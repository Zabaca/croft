// The project tick (schedule/tick.ts, cli/commands/tick.ts; DESIGN.md §8 "Each tick only plans and spawns"): exits
// when scheduling is off or paused, the singleton, the heartbeat, reconcile, one detached run per group with the
// fire recorded first, runs still starting counted as taken, a fire the run did not attempt (a child that died
// before it recorded the run, a lease met after planning, a spawn that failed) staying due, and, in real processes,
// a tick with nothing changed importing no asset code, a tick never importing code nobody has run, and a real tick
// starting a real `croft run --due` against a mock API.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentIdentity, type ProcessIdentity } from "../core/proc.ts";
import { closeAllWarehouses } from "../db/warehouse.ts";
import { writeChildRecord } from "../run/detach.ts";
import { cleanupProjects, cli, cliEnv, keysetIssues, mockApi, runIn, until } from "../run/testkit.ts";
import { tryAcquire } from "../history/leases.ts";
import { FAILED_STARTS_SETTING, RETRY_BACKOFF_MS, SPAWNED_SETTING } from "./due.ts";
import type { ScheduledFailure } from "./notify.ts";
import {
  approveAll, built, DEAD, imports, recordStep, type SchedProject, schedProject, scheduledIngest, scheduleStateOf, scheduling,
} from "./scheduler-testkit.ts";
import { projectTick, type SpawnRequest, type TickInput } from "./tick.ts";
import { formatTick } from "../cli/commands/tick.ts";

const api = mockApi();
afterAll(async () => {
  api.stop();
  await closeAllWarehouses();
  cleanupProjects();
});

const at = (iso: string) => new Date(iso);

/** A tick in this process, with a spawner that records what it would start (and the child's handshake). */
async function tick(p: SchedProject, now: string, o: Partial<TickInput> = {}) {
  const spawned: SpawnRequest[] = [];
  const out = await projectTick({
    project: p.project, env: { PATH: "/usr/bin:/bin", HOME: "/tmp", CROFT_CONFIRM_GRANT: "g_secret" }, now: at(now),
    spawn: async (r) => {
      spawned.push(r);
      // The child: this process, alive, as run/detach.ts records it.
      writeChildRecord(r.stateDir, r.runId, currentIdentity());
    },
    ...o,
  });
  return { ...out, spawned };
}

/** issues (hourly) → open_issues (SQL), approved and built by hand at 10:05, scheduling on. */
async function pipeline(): Promise<SchedProject> {
  const p = schedProject({ "assets/issues.ts": scheduledIngest(), "assets/open_issues.sql": "select id from issues\n" });
  scheduling(p, "on");
  await tick(p, "2026-09-22T10:05:00Z", { spawn: async () => {} });
  approveAll(p);
  built(p, "issues", { lastLoadedAt: "2026-09-22T10:05:00.000000Z" });
  built(p, "open_issues", { kind: "sql", lastLoadedAt: "2026-09-22T10:05:01.000000Z", inputsSeen: { issues: { inputLastLoadedAt: "2026-09-22T10:05:00.000000Z" } } });
  recordStep(p, { asset: "issues", at: "2026-09-22T10:05:00Z", status: "ok" });
  recordStep(p, { asset: "open_issues", at: "2026-09-22T10:05:01Z", status: "ok" });
  // A tick after the run by hand: it imports the approved code (nothing is due).
  await tick(p, "2026-09-22T10:05:30Z", { spawn: async () => { throw new Error("nothing is due"); } });
  const db = p.db();
  db.setSetting(SPAWNED_SETTING, []);
  db.close();
  return p;
}

describe("croft tick exits at once unless scheduling is on", () => {
  test("off: exits scheduling_off, with no heartbeat and nothing started", async () => {
    const p = schedProject({ "assets/issues.ts": scheduledIngest() });
    const out = await tick(p, "2026-09-22T11:00:30Z");
    expect(out.result).toMatchObject({ exited: "scheduling_off", heartbeatAt: null, spawned: [], held: [], importedAssetCode: false });
    expect(out.spawned).toEqual([]);
    const db = p.db();
    expect(db.getTick()).toBeNull();
    db.close();
  });

  test("paused: exits paused; a pause whose end has passed reads as on", async () => {
    const p = await pipeline();
    scheduling(p, "paused", "2026-09-22T12:00:00.000Z");
    expect((await tick(p, "2026-09-22T11:00:30Z")).result.exited).toBe("paused");
    scheduling(p, "paused");
    expect((await tick(p, "2026-09-22T11:00:30Z")).result.exited).toBe("paused");
    scheduling(p, "paused", "2026-09-22T11:00:00.000Z");
    const out = await tick(p, "2026-09-22T11:00:30Z");
    expect(out.result.exited).toBeNull();
    expect(out.spawned.map((s) => s.assets)).toEqual([["issues"]]);
  });
});

