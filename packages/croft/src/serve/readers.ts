// croft serve's query engine in server mode (DESIGN.md D119, §5 "Server mode, apps and GUIs"; "serverMode" in croft.json): the
// readers' process on the read copy. The file engine (serve/instance.ts) holds the live warehouse and steps aside for
// every writer; this one never opens the live file, holds no lock on it and creates no write intent, so no writer ever
// waits for croft serve and no query ever waits for a writer.
//
// What it runs:
// - one child process, the readers' process (serve/worker.ts with `readers`): an in-memory DuckDB instance that loads
//   quack and httpfs by path, attaches the read copy READ_ONLY as `wh`, and is locked down to the copy's path
//   (db/modes.ts, kind "readers"). Its connections run `USE wh`, so the serve gate and the queries see the copy exactly as
//   they see the live file in file mode (D112, D76);
// - the copy's identity (device, inode, mtime and size of `<database>.read.duckdb`) checked every copyPollMs (250 ms), the
//   way croft serve polls the write-intent folder in file mode, and never through file-system events, which merge and drop
//   on macOS. The refresh runs in the `croft run` process (db/readcopy.ts) and renames a new clone over the copy, which
//   changes the inode. On a change the engine sends `swap`; the process detaches the old file and attaches the new one,
//   2 to 10 ms [V: 2.0.0], and a query started meanwhile waits for it;
// - the copy's as-of time, the copy's mtime (the checkpoint it was taken at) in the project offset, read before the
//   swap, so it is never newer than the data. Every answer carries it as `asOf`. Nothing is "stale" here: every answer
//   is from the copy, and says when that was.
//
// Killing: a query that interrupts cannot stop, past its deadline, ends with the readers' process (SIGKILL, as the file
// engine's worker, D76). Every query running there fails with a retryable SERVE_UNAVAILABLE (reason "restarted"), and
// a new process starts at once. A process that fails to start its mode, or to swap, ends itself and is replaced after a
// backoff (0, 250 ms, 500 ms, 1 s, ... 60 s): the instance it had is part set up and is never reused (connect.ts marks it).
// Queries wait for the replacement up to queueMs and then get a 503; a start that fails for a reason a retry will not fix
// (a missing extension file, a copy from a newer croft) answers every query with that error until it is fixed.
//
// A copy that is missing, behind or failed is made by a child process (copy-maker.ts), not here: this engine never opens the
// live file. Until a missing copy exists every query is a retryable 503 (DB_NOT_FOUND when there is no warehouse yet).
//
// Limits, admission, the deadline and the row and byte limits are the file engine's (queue.ts, worker.ts answer()).
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { formatInstant, now, zonedParts } from "../core/time.ts";
import { canonicalPath, type SandboxSpec, serveResources } from "../db/connect.ts";
import { assertCopyPolicy, assessCopyPolicy, type CloneProbe, copyCostlyProblem, type ProbeOptions, type ThresholdOption } from "../db/copy-policy.ts";
import { assertSafeFilesystem, type FsProbe, realProbe } from "../db/fs-kind.ts";
import { loadProject, type Project } from "../project/root.ts";
import { mapQueryError } from "../read/select.ts";
import { COPY_CHECK_MS, CopyMaker, type CopyMakerOptions } from "./copy-maker.ts";
import { assertQuackAddress, KeyFollower, spawnQuackWorker } from "./engine-quack.ts";
import { KeyStore } from "./keys.ts";
import { noSharedTables, notAdmittedError, queueFullError, restartedError, stopError } from "./errors.ts";
import { SERVE_DEFAULTS, serveLimits } from "./instance.ts";
import { Admission, type Flight, type StopReason } from "./queue.ts";
import { QueryWorker, WorkerGone, WorkerStopped } from "./query-worker.ts";
import type { ServeEngine, ServeEngineOptions, ServeEngineStatus, ServeQuery, ServeQueryData } from "./types.ts";

