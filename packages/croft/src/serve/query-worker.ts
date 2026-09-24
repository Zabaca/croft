// croft serve's handle on one query worker (serve/worker.ts): a child process holding one read-only DuckDB
// instance, spoken to over Bun's IPC channel. The engine (serve/instance.ts) opens a file in a fresh worker,
// sends it queries and interrupts, and kills it (SIGKILL) to release the file: the kernel drops the process's
// locks as it exits, however DuckDB's objects stand, so a query that interrupts cannot stop never keeps a writer
// out for longer than it takes to kill a process.
//
// Every request fails with WorkerGone once the worker has exited, whatever the reason: killed by the engine,
// killed by the OOM killer, or crashed. The engine learns of the exit through onExit.
import type { Subprocess } from "bun";
import { fileURLToPath } from "node:url";
import { CroftError } from "../core/errors.ts";
import type { SandboxSpec } from "../db/connect.ts";
import type { ColumnInfo } from "../db/values.ts";
import { tickEnv } from "./loop.ts";
import type { FromWorker, ToWorker, WireError } from "./worker.ts";

/** The worker's entry: the same croft this server runs. */
export const WORKER_FILE = fileURLToPath(new URL("./worker.ts", import.meta.url));

/** The worker exited: every request still waiting on it fails with this. */
export class WorkerGone extends Error {
  constructor(readonly exit: { code: number | null; signal: string | null; killed: boolean }, readonly stderr: string) {
    const how = exit.killed ? "was stopped by croft serve" : exit.signal ? `was killed by ${exit.signal}` : exit.code === null ? "could not start" : `exited with code ${exit.code}`;
    const last = stderr.trim().split("\n").pop()?.slice(0, 300);
    super(`croft serve's query worker ${how}${last ? `: ${last}` : ""}`);
    this.name = "WorkerGone";
  }
}

/** The worker reported that it interrupted the query, as the engine asked. */
export class WorkerStopped extends Error {
  constructor() {
    super("the query was stopped");
    this.name = "WorkerStopped";
  }
}

/** Another process holds the file (DuckDB's lock error, parsed). */
export class WorkerConflict extends Error {
  constructor(readonly program: string | null, readonly pid: number | null, message: string) {
    super(message);
    this.name = "WorkerConflict";
  }
}

export interface WorkerQuery {
  sql: string;
  params: unknown[];
  limit: number;
  maxRows: number;
  maxBytes: number;
}

export interface WorkerAnswer {
  columns: ColumnInfo[];
  rowsJson: string;
  rowCount: number;
}

export interface SpawnOptions {
  /** Called once when the worker has exited, for any reason. */
  onExit?(w: QueryWorker): void;
  /** The worker's command (tests); `bun --no-env-file worker.ts` by default. */
  argv?: string[];
}

interface Waiting<T> {
  resolve(v: T): void;
  reject(e: unknown): void;
}

/** How much of the worker's stderr is kept, for the message of an unexpected exit. */
const STDERR_KEPT = 4096;

export class QueryWorker {
  readonly pid: number;
  /** The worker's connections, as it last reported them (0 once it has exited). */
  conns = 0;
  /** The worker's peak resident set, in bytes, as it last reported it. */
  peakRss = 0;
  /** Resolves when the worker can take requests; rejects with WorkerGone if it exits first. */
  readonly ready: Promise<void>;
  /** Resolves once the process has exited (never rejects). */
  readonly exited: Promise<void>;
  private readonly proc: Subprocess<"ignore", "ignore", "pipe"> | null;
  private readonly queries = new Map<number, Waiting<WorkerAnswer>>();
  private opening: Waiting<void> | null = null;
  private disconnecting: Waiting<number>[] = [];
  private readyWait!: Waiting<void>;
  private gone: WorkerGone | null = null;
  private killedByUs = false;
  private stderr = "";

  private constructor(o: SpawnOptions) {
    this.ready = new Promise<void>((resolve, reject) => (this.readyWait = { resolve, reject }));
    this.ready.catch(() => {}); // a worker that dies before it is ready fails the request that waits on it
    const argv = o.argv ?? [process.execPath, "--no-env-file", WORKER_FILE];
    let proc: Subprocess<"ignore", "ignore", "pipe"> | null = null;
    let failed = "";
    try {
      proc = Bun.spawn(argv, {
        stdio: ["ignore", "ignore", "pipe"],
        env: tickEnv(process.env), // no serve token, no confirmation grant
        ipc: (m) => this.receive(m as FromWorker),
        serialization: "advanced",
      });
    } catch (e) {
      // It could not even start (a missing Bun, no processes left): a worker that is gone at once, never a throw.
      failed = `${argv[0]} could not be started: ${e instanceof Error ? e.message : String(e)}`;
    }
    this.proc = proc;
    this.pid = proc?.pid ?? -1;
    if (proc) void this.drainStderr(proc);
    const exit = proc ? proc.exited : Promise.resolve(null);
    this.exited = exit.then((code) => {
      this.gone = new WorkerGone({ code, signal: proc?.signalCode ?? null, killed: this.killedByUs }, failed || this.stderr);
      this.conns = 0;
      this.readyWait.reject(this.gone);
      this.opening?.reject(this.gone);
      this.opening = null;
      for (const w of this.queries.values()) w.reject(this.gone);
      this.queries.clear();
      for (const w of this.disconnecting.splice(0)) w.resolve(0);
      try {
        o.onExit?.(this);
      } catch {}
    });
  }

