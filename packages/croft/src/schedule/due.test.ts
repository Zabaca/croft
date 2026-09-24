// What is due (schedule/due.ts, DESIGN.md §8 "What counts as due", "What the user experiences"; §6 the scheduler
// hold): fires handled once, catch-up once, stale transforms, holds, backoff, groups, and the facts cache that keeps
// a tick with nothing changed from importing any asset code, keyed by everything a code hash covers, and never
// importing code nobody has run.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { problem } from "../core/errors.ts";
import { currentIdentity } from "../core/proc.ts";
import { tryAcquire } from "../history/leases.ts";
import { tsFingerprint } from "../project/ts-asset.ts";
import { writeChildRecord } from "../run/detach.ts";
import { cleanupProjects } from "../run/testkit.ts";
import {
  type DueWork, duePlanning, dueWork, type FactsResolver, FACTS_SETTING, keyOf, LOAD_RETRY_MS, resolveAssets, RETRY_BACKOFF_MS, scheduleView,
  SPAWNED_SETTING,
} from "./due.ts";
import {
  approveAll, built, DEAD, factsOf, imports, recordSkip, recordStep, rezone, type SchedProject, schedProject, scheduledIngest, scheduleStateOf,
  scheduling,
} from "./scheduler-testkit.ts";

const outside: string[] = [];
afterAll(() => {
  cleanupProjects();
  for (const d of outside.splice(0)) rmSync(d, { recursive: true, force: true });
});

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
    db.setSetting(SPAWNED_SETTING, [{ runId: "r_0922_1015_strt", assets: ["open_issues"], at: "2026-09-22T10:15:00.000Z" }]);
    db.close();
    // Its child process: this one (alive), recorded as the spawn handshake.
    writeChildRecord(p.stateDir, "r_0922_1015_strt", currentIdentity());
    let w = await work(p, "2026-09-22T10:20:00Z");
    expect(view(w, "open_issues")).toMatchObject({ due: true, held: { code: "leased", reason: "the scheduled run r_0922_1015_strt is starting; it stays due" } });
    expect(w.inFlight).toEqual([{ runId: "r_0922_1015_strt", assets: ["open_issues"], at: "2026-09-22T10:15:00.000Z" }]);
    // A child that is gone without recording its run no longer holds anything, but it did not start the
    // transform: that is reported, and the transform waits RETRY_BACKOFF_MS before the next try (never every minute).
    writeChildRecord(p.stateDir, "r_0922_1015_strt", DEAD);
    w = await work(p, "2026-09-22T10:21:00Z");
    expect(w.inFlight).toEqual([]);
    expect(view(w, "open_issues")).toMatchObject({
      due: true,
      held: { code: "backoff", reason: "the scheduled run r_0922_1015_strt did not start it (its process ended before it recorded the run); tries again after 10:30" },
    });
    expect(w.groups).toEqual([]);
    expect(w.failedStarts).toEqual([{
      runId: "r_0922_1015_strt", assets: ["open_issues"], at: "2026-09-22T10:15:00.000Z", reason: "its process ended before it recorded the run",
      unrecorded: true, fresh: true,
    }]);
    expect(w.problems.map((x) => [x.code, x.severity, x.message])).toEqual([
      ["RUN_CRASHED", "warning", "the scheduled run r_0922_1015_strt did not start open_issues: its process ended before it recorded the run"],
    ]);
    w = await work(p, "2026-09-22T10:30:00Z");
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

  test("stale transforms that share an input are one run, not one process each", async () => {
    const readers = ["r1", "r2", "r3", "r4", "r5"];
    const p = schedProject({
      "assets/src.ts": scheduledIngest(), "assets/other.ts": scheduledIngest(), "assets/lone.sql": "select id from other\n",
      ...Object.fromEntries(readers.map((r, n) => [`assets/${r}.sql`, `select id, ${n} as n from src\n`])),
    });
    await work(p, "2026-09-22T10:05:00Z");
    approveAll(p);
    built(p, "src", { lastLoadedAt: "2026-09-22T10:05:00.000000Z" });
    built(p, "other", { lastLoadedAt: "2026-09-22T10:05:00.000000Z" });
    for (const r of [...readers, "lone"]) {
      const input = r === "lone" ? "other" : "src";
      built(p, r, { kind: "sql", lastLoadedAt: "2026-09-22T10:05:01.000000Z", inputsSeen: { [input]: { inputLastLoadedAt: "2026-09-22T10:05:00.000000Z" } } });
    }
    for (const a of ["src", "other", ...readers, "lone"]) recordStep(p, { asset: a, at: "2026-09-22T10:05:02Z", status: "ok" });
    // `croft run src --only` and `croft run other --only` by hand: all six transforms are stale.
    built(p, "src", { lastLoadedAt: "2026-09-22T10:10:00.000000Z" });
    built(p, "other", { lastLoadedAt: "2026-09-22T10:10:00.000000Z" });
    const w = await work(p, "2026-09-22T10:20:00Z");
    expect(w.views.filter((v) => v.due).map((v) => v.asset)).toEqual(["lone", ...readers]);
    // The five readers of src: one run. lone reads nothing they touch: a run of its own.
    expect(w.groups).toEqual([["lone"], readers]);
  });
});

