// croft serve's scheduler loop: a fresh `croft tick` subprocess every interval while scheduling is on, never
// two at once. The spawner is injected, except in the tests of spawnTick itself, which start a harmless script.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunsDb } from "../history/runs-db.ts";
import type { SchedulingSetting } from "../schedule/os.ts";
import { type LoopEvent, startLoop, spawnTick, TICK_INTERVAL_MS, tickCommand, tickEnv, tickLogPath, type TickSpawner } from "./loop.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function temp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "croft-loop-")));
  dirs.push(d);
  return d;
}

/** A spawner that records each call; `alive` decides whether the last "tick" is still running. */
function fakeSpawner() {
  const calls: { root: string; stateDir: string; env: Record<string, string> }[] = [];
  let pid = 1000;
  const state = { alive: false };
  const spawn: TickSpawner = (o) => {
    calls.push(o);
    const mine = ++pid;
    return { pid: mine, alive: () => state.alive && pid === mine };
  };
  return { spawn, calls, state };
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
};

describe("the loop", () => {
  test("every minute by default", () => {
    expect(TICK_INTERVAL_MS).toBe(60_000);
  });

  test("spawns only while scheduling is on, never while off or paused", async () => {
    const root = temp();
    let scheduling: SchedulingSetting = { state: "off", via: null };
    const f = fakeSpawner();
    const events: LoopEvent[] = [];
    const loop = startLoop({ root, stateDir: join(root, ".croft"), env: { PATH: "/usr/bin" }, intervalMs: 20, spawn: f.spawn, scheduling: () => scheduling, onEvent: (e) => events.push(e) });
    try {
      await until(() => events.length >= 3);
      expect(f.calls).toHaveLength(0);
      expect(events.every((e) => e.kind === "skipped" && e.reason === "off")).toBe(true);

      scheduling = { state: "on", via: "serve" };
      await until(() => f.calls.length >= 2);
      expect(f.calls[0]).toEqual({ root, stateDir: join(root, ".croft"), env: { PATH: "/usr/bin" } });

      scheduling = { state: "paused", via: "serve", pausedUntil: null };
      const n = f.calls.length;
      events.length = 0;
      await until(() => events.length >= 3);
      expect(f.calls.length).toBe(n);
      expect(events.some((e) => e.kind === "skipped" && e.reason === "paused")).toBe(true);
    } finally {
      loop.stop();
    }
  });

  test("ticks at once when started, then every interval", () => {
    const f = fakeSpawner();
    const loop = startLoop({ root: temp(), stateDir: temp(), env: {}, intervalMs: 60_000, spawn: f.spawn, scheduling: () => ({ state: "on", via: "serve" }) });
    try {
      expect(f.calls).toHaveLength(1);
    } finally {
      loop.stop();
    }
  });

  test("skips the spawn while the previous tick is still alive", () => {
    const f = fakeSpawner();
    const loop = startLoop({ root: temp(), stateDir: temp(), env: {}, intervalMs: 60_000, spawn: f.spawn, scheduling: () => ({ state: "on", via: "serve" }) });
    try {
      expect(f.calls).toHaveLength(1);
      f.state.alive = true;
      expect(loop.tick()).toMatchObject({ kind: "skipped", reason: "previous_alive", pid: 1001 });
      expect(f.calls).toHaveLength(1);
      f.state.alive = false;
      expect(loop.tick()).toMatchObject({ kind: "spawned", pid: 1002 });
      expect(f.calls).toHaveLength(2);
    } finally {
      loop.stop();
    }
  });

  test("stop() ends the ticking", async () => {
    const f = fakeSpawner();
    const loop = startLoop({ root: temp(), stateDir: temp(), env: {}, intervalMs: 10, spawn: f.spawn, scheduling: () => ({ state: "on", via: "serve" }) });
    await until(() => f.calls.length >= 2);
    loop.stop();
    const n = f.calls.length;
    await Bun.sleep(60);
    expect(f.calls.length).toBe(n);
    expect(loop.tick()).toMatchObject({ kind: "skipped", reason: "stopped" });
  });

  test("a failing spawn or settings read is reported and the loop keeps going", async () => {
    let n = 0;
    const events: LoopEvent[] = [];
    const loop = startLoop({
      root: temp(), stateDir: temp(), env: {}, intervalMs: 10,
      spawn: () => {
        n++;
        throw new Error("spawn failed");
      },
      scheduling: () => ({ state: "on", via: "serve" }), onEvent: (e) => events.push(e),
    });
    try {
      await until(() => n >= 2);
      expect(events.filter((e) => e.kind === "error").length).toBeGreaterThanOrEqual(2);
    } finally {
      loop.stop();
    }
  });

  test("by default the scheduling setting comes from the project's runs.sqlite", async () => {
    const stateDir = temp();
    const f = fakeSpawner();
    const events: LoopEvent[] = [];
    const loop = startLoop({ root: temp(), stateDir, env: {}, intervalMs: 20, spawn: f.spawn, onEvent: (e) => events.push(e) });
    try {
      await until(() => events.length >= 1);
      expect(f.calls).toHaveLength(0);
      const db = RunsDb.open(stateDir);
      db.setScheduling({ state: "on", via: "serve" });
      db.close();
      await until(() => f.calls.length >= 1);
    } finally {
      loop.stop();
    }
  });
});

