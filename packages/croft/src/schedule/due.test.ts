// What is due (schedule/due.ts, DESIGN.md §8 "What counts as due", "What the user experiences"; §6 the scheduler
// hold): fires handled once, catch-up once, stale transforms, holds, backoff, groups, and the facts cache that keeps
// a tick with nothing changed from importing any asset code.
import { afterAll, describe, expect, test } from "bun:test";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { problem } from "../core/errors.ts";
import { currentIdentity } from "../core/proc.ts";
import { tryAcquire } from "../history/leases.ts";
import { cleanupProjects } from "../run/testkit.ts";
import { type DueWork, dueWork, type FactsResolver, resolveAssets, RETRY_BACKOFF_MS, scheduleView, SPAWNED_SETTING } from "./due.ts";
import {
  approveAll, built, factsOf, imports, recordStep, type SchedProject, schedProject, scheduledIngest, scheduleStateOf, scheduling,
} from "./scheduler-testkit.ts";

afterAll(cleanupProjects);

const at = (iso: string) => new Date(iso);

/** dueWork over the project's runs.sqlite at `now`, storing the facts (as the tick does). */
async function work(p: SchedProject, now: string, o: { resolve?: FactsResolver; store?: boolean } = {}): Promise<DueWork> {
  const db = p.db(at(now));
  try {
    return await dueWork({ project: p.project, runs: db, now: at(now), store: o.store ?? true, ...(o.resolve ? { resolve: o.resolve } : {}) });
  } finally {
    db.close();
  }
}

const view = (w: DueWork, asset: string) => w.views.find((v) => v.asset === asset)!;

/** A counting resolver: the real one, and the names it was asked for. */
function counting(): { resolve: FactsResolver; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, resolve: async (i) => (calls.push([...i.names]), resolveAssets(i)) };
}

/** issues (hourly ingest) → open_issues (SQL), approved and built by hand at 10:05. */
async function pipeline(files: Record<string, string> = {}): Promise<SchedProject> {
  const p = schedProject({ "assets/issues.ts": scheduledIngest(), "assets/open_issues.sql": "select id from issues\n", ...files });
  await work(p, "2026-09-22T10:05:00Z");
  approveAll(p);
  built(p, "issues", { lastLoadedAt: "2026-09-22T10:05:00.000000Z" });
  built(p, "open_issues", { kind: "sql", lastLoadedAt: "2026-09-22T10:05:01.000000Z", inputsSeen: { issues: { inputLastLoadedAt: "2026-09-22T10:05:00.000000Z" } } });
  recordStep(p, { asset: "issues", at: "2026-09-22T10:05:00Z", status: "ok" });
  recordStep(p, { asset: "open_issues", at: "2026-09-22T10:05:01Z", status: "ok" });
  return p;
}