/** How often the copy's identity is checked. */
export const COPY_POLL_MS = 250;
/** A readers' process that dies within this long of opening counts as a failed start for the backoff. */
const QUICK_DEATH_MS = 2000;

/** Instrumentation points (tests, diagnostics). Each gets the wall-clock time it happened. */
export interface ReadersEngineHooks {
  /** A readers' process opened and queries are admitted. */
  opened?(e: { pid: number; asOf: string; at: number }): void;
  /** The copy was swapped in; `asOf` is its as-of time. */
  swapped?(e: { asOf: string; ms: number; at: number }): void;
  /** The readers' process exited (killed for a deadline, crashed, or failed to start). */
  exited?(e: { pid: number; at: number }): void;
  /** A Quack query ran past the deadline; the process is being killed (D127). */
  quackOverdue?(e: { pid: number; ms: number; at: number }): void;
  /** The keys the process accepts over Quack were sent again (the keys file changed, D126). */
  keysSent?(e: { names: string[]; at: number }): void;
  /** A query ended (answered or not) on the process `workerPid`. */
  queryEnded?(e: { workerPid: number; workerPeakRss: number; at: number }): void;
}

/** Options the command does not pass: tests and diagnostics. */
export interface ReadersEngineInternals {
  hooks?: ReadersEngineHooks;
  fs?: FsProbe;
  maxBytes?: number;
  maxRows?: number;
  maxQueued?: number;
  killAfterMs?: number;
  resources?: Partial<{ memoryLimit: string; threads: number }>;
  interruptEveryMs?: number;
  /** COPY_POLL_MS by default. */
  copyPollMs?: number;
  /** A folder of the pinned extension files, for croft's tests; by default $CROFT_EXTENSION_DIR or croft's cache (D195). */
  extensionDir?: string;
  /** Where the readers' process listens for DuckDB clients (serverMode.quackHost and quackPort by default); false: nowhere,
   *  for a test that wants no listener. */
  quack?: false | { host: string; port: number; maxConcurrent?: number };
  /** How the copy policy tries to clone (db/copy-policy.ts), for tests. */
  policy?: ProbeOptions & ThresholdOption & { clone?: CloneProbe };
  /** The readers' process command (tests); `bun --no-env-file worker.ts` by default. */
  workerArgv?: string[];
  /** The wait before the next try after `attempts` failed starts; restartDelayMs by default. */
  restartDelayMs?: (attempts: number) => number;
  /** Make the copy in a child process when it is missing, behind or failed (serve/copy-maker.ts); on by default. false
   *  for a test of an engine that must see no copy appear by itself; an object overrides the maker's command and waits. */
  copyMaker?: boolean | Omit<CopyMakerOptions, "project">;
}

/** The longest wait between starts: every try checks the pinned extension files again (about 66 MB hashed), so a start
 *  that keeps failing is tried once a minute, not every few seconds. */
const RESTART_CEILING_MS = 60_000;

/** The wait before starting the readers' process again after `attempts` starts in a row failed: none the first time. */
export function restartDelayMs(attempts: number): number {
  return attempts <= 0 ? 0 : Math.min(RESTART_CEILING_MS, 250 * 2 ** (attempts - 1));
}

/** A file's identity: replaced (renamed over) means another inode; the rest is defence against a reused one. */
interface CopyIdentity { dev: number; ino: number; mtimeMs: number; size: number }

function statIdentity(path: string): CopyIdentity | null {
  try {
    const st = statSync(path);
    return st.isFile() ? { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, size: st.size } : null;
  } catch {
    return null;
  }
}

const sameIdentity = (a: CopyIdentity, b: CopyIdentity) => a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size;

/** Open the readers' engine for a project. Throws SERVER_MODE_COPY_COSTLY where the copy policy refuses server mode,
 *  SERVE_UNSAFE_FILESYSTEM for a warehouse on a filesystem whose locks cannot be trusted, and the mode's own errors
 *  (EXTENSION_MISSING and the others, DB_NEWER_FORMAT) when the first start fails. */
