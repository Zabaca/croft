// croft doctor (DESIGN.md §2 "Install-time failures", §4.1): the environment plus a project summary,
// in under a second, with no writes except the one write test the design asks for (a temp file in the
// state folder, removed at once).
//
// DuckDB is never imported statically here. The binding is checked in a child process first (a missing
// or foreign-arch binding must be reported, not crash doctor), and only then is db/warehouse.ts imported
// to look at the warehouse read-only.
import { accessSync, constants as fsConstants, existsSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { CroftError, problem } from "../../core/errors.ts";
import type { LockHolder, Problem } from "../../core/types.ts";
import { isHolderAlive, liveIntents } from "../../db/intent.ts";
import { CLAUDE_MD, claudeBlock, findBlock, SKILL_PATH, skillStamp } from "../../agent/templates.ts";
import { ProjectEnv } from "../../project/env.ts";
import { appRootOf, relocationPlan } from "../../project/init.ts";
import { configProblems, findRoot, loadProject, syncedLocation, type ConfigIssue, type Project } from "../../project/root.ts";
import type { Command } from "../command.ts";
import { LAUNCH_ENV, SELF_ROOT } from "../launcher.ts";
import { formatCount } from "../render.ts";
import { BUN_FLOOR, CROFT_VERSION, versionAtLeast } from "../version.ts";

/** The newest Bun this croft version was tested on in CI (DESIGN.md §2 "Dependencies"). A newer Bun is a
 *  warning, not an error: parse behavior has changed between Bun versions before [V]. */
export const BUN_TESTED = "1.4.2";

export type Section = "environment" | "project" | "scheduling";
export type CheckStatus = "ok" | "warn" | "error" | "info";
export interface DoctorCheck {
  id: string;
  section: Section;
  status: CheckStatus;
  text: string;                      // the line printed after the status label
  code?: string;                     // the problem this check reported, when it has a registered code
  details?: Record<string, unknown>;
}
export interface DoctorData {
  checks: DoctorCheck[];
  summary: { ok: number; info: number; warnings: number; errors: number };
  project: { root: string; database: string; stateDir: string; relocated: boolean } | null;
}

export type DuckdbProbe =
  | { ok: true; version: string; extensions: string[]; platformArch: string }
  | { ok: false; name?: string; code?: string; message: string; exitCode?: number | null; signal?: string | null; stderr?: string };

export interface DoctorDeps {
  bunVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  croftRoot: string;                 // package root of the running croft copy
  env: Record<string, string | undefined>;
  home: string;
  wsl: boolean;
  probeDuckdb(croftRoot: string): DuckdbProbe;
  rosetta(): boolean;
  synced(path: string): string | null;
  /** How long the warehouse probe waits on a lock before naming the holder. */
  lockWaitMs: number;
  healthTimeoutMs: number;
}

export function defaultDeps(env: Record<string, string | undefined>): DoctorDeps {
  return {
    bunVersion: Bun.version,
    platform: process.platform,
    arch: process.arch,
    croftRoot: SELF_ROOT,
    env,
    home: homedir(),
    wsl: process.platform === "linux" && isWsl(env),
    probeDuckdb,
    rosetta,
    synced: (p) => syncedLocation(p),
    lockWaitMs: 150,
    healthTimeoutMs: 300,
  };
}

export const doctor: Command<DoctorData> = {
  name: "doctor",
  summary: "check the environment and the project: Bun, DuckDB, the warehouse, storage, Claude files",
  usage: "croft doctor",
  options: {},
  maxPositionals: 0,
  async run(ctx) {
    const { data, problems } = await runDoctor(ctx.cwd, defaultDeps(ctx.processEnv));
    const errors = data.checks.filter((c) => c.status === "error").length;
    return { data, problems, next: nextFor(problems), ...(errors > 0 && !problems.some((p) => p.severity === "error") ? { exit: 1, ok: false } : {}) };
  },
  human(result) {
    return formatDoctor(result.data);
  },
};

function nextFor(problems: Problem[]): { command: string; reason: string }[] {
  return problems.some((p) => p.code === "CLAUDE_FILES_OUTDATED")
    ? [{ command: "croft init --claude", reason: "refresh CLAUDE.md and the croft skill for this version" }]
    : [];
}

// ---------------------------------------------------------------------------------------------

class Report {
  readonly checks: DoctorCheck[] = [];
  readonly problems: Problem[] = [];
  add(section: Section, id: string, status: CheckStatus, text: string, p?: Problem, details?: Record<string, unknown>): void {
    this.checks.push({ id, section, status, text, ...(p ? { code: p.code } : {}), ...(details ? { details } : {}) });
    if (p) this.problems.push(p);
  }
}

export async function runDoctor(cwd: string, d: DoctorDeps): Promise<{ data: DoctorData; problems: Problem[] }> {
  const r = new Report();
  const root = findRoot(cwd);
  let project: Project | null = null;
  let configIssues: ConfigIssue[] | null = null;
  if (root) {
    try {
      project = loadProject({ root, home: d.home });
    } catch (e) {
      if (!(e instanceof CroftError)) throw e;
      configIssues = (e.problem.details?.issues as ConfigIssue[] | undefined) ?? [{ path: "", message: e.problem.message, hint: e.problem.hint }];
    }
  }

  // Environment
  checkBun(r, d);
  checkCroft(r, d, root);
  const probe = d.probeDuckdb(d.croftRoot);
  checkDuckdb(r, d, probe, root);
  if (project) {
    await checkWarehouse(r, d, project, probe.ok);
    await checkServe(r, d, project);
  }

  // Project
  if (!root) {
    r.add("project", "project", "info", "no croft project here (croft init creates one)");
  } else if (configIssues) {
    const problems = configProblems(configIssues);
    problems.forEach((p, i) => r.add("project", i === 0 ? "config" : `config.${i}`, "error", `croft.json: ${p.message}`, p));
  } else if (project) {
    r.add("project", "config", "ok", `croft.json · timezone ${project.timezone} · ${assetSummary(project.paths.assetsDir)}`);
  }
  if (project) {
    checkStorage(r, d, project);
    checkWritable(r, project);
  }
  if (root) {
    checkEnvFiles(r, root);
    checkClaudeFiles(r, root);
  }
  if (d.wsl) {
    r.add("environment", "wsl", "info", "WSL stops its VM when no terminal is open, so scheduled runs pause until one is");
  }
  // HOOK(schedule): the Scheduling section (on/off, who ticks, SCHEDULER_STALE) belongs to the schedule slice.

  const count = (s: CheckStatus) => r.checks.filter((c) => c.status === s).length;
  // Stable section order for output: environment, project, scheduling.
  const order: Section[] = ["environment", "project", "scheduling"];
  const checks = [...r.checks].sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section));
  return {
    data: {
      checks,
      summary: { ok: count("ok"), info: count("info"), warnings: count("warn"), errors: count("error") },
      project: project
        ? { root: project.root, database: project.paths.database, stateDir: project.paths.stateDir, relocated: project.relocated }
        : null,
    },
    problems: r.problems,
  };
}

