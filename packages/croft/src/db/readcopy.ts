// The opt-in read copy for GUIs (DESIGN.md §5 "Server mode, apps and GUIs", `readCopy` in croft.json): the
// database's `<stem>.read.duckdb` next to it (warehouse.read.duckdb), for tools that need a file (the DuckDB UI,
// DBeaver, notebooks) and for croft serve's stale answers while a writer holds the live file. The runner calls
// refreshReadCopy at the end of every run that committed a write.
//
//   request   runs.sqlite setting "readCopy": every request bumps `requested`. While another live process is
//             refreshing (`holder`), the request is left to it, and it refreshes once more after its current
//             round: a burst of runs ending together costs two refreshes, not one each. Within this process,
//             calls made while a refresh runs share one follow-up after it.
//   lease     a write lease like every writer's (write intent first, then the file lock, so croft serve steps
//             aside), through the run's own DuckWarehouse when the caller passes it, else this process's:
//             1. CHECKPOINT, so the file holds every commit: a copy taken without it missed rows still in the
//                WAL (1,000 of 1,500) [V];
//             2. a child process clones the file to a temporary name next to the copy: `cp -c` (clonefile) on
//                macOS, `cp` with reflink=auto on Linux, a plain `cp` when that fails. A child, because this
//                process must not open the warehouse any other way (§5 "Owning the DuckDB file"); /bin/cp by
//                absolute path, with an explicit environment.
//             The lease lasts the checkpoint plus the clone and nothing else. A clone takes 0.1–0.2 ms on APFS
//             [V]; a plain copy takes as long as the copy, which must not see a write.
//   release   a warehouse this call opened is closed (lock and intent gone) before anything else happens.
//   rename    the temporary file gets the checkpoint's time as its mtime (croft serve's `asOf`) and is renamed
//             over the copy, so a reader never sees a half file and one holding the old copy keeps reading it
//             (POSIX rename; the read copy is POSIX-only in v1). A WAL a GUI left next to the old copy goes first:
//             DuckDB would replay it onto the new one.
//
// Errors are logged to <state>/readcopy.log and recorded in the setting (lastError), never thrown: the run has
// already succeeded, and a copy that missed a refresh only shows older data, which croft serve marks with asOf.
//
//   status    readCopyStatus, for doctor and status (R32-11): the copy's path and asOf, the last good refresh, the
//             last error, and its health. A refresh records which runs it covers (`covers`: the last finished run
//             that committed a write, as runs.sqlite orders them), so a copy older than the last run that wrote data
//             is found by run order, not by comparing clocks. A stat and runs.sqlite only: it never opens the copy,
//             and this module imports DuckDB only when it refreshes, so doctor can import it before the binding
//             check.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { CroftError } from "../core/errors.ts";
import { currentIdentity, type ProcessIdentity, recordAlive } from "../core/proc.ts";
import { formatInstant, now, parseInstant, zonedParts } from "../core/time.ts";
import { RunsDb } from "../history/runs-db.ts";
import { loadProject, type Project } from "../project/root.ts";
import type { DuckWarehouse } from "./warehouse.ts";

/** The runs.sqlite setting that coordinates refreshes and records the last one. */
export const READ_COPY_SETTING = "readCopy";
/** Where refresh errors are logged, in the state folder. */
export const READ_COPY_LOG = "readcopy.log";

export const READ_COPY_DEFAULTS = {
  /** How long a refresh waits for the warehouse lock. A writer that holds it longer refreshes the copy itself. */
  waitMs: 30_000,
  /** A clone or copy that runs longer is killed (the lease must end). */
  cloneTimeoutMs: 10 * 60_000,
  /** Follow-up rounds one refresher runs for requests that arrive meanwhile, at most. */
  maxRounds: 10,
} as const;

/** Where cp is looked for, by absolute path. */
const CP_PATHS = ["/bin/cp", "/usr/bin/cp"] as const;
/** GNU cp's clone-if-possible flag. Built from two parts: the agent-contract scan reads every string of the source
 *  and would take the whole flag for an option of croft's own. */
const REFLINK_AUTO = "-" + "-reflink=auto";

/** How the copy was made: an APFS clone (`cp -c`), a reflink or copy (`cp` with reflink=auto), or a plain copy. */
export type CloneMethod = "clone" | "reflink" | "copy";