describe("fires: each is handled once; missed fires run once", () => {
  test("an hourly ingest is due at each fire and not again once it is handled; a run by hand covers the fire before it", async () => {
    const p = await pipeline();
    // Built by hand at 10:05, after the 10:00 fire.
    let w = await work(p, "2026-09-22T10:20:00Z");
    expect(view(w, "issues")).toMatchObject({ due: false, nextFireAt: "2026-09-22T11:00:00.000Z", schedule: { text: "every hour", cron: "0 * * * *" }, held: null });
    expect(w.groups).toEqual([]);

    w = await work(p, "2026-09-22T11:00:30Z");
    expect(view(w, "issues")).toMatchObject({ due: true, dueReason: "fired at 11:00", nextFireAt: "2026-09-22T12:00:00.000Z" });
    // What reads it follows it in the same run; only the ingest is named.
    expect(view(w, "open_issues")).toMatchObject({ due: true, dueReason: "after issues, which is due", held: null });
    expect(w.groups).toEqual([["issues"]]);
    expect(w.fires.get("issues")).toBe("2026-09-22T11:00:00.000Z");

    // The run of that fire started (last_fire_at): not due again until the next fire.
    const db = p.db();
    db.putScheduleState("issues", { lastFireAt: "2026-09-22T11:00:00.000Z" });
    db.close();
    expect((await work(p, "2026-09-22T11:30:00Z")).groups).toEqual([]);
    expect((await work(p, "2026-09-22T11:59:59Z")).groups).toEqual([]);
    w = await work(p, "2026-09-22T12:00:05Z");
    expect(w.groups).toEqual([["issues"]]);
    expect(view(w, "issues").lastFireAt).toBe("2026-09-22T11:00:00.000Z");
  });

  test("after 8 missed hourly fires (a laptop asleep), the ingest is due once, for the latest fire", async () => {
    const p = await pipeline();
    const db = p.db();
    db.putScheduleState("issues", { lastFireAt: "2026-09-22T10:00:00.000Z" });
    db.close();
    const w = await work(p, "2026-09-22T18:10:00Z");
    expect(w.groups).toEqual([["issues"]]);
    expect(w.fires.get("issues")).toBe("2026-09-22T18:00:00.000Z");
    expect(view(w, "issues").dueReason).toBe("fired at 18:00; 8 missed fires run once");
    const db2 = p.db();
    db2.putScheduleState("issues", { lastFireAt: w.fires.get("issues")! });
    db2.close();
    expect((await work(p, "2026-09-22T18:40:00Z")).groups).toEqual([]);
  });

  test("the fire times can be injected (the matcher is schedule/types.ts by default)", async () => {
    const p = await pipeline();
    const db = p.db(at("2026-09-22T10:30:00Z"));
    try {
      const w = await dueWork({
        project: p.project, runs: db, now: at("2026-09-22T10:30:00Z"), store: true,
        fires: { latest: () => at("2026-09-22T10:29:00Z"), next: () => at("2026-09-22T10:31:00Z") },
      });
      expect(view(w, "issues")).toMatchObject({ due: true, nextFireAt: "2026-09-22T10:31:00.000Z", dueReason: "fired at 10:29" });
    } finally {
      db.close();
    }
  });
});

describe("stale transforms are due on their own", () => {
  test("a stale transform is due with no ingest due", async () => {
    const p = await pipeline();
    // issues was loaded again (a run --only by hand at 10:10): open_issues has not read it.
    built(p, "issues", { lastLoadedAt: "2026-09-22T10:10:00.000000Z" });
    recordStep(p, { asset: "issues", at: "2026-09-22T10:10:00Z", status: "ok" });
    const w = await work(p, "2026-09-22T10:20:00Z");
    expect(view(w, "issues").due).toBe(false);
    expect(view(w, "open_issues")).toMatchObject({ due: true, dueReason: "stale: input issues changed", held: null });
    expect(w.groups).toEqual([["open_issues"]]);
    expect(w.fires.size).toBe(0);
  });

  test("a transform whose input was never built waits for it", async () => {
    const p = schedProject({ "assets/issues.ts": scheduledIngest(), "assets/open_issues.sql": "select id from issues\n" });
    await work(p, "2026-09-22T10:05:00Z");
    approveAll(p);
    // Not due on its own (a run would only skip it)...
    const db = p.db();
    db.putScheduleState("issues", { lastFireAt: "2026-09-22T10:00:00.000Z" });
    db.close();
    let w = await work(p, "2026-09-22T10:20:00Z");
    expect(view(w, "open_issues")).toMatchObject({ due: false, dueReason: null });
    expect(w.groups).toEqual([]);
    // ...but after its input, once that is due: the run of the ingest builds it too.
    w = await work(p, "2026-09-22T11:00:20Z");
    expect(view(w, "open_issues")).toMatchObject({ due: true, dueReason: "after issues, which is due" });
    expect(w.groups).toEqual([["issues"]]);
  });
});

