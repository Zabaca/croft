// Leases on the warehouse file (DESIGN.md §5 "Owning the DuckDB file", "Leases", "Server mode").
//
// - The file is open only while DuckDB works: read()/write() open it on demand and close it 100 ms after
//   the last lease. Every connection is disconnected before closeSync(), because DuckDB keeps the OS lock
//   while any connection of the instance is open.
// - One access mode per process and path (connect.ts enforces it); instances only via fromCache.
// - Read-write opens announce a write intent first and remove it only after closeSync() returned.
// - Lock conflicts are retried with jittered backoff (25 ms doubling to 1 s) and end in DB_BUSY (a croft
//   holder) or DB_HELD_BY_OTHER_PROGRAM, naming the holder from DuckDB's lock error.
// - write() wraps BEGIN/COMMIT/ROLLBACK; every statement goes through prepare(), one per call, and the
//   transaction's TxGuard throws DDL_AFTER_DML at an ALTER that follows DML on the same table.
// - An optional AbortSignal ends a wait at once (Ctrl-C during a lock wait of up to 10 min): the lock wait,
//   and a write queued behind another write of this process. It never cuts a lease that already holds the
//   file; the body decides what an abort means there (run/ingest.ts refuses further statements).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { type DuckDBConnection, type DuckDBInstance, type DuckDBResultReader, type DuckDBValue, StatementType,
  blobValue, listValue } from "@duckdb/node-api";
import { CroftError } from "../core/errors.ts";
import type { LockHolder, Sql, Warehouse } from "../core/types.ts";
import type { Row } from "../types.ts";
import { type AccessMode, canonicalPath, connect, type LockConflict, lockConflict, openInstance, type SandboxSpec } from "./connect.ts";
import * as intents from "./intent.ts";
import { checkFormat } from "./state.ts";
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
}

export interface WriteOptions {
  waitMs?: number;
  runId: string;
  asset?: string;
  transaction?: boolean;
  /** Ends the wait for the file (and for this process's earlier writes) at once: the signal's CroftError
   *  reason (a run's INTERRUPTED or TIMEOUT), else INTERRUPTED. */
  signal?: AbortSignal;
}
export interface ReadOptions { waitMs?: number; purpose: string; signal?: AbortSignal }

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
  constructor(readonly connection: DuckDBConnection, private readonly ctx: RenderContext, private readonly guard: TxGuard | null) {}

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
      if (params.length) stmt.bind(params.map(toDuck));
      const out = read ? await stmt.runAndReadAll() : (await stmt.run(), undefined);
      this.guard?.record(type, sql);
      return out;
    } finally {
      stmt.destroySync();
    }
  }
}

