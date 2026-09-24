// .croft/runs.sqlite: observability and coordination state (DESIGN.md §5 "Where state lives").
// bun:sqlite in WAL mode stays readable while DuckDB is locked and while another process writes,
// so `status` and `logs` never wait. Data-coupled state lives in DuckDB's _croft schema instead.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomInt } from "node:crypto";
import { CroftError, problem } from "../core/errors.ts";
import { currentIdentity, type ProcessIdentity } from "../core/proc.ts";
import type { LockHolder, Problem } from "../core/types.ts";
import type { SchedulingSetting } from "../schedule/os.ts";

export const RUNS_DB_FILE = "runs.sqlite";
export const BUSY_TIMEOUT_MS = 5000;

// The v1 schema, exactly as in DESIGN.md §5. Later versions append a migration; never edit one
// that has shipped. Each is idempotent (IF NOT EXISTS) so a half-applied upgrade can rerun.
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, trigger TEXT, human INTEGER, argv TEXT, pid INTEGER,
     proc_start TEXT, boot_id TEXT, started_at TEXT, finished_at TEXT, status TEXT, summary TEXT);
   CREATE TABLE IF NOT EXISTS steps (run_id TEXT, asset TEXT, attempt INTEGER, status TEXT, reason TEXT,
     started_at TEXT, finished_at TEXT, rows_in INTEGER, added INTEGER, updated INTEGER, error TEXT,
     code_hash TEXT, log_path TEXT, PRIMARY KEY (run_id, asset, attempt));
   CREATE TABLE IF NOT EXISTS leases (asset TEXT PRIMARY KEY, run_id TEXT, pid INTEGER, proc_start TEXT,
     boot_id TEXT, since TEXT);
   CREATE TABLE IF NOT EXISTS lock_holder (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER, run_id TEXT,
     asset TEXT, action TEXT, since TEXT);
   CREATE TABLE IF NOT EXISTS lock_waiters (pid INTEGER PRIMARY KEY, purpose TEXT, since TEXT);
   CREATE TABLE IF NOT EXISTS schedule_state (asset TEXT PRIMARY KEY, phrase TEXT, cron TEXT, file_hash TEXT,
     last_fire_at TEXT, last_attempt_at TEXT, approved_code_hash TEXT);
   CREATE TABLE IF NOT EXISTS tick (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER, proc_start TEXT,
     heartbeat_at TEXT);
   CREATE TABLE IF NOT EXISTS confirmations (token TEXT PRIMARY KEY, command TEXT, impact TEXT,
     impact_hash TEXT, created_at TEXT, expires_at TEXT, used_at TEXT);
   CREATE TABLE IF NOT EXISTS catalog (asset TEXT PRIMARY KEY, json TEXT, source TEXT, refreshed_at TEXT);
   CREATE INDEX IF NOT EXISTS steps_by_asset ON steps (asset, started_at);
   CREATE INDEX IF NOT EXISTS runs_by_status ON runs (status);`,
  // 2 (phase 3): per-project settings, such as scheduling on/off/paused.
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);`,
];
export const SCHEMA_VERSION = MIGRATIONS.length;

export type RunStatus = "running" | "succeeded" | "failed" | "crashed" | "interrupted";
export type RunTrigger = "manual" | "schedule" | "confirm" | (string & {});
/** StepResult statuses, plus the states a step passes through or ends in outside a normal finish. */
export type StepStatus = "running" | "ok" | "failed" | "skipped" | "unchanged" | "interrupted" | "crashed";
export type CatalogSource = "run" | "preview" | "pins";

/** Step and run statuses that mean "look here with `logs --failed`". */
export const FAILED_STATUSES = ["failed", "crashed", "interrupted"] as const;

