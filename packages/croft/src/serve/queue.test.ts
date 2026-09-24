import { describe, expect, test } from "bun:test";
import { CroftError } from "../core/errors.ts";
import { Admission, type Flight } from "./queue.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function admission(o: { maxConcurrent?: number; everyMs?: number } = {}) {
  const a = new Admission({
    maxConcurrent: o.maxConcurrent ?? 2,
    interruptEveryMs: o.everyMs ?? 20,
    unavailable: (waitedMs) => new CroftError("SERVE_UNAVAILABLE", { message: `waited ${waitedMs}`, hint: "retry", details: { retryAfterMs: 1000 } }),
    aborted: () => new CroftError("INTERRUPTED", { message: "request went away", hint: "nothing to do" }),
  });
  a.resume();
  return a;
}

async function rejection(p: Promise<unknown>): Promise<CroftError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
  throw new Error("expected a CroftError");
}

const soon = (ms = 10_000) => Date.now() + ms;

describe("Admission", () => {
  test("admits up to maxConcurrent; the rest wait in arrival order", async () => {
    const a = admission({ maxConcurrent: 2 });
    const f1 = await a.enter({ deadline: soon() });
    const f2 = await a.enter({ deadline: soon() });
    const order: number[] = [];
    const p3 = a.enter({ deadline: soon() }).then((f) => (order.push(3), f));
    const p4 = a.enter({ deadline: soon() }).then((f) => (order.push(4), f));
    await sleep(5);
    expect(a.inFlight).toBe(2);
    expect(a.queued).toBe(2);
    expect(order).toEqual([]);
    f1.release();
    const f3 = await p3;
    expect(order).toEqual([3]);
    f2.release();
    const f4 = await p4;
    expect(order).toEqual([3, 4]);
    f3.release();
    f4.release();
    expect(a.inFlight).toBe(0);
    expect(a.queued).toBe(0);
  });

  test("release is idempotent", async () => {
    const a = admission({ maxConcurrent: 1 });
    const f = await a.enter({ deadline: soon() });
    f.release();
    f.release();
    expect(a.inFlight).toBe(0);
    const g = await a.enter({ deadline: soon() });
    expect(a.inFlight).toBe(1);
    g.release();
  });

  test("a query not admitted by its deadline gets the engine's SERVE_UNAVAILABLE, with how long it waited", async () => {
    const a = admission({ maxConcurrent: 1 });
    const f = await a.enter({ deadline: soon() });
    const start = Date.now();
    const err = await rejection(a.enter({ deadline: Date.now() + 120 }));
    expect(err.code).toBe("SERVE_UNAVAILABLE");
    expect(err.problem.details?.retryAfterMs).toBe(1000);
    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
    expect(Number(err.message.replace("waited ", ""))).toBeGreaterThanOrEqual(100);
    expect(a.queued).toBe(0);
    f.release();
    expect(a.inFlight).toBe(0);
  });

  test("a deadline already passed with a free slot still admits (the queue wait is what is limited)", async () => {
    const a = admission({ maxConcurrent: 1 });
    const f = await a.enter({ deadline: Date.now() - 1 });
    expect(a.inFlight).toBe(1);
    f.release();
  });

  test("paused: nothing is admitted, waiters keep their place, and resume admits them in order", async () => {
    const a = admission({ maxConcurrent: 4 });
    a.pause();
    const got: number[] = [];
    const ps = [1, 2, 3].map((n) => a.enter({ deadline: soon() }).then((f) => (got.push(n), f)));
    await sleep(20);
    expect(got).toEqual([]);
    expect(a.queued).toBe(3);
    a.resume();
    const flights = await Promise.all(ps);
    expect(got).toEqual([1, 2, 3]);
    flights.forEach((f) => f.release());
  });

  test("an aborted request leaves the queue with the engine's INTERRUPTED; one aborted before it came is refused at once", async () => {
    const a = admission({ maxConcurrent: 1 });
    const f = await a.enter({ deadline: soon() });
    const ac = new AbortController();
    const p = a.enter({ deadline: soon(), signal: ac.signal });
    await sleep(5);
    ac.abort();
    expect((await rejection(p)).code).toBe("INTERRUPTED");
    expect(a.queued).toBe(0);
    expect((await rejection(a.enter({ deadline: soon(), signal: ac.signal }))).code).toBe("INTERRUPTED");
    f.release();
  });

  test("fail() rejects every waiter; close() also refuses new ones", async () => {
    const a = admission({ maxConcurrent: 1 });
    a.pause();
    const p = a.enter({ deadline: soon() });
    const boom = new CroftError("DB_NOT_FOUND", { message: "no file", hint: "run" });
    a.fail(boom);
    expect(await rejection(p)).toBe(boom);
    a.resume();
    const f = await a.enter({ deadline: soon() });
    f.release();
    const stopped = new CroftError("SERVE_UNAVAILABLE", { message: "stopping", hint: "restart" });
    const q = a.enter({ deadline: soon() });
    a.pause();
    a.close(stopped);
    await q.then((x) => x.release(), () => {});
    expect(await rejection(a.enter({ deadline: soon() }))).toBe(stopped);
  });

  test("idle() resolves once every admitted flight released", async () => {
    const a = admission({ maxConcurrent: 2 });
    await a.idle(); // nothing in flight
    const f1 = await a.enter({ deadline: soon() });
    const f2 = await a.enter({ deadline: soon() });
    let idle = false;
    const p = a.idle().then(() => (idle = true));
    f1.release();
    await sleep(5);
    expect(idle).toBe(false);
    f2.release();
    await p;
    expect(idle).toBe(true);
  });
});

