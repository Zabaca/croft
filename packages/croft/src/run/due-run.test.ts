// `croft run --due` (DESIGN.md §8, §6 the scheduler hold, §5 "Default waits"): the scheduler's run against a mock
// API. Trigger schedule, human false; the plan's holds (SCHEDULE_HELD, LARGE_REPROCESS, leased) skip their steps
// and what reads them; the cost guard holds instead of asking; overlaps skip instead of waiting; retries as for
// any run; last_attempt_at and last_fire_at recorded; the after-run hooks (read copy, failure notification).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentIdentity } from "../core/proc.ts";
import { closeAllWarehouses, warehouseFor } from "../db/warehouse.ts";
import { tryAcquire } from "../history/leases.ts";
import { RunsDb } from "../history/runs-db.ts";
import { loadProject } from "../project/root.ts";
import { duePlan } from "../cli/commands/run.ts";
import { dueWork } from "../schedule/due.ts";
import type { ScheduledFailure } from "../schedule/notify.ts";
import { planRun } from "./plan.ts";
import { type RunnerOptions, SCHEDULED_LOCK_WAIT_MS } from "./runner.ts";
import { cleanupProjects, cli, cliEnv, keysetIssues, makeProject, mockApi, runIn, simpleGet } from "./testkit.ts";

const api = mockApi();
afterAll(async () => {
  api.stop();
  await closeAllWarehouses();
  cleanupProjects();
});
beforeEach(() => {
  api.state.log.length = 0;
  api.state.issues = [
    { id: 1, title: "a", updated_at: "2026-09-01T10:00:00Z" },
    { id: 2, title: "b", updated_at: "2026-09-02T10:00:00Z" },
  ];
});

const HOURLY = `\n  schedule: "every hour",`;

function runsDb(root: string): RunsDb {
  return RunsDb.open(join(root, ".croft"));
}

function on(root: string): void {
  const db = runsDb(root);
  db.setScheduling({ state: "on", via: "serve" });
  db.close();
}

/** The hooks, recorded. */
function hooks() {
  const calls = { readCopy: [] as string[], notify: [] as { root: string; failure: ScheduledFailure }[] };
  return {
    calls,
    hooks: {
      refreshReadCopy: async (root: string) => void calls.readCopy.push(root),
      notifyScheduledFailure: async (root: string, failure: ScheduledFailure) => void calls.notify.push({ root, failure }),
    },
  };
}

/** `croft run --due <assets>` in this process at `now`, as the detached child of a tick runs it. */
async function runDue(root: string, assets: string[], now: Date, o: Partial<RunnerOptions> = {}) {
  await closeAllWarehouses();
  const plan = await duePlan(loadProject({ root }), assets, now);
  return runIn(root, assets, { plan, trigger: "schedule", human: false, argv: ["run", "--due", ...assets], now: () => now, ...o });
}

/** The next full hour after the real clock (the hand run's steps carry real times), and 30 s past it. */
function nextFire(): { fire: Date; now: Date } {
  const fire = new Date(Math.ceil((Date.now() + 1000) / 3_600_000) * 3_600_000);
  return { fire, now: new Date(fire.getTime() + 30_000) };
}

/** issues (hourly, keyset) → open_issues (SQL), run by hand once (built and approved), scheduling on. */
async function pipeline(extra: Record<string, string> = {}): Promise<string> {
  const root = makeProject({
    "assets/issues.ts": keysetIssues(api.url, HOURLY), "assets/open_issues.sql": "select id, title from issues\n", ...extra,
  }, { timezone: "UTC" });
  const out = await runIn(root, ["issues", "open_issues"]);
  expect(out.data.status).toBe("succeeded");
  on(root);
  return root;
}

