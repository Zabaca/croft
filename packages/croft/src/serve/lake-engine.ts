// croft serve's query engine for a lake project (DESIGN.md D143; option 07, slice 2): the lake's last snapshot, read in a child process
// with the read-only catalog login and the read-only bucket key. The file engine (serve/instance.ts) holds the live warehouse and steps
// aside for every writer; the readers' engine (serve/readers.ts) answers from a copy of it. A lake needs neither: it is a catalog and a
// bucket, many processes read it at once, and a reader sees the snapshot that was last committed while a writer works on the next. So this
// engine holds no lock, creates no write intent and never steps aside, and a query never waits for a run or answers "busy, retry"
// because of one.
//
// What it runs: one child process (serve/worker.ts with `lake`), an in-memory DuckDB that loads the lake's extensions by path, attaches
// the lake READ_ONLY with the credentials of the read-only pair, and is locked down to the bucket's one folder (db/modes.ts, kind
// `lake`). The process holds the read-only credentials and nobody else does: they come to it over the IPC channel, never through the
// environment or the command line. Its connections run `USE lake`, so the serve gate and the queries see the lake as they see the file.
//
// Killing, limits, admission and the row and byte limits are the other engines' (queue.ts, worker.ts answer()). A query that
// interrupts cannot stop ends with the process (SIGKILL), every query running there fails with a retryable SERVE_UNAVAILABLE, and a
// new process starts. A process that fails to start, or dies soon after, is replaced after a backoff. A lake nobody has written yet
// is DB_NOT_FOUND until a run creates it: the engine looks again every second.
//
// A key works only in server mode (D128, D129): a query that carries one is refused here, as by the file engine, unless the project has
// "serverMode" on. Server mode over a lake (D183; option 07, slice 5) is this engine with `serve` in the process's open message: the same
// process also loads quack, makes a view of each shared table, starts Quack's listener, and answers a key's query on the views. There is
// no read copy to make and none to swap in: the process attaches the lake itself, read-only, and the views read its last snapshot whenever
// they are read, so a person sees each commit on their next query. Every answer says when the snapshot it could have read was made.
import { CroftError } from "../core/errors.ts";
import { formatInstant, now, zonedParts } from "../core/time.ts";
import { type SandboxSpec, serveResources } from "../db/connect.ts";
import { lakeConnection } from "../db/lake.ts";
import { ProjectEnv } from "../project/env.ts";
import { loadProject, type Project } from "../project/root.ts";
import { mapQueryError } from "../read/select.ts";
import { keyNeedsServerMode, noSharedTables, notAdmittedError, plaintextNotAccepted, queueFullError, restartedError, stopError } from "./errors.ts";
import { SERVE_DEFAULTS, serveLimits } from "./instance.ts";
import { KeyStore } from "./keys.ts";
import { Admission, type Flight, type StopReason } from "./queue.ts";
import { QueryWorker, WorkerGone, WorkerStopped } from "./query-worker.ts";
import type { QuackKey } from "./quack-access.ts";
import { listenAddress } from "./quack-address.ts";
import { restartDelayMs } from "./readers.ts";
import type { ServeEngine, ServeEngineOptions, ServeEngineStatus, ServeQuery, ServeQueryData } from "./types.ts";

/** How often a missing process, or a lake that is not there yet, is looked at. */
export const LAKE_POLL_MS = 1000;
/** How often server mode over a lake sends the process the keys when they changed: a removed key's open Quack session is refused within
 *  this long, as on a file (option 06 promises "within one second"; the file engine looks every 250 ms). */
export const LAKE_KEYS_POLL_MS = 250;
/** A process that dies within this long of opening counts as a failed start for the backoff. */
const QUICK_DEATH_MS = 2000;

