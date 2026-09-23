// The launcher: what the croft bin does before anything else (DESIGN.md §2 "The launcher", D34).
//
// The global `croft` (bun add -g) is only a shim. Inside a project it runs that project's pinned copy in
// node_modules/@zabaca/croft, from the project root, with `bun --no-env-file`, so the global and project
// versions can never disagree. Outside a project only init, doctor, docs, version and help work.
//
// Bun loads .env, .env.<NODE_ENV> and .env.local from the working folder into every process started
// without --no-env-file, and that includes this launcher (its shebang is plain `bun`). Children inherit
// those values [V: Bun.spawn and node:child_process both passed them on], so the pinned copy gets an
// environment rebuilt without them, and a copy that runs here but had .env loaded starts itself again
// the same way: croft reads <root>/.env itself, and only declared secrets may reach asset code (§9.8).
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODES, CroftError } from "../core/errors.ts";
import type { Problem } from "../core/types.ts";
import { systemTimeZone } from "../core/time.ts";
import { parseDotenv } from "../project/env.ts";
import { findRoot, notFound } from "../project/root.ts";
import { buildEnvelope, formatProblem, toJsonLine } from "./render.ts";
import { CROFT_VERSION } from "./version.ts";

export const CROFT_PACKAGE = "@zabaca/croft";

/** Commands that work without a project. */
export const OUTSIDE_PROJECT: readonly string[] = ["init", "doctor", "docs", "version", "help"];

/** Environment variables the launcher sets for the pinned copy it starts. */
export const LAUNCH_ENV = {
  delegatedTo: "CROFT_DELEGATED_TO",       // realpath of the copy: guards against delegating in a loop
  launcherVersion: "CROFT_LAUNCHER_VERSION", // for doctor's "project-pinned; launcher 0.1.0"
  callerCwd: "CROFT_CALLER_CWD",           // where the user typed the command (init resolves [dir] from it)
} as const;

/** The package root of the croft copy that is running. */
export const SELF_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export type LaunchPlan =
  | { kind: "local" }
  | { kind: "refuse"; problem: Problem; exit: number }
  | { kind: "install"; root: string }
  | { kind: "delegate"; root: string; copy: string; bin: string };

export interface PlanInput {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string | undefined>;
  isBun: boolean;
  selfRoot: string;
  commandNames: readonly string[];
  /** Set after an install attempt, so a failed install does not loop. */
  installFailed?: { exit: number | null };
}

/** The command name and --json, found the way main.ts finds them (first non-flag argument before "--"). */
export function scanCommand(argv: readonly string[]): { name: string; json: boolean } {
  let name: string | undefined;
  let json = false;
  let version = false;
  for (const a of argv) {
    if (a === "--") break;
    if (a === "--json") json = true;
    else if (a === "--version" || a === "-V") version = true;
    else if (name === undefined && !a.startsWith("-")) name = a;
  }
  return { name: version ? "version" : name ?? "help", json };
}

/** Decide what this invocation does. Reads the file system; never writes. */
export function planLaunch(i: PlanInput): LaunchPlan {
  if (!i.isBun) return { kind: "refuse", problem: needsBun().problem, exit: CODES.NEEDS_BUN.exit };
  const { name } = scanCommand(i.argv);
  const root = findRoot(i.cwd);
  if (!root) {
    // Unknown names go to main.ts, which answers with a did-you-mean.
    if (OUTSIDE_PROJECT.includes(name) || !i.commandNames.includes(name)) return { kind: "local" };
    const e = notFound(i.cwd);
    return {
      kind: "refuse", exit: e.exit,
      problem: { ...e.problem, message: `croft ${name} works inside a croft project; ${e.problem.message}`, details: { command: name, allowedOutside: [...OUTSIDE_PROJECT] } },
    };
  }

  const copy = join(root, "node_modules", ...CROFT_PACKAGE.split("/"));
  if (existsSync(join(copy, "package.json"))) {
    const realCopy = realpathSync(copy);
    if (realCopy === realpath(i.selfRoot)) return { kind: "local" };
    if (i.env[LAUNCH_ENV.delegatedTo] === realCopy) return { kind: "local" };   // already delegated once
    return { kind: "delegate", root, copy: realCopy, bin: binOf(realCopy) };
  }
  if (!declaresCroft(root)) return { kind: "local" };                         // nothing pinned: run this copy
  // The pinned copy is missing. Diagnostic commands run from this copy without installing anything (doctor
  // promises no writes and then says what is missing); unknown names go to main.ts for a did-you-mean.
  if (OUTSIDE_PROJECT.includes(name) || !i.commandNames.includes(name)) return { kind: "local" };
  // After a fresh clone node_modules is missing entirely: install once. A node_modules without croft (or a
  // failed install) is not retried on every command; anything that could write data with a version the
  // project did not pin is refused until `bun install` succeeds.
  if (!existsSync(join(root, "node_modules")) && !i.installFailed) return { kind: "install", root };
  const why = i.installFailed
    ? `bun install ${i.installFailed.exit === null ? "could not start" : `exited with ${i.installFailed.exit}`}`
    : "node_modules has no @zabaca/croft";
  const problem = new CroftError("DUCKDB_BINDING_MISSING", {
    message: `this project's dependencies are not installed (${why}), so its pinned croft cannot run`,
    hint: `fix what bun install reports, then retry: cd ${root} && bun install`,
    fix: { kind: "command", description: "install the project's dependencies", command: `cd ${shellQuote(root)} && bun install` },
    details: { root },
  }).problem;
  return { kind: "refuse", problem, exit: CODES.DUCKDB_BINDING_MISSING.exit };
}