describe("the facts cache covers everything a TS asset's code hash covers", () => {
  test("an edit to helpers/, a JSON map or code outside the project is seen; run by hand, it is released on the next look with no file change", async () => {
    const away = mkdtempSync(join(tmpdir(), "croft-outside-"));
    outside.push(away);
    const shared = join(away, "shared.ts");
    writeFileSync(shared, `export const shared = "s1";\n`);
    const feed = `import { ingest } from "@zabaca/croft";
import { tag } from "../helpers/tag.ts";
import map from "../helpers/map.json";
import { shared } from ${JSON.stringify(shared)};
export default ingest({
  key: "id",
  schedule: "every hour",
  async *rows() {
    yield [{ id: 1, v: tag + map.k + shared }];
  },
});
`;
    const p = schedProject({ "assets/feed.ts": feed, "helpers/tag.ts": `export const tag = "v1";\n`, "helpers/map.json": `{ "k": "a" }\n` });
    const path = join(p.root, "assets/feed.ts");
    // The code hash a run computes (run/plan.ts, through project/ts-asset.ts): what a run by hand approves.
    const hash = () => tsFingerprint(path, { root: p.root, timezone: "UTC" });
    const approve = async () => {
      const db = p.db();
      db.approveCode("feed", await hash());
      db.close();
    };
    await work(p, "2026-09-22T10:05:00Z");
    await approve();
    recordStep(p, { asset: "feed", at: "2026-09-22T10:05:00Z", status: "ok" });
    let w = await work(p, "2026-09-22T11:00:30Z");
    expect(factsOf(p).feed!.codeHash).toBe(await hash());
    expect(factsOf(p).feed!.files).toEqual(expect.arrayContaining(["assets/feed.ts", "helpers/tag.ts", "helpers/map.json", relative(p.root, realpathSync(shared))]));
    expect(view(w, "feed").held).toBeNull();
    expect(w.groups).toEqual([["feed"]]);

    let minute = 1;
    for (const [file, text] of [
      [join(p.root, "helpers/tag.ts"), `export const tag = "v2";\n`],
      [join(p.root, "helpers/map.json"), `{ "k": "b" }\n`],
      [shared, `export const shared = "s2";\n`],
    ] as const) {
      writeFileSync(file, text);
      utimesSync(file, at(`2026-09-22T10:5${minute}:00Z`), at(`2026-09-22T10:5${minute}:00Z`));
      w = await work(p, `2026-09-22T11:0${minute}:00Z`);
      expect(factsOf(p).feed!.codeHash, file).toBe(await hash());
      expect(view(w, "feed").held?.code, file).toBe("SCHEDULE_HELD");
      expect(w.groups).toEqual([]);
      // Run by hand: approved. What status shows (scheduleView) and the next tick release it, with no file change.
      await approve();
      const shown = await scheduleView({ root: p.root, now: at(`2026-09-22T11:0${minute}:30Z`) });
      expect(shown.find((v) => v.asset === "feed")!.held, file).toBeNull();
      w = await work(p, `2026-09-22T11:0${minute}:40Z`);
      expect(view(w, "feed").held, file).toBeNull();
      expect(w.groups).toEqual([["feed"]]);
      minute++;
    }
  });

  test("an approval since the facts were read looks again, even if the key missed a change", async () => {
    const p = await pipeline();
    const path = join(p.root, "assets/issues.ts");
    await work(p, "2026-09-22T10:06:00Z");
    // A cached code hash that is not the file's (as a key that missed an input would leave it), read while an older
    // code was approved; a person has run the file's code since.
    const db = p.db();
    const facts = factsOf(p);
    db.setSetting("schedule.facts", { ...facts, issues: { ...facts.issues!, codeHash: "stale-hash", approved: "older-approval" } });
    db.approveCode("issues", await tsFingerprint(path, { root: p.root, timezone: "UTC" }));
    db.close();
    const w = await work(p, "2026-09-22T11:00:30Z");
    expect(view(w, "issues").held).toBeNull();
    expect(factsOf(p).issues!.codeHash).toBe(await tsFingerprint(path, { root: p.root, timezone: "UTC" }));
  });
});

