// .croft/runs.sqlite: observability and coordination state (DESIGN.md §5 "Where state lives").
// bun:sqlite in WAL mode stays readable while DuckDB is locked and while another process writes,
// so `status` and `logs` never wait. Data-coupled state lives in DuckDB's _croft schema instead.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomInt } from "node:crypto";
import { CroftError } from "../core/errors.ts";
import { currentIdentity, type ProcessIdentity } from "../core/proc.ts";
import type { LockHolder, Problem } from "../core/types.ts";

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
export interface CatalogEntry<T = unknown> { asset: string; value: T; source: CatalogSource; refreshedAt: string }
export interface RunsDbOptions { now?: () => Date }

interface RunRow { id: string; trigger: string; human: number; argv: string | null; pid: number | null;
  proc_start: string | null; boot_id: string | null; started_at: string; finished_at: string | null;
  status: string; summary: string | null }
interface StepRow { run_id: string; asset: string; attempt: number; status: string; reason: string | null;
  started_at: string; finished_at: string | null; rows_in: number | null; added: number | null;
  updated: number | null; error: string | null; code_hash: string | null; log_path: string | null }

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

  /** running → crashed. Returns false when the run was not running. */
  markCrashed(id: string): boolean {
    const res = this.sqlite
      .query("UPDATE runs SET status = 'crashed', finished_at = ? WHERE id = ? AND status = 'running'")
      .run(this.nowIso(), id);
    return res.changes === 1;
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
    const res = this.sqlite
      .query(`UPDATE steps SET status = ?, reason = coalesce(?, reason), finished_at = ?, rows_in = ?, added = ?,
                updated = ?, error = ?
              WHERE run_id = ? AND asset = ? AND attempt = ? AND status = 'running'`)
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

  /** Steps still marked running whose run has ended: what reconcile has left to resolve. */
  danglingSteps(): StepRecord[] {
    return (this.sqlite
      .query(`SELECT s.* FROM steps s JOIN runs r ON r.id = s.run_id
              WHERE s.status = 'running' AND r.status <> 'running' ORDER BY s.started_at`)
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
