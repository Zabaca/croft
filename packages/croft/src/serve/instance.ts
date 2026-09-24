// croft serve's query engine (DESIGN.md §5 "Server mode, apps and GUIs"): one read-only DuckDB instance on the
// live warehouse, admission (queue.ts) and the write-intent handoff (handoff.ts). server.ts only speaks HTTP.
//
// Owning the file:
// - One instance at a time, through connect.ts openInstance (DuckDBInstance.fromCache), read-only, with the serve
//   sandbox: allowed_directories = [], memory_limit 25% of RAM and threads (connect.ts serveResources). The
//   instance cache keeps only a weak reference, so the instance, and with it the OS lock, lives exactly as long
//   as something references it: the engine's one handle, a connection, a prepared statement or a streaming
//   result. So the engine keeps the only handle, makes every connection itself (the Pool below), destroys each
//   statement as its query settles, reads only materialized results, and disconnects every connection before
//   closeSync(). It never takes a second handle for the path while one is open: two instances on one file in one
//   process lose data, and closing a second one drops the first one's lock (§5, "Owning the DuckDB file").
// - It runs no user code and opens the file no other way (no fs calls on it, no ATTACH): the serve gate
//   (sql/gate.ts, profile "serve") admits only the project's tables, CTEs and range/generate_series/unnest/
//   json_each/json_tree.
//
// Stepping aside (states open → stepping_aside → closed_for_write → reopening → open):
// 1. A live intent appears in write-intent.d (polled every 50 ms, woken earlier by fs.watch): stop admitting.
// 2. Running queries may finish for graceMs (2 s); then each is interrupted every 20 ms until it settles. Their
//    clients get SERVE_UNAVAILABLE (503) with retryAfterMs.
// 3. Each query destroyed its prepared statement as it settled; its result was materialized, so no reader holds
//    the file.
// 4. Every connection is disconnected, idle ones included (no pool survives a handoff).
// 5. closeSync(): the writer can lock the file.
// When no intent is proven live any more (dead writers' intents are removed), the file is reopened, and queries
// that queued meanwhile run, each within its own queueMs (10 s) of arriving.
//
// The read copy (readCopy in croft.json, db/readcopy.ts): while the engine steps aside or stays closed for a writer
// and <database stem>.read.duckdb exists, queries are answered from it instead of waiting, their data marked
// `stale: true` with `asOf`, the copy's mtime (its checkpoint) in the project offset. That covers queries that
// arrive then, queries already waiting in the queue when the engine steps aside, and queries interrupted for the
// writer after graceMs. The copy is another file (a clone renamed into place, so another inode): its own read-only
// instance, with the same sandbox, gate and limits, and its own admission of maxConcurrent. It is opened for the
// queries that need it and closed 100 ms after the last one, so a GUI can open the copy between writes and a
// refreshed copy is picked up by the next open. A copy that cannot be opened leaves the query waiting as before.
import type { DuckDBConnection, DuckDBInstance, DuckDBPreparedStatement } from "@duckdb/node-api";
import { existsSync, statSync } from "node:fs";
import { CroftError } from "../core/errors.ts";
import { formatInstant, now, zonedParts } from "../core/time.ts";
import type { Sql } from "../core/types.ts";
import { canonicalPath, connect, lockConflict, openInstance, type SandboxSpec, serveResources } from "../db/connect.ts";
import { assertSafeFilesystem, type FsProbe, realProbe } from "../db/fs-kind.ts";
import type { IntentEntry } from "../db/intent.ts";
import { checkFormat } from "../db/state.ts";
import { backoffMs } from "../db/warehouse.ts";
import { renderRows, resultColumns } from "../db/values.ts";
import { loadProject, type Project } from "../project/root.ts";
import { mapQueryError, toDuck, wireSafe } from "../read/select.ts";
import { tooManyRows } from "../read/wire.ts";
import type { Row } from "../types.ts";
import { assertOneSelect } from "../sql/gate.ts";
import { drain, IntentWatch } from "./handoff.ts";
import { Admission, type Flight, type StopReason } from "./queue.ts";
import type { ServeEngine, ServeEngineOptions, ServeEngineStatus, ServeQuery, ServeQueryData } from "./types.ts";

export const SERVE_DEFAULTS = {
  maxConcurrent: 4,
  queueMs: 10_000,
  queryTimeoutMs: 30_000,
  pollMs: 50,
  graceMs: 2000,
  /** Repeated interrupts of a stopped query. */
  interruptEveryMs: 20,
  /** What a 503 tells the client to wait: a write step usually takes seconds. */
  retryAfterMs: 1000,
  /** The read copy's instance stays open this long after its last query. */
  copyLingerMs: 100,
} as const;