describe("the scheduler imports only code a human has run (§6)", () => {
  test("an unapproved edit is bundled, never imported: it keeps the facts of the approved code, and is held", async () => {
    const marker = join(schedProject({}).root, "imported.log");
    const p = schedProject({ "assets/issues.ts": scheduledIngest({ marker }) });
    const c = counting();
    // New, never run by hand: not imported; its text shows it is an hourly ingest, due and held at the fire.
    let w = await work(p, "2026-09-22T10:05:00Z", { resolve: c.resolve });
    expect([c.calls, imports(marker), w.imported]).toEqual([[], 0, false]);
    w = await work(p, "2026-09-22T11:00:30Z", { resolve: c.resolve });
    expect(view(w, "issues")).toMatchObject({
      due: true, schedule: { text: "every hour" }, held: { code: "SCHEDULE_HELD", reason: expect.stringContaining("new: code edited") },
    });
    expect(c.calls).toEqual([]);
    approveAll(p);
    await work(p, "2026-09-22T11:01:00Z", { resolve: c.resolve });
    expect(c.calls).toEqual([["issues"]]);
    expect(imports(marker)).toBe(1);

    // An edit nobody has run (a new schedule, a fixture): its top-level code never runs under the scheduler.
    writeFileSync(join(p.root, "assets/issues.ts"), scheduledIngest({ marker, schedule: "daily at 06:00", body: `yield [{ id: 1, title: "test" }];` }));
    w = await work(p, "2026-09-22T11:02:00Z", { resolve: c.resolve });
    expect(c.calls).toEqual([["issues"]]);
    expect(w.imported).toBe(false);
    expect(view(w, "issues")).toMatchObject({ schedule: { text: "every hour" }, held: { code: "SCHEDULE_HELD", reason: expect.stringContaining("code edited") } });
    expect(factsOf(p).issues).toMatchObject({ readFrom: expect.any(String), codeHash: expect.any(String) });
    expect(factsOf(p).issues!.readFrom).not.toBe(factsOf(p).issues!.codeHash);
    // Nothing changed: not bundled or imported again.
    w = await work(p, "2026-09-22T11:03:00Z", { resolve: c.resolve });
    expect([c.calls.length, w.imported]).toEqual([1, false]);
    // Run by hand: imported on the next look.
    approveAll(p);
    await work(p, "2026-09-22T11:04:00Z", { resolve: c.resolve });
    expect(c.calls).toEqual([["issues"], ["issues"]]);
  });

  test("a new TS transform, never run by hand, is not imported either: held, stale (never built)", async () => {
    const enrich = `import { transform } from "@zabaca/croft";
export default transform({ inputs: ["issues"], key: "id", async *rows({ rows }) { for await (const r of rows("issues")) yield { id: r.id }; } });
`;
    const p = await pipeline();
    await work(p, "2026-09-22T10:06:00Z");
    writeFileSync(join(p.root, "assets/enrich.ts"), enrich);
    const c = counting();
    const w = await work(p, "2026-09-22T10:20:00Z", { resolve: c.resolve });
    expect(c.calls).toEqual([]);
    expect(view(w, "enrich")).toMatchObject({ kind: "ts", due: true, dueReason: "stale: never built", held: { code: "SCHEDULE_HELD" } });
  });
});

