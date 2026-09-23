// croft init (DESIGN.md §2, §9, D42, D43). Three shapes:
//   - a new or empty folder gets the whole scaffold;
//   - a folder with a package.json (an app) gets a croft project in data/, and the app's own files are
//     never overwritten: the root CLAUDE.md gets a managed block, and the tsconfig "exclude" edit is only
//     applied after a yes on a TTY (otherwise it is printed);
//   - --claude only refreshes the Claude files (managed block replaced in place, SKILL.md rewritten).
// Everything is planned first and written afterwards, so a refusal (an existing project, unbalanced
// CLAUDE.md markers) leaves the disk untouched. Nothing here imports DuckDB: init must work before
// `bun install` has fetched the native binding.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { CroftError } from "../core/errors.ts";
import type { Problem } from "../core/types.ts";
import { checkTimeZone, systemTimeZone } from "../core/time.ts";
import {
  BLOCK_START, CLAUDE_MD, claudeBlock, CROFT_PACKAGE, CROFT_VERSION, gitignorePatterns, scaffold, SKILL_PATH,
  skillMd, UnbalancedBlock, upsertBlock, type BlockAction,
} from "../agent/templates.ts";
import { planExclude } from "./init-tsconfig.ts";
import { CONFIG_FILE, findRoot, relocationDir, syncedLocation } from "./root.ts";

export const DATA_DIR = "data";

export type FileAction = "created" | "appended" | "replaced" | "merged" | "unchanged" | "skipped";
export interface FileChange { path: string; action: FileAction; note?: string }

export interface TsconfigEdit {
  file: string;                      // relative to the app folder
  status: "applied" | "declined" | "suggested" | "manual";
  reason: string;
  diff?: string;
}

export interface InstallResult { ran: true; ok: boolean; command: string; ms: number; output?: string }
export type InstallOutcome = InstallResult | { ran: false; reason: string };

export interface ExampleResult { ran: true; ok: boolean; asset: string; rows: number; checks: "ok" | "failed"; problems?: Problem[] }
export type ExampleOutcome = ExampleResult | { ran: false; reason: string };

/**
 * HOOK(example): running assets/example_sales.ts after install belongs to the run slice. When it exists,
 * the init command passes a runner here that runs `example_sales` in the new project (read-write, through
 * db/warehouse.ts, so it takes a write intent like every writer) and reports its row count and checks.
 * Until then init reports the example as not run and suggests `croft run example_sales`.
 */
export type ExampleRunner = (root: string) => Promise<ExampleResult>;

export interface InitOptions {
  /** The folder the user named (or the current folder). */
  target: string;
  /** The folder as the user typed it, for suggested commands ("croft init my-data --claude"). */
  displayTarget?: string;
  /** --claude: refresh only CLAUDE.md's managed block and the skill. */
  claudeOnly?: boolean;
  /** false for --no-install. Default true. */
  install?: boolean;
  version?: string;
  /** Default: this machine's zone (Intl), made canonical. */
  timezone?: string;
  /** Home folder for relocation (tests use a fake one). */
  home?: string;
  /** Why a path is unsafe for a DuckDB file, or null; default syncedLocation (tests inject a fake). */
  synced?: (path: string) => string | null;
  /** Ask before editing the app's tsconfig.json. Absent (off a TTY, --json): the edit is only printed. */
  confirmEdit?: (edit: { file: string; diff: string }) => Promise<boolean>;
  runInstall?: (root: string) => InstallResult;
  runExample?: ExampleRunner;
  onProgress?: (line: string) => void;
}

export interface InitResult {
  mode: "new" | "app" | "claude";
  /** The folder paths in `files` are relative to: the app folder in app mode, else the project root. */
  base: string;
  root: string;                      // the croft project (croft.json lives here)
  version: string;
  timezone: string;
  files: FileChange[];
  relocation: { reason: string; dir: string; database: string; stateDir: string } | null;
  tsconfig: TsconfigEdit | null;
  appSteps: string[];
  install: InstallOutcome;
  example: ExampleOutcome;
}

/** This machine's time zone, as a name croft.json accepts; UTC when the system reports nothing usable. */
export function detectTimeZone(): string {
  const zone = systemTimeZone();
  const check = checkTimeZone(zone);
  return check.ok ? check.name : check.suggestion ?? "UTC";
}