describe("held assets are skipped and stay due", () => {
  test("SCHEDULE_HELD: a new asset never run by hand", async () => {
    const p = schedProject({ "assets/issues.ts": scheduledIngest() });
    utimesSync(join(p.root, "assets/issues.ts"), at("2026-09-22T10:48:00Z"), at("2026-09-22T10:48:00Z"));
    const w = await work(p, "2026-09-22T11:00:30Z");
    expect(view(w, "issues")).toMatchObject({
      due: true, held: { code: "SCHEDULE_HELD", reason: "new: code edited 13 min ago, not run by hand yet; croft run issues releases it" },
    });
    expect(w.groups).toEqual([]);
    expect(w.held).toEqual([{ asset: "issues", code: "SCHEDULE_HELD", reason: view(w, "issues").held!.reason }]);
  });

  test("SCHEDULE_HELD: code edited since it was last run by hand names when, and croft run <asset>", async () => {
    const p = await pipeline();
    writeFileSync(join(p.root, "assets/issues.ts"), scheduledIngest({ body: `yield [{ id: 1, title: "test" }];` }));
    utimesSync(join(p.root, "assets/issues.ts"), at("2026-09-22T10:48:30Z"), at("2026-09-22T10:48:30Z"));
    const w = await work(p, "2026-09-22T11:00:30Z");
    expect(view(w, "issues")).toMatchObject({ due: true, held: { code: "SCHEDULE_HELD", reason: "code edited 12 min ago, not run by hand yet; croft run issues releases it" } });
    expect(w.groups).toEqual([]);
    // Run by hand (its code approved again): released.
    approveAll(p, ["issues"]);
    expect((await work(p, "2026-09-22T11:00:40Z")).groups).toEqual([["issues"]]);
  });

  test("SCHEDULE_HELD: a file that no longer loads stays scheduled, and held", async () => {
    const p = await pipeline();
    writeFileSync(join(p.root, "assets/issues.ts"), scheduledIngest().replace("export default", "export default oops("));
    const w = await work(p, "2026-09-22T11:00:30Z");
    expect(view(w, "issues")).toMatchObject({ due: true, schedule: { cron: "0 * * * *" } });
    expect(view(w, "issues").held).toMatchObject({ code: "SCHEDULE_HELD" });
    expect(view(w, "issues").held!.reason).toContain("does not load; fix it, then croft run issues releases it");
  });

  test("LARGE_REPROCESS: a scheduled run met the cost guard; a successful run by hand releases it", async () => {
    const p = await pipeline();
    built(p, "issues", { lastLoadedAt: "2026-09-22T10:10:00.000000Z" });
    recordStep(p, { asset: "issues", at: "2026-09-22T10:10:00Z", status: "ok" });
    const guard = { ...problem("LARGE_REPROCESS", { message: "open_issues would process 5000 input rows", hint: "ask" }), severity: "warning" as const };
    recordStep(p, { asset: "open_issues", at: "2026-09-22T10:11:00Z", status: "skipped", human: false, error: guard });
    let w = await work(p, "2026-09-22T10:20:00Z");
    expect(view(w, "open_issues")).toMatchObject({ due: true, held: { code: "LARGE_REPROCESS" } });
    expect(view(w, "open_issues").held!.reason).toContain("croft run open_issues");
    expect(w.groups).toEqual([]);
    recordStep(p, { asset: "open_issues", at: "2026-09-22T10:15:00Z", status: "ok", human: true });
    w = await work(p, "2026-09-22T10:20:00Z");
    expect(view(w, "open_issues").held).toBeNull();
  });

  test("paused: everything is held until scheduling resumes", async () => {
    const p = await pipeline();
    scheduling(p, "paused", "2026-09-22T13:00:00.000Z");
    const w = await work(p, "2026-09-22T11:00:30Z");
    expect(view(w, "issues")).toMatchObject({ due: true, held: { code: "paused", reason: "scheduling is paused until 13:00; croft schedule on resumes it" } });
    expect(w.groups).toEqual([]);
  });

  test("leased: an asset another run holds is skipped and stays due (overlaps skip)", async () => {
    const p = await pipeline();
    const db = p.db();
    expect(tryAcquire(db, ["issues"], "r_0922_1059_long", currentIdentity()).ok).toBe(true);
    db.close();
    let w = await work(p, "2026-09-22T11:00:30Z");
    expect(view(w, "issues")).toMatchObject({ due: true, held: { code: "leased", reason: "run r_0922_1059_long holds it; it stays due" } });
    expect(w.groups).toEqual([]);
    // Still due once the lease is gone: the fire was never handled.
    const db2 = p.db();
    db2.sqlite.query("DELETE FROM leases").run();
    db2.close();
    w = await work(p, "2026-09-22T11:05:00Z");
    expect(w.groups).toEqual([["issues"]]);
  });

  test("leased: a run a tick started that has not taken its leases yet holds its assets and what reads them", async () => {
    const p = await pipeline();
    built(p, "issues", { lastLoadedAt: "2026-09-22T10:10:00.000000Z" });
    recordStep(p, { asset: "issues", at: "2026-09-22T10:10:00Z", status: "ok" });
    const db = p.db();
    db.setSetting(SPAWNED_SETTING, [{ runId: "r_0922_1015_strt", assets: ["open_issues"] }]);
    db.close();
    // Its child process: this one (alive), recorded as the spawn handshake.
    const { writeChildRecord } = await import("../run/detach.ts");
    writeChildRecord(p.stateDir, "r_0922_1015_strt", currentIdentity());
    let w = await work(p, "2026-09-22T10:20:00Z");
    expect(view(w, "open_issues")).toMatchObject({ due: true, held: { code: "leased", reason: "the scheduled run r_0922_1015_strt is starting; it stays due" } });
    expect(w.inFlight).toEqual([{ runId: "r_0922_1015_strt", assets: ["open_issues"] }]);
    // A child that is gone no longer holds anything.
    writeChildRecord(p.stateDir, "r_0922_1015_strt", { pid: 999_999, procStart: "0", bootId: "no-such-boot" });
    w = await work(p, "2026-09-22T10:21:00Z");
    expect(w.inFlight).toEqual([]);
    expect(w.groups).toEqual([["open_issues"]]);
  });
});