export interface RunRecord {
  id: string; trigger: RunTrigger; human: boolean; argv: string[];
  pid: number | null; procStart: string | null; bootId: string | null;
  startedAt: string; finishedAt: string | null; status: RunStatus; summary: unknown;
}
export interface StepRecord {
  runId: string; asset: string; attempt: number; status: StepStatus; reason: string | null;
  startedAt: string; finishedAt: string | null; rowsIn: number | null; added: number | null;
  updated: number | null; error: Problem | null; codeHash: string | null; logPath: string | null;
}
export interface NewRun {
  trigger: RunTrigger; human: boolean; argv: string[];
  id?: string;                       // a detached parent may pick the id and pass it to the child
  identity?: ProcessIdentity;        // defaults to this process: the one that will do the work
  timeZone?: string;                 // project zone, for the MMDD_HHMM part of a generated id
}
export interface NewStep { runId: string; asset: string; attempt: number; reason: string; codeHash?: string; logPath?: string }
/** StepResult satisfies this, so the runner can pass its result straight through. */
export interface StepFinish {
  status: Exclude<StepStatus, "running">; reason?: string;
  rows?: { in?: number; added?: number; updated?: number };
  error?: Problem | null;
}
export interface RunFilter {
  asset?: string;                    // runs that have a step for this asset
  failed?: boolean;                  // failed/crashed/interrupted (the asset's step, when asset is given)
  since?: string | Date;             // started at or after
  status?: RunStatus[];
  limit?: number;                    // default 50
}
export interface Waiter { pid: number; purpose: string; since: string }
/** schedule_state (§8): instants are ISO-8601 UTC. */
export interface ScheduleStateRow {
  asset: string; phrase: string | null; cron: string | null; fileHash: string | null;
  lastFireAt: string | null; lastAttemptAt: string | null; approvedCodeHash: string | null;
}
export interface TickRow { pid: number | null; procStart: string | null; heartbeatAt: string | null }
interface ScheduleStateDbRow { asset: string; phrase: string | null; cron: string | null; file_hash: string | null;
  last_fire_at: string | null; last_attempt_at: string | null; approved_code_hash: string | null }
function toScheduleState(r: ScheduleStateDbRow): ScheduleStateRow {
  return { asset: r.asset, phrase: r.phrase, cron: r.cron, fileHash: r.file_hash, lastFireAt: r.last_fire_at,
    lastAttemptAt: r.last_attempt_at, approvedCodeHash: r.approved_code_hash };
}
export interface CatalogEntry<T = unknown> { asset: string; value: T; source: CatalogSource; refreshedAt: string }
export interface RunsDbOptions { now?: () => Date }

interface RunRow { id: string; trigger: string; human: number; argv: string | null; pid: number | null;
  proc_start: string | null; boot_id: string | null; started_at: string; finished_at: string | null;
  status: string; summary: string | null }
interface StepRow { run_id: string; asset: string; attempt: number; status: string; reason: string | null;
  started_at: string; finished_at: string | null; rows_in: number | null; added: number | null;
  updated: number | null; error: string | null; code_hash: string | null; log_path: string | null }
interface StaleStep { run_id: string; asset: string; attempt: number; pid: number | null }

const RUN_ID = /^r_\d{4}_\d{4}_[0-9a-z]{4}$/;
const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** `r_MMDD_HHMM_xxxx`, in the project time zone so ids read like the times croft prints. */
export function newRunId(now: Date = new Date(), timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  let suffix = "";
  for (let i = 0; i < 4; i++) suffix += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return `r_${get("month")}${get("day")}_${get("hour")}${get("minute")}_${suffix}`;
}

export function isRunId(s: string): boolean {
  return RUN_ID.test(s);
}

export function toIso(t: string | Date): string {
  const d = typeof t === "string" ? new Date(t) : t;
  if (Number.isNaN(d.getTime())) throw new CroftError("USAGE_ERROR", { message: `not a time: ${String(t)}`, hint: "use an ISO-8601 time" });
  return d.toISOString();
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;   // written by hand or by an older build: surface it rather than crash `logs`
  }
}

/**
 * A step reconcile() has yet to check against the warehouse, once its run has ended: one crashed with no finish
 * time (markCrashed, crashStaleSteps; a step that ends any other way always gets one), or one still marked running.
 * `t` is the steps table's alias with its dot, or "".
 */
function dangling(t: string): string {
  return `(${t}status = 'running' OR (${t}status = 'crashed' AND ${t}finished_at IS NULL))`;
}

