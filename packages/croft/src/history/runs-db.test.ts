import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError, problem } from "../core/errors.ts";
import { currentIdentity } from "../core/proc.ts";
import type { StepResult } from "../core/types.ts";
import { isRunId, newRunId, RunsDb, SCHEMA_VERSION } from "./runs-db.ts";

let dir: string;
let clock: number;
let db: RunsDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "croft-runsdb-"));
  clock = Date.parse("2026-09-22T17:00:00.000Z");
  db = RunsDb.open(dir, { now: () => new Date(clock) });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const EXPECTED_COLUMNS: Record<string, string[]> = {
  runs: ["id", "trigger", "human", "argv", "pid", "proc_start", "boot_id", "started_at", "finished_at", "status", "summary"],
  steps: ["run_id", "asset", "attempt", "status", "reason", "started_at", "finished_at", "rows_in", "added", "updated",
    "error", "code_hash", "log_path"],
  leases: ["asset", "run_id", "pid", "proc_start", "boot_id", "since"],
  lock_holder: ["id", "pid", "run_id", "asset", "action", "since"],
  lock_waiters: ["pid", "purpose", "since"],
  schedule_state: ["asset", "phrase", "cron", "file_hash", "last_fire_at", "last_attempt_at", "approved_code_hash"],
  tick: ["id", "pid", "proc_start", "heartbeat_at"],
  confirmations: ["token", "command", "impact", "impact_hash", "created_at", "expires_at", "used_at"],
  catalog: ["asset", "json", "source", "refreshed_at"],
  settings: ["key", "value"],
};