describe("the singleton", () => {
  test("of two concurrent ticks, the second exits another_tick; a dead holder is taken over", async () => {
    const p = await pipeline();
    const A: ProcessIdentity = { pid: 424_242, procStart: "1", bootId: "b" };
    const B: ProcessIdentity = { pid: 434_343, procStart: "2", bootId: "b" };
    // A is alive while it holds the singleton; B is always alive.
    let aRunning = true;
    const alive = (r: { pid: number | null }) => r.pid === B.pid || (r.pid === A.pid && aRunning) || r.pid === process.pid;
    let second: Awaited<ReturnType<typeof tick>> | undefined;
    const first = await tick(p, "2026-09-22T11:00:30Z", {
      identity: A, alive,
      onClaimed: async () => {
        second = await tick(p, "2026-09-22T11:00:31Z", { identity: B, alive });
      },
    });
    expect(second!.result.exited).toBe("another_tick");
    expect(second!.spawned).toEqual([]);
    expect(first.result.exited).toBeNull();
    expect(first.spawned.map((s) => s.assets)).toEqual([["issues"]]);
    // A released it: B gets it.
    expect((await tick(p, "2026-09-22T11:01:30Z", { identity: B, alive })).result.exited).toBeNull();

    // A holder that died without releasing (killed mid-tick) does not block the next tick.
    const db = p.db();
    db.claimTick(() => false, { pid: DEAD.pid, procStart: DEAD.procStart, bootId: DEAD.bootId });
    expect(db.getTick()?.pid).toBe(DEAD.pid);
    db.close();
    aRunning = false;
    expect((await tick(p, "2026-09-22T11:02:30Z", { identity: B, alive })).result.exited).toBeNull();
  });
});