/** Instrumentation points (tests, diagnostics). */
export interface LakeEngineHooks {
  /** The lake process opened and queries are admitted. */
  opened?(e: { pid: number; at: number }): void;
  /** The process exited (killed for a deadline, crashed, or failed to start). */
  exited?(e: { pid: number; at: number }): void;
  /** A query ended (answered or not) on the process `workerPid`. */
  queryEnded?(e: { workerPid: number; workerPeakRss: number; at: number }): void;
  /** Server mode: a Quack query ran past the deadline; the process is being killed (D127). */
  quackOverdue?(e: { pid: number; ms: number; at: number }): void;
  /** Server mode: the keys the process accepts over Quack were sent again (the keys file changed, D126). */
  keysSent?(e: { names: string[]; at: number }): void;
}

/** Options the command does not pass: tests and diagnostics. */
export interface LakeEngineInternals {
  hooks?: LakeEngineHooks;
  maxBytes?: number;
  maxRows?: number;
  maxQueued?: number;
  killAfterMs?: number;
  resources?: Partial<{ memoryLimit: string; threads: number }>;
  interruptEveryMs?: number;
  /** How often the engine looks and how long a lake that is not there yet waits: LAKE_POLL_MS by default, and in server mode it looks every LAKE_KEYS_POLL_MS. */
  pollMs?: number;
  /** A folder of the pinned extension files, for croft's tests; by default the lake add-on in the project's node_modules (D134). */
  extensionDir?: string;
  /** The worker command (tests); `bun --no-env-file worker.ts` by default. */
  workerArgv?: string[];
  /** The wait before the next try after `attempts` failed starts; restartDelayMs by default. */
  restartDelayMs?: (attempts: number) => number;
  /** Server mode only: where the process listens for DuckDB clients (serverMode.quackHost and quackPort by default); false: nowhere,
   *  for a test that wants no listener. */
  quack?: false | { host: string; port: number; maxConcurrent?: number };
}

/** Open the lake engine for a project. Throws the mode's own errors (EXTENSION_MISSING and the others, LAKE_ATTACH_FAILED, SECRET_MISSING)
 *  when the first start fails; a lake that does not exist yet is waited for. */
export async function openLakeEngine(o: ServeEngineOptions & LakeEngineInternals): Promise<ServeEngine> {
  const project = loadProject({ root: o.root });
  const engine = new LakeEngine(project, o);
  engine.assertQuackAddress();
  await engine.start();
  return engine;
}

class LakeEngine implements ServeEngine {
  private state: "waiting" | "starting" | "open" | "restarting" | "stopped" = "waiting";
  private worker: QueryWorker | null = null;
  private opening: QueryWorker | null = null;
  private readonly admission: Admission;
  private readonly hooks: LakeEngineHooks;
  private readonly spec: () => SandboxSpec;
  private readonly protect: string[];
  private readonly label: string;
  private readonly maxConcurrent: number;
  private readonly queueMs: number;
  private readonly queryTimeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxRows: number;
  private readonly maxQueued: number;
  private readonly pollMs: number;
  /** How often the engine looks (tick): the keys are sent on it, so server mode looks at LAKE_KEYS_POLL_MS. */
  private readonly tickMs: number;
  private readonly argv: string[] | undefined;
  private readonly delayOf: (attempts: number) => number;
  /** Server mode over a lake (D183): keys, the shared tables and Quack. False for a lake project that serves apps only. */
  private readonly serverMode: boolean;
  private readonly quackAt: { host: string; port: number; maxConcurrent: number } | null;
  private readonly onQuack: ServeEngineOptions["onQuack"];
  /** Reads the keys file for the Quack hooks (D126); the engine never writes it. */
  private readonly keyStore: KeyStore;
  /** The keys last read, which a process opens with and is sent again when the file changes. */
  private keys: QuackKey[] = [];
  private quackUri: string | null = null;
  /** When the lake's newest snapshot the process has seen was made, in the project offset; null before it opens. */
  private asOf: string | null = null;
  /** Why queries are refused until something changes (no lake yet; a start that a retry will not fix); null otherwise. */
  private blocked: CroftError | null = null;
  private transition: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private closing: Promise<void> | null = null;
  private attempts = 0;
  private retryAt = 0;
  private openedAt = 0;
  private restarts = 0;
  private seq = 0;
  private day = "";
  private count = 0;