describe("an import of approved code that fails is tried again", () => {
  const ENRICH = `import { transform } from "@zabaca/croft";
export default transform({ inputs: ["issues"], key: "id", async *rows({ rows }) { for await (const r of rows("issues")) yield { id: r.id }; } });
`;
  /** The real resolver, except that enrich's import fails while `failing.on`. */
  function flaky() {
    const failing = { on: true };
    const calls: string[][] = [];
    const resolve: FactsResolver = async (i) => {
      calls.push([...i.names]);
      const got = await resolveAssets(i);
      if (!failing.on) return got;
      return got.map((a) => a.name !== "enrich" ? a : {
        ...a, ok: false, kind: "ts" as const, inputs: [],
        problems: [problem("ASSET_INVALID", { message: "assets/enrich.ts: fetch failed: getaddrinfo ENOTFOUND api.example.com", hint: "move network calls into rows()", asset: "enrich" })],
      });
    };
    return { failing, calls, resolve };
  }

  test("once: reported, retried after LOAD_RETRY_MS; the transform is due again once it loads", async () => {
    // Run by hand once (pipeline approves every asset's code), never imported by the scheduler yet.
    const p = await pipeline({ "assets/enrich.ts": ENRICH });
    built(p, "enrich", { kind: "ts", lastLoadedAt: "2026-09-22T10:05:02.000000Z", inputsSeen: { issues: { inputLastLoadedAt: "2026-09-22T10:05:00.000000Z" } } });
    recordStep(p, { asset: "enrich", at: "2026-09-22T10:05:02Z", status: "ok" });
    // issues loaded by hand (--only): enrich is stale.
    built(p, "issues", { lastLoadedAt: "2026-09-22T10:10:00.000000Z" });
    recordStep(p, { asset: "issues", at: "2026-09-22T10:10:00Z", status: "ok" });
    const f = flaky();
    expect(LOAD_RETRY_MS).toBe(5 * 60_000);
    let w = await work(p, "2026-09-22T10:12:00Z", { resolve: f.resolve });
    expect(f.calls).toEqual([["enrich", "issues"]]);
    expect(w.problems).toEqual([expect.objectContaining({
      code: "ASSET_INVALID", severity: "warning", asset: "enrich",
      message: "the scheduler could not load enrich: assets/enrich.ts: fetch failed: getaddrinfo ENOTFOUND api.example.com",
      effect: "the scheduler keeps what it knew of enrich and tries again after 10:17",
    })]);
    expect(factsOf(p).enrich).toMatchObject({ ok: false, failedAt: "2026-09-22T10:12:00.000Z" });
    // Before the retry: not imported again.
    f.failing.on = false;
    w = await work(p, "2026-09-22T10:15:00Z", { resolve: f.resolve });
    expect(f.calls.length).toBe(1);
    // After it: imported, and the stale transform is due.
    w = await work(p, "2026-09-22T10:17:00Z", { resolve: f.resolve });
    expect(f.calls).toEqual([["enrich", "issues"], ["enrich"]]);
    expect(factsOf(p).enrich).toMatchObject({ ok: true, inputs: ["issues"] });
    expect(factsOf(p).enrich!.failedAt).toBeUndefined();
    expect(view(w, "enrich")).toMatchObject({ due: true, dueReason: "stale: input issues changed", held: null });
    expect(w.groups).toEqual([["enrich", "open_issues"]]);

    // An approved edit whose import fails keeps the facts it had: the transform stays due.
    writeFileSync(join(p.root, "assets/enrich.ts"), ENRICH.replace("yield { id: r.id }", "yield { id: r.id, n: 1 }"));
    const db2 = p.db();
    db2.approveCode("enrich", await tsFingerprint(join(p.root, "assets/enrich.ts"), { root: p.root, timezone: "UTC" }));
    db2.close();
    f.failing.on = true;
    w = await work(p, "2026-09-22T10:20:00Z", { resolve: f.resolve });
    expect(f.calls.length).toBe(3);
    expect(factsOf(p).enrich).toMatchObject({ ok: false, inputs: ["issues"], kind: "ts" });
    expect(view(w, "enrich")).toMatchObject({ due: true, held: null });
    expect(w.groups).toEqual([["enrich", "open_issues"]]);
  });
});

describe("a time zone change is said as such", () => {
  test("held: the project time zone changed (A → B), not 'code edited', for TS and SQL; the run's hold says the same", async () => {
    const p = await pipeline();
    await work(p, "2026-09-22T10:06:00Z");
    scheduling(p, "on");
    const ny = rezone(p, "America/New_York");
    const w = await work(ny, "2026-09-22T11:00:30Z");
    expect(view(w, "issues").held).toEqual({
      code: "SCHEDULE_HELD", reason: "the project time zone changed (UTC → America/New_York) since it was last run by hand; croft run issues releases it",
    });
    expect(view(w, "open_issues").held).toEqual({
      code: "SCHEDULE_HELD", reason: "the project time zone changed (UTC → America/New_York) since it was last run by hand; croft run open_issues releases it",
    });
    // What status and `schedule status` show (scheduleView, which may import the unapproved code for a person).
    const shown = await scheduleView({ root: ny.root, now: at("2026-09-22T11:00:35Z") });
    for (const a of ["issues", "open_issues"]) {
      expect(shown.find((v) => v.asset === a)!.held!.reason, a).toStartWith("the project time zone changed (UTC → America/New_York)");
    }
    // The run the tick starts (croft run --due) holds it with the same words.
    const db = ny.db(at("2026-09-22T11:00:40Z"));
    try {
      const plan = duePlanning({ project: ny.project, runs: db, now: at("2026-09-22T11:00:40Z") });
      const h = plan.hold({ asset: "issues", file: "assets/issues.ts", kind: "rows", codeHash: factsOf(ny).issues!.codeHash!, ok: true });
      expect(h).toMatchObject({
        hold: "code_not_run_by_hand",
        reason: "held: the project time zone changed (UTC → America/New_York) since it was last run by hand; croft run issues releases it",
        problem: { code: "SCHEDULE_HELD", details: { timeZoneChanged: { from: "UTC", to: "America/New_York" } } },
      });
    } finally {
      db.close();
    }
    // An edit on top is an edit.
    writeFileSync(join(ny.root, "assets/open_issues.sql"), "select id, 1 as n from issues\n");
    expect(view(await work(ny, "2026-09-22T11:01:00Z"), "open_issues").held!.reason).toMatch(/^code edited .* ago, not run by hand yet/);
  });
});