describe("schema", () => {
  test("creates runs.sqlite in WAL mode with busy_timeout 5000", () => {
    expect(existsSync(join(dir, "runs.sqlite"))).toBe(true);
    expect(db.sqlite.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(db.sqlite.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    expect(db.schemaVersion()).toBe(SCHEMA_VERSION);
  });

  test("tables match DESIGN.md §5 column for column", () => {
    for (const [table, cols] of Object.entries(EXPECTED_COLUMNS)) {
      const info = db.sqlite.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
      expect(info.map((c) => c.name)).toEqual(cols);
    }
    const pk = (t: string) => (db.sqlite.query(`PRAGMA table_info(${t})`).all() as { name: string; pk: number }[])
      .filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    expect(pk("steps")).toEqual(["run_id", "asset", "attempt"]);
    expect(pk("leases")).toEqual(["asset"]);
    expect(pk("confirmations")).toEqual(["token"]);
  });

  test("singleton tables refuse a second row", () => {
    expect(() => db.sqlite.query("INSERT INTO lock_holder (id, pid) VALUES (2, 1)").run()).toThrow();
    expect(() => db.sqlite.query("INSERT INTO tick (id, pid) VALUES (2, 1)").run()).toThrow();
  });

  test("reopening keeps data and does not rerun migrations", () => {
    const run = db.createRun({ trigger: "manual", human: true, argv: ["run"] });
    db.close();
    db = RunsDb.open(dir);
    expect(db.getRun(run.id)?.id).toBe(run.id);
    expect(db.schemaVersion()).toBe(SCHEMA_VERSION);
  });

  test("a half-applied migration (tables present, version 0) reruns cleanly", () => {
    db.sqlite.exec("PRAGMA user_version = 0");
    db.close();
    db = RunsDb.open(dir);
    expect(db.schemaVersion()).toBe(SCHEMA_VERSION);
  });

  test("a file from a newer croft is refused with DB_NEWER_FORMAT", () => {
    db.sqlite.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    let err: unknown;
    try {
      RunsDb.open(dir);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CroftError);
    expect((err as CroftError).code).toBe("DB_NEWER_FORMAT");
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "croft-runsdb-"));
    db = RunsDb.open(dir);   // for afterEach
  });

  test("a second connection sees the schema without migrating", () => {
    const other = new Database(join(dir, "runs.sqlite"));
    expect((other.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    other.close();
  });
});

describe("run ids", () => {
  test("look like r_MMDD_HHMM_xxxx in the given time zone", () => {
    const at = new Date("2026-09-22T17:15:00Z");
    const la = newRunId(at, "America/Los_Angeles");
    expect(la).toMatch(/^r_0922_1015_[0-9a-z]{4}$/);
    expect(newRunId(at, "UTC")).toMatch(/^r_0922_1715_[0-9a-z]{4}$/);
    expect(newRunId(new Date("2026-01-02T00:05:00Z"), "UTC")).toMatch(/^r_0102_0005_/);
    expect(isRunId(la)).toBe(true);
    expect(isRunId("github_issues")).toBe(false);
  });

  test("are random in the suffix", () => {
    const at = new Date("2026-09-22T17:15:00Z");
    const ids = new Set(Array.from({ length: 200 }, () => newRunId(at, "UTC")));
    expect(ids.size).toBeGreaterThan(190);
  });
});

describe("runs", () => {
  test("createRun records the process identity and starts running", () => {
    const run = db.createRun({ trigger: "schedule", human: false, argv: ["run", "--due"], timeZone: "UTC" });
    const me = currentIdentity();
    expect(run).toMatchObject({
      trigger: "schedule", human: false, argv: ["run", "--due"], pid: me.pid, procStart: me.procStart,
      bootId: me.bootId, status: "running", startedAt: "2026-09-22T17:00:00.000Z", finishedAt: null, summary: null,
    });
    expect(run.id).toMatch(/^r_0922_1700_/);
    expect(db.runningRuns().map((r) => r.id)).toEqual([run.id]);
  });

  test("a caller-chosen id is used, and a duplicate is refused", () => {
    const run = db.createRun({ id: "r_0922_1000_abcd", trigger: "manual", human: true, argv: [] });
    expect(run.id).toBe("r_0922_1000_abcd");
    expect(() => db.createRun({ id: "r_0922_1000_abcd", trigger: "manual", human: true, argv: [] })).toThrow(CroftError);
  });

  test("finishRun ends a running run once, with a JSON summary", () => {
    const run = db.createRun({ trigger: "manual", human: true, argv: [] });
    clock += 5000;
    expect(db.finishRun(run.id, "succeeded", { steps: [], durationMs: 5000 })).toBe(true);
    expect(db.finishRun(run.id, "failed")).toBe(false);
    expect(db.getRun(run.id)).toMatchObject({
      status: "succeeded", finishedAt: "2026-09-22T17:00:05.000Z", summary: { steps: [], durationMs: 5000 },
    });
  });

  test("markCrashed only changes running runs", () => {
    const a = db.createRun({ trigger: "manual", human: true, argv: [] });
    const b = db.createRun({ trigger: "manual", human: true, argv: [] });
    db.finishRun(b.id, "succeeded");
    expect(db.markCrashed(a.id)).toBe(true);
    expect(db.markCrashed(a.id)).toBe(false);
    expect(db.markCrashed(b.id)).toBe(false);
    expect(db.getRun(a.id)?.status).toBe("crashed");
    expect(db.getRun(b.id)?.status).toBe("succeeded");
  });

  test("listRuns filters by asset, failure, time and status, newest first", () => {
    const r1 = db.createRun({ trigger: "manual", human: true, argv: [] });
    db.startStep({ runId: r1.id, asset: "orders", attempt: 1, reason: "requested" });
    db.finishStep(r1.id, "orders", 1, { status: "ok" });
    db.finishRun(r1.id, "succeeded");
    clock += 60_000;
    const r2 = db.createRun({ trigger: "schedule", human: false, argv: [] });
    db.startStep({ runId: r2.id, asset: "orders", attempt: 1, reason: "schedule_due" });
    db.finishStep(r2.id, "orders", 1, { status: "failed" });
    db.startStep({ runId: r2.id, asset: "customers", attempt: 1, reason: "schedule_due" });
    db.finishStep(r2.id, "customers", 1, { status: "ok" });
    db.finishRun(r2.id, "failed");
    clock += 60_000;
    const r3 = db.createRun({ trigger: "manual", human: true, argv: [] });
    db.startStep({ runId: r3.id, asset: "customers", attempt: 1, reason: "requested" });

    expect(db.listRuns().map((r) => r.id)).toEqual([r3.id, r2.id, r1.id]);
    expect(db.listRuns({ limit: 1 }).map((r) => r.id)).toEqual([r3.id]);
    expect(db.listRuns({ asset: "orders" }).map((r) => r.id)).toEqual([r2.id, r1.id]);
    expect(db.listRuns({ failed: true }).map((r) => r.id)).toEqual([r2.id]);
    expect(db.listRuns({ asset: "customers", failed: true })).toEqual([]);
    expect(db.listRuns({ asset: "orders", failed: true }).map((r) => r.id)).toEqual([r2.id]);
    expect(db.listRuns({ since: "2026-09-22T17:01:00Z" }).map((r) => r.id)).toEqual([r3.id, r2.id]);
    expect(db.listRuns({ since: new Date("2026-09-22T17:01:30Z") }).map((r) => r.id)).toEqual([r3.id]);
    expect(db.listRuns({ status: ["running"] }).map((r) => r.id)).toEqual([r3.id]);
    expect(() => db.listRuns({ since: "yesterday-ish" })).toThrow(CroftError);
  });
});

describe("steps", () => {
  test("start, finish and read back a step, including a StepResult", () => {
    const run = db.createRun({ trigger: "manual", human: true, argv: [] });
    const s = db.startStep({ runId: run.id, asset: "orders", attempt: 1, reason: "requested", codeHash: "h1",
      logPath: "/x/orders.log" });
    expect(s).toMatchObject({ status: "running", reason: "requested", codeHash: "h1", logPath: "/x/orders.log", finishedAt: null });
    const result: StepResult = {
      asset: "orders", status: "failed", reason: "requested", behavior: "merge by id", attempt: 1, maxAttempts: 3,
      rows: { in: 10, added: 4, updated: 2, unchanged: 4, deleted: 0, total: 100 }, schemaChanges: [], checks: [],
      logsCommand: "croft logs orders", durationMs: 12,
      error: { severity: "error", code: "HTTP_ERROR", message: "500", hint: "retry", docs: "croft docs HTTP_ERROR" },
    };
    clock += 1000;
    expect(db.finishStep(run.id, "orders", 1, result)).toBe(true);
    expect(db.finishStep(run.id, "orders", 1, { status: "ok" })).toBe(false);   // already finished
    expect(db.getStep(run.id, "orders", 1)).toMatchObject({
      status: "failed", rowsIn: 10, added: 4, updated: 2, finishedAt: "2026-09-22T17:00:01.000Z",
      error: { code: "HTTP_ERROR", message: "500" },
    });
  });

  test("a step cannot be started twice with the same attempt", () => {
    const run = db.createRun({ trigger: "manual", human: true, argv: [] });
    db.startStep({ runId: run.id, asset: "orders", attempt: 1, reason: "requested" });
    expect(() => db.startStep({ runId: run.id, asset: "orders", attempt: 1, reason: "requested" })).toThrow(/already started/);
    db.startStep({ runId: run.id, asset: "orders", attempt: 2, reason: "requested" });
    expect(db.stepsFor(run.id).map((s) => s.attempt)).toEqual([1, 2]);
  });

  test("latestStep returns the last attempt of the last run, optionally only failures", () => {
    const r1 = db.createRun({ trigger: "manual", human: true, argv: [] });
    db.startStep({ runId: r1.id, asset: "orders", attempt: 1, reason: "requested" });
    db.finishStep(r1.id, "orders", 1, { status: "failed" });
    clock += 1000;
    db.startStep({ runId: r1.id, asset: "orders", attempt: 2, reason: "requested" });
    db.finishStep(r1.id, "orders", 2, { status: "ok" });
    expect(db.latestStep("orders")).toMatchObject({ runId: r1.id, attempt: 2, status: "ok" });
    expect(db.latestStep("orders", { failed: true })).toMatchObject({ runId: r1.id, attempt: 1, status: "failed" });
    expect(db.latestStep("nothing")).toBeNull();
  });

  test("lastCheckSources: the checks the asset's last ok step ran, from its run's summary; null when unknown", () => {
    const result = (asset: string, status: StepResult["status"], checks: string[]): Partial<StepResult> =>
      ({ asset, status, checks: checks.map((check) => ({ check, ok: true, failing: 0 })) });
    expect(db.lastCheckSources("orders")).toBeNull();

    const r1 = db.createRun({ trigger: "manual", human: true, argv: [] });
    db.startStep({ runId: r1.id, asset: "orders", attempt: 1, reason: "requested" });
    db.finishStep(r1.id, "orders", 1, { status: "ok" });
    // Still running: its summary holds progress only.
    db.setRunProgress(r1.id, { asset: "orders" });
    expect(db.lastCheckSources("orders")).toBeNull();
    db.finishRun(r1.id, "succeeded", { data: { runId: r1.id, steps: [result("orders", "ok", ["unique(id)", "not_null(id)"]), result("x", "ok", ["min_rows(1)"])] } });
    expect(db.lastCheckSources("orders")).toEqual(["unique(id)", "not_null(id)"]);

    // A later failed step does not count (its write rolled back); a later ok one does, even with no checks.
    clock += 1000;
    const r2 = db.createRun({ trigger: "manual", human: true, argv: [] });
    db.startStep({ runId: r2.id, asset: "orders", attempt: 1, reason: "requested" });
    db.finishStep(r2.id, "orders", 1, { status: "failed" });
    db.finishRun(r2.id, "failed", { data: { runId: r2.id, steps: [result("orders", "failed", ["unique(id)", "amount >= 0"])] } });
    expect(db.lastCheckSources("orders")).toEqual(["unique(id)", "not_null(id)"]);
    clock += 1000;
    const r3 = db.createRun({ trigger: "manual", human: true, argv: [] });
    db.startStep({ runId: r3.id, asset: "orders", attempt: 1, reason: "requested" });
    db.finishStep(r3.id, "orders", 1, { status: "ok" });
    db.finishRun(r3.id, "succeeded", { data: { runId: r3.id, steps: [result("orders", "ok", [])] } });
    expect(db.lastCheckSources("orders")).toEqual([]);

    // A crashed run keeps no summary: unknown again.
    clock += 1000;
    const r4 = db.createRun({ trigger: "manual", human: true, argv: [] });
    db.startStep({ runId: r4.id, asset: "orders", attempt: 1, reason: "requested" });
    db.finishStep(r4.id, "orders", 1, { status: "ok", reason: "requested (recovered)" });
    db.markCrashed(r4.id);
    expect(db.lastCheckSources("orders")).toBeNull();
  });

  test("danglingSteps lists the unchecked steps of ended runs only", () => {
    const live = db.createRun({ trigger: "manual", human: true, argv: [] });
    db.startStep({ runId: live.id, asset: "a", attempt: 1, reason: "requested" });
    const dead = db.createRun({ trigger: "manual", human: true, argv: [] });
    db.startStep({ runId: dead.id, asset: "b", attempt: 1, reason: "requested" });
    db.startStep({ runId: dead.id, asset: "c", attempt: 1, reason: "requested" });
    db.finishStep(dead.id, "c", 1, { status: "ok" });
    db.markCrashed(dead.id);
    expect(db.danglingSteps().map((s) => [s.runId, s.asset])).toEqual([[dead.id, "b"]]);
    // A step an older croft left running in a run that ended is dangling too.
    clock += 1000;
    const old = db.createRun({ trigger: "manual", human: true, argv: [] });
    db.startStep({ runId: old.id, asset: "d", attempt: 1, reason: "requested" });
    db.sqlite.query("UPDATE runs SET status = 'crashed' WHERE id = ?").run(old.id);
    expect(db.danglingSteps().map((s) => [s.runId, s.asset])).toEqual([[dead.id, "b"], [old.id, "d"]]);
    // Once reconcile has checked a step, it is not dangling any more.
    const lost = problem("RUN_CRASHED", { message: "lost", hint: "run it again" });
    expect(db.settleStep(dead.id, "b", 1, { status: "crashed", error: lost })).toBe(true);
    expect(db.settleStep(old.id, "d", 1, { status: "ok", reason: "requested (recovered)" })).toBe(true);
    expect(db.danglingSteps()).toEqual([]);
    expect(db.getStep(dead.id, "b", 1)).toMatchObject({ status: "crashed", error: { message: "lost" } });
  });

  // A detached run's parent (and croft wait) marks a dead run crashed as soon as it sees the child die. Its steps
  // must say crashed at once too: status reads a running step of an ended run as running, not crashed.
  test("markCrashed crashes the run's running steps too, unchecked until reconcile settles them", () => {
    const run = db.createRun({ trigger: "manual", human: true, argv: ["run"], identity: { ...currentIdentity(), pid: 4242 } });
    db.startStep({ runId: run.id, asset: "orders", attempt: 1, reason: "requested" });
    db.finishStep(run.id, "orders", 1, { status: "ok" });
    db.startStep({ runId: run.id, asset: "labels", attempt: 1, reason: "input orders has new rows" });
    const other = db.createRun({ trigger: "manual", human: true, argv: ["run"] });
    db.startStep({ runId: other.id, asset: "refs", attempt: 1, reason: "requested" });
    clock += 5000;

    expect(db.markCrashed(run.id)).toBe(true);
    expect(db.getRun(run.id)).toMatchObject({ status: "crashed", finishedAt: "2026-09-22T17:00:05.000Z" });
    expect(db.getStep(run.id, "orders", 1)?.status).toBe("ok");
    const crashed = db.getStep(run.id, "labels", 1)!;
    // No finish time yet: reconcile() has not checked the warehouse for a commit that landed before the crash.
    expect(crashed).toMatchObject({ status: "crashed", reason: "input orders has new rows", finishedAt: null });
    expect(crashed.error).toMatchObject({
      code: "RUN_CRASHED", asset: "labels", runId: run.id, retryable: true,
      fix: { kind: "command", command: "croft run labels" },
    });
    expect(crashed.error!.message).toContain("pid 4242");
    expect(db.latestStep("labels", { failed: true })?.runId).toBe(run.id);
    expect(db.getStep(other.id, "refs", 1)?.status).toBe("running");
    expect(db.danglingSteps().map((s) => [s.runId, s.asset, s.status])).toEqual([[run.id, "labels", "crashed"]]);

    // A late finish from a process wrongly thought dead cannot overwrite it; only reconcile's check settles it.
    expect(db.finishStep(run.id, "labels", 1, { status: "ok" })).toBe(false);
    clock += 1000;
    expect(db.settleStep(run.id, "labels", 1, { status: "ok", reason: "input orders has new rows (recovered)", rows: { in: 3, added: 3 } })).toBe(true);
    expect(db.getStep(run.id, "labels", 1)).toMatchObject({
      status: "ok", reason: "input orders has new rows (recovered)", added: 3, error: null, finishedAt: "2026-09-22T17:00:06.000Z",
    });
    expect(db.settleStep(run.id, "labels", 1, { status: "crashed" })).toBe(false);
    expect(db.danglingSteps()).toEqual([]);

    // A run that was not running changes nothing, steps included.
    db.startStep({ runId: run.id, asset: "late", attempt: 1, reason: "requested" });
    expect(db.markCrashed(run.id)).toBe(false);
    expect(db.getStep(run.id, "late", 1)?.status).toBe("running");
  });
});

describe("lock holder and waiters", () => {
  test("set, read and clear the holder; only the owner clears it", () => {
    expect(db.getLockHolder()).toBeNull();
    db.setLockHolder({ runId: "r_0922_1000_abcd", asset: "orders", action: "write" });
    expect(db.getLockHolder()).toEqual({ pid: process.pid, program: "croft", runId: "r_0922_1000_abcd",
      asset: "orders", action: "write", since: "2026-09-22T17:00:00.000Z" });
    db.setLockHolder({ pid: 999_999, action: "read" });
    expect(db.getLockHolder()).toMatchObject({ pid: 999_999, action: "read" });
    expect(db.getLockHolder()?.runId).toBeUndefined();
    expect(db.clearLockHolder()).toBe(false);
    expect(db.clearLockHolder(999_999)).toBe(true);
    expect(db.getLockHolder()).toBeNull();
  });

  test("waiters register, list and unregister", () => {
    expect(db.hasOtherWaiters()).toBe(false);
    db.registerWaiter("run orders");
    expect(db.hasOtherWaiters()).toBe(false);
    db.registerWaiter("query", 4242);
    db.registerWaiter("query again", 4242);   // upsert, not a second row
    expect(db.listWaiters()).toHaveLength(2);
    expect(db.hasOtherWaiters()).toBe(true);
    db.unregisterWaiter(4242);
    db.unregisterWaiter();
    expect(db.listWaiters()).toEqual([]);
  });
});

describe("catalog", () => {
  test("put, get, overwrite, list and delete", () => {
    expect(db.catalogGet("orders")).toBeNull();
    db.catalogPut("orders", { columns: [{ name: "id", type: "BIGINT" }] }, "run");
    clock += 1000;
    db.catalogPut("customers", { columns: [] }, "preview");
    db.catalogPut("orders", { columns: [{ name: "id", type: "VARCHAR" }] }, "pins");
    expect(db.catalogGet<{ columns: { name: string; type: string }[] }>("orders")).toEqual({
      asset: "orders", value: { columns: [{ name: "id", type: "VARCHAR" }] }, source: "pins",
      refreshedAt: "2026-09-22T17:00:01.000Z",
    });
    expect(db.catalogAll().map((e) => e.asset)).toEqual(["customers", "orders"]);
    expect(db.catalogDelete("orders")).toBe(true);
    expect(db.catalogDelete("orders")).toBe(false);
  });
});

describe("approved code (the scheduler hold, §6)", () => {
  test("approveCode records the hash a human ran, replacing the previous one; other schedule_state columns stay", () => {
    expect(db.approvedCode("zones")).toBeNull();
    db.approveCode("zones", "h1");
    expect(db.approvedCode("zones")).toBe("h1");
    db.sqlite.query("UPDATE schedule_state SET phrase = 'every hour' WHERE asset = 'zones'").run();
    db.approveCode("zones", "h2");
    expect(db.approvedCode("zones")).toBe("h2");
    expect(db.sqlite.query("SELECT phrase FROM schedule_state WHERE asset = 'zones'").get()).toEqual({ phrase: "every hour" });
    expect(db.approvedCode("other")).toBeNull();
  });
});

describe("settings and scheduling (§8)", () => {
  test("scheduling is off until set; a setting survives reopening", () => {
    expect(db.getScheduling()).toEqual({ state: "off", via: null });
    db.setScheduling({ state: "on", via: "os-job" });
    expect(db.getScheduling()).toEqual({ state: "on", via: "os-job" });
    db.close();
    db = RunsDb.open(dir, { now: () => new Date(clock) });
    expect(db.getScheduling()).toEqual({ state: "on", via: "os-job" });
    expect(db.getSetting("nothing")).toBeNull();
  });

  test("a pause with an end reads as paused until then, and as on after", () => {
    db.setScheduling({ state: "paused", via: "serve", pausedUntil: "2026-09-22T19:00:00.000Z" });
    expect(db.getScheduling()).toEqual({ state: "paused", via: "serve", pausedUntil: "2026-09-22T19:00:00.000Z" });
    clock = Date.parse("2026-09-22T19:00:00.000Z");
    expect(db.getScheduling()).toEqual({ state: "on", via: "serve" });
  });

  test("an open-ended pause stays paused; junk reads as off", () => {
    db.setScheduling({ state: "paused", via: "os-job" });
    expect(db.getScheduling()).toEqual({ state: "paused", via: "os-job", pausedUntil: null });
    db.setSetting("scheduling", { state: "sideways" });
    expect(db.getScheduling()).toEqual({ state: "off", via: null });
  });
});