export interface LaunchOptions {
  /** Runs this copy's CLI (main.ts's main). */
  main: (argv: readonly string[]) => Promise<number>;
  commandNames: readonly string[];
  argv?: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  isBun?: boolean;
  selfRoot?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** `bun install` in the project; returns its exit code (null when it could not start). */
  install?: (root: string) => number | null;
  /** Starts the pinned copy and resolves with its exit code. */
  delegate?: (plan: Extract<LaunchPlan, { kind: "delegate" }>, argv: readonly string[], env: Record<string, string>) => Promise<number>;
}

/** Run one invocation of the croft bin and return its exit code. */
export async function launch(o: LaunchOptions): Promise<number> {
  const argv = o.argv ?? process.argv.slice(2);
  const cwd = o.cwd ?? process.cwd();
  const env = o.env ?? process.env;
  const input: PlanInput = {
    argv, cwd, env, isBun: o.isBun ?? typeof globalThis.Bun !== "undefined",
    selfRoot: o.selfRoot ?? SELF_ROOT, commandNames: o.commandNames,
  };
  const stderr = o.stderr ?? ((t: string) => void process.stderr.write(t));
  let plan = planLaunch(input);
  if (plan.kind === "install") {
    stderr(`croft: installing this project's dependencies first (bun install in ${plan.root})\n`);
    const exit = (o.install ?? bunInstall)(plan.root);
    if (exit !== 0) stderr(`croft: bun install ${exit === null ? "could not start" : `exited with ${exit}`}\n`);
    plan = planLaunch({ ...input, ...(exit === 0 ? {} : { installFailed: { exit } }) });
    if (plan.kind === "install") plan = { kind: "local" };                  // installed, but no copy appeared
  }
  if (plan.kind === "refuse") {
    emitRefusal(plan.problem, scanCommand(argv), o.stdout ?? ((t) => void process.stdout.write(t)), stderr);
    return plan.exit;
  }
  if (plan.kind === "delegate") {
    const childEnv = launcherEnv(env, cwd);
    childEnv[LAUNCH_ENV.delegatedTo] = plan.copy;
    childEnv[LAUNCH_ENV.launcherVersion] = CROFT_VERSION;
    childEnv[LAUNCH_ENV.callerCwd] = cwd;
    return (o.delegate ?? spawnPinned)(plan, argv, childEnv);
  }
  // Running here. If Bun loaded .env files into this process, start this same copy again the way the
  // launcher starts a pinned one. Deleting the keys from process.env is not enough: Bun spawns children
  // with the environment it started with unless given one [V], so asset code could still pass secrets on.
  const loaded = bunDotenvKeys(env, cwd);
  if (loaded.length && env[LAUNCH_ENV.delegatedTo] === undefined) {
    const self = realpath(input.selfRoot);
    const childEnv = launcherEnv(env, cwd);
    childEnv[LAUNCH_ENV.delegatedTo] = self;
    return (o.delegate ?? spawnPinned)({ kind: "delegate", root: cwd, copy: self, bin: binOf(self) }, argv, childEnv);
  }
  for (const k of loaded) delete env[k];      // a shell value equal to the file's: croft reads .env itself
  return o.main(argv);
}