interface Described { holder: LockHolder; croft: boolean }

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
  private readonly spec: SandboxSpec;
  private readonly stateDir: string;
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

  constructor(o: WarehouseOptions) {
    this.o = o;
    this.path = canonicalPath(o.path);
    this.mode = o.mode;
    this.stateDir = canonicalPath(o.stateDir);
    this.spec = {
      profile: o.profile ?? "warehouse", timezone: o.timezone, root: o.root, stateDir: this.stateDir,
      fileDirs: o.fileDirs, memoryLimit: o.memoryLimit, threads: o.threads,
    };
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
    return this.lease("read", o?.waitMs, (conn) => fn(new LeaseSql(conn, this.renderCtx(), null)), undefined, o?.signal);
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
        if (o?.transaction === false) return fn(new LeaseSql(conn, this.renderCtx(), null));
        // DuckDB names a file database after its stem, so `warehouse.t` means main.t in warehouse.duckdb.
        const tx = new LeaseSql(conn, this.renderCtx(), new TxGuard({ database: basename(this.path, extname(this.path)) }));
        await conn.run("BEGIN TRANSACTION");
        try {
          const result = await fn(tx);
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
    runId?: string, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw waitAborted(signal);
    this.leases++;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    let conn: DuckDBConnection | undefined;
    try {
      const instance = await this.ensureOpen(kind, waitMs ?? this.waitCap(kind), runId, signal);
      conn = await connect(instance, this.spec, this.path);
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
    return this.mode === "read_write" && this.o.writeIntent !== false;
  }

  private async open(kind: "read" | "write", waitMs: number, runId?: string, signal?: AbortSignal): Promise<DuckDBInstance> {
    if (this.mode === "read_only" && !existsSync(this.path)) {
      throw new CroftError("DB_NOT_FOUND", {
        message: `the warehouse ${this.path} does not exist yet`,
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
    let noticed = false;
    const seen = new Map<number, { at: number; d: Described }>();
    // Foreign-holder bookkeeping. A GUI (DuckDB UI, DBeaver) never steps aside for an intent, so after it
    // has blocked us continuously for foreignWithdrawMs the intent is withdrawn and croft serve keeps
    // serving. Withdrawing at the first conflict would be wrong: an app reading through
    // @zabaca/croft/read honors intents but is not recognizable as croft, and without the intent it
    // would keep reopening and starve the writer. So the intent also comes back every
    // foreignReannounceMs, giving such readers the chance to step aside.
    let foreignPid: number | null = null;
    let foreignSince = 0;
    let withdrawnAt: number | null = null;
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) {
        this.waitingOn = null;
        this.dropIntent();
        throw waitAborted(signal);
      }
      try {
        const { instance } = await openInstance(this.path, this.mode);
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
        const { holder, croft } = await this.describeCached(conflict, seen);
        this.waitingOn = holder;
        const now = Date.now();
        if (this.intentHeld) {
          if (croft) {
            foreignPid = null;
            if (withdrawnAt !== null) intents.resume(this.stateDir);
            withdrawnAt = null;
          } else {
            if (foreignPid !== holder.pid) {
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
    if (pid === null) return { holder: { pid: null, program: c.program }, croft: false };
    const intent = intents.liveIntents(this.stateDir).find((i) => i.pid === pid);
    const base: LockHolder = intent
      ? { pid, program: "croft", runId: intent.runId ?? undefined, action: "write", since: intent.since }
      : { pid, program: c.program };
    let croft = Boolean(intent);
    if (!croft && servePid(this.stateDir) === pid) {
      base.program = "croft's read server";
      croft = true;
    }
    const extra = this.o.lookupHolder ? await this.o.lookupHolder(pid) : null;
    if (extra) {
      Object.assign(base, extra);
      croft = true;
    }
    if (!croft && isCroftCommand(pid)) {
      base.program = "croft";
      croft = true;
    }
    return { holder: base, croft };
  }

  private busyError(holder: LockHolder, croft: boolean, waitedMs: number, kind: "read" | "write"): CroftError {
    const secs = Math.round(waitedMs / 100) / 10;
    const details = { holder, waitedMs, database: this.path, purpose: kind };
    if (!croft) {
      const who = `${holder.program ?? "another program"}${holder.pid !== null ? ` (PID ${holder.pid})` : ""}`;
      return new CroftError("DB_HELD_BY_OTHER_PROGRAM", {
        message: `the warehouse is held by ${who}; waited ${secs} s`,
        hint: `close ${who}, then retry; apps should open the file only per query (@zabaca/croft/read does)`,
        retryable: true,
        details,
      });
    }
    let who: string;
    if (holder.program === "croft's read server") who = `croft's read server (pid ${holder.pid}) has not stepped aside`;
    else if (holder.runId) {
      const since = holder.since ? `, ${Math.max(0, Math.round((Date.now() - Date.parse(holder.since)) / 1000))} s` : "";
      who = `croft run ${holder.runId}${holder.asset ? `, writing ${holder.asset}` : ""}${since}`;
    } else who = `croft (pid ${holder.pid})`;
    return new CroftError("DB_BUSY", {
      message: `the warehouse is busy: ${who}; waited ${secs} s`,
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
  return /(^|[\/\s])croft(\s|$)|@zabaca\/croft|\/croft\/src\//.test(commandLine(pid));
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
