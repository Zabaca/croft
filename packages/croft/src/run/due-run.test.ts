// `croft run --due` (DESIGN.md §8, §6 the scheduler hold, §5 "Default waits"): the scheduler's run against a mock
// API. Trigger schedule, human false; the plan's holds (SCHEDULE_HELD, LARGE_REPROCESS, leased) skip their steps
// and what reads them; the cost guard holds instead of asking; overlaps skip instead of waiting; retries as for
// any run; last_attempt_at and last_fire_at recorded; the after-run hooks (read copy, failure notification).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentIdentity } from "../core/proc.ts";
import { ENGINE_SETTING } from "../db/backup.ts";
import { closeAllWarehouses, warehouseFor } from "../db/warehouse.ts";
import { tryAcquire } from "../history/leases.ts";
import { RunsDb } from "../history/runs-db.ts";
import { loadProject } from "../project/root.ts";
import { duePlan } from "../cli/commands/run.ts";
import { secretsCommandHash } from "../project/env.ts";
import { dueWork, FACTS_SETTING, scheduleView } from "../schedule/due.ts";
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

  test("a scheduled run never approves code, and never runs code nobody approved, even from a plan without holds", async () => {
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones", HOURLY) }, { timezone: "UTC" });
    api.state.zones = [{ id: 1 }];
    on(root);
    // A plan without the scheduler's holds (the plan's own tests cover those): the step's start still checks them.
    const plan = await planRun({ root, timezone: "UTC", selectors: ["zones"] });
    const out = await runIn(root, ["zones"], { plan, trigger: "schedule", human: false, argv: ["run", "--due", "zones"] });
    expect(out.data.steps[0]).toMatchObject({ status: "skipped" });
    expect(out.data.steps[0]!.skippedBecause).toStartWith("held (SCHEDULE_HELD): new: code edited");
    expect(api.state.log).toEqual([]);
    // A run that is not a person's (human false) runs, and its success approves nothing.
    expect((await runIn(root, ["zones"], { plan, human: false })).data.steps[0]!.status).toBe("ok");
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

  // R32-08 (the run's side): the scheduler's run imported every TS transform to plan it, so the top-level code of code
  // nobody had run executed unattended (§6 "The scheduler only runs code a human has run").
  test("a TS asset nobody ran by hand is never imported: it is planned from what the scheduler knows of it, and held", async () => {
    const root = await pipeline();
    writeFileSync(join(root, "assets/triage.ts"), `import { appendFileSync } from "node:fs";
appendFileSync(new URL("../imported.txt", import.meta.url), "triage\\n");
import { transform } from "@zabaca/croft";
export default transform({ inputs: ["issues"], key: "id", incremental: true, async *rows({ newRows }) { for await (const r of newRows("issues")) yield { id: r.id }; } });
`);
    // The tick's cached facts say it reads issues, so the run takes it downstream of the due ingest, and holds it.
    const db = runsDb(root);
    db.setSetting(FACTS_SETTING, { triage: { asset: "triage", file: "assets/triage.ts", kind: "ts", fileHash: "k", schedule: null, inputs: ["issues"], codeHash: null, incremental: true, ok: true } });
    db.close();
    const out = await runDue(root, ["issues"], nextFire().now);
    expect(existsSync(join(root, "imported.txt"))).toBe(false);
    expect(out.data.steps.map((s) => s.asset)).toEqual(["issues", "open_issues", "triage"]);
    expect(out.data.steps[0]).toMatchObject({ asset: "issues", status: "ok" });
    expect(out.data.steps[2]).toMatchObject({ asset: "triage", status: "skipped" });
    expect(out.data.steps[2]!.skippedBecause).toStartWith("held (SCHEDULE_HELD): new: code edited");
    expect(out.problems.find((p) => p.code === "SCHEDULE_HELD")).toMatchObject({ asset: "triage", fix: { command: "croft run triage" } });
    // A run by hand imports it (and approves it).
    expect((await runIn(root, ["triage"])).data.steps[0]).toMatchObject({ status: "ok" });
    expect(readFileSync(join(root, "imported.txt"), "utf8")).toBe("triage\n");
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

// R32-07: a scheduled run plans, then waits for the file (up to 30 min), and runs earlier steps and retries first. Its
// holds are checked again as each step starts, against the code the step loads then.
describe("croft run --due: holds when a step starts", () => {
  const due = (root: string, assets: string[], plan: Awaited<ReturnType<typeof duePlan>>, now: Date, o: Partial<RunnerOptions> = {}) =>
    runIn(root, assets, { plan, trigger: "schedule", human: false, argv: ["run", "--due", ...assets], now: () => now, ...o });

  test("code edited after the plan (a file rows() imports when it runs) holds the step; nothing runs or is recorded as handled", async () => {
    const root = makeProject({
      "assets/items.ts": `import { ingest } from "@zabaca/croft";
export default ingest({
  key: "id",${HOURLY}
  async *rows() { const { rows } = await import("../lib/rows.ts"); yield rows; },
});
`,
      "lib/rows.ts": `export const rows = [{ id: 1, title: "real issue 1" }];\n`,
      "assets/titles.sql": "select id, title from items\n",
    }, { timezone: "UTC" });
    expect((await runIn(root, ["items", "titles"])).data.status).toBe("succeeded");
    on(root);
    const { now } = nextFire();
    const plan = await duePlan(loadProject({ root }), ["items"], now);
    expect(plan.steps.map((s) => [s.asset, s.hold ?? null])).toEqual([["items", null], ["titles", null]]);
    // While the run waits for the file: a debugging fixture nobody has run by hand (DESIGN §6).
    writeFileSync(join(root, "lib/rows.ts"), `export const rows = [{ id: 1, title: "test" }];\n`);
    const h = hooks();
    const out = await due(root, ["items"], plan, now, { hooks: h.hooks });
    expect(out.exit).toBe(0);
    const [items, titles] = out.data.steps;
    expect(items).toMatchObject({ asset: "items", status: "skipped" });
    expect(items!.skippedBecause).toMatch(/^held \(SCHEDULE_HELD\): code edited .*, not run by hand yet; croft run items releases it$/);
    expect(titles).toMatchObject({ asset: "titles", status: "skipped" });
    expect(titles!.skippedBecause).toStartWith("input items is held (SCHEDULE_HELD)");
    expect(out.problems.find((p) => p.code === "SCHEDULE_HELD")).toMatchObject({ severity: "warning", asset: "items", fix: { command: "croft run items" } });
    const db = runsDb(root);
    try {
      // No attempt of items (a reader skipped for its input is recorded, as when the plan holds the input).
      expect(db.stepsFor(out.data.runId).map((s) => s.asset)).toEqual(["titles"]);
      expect(db.scheduleState("items")).toMatchObject({ lastFireAt: null, lastAttemptAt: null });
    } finally {
      db.close();
    }
    expect(h.calls).toEqual({ readCopy: [], notify: [] });
  });

  test("an edit while the step waits for the file (a GUI holds it) holds the step once it has the file", async () => {
    const { spawnHolder, cleanup } = await import("../read/testkit.ts");
    const root = makeProject({
      "assets/items.ts": `import { ingest } from "@zabaca/croft";
export default ingest({
  key: "id",${HOURLY}
  async *rows() { const { rows } = await import("../lib/rows.ts"); yield rows; },
});
`,
      "lib/rows.ts": `export const rows = [{ id: 1, title: "real issue 1" }];\n`,
    }, { timezone: "UTC" });
    expect((await runIn(root, ["items"])).data.status).toBe("succeeded");
    on(root);
    await closeAllWarehouses();
    const { now } = nextFire();
    const plan = await duePlan(loadProject({ root }), ["items"], now);
    expect(plan.steps.map((s) => [s.asset, s.hold ?? null])).toEqual([["items", null]]);
    const holder = spawnHolder(join(root, "warehouse.duckdb"), 2500);
    try {
      await holder.waitFor("held");
      const running = due(root, ["items"], plan, now);
      await Bun.sleep(700);
      writeFileSync(join(root, "lib/rows.ts"), `export const rows = [{ id: 1, title: "test" }];\n`);
      const out = await running;
      expect(out.data.steps[0]).toMatchObject({ asset: "items", status: "skipped" });
      expect(out.data.steps[0]!.skippedBecause).toStartWith("held (SCHEDULE_HELD): ");
      const db = runsDb(root);
      expect(db.stepsFor(out.data.runId)).toEqual([]);
      db.close();
    } finally {
      cleanup();
    }
  }, 20_000);

  test("scheduling paused after the plan holds the run's steps as they start", async () => {
    const root = await pipeline();
    const { now } = nextFire();
    const plan = await duePlan(loadProject({ root }), ["issues"], now);
    const db = runsDb(root);
    db.setScheduling({ state: "paused", via: "serve" });
    db.close();
    api.state.log.length = 0;
    const out = await due(root, ["issues"], plan, now);
    expect(out.data.steps.map((s) => [s.asset, s.status, s.skippedBecause])).toEqual([
      ["issues", "skipped", "held: scheduling is paused"],
      ["open_issues", "skipped", "input issues is held: scheduling is paused"],
    ]);
    expect(out.exit).toBe(0);
    expect(api.state.log).toEqual([]);
  });

  test("a pause while an earlier step runs holds the later ones", async () => {
    const root = await pipeline();
    api.state.issues.push({ id: 3, title: "c", updated_at: "2026-09-03T10:00:00Z" });
    const { now } = nextFire();
    const plan = await duePlan(loadProject({ root }), ["issues"], now);
    const pause = (_line: string, e: { type: string; asset?: unknown; status?: unknown }) => {
      if (e.type !== "step" || e.asset !== "issues" || e.status !== "running") return;
      const db = runsDb(root);
      db.setScheduling({ state: "off", via: null });
      db.close();
    };
    const out = await due(root, ["issues"], plan, now, { onEvent: pause });
    expect(out.data.steps.map((s) => [s.asset, s.status, s.skippedBecause ?? null])).toEqual([
      ["issues", "ok", null],
      ["open_issues", "skipped", "held: scheduling is off"],
    ]);
  });

  test("a run by hand checks nothing of the sort", async () => {
    const root = await pipeline();
    const db = runsDb(root);
    db.setScheduling({ state: "paused", via: "serve" });
    db.close();
    writeFileSync(join(root, "assets/issues.ts"), keysetIssues(api.url, `${HOURLY}\n  description: "edited",`));
    const out = await runIn(root, ["issues"]);
    expect(out.data.steps[0]).toMatchObject({ asset: "issues", status: "ok" });
    expect(out.data.steps.filter((s) => s.skippedBecause?.includes("held"))).toEqual([]);
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

  describe("croft.json's secretsFrom command (D108)", () => {
    const KEYED = `import { ingest } from "@zabaca/croft";
export default ingest({${HOURLY}
  secrets: ["API_KEY"],
  async *rows({ secret }) { yield [{ id: 1, key_length: secret("API_KEY").length }]; },
});
`;
    const PLAIN = `import { ingest } from "@zabaca/croft";
export default ingest({${HOURLY}
  async *rows() { yield [{ id: 1 }]; },
});
`;
    /** croft.json with a secretsFrom command that prints API_KEY (`print`) and counts its runs in ran.txt. */
    const config = (print: string) => ({
      secretsFrom: { command: [process.execPath, "-e", `require("node:fs").appendFileSync("ran.txt", "x"); console.log(${JSON.stringify(print)})`] },
    });
    const ran = (root: string) => (existsSync(join(root, "ran.txt")) ? readFileSync(join(root, "ran.txt"), "utf8").length : 0);

    test("a step reads its secret from the command; a failing command fails only the steps that need it", async () => {
      const root = makeProject({ "assets/keyed.ts": KEYED, "assets/plain.ts": PLAIN }, { timezone: "UTC", config: config("API_KEY=key-from-store-1") });
      const out = await runIn(root, ["keyed", "plain"]);
      expect(out.data.steps.map((s) => [s.asset, s.status])).toEqual([["keyed", "ok"], ["plain", "ok"]]);
      expect(ran(root)).toBe(1);

      writeFileSync(join(root, "croft.json"), JSON.stringify({ database: "warehouse.duckdb", timezone: "UTC",
        secretsFrom: { command: [process.execPath, "-e", "console.error('no key could decrypt key-from-store-1'); process.exit(2)"] } }));
      const failed = await runIn(root, ["keyed", "plain"]);
      expect(failed.data.steps.map((s) => [s.asset, s.status])).toEqual([["keyed", "failed"], ["plain", "ok"]]);
      const p = failed.problems.find((x) => x.code === "SECRETS_COMMAND_FAILED")!;
      expect(p).toMatchObject({ severity: "error", asset: "keyed", fix: { kind: "manual", requiresHuman: true } });
      expect(p.message).toEndWith("exited with status 2:\nno key could decrypt key-from-store-1");
    });

    test("the scheduler holds what reads secrets until a person has run an asset under the command; a changed command holds again", async () => {
      const root = makeProject({ "assets/keyed.ts": KEYED, "assets/plain.ts": PLAIN }, { timezone: "UTC", config: config("API_KEY=key-from-store-1") });
      expect((await runIn(root, ["keyed", "plain"])).data.status).toBe("succeeded");
      on(root);
      const first = await runDue(root, ["keyed", "plain"], nextFire().now);
      expect(first.data.steps.map((s) => [s.asset, s.status])).toEqual([["keyed", "ok"], ["plain", "ok"]]);
      expect(ran(root)).toBe(2);

      // Edited: the asset that reads secrets is held, the other runs, and the new command never runs.
      writeFileSync(join(root, "croft.json"), JSON.stringify({ database: "warehouse.duckdb", timezone: "UTC", ...config("API_KEY=key-from-store-2") }));
      const now = new Date(nextFire().now.getTime() + 3_600_000);
      const views = await scheduleView({ root, now });
      expect(views.find((v) => v.asset === "keyed")!.held).toEqual({
        code: "SCHEDULE_HELD", reason: "croft.json's secretsFrom command is new or changed, not run by hand yet; croft run keyed releases it",
      });
      expect(views.find((v) => v.asset === "plain")!.held).toBeNull();
      const held = await runDue(root, ["keyed", "plain"], now);
      expect(held.data.steps.map((s) => [s.asset, s.status])).toEqual([["keyed", "skipped"], ["plain", "ok"]]);
      expect(held.data.steps[0]!.skippedBecause).toBe("held (SCHEDULE_HELD): croft.json's secretsFrom command is new or changed, not run by hand yet; croft run keyed releases it");
      expect(held.problems.find((p) => p.code === "SCHEDULE_HELD")).toMatchObject({ severity: "warning", asset: "keyed", fix: { command: "croft run keyed" } });
      expect(held.exit).toBe(0);
      expect(ran(root)).toBe(2);

      // A plan without the scheduler's holds: the step's start still checks the command (holdAtStart).
      const plan = await planRun({ root, timezone: "UTC", selectors: ["keyed"] });
      const atStart = await runIn(root, ["keyed"], { plan, trigger: "schedule", human: false, argv: ["run", "--due", "keyed"] });
      expect(atStart.data.steps[0]).toMatchObject({ status: "skipped" });
      expect(atStart.data.steps[0]!.skippedBecause).toBe("held (SCHEDULE_HELD): croft.json's secretsFrom command is new or changed, not run by hand yet; croft run keyed releases it");
      expect(ran(root)).toBe(2);
      // A run that is not a person's approves nothing.
      expect((await runIn(root, ["keyed"], { plan, human: false })).data.steps[0]!.status).toBe("ok");
      const db = runsDb(root);
      expect(db.approvedSecretsCommand()).not.toBe(secretsCommandHash(loadProject({ root }).config.secretsFrom!));
      db.close();

      // A run by hand releases it.
      expect((await runIn(root, ["keyed"])).data.steps[0]).toMatchObject({ status: "ok" });
      const later = await runDue(root, ["keyed"], new Date(now.getTime() + 3_600_000));
      expect(later.data.steps[0]).toMatchObject({ asset: "keyed", status: "ok" });
    });
  });

  test("an asset whose file is gone since the tick is left out; nothing due is not an empty project", async () => {
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones", HOURLY) });
    on(root);
    const r = await cli(root, ["run", "--due", "gone_asset", "--foreground", "--json"], cliEnv({ CROFT_FORBID_OS_JOBS: "1", CROFT_NOTIFY_DRY: "1" }));
    expect(r.code).toBe(0);
    expect(r.json?.data).toMatchObject({ status: "succeeded", steps: [] });
    expect(r.json?.next).toEqual([]);
  });
});

// D114: an SQL asset's code hash is DuckDB's parse tree, so a new DuckDB changes it although no file changed. The
// project is made to look as croft would find it after an upgrade: the SQL asset built and approved under an older
// engine's hash, which runs.sqlite records with the same source.
describe("a DuckDB upgrade (run/engine-change.ts)", () => {
  let seq = 0;
  async function asIfBuiltBy(root: string, asset: string, engine: string, o: { sourceRow?: boolean } = {}): Promise<string> {
    await closeAllWarehouses();
    const old = `built-by-${engine}-${++seq}`;
    const db = runsDb(root);
    let current: string;
    try {
      current = db.approvedCode(asset)!;
      const source = db.codeSource(current)!;
      expect(source.engine).not.toBe(engine);
      if (o.sourceRow ?? true) db.noteCodeSource(old, source.sourceHash, engine);
      // croft 0.3 recorded its engine; the 2.0 writer that built the project here recorded its own.
      else db.setSetting(ENGINE_SETTING, { version: engine, recordedAt: "2026-01-01T00:00:00.000Z" });
      db.approveCode(asset, old);
      const entry = db.catalogGet<Record<string, unknown>>(asset)!;
      db.catalogPut(asset, { ...entry.value, codeHash: old }, entry.source);
      db.sqlite.query("UPDATE steps SET code_hash = ? WHERE asset = ?").run(old, asset);
    } finally {
      db.close();
    }
    const { DuckDBInstance } = await import("@duckdb/node-api");
    const instance = await DuckDBInstance.create(loadProject({ root }).paths.database);
    const conn = await instance.connect();
    await conn.run("UPDATE _croft.assets SET code_hash = $1 WHERE name = $2", [old, asset]);
    conn.closeSync();
    instance.closeSync();
    return current;
  }

  test("the SQL asset rebuilds once, unedited and unheld, and the scheduled run approves its new hash", async () => {
    const root = await pipeline();
    const now = await asIfBuiltBy(root, "open_issues", "v1.5.5");
    const plan = await planRun({ root, timezone: "UTC", selectors: [] });
    const step = plan.steps.find((s) => s.asset === "open_issues")!;
    expect(step.reason).toContain("DuckDB upgraded (1.5.5 → 2.0.0)");
    expect(step.approvalCarries).toBe(true);
    const status = await cli(root, ["status", "--json"], cliEnv());
    expect(status.json, status.stderr).toBeDefined();
    expect(JSON.stringify(status.json)).not.toContain("EDITED_SINCE_LAST_RUN");
    // The tick does not hold it.
    const views = await scheduleView({ root, now: nextFire().now });
    expect(views.find((v) => v.asset === "open_issues")?.held ?? null).toBeNull();
    // The scheduled run rebuilds it and approves the new hash; the next run has nothing to do.
    const out = await runDue(root, ["open_issues"], nextFire().now);
    expect(out.data.steps).toMatchObject([{ asset: "open_issues", status: "ok" }]);
    const db = runsDb(root);
    try {
      expect(db.approvedCode("open_issues")).toBe(now);
    } finally {
      db.close();
    }
    const again = await planRun({ root, timezone: "UTC", selectors: [] });
    expect(again.steps.find((s) => s.asset === "open_issues")!.reasons).not.toContain("code_changed");
  });

  test("a build croft 0.3 recorded (no source row) counts when the file is not newer than the build", async () => {
    const root = await pipeline();
    await asIfBuiltBy(root, "open_issues", "v1.5.5", { sourceRow: false });
    const old = new Date(Date.now() - 86_400_000);
    utimesSync(join(root, "assets/open_issues.sql"), old, old);
    const plan = await planRun({ root, timezone: "UTC", selectors: [] });
    expect(plan.steps.find((s) => s.asset === "open_issues")!.reason).toContain("DuckDB upgraded (1.5.5 → 2.0.0)");
  });

  test("a build croft 0.3 recorded, from a file touched since (a git checkout): the safe side, an edit, held", async () => {
    const root = await pipeline();
    await asIfBuiltBy(root, "open_issues", "v1.5.5", { sourceRow: false });
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(root, "assets/open_issues.sql"), later, later);
    const touched = await planRun({ root, timezone: "UTC", selectors: [] });
    const step = touched.steps.find((s) => s.asset === "open_issues")!;
    expect(step.reason).toContain("SQL changed");
    expect(JSON.stringify((await cli(root, ["status", "--json"], cliEnv())).json)).toContain("EDITED_SINCE_LAST_RUN");
    const out = await runDue(root, ["open_issues"], nextFire().now);
    expect(out.data.steps[0]!.skippedBecause).toStartWith("held (SCHEDULE_HELD)");
  });

  test("a real edit is still an edit: EDITED_SINCE_LAST_RUN and SCHEDULE_HELD", async () => {
    const root = await pipeline();
    await asIfBuiltBy(root, "open_issues", "v1.5.5");
    writeFileSync(join(root, "assets/open_issues.sql"), "select id, title, 1 as edited from issues\n");
    const plan = await planRun({ root, timezone: "UTC", selectors: [] });
    const step = plan.steps.find((s) => s.asset === "open_issues")!;
    expect(step.reason).toContain("SQL changed");
    expect(step.approvalCarries).toBeUndefined();
    expect(JSON.stringify((await cli(root, ["status", "--json"], cliEnv())).json)).toContain("EDITED_SINCE_LAST_RUN");
    const out = await runDue(root, ["open_issues"], nextFire().now);
    expect(out.data.steps[0]!.skippedBecause).toStartWith("held (SCHEDULE_HELD)");
  });
});
