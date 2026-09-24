// Admission to croft serve's DuckDB instance (DESIGN.md §5 "Server mode": "Query limits", "Handing the file over").
//
// - At most maxConcurrent queries run in DuckDB at once (serve.maxConcurrent, default 4, below the worker-thread
//   count). The rest wait here, first come first served, and the wait counts toward the 10 s admission limit.
// - While the engine steps aside for a writer, admission is paused: queued queries keep their place and wait
//   through the handoff, up to their own deadline.
// - An admitted query is a Flight. stop() interrupts its connection at once and again every 20 ms until the
//   query settles: DuckDB can miss an interrupt that lands between two tasks, and a connection must never be
//   disconnected while its interrupted query has not settled (the lock stayed held in that case [V]). The first
//   reason wins, so the error a client sees names what actually stopped its query.
import type { CroftError } from "../core/errors.ts";

/** Why a running query was stopped: a writer needed the file, its deadline passed, its request went away, or
 *  the server is stopping. */
export type StopReason = "write" | "timeout" | "abort" | "stop";

/** What stop() needs from a connection (DuckDBConnection has it). */
export interface Interruptible {
  interrupt(): void;
}

/** Thrown by Flight.checkpoint() when the flight was stopped before its next DuckDB step. */
export class FlightStopped extends Error {
  constructor(readonly reason: StopReason) {
    super(`query stopped (${reason})`);
  }
}

export class Flight {
  /** The connection the query runs on, once it has one. */
  conn: Interruptible | null = null;
  reason: StopReason | null = null;
  readonly admittedAt = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  private done = false;

  constructor(private readonly leave: (f: Flight) => void, private readonly everyMs: number) {}

  /** The query got its connection. A flight stopped before this is interrupted at once. */
  attach(conn: Interruptible): void {
    this.conn = conn;
    if (this.reason && !this.done) conn.interrupt();
  }

  /** Interrupt the query now and every `everyMs` until it is released. The first reason is kept. */
  stop(reason: StopReason): void {
    if (this.done || this.reason) return; // already being interrupted
    this.reason = reason;
    this.conn?.interrupt();
    this.timer = setInterval(() => this.conn?.interrupt(), this.everyMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Throw FlightStopped when the flight was stopped: called between the query's DuckDB steps, so a query
   *  stopped while it waited for a connection never starts. */
  checkpoint(): void {
    if (this.reason) throw new FlightStopped(this.reason);
  }

  /** True once released. */
  get settled(): boolean {
    return this.done;
  }

  /** The query settled (its statement is destroyed): give the slot back. Idempotent. */
  release(): void {
    if (this.done) return;
    this.done = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.leave(this);
  }
}

export interface AdmissionOptions {
  maxConcurrent: number;
  /** Interval of repeated interrupts once a flight is stopped (20 ms). */
  interruptEveryMs?: number;
  /** The error for a query not admitted by its deadline; the engine knows why (a writer, or a full house). */
  unavailable(waitedMs: number): CroftError;
  /** The error for a query whose request went away while it waited. */
  aborted(): CroftError;
}

export interface EnterOptions {
  /** Epoch ms after which a query still waiting gives up (arrival + queueMs). */
  deadline: number;
  signal?: AbortSignal;
}

interface Waiter {
  since: number;
  resolve(f: Flight): void;
  reject(e: unknown): void;
  cleanup(): void;
}

export class Admission {
  /** Admitted flights that have not released their slot. */
  readonly active = new Set<Flight>();
  private readonly waiting: Waiter[] = [];
  private admitting = false;
  private closedWith: CroftError | null = null;
  private idlers: (() => void)[] = [];

  constructor(private readonly o: AdmissionOptions) {}

  get inFlight(): number {
    return this.active.size;
  }

  get queued(): number {
    return this.waiting.length;
  }

  /** Wait for a slot. Rejects with o.unavailable() at the deadline, o.aborted() when the signal aborts, or
   *  the error given to fail()/close(). */
  enter(o: EnterOptions): Promise<Flight> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    if (o.signal?.aborted) return Promise.reject(this.o.aborted());
    if (this.admitting && this.waiting.length === 0 && this.active.size < this.o.maxConcurrent) return Promise.resolve(this.admit());
    return new Promise<Flight>((resolve, reject) => {
      const since = Date.now();
      const timer = setTimeout(() => {
        this.drop(w);
        reject(this.o.unavailable(Date.now() - since));
      }, Math.max(0, o.deadline - since));
      const onAbort = () => {
        this.drop(w);
        reject(this.o.aborted());
      };
      const w: Waiter = {
        since, resolve, reject,
        cleanup: () => {
          clearTimeout(timer);
          o.signal?.removeEventListener("abort", onAbort);
        },
      };
      o.signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(w);
      this.pump();
    });
  }

  /** Stop admitting (a writer needs the file). Waiters stay queued; running flights are not touched. */
  pause(): void {
    this.admitting = false;
  }

  /** Admit again, waiters first, in arrival order. */
  resume(): void {
    if (this.closedWith) return;
    this.admitting = true;
    this.pump();
  }

  /** Reject every waiter with `err` (the file cannot be opened, e.g. DB_NOT_FOUND). New queries still queue. */
  fail(err: CroftError): void {
    for (const w of this.waiting.splice(0)) {
      w.cleanup();
      w.reject(err);
    }
  }

  /** Refuse everything from now on with `err`, waiters included (the server is stopping). */
  close(err: CroftError): void {
    this.closedWith = err;
    this.admitting = false;
    this.fail(err);
  }

  /** Resolves once no flight holds a slot. */
  idle(): Promise<void> {
    if (this.active.size === 0) return Promise.resolve();
    return new Promise<void>((r) => this.idlers.push(r));
  }

  private admit(): Flight {
    const f = new Flight((x) => this.leave(x), this.o.interruptEveryMs ?? 20);
    this.active.add(f);
    return f;
  }

  private leave(f: Flight): void {
    if (!this.active.delete(f)) return;
    if (this.active.size === 0) for (const r of this.idlers.splice(0)) r();
    this.pump();
  }

  private pump(): void {
    while (this.admitting && this.waiting.length > 0 && this.active.size < this.o.maxConcurrent) {
      const w = this.waiting.shift()!;
      w.cleanup();
      w.resolve(this.admit());
    }
  }

  private drop(w: Waiter): void {
    const i = this.waiting.indexOf(w);
    if (i >= 0) this.waiting.splice(i, 1);
    w.cleanup();
  }
}