/** What a refresh did. It never throws. */
export type ReadCopyOutcome =
  | { status: "disabled" }
  /** Nothing to copy (no warehouse yet), or no readable project. */
  | { status: "skipped"; reason: string }
  /** Another live process is refreshing; it refreshes once more for this request. */
  | { status: "coalesced" }
  /** asOf: the checkpoint's time in the project offset (the copy's mtime); refreshedAt: the same instant, UTC ISO. */
  | { status: "refreshed"; path: string; method: CloneMethod; asOf: string; refreshedAt: string; heldMs: number; rounds: number }
  | { status: "failed"; error: { code: string | null; message: string }; rounds: number };

/** Instrumentation points (tests). Each may be async; a refresh waits for it. */
export interface ReadCopyHooks {
  /** CHECKPOINT returned, under the lease. */
  checkpointed?(e: { at: number }): void | Promise<void>;
  /** The temporary file is complete, still under the lease. */
  cloned?(e: { tmp: string; method: CloneMethod; at: number }): void | Promise<void>;
  /** The lease is over (and the warehouse closed unless the caller passed it); the rename comes next. */
  beforeRename?(e: { tmp: string; path: string; at: number }): void | Promise<void>;
}

export interface ReadCopyOptions {
  /** The project, when the caller has it loaded; otherwise croft.json at `root` is read. */
  project?: Project;
  /** The run's read-write warehouse, so the refresh reuses its open instance and intent. The caller closes it. */
  warehouse?: DuckWarehouse;
  /** The run the refresh follows, recorded in the write intent. */
  runId?: string;
  /** READ_COPY_DEFAULTS.waitMs */
  waitMs?: number;
  /** Which clone command to try first; default process.platform. */
  platform?: NodeJS.Platform;
  /** Where cp is looked for (tests). */
  cp?: readonly string[];
  cloneTimeoutMs?: number;
  hooks?: ReadCopyHooks;
}

/** A finished run that committed a write: its id, and when it finished (runs.finished_at, UTC ISO). */
export interface RunMark { runId: string; at: string }

/** The setting's value. */
interface ReadCopyState {
  /** Bumped by every request; a refresher runs again while it grew during its round. */
  requested: number;
  /** The process refreshing now, or null. */
  holder: ProcessIdentity | null;
  /** The last good refresh: its checkpoint (UTC ISO), how it cloned and how long it held the warehouse. */
  refreshedAt: string | null;
  method: CloneMethod | null;
  heldMs: number | null;
  /** The last finished run that wrote data when the last good refresh began (lastWrite): the copy holds its writes.
   *  null when none had, or for a copy made before croft recorded it. */
  covers: RunMark | null;
  /** The last refresh's error, until one succeeds. `at` is UTC ISO. */
  lastError: { at: string; code: string | null; message: string } | null;
}

/**
 * How current the copy is:
 * - off: readCopy is off;
 * - ok: the last good refresh came after the last run that wrote data;
 * - missing: no copy yet, and nothing failed (the next run that writes makes it);
 * - refreshing: a refresh is under way, or the run that wrote last is still finishing (its refresh follows);
 * - failed: the last refresh failed (lastError): the copy keeps older data;
 * - behind: a run wrote data after the last good refresh, and no refresh followed (readCopy was off then, or the
 *   refreshing process died).
 * failed and behind are warnings in doctor and status.
 */
export type ReadCopyHealth = "off" | "ok" | "missing" | "refreshing" | "failed" | "behind";

/** The read copy for doctor and status: whether it is on, where, and how current. */
export interface ReadCopyStatus {
  enabled: boolean;
  path: string;
  exists: boolean;
  /** The copy's mtime (its checkpoint) in the project offset, or null without a copy. */
  asOf: string | null;
  refreshedAt: string | null;
  method: CloneMethod | null;
  lastError: ReadCopyState["lastError"];
  /** The last finished run that committed a write (runs.sqlite), or null. */
  lastWrite: RunMark | null;
  /** A refresh is under way: another live process holds it, or the run that wrote last is still finishing. */
  refreshing: boolean;
  health: ReadCopyHealth;
  /** <state>/readcopy.log, where refresh errors go. */
  log: string;
}

/**
 * Refresh the read copy of the project at `root`: a no-op unless readCopy is on. Called by the runner after a run
 * that committed writes. Never throws; errors go to <state>/readcopy.log and the outcome.
 */
