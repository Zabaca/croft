// When a lake's next maintenance pass is due (db/lake-maintenance-state.ts; DESIGN.md D150; option 07, slice 3): a pure function of what runs.sqlite
// remembers, the setting and the clock.
import { describe, expect, test } from "bun:test";
import { ensureState, type MaintenanceState, maintenanceDue, maintenanceView, noteSpawned, readState, SPAWN_GRACE_MS } from "./lake-maintenance-state.ts";

const HOUR = 3_600_000;
const T = new Date("2026-11-02T12:00:00Z");
const at = (hours: number): Date => new Date(T.getTime() + hours * HOUR);
const CFG = { enabled: true, everyHours: 24 };

const state = (over: Partial<MaintenanceState> = {}): MaintenanceState => ({
  baselineAt: T.toISOString(), lastAttemptAt: null, lastOkAt: null, last: null, lastError: null, running: null, spawnedAt: null, ...over,
});
const dead = () => false;
const alive = () => true;

describe("when a pass is due", () => {
  test("never when it is off, and not at the first look: a lake is stamped when croft first sees it", () => {
    expect(maintenanceDue(null, { enabled: false, everyHours: 24 }, at(1000))).toMatchObject({ due: false, why: "off" });
    expect(maintenanceDue(state(), { enabled: false, everyHours: 24 }, at(1000))).toMatchObject({ due: false, why: "off" });
    expect(maintenanceDue(null, CFG, T)).toMatchObject({ due: false, why: "waiting" });
  });

  test("a day after the lake was first seen, then a day after each pass that worked", () => {
    expect(maintenanceDue(state(), CFG, at(23.9), dead).due).toBe(false);
    expect(maintenanceDue(state(), CFG, at(24), dead)).toMatchObject({ due: true, why: "interval" });
    const worked = state({ lastAttemptAt: at(30).toISOString(), lastOkAt: at(30).toISOString() });
    expect(maintenanceDue(worked, CFG, at(53.9), dead)).toMatchObject({ due: false, why: "waiting", at: at(54).toISOString() });
    expect(maintenanceDue(worked, CFG, at(54), dead).due).toBe(true);
    expect(maintenanceDue(worked, { enabled: true, everyHours: 6 }, at(36), dead).due).toBe(true);
  });

  test("an hour after a pass that failed (or sooner than the interval, when the interval is shorter), until one works", () => {
    const failed = state({ lastAttemptAt: at(30).toISOString(), lastOkAt: at(5).toISOString(), lastError: { at: at(30).toISOString(), step: "cleanup", code: "LAKE_MAINTENANCE_FAILED", message: "x" } });
    expect(maintenanceDue(failed, CFG, at(30.9), dead)).toMatchObject({ due: false, why: "waiting" });
    expect(maintenanceDue(failed, CFG, at(31), dead)).toMatchObject({ due: true, why: "retry" });
    expect(maintenanceDue(failed, { enabled: true, everyHours: 1 }, at(31), dead).due).toBe(true);
    // A pass that worked after the failure clears it.
    expect(maintenanceDue({ ...failed, lastOkAt: at(31).toISOString(), lastAttemptAt: at(31).toISOString(), lastError: null }, CFG, at(32), dead).due).toBe(false);
  });

  test("not while a pass runs: a live claim, or a pass the tick started a moment ago; a claim whose process is gone does not count", () => {
    const running = state({ running: { pid: 1, procStart: "x", bootId: "y", at: at(30).toISOString() } });
    expect(maintenanceDue(running, CFG, at(40), alive)).toMatchObject({ due: false, why: "running" });
    expect(maintenanceDue(running, CFG, at(40), dead)).toMatchObject({ due: true, why: "interval" });
    const spawned = state({ spawnedAt: at(30).toISOString() });
    expect(maintenanceDue(spawned, CFG, new Date(at(30).getTime() + SPAWN_GRACE_MS - 1), dead)).toMatchObject({ due: false, why: "running" });
    expect(maintenanceDue(spawned, CFG, new Date(at(30).getTime() + SPAWN_GRACE_MS), dead).due).toBe(true);
  });
});

describe("what croft remembers", () => {
  const store = () => {
    let value: unknown = null;
    return { getSetting: <T>() => value as T | null, setSetting: (_k: string, v: unknown) => void (value = JSON.parse(JSON.stringify(v))) };
  };

  test("the first look stamps the baseline and keeps it; the tick's note is kept with it", () => {
    const s = store();
    expect(readState(s)).toBeNull();
    expect(ensureState(s, T).baselineAt).toBe(T.toISOString());
    expect(ensureState(s, at(5)).baselineAt).toBe(T.toISOString());
    noteSpawned(s, at(6));
    expect(readState(s)).toMatchObject({ baselineAt: T.toISOString(), spawnedAt: at(6).toISOString(), running: null });
  });

  test("the view says whether it is on, the last pass and the next", () => {
    const view = maintenanceView(state({ lastOkAt: at(30).toISOString(), lastAttemptAt: at(30).toISOString() }), CFG, at(40));
    expect(view).toMatchObject({ enabled: true, everyHours: 24, lastOkAt: at(30).toISOString(), nextDueAt: at(54).toISOString(), lastPass: null, lastError: null });
    expect(maintenanceView(null, { enabled: false, everyHours: 24 }, at(40))).toMatchObject({ enabled: false, nextDueAt: null });
    expect(maintenanceView(state(), CFG, at(100)).nextDueAt).toBe(at(100).toISOString());
  });
});
