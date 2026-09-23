// The run engine in this process (executeRun), against a Bun.serve mock API: pagination, retries, the
// shrink guard, big integers, type drift, cursors, --from, ctx.query, the catalog mirror and leases.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { closeAllWarehouses } from "../db/warehouse.ts";
import { getCatalog } from "../history/catalog.ts";
import { acquire } from "../history/leases.ts";
import { logPath } from "../history/logs.ts";
import { RunsDb } from "../history/runs-db.ts";
import { listTrash } from "../safety/trash.ts";
import { cleanupProjects, keysetIssues, linkItems, makeProject, mockApi, runIn, simpleGet, slowPages } from "./testkit.ts";

const api = mockApi();
afterAll(async () => {
  api.stop();
  await closeAllWarehouses();
  cleanupProjects();
});
beforeEach(() => {
  api.state.log.length = 0;
});

/** Read a warehouse with a private instance (the engine has closed it after the run). */
async function rows(root: string, sql: string): Promise<Record<string, unknown>[]> {
  await closeAllWarehouses();
  const db = await DuckDBInstance.create(join(root, "warehouse.duckdb"), { access_mode: "READ_ONLY" });
  const c = await db.connect();
  try {
    return (await c.runAndReadAll(sql)).getRowObjectsJS() as Record<string, unknown>[];
  } finally {
    c.disconnectSync();
    db.closeSync();
  }
}

function runsDb(root: string): RunsDb {
  return RunsDb.open(join(root, ".croft"));
}