// ---------------------------------------------------------------------------------------------
// Environment

function checkBun(r: Report, d: DoctorDeps): void {
  const where = `${d.platform}-${d.arch}`;
  if (!versionAtLeast(d.bunVersion, BUN_FLOOR)) {
    const p = problem("BUN_TOO_OLD", {
      message: `croft needs Bun ${BUN_FLOOR} or newer; this is Bun ${d.bunVersion}`,
      hint: "run bun upgrade",
      fix: { kind: "command", description: "upgrade Bun", command: "bun upgrade", requiresHuman: true },
    });
    r.add("environment", "bun", "error", `bun ${d.bunVersion} (${where}), needs >= ${BUN_FLOOR}`, p);
  } else if (!versionAtLeast(BUN_TESTED, d.bunVersion)) {
    // No registered code says "newer than tested"; the check carries the warning on its own.
    r.add("environment", "bun", "warn", `bun ${d.bunVersion} (${where}) is newer than the newest Bun croft ${CROFT_VERSION} was tested on (${BUN_TESTED}); if something breaks, try Bun ${BUN_TESTED}`,
      undefined, { tested: BUN_TESTED });
  } else {
    r.add("environment", "bun", "ok", `bun ${d.bunVersion} (${where}), needs >= ${BUN_FLOOR}`);
  }
}