export async function openReadersEngine(o: ServeEngineOptions & ReadersEngineInternals): Promise<ServeEngine> {
  const project = loadProject({ root: o.root });
  assertSafeFilesystem({ root: project.root, database: project.paths.database, stateDir: project.paths.stateDir }, o.fs ?? realProbe);
  assertCopyPolicy(project, o.policy);
  const engine = new ReadersEngine(project, o);
  engine.assertQuackAddress();
  await engine.start();
  return engine;
}

class ReadersEngine implements ServeEngine {
  private state: "waiting" | "starting" | "open" | "restarting" | "stopped" = "waiting";
  /** The readers' process that serves, or null. */
  private worker: QueryWorker | null = null;
  /** The process a start is opening, or null. */
  private opening: QueryWorker | null = null;
  /** The copy the process has attached, and its as-of time in the project offset. */
  private attached: CopyIdentity | null = null;
  private asOf: string | null = null;
  private readonly admission: Admission;
  private readonly hooks: ReadersEngineHooks;
  private readonly spec: SandboxSpec;
  private readonly protect: string[];
  private readonly copyPath: string;
  private readonly secretDir: string;
  private readonly extensionDir: string | undefined;
  private readonly maxConcurrent: number;
  private readonly queueMs: number;
  private readonly queryTimeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxRows: number;
  private readonly maxQueued: number;
  private readonly pollMs: number;
  private readonly argv: string[] | undefined;
  private readonly policy: (ProbeOptions & ThresholdOption & { clone?: CloneProbe }) | undefined;
  private readonly delayOf: (attempts: number) => number;
  private readonly quackAt: { host: string; port: number; maxConcurrent: number } | null;
  private readonly onQuack: ServeEngineOptions["onQuack"];
  /** Follows the keys file for the Quack hooks (D126); the engine never writes it. */
  private readonly keys: KeyFollower;
  private quackUri: string | null = null;
  /** Why queries are refused until something changes (no copy yet; a start that a retry will not fix); null otherwise. */
  private blocked: CroftError | null = null;
  private transition: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Makes the read copy in a child process when it is missing, behind or failed; null when turned off. */
  private readonly maker: CopyMaker | null;
  private lastCopyCheck = 0;
  private stopped = false;
  private closing: Promise<void> | null = null;
  private attempts = 0;
  private retryAt = 0;
  private openedAt = 0;
  private swaps = 0;
  private restarts = 0;
  private seq = 0;
  private day = "";
  private count = 0;

  constructor(private readonly project: Project, o: ServeEngineOptions & ReadersEngineInternals) {
    const limits = serveLimits(project, o);
    this.maxConcurrent = limits.maxConcurrent;
    this.queueMs = limits.queueMs;
    this.queryTimeoutMs = limits.queryTimeoutMs;
    this.maxBytes = limits.maxBytes;
    this.maxRows = limits.maxRows;
    this.maxQueued = limits.maxQueued;
    this.pollMs = o.copyPollMs ?? COPY_POLL_MS;
    this.argv = o.workerArgv;
    this.policy = o.policy;
    this.maker = o.copyMaker === false ? null : new CopyMaker({ project, ...(typeof o.copyMaker === "object" ? o.copyMaker : {}) });
    this.delayOf = o.restartDelayMs ?? restartDelayMs;
    const sm = project.config.serverMode;
    this.quackAt = o.quack === false ? null : { host: sm.quackHost, port: sm.quackPort, maxConcurrent: sm.quackMaxConcurrent, ...o.quack };
    this.onQuack = o.onQuack;
    this.keys = new KeyFollower(new KeyStore(project.paths.stateDir));
    this.hooks = guarded(o.hooks ?? {});
    this.spec = { profile: "serve", timezone: project.timezone, root: project.root, stateDir: project.paths.stateDir, ...serveResources(), ...o.resources };
    this.protect = [project.paths.stateDir];
    this.copyPath = canonicalPath(project.paths.readCopy);
    this.secretDir = join(project.paths.stateDir, "readers-secrets");
    this.extensionDir = o.extensionDir;
    this.admission = new Admission({
      maxConcurrent: this.maxConcurrent,
      maxQueued: this.maxQueued,
      interruptEveryMs: o.interruptEveryMs ?? SERVE_DEFAULTS.interruptEveryMs,
      stuckAfterMs: o.killAfterMs ?? SERVE_DEFAULTS.killAfterMs,
      unavailable: (waitedMs) => this.notAdmitted(waitedMs),
      aborted: () => this.stopError("abort"),
      full: () => this.queueFull(),
    });
  }