  static spawn(o: SpawnOptions = {}): QueryWorker {
    return new QueryWorker(o);
  }

  /** Still running (it may not be ready yet). */
  get alive(): boolean {
    return this.gone === null;
  }

  /** Open the file read-only with the serve sandbox and check its format. Throws a CroftError (DB_NEWER_FORMAT,
   *  CONFIG_INVALID, ...), WorkerConflict (another process holds the file), WorkerGone, or an Error. */
  async open(o: { path: string; spec: SandboxSpec; protect: string[] }): Promise<void> {
    await this.ready;
    if (this.opening) throw new Error("the query worker is already opening a database");
    const p = new Promise<void>((resolve, reject) => (this.opening = { resolve, reject }));
    this.post({ op: "open", ...o });
    return p;
  }

  /** Run one query; `id` is the engine's, for interrupt(). Throws a CroftError, WorkerStopped, WorkerGone, or an
   *  Error (croft's own bug). */
  query(id: number, q: WorkerQuery): Promise<WorkerAnswer> {
    if (this.gone) return Promise.reject(this.gone);
    const p = new Promise<WorkerAnswer>((resolve, reject) => this.queries.set(id, { resolve, reject }));
    this.post({ op: "query", id, ...q });
    return p;
  }

  interrupt(id: number): void {
    if (this.queries.has(id)) this.post({ op: "interrupt", id });
  }

  /** Disconnect every connection; resolves with how many are still open (the last count known if the worker does
   *  not answer within `timeoutMs`, 0 once it has exited). */
  disconnect(timeoutMs: number): Promise<number> {
    if (this.gone) return Promise.resolve(0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answered = new Promise<number>((resolve, reject) => this.disconnecting.push({ resolve, reject }));
    this.post({ op: "disconnect" });
    return Promise.race([answered, new Promise<number>((r) => (timer = setTimeout(() => r(this.conns), timeoutMs)))])
      .finally(() => clearTimeout(timer));
  }

  /** SIGKILL, and wait for the exit: the file is free when this resolves. */
  async kill(): Promise<void> {
    if (!this.gone) {
      this.killedByUs = true;
      try {
        this.proc?.kill("SIGKILL");
      } catch {}
    }
    await this.exited;
  }

  private post(m: ToWorker): void {
    if (this.gone) return;
    try {
      this.proc?.send(m);
    } catch {
      // The channel closed: the exit handler fails what waits.
    }
  }

  private receive(m: FromWorker): void {
    switch (m.op) {
      case "ready":
        this.readyWait.resolve();
        return;
      case "opened":
        this.conns = m.conns;
        this.opening?.resolve();
        this.opening = null;
        return;
      case "open_failed":
        this.opening?.reject(fromWire(m.error));
        this.opening = null;
        return;
      case "answer":
      case "failed": {
        this.conns = m.conns;
        this.peakRss = Math.max(this.peakRss, m.peakRss);
        const w = this.queries.get(m.id);
        if (!w) return;
        this.queries.delete(m.id);
        if (m.op === "answer") w.resolve({ columns: m.columns, rowsJson: m.rowsJson, rowCount: m.rowCount });
        else w.reject(fromWire(m.error));
        return;
      }
      case "disconnected":
        this.conns = m.conns;
        for (const w of this.disconnecting.splice(0)) w.resolve(m.conns);
        return;
    }
  }

  private async drainStderr(proc: Subprocess<"ignore", "ignore", "pipe">): Promise<void> {
    try {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stderr) {
        this.stderr = (this.stderr + decoder.decode(chunk, { stream: true })).slice(-STDERR_KEPT);
      }
    } catch {}
  }
}

/** The error a WireError stands for, on this side. */
export function fromWire(e: WireError): Error {
  switch (e.kind) {
    case "croft": {
      const { code, severity: _s, docs: _d, ...init } = e.problem;
      return new CroftError(code as ConstructorParameters<typeof CroftError>[0], init);
    }
    case "stopped":
      return new WorkerStopped();
    case "conflict":
      return new WorkerConflict(e.program, e.pid, e.message);
    case "error": {
      const err = new Error(e.message);
      err.name = e.name;
      return err;
    }
  }
}