/** The data of an answer from the read copy. serve/types.ts ServeQueryData declares stale and asOf as optional
 *  fields (orchestrator change requested); until then this type carries them. */
type StaleQueryData = ServeQueryData & { stale: true; asOf: string };

/** Instrumentation points (tests, diagnostics). Each gets the wall-clock time it happened. */
export interface ServeEngineHooks {
  /** A live intent appeared: admission stopped. */
  steppingAside?(e: { intent: IntentEntry; at: number }): void;
  /** Right before the instance's closeSync(): connections still open (0 unless a disconnect failed). */
  beforeClose?(e: { openConnections: number; reason: CloseReason; at: number }): void;
  /** closeSync() returned: the file is free. `intent` is the writer it was released for. */
  released?(e: { intent: IntentEntry | null; reason: CloseReason; at: number }): void;
  /** The file was (re)opened and queries are admitted again. */
  opened?(e: { at: number }): void;
}

/** Why the instance was closed: a writer, the server stopping, or a check that failed right after opening. */
export type CloseReason = "write" | "stop" | "error";

/** Options the command does not pass: tests and diagnostics. */
export interface ServeEngineInternals {
  hooks?: ServeEngineHooks;
  /** How the warehouse's filesystem is probed (db/fs-kind.ts). */
  fs?: FsProbe;
  /** serve.maxBytes by default. */
  maxBytes?: number;
  /** serveResources() by default. */
  resources?: Partial<{ memoryLimit: string; threads: number }>;
  interruptEveryMs?: number;
  /** Watch write-intent.d besides polling it (default true). */
  watch?: boolean;
}

/** Open the engine for a project. Throws SERVE_UNSAFE_FILESYSTEM when the warehouse is on a filesystem whose
 *  locks cannot be trusted (virtiofs, grpcfuse, fakeowner, 9p, network filesystems). */
export async function openServeEngine(o: ServeEngineOptions & ServeEngineInternals): Promise<ServeEngine> {
  const project = loadProject({ root: o.root });
  assertSafeFilesystem({ root: project.root, database: project.paths.database, stateDir: project.paths.stateDir }, o.fs ?? realProbe);
  const engine = new Engine(project, o);
  await engine.start();
  return engine;
}

/** The connections of the current instance. `open` counts every connection made and not yet disconnected. */
class Pool {
  private readonly idle: DuckDBConnection[] = [];
  private readonly all = new Set<DuckDBConnection>();

  constructor(private readonly maxIdle: number) {}

  get open(): number {
    return this.all.size;
  }

  async take(instance: DuckDBInstance, spec: SandboxSpec, key: string): Promise<DuckDBConnection> {
    const reuse = this.idle.pop();
    if (reuse) return reuse;
    const conn = await connect(instance, spec, key);
    this.all.add(conn);
    return conn;
  }

  /** Back from a settled query: kept for the next one while the instance stays open, else disconnected. */
  give(conn: DuckDBConnection, keep: boolean): void {
    if (!this.all.has(conn)) return;
    if (keep && this.idle.length < this.maxIdle) this.idle.push(conn);
    else this.drop(conn);
  }

  /** Disconnect every connection, idle or not. disconnectSync() also destroys the statements it still tracks. */
  dropAll(): void {
    this.idle.length = 0;
    for (const c of [...this.all]) this.drop(c);
  }

  private drop(conn: DuckDBConnection): void {
    const i = this.idle.indexOf(conn);
    if (i >= 0) this.idle.splice(i, 1);
    try {
      conn.disconnectSync();
      this.all.delete(conn);
    } catch {
      // Counted as still open: beforeClose reports it.
    }
  }
}

const secs = (ms: number) => Math.round(ms / 100) / 10;

/**
 * The read copy as a second, read-only source, used only while the live file is closed for a writer. Its instance
 * is opened for the queries that need it and closed copyLingerMs after the last one. The copy is replaced by a
 * rename (db/readcopy.ts): an instance on the old file keeps reading it, consistently, and the first query after
 * that instance closed opens the new file. Connections are made per query and disconnected when it settles.
 */