describe("keyset pagination, cursors and the catalog mirror", () => {
  test("first run loads every page; the cursor, runs.sqlite, the step log and the catalog agree", async () => {
    api.state.issues = [
      { id: 1, title: "a", updated_at: "2026-09-01T10:00:00Z" },
      { id: 2, title: "b", updated_at: "2026-09-02T10:00:00Z" },
      { id: 3, title: "c", updated_at: "2026-09-03T10:00:00Z" },
    ];
    const root = makeProject({ "assets/issues.ts": keysetIssues(api.url) });
    const out = await runIn(root, ["issues"]);
    expect(out.exit).toBe(0);
    expect(out.data.status).toBe("succeeded");
    const step = out.data.steps[0]!;
    expect(step).toMatchObject({ asset: "issues", status: "ok", behavior: "merge by id", attempt: 1, maxAttempts: 3 });
    expect(step.rows).toMatchObject({ added: 3, updated: 0, total: 3 });
    expect(step.cursor).toMatchObject({ after: "2026-09-03T10:00:00Z" });
    // Ascending keyset with an inclusive `since`: pages (1,2), (2,3), (3); dedupe keeps one row per id.
    expect(step.requests).toBe(3);
    expect(step.rows.in).toBe(5);
    expect(await rows(root, "select id, title from issues order by id")).toEqual([
      { id: 1n, title: "a" }, { id: 2n, title: "b" }, { id: 3n, title: "c" },
    ]);

    const db = runsDb(root);
    try {
      const run = db.getRun(out.data.runId)!;
      expect(run.status).toBe("succeeded");
      expect((run.summary as { data: { runId: string } }).data.runId).toBe(out.data.runId);
      expect(db.stepsFor(out.data.runId)).toMatchObject([{ asset: "issues", attempt: 1, status: "ok", added: 3 }]);
      const cat = getCatalog(db, "issues")!;
      expect(cat).toMatchObject({ asset: "issues", kind: "ingest", write: "merge", key: ["id"], rows: 3, lastRunId: out.data.runId });
      expect(cat.cursor).toEqual({ field: "updated_at", value: "2026-09-03T10:00:00Z", type: "timestamp", unit: null });
      expect(cat.columns.map((c) => c.name)).toEqual(["id", "title", "updated_at", "_loaded_at"]);
      expect(cat.columns.find((c) => c.name === "updated_at")?.type).toBe("TIMESTAMPTZ");
      expect(cat.lastLoadedAt).toMatch(/Z$/);
      expect(db.listRuns().length).toBe(1);
      // No lease is left behind.
      expect(db.sqlite.query("select count(*) n from leases").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
    const log = readFileSync(logPath(join(root, ".croft"), out.data.runId, "issues"), "utf8");
    expect(log).toContain("extracted 5 rows in 1 part(s), 3 request(s)");
    expect(existsSync(join(root, ".croft", "staging", out.data.runId))).toBe(false);
  });

  test("the next run asks from the saved cursor minus 1 s, and only changed rows are written", async () => {
    api.state.issues = [
      { id: 1, title: "a", updated_at: "2026-09-01T10:00:00Z" },
      { id: 2, title: "b", updated_at: "2026-09-02T10:00:00Z" },
    ];
    const root = makeProject({ "assets/issues.ts": keysetIssues(api.url) });
    expect((await runIn(root, ["issues"])).exit).toBe(0);
    api.state.issues.push({ id: 3, title: "c", updated_at: "2026-09-05T08:00:00Z" });
    api.state.issues[1] = { id: 2, title: "b2", updated_at: "2026-09-04T00:00:00Z" };
    api.state.log.length = 0;
    const second = await runIn(root, ["issues"]);
    expect(second.exit).toBe(0);
    // Keyed timestamp cursors re-read 1 s (§3a "Boundary rows").
    expect(api.state.log[0]!.query.since).toBe("2026-09-02T09:59:59Z");
    const s = second.data.steps[0]!;
    expect(s.cursor).toEqual({ before: "2026-09-02T10:00:00Z", after: "2026-09-05T08:00:00Z", sinceUsed: "2026-09-02T09:59:59Z" });
    // The inclusive API returns id 3 again on the last page; dedupe by key keeps one.
    expect(s.rows).toMatchObject({ in: 3, added: 1, updated: 1, unchanged: 0, total: 3 });
    // A third run with nothing new leaves the cursor where it is and writes nothing.
    const third = await runIn(root, ["issues"]);
    expect(third.data.steps[0]!.rows).toMatchObject({ added: 0, updated: 0, unchanged: 1, total: 3 });
    expect(third.data.steps[0]!.cursor?.after).toBe("2026-09-05T08:00:00Z");
    expect(await rows(root, "select title from issues where id = 2")).toEqual([{ title: "b2" }]);
  });
});

describe("Link pagination", () => {
  test("res.next follows rel=next to the last page", async () => {
    api.state.items = [{ id: 1, n: "x" }, { id: 2, n: "y" }, { id: 3, n: "z" }, { id: 4, n: "w" }, { id: 5, n: "v" }];
    const root = makeProject({ "assets/items.ts": linkItems(api.url) });
    const out = await runIn(root, []);
    expect(out.exit).toBe(0);
    expect(out.data.steps[0]).toMatchObject({ asset: "items", status: "ok", behavior: "replace", requests: 3 });
    expect(api.state.log.map((l) => l.query.page ?? "1")).toEqual(["1", "2", "3"]);
    expect(await rows(root, "select count(*)::INT n from items")).toEqual([{ n: 5 }]);
  });
});

describe("retries", () => {
  test("429 with Retry-After is honored by ctx.http inside one attempt", async () => {
    api.state.limited = 1;
    const root = makeProject({ "assets/limited.ts": simpleGet(api.url, "/limited") });
    const t0 = Date.now();
    const out = await runIn(root, ["limited"]);
    expect(out.exit).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(out.data.steps[0]).toMatchObject({ status: "ok", attempt: 1 });
    expect(api.state.log.filter((l) => l.path === "/limited")).toHaveLength(2);
    const log = readFileSync(logPath(join(root, ".croft"), out.data.runId, "limited"), "utf8");
    expect(log).toContain("429");
  });

  test("flaky 500s beyond ctx.http's own retries are retried by the runner as a new attempt", async () => {
    api.state.failures = 5; // http retries 3 times (4 tries), so attempt 1 fails; attempt 2 succeeds
    const root = makeProject({ "assets/flaky.ts": simpleGet(api.url, "/flaky") });
    const out = await runIn(root, ["flaky"]);
    expect(out.exit).toBe(0);
    expect(out.data.steps[0]).toMatchObject({ status: "ok", attempt: 2, maxAttempts: 3 });
    const db = runsDb(root);
    try {
      expect(db.stepsFor(out.data.runId).map((s) => [s.attempt, s.status])).toEqual([[1, "failed"], [2, "ok"]]);
      expect(db.stepsFor(out.data.runId)[0]!.error?.code).toBe("HTTP_ERROR");
    } finally {
      db.close();
    }
  });

  test("a deterministic failure is not retried, and exits 1 with the problem and a logs next step", async () => {
    const root = makeProject({ "assets/broken.ts": `import { ingest } from "@zabaca/croft";
export default ingest({ async *rows() { yield [{ id: 1 }]; throw new TypeError("boom at page 2"); } });
` });
    const out = await runIn(root, ["broken"]);
    expect(out.exit).toBe(1);
    expect(out.data.status).toBe("failed");
    expect(out.data.steps[0]).toMatchObject({ status: "failed", attempt: 1, logsCommand: "croft logs broken --failed" });
    expect(out.data.steps[0]!.error?.code).toBe("ASSET_CODE_ERROR");
    expect(out.data.steps[0]!.error?.message).toContain("boom at page 2");
    expect(out.next).toContainEqual({ command: "croft logs broken --failed", reason: "see why broken failed" });
  });

  test("retries: 0 in the asset means one attempt only", async () => {
    api.state.failures = 10;
    const root = makeProject({ "assets/flaky.ts": simpleGet(api.url, "/flaky", "\n  retries: 0,") });
    const out = await runIn(root, ["flaky"]);
    expect(out.exit).toBe(1);
    expect(out.data.steps[0]).toMatchObject({ status: "failed", attempt: 1, maxAttempts: 1 });
    api.state.failures = 0;
  });
});

describe("the shrink guard and --allow-shrink", () => {
  const zones = Array.from({ length: 6 }, (_, i) => ({ zone: i + 1, name: `z${i + 1}` }));

  test("an empty page trips SHRINK_GUARD on a replace ingest; nothing is written", async () => {
    api.state.zones = zones;
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones") });
    expect((await runIn(root, ["zones"])).exit).toBe(0);
    api.state.zones = [];
    const out = await runIn(root, ["zones"]);
    expect(out.exit).toBe(1);
    const e = out.data.steps[0]!.error!;
    expect(e.code).toBe("SHRINK_GUARD");
    expect(e.fix).toMatchObject({ kind: "manual", requiresHuman: true });
    expect(e.details).toMatchObject({ rowsBefore: 6, rowsAfter: 0, requests: 1, lastStatus: 200, bodyPreview: "[]" });
    expect(out.data.steps[0]!.attempt).toBe(1); // deterministic: no retry
    expect(await rows(root, "select count(*)::INT n from zones")).toEqual([{ n: 6 }]);
  });

  test("off a TTY --allow-shrink returns a confirmation (exit 5); the token run trashes first, then writes", async () => {
    api.state.zones = zones;
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones") });
    await runIn(root, ["zones"]);
    api.state.zones = zones.slice(0, 1);
    const asked = await runIn(root, ["zones"], { allowShrink: true });
    expect(asked.exit).toBe(5);
    expect(asked.confirmation).toMatchObject({ command: "croft run zones --allow-shrink", impact: { asset: "zones", rows: 6, downstream: [] } });
    expect(asked.problems.map((p) => p.code)).toContain("CONFIRMATION_REQUIRED");
    expect(asked.data.steps[0]).toMatchObject({ status: "skipped", reason: "needs confirmation" });
    expect(asked.next.some((n) => n.command.includes("confirm"))).toBe(false); // never in next
    expect(await rows(root, "select count(*)::INT n from zones")).toEqual([{ n: 6 }]);
    expect(listTrash(join(root, ".croft"))).toEqual([]);

    const token = asked.confirmation!.token;
    const done = await runIn(root, ["zones"], { allowShrink: true, confirmToken: token });
    expect(done.exit).toBe(0);
    const step = done.data.steps[0]!;
    expect(step.status).toBe("ok");
    expect(step.rows).toMatchObject({ total: 1, deleted: 5 });
    expect(step.trashed).toMatchObject({ rows: 6 });
    expect(done.problems.map((p) => p.code)).toContain("SHRINK_GUARD_DISABLED");
    const trash = listTrash(join(root, ".croft"), "zones");
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatchObject({ asset: "zones", rows: 6, reason: `run --allow-shrink (${done.data.runId})` });
    expect(await rows(root, "select count(*)::INT n from zones")).toEqual([{ n: 1 }]);

    // A spent token is stale.
    const again = await runIn(root, ["zones"], { allowShrink: true, confirmToken: token });
    api.state.zones = [];
    expect(again.data.steps[0]!.status).toBe("ok"); // 1 → 1 rows: no shrink, the token is never consulted
    const shrinkAgain = await runIn(root, ["zones"], { allowShrink: true, confirmToken: token });
    expect(shrinkAgain.exit).toBe(5);
    expect(shrinkAgain.data.steps[0]!.error?.code).toBe("CONFIRMATION_STALE");
  });

  test("a token whose impact changed (the table grew) is CONFIRMATION_STALE and changes nothing", async () => {
    api.state.zones = zones;
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones") });
    await runIn(root, ["zones"]);
    api.state.zones = [];
    const asked = await runIn(root, ["zones"], { allowShrink: true });
    expect(asked.exit).toBe(5);
    api.state.zones = [...zones, { zone: 7, name: "z7" }, { zone: 8, name: "z8" }];
    await runIn(root, ["zones"]);
    api.state.zones = [];
    const stale = await runIn(root, ["zones"], { allowShrink: true, confirmToken: asked.confirmation!.token });
    expect(stale.data.steps[0]!.error?.code).toBe("CONFIRMATION_STALE");
    expect(await rows(root, "select count(*)::INT n from zones")).toEqual([{ n: 8 }]);
    expect(listTrash(join(root, ".croft"))).toEqual([]);
  });

  test("on a TTY the run asks y/N; no means SHRINK_GUARD, yes trashes and writes", async () => {
    api.state.zones = zones;
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones") });
    await runIn(root, ["zones"]);
    api.state.zones = [];
    const questions: string[] = [];
    const no = await runIn(root, ["zones"], { allowShrink: true, interactive: true, prompt: async (q) => (questions.push(q), false) });
    expect(no.data.steps[0]!.error?.code).toBe("SHRINK_GUARD");
    expect(questions[0]).toContain("zones would go from 6 rows to 0");
    const yes = await runIn(root, ["zones"], { allowShrink: true, interactive: true, prompt: async () => true });
    expect(yes.exit).toBe(0);
    expect(yes.data.steps[0]!.trashed?.rows).toBe(6);
    expect(await rows(root, "select count(*)::INT n from zones")).toEqual([{ n: 0 }]);
  });

  test("--allow-shrink takes exactly one exact name and only replace ingests", async () => {
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones"), "assets/issues.ts": keysetIssues(api.url) });
    await expect(runIn(root, [], { allowShrink: true })).rejects.toMatchObject({ code: "USAGE_ERROR" });
    await expect(runIn(root, ["z*"], { allowShrink: true })).rejects.toMatchObject({ code: "USAGE_ERROR" });
    await expect(runIn(root, ["issues"], { allowShrink: true })).rejects.toMatchObject({ code: "USAGE_ERROR" });
  });
});

describe("types across runs", () => {
  test("big integers reach DuckDB exactly through ctx.http's lossless JSON", async () => {
    api.state.raw = `[{"id": 1, "big": 12345678901234567890}, {"id": 2, "big": 9007199254740993}]`;
    const root = makeProject({ "assets/bigs.ts": simpleGet(api.url, "/raw", '\n  key: "id",') });
    const out = await runIn(root, ["bigs"]);
    expect(out.exit).toBe(0);
    expect(out.problems.map((p) => p.code)).not.toContain("UNSAFE_INTEGER");
    expect(await rows(root, "select big::VARCHAR b, typeof(big) t from bigs order by id")).toEqual([
      { b: "12345678901234567890", t: "HUGEINT" }, { b: "9007199254740993", t: "HUGEINT" },
    ]);
  });

  test("type drift: an integer column that receives fractions widens to DOUBLE; text in it is TYPE_CONFLICT", async () => {
    api.state.raw = `[{"id": 1, "amount": 10}, {"id": 2, "amount": 20}]`;
    const root = makeProject({ "assets/drift.ts": simpleGet(api.url, "/raw", '\n  key: "id",') });
    expect((await runIn(root, ["drift"])).exit).toBe(0);
    api.state.raw = `[{"id": 1, "amount": 10.5}, {"id": 2, "amount": 20}, {"id": 3, "amount": 1, "note": "new"}]`;
    const widened = await runIn(root, ["drift"]);
    expect(widened.exit).toBe(0);
    const s = widened.data.steps[0]!;
    expect(s.schemaChanges).toContainEqual({ kind: "widen", column: "amount", from: "BIGINT", to: "DOUBLE" });
    expect(s.schemaChanges).toContainEqual({ kind: "add_column", column: "note", type: "VARCHAR" });
    expect(widened.problems.map((p) => p.code)).toContain("TYPE_WIDENED");
    api.state.raw = `[{"id": 4, "amount": "n/a"}]`;
    const conflict = await runIn(root, ["drift"]);
    expect(conflict.exit).toBe(1);
    expect(conflict.data.steps[0]!.error?.code).toBe("TYPE_CONFLICT");
    expect(conflict.data.steps[0]!.attempt).toBe(1);
    expect(await rows(root, "select count(*)::INT n from drift")).toEqual([{ n: 3 }]);
    const db = runsDb(root);
    try {
      expect(getCatalog(db, "drift")!.columns.find((c) => c.name === "amount")?.type).toBe("DOUBLE");
    } finally {
      db.close();
    }
  });
});

describe("--from backfills", () => {
  test("a merge ingest fetches from the converted --from and the cursor never regresses", async () => {
    api.state.issues = [
      { id: 1, title: "a", updated_at: "2026-09-01T10:00:00Z" },
      { id: 2, title: "b", updated_at: "2026-09-10T10:00:00Z" },
    ];
    const root = makeProject({ "assets/issues.ts": keysetIssues(api.url) });
    await runIn(root, ["issues"]);
    api.state.log.length = 0;
    const out = await runIn(root, ["issues"], { from: "2026-06-24" });
    expect(out.exit).toBe(0);
    // A date is midnight in the project zone, rendered in the saved cursor's own form (UTC, Z).
    expect(api.state.log[0]!.query.since).toBe("2026-06-24T07:00:00Z");
    const s = out.data.steps[0]!;
    expect(s.reason).toContain("since: 2026-06-24T07:00:00Z (2026-06-24T00:00:00-07:00)");
    expect(s.cursor).toMatchObject({ before: "2026-09-10T10:00:00Z", after: "2026-09-10T10:00:00Z", sinceUsed: "2026-06-24T07:00:00Z" });
    const log = readFileSync(logPath(join(root, ".croft"), out.data.runId, "issues"), "utf8");
    expect(log).toContain("--from 2026-06-24: since: 2026-06-24T07:00:00Z (2026-06-24T00:00:00-07:00)");
  });

  test("an epoch-seconds cursor gets a number; relative values count back from now", async () => {
    api.state.raw = `[{"id": "a", "created": 1782000000}]`;
    const root = makeProject({ "assets/charges.ts": `import { ingest } from "@zabaca/croft";
export default ingest({
  key: "id",
  incremental: { field: "created", unit: "s", lookback: "30 days" },
  async *rows({ since, http }) {
    yield (await http.get("${api.url}/raw", { query: { since } })).json<Record<string, unknown>[]>();
  },
});
` });
    await runIn(root, ["charges"]);
    api.state.log.length = 0;
    const second = await runIn(root, ["charges"]);
    expect(api.state.log[0]!.query.since).toBe(String(1782000000 - 30 * 86400));
    expect(second.exit).toBe(0);
    api.state.log.length = 0;
    const now = new Date("2026-09-22T12:00:00Z");
    const back = await runIn(root, ["charges"], { from: "-90d", now: () => now });
    expect(back.exit).toBe(0);
    const want = Math.floor(now.getTime() / 1000) - 90 * 86400;
    expect(api.state.log[0]!.query.since).toBe(String(want));
    expect(back.data.steps[0]!.reason).toContain(`since: ${want} (`);
  });

  test("the --from matrix: replace and file ingests are BACKFILL_UNSUPPORTED; append before the cursor would duplicate", async () => {
    api.state.zones = [{ zone: 1 }];
    api.state.raw = `[{"seq": 5, "what": "x"}]`;
    const root = makeProject({
      "assets/zones.ts": simpleGet(api.url, "/zones"),
      "assets/events.ts": `import { ingest } from "@zabaca/croft";
export default ingest({
  write: "append",
  incremental: "seq",
  async *rows({ http }) { yield (await http.get("${api.url}/raw")).json<Record<string, unknown>[]>(); },
});
`,
    });
    const replace = await runIn(root, ["zones"], { from: "2026-01-01" });
    expect(replace.exit).toBe(1);
    expect(replace.data.steps[0]!.error).toMatchObject({ code: "BACKFILL_UNSUPPORTED" });
    expect(replace.data.steps[0]!.error!.hint).toContain("croft run zones");
    await runIn(root, ["events"]);
    const dup = await runIn(root, ["events"], { from: "3" });
    expect(dup.exit).toBe(1);
    expect(dup.data.steps[0]!.error?.code).toBe("BACKFILL_WOULD_DUPLICATE");
    const later = await runIn(root, ["events"], { from: "9" });
    expect(later.exit).toBe(0);
  });

  test("a transform named with --from is BACKFILL_UNSUPPORTED; in a bare run it is skipped", async () => {
    api.state.issues = [{ id: 1, title: "a", updated_at: "2026-09-01T10:00:00Z" }];
    const root = makeProject({ "assets/report.sql": "select 1 as x\n", "assets/issues.ts": keysetIssues(api.url) });
    const named = await runIn(root, ["report"], { from: "-7d" });
    expect(named.exit).toBe(1);
    expect(named.data.steps[0]!.error).toMatchObject({ code: "BACKFILL_UNSUPPORTED", hint: "transforms rebuild from their inputs: croft run report --rebuild" });
    const bare = await runIn(root, [], { from: "-7d" });
    expect(bare.exit).toBe(0);
    expect(bare.data.steps.find((s) => s.asset === "report")).toMatchObject({ status: "skipped", skippedBecause: "--from applies to merge ingests" });
  });
});

describe("ctx.query over the asset's own table", () => {
  test("reads a snapshot taken before the run (empty on the first run), with HUGEINT intact", async () => {
    api.state.raw = `[{"id": 1, "big": 170141183460469231731687303715884105727}, {"id": 2, "big": 5}]`;
    const root = makeProject({ "assets/known.ts": `import { ingest } from "@zabaca/croft";
export default ingest({
  key: "id",
  async *rows({ http, query, log }) {
    let seen: { id: number; big: bigint }[] = [];
    try {
      seen = await query<{ id: number; big: bigint }>("select id, big from known order by id");
    } catch (e) {
      log("first run:", (e as Error).message);
    }
    log("seen", JSON.stringify(seen.map((r) => [r.id, String(r.big)])));
    const rows = (await http.get("${api.url}/raw")).json<Record<string, unknown>[]>();
    yield rows.map((r) => ({ ...r, known: seen.some((s) => s.id === r.id) }));
  },
});
` });
    const first = await runIn(root, ["known"]);
    expect(first.exit).toBe(0);
    const log1 = readFileSync(logPath(join(root, ".croft"), first.data.runId, "known"), "utf8");
    expect(log1).toContain("has no table yet");
    const second = await runIn(root, ["known"]);
    expect(second.exit).toBe(0);
    const log2 = readFileSync(logPath(join(root, ".croft"), second.data.runId, "known"), "utf8");
    expect(log2).toContain(`seen [[1,"170141183460469231731687303715884105727"],[2,"5"]]`);
    expect(await rows(root, "select id, known from known order by id")).toEqual([{ id: 1n, known: true }, { id: 2n, known: true }]);
  });

  test("ctx.query is one sandboxed SELECT: writes, other files and the state folder are refused", async () => {
    api.state.raw = `[{"id": 1}]`;
    const root = makeProject({ "assets/probe.ts": `import { ingest } from "@zabaca/croft";
export default ingest({
  key: "id",
  async *rows({ http, query, log }) {
    for (const sql of ["delete from probe", "select * from read_text('.croft/runs.sqlite')", "select * from read_csv('/etc/hosts')", "select 1; select 2"]) {
      try { await query(sql); log("allowed", sql); } catch (e) { log("refused", (e as { code?: string }).code, sql); }
    }
    yield (await http.get("${api.url}/raw")).json<Record<string, unknown>[]>();
  },
});
` });
    await runIn(root, ["probe"]);
    const out = await runIn(root, ["probe"]);
    const log = readFileSync(logPath(join(root, ".croft"), out.data.runId, "probe"), "utf8");
    expect(log).not.toContain("allowed");
    expect(log).toContain("refused QUERY_NOT_SELECT delete from probe");
    expect(log).toContain("refused QUERY_PATH_DENIED select * from read_text");
    expect(log).toContain("refused QUERY_PATH_DENIED select * from read_csv('/etc/hosts')");
    expect(log).toContain("refused SQL_NOT_ONE_STATEMENT");
  });
});

describe("leases, timeouts and signals", () => {
  test("an asset leased by another live run is ASSET_BUSY (exit 4) with --no-wait, naming the run", async () => {
    api.state.zones = [{ zone: 1 }];
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones") });
    const db = runsDb(root);
    try {
      const other = db.createRun({ trigger: "schedule", human: false, argv: ["run", "--due"] });
      await acquire(db, "zones", other.id, { noWait: true });
      const out = await runIn(root, ["zones"], { noWait: true });
      expect(out.exit).toBe(4);
      expect(out.problems[0]).toMatchObject({ code: "ASSET_BUSY", runId: other.id, details: { heldBy: { runId: other.id, trigger: "schedule" } } });
      expect(out.data.steps[0]).toMatchObject({ status: "skipped" });
      expect(out.data.steps[0]!.skippedBecause).toContain(other.id);
      expect(out.next[0]!.command).toBe(`croft wait ${other.id} --timeout 100s`);
    } finally {
      db.close();
    }
  });

  test("no progress for the timeout fails the step with TIMEOUT", async () => {
    api.state.slowPages = 2;
    api.state.slowDelayMs = 400;
    const root = makeProject({ "assets/slow.ts": slowPages(api.url) });
    const out = await runIn(root, ["slow"], { timeoutMs: 150 });
    expect(out.exit).toBe(1);
    expect(out.data.steps[0]!.error).toMatchObject({ code: "TIMEOUT", details: { phase: "extract", rowsSoFar: 0 } });
  });

  test("an aborted signal interrupts the step: nothing is written, the run is interrupted, exit 130", async () => {
    api.state.slowPages = 50;
    api.state.slowDelayMs = 50;
    const root = makeProject({ "assets/slow.ts": slowPages(api.url) });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const out = await runIn(root, ["slow"], { signal: ac.signal });
    expect(out.exit).toBe(130);
    expect(out.data.status).toBe("interrupted");
    expect(out.data.steps[0]!.error?.code).toBe("INTERRUPTED");
    const db = runsDb(root);
    try {
      expect(db.getRun(out.data.runId)!.status).toBe("interrupted");
      expect(db.stepsFor(out.data.runId)[0]!.status).toBe("interrupted");
    } finally {
      db.close();
    }
    expect(existsSync(join(root, "warehouse.duckdb")) ? await rows(root, "select count(*)::INT n from duckdb_tables() where table_name = 'slow'") : [{ n: 0 }]).toEqual([{ n: 0 }]);
  });
});

describe("planning", () => {
  test("transforms are skipped with a note; a broken asset fails alone; unknown names are usage errors", async () => {
    api.state.zones = [{ zone: 1 }];
    const root = makeProject({
      "assets/zones.ts": simpleGet(api.url, "/zones"),
      "assets/report.sql": "select 1 as x",
      "assets/bad.ts": `export default 42;\n`,
    });
    const out = await runIn(root, []);
    expect(out.exit).toBe(2); // ASSET_INVALID is a project problem
    const by = Object.fromEntries(out.data.steps.map((s) => [s.asset, s]));
    expect(by.zones!.status).toBe("ok");
    expect(by.report).toMatchObject({ status: "skipped" });
    expect(by.report!.skippedBecause).toContain("ingests only");
    expect(by.bad!.status).toBe("failed");
    expect(by.bad!.error?.code).toBe("ASSET_INVALID");
    await expect(runIn(root, ["zonez"])).rejects.toMatchObject({ code: "USAGE_ERROR", problem: { hint: "did you mean zones?" } });
    await expect(runIn(root, ["nothing_*"])).rejects.toMatchObject({ code: "USAGE_ERROR" });
  });
});

describe("sources, JSON keys, --no-wait and staging", () => {
  test("rows() may return an array or a promise of rows, not only a generator", async () => {
    const root = makeProject({
      "assets/plain.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ key: "id", rows: () => [{ id: 1 }, { id: 2 }] });\n`,
      "assets/promised.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ key: "id", rows: async () => [{ id: 1 }, { id: 2 }, { id: 3 }] });\n`,
    });
    const out = await runIn(root, []);
    expect(out.exit).toBe(0);
    expect(out.data.steps.map((s) => [s.asset, s.rows.total])).toEqual([["plain", 2], ["promised", 3]]);
  });

  test("JSON columns of mixed kinds write fine, and their object keys reach the catalog", async () => {
    api.state.raw = JSON.stringify([
      { id: 1, meta: { b: 1, a: { deep: true } } }, { id: 2, meta: [1, 2] }, { id: 3, meta: "text" }, { id: 4, meta: 5 },
      { id: 5, meta: null }, { id: 6, meta: { c: null } },
    ]);
    const root = makeProject({ "assets/meta.ts": simpleGet(api.url, "/raw", '\n  key: "id",') });
    const out = await runIn(root, ["meta"]);
    expect(out.exit).toBe(0);
    const db = runsDb(root);
    try {
      expect(getCatalog(db, "meta")!.columns.find((c) => c.name === "meta")).toMatchObject({ type: "JSON", jsonKeys: ["a", "b", "c"] });
    } finally {
      db.close();
    }
  });

  test("--no-wait: a database held by another program is exit 4 at once, without retries", async () => {
    const { spawnHolder, cleanup } = await import("../read/testkit.ts");
    api.state.zones = [{ zone: 1 }];
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones") });
    const holder = spawnHolder(join(root, "warehouse.duckdb"), 30_000);
    try {
      await holder.waitFor("held");
      const t0 = Date.now();
      const out = await runIn(root, ["zones"], { noWait: true });
      expect(out.exit).toBe(4);
      expect(out.data.steps[0]).toMatchObject({ status: "failed", attempt: 1 });
      expect(out.data.steps[0]!.error!.code).toBe("DB_HELD_BY_OTHER_PROGRAM");
      expect(Date.now() - t0).toBeLessThan(5000);
    } finally {
      cleanup();
    }
  });

  test("staging of runs that ended more than 3 days ago is pruned; running and recent ones stay", async () => {
    const { mkdirSync, utimesSync } = await import("node:fs");
    const { pruneStaging } = await import("./runner.ts");
    const root = makeProject({});
    const state = join(root, ".croft");
    const db = runsDb(root);
    try {
      const old = db.createRun({ trigger: "manual", human: true, argv: ["run"] });
      db.finishRun(old.id, "failed");
      const live = db.createRun({ trigger: "manual", human: true, argv: ["run"] });
      for (const id of [old.id, live.id, "r_0101_0000_orph"]) mkdirSync(join(state, "staging", id, "a"), { recursive: true });
      const past = new Date(Date.now() - 4 * 86_400_000);
      utimesSync(join(state, "staging", "r_0101_0000_orph"), past, past);
      const later = Date.now() + 4 * 86_400_000;
      expect(pruneStaging(state, db).map((d) => d.split("/").at(-1))).toEqual(["r_0101_0000_orph"]);
      expect(pruneStaging(state, db, later).map((d) => d.split("/").at(-1))).toEqual([old.id]);
      expect(existsSync(join(state, "staging", live.id))).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("concurrency, events and approvals", () => {
  test("extractions overlap up to croft.json concurrency; with concurrency 1 they run one after another", async () => {
    api.state.slowPages = 3;
    api.state.slowDelayMs = 120;
    const files = { "assets/one.ts": slowPages(api.url), "assets/two.ts": slowPages(api.url) };
    const order = async (concurrency: number) => {
      const root = makeProject(files, { config: { concurrency } });
      const seen: string[] = [];
      const out = await runIn(root, [], { onEvent: (_line, e) => { if (e.type === "step") seen.push(`${String(e.asset)}:${String(e.status)}`); } });
      expect(out.exit).toBe(0);
      return seen;
    };
    expect((await order(2)).slice(0, 2).sort()).toEqual(["one:running", "two:running"]);
    expect(await order(1)).toEqual(["one:running", "one:ok", "two:running", "two:ok"]);
  });

  test("a retry is announced with nextRetryAt; HTTP_ERROR says how many rows came before it", async () => {
    api.state.failures = 100;
    const root = makeProject({ "assets/flaky.ts": `import { ingest } from "@zabaca/croft";
export default ingest({
  retries: 1,
  async *rows({ http }) {
    yield [{ id: 1 }, { id: 2 }];
    yield (await http.get("${api.url}/flaky")).json<Record<string, unknown>[]>();
  },
});
` });
    const events: Record<string, unknown>[] = [];
    const out = await runIn(root, ["flaky"], { onEvent: (_l, e) => events.push(e) });
    api.state.failures = 0;
    expect(out.exit).toBe(1);
    const retry = events.find((e) => e.type === "retry")!;
    expect(retry).toMatchObject({ asset: "flaky", attempt: 1, code: "HTTP_ERROR" });
    expect(Date.parse(String(retry.nextRetryAt))).toBeGreaterThan(0);
    const e = out.data.steps[0]!.error!;
    expect(e.code).toBe("HTTP_ERROR");
    expect(e.details).toMatchObject({ status: 500, rowsBeforeError: 2 });
    expect(out.data.steps[0]).toMatchObject({ attempt: 2, maxAttempts: 2 });
    expect(out.next).toContainEqual({ command: "croft run flaky", reason: "the error is temporary; run it again later" });
  });

  test("a successful human run records the code it ran (releases the scheduler hold)", async () => {
    api.state.zones = [{ zone: 1 }];
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones") });
    await runIn(root, ["zones"], { human: false });
    const db = runsDb(root);
    try {
      expect(db.sqlite.query("select approved_code_hash from schedule_state where asset = 'zones'").get()).toBeNull();
    } finally {
      db.close();
    }
    await runIn(root, ["zones"]);
    const db2 = runsDb(root);
    try {
      const row = db2.sqlite.query("select approved_code_hash h from schedule_state where asset = 'zones'").get() as { h: string };
      expect(row.h).toBe(getCatalog(db2, "zones")!.codeHash!);
    } finally {
      db2.close();
    }
  });

  test("secrets reach rows() only when declared, and never reach the step log or the stored summary", async () => {
    const root = makeProject({
      ".env": "API_TOKEN=supersecret-value-123\n",
      "assets/secretive.ts": `import { ingest } from "@zabaca/croft";
export default ingest({
  secrets: ["API_TOKEN"],
  async *rows({ secret, log }) {
    const t = secret("API_TOKEN");
    log("using", t);
    throw new Error("failed with token " + t);
  },
});
`,
    });
    const out = await runIn(root, ["secretive"]);
    expect(out.exit).toBe(1);
    expect(JSON.stringify(out)).not.toContain("supersecret-value-123");
    expect(out.data.steps[0]!.error!.message).toContain("[redacted:API_TOKEN]");
    const log = readFileSync(logPath(join(root, ".croft"), out.data.runId, "secretive"), "utf8");
    expect(log).toContain("using [redacted:API_TOKEN]");
    expect(log).not.toContain("supersecret");
    const db = runsDb(root);
    try {
      expect(JSON.stringify(db.getRun(out.data.runId)!.summary)).not.toContain("supersecret");
      expect(JSON.stringify(db.stepsFor(out.data.runId))).not.toContain("supersecret");
    } finally {
      db.close();
    }
    expect(readFileSync(join(root, ".croft", "logs", out.data.runId, "events.ndjson"), "utf8")).not.toContain("supersecret");
  });

  test("an ordinary .env value (MODE=replace) is not redacted out of statuses and behaviors", async () => {
    api.state.zones = [{ zone: 1 }];
    const root = makeProject({ ".env": "MODE=replace\nLEVEL=failed\n", "assets/zones.ts": simpleGet(api.url, "/zones") });
    const out = await runIn(root, ["zones"]);
    expect(out.data.steps[0]).toMatchObject({ status: "ok", behavior: "replace" });
    const db = runsDb(root);
    try {
      expect((db.getRun(out.data.runId)!.summary as { data: { steps: { behavior: string }[] } }).data.steps[0]!.behavior).toBe("replace");
    } finally {
      db.close();
    }
  });
});