/** The error of a step crashed before reconcile() checked it: the process died, and whether the step committed
 *  anything is not known yet. reconcile() replaces it with what it finds. */
export function uncheckedCrash(asset: string, runId: string, pid: number | null): Problem {
  return problem("RUN_CRASHED", {
    message: `the process running ${asset} (pid ${pid ?? "?"}) died before the step finished; the next croft command that writes checks whether it committed anything`,
    hint: `croft run ${asset} checks that first, keeps what the step committed and runs it again; cursors move only on commit, so no data is skipped`,
    asset, runId, retryable: true,
    fix: { kind: "command", description: "run the asset again", command: `croft run ${asset}` },
  });
}

function toRun(r: RunRow): RunRecord {
  return {
    id: r.id, trigger: r.trigger, human: r.human === 1, argv: (parseJson(r.argv) as string[] | null) ?? [],
    pid: r.pid, procStart: r.proc_start, bootId: r.boot_id, startedAt: r.started_at,
    finishedAt: r.finished_at, status: r.status as RunStatus, summary: parseJson(r.summary),
  };
}

function toStep(r: StepRow): StepRecord {
  return {
    runId: r.run_id, asset: r.asset, attempt: r.attempt, status: r.status as StepStatus, reason: r.reason,
    startedAt: r.started_at, finishedAt: r.finished_at, rowsIn: r.rows_in, added: r.added, updated: r.updated,
    error: parseJson(r.error) as Problem | null, codeHash: r.code_hash, logPath: r.log_path,
  };
}

function sqliteCode(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" ? code : "";
}

function isConstraint(e: unknown): boolean {
  return sqliteCode(e).startsWith("SQLITE_CONSTRAINT");
}

/**
 * Switching a new file to WAL needs an exclusive lock, and SQLite reports SQLITE_BUSY at once,
 * without calling the busy handler, when another process is opening the file at the same moment
 * (8 racing openers failed in most rounds). So retry with jitter for as long as busy_timeout.
 */
function enableWal(sqlite: Database): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      sqlite.exec("PRAGMA journal_mode = WAL");   // a filesystem without WAL support keeps its mode, no error
      return;
    } catch (e) {
      if (!sqliteCode(e).startsWith("SQLITE_BUSY") || Date.now() > deadline) throw e;
    }
    Bun.sleepSync(5 + Math.random() * 20);
  }
}

export class RunsDb {
  readonly sqlite: Database;
  readonly path: string;
  readonly now: () => Date;

  private constructor(readonly stateDir: string, sqlite: Database, now: () => Date) {
    this.sqlite = sqlite;
    this.path = join(stateDir, RUNS_DB_FILE);
    this.now = now;
  }

  /** Open (creating if needed) <stateDir>/runs.sqlite and bring its schema up to date. */
  static open(stateDir: string, opts: RunsDbOptions = {}): RunsDb {
    mkdirSync(stateDir, { recursive: true });
    const sqlite = new Database(join(stateDir, RUNS_DB_FILE), { create: true, strict: true });
    try {
      sqlite.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      enableWal(sqlite);
      sqlite.exec("PRAGMA synchronous = NORMAL");
      const db = new RunsDb(stateDir, sqlite, opts.now ?? (() => new Date()));
      db.migrate();
      return db;
    } catch (e) {
      sqlite.close();
      throw e;
    }
  }