describe("croft run --due: the scheduler's run", () => {
  test("the due ingest and what reads it run as a scheduled run; the fire and the attempt are recorded", async () => {
    const root = await pipeline();
    api.state.issues.push({ id: 3, title: "c", updated_at: "2026-09-03T10:00:00Z" });
    const { fire, now } = nextFire();
    const h = hooks();
    const out = await runDue(root, ["issues"], now, { hooks: h.hooks });
    expect(out.exit).toBe(0);
    expect(out.data.steps.map((s) => [s.asset, s.status])).toEqual([["issues", "ok"], ["open_issues", "ok"]]);
    expect(out.data.steps[0]!.rows.added).toBe(1);
    expect(out.data.steps[0]!.reason).toBe("scheduled");
    const db = runsDb(root);
    try {
      expect(db.getRun(out.data.runId)).toMatchObject({ trigger: "schedule", human: false, argv: ["run", "--due", "issues"], status: "succeeded" });
      expect(db.scheduleState("issues")).toMatchObject({ lastFireAt: fire.toISOString(), lastAttemptAt: now.toISOString() });
      expect(db.scheduleState("open_issues")?.lastAttemptAt).toBe(now.toISOString());
    } finally {
      db.close();
    }
    // It committed: the read copy is refreshed; nothing failed: no notification.
    expect(h.calls.readCopy).toEqual([root]);
    expect(h.calls.notify).toEqual([]);
    // The database lock is waited for up to 30 min.
    expect(SCHEDULED_LOCK_WAIT_MS).toBe(30 * 60_000);
    expect(warehouseFor(loadProject({ root }).paths.database)?.options.waits?.offTtyMs).toBe(SCHEDULED_LOCK_WAIT_MS);
  });

  test("a transform the tick found stale that is up to date by now is skipped", async () => {
    const root = await pipeline();
    const out = await runDue(root, ["open_issues"], nextFire().now);
    expect(out.data.steps).toMatchObject([{ asset: "open_issues", status: "skipped", skippedBecause: "up to date: nothing it reads changed since the scheduler found it due" }]);
    expect(out.exit).toBe(0);
  });

  test("a scheduled run never approves code", async () => {
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones", HOURLY) }, { timezone: "UTC" });
    api.state.zones = [{ id: 1 }];
    // A plan without the scheduler's holds (the plan's own tests cover those): only the runner's human:false.
    const plan = await planRun({ root, timezone: "UTC", selectors: ["zones"] });
    const out = await runIn(root, ["zones"], { plan, trigger: "schedule", human: false, argv: ["run", "--due", "zones"] });
    expect(out.data.steps[0]!.status).toBe("ok");
    const db = runsDb(root);
    expect(db.approvedCode("zones")).toBeNull();
    db.close();
  });
});