describe("a transform skipped for a held or failed input waits for that input", () => {
  /** src (hourly) → h (SQL) → t (SQL, reads h and src), approved and built by hand at 10:05. */
  async function chain(): Promise<SchedProject> {
    const p = schedProject({
      "assets/src.ts": scheduledIngest(), "assets/h.sql": "select id from src\n", "assets/t.sql": "select h.id from h join src using (id)\n",
    });
    await work(p, "2026-09-22T10:05:00Z");
    approveAll(p);
    built(p, "src", { lastLoadedAt: "2026-09-22T10:05:00.000000Z" });
    built(p, "h", { kind: "sql", lastLoadedAt: "2026-09-22T10:05:01.000000Z", inputsSeen: { src: { inputLastLoadedAt: "2026-09-22T10:05:00.000000Z" } } });
    built(p, "t", {
      kind: "sql", lastLoadedAt: "2026-09-22T10:05:02.000000Z",
      inputsSeen: { src: { inputLastLoadedAt: "2026-09-22T10:05:00.000000Z" }, h: { inputLastLoadedAt: "2026-09-22T10:05:01.000000Z" } },
    });
    for (const a of ["src", "h", "t"]) recordStep(p, { asset: a, at: "2026-09-22T10:05:02Z", status: "ok" });
    // The 11:00 fire: src loaded again by the scheduled run.
    built(p, "src", { lastLoadedAt: "2026-09-22T11:00:05.000000Z" });
    recordStep(p, { asset: "src", at: "2026-09-22T11:00:05Z", status: "ok", human: false });
    return p;
  }

  test("held (SCHEDULE_HELD): not started every minute; due again once the input is released", async () => {
    const p = await chain();
    // h is being edited (a new column): the 11:00 run held it, and skipped t for it.
    writeFileSync(join(p.root, "assets/h.sql"), "select id, 1 as extra from src\n");
    utimesSync(join(p.root, "assets/h.sql"), at("2026-09-22T10:50:00Z"), at("2026-09-22T10:50:00Z"));
    recordSkip(p, { asset: "t", at: "2026-09-22T11:00:06Z", because: "input h is held (SCHEDULE_HELD): code edited 10 min ago, not run by hand yet; croft run h releases it" });
    for (const now of ["2026-09-22T11:01:00Z", "2026-09-22T11:02:00Z", "2026-09-22T11:30:00Z"]) {
      const w = await work(p, now);
      expect(view(w, "h").held?.code).toBe("SCHEDULE_HELD");
      expect(view(w, "t")).toMatchObject({ due: true, held: { code: "backoff", reason: `waits for its input h: SCHEDULE_HELD, ${view(w, "h").held!.reason}` } });
      expect(w.groups).toEqual([]);
    }
    // Released (previewed or run by hand: its code approved): h and t are due, in one run.
    approveAll(p, ["h"]);
    const w = await work(p, "2026-09-22T11:31:00Z");
    expect(view(w, "t").held).toBeNull();
    expect(w.groups).toEqual([["h", "t"]]);
  });

  test("held: a change to the input since the skip makes the reader due again", async () => {
    const p = await chain();
    writeFileSync(join(p.root, "assets/h.sql"), "select id, 1 as extra from src\n");
    recordSkip(p, { asset: "t", at: "2026-09-22T11:00:06Z", because: "input h is held (SCHEDULE_HELD): code edited" });
    expect(view(await work(p, "2026-09-22T11:01:00Z"), "t").held?.code).toBe("backoff");
    // h is built (by hand, with the code before the edit, say) after the skip.
    built(p, "h", { kind: "sql", lastLoadedAt: "2026-09-22T11:10:00.000000Z", inputsSeen: { src: { inputLastLoadedAt: "2026-09-22T11:00:05.000000Z" } } });
    const w = await work(p, "2026-09-22T11:11:00Z");
    expect(view(w, "t")).toMatchObject({ due: true, held: null });
    expect(w.groups).toEqual([["t"]]);
  });

  test("failed deterministically: the reader waits with it, and both run again, in one run, once its input changes", async () => {
    const p = await chain();
    const err = problem("QUERY_FAILED", { message: "Conversion Error: Could not convert string 'x' to INT32", hint: "fix the SQL", asset: "h" });
    const runId = recordStep(p, { asset: "h", at: "2026-09-22T11:00:06Z", status: "failed", human: false, error: err, codeHash: factsOf(p).h!.codeHash! });
    recordSkip(p, { asset: "t", at: "2026-09-22T11:00:07Z", because: `input h failed (${runId})` });
    for (const now of ["2026-09-22T11:01:00Z", "2026-09-22T11:02:00Z", "2026-09-22T11:59:00Z"]) {
      const w = await work(p, now);
      expect(view(w, "h").held).toEqual({ code: "backoff", reason: "failed at 11:00 (QUERY_FAILED); waits for a change to its code or inputs, or croft run h" });
      expect(view(w, "t").held).toEqual({
        code: "backoff", reason: "waits for its input h: failed at 11:00 (QUERY_FAILED); waits for a change to its code or inputs, or croft run h",
      });
      expect(w.groups).toEqual([]);
    }
    // src loads again (its next fire, or by hand): h's wait ends, and t's with it.
    built(p, "src", { lastLoadedAt: "2026-09-22T12:00:05.000000Z" });
    recordStep(p, { asset: "src", at: "2026-09-22T12:00:05Z", status: "ok", human: false });
    const w = await work(p, "2026-09-22T12:01:00Z");
    expect([view(w, "h").held, view(w, "t").held]).toEqual([null, null]);
    expect(w.groups).toEqual([["h", "t"]]);
  });

  test("a skip whose run names another input waits for that one only", async () => {
    const p = await chain();
    writeFileSync(join(p.root, "assets/h.sql"), "select id, 1 as extra from src\n");
    // The skip named src (not h): src is not held, so t is due.
    recordSkip(p, { asset: "t", at: "2026-09-22T11:00:06Z", because: "input src was not built: something else" });
    const w = await work(p, "2026-09-22T11:01:00Z");
    expect(view(w, "t")).toMatchObject({ due: true, held: null });
  });
});