  constructor(private readonly project: Project, o: ServeEngineOptions & LakeEngineInternals) {
    const limits = serveLimits(project, o);
    this.maxConcurrent = limits.maxConcurrent;
    this.queueMs = limits.queueMs;
    this.queryTimeoutMs = limits.queryTimeoutMs;
    this.maxBytes = limits.maxBytes;
    this.maxRows = limits.maxRows;
    this.maxQueued = limits.maxQueued;
    this.pollMs = o.pollMs ?? LAKE_POLL_MS;
    this.tickMs = o.pollMs ?? (project.config.serverMode.enabled ? LAKE_KEYS_POLL_MS : LAKE_POLL_MS);
    this.argv = o.workerArgv;
    this.delayOf = o.restartDelayMs ?? restartDelayMs;
    const sm = project.config.serverMode;
    this.serverMode = sm.enabled;
    this.quackAt = !sm.enabled || o.quack === false ? null : { host: sm.quackHost, port: sm.quackPort, maxConcurrent: sm.quackMaxConcurrent, ...o.quack };
    this.onQuack = o.onQuack;
    this.keyStore = new KeyStore(project.paths.stateDir);
    this.hooks = guarded(o.hooks ?? {});
    this.label = project.databaseLabel;
    this.protect = [project.paths.stateDir];
    const env = o.env ?? ProjectEnv.load(project.root);
    const lake = lakeConnection(project, env, o.extensionDir ? { extensionDir: o.extensionDir } : {});
    if (!lake) throw new CroftError("INTERNAL_ERROR", { message: "the lake engine was opened for a project with no lake", hint: "report this croft bug" });
    // Made for each start: the read-only credentials are read from the project's secrets then, and a secret that was missing can be set.
    this.spec = () => ({
      profile: "serve", timezone: project.timezone, root: project.root, stateDir: project.paths.stateDir, ...serveResources(), ...o.resources,
      mode: lake.mode("read"),
    });
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
    if (!this.quackAt) return;
    const { uri, loopback } = listenAddress(this.quackAt.host, this.quackAt.port);
    if (!loopback && !this.project.config.serverMode.quackPlaintextOnNetwork) throw plaintextNotAccepted(uri);
  }

  /** First open. A lake that is not there yet is waited for (the first run creates it); a start that fails fails croft serve's start. */
  async start(): Promise<void> {
    try {
      await this.open();
    } catch (e) {
      if (e instanceof CroftError && e.code === "DB_NOT_FOUND") {
        this.block(e);
        this.retryAt = Date.now() + this.pollMs;
      } else {
        await this.close();
        throw e instanceof CroftError ? e : this.workerFailed(e);
      }
    }
    this.timer = setInterval(() => this.tick(), this.tickMs);
    // The HTTP server keeps croft serve alive; the poll alone never should.
    (this.timer as { unref?: () => void }).unref?.();
  }