function checkCroft(r: Report, d: DoctorDeps, root: string | null): void {
  const launcher = d.env[LAUNCH_ENV.launcherVersion];
  const via = launcher ? `; launcher ${launcher}` : "";
  if (!root) {
    r.add("environment", "croft", "ok", `croft ${CROFT_VERSION} (${d.croftRoot.replace(/\/$/, "")})`);
    return;
  }
  const copy = join(root, "node_modules", "@zabaca", "croft");
  if (!existsSync(join(copy, "package.json"))) {
    if (declaresCroft(root)) {
      r.add("environment", "croft", "warn", `croft ${CROFT_VERSION} is running, but this project's pinned croft is not installed; run bun install in ${root}`,
        undefined, { pinned: null });
    } else {
      r.add("environment", "croft", "info", `croft ${CROFT_VERSION} (this project's package.json does not pin @zabaca/croft)`);
    }
    return;
  }
  if (realpathSafe(copy) === realpathSafe(d.croftRoot)) {
    r.add("environment", "croft", "ok", `croft ${CROFT_VERSION} (project-pinned${via})`);
    return;
  }
  let pinned = "?";
  try { pinned = (JSON.parse(readFileSync(join(copy, "package.json"), "utf8")) as { version?: string }).version ?? "?"; } catch { /* unreadable */ }
  r.add("environment", "croft", pinned === CROFT_VERSION ? "info" : "warn",
    `croft ${CROFT_VERSION} is running from ${d.croftRoot.replace(/\/$/, "")}, but this project pins croft ${pinned}; run croft through the launcher (croft …) or bunx croft`,
    undefined, { pinned });
}

/** Load the binding in a child process and report its version and built-in extensions. `--no-install`
 *  stops Bun from fetching a missing package on import, which it otherwise does outside node_modules [V]. */
export function probeDuckdb(croftRoot: string): DuckdbProbe {
  const script = `
const say = (o) => process.stdout.write(JSON.stringify(o));
try {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const db = await DuckDBInstance.create(":memory:");
  const c = await db.connect();
  const r = await c.runAndReadAll("SELECT version() AS v, (SELECT list(extension_name ORDER BY extension_name) FROM duckdb_extensions() WHERE install_mode = 'STATICALLY_LINKED') AS ext");
  const [row] = r.getRowObjectsJS();
  c.disconnectSync();
  db.closeSync();
  say({ ok: true, version: String(row.v), extensions: (row.ext ?? []).map(String), platformArch: process.platform + "-" + process.arch });
} catch (e) {
  say({ ok: false, name: e?.name, code: e?.code, message: String(e?.message ?? e) });
}`;
  let r;
  try {
    r = Bun.spawnSync([process.execPath, "--no-env-file", "--no-install", "-e", script], {
      cwd: realpathSafe(croftRoot), stdout: "pipe", stderr: "pipe", timeout: 15_000,
    });
  } catch (e) {
    return { ok: false, message: `cannot run the DuckDB check from ${croftRoot}: ${(e as Error).message}` };
  }
  try {
    return JSON.parse(r.stdout.toString().trim()) as DuckdbProbe;
  } catch {
    return {
      ok: false, message: `the DuckDB check crashed${r.signalCode ? ` (${r.signalCode})` : ` (exit ${r.exitCode})`}`,
      exitCode: r.exitCode, signal: r.signalCode ?? null, stderr: r.stderr.toString().trim().split("\n").slice(-5).join("\n"),
    };
  }
}

/** x64 Bun translated by Rosetta on an Apple Silicon Mac. */
function rosetta(): boolean {
  if (process.platform !== "darwin" || process.arch !== "x64") return false;
  const r = Bun.spawnSync(["sysctl", "-n", "sysctl.proc_translated"], { stdout: "pipe", stderr: "ignore" });
  return r.stdout.toString().trim() === "1";
}