describe("croft run --due: holds", () => {
  test("SCHEDULE_HELD: an edited ingest is skipped with that code, and so is what reads it; nothing is fetched", async () => {
    const root = await pipeline();
    writeFileSync(join(root, "assets/issues.ts"), keysetIssues(api.url, `${HOURLY}\n  description: "edited",`));
    api.state.log.length = 0;
    const h = hooks();
    const out = await runDue(root, ["issues"], nextFire().now, { hooks: h.hooks });
    expect(out.exit).toBe(0);
    expect(out.ok).toBe(true);
    expect(out.data.status).toBe("succeeded");
    const [issues, open] = out.data.steps;
    expect(issues).toMatchObject({ asset: "issues", status: "skipped" });
    expect(issues!.skippedBecause).toMatch(/^held \(SCHEDULE_HELD\): code edited .* ago, not run by hand yet; croft run issues releases it$/);
    expect(open).toMatchObject({ asset: "open_issues", status: "skipped" });
    expect(open!.skippedBecause).toStartWith("input issues is held (SCHEDULE_HELD)");
    const held = out.problems.find((p) => p.code === "SCHEDULE_HELD")!;
    expect(held).toMatchObject({ severity: "warning", asset: "issues", fix: { kind: "command", command: "croft run issues" } });
    expect(api.state.log).toEqual([]);
    // Not handled: the fire stays due.
    const db = runsDb(root);
    expect(db.scheduleState("issues")?.lastFireAt).toBeNull();
    db.close();
    expect(h.calls).toEqual({ readCopy: [], notify: [] });
  });

  test("SCHEDULE_HELD: an ingest whose code no longer loads is held, not failed", async () => {
    const root = await pipeline();
    writeFileSync(join(root, "assets/issues.ts"), "export default ingest({ oops");
    const h = hooks();
    const out = await runDue(root, ["issues"], nextFire().now, { hooks: h.hooks });
    expect(out.data.steps[0]).toMatchObject({ asset: "issues", status: "skipped" });
    expect(out.data.steps[0]!.skippedBecause).toContain("does not load; fix it, then croft run issues releases it");
    expect(out.exit).toBe(0);
    expect(h.calls.notify).toEqual([]);
  });

  test("LARGE_REPROCESS: the cost guard holds the transform in a scheduled run; the tick then leaves it alone", async () => {
    const guarded = `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["issues"],
  key: "issue_id",
  incremental: true,
  confirmAbove: 3,
  async *rows({ newRows, http }) {
    for await (const r of newRows("issues")) {
      if ((globalThis as any).__never) await http.get("${api.url}/zones");
      yield { issue_id: r.id };
    }
  },
});
`;
    api.state.issues = [1, 2, 3, 4, 5].map((id) => ({ id, title: `t${id}`, updated_at: `2026-09-0${id}T10:00:00Z` }));
    const root = makeProject({ "assets/issues.ts": keysetIssues(api.url, HOURLY), "assets/triage.ts": guarded }, { timezone: "UTC" });
    expect((await runIn(root, ["issues"], { only: true })).data.status).toBe("succeeded");
    on(root);
    // A person ran triage's code before (preview approves it too); its backlog is over confirmAbove.
    const plan = await planRun({ root, timezone: "UTC", selectors: ["triage"] });
    const db = runsDb(root);
    db.approveCode("triage", plan.steps[0]!.codeHash!);
    db.close();

    const { now } = nextFire();
    const h = hooks();
    const out = await runDue(root, ["triage"], now, { hooks: h.hooks });
    expect(out.exit).toBe(0);
    expect(out.confirmation).toBeUndefined();
    expect(out.data.steps[0]).toMatchObject({ asset: "triage", status: "skipped" });
    expect(out.data.steps[0]!.skippedBecause).toStartWith("held (LARGE_REPROCESS): triage would process 5 input rows");
    expect(out.data.steps[0]!.skippedBecause).toEndWith("a person has to run it: croft run triage");
    expect(out.problems.find((p) => p.code === "LARGE_REPROCESS")).toMatchObject({ severity: "warning", asset: "triage" });
    expect(h.calls.notify).toEqual([]);

    // Recorded: the tick holds it (and a second --due run holds it at plan time).
    const db2 = RunsDb.open(join(root, ".croft"), { now: () => now });
    try {
      const w = await dueWork({ project: loadProject({ root }), runs: db2, now, store: true });
      expect(w.views.find((v) => v.asset === "triage")).toMatchObject({ due: true, held: { code: "LARGE_REPROCESS" } });
      expect(w.groups).toEqual([["issues"]]);
    } finally {
      db2.close();
    }
    const again = await runDue(root, ["triage"], now);
    expect(again.data.steps[0]!.skippedBecause).toStartWith("held (LARGE_REPROCESS): the cost guard needs a person");
  });

  test("overlaps skip: an asset another run holds is skipped at once and stays due", async () => {
    const root = await pipeline();
    const project = loadProject({ root });
    const { now } = nextFire();
    const plan = await duePlan(project, ["issues"], now);
    // Between the plan and the leases, another run takes issues.
    const db = runsDb(root);
    expect(tryAcquire(db, ["issues"], "r_0924_0900_hold", currentIdentity()).ok).toBe(true);
    db.close();
    const t0 = Date.now();
    const out = await runIn(root, ["issues"], { plan, trigger: "schedule", human: false, argv: ["run", "--due", "issues"], now: () => now });
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(out.data.steps.map((s) => [s.asset, s.status, s.skippedBecause])).toEqual([
      ["issues", "skipped", "held: run r_0924_0900_hold holds it; it stays due"],
      ["open_issues", "skipped", "input issues is held: run r_0924_0900_hold holds it; it stays due"],
    ]);
    expect(out.exit).toBe(0);
    const db2 = runsDb(root);
    expect(db2.scheduleState("issues")?.lastFireAt ?? null).toBeNull();
    // Planned while leased: held at plan time with the same words.
    await closeAllWarehouses();
    const planned = await duePlan(project, ["issues"], now);
    expect(planned.steps.find((s) => s.asset === "issues")).toMatchObject({ hold: "leased", reason: "held: run r_0924_0900_hold holds it; it stays due" });
    db2.sqlite.query("DELETE FROM leases").run();
    db2.close();
  });
});