  status(): ServeEngineStatus {
    return {
      state: this.state === "open" ? "open" : this.state === "stopped" ? "stopped" : "reopening",
      writeIntent: null,
      inFlight: this.admission.inFlight,
      queued: this.admission.queued,
      openConnections: this.worker?.conns ?? 0,
      queriesToday: this.dayKey() === this.day ? this.count : 0,
      lake: { label: this.label, workerPid: this.worker?.pid ?? null, restarts: this.restarts },
      ...(this.serverMode
        ? {
          serverMode: {
            state: this.state, copy: null, asOf: this.asOf, workerPid: this.worker?.pid ?? null, swaps: 0, restarts: this.restarts, copyCost: null,
            makingCopy: false, quack: this.quackUri ? { uri: this.quackUri } : null,
          },
        }
        : {}),
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
    // A key works only in server mode (D128), where its query has two walls; the HTTP layer refuses it before this, and so does the engine.
    if (q.scope && !this.serverMode) throw keyNeedsServerMode();
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

  private async answer(worker: QueryWorker, flight: Flight, q: ServeQuery, arrived: number): Promise<ServeQueryData> {
    const id = ++this.seq;
    flight.attach({ interrupt: () => worker.interrupt(id), abandon: () => void worker.kill() });
    flight.checkpoint();
    const a = await worker.query(id, {
      sql: q.sql, params: q.params, limit: q.limit, maxRows: this.maxRows, maxBytes: this.maxBytes, ...(q.scope ? { shared: [...q.scope.tables] } : {}),
    });
    const rows = JSON.parse(a.rowsJson) as ServeQueryData["rows"];
    // Server mode: every answer says when the lake's snapshot it could have read was made, in the project offset.
    const asOf = a.snapshotMs !== undefined ? formatInstant(a.snapshotMs, this.project.timezone) : undefined;
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
      void this.opening?.kill(); // a start in progress fails and leaves the rest to us
      await this.transition;
      const worker = this.worker;
      this.worker = null;
      await worker?.kill();
      this.state = "stopped";
    })();
    return this.closing;
  }

  // ---- the process ---------------------------------------------------------------------------------------

  /** On every poll: a lake with no process is tried again once its wait is over. */
  private tick(): void {
    if (this.stopped) return;
    this.sendKeys();
    if (this.transition || this.worker) return;
    if (Date.now() < this.retryAt) return;
    this.begin(this.reopen());
  }

  /** Read the keys file when it changed since the last look: the new list, or null. A Quack session outlives a request, so the process
   *  checks every query against its list, and a removed key stops working within a look (D126). */
  private readKeys(): QuackKey[] | null {
    if (!this.serverMode) return null;
    const changed = this.keyStore.changes();
    if (changed) this.keys = changed;
    return changed;
  }

  /** Tell the process the keys, when they changed. */
  private sendKeys(): void {
    const changed = this.readKeys();
    if (!changed || !this.worker) return; // a process that opens next starts with the list
    this.worker.setKeys(changed);
    this.hooks.keysSent?.({ names: changed.map((k) => k.name), at: Date.now() });
  }

  private begin(p: Promise<void>): void {
    this.transition = p
      .catch(() => {}) // every failure is recorded (blocked, or a restart) by the transition itself
      .finally(() => {
        this.transition = null;
        if (!this.stopped) this.tick();
      });
  }