describe("a tick records a heartbeat, reconciles, and starts one run per group", () => {
  test("the heartbeat is the tick's time (CROFT_NOW), and the singleton is released", async () => {
    const p = await pipeline();
    const out = await tick(p, "2026-09-22T10:30:00Z");
    expect(out.result.heartbeatAt).toBe("2026-09-22T10:30:00.000Z");
    const db = p.db();
    expect(db.getTick()).toEqual({ pid: null, procStart: null, heartbeatAt: "2026-09-22T10:30:00.000Z" });
    db.close();
  });

  test("a run whose process died becomes crashed; a scheduled one notifies", async () => {
    const p = await pipeline();
    const db = p.db();
    const gone = db.createRun({ trigger: "schedule", human: false, argv: ["run", "--due", "issues"], identity: DEAD });
    db.startStep({ runId: gone.id, asset: "issues", attempt: 1, reason: "scheduled" });
    const manual = db.createRun({ trigger: "manual", human: true, argv: ["run", "open_issues"], identity: DEAD });
    db.close();
    const notified: ScheduledFailure[] = [];
    const out = await tick(p, "2026-09-22T10:30:00Z", { notify: async (_root, f) => void notified.push(f) });
    const db2 = p.db();
    expect(db2.getRun(gone.id)?.status).toBe("crashed");
    expect(db2.getRun(manual.id)?.status).toBe("crashed");
    expect(db2.stepsFor(gone.id)[0]?.status).toBe("crashed");
    db2.close();
    expect(out.result.exited).toBeNull();
    expect(notified).toEqual([{ project: p.root, runId: gone.id, failed: [{ asset: "issues", error: expect.objectContaining({ code: "RUN_CRASHED" }) }] }]);
    // The step could not be checked against the warehouse (there is none yet): a warning, for a later tick.
    expect(out.problems.map((x) => [x.code, x.severity])).toEqual([["DB_NOT_FOUND", "warning"]]);
  });

  test("with nothing to reconcile, there is nothing to report or notify", async () => {
    const p = await pipeline();
    const out = await tick(p, "2026-09-22T10:30:00Z", { notify: async () => { throw new Error("not called"); } });
    expect(out.problems).toEqual([]);
  });

  test("due work: one detached run per group, with an explicit environment; the fire is recorded before it starts", async () => {
    const p = await pipeline();
    const out = await tick(p, "2026-09-22T11:00:30Z");
    expect(out.problems).toEqual([]);
    expect(out.spawned).toHaveLength(1);
    const s = out.spawned[0]!;
    expect(s).toMatchObject({ root: p.root, stateDir: p.stateDir, assets: ["issues"] });
    expect(s.runId).toMatch(/^r_0922_1100_[0-9a-z]{4}$/);
    // The tick's own environment, given explicitly, without a confirmation grant.
    expect(s.env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/tmp", CROFT_CONFIRM_GRANT: undefined });
    expect(out.result).toMatchObject({
      exited: null, heartbeatAt: "2026-09-22T11:00:30.000Z", spawned: [{ runId: s.runId, assets: ["issues"] }], held: [], importedAssetCode: false,
    });
    expect(scheduleStateOf(p, "issues")).toMatchObject({ lastFireAt: "2026-09-22T11:00:00.000Z", lastAttemptAt: "2026-09-22T11:00:30.000Z" });
    // Noted with the run: the fire, and the last_fire_at it replaced.
    const db = p.db();
    expect(db.getSetting<unknown[]>(SPAWNED_SETTING)).toEqual([{
      runId: s.runId, assets: ["issues"], at: "2026-09-22T11:00:30.000Z", fires: { issues: { fire: "2026-09-22T11:00:00.000Z", before: null } },
    }]);
    db.close();

    // The next tick: the run is starting (its child is alive): nothing starts again.
    expect((await tick(p, "2026-09-22T11:01:30Z")).spawned).toEqual([]);
  });

  test("a stale transform the last tick started is not started again while that run is starting", async () => {
    const p = await pipeline();
    built(p, "issues", { lastLoadedAt: "2026-09-22T10:10:00.000000Z" });
    recordStep(p, { asset: "issues", at: "2026-09-22T10:10:00Z", status: "ok" });
    const first = await tick(p, "2026-09-22T10:20:00Z");
    expect(first.spawned.map((s) => s.assets)).toEqual([["open_issues"]]);
    const runId = first.spawned[0]!.runId;
    const again = await tick(p, "2026-09-22T10:21:00Z");
    expect(again.spawned).toEqual([]);
    expect(again.result.held).toEqual([{ asset: "open_issues", code: "leased", reason: `the scheduled run ${runId} is starting; it stays due` }]);
    // Its process is gone and it never recorded a run: a failed start, reported and notified; the transform waits
    // RETRY_BACKOFF_MS (a child that dies at once is not started again every minute), then it is started again.
    writeChildRecord(p.stateDir, runId, DEAD);
    const notified: ScheduledFailure[] = [];
    const notify = async (_root: string, f: ScheduledFailure) => void notified.push(f);
    const third = await tick(p, "2026-09-22T10:22:00Z", { notify });
    expect(third.spawned).toEqual([]);
    expect(third.result.held).toEqual([{
      asset: "open_issues", code: "backoff", reason: `the scheduled run ${runId} did not start it (its process ended before it recorded the run); tries again after 10:35`,
    }]);
    expect(third.problems.map((x) => [x.code, x.severity])).toEqual([["RUN_CRASHED", "warning"]]);
    expect(notified).toEqual([{ project: p.root, runId, failed: [{ asset: "open_issues", error: expect.objectContaining({ code: "RUN_CRASHED" }) }] }]);
    // Reported once, waited out, then started again.
    const fourth = await tick(p, "2026-09-22T10:23:00Z", { notify });
    expect([fourth.spawned, fourth.problems, notified.length]).toEqual([[], [], 1]);
    const fifth = await tick(p, "2026-09-22T10:35:00Z", { notify });
    expect(fifth.spawned.map((s) => s.assets)).toEqual([["open_issues"]]);
  });

  test("a child killed before it recorded its run: the fire stays due, and runs once more after RETRY_BACKOFF_MS", async () => {
    const p = await pipeline();
    const notified: ScheduledFailure[] = [];
    const notify = async (_root: string, f: ScheduledFailure) => void notified.push(f);
    // The child dies at once (killed, out of memory, a crash while planning): it never records its run.
    const first = await tick(p, "2026-09-22T11:00:30Z", { notify, spawn: async (r) => writeChildRecord(r.stateDir, r.runId, DEAD) });
    expect(first.result.spawned.map((s) => s.assets)).toEqual([["issues"]]);
    const runId = first.result.spawned[0]!.runId;
    expect(scheduleStateOf(p, "issues")?.lastFireAt).toBe("2026-09-22T11:00:00.000Z");

    const next = await tick(p, "2026-09-22T11:01:30Z", { notify });
    expect(next.spawned).toEqual([]);
    // Not handled: last_fire_at goes back; the fire is due, and held for the wait.
    expect(scheduleStateOf(p, "issues")?.lastFireAt).toBeNull();
    expect(next.result.held).toEqual([{
      asset: "issues", code: "backoff", reason: `the scheduled run ${runId} did not start it (its process ended before it recorded the run); tries again after 11:15`,
    }]);
    expect(next.problems).toEqual([expect.objectContaining({
      code: "RUN_CRASHED", severity: "warning", message: `the scheduled run ${runId} did not start issues: its process ended before it recorded the run`,
      effect: "it stays due; it runs again after 11:15",
    })]);
    expect(notified).toEqual([{ project: p.root, runId, failed: [{ asset: "issues", error: expect.objectContaining({ code: "RUN_CRASHED" }) }] }]);
    const db = p.db();
    expect(db.getSetting<unknown[]>(SPAWNED_SETTING)).toEqual([]);
    expect(db.getSetting<unknown[]>(FAILED_STARTS_SETTING)).toEqual([{
      runId, assets: ["issues"], at: "2026-09-22T11:00:30.000Z", reason: "its process ended before it recorded the run", unrecorded: true,
    }]);
    db.close();

    expect((await tick(p, "2026-09-22T11:10:00Z", { notify })).spawned).toEqual([]);
    expect(RETRY_BACKOFF_MS).toBe(15 * 60_000);
    const again = await tick(p, "2026-09-22T11:15:30Z", { notify });
    expect(again.spawned.map((s) => s.assets)).toEqual([["issues"]]);
    expect(scheduleStateOf(p, "issues")?.lastFireAt).toBe("2026-09-22T11:00:00.000Z");
    expect(notified).toHaveLength(1);
  });

  test("a scheduled run that meets a lease taken after the tick planned skips the ingest, which stays due", async () => {
    const p = await pipeline();
    const first = await tick(p, "2026-09-22T11:00:30Z");
    const runId = first.result.spawned[0]!.runId;
    // A person's run takes issues; the scheduled run then records itself, finds issues leased and skips it (no step).
    const db = p.db();
    expect(tryAcquire(db, ["issues"], "r_0922_1100_hand", currentIdentity()).ok).toBe(true);
    const run = db.createRun({ id: runId, trigger: "schedule", human: false, argv: ["run", "--due", "issues"], identity: DEAD });
    db.finishRun(run.id, "succeeded");
    db.close();
    const next = await tick(p, "2026-09-22T11:01:30Z");
    expect(next.spawned).toEqual([]);
    expect(next.result.held).toEqual([{ asset: "issues", code: "leased", reason: "run r_0922_1100_hand holds it; it stays due" }]);
    expect(scheduleStateOf(p, "issues")?.lastFireAt).toBeNull();
    expect(next.problems).toEqual([]);
    // The person's run ends without handling it (it failed, say): the next tick runs the fire, with no wait.
    const db2 = p.db();
    db2.sqlite.query("DELETE FROM leases").run();
    db2.close();
    const third = await tick(p, "2026-09-22T11:02:30Z");
    expect(third.spawned.map((s) => s.assets)).toEqual([["issues"]]);
  });

  test("held assets are listed and not started", async () => {
    const p = await pipeline();
    writeFileSync(join(p.root, "assets/issues.ts"), scheduledIngest({ body: `yield [{ id: 1, title: "test" }];` }));
    const out = await tick(p, "2026-09-22T11:00:30Z");
    expect(out.spawned).toEqual([]);
    // Bundled, not imported: nobody ran the edit.
    expect(out.result.importedAssetCode).toBe(false);
    expect(out.result.held.map((h) => [h.asset, h.code])).toEqual([["issues", "SCHEDULE_HELD"]]);
    expect(formatTick(out.result)).toMatch(/^tick: nothing due \(\d+ ms\)\n {2}held issues \(SCHEDULE_HELD\): code edited .* ago, not run by hand yet; croft run issues releases it$/);
    // Still due: last_fire_at did not move.
    expect(scheduleStateOf(p, "issues")?.lastFireAt).toBeNull();
  });

  test("a run that cannot be started is a problem, and the tick goes on; the fire stays due and is tried again after a wait", async () => {
    const p = await pipeline();
    const notified: ScheduledFailure[] = [];
    const notify = async (_root: string, f: ScheduledFailure) => void notified.push(f);
    const out = await tick(p, "2026-09-22T11:00:30Z", { notify, spawn: async () => { throw new Error("spawn bun ENOENT"); } });
    expect(out.result.spawned).toEqual([]);
    expect(out.problems.map((x) => [x.message, x.effect])).toEqual([
      ["the scheduler could not start the run of issues: spawn bun ENOENT", "it stays due; the scheduler tries again after 11:15"],
    ]);
    expect(notified).toEqual([{ project: p.root, runId: expect.any(String), failed: [{ asset: "issues", error: expect.objectContaining({ code: "RUN_CRASHED" }) }] }]);
    expect(scheduleStateOf(p, "issues")?.lastFireAt).toBeNull();
    const next = await tick(p, "2026-09-22T11:01:30Z", { notify });
    expect(next.spawned).toEqual([]);
    expect(next.result.held).toEqual([{ asset: "issues", code: "backoff", reason: expect.stringContaining("(it could not be started: spawn bun ENOENT); tries again after 11:15") }]);
    expect((await tick(p, "2026-09-22T11:15:30Z", { notify })).spawned.map((s) => s.assets)).toEqual([["issues"]]);
  });
});

describe("croft tick in real processes", () => {
  /** A fresh home for anything per-user (the tick itself touches none). */
  const home = mkdtempSync(join(tmpdir(), "croft-tick-home-"));
  const env = (now: string, extra: Record<string, string> = {}) => cliEnv({
    CROFT_NOW: now, CROFT_HOME: home, CROFT_JOB_LABEL: `dev.croft.test-tick-${process.pid}`, CROFT_FORBID_OS_JOBS: "1", CROFT_NOTIFY_DRY: "1", ...extra,
  });

  test("a tick with nothing changed imports no asset code; a tick never imports code nobody has run", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "croft-marker-")), "imported.log");
    const p = schedProject({ "assets/issues.ts": scheduledIngest({ marker }), "assets/open_issues.sql": "select id from issues\n" });
    scheduling(p, "on");
    // New, never run by hand: the SQL is parsed; the ingest is bundled, not imported (its top-level code never runs
    // under the scheduler), and it is held at its fire (its text shows the schedule).
    let r = await cli(p.root, ["tick", "--json"], env("2026-09-22T10:05:00Z"));
    expect(r.code).toBe(0);
    expect(r.json?.data).toMatchObject({ exited: null, importedAssetCode: true, spawned: [] });
    expect(r.json?.data.held.map((h: { asset: string; code: string }) => [h.asset, h.code])).toEqual([["issues", "SCHEDULE_HELD"]]);
    expect(imports(marker)).toBe(0);

    r = await cli(p.root, ["tick", "--json"], env("2026-09-22T10:06:00Z"));
    expect(r.json?.data).toMatchObject({ exited: null, importedAssetCode: false, heartbeatAt: "2026-09-22T10:06:00.000Z" });
    expect(r.json?.data.tookMs).toBeLessThan(1000);
    expect(imports(marker)).toBe(0);

    // Run by hand (that run imports it): the next tick imports the approved code once, the one after does not.
    const run = await cli(p.root, ["run", "issues", "--only", "--foreground", "--json"], env("2026-09-22T10:06:30Z"));
    expect(run.code).toBe(0);
    expect(imports(marker)).toBe(1);
    r = await cli(p.root, ["tick"], env("2026-09-22T10:07:00Z"));
    expect(r.stdout).toContain("tick: nothing due · read changed asset files");
    expect(imports(marker)).toBe(2);
    await cli(p.root, ["tick"], env("2026-09-22T10:07:30Z"));
    expect(imports(marker)).toBe(2);

    // An edit nobody has run: the tick holds it without importing it, and keeps the approved code's schedule.
    writeFileSync(join(p.root, "assets/issues.ts"), scheduledIngest({ marker, schedule: "daily at 06:00" }));
    r = await cli(p.root, ["tick", "--json"], env("2026-09-22T10:08:00Z"));
    expect(r.code).toBe(0);
    expect(r.json?.data.importedAssetCode).toBe(false);
    expect(imports(marker)).toBe(2);
    expect(scheduleStateOf(p, "issues")).toMatchObject({ phrase: "every hour", cron: "0 * * * *" });
    // Run by hand: the next tick imports it, and reads its new schedule.
    expect((await cli(p.root, ["run", "issues", "--only", "--foreground", "--json"], env("2026-09-22T10:08:30Z"))).code).toBe(0);
    expect(imports(marker)).toBe(3);
    r = await cli(p.root, ["tick"], env("2026-09-22T10:09:00Z"));
    expect(imports(marker)).toBe(4);
    expect(scheduleStateOf(p, "issues")).toMatchObject({ phrase: "daily at 06:00", cron: "0 6 * * *" });
    await cli(p.root, ["tick"], env("2026-09-22T10:09:30Z"));
    expect(imports(marker)).toBe(4);

    scheduling(p, "off");
    r = await cli(p.root, ["tick"], env("2026-09-22T10:10:00Z"));
    expect(r.stdout.trim()).toBe("tick: nothing to do: scheduling is off for this project");
  }, 60_000);

  test("a real tick starts a real croft run --due: the fire runs once, with what reads the ingest", async () => {
    api.state.issues = [
      { id: 1, title: "a", updated_at: "2026-09-01T10:00:00Z" },
      { id: 2, title: "b", updated_at: "2026-09-02T10:00:00Z" },
    ];
    const p = schedProject({
      "assets/issues.ts": keysetIssues(api.url, `\n  schedule: "every hour",`),
      "assets/open_issues.sql": "select id, title from issues\n",
    });
    // Run by hand once: builds both and approves their code.
    const first = await runIn(p.root, []);
    expect(first.data.status).toBe("succeeded");
    await closeAllWarehouses();
    scheduling(p, "on");
    api.state.issues.push({ id: 3, title: "c", updated_at: "2026-09-03T10:00:00Z" });

    const next = new Date(Math.ceil((Date.now() + 1000) / 3_600_000) * 3_600_000);
    const now = new Date(next.getTime() + 30_000).toISOString();
    const r = await cli(p.root, ["tick", "--json"], env(now));
    expect(r.code).toBe(0);
    const spawned = r.json?.data.spawned as { runId: string; assets: string[] }[];
    expect(spawned.map((s) => s.assets)).toEqual([["issues"]]);
    const runId = spawned[0]!.runId;

    const db = p.db();
    try {
      const run = await until(() => {
        const x = db.getRun(runId);
        return x && x.status !== "running" ? x : null;
      }, 60_000, 100);
      expect(run).toMatchObject({ trigger: "schedule", human: false, status: "succeeded", argv: ["run", "--due", "issues"] });
      const steps = db.stepsFor(runId);
      expect(steps.map((s) => [s.asset, s.status])).toEqual([["issues", "ok"], ["open_issues", "ok"]]);
      expect(steps[0]).toMatchObject({ added: 1 });
      expect(db.scheduleState("issues")).toMatchObject({ lastFireAt: next.toISOString(), lastAttemptAt: now });
    } finally {
      db.close();
    }
    // The same minute again: the fire is handled, nothing starts.
    const again = await cli(p.root, ["tick", "--json"], env(new Date(next.getTime() + 60_000).toISOString()));
    expect(again.json?.data.spawned).toEqual([]);
  }, 90_000);
});
