// Leases on the warehouse file (DESIGN.md §5 "Owning the DuckDB file", "Leases", "Server mode").
//
// - The file is open only while DuckDB works: read()/write() open it on demand and close it 100 ms after
//   the last lease. Every connection is disconnected before closeSync(), because DuckDB keeps the OS lock
//   while any connection of the instance is open.
// - One access mode per process and path (connect.ts enforces it); instances only via fromCache.
// - Read-write opens announce a write intent first and remove it only after closeSync() returned. A process's first
//   read-write open backs the file up first when its DuckDB is newer than the one recorded (db/backup.ts).
// - Lock conflicts are retried with jittered backoff (25 ms doubling to 1 s) and end in DB_BUSY (a croft
//   holder) or DB_HELD_BY_OTHER_PROGRAM, naming the holder from DuckDB's lock error.
// - write() wraps BEGIN/COMMIT/ROLLBACK; every statement goes through prepare(), one per call, and the
//   transaction's TxGuard throws DDL_AFTER_DML at an ALTER that follows DML on the same table.
// - An optional AbortSignal ends a wait at once (Ctrl-C during a lock wait of up to 10 min): the lock wait,
//   and a write queued behind another write of this process. It never cuts a lease that already holds the
//   file; the body decides what an abort means there (run/ingest.ts refuses further statements).
//
// A warehouse that is a lake (WarehouseOptions.lake; option 07, D138 to D144) is the same object with another store under it. There is no
// file: the instance is an in-memory one that attaches the lake when its first connection is made and is then locked, and it stays open
// for the life of the command (a re-attach after the lock is refused), so nothing lingers and nothing is closed after a lease. Every
// connection works in the lake (`USE lake`), so the tables, the views and `current_database()` read as they do in a file, and a read lease is
// one transaction (the catalog charges round trips for each, D-T2). There is no
// file lock and no write intent; the lock on writes is croft's own (db/lake.ts LakeWriteLock), one write at a time on this machine, and
// croft serve never steps aside. A read whose catalog connection dropped is tried again; a write is tried again as a whole, after its
// commit is checked by the tag it carries (a commit may have landed without its answer reaching us); every error that leaves a lease has
// the lake's credentials taken out of it.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { type DuckDBConnection, type DuckDBInstance, type DuckDBResultReader, type DuckDBValue, StatementType,
  blobValue, listValue, version as duckdbVersion } from "@duckdb/node-api";
import { CroftError } from "../core/errors.ts";
import type { LockHolder, Sql, Warehouse } from "../core/types.ts";
import type { Row } from "../types.ts";
import { type AccessMode, canonicalPath, connect, type LockConflict, lockConflict, openInstance, openMemoryInstance, type SandboxSpec, startFailure } from "./connect.ts";
import { bookkeepingOf, seqResetSql } from "./bookkeeping.ts";
import * as intents from "./intent.ts";
import {
  isCommitFailure, isConflict, isConnectionError, LAKE_RETRY, type LakeConnection, lakeBackoffMs, landedTag, LakeWriteLock, newCommitTag, TX_VARIABLE, WRITER_PREFIX, writerKey, writerRecord,
} from "./lake.ts";
import { LAKE_ALIAS, modeSecrets, scrub, scrubThrown } from "./modes.ts";
import { storeTlsError } from "./store-tls.ts";
import { now as clockNow } from "../core/time.ts";
import { checkFormat, ensureState, hasState } from "./state.ts";
import { TxGuard } from "./tx-guard.ts";
import { type ColumnInfo, type RenderContext, type RenderMode, renderRows, resultColumns } from "./values.ts";

export interface WaitPolicy {
  offTtyMs: number;   // every wait off a TTY, so a wait never outlives an agent's shell (90 s)
  ttyReadMs: number;  // query/preview/describe on a TTY (60 s)
  ttyWriteMs: number; // run writes on a TTY (10 min)
}
export const DEFAULT_WAITS: WaitPolicy = { offTtyMs: 90_000, ttyReadMs: 60_000, ttyWriteMs: 600_000 };

export interface WarehouseOptions {
  path: string;                          // warehouse.duckdb (or .croft/preview.duckdb)
  mode: AccessMode;                      // the process's mode for this file, for its whole life
  profile?: "warehouse" | "query" | "serve"; // sandbox profile (connect.ts); default "warehouse"
  timezone: string;
  root: string;                          // project root
  stateDir: string;                      // .croft (or relocated): intents, serve.json
  fileDirs?: string[];                   // declared file-ingest directories
  memoryLimit?: string;
  threads?: number;
  writeIntent?: boolean;                 // default true in read_write mode (false only for preview.duckdb)
  runId?: string;                        // recorded in the write intent
  render?: RenderMode;                   // how Sql.all renders values; default "ts"
  lingerMs?: number;                     // default 100
  waits?: Partial<WaitPolicy>;
  isTTY?: boolean;                       // default: stdin and stdout are both TTYs
  noticeAfterMs?: number;                // when onWait fires; default 2000
  foreignWithdrawMs?: number;            // withdraw the intent after a foreign holder blocked this long (2000)
  foreignReannounceMs?: number;          // then announce it again after this long (5000)
  onWait?: (holder: LockHolder, waitedMs: number) => void;
  /** Describe a PID that holds the file (runs.sqlite: run id, asset, since). null when unknown. */
  lookupHolder?: (pid: number) => Partial<LockHolder> | null | Promise<Partial<LockHolder> | null>;
  register?: boolean;                    // set globalThis[Symbol.for("croft.warehouse")]; default true
  /** How messages name the file: "the warehouse" (default), or "the preview database" for preview.duckdb. */
  label?: string;
  /** The DuckDB engine this process runs, for the pre-upgrade backup (db/backup.ts); default version(). Tests inject it. */
  engineVersion?: string;
  /** The project's lake (db/lake.ts lakeConnection): the warehouse is a DuckLake, and `path` only names it (nothing is opened there).
   *  `mode: "read_write"` attaches with the writer's login and key, `"read_only"` with the read-only ones, read-only. */
  lake?: LakeConnection;
  /** Tests only: runs right after a lake write's COMMIT returned, and may throw what a connection that dropped at that moment would
   *  (the commit landed and its answer did not), which is the one case of an unknown outcome a test cannot otherwise make happen. */
  afterLakeCommit?: () => void | Promise<void>;
  /** Tests only: runs in a lake write just before the commit is tagged and issued, and may throw what a connection that dropped at that
   *  moment would (the commit did not land, and the step does not know), or do what another writer's commit that lands late would. */
  beforeLakeCommit?: (a: { attempt: number; tag: string }) => void | Promise<void>;
}