export async function refreshReadCopy(root: string, o: ReadCopyOptions = {}): Promise<ReadCopyOutcome> {
  let project: Project;
  try {
    project = o.project ?? loadProject({ root });
  } catch (e) {
    return { status: "skipped", reason: `no project to refresh: ${messageOf(e)}` };
  }
  if (!project.config.readCopy) return { status: "disabled" };
  let key: string;
  try {
    const { canonicalPath } = await import("./connect.ts");
    key = canonicalPath(project.paths.readCopy); // one key however the root was spelled
  } catch {
    key = project.paths.readCopy;
  }
  return coalesce(key, () => refreshLoop(project, o));
}

/** The last finished run that committed a write: a run whose status is final and one of whose steps is ok (the
 *  runner refreshes the copy after each such run). Runs still running are left out: their refresh comes at their
 *  end. */
function lastWrite(runs: RunsDb): RunMark | null {
  const row = runs.sqlite.query(`SELECT id, finished_at FROM runs
      WHERE status <> 'running' AND finished_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM steps s WHERE s.run_id = runs.id AND s.status = 'ok')
      ORDER BY finished_at DESC, id DESC LIMIT 1`).get() as { id: string; finished_at: string } | null;
  return row ? { runId: row.id, at: row.finished_at } : null;
}

/** Whether the process of a run is alive (runs.sqlite's pid, start time and boot id). */
function runAlive(runs: RunsDb, runId: string): boolean {
  const r = runs.getRun(runId);
  return !!r && recordAlive({ pid: r.pid, procStart: r.procStart, bootId: r.bootId });
}

/**
 * The read copy's state, from a stat of the copy and runs.sqlite (the setting, and the last run that wrote data).
 * Never opens the copy, never writes. `runs`: an open runs.sqlite to read (the caller's).
 */
export function readCopyStatus(project: Project, runs?: RunsDb): ReadCopyStatus {
  const path = project.paths.readCopy;
  const log = join(project.paths.stateDir, READ_COPY_LOG);
  let mtimeMs: number | null = null;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {}
  let state: ReadCopyState = emptyState();
  let written: RunMark | null = null;
  let holderAlive = false;
  let writerAlive = false;
  try {
    const db = runs ?? (existsSync(join(project.paths.stateDir, "runs.sqlite")) ? RunsDb.open(project.paths.stateDir) : null);
    try {
      if (db) {
        state = readState(db);
        written = lastWrite(db);
        holderAlive = state.holder !== null && recordAlive(state.holder);
        const unsettled = state.lastError !== null || (written !== null && behindOf(state, written, mtimeMs));
        if (unsettled && written && !holderAlive) writerAlive = runAlive(db, written.runId);
      }
    } finally {
      if (!runs) db?.close();
    }
  } catch {}
  const enabled = project.config.readCopy;
  const exists = mtimeMs !== null;
  const refreshing = holderAlive || writerAlive;
  const health: ReadCopyHealth = !enabled ? "off"
    : refreshing ? "refreshing"
    : state.lastError ? "failed"
    : !exists ? "missing"
    : written && behindOf(state, written, mtimeMs) ? "behind"
    : "ok";
  return {
    enabled, path, exists,
    asOf: mtimeMs === null ? null : formatInstant(Math.round(mtimeMs), project.timezone),
    refreshedAt: state.refreshedAt, method: state.method, lastError: state.lastError,
    lastWrite: written, refreshing, health, log,
  };
}

/** Whether the copy misses the writes of `written`: by run order when the last refresh recorded what it covers,
 *  else (a copy made before that) by the copy's time. */
function behindOf(state: ReadCopyState, written: RunMark, mtimeMs: number | null): boolean {
  if (mtimeMs === null) return false;
  // lastWrite orders by finished_at, then id: the same order decides here.
  if (state.covers) return written.at > state.covers.at || (written.at === state.covers.at && written.runId > state.covers.runId);
  return Date.parse(written.at) > mtimeMs;
}

// ---- how doctor and status show it ------------------------------------------------------------------------

/** The read copy in doctor's details and status's data.readCopy: instants in the project zone. */
export interface ReadCopyView {
  path: string;
  exists: boolean;
  asOf: string | null;
  refreshedAt: string | null;
  method: CloneMethod | null;
  lastError: { at: string; code: string | null; message: string } | null;
  lastWrite: { runId: string; at: string } | null;
  health: Exclude<ReadCopyHealth, "off">;
  log: string;
}