/** Where a relocated database and state folder go, written as croft.json records them: under ~ when
 *  possible, so the file still reads right on another machine with a different user name. */
export function relocationPlan(root: string, reason: string, home = homedir()): NonNullable<InitResult["relocation"]> {
  const dir = relocationDir(root, home);
  const tilde = (p: string) => (p.startsWith(home + sep) ? `~/${relative(home, p).split(sep).join("/")}` : p);
  return { reason, dir, database: tilde(join(dir, "warehouse.duckdb")), stateDir: tilde(join(dir, ".croft")) };
}

interface Write { abs: string; rel: string; text: string; action: FileAction; mode?: number; note?: string }

export async function initProject(o: InitOptions): Promise<InitResult> {
  const target = resolve(o.target);
  if (existsSync(target) && !statSync(target).isDirectory()) {
    throw usage(`${target} is a file, not a folder`, "name a folder: croft init <dir>");
  }
  if (o.claudeOnly) return refreshClaude(target, o);

  const version = o.version ?? CROFT_VERSION;
  const has = (p: string) => existsSync(join(target, p));
  if (has(CONFIG_FILE)) throw alreadyProject(target, target, o.displayTarget);
  if (has(join(DATA_DIR, CONFIG_FILE))) throw alreadyProject(join(target, DATA_DIR), target, o.displayTarget);
  const app = has("package.json");
  const root = app ? join(target, DATA_DIR) : target;
  if (app) {
    if (existsSync(root) && (!statSync(root).isDirectory() || readdirSync(root).length > 0)) {
      throw usage(`${target} looks like an app (it has a package.json), and its ${DATA_DIR}/ already holds other files`,
        `croft puts pipelines for an app in ${DATA_DIR}/; move that folder, or create the project elsewhere with croft init <dir>`);
    }
  }

  const timezone = o.timezone ?? detectTimeZone();
  const why = (o.synced ?? ((p: string) => syncedLocation(p, { home: o.home })))(root);
  const relocation = why ? relocationPlan(root, why, o.home) : null;
  const base = target;
  const rel = (abs: string) => relative(base, abs).split(sep).join("/");

  // Plan every write before touching the disk.
  const writes: Write[] = [];
  for (const f of scaffold({ version, timezone, relocated: relocation })) {
    const abs = join(root, ...f.path.split("/"));
    writes.push({ ...planFile(abs, f.text, f.path), rel: rel(abs), ...(f.mode ? { mode: f.mode } : {}) });
  }
  let tsPlan: ReturnType<typeof planExclude> | null = null;
  const appSteps: string[] = [];
  if (app) {
    const claude = join(target, CLAUDE_MD);
    writes.push({ abs: claude, rel: CLAUDE_MD, ...blockWrite(claude, claudeBlock("app")), note: `points Claude Code at ${DATA_DIR}/` });
    // Claude Code runs from the app folder, so the skill the root block names must be discoverable there too.
    const skill = join(target, ...SKILL_PATH.split("/"));
    writes.push({ ...planManaged(skill, skillMd(version)), rel: SKILL_PATH });
    const tsconfig = join(target, "tsconfig.json");
    if (existsSync(tsconfig)) tsPlan = planExclude(readFileSync(tsconfig, "utf8"), "tsconfig.json", DATA_DIR);
    appSteps.push(...appInstructions(target, version));
  }

  // Apply.
  mkdirSync(root, { recursive: true });
  for (const w of writes) apply(w);
  mkdirSync(relocation ? resolveHome(relocation.stateDir, o.home) : join(root, ".croft"), { recursive: true });

  let tsconfig: TsconfigEdit | null = null;
  if (tsPlan && tsPlan.status !== "not_needed") {
    if (tsPlan.status === "manual") tsconfig = { file: "tsconfig.json", status: "manual", reason: tsPlan.reason };
    else {
      const edit = { file: "tsconfig.json", diff: tsPlan.diff! };
      let status: TsconfigEdit["status"] = "suggested";
      if (o.confirmEdit) {
        status = (await o.confirmEdit(edit)) ? "applied" : "declined";
        if (status === "applied") writeFileSync(join(target, "tsconfig.json"), tsPlan.after!);
      }
      tsconfig = { ...edit, status, reason: tsPlan.reason };
    }
  }

  let install: InstallOutcome = { ran: false, reason: "skipped (--no-install)" };
  if (o.install !== false) {
    o.onProgress?.("Installing dependencies (bun install)…");
    install = (o.runInstall ?? bunInstall)(root);
  }

  let example: ExampleOutcome;
  if (!o.runExample) example = { ran: false, reason: "not run by this version of croft init" };
  else if (!install.ran || !install.ok) example = { ran: false, reason: "dependencies are not installed" };
  else {
    o.onProgress?.("Running example_sales…");
    example = await o.runExample(root);
  }

  return {
    mode: app ? "app" : "new", base, root, version, timezone,
    files: writes.map((w) => ({ path: w.rel, action: w.action, ...(w.note ? { note: w.note } : {}) })),
    relocation, tsconfig, appSteps, install, example,
  };
}