export function checkDuckdb(r: Report, d: DoctorDeps, probe: DuckdbProbe, root: string | null): void {
  const where = `${d.platform}-${d.arch}`;
  const underRosetta = d.rosetta();
  if (probe.ok) {
    const version = probe.version.replace(/^v/, "");
    const ext = ["json", "parquet", "icu"].filter((e) => probe.extensions.includes(e));
    const note = underRosetta ? " · x64 Bun under Rosetta (the arm64 build of Bun is faster)" : "";
    r.add("environment", "duckdb", "ok", `duckdb ${version} binding ${probe.platformArch} · ${ext.join(", ")} built in${note}`,
      undefined, { version, extensions: probe.extensions });
    return;
  }
  const reinstall = root ? `cd ${shellQuote(root)} && rm -rf node_modules && bun install` : "bun add -g @zabaca/croft";
  const text = `${probe.message}${probe.stderr ? `\n${probe.stderr}` : ""}`;
  const missing = probe.code === "MODULE_NOT_FOUND" || /Cannot find (module|package)/.test(text);
  const wrongArch = /incompatible architecture|wrong ELF class|Exec format error|not a valid mach-o|slice is not valid mach-o/i.test(text);
  if (missing || wrongArch || underRosetta) {
    const found = bindingsPresent(d.croftRoot);
    const other = found.filter((b) => !b.startsWith(where));
    let why = missing ? `the DuckDB binding for ${where} is not installed` : `the DuckDB binding cannot be loaded by this ${where} Bun`;
    if (other.length) why += ` (node_modules has ${other.join(", ")}: installed on another machine or by another Bun?)`;
    const fix = underRosetta
      ? { kind: "manual" as const, description: "install the arm64 build of Bun (this one is x64 under Rosetta), then rm -rf node_modules && bun install", requiresHuman: true }
      : { kind: "command" as const, description: "reinstall the dependencies for this machine", command: reinstall };
    const p = problem("DUCKDB_BINDING_MISSING", {
      message: why,
      hint: underRosetta ? "install the arm64 build of Bun, then reinstall the dependencies" : `run ${reinstall}`,
      fix,
      details: { platformArch: where, bindingsPresent: found, error: probe.message.slice(0, 500) },
    });
    r.add("environment", "duckdb", "error", `duckdb binding: ${why}`, p);
    return;
  }
  const glibc = /GLIBC_(\d+\.\d+)'? not found/.exec(text)?.[1];
  const p = problem("DUCKDB_BINDING_LOAD", {
    message: glibc
      ? `the DuckDB binding needs glibc ${glibc} or newer, which this system does not have`
      : `the DuckDB binding failed to load: ${probe.message.split("\n")[0]!.slice(0, 300)}`,
    hint: glibc ? `use a system with glibc >= ${glibc} (croft needs glibc 2.25 at least), or a newer distribution` : `try ${reinstall}`,
    fix: glibc
      ? { kind: "manual", description: `run croft on a system with glibc ${glibc} or newer`, requiresHuman: true }
      : { kind: "command", description: "reinstall the dependencies", command: reinstall },
    details: { error: probe.message.slice(0, 500), ...(probe.stderr ? { stderr: probe.stderr } : {}) },
  });
  r.add("environment", "duckdb", "error", `duckdb binding: ${p.message}`, p);
}

/** The @duckdb/node-bindings-<platform> packages next to the one croft resolves. */
function bindingsPresent(croftRoot: string): string[] {
  try {
    const api = Bun.resolveSync("@duckdb/node-api/package.json", realpathSafe(croftRoot));
    const bindings = Bun.resolveSync("@duckdb/node-bindings/package.json", dirname(api));
    return readdirSync(dirname(dirname(bindings)))
      .filter((n) => n.startsWith("node-bindings-")).map((n) => n.slice("node-bindings-".length)).sort();
  } catch {
    return [];
  }
}