describe("Flight.stop", () => {
  function fakeConn() {
    const at: number[] = [];
    return { at, interrupt: () => at.push(Date.now()) };
  }

  test("interrupts its connection at once and every interval until it is released; the first reason wins", async () => {
    const a = admission({ everyMs: 20 });
    const f: Flight = await a.enter({ deadline: soon() });
    const c = fakeConn();
    f.attach(c);
    f.stop("write");
    f.stop("timeout");
    expect(f.reason).toBe("write");
    expect(c.at.length).toBe(1);
    await sleep(110);
    const n = c.at.length;
    expect(n).toBeGreaterThanOrEqual(3);
    f.release();
    await sleep(60);
    expect(c.at.length).toBe(n);
  });

  test("stopped before it has a connection: attach interrupts at once, and checkpoint throws", async () => {
    const a = admission();
    const f = await a.enter({ deadline: soon() });
    expect(() => f.checkpoint()).not.toThrow();
    f.stop("abort");
    expect(() => f.checkpoint()).toThrow();
    const c = fakeConn();
    f.attach(c);
    expect(c.at.length).toBe(1);
    f.release();
  });

  test("stop after release does nothing", async () => {
    const a = admission();
    const f = await a.enter({ deadline: soon() });
    const c = fakeConn();
    f.attach(c);
    f.release();
    f.stop("timeout");
    expect(f.reason).toBeNull();
    expect(c.at).toEqual([]);
  });
});

describe("bounds", () => {
  test("past maxQueued waiting, enter() refuses at once with the engine's error; a free slot still admits", async () => {
    const a = new Admission({
      maxConcurrent: 1, maxQueued: 2,
      unavailable: (waitedMs) => new CroftError("SERVE_UNAVAILABLE", { message: `waited ${waitedMs}`, hint: "retry" }),
      aborted: () => new CroftError("INTERRUPTED", { message: "request went away", hint: "nothing to do" }),
      full: () => new CroftError("SERVE_UNAVAILABLE", { message: "queue full", hint: "retry", details: { reason: "busy" } }),
    });
    a.resume();
    const first = await a.enter({ deadline: soon() });
    const waiting = [a.enter({ deadline: soon() }), a.enter({ deadline: soon() })];
    expect(a.queued).toBe(2);
    const start = Date.now();
    const err = await rejection(a.enter({ deadline: soon() }));
    expect(Date.now() - start).toBeLessThan(50);
    expect(err.message).toBe("queue full");
    expect(a.queued).toBe(2);
    first.release();
    const second = await waiting[0]!;
    second.release();
    (await waiting[1]!).release();
    // With room again, it queues and is admitted as before.
    (await a.enter({ deadline: soon() })).release();
  });

  test("a stopped flight that does not settle within stuckAfterMs is abandoned: its connection's abandon() runs once", async () => {
    const a = new Admission({
      maxConcurrent: 2, interruptEveryMs: 20, stuckAfterMs: 80,
      unavailable: () => new CroftError("SERVE_UNAVAILABLE", { message: "busy", hint: "retry" }),
      aborted: () => new CroftError("INTERRUPTED", { message: "gone", hint: "nothing to do" }),
    });
    a.resume();
    const stuck = await a.enter({ deadline: soon() });
    const abandoned: number[] = [];
    stuck.attach({ interrupt: () => {}, abandon: () => abandoned.push(Date.now()) });
    const start = Date.now();
    stuck.stop("timeout");
    await sleep(200);
    expect(abandoned.length).toBe(1);
    expect(abandoned[0]! - start).toBeGreaterThanOrEqual(75);
    stuck.release();
    // One that settles in time is never abandoned.
    const fine = await a.enter({ deadline: soon() });
    const never: number[] = [];
    fine.attach({ interrupt: () => {}, abandon: () => never.push(1) });
    fine.stop("write");
    await sleep(20);
    fine.release();
    await sleep(120);
    expect(never).toEqual([]);
  });
});