  /** Start the process on the lake. Throws what it reported (the first start's caller reports it; later ones are recorded by reopen). */
  private async open(): Promise<void> {
    this.state = this.restarts > 0 || this.attempts > 0 ? "restarting" : "starting";
    const worker: QueryWorker = QueryWorker.spawn({
      onExit: (w) => this.exited(w),
      onQuack: (e) => {
        try {
          this.onQuack?.(e);
        } catch {
          // A log or a last-use time that cannot be written never costs a client its answer.
        }
      },
      onOverdue: (o) => {
        // Quack has no server-side cancel [V: 2.0.0]: the process ends, every session on it with it, and clients attach again (D127).
        this.hooks.quackOverdue?.({ pid: worker.pid, ms: o.ms, at: Date.now() });
        void worker.kill();
      },
      onSnapshot: (ms) => {
        this.asOf = formatInstant(ms, this.project.timezone);
      },
      ...(this.argv ? { argv: this.argv } : {}),
    });
    this.opening = worker;
    this.readKeys(); // the process opens with the keys as they are now
    let opened: Awaited<ReturnType<QueryWorker["open"]>>;
    try {
      opened = await worker.open({
        path: this.label, spec: this.spec(), protect: this.protect, lake: true,
        ...(this.serverMode
          ? {
            serve: {
              shared: [...this.project.config.serve.sharedTables],
              ...(this.quackAt ? { quack: { ...this.quackAt, queryTimeoutMs: this.queryTimeoutMs, keys: this.keys } } : {}),
            },
          }
          : {}),
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
    this.quackUri = opened.quack?.uri ?? null;
    if (opened.snapshotMs !== undefined) this.asOf = formatInstant(opened.snapshotMs, this.project.timezone);
    if (this.serverMode) worker.setKeys(this.keys); // a change while it opened was read but not sent
    this.state = "open";
    this.blocked = null;
    this.openedAt = Date.now();
    this.hooks.opened?.({ pid: worker.pid, at: Date.now() });
    this.admission.resume();
  }

  /** A later start (after the process ended, or the lake appeared): what fails is recorded, not thrown. */
  private async reopen(): Promise<void> {
    try {
      // attempts is not reset here: a process that dies soon after it opens counts against the next start (exited()).
      await this.open();
    } catch (e) {
      if (this.stopped) return;
      this.attempts++;
      this.retryAt = Date.now() + (e instanceof CroftError && e.code === "DB_NOT_FOUND" ? this.pollMs : this.delayOf(this.attempts));
      this.state = "restarting";
      // A WorkerGone is a process that died on its way up: queries wait for the next try. Anything else (a lake that is not there, a
      // catalog that refuses the login, a missing extension file) is not mended by trying at once: queries are refused with it.
      if (e instanceof WorkerGone) {
        this.blocked = null;
        this.admission.pause();
      } else this.block(e instanceof CroftError ? e : this.workerFailed(e));
    }
  }

  /** A process exited. While it served (a deadline's kill, the OOM killer, a crash), another starts at once, or after a backoff when
   *  it died soon after it opened; its queries have failed already. A stop releases it itself. */
  private exited(w: QueryWorker): void {
    this.hooks.exited?.({ pid: w.pid, at: Date.now() });
    if (w !== this.worker || this.stopped) return;
    this.worker = null;
    this.quackUri = null;
    this.restarts++;
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

  // ---- results -------------------------------------------------------------------------------------------

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

  // ---- errors --------------------------------------------------------------------------------------------

  /** Why a query was not admitted within queueMs. */
  private notAdmitted(waitedMs: number): CroftError {
    if (this.stopped) return this.stopError("stop");
    return notAdmittedError({ what: "process on the lake", waitedMs, state: this.state, attempts: this.attempts, maxConcurrent: this.maxConcurrent });
  }

  /** A query refused because maxQueued already wait. */
  private queueFull(): CroftError {
    return this.stopped ? this.stopError("stop") : queueFullError(this.maxQueued, this.maxConcurrent);
  }

  private restarted(e: WorkerGone | null): CroftError {
    return restartedError(e, "lake process");
  }

  private stopError(reason: StopReason): CroftError {
    // A lake engine never steps aside for a writer, so "write" is not a reason a flight here can have.
    return stopError(reason === "write" ? "stop" : reason, { queryTimeoutMs: this.queryTimeoutMs });
  }

  /** The lake process could not start (or died while it attached the lake). */
  private workerFailed(e: unknown): CroftError {
    const message = e instanceof Error ? e.message : String(e);
    return new CroftError("INTERNAL_ERROR", {
      message: `croft serve could not start its lake process: ${message.split("\n")[0]}`,
      hint: "run croft doctor to check the installation; croft serve retries with a backoff; if it keeps failing, report this croft bug with the message",
      fix: { kind: "command", description: "check croft's installation", command: "croft doctor" },
      details: { database: this.label, worker: message.split("\n")[0] },
    });
  }
}

/** Hooks that cannot break the engine: one that throws is ignored. */
function guarded(h: LakeEngineHooks): LakeEngineHooks {
  const out: LakeEngineHooks = {};
  for (const [name, fn] of Object.entries(h) as [keyof LakeEngineHooks, ((e: unknown) => void) | undefined][]) {
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
