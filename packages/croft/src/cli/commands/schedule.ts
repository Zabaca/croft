// croft schedule on|off|status|pause [--for 2h] [--no-os-job] (DESIGN.md §4.1, §4.2, §5 "Server mode", §6 "The
// scheduler only runs code a human has run", §8 "Turning it on").
//
// - on: record scheduling as on in runs.sqlite, add the project to ~/.croft/projects.json, make sure the one
//   per-user OS job exists (schedule/register.ts), then wait up to 70 s for the first heartbeat, the proof that
//   the job really ticks this project. In that order, so the job's first run (RunAtLoad) already finds the
//   project. When none comes, SCHEDULER_STALE names the likely cause with the tail of tick.log. If the job
//   cannot be installed, the setting and the registry are put back as they were. With --no-os-job (servers,
//   containers, WSL) nothing is installed and nothing is waited for: croft serve ticks while it runs.
// - off: record it off, take the project out of the registry, and remove the OS job once no project needs it.
// - pause [--for 2h]: ticks exit at once until the pause ends, or until `croft schedule on`.
// - status (also a bare `croft schedule`): the setting, the last heartbeat, the job as installed, and each asset
//   as the scheduler sees it (schedule/due.ts scheduleView: next fire, last fire, due, held).
//
// This module also holds what status, doctor, context and describe show about scheduling: the setting as the ticks
// read it, the last heartbeat and whether it is stale (SCHEDULER_STALE, with the diagnosis), holds that need a
// human (SCHEDULE_HELD), and fire times in words. doctor imports it, so it must never import DuckDB or asset code:
// the scheduler's view of the assets is imported only when it is asked for.
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { CroftError, problem } from "../../core/errors.ts";
import { formatInstant, zonedParts } from "../../core/time.ts";
import type { Fix, Problem } from "../../core/types.ts";
import { RUNS_DB_FILE, RunsDb } from "../../history/runs-db.ts";
import type { Project } from "../../project/root.ts";
import { didYouMean } from "../../project/suggest.ts";
import { liveServer } from "../../read/locate.ts";
import type { AssetScheduleView, HoldCode, ScheduleViewInput } from "../../schedule/due.ts";
import { diagnose, type DiagnosisCause, HEARTBEAT_WAIT_MS, STALE_AFTER_MS, tickLogTail, waitForHeartbeat } from "../../schedule/heartbeat.ts";
import { croftHome, type CroftHome, type Env } from "../../schedule/home.ts";
import { type OsRunner, realRunner, type RegistryEntry, type SchedulingSetting } from "../../schedule/os.ts";
import { ensureJob, inspectJob, type JobOptions, type JobResult, plistPath, removeJob } from "../../schedule/register.ts";
import { addProject, canonicalRoot, listProjects, pruneRegistry, removeProject } from "../../schedule/registry.ts";
import { nextFires } from "../../schedule/types.ts";
import type { CommandImpl, CommandResult, Ctx, Next } from "../command.ts";
import { table } from "../render.ts";

// ---------------------------------------------------------------------------------------------------------
// The setting and the heartbeat, as every surface shows them

/** runs.sqlite setting: when scheduling was last turned on or resumed (ISO-8601 UTC). Without a heartbeat since,
 *  the scheduler counts as stale 3 minutes after it. */
export const SINCE_KEY = "scheduling.since";
/** Test knob: how long `schedule on` waits for the first heartbeat, in milliseconds (default 70 s). */
export const HEARTBEAT_WAIT_ENV = "CROFT_HEARTBEAT_WAIT_MS";
/** A heartbeat this recent means the job already ticks: `schedule on` does not wait for another. */
const TICKING_WITHIN_MS = 2 * 60_000;

/** Scheduling for one project, read as the ticks read it. Instants are ISO-8601 UTC. */
export interface SchedulingRecord {
  state: SchedulingSetting["state"];
  via: SchedulingSetting["via"];
  /** While paused: when it resumes on its own, or null (until `croft schedule on`). */
  pausedUntil: string | null;
  /** When it was last turned on or resumed; null when unknown. */
  since: string | null;
  heartbeatAt: string | null;
  /** The later of the last heartbeat, turning on and the end of a pause: a tick is due within a minute of it. */
  quietSince: string | null;
  /** On, and quiet for more than 3 minutes (SCHEDULER_STALE). */
  stale: boolean;
}

export const SCHEDULING_OFF: SchedulingRecord = {
  state: "off", via: null, pausedUntil: null, since: null, heartbeatAt: null, quietSince: null, stale: false,
};

const latest = (...xs: (string | null)[]) => xs.filter((x): x is string => !!x && Number.isFinite(Date.parse(x)))
  .sort((a, b) => Date.parse(a) - Date.parse(b)).pop() ?? null;

/** The setting from an open runs.sqlite. A pause whose end has passed reads as on (RunsDb.getScheduling), judged
 *  by `now`, so CROFT_NOW decides it. */
export function schedulingOf(db: RunsDb, now: Date): SchedulingRecord {
  const raw = db.getSetting<Partial<SchedulingSetting>>("scheduling");
  const via = raw?.via === "os-job" || raw?.via === "serve" ? raw.via : null;
  let state: SchedulingSetting["state"] = raw?.state === "on" || raw?.state === "paused" ? raw.state : "off";
  let pausedUntil = state === "paused" && typeof raw?.pausedUntil === "string" ? raw.pausedUntil : null;
  let resumedAt: string | null = null;
  if (state === "paused" && pausedUntil !== null && Date.parse(pausedUntil) <= now.getTime()) {
    state = "on";
    resumedAt = pausedUntil;
    pausedUntil = null;
  }
  const since = db.getSetting<unknown>(SINCE_KEY);
  const heartbeatAt = db.getTick()?.heartbeatAt ?? null;
  const quietSince = latest(heartbeatAt, typeof since === "string" ? since : null, resumedAt);
  const stale = state === "on" && (quietSince === null || now.getTime() - Date.parse(quietSince) > STALE_AFTER_MS);
  return { state, via: state === "off" ? null : via, pausedUntil, since: typeof since === "string" ? since : null, heartbeatAt, quietSince, stale };
}