describe("croft run --due: failures", () => {
  test("retries as any run, then the failure notifies; every attempt records last_attempt_at", async () => {
    api.state.failures = 1000;
    const root = makeProject({ "assets/flaky.ts": simpleGet(api.url, "/flaky", HOURLY) }, { timezone: "UTC" });
    const plan = await planRun({ root, timezone: "UTC", selectors: ["flaky"] });
    const db = runsDb(root);
    db.approveCode("flaky", plan.steps[0]!.codeHash!);
    db.setScheduling({ state: "on", via: "serve" });
    db.close();
    const { now } = nextFire();
    const h = hooks();
    const out = await runDue(root, ["flaky"], now, { hooks: h.hooks });
    api.state.failures = 0;
    expect(out.data.status).toBe("failed");
    expect(out.data.steps[0]).toMatchObject({ asset: "flaky", status: "failed", attempt: 3, maxAttempts: 3 });
    expect(h.calls.notify).toHaveLength(1);
    expect(h.calls.notify[0]!.root).toBe(root);
    expect(h.calls.notify[0]!.failure).toMatchObject({ project: root, runId: out.data.runId, failed: [{ asset: "flaky", error: { code: "HTTP_ERROR" } }] });
    expect(h.calls.readCopy).toEqual([]);
    const db2 = runsDb(root);
    expect(db2.stepsFor(out.data.runId).map((s) => s.attempt)).toEqual([1, 2, 3]);
    expect(db2.scheduleState("flaky")?.lastAttemptAt).toBe(now.toISOString());
    db2.close();
  });

  test("a hook that throws never fails the run", async () => {
    const root = await pipeline();
    const out = await runDue(root, ["issues"], nextFire().now, {
      hooks: { refreshReadCopy: async () => { throw new Error("disk full"); } },
    });
    expect(out.data.status).toBe("succeeded");
    expect(out.exit).toBe(0);
  });
});

describe("croft run --due on the command line", () => {
  test("--due goes with no other run flag", async () => {
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones", HOURLY) });
    const r = await cli(root, ["run", "--due", "--from", "-1d", "--json"]);
    expect(r.code).toBe(2);
    expect(r.json?.problems[0]).toMatchObject({ code: "USAGE_ERROR", message: "--due runs what the scheduler would; it does not go with --from" });
  });

  test("off a TTY it detaches like any run, and the parent prints the scheduled run's result", async () => {
    const root = await pipeline();
    await closeAllWarehouses();
    api.state.issues.push({ id: 3, title: "c", updated_at: "2026-09-03T10:00:00Z" });
    const { fire, now } = nextFire();
    const r = await cli(root, ["run", "--due", "issues", "--json"], cliEnv({ CROFT_NOW: now.toISOString(), CROFT_FORBID_OS_JOBS: "1", CROFT_NOTIFY_DRY: "1" }));
    expect(r.code).toBe(0);
    expect(r.json?.data.status).toBe("succeeded");
    expect(r.json?.data.steps.map((s: { asset: string; status: string }) => [s.asset, s.status])).toEqual([["issues", "ok"], ["open_issues", "ok"]]);
    const db = runsDb(root);
    expect(db.getRun(r.json?.data.runId)).toMatchObject({ trigger: "schedule", human: false });
    expect(db.scheduleState("issues")?.lastFireAt).toBe(fire.toISOString());
    db.close();
  }, 60_000);

  test("an asset whose file is gone since the tick is left out; nothing due is not an empty project", async () => {
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones", HOURLY) });
    on(root);
    const r = await cli(root, ["run", "--due", "gone_asset", "--foreground", "--json"], cliEnv({ CROFT_FORBID_OS_JOBS: "1", CROFT_NOTIFY_DRY: "1" }));
    expect(r.code).toBe(0);
    expect(r.json?.data).toMatchObject({ status: "succeeded", steps: [] });
    expect(r.json?.next).toEqual([]);
  });
});