/** --claude: refresh CLAUDE.md's block and the skill of the project at (or above, or in data/ of) target. */
async function refreshClaude(target: string, o: InitOptions): Promise<InitResult> {
  const root = existsSync(join(target, CONFIG_FILE)) ? target : findRoot(target);
  if (!root) {
    throw new CroftError("PROJECT_NOT_FOUND", {
      message: `no croft project at ${target}: croft init --claude refreshes the Claude files of an existing project`,
      hint: "run it inside the project, or create one with croft init",
      fix: { kind: "command", description: "create a project here", command: "croft init" },
    });
  }
  const version = o.version ?? CROFT_VERSION;
  const parent = appRootOf(root);
  const base = parent ?? root;
  const rel = (abs: string) => relative(base, abs).split(sep).join("/");
  const writes: Write[] = [];
  const claude = join(root, CLAUDE_MD);
  writes.push({ abs: claude, rel: rel(claude), ...blockWrite(claude, claudeBlock("project")) });
  const skill = join(root, ...SKILL_PATH.split("/"));
  writes.push({ ...planManaged(skill, skillMd(version)), rel: rel(skill) });
  if (parent) {
    const appClaude = join(parent, CLAUDE_MD);
    writes.push({ abs: appClaude, rel: CLAUDE_MD, ...blockWrite(appClaude, claudeBlock("app")) });
    const appSkill = join(parent, ...SKILL_PATH.split("/"));
    writes.push({ ...planManaged(appSkill, skillMd(version)), rel: SKILL_PATH });
  }
  for (const w of writes) apply(w);
  let timezone = detectTimeZone();
  try {
    const tz = (JSON.parse(readFileSync(join(root, CONFIG_FILE), "utf8")) as { timezone?: unknown }).timezone;
    if (typeof tz === "string") timezone = tz;
  } catch { /* a broken croft.json is validate's business; the Claude files are still refreshed */ }
  return {
    mode: "claude", base, root, version, timezone,
    files: writes.map((w) => ({ path: w.rel, action: w.action })),
    relocation: null, tsconfig: null, appSteps: [], install: { ran: false, reason: "not needed for --claude" },
    example: { ran: false, reason: "not needed for --claude" },
  };
}

/** The app folder whose Claude files croft init set up next to a data/ project, or null. A project that
 *  merely happens to be called data/ under some package.json is not an app project unless croft's own
 *  files are there (the skill, or croft markers in CLAUDE.md): --claude must not write into a parent
 *  folder croft never touched. */
export function appRootOf(root: string): string | null {
  const parent = dirname(root);
  if (basename(root) !== DATA_DIR || !existsSync(join(parent, "package.json")) || existsSync(join(parent, CONFIG_FILE))) return null;
  if (existsSync(join(parent, ...SKILL_PATH.split("/")))) return parent;
  try {
    return readFileSync(join(parent, CLAUDE_MD), "utf8").includes(BLOCK_START) ? parent : null;
  } catch {
    return null;
  }
}

/** A scaffold file: created when absent; an existing file is kept, except the ones croft manages or can
 *  merge into without losing anything (CLAUDE.md's block, the skill, .gitignore patterns). */