describe("backoff: a failed transform is never retried every minute", () => {
  async function staleTransform(): Promise<SchedProject> {
    const p = await pipeline();
    built(p, "issues", { lastLoadedAt: "2026-09-22T10:10:00.000000Z" });
    recordStep(p, { asset: "issues", at: "2026-09-22T10:10:00Z", status: "ok" });
    return p;
  }

  test("a deterministic failure waits for a change to the transform's inputs or code", async () => {
    const p = await staleTransform();
    const codeHash = factsOf(p).open_issues!.codeHash!;
    const err = problem("TYPE_CONFLICT", { message: "column id: BIGINT cannot hold VARCHAR", hint: "pin it", asset: "open_issues" });
    recordStep(p, { asset: "open_issues", at: "2026-09-22T10:12:00Z", status: "failed", human: false, error: err, codeHash });
    let w = await work(p, "2026-09-22T10:13:00Z");
    expect(view(w, "open_issues")).toMatchObject({
      due: true, held: { code: "backoff", reason: "failed at 10:12 (TYPE_CONFLICT); waits for a change to its code or inputs, or croft run open_issues" },
    });
    expect(w.groups).toEqual([]);
    // Hours later: still waiting.
    expect((await work(p, "2026-09-22T15:00:00Z")).views.find((v) => v.asset === "open_issues")!.held?.code).toBe("backoff");
    // Its input changed (a run by hand of issues at 11:00:10): it tries again.
    built(p, "issues", { lastLoadedAt: "2026-09-22T11:00:10.000000Z" });
    recordStep(p, { asset: "issues", at: "2026-09-22T11:00:10Z", status: "ok" });
    w = await work(p, "2026-09-22T11:01:00Z");
    expect(view(w, "open_issues").held).toBeNull();
    expect(w.groups).toEqual([["open_issues"]]);
  });

  test("a deterministic failure of older code does not hold the new code", async () => {
    const p = await staleTransform();
    const err = problem("QUERY_FAILED", { message: "Binder Error", hint: "fix the SQL", asset: "open_issues" });
    recordStep(p, { asset: "open_issues", at: "2026-09-22T10:12:00Z", status: "failed", human: false, error: err, codeHash: "an-older-hash" });
    const w = await work(p, "2026-09-22T10:13:00Z");
    expect(view(w, "open_issues").held).toBeNull();
  });

  test("a retryable failure (after its own retries) or a crash waits RETRY_BACKOFF_MS, or the server's longer Retry-After", async () => {
    const p = await staleTransform();
    const codeHash = factsOf(p).open_issues!.codeHash!;
    const err = problem("HTTP_ERROR", { message: "503 from the API", hint: "later", retryable: true, asset: "open_issues" });
    recordStep(p, { asset: "open_issues", at: "2026-09-22T10:12:00Z", status: "failed", human: false, error: err, codeHash });
    expect(RETRY_BACKOFF_MS).toBe(15 * 60_000);
    let w = await work(p, "2026-09-22T10:13:00Z");
    expect(view(w, "open_issues").held).toEqual({ code: "backoff", reason: "failed at 10:12 (HTTP_ERROR); tries again after 10:27" });
    expect((await work(p, "2026-09-22T10:27:01Z")).groups).toEqual([["open_issues"]]);

    const slow = problem("HTTP_ERROR", { message: "429", hint: "later", retryable: true, details: { retryAfterMs: 3_600_000 } });
    recordStep(p, { asset: "open_issues", at: "2026-09-22T10:30:00Z", status: "failed", human: false, error: slow, codeHash });
    w = await work(p, "2026-09-22T10:50:00Z");
    expect(view(w, "open_issues").held).toEqual({ code: "backoff", reason: "failed at 10:30 (HTTP_ERROR); tries again after 11:30" });

    recordStep(p, { asset: "open_issues", at: "2026-09-22T12:00:00Z", status: "crashed", human: false, codeHash });
    w = await work(p, "2026-09-22T12:01:00Z");
    expect(view(w, "open_issues").held).toEqual({ code: "backoff", reason: "crashed at 12:00 (CRASHED); tries again after 12:15" });
  });
});

