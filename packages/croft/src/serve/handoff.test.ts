import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { bootId, currentIdentity, procStart } from "../core/proc.ts";
import { intentDir, intentFileName } from "../db/intent.ts";
import { cleanup, spawnIdle, writeIntent } from "../read/testkit.ts";
import { drain, IntentWatch } from "./handoff.ts";
import { Admission } from "./queue.ts";

afterAll(cleanup);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function stateDir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "croft-handoff-")));
  dirs.push(d);
  return d;
}

function plant(state: string, id: { pid: number; procStart: string; bootId: string }): string {
  mkdirSync(intentDir(state), { recursive: true });
  const file = join(intentDir(state), intentFileName(id));
  writeFileSync(file, JSON.stringify({ ...id, runId: "r_old", since: new Date().toISOString() }));
  return file;
}

async function exitedIdentity() {
  const child = spawn("sleep", ["0.01"]);
  const id = { pid: child.pid!, procStart: procStart(child.pid!) ?? "gone", bootId: bootId() };
  await new Promise((r) => child.on("exit", r));
  return id;
}

describe("IntentWatch", () => {
  test("a live writer's intent is a candidate at once and proven live", async () => {
    const state = stateDir();
    const w = new IntentWatch({ stateDir: state, pollMs: 50, onTick: () => {} });
    expect(w.candidates()).toEqual([]);
    const idle = spawnIdle();
    await idle.waitFor("up");
    writeIntent(state, idle.pid, "r_live");
    expect(w.candidates().map((i) => i.runId)).toEqual(["r_live"]);
    expect(w.live().map((i) => i.runId)).toEqual(["r_live"]);
  });

  test("a dead holder's intent is no candidate, and is removed on the way; live() removes it too", async () => {
    const state = stateDir();
    const w = new IntentWatch({ stateDir: state, pollMs: 50, onTick: () => {} });
    const file = plant(state, await exitedIdentity());
    expect(w.candidates()).toEqual([]);
    expect(existsSync(file)).toBe(false);
    const again = plant(state, await exitedIdentity());
    expect(w.live()).toEqual([]);
    expect(existsSync(again)).toBe(false);
  });

  test("a reused PID passes the quick check (stepping aside is cheap) but not the proof, which purges it", () => {
    const state = stateDir();
    const me = currentIdentity();
    // A live PID with another start time: the intent's writer is gone and its PID was reused.
    const file = plant(state, { pid: me.pid, procStart: "1000000000", bootId: bootId() });
    const w = new IntentWatch({ stateDir: state, pollMs: 50, onTick: () => {} });
    expect(w.candidates()).toHaveLength(1);
    expect(w.live()).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  test("an intent from another boot is no candidate; unreadable files are ignored and purged", () => {
    const state = stateDir();
    const me = currentIdentity();
    plant(state, { ...me, bootId: "another-boot" });
    writeFileSync(join(intentDir(state), "123-456.json"), "{not json");
    const w = new IntentWatch({ stateDir: state, pollMs: 50, onTick: () => {} });
    expect(w.candidates()).toEqual([]);
    expect(readdirSync(intentDir(state))).toEqual([]);
    plant(state, { ...me, bootId: "another-boot" });
    expect(w.live()).toEqual([]);
    expect(readdirSync(intentDir(state))).toEqual([]);
  });

  test("polls every pollMs, and a new intent file wakes it before the next poll", async () => {
    const state = stateDir();
    let ticks = 0;
    const polled = new IntentWatch({ stateDir: state, pollMs: 20, onTick: () => ticks++ });
    polled.start();
    await sleep(250);
    polled.stop();
    expect(ticks).toBeGreaterThanOrEqual(4);
    const after = ticks;
    await sleep(60);
    expect(ticks).toBe(after);

    // With a poll far away, only the directory watch can wake it.
    let woke = 0;
    const watched = new IntentWatch({ stateDir: state, pollMs: 60_000, onTick: () => woke++ });
    watched.start();
    try {
      await sleep(50);
      const before = woke;
      const idle = spawnIdle();
      await idle.waitFor("up");
      writeIntent(state, idle.pid);
      for (let i = 0; woke === before && i < 300; i++) await sleep(10);
      expect(woke).toBeGreaterThan(before);
    } finally {
      watched.stop();
    }
  });

  test("the intent folder is created when missing, so it can be watched", () => {
    const state = stateDir();
    const w = new IntentWatch({ stateDir: state, pollMs: 50, onTick: () => {} });
    w.start();
    w.stop();
    expect(existsSync(intentDir(state))).toBe(true);
  });
});

describe("drain", () => {
  function admission() {
    const a = new Admission({
      maxConcurrent: 4,
      interruptEveryMs: 20,
      unavailable: () => new CroftError("SERVE_UNAVAILABLE", { message: "x", hint: "y" }),
      aborted: () => new CroftError("INTERRUPTED", { message: "x", hint: "y" }),
    });
    a.resume();
    return a;
  }

  test("nothing in flight: done at once", async () => {
    const a = admission();
    const t = Date.now();
    expect(await drain(a, { graceMs: 2000, reason: "write" })).toEqual({ interrupted: 0 });
    expect(Date.now() - t).toBeLessThan(50);
  });

  test("a query that finishes within the grace period is left alone", async () => {
    const a = admission();
    const f = await a.enter({ deadline: Date.now() + 1000 });
    const interrupts: number[] = [];
    f.attach({ interrupt: () => interrupts.push(Date.now()) });
    setTimeout(() => f.release(), 60);
    expect(await drain(a, { graceMs: 500, reason: "write" })).toEqual({ interrupted: 0 });
    expect(interrupts).toEqual([]);
    expect(f.reason).toBeNull();
  });

  test("after the grace period, each query still running is interrupted every 20 ms until it settles", async () => {
    const a = admission();
    const f = await a.enter({ deadline: Date.now() + 1000 });
    const g = await a.enter({ deadline: Date.now() + 1000 });
    const start = Date.now();
    const seen: number[] = [];
    // f ignores the first two interrupts (DuckDB can miss one between tasks); g settles on the first.
    f.attach({ interrupt: () => { seen.push(Date.now()); if (seen.length === 3) setTimeout(() => f.release(), 1); } });
    g.attach({ interrupt: () => setTimeout(() => g.release(), 1) });
    const out = await drain(a, { graceMs: 150, reason: "write" });
    const took = Date.now() - start;
    expect(out).toEqual({ interrupted: 2 });
    expect(f.reason).toBe("write");
    expect(g.reason).toBe("write");
    expect(seen[0]! - start).toBeGreaterThanOrEqual(140);
    expect(seen[2]! - seen[0]!).toBeGreaterThanOrEqual(30);
    expect(took).toBeGreaterThanOrEqual(150);
    expect(a.inFlight).toBe(0);
  });
});