  /** The listener's address must be loopback, or the project must have accepted plaintext on the network (D131). */
  assertQuackAddress(): void {
    assertQuackAddress(this.quackAt, this.project.config.serverMode.quackPlaintextOnNetwork);
  }

  /** First open. A copy that is not there yet is waited for (the first run that changes data makes it); a start that
   *  fails fails croft serve's start, with the error that says why. */
  async start(): Promise<void> {
    const id = statIdentity(this.copyPath);
    if (!id) {
      this.block(this.noCopy());
    } else {
      try {
        await this.open(id);
      } catch (e) {
        await this.close();
        throw e instanceof CroftError ? e : this.workerFailed(e);
      }
    }
    this.timer = setInterval(() => this.tick(), this.pollMs);
    // The HTTP server keeps croft serve alive; the poll alone never should.
    (this.timer as { unref?: () => void }).unref?.();
    // A copy that is missing, behind or failed is made now, in a child; start does not wait for it.
    this.lastCopyCheck = Date.now();
    this.maker?.check();
  }

  /** Set when the warehouse has grown past the copy limit since croft serve started (or the setting changed): refreshes
   *  carry on, so answers keep coming, but each one is a full copy the project has not accepted (D121). A stat and a
   *  probe that runs once, so it is cheap on every status. */
  private copyCost(): { code: string; message: string } | null {
    const policy = assessCopyPolicy(this.project, this.policy);
    return policy.refused ? { code: "SERVER_MODE_COPY_COSTLY", message: copyCostlyProblem(policy, "limit").message } : null;
  }