/** The setting of a project; off when it has no runs.sqlite (which is not created). */
export function readScheduling(stateDir: string, now: Date): SchedulingRecord {
  if (!existsSync(join(stateDir, RUNS_DB_FILE))) return SCHEDULING_OFF;
  const db = RunsDb.open(stateDir, { now: () => now });
  try {
    return schedulingOf(db, now);
  } finally {
    db.close();
  }
}

/** status, context and schedule's `scheduling` (§4.3), instants in the project zone. `stale` is there only while
 *  scheduling is on, and `pausedUntil` only while it is paused. */
export interface Scheduling {
  state: "on" | "off" | "paused";
  via: "os-job" | "serve" | null;
  lastTickAt: string | null;
  stale?: boolean;
  pausedUntil?: string | null;
}

export function schedulingJson(r: SchedulingRecord, tz: string): Scheduling {
  const out: Scheduling = { state: r.state, via: r.via, lastTickAt: zonedOrNull(r.heartbeatAt, tz) };
  if (r.state === "on") out.stale = r.stale;
  if (r.state === "paused") out.pausedUntil = zonedOrNull(r.pausedUntil, tz);
  return out;
}

function zonedOrNull(iso: string | null, tz: string): string | null {
  if (!iso) return null;
  try {
    return formatInstant(iso, tz);
  } catch {
    return iso;
  }
}

/** Who ticks the project, in words: "the per-user OS job", "croft serve (pid 4121)". */
export function tickerText(r: Pick<SchedulingRecord, "via">, serve: { pid: number } | null): string {
  if (r.via === "serve") return serve ? `croft serve (pid ${serve.pid})` : "croft serve (not running)";
  const job = "the per-user OS job";
  return serve ? `${job} and croft serve (pid ${serve.pid})` : job;
}

// ---------------------------------------------------------------------------------------------------------
// SCHEDULER_STALE: why the scheduler does not tick (§8)

export type StaleCause = DiagnosisCause | "not_registered" | "job_missing" | "job_not_loaded" | "serve_not_running" | "serve_not_ticking";

export interface StaleOptions {
  root: string;
  stateDir: string;
  tz: string;
  now: Date;
  home: CroftHome;
  /** Checks the installed job too (launchctl print, crontab -l); without one only files are read. */
  runner?: OsRunner;
  platform?: NodeJS.Platform;
  uid?: number;
  /** The live croft serve, when known (liveServer(stateDir) otherwise). */
  serve?: { pid: number } | null;
  /** `schedule on`: how long it waited for the first tick. */
  waitedMs?: number;
}

interface Cause { cause: StaleCause; message: string; hint: string; fix?: Fix; logFile: string; logTail: string }

/** croft serve's own tick log (serve/loop.ts tickLogPath: the ticks it starts write there). */
function serveTickLog(stateDir: string): string {
  return join(stateDir, "logs", "tick.log");
}

function staleCause(r: SchedulingRecord, o: StaleOptions): Cause {
  const serve = o.serve !== undefined ? o.serve : liveServer(o.stateDir);
  if (r.via === "serve") {
    const log = serveTickLog(o.stateDir);
    const tail = tickLogTail({ ...o.home, tickLog: log });
    if (!serve) {
      return {
        cause: "serve_not_running", logFile: log, logTail: tail,
        message: "scheduling is on for croft serve only (croft schedule on --no-os-job), and croft serve is not running",
        hint: "start croft serve in a terminal and keep it running: it ticks every minute; where the per-user OS job works (macOS, or Linux with cron), croft schedule on installs it instead",
        fix: { kind: "manual", description: "ask the user to start croft serve in their terminal and keep it running", requiresHuman: true },
      };
    }
    return {
      cause: "serve_not_ticking", logFile: log, logTail: tail,
      message: `croft serve (pid ${serve.pid}) is running, but no croft tick it starts checks in; the end of ${log} may say why`,
      hint: `read ${log}; stopping croft serve and starting it again restarts its ticks`,
      fix: { kind: "manual", description: `read ${log}, then restart croft serve`, requiresHuman: true },
    };
  }
  const base = { logFile: o.home.tickLog, logTail: tickLogTail(o.home) };
  const again: Fix = { kind: "command", description: "register the project and reinstall the scheduler job", command: "croft schedule on" };
  let registered: boolean;
  try {
    const root = canonicalRoot(o.root);
    registered = listProjects(o.home).some((e) => e.root === root && e.via === "os-job");
  } catch {
    registered = false;
  }
  if (!registered) {
    return {
      ...base, cause: "not_registered",
      message: `this project is not in ${o.home.registry}, so the per-user OS job does not tick it`,
      hint: "croft schedule on registers it again", fix: again,
    };
  }
  const platform = o.platform ?? process.platform;
  let installed: boolean | null = null;
  let loaded: boolean | null = null;
  try {
    if (o.runner) {
      const job = inspectJob(o.runner, o.home, { platform, ...(o.uid !== undefined ? { uid: o.uid } : {}) });
      installed = job.installed;
      loaded = job.loaded;
    } else if (platform === "darwin") {
      installed = existsSync(plistPath(o.home));
    }
  } catch { /* cannot be inspected here (no launchctl or crontab): the log decides */ }
  if (installed === false) {
    const what = platform === "darwin" ? `${plistPath(o.home)} is gone` : "croft's line is gone from the crontab";
    return { ...base, cause: "job_missing", message: `the per-user OS job is not installed (${what})`, hint: "croft schedule on installs it again", fix: again };
  }
  if (loaded === false) {
    return {
      ...base, cause: "job_not_loaded",
      message: "the per-user OS job is installed, but launchd has not loaded it (it was booted out, or the Mac's desktop session has not started)",
      hint: "croft schedule on loads it again (it needs a logged-in desktop session, not only SSH)", fix: again,
    };
  }
  const d = diagnose(o.home, { platform, ...(o.runner ? { runner: o.runner } : {}) });
  return { cause: d.cause, message: d.message, hint: d.hint, ...(d.fix ? { fix: d.fix } : {}), logFile: d.logFile, logTail: d.logTail };
}