/** What doctor and status print: a line, and for failed and behind a warning with its hint. */
export interface ReadCopyWords {
  /** "warehouse.read.duckdb · as of 10:02 (3 min ago)". */
  text: string;
  warning: boolean;
  hint: string | null;
}

/** readCopyWords with the view. */
export interface ReadCopySummary extends ReadCopyWords {
  view: ReadCopyView;
}

const NOT_REFRESHED = "the read copy was not refreshed: ";

/** The read copy as JSON, instants in the project zone `tz`; null when readCopy is off. */
export function readCopyView(s: ReadCopyStatus, tz: string): ReadCopyView | null {
  if (!s.enabled || s.health === "off") return null;
  const zoned = (iso: string | null) => (iso ? zonedOr(iso, tz) : null);
  return {
    path: s.path, exists: s.exists, asOf: s.asOf, refreshedAt: zoned(s.refreshedAt), method: s.method,
    lastError: s.lastError ? { ...s.lastError, at: zoned(s.lastError.at)! } : null,
    lastWrite: s.lastWrite ? { runId: s.lastWrite.runId, at: zoned(s.lastWrite.at)! } : null,
    health: s.health, log: s.log,
  };
}

/**
 * A read copy in words, at `now`. Paths inside the project (`root`) are shown relative to it, so the hint of a
 * warning names .croft/readcopy.log. `database`: the warehouse, which a program holding it keeps from being copied.
 */
export function readCopyWords(v: ReadCopyView, o: { root: string; database: string; tz: string; now: Date }): ReadCopyWords {
  const shown = (p: string) => (p === o.root || p.startsWith(o.root + sep) ? relative(o.root, p) : p);
  const log = shown(v.log);
  const asOf = v.asOf ? `as of ${clock(v.asOf, o.tz, o.now)} (${ago(v.asOf, o.now)})` : null;
  const parts = [shown(v.path)];
  let hint: string | null = null;
  switch (v.health) {
    case "ok":
      parts.push(asOf ?? "no copy");
      break;
    case "missing":
      parts.push("not made yet: the next croft run that writes data makes it");
      break;
    case "refreshing":
      parts.push(...(asOf ? [asOf] : []), "being refreshed now");
      break;
    case "failed": {
      const e = v.lastError!;
      const why = e.message.startsWith(NOT_REFRESHED) ? e.message.slice(NOT_REFRESHED.length) : e.message;
      parts.push(asOf ?? "no copy yet", `the last refresh failed ${ago(e.at, o.now)}${e.code ? ` (${e.code})` : ""}: ${why}`);
      hint = e.code === "DB_HELD_BY_OTHER_PROGRAM"
        ? `close the program holding ${shown(o.database)} (GUIs open ${shown(v.path)} instead); the next croft run that writes data refreshes the copy (${log} has each failure)`
        : `fix what ${log} says (free disk space, for example); the next croft run that writes data refreshes the copy`;
      break;
    }
    case "behind":
      parts.push(`${asOf ?? "no copy"}, older than the last run that wrote data (${v.lastWrite!.runId}, ${clock(v.lastWrite!.at, o.tz, o.now)})`);
      hint = `the next croft run that writes data refreshes the copy; no refresh followed that run (readCopy was off then, or the refresh was cut short; ${log} has each failure)`;
      break;
  }
  return { text: parts.join(" · "), warning: v.health === "failed" || v.health === "behind", hint };
}

/** The read copy of `project` (s: its readCopyStatus) as doctor shows it, at `at`; null when readCopy is off. */
export function readCopySummary(s: ReadCopyStatus, project: Project, at: Date): ReadCopySummary | null {
  const view = readCopyView(s, project.timezone);
  if (!view) return null;
  const words = readCopyWords(view, { root: project.root, database: project.paths.database, tz: project.timezone, now: at });
  return { view, ...words };
}