function planFile(abs: string, text: string, path: string): Omit<Write, "rel"> {
  if (path === CLAUDE_MD) return { abs, ...blockWrite(abs, text) };
  if (path === SKILL_PATH) return planManaged(abs, text);
  if (!existsSync(abs)) return { abs, text, action: "created" };
  if (path === ".gitignore") {
    const existing = readFileSync(abs, "utf8");
    const have = new Set(existing.split("\n").map((l) => l.trim()));
    const missing = gitignorePatterns().filter((p) => !have.has(p));
    if (!missing.length) return { abs, text: existing, action: "unchanged" };
    const sep = existing === "" || existing.endsWith("\n") ? "" : "\n";
    return { abs, text: `${existing}${sep}# croft\n${missing.join("\n")}\n`, action: "merged", note: `added ${missing.join(", ")}` };
  }
  return { abs, text: "", action: "skipped", note: "already exists; left as it was" };
}

/** A file croft owns outright (the skill): written when absent or different. */
function planManaged(abs: string, text: string): Omit<Write, "rel"> {
  if (!existsSync(abs)) return { abs, text, action: "created" };
  return { abs, text, action: readFileSync(abs, "utf8") === text ? "unchanged" : "replaced" };
}

function blockWrite(abs: string, block: string): { text: string; action: BlockAction } {
  const existing = existsSync(abs) ? readFileSync(abs, "utf8") : null;
  try {
    return upsertBlock(existing, block);
  } catch (e) {
    if (!(e instanceof UnbalancedBlock)) throw e;
    throw usage(`${abs}: ${e.message}, so croft cannot tell where its block ends`,
      "fix the croft markers in that CLAUDE.md by hand (or delete the croft block), then run croft init --claude",
      { kind: "manual", description: `make ${abs} hold one "<!-- croft:start …" line and one "<!-- croft:end -->" line, or neither` });
  }
}

function apply(w: Write): void {
  if (w.action === "skipped" || w.action === "unchanged") return;
  mkdirSync(dirname(w.abs), { recursive: true });
  writeFileSync(w.abs, w.text, w.mode ? { mode: w.mode } : undefined);
  if (w.mode) chmodSync(w.abs, w.mode);        // writeFileSync's mode only applies when it creates the file
}

/** What the app itself needs, printed after init in an app repo (DESIGN.md §2). */
export function appInstructions(appRoot: string, version: string = CROFT_VERSION): string[] {
  const at = (f: string) => existsSync(join(appRoot, f));
  const pm = at("bun.lock") || at("bun.lockb") ? "bun add" : at("pnpm-lock.yaml") ? "pnpm add" : at("yarn.lock") ? "yarn add" : "npm install";
  const steps = [`${pm} ${CROFT_PACKAGE}@${version}`];
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try { pkg = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")); } catch { /* unreadable: no framework hints */ }
  if (pkg.dependencies?.next || pkg.devDependencies?.next) {
    steps.push("Next.js: add serverExternalPackages: ['@duckdb/node-api'] to next.config");
  }
  steps.push(`read data in app code with import { query } from "${CROFT_PACKAGE}/read"; never open the .duckdb file directly`);
  return steps;
}

/** `bun install` in the new project with the Bun running croft. Output is captured, not streamed, so a
 *  --json caller still gets exactly one envelope on stdout. */
export function bunInstall(root: string): InstallResult {
  const started = performance.now();
  const r = Bun.spawnSync([process.execPath, "install"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const ms = Math.round(performance.now() - started);
  const output = `${r.stdout.toString()}${r.stderr.toString()}`.trim().split("\n").slice(-20).join("\n");
  return { ran: true, ok: r.exitCode === 0, command: "bun install", ms, ...(r.exitCode === 0 ? {} : { output }) };
}

function resolveHome(p: string, home = homedir()): string {
  return p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

function alreadyProject(root: string, target: string, display?: string): CroftError {
  const inData = root !== target;
  const command = `croft init${display ? ` ${display}` : ""} --claude`;
  return new CroftError("USAGE_ERROR", {
    message: `${inData ? `${target} already has a croft project in ${DATA_DIR}/` : `${target} is already a croft project`}; croft init never overwrites a project`,
    hint: `to refresh CLAUDE.md and the croft skill for this version, run ${command}`,
    fix: { kind: "command", description: "refresh the Claude files", command },
    details: { root },
  });
}

function usage(message: string, hint: string, fix?: Problem["fix"]): CroftError {
  return new CroftError("USAGE_ERROR", { message, hint, fix: fix ?? { kind: "manual", description: hint } });
}