/** "3 min", "2 h", "3 days": how long, in rough words. */
export function spanText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h`;
  const days = Math.round(s / 86_400);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** "12 s ago", "14 min ago"; "—" without an instant. */
export function agoText(iso: string | null, now: Date): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return t > now.getTime() ? "just now" : `${spanText(now.getTime() - t)} ago`;
}

/** SCHEDULER_STALE (a warning): how long the scheduler has been quiet, and the likely cause, with the tail of the
 *  tick log in details (the human outputs print it under the problem). */
export function staleProblem(r: SchedulingRecord, o: StaleOptions): Problem {
  const c = staleCause(r, o);
  const quietMs = r.quietSince ? o.now.getTime() - Date.parse(r.quietSince) : null;
  const head = o.waitedMs !== undefined
    ? `no scheduler tick arrived within ${spanText(o.waitedMs)} of turning scheduling on`
    : r.heartbeatAt && quietMs !== null
      ? `the scheduler has not ticked for ${spanText(quietMs)} (last tick ${zonedOrNull(r.heartbeatAt, o.tz)})`
      : quietMs !== null
        ? `the scheduler has not ticked since scheduling was turned on ${spanText(quietMs)} ago`
        : "the scheduler has never ticked for this project";
  return problem("SCHEDULER_STALE", {
    message: `${head}: ${c.message}`,
    hint: c.hint,
    ...(c.fix ? { fix: c.fix } : {}),
    effect: "scheduled ingests do not run until it ticks again",
    details: {
      cause: c.cause, via: r.via, lastTickAt: zonedOrNull(r.heartbeatAt, o.tz), quietForMs: quietMs,
      ...(o.waitedMs !== undefined ? { waitedMs: o.waitedMs } : {}), logFile: c.logFile, logTail: c.logTail,
    },
  });
}

/** The last lines of a SCHEDULER_STALE's tick log, under a line naming the file, for human output; none when the
 *  log is empty or missing. */
export function logTailLines(p: Problem, indent = "  ", max = 10): string[] {
  const d = p.details as { logFile?: unknown; logTail?: unknown } | undefined;
  if (typeof d?.logTail !== "string" || d.logTail === "") return [];
  const lines = d.logTail.split("\n").slice(-max);
  return [`${indent}${typeof d.logFile === "string" ? d.logFile : "tick.log"}, last lines:`, ...lines.map((l) => `${indent}  ${l}`)];
}

// ---------------------------------------------------------------------------------------------------------
// Holds and the scheduler's view of the assets

export type ScheduleViewFn = (i: ScheduleViewInput) => Promise<AssetScheduleView[]>;

/** schedule/due.ts scheduleView, imported only when asked for (it reads runs.sqlite; it imports no asset code). */
export const defaultScheduleView: ScheduleViewFn = async (i) => (await import("../../schedule/due.ts")).scheduleView(i);

/** Holds a human must lift (§6, §5 cost guard). The others pass by themselves: paused, leased (running), backoff
 *  (after a failure, until the next fire). */
export const HUMAN_HOLDS: ReadonlySet<HoldCode> = new Set<HoldCode>(["SCHEDULE_HELD", "LARGE_REPROCESS"]);

/** SCHEDULE_HELD as a warning: the asset waits for a run by hand. */
export function heldProblem(asset: string, reason: string): Problem {
  const p = problem("SCHEDULE_HELD", {
    asset,
    message: `${asset} is held from the scheduler: ${reason}`,
    hint: `the scheduler only runs code a human has run; croft run ${asset} runs it now and releases it (croft preview ${asset} first shows what it would do)`,
    fix: { kind: "command", description: "run it by hand once, which releases it for the scheduler", command: `croft run ${asset}` },
    effect: "the scheduler skips it until then",
  });
  p.severity = "warning";
  return p;
}

/** The next `n` fires of a cron after `now`; none for a cron that does not parse (validate reports it). */
export function nextFireOf(cron: string, tz: string, now: Date, n = 1): Date[] {
  try {
    return nextFires(cron, tz, now, n);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------------------
// Times in words (the project zone)

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "11:00" on the same local day as `now`, else "Oct 1 00:00". */
export function clockText(iso: string, tz: string, now: Date): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const p = zonedParts(new Date(t), tz);
  const n = zonedParts(now, tz);
  const time = `${pad(p.hour)}:${pad(p.minute)}`;
  if (p.year === n.year && p.month === n.month && p.day === n.day) return time;
  return `${MONTHS[p.month - 1]} ${p.day}${p.year !== n.year ? ` ${p.year}` : ""} ${time}`;
}

/** A fire time to come: "in 55 min" within 90 minutes, otherwise clockText. */
export function fireText(iso: string, tz: string, now: Date): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const ms = t - now.getTime();
  if (ms >= 0 && ms < 90 * 60_000) return `in ${Math.max(1, Math.round(ms / 60_000))} min`;
  return clockText(iso, tz, now);
}

/** "~/my-data" for a folder under the home folder. */
export function homeShort(path: string, home: string): string {
  const h = resolve(home);
  return path === h ? "~" : path.startsWith(h + sep) ? `~/${relative(h, path)}` : path;
}

// ---------------------------------------------------------------------------------------------------------
// The command

export type ScheduleAction = "on" | "off" | "pause" | "status";

/** One asset as the scheduler sees it (schedule/due.ts), instants in the project zone. */
export interface ScheduleAsset {
  asset: string;
  kind: AssetScheduleView["kind"];
  /** The schedule as written ("every hour"), for ingests with one. */
  schedule: string | null;
  cron: string | null;
  nextFireAt: string | null;
  lastFireAt: string | null;
  lastAttemptAt: string | null;
  due: boolean;
  dueReason: string | null;
  held: { code: HoldCode; reason: string } | null;
}

/** The per-user OS job. */
export interface JobInfo {
  kind: "launchd" | "crontab";
  label: string;
  /** The LaunchAgent plist; null for crontab. */
  file: string | null;
  installed: boolean;
  /** launchd has it loaded; null for crontab. */
  loaded: boolean | null;
  /** The Bun it runs. */
  bun: string | null;
  bunExists: boolean;
  /** on: false when the only Bun found is a version manager's, which may vanish on upgrade. */
  bunStable?: boolean;
  /** on: written or (re)loaded now. */
  changed?: boolean;
  /** off: removed now. */
  removed?: boolean;
}

export interface ScheduleData {
  action: ScheduleAction;
  root: string;
  scheduling: Scheduling;
  /** The per-user OS job: installed (on), removed (off), or as inspected (status); null when not touched. */
  job: JobInfo | null;
  /** ~/.croft/projects.json: the projects with scheduling on, and how many the OS job ticks. */
  registry: { file: string; projects: number; osJob: number } | null;
  /** The live croft serve, which also ticks while scheduling is on. */
  serve: { url: string; pid: number } | null;
  /** on: the first heartbeat. null with --no-os-job (nothing waited for). */
  firstTick?: { ok: boolean; at: string | null; waitedMs: number; alreadyTicking?: true } | null;
  /** on: scheduled ingests and held assets; status: every asset; off and pause: none. */
  assets: ScheduleAsset[];
  /** on: the scheduler's view could not be read, so `assets` is empty (a warning says why). */
  assetsUnavailable?: true;
}

/** What tests replace. Everything defaults to the real thing. */
export interface ScheduleDeps {
  runner?: OsRunner;
  home?: CroftHome;
  /** platform, uid, exists, execPath, sleep for ensureJob and removeJob (tests fake the machine). */
  job?: JobOptions;
  scheduleView?: ScheduleViewFn;
  /** Default: CROFT_HEARTBEAT_WAIT_MS, else 70 s. */
  heartbeatWaitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const schedule: CommandImpl<ScheduleData> = {
  run: (ctx) => runSchedule(ctx),
  human(result, ctx) {
    return formatSchedule(result.data, result.problems, ctx.project.timezone, ctx.now(), userHomeOf(ctx.processEnv));
  },
};

const ACTIONS: readonly ScheduleAction[] = ["on", "off", "pause", "status"];
const SYNONYMS: Record<string, ScheduleAction> = {
  enable: "on", start: "on", resume: "on", disable: "off", stop: "off", show: "status", list: "status",
};

function actionOf(ctx: Ctx): ScheduleAction {
  const word = ctx.positionals[0];
  if (word === undefined) return "status";
  if ((ACTIONS as readonly string[]).includes(word)) return word as ScheduleAction;
  const guess = SYNONYMS[word.toLowerCase()] ?? didYouMean(word, ACTIONS);
  throw new CroftError("USAGE_ERROR", {
    message: `croft schedule has no action "${word}"`,
    hint: `${guess ? `did you mean croft schedule ${guess}? ` : ""}usage: croft schedule on|off|status|pause [--for 2h] [--no-os-job]`,
    fix: { kind: "command", description: guess ? `use croft schedule ${guess}` : "show scheduling for this project", command: `croft schedule ${guess ?? "status"}` },
    details: { action: word, ...(guess ? { suggestion: guess } : {}) },
  });
}

function refuseFlag(flag: string, action: ScheduleAction, only: string): never {
  throw new CroftError("USAGE_ERROR", {
    message: `${flag} does not apply to croft schedule ${action}`,
    hint: `${flag} goes with ${only}`,
    fix: { kind: "command", description: `run croft schedule ${action} without ${flag}`, command: `croft schedule ${action}` },
    details: { flag, action },
  });
}

/** --for: "2h", "30m", "1d", "90 minutes", "1h30m". */
export function parseFor(text: string): number {
  const units: Record<string, number> = {
    s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
    m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
    h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
    d: 86_400_000, day: 86_400_000, days: 86_400_000, w: 604_800_000, week: 604_800_000, weeks: 604_800_000,
  };
  const t = text.trim().toLowerCase();
  let ms = 0;
  let rest = t;
  const part = /^(\d+(?:\.\d+)?)\s*([a-z]+)\s*/;
  for (let m = part.exec(rest); m && units[m[2]!] !== undefined; m = part.exec(rest)) {
    ms += Number(m[1]) * units[m[2]!]!;
    rest = rest.slice(m[0].length);
  }
  if (t === "" || rest !== "" || ms < 60_000 || ms > 365 * 86_400_000) {
    throw new CroftError("USAGE_ERROR", {
      message: `--for ${JSON.stringify(text)} is not a pause length`,
      hint: "write it like 30m, 2h or 1d (at least a minute, at most a year); without --for the pause lasts until croft schedule on",
      fix: { kind: "command", description: "pause for two hours", command: "croft schedule pause --for 2h" },
      details: { value: text },
    });
  }
  return Math.round(ms);
}

function userHomeOf(env: Env): string {
  return croftHome(env).userHome;
}

/** The environment the OS job code sees: the command's, with the test tripwire of this process kept. */
function jobEnv(env: Env): Env {
  return process.env.CROFT_FORBID_OS_JOBS === "1" ? { ...env, CROFT_FORBID_OS_JOBS: "1" } : env;
}

/**
 * Tests must never touch the real ~/.croft: with CROFT_FORBID_OS_JOBS=1 (tests/preload.ts), a croft folder or home
 * that is the real user's is refused before the registry or the job is written.
 */
export function guardRealHome(home: CroftHome, env: Env): void {
  if (env.CROFT_FORBID_OS_JOBS !== "1" && process.env.CROFT_FORBID_OS_JOBS !== "1") return;
  let real: string;
  try {
    real = resolve(userInfo().homedir);
  } catch {
    return;
  }
  if (resolve(home.userHome) === real || resolve(home.dir) === join(real, ".croft")) {
    throw new CroftError("INTERNAL_ERROR", {
      message: `refusing to change the scheduler of the real user (${real}): CROFT_FORBID_OS_JOBS=1 (tests must set HOME and CROFT_HOME to a temp folder)`,
      hint: "report this croft bug",
    });
  }
}

interface Invocation {
  ctx: Ctx;
  deps: ScheduleDeps;
  project: Project;
  now: Date;
  home: CroftHome;
  env: Env;
  runner: () => OsRunner;
  jobOptions: JobOptions;
}

export async function runSchedule(ctx: Ctx, deps: ScheduleDeps = {}): Promise<CommandResult<ScheduleData>> {
  const action = actionOf(ctx);
  if (ctx.values["no-os-job"] === true && action !== "on") refuseFlag("--no-os-job", action, "croft schedule on");
  if (ctx.values.for !== undefined && action !== "pause") refuseFlag("--for", action, "croft schedule pause");
  const project = ctx.project;
  const env = jobEnv(ctx.processEnv);
  let runner: OsRunner | undefined = deps.runner;
  const e: Invocation = {
    ctx, deps, project, now: ctx.now(), env,
    home: deps.home ?? croftHome(ctx.processEnv),
    runner: () => (runner ??= realRunner(env)),
    jobOptions: { env, ...deps.job },
  };
  switch (action) {
    case "on":
      return turnOn(e, ctx.values["no-os-job"] === true);
    case "off":
      return turnOff(e);
    case "pause":
      return pause(e, typeof ctx.values.for === "string" ? parseFor(ctx.values.for) : null);
    default:
      return status(e);
  }
}

function serveOf(stateDir: string): ScheduleData["serve"] {
  const s = liveServer(stateDir);
  return s ? { url: s.url, pid: s.pid } : null;
}

function registrySummary(home: CroftHome): ScheduleData["registry"] {
  try {
    const entries = listProjects(home);
    return { file: home.registry, projects: entries.length, osJob: entries.filter((x) => x.via === "os-job").length };
  } catch {
    return null;
  }
}

function assetOf(v: AssetScheduleView, tz: string): ScheduleAsset {
  return {
    asset: v.asset, kind: v.kind, schedule: v.schedule?.text ?? null, cron: v.schedule?.cron ?? null,
    nextFireAt: zonedOrNull(v.nextFireAt, tz), lastFireAt: zonedOrNull(v.lastFireAt, tz), lastAttemptAt: zonedOrNull(v.lastAttemptAt, tz),
    due: v.due, dueReason: v.dueReason, held: v.held,
  };
}

/** SCHEDULE_HELD warnings and `croft run` next steps for the assets a human must run. */
function holdsOf(assets: readonly ScheduleAsset[]): { problems: Problem[]; next: Next[] } {
  const held = assets.filter((a) => a.held && a.held.code === "SCHEDULE_HELD");
  return {
    problems: held.map((a) => heldProblem(a.asset, a.held!.reason)),
    next: held.slice(0, 3).map((a) => ({ command: `croft run ${a.asset}`, reason: `releases it for the scheduler (${a.held!.reason})` })),
  };
}

/** The scheduler's view, or none with a warning: the view is extra information after on, never a failure. */
async function viewOrWarning(e: Invocation): Promise<{ assets: ScheduleAsset[]; problems: Problem[] }> {
  try {
    const views = await (e.deps.scheduleView ?? defaultScheduleView)({ root: e.project.root, now: e.now });
    return { assets: views.map((v) => assetOf(v, e.project.timezone)), problems: [] };
  } catch (err) {
    const p = err instanceof CroftError ? { ...err.problem } : problem("INTERNAL_ERROR", {
      message: `the scheduled assets could not be listed: ${String((err as Error)?.message ?? err).split("\n")[0]!.slice(0, 300)}`,
      hint: "croft schedule status lists them; if it fails too, report this croft bug",
      fix: { kind: "command", description: "list what the scheduler runs", command: "croft schedule status" },
    });
    p.severity = "warning";
    return { assets: [], problems: [p] };
  }
}

function jobInfo(r: JobResult): JobInfo {
  return {
    kind: r.kind, label: r.label, file: r.file, installed: true, loaded: r.kind === "launchd" ? true : null,
    bun: r.bun.path, bunExists: true, bunStable: r.bun.stable, changed: r.changed || r.tickScriptChanged,
  };
}

function inspected(e: Invocation): JobInfo | null {
  try {
    const j = inspectJob(e.runner(), e.home, e.jobOptions);
    const kind = j.kind;
    return {
      kind, label: e.home.jobLabel, file: kind === "launchd" ? plistPath(e.home) : null,
      installed: j.installed, loaded: j.loaded, bun: j.bun, bunExists: j.bunExists,
    };
  } catch {
    return null;   // no launchctl or crontab here (or a test without a fake runner)
  }
}

async function turnOn(e: Invocation, noOsJob: boolean): Promise<CommandResult<ScheduleData>> {
  const { project, now, home } = e;
  const root = project.root;
  const stateDir = project.paths.stateDir;
  const tz = project.timezone;
  const via: "os-job" | "serve" = noOsJob ? "serve" : "os-job";
  guardRealHome(home, e.env);
  const previousEntry = listProjects(home).find((x) => x.root === canonicalRoot(root)) ?? null;

  // The setting first, then the registry, then the job: the job's first run (RunAtLoad) must find the project.
  const db = RunsDb.open(stateDir, { now: () => now });
  let before: SchedulingRecord;
  const saved = { scheduling: null as unknown, since: null as unknown };
  try {
    saved.scheduling = db.getSetting("scheduling");
    saved.since = db.getSetting(SINCE_KEY);
    before = schedulingOf(db, now);
    db.setScheduling({ state: "on", via });
    if (before.state !== "on" || before.via !== via) db.setSetting(SINCE_KEY, now.toISOString());
  } finally {
    db.close();
  }

  let job: JobInfo | null = null;
  let entries: RegistryEntry[];
  try {
    entries = addProject(home, { root, via }, { now }).entries;
    if (!noOsJob) job = jobInfo(ensureJob(e.runner(), home, e.jobOptions));
  } catch (err) {
    // Put the setting and the registry back as they were: scheduling is not on when its job could not be installed.
    const back = RunsDb.open(stateDir, { now: () => now });
    try {
      back.setSetting("scheduling", saved.scheduling ?? { state: "off", via: null });
      back.setSetting(SINCE_KEY, saved.since);
    } finally {
      back.close();
    }
    try {
      if (previousEntry) addProject(home, { root, via: previousEntry.via }, { now });
      else removeProject(home, root);
    } catch { /* the registry could not be restored: the per-user tick checks the setting anyway */ }
    throw err;
  }

  const problems: Problem[] = [];
  // Serve only, and the OS job ticked nothing else: take it away (as off does).
  if (noOsJob && before.via === "os-job" && !entries.some((x) => x.via === "os-job")) {
    job = removeQuietly(e, problems, true, "this project is ticked by croft serve only: the job's ticks skip it");
  }

  let firstTick: ScheduleData["firstTick"] = null;
  if (!noOsJob) {
    const ticking = before.state === "on" && before.via === "os-job" && !job?.changed && before.heartbeatAt !== null
      && now.getTime() - Date.parse(before.heartbeatAt) <= TICKING_WITHIN_MS;
    if (ticking) {
      firstTick = { ok: true, at: zonedOrNull(before.heartbeatAt, tz), waitedMs: 0, alreadyTicking: true };
    } else {
      const wait = await waitFirstTick(e);
      firstTick = wait.ok ? { ok: true, at: zonedOrNull(wait.at, tz), waitedMs: wait.waitedMs } : { ok: false, at: null, waitedMs: wait.waitedMs };
      if (!wait.ok) {
        const rec = readScheduling(stateDir, now);
        problems.push(staleProblem(rec, {
          root, stateDir, tz, now, home, runner: e.runner(), waitedMs: wait.waitedMs,
          ...(e.jobOptions.platform ? { platform: e.jobOptions.platform } : {}), ...(e.jobOptions.uid !== undefined ? { uid: e.jobOptions.uid } : {}),
        }));
      }
    }
  }

  const view = await viewOrWarning(e);
  const assets = view.assets.filter((a) => a.schedule !== null || (a.held !== null && HUMAN_HOLDS.has(a.held.code)));
  const holds = holdsOf(assets);
  const next: Next[] = [...holds.next];
  if (view.problems.length === 0 && !assets.some((a) => a.schedule !== null)) {
    next.push({ command: "croft docs ingest", reason: "no ingest has a schedule yet: add schedule: \"every hour\" (or daily at 06:00, …) to one" });
  }
  const data: ScheduleData = {
    action: "on", root, scheduling: schedulingJson(readScheduling(stateDir, now), tz), job, registry: registrySummary(home),
    serve: serveOf(stateDir), firstTick, assets, ...(view.problems.length ? { assetsUnavailable: true as const } : {}),
  };
  return { data, problems: [...problems, ...view.problems, ...holds.problems], next, ok: true, exit: 0 };
}

/** Wait for the first heartbeat, with progress on a TTY. */
async function waitFirstTick(e: Invocation): Promise<{ ok: true; at: string; waitedMs: number } | { ok: false; waitedMs: number }> {
  const envWait = e.ctx.processEnv[HEARTBEAT_WAIT_ENV]?.trim() ?? "";
  const timeoutMs = e.deps.heartbeatWaitMs ?? (/^\d+$/.test(envWait) ? Number(envWait) : HEARTBEAT_WAIT_MS);
  const tty = e.ctx.isTTY.stdout;
  const sleepFn = e.deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const t0 = Date.now();
  let shown = 0;
  if (tty) e.ctx.render.progress(`Waiting for the first tick (the job runs every minute; up to ${spanText(timeoutMs)})…`);
  const sleep = async (ms: number) => {
    const tens = Math.floor((Date.now() - t0) / 10_000);
    if (tty && tens > shown) {
      shown = tens;
      e.ctx.render.progress(`  still waiting for the first tick (${tens * 10} s)…`);
    }
    await sleepFn(ms);
  };
  const r = await waitForHeartbeat(e.project.root, {
    stateDir: e.project.paths.stateDir, timeoutMs, pollMs: e.deps.pollMs ?? Math.min(1000, Math.max(10, Math.floor(timeoutMs / 20))),
    since: e.now, home: e.home, sleep,
    diagnose: { ...(e.jobOptions.platform ? { platform: e.jobOptions.platform } : {}), runner: e.runner() },
  });
  return r.ok ? { ok: true, at: r.heartbeatAt.toISOString(), waitedMs: r.waitedMs } : { ok: false, waitedMs: r.waitedMs };
}

/**
 * Remove the OS job. A failure is a warning, saying `effect`, when the project used the job (`expected`: a job may
 * be left behind), and silent otherwise (there was likely none: no launchctl or cron here, say).
 */
function removeQuietly(e: Invocation, problems: Problem[], expected: boolean, effect: string): JobInfo | null {
  try {
    const r = removeJob(e.runner(), e.home, e.jobOptions);
    return {
      kind: r.kind, label: e.home.jobLabel, file: r.kind === "launchd" ? plistPath(e.home) : null,
      installed: false, loaded: r.kind === "launchd" ? false : null, bun: null, bunExists: false, removed: r.removed,
    };
  } catch (err) {
    if (expected) {
      const p = err instanceof CroftError ? { ...err.problem } : problem("INSTALL_FAILED", {
        message: `croft could not remove its scheduler job: ${String((err as Error)?.message ?? err).split("\n")[0]}`,
        hint: "remove croft's scheduler job by hand if it is still installed; it no longer ticks this project either way",
        fix: { kind: "manual", description: "remove croft's scheduler job by hand", requiresHuman: true },
      });
      p.severity = "warning";
      p.effect = effect;
      problems.push(p);
    }
    return null;
  }
}

async function turnOff(e: Invocation): Promise<CommandResult<ScheduleData>> {
  const { project, now, home } = e;
  const stateDir = project.paths.stateDir;
  guardRealHome(home, e.env);
  const db = RunsDb.open(stateDir, { now: () => now });
  let before: SchedulingRecord;
  try {
    before = schedulingOf(db, now);
    db.setScheduling({ state: "off", via: null });
  } finally {
    db.close();
  }
  const { removed } = removeProject(home, project.root);
  const { entries } = pruneRegistry(home);
  const problems: Problem[] = [];
  let job: JobInfo | null = null;
  // The one job serves every project: it goes once none of them needs it.
  if (!entries.some((x) => x.via === "os-job")) {
    job = removeQuietly(e, problems, before.via === "os-job" || removed?.via === "os-job", "scheduling is off for this project: its ticks exit at once");
  }
  const data: ScheduleData = {
    action: "off", root: project.root, scheduling: schedulingJson(readScheduling(stateDir, now), project.timezone), job,
    registry: { file: home.registry, projects: entries.length, osJob: entries.filter((x) => x.via === "os-job").length },
    serve: serveOf(stateDir), assets: [],
  };
  return { data, problems, next: [], ok: true, exit: 0 };
}

async function pause(e: Invocation, forMs: number | null): Promise<CommandResult<ScheduleData>> {
  const { project, now } = e;
  const stateDir = project.paths.stateDir;
  const before = readScheduling(stateDir, now);
  if (before.state === "off") {
    throw new CroftError("USAGE_ERROR", {
      message: "scheduling is off for this project, so there is nothing to pause",
      hint: "croft schedule on turns scheduled runs on; croft schedule status shows the setting",
      fix: { kind: "command", description: "show the scheduling setting", command: "croft schedule status" },
    });
  }
  const pausedUntil = forMs === null ? null : new Date(now.getTime() + forMs).toISOString();
  const db = RunsDb.open(stateDir, { now: () => now });
  try {
    db.setScheduling({ state: "paused", via: before.via, pausedUntil });
  } finally {
    db.close();
  }
  const data: ScheduleData = {
    action: "pause", root: project.root, scheduling: schedulingJson(readScheduling(stateDir, now), project.timezone), job: null,
    registry: registrySummary(e.home), serve: serveOf(stateDir), assets: [],
  };
  return { data, problems: [], next: [{ command: "croft schedule on", reason: "resume scheduled runs now" }], ok: true, exit: 0 };
}

async function status(e: Invocation): Promise<CommandResult<ScheduleData>> {
  const { project, now, home } = e;
  const stateDir = project.paths.stateDir;
  const tz = project.timezone;
  const rec = readScheduling(stateDir, now);
  const serve = serveOf(stateDir);
  const job = rec.state !== "off" && rec.via === "os-job" ? inspected(e) : null;
  const views = await (e.deps.scheduleView ?? defaultScheduleView)({ root: project.root, now });
  const assets = views.map((v) => assetOf(v, tz));
  const problems: Problem[] = [];
  const next: Next[] = [];
  if (rec.stale) {
    problems.push(staleProblem(rec, {
      root: project.root, stateDir, tz, now, home, serve, ...(rec.via === "os-job" ? { runner: e.runner() } : {}),
      ...(e.jobOptions.platform ? { platform: e.jobOptions.platform } : {}), ...(e.jobOptions.uid !== undefined ? { uid: e.jobOptions.uid } : {}),
    }));
  }
  if (rec.state !== "off") {
    const holds = holdsOf(assets);
    problems.push(...holds.problems);
    next.push(...holds.next);
  } else {
    next.push({ command: "croft schedule on", reason: "run the scheduled ingests on their schedules" });
  }
  const data: ScheduleData = {
    action: "status", root: project.root, scheduling: schedulingJson(rec, tz), job, registry: registrySummary(home), serve, assets,
  };
  return { data, problems, next, ok: true, exit: 0 };
}

// ---------------------------------------------------------------------------------------------------------
// Human output (§4.2)

function heldText(a: ScheduleAsset): string {
  if (!a.held) return "—";
  const words = `${a.held.code === "SCHEDULE_HELD" ? "held" : a.held.code === "LARGE_REPROCESS" ? "held (LARGE_REPROCESS)" : a.held.code}: ${a.held.reason}`;
  return HUMAN_HOLDS.has(a.held.code) && !a.held.reason.includes("croft run") ? `${words} (croft run ${a.asset})` : words;
}

function scheduledLines(assets: readonly ScheduleAsset[], tz: string, now: Date): string[] {
  const scheduled = assets.filter((a) => a.schedule !== null);
  const rows = scheduled.map((a) => [a.asset, a.schedule, a.cron ?? "", a.nextFireAt ? `next ${clockText(a.nextFireAt, tz, now)}` : ""]);
  // An aligned table without its (empty) header line.
  return rows.length ? table(["", "", "", ""], rows, { limit: Infinity, maxWidth: 200, indent: "  " }).text.split("\n").slice(1) : [];
}

function heldLines(assets: readonly ScheduleAsset[]): string[] {
  const held = assets.filter((a) => a.held !== null && HUMAN_HOLDS.has(a.held.code));
  if (!held.length) return [];
  return [
    "Held until run by hand (the scheduler only runs code a human has run; new assets wait for their first run):",
    ...held.map((a) => `  ${a.asset}  ${a.held!.reason}${a.held!.reason.includes("croft run") ? "" : ` → croft run ${a.asset}`}`),
  ];
}

function tickLine(d: ScheduleData, problems: readonly Problem[], now: Date): string[] {
  const t = d.firstTick;
  if (!t) return [];
  if (t.alreadyTicking) return [`Already ticking: last tick ${agoText(t.at, now)}.`];
  if (t.ok) return [`Waiting for the first tick… ok (after ${spanText(t.waitedMs)})`];
  const stale = problems.find((p) => p.code === "SCHEDULER_STALE");
  return [`Waiting for the first tick… none after ${spanText(t.waitedMs)} (see the warning below)`, ...(stale ? logTailLines(stale) : [])];
}

export function formatSchedule(d: ScheduleData, problems: readonly Problem[], tz: string, now: Date, userHome: string): string {
  const where = homeShort(d.root, userHome);
  const lines: string[] = [];
  const s = d.scheduling;
  if (d.action === "on") {
    if (s.via === "serve") {
      lines.push(`Scheduling is on for ${where}, ticked by croft serve only (no OS job): nothing runs on a schedule while croft serve is stopped.`);
      lines.push(d.serve ? `croft serve (pid ${d.serve.pid}) is running and ticks every minute.` : "croft serve is not running: start it in a terminal and keep it running (it ticks every minute).");
      if (d.job?.removed) lines.push("Removed the per-user OS job (no other project uses it).");
    } else {
      lines.push(`Scheduling is on for ${where} (one job per user; checked every minute; survives restarts).`);
      if (d.job && d.job.bunStable === false) {
        lines.push(`note: the job runs Bun from ${d.job.bun}, a version manager's path that may vanish on upgrade; Bun's own installer (curl -fsSL https://bun.sh/install | bash) gives a stable one, then run croft schedule on again`);
      }
    }
    lines.push(...tickLine(d, problems, now));
    const scheduled = scheduledLines(d.assets, tz, now);
    if (d.assetsUnavailable) lines.push("  (the scheduled ingests could not be listed: see the warning below)");
    else lines.push(...(scheduled.length ? scheduled : ["  no ingest has a schedule yet (add schedule: \"every hour\" to one; croft docs ingest)"]));
    lines.push(...heldLines(d.assets));
    lines.push("Turn off: croft schedule off");
    return lines.join("\n");
  }
  if (d.action === "off") {
    lines.push(`Scheduling is off for ${where}: nothing runs on a schedule until croft schedule on.`);
    const others = d.registry?.osJob ?? 0;
    if (d.job?.removed) lines.push("Removed the per-user OS job (no other project uses it).");
    else if (others > 0) lines.push(`The per-user OS job stays: it ticks ${others} other project${others === 1 ? "" : "s"}.`);
    return lines.join("\n");
  }
  if (d.action === "pause") {
    const until = s.pausedUntil ? `until ${clockText(s.pausedUntil, tz, now)} (in ${spanText(Date.parse(s.pausedUntil) - now.getTime())})` : "until croft schedule on";
    lines.push(`Scheduling is paused for ${where} ${until}; croft schedule on resumes it now.`);
    return lines.join("\n");
  }
  // status
  lines.push(statusHead(d, now, tz));
  if (d.job) {
    const j = d.job;
    const state = !j.installed ? "not installed" : j.loaded === false ? "installed, not loaded" : j.loaded ? "installed, loaded" : "installed";
    lines.push(`Job: ${j.kind === "launchd" ? `launchd ${j.label}` : `crontab (${j.label})`} · ${state}${j.bun ? ` · bun ${j.bun}${j.bunExists ? "" : " (missing)"}` : ""}`);
  }
  const stale = problems.find((p) => p.code === "SCHEDULER_STALE");
  if (stale) lines.push(...logTailLines(stale));
  if (d.assets.length === 0) {
    lines.push("No assets yet.");
    return lines.join("\n");
  }
  const rows = d.assets.map((a) => [
    a.asset,
    a.schedule ?? (a.kind === "ingest" ? "manual" : "after inputs"),
    a.cron ?? "—",
    a.nextFireAt ? fireText(a.nextFireAt, tz, now) : "—",
    a.lastFireAt ? clockText(a.lastFireAt, tz, now) : "—",
    a.held ? heldText(a) : a.due ? `due${a.dueReason ? `: ${a.dueReason}` : ""}` : "—",
  ]);
  lines.push(table(["ASSET", "SCHEDULE", "CRON", "NEXT", "LAST FIRE", "STATUS"], rows, { limit: Infinity, maxWidth: 200 }).text);
  return lines.join("\n");
}

function statusHead(d: ScheduleData, now: Date, tz: string): string {
  const s = d.scheduling;
  const parts = [`Scheduling ${s.state}`];
  if (s.state === "paused") parts.push(s.pausedUntil ? `until ${clockText(s.pausedUntil, tz, now)}` : "until croft schedule on");
  if (s.state !== "off") parts.push(`ticks from ${tickerText(s, d.serve)}`);
  const stale = s.stale ? " (stale)" : "";
  parts.push(s.lastTickAt ? `last tick ${agoText(s.lastTickAt, now)}${stale}` : s.state === "on" ? `no tick yet${stale}` : "never ticked");
  return parts.join(" · ");
}