describe("a fire the run did not attempt stays due", () => {
  const FIRE = "2026-09-22T11:00:00.000Z";
  /** The tick at 11:00:30 recorded the 11:00 fire and noted its run, as schedule/tick.ts does. */
  async function fired(o: { run?: "ended" | "attempted" | "crashed" | "none"; child?: "dead" | "refused" } = {}): Promise<{ p: SchedProject; runId: string }> {
    const p = await pipeline();
    const runId = "r_0922_1100_tick";
    const db = p.db(at("2026-09-22T11:00:30Z"));
    try {
      db.putScheduleState("issues", { lastFireAt: FIRE, lastAttemptAt: "2026-09-22T11:00:30.000Z" });
      db.setSetting(SPAWNED_SETTING, [{ runId, assets: ["issues"], at: "2026-09-22T11:00:30.000Z", fires: { issues: { fire: FIRE, before: null } } }]);
      if (o.run && o.run !== "none") {
        const run = db.createRun({ id: runId, trigger: "schedule", human: false, argv: ["run", "--due", "issues"], identity: DEAD });
        if (o.run === "attempted") {
          db.startStep({ runId: run.id, asset: "issues", attempt: 1, reason: "scheduled" });
          db.finishStep(run.id, "issues", 1, { status: "failed", error: problem("HTTP_ERROR", { message: "400", hint: "x" }) });
        }
        db.finishRun(run.id, o.run === "crashed" ? "crashed" : o.run === "attempted" ? "failed" : "succeeded");
      }
    } finally {
      db.close();
    }
    if (o.child === "dead") writeChildRecord(p.stateDir, runId, DEAD);
    if (o.child === "refused") {
      const { writeNotStarted } = await import("../run/detach.ts");
      writeNotStarted(p.stateDir, runId, problem("DB_BUSY", { message: "the database is busy", hint: "later" }));
    }
    return { p, runId };
  }

  test("it met another run's lease (a run that ended normally): the fire goes back, with no wait", async () => {
    const { p } = await fired({ run: "ended" });
    const w = await work(p, "2026-09-22T11:02:00Z");
    expect(view(w, "issues")).toMatchObject({ due: true, lastFireAt: null, held: null, dueReason: "fired at 11:00" });
    expect(w.rollbacks).toEqual([{ asset: "issues", from: FIRE, to: null }]);
    expect(w.failedStarts).toEqual([]);
    expect(w.groups).toEqual([["issues"]]);
    // scheduleView (read-only) sees it too, before any tick.
    const views = await scheduleView({ root: p.root, now: at("2026-09-22T11:02:00Z") });
    expect(views.find((v) => v.asset === "issues")).toMatchObject({ due: true, lastFireAt: null });
  });

  test("it attempted the ingest (even one that failed): the fire is handled", async () => {
    const { p } = await fired({ run: "attempted" });
    const w = await work(p, "2026-09-22T11:02:00Z");
    expect(view(w, "issues")).toMatchObject({ due: false, lastFireAt: FIRE });
    expect(w.rollbacks).toEqual([]);
  });

  test("its child died before it recorded the run: the fire stays due, reported, and waits RETRY_BACKOFF_MS", async () => {
    const { p, runId } = await fired({ child: "dead" });
    let w = await work(p, "2026-09-22T11:01:30Z");
    expect(view(w, "issues")).toMatchObject({
      due: true, lastFireAt: null,
      held: { code: "backoff", reason: `the scheduled run ${runId} did not start it (its process ended before it recorded the run); tries again after 11:15` },
    });
    expect(w.rollbacks).toEqual([{ asset: "issues", from: FIRE, to: null }]);
    expect(w.failedStarts).toMatchObject([{ runId, assets: ["issues"], unrecorded: true, fresh: true }]);
    expect(w.problems.map((x) => [x.code, x.message, x.effect])).toEqual([
      ["RUN_CRASHED", `the scheduled run ${runId} did not start issues: its process ended before it recorded the run`, "it stays due; it runs again after 11:15"],
    ]);
    expect(w.groups).toEqual([]);
    w = await work(p, "2026-09-22T11:15:30Z");
    expect(w.groups).toEqual([["issues"]]);
  });

  test("its child refused to start: the refusal is the reason", async () => {
    const { p, runId } = await fired({ child: "refused" });
    const w = await work(p, "2026-09-22T11:01:30Z");
    expect(view(w, "issues").held!.reason).toBe(`the scheduled run ${runId} did not start it (it refused to start: DB_BUSY: the database is busy); tries again after 11:15`);
    expect(w.failedStarts[0]!.problem).toMatchObject({ code: "DB_BUSY" });
  });

  test("the run crashed before it started the ingest: the fire stays due and waits", async () => {
    const { p, runId } = await fired({ run: "crashed" });
    const w = await work(p, "2026-09-22T11:01:30Z");
    expect(view(w, "issues")).toMatchObject({
      due: true, held: { code: "backoff", reason: `the scheduled run ${runId} did not start it (the run crashed before it started it); tries again after 11:15` },
    });
    expect(w.failedStarts).toMatchObject([{ runId, unrecorded: false }]);
  });

  test("an asset the run did not start is bundled again: a cached code hash the key failed to refresh cannot loop", async () => {
    const p = await pipeline();
    await work(p, "2026-09-22T10:06:00Z");
    // An edit the key does not see (as a file it failed to cover would leave it): the cached facts match the edited
    // file's key, with the approved code's hash.
    writeFileSync(join(p.root, "assets/issues.ts"), scheduledIngest({ body: `yield [{ id: 1, title: "test" }];` }));
    const facts = factsOf(p);
    const key = keyOf(p.root, join(p.root, "assets/issues.ts"), "UTC", { files: facts.issues!.files!, packages: facts.issues!.packages! });
    const db = p.db();
    db.setSetting(FACTS_SETTING, { ...facts, issues: { ...facts.issues!, fileHash: key } });
    db.putScheduleState("issues", { fileHash: key });
    db.close();
    expect((await work(p, "2026-09-22T11:00:20Z")).groups).toEqual([["issues"]]);
    // The run the tick started computed the real hash, held issues and ended without starting it.
    const runId = "r_0922_1100_miss";
    const db2 = p.db(at("2026-09-22T11:00:30Z"));
    db2.putScheduleState("issues", { lastFireAt: FIRE });
    db2.setSetting(SPAWNED_SETTING, [{ runId, assets: ["issues"], at: "2026-09-22T11:00:30.000Z", fires: { issues: { fire: FIRE, before: null } } }]);
    db2.finishRun(db2.createRun({ id: runId, trigger: "schedule", human: false, argv: ["run", "--due", "issues"], identity: DEAD }).id, "succeeded");
    db2.close();
    const w = await work(p, "2026-09-22T11:01:30Z");
    expect(view(w, "issues")).toMatchObject({ due: true, held: { code: "SCHEDULE_HELD" } });
    expect(w.groups).toEqual([]);
    expect(factsOf(p).issues!.codeHash).toBe(await tsFingerprint(join(p.root, "assets/issues.ts"), { root: p.root, timezone: "UTC" }));
  });

  test("a later fire moved last_fire_at since: nothing goes back", async () => {
    const { p } = await fired({ run: "ended" });
    const db = p.db();
    db.putScheduleState("issues", { lastFireAt: "2026-09-22T12:00:00.000Z" });
    db.close();
    const w = await work(p, "2026-09-22T12:02:00Z");
    expect(w.rollbacks).toEqual([]);
    expect(view(w, "issues")).toMatchObject({ due: false, lastFireAt: "2026-09-22T12:00:00.000Z" });
  });
});

