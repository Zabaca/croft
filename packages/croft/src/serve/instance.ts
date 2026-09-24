// croft serve's query engine (DESIGN.md §5 "Server mode, apps and GUIs"): the read-only DuckDB instance on the
// live warehouse, admission (queue.ts) and the write-intent handoff (handoff.ts). server.ts only speaks HTTP.
//
// Owning the file:
// - The instance lives in a query worker (worker.ts), a child process this engine spawns and owns
//   (query-worker.ts), never in croft serve itself: one worker per open of the file, read-only, with the serve
//   sandbox (allowed_directories = [], memory_limit 25% of RAM and threads: connect.ts serveResources). croft serve
//   opens no DuckDB file at all, so its own descriptors can never drop a lock (§5, "Owning the DuckDB file").
// - The file is released by killing the worker (SIGKILL): the kernel drops the process's locks as it exits,
//   whatever DuckDB's objects are doing. That is what bounds a handoff. DuckDB checks for interrupts only between
//   tasks, and a SELECT can spend many seconds in one scalar or list expression (list_sort(range(n)),
//   list_reduce over a big range, a big constant folded while planning), which no interrupt stops, and closing an
//   instance while its query runs keeps the lock.
// - It runs no user code: the serve gate (sql/gate.ts, profile "serve", applied in the worker) admits only the
//   project's tables, CTEs and range/generate_series/unnest/json_each/json_tree.
//
// Stepping aside (states open → stepping_aside → closed_for_write → reopening → open):
// 1. A live intent appears in write-intent.d (polled every 50 ms, woken earlier by fs.watch): stop admitting.
// 2. Running queries may finish for graceMs (2 s); then each is interrupted every 20 ms until it settles. Their
//    clients get SERVE_UNAVAILABLE (503) with retryAfterMs. One that has not settled killAfterMs (500 ms) after
//    its first interrupt is abandoned: the worker is killed, which ends it (and any query beside it).
// 3. Every connection is disconnected, idle ones included (no pool survives a handoff).
// 4. The worker is killed and its exit awaited: the writer can lock the file. So the writer waits at most
//    graceMs + killAfterMs + the few milliseconds a kill takes, whatever the queries do.
// A fresh worker is started meanwhile, so when no intent is proven live any more (dead writers' intents are
// removed), the file is reopened in milliseconds, and queries that queued meanwhile run, each within its own
// queueMs (10 s) of arriving.
//
// Deadlines hold the same way: at queryTimeoutMs a query is interrupted, and one that has not settled
// killAfterMs later is abandoned. A worker that dies while serving (killed for a stuck query, the OOM killer, a
// crash) is replaced at once; the queries it ran beside the stuck one get SERVE_UNAVAILABLE (retryable), which the
// read client retries.
//
// Limits (§5 "Query limits"): at most maxConcurrent queries run, at most maxQueued wait (more are refused at once:
// a burst of requests during a write step cannot pile up), and a result is streamed chunk by chunk in the worker
// and fails with QUERY_TOO_MANY_ROWS as soon as it passes `limit` (capped at maxRows) or serve.maxBytes.
//
// The read copy (readCopy in croft.json, db/readcopy.ts): while the engine steps aside or stays closed for a writer
// and <database stem>.read.duckdb exists, queries are answered from it instead of waiting, their data marked
// `stale: true` with `asOf`, the copy's mtime (its checkpoint) in the project offset. That covers queries that
// arrive then, queries already waiting in the queue when the engine steps aside, and queries interrupted for the
// writer after graceMs. The copy is another file (a clone renamed into place, so another inode): its own worker,
// with the same sandbox, gate and limits, and its own admission of maxConcurrent. It is opened for the queries that
// need it and its worker is killed 100 ms after the last one, so a GUI can open the copy between writes and a
// refreshed copy is picked up by the next open. A copy that cannot be opened leaves the query waiting as before.
import { existsSync, statSync } from "node:fs";
import { CroftError } from "../core/errors.ts";
import { formatInstant, now, zonedParts } from "../core/time.ts";
import { canonicalPath, type SandboxSpec, serveResources } from "../db/connect.ts";
import { assertSafeFilesystem, type FsProbe, realProbe } from "../db/fs-kind.ts";
import type { IntentEntry } from "../db/intent.ts";
import { backoffMs } from "../db/warehouse.ts";
import { loadProject, type Project } from "../project/root.ts";
import { mapQueryError } from "../read/select.ts";
import { drain, IntentWatch } from "./handoff.ts";
import { Admission, type Flight, type StopReason } from "./queue.ts";
import { QueryWorker, WorkerConflict, WorkerGone, WorkerStopped } from "./query-worker.ts";
import type { ServeEngine, ServeEngineOptions, ServeEngineStatus, ServeQuery, ServeQueryData } from "./types.ts";