class ReadCopySource {
  private instance: DuckDBInstance | null = null;
  private opening: Promise<DuckDBInstance> | null = null;
  /** The file the open instance reads (inode and mtime), and its mtime in the project offset. */
  private file: { ino: number; mtimeMs: number } | null = null;
  private asOf = "";
  private refs = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly conns = new Set<DuckDBConnection>();

  constructor(readonly path: string, private readonly spec: SandboxSpec, private readonly timezone: string, private readonly lingerMs: number) {}

  /** Whether there is a copy to answer from: a stat, never an open. */
  exists(): boolean {
    try {
      return statSync(this.path).isFile();
    } catch {
      return false;
    }
  }

  /** A connection on the copy and the copy's asOf. Throws when the copy cannot be opened or served. */
  async take(): Promise<{ conn: DuckDBConnection; asOf: string }> {
    this.refs++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      const instance = await this.open();
      const conn = await connect(instance, this.spec, this.path);
      this.conns.add(conn);
      return { conn, asOf: this.asOf };
    } catch (e) {
      this.leave();
      throw e;
    }
  }

  /** The query on `conn` settled (its statement is destroyed). */
  give(conn: DuckDBConnection): void {
    if (this.conns.delete(conn)) {
      try {
        conn.disconnectSync();
      } catch {}
    }
    this.leave();
  }

  /** Close now if no query uses the copy (the engine stops); otherwise the last one closes it. */
  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.refs > 0 || this.opening) return;
    this.drop();
  }

  /** Disconnect every connection, then close the instance. */
  private drop(): void {
    for (const c of this.conns) {
      try {
        c.disconnectSync();
      } catch {}
    }
    this.conns.clear();
    const instance = this.instance;
    this.instance = null;
    this.file = null;
    instance?.closeSync();
  }

  private leave(): void {
    if (--this.refs > 0) return;
    this.timer = setTimeout(() => this.close(), this.lingerMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async open(): Promise<DuckDBInstance> {
    // A copy renamed into place since the instance opened: reopen, unless a query still reads the old one.
    if (this.instance && this.refs === 1 && !this.opening && this.replaced()) this.drop();
    if (this.instance) return this.instance;
    this.opening ??= (async () => {
      // The stat comes first: if a rename lands in between, asOf is older than the data, never newer.
      const st = statSync(this.path);
      const { instance } = await openInstance(this.path, "read_only");
      try {
        const conn = await connect(instance, this.spec, this.path);
        try {
          await checkFormat(sqlOn(conn, this.timezone)); // DB_NEWER_FORMAT, as for the live file
        } finally {
          conn.disconnectSync();
        }
      } catch (e) {
        instance.closeSync();
        throw e;
      }
      this.instance = instance;
      this.file = { ino: st.ino, mtimeMs: st.mtimeMs };
      this.asOf = formatInstant(Math.round(st.mtimeMs), this.timezone);
      return instance;
    })().finally(() => (this.opening = null));
    return this.opening;
  }

  private replaced(): boolean {
    try {
      const st = statSync(this.path);
      return !this.file || st.ino !== this.file.ino || st.mtimeMs !== this.file.mtimeMs;
    } catch {
      return false; // gone: keep reading the open one
    }
  }
}

class Engine implements ServeEngine {
  private state: ServeEngineStatus["state"] = "reopening";
  private instance: DuckDBInstance | null = null;
  private readonly pool: Pool;
  private readonly admission: Admission;
  private readonly watch: IntentWatch;
  private readonly spec: SandboxSpec;
  private readonly path: string;
  private readonly hooks: ServeEngineHooks;
  private readonly maxConcurrent: number;
  private readonly queueMs: number;
  private readonly queryTimeoutMs: number;
  private readonly graceMs: number;
  private readonly pollMs: number;
  private readonly maxBytes: number;
  /** The read copy (readCopy on), and admission to it; null when readCopy is off. */
  private readonly copy: ReadCopySource | null;
  private readonly copyAdmission: Admission;
  /** What queued queries are rejected with when the engine steps aside and the copy can answer them. */
  private readonly toCopy: CroftError;
  /** The writer the engine stepped aside for (or waits on), else null. */
  private intent: IntentEntry | null = null;
  /** Why the file cannot be opened right now (DB_NOT_FOUND, DB_NEWER_FORMAT, DB_UNREADABLE); null otherwise. */
  private blocked: CroftError | null = null;
  /** A program without an intent that held the file at the last reopen attempt. */
  private foreign: { program: string | null; pid: number | null } | null = null;
  private transition: Promise<void> | null = null;
  private retryAt = 0;
  private attempts = 0;
  private stopped = false;
  private closing: Promise<void> | null = null;
  private day = "";
  private count = 0;

  constructor(private readonly project: Project, o: ServeEngineOptions & ServeEngineInternals) {
    const serve = project.config.serve;
    this.maxConcurrent = o.maxConcurrent ?? serve.maxConcurrent ?? SERVE_DEFAULTS.maxConcurrent;
    this.queueMs = o.queueMs ?? SERVE_DEFAULTS.queueMs;
    this.queryTimeoutMs = o.queryTimeoutMs ?? serve.queryTimeoutMs ?? SERVE_DEFAULTS.queryTimeoutMs;
    this.graceMs = o.graceMs ?? SERVE_DEFAULTS.graceMs;
    this.pollMs = o.pollMs ?? SERVE_DEFAULTS.pollMs;
    this.maxBytes = o.maxBytes ?? serve.maxBytes;
    this.hooks = guarded(o.hooks ?? {});
    this.path = canonicalPath(project.paths.database);
    this.spec = { profile: "serve", timezone: project.timezone, root: project.root, stateDir: project.paths.stateDir, ...serveResources(), ...o.resources };
    this.pool = new Pool(this.maxConcurrent);
    this.admission = new Admission({
      maxConcurrent: this.maxConcurrent,
      interruptEveryMs: o.interruptEveryMs ?? SERVE_DEFAULTS.interruptEveryMs,
      unavailable: (waitedMs) => this.notAdmitted(waitedMs),
      aborted: () => this.stopError("abort"),
    });
    this.watch = new IntentWatch({ stateDir: project.paths.stateDir, pollMs: this.pollMs, onTick: () => this.tick(), watch: o.watch });
    this.copy = project.config.readCopy
      ? new ReadCopySource(canonicalPath(project.paths.readCopy), this.spec, project.timezone, SERVE_DEFAULTS.copyLingerMs)
      : null;
    this.copyAdmission = new Admission({
      maxConcurrent: this.maxConcurrent,
      interruptEveryMs: o.interruptEveryMs ?? SERVE_DEFAULTS.interruptEveryMs,
      unavailable: (waitedMs) => this.copyBusy(waitedMs),
      aborted: () => this.stopError("abort"),
    });
    this.copyAdmission.resume();
    this.toCopy = new CroftError("SERVE_UNAVAILABLE", {
      message: "croft's read server stepped aside for a writer; the query moves to the read copy",
      hint: "retry after Retry-After",
      retryable: true,
      details: { reason: "write", retryAfterMs: SERVE_DEFAULTS.retryAfterMs },
    });
  }

  /** First open. A writer already at work is waited for; a file that is not there yet is waited for too (the
   *  first run creates it); a file that cannot be served (newer format, unreadable) fails the start. */
  async start(): Promise<void> {
    const live = this.watch.live();
    if (live.length > 0) {
      this.intent = live[0]!;
      this.state = "closed_for_write";
    } else {
      await this.reopen();
      if (this.blocked && this.blocked.code !== "DB_NOT_FOUND") {
        const err = this.blocked;
        await this.close();
        throw err;
      }
    }
    this.watch.start();
    this.tick();
  }

  status(): ServeEngineStatus {
    const i = this.intent;
    return {
      state: this.state,
      writeIntent: i ? { pid: i.pid, runId: i.runId, since: i.since } : null,
      inFlight: this.admission.inFlight + this.copyAdmission.inFlight,
      queued: this.admission.queued + this.copyAdmission.queued,
      openConnections: this.pool.open,
      queriesToday: this.dayKey() === this.day ? this.count : 0,
    };
  }

  async query(q: ServeQuery): Promise<ServeQueryData> {
    const arrived = performance.now();
    const arrivedAt = Date.now();
    if (!Number.isSafeInteger(q.limit) || q.limit < 0) {
      throw new CroftError("USAGE_ERROR", {
        message: `limit must be a whole number of rows, 0 or more; got ${JSON.stringify(q.limit)}`,
        hint: "send {sql, params?, limit?} with limit a whole number, such as 10000",
      });
    }
    if (this.stopped) throw this.stopError("stop");
    // A file that cannot be opened fails at once, unless a writer is about to change that (the first run).
    if (this.blocked && this.state === "reopening" && !this.intent) throw this.blocked;
    // A writer holds the file: the read copy answers, when there is one.
    if (this.copyServes()) {
      const stale = await this.fromCopy(q, arrived);
      if (stale) return stale;
    }
    const live = { admitted: false };
    try {
      return await this.fromLive(q, arrived, arrivedAt + this.queueMs, live);
    } catch (e) {
      // Moved out of the queue as the engine stepped aside, or interrupted for the writer: the copy answers. A query
      // interrupted on the live file was counted there.
      const forWriter = e === this.toCopy || (e instanceof CroftError && e.code === "SERVE_UNAVAILABLE" && e.problem.details?.reason === "write");
      if (forWriter && this.copyServes()) {
        const stale = await this.fromCopy(q, arrived, !live.admitted);
        if (stale) return stale;
      }
      // The copy could not answer after all: wait in the queue as before, for the rest of queueMs.
      if (e === this.toCopy) return this.fromLive(q, arrived, arrivedAt + this.queueMs, live);
      throw e;
    }
  }

  /** The query on the live file, once admitted (by `deadline`, epoch ms); `live.admitted` says whether it was. */
  private async fromLive(q: ServeQuery, arrived: number, deadline: number, live: { admitted: boolean }): Promise<ServeQueryData> {
    const flight = await this.admission.enter({ deadline, signal: q.signal });
    live.admitted = true;
    const timer = setTimeout(() => flight.stop("timeout"), this.queryTimeoutMs);
    const onAbort = () => flight.stop("abort");
    q.signal?.addEventListener("abort", onAbort, { once: true });
    let conn: DuckDBConnection | null = null;
    try {
      const instance = this.instance;
      if (!instance) throw this.stopError("stop"); // admitted only while open; defensive
      conn = await this.pool.take(instance, this.spec, this.path);
      return await this.answer(conn, flight, q, arrived);
    } catch (e) {
      if (flight.reason) throw this.stopError(flight.reason);
      throw mapQueryError(e, "serve");
    } finally {
      clearTimeout(timer);
      q.signal?.removeEventListener("abort", onAbort);
      if (conn) this.pool.give(conn, this.state === "open" && !this.stopped);
      this.countQuery();
      flight.release();
    }
  }

  /** Whether the read copy answers now: readCopy is on, a writer holds the file, and the copy exists. */
  private copyServes(): boolean {
    return this.copy !== null && !this.stopped && this.intent !== null
      && (this.state === "stepping_aside" || this.state === "closed_for_write") && this.copy.exists();
  }

  /**
   * The query on the read copy, within what is left of its queryTimeoutMs. null when the copy cannot be opened
   * (the caller then waits for the live file); the query's own errors are thrown. `count`: toward queriesToday.
   */
  private async fromCopy(q: ServeQuery, arrived: number, count = true): Promise<StaleQueryData | null> {
    const copy = this.copy!;
    const left = this.queryTimeoutMs - (performance.now() - arrived);
    if (left <= 0) return null;
    const flight = await this.copyAdmission.enter({ deadline: Date.now() + this.queueMs, signal: q.signal });
    const timer = setTimeout(() => flight.stop("timeout"), left);
    const onAbort = () => flight.stop("abort");
    q.signal?.addEventListener("abort", onAbort, { once: true });
    let lease: { conn: DuckDBConnection; asOf: string } | null = null;
    try {
      try {
        lease = await copy.take();
      } catch {
        return null;
      }
      const data = await this.answer(lease.conn, flight, q, arrived);
      return { ...data, stale: true, asOf: lease.asOf };
    } catch (e) {
      if (flight.reason) throw this.stopError(flight.reason);
      throw mapQueryError(e, "serve");
    } finally {
      clearTimeout(timer);
      q.signal?.removeEventListener("abort", onAbort);
      if (lease) {
        copy.give(lease.conn);
        if (count) this.countQuery();
      }
      flight.release();
    }
  }

  /** The gate, then the statement, fully materialized and rendered; the statement is destroyed as it settles. */
  private async answer(conn: DuckDBConnection, flight: Flight, q: ServeQuery, arrived: number): Promise<ServeQueryData> {
    flight.attach(conn);
    flight.checkpoint();
    await assertOneSelect(conn, q.sql, { profile: "serve", protect: [this.project.paths.stateDir] });
    flight.checkpoint();
    let stmt: DuckDBPreparedStatement;
    try {
      stmt = await conn.prepare(q.sql);
    } catch (e) {
      throw mapQueryError(e, "serve");
    }
    try {
      flight.checkpoint();
      if (q.params.length) stmt.bind(q.params.map(toDuck));
      // Materialized, never streamed: a partly read stream keeps the file locked [V]. At most limit + 1 rows are
      // converted to JavaScript; more than `limit` is an error, never a partial result.
      const reader = await stmt.runAndReadUntil(q.limit + 1);
      if (reader.currentRowCount > q.limit) throw tooManyRows(q.limit, { via: "read server" });
      const columns = resultColumns(reader);
      const rows = this.wireRows(renderRows(reader, { mode: "json", timezone: this.project.timezone }), q.limit);
      return { columns, rows, rowCount: rows.length, tookMs: Math.round(performance.now() - arrived) };
    } finally {
      try {
        stmt.destroySync();
      } catch {}
    }
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.stopped = true;
      this.watch.stop();
      this.admission.close(this.stopError("stop"));
      this.copyAdmission.close(this.stopError("stop"));
      // No grace: the server is going away.
      for (const f of [...this.admission.active, ...this.copyAdmission.active]) f.stop("stop");
      await Promise.all([this.admission.idle(), this.copyAdmission.idle()]);
      this.copy?.close();
      await this.transition; // an open or a step-aside in progress sees `stopped` and leaves the rest to us
      this.release("stop");
      this.state = "stopped";
      this.intent = null;
    })();
    return this.closing;
  }

  // ---- the handoff --------------------------------------------------------------------------------------

  /** On every poll and folder change. Starts at most one transition at a time; each re-ticks when it ends. */
  private tick(): void {
    if (this.stopped || this.transition) return;
    if (this.state === "open") {
      const writer = this.watch.candidates()[0];
      if (writer) this.begin(this.stepAside(writer));
      return;
    }
    // Closed (or not open yet): reopen only once no writer is proven alive; dead writers' intents go.
    const live = this.watch.live();
    if (live.length > 0) {
      this.intent = live[0]!;
      this.state = "closed_for_write";
      return;
    }
    this.intent = null;
    this.state = "reopening";
    if (Date.now() >= this.retryAt) this.begin(this.reopen());
  }

  private begin(p: Promise<void>): void {
    this.transition = p
      .catch(() => {}) // every failure is recorded (blocked) by the transition itself
      .finally(() => {
        this.transition = null;
        if (!this.stopped) this.tick();
      });
  }

  private async stepAside(intent: IntentEntry): Promise<void> {
    this.state = "stepping_aside";
    this.intent = intent;
    this.admission.pause();
    // Queries waiting for a slot go to the read copy rather than wait out the write.
    if (this.copyServes()) this.admission.fail(this.toCopy);
    this.hooks.steppingAside?.({ intent, at: Date.now() });
    await drain(this.admission, { graceMs: this.graceMs, reason: "write" });
    if (this.stopped) return; // close() releases the file
    this.release("write");
    this.state = "closed_for_write";
  }

  /** Steps 3–5: every statement is already destroyed (each query destroys its own as it settles); disconnect
   *  every connection, then close the one handle. */
  private release(reason: CloseReason): void {
    this.pool.dropAll();
    const instance = this.instance;
    if (!instance) return;
    this.instance = null;
    this.hooks.beforeClose?.({ openConnections: this.pool.open, reason, at: Date.now() });
    instance.closeSync();
    this.hooks.released?.({ intent: reason === "write" ? this.intent : null, reason, at: Date.now() });
  }

  private async reopen(): Promise<void> {
    this.state = "reopening";
    if (!existsSync(this.path)) { // a stat: never opens the file
      this.block(this.notFound());
      this.retryAt = Date.now() + this.pollMs;
      return;
    }
    let instance: DuckDBInstance;
    try {
      instance = (await openInstance(this.path, "read_only")).instance;
    } catch (e) {
      const conflict = lockConflict(e);
      if (conflict) {
        // A program without an intent holds it: a GUI, or a writer that withdrew its intent because of one.
        // The file exists and will open once it lets go: queries wait rather than fail.
        this.foreign = { program: conflict.program, pid: conflict.pid };
        this.blocked = null;
        this.retryAt = Date.now() + backoffMs(this.attempts++);
        return;
      }
      this.block(this.unreadable(e));
      this.retryAt = Date.now() + 1000;
      return;
    }
    this.instance = instance;
    this.foreign = null;
    this.attempts = 0;
    if (this.stopped) return; // close() releases it
    try {
      // Refuse a database from a newer croft before serving it (DB_NEWER_FORMAT), as every croft read does.
      const conn = await this.pool.take(instance, this.spec, this.path);
      try {
        await checkFormat(sqlOn(conn, this.project.timezone));
      } finally {
        this.pool.give(conn, true);
      }
    } catch (e) {
      if (this.stopped) return;
      this.release("error");
      this.block(e instanceof CroftError ? e : this.unreadable(e));
      this.retryAt = Date.now() + 1000;
      return;
    }
    if (this.stopped) return;
    this.blocked = null;
    this.state = "open";
    this.hooks.opened?.({ at: Date.now() });
    // A writer that announced itself while the file opened goes first: the next tick steps aside at once.
    if (this.watch.candidates().length === 0) this.admission.resume();
  }

  private block(err: CroftError): void {
    this.blocked = err;
    this.admission.fail(err);
  }

  // ---- results ------------------------------------------------------------------------------------------

  /**
   * Rows exactly as the client will parse them (-0 is 0, as direct mode returns them: read/select.ts wireSafe),
   * within serve.maxBytes of JSON. A bigger result is QUERY_TOO_MANY_ROWS, never a truncated one.
   */
  private wireRows(rows: Row[], limit: number): Row[] {
    let bytes = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = wireSafe(rows[i]) as Row;
      bytes += Buffer.byteLength(JSON.stringify(r)) + 1;
      if (bytes > this.maxBytes) {
        throw new CroftError("QUERY_TOO_MANY_ROWS", {
          message: `the result is larger than serve.maxBytes (${this.maxBytes.toLocaleString("en-US")} bytes); croft never returns a partial result`,
          hint: "select fewer or smaller columns, filter or aggregate in SQL, or raise serve.maxBytes in croft.json",
          retryable: false,
          details: { maxBytes: this.maxBytes, limit, rowsWithinMaxBytes: i, via: "read server" },
        });
      }
    }
    return rows;
  }

  private countQuery(): void {
    const key = this.dayKey();
    if (key !== this.day) {
      this.day = key;
      this.count = 0;
    }
    this.count++;
  }

  /** Today in the project's zone (CROFT_NOW freezes it for tests). */
  private dayKey(): string {
    const p = zonedParts(now(), this.project.timezone);
    return `${p.year}-${p.month}-${p.day}`;
  }

  // ---- errors -------------------------------------------------------------------------------------------

  private writer(i: IntentEntry): string {
    return i.runId ? `croft run ${i.runId}` : `a croft write (pid ${i.pid})`;
  }

  private writeDetails(i: IntentEntry): Record<string, unknown> {
    return { pid: i.pid, runId: i.runId, since: i.since };
  }

  /** Why a query was not admitted within queueMs. */
  private notAdmitted(waitedMs: number): CroftError {
    const retryAfterMs = SERVE_DEFAULTS.retryAfterMs;
    const base = { retryable: true };
    if (this.stopped) return this.stopError("stop");
    if (this.intent && this.state !== "open") {
      return new CroftError("SERVE_UNAVAILABLE", {
        ...base,
        message: `croft's read server waited ${secs(waitedMs)} s for ${this.writer(this.intent)} to finish writing; the query was not run`,
        hint: "retry after Retry-After: a run holds the file only while a write step runs, usually seconds",
        details: { reason: "write", retryAfterMs, waitedMs, writeIntent: this.writeDetails(this.intent) },
      });
    }
    if (this.state !== "open") {
      const who = this.foreign ? `${this.foreign.program ?? "another program"}${this.foreign.pid !== null ? ` (PID ${this.foreign.pid})` : ""}` : null;
      return new CroftError("SERVE_UNAVAILABLE", {
        ...base,
        message: who
          ? `croft's read server could not open the warehouse for ${secs(waitedMs)} s: ${who} holds it`
          : `croft's read server could not open the warehouse for ${secs(waitedMs)} s${this.blocked ? `: ${this.blocked.message}` : ""}`,
        hint: who ? `close ${who}; GUIs should open the read copy ("readCopy": true) instead of the live file` : "retry after Retry-After; croft doctor shows what is wrong",
        details: { reason: "unavailable", retryAfterMs, waitedMs, holder: this.foreign },
      });
    }
    return new CroftError("SERVE_UNAVAILABLE", {
      ...base,
      message: `all ${this.maxConcurrent} query slots of croft's read server stayed busy for ${secs(waitedMs)} s; the query was not run`,
      hint: "retry after Retry-After; slow queries hold the slots, so filter or aggregate them in SQL, or raise serve.maxConcurrent in croft.json",
      details: { reason: "busy", retryAfterMs, waitedMs, maxConcurrent: this.maxConcurrent },
    });
  }

  /** Why a query for the read copy was not admitted within queueMs: its slots stayed busy. */
  private copyBusy(waitedMs: number): CroftError {
    if (this.stopped) return this.stopError("stop");
    return new CroftError("SERVE_UNAVAILABLE", {
      message: `all ${this.maxConcurrent} query slots of croft's read server stayed busy for ${secs(waitedMs)} s while it answered from the read copy; the query was not run`,
      hint: "retry after Retry-After; slow queries hold the slots, so filter or aggregate them in SQL, or raise serve.maxConcurrent in croft.json",
      retryable: true,
      details: { reason: "busy", retryAfterMs: SERVE_DEFAULTS.retryAfterMs, waitedMs, maxConcurrent: this.maxConcurrent },
    });
  }

  /** What a stopped query (or a request refused because the server stops) reports. */
  private stopError(reason: StopReason): CroftError {
    const retryAfterMs = SERVE_DEFAULTS.retryAfterMs;
    switch (reason) {
      case "write": {
        const i = this.intent;
        return new CroftError("SERVE_UNAVAILABLE", {
          message: `the query was interrupted after ${secs(this.graceMs)} s so ${i ? this.writer(i) : "a croft run"} could write; it returned nothing`,
          hint: "retry after Retry-After; queries that finish within 2 s are never interrupted, so a long one may need filtering or aggregating",
          retryable: true,
          details: { reason: "write", retryAfterMs, graceMs: this.graceMs, writeIntent: i ? this.writeDetails(i) : null },
        });
      }
      case "timeout":
        return new CroftError("TIMEOUT", {
          message: `the query ran longer than serve.queryTimeoutMs (${secs(this.queryTimeoutMs)} s) and was stopped`,
          hint: "make it cheaper (filter or aggregate in SQL, add a LIMIT), or raise serve.queryTimeoutMs in croft.json",
          retryable: false,
          details: { phase: "query", timeoutMs: this.queryTimeoutMs },
        });
      case "abort":
        return new CroftError("INTERRUPTED", {
          message: "the request went away, so its query was stopped",
          hint: "nothing to do: the client disconnected or cancelled the request",
          details: { reason: "abort" },
        });
      case "stop":
        return new CroftError("SERVE_UNAVAILABLE", {
          message: "croft's read server is stopping; the query was not answered",
          hint: "retry once croft serve runs again; without it, @zabaca/croft/read reads the file directly",
          retryable: true,
          details: { reason: "stopping", retryAfterMs },
        });
    }
  }

  private notFound(): CroftError {
    return new CroftError("DB_NOT_FOUND", {
      message: `the warehouse ${this.project.paths.database} does not exist yet`,
      hint: "run an asset first; croft serve opens the file as soon as a run creates it",
      fix: { kind: "command", description: "build the assets", command: "croft run" },
      details: { database: this.project.paths.database },
    });
  }

  private unreadable(e: unknown): CroftError {
    const first = String((e as Error)?.message ?? e).split("\n")[0]!;
    return new CroftError("DB_UNREADABLE", {
      message: `croft's read server cannot open the warehouse ${this.project.paths.database}: ${first}`,
      hint: "run croft doctor to check the file; croft serve retries every second",
      fix: { kind: "command", description: "check the warehouse file", command: "croft doctor" },
      details: { database: this.project.paths.database, duckdb: first },
    });
  }
}

/** Hooks that cannot break the engine: one that throws is ignored (a handoff must always finish). */
function guarded(h: ServeEngineHooks): ServeEngineHooks {
  const out: ServeEngineHooks = {};
  for (const [name, fn] of Object.entries(h) as [keyof ServeEngineHooks, ((e: unknown) => void) | undefined][]) {
    if (fn) {
      (out as Record<string, (e: unknown) => void>)[name] = (e) => {
        try {
          fn(e);
        } catch {}
      };
    }
  }
  return out;
}

/** A minimal Sql over one connection, for db/state.ts's format check. */
function sqlOn(conn: DuckDBConnection, timezone: string): Sql {
  return {
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return renderRows(await conn.runAndReadAll(sql, params.map(toDuck)), { mode: "ts", timezone }) as T[];
    },
    async exec(sql: string, params: unknown[] = []): Promise<void> {
      await conn.run(sql, params.map(toDuck));
    },
  };
}