  close(): void {
    this.sqlite.close();
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  /** Run fn in a BEGIN IMMEDIATE transaction: the write lock is taken up front, so a
   *  read-then-write (lease acquire, token insert) cannot interleave with another process. */
  transaction<T>(fn: () => T): T {
    return this.sqlite.transaction(fn).immediate();
  }

  schemaVersion(): number {
    return (this.sqlite.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  }

  private migrate(): void {
    if (this.schemaVersion() === SCHEMA_VERSION) return;   // common case: no write lock needed
    this.transaction(() => {
      const from = this.schemaVersion();
      if (from > SCHEMA_VERSION) {
        throw new CroftError("DB_NEWER_FORMAT", {
          message: `${this.path} was written by a newer croft (schema ${from}; this croft knows ${SCHEMA_VERSION})`,
          hint: "upgrade croft (the project pins its version in package.json)",
          file: this.path,
        });
      }
      for (let v = from; v < SCHEMA_VERSION; v++) this.sqlite.exec(MIGRATIONS[v]!);
      this.sqlite.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  // ---- runs ----

  createRun(r: NewRun): RunRecord {
    const who = r.identity ?? currentIdentity();
    const insert = this.sqlite.query(
      `INSERT INTO runs (id, trigger, human, argv, pid, proc_start, boot_id, started_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')`,
    );
    const startedAt = this.nowIso();
    // A generated id collides only if two runs start in the same minute with the same 4 random
    // characters; retry rather than fail. A caller-chosen id that collides is a bug, so it throws.
    for (let tries = 0; ; tries++) {
      const id = r.id ?? newRunId(this.now(), r.timeZone);
      try {
        insert.run(id, r.trigger, r.human ? 1 : 0, JSON.stringify(r.argv), who.pid, who.procStart, who.bootId, startedAt);
        return this.getRun(id)!;
      } catch (e) {
        if (!isConstraint(e)) throw e;
        if (r.id !== undefined || tries >= 20) {
          throw new CroftError("INTERNAL_ERROR", { message: `run id ${id} already exists`, hint: "pick a new run id", runId: id });
        }
      }
    }
  }

  getRun(id: string): RunRecord | null {
    const row = this.sqlite.query("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | null;
    return row ? toRun(row) : null;
  }

  /** Ends a running run. Returns false when it was not running (for example reconcile got there first). */
  finishRun(id: string, status: Exclude<RunStatus, "running">, summary?: unknown): boolean {
    const res = this.sqlite
      .query("UPDATE runs SET status = ?, finished_at = ?, summary = ? WHERE id = ? AND status = 'running'")
      .run(status, this.nowIso(), summary === undefined ? null : JSON.stringify(summary), id);
    return res.changes === 1;
  }

  /** A running run's latest progress as its summary ({progress}), for status and context; finishRun replaces
   *  it with the result. Does nothing once the run has ended. */
  setRunProgress(id: string, progress: unknown): void {
    this.sqlite.query("UPDATE runs SET summary = ? WHERE id = ? AND status = 'running'").run(JSON.stringify({ progress }), id);
  }

  /**
   * running → crashed, together with the run's steps still marked running: they become `crashed` too, unchecked
   * (see crashStaleSteps), so status and describe show the crash at once. Returns false when the run was not
   * running; nothing changes then.
   */
  markCrashed(id: string): boolean {
    return this.transaction(() => {
      const res = this.sqlite
        .query("UPDATE runs SET status = 'crashed', finished_at = ? WHERE id = ? AND status = 'running'")
        .run(this.nowIso(), id);
      if (res.changes !== 1) return false;
      this.crashSteps(this.staleSteps(id));
      return true;
    });
  }

  /**
   * Steps still marked running in a run that has ended (one an older croft marked crashed, say) become `crashed`,
   * unchecked: RUN_CRASHED with no finish time, because only reconcile() can tell from the warehouse whether the
   * step committed before its process died. danglingSteps lists them until settleStep records what it found.
   * Returns how many changed.
   */
  crashStaleSteps(): number {
    // Every writing command calls this, and there is usually nothing to do: no write lock is taken then.
    const stale = this.staleSteps(null);
    return stale.length === 0 ? 0 : this.transaction(() => this.crashSteps(stale));
  }

  /** Steps still marked running in ended runs (of one run, or of all), with their run's pid. */
  private staleSteps(runId: string | null): StaleStep[] {
    return this.sqlite
      .query(`SELECT s.run_id, s.asset, s.attempt, r.pid FROM steps s JOIN runs r ON r.id = s.run_id
              WHERE s.status = 'running' AND r.status <> 'running'${runId === null ? "" : " AND r.id = ?"}`)
      .all(...(runId === null ? [] : [runId])) as StaleStep[];
  }

  /** Each update is guarded by status = 'running', so a step that finished meanwhile keeps its finish. */
  private crashSteps(stale: StaleStep[]): number {
    const crash = this.sqlite.query(
      "UPDATE steps SET status = 'crashed', error = ? WHERE run_id = ? AND asset = ? AND attempt = ? AND status = 'running'",
    );
    let n = 0;
    for (const s of stale) {
      n += crash.run(JSON.stringify(uncheckedCrash(s.asset, s.run_id, s.pid)), s.run_id, s.asset, s.attempt).changes;
    }
    return n;
  }

  runningRuns(): RunRecord[] {
    return (this.sqlite.query("SELECT * FROM runs WHERE status = 'running' ORDER BY started_at").all() as RunRow[]).map(toRun);
  }

  /** Newest first. */
  listRuns(f: RunFilter = {}): RunRecord[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    const failedList = FAILED_STATUSES.map((s) => `'${s}'`).join(", ");
    if (f.asset !== undefined) {
      where.push(`EXISTS (SELECT 1 FROM steps s WHERE s.run_id = runs.id AND s.asset = ?${f.failed ? ` AND s.status IN (${failedList})` : ""})`);
      params.push(f.asset);
    } else if (f.failed) {
      where.push(`status IN (${failedList})`);
    }
    if (f.since !== undefined) {
      where.push("started_at >= ?");
      params.push(toIso(f.since));
    }
    if (f.status?.length) {
      where.push(`status IN (${f.status.map(() => "?").join(", ")})`);
      params.push(...f.status);
    }
    const sql = `SELECT * FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                 ORDER BY started_at DESC, id DESC LIMIT ?`;
    params.push(f.limit ?? 50);
    return (this.sqlite.query(sql).all(...params) as RunRow[]).map(toRun);
  }

  // ---- steps ----

  startStep(s: NewStep): StepRecord {
    try {
      this.sqlite
        .query(`INSERT INTO steps (run_id, asset, attempt, status, reason, started_at, code_hash, log_path)
                VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`)
        .run(s.runId, s.asset, s.attempt, s.reason, this.nowIso(), s.codeHash ?? null, s.logPath ?? null);
    } catch (e) {
      if (!isConstraint(e)) throw e;
      throw new CroftError("INTERNAL_ERROR", {
        message: `step ${s.asset} attempt ${s.attempt} of run ${s.runId} was already started`,
        hint: "each retry needs a new attempt number", asset: s.asset, runId: s.runId,
      });
    }
    return this.getStep(s.runId, s.asset, s.attempt)!;
  }

  getStep(runId: string, asset: string, attempt: number): StepRecord | null {
    const row = this.sqlite.query("SELECT * FROM steps WHERE run_id = ? AND asset = ? AND attempt = ?")
      .get(runId, asset, attempt) as StepRow | null;
    return row ? toStep(row) : null;
  }

  /** Ends a running step. Only a step still marked running changes, so a late finish cannot
   *  overwrite what reconcile decided. Returns whether the step changed. */
  finishStep(runId: string, asset: string, attempt: number, f: StepFinish): boolean {
    return this.endStep("status = 'running'", runId, asset, attempt, f);
  }

  /** Records what reconcile() found for a dangling step (danglingSteps). Only a step still dangling changes, so
   *  two reconciles cannot both settle it, and a late finishStep cannot overwrite what it found. */
  settleStep(runId: string, asset: string, attempt: number, f: StepFinish): boolean {
    return this.endStep(`${dangling("")} AND EXISTS (SELECT 1 FROM runs r WHERE r.id = steps.run_id AND r.status <> 'running')`,
      runId, asset, attempt, f);
  }

  private endStep(when: string, runId: string, asset: string, attempt: number, f: StepFinish): boolean {
    const res = this.sqlite
      .query(`UPDATE steps SET status = ?, reason = coalesce(?, reason), finished_at = ?, rows_in = ?, added = ?,
                updated = ?, error = ?
              WHERE run_id = ? AND asset = ? AND attempt = ? AND ${when}`)
      .run(f.status, f.reason ?? null, this.nowIso(), f.rows?.in ?? null, f.rows?.added ?? null,
        f.rows?.updated ?? null, f.error ? JSON.stringify(f.error) : null, runId, asset, attempt);
    return res.changes === 1;
  }

  stepsFor(runId: string): StepRecord[] {
    return (this.sqlite.query("SELECT * FROM steps WHERE run_id = ? ORDER BY started_at, asset, attempt")
      .all(runId) as StepRow[]).map(toStep);
  }

  /** The most recent step of an asset (the last attempt of its last run). */
  latestStep(asset: string, o: { failed?: boolean } = {}): StepRecord | null {
    const failed = o.failed ? `AND status IN (${FAILED_STATUSES.map((s) => `'${s}'`).join(", ")})` : "";
    const row = this.sqlite
      .query(`SELECT * FROM steps WHERE asset = ? ${failed} ORDER BY started_at DESC, attempt DESC LIMIT 1`)
      .get(asset) as StepRow | null;
    return row ? toStep(row) : null;
  }

  /**
   * The sources of the checks and warnings the asset's last successful write ran: StepResult.checks of its
   * latest `ok` step, from that run's stored summary (checks/run.ts ChecksHookOptions.previous). A check not
   * among them is new or edited and covers the whole table once. null when unknown: no ok step, or its run left
   * no summary (it crashed, or is still going); every check then covers the whole table, which is always safe.
   */
  lastCheckSources(asset: string): string[] | null {
    const row = this.sqlite
      .query(`SELECT r.summary AS summary FROM steps s JOIN runs r ON r.id = s.run_id
              WHERE s.asset = ? AND s.status = 'ok' ORDER BY s.started_at DESC, s.attempt DESC LIMIT 1`)
      .get(asset) as { summary: string | null } | null;
    if (!row) return null;
    const steps = (parseJson(row.summary) as { data?: { steps?: unknown } } | null)?.data?.steps;
    if (!Array.isArray(steps)) return null;
    const step = steps.find((s) => (s as { asset?: unknown } | null)?.asset === asset) as { status?: unknown; checks?: unknown } | undefined;
    if (!step || step.status !== "ok" || !Array.isArray(step.checks)) return null;
    return step.checks.flatMap((c) => (typeof (c as { check?: unknown } | null)?.check === "string" ? [(c as { check: string }).check] : []));
  }

  /** Steps of ended runs that reconcile has left to check against the warehouse: those markCrashed or
   *  crashStaleSteps crashed (no finish time yet), and any still marked running. */
  danglingSteps(): StepRecord[] {
    return (this.sqlite
      .query(`SELECT s.* FROM steps s JOIN runs r ON r.id = s.run_id
              WHERE ${dangling("s.")} AND r.status <> 'running' ORDER BY s.started_at`)
      .all() as StepRow[]).map(toStep);
  }

  // ---- DuckDB lock holder and waiters (diagnostics and writer fairness, §5 "Leases") ----

  setLockHolder(h: { runId?: string; asset?: string; action?: string; pid?: number }): void {
    this.sqlite
      .query(`INSERT INTO lock_holder (id, pid, run_id, asset, action, since) VALUES (1, ?, ?, ?, ?, ?)
              ON CONFLICT (id) DO UPDATE SET pid = excluded.pid, run_id = excluded.run_id,
                asset = excluded.asset, action = excluded.action, since = excluded.since`)
      .run(h.pid ?? process.pid, h.runId ?? null, h.asset ?? null, h.action ?? null, this.nowIso());
  }

  /** Clears the holder row only if pid still owns it, so a slow process cannot erase its successor. */
  clearLockHolder(pid: number = process.pid): boolean {
    return this.sqlite.query("DELETE FROM lock_holder WHERE id = 1 AND pid = ?").run(pid).changes === 1;
  }

  getLockHolder(): LockHolder | null {
    const row = this.sqlite.query("SELECT pid, run_id, asset, action, since FROM lock_holder WHERE id = 1").get() as
      { pid: number | null; run_id: string | null; asset: string | null; action: string | null; since: string } | null;
    if (!row) return null;
    const h: LockHolder = { pid: row.pid, program: "croft", since: row.since };
    if (row.run_id !== null) h.runId = row.run_id;
    if (row.asset !== null) h.asset = row.asset;
    if (row.action !== null) h.action = row.action;
    return h;
  }

  registerWaiter(purpose: string, pid: number = process.pid): void {
    this.sqlite
      .query(`INSERT INTO lock_waiters (pid, purpose, since) VALUES (?, ?, ?)
              ON CONFLICT (pid) DO UPDATE SET purpose = excluded.purpose`)
      .run(pid, purpose, this.nowIso());
  }

  unregisterWaiter(pid: number = process.pid): void {
    this.sqlite.query("DELETE FROM lock_waiters WHERE pid = ?").run(pid);
  }

  listWaiters(): Waiter[] {
    return this.sqlite.query("SELECT pid, purpose, since FROM lock_waiters ORDER BY since").all() as Waiter[];
  }

  /** A writer that sees other waiters yields between write steps (§5 "Fairness"). */
  hasOtherWaiters(pid: number = process.pid): boolean {
    return this.sqlite.query("SELECT 1 FROM lock_waiters WHERE pid <> ? LIMIT 1").get(pid) !== null;
  }

  // ---- the scheduler hold (§6 "The scheduler only runs code a human has run") ----

  /** Record the code hash a human-initiated run or preview of `asset` ran successfully, which releases the
   *  scheduler hold for that code. Other schedule_state columns are kept. */
  approveCode(asset: string, codeHash: string): void {
    this.sqlite.query(
      `INSERT INTO schedule_state (asset, approved_code_hash) VALUES (?, ?)
       ON CONFLICT (asset) DO UPDATE SET approved_code_hash = excluded.approved_code_hash`,
    ).run(asset, codeHash);
  }

  /** The code hash a human last ran for `asset`, or null (never run by hand). */
  approvedCode(asset: string): string | null {
    const row = this.sqlite.query("SELECT approved_code_hash FROM schedule_state WHERE asset = ?").get(asset) as
      { approved_code_hash: string | null } | null;
    return row?.approved_code_hash ?? null;
  }

  // ---- schedule_state and the tick row (§8) ----

  /** An asset's schedule_state row, or null. */
  scheduleState(asset: string): ScheduleStateRow | null {
    const r = this.sqlite.query(`SELECT asset, phrase, cron, file_hash, last_fire_at, last_attempt_at, approved_code_hash
      FROM schedule_state WHERE asset = ?`).get(asset) as ScheduleStateDbRow | null;
    return r ? toScheduleState(r) : null;
  }

  allScheduleState(): ScheduleStateRow[] {
    const rows = this.sqlite.query(`SELECT asset, phrase, cron, file_hash, last_fire_at, last_attempt_at, approved_code_hash
      FROM schedule_state ORDER BY asset`).all() as ScheduleStateDbRow[];
    return rows.map(toScheduleState);
  }

  /** Update the given columns of an asset's schedule_state row (creating it); others are kept. */
  putScheduleState(asset: string, v: Partial<Omit<ScheduleStateRow, "asset">>): void {
    const cols: [keyof Omit<ScheduleStateRow, "asset">, string][] = [
      ["phrase", "phrase"], ["cron", "cron"], ["fileHash", "file_hash"], ["lastFireAt", "last_fire_at"],
      ["lastAttemptAt", "last_attempt_at"], ["approvedCodeHash", "approved_code_hash"],
    ];
    const set = cols.filter(([k]) => v[k] !== undefined);
    this.sqlite.query("INSERT INTO schedule_state (asset) VALUES (?) ON CONFLICT (asset) DO NOTHING").run(asset);
    if (!set.length) return;
    this.sqlite.query(`UPDATE schedule_state SET ${set.map(([, c]) => `${c} = ?`).join(", ")} WHERE asset = ?`)
      .run(...set.map(([k]) => v[k] ?? null), asset);
  }

  deleteScheduleState(asset: string): boolean {
    return this.sqlite.query("DELETE FROM schedule_state WHERE asset = ?").run(asset).changes === 1;
  }

  /** The tick row: the project tick that holds the singleton, and the last heartbeat. */
  getTick(): TickRow | null {
    const r = this.sqlite.query("SELECT pid, proc_start, heartbeat_at FROM tick WHERE id = 1").get() as
      { pid: number | null; proc_start: string | null; heartbeat_at: string | null } | null;
    return r ? { pid: r.pid, procStart: r.proc_start, heartbeatAt: r.heartbeat_at } : null;
  }

  /**
   * Take the tick singleton for `id` (default: this process): true when no other live tick holds it. `alive`
   * decides whether a recorded holder still runs (core/proc.ts recordAlive by default; tests inject one).
   */
  claimTick(alive: (h: { pid: number; procStart: string | null }) => boolean, id: ProcessIdentity = currentIdentity()): boolean {
    return this.transaction(() => {
      const cur = this.getTick();
      if (cur?.pid && cur.pid !== id.pid && alive({ pid: cur.pid, procStart: cur.procStart })) return false;
      this.sqlite.query(`INSERT INTO tick (id, pid, proc_start, heartbeat_at) VALUES (1, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET pid = excluded.pid, proc_start = excluded.proc_start`)
        .run(id.pid, id.procStart, cur?.heartbeatAt ?? null);
      return true;
    });
  }

  /** Release the singleton if `pid` holds it; the heartbeat stays. */
  releaseTick(pid: number = process.pid): void {
    this.sqlite.query("UPDATE tick SET pid = NULL, proc_start = NULL WHERE id = 1 AND pid = ?").run(pid);
  }

  /** Record a heartbeat (ISO-8601 UTC; default now). */
  heartbeat(at: string = this.nowIso()): void {
    this.sqlite.query(`INSERT INTO tick (id, heartbeat_at) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at`).run(at);
  }

  // ---- settings (per project) ----

  /** A setting's JSON value, or null when unset. */
  getSetting<T = unknown>(key: string): T | null {
    const row = this.sqlite.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string | null } | null;
    return row ? (parseJson(row.value) as T) : null;
  }

  setSetting(key: string, value: unknown): void {
    this.sqlite.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }

  /** Scheduling for this project (§8): off until `croft schedule on`. A pause whose pausedUntil has passed reads
   *  as on. */
  getScheduling(): SchedulingSetting {
    const v = this.getSetting<SchedulingSetting>("scheduling");
    if (!v || (v.state !== "on" && v.state !== "off" && v.state !== "paused")) return { state: "off", via: null };
    const via = v.via === "os-job" || v.via === "serve" ? v.via : null;
    if (v.state === "paused" && typeof v.pausedUntil === "string" && Date.parse(v.pausedUntil) <= this.now().getTime()) {
      return { state: "on", via };
    }
    return v.state === "paused" ? { state: "paused", via, pausedUntil: v.pausedUntil ?? null } : { state: v.state, via };
  }

  setScheduling(s: SchedulingSetting): void {
    this.setSetting("scheduling", s);
  }

  // ---- catalog mirror of _croft.* (DuckDB wins on disagreement) ----

  catalogGet<T = unknown>(asset: string): CatalogEntry<T> | null {
    const row = this.sqlite.query("SELECT asset, json, source, refreshed_at FROM catalog WHERE asset = ?").get(asset) as
      { asset: string; json: string; source: string; refreshed_at: string } | null;
    if (!row) return null;
    return { asset: row.asset, value: parseJson(row.json) as T, source: row.source as CatalogSource, refreshedAt: row.refreshed_at };
  }

  catalogPut(asset: string, value: unknown, source: CatalogSource): void {
    this.sqlite
      .query(`INSERT INTO catalog (asset, json, source, refreshed_at) VALUES (?, ?, ?, ?)
              ON CONFLICT (asset) DO UPDATE SET json = excluded.json, source = excluded.source,
                refreshed_at = excluded.refreshed_at`)
      .run(asset, JSON.stringify(value), source, this.nowIso());
  }

  catalogAll<T = unknown>(): CatalogEntry<T>[] {
    const rows = this.sqlite.query("SELECT asset, json, source, refreshed_at FROM catalog ORDER BY asset").all() as
      { asset: string; json: string; source: string; refreshed_at: string }[];
    return rows.map((r) => ({ asset: r.asset, value: parseJson(r.json) as T, source: r.source as CatalogSource, refreshedAt: r.refreshed_at }));
  }

  catalogDelete(asset: string): boolean {
    return this.sqlite.query("DELETE FROM catalog WHERE asset = ?").run(asset).changes === 1;
  }
}