export const SERVE_DEFAULTS = {
  maxConcurrent: 4,
  queueMs: 10_000,
  queryTimeoutMs: 30_000,
  pollMs: 50,
  graceMs: 2000,
  /** Repeated interrupts of a stopped query. */
  interruptEveryMs: 20,
  /** A stopped query that has not settled this long after its first interrupt is ended by killing its worker. */
  killAfterMs: 500,
  /** Queries that may wait for a slot; more are refused at once (503). */
  maxQueued: 64,
  /** The most rows one answer carries, whatever `limit` asks for. */
  maxRows: 100_000,
  /** How long a worker may take to disconnect its connections before it is killed anyway. */
  disconnectWaitMs: 250,
  /** What a 503 tells the client to wait: a write step usually takes seconds. */
  retryAfterMs: 1000,
  /** The read copy's worker stays up this long after its last query. */
  copyLingerMs: 100,
} as const;

/** The data of an answer from the read copy. */
type StaleQueryData = ServeQueryData & { stale: true; asOf: string };

/** Instrumentation points (tests, diagnostics). Each gets the wall-clock time it happened. */
export interface ServeEngineHooks {
  /** A live intent appeared: admission stopped. */
  steppingAside?(e: { intent: IntentEntry; at: number }): void;
  /** Right before the worker is killed: connections still open (0 unless a disconnect failed or it hung). */
  beforeClose?(e: { openConnections: number; reason: CloseReason; at: number }): void;
  /** The worker has exited: the file is free. `intent` is the writer it was released for. */
  released?(e: { intent: IntentEntry | null; reason: CloseReason; at: number }): void;
  /** The file was (re)opened and queries are admitted again. */
  opened?(e: { at: number }): void;
  /** A query ended (answered or not) on a worker: its pid and peak resident set, in bytes. */
  queryEnded?(e: { workerPid: number; workerPeakRss: number; at: number }): void;
}

/** Why the file was released: a writer, the server stopping, or a check that failed right after opening. */
export type CloseReason = "write" | "stop" | "error";

/** Options the command does not pass: tests and diagnostics. */
export interface ServeEngineInternals {
  hooks?: ServeEngineHooks;
  /** How the warehouse's filesystem is probed (db/fs-kind.ts). */
  fs?: FsProbe;
  /** serve.maxBytes by default. */
  maxBytes?: number;
  /** SERVE_DEFAULTS.maxRows by default. */
  maxRows?: number;
  /** SERVE_DEFAULTS.maxQueued by default. */
  maxQueued?: number;
  /** SERVE_DEFAULTS.killAfterMs by default. */
  killAfterMs?: number;
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

const secs = (ms: number) => Math.round(ms / 100) / 10;

/** What a file is opened with in a worker. */
interface OpenSpec { path: string; spec: SandboxSpec; protect: string[] }

/**
 * The read copy as a second, read-only source, used only while the live file is closed for a writer. Its worker is
 * started for the queries that need it and killed copyLingerMs after the last one. The copy is replaced by a rename
 * (db/readcopy.ts): a worker on the old file keeps reading it, consistently, and the first query after that worker
 * went away opens the new file. While the live file stays closed, a spare worker waits, so a query after the linger
 * only pays for the open.
 */
class ReadCopySource {
  private worker: QueryWorker | null = null;
  private spare: QueryWorker | null = null;
  private opening: Promise<QueryWorker> | null = null;
  /** The file the worker reads (inode and mtime), and its mtime in the project offset. */
  private file: { ino: number; mtimeMs: number } | null = null;
  private asOf = "";
  private refs = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private warm = false;

  constructor(private readonly open: OpenSpec, private readonly timezone: string, private readonly lingerMs: number,
    private readonly spawn: () => QueryWorker) {}

  get path(): string {
    return this.open.path;
  }

  /** Whether there is a copy to answer from: a stat, never an open. */
  exists(): boolean {
    try {
      return statSync(this.path).isFile();
    } catch {
      return false;
    }
  }

