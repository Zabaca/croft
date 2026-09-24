// croft doctor (DESIGN.md §2 "Install-time failures", §4.1): the environment plus a project summary,
// in under a second, with no writes except the one write test the design asks for (a temp file in the
// state folder, removed at once) and the trash's retention (checkTrash deletes expired trashed versions).
//
// DuckDB is never imported statically here. The binding is checked in a child process first (a missing
// or foreign-arch binding must be reported, not crash doctor), and only then is db/warehouse.ts imported
// to look at the warehouse read-only; if that import still fails, the warehouse check says so.
//
// Human output shows each problem under its check, with its fix, as in the §2 example
// (humanShowsProblems in the registry), rather than main.ts appending the standard blocks.
//
// The Scheduling section (§2, §8) says whether scheduling is on, who ticks (the per-user OS job or croft serve)
// and when the last tick was, from runs.sqlite without creating it. A scheduler quiet for 3 minutes while on is
// SCHEDULER_STALE with the likely cause and the end of the tick log; only then is the OS job inspected
// (launchctl print, crontab -l). A paused project is told the command that resumes it as it was: `croft schedule
// on --no-os-job` for one ticked by croft serve only.
//
// With readCopy on, the Environment section has the read copy's line (db/readcopy.ts, which imports DuckDB only to
// refresh): a refresh that failed, or a copy older than the last run that wrote data, is a warning whose hint
// names .croft/readcopy.log.
//
// The data's health, in the Project section, without writing anything:
// - tables (§5 "Out-of-band changes"): in the warehouse's read lease, every table croft has a commit of is compared
//   with its record (safety/out-of-band.ts): OUT_OF_BAND_CHANGE for rows or stamps, TABLE_MODIFIED_OUTSIDE_CROFT for
//   columns, a warning line each; the next run of the asset takes the change in. Not while a croft writer is live.
// - drift (§7): the COLUMN_STOPPED_ARRIVING, JSON_KIND_CHANGED and TYPE_WIDENED warnings of the last 7 days' runs
//   (history/drift.ts), an info line, since the runs reported them.
// - backups (§6 "Before an engine upgrade", db/backup.ts): the pre-upgrade backups in .croft/backups/, and whether
//   the next command that writes backs the warehouse up first (this croft's DuckDB is newer than the recorded one).
import { accessSync, constants as fsConstants, existsSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { CroftError, problem } from "../../core/errors.ts";
import { now, offsetSeconds } from "../../core/time.ts";
import type { LockHolder, Problem } from "../../core/types.ts";
import { BACKUPS_KEPT, backupsDir, compareEngineVersions, type EngineRecord, listBackups, recordedEngine } from "../../db/backup.ts";
import { filesystemKind, folderKind, type FsKind } from "../../db/fs-kind.ts";
import { isHolderAlive, liveIntents } from "../../db/intent.ts";
import { readCopyStatus, readCopySummary } from "../../db/readcopy.ts";
import { CLAUDE_MD, claudeBlock, findBlock, SKILL_PATH, skillStamp } from "../../agent/templates.ts";
import { type DriftEntry, driftTexts, recentDrift } from "../../history/drift.ts";
import { RUNS_DB_FILE, RunsDb } from "../../history/runs-db.ts";
import { ProjectEnv } from "../../project/env.ts";
import { appRootOf, relocationPlan } from "../../project/init.ts";
import { configProblems, findRoot, loadProject, syncedLocation, type ConfigIssue, type Project } from "../../project/root.ts";
import { croftHome, type CroftHome } from "../../schedule/home.ts";
import { type OsRunner, realRunner } from "../../schedule/os.ts";
import type { CommandImpl } from "../command.ts";
import { LAUNCH_ENV, SELF_ROOT } from "../launcher.ts";
import { formatCount, formatProblem } from "../render.ts";
import { BUN_FLOOR, BUN_TESTED, CROFT_VERSION, versionAtLeast } from "../version.ts";
import {
  agoText, clockText, logTailLines, readScheduling, resumeCommand, schedulingJson, type SchedulingRecord, staleProblem, tickerText,
} from "./schedule.ts";

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
  /** DuckDB's UTC offsets (seconds) for `tz` at each instant (epoch ms), from its bundled ICU data; null when
   *  DuckDB does not know the zone. Default: duckdbOffsets (an in-memory DuckDB, after the binding check passed). */
  duckdbOffsets?(tz: string, instants: readonly number[]): Promise<number[] | null>;
  rosetta(): boolean;
  synced(path: string): string | null;
  /** The filesystem of the database ("file") or of .croft/ ("folder"), db/fs-kind.ts: a VM or container share or a
   *  network mount is SERVE_UNSAFE_FILESYSTEM. Default: the real probe (df and mount on macOS, /proc/mounts on Linux). */
  filesystem?(path: string, kind: "file" | "folder"): FsKind;
  /** ~/.croft, for the Scheduling section's diagnosis (the registry, the job's plist, tick.log). Default croftHome(env). */
  croftHome?: CroftHome;
  /** Inspects the scheduler job when the scheduler is stale. Default: realRunner. */
  osRunner?: OsRunner;
  /** How long the warehouse probe waits on a lock before naming the holder. */
  lockWaitMs: number;
  healthTimeoutMs: number;
  /** How long the tables line may spend comparing tables with croft's record (TABLE_SCAN_MS). */
  tableScanMs?: number;
}