/** Start the pinned copy with `bun --no-env-file` from the project root, forwarding stdio, signals and
 *  the exit code. Bun has no exec(), so the launcher waits for the child. */
async function spawnPinned(plan: Extract<LaunchPlan, { kind: "delegate" }>, argv: readonly string[], env: Record<string, string>): Promise<number> {
  const child = Bun.spawn([process.execPath, "--no-env-file", plan.bin, ...argv], {
    cwd: plan.root, env, stdio: ["inherit", "inherit", "inherit"],
  });
  // Ctrl-C on a terminal reaches the whole foreground process group, child included, so the launcher only
  // has to survive it; a signal sent to the launcher alone is passed on.
  const forward = (sig: NodeJS.Signals) => () => {
    if (sig === "SIGINT" && process.stdin.isTTY) return;
    try { child.kill(sig); } catch { /* already gone */ }
  };
  const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((sig) => [sig, forward(sig)] as const);
  for (const [sig, h] of handlers) process.on(sig, h);
  try {
    await child.exited;
  } finally {
    for (const [sig, h] of handlers) process.off(sig, h);
  }
  if (child.exitCode !== null) return child.exitCode;
  const signal = child.signalCode as keyof typeof constants.signals | null;
  return 128 + (signal ? constants.signals[signal] ?? 1 : 1);
}

function bunInstall(root: string): number | null {
  // bun install's own output goes to stderr, so a --json caller still gets exactly one envelope on stdout.
  const r = Bun.spawnSync([process.execPath, "install"], { cwd: root, stdio: ["ignore", 2, 2] });
  return r.exitCode;
}

/** Keys Bun loaded into this process from .env files in `cwd` (.env, .env.<NODE_ENV or development>, and
 *  .env.local unless NODE_ENV=test [V]). A value that differs from every file's value came from the shell
 *  (Bun never overrides the shell [V]) and is not listed. A file value with `$` cannot be compared, because
 *  Bun expands it [V], so its key is listed. */
export function bunDotenvKeys(env: Record<string, string | undefined>, cwd: string): string[] {
  const nodeEnv = env.NODE_ENV || "development";
  const files = [".env", `.env.${nodeEnv}`, ...(nodeEnv === "test" ? [] : [".env.local"])];
  const drop = new Set<string>();
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(join(cwd, f), "utf8");
    } catch {
      continue;
    }
    for (const [k, v] of parseDotenv(text).values) {
      if (env[k] !== undefined && (env[k] === v || v.includes("$"))) drop.add(k);
    }
  }
  return [...drop];
}

/** The environment for the pinned copy: this process's, minus what Bun loaded from .env files in `cwd`. */
export function launcherEnv(env: Record<string, string | undefined>, cwd: string): Record<string, string> {
  const drop = new Set(bunDotenvKeys(env, cwd));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !drop.has(k)) out[k] = v;
  return out;
}

function emitRefusal(p: Problem, scan: { name: string; json: boolean }, stdout: (t: string) => void, stderr: (t: string) => void): void {
  if (scan.json) {
    stdout(toJsonLine(buildEnvelope({ command: scan.name, ok: false, data: null, problems: [p], next: [], database: "", timezone: systemTimeZone(), durationMs: 0 })));
  } else {
    stderr(`${formatProblem(p)}\n`);
  }
}

function needsBun(): CroftError {
  return new CroftError("NEEDS_BUN", {
    message: "croft runs on Bun, not Node or another runtime",
    hint: "install Bun (curl -fsSL https://bun.sh/install | bash), then run croft again",
    fix: { kind: "command", description: "install Bun", command: "curl -fsSL https://bun.sh/install | bash", requiresHuman: true },
  });
}

/** The bin file of an installed croft copy (package.json "bin"), defaulting to src/cli/main.ts. */
export function binOf(copy: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(copy, "package.json"), "utf8")) as { bin?: string | Record<string, string> };
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.croft;
    if (bin) return join(copy, bin);
  } catch { /* fall through */ }
  return join(copy, "src", "cli", "main.ts");
}

/** Whether <root>/package.json asks for @zabaca/croft (so a missing copy means "run bun install"). */
export function declaresCroft(root: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    return ["dependencies", "devDependencies", "optionalDependencies"].some((k) => typeof pkg[k]?.[CROFT_PACKAGE] === "string");
  } catch {
    return false;
  }
}

function realpath(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}