export interface WriteOptions {
  waitMs?: number;
  runId: string;
  asset?: string;
  transaction?: boolean;
  /** A write that does not write the lake (`transaction: false` bodies that write a trash file, with the lake only read): no commit tag,
   *  no record of the writer, no second try. Default true; a file warehouse ignores it. */
  touchesLake?: boolean;
  /** Tests only: the tag the lake commit carries, in place of a fresh one. */
  commitTag?: string;
  /** Ends the wait for the file (and for this process's earlier writes) at once: the signal's CroftError
   *  reason (a run's INTERRUPTED or TIMEOUT), else INTERRUPTED. */
  signal?: AbortSignal;
}
export interface ReadOptions {
  waitMs?: number;
  purpose: string;
  signal?: AbortSignal;
  /** A lake only: the lease asks no more of the lake than that it can be attached (db/lake-pass.ts lakeExists). No transaction, no `USE`, no check
   *  of the format, and the body must not query the lake: the three cost the catalog 3 s at 41 ms, for an answer the attach already gave. */
  attachOnly?: boolean;
}

/** A wait that ends early, without error, when the signal aborts; the caller checks the signal next. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Errors thrown because a lease's own signal ended its wait for the file (see ensureOpen). */
const abortedWaits = new WeakSet<object>();

/** What an aborted wait throws: the signal's reason when it is a CroftError, else INTERRUPTED. */
export function waitAborted(signal: AbortSignal, what = "waiting for the warehouse"): CroftError {
  const r = signal.reason as { name?: unknown; problem?: unknown } | undefined;
  const err = r instanceof CroftError ? r : r && r.name === "CroftError" && r.problem ? (r as CroftError)
    : new CroftError("INTERRUPTED", { message: `interrupted while ${what}`, hint: "nothing was written; run it again" });
  abortedWaits.add(err);
  return err;
}

/** Jittered exponential backoff: 25 ms doubling to 1 s, each delay drawn from [half, full]. */
export function backoffMs(attempt: number): number {
  const base = Math.min(1000, 25 * 2 ** Math.min(attempt, 6));
  return Math.round(base / 2 + Math.random() * (base / 2));
}

// JSON.rawJSON (Bun, Node 21+) writes bigints as exact digits; TypeScript's lib does not declare it yet.
const rawJSON = (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON;

/** JS parameter → DuckDB value. Plain objects bind as JSON text, Dates as ISO instants. */
function toDuck(v: unknown): DuckDBValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") return v;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return blobValue(v);
  if (Array.isArray(v)) return listValue(v.map(toDuck));
  if (typeof v === "object" && v.constructor !== Object) return v as DuckDBValue; // DuckDB value classes
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? rawJSON(x.toString()) : x));
}

/**
 * The Sql handed to lease callbacks. Every statement goes through prepare(), which accepts exactly one
 * statement, so a value concatenated into SQL can never smuggle in a second one.
 */
export class LeaseSql implements Sql {
  /** The first statement DuckDB refused inside a write's transaction. On DuckDB 2.0 any refusal, a failed prepare
   *  included, aborts the transaction, and a COMMIT after it ends the transaction without writing anything and
   *  without an error [V]; write() refuses to commit then. */
  failed: Error | null = null;
  /** A lake write whose body begins and commits its own transactions (`transaction: false`): what croft does as it begins one (forget the
   *  log numbers of an earlier one) and just before it commits (tag the commit, record the machine). */
  hooks: { begin?: () => Promise<void>; commit?: () => Promise<void> } | null = null;
  /** The statements of a lake warehouse: croft never runs CHECKPOINT on a lake, sets one of its options or expires its snapshots by age (D149). */
  lake = false;
  /** A lake read is one transaction (DuckLake charges the catalog's round trips for each one, D-T2), and a statement DuckDB refuses aborts it: this
   *  starts another, so a body that goes on after a refused statement (a table that is not there, a query the user got wrong) is as it was when
   *  every statement was a transaction of its own. Not called for a connection that dropped: the lease retries the whole body. */
  recover: (() => Promise<void>) | null = null;

  constructor(readonly connection: DuckDBConnection, private readonly ctx: RenderContext, private readonly guard: TxGuard | null) {}

  private async mended(e: unknown): Promise<void> {
    if (this.recover && !isConnectionError(e)) await this.recover();
  }

  async all<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return renderRows((await this.run(sql, params, true))!, this.ctx) as T[];
  }

  async exec(sql: string, params: unknown[] = []): Promise<void> {
    await this.run(sql, params, false);
  }

  /** Rows plus column names and types (for `croft query`), rendered in `mode` (default: the lease's). */
  async query(sql: string, params: unknown[] = [], mode?: RenderMode): Promise<{ columns: ColumnInfo[]; rows: Row[] }> {
    const reader = (await this.run(sql, params, true))!;
    return { columns: resultColumns(reader), rows: renderRows(reader, mode ? { ...this.ctx, mode } : this.ctx) };
  }

  /** Tables this transaction has written so far (write leases only). */
  touched(): string[] {
    return this.guard?.tables() ?? [];
  }

  private async run(sql: string, params: unknown[], read: boolean): Promise<DuckDBResultReader | undefined> {
    let stmt;
    try {
      stmt = await this.connection.prepare(sql);
    } catch (e) {
      if (this.guard) this.failed ??= e as Error;
      await this.mended(e);
      if (/Cannot prepare multiple statements/.test((e as Error).message)) {
        throw new CroftError("SQL_NOT_ONE_STATEMENT", { message: "croft runs one SQL statement per call", hint: "report this croft bug", details: { sql: sql.slice(0, 200) } });
      }
      throw e;
    }
    try {
      const type = stmt.statementType;
      if (this.guard && type === StatementType.TRANSACTION) {
        throw new CroftError("INTERNAL_ERROR", { message: "write() owns the transaction; do not BEGIN, COMMIT or ROLLBACK inside it", hint: "report this croft bug" });
      }
      this.guard?.check(type, sql);
      if (this.lake) refuseOnLake(sql);
      const word = this.hooks && type === StatementType.TRANSACTION ? /^\s*(\w+)/.exec(sql)?.[1]?.toUpperCase() : undefined;
      if (word === "COMMIT") await this.hooks!.commit?.();
      let out: DuckDBResultReader | undefined;
      try {
        if (params.length) stmt.bind(params.map(toDuck));
        out = read ? await stmt.runAndReadAll() : (await stmt.run(), undefined);
        if (word === "BEGIN") await this.hooks!.begin?.();
      } catch (e) {
        if (this.guard) this.failed ??= e as Error;
        await this.mended(e);
        throw e;
      }
      this.guard?.record(type, sql);
      return out;
    } finally {
      stmt.destroySync();
    }
  }
}