async function checkWarehouse(r: Report, d: DoctorDeps, project: Project, bindingOk: boolean): Promise<void> {
  const path = project.paths.database;
  const label = project.databaseLabel;
  if (!existsSync(path)) {
    r.add("environment", "warehouse", "ok", `${label} not created yet (the first croft run creates it)`, undefined, { exists: false });
    return;
  }
  const size = statSync(path).size;
  const writable = canWrite(path) && canWrite(dirname(path));
  const parts = [`${label} ${formatBytes(size)}`, writable ? "writable" : "not writable"];
  const details: Record<string, unknown> = { exists: true, bytes: size, writable };
  if (!bindingOk) {
    r.add("environment", "warehouse", "info", `${parts.join(" · ")} · not opened (the DuckDB binding does not load)`, undefined, details);
    return;
  }
  // A croft writer holds or waits for the file: stay out of its way, as serve and app readers do (§5).
  const writer = liveIntents(project.paths.stateDir)[0];
  if (writer) {
    const who = writer.runId ? `croft run ${writer.runId}` : `croft (pid ${writer.pid})`;
    r.add("environment", "warehouse", "info", `${parts.join(" · ")} · busy: ${who} is writing (not opened meanwhile)`, undefined,
      { ...details, heldBy: { pid: writer.pid, program: "croft", runId: writer.runId, since: writer.since } });
    return;
  }
  const { openWarehouse } = await import("../../db/warehouse.ts");
  const { readMeta } = await import("../../db/state.ts");
  const w = openWarehouse({
    path, mode: "read_only", profile: "query", timezone: project.timezone, root: project.root, stateDir: project.paths.stateDir,
    isTTY: false, register: false, lingerMs: 0, noticeAfterMs: Number.MAX_SAFE_INTEGER,
  });
  const serve = servePid(project.paths.stateDir);
  try {
    const meta = await w.read(async (db) => readMeta(db), { waitMs: d.lockWaitMs, purpose: "doctor" });
    const serveHolds = serve !== null && serve.alive;
    parts.push(serveHolds ? `held read-only by croft serve (pid ${serve.pid}; steps aside for writes)` : "not held");
    if (meta.format_version) {
      parts.push(`duckdb ${String(meta.duckdb_version ?? "?").replace(/^v/, "")} · croft format ${meta.format_version}`);
    } else {
      parts.push("no croft state yet");
    }
    Object.assign(details, { meta, heldBy: serveHolds ? { pid: serve.pid, program: "croft serve" } : null });
    r.add("environment", "warehouse", writable ? "ok" : "warn", parts.join(" · "), undefined, details);
  } catch (e) {
    if (!(e instanceof CroftError)) {
      const msg = (e as Error).message ?? String(e);
      if (/version number|newer version of DuckDB|created with a newer/i.test(msg)) {
        const p = problem("DB_NEWER_FORMAT", {
          message: `${label} was written by a newer DuckDB than this croft's (${msg.split("\n")[0]!.slice(0, 200)})`,
          hint: "upgrade croft in this project (bun add @zabaca/croft@latest) instead of opening the database with an older version",
          retryable: false,
        });
        r.add("environment", "warehouse", "error", `${parts.join(" · ")} · ${p.message}`, p, details);
      } else {
        // No registered code fits "the file is not a readable DuckDB database"; the check carries it.
        r.add("environment", "warehouse", "error", `${parts.join(" · ")} · cannot be opened: ${msg.split("\n")[0]!.slice(0, 200)}`, undefined,
          { ...details, error: msg.slice(0, 500) });
      }
      return;
    }
    const holder = e.problem.details?.holder as LockHolder | undefined;
    if (e.code === "DB_BUSY") {
      const who = holder?.runId ? `croft run ${holder.runId}${holder.asset ? `, writing ${holder.asset}` : ""}` : `${holder?.program ?? "croft"}${holder?.pid ? ` (pid ${holder.pid})` : ""}`;
      r.add("environment", "warehouse", "info", `${parts.join(" · ")} · busy: ${who} is writing`, undefined, { ...details, heldBy: holder ?? null });
    } else if (e.code === "DB_HELD_BY_OTHER_PROGRAM") {
      const who = `${holder?.program ?? "another program"}${holder?.pid ? ` (PID ${holder.pid})` : ""}`;
      r.add("environment", "warehouse", "error", `${parts.join(" · ")} · held by ${who}`, e.problem, { ...details, heldBy: holder ?? null });
    } else {
      r.add("environment", "warehouse", "error", `${parts.join(" · ")} · ${e.problem.message}`, e.problem, details);
    }
  } finally {
    await w.close();
  }
}