/** The tables line compares no more tables once this has passed, so doctor stays quick on a big warehouse. */
export const TABLE_SCAN_MS = 400;

export function defaultDeps(env: Record<string, string | undefined>): DoctorDeps {
  return {
    bunVersion: Bun.version,
    platform: process.platform,
    arch: process.arch,
    croftRoot: SELF_ROOT,
    env,
    home: homedir(),
    wsl: process.platform === "linux" && isWsl(env),
    probeDuckdb: (croftRoot) => probeDuckdb(croftRoot, env),
    duckdbOffsets,
    rosetta: () => rosetta(env),
    synced: (p) => syncedLocation(p),
    croftHome: croftHome(env),
    // The test tripwire of this process holds whatever environment doctor was given.
    osRunner: realRunner(process.env.CROFT_FORBID_OS_JOBS === "1" ? { ...env, CROFT_FORBID_OS_JOBS: "1" } : env),
    lockWaitMs: 150,
    healthTimeoutMs: 300,
  };
}

/** croft doctor. Its spec (name, usage, humanShowsProblems) is in commands/index.ts. */
export const doctor: CommandImpl<DoctorData> = {
  async run(ctx) {
    const { data, problems } = await runDoctor(ctx.cwd, defaultDeps(ctx.processEnv));
    const errors = data.checks.filter((c) => c.status === "error").length;
    return { data, problems, next: nextFor(problems), ...(errors > 0 && !problems.some((p) => p.severity === "error") ? { exit: 1, ok: false } : {}) };
  },
  human(result) {
    return formatDoctor(result.data, result.problems);
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
  const found: { scan: TableScanResult } = { scan: null };
  if (project) {
    await checkWarehouse(r, d, project, probe.ok, found);
    await checkServe(r, d, project);
    checkReadCopy(r, d, project);
    if (probe.ok) await checkTzdata(r, d, project.timezone);
  }

  // Project
  if (!root) {
    r.add("project", "project", "info", "no croft project here (croft init creates one)");
  } else if (configIssues) {
    const problems = configProblems(configIssues);
    problems.forEach((p, i) => r.add("project", i === 0 ? "config" : `config.${i}`, "error", `croft.json: ${p.message}`, p));
  } else if (project) {
    r.add("project", "config", "ok", `croft.json · timezone ${project.timezone}`);
  }
  if (project) {
    await checkAssets(r, d, project, probe.ok);
    checkTables(r, found.scan);
    checkDrift(r, d, project);
    checkStorage(r, d, project);
    checkWritable(r, project);
    await checkTrash(r, d, project);
    checkBackups(r, d, project, probe);
  }
  if (root) checkEnvFiles(r, root);
  if (project) await checkSecrets(r, d, project, probe.ok);
  if (root) checkClaudeFiles(r, root);
  if (d.wsl) {
    r.add("environment", "wsl", "info", "WSL stops its VM when no terminal is open, so scheduled runs pause until one is");
  }
  if (project) checkScheduling(r, d, project);

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
    const p = problem("BUN_UNTESTED", {
      message: `Bun ${d.bunVersion} is newer than the newest Bun croft ${CROFT_VERSION} was tested on (${BUN_TESTED})`,
      hint: `croft usually works on a newer Bun; if something breaks, try Bun ${BUN_TESTED} (curl -fsSL https://bun.sh/install | bash -s bun-v${BUN_TESTED}) or a newer croft`,
      fix: { kind: "manual", description: `if croft misbehaves, install Bun ${BUN_TESTED} or upgrade croft`, requiresHuman: true },
      details: { bun: d.bunVersion, tested: BUN_TESTED },
    });
    r.add("environment", "bun", "warn", `bun ${d.bunVersion} (${where}) is newer than the newest Bun croft ${CROFT_VERSION} was tested on (${BUN_TESTED}); if something breaks, try Bun ${BUN_TESTED}`,
      p, { tested: BUN_TESTED });
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
export function probeDuckdb(croftRoot: string, env: Record<string, string | undefined> = process.env): DuckdbProbe {
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
      cwd: realpathSafe(croftRoot), env: childEnv(env), stdout: "pipe", stderr: "pipe", timeout: 15_000,
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
function rosetta(env: Record<string, string | undefined>): boolean {
  if (process.platform !== "darwin" || process.arch !== "x64") return false;
  const r = Bun.spawnSync(["sysctl", "-n", "sysctl.proc_translated"], { env: childEnv(env), stdout: "pipe", stderr: "ignore" });
  return r.stdout.toString().trim() === "1";
}

/** The environment a child gets. Always passed explicitly: without it Bun hands children the environment
 *  it started with, including values it loaded from .env that croft has since removed [V]. */
export function childEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
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

/** What the warehouse's read lease found of tables changed outside croft (safety/out-of-band.ts scanTables), for the
 *  Project section: null when the warehouse was not opened or has no croft state, an Error when the comparison failed. */
type TableScanResult = import("../../safety/out-of-band.ts").TableScan | Error | null;

/** The warehouse line. In the same read lease, the tables croft has a record of are compared with it (`found.scan`). */
async function checkWarehouse(r: Report, d: DoctorDeps, project: Project, bindingOk: boolean, found: { scan: TableScanResult }): Promise<void> {
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
  let openWarehouse: typeof import("../../db/warehouse.ts").openWarehouse;
  let readMeta: typeof import("../../db/state.ts").readMeta;
  let scanTables: typeof import("../../safety/out-of-band.ts").scanTables;
  try {
    ({ openWarehouse } = await import("../../db/warehouse.ts"));
    ({ readMeta } = await import("../../db/state.ts"));
    ({ scanTables } = await import("../../safety/out-of-band.ts"));
  } catch (e) {
    // The child-process probe loaded the binding, but this process cannot: report it, do not crash.
    const msg = (e as Error).message ?? String(e);
    const reinstall = `cd ${shellQuote(project.root)} && rm -rf node_modules && bun install`;
    const p = problem("DUCKDB_BINDING_LOAD", {
      message: `the DuckDB binding loads in a separate process but not in croft doctor's own: ${msg.split("\n")[0]!.slice(0, 300)}`,
      hint: `run ${reinstall}, then croft doctor again`,
      fix: { kind: "command", description: "reinstall the dependencies", command: reinstall },
      details: { error: msg.slice(0, 500) },
    });
    r.add("environment", "warehouse", "error", `${parts.join(" · ")} · not opened: ${p.message}`, p, details);
    return;
  }
  const w = openWarehouse({
    path, mode: "read_only", profile: "query", timezone: project.timezone, root: project.root, stateDir: project.paths.stateDir,
    isTTY: false, register: false, lingerMs: 0, noticeAfterMs: Number.MAX_SAFE_INTEGER,
  });
  const serve = servePid(project.paths.stateDir);
  try {
    const meta = await w.read(async (db) => {
      const m = await readMeta(db);
      if (m.format_version) {
        try {
          found.scan = await scanTables(db, { budgetMs: d.tableScanMs ?? TABLE_SCAN_MS });
        } catch (e) {
          found.scan = e instanceof Error ? e : new Error(String(e));
        }
      }
      return m;
    }, { waitMs: d.lockWaitMs, purpose: "doctor" });
    const serveHolds = serve !== null && serve.alive;
    parts.push(serveHolds ? `held read-only by croft's read server (pid ${serve.pid}; steps aside for writes)` : "not held");
    if (meta.format_version) {
      parts.push(`duckdb ${String(meta.duckdb_version ?? "?").replace(/^v/, "")} · croft format ${meta.format_version}`);
    } else {
      parts.push("no croft state yet");
    }
    Object.assign(details, { meta, heldBy: serveHolds ? { pid: serve.pid, program: "croft's read server" } : null });
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
        const first = msg.split("\n")[0]!.slice(0, 200);
        const p = problem("DB_UNREADABLE", {
          message: `${label} cannot be opened as a DuckDB database: ${first}`,
          hint: `check that ${path} is this project's DuckDB file and that it is readable; if it is damaged, restore it from a backup`,
          fix: { kind: "manual", description: `check or restore ${path}`, requiresHuman: true },
          details: { path, error: msg.slice(0, 500) },
        });
        r.add("environment", "warehouse", "error", `${parts.join(" · ")} · cannot be opened: ${first}`, p,
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
    r.add("environment", "serve", "info", "no read server running (apps read the warehouse file directly)", undefined, { running: false });
    return;
  }
  if (!s.alive) {
    r.add("environment", "serve", "info", `no read server running (serve.json is left from pid ${s.pid})`, undefined, { running: false, stalePid: s.pid });
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
      message: `croft's read server (pid ${s.pid}) is running but does not answer on ${s.url ?? "its recorded address"}`,
      hint: `ask the user to stop process ${s.pid}: it recorded serve.json but does not answer, and apps read the warehouse file directly once it is gone`,
      fix: { kind: "manual", description: `stop the server process that does not answer (pid ${s.pid})`, requiresHuman: true },
      retryable: true,
      details: { pid: s.pid, url: s.url },
    });
    r.add("environment", "serve", "error", `read server (pid ${s.pid}) does not answer on ${where}`, p, { running: true, pid: s.pid, url: s.url });
    return;
  }
  const queries = typeof health.queriesToday === "number" ? ` · ${formatCount(health.queriesToday)} queries today` : "";
  r.add("environment", "serve", "ok", `read server on ${where} (pid ${s.pid}) · token in ${shownFile}${queries}`, undefined,
    { running: true, pid: s.pid, url: s.url, queriesToday: health.queriesToday ?? null });
}

/**
 * The read copy (readCopy on, §5; R32-11): its path and how old it is. A refresh that failed (with its error), or a
 * copy older than the last run that wrote data, is a warning with a hint that names .croft/readcopy.log; "not made
 * yet" is an info line. A stat and runs.sqlite only (db/readcopy.ts readCopyStatus): the copy is never opened.
 */
function checkReadCopy(r: Report, d: DoctorDeps, project: Project): void {
  if (!project.config.readCopy) return;
  let at: Date;
  try { at = now(d.env); } catch { at = new Date(); }
  const s = readCopySummary(readCopyStatus(project), project, at);
  if (!s) return;
  const lines = [`read copy ${s.text}`, ...(s.hint ? [`hint: ${s.hint}`] : [])];
  const status = s.warning ? "warn" : s.view.health === "missing" ? "info" : "ok";
  r.add("environment", "readcopy", status, lines.join("\n"), undefined, { ...s.view });
}

// JSON timestamps take their offsets from Bun's Intl (core/time.ts); `::DATE` and every SQL time function use
// DuckDB's bundled ICU data. When the two tzdata releases disagree for the project zone, a row's JSON timestamp
// and its ::DATE can fall on different days. Compared from now over the next two years: every 12 hours, and
// every 15 minutes across each 12-hour step where either side's offset changes (a transition), which catches a
// different offset as well as a different switch time. Silent when they agree.
const TZ_HORIZON_MS = 731 * 86_400_000;
const TZ_STEP_MS = 12 * 3_600_000;
const TZ_FINE_MS = 15 * 60_000;

async function checkTzdata(r: Report, d: DoctorDeps, tz: string): Promise<void> {
  const lookup = d.duckdbOffsets ?? duckdbOffsets;
  let start: number;
  try { start = now(d.env).getTime(); } catch { start = Date.now(); }
  start = Math.floor(start / TZ_STEP_MS) * TZ_STEP_MS;
  const coarse: number[] = [];
  for (let t = start; t <= start + TZ_HORIZON_MS; t += TZ_STEP_MS) coarse.push(t);
  let samples: { at: number; bun: number; duckdb: number }[];
  try {
    const duck = await lookup(tz, coarse);
    if (duck === null) {
      const p = problem("TZDATA_MISMATCH", {
        message: `DuckDB's time zone data does not know ${tz}, which Bun's accepts; croft sets the project zone on every DuckDB connection`,
        hint: `set "timezone" in croft.json to a zone name DuckDB also knows (the canonical IANA name, such as America/Los_Angeles)`,
        fix: { kind: "manual", description: `change "timezone" in croft.json to a zone DuckDB knows` },
        details: { timezone: tz, duckdbKnowsZone: false },
      });
      r.add("environment", "tzdata", "warn", `time zone data: DuckDB does not know ${tz}`, p, { timezone: tz });
      return;
    }
    const bun = coarse.map((t) => offsetSeconds(t, tz));
    const fine: number[] = [];
    for (let i = 1; i < coarse.length; i++) {
      if (bun[i] === bun[i - 1] && duck[i] === duck[i - 1]) continue;
      for (let t = coarse[i - 1]! + TZ_FINE_MS; t < coarse[i]!; t += TZ_FINE_MS) fine.push(t);
    }
    const fineDuck = fine.length ? (await lookup(tz, fine)) ?? [] : [];
    samples = [
      ...coarse.map((at, i) => ({ at, bun: bun[i]!, duckdb: duck[i]! })),
      ...fine.map((at, i) => ({ at, bun: offsetSeconds(at, tz), duckdb: fineDuck[i]! })),
    ].sort((a, b) => a.at - b.at);
  } catch (e) {
    const msg = ((e as Error).message ?? String(e)).split("\n")[0]!.slice(0, 200);
    r.add("environment", "tzdata", "info", `time zone data: not compared with DuckDB's (${msg})`, undefined, { timezone: tz });
    return;
  }
  const bad = samples.filter((s) => s.bun !== s.duckdb);
  if (bad.length === 0) return;
  const show = (s: { at: number; bun: number; duckdb: number }) =>
    ({ at: new Date(s.at).toISOString().replace(".000Z", "Z"), bun: offsetText(s.bun), duckdb: offsetText(s.duckdb) });
  const first = show(bad[0]!);
  const last = show(bad.at(-1)!);
  const from = new Date(start).toISOString().slice(0, 10);
  const until = new Date(start + TZ_HORIZON_MS).toISOString().slice(0, 10);
  const p = problem("TZDATA_MISMATCH", {
    message: `Bun's and DuckDB's time zone data disagree for ${tz} at ${formatCount(bad.length)} of ${formatCount(samples.length)} instants `
      + `checked from ${from} to ${until}, first at ${first.at} (Bun ${first.bun}, DuckDB ${first.duckdb}). JSON timestamps use Bun's `
      + `offsets and ::DATE uses DuckDB's, so near those instants a row's JSON timestamp and its ::DATE can fall on different days`,
    hint: "upgrade Bun (bun upgrade) and croft so both carry a current tzdata release; until they agree, take days from SQL (::DATE), not from JSON timestamps",
    fix: { kind: "manual", description: "upgrade Bun and croft until both use the same tzdata release; meanwhile compute days in SQL", requiresHuman: true },
    details: { timezone: tz, checked: samples.length, mismatches: bad.length, from, until, first, last },
  });
  r.add("environment", "tzdata", "warn", `time zone data: Bun and DuckDB disagree for ${tz} (first at ${first.at}: Bun ${first.bun}, DuckDB ${first.duckdb})`,
    p, { timezone: tz });
}

/** DuckDB's offsets for `tz`, read through its session TimeZone exactly as `::DATE` sees them; null when
 *  DuckDB does not know the zone. */
export async function duckdbOffsets(tz: string, instants: readonly number[]): Promise<number[] | null> {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const db = await DuckDBInstance.create(":memory:");
  const c = await db.connect();
  try {
    try {
      await c.run(`SET TimeZone = '${tz.replaceAll("'", "''")}'`);
    } catch (e) {
      if (/Unknown TimeZone/i.test((e as Error).message)) return null;
      throw e;
    }
    const ms = instants.map((t) => Math.trunc(t));
    if (ms.length === 0) return [];
    const reader = await c.runAndReadAll(`SELECT t, date_part('timezone', make_timestamptz(t * 1000))::INTEGER AS off
      FROM unnest([${ms.join(",")}]::BIGINT[]) AS u(t)`);
    const byInstant = new Map<number, number>();
    for (const [t, off] of reader.getRowsJS() as [bigint, number][]) byInstant.set(Number(t), off);
    return ms.map((t) => byInstant.get(t) ?? Number.NaN);
  } finally {
    c.disconnectSync();
    db.closeSync();
  }
}

/** ±HH:MM, with :SS only for historic second offsets. */
function offsetText(seconds: number): string {
  if (!Number.isFinite(seconds)) return "?";
  const a = Math.abs(seconds);
  const ss = a % 60;
  return `${seconds < 0 ? "-" : "+"}${String(Math.floor(a / 3600)).padStart(2, "0")}:${String(Math.floor((a % 3600) / 60)).padStart(2, "0")}${ss ? `:${String(ss).padStart(2, "0")}` : ""}`;
}

// ---------------------------------------------------------------------------------------------
// Project

function assetFileCount(assetsDir: string): number {
  let n = 0;
  try {
    for (const f of new Bun.Glob("**/*.{ts,sql}").scanSync({ cwd: assetsDir, onlyFiles: true })) if (!f.split("/").some((s) => s.startsWith("."))) n++;
  } catch { /* no assets/ yet */ }
  return n;
}

/**
 * The assets, validated as `croft validate` validates them (static checks and the bind check, on an in-memory
 * DuckDB; never the warehouse): "6 assets · 0 errors, 1 warning (details: croft validate)" (§2). The problems
 * stay validate's and doctor shows the counts: the line is an error when an asset has one, ok otherwise.
 * validate.ts imports DuckDB, so it is loaded only after the binding check passed; without a binding the files
 * are only counted.
 */
async function checkAssets(r: Report, d: DoctorDeps, project: Project, bindingOk: boolean): Promise<void> {
  const files = assetFileCount(project.paths.assetsDir);
  const filesText = `${files} asset file${files === 1 ? "" : "s"}`;
  if (!bindingOk) {
    r.add("project", "assets", "info", `${filesText}, not validated (validating needs the DuckDB binding)`);
    return;
  }
  // Before bun install, every TS asset fails to import @zabaca/croft; the croft line already says to install.
  if (declaresCroft(project.root) && !existsSync(join(project.root, "node_modules", "@zabaca", "croft", "package.json"))) {
    r.add("project", "assets", "info", `${filesText}, not validated until the project's packages are installed (bun install)`);
    return;
  }
  let problems: Problem[];
  let assets: number;
  try {
    const { validateProject } = await import("./validate.ts");
    const report = await validateProject({ project, env: ProjectEnv.load(project.root, d.env), importTimeoutMs: 5000 });
    problems = report.problems;
    assets = report.data.assets.length;
  } catch (e) {
    r.add("project", "assets", "info", `${filesText}, not validated: ${String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 200)}`);
    return;
  }
  const count = (s: Problem["severity"]) => problems.filter((p) => p.severity === s).length;
  const errors = count("error");
  const warnings = count("warning");
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  r.add("project", "assets", errors > 0 ? "error" : "ok",
    `${plural(assets, "asset")} · ${plural(errors, "error")}, ${plural(warnings, "warning")} (details: croft validate)`,
    undefined, { assets, errors, warnings, info: count("info") });
}

function checkStorage(r: Report, d: DoctorDeps, project: Project): void {
  const { database, stateDir } = project.paths;
  const dbWhy = d.synced(database);
  const stateWhy = d.synced(stateDir);
  if (dbWhy || stateWhy) {
    const why = dbWhy ?? stateWhy!;
    const plan = relocationPlan(project.root, why, d.home);
    // A mount whose locks cannot be trusted (a network filesystem, 9p such as WSL's drives) is an error
    // (§5 "Same kernel only"); a sync folder is a warning, with the move that fixes it.
    const unsafe = unsafeMount(why);
    const p = problem(unsafe ? "SERVE_UNSAFE_FILESYSTEM" : "DB_ON_SYNCED_FOLDER", {
      message: unsafe
        ? `${dbWhy ? "the database" : ".croft/"} is on ${why}, where DuckDB's file lock does not hold and writes can be lost`
        : `${dbWhy ? "the database" : ".croft/"} is in ${why}; file sync can corrupt a DuckDB file mid-write and break its locks`,
      hint: `move ${dbWhy ? database : stateDir} to ${plan.dir} and set "database": "${plan.database}" and "stateDir": "${plan.stateDir}" in croft.json`,
      fix: {
        kind: "manual", requiresHuman: true,
        description: `with no croft command running, move the database and .croft/ to ${plan.dir}, then set "database": "${plan.database}" and "stateDir": "${plan.stateDir}" in croft.json`,
      },
      details: { reason: why, relocateTo: plan.dir },
    });
    r.add("project", "storage", unsafe ? "error" : "warn", `storage: ${p.message}`, p);
    return;
  }
  // The mount itself (db/fs-kind.ts): a VM or container share (virtiofs, Docker Desktop's grpcfuse and fakeowner,
  // 9p) or a network filesystem, where a process on the other side neither sees nor honors DuckDB's lock.
  const fsOf = d.filesystem ?? ((p: string, kind: "file" | "folder") => (kind === "file" ? filesystemKind(p) : folderKind(p)));
  const mounts = [
    { what: "the database", path: database, kind: fsOf(database, "file") },
    { what: ".croft/", path: stateDir, kind: fsOf(stateDir, "folder") },
  ];
  const bad = mounts.find((m) => m.kind.unsafe !== null);
  if (bad) {
    const why = bad.kind.unsafe!;
    const plan = relocationPlan(project.root, why, d.home);
    const p = problem("SERVE_UNSAFE_FILESYSTEM", {
      message: `${bad.what} is on ${why}, where DuckDB's file lock does not hold across machines and writes can be lost`,
      hint: `move ${bad.path} to ${plan.dir} (a disk of the machine that runs croft) and set "database": "${plan.database}" and "stateDir": "${plan.stateDir}" in croft.json`,
      fix: {
        kind: "manual", requiresHuman: true,
        description: `with no croft command running, move the database and .croft/ to ${plan.dir}, then set "database": "${plan.database}" and "stateDir": "${plan.stateDir}" in croft.json`,
      },
      details: { reason: why, relocateTo: plan.dir, path: bad.path, filesystem: bad.kind.type, mountPoint: bad.kind.mountPoint },
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
    const p = problem("PROJECT_NOT_WRITABLE", {
      message: `croft cannot write to ${dir} (${code}); runs, logs and the trash live there`,
      hint: `make ${dir} writable for your user (for example: chmod u+w ${shellQuote(dir)}), or check that the disk is not full or read-only`,
      fix: { kind: "manual", description: `make ${dir} writable for your user`, requiresHuman: true },
      details: { dir, error: code },
    });
    r.add("project", "writable", "error", `${shown}/ is not writable (${code})`, p, { dir });
  }
}

/**
 * The trash (§6 "Trash, restore and delete"): what it holds, once doctor has pruned the versions retention lets go
 * (older than 30 days, beyond each table's 5 newest). Deleting those files is doctor's one write besides the write
 * test, as the trash itself does at every trash. No line while the trash is empty. safety/trash.ts's listing and
 * pruning load no DuckDB binding; it is imported here all the same, so a broken install cannot stop doctor.
 */
async function checkTrash(r: Report, d: DoctorDeps, project: Project): Promise<void> {
  let trash: typeof import("../../safety/trash.ts");
  try {
    trash = await import("../../safety/trash.ts");
  } catch {
    return;
  }
  const stateDir = project.paths.stateDir;
  let pruned = 0;
  try {
    pruned = trash.pruneTrash(stateDir, { now: now(d.env) }).length;
  } catch {
    // A bad CROFT_NOW or an unwritable folder: listed as it is; the writable line says why.
  }
  const versions = trash.listTrash(stateDir);
  if (versions.length === 0 && pruned === 0) return;
  const tables = new Set(versions.map((v) => v.asset)).size;
  const bytes = versions.reduce((sum, v) => sum + v.bytes, 0);
  const plural = (n: number, word: string) => `${formatCount(n)} ${word}${n === 1 ? "" : "s"}`;
  const { days, versions: keep } = trash.TRASH_RETENTION;
  r.add("project", "trash", "ok",
    `trash: ${plural(versions.length, "version")} of ${plural(tables, "table")}, ${formatBytes(bytes)}${pruned ? `; removed ${formatCount(pruned)} older than ${days} days` : ""}`
      + ` (kept: ${days} days, and the ${keep} newest of each table; croft restore lists them)`,
    undefined, { versions: versions.length, tables, bytes, pruned });
}

/**
 * Tables changed outside croft (§5 "Out-of-band changes"), as the warehouse's read lease found them: one warning line
 * per change, OUT_OF_BAND_CHANGE (rows or stamps) or TABLE_MODIFIED_OUTSIDE_CROFT (columns), and one ok line when every
 * table is as croft left it. No line when the warehouse was not opened (not built yet, busy, no binding) or holds no
 * table croft wrote. doctor changes nothing: the next run of the asset takes the change in.
 */
function checkTables(r: Report, scan: TableScanResult): void {
  if (scan === null) return;
  if (scan instanceof Error) {
    r.add("project", "tables", "info", `tables: not compared with croft's record (${scan.message.split("\n")[0]!.slice(0, 200)})`);
    return;
  }
  if (scan.checked > 0 && scan.findings.length === 0) {
    r.add("project", "tables", "ok", `tables: ${formatCount(scan.checked)} as croft last wrote them (rows, newest _loaded_at and columns)`, undefined,
      { checked: scan.checked });
  }
  if (scan.skipped > 0) {
    r.add("project", "tables", "info", `tables: ${formatCount(scan.skipped)} more not compared with croft's record in the time doctor allows`
      + " (the next run of each asset compares its table)", undefined, { skipped: scan.skipped });
  }
  for (const f of scan.findings) {
    if (f.outOfBand) r.add("project", "tables", "warn", f.outOfBand.problem.message, f.outOfBand.problem, { asset: f.asset });
    if (f.schema) {
      // safety/guards.ts words it for the write that meets it; the fix is the same here: tell the user.
      const p: Problem = f.schema.fix ? f.schema : {
        ...f.schema,
        fix: { kind: "manual", description: `tell the user ${f.asset}'s columns were changed outside croft; croft keeps them as they are from its next run of ${f.asset}` },
      };
      r.add("project", "tables", "warn", p.message, p, { asset: f.asset });
    }
  }
}

const DRIFT_DAYS = 7;

/**
 * Drift of the last 7 days (§7 "Drift that does not fail a load is still reported", history/drift.ts): the
 * COLUMN_STOPPED_ARRIVING, JSON_KIND_CHANGED and TYPE_WIDENED warnings that runs recorded, per asset. An info line: the
 * runs already reported them. runs.sqlite is read only when it exists.
 */
function checkDrift(r: Report, d: DoctorDeps, project: Project): void {
  const stateDir = project.paths.stateDir;
  if (!existsSync(join(stateDir, RUNS_DB_FILE))) return;
  let at: Date;
  try { at = now(d.env); } catch { at = new Date(); }
  let entries: DriftEntry[];
  try {
    const db = RunsDb.open(stateDir);
    try {
      entries = recentDrift(db, new Date(at.getTime() - DRIFT_DAYS * 86_400_000));
    } finally {
      db.close();
    }
  } catch {
    return;                          // runs.sqlite cannot be read: the scheduling line says so
  }
  if (entries.length === 0) return;
  const byAsset = new Map<string, DriftEntry[]>();
  for (const e of entries) byAsset.set(e.asset, [...(byAsset.get(e.asset) ?? []), e]);
  const shown = [...byAsset].slice(0, 5).map(([asset, list]) => `${asset}: ${driftTexts(list)} (${agoText(list[0]!.at, at)})`);
  const more = byAsset.size > 5 ? ` · ${byAsset.size - 5} more assets` : "";
  r.add("project", "drift", "info", `drift (${DRIFT_DAYS} days): ${shown.join(" · ")}${more}; croft status shows it per asset`, undefined, {
    entries: entries.map((e) => ({ asset: e.asset, code: e.code, column: e.column, text: e.text, at: e.at, runId: e.runId })),
  });
}

/**
 * Pre-upgrade backups (§6 "Before an engine upgrade", db/backup.ts): how many, their size and the newest, in
 * .croft/backups/. When the DuckDB this croft loads is newer than the engine runs.sqlite recorded, the next command
 * that writes backs the warehouse up first, and the line says so (info). No line with neither. Reads only.
 */
function checkBackups(r: Report, d: DoctorDeps, project: Project, probe: DuckdbProbe): void {
  let at: Date;
  try { at = now(d.env); } catch { at = new Date(); }
  const stateDir = project.paths.stateDir;
  const list = listBackups(stateDir);
  let rec: EngineRecord | null = null;
  try {
    rec = recordedEngine(stateDir);
  } catch { /* runs.sqlite cannot be read: nothing pending that doctor can tell */ }
  const running = probe.ok ? probe.version : null;
  const pending = running !== null && rec !== null && existsSync(project.paths.database) && compareEngineVersions(running, rec.version) > 0;
  if (list.length === 0 && !pending) return;
  const bare = (v: string) => v.replace(/^v(?=\d)/, "");
  const dir = backupsDir(stateDir);
  const shownDir = `${inside(project.root, dir) ? relative(project.root, dir) : dir}/`;
  const parts: string[] = [];
  if (list.length) {
    const bytes = list.reduce((sum, b) => sum + b.bytes, 0);
    const newest = list[0]!;
    const count = list.length === 1 ? "1 before a DuckDB upgrade" : `${formatCount(list.length)} before DuckDB upgrades`;
    parts.push(`backups: ${count}, ${formatBytes(bytes)} in ${shownDir} (newest ${agoText(newest.at, at)}: ${newest.from} → ${newest.to}; the ${BACKUPS_KEPT} newest are kept)`);
  } else {
    parts.push("backups: none yet");
  }
  if (pending) parts.push(`the next croft command that writes backs the warehouse up first (DuckDB ${bare(rec!.version)} → ${bare(running!)})`);
  r.add("project", "backups", pending ? "info" : "ok", parts.join(" · "), undefined, {
    backups: list.map((b) => ({ path: b.path, at: b.at, from: b.from, to: b.to, bytes: b.bytes, wal: b.wal !== null })),
    recorded: rec?.version ?? null, running, pending,
  });
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

/**
 * Declared secrets against the environment and .env (§2 "Referenced secret missing"): one SECRET_MISSING
 * warning per declared name that is set in neither, naming the assets that use it, with the .env fix. The
 * names come from the asset configs as `croft secrets` reads them: each TS asset is imported in isolation,
 * which runs nothing past its top level (never rows() or run()); a file that does not import still has the
 * names its text lists. Finding the assets needs DuckDB (asset names are checked against its keywords), so
 * with a binding that does not load the check is skipped, and loaded only after the binding check passed.
 */
async function checkSecrets(r: Report, d: DoctorDeps, project: Project, bindingOk: boolean): Promise<void> {
  if (!bindingOk) {
    r.add("project", "secrets", "info", "declared secrets not checked (finding the assets needs the DuckDB binding)");
    return;
  }
  let declared: Record<string, string[]>;
  try {
    const { discoverAssets } = await import("../../project/discover.ts");
    const { loadConfigs, secretsByAsset } = await import("./describe.ts");
    const { assets } = await discoverAssets(project.root, { assetsDir: project.paths.assetsDir });
    declared = secretsByAsset(await loadConfigs(project, assets.filter((a) => a.kind === "ts"), { importTimeoutMs: 5000 }));
  } catch (e) {
    r.add("project", "secrets", "info", `declared secrets not checked: ${String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 200)}`);
    return;
  }
  let env: ProjectEnv;
  try {
    env = ProjectEnv.load(project.root, d.env);
  } catch {
    return;                          // .env cannot be read: checkEnvFiles already says so
  }
  const list = env.listSecrets(declared);
  if (list.length === 0) return;
  const missing = list.filter((s) => s.status === "missing");
  for (const s of missing) {
    const p = problem("SECRET_MISSING", {
      message: `secret ${s.name} is not set (used by ${s.usedBy.join(", ")})`,
      hint: `add ${s.name}=... to .env (or run \`croft secrets set ${s.name}\` in your terminal)`,
      fix: { kind: "manual", description: `ask the user to add ${s.name}=... to .env`, requiresHuman: true },
      details: { name: s.name, usedBy: s.usedBy },
    });
    // A warning here: nothing fails until an asset that needs the secret runs (where it is an error).
    p.severity = "warning";
    r.add("project", "secrets", "warn", `${s.name} (used by ${s.usedBy.join(", ")})`, p, { name: s.name, usedBy: s.usedBy });
  }
  if (missing.length === 0) r.add("project", "secrets", "ok", `secrets: ${list.map((s) => s.name).join(", ")} set`);
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
// Scheduling

/**
 * "on · ticks from croft serve (pid 4121) · last tick 12 s ago" (§2). A scheduler quiet for 3 minutes while on is
 * SCHEDULER_STALE, with the likely cause and the end of the tick log under the line.
 */
function checkScheduling(r: Report, d: DoctorDeps, project: Project): void {
  let at: Date;
  try { at = now(d.env); } catch { at = new Date(); }
  const tz = project.timezone;
  let rec: SchedulingRecord;
  try {
    rec = readScheduling(project.paths.stateDir, at);
  } catch (e) {
    r.add("scheduling", "scheduling", "info", `not read: ${String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 200)}`);
    return;
  }
  const details = { ...schedulingJson(rec, tz) } as Record<string, unknown>;
  if (rec.state === "off") {
    r.add("scheduling", "scheduling", "info", "off (croft schedule on runs the scheduled ingests on their schedules)", undefined, details);
    return;
  }
  const last = rec.heartbeatAt ? `last tick ${agoText(rec.heartbeatAt, at)}`
    : rec.since ? `no tick since it was turned on ${agoText(rec.since, at)}` : "no tick yet";
  if (rec.state === "paused") {
    // A project ticked by croft serve only resumes with --no-os-job, so following the line never installs the OS job.
    const resume = resumeCommand(rec.via);
    const until = rec.pausedUntil ? `until ${clockText(rec.pausedUntil, tz, at)} (${resume} resumes it now)` : `until ${resume}`;
    r.add("scheduling", "scheduling", "ok", `paused ${until}${rec.heartbeatAt ? ` · ${last}` : ""}`, undefined, details);
    return;
  }
  const s = servePid(project.paths.stateDir);
  const serve = s?.alive ? { pid: s.pid } : null;
  const head = `on · ticks from ${tickerText(rec, serve)} · ${last}`;
  if (!rec.stale) {
    r.add("scheduling", "scheduling", "ok", head, undefined, details);
    return;
  }
  const p = staleProblem(rec, {
    root: project.root, stateDir: project.paths.stateDir, tz, now: at, home: d.croftHome ?? croftHome(d.env), serve, platform: d.platform,
    ...(rec.via === "os-job" && d.osRunner ? { runner: d.osRunner } : {}),
  });
  r.add("scheduling", "scheduling", "warn", [`${head} (stale)`, ...logTailLines(p, "")].join("\n"), p, details);
}

// ---------------------------------------------------------------------------------------------
// Output

const LABEL: Record<CheckStatus, string> = { ok: "ok", warn: "warn", error: "error", info: "info" };
const TITLES: Record<Section, string> = { environment: "Environment", project: "Project", scheduling: "Scheduling" };

/** The §2 layout: each check under its section; a check that reported a problem shows the problem's code
 *  in front and its hint or fix below. A problem that matches no check is printed after the checks. */
export function formatDoctor(data: DoctorData, problems: readonly Problem[] = []): string {
  const lines: string[] = [];
  // Checks and their problems were recorded together, in the same order: match them up by code.
  const pending = [...problems];
  const take = (code: string | undefined) => {
    const i = code === undefined ? -1 : pending.findIndex((p) => p.code === code);
    return i < 0 ? undefined : pending.splice(i, 1)[0];
  };
  for (const section of ["environment", "project", "scheduling"] as Section[]) {
    const checks = data.checks.filter((c) => c.section === section);
    if (!checks.length) continue;
    lines.push(TITLES[section]);
    for (const c of checks) {
      const [first = "", ...rest] = c.text.split("\n");
      const code = c.code && !first.startsWith(c.code) ? `${c.code} ` : "";
      lines.push(`  ${LABEL[c.status].padEnd(5)} ${code}${first}`);
      for (const l of rest) lines.push(`        ${l}`);
      const p = take(c.code);
      if (p) for (const l of fixLines(p)) lines.push(`        ${l}`);
    }
  }
  lines.push(...pending.map((p) => formatProblem(p)));
  const { errors, warnings } = data.summary;
  const parts = [];
  if (errors) parts.push(`${errors} ${errors === 1 ? "error" : "errors"}`);
  if (warnings) parts.push(`${warnings} ${warnings === 1 ? "warning" : "warnings"}`);
  lines.push(parts.length ? parts.join(", ") : "no problems found");
  return lines.join("\n");
}

/** A problem's hint, fix and effect lines as formatProblem prints them, without its head line: the
 *  check's text already says what is wrong. */
function fixLines(p: Problem): string[] {
  const { file: _file, asset: _asset, ...rest } = p;
  return formatProblem({ ...rest, message: "" }).split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
}

/** Storage whose file locks cannot be trusted at all, as opposed to a sync folder (see syncedLocation). */
function unsafeMount(why: string): boolean {
  return why.startsWith("a network filesystem") || why.includes("WSL");
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

