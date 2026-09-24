// The run engine in this process (executeRun), against a Bun.serve mock API: pagination, retries, the
// shrink guard, big integers, type drift, cursors, --from, ctx.query, the catalog mirror and leases.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { closeAllWarehouses } from "../db/warehouse.ts";
import { getCatalog } from "../history/catalog.ts";
import { acquire } from "../history/leases.ts";
import { logPath } from "../history/logs.ts";
import { RunsDb } from "../history/runs-db.ts";
import { loadProject } from "../project/root.ts";
import { listTrash } from "../safety/trash.ts";
import { planRun } from "./plan.ts";
import { withProjectChecks } from "./runner.ts";
import { cleanupProjects, cli, cliEnv, keysetIssues, linkItems, makeProject, mockApi, runIn, simpleGet, slowPages } from "./testkit.ts";

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
    // This step created the table (§4.2 "new table, 3 columns"); _loaded_at is croft's and not counted.
    expect(step.created).toEqual({ columns: 3, jsonColumns: 0 });
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
    expect(s.created).toBeUndefined();
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

  // §3a: a Retry-After longer than ctx.http waits inside a run fails the request with retryAfterMs "so the runner
  // can schedule the retry": the next attempt waits max(its own delay, retryAfterMs).
  test("the next attempt waits for the server's Retry-After, not only the fixed delay", async () => {
    api.state.limited = 1;
    api.state.retryAfter = "1";
    try {
      const root = makeProject({ "assets/limited.ts": simpleGet(api.url, "/limited") });
      const retries: Record<string, unknown>[] = [];
      const t0 = Date.now();
      const out = await runIn(root, ["limited"], {
        http: { retryBaseMs: 5, maxRetryAfterMs: 100 }, onEvent: (_l, e) => void (e.type === "retry" && retries.push(e)),
      });
      expect(out.exit).toBe(0);
      expect(out.data.steps[0]).toMatchObject({ status: "ok", attempt: 2 });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
      expect(retries).toHaveLength(1);
      const planned = Date.parse(String(retries[0]!.nextRetryAt)) - Date.parse(String(retries[0]!.at));
      expect(planned).toBeGreaterThanOrEqual(990);
      expect(planned).toBeLessThan(1500);
    } finally {
      api.state.retryAfter = "1";
      api.state.limited = 0;
    }
  });

  test("a Retry-After beyond what a run waits for ends the step now, with nextRetryAt when the server allows", async () => {
    api.state.limited = 5;
    api.state.retryAfter = "3600";
    try {
      const root = makeProject({ "assets/limited.ts": simpleGet(api.url, "/limited") });
      const t0 = Date.now();
      const out = await runIn(root, ["limited"]);
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(out.exit).toBe(1);
      const s = out.data.steps[0]!;
      expect(s).toMatchObject({ status: "failed", attempt: 1, maxAttempts: 3 });
      expect(s.error).toMatchObject({ code: "HTTP_ERROR", details: { status: 429, retryAfterMs: 3_600_000 } });
      const at = Date.parse(s.nextRetryAt!);
      expect(Math.abs(at - (Date.now() + 3_600_000))).toBeLessThan(10_000);
      expect(api.state.log.filter((l) => l.path === "/limited")).toHaveLength(1);
      expect(out.next).toContainEqual({ command: "croft run limited", reason: `the API asks to wait; run it again after ${s.nextRetryAt}` });
    } finally {
      api.state.retryAfter = "1";
      api.state.limited = 0;
    }
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

  // §6: `allowShrink: true` is the user's standing decision, made in code: a shrink needs no confirmation, but every
  // run says the guard is off (SHRINK_GUARD_DISABLED), and the current rows still go to the trash first.
  test("allowShrink: true in the asset shrinks without a confirmation, trashing first, and warns on every run", async () => {
    api.state.zones = zones;
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones", "\n  allowShrink: true,") });
    const first = await runIn(root, ["zones"]);
    expect(first.exit).toBe(0);
    const off = first.problems.filter((p) => p.code === "SHRINK_GUARD_DISABLED");
    expect(off).toHaveLength(1);
    expect(off[0]).toMatchObject({ severity: "warning", asset: "zones", file: "assets/zones.ts", line: 3, fix: { kind: "edit", line: 3 } });
    expect(first.data.steps[0]!.trashed).toBeUndefined();

    api.state.zones = zones.slice(0, 1);
    const shrunk = await runIn(root, ["zones"]);
    expect(shrunk.exit).toBe(0);
    expect(shrunk.confirmation).toBeUndefined();
    expect(shrunk.problems.map((p) => p.code)).not.toContain("SHRINK_GUARD");
    expect(shrunk.problems.map((p) => p.code)).not.toContain("CONFIRMATION_REQUIRED");
    const step = shrunk.data.steps[0]!;
    expect(step).toMatchObject({ status: "ok", attempt: 1, rows: { total: 1, deleted: 5 }, trashed: { rows: 6 } });
    const warned = shrunk.problems.filter((p) => p.code === "SHRINK_GUARD_DISABLED");
    expect(warned.map((p) => p.severity)).toEqual(["warning", "warning"]);
    const shrink = warned.find((p) => p.details?.rowsBefore !== undefined)!;
    expect(shrink.details).toMatchObject({ rowsBefore: 6, rowsAfter: 1, trashPath: step.trashed!.path });
    expect(shrink.message).toContain("the previous 6 rows went to the trash first");
    const trash = listTrash(join(root, ".croft"), "zones");
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatchObject({ asset: "zones", rows: 6, path: step.trashed!.path, reason: `allowShrink: true (${shrunk.data.runId})` });
    expect(await rows(root, "select count(*)::INT n from zones")).toEqual([{ n: 1 }]);
    const log = readFileSync(logPath(join(root, ".croft"), shrunk.data.runId, "zones"), "utf8");
    expect(log).toContain("allowShrink: true: moving the current 6 rows of zones to the trash first");
    // The trashed version holds the rows the shrink removed.
    const t = await DuckDBInstance.create(trash[0]!.path, { access_mode: "READ_ONLY" });
    const c = await t.connect();
    try {
      expect((await c.runAndReadAll("select count(*)::INT n from zones")).getRowObjectsJS()).toEqual([{ n: 6 }]);
    } finally {
      c.disconnectSync();
      t.closeSync();
    }

    // --allow-shrink on top of it asks nothing either: the code already says yes.
    api.state.zones = [];
    const flagged = await runIn(root, ["zones"], { allowShrink: true });
    expect(flagged.exit).toBe(0);
    expect(flagged.confirmation).toBeUndefined();
    expect(flagged.data.steps[0]!.trashed?.rows).toBe(1);
    expect(listTrash(join(root, ".croft"), "zones")).toHaveLength(2);
  });

  test("without allowShrink, and with allowShrink: false, the guard holds", async () => {
    api.state.zones = zones;
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones", "\n  allowShrink: false,") });
    const first = await runIn(root, ["zones"]);
    expect(first.problems.map((p) => p.code)).not.toContain("SHRINK_GUARD_DISABLED");
    api.state.zones = [];
    const out = await runIn(root, ["zones"]);
    expect(out.exit).toBe(1);
    expect(out.data.steps[0]!.error?.code).toBe("SHRINK_GUARD");
    expect(listTrash(join(root, ".croft"))).toEqual([]);
    expect(await rows(root, "select count(*)::INT n from zones")).toEqual([{ n: 6 }]);
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

  // A text cursor ("v0005") is compared as text: -90d, today or a date would reach rows() as the literal since
  // "-90d", a filter the API cannot use. They are refused before the run; a value in the cursor's own form is not.
  test("a string cursor refuses relative values and dates before the run, and passes a value in its own form as is", async () => {
    api.state.raw = `[{"id": 1, "ver": "v0005"}]`;
    const root = makeProject({ "assets/vers.ts": `import { ingest } from "@zabaca/croft";
export default ingest({
  key: "id",
  incremental: "ver",
  async *rows({ since, http }) {
    yield (await http.get("${api.url}/raw", { query: { since } })).json<Record<string, unknown>[]>();
  },
});
` });
    expect((await runIn(root, ["vers"])).exit).toBe(0);
    const recorded = () => {
      const db = runsDb(root);
      try {
        return db.listRuns().length;
      } finally {
        db.close();
      }
    };
    for (const from of ["-90d", "today", "2026-09-01"]) {
      const e = await runIn(root, ["vers"], { from }).catch((x: unknown) => x);
      expect(e).toMatchObject({ code: "CURSOR_TYPE_MISMATCH", exit: 2, problem: { asset: "vers", details: { from, saved: "v0005", field: "ver" } } });
      expect((e as { problem: { hint: string } }).problem.hint).toContain('"v0005"');
    }
    expect(recorded()).toBe(1);
    api.state.log.length = 0;
    const ok = await runIn(root, ["vers"], { from: "v0003" });
    expect(ok.exit).toBe(0);
    expect(api.state.log[0]!.query.since).toBe("v0003");
    expect(ok.data.steps[0]!.reason).toContain("since: v0003");
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
    // §8 + a backfill that cannot apply is refused before the run starts (exit 2): no run, no failed step.
    const runsBefore = () => {
      const db = runsDb(root);
      try {
        return { runs: db.listRuns().length, steps: (db.sqlite.query("select count(*) n from steps").get() as { n: number }).n };
      } finally {
        db.close();
      }
    };
    await expect(runIn(root, ["zones"], { from: "2026-01-01" })).rejects.toMatchObject({
      code: "BACKFILL_UNSUPPORTED", exit: 2, problem: { hint: expect.stringContaining("croft run zones") },
    });
    expect(runsBefore()).toEqual({ runs: 0, steps: 0 });
    // An append ingest with no saved position yet takes --from.
    expect((await runIn(root, ["events"], { from: "2026-01-01" })).exit).toBe(0);
    const recorded = runsBefore();
    // Once it has one, --from at or before it would store rows twice...
    await expect(runIn(root, ["events"], { from: "3" })).rejects.toMatchObject({ code: "BACKFILL_WOULD_DUPLICATE", exit: 2 });
    // ...and after it would skip the rows in between (or, keeping the position, store the later rows twice).
    const later = await runIn(root, ["events"], { from: "9" }).catch((e: unknown) => e);
    expect(later).toMatchObject({ code: "BACKFILL_WOULD_DUPLICATE", problem: { details: { since: 9, saved: "5" } } });
    expect((later as Error).message).toContain("after its saved position 5");
    expect(runsBefore()).toEqual(recorded);
  });

  test("a transform named with --from is BACKFILL_UNSUPPORTED before the run; in a bare run it is skipped", async () => {
    api.state.issues = [{ id: 1, title: "a", updated_at: "2026-09-01T10:00:00Z" }];
    api.state.zones = [{ zone: 1 }];
    const root = makeProject({ "assets/report.sql": "select 1 as x\n", "assets/issues.ts": keysetIssues(api.url), "assets/zones.ts": simpleGet(api.url, "/zones") });
    await expect(runIn(root, ["report"], { from: "-7d" })).rejects.toMatchObject({
      code: "BACKFILL_UNSUPPORTED", problem: { hint: "transforms are rebuilt from their inputs; there is nothing to backfill: croft run report" },
    });
    // A bare run (or a glob) runs --from where it applies and skips the rest; nothing fails.
    const bare = await runIn(root, [], { from: "-7d" });
    expect(bare.exit).toBe(0);
    expect(bare.data.steps.find((s) => s.asset === "report")).toMatchObject({ status: "skipped", skippedBecause: "--from applies to merge ingests" });
    expect(bare.data.steps.find((s) => s.asset === "zones")).toMatchObject({ status: "skipped", skippedBecause: "--from applies to merge ingests" });
    expect(bare.data.steps.find((s) => s.asset === "issues")).toMatchObject({ status: "ok" });
    expect(bare.problems.filter((p) => p.severity === "error")).toEqual([]);
  });

  // §8: a --from later than the saved cursor must not let the cursor jump over [saved, from): a merge ingest
  // keeps its saved position, so the next run fetches the rows in between instead of losing them.
  test("a --from after the saved cursor keeps the cursor, so the rows in between are fetched next time", async () => {
    api.state.issues = [
      { id: 1, title: "a", updated_at: "2026-09-01T12:00:00Z" },
      { id: 2, title: "b", updated_at: "2026-09-02T12:00:00Z" },
    ];
    const root = makeProject({ "assets/issues.ts": keysetIssues(api.url) });
    expect((await runIn(root, ["issues"])).exit).toBe(0);
    api.state.issues.push(
      { id: 3, title: "c", updated_at: "2026-09-03T12:00:00Z" },
      { id: 4, title: "d", updated_at: "2026-09-04T12:00:00Z" },
      { id: 6, title: "f", updated_at: "2026-09-06T12:00:00Z" },
    );
    const from = await runIn(root, ["issues"], { from: "2026-09-05" });
    expect(from.exit).toBe(0);
    const s = from.data.steps[0]!;
    expect(s.rows).toMatchObject({ added: 1, total: 3 });
    expect(s.cursor).toEqual({ before: "2026-09-02T12:00:00Z", after: "2026-09-02T12:00:00Z", sinceUsed: "2026-09-05T07:00:00Z" });
    expect(s.reason).toContain("the saved position stays at 2026-09-02T12:00:00Z");
    const db = runsDb(root);
    try {
      expect(getCatalog(db, "issues")!.cursor?.value).toBe("2026-09-02T12:00:00Z");
    } finally {
      db.close();
    }
    api.state.log.length = 0;
    const next = await runIn(root, ["issues"]);
    expect(api.state.log[0]!.query.since).toBe("2026-09-02T11:59:59Z");
    expect(next.data.steps[0]!.cursor?.after).toBe("2026-09-06T12:00:00Z");
    expect(await rows(root, "select id from issues order by id")).toEqual([1n, 2n, 3n, 4n, 6n].map((id) => ({ id })));
    // A --from at or before the saved cursor needs no hold: it re-reads a window the cursor already covers.
    const back = await runIn(root, ["issues"], { from: "2026-09-01" });
    expect(back.data.steps[0]!.cursor?.after).toBe("2026-09-06T12:00:00Z");
    expect(back.data.steps[0]!.reason).not.toContain("stays at");
  });

  test("off a TTY a --from that cannot apply is refused by the command itself; no run is recorded", async () => {
    api.state.raw = `[{"seq": 5, "what": "x"}]`;
    const root = makeProject({ "assets/events.ts": `import { ingest } from "@zabaca/croft";
export default ingest({
  write: "append",
  incremental: "seq",
  async *rows({ http }) { yield (await http.get("${api.url}/raw")).json<Record<string, unknown>[]>(); },
});
`, "assets/report.sql": "select 1 as x\n" });
    expect((await cli(root, ["run", "events", "--json"])).code).toBe(0);
    // Needs the saved cursor, so the detached child checks it before recording the run; the parent reports it.
    const dup = await cli(root, ["run", "events", "--from", "3", "--json"]);
    expect(dup.code).toBe(2);
    expect(dup.json!.problems[0]).toMatchObject({ code: "BACKFILL_WOULD_DUPLICATE", asset: "events" });
    // Needs only the plan: the parent refuses before starting a child.
    const tr = await cli(root, ["run", "report", "--from=-7d", "--json"]);
    expect(tr.code).toBe(2);
    expect(tr.json!.problems[0]).toMatchObject({ code: "BACKFILL_UNSUPPORTED", asset: "report" });
    const db = runsDb(root);
    try {
      expect(db.listRuns()).toHaveLength(1);
      expect(db.listRuns({ failed: true })).toHaveLength(0);
    } finally {
      db.close();
    }
  }, 60_000);
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

  test("while a run works, runs.summary carries its progress (status and context read it); then its result", async () => {
    api.state.slowPages = 6;
    api.state.slowDelayMs = 150;
    const root = makeProject({ "assets/slow.ts": slowPages(api.url) });
    const running = runIn(root, ["slow"]);
    const db = runsDb(root);
    try {
      let progress: Record<string, unknown> | undefined;
      for (let i = 0; i < 200 && !progress; i++) {
        const r = db.runningRuns()[0];
        progress = (r?.summary as { progress?: Record<string, unknown> } | null)?.progress;
        if (!progress) await new Promise((res) => setTimeout(res, 20));
      }
      expect(progress).toMatchObject({ asset: "slow", phase: "extract" });
      const out = await running;
      expect(out.exit).toBe(0);
      expect((db.getRun(out.data.runId)!.summary as { data: { status: string } }).data.status).toBe("succeeded");
    } finally {
      db.close();
    }
  });

  // §4.3 status.running[] {phase, rowsFetched}: rows fetched inside a throttle window reach runs.summary at its
  // end, so a run that fetched pages for less than a second does not show rowsFetched 0 all along.
  test("runs.summary.progress counts the rows fetched so far while the step extracts", async () => {
    api.state.slowPages = 6;
    api.state.slowDelayMs = 150;
    const root = makeProject({ "assets/slow.ts": slowPages(api.url) });
    let done = false;
    const running = runIn(root, ["slow"]).finally(() => {
      done = true;
    });
    const db = runsDb(root);
    try {
      let seen: Record<string, unknown> | undefined;
      while (!done && !seen) {
        const p = (db.runningRuns()[0]?.summary as { progress?: Record<string, unknown> } | null)?.progress;
        if (p?.phase === "extract" && Number(p.rowsFetched) > 0) seen = p;
        else await new Promise((res) => setTimeout(res, 20));
      }
      expect(seen).toMatchObject({ asset: "slow", phase: "extract" });
      expect(Object.keys(seen!).sort()).toEqual(["asset", "elapsedMs", "phase", "requests", "rowsFetched"]);
      expect((await running).exit).toBe(0);
    } finally {
      db.close();
    }
  });

  // croft's own progress output is not asset output: --events lines emitted while rows() runs (inside the step's
  // console capture) still reach stderr, and never the step log.
  test("--events progress during extraction reaches stderr, not the step log", async () => {
    api.state.slowPages = 4;
    api.state.slowDelayMs = 200;
    const root = makeProject({ "assets/slow.ts": slowPages(api.url) });
    const r = await cli(root, ["run", "slow", "--foreground", "--json", "--events"]);
    expect(r.code).toBe(0);
    const events = r.stderr.trim().split("\n").map((l) => JSON.parse(l) as { type: string; phase?: string });
    expect(events.some((e) => e.type === "progress" && e.phase === "extract")).toBe(true);
    const log = readFileSync(logPath(join(root, ".croft"), r.json!.data.runId, "slow"), "utf8");
    expect(log).not.toContain(`"type":"progress"`);
    expect(log).toContain("page 4");
  }, 30_000);

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

describe("a lock wait and Ctrl-C", () => {
  test("SIGINT while the warehouse is held by another program interrupts the wait at once (exit 130)", async () => {
    api.state.zones = [{ zone: 1 }];
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones") });
    expect((await runIn(root, ["zones"])).exit).toBe(0);
    await closeAllWarehouses();
    // Another program (think DuckDB UI) holds the file read-write; off a TTY a run would wait 90 s for it.
    const holder = spawn(process.execPath, ["-e", `const { DuckDBInstance } = require(process.env.DUCKDB_API);
(async () => { const db = await DuckDBInstance.create(process.env.DB_PATH); await db.connect(); console.log("held"); setInterval(() => {}, 1000); })();`], {
      env: { ...process.env, DUCKDB_API: require.resolve("@duckdb/node-api"), DB_PATH: join(root, "warehouse.duckdb") },
      stdio: ["ignore", "pipe", "inherit"],
    });
    try {
      await new Promise<void>((resolve) => holder.stdout!.on("data", (d) => String(d).includes("held") && resolve()));
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 300);
      const started = Date.now();
      const out = await runIn(root, ["zones"], { signal: ac.signal });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(out.exit).toBe(130);
      expect(out.data.status).toBe("interrupted");
      expect(out.data.steps[0]!.error?.code).toBe("INTERRUPTED");
    } finally {
      holder.kill("SIGKILL");
    }
  });
});

describe("planning", () => {
  test("a SQL transform runs after its input; a broken asset fails alone; unknown names are usage errors", async () => {
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
    expect(by.report).toMatchObject({ status: "ok" });
    expect(out.data.steps.findIndex((s) => s.asset === "report")).toBeGreaterThan(-1);
    expect(by.bad!.status).toBe("failed");
    expect(by.bad!.error?.code).toBe("ASSET_INVALID");
    await expect(runIn(root, ["zonez"])).rejects.toMatchObject({ code: "USAGE_ERROR", problem: { hint: "did you mean zones?" } });
    await expect(runIn(root, ["nothing_*"])).rejects.toMatchObject({ code: "USAGE_ERROR" });
  });

  test("a named asset whose input was never built is skipped, and the run says so with the run that builds it", async () => {
    api.state.zones = [{ zone: 1 }];
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones"), "assets/report.sql": "-- key: zone\nselect zone from zones\n" });
    const out = await runIn(root, ["report"]);
    expect(out.data.steps).toMatchObject([{ asset: "report", status: "skipped" }]);
    expect(out.problems).toMatchObject([{ code: "INPUT_NOT_BUILT", severity: "warning", asset: "report", fix: { kind: "command", command: "croft run zones" } }]);
    expect(out.next[0]).toEqual({ command: "croft run zones", reason: "build zones first: report reads it, and it has never been built" });
    expect(out.exit).toBe(0);
  });
});

describe("a TS transform's inputs that name no asset", () => {
  test("fail its step before the code runs, with UNKNOWN_TABLE and a did-you-mean edit; nothing names croft run of the typo", async () => {
    const root = makeProject({
      "assets/issues.sql": "-- key: id\nSELECT i AS id FROM range(1, 4) t(i)\n",
      "assets/typo.ts": `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["issuez"], key: "id",
  async *rows({ rows }) {
    console.log("the code ran");
    for await (const r of rows<{ id: number }>("issuez")) yield { id: r.id };
  },
});
`,
    });
    expect((await runIn(root, ["issues"], { only: true })).exit).toBe(0);
    const out = await runIn(root, ["typo"]);
    const step = out.data.steps.find((s) => s.asset === "typo")!;
    expect(step).toMatchObject({ status: "failed", attempt: 1, maxAttempts: 1 });
    expect(step.error).toMatchObject({
      code: "UNKNOWN_TABLE", asset: "typo", file: "assets/typo.ts", line: 3,
      fix: { kind: "edit", file: "assets/typo.ts", line: 3, replace: { from: "issuez", to: "issues" } },
      details: { table: "issuez", suggestion: "issues" },
    });
    expect(step.error!.message).toContain("issuez");
    expect(step.error!.hint).toContain("did you mean issues?");
    expect(out.exit).toBe(2);
    expect(JSON.stringify(out)).not.toContain("croft run issuez");
    // The step failed before its code ran: nothing reached its log.
    const log = logPath(join(root, ".croft"), out.data.runId, "typo");
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").not.toContain("the code ran");
    const db = runsDb(root);
    try {
      expect(db.stepsFor(out.data.runId).find((s) => s.asset === "typo")).toMatchObject({ status: "failed" });
    } finally {
      db.close();
    }
  });

  test("withProjectChecks reports each unknown input once, also on a plan that already has it", async () => {
    const root = makeProject({
      "assets/issues.sql": "-- key: id\nSELECT 1 AS id\n",
      "assets/typo.ts": `import { transform } from "@zabaca/croft";\nexport default transform({ inputs: ["issuez", "issues"], key: "id", async *rows() {} });\n`,
    });
    const project = loadProject({ root });
    // issues is built in the same run, so typo is planned (an input never built and not built by the run skips it).
    const plan = await planRun({ root, timezone: project.timezone, selectors: ["issues", "typo"] });
    const typo = (p: typeof plan) => p.steps.find((x) => x.asset === "typo")!;
    expect(typo(plan).problems.map((p) => p.code)).not.toContain("UNKNOWN_TABLE");
    const once = await withProjectChecks(plan, project);
    const twice = await withProjectChecks(once, project);
    for (const p of [once, twice]) {
      expect(typo(p).problems.filter((x) => x.code === "UNKNOWN_TABLE").map((x) => x.details?.table)).toEqual(["issuez"]);
    }
  });
});

describe("file ingests through the engine", () => {
  test("files outside files/ load from their snapshots; the warehouse sandbox never opens their folders", async () => {
    const root = makeProject({
      "exports/2026-01.csv": "order_id,amount\n1,5\n2,7\n",
      "top.csv": "id\n9\n",
      "assets/sales.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ file: "exports/*.csv", key: "order_id", incremental: true });\n`,
      "assets/top.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ file: "*.csv" });\n`,
    });
    const out = await runIn(root, ["sales", "top"]);
    expect(out.exit).toBe(0);
    expect(out.data.steps.map((s) => [s.asset, s.status, s.rows.total])).toEqual([["sales", "ok", 2], ["top", "ok", 1]]);
    expect(await rows(root, "select sum(amount)::INT AS total from sales")).toEqual([{ total: 12 }]);
    // Nothing changed: the next run skips the write.
    expect((await runIn(root, ["sales"])).data.steps[0]!.status).toBe("unchanged");
  });

  // §3b: rows of a deleted file are kept "and status says '1 file gone'". status reads the catalog mirror, so an
  // unchanged step (the only change was the deletion) must still record which files are gone.
  test("a deletion alone leaves the step unchanged, and the catalog mirror lists the gone file", async () => {
    const root = makeProject({
      "files/sales/a.csv": "order_id,amount\n1,5\n",
      "files/sales/b.csv": "order_id,amount\n2,7\n",
      "assets/sales.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ file: "files/sales/*.csv", key: "order_id", incremental: true });\n`,
    });
    expect((await runIn(root, ["sales"])).exit).toBe(0);
    rmSync(join(root, "files/sales/b.csv"));
    const gone = await runIn(root, ["sales"]);
    expect(gone.data.steps[0]).toMatchObject({ status: "unchanged", rows: { total: 2 } });
    const db = runsDb(root);
    try {
      expect(getCatalog(db, "sales")).toMatchObject({ rows: 2, filesGone: ["files/sales/b.csv"] });
      // The file comes back unchanged: nothing is gone any more.
      writeFileSync(join(root, "files/sales/b.csv"), "order_id,amount\n2,7\n");
      expect((await runIn(root, ["sales"])).data.steps[0]!.status).toBe("unchanged");
      expect(getCatalog(db, "sales")!.filesGone).toBeUndefined();
    } finally {
      db.close();
    }
  });

  // §3b: CSV_HEADER_AMBIGUOUS is a first-load error. Once the asset has loaded, its stored columns settle the header
  // question, so a day with no orders (an export holding only the header line) is an empty file, not a failure.
  test("after the first load a header-only CSV is an empty file, and later all-text files reuse the header decision", async () => {
    const root = makeProject({
      "files/sales/2026-09-01.csv": "order_id,amount,customer\nA1,10,ann\nA2,20,bob\n",
      "assets/sales.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ file: "files/sales/*.csv", incremental: true, key: "order_id" });\n`,
    });
    const first = await runIn(root, ["sales"]);
    expect(first.exit).toBe(0);
    expect(first.data.steps[0]!.csvHeader).toMatchObject({ header: true, from: "sniffed" });

    writeFileSync(join(root, "files/sales/2026-09-02.csv"), "order_id,amount,customer\n");
    const empty = await runIn(root, ["sales"]);
    expect(empty.problems.filter((p) => p.severity === "error")).toEqual([]);
    expect(empty.exit).toBe(0);
    expect(empty.data.steps[0]).toMatchObject({ status: "ok", rows: { in: 0, added: 0, total: 2 } });
    // Recorded like any loaded file: the next run has nothing to do.
    expect((await runIn(root, ["sales"])).data.steps[0]!.status).toBe("unchanged");

    // Every column of this export reads as text and its first line is not all known names (a new column):
    // the stored decision (a header line) holds, and the new column arrives.
    writeFileSync(join(root, "files/sales/2026-09-03.csv"), "order_id,customer,note\nA3,cat,gift\n");
    const later = await runIn(root, ["sales"]);
    expect(later.problems.filter((p) => p.severity === "error")).toEqual([]);
    expect(later.data.steps[0]).toMatchObject({ status: "ok", rows: { added: 1, total: 3 } });
    expect(await rows(root, "select order_id, customer, note from sales order by order_id")).toEqual([
      { order_id: "A1", customer: "ann", note: null }, { order_id: "A2", customer: "bob", note: null }, { order_id: "A3", customer: "cat", note: "gift" },
    ]);
  });

  test("the first load of a header-only or all-text CSV is still CSV_HEADER_AMBIGUOUS", async () => {
    const root = makeProject({
      "files/names.csv": "name,city\n",
      "assets/names.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ file: "files/*.csv" });\n`,
    });
    const out = await runIn(root, ["names"]);
    expect(out.exit).toBe(1);
    expect(out.data.steps[0]!.error?.code).toBe("CSV_HEADER_AMBIGUOUS");
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
    expect(out.data.steps[0]!.created).toEqual({ columns: 2, jsonColumns: 1 });
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

describe("fairness and empty projects", () => {
  test("a writer yields 200 ms before its write when another process waits for the file", async () => {
    api.state.zones = [{ zone: 1 }];
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones") });
    const db = runsDb(root);
    try {
      db.registerWaiter("croft query", process.ppid); // a live process that is not this one
    } finally {
      db.close();
    }
    const out = await runIn(root, ["zones"]);
    expect(out.exit).toBe(0);
    expect(out.data.steps[0]!.durationMs).toBeGreaterThanOrEqual(190);
  });

  test("a project without assets runs nothing and points at the templates", async () => {
    const root = makeProject({});
    const out = await runIn(root, []);
    expect(out).toMatchObject({ exit: 0, data: { status: "succeeded", steps: [] }, next: [{ command: "croft docs ingest" }] });
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

  test("every asset's declared secrets are hidden in a run's data, not only those of the steps it runs", async () => {
    const root = makeProject({
      ".env": "SHOP_PASSWORD=Swordfish\nVAULT_KEY=Opensesame\n",
      // A config endpoint that echoes the connection settings, the password included.
      "assets/shop_config.ts": `import { ingest } from "@zabaca/croft";
export default ingest({
  secrets: ["SHOP_PASSWORD"], key: "id",
  async *rows({ secret }) { yield [{ id: 1, host: "db.example.com", password: secret("SHOP_PASSWORD") }]; },
});
`,
      // Unrelated to shop_hosts: a run of shop_hosts does not even import it, and its secret still counts.
      "assets/vault.ts": `import { ingest } from "@zabaca/croft";
export default ingest({ secrets: ["VAULT_KEY"], key: "id", async *rows({ secret }) { yield [{ id: 1, ok: secret("VAULT_KEY").length > 0 }]; } });
`,
      "assets/shop_hosts.sql": "-- key: id\n-- check: password IS NULL\nSELECT id, host, password, 'Opensesame' AS note FROM shop_config\n",
    });
    expect((await runIn(root, ["shop_config"], { only: true })).exit).toBe(0);
    const out = await runIn(root, ["shop_hosts"]);
    const step = out.data.steps.find((s) => s.asset === "shop_hosts")!;
    expect(step.error?.code).toBe("CHECK_FAILED");
    // Both values are all letters: only a declaration gets them redacted in data.
    const samples = JSON.stringify(step.checks);
    expect(samples).toContain("[redacted:SHOP_PASSWORD]");
    expect(samples).toContain("[redacted:VAULT_KEY]");
    expect(JSON.stringify(out)).not.toMatch(/Swordfish|Opensesame/);
    const db = runsDb(root);
    try {
      expect(JSON.stringify(db.getRun(out.data.runId)!.summary)).not.toMatch(/Swordfish|Opensesame/);
      expect(JSON.stringify(db.stepsFor(out.data.runId))).not.toMatch(/Swordfish|Opensesame/);
    } finally {
      db.close();
    }
    expect(readFileSync(join(root, ".croft", "logs", out.data.runId, "events.ndjson"), "utf8")).not.toMatch(/Swordfish|Opensesame/);
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

describe("the project clock", () => {
  // runs.sqlite follows the project clock (CROFT_NOW in tests), like run ids, _loaded_at and the scheduler's fires, so
  // a run by hand at 11:05 counts as having handled the 11:00 fire.
  test("a run and its steps are stamped with the runner's clock", async () => {
    api.state.zones = [{ zone: 1 }];
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones") });
    const at = new Date("2031-05-06T07:08:09.000Z");
    const out = await runIn(root, ["zones"], { now: () => at });
    expect(out.exit).toBe(0);
    const db = runsDb(root);
    try {
      expect(db.getRun(out.data.runId)).toMatchObject({ startedAt: at.toISOString(), finishedAt: at.toISOString() });
      expect(db.stepsFor(out.data.runId)).toMatchObject([{ asset: "zones", startedAt: at.toISOString(), finishedAt: at.toISOString() }]);
    } finally {
      db.close();
    }
  });

  test("a failed run's staging is kept 3 days on the clock that stamped it", async () => {
    const { mkdirSync } = await import("node:fs");
    const { pruneStaging } = await import("./runner.ts");
    const root = makeProject({});
    const state = join(root, ".croft");
    // CROFT_NOW ten days back: the run ended just now on its own clock.
    const db = RunsDb.open(state, { now: () => new Date(Date.now() - 10 * 86_400_000) });
    try {
      const run = db.createRun({ trigger: "manual", human: true, argv: ["run"] });
      db.finishRun(run.id, "failed");
      mkdirSync(join(state, "staging", run.id, "a"), { recursive: true });
      expect(pruneStaging(state, db)).toEqual([]);
      expect(pruneStaging(state, db, Date.now() + 4 * 86_400_000).map((d) => d.split("/").at(-1))).toEqual([run.id]);
    } finally {
      db.close();
    }
  });

  test("croft run under CROFT_NOW stamps runs.sqlite with it, detached or not", async () => {
    api.state.zones = [{ zone: 1 }];
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones") });
    const at = "2031-05-06T07:08:09.000Z";
    for (const mode of [["--foreground"], []]) {
      const r = await cli(root, ["run", "zones", ...mode, "--json"], cliEnv({ CROFT_NOW: at }));
      expect(r.code, r.stderr).toBe(0);
      const db = runsDb(root);
      try {
        expect(db.getRun(r.json!.data.runId)).toMatchObject({ startedAt: at, finishedAt: at });
        expect(db.stepsFor(r.json!.data.runId)).toMatchObject([{ startedAt: at }]);
      } finally {
        db.close();
      }
    }
  });
});