describe("the tick subprocess", () => {
  test("croft's own bin, run by the absolute Bun path without Bun's .env loading", () => {
    const argv = tickCommand();
    expect(argv[0]).toBe(process.execPath);
    expect(argv[1]).toBe("--no-env-file");
    expect(argv[2]!.endsWith(join("bin", "croft.mjs"))).toBe(true);
    expect(existsSync(argv[2]!)).toBe(true);
    expect(argv.slice(3)).toEqual(["tick"]);
  });

  test("an explicit environment: the server's, without the serve token or a confirmation grant", () => {
    expect(tickEnv({ PATH: "/bin", HOME: "/h", CROFT_SERVE_TOKEN: "t", CROFT_CONFIRM_GRANT: "g", EMPTY: undefined, CROFT_NOW: "x" }))
      .toEqual({ PATH: "/bin", HOME: "/h", CROFT_NOW: "x" });
  });

  test("spawnTick: detached, cwd = the project, exactly the env given, output appended to <state>/logs/tick.log (0600)", async () => {
    const root = temp();
    const stateDir = join(root, ".croft");
    const log = tickLogPath(stateDir);
    expect(log).toBe(join(stateDir, "logs", "tick.log"));
    const script = "console.log(JSON.stringify({ cwd: process.cwd(), env: Object.keys(process.env).filter((k) => k.startsWith('ONLY_')), pgid: process.pid })); console.error('to stderr');";
    const first = spawnTick({ root, stateDir, env: { ONLY_THIS: "1", PATH: process.env.PATH ?? "" }, argv: [process.execPath, "-e", script] });
    expect(first.pid).toBeGreaterThan(0);
    await until(() => !first.alive(), 10_000);
    const second = spawnTick({ root, stateDir, env: { ONLY_THIS: "2", PATH: process.env.PATH ?? "" }, argv: [process.execPath, "-e", script] });
    await until(() => !second.alive(), 10_000);
    const text = readFileSync(log, "utf8");
    const lines = text.trim().split("\n");
    const outputs = lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    expect(outputs).toHaveLength(2);
    expect(outputs[0]).toMatchObject({ cwd: root, env: ["ONLY_THIS"] });
    expect(text.match(/to stderr/g)).toHaveLength(2);
    // A header line per tick says who started it and when.
    expect(lines.filter((l) => l.startsWith("── ")).length).toBe(2);
    expect(statSync(log).mode & 0o777).toBe(0o600);
  });

  test("tick.log is rotated once it grows past its cap", async () => {
    const root = temp();
    const stateDir = join(root, ".croft");
    const log = tickLogPath(stateDir);
    const first = spawnTick({ root, stateDir, env: {}, argv: [process.execPath, "-e", "0"] });
    await until(() => !first.alive(), 10_000);
    writeFileSync(log, "x".repeat(2000));
    const t = spawnTick({ root, stateDir, env: {}, argv: [process.execPath, "-e", "0"], maxLogBytes: 1000 });
    await until(() => !t.alive(), 10_000);
    expect(readFileSync(`${log}.1`, "utf8")).toBe("x".repeat(2000));
    expect(readFileSync(log, "utf8").length).toBeLessThan(1000);
  });

  test("a command that cannot start is an error, not a crash", () => {
    const root = temp();
    expect(() => spawnTick({ root, stateDir: join(root, ".croft"), env: {}, argv: [join(root, "no-such-program")] })).toThrow();
  });
});