describe("groups: one run per connected group of due assets", () => {
  test("independent pipelines run apart; ingests that feed one transform run together", async () => {
    const p = schedProject({
      "assets/a.ts": scheduledIngest(), "assets/b.ts": scheduledIngest(), "assets/c.ts": scheduledIngest(),
      "assets/ab.sql": "select a.id from a join b using (id)\n", "assets/c_only.sql": "select id from c\n",
    });
    await work(p, "2026-09-22T10:05:00Z");
    approveAll(p);
    const w = await work(p, "2026-09-22T11:00:30Z");
    expect(w.groups).toEqual([["a", "b"], ["c"]]);
  });
});

describe("the facts cache: nothing imported when nothing changed", () => {
  test("a tick with no changed file imports no asset code; an edit re-imports that asset once", async () => {
    const marker = join(schedProject({}).root, "imported.log");
    const p = schedProject({ "assets/issues.ts": scheduledIngest({ marker }), "assets/open_issues.sql": "select id from issues\n" });
    const c = counting();
    let w = await work(p, "2026-09-22T10:05:00Z", { resolve: c.resolve });
    expect(w.imported).toBe(true);
    expect(c.calls).toEqual([["issues", "open_issues"]]);
    expect(imports(marker)).toBe(1);
    // schedule_state keeps phrase, cron and file_hash.
    expect(scheduleStateOf(p, "issues")).toMatchObject({ phrase: "every hour", cron: "0 * * * *", fileHash: factsOf(p).issues!.fileHash });

    for (const now of ["2026-09-22T10:06:00Z", "2026-09-22T11:00:30Z", "2026-09-22T12:00:30Z"]) {
      const t0 = performance.now();
      w = await work(p, now, { resolve: c.resolve });
      const took = performance.now() - t0;
      expect(w.imported).toBe(false);
      expect(took).toBeLessThan(500);
    }
    expect(c.calls.length).toBe(1);
    expect(imports(marker)).toBe(1);

    // scheduleView reads the same cache: no import either.
    const views = await scheduleView({ root: p.root, now: at("2026-09-22T12:10:00Z") });
    expect(views.find((v) => v.asset === "issues")).toMatchObject({ schedule: { text: "every hour" }, nextFireAt: "2026-09-22T13:00:00.000Z" });
    expect(imports(marker)).toBe(1);

    // An edit to the SQL asset re-reads only it (and the TS transforms, of which there are none here).
    writeFileSync(join(p.root, "assets/open_issues.sql"), "select id, 1 as n from issues\n");
    w = await work(p, "2026-09-22T12:11:00Z", { resolve: c.resolve });
    expect(c.calls.at(-1)).toEqual(["open_issues"]);
    expect(imports(marker)).toBe(1);

    // An edit to the ingest reads it again, once. (This process caches the module it imported, so the marker only
    // moves in a new process: tick.test.ts runs real ticks for that.)
    writeFileSync(join(p.root, "assets/issues.ts"), scheduledIngest({ marker, schedule: "daily at 06:00" }));
    await work(p, "2026-09-22T12:12:00Z", { resolve: c.resolve });
    expect(c.calls.at(-1)).toEqual(["issues"]);
    await work(p, "2026-09-22T12:13:00Z", { resolve: c.resolve });
    expect(c.calls.length).toBe(3);

    // lib/ is part of every TS asset's code: a change there reads the TS assets again.
    await Bun.write(join(p.root, "lib", "util.ts"), "export const x = 1;\n");
    await work(p, "2026-09-22T12:14:00Z", { resolve: c.resolve });
    expect(c.calls.at(-1)).toEqual(["issues"]);
    expect(c.calls.length).toBe(4);
  });

  test("a file the naming rules refuse is remembered, not imported every tick", async () => {
    const p = schedProject({ "assets/order.ts": scheduledIngest() });
    const c = counting();
    let w = await work(p, "2026-09-22T10:05:00Z", { resolve: c.resolve });
    expect(w.views).toEqual([]);
    w = await work(p, "2026-09-22T10:06:00Z", { resolve: c.resolve });
    expect(c.calls).toEqual([["order"]]);
    expect(w.imported).toBe(false);
  });

  test("scheduleView takes the facts from a project the caller already resolved (status does)", async () => {
    const p = await pipeline();
    const { resolveProject } = await import("../project/resolve.ts");
    const resolved = (await resolveProject({ root: p.root, timezone: "UTC" })).assets;
    writeFileSync(join(p.root, "assets/open_issues.sql"), "select id, 2 as n from issues\n");
    const views = await scheduleView({ root: p.root, now: at("2026-09-22T11:00:30Z"), resolved });
    expect(views.map((v) => [v.asset, v.kind, v.due])).toEqual([["issues", "ingest", true], ["open_issues", "sql", true]]);
    // Read-only: the cache still holds what the last tick stored.
    expect(factsOf(p).open_issues!.fileHash).toBe(scheduleStateOf(p, "open_issues")!.fileHash!);
  });

  test("scheduleView without runs.sqlite: every asset new, nothing written", async () => {
    const p = schedProject({ "assets/issues.ts": scheduledIngest() });
    const views = await scheduleView({ root: p.root, now: at("2026-09-22T11:00:30Z") });
    expect(views).toEqual([{
      asset: "issues", kind: "ingest", schedule: { text: "every hour", cron: "0 * * * *" }, nextFireAt: "2026-09-22T12:00:00.000Z",
      lastFireAt: null, lastAttemptAt: null, due: true, dueReason: "fired at 11:00",
      held: { code: "SCHEDULE_HELD", reason: expect.stringContaining("new: code edited") },
    }]);
    expect(await Bun.file(join(p.stateDir, "runs.sqlite")).exists()).toBe(false);
  });
});