  status(): ServeEngineStatus {
    return {
      state: this.state === "open" ? "open" : this.state === "stopped" ? "stopped" : "reopening",
      writeIntent: null,
      inFlight: this.admission.inFlight,
      queued: this.admission.queued,
      openConnections: this.worker?.conns ?? 0,
      queriesToday: this.dayKey() === this.day ? this.count : 0,
      serverMode: {
        state: this.state,
        copy: this.project.paths.readCopy,
        asOf: this.asOf,
        workerPid: this.worker?.pid ?? null,
        swaps: this.swaps,
        makingCopy: this.maker?.running ?? false,
        restarts: this.restarts,
        copyCost: this.copyCost(),
        quack: this.quackUri ? { uri: this.quackUri } : null,
      },
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
    if (q.scope && q.scope.tables.length === 0) throw noSharedTables();
    if (this.stopped) throw this.stopError("stop");
    if (this.blocked && this.state !== "open") throw this.blocked;
    const flight = await this.admission.enter({ deadline: arrivedAt + this.queueMs, signal: q.signal });
    const timer = setTimeout(() => flight.stop("timeout"), this.queryTimeoutMs);
    const onAbort = () => flight.stop("abort");
    q.signal?.addEventListener("abort", onAbort, { once: true });
    // Admitted only while open; the process may have died since (it is being replaced), and then the query fails.
    const worker = this.worker;
    try {
      if (!worker) throw this.restarted(null);
      return await this.answer(worker, flight, q, arrived);
    } catch (e) {
      throw this.queryError(e, flight);
    } finally {
      clearTimeout(timer);
      q.signal?.removeEventListener("abort", onAbort);
      if (worker) this.hooks.queryEnded?.({ workerPid: worker.pid, workerPeakRss: worker.peakRss, at: Date.now() });
      this.countQuery();
      flight.release();
    }
  }

  /** The query in `worker`: the gate, the statement streamed within the limits, the rows as the client parses them. The
   *  as-of time is read when the query is sent: a swap that finishes while it runs does not move it, and one still
   *  running makes it older than the data, never newer. A flight that interrupts cannot stop is ended by killing the
   *  readers' process (Flight.stop, stuckAfterMs). */
  private async answer(worker: QueryWorker, flight: Flight, q: ServeQuery, arrived: number): Promise<ServeQueryData> {
    const id = ++this.seq;
    flight.attach({ interrupt: () => worker.interrupt(id), abandon: () => void worker.kill() });
    flight.checkpoint();
    const asOf = this.asOf ?? undefined;
    const a = await worker.query(id, {
      sql: q.sql, params: q.params, limit: q.limit, maxRows: this.maxRows, maxBytes: this.maxBytes, ...(q.scope ? { shared: [...q.scope.tables] } : {}),
    });
    const rows = JSON.parse(a.rowsJson) as ServeQueryData["rows"];
    return {
      columns: a.columns, rows, rowCount: a.rowCount, tookMs: Math.round(performance.now() - arrived), ...(asOf ? { asOf } : {}),
      ...(q.scope ? { tables: a.tables } : {}),
    };
  }

  private queryError(e: unknown, flight: Flight): unknown {
    if (flight.reason) return this.stopError(flight.reason);
    if (e instanceof WorkerGone) return this.restarted(e);
    if (e instanceof WorkerStopped) return this.stopError("stop"); // never asked for; defensive
    return mapQueryError(e, "serve");
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.stopped = true;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.admission.close(this.stopError("stop"));
      // No grace: the server is going away. Queries that interrupts cannot stop are ended with their process.
      for (const f of [...this.admission.active]) f.stop("stop");
      await this.admission.idle();
      await this.maker?.stop();
      void this.opening?.kill(); // a start in progress fails and leaves the rest to us
      await this.transition;
      // The readers' process goes first: it is the only thing that holds the copy, and nothing outlives croft serve.
      const worker = this.worker;
      this.worker = null;
      await worker?.kill();
      this.state = "stopped";
    })();
    return this.closing;
  }

  // ---- the copy, and the process ---------------------------------------------------------------------------

  /** On every poll. Starts at most one transition at a time; each re-checks when it ends. */
  private tick(): void {
    if (this.stopped) return;
    if (this.maker && Date.now() - this.lastCopyCheck >= COPY_CHECK_MS) {
      this.lastCopyCheck = Date.now();
      this.maker.check();
    }
    this.keys.send(this.worker, (names) => this.hooks.keysSent?.({ names, at: Date.now() }));
    if (this.transition) return;
    const id = statIdentity(this.copyPath);
    if (!this.worker) {
      if (!id) {
        const err = this.noCopy();
        if (this.blocked?.message !== err.message) this.block(err);
        return;
      }
      if (Date.now() < this.retryAt) return;
      this.begin(this.reopen(id));
      return;
    }
    if (id && this.attached && !sameIdentity(id, this.attached)) this.begin(this.swap(id));
  }

  private begin(p: Promise<void>): void {
    this.transition = p
      .catch(() => {}) // every failure is recorded (blocked, or a restart) by the transition itself
      .finally(() => {
        this.transition = null;
        if (!this.stopped) this.tick();
      });
  }

  /** Start the readers' process on the copy now at `id`. Throws what the process reported (the first start's caller
   *  reports it; later ones are recorded by reopen). */
  private async open(id: CopyIdentity): Promise<void> {
    this.state = this.restarts > 0 || this.attempts > 0 ? "restarting" : "starting";
    const worker = spawnQuackWorker({
      onExit: (w) => this.exited(w),
      onQuack: (e) => this.onQuack?.(e),
      overdue: (o) => this.hooks.quackOverdue?.({ ...o, at: Date.now() }),
      ...(this.argv ? { argv: this.argv } : {}),
    });
    this.opening = worker;
    const asOf = formatInstant(Math.round(id.mtimeMs), this.project.timezone);
    this.keys.read(); // the process opens with the keys as they are now
    let opened: Awaited<ReturnType<QueryWorker["open"]>>;
    try {
      opened = await worker.open({
        path: this.copyPath, spec: this.spec, protect: this.protect,
        readers: {
          ...(this.extensionDir ? { extensionDir: this.extensionDir } : {}), secretDir: this.secretDir, shared: [...this.project.config.serve.sharedTables], asOf,
          ...(this.quackAt ? { quack: { ...this.quackAt, queryTimeoutMs: this.queryTimeoutMs, keys: this.keys.current } } : {}),
        },
      });
    } catch (e) {
      this.opening = null;
      void worker.kill();
      throw e;
    }
    this.opening = null;
    if (this.stopped) {
      void worker.kill();
      return;
    }
    this.worker = worker;
    this.attached = id;
    this.asOf = asOf;
    this.quackUri = opened.quack?.uri ?? null;
    worker.setKeys(this.keys.current); // a change while it opened was read but not sent
    this.state = "open";
    this.blocked = null;
    this.openedAt = Date.now();
    this.hooks.opened?.({ pid: worker.pid, asOf: this.asOf, at: Date.now() });
    this.admission.resume();
  }

  /** A later start (after the process ended, or the copy appeared): what fails is recorded, not thrown. */
  private async reopen(id: CopyIdentity): Promise<void> {
    try {
      // attempts is not reset here: a process that dies soon after it opens counts against the next start (exited()).
      await this.open(id);
    } catch (e) {
      if (this.stopped) return;
      this.attempts++;
      this.retryAt = Date.now() + this.delayOf(this.attempts);
      this.state = "restarting";
      // A WorkerGone is a process that died on its way up: queries wait for the next try. Anything else (a missing
      // extension file, a copy from a newer croft) is not mended by trying again: queries are refused with it.
      if (e instanceof WorkerGone) {
        this.blocked = null;
        this.admission.pause();
      } else this.block(e instanceof CroftError ? e : this.workerFailed(e));
    }
  }

  /** Take a replaced copy in. The identity is read before, so the as-of time is never newer than the data. */
  private async swap(id: CopyIdentity): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    const started = performance.now();
    try {
      await worker.swap(formatInstant(Math.round(id.mtimeMs), this.project.timezone));
    } catch {
      // The process could not take the copy in and is part set up, or it died: it goes now (its answer to the swap has
      // been read), and exited() starts another. Queries waiting for it are told to retry.
      void worker.kill();
      return;
    }
    if (this.worker !== worker) return;
    this.attached = id;
    this.asOf = formatInstant(Math.round(id.mtimeMs), this.project.timezone);
    this.swaps++;
    this.hooks.swapped?.({ asOf: this.asOf, ms: Math.round(performance.now() - started), at: Date.now() });
  }

  /** A process exited. While it served (a deadline's kill, the OOM killer, a crash), another starts at once, or after a
   *  backoff when it died soon after it opened; its queries have failed already. A stop releases it itself. */
  private exited(w: QueryWorker): void {
    this.hooks.exited?.({ pid: w.pid, at: Date.now() });
    if (w !== this.worker || this.stopped) return;
    this.worker = null;
    this.attached = null;
    this.asOf = null;
    this.quackUri = null;
    this.restarts++;
    // A process we ended (a deadline) is replaced at once; one that died by itself soon after it opened counts against the backoff.
    this.attempts = !w.stoppedByUs && Date.now() - this.openedAt < QUICK_DEATH_MS ? this.attempts + 1 : 0;
    this.retryAt = Date.now() + this.delayOf(this.attempts);
    this.state = "restarting";
    this.admission.pause();
    this.tick();
  }

  private block(err: CroftError): void {
    this.blocked = err;
    this.admission.fail(err);
  }

  // ---- results ---------------------------------------------------------------------------------------------

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

  // ---- errors ----------------------------------------------------------------------------------------------

  /** Why a query was not admitted within queueMs. */
  private notAdmitted(waitedMs: number): CroftError {
    if (this.stopped) return this.stopError("stop");
    return notAdmittedError({ what: "readers' process for the read copy", waitedMs, state: this.state, attempts: this.attempts, maxConcurrent: this.maxConcurrent });
  }

  /** A query refused because maxQueued already wait. */
  private queueFull(): CroftError {
    return this.stopped ? this.stopError("stop") : queueFullError(this.maxQueued, this.maxConcurrent);
  }

  private restarted(e: WorkerGone | null): CroftError {
    return restartedError(e, "readers' process");
  }

  private stopError(reason: StopReason): CroftError {
    // A readers' engine never steps aside for a writer, so "write" is not a reason a flight here can have.
    return stopError(reason === "write" ? "stop" : reason, { queryTimeoutMs: this.queryTimeoutMs });
  }

  /**
   * No read copy yet. Where the warehouse exists, croft serve is making the copy in a child process (serve/copy-maker.ts)
   * and the query is told to retry (a 503); with no warehouse yet, or the maker off, it is DB_NOT_FOUND until a run makes it.
   */
  private noCopy(): CroftError {
    if (this.maker && existsSync(this.project.paths.database)) {
      const failed = this.maker.lastFailure;
      return new CroftError("SERVE_UNAVAILABLE", {
        message: failed
          ? `the read copy ${this.project.paths.readCopy} does not exist yet, and the last try to make it failed: ${failed}`
          : `the read copy ${this.project.paths.readCopy} does not exist yet; croft serve is making it from the warehouse`,
        hint: failed
          ? "retry after Retry-After; croft doctor and .croft/readcopy.log say what is wrong, and croft serve tries again"
          : "retry after Retry-After: the copy is ready within seconds for a warehouse of ordinary size",
        retryable: true,
        details: { reason: "making_copy", retryAfterMs: SERVE_DEFAULTS.retryAfterMs, readCopy: this.project.paths.readCopy, serverMode: true },
      });
    }
    return new CroftError("DB_NOT_FOUND", {
      message: `the read copy ${this.project.paths.readCopy} does not exist yet; in server mode croft serve answers from it`,
      hint: "the copy is made at the end of every run that changes data; run an asset, and croft serve picks the copy up within a second",
      fix: { kind: "command", description: "build the assets", command: "croft run" },
      details: { readCopy: this.project.paths.readCopy, serverMode: true },
    });
  }

  /** The readers' process could not start (or died while it opened the copy). */
  private workerFailed(e: unknown): CroftError {
    const message = e instanceof Error ? e.message : String(e);
    return new CroftError("INTERNAL_ERROR", {
      message: `croft serve could not start its readers' process: ${message.split("\n")[0]}`,
      hint: "run croft doctor to check the installation; croft serve retries with a backoff; if it keeps failing, report this croft bug with the message",
      fix: { kind: "command", description: "check croft's installation", command: "croft doctor" },
      details: { readCopy: this.project.paths.readCopy, worker: message.split("\n")[0] },
    });
  }
}

/** Hooks that cannot break the engine: one that throws is ignored. */
function guarded(h: ReadersEngineHooks): ReadersEngineHooks {
  const out: ReadersEngineHooks = {};
  for (const [name, fn] of Object.entries(h) as [keyof ReadersEngineHooks, ((e: unknown) => void) | undefined][]) {
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