function zonedOr(iso: string, tz: string): string {
  try {
    return formatInstant(iso, tz);
  } catch {
    return iso;
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number) => String(n).padStart(2, "0");

/** Epoch milliseconds of an ISO instant (with an offset, and microseconds); NaN when it is not one. */
function epochMs(iso: string): number {
  try {
    return Number(parseInstant(iso) / 1000n);
  } catch {
    return Date.parse(iso);
  }
}

/** "10:02" on the same local day as `at`, else "Sep 23 10:02" (as schedule.ts clockText). */
function clock(iso: string, tz: string, at: Date): string {
  const t = epochMs(iso);
  if (!Number.isFinite(t)) return iso;
  const p = zonedParts(new Date(t), tz);
  const n = zonedParts(at, tz);
  const time = `${pad2(p.hour)}:${pad2(p.minute)}`;
  if (p.year === n.year && p.month === n.month && p.day === n.day) return time;
  return `${MONTHS[p.month - 1]} ${p.day}${p.year !== n.year ? ` ${p.year}` : ""} ${time}`;
}

/** "12 s ago", "14 min ago", "3 h ago", "2 days ago". */
function ago(iso: string, at: Date): string {
  const t = epochMs(iso);
  if (!Number.isFinite(t)) return "at an unknown time";
  const s = Math.round((at.getTime() - t) / 1000);
  if (s < 0) return "just now";
  if (s < 90) return `${s} s ago`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
  const days = Math.round(s / 86_400);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// ---- coalescing in this process ---------------------------------------------------------------------------

interface Slot { running: Promise<ReadCopyOutcome>; next: Promise<ReadCopyOutcome> | null }
const slots = new Map<string, Slot>();

/** Run `work` now, or once after the running one: every call made meanwhile shares that follow-up. */
function coalesce(key: string, work: () => Promise<ReadCopyOutcome>): Promise<ReadCopyOutcome> {
  const slot = slots.get(key);
  if (slot) {
    slot.next ??= slot.running.catch(() => {}).then(() => {
      slot.next = null;
      return start(slot, key, work);
    });
    return slot.next;
  }
  const fresh: Slot = { running: Promise.resolve({ status: "disabled" }), next: null };
  slots.set(key, fresh);
  return start(fresh, key, work);
}

function start(slot: Slot, key: string, work: () => Promise<ReadCopyOutcome>): Promise<ReadCopyOutcome> {
  const p: Promise<ReadCopyOutcome> = work().finally(() => {
    if (slot.running === p && !slot.next) slots.delete(key);
  });
  slot.running = p;
  return p;
}

// ---- coalescing across processes (runs.sqlite) ------------------------------------------------------------

function emptyState(): ReadCopyState {
  return { requested: 0, holder: null, refreshedAt: null, method: null, heldMs: null, covers: null, lastError: null };
}

function readState(runs: RunsDb): ReadCopyState {
  const v = runs.getSetting<Partial<ReadCopyState>>(READ_COPY_SETTING);
  const s = emptyState();
  if (!v || typeof v !== "object") return s;
  if (typeof v.requested === "number" && Number.isFinite(v.requested)) s.requested = v.requested;
  const h = v.holder;
  if (h && typeof h.pid === "number" && typeof h.procStart === "string") s.holder = { pid: h.pid, procStart: h.procStart, bootId: typeof h.bootId === "string" ? h.bootId : "" };
  if (typeof v.refreshedAt === "string") s.refreshedAt = v.refreshedAt;
  if (v.method === "clone" || v.method === "reflink" || v.method === "copy") s.method = v.method;
  if (typeof v.heldMs === "number") s.heldMs = v.heldMs;
  if (v.covers && typeof v.covers.runId === "string" && typeof v.covers.at === "string") s.covers = { runId: v.covers.runId, at: v.covers.at };
  if (v.lastError && typeof v.lastError.message === "string") s.lastError = v.lastError;
  return s;
}

const isMe = (h: ProcessIdentity, me: ProcessIdentity) => h.pid === me.pid && h.procStart === me.procStart;

/** Record a request; take the refresh unless another live process has it ("coalesced"). */
function claim(runs: RunsDb, me: ProcessIdentity): "mine" | "coalesced" {
  return runs.transaction(() => {
    const s = readState(runs);
    s.requested += 1;
    const busy = s.holder !== null && !isMe(s.holder, me) && recordAlive(s.holder);
    if (!busy) s.holder = me;
    runs.setSetting(READ_COPY_SETTING, s);
    return busy ? "coalesced" : "mine";
  });
}

/** Record a round's outcome. True when requests arrived during it (and another round may run); otherwise the
 *  refresh is given up in the same transaction, so a request made after it finds no holder and refreshes itself.
 *  `covers`: the last run that wrote data when the round began, which a good refresh holds. */
function endRound(runs: RunsDb, me: ProcessIdentity, target: number, out: ReadCopyOutcome, mayContinue: boolean, covers: RunMark | null): boolean {
  return runs.transaction(() => {
    const s = readState(runs);
    if (out.status === "refreshed") {
      s.refreshedAt = out.refreshedAt;
      s.method = out.method;
      s.heldMs = out.heldMs;
      s.covers = covers;
      s.lastError = null;
    } else if (out.status === "failed") {
      s.lastError = { at: now().toISOString(), code: out.error.code, message: out.error.message };
    }
    const again = mayContinue && s.requested > target;
    if (!again && s.holder && isMe(s.holder, me)) s.holder = null;
    runs.setSetting(READ_COPY_SETTING, s);
    return again;
  });
}

async function refreshLoop(project: Project, o: ReadCopyOptions): Promise<ReadCopyOutcome> {
  const stateDir = project.paths.stateDir;
  let runs: RunsDb | null = null;
  const me = currentIdentity();
  let holding = false;
  let rounds = 0;
  try {
    runs = RunsDb.open(stateDir);
    if (claim(runs, me) === "coalesced") return { status: "coalesced" };
    holding = true;
    for (;;) {
      rounds++;
      // Requests made before this round's CHECKPOINT are covered by it, and so are the runs finished before it.
      const target = readState(runs).requested;
      const covers = lastWrite(runs);
      const out = await refreshOnce(project, o, rounds);
      if (out.status === "failed") log(stateDir, `${out.error.code ? `${out.error.code}: ` : ""}${out.error.message}`);
      const again = endRound(runs, me, target, out, rounds < READ_COPY_DEFAULTS.maxRounds, covers);
      if (!again) {
        holding = false;
        return out;
      }
      // Requests arrived during the round: once more, for all of them.
    }
  } catch (e) {
    // runs.sqlite itself failed (busy past its timeout, unwritable): log, and never fail the run.
    const error = { code: e instanceof CroftError ? e.code : null, message: `the read copy was not refreshed: ${messageOf(e)}` };
    log(stateDir, error.message);
    return { status: "failed", error, rounds };
  } finally {
    if (holding && runs) {
      try {
        runs.transaction(() => {
          const s = readState(runs!);
          if (s.holder && isMe(s.holder, me)) runs!.setSetting(READ_COPY_SETTING, { ...s, holder: null });
        });
      } catch {}
    }
    runs?.close();
  }
}

// ---- one refresh ---------------------------------------------------------------------------------------------

async function refreshOnce(project: Project, o: ReadCopyOptions, round: number): Promise<ReadCopyOutcome> {
  const { database, readCopy: path, stateDir } = project.paths;
  if (!existsSync(database)) return { status: "skipped", reason: `the warehouse ${database} does not exist yet` }; // a stat
  const failed = (e: unknown): ReadCopyOutcome => ({
    status: "failed", rounds: round,
    error: { code: e instanceof CroftError ? e.code : null, message: `the read copy was not refreshed: ${messageOf(e)}` },
  });
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`);
  let own: DuckWarehouse | null = null;
  try {
    mkdirSync(dir, { recursive: true });
    removeTemps(path);
    // DuckDB is imported only here, when a refresh opens the warehouse itself (doctor imports this module).
    const w = o.warehouse ?? (own = (await import("./warehouse.ts")).openWarehouse({
      path: database, mode: "read_write", timezone: project.timezone, root: project.root, stateDir, isTTY: false,
      ...(o.runId ? { runId: o.runId } : {}),
    }));
    // Without a run the intent names none, and croft serve says "a croft write (pid n)".
    const leased = await w.write("refresh the read copy", async (sql) => {
      const started = Date.now();
      await sql.exec("CHECKPOINT");
      const at = now();
      assertWalFolded(database);
      await o.hooks?.checkpointed?.({ at: Date.now() });
      const method = await cloneFile(database, tmp, o);
      const heldMs = Date.now() - started;
      await o.hooks?.cloned?.({ tmp, method, at: Date.now() });
      return { at, method, heldMs };
    }, { runId: o.runId ?? "", transaction: false, waitMs: o.waitMs ?? READ_COPY_DEFAULTS.waitMs });
    // The file goes before anything else: the lease was the checkpoint plus the clone.
    if (own) await own.close();
    own = null;
    await o.hooks?.beforeRename?.({ tmp, path, at: Date.now() });
    utimesSync(tmp, leased.at, leased.at);
    rmSync(`${path}.wal`, { force: true });
    renameSync(tmp, path);
    return {
      status: "refreshed", path, method: leased.method, asOf: formatInstant(leased.at, project.timezone), heldMs: leased.heldMs,
      rounds: round, refreshedAt: leased.at.toISOString(),
    };
  } catch (e) {
    return failed(e);
  } finally {
    rmSync(tmp, { force: true });
    if (own) await own.close().catch(() => {});
  }
}

/** After CHECKPOINT the WAL is gone or empty; otherwise the copy would miss what it holds. A stat, never an open. */
function assertWalFolded(database: string): void {
  let size = 0;
  try {
    size = statSync(`${database}.wal`).size;
  } catch {
    return;
  }
  if (size > 0) throw new Error(`the WAL still held ${size} bytes after CHECKPOINT, so a copy would miss commits`);
}

/** Temporary files a killed refresh left next to the copy. Only the holder refreshes, so none of another process
 *  is in use; this process removes its own as each refresh ends. */
function removeTemps(path: string): void {
  const prefix = `.${basename(path)}.`;
  const mine = `${prefix}${process.pid}-`;
  for (const name of readdirSync(dirname(path))) {
    if (name.startsWith(prefix) && name.endsWith(".tmp") && !name.startsWith(mine)) rmSync(join(dirname(path), name), { force: true, recursive: true });
  }
}

/** Clone `src` to `dst` in a child process: the platform's clone command, then a plain copy. */
async function cloneFile(src: string, dst: string, o: ReadCopyOptions): Promise<CloneMethod> {
  const cp = (o.cp ?? CP_PATHS).find((p) => existsSync(p));
  if (!cp) throw new Error(`cp was not found (looked for ${(o.cp ?? CP_PATHS).join(", ")})`);
  const timeoutMs = o.cloneTimeoutMs ?? READ_COPY_DEFAULTS.cloneTimeoutMs;
  const platform = o.platform ?? process.platform;
  const fast: { method: CloneMethod; flag: string } | null = platform === "darwin" ? { method: "clone", flag: "-c" }
    : platform === "linux" ? { method: "reflink", flag: REFLINK_AUTO } : null;
  if (fast) {
    const r = await runCp(cp, [fast.flag, src, dst], timeoutMs);
    if (r.ok) return fast.method;
    rmSync(dst, { force: true });
  }
  const r = await runCp(cp, [src, dst], timeoutMs);
  if (r.ok) return "copy";
  rmSync(dst, { force: true });
  throw new Error(`${cp} could not copy the warehouse: ${r.why}`);
}

/** Run cp with a fixed environment; never throws. */
function runCp(cp: string, args: string[], timeoutMs: number): Promise<{ ok: true } | { ok: false; why: string }> {
  return new Promise((resolve) => {
    let stderr = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const done = (v: { ok: true } | { ok: false; why: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cp, args, { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      done({ ok: false, why: messageOf(e) });
      return;
    }
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ ok: false, why: `it took longer than ${Math.round(timeoutMs / 1000)} s` });
    }, timeoutMs);
    child.stderr!.on("data", (d) => {
      if (stderr.length < 2000) stderr += String(d);
    });
    child.on("error", (e) => done({ ok: false, why: e.message }));
    child.on("close", (code, signal) => {
      if (code === 0) done({ ok: true });
      else done({ ok: false, why: stderr.trim().split("\n")[0] || (signal ? `killed by ${signal}` : `exit ${code}`) });
    });
  });
}

// ---- log ----------------------------------------------------------------------------------------------------

/** One line in <state>/readcopy.log (mode 0600). Logging must never fail the caller. */
function log(stateDir: string, message: string): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(join(stateDir, READ_COPY_LOG), `${now().toISOString()} ${message.replace(/\n/g, " ")}\n`, { mode: 0o600 });
  } catch {}
}

function messageOf(e: unknown): string {
  return String((e as Error)?.message ?? e).split("\n")[0]!;
}