  /** Keep a spare worker ready (the live file is closed for a writer), or stop keeping one. */
  keepWarm(on: boolean): void {
    this.warm = on;
    if (on) {
      if (this.exists()) this.spare ??= this.spawn();
    } else {
      void this.spare?.kill();
      this.spare = null;
    }
  }

  /** The worker on the copy and the copy's asOf. Throws when the copy cannot be opened or served. */
  async take(): Promise<{ worker: QueryWorker; asOf: string }> {
    this.refs++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      const worker = await this.ready();
      return { worker, asOf: this.asOf };
    } catch (e) {
      this.leave();
      throw e;
    }
  }

  /** A query on the copy settled. */
  give(): void {
    this.leave();
  }

  /** Kill the worker now if no query uses the copy (the engine stops); otherwise the last one does. */
  close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.refs > 0 || this.opening) return Promise.resolve();
    return this.drop();
  }

  /** Stop for good: the worker and the spare. */
  async stop(): Promise<void> {
    this.keepWarm(false);
    await this.close();
  }

  private drop(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    this.file = null;
    if (this.warm) this.spare ??= this.spawn();
    return w ? w.kill() : Promise.resolve();
  }

  private leave(): void {
    if (--this.refs > 0) return;
    this.timer = setTimeout(() => void this.close(), this.lingerMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async ready(): Promise<QueryWorker> {
    // A worker that died, or a copy renamed into place since it opened (unless a query still reads the old one).
    if (this.worker && (!this.worker.alive || (this.refs === 1 && !this.opening && this.replaced()))) void this.drop();
    if (this.worker) return this.worker;
    this.opening ??= (async () => {
      // The stat comes first: if a rename lands in between, asOf is older than the data, never newer.
      const st = statSync(this.path);
      const w = this.spare?.alive ? this.spare : this.spawn();
      this.spare = null;
      try {
        await w.open(this.open); // DB_NEWER_FORMAT, as for the live file
      } catch (e) {
        void w.kill();
        throw e;
      }
      this.worker = w;
      this.file = { ino: st.ino, mtimeMs: st.mtimeMs };
      this.asOf = formatInstant(Math.round(st.mtimeMs), this.timezone);
      return w;
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
  /** The worker with the live file open (state open or stepping aside), else null. */
  private worker: QueryWorker | null = null;
  /** A worker started ahead, with no file open, for the next open. */
  private spare: QueryWorker | null = null;
  /** The worker a reopen is opening the file in. */
  private opening: QueryWorker | null = null;
  private readonly admission: Admission;
  private readonly watch: IntentWatch;
  private readonly live: OpenSpec;
  private readonly hooks: ServeEngineHooks;
  private readonly maxConcurrent: number;
  private readonly queueMs: number;
  private readonly queryTimeoutMs: number;
  private readonly graceMs: number;
  private readonly pollMs: number;
  private readonly maxBytes: number;
  private readonly maxRows: number;
  private readonly maxQueued: number;
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
  private seq = 0;
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
    this.maxRows = o.maxRows ?? (serve as { maxRows?: number }).maxRows ?? SERVE_DEFAULTS.maxRows;
    this.maxQueued = o.maxQueued ?? SERVE_DEFAULTS.maxQueued;
    const killAfterMs = o.killAfterMs ?? SERVE_DEFAULTS.killAfterMs;
    this.hooks = guarded(o.hooks ?? {});
    const spec: SandboxSpec = { profile: "serve", timezone: project.timezone, root: project.root, stateDir: project.paths.stateDir, ...serveResources(), ...o.resources };
    const protect = [project.paths.stateDir];
    this.live = { path: canonicalPath(project.paths.database), spec, protect };
    const admissionOf = (unavailable: (waitedMs: number) => CroftError, copy: boolean) => new Admission({
      maxConcurrent: this.maxConcurrent,
      maxQueued: this.maxQueued,
      interruptEveryMs: o.interruptEveryMs ?? SERVE_DEFAULTS.interruptEveryMs,
      stuckAfterMs: killAfterMs,
      unavailable,
      aborted: () => this.stopError("abort"),
      full: () => this.queueFull(copy),
    });
    this.admission = admissionOf((waitedMs) => this.notAdmitted(waitedMs), false);
    this.watch = new IntentWatch({ stateDir: project.paths.stateDir, pollMs: this.pollMs, onTick: () => this.tick(), watch: o.watch });
    this.copy = project.config.readCopy
      ? new ReadCopySource({ path: canonicalPath(project.paths.readCopy), spec, protect }, project.timezone, SERVE_DEFAULTS.copyLingerMs, () => QueryWorker.spawn())
      : null;
    this.copyAdmission = admissionOf((waitedMs) => this.copyBusy(waitedMs), true);
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
      this.spare = this.spawn();
      this.copy?.keepWarm(true);
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
      openConnections: this.worker?.conns ?? 0,
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
    // Admitted only while open; the worker may have died since (it is being replaced), and then query() fails.
    const worker = this.worker;
    try {
      if (!worker) throw this.restarted(null);
      return await this.answer(worker, flight, q, arrived);
    } catch (e) {
      throw this.queryError(e, flight);
    } finally {
      clearTimeout(timer);
      q.signal?.removeEventListener("abort", onAbort);
      this.ended(worker);
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
    let lease: { worker: QueryWorker; asOf: string } | null = null;
    try {
      try {
        lease = await copy.take();
      } catch {
        return null;
      }
      const data = await this.answer(lease.worker, flight, q, arrived);
      return { ...data, stale: true, asOf: lease.asOf };
    } catch (e) {
      throw this.queryError(e, flight);
    } finally {
      clearTimeout(timer);
      q.signal?.removeEventListener("abort", onAbort);
      if (lease) {
        copy.give();
        this.ended(lease.worker);
        if (count) this.countQuery();
      }
      flight.release();
    }
  }

  /** The query in `worker`: the gate, the statement streamed within the limits, the rows as the client parses them.
   *  A flight that cannot be stopped by interrupts is ended by killing the worker (Flight.stop, stuckAfterMs). */
  private async answer(worker: QueryWorker, flight: Flight, q: ServeQuery, arrived: number): Promise<ServeQueryData> {
    const id = ++this.seq;
    flight.attach({ interrupt: () => worker.interrupt(id), abandon: () => void worker.kill() });
    flight.checkpoint();
    const a = await worker.query(id, { sql: q.sql, params: q.params, limit: q.limit, maxRows: this.maxRows, maxBytes: this.maxBytes });
    const rows = JSON.parse(a.rowsJson) as ServeQueryData["rows"];
    return { columns: a.columns, rows, rowCount: a.rowCount, tookMs: Math.round(performance.now() - arrived) };
  }

  /** What a failed query reports: why it was stopped, if it was; the worker going away under it; or its own error. */
  private queryError(e: unknown, flight: Flight): unknown {
    if (flight.reason) return this.stopError(flight.reason);
    if (e instanceof WorkerGone) return this.restarted(e);
    if (e instanceof WorkerStopped) return this.stopError("stop"); // never asked for; defensive
    return mapQueryError(e, "serve");
  }

  private ended(worker: QueryWorker | null): void {
    if (worker) this.hooks.queryEnded?.({ workerPid: worker.pid, workerPeakRss: worker.peakRss, at: Date.now() });
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.stopped = true;
      this.watch.stop();
      this.admission.close(this.stopError("stop"));
      this.copyAdmission.close(this.stopError("stop"));
      // No grace: the server is going away. Queries that interrupts cannot stop are ended with their worker.
      for (const f of [...this.admission.active, ...this.copyAdmission.active]) f.stop("stop");
      await Promise.all([this.admission.idle(), this.copyAdmission.idle()]);
      await this.copy?.stop();
      void this.opening?.kill(); // an open in progress fails and leaves the rest to us
      await this.transition;
      await this.release("stop");
      const spare = this.spare;
      this.spare = null;
      await spare?.kill();
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
    this.copy?.keepWarm(true);
    this.hooks.steppingAside?.({ intent, at: Date.now() });
    // Stuck queries are ended with the worker after killAfterMs (Flight.stop), so this always finishes.
    await drain(this.admission, { graceMs: this.graceMs, reason: "write" });
    if (this.stopped) return; // close() releases the file
    await this.release("write");
    this.state = "closed_for_write";
    this.spare ??= this.spawn(); // the next open only has to open the file
  }

  /** Steps 3–4: disconnect every connection, then kill the worker and wait for its exit. */
  private async release(reason: CloseReason): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    this.worker = null;
    const open = await worker.disconnect(SERVE_DEFAULTS.disconnectWaitMs);
    this.hooks.beforeClose?.({ openConnections: open, reason, at: Date.now() });
    await worker.kill();
    this.hooks.released?.({ intent: reason === "write" ? this.intent : null, reason, at: Date.now() });
  }

  private async reopen(): Promise<void> {
    this.state = "reopening";
    if (!existsSync(this.live.path)) { // a stat: never opens the file
      this.block(this.notFound());
      this.retryAt = Date.now() + this.pollMs;
      return;
    }
    const worker = this.spare?.alive ? this.spare : this.spawn();
    this.spare = null;
    this.opening = worker;
    try {
      await worker.open(this.live);
    } catch (e) {
      this.opening = null;
      if (this.stopped) {
        void worker.kill();
        return;
      }
      if (e instanceof WorkerConflict) {
        // A program without an intent holds it: a GUI, or a writer that withdrew its intent because of one.
        // The file exists and will open once it lets go: queries wait rather than fail. The worker opened
        // nothing, so it tries again.
        this.spare = worker;
        this.foreign = { program: e.program, pid: e.pid };
        this.blocked = null;
        this.retryAt = Date.now() + backoffMs(this.attempts++);
        return;
      }
      void worker.kill();
      this.block(e instanceof CroftError ? e : e instanceof WorkerGone ? this.workerFailed(e) : this.unreadable(e));
      this.retryAt = Date.now() + 1000;
      return;
    }
    this.opening = null;
    this.worker = worker;
    this.foreign = null;
    this.attempts = 0;
    if (this.stopped) return; // close() releases it
    this.blocked = null;
    this.state = "open";
    this.copy?.keepWarm(false);
    this.hooks.opened?.({ at: Date.now() });
    // A writer that announced itself while the file opened goes first: the next tick steps aside at once.
    if (this.watch.candidates().length === 0) this.admission.resume();
  }

  private spawn(): QueryWorker {
    return QueryWorker.spawn({ onExit: (w) => this.exited(w) });
  }

  /** A worker exited. While it served (a stuck query's kill, the OOM killer, a crash), the file is reopened in a
   *  new one; its queries have failed already. A handoff or a stop releases its worker itself. */
  private exited(w: QueryWorker): void {
    if (w === this.spare) this.spare = null;
    if (w !== this.worker || this.state !== "open" || this.stopped) return;
    this.worker = null;
    this.admission.pause();
    this.state = "reopening";
    this.retryAt = 0;
    this.tick();
  }

  private block(err: CroftError): void {
    this.blocked = err;
    this.admission.fail(err);
  }

  // ---- results ------------------------------------------------------------------------------------------

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

  /** A query refused because maxQueued already wait. */
  private queueFull(copy: boolean): CroftError {
    if (this.stopped) return this.stopError("stop");
    return new CroftError("SERVE_UNAVAILABLE", {
      message: `${this.maxQueued} queries are already waiting for croft's read server${copy ? " (answering from the read copy)" : this.intent ? ` (${this.writer(this.intent)} is writing)` : ""}; this one was not queued`,
      hint: "retry after Retry-After; send fewer queries at once, or make them cheaper (filter or aggregate in SQL) so the slots free up sooner",
      retryable: true,
      details: { reason: "busy", retryAfterMs: SERVE_DEFAULTS.retryAfterMs, maxQueued: this.maxQueued, maxConcurrent: this.maxConcurrent },
    });
  }

  /** A query that ran in a worker which went away under it (killed for another, stuck query, or crashed). */
  private restarted(e: WorkerGone | null): CroftError {
    return new CroftError("SERVE_UNAVAILABLE", {
      message: "croft's read server restarted its query worker while this query ran (to end another query that interrupts could not stop, or after a crash); it returned nothing",
      hint: "retry after Retry-After; if it keeps failing, the query itself may be too heavy: filter or aggregate in SQL",
      retryable: true,
      details: { reason: "restarted", retryAfterMs: SERVE_DEFAULTS.retryAfterMs, worker: e?.message ?? null },
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

  /** The query worker could not start (or died while opening the file). */
  private workerFailed(e: WorkerGone): CroftError {
    return new CroftError("INTERNAL_ERROR", {
      message: `croft serve could not start its query worker: ${e.message}`,
      hint: "run croft doctor to check the installation; croft serve retries every second; if it keeps failing, report this croft bug with the message",
      fix: { kind: "command", description: "check croft's installation", command: "croft doctor" },
      details: { database: this.project.paths.database, worker: e.message },
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
