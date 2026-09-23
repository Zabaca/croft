import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootId, currentIdentity, procStart } from "../core/proc.ts";
import {
  acquire, heldCount, intentDir, intentFileName, isHolderAlive, listIntents, liveIntents, purgeDead, release, resume,
  waitForNoIntents, withdraw,
} from "./intent.ts";

const stateDir = () => realpathSync(mkdtempSync(join(tmpdir(), "croft-intent-")));

function plant(state: string, id: { pid: number; procStart: string; bootId: string }, runId = "r_old") {
  mkdirSync(intentDir(state), { recursive: true });
  const file = join(intentDir(state), intentFileName(id));
  writeFileSync(file, JSON.stringify({ ...id, runId, since: new Date().toISOString() }));
  return file;
}

describe("acquire and release", () => {
  test("one file per holder with {pid, procStart, bootId, runId, since}; no temp files left", () => {
    const state = stateDir();
    const intent = acquire(state, { runId: "r_1" });
    const names = readdirSync(intentDir(state));
    expect(names).toEqual([intentFileName(currentIdentity())]);
    expect(names[0]).toMatch(/^\d+-[A-Za-z0-9_]+\.json$/);
    const onDisk = JSON.parse(readFileSync(join(intentDir(state), names[0]!), "utf8"));
    expect(onDisk).toEqual({ ...currentIdentity(), runId: "r_1", since: intent.since });
    expect(Date.parse(onDisk.since)).toBeGreaterThan(0);
    release(state);
    expect(readdirSync(intentDir(state))).toEqual([]);
  });

  test("an in-process reference count covers concurrent leases", () => {
    const state = stateDir();
    acquire(state);
    acquire(state);
    expect(heldCount(state)).toBe(2);
    release(state);
    expect(liveIntents(state)).toHaveLength(1); // still held by the second lease
    release(state);
    expect(heldCount(state)).toBe(0);
    expect(listIntents(state)).toHaveLength(0);
    release(state); // extra release is harmless
  });

  test("withdraw and resume keep the references", () => {
    const state = stateDir();
    acquire(state, { runId: "r_2" });
    withdraw(state);
    expect(listIntents(state)).toHaveLength(0);
    expect(heldCount(state)).toBe(1);
    resume(state);
    expect(liveIntents(state).map((i) => i.runId)).toEqual(["r_2"]);
    release(state);
    expect(listIntents(state)).toHaveLength(0);
  });
});

describe("liveness", () => {
  test("own intent is live; excludeSelf hides it", () => {
    const state = stateDir();
    acquire(state);
    expect(liveIntents(state)).toHaveLength(1);
    expect(liveIntents(state, { excludeSelf: true })).toHaveLength(0);
    release(state);
  });

  test("an intent from another boot, a reused PID or an exited process is dead and purged", async () => {
    const state = stateDir();
    const me = currentIdentity();
    const otherBoot = plant(state, { ...me, bootId: "another-boot" });
    // Same PID as a live process but a different start time: the PID was reused.
    plant(state, { pid: me.pid, procStart: "Mon Jan  1 00:00:00 2001", bootId: bootId() });
    const child = spawn("sleep", ["0.05"]);
    const exited = { pid: child.pid!, procStart: procStart(child.pid!)!, bootId: bootId() };
    plant(state, exited);
    expect(isHolderAlive(exited)).toBe(true);
    await new Promise((r) => child.on("exit", r));
    expect(isHolderAlive(exited)).toBe(false);
    writeFileSync(join(intentDir(state), "garbage.json"), "{not json");
    expect(listIntents(state)).toHaveLength(4);
    expect(liveIntents(state)).toHaveLength(0);
    const removed = purgeDead(state);
    expect(removed.map((r) => r.file)).toContain(otherBoot);
    expect(removed).toHaveLength(4);
    expect(readdirSync(intentDir(state))).toEqual([]);
  });

  test("an intent whose boot id could not be read is live while its process is (never purged as dead)", async () => {
    const state = stateDir();
    const child = spawn("sleep", ["30"]);
    try {
      for (const boot of ["", "unknown"]) {
        const id = { pid: child.pid!, procStart: procStart(child.pid!)!, bootId: boot };
        const file = plant(state, id);
        expect(isHolderAlive(id)).toBe(true);
        expect(purgeDead(state)).toEqual([]);
        expect(liveIntents(state).map((i) => i.file)).toEqual([file]);
        purgeDead(state);
        rmSync(file);
      }
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("purgeDead keeps live intents", () => {
    const state = stateDir();
    acquire(state);
    expect(purgeDead(state)).toEqual([]);
    expect(liveIntents(state)).toHaveLength(1);
    release(state);
  });
});

describe("waitForNoIntents", () => {
  test("resolves when the last other live intent goes away", async () => {
    const state = stateDir();
    const child = spawn("sleep", ["0.3"]);
    plant(state, { pid: child.pid!, procStart: procStart(child.pid!)!, bootId: bootId() });
    const started = Date.now();
    expect(await waitForNoIntents(state, { timeoutMs: 5000, pollMs: 20 })).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });

  test("times out while a live intent remains; ignores this process's own", async () => {
    const state = stateDir();
    acquire(state);
    expect(await waitForNoIntents(state, { timeoutMs: 50 })).toBe(true);
    release(state);
    const child = spawn("sleep", ["5"]);
    plant(state, { pid: child.pid!, procStart: procStart(child.pid!)!, bootId: bootId() });
    expect(await waitForNoIntents(state, { timeoutMs: 120, pollMs: 20 })).toBe(false);
    child.kill();
  });
});