interface ServeFile { pid: number; alive: boolean; url: string | null; token: string | null; raw: Record<string, unknown> }

function servePid(stateDir: string): ServeFile | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(join(stateDir, "serve.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const pid = typeof raw.pid === "number" ? raw.pid : -1;
  let alive = false;
  if (pid > 0) {
    if (typeof raw.procStart === "string" && typeof raw.bootId === "string") {
      alive = isHolderAlive({ pid, procStart: raw.procStart, bootId: raw.bootId });
    } else {
      try { process.kill(pid, 0); alive = true; } catch (e) { alive = (e as NodeJS.ErrnoException).code === "EPERM"; }
    }
  }
  const url = typeof raw.url === "string" ? raw.url
    : typeof raw.host === "string" && typeof raw.port === "number" ? `http://${raw.host.includes(":") ? `[${raw.host}]` : raw.host}:${raw.port}` : null;
  return { pid, alive, url, token: typeof raw.token === "string" ? raw.token : null, raw };
}

async function checkServe(r: Report, d: DoctorDeps, project: Project): Promise<void> {
  const file = join(project.paths.stateDir, "serve.json");
  const s = servePid(project.paths.stateDir);
  if (!s) {
    r.add("environment", "serve", "info", "croft serve is not running (apps read the file directly)", undefined, { running: false });
    return;
  }
  if (!s.alive) {
    r.add("environment", "serve", "info", `croft serve is not running (serve.json is left from pid ${s.pid})`, undefined, { running: false, stalePid: s.pid });
    return;
  }
  const shownFile = inside(project.root, file) ? relative(project.root, file) : file;
  const where = s.url ? s.url.replace(/^https?:\/\//, "").replace(/\/$/, "") : "an unknown address";
  let health: Record<string, unknown> | null = null;
  if (s.url) {
    try {
      const res = await fetch(new URL("/health", s.url), {
        headers: s.token ? { authorization: `Bearer ${s.token}` } : {},
        signal: AbortSignal.timeout(d.healthTimeoutMs),
      });
      if (res.ok) health = (await res.json()) as Record<string, unknown>;
    } catch { /* not answering: reported below */ }
  }
  if (!health) {
    const p = problem("SERVE_UNAVAILABLE", {
      message: `croft serve (pid ${s.pid}) is running but does not answer on ${s.url ?? "its recorded address"}`,
      hint: "stop it and start croft serve again in your terminal",
      fix: { kind: "manual", description: `stop croft serve (pid ${s.pid}) and start it again`, requiresHuman: true },
      retryable: true,
      details: { pid: s.pid, url: s.url },
    });
    r.add("environment", "serve", "error", `croft serve pid ${s.pid} does not answer on ${where}`, p, { running: true, pid: s.pid, url: s.url });
    return;
  }
  const queries = typeof health.queriesToday === "number" ? ` · ${formatCount(health.queriesToday)} queries today` : "";
  r.add("environment", "serve", "ok", `croft serve on ${where} (pid ${s.pid}) · token in ${shownFile}${queries}`, undefined,
    { running: true, pid: s.pid, url: s.url, queriesToday: health.queriesToday ?? null });
}

// ---------------------------------------------------------------------------------------------
// Project

function assetSummary(assetsDir: string): string {
  let n = 0;
  try {
    for (const f of new Bun.Glob("**/*.{ts,sql}").scanSync({ cwd: assetsDir, onlyFiles: true })) if (!f.split("/").some((s) => s.startsWith("."))) n++;
  } catch { /* no assets/ yet */ }
  // HOOK(validate): once discovery and validation exist, report "N assets · E errors, W warnings" here.
  return `${n} asset file${n === 1 ? "" : "s"} (details: croft validate)`;
}

function checkStorage(r: Report, d: DoctorDeps, project: Project): void {
  const { database, stateDir } = project.paths;
  const dbWhy = d.synced(database);
  const stateWhy = d.synced(stateDir);
  if (dbWhy || stateWhy) {
    const plan = relocationPlan(project.root, dbWhy ?? stateWhy!, d.home);
    const p = problem("SERVE_UNSAFE_FILESYSTEM", {
      message: `${dbWhy ? "the database" : ".croft/"} is in ${dbWhy ?? stateWhy}; file sync and network filesystems can corrupt a DuckDB file mid-write and break its locks`,
      hint: `move ${dbWhy ? database : stateDir} to ${plan.dir} and set "database": "${plan.database}" and "stateDir": "${plan.stateDir}" in croft.json`,
      fix: {
        kind: "manual", requiresHuman: true,
        description: `with no croft command running, move the database and .croft/ to ${plan.dir}, then set "database": "${plan.database}" and "stateDir": "${plan.stateDir}" in croft.json`,
      },
      details: { reason: dbWhy ?? stateWhy, relocateTo: plan.dir },
    });
    r.add("project", "storage", "error", `storage: ${p.message}`, p);
    return;
  }
  const rootWhy = d.synced(project.root);
  if (rootWhy) {
    r.add("project", "storage", "ok", `storage: the project folder is in ${rootWhy}; the database and .croft/ live in ${dirname(database)} (safe)`,
      undefined, { relocated: true, databaseDir: dirname(database) });
  } else {
    r.add("project", "storage", "ok", "storage: local disk (not a synced or network folder)", undefined, { relocated: project.relocated });
  }
}

/** Write and remove a temp file in the state folder (or its nearest existing parent, before the first run). */
function checkWritable(r: Report, project: Project): void {
  let dir = project.paths.stateDir;
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  const probe = join(dir, `.croft-doctor-${process.pid}-${Date.now()}.tmp`);
  const shown = inside(project.root, dir) ? (relative(project.root, dir) || ".") : dir;
  try {
    writeFileSync(probe, "croft doctor write test\n", { flag: "wx" });
    unlinkSync(probe);
    r.add("project", "writable", "ok", `${shown === "." ? "the project folder" : `${shown}/`} is writable`, undefined, { dir });
  } catch (e) {
    try { unlinkSync(probe); } catch { /* never created */ }
    const code = (e as NodeJS.ErrnoException).code ?? "error";
    // No registered code names "folder not writable"; REQUIRES_HUMAN is the closest (a permission fix).
    const p = problem("REQUIRES_HUMAN", {
      message: `croft cannot write to ${dir} (${code}); runs, logs and the trash live there`,
      hint: `make ${dir} writable for your user (for example: chmod u+w ${shellQuote(dir)}), or check that the disk is not full or read-only`,
      fix: { kind: "manual", description: `make ${dir} writable for your user`, requiresHuman: true },
      details: { check: "project_writable", dir, error: code },
    });
    r.add("project", "writable", "error", `${shown}/ is not writable (${code})`, p, { dir });
  }
}

function checkEnvFiles(r: Report, root: string): void {
  let env: ProjectEnv;
  try {
    env = ProjectEnv.load(root, {});
  } catch (e) {
    r.add("project", "env", "warn", `.env cannot be read: ${(e as Error).message}`);
    return;
  }
  for (const p of env.problems()) r.add("project", "env", "warn", `${p.code} ${p.file}: ${p.message}`, p);
  for (const issue of env.issues) {
    const p = problem("ENV_FILE_INVALID", {
      message: `.env ${issue.message}`, hint: "fix that line of .env (KEY=value)", file: ".env", line: issue.line,
      fix: { kind: "manual", description: `fix line ${issue.line} of .env`, requiresHuman: true },
    });
    r.add("project", "env", "warn", `ENV_FILE_INVALID .env: ${issue.message}`, p);
  }
  if (!env.problems().length && !env.issues.length) {
    r.add("project", "env", "ok", existsSync(join(root, ".env")) ? "secrets: .env (read by croft; Bun's .env loading is off)" : "secrets: no .env yet");
  }
}

/** CLAUDE.md's managed block and SKILL.md's version stamp against this croft (CLAUDE_FILES_OUTDATED). */
export function claudeFilesStatus(root: string): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const check = (dir: string, kind: "project" | "app", prefix: string) => {
    const skill = join(dir, ...SKILL_PATH.split("/"));
    if (!existsSync(skill)) reasons.push(`${prefix}${SKILL_PATH} is missing`);
    else {
      const stamp = skillStamp(readFileSync(skill, "utf8"));
      if (stamp !== CROFT_VERSION) reasons.push(`${prefix}${SKILL_PATH} is for croft ${stamp ?? "(no version stamp)"}; this is croft ${CROFT_VERSION}`);
    }
    const claude = join(dir, CLAUDE_MD);
    let block: string | null = null;
    try {
      block = existsSync(claude) ? findBlock(readFileSync(claude, "utf8"))?.text ?? null : null;
    } catch {
      reasons.push(`${prefix}${CLAUDE_MD} has unbalanced croft markers`);
      return;
    }
    if (block === null) reasons.push(`${prefix}${CLAUDE_MD} has no croft block`);
    else if (block.trimEnd() !== claudeBlock(kind).trimEnd()) reasons.push(`${prefix}${CLAUDE_MD}'s croft block differs from croft ${CROFT_VERSION}'s`);
  };
  check(root, "project", "");
  const app = appRootOf(root);
  if (app) check(app, "app", "../");
  return { ok: reasons.length === 0, reasons };
}

function checkClaudeFiles(r: Report, root: string): void {
  const s = claudeFilesStatus(root);
  if (s.ok) {
    r.add("project", "claude", "ok", `Claude files match croft ${CROFT_VERSION} (CLAUDE.md, ${SKILL_PATH})`);
    return;
  }
  const p = problem("CLAUDE_FILES_OUTDATED", {
    message: `the Claude Code files are out of date: ${s.reasons.join("; ")}`,
    hint: "run croft init --claude",
    fix: { kind: "command", description: "refresh CLAUDE.md's croft block and the croft skill", command: "croft init --claude" },
    details: { reasons: s.reasons },
  });
  r.add("project", "claude", "warn", `CLAUDE_FILES_OUTDATED ${s.reasons[0]}${s.reasons.length > 1 ? ` (+${s.reasons.length - 1} more)` : ""}`, p);
}

// ---------------------------------------------------------------------------------------------
// Output

const LABEL: Record<CheckStatus, string> = { ok: "ok", warn: "warn", error: "error", info: "info" };
const TITLES: Record<Section, string> = { environment: "Environment", project: "Project", scheduling: "Scheduling" };

export function formatDoctor(data: DoctorData): string {
  const lines: string[] = [];
  for (const section of ["environment", "project", "scheduling"] as Section[]) {
    const checks = data.checks.filter((c) => c.section === section);
    if (!checks.length) continue;
    lines.push(TITLES[section]);
    for (const c of checks) {
      const [first, ...rest] = c.text.split("\n");
      lines.push(`  ${LABEL[c.status].padEnd(5)} ${first}`);
      for (const l of rest) lines.push(`        ${l}`);
    }
  }
  const { errors, warnings } = data.summary;
  const parts = [];
  if (errors) parts.push(`${errors} ${errors === 1 ? "error" : "errors"}`);
  if (warnings) parts.push(`${warnings} ${warnings === 1 ? "warning" : "warnings"}`);
  lines.push(parts.length ? parts.join(", ") : "no problems found");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------

function declaresCroft(root: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    return ["dependencies", "devDependencies"].some((k) => typeof pkg[k]?.["@zabaca/croft"] === "string");
  } catch {
    return false;
  }
}

function canWrite(p: string): boolean {
  try { accessSync(p, fsConstants.W_OK); return true; } catch { return false; }
}

function realpathSafe(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

function inside(root: string, p: string): boolean {
  return p === root || p.startsWith(root + sep);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

function isWsl(env: Record<string, string | undefined>): boolean {
  if (env.WSL_DISTRO_NAME) return true;
  try { return /microsoft/i.test(readFileSync("/proc/version", "utf8")); } catch { return false; }
}

function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