/**
 * What croft never runs on a lake (DESIGN.md D149). CHECKPOINT runs all of DuckLake's maintenance from the lake's stored options, so an
 * age-based expiry set by anyone expires a snapshot the trash pinned; an option set by croft would be one; an expiry that is not by an
 * explicit list of versions is by age. croft runs each maintenance step itself (db/lake-maintenance.ts), and this keeps every other
 * path of croft from issuing any of the three, whatever its caller thought it was doing.
 */
const NEVER_ON_A_LAKE = /^\s*(?:FORCE\s+)?CHECKPOINT\b|\bset_option\s*\(|ducklake_expire_snapshots\s*\((?![^)]*\bversions\s*=>)/i;
export function refuseOnLake(sql: string): void {
  if (NEVER_ON_A_LAKE.test(sql)) {
    throw new CroftError("INTERNAL_ERROR", {
      message: "croft does not run CHECKPOINT on a lake, set an option of it, or expire its snapshots by age",
      hint: "report this croft bug: it would let DuckLake expire versions the trash promises to keep",
      details: { sql: sql.slice(0, 120) },
    });
  }
}

/** `known`: whether the holder was identified at all. A process whose command line could not be read (ps failing on
 *  a loaded machine) is not known to be foreign, so the write intent is never withdrawn on that guess. */
interface Described { holder: LockHolder; croft: boolean; known: boolean }

/** `p`, or a rejection as soon as `signal` aborts (p keeps running; its outcome is then ignored). */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(waitAborted(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(waitAborted(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// One warehouse per canonical path per process.
const byPath = new Map<string, DuckWarehouse>();
const GLOBAL_KEY = Symbol.for("croft.warehouse");
const GLOBAL_ALL = Symbol.for("croft.warehouses");

export class DuckWarehouse implements Warehouse {
  readonly path: string;
  readonly mode: AccessMode;
  private readonly o: WarehouseOptions;
  /** The sandbox every connection gets. A lake's has its mode too, which holds credentials and is made when the instance opens. */
  private spec: SandboxSpec;
  private readonly stateDir: string;
  /** Lake mode: the project's lake, the lock on its writes, and the key the connection factory knows this instance by. */
  private readonly lake: LakeConnection | null;
  private readonly writeLock: LakeWriteLock | null;
  private readonly key: string;
  private instance: DuckDBInstance | null = null;
  private opening: Promise<DuckDBInstance> | null = null;
  private leases = 0;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly conns = new Set<DuckDBConnection>();
  private writeChain: Promise<unknown> = Promise.resolve();
  private intentHeld = false;
  private waitingOn: LockHolder | null = null;
  private idle: (() => void)[] = [];
  private formatChecked = false;
  private engineChecked = false;

  constructor(o: WarehouseOptions) {
    this.o = o;
    this.path = canonicalPath(o.path);
    this.mode = o.mode;
    this.stateDir = canonicalPath(o.stateDir);
    this.spec = {
      profile: o.profile ?? "warehouse", timezone: o.timezone, root: o.root, stateDir: this.stateDir,
      fileDirs: o.fileDirs, memoryLimit: o.memoryLimit, threads: o.threads,
    };
    this.lake = o.lake ?? null;
    this.writeLock = this.lake ? new LakeWriteLock(this.stateDir) : null;
    this.key = this.lake ? `lake:${this.path}` : this.path;
  }

  /** The Sql over a connection of this warehouse; a lake's refuses what croft never runs on one (refuseOnLake). */
  private sqlOver(conn: DuckDBConnection, guard: TxGuard | null, wholeRead = false): LeaseSql {
    const sql = new LeaseSql(conn, this.renderCtx(), guard);
    sql.lake = this.lake !== null;
    if (wholeRead && this.lake) sql.recover = () => this.restartRead(conn);
    return sql;
  }

  /** A lake read's transaction was aborted by a statement DuckDB refused: end it and begin another (the default catalog survives a rollback). */
  private async restartRead(conn: DuckDBConnection): Promise<void> {
    try {
      await conn.run("ROLLBACK");
      await conn.run("BEGIN TRANSACTION");
    } catch {
      // The next statement says what is wrong with the connection.
    }
  }

  /** Whether this warehouse is a lake. */
  get isLake(): boolean {
    return this.lake !== null;
  }

  /** The options this warehouse was created with. */
  get options(): Readonly<WarehouseOptions> {
    return this.o;
  }

  /** True while the instance is open (or opening). */
  get isOpen(): boolean {
    return this.instance !== null || this.opening !== null;
  }

  read<T>(fn: (db: LeaseSql) => Promise<T>, o?: ReadOptions): Promise<T> {
    return this.lease("read", o?.waitMs, (conn) => fn(this.sqlOver(conn, null, o?.attachOnly !== true)), undefined, o?.signal, o?.attachOnly === true);
  }

  write<T>(label: string, fn: (tx: LeaseSql) => Promise<T>, o?: WriteOptions): Promise<T> {
    if (this.mode !== "read_write") {
      return Promise.reject(new CroftError("INTERNAL_ERROR", { message: `write "${label}" in a read-only process`, hint: "report this croft bug" }));
    }
    // In-process write mutex: one write step at a time, in arrival order.
    const signal = o?.signal;
    let started = false;
    const run = async () => {
      started = true;
      return this.lease("write", o?.waitMs, async (conn) => {
        if (this.lake) return this.lakeWrite(conn, label, fn, o);
        if (o?.transaction === false) return fn(this.sqlOver(conn, null));
        // DuckDB names a file database after its stem, so `warehouse.t` means main.t in warehouse.duckdb.
        const tx = new LeaseSql(conn, this.renderCtx(), new TxGuard({ database: basename(this.path, extname(this.path)) }));
        await conn.run("BEGIN TRANSACTION");
        try {
          const result = await fn(tx);
          if (tx.failed) {
            // The body went on after a statement DuckDB refused: the transaction is aborted, and COMMIT would
            // silently write nothing.
            throw new CroftError("INTERNAL_ERROR", {
              message: `write "${label}" went on after a statement failed (${tx.failed.message.split("\n")[0]}); nothing was committed`,
              hint: "report this croft bug",
            });
          }
          await conn.run("COMMIT");
          return result;
        } catch (e) {
          try {
            await conn.run("ROLLBACK");
          } catch {} // already rolled back by a failed COMMIT
          throw e;
        }
      }, o?.runId, signal);
    };
    const next = this.writeChain.then(run, run);
    this.writeChain = next.catch(() => {});
    if (!signal) return next;
    // Queued behind another write: an abort ends the wait now, and the queued lease then refuses to start.
    // Once it has started, the lease itself (lock wait) or its body decides.
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        if (!started) reject(waitAborted(signal, `waiting for another write of this process (${label})`));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      next.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  /**
   * Who holds the file. While this process waits, the holder from the last lock error; otherwise a live
   * write intent of another process; otherwise, in read-only mode, a no-wait probe.
   */
  async holder(): Promise<LockHolder | null> {
    if (this.waitingOn) return this.waitingOn;
    // A lake has no file for a reader to be kept out of: the only holder is the machine's writer, by croft's own lock.
    if (this.lake) {
      const h = this.writeLock!.holder();
      if (!h) return null;
      const extra = h.pid !== null && this.o.lookupHolder ? await this.o.lookupHolder(h.pid) : null;
      return extra ? { ...h, ...extra } : h;
    }
    if (this.instance) return { pid: process.pid, program: "croft (this process)" };
    const other = intents.liveIntents(this.stateDir, { excludeSelf: true })[0];
    if (other) return { pid: other.pid, program: "croft", runId: other.runId ?? undefined, action: "write", since: other.since };
    if (this.mode === "read_only") {
      try {
        await this.read(async () => {}, { waitMs: 0, purpose: "holder probe" });
      } catch (e) {
        if (e instanceof CroftError && (e.code === "DB_BUSY" || e.code === "DB_HELD_BY_OTHER_PROGRAM")) {
          return (e.problem.details?.holder as LockHolder) ?? null;
        }
        throw e;
      }
    }
    return null;
  }

  /** Close as soon as no lease is active (waits for running leases). */
  async close(): Promise<void> {
    if (this.leases > 0) await new Promise<void>((r) => this.idle.push(r));
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    if (this.opening) await this.opening.catch(() => {});
    this.closeNow();
  }

  /** How messages name the file (WarehouseOptions.label). */
  private get label(): string {
    return this.o.label ?? (this.lake ? "the lake" : "the warehouse");
  }

  private renderCtx(): RenderContext {
    return { mode: this.o.render ?? "ts", timezone: this.o.timezone };
  }

  private waitCap(kind: "read" | "write"): number {
    const w = { ...DEFAULT_WAITS, ...this.o.waits };
    const tty = this.o.isTTY ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
    if (!tty) return w.offTtyMs;
    return kind === "write" ? w.ttyWriteMs : w.ttyReadMs;
  }

  private async lease<T>(kind: "read" | "write", waitMs: number | undefined, body: (conn: DuckDBConnection) => Promise<T>,
    runId?: string, signal?: AbortSignal, attachOnly = false): Promise<T> {
    if (signal?.aborted) throw waitAborted(signal);
    this.leases++;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    let conn: DuckDBConnection | undefined;
    try {
      const instance = await this.ensureOpen(kind, waitMs ?? this.waitCap(kind), runId, signal);
      if (this.lake) return await this.inLake(kind, instance, body, signal, (c) => { conn = c; }, attachOnly);
      conn = await connect(instance, this.spec, this.key);
      this.conns.add(conn);
      if (!this.formatChecked) {
        // Refuse a database from a newer croft before touching it (DB_NEWER_FORMAT); once per process.
        await checkFormat(new LeaseSql(conn, this.renderCtx(), null));
        this.formatChecked = true;
      }
      return await body(conn);
    } finally {
      if (conn) {
        this.conns.delete(conn);
        conn.disconnectSync();
      }
      if (--this.leases === 0) this.scheduleClose();
    }
  }

  /**
   * The open instance, opening it if needed. One open runs at a time: the lease that starts it waits with
   * its own signal; others wait for that open, each giving up at once when its own signal aborts. When the
   * opener's signal ended the shared open, a lease whose signal did not abort starts a new one.
   */
  private async ensureOpen(kind: "read" | "write", waitMs: number, runId?: string, signal?: AbortSignal): Promise<DuckDBInstance> {
    for (;;) {
      if (signal?.aborted) throw waitAborted(signal);
      if (this.instance) return this.instance;
      if (!this.opening) {
        this.opening = this.open(kind, waitMs, runId, signal).finally(() => (this.opening = null));
        return this.opening;
      }
      try {
        return await (signal ? untilAborted(this.opening, signal) : this.opening);
      } catch (e) {
        if (e && typeof e === "object" && abortedWaits.has(e) && !signal?.aborted) continue;
        throw e;
      }
    }
  }

  private get usesIntent(): boolean {
    return this.mode === "read_write" && this.o.writeIntent !== false && !this.lake;
  }

  /**
   * A lake's instance: an in-memory DuckDB that attaches the lake on its first connection (db/connect.ts, db/modes.ts) with the login and
   * key for this process's access, and is then locked. It has no file to lock, so there is no write intent, no wait and no pre-upgrade
   * backup. The mode, which holds the credentials, is made here, so a missing secret is SECRET_MISSING before anything is attached.
   */
  private async openLake(): Promise<DuckDBInstance> {
    this.spec = { ...this.spec, mode: this.lake!.mode(this.mode === "read_write" ? "write" : "read") };
    const instance = await openMemoryInstance();
    this.instance = instance;
    registerExitHook();
    return instance;
  }

  /** Close an instance whose mode failed to start: it is part set up and never reused, so the next lease opens a new one. */
  private dropInstance(instance: DuckDBInstance): void {
    if (this.instance !== instance) return;
    for (const c of this.conns) {
      try { c.disconnectSync(); } catch { /* gone */ }
    }
    this.conns.clear();
    try { instance.closeSync(); } catch { /* gone */ }
    this.instance = null;
    this.formatChecked = false;
  }

  /** The lake's error with its credentials taken out: the password, the key id and secret and the session token. */
  private scrub(e: unknown): unknown {
    const clean = this.spec.mode ? scrubThrown(e, modeSecrets(this.spec.mode)) : e;
    // The check of the store's certificate failing is one code wherever a command meets it (D160), not whatever the command makes of an
    // unknown error (INTERNAL_ERROR, QUERY_FAILED).
    if (this.lake && !(clean instanceof CroftError)) {
      const m = this.spec.mode;
      const caFile = m?.kind === "lake" || m?.kind === "lake-readers" ? m.lake.data.caFile : undefined;
      return storeTlsError(clean, { ...(caFile ? { caFile } : {}) }) ?? clean;
    }
    return clean;
  }

  /** Text (a step's error that a body caught and reports itself) with the lake's credentials taken out. */
  redact(text: string): string {
    return this.spec.mode ? scrub(text, modeSecrets(this.spec.mode)) : text;
  }

  /**
   * A lease on the lake: a connection (the first one attaches the lake, retried when the catalog was unreachable for a moment), working in
   * the lake, and the body. A read whose catalog or store connection dropped is tried again; a write does its own retrying
   * (lakeWrite), because it must check its commit first. Every error that leaves is scrubbed.
   *
   * A read is one transaction from `USE lake` to the end of its body (D-T2). Every statement outside a transaction is a DuckLake
   * transaction of its own, and each of those costs the catalog's round trips (a snapshot lookup, and for each table the files, the stats and
   * the inlined rows: 9 to 26 of them, 0.4 to 1.1 s at the 41 ms the second real-lake trial measured), so the 11 statements croft ran to
   * read the state of one asset cost 6 s; in one transaction the snapshot and what DuckLake learned of a table are paid once. Nothing in a
   * read changes the lake, so the transaction is rolled back at the end, which costs nothing; and a statement DuckDB refuses (which aborts a
   * transaction) is followed by a new one (LeaseSql.recover), so a body may go on after a failed statement as it could before.
   */
  private async inLake<T>(kind: "read" | "write", first: DuckDBInstance, body: (conn: DuckDBConnection) => Promise<T>, signal: AbortSignal | undefined,
    give: (conn: DuckDBConnection) => void, attachOnly = false): Promise<T> {
    let instance = first;
    let conn: DuckDBConnection | undefined;
    for (let attempt = 0; !conn; attempt++) {
      try {
        conn = await connect(instance, this.spec, this.key);
      } catch (raised) {
        // A lease that shared the instance with one whose attach failed is refused by the instance ("left part set up"), and that is not what
        // went wrong: what stopped the attach is, and it is the same attach.
        const e = startFailure(instance) ?? raised;
        this.dropInstance(instance);
        const details = e instanceof CroftError && e.code === "LAKE_ATTACH_FAILED" ? e.problem.details : undefined;
        if (details?.notCreated) {
          throw new CroftError("DB_NOT_FOUND", {
            message: `${this.label} does not exist yet: nothing has written to it`,
            hint: "the machine that writes creates the lake with its first run: croft run",
            fix: { kind: "command", description: "build the assets, which creates the lake", command: "croft run" },
            details: { database: this.lake!.label, notCreated: true },
          });
        }
        if (details && typeof details.duckdb === "string" && isConnectionError(details.duckdb) && attempt < LAKE_RETRY.connection) {
          await sleep(lakeBackoffMs(attempt));
          if (signal?.aborted) throw waitAborted(signal);
          // The instance another lease opened since, or a new one (one open at a time).
          instance = await this.ensureOpen(kind, 0, undefined, signal);
          continue;
        }
        throw this.scrub(e);
      }
    }
    give(conn);
    this.conns.add(conn);
    if (attachOnly) return await body(conn);
    const whole = kind === "read";
    const endRead = async () => {
      try { await conn!.run("ROLLBACK"); } catch { /* none open, or the connection is gone */ }
    };
    let used = false;
    for (let attempt = 0; ; attempt++) {
      try {
        if (whole) await conn.run("BEGIN TRANSACTION");
        if (whole || !used) {
          await conn.run(`USE ${LAKE_ALIAS}`);
          used = true;
        }
        if (!this.formatChecked) {
          // Refuse a lake from a newer croft before touching it (DB_NEWER_FORMAT); once per process.
          await checkFormat(this.sqlOver(conn, null));
          this.formatChecked = true;
        }
        const out = await body(conn);
        if (whole) await endRead();
        return out;
      } catch (e) {
        if (whole) await endRead();
        if (kind === "read" && isConnectionError(e)) {
          if (attempt < LAKE_RETRY.connection) {
            await sleep(lakeBackoffMs(attempt));
            continue;
          }
          throw this.scrub(this.lost(e));
        }
        throw this.scrub(e);
      }
    }
  }

  /** The catalog or the store could not be reached, however it was tried. */
  private lost(e: unknown): CroftError {
    return new CroftError("LAKE_CONNECTION_LOST", {
      message: `croft lost its connection to the lake (${this.lake!.label}) and could not get it back: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 300)}`,
      hint: "check that the catalog and the bucket are up and reachable from this machine, then run the command again; nothing partial was written",
      retryable: true,
      details: { database: this.lake!.label },
    });
  }

  /**
   * One write step on the lake: croft's lock first (one write at a time on this machine), then the body in a transaction, tagged with a
   * token the snapshot it commits carries. When the connection to the catalog dropped, or the commit's outcome is not known, the tags of
   * the attempts that reached their commit say whether one of them landed: if it did, the write is done and its result is returned; if not,
   * the whole step is run again, once for a dropped connection and a few times for a conflict, in a new transaction. Before every retry
   * all the earlier attempts' tags are asked about, not only the last one's, since an attempt's commit that was in flight can land after
   * a later attempt began (that attempt then conflicts with it, on the machine's record every write updates, and the retry finds the
   * first one landed). A step is never run again after a commit of it landed.
   *
   * A body that begins and commits its own transactions (`transaction: false`: delete and restore) goes through the same: croft's hooks
   * on its BEGIN and COMMIT forget the log numbers and tag and record the commit. Such a body has no result to return for a commit that
   * landed without its answer, so that is said as LAKE_COMMIT_UNCERTAIN (landed: true) and not retried.
   */
  private async lakeWrite<T>(conn: DuckDBConnection, label: string, fn: (tx: LeaseSql) => Promise<T>, o: WriteOptions | undefined): Promise<T> {
    const release = await this.writeLock!.acquire({
      waitMs: o?.waitMs ?? this.waitCap("write"), runId: o?.runId ?? null, ...(o?.asset ? { asset: o.asset } : {}), label, ...(o?.signal ? { signal: o.signal } : {}),
      noticeAfterMs: this.o.noticeAfterMs ?? 2000, onWait: (h, ms) => this.o.onWait?.(h, ms),
      busy: (h, waited) => this.busyError(h ?? { pid: null, program: "croft" }, true, waited, "write"),
      aborted: () => waitAborted(o!.signal!),
    });
    try {
      const own = o?.transaction === false;
      if (own && o?.touchesLake === false) return await fn(this.sqlOver(conn, null));
      const tagged = (tag: string) => `CALL ${LAKE_ALIAS}.set_commit_message('croft', '${tag}')`;
      const reset = async (tag: string) => {
        for (const stmt of seqResetSql()) await conn.run(stmt);
        await conn.run(`SET VARIABLE ${TX_VARIABLE} = '${tag}'`); // this transaction's name, for what may happen once in it
      };
      /** The attempts whose commit may yet land, with what their body returned. */
      const maybe: { tag: string; result: T | undefined }[] = [];
      const uncertain = (message: string, extra: Record<string, unknown> = {}) => new CroftError("LAKE_COMMIT_UNCERTAIN", {
        message,
        hint: "check the lake before running again: croft status shows what the last run wrote; a run that did not land is safe to run again",
        retryable: true,
        details: { database: this.lake!.label, step: label, ...extra },
      });
      for (let attempt = 0; ; attempt++) {
        const tag = o?.commitTag ?? newCommitTag();
        const tx = this.sqlOver(conn, own ? null : new TxGuard({ database: LAKE_ALIAS }));
        let result: T | undefined;
        let ran = false;
        /** Just before the commit: this machine's record, the tag. */
        const beforeCommit = async () => {
          ran = true;
          await this.recordWriter(tx, o?.runId);
          await this.o.beforeLakeCommit?.({ attempt, tag });
          await conn.run(tagged(tag));
        };
        if (own) tx.hooks = { begin: () => reset(tag), commit: beforeCommit };
        try {
          if (!own) {
            await conn.run("BEGIN TRANSACTION");
            // The numbers the log adapter kept (D145) are this transaction's: forget those of an earlier one, or of a rolled-back one.
            await reset(tag);
          }
          result = await fn(tx);
          if (!own) {
            if (tx.failed) {
              // The body went on after a statement DuckDB refused: the transaction is aborted, and COMMIT would silently write nothing.
              throw new CroftError("INTERNAL_ERROR", {
                message: `write "${label}" went on after a statement failed (${tx.failed.message.split("\n")[0]}); nothing was committed`,
                hint: "report this croft bug",
              });
            }
            await beforeCommit();
            await conn.run("COMMIT");
          }
          await this.o.afterLakeCommit?.();
          return result as T;
        } catch (e) {
          try {
            await conn.run("ROLLBACK");
          } catch {} // already rolled back by a failed COMMIT, or by the body
          const lostConnection = isConnectionError(e);
          const unsure = ran && (isCommitFailure(e) || lostConnection);
          const conflict = isConflict(e) && !lostConnection;
          if (!lostConnection && !unsure && !conflict) throw e;
          if (unsure) maybe.push({ tag, result });
          if (maybe.length) {
            let landed: string | null;
            try {
              landed = await landedTag(this.sqlOver(conn, null), maybe.map((m) => m.tag));
            } catch (check) {
              throw uncertain(`write "${label}" was committing when croft lost its connection to the lake, and croft could not find out whether it landed: ${(check instanceof Error ? check.message : String(check)).split("\n")[0]!.slice(0, 200)}`);
            }
            if (landed) {
              if (!own) return maybe.find((m) => m.tag === landed)!.result as T;
              throw uncertain(`write "${label}" landed (its commit was found in the lake by its tag), but croft lost the answer and cannot report what it did`, { landed: true });
            }
          }
          if (attempt + 1 >= (conflict ? LAKE_RETRY.conflict : LAKE_RETRY.connection)) throw lostConnection || unsure ? this.lost(e) : e;
          await sleep(lakeBackoffMs(attempt));
          if (o?.signal?.aborted) throw waitAborted(o.signal);
        }
      }
    } finally {
      release();
    }
  }

  /**
   * Which machine wrote, in the same transaction as the write: this machine's row of _croft.meta (one row per machine, so a machine's
   * write does not hide another's), which also says whether this write found that another machine had written since the one before it.
   * It is a row every write of the machine updates, so two attempts of one step that overlap conflict on it instead of both landing.
   */
  private async recordWriter(tx: LeaseSql, runId: string | undefined): Promise<void> {
    // A write that commits with no _croft state (a body that made none) gets it here, so it is recorded like the rest.
    if (!(await hasState(tx))) await ensureState(tx, { bookkeeping: "log" });
    const rows = await tx.all<{ key: string; value: string }>(`SELECT key, value FROM _croft.meta WHERE key LIKE '${WRITER_PREFIX}%'`);
    const record = writerRecord(runId ?? null, clockNow(), rows);
    await (await bookkeepingOf(tx)).upsert("meta", { key: "$1", value: "$2" }, [writerKey(record.machine), JSON.stringify(record)]);
  }

  private async open(kind: "read" | "write", waitMs: number, runId?: string, signal?: AbortSignal): Promise<DuckDBInstance> {
    if (this.lake) return this.openLake();
    if (this.mode === "read_only" && !existsSync(this.path)) {
      throw new CroftError("DB_NOT_FOUND", {
        message: `${this.label} ${this.path} does not exist yet`,
        hint: "run an asset first: croft run",
        fix: { kind: "command", description: "build the assets", command: "croft run" },
      });
    }
    if (this.usesIntent && !this.intentHeld) {
      intents.acquire(this.stateDir, { runId: runId ?? this.o.runId ?? null });
      this.intentHeld = true;
    }
    const start = Date.now();
    const deadline = start + waitMs;
    // Before this process first opens the file read-write: a backup when its engine is newer than the recorded one.
    if (this.usesIntent && !this.engineChecked) {
      try {
        const { backupBeforeUpgrade } = await import("./backup.ts");
        await backupBeforeUpgrade(this.stateDir, this.path, this.o.engineVersion ?? duckdbVersion(), { waitMs, signal });
      } catch (e) {
        this.dropIntent();
        throw e;
      }
      this.engineChecked = true;
    }
    let noticed = false;
    const seen = new Map<number, { at: number; d: Described }>();
    // Foreign-holder bookkeeping. A GUI (DuckDB UI, DBeaver) never steps aside for an intent, so after it
    // has blocked us continuously for foreignWithdrawMs the intent is withdrawn and croft serve keeps
    // serving. Withdrawing at the first conflict would be wrong: an app reading through
    // @zabaca/croft/read honors intents but is not recognizable as croft, and without the intent it
    // would keep reopening and starve the writer. So the intent also comes back every
    // foreignReannounceMs, giving such readers the chance to step aside.
    let foreignPid: number | null = null;
    let foreignSince: number | null = null;
    let withdrawnAt: number | null = null;
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) {
        this.waitingOn = null;
        this.dropIntent();
        throw waitAborted(signal);
      }
      try {
        const { instance } = await openInstance(this.path, this.mode, { stateDir: this.stateDir });
        if (this.intentHeld) intents.resume(this.stateDir); // announce again before anything else happens
        this.instance = instance;
        this.waitingOn = null;
        registerExitHook();
        return instance;
      } catch (e) {
        const conflict = lockConflict(e);
        if (!conflict) {
          this.dropIntent();
          throw e;
        }
        const { holder, croft, known } = await this.describeCached(conflict, seen);
        this.waitingOn = holder;
        const now = Date.now();
        if (this.intentHeld) {
          if (croft) {
            foreignPid = null;
            foreignSince = null;
            if (withdrawnAt !== null) intents.resume(this.stateDir);
            withdrawnAt = null;
          } else if (known) {
            // The clock starts at the first conflict with this holder (never at 0, which withdrew at once).
            if (foreignSince === null || foreignPid !== holder.pid) {
              foreignPid = holder.pid;
              foreignSince = now;
            }
            if (withdrawnAt === null && now - foreignSince >= (this.o.foreignWithdrawMs ?? 2000)) {
              intents.withdraw(this.stateDir);
              withdrawnAt = now;
            } else if (withdrawnAt !== null && now - withdrawnAt >= (this.o.foreignReannounceMs ?? 5000)) {
              intents.resume(this.stateDir);
              withdrawnAt = null;
              foreignSince = now;
            }
          }
        }
        const waited = now - start;
        if (!noticed && waited >= (this.o.noticeAfterMs ?? 2000)) {
          noticed = true;
          this.o.onWait?.(holder, waited);
        }
        if (Date.now() >= deadline) {
          this.waitingOn = null;
          this.dropIntent();
          throw this.busyError(holder, croft, waited, kind);
        }
        await sleep(Math.max(1, Math.min(backoffMs(attempt), deadline - Date.now())), signal);
      }
    }
  }

  private dropIntent(): void {
    if (this.intentHeld && !this.instance) {
      this.intentHeld = false;
      intents.release(this.stateDir);
    }
  }

  private scheduleClose(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    // A lake's instance lives as long as the command: nothing is locked by it, and a re-attach after its lock is refused.
    if (this.lake) {
      for (const r of this.idle.splice(0)) r();
      return;
    }
    this.closeTimer = setTimeout(() => this.closeNow(), this.o.lingerMs ?? 100);
    // Do not keep the process alive for the linger; the exit hook closes the file.
    (this.closeTimer as { unref?: () => void }).unref?.();
    for (const r of this.idle.splice(0)) r();
  }

  private closeNow(): void {
    this.closeTimer = null;
    if (this.leases > 0 || this.opening) return;
    if (this.instance) {
      for (const c of this.conns) c.disconnectSync(); // the lock stays held while any connection is open
      this.conns.clear();
      this.instance.closeSync();
      this.instance = null;
    }
    // Only now may serve reopen: the intent goes after closeSync() returned.
    this.dropIntent();
  }

  /** Close synchronously at process exit. */
  closeSyncForExit(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    for (const c of this.conns) {
      try {
        c.disconnectSync();
      } catch {}
    }
    this.conns.clear();
    try {
      this.instance?.closeSync();
    } catch {}
    this.instance = null;
    if (this.intentHeld) {
      this.intentHeld = false;
      intents.release(this.stateDir);
    }
  }

  // Describing a holder spawns `ps`; within one wait, reuse a description for a second.
  private async describeCached(c: LockConflict, seen: Map<number, { at: number; d: Described }>): Promise<Described> {
    if (c.pid === null) return this.describe(c);
    const hit = seen.get(c.pid);
    if (hit && Date.now() - hit.at < 1000) return hit.d;
    const d = await this.describe(c);
    seen.set(c.pid, { at: Date.now(), d });
    return d;
  }

  private async describe(c: LockConflict): Promise<Described> {
    const pid = c.pid;
    // A lock error that names no PID identifies no holder: it is never taken for a foreign program.
    if (pid === null) return { holder: { pid: null, program: c.program }, croft: false, known: false };
    const intent = intents.liveIntents(this.stateDir).find((i) => i.pid === pid);
    const base: LockHolder = intent
      ? { pid, program: "croft", runId: intent.runId ?? undefined, action: "write", since: intent.since }
      : { pid, program: c.program };
    let croft = Boolean(intent);
    const cmd = croft ? "" : commandLine(pid);
    // croft serve holds the file in its query worker, a child process (serve/worker.ts), not under its own pid.
    if (!croft && (servePid(this.stateDir) === pid || isServeWorkerCommand(cmd))) {
      base.program = "croft's read server";
      croft = true;
    }
    const extra = this.o.lookupHolder ? await this.o.lookupHolder(pid) : null;
    if (extra) {
      Object.assign(base, extra);
      croft = true;
    }
    if (!croft && isCroftCommandLine(cmd)) {
      base.program = "croft";
      croft = true;
    }
    return { holder: base, croft, known: croft || cmd !== "" };
  }

  private busyError(holder: LockHolder, croft: boolean, waitedMs: number, kind: "read" | "write"): CroftError {
    const secs = Math.round(waitedMs / 100) / 10;
    const details = { holder, waitedMs, database: this.path, purpose: kind };
    if (!croft) {
      const who = `${holder.program ?? "another program"}${holder.pid !== null ? ` (PID ${holder.pid})` : ""}`;
      return new CroftError("DB_HELD_BY_OTHER_PROGRAM", {
        message: `${this.label} is held by ${who}; waited ${secs} s`,
        hint: `close ${who}, then retry; apps should open the file only per query (@zabaca/croft/read does)`,
        retryable: true,
        details,
      });
    }
    let who: string;
    if (holder.action === "maintenance") {
      const since = holder.since ? `, ${Math.max(0, Math.round((Date.now() - Date.parse(holder.since)) / 1000))} s` : "";
      who = `croft is running the lake's maintenance (pid ${holder.pid}${since})`;
    } else if (holder.program === "croft's read server") who = `croft's read server (pid ${holder.pid}) has not stepped aside`;
    else if (holder.runId) {
      const since = holder.since ? `, ${Math.max(0, Math.round((Date.now() - Date.parse(holder.since)) / 1000))} s` : "";
      who = `croft run ${holder.runId}${holder.asset ? `, writing ${holder.asset}` : ""}${since}`;
    } else who = `croft (pid ${holder.pid})`;
    return new CroftError("DB_BUSY", {
      message: `${this.label} is busy: ${who}; waited ${secs} s`,
      hint: "retry when it finishes (croft status shows running work), or pass a longer wait",
      retryable: true,
      details,
    });
  }
}

/** The PID in <state>/serve.json, when croft serve recorded one. */
function servePid(stateDir: string): number | null {
  try {
    const v = JSON.parse(readFileSync(join(stateDir, "serve.json"), "utf8")) as { pid?: unknown };
    return typeof v.pid === "number" ? v.pid : null;
  } catch {
    return null;
  }
}

/** Whether a PID runs croft: the bin (`croft …`), the package (`@zabaca/croft`) or its source tree. */
export function isCroftCommand(pid: number): boolean {
  return isCroftCommandLine(commandLine(pid));
}

function isCroftCommandLine(cmd: string): boolean {
  return /(^|[\/\s])croft(\s|$)|@zabaca\/croft|\/croft\/src\//.test(cmd);
}

/** Whether a PID is croft serve's query worker (serve/worker.ts), which holds the warehouse for the server. */
export function isServeWorker(pid: number): boolean {
  return isServeWorkerCommand(commandLine(pid));
}

function isServeWorkerCommand(cmd: string): boolean {
  return /[\/\\]serve[\/\\]worker\.ts(\s|$)/.test(cmd);
}

/** A process's command line: /proc on Linux (minimal containers ship no `ps`), `ps` elsewhere. */
function commandLine(pid: number): string {
  if (process.platform === "linux") {
    try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim(); } catch { /* fall back to ps */ }
  }
  const out = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" } });
  return (out.stdout ?? "").trim();
}

let exitHooked = false;
function registerExitHook(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => {
    for (const w of byPath.values()) w.closeSyncForExit();
  });
}

/**
 * The warehouse for a path, created on first use. A process uses one mode per file for its whole life;
 * asking for another mode is a croft bug and throws. Registers globalThis[Symbol.for("croft.warehouse")]
 * so @zabaca/croft/read in the same process runs through this lease instead of opening a second instance.
 */
export function openWarehouse(o: WarehouseOptions): DuckWarehouse {
  const path = canonicalPath(o.path);
  let w = byPath.get(path);
  if (w) {
    if (w.mode !== o.mode) {
      throw new CroftError("INTERNAL_ERROR", {
        message: `${path} is already open ${w.mode} in this process; a process uses one access mode for its whole life`,
        hint: "report this croft bug",
      });
    }
    const differs: string[] = (["profile", "timezone"] as const).filter((k) => (w!.options[k] ?? null) !== (o[k] ?? null));
    if (canonicalPath(w.options.stateDir) !== canonicalPath(o.stateDir)) differs.push("stateDir");
    if (differs.length) {
      throw new CroftError("INTERNAL_ERROR", {
        message: `${path} is already open in this process with a different ${differs.join(", ")}`,
        hint: "report this croft bug",
      });
    }
  } else {
    w = new DuckWarehouse(o);
    byPath.set(path, w);
  }
  const g = globalThis as Record<symbol, unknown>;
  if (o.register !== false) g[GLOBAL_KEY] = w;
  g[GLOBAL_ALL] = byPath;
  return w;
}

/** The warehouse registered for a path in this process, if any. */
export function warehouseFor(path: string): DuckWarehouse | undefined {
  return byPath.get(canonicalPath(path));
}

/** Close and forget every warehouse (tests). */
export async function closeAllWarehouses(): Promise<void> {
  for (const w of byPath.values()) await w.close();
  byPath.clear();
  const g = globalThis as Record<symbol, unknown>;
  delete g[GLOBAL_KEY];
}