describe("the facts cache: nothing imported when nothing changed", () => {
  test("a tick with no changed file reads no asset file; an edit reads that asset again, once", async () => {
    const marker = join(schedProject({}).root, "imported.log");
    const p = schedProject({ "assets/issues.ts": scheduledIngest({ marker }), "assets/open_issues.sql": "select id from issues\n" });
    const c = counting();
    let w = await work(p, "2026-09-22T10:05:00Z", { resolve: c.resolve });
    // The SQL is parsed; the ingest, never run by hand, is only bundled (§6: its code is not run).
    expect(w.imported).toBe(true);
    expect(c.calls).toEqual([["open_issues"]]);
    expect(imports(marker)).toBe(0);
    // Run by hand: the next look imports it, once.
    approveAll(p);
    w = await work(p, "2026-09-22T10:06:00Z", { resolve: c.resolve });
    expect(c.calls).toEqual([["open_issues"], ["issues"]]);
    expect(imports(marker)).toBe(1);
    // schedule_state keeps phrase, cron and file_hash.
    expect(scheduleStateOf(p, "issues")).toMatchObject({ phrase: "every hour", cron: "0 * * * *", fileHash: factsOf(p).issues!.fileHash });

    for (const now of ["2026-09-22T10:07:00Z", "2026-09-22T11:00:30Z", "2026-09-22T12:00:30Z"]) {
      const t0 = performance.now();
      w = await work(p, now, { resolve: c.resolve });
      const took = performance.now() - t0;
      expect(w.imported).toBe(false);
      expect(took).toBeLessThan(500);
    }
    expect(c.calls.length).toBe(2);
    expect(imports(marker)).toBe(1);

    // scheduleView reads the same cache: no import either.
    const views = await scheduleView({ root: p.root, now: at("2026-09-22T12:10:00Z") });
    expect(views.find((v) => v.asset === "issues")).toMatchObject({ schedule: { text: "every hour" }, nextFireAt: "2026-09-22T13:00:00.000Z" });
    expect(imports(marker)).toBe(1);

    // An edit to the SQL asset re-reads only it.
    writeFileSync(join(p.root, "assets/open_issues.sql"), "select id, 1 as n from issues\n");
    w = await work(p, "2026-09-22T12:11:00Z", { resolve: c.resolve });
    expect(c.calls.at(-1)).toEqual(["open_issues"]);
    expect(imports(marker)).toBe(1);

    // An edit to the ingest is bundled again, not imported (nobody ran it); run by hand, it is imported once.
    // (This process caches the module it imported, so the marker only moves in a new process: tick.test.ts runs
    // real ticks for that.)
    writeFileSync(join(p.root, "assets/issues.ts"), scheduledIngest({ marker, schedule: "daily at 06:00" }));
    w = await work(p, "2026-09-22T12:12:00Z", { resolve: c.resolve });
    expect(c.calls.length).toBe(3);
    expect(view(w, "issues").held?.code).toBe("SCHEDULE_HELD");
    approveAll(p, ["issues"]);
    await work(p, "2026-09-22T12:13:00Z", { resolve: c.resolve });
    expect(c.calls.at(-1)).toEqual(["issues"]);
    await work(p, "2026-09-22T12:14:00Z", { resolve: c.resolve });
    expect(c.calls.length).toBe(4);

    // A file the ingest does not import (lib/util.ts) changes nothing it depends on: nothing is read again.
    await Bun.write(join(p.root, "lib", "util.ts"), "export const x = 1;\n");
    w = await work(p, "2026-09-22T12:15:00Z", { resolve: c.resolve });
    expect(w.imported).toBe(false);
    expect(c.calls.length).toBe(4);
  });

  test("a file the naming rules refuse is remembered, never imported", async () => {
    const p = schedProject({ "assets/order.ts": scheduledIngest() });
    const c = counting();
    let w = await work(p, "2026-09-22T10:05:00Z", { resolve: c.resolve });
    expect(w.views).toEqual([]);
    w = await work(p, "2026-09-22T10:06:00Z", { resolve: c.resolve });
    expect(w.views).toEqual([]);
    expect(c.calls).toEqual([]);
    expect(w.imported).toBe(false);
    expect(factsOf(p).order).toMatchObject({ kind: null, notAsset: true });
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
