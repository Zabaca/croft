// Journey 27: an ingest that grows and changes shape without refetching or losing data (DESIGN.md §6 "Behavior
// changes", "Pin changes", "Destructive operations need confirmation"; §8 "Large first loads"; §3a EMPTY_EXTRACT).
//   a. a merge ingest whose key changes: INGEST_CONFIG_CHANGED before anything is fetched, with revert and --rebuild
//      as the ways forward (the rebuild a human's decision, never a command to run); reverting runs as before;
//   b. an append ingest that gains a key: croft run asks (convert_key); croft confirm trashes the table, keeps the
//      latest row of each key, then fetches as a merge;
//   c. a lossy pin (VARCHAR zip codes pinned BIGINT): PIN_CHANGES_DATA with samples in the preview, a token, and
//      after croft confirm the table in the trash and the column retyped as the samples showed (c2, a reported bug:
//      the run that asks does not show the samples);
//   d. a long first load of a cursor ingest killed (CROFT_FAULT) right after its first partial commit: the committed
//      part stays with its cursor, and the next run asks the API for what comes after it;
//   e. EMPTY_EXTRACT: an ingest with a lookback gets [] although its window held rows: a warning, nothing removed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupAll, codes, destructiveNext, type Envelope, findProblem, initProject, json, type MockApi, mockApi, type Project, show, stepOf,
  trashVersions,
} from "./harness.ts";

let api: MockApi;
beforeAll(() => {
  api = mockApi();
});
afterAll(async () => {
  api.stop();
  await cleanupAll();
});

type Row = Record<string, unknown>;

/** An ingest of the mock route `url` (which filters by since), with `config` lines. */
const ingestOf = (url: string, config: string) => `import { ingest } from "@zabaca/croft";

export default ingest({
  description: "Rows from the mock API",
${config}
  async *rows({ since, http }) {
    yield (await http.get("${url}", { query: { since } })).json<Record<string, unknown>[]>();
  },
});
`;

interface Source { p: Project; state: { rows: Row[]; empty: boolean }; path: string; url: string }

/** A project with one ingest `name` of rows ascending by `field` (after since, as an event log's API filters), under
 *  `prefix`. */
async function source(prefix: string, name: string, field: string, rows: Row[], config: string): Promise<Source> {
  const state = { rows, empty: false };
  const path = `${prefix}/${name}`;
  api.route(path, (_req, url) => {
    if (state.empty) return json([]);
    const since = url.searchParams.get("since");
    return json(state.rows.filter((r) => !since || String(r[field]) > since));
  });
  const { project: p } = await initProject();
  p.remove("assets/example_sales.ts");
  const url = `${api.url}${path}`;
  p.write(`assets/${name}.ts`, ingestOf(url, config));
  return { p, state, path, url };
}

const at = (s: number) => `2026-09-20T10:00:${String(s).padStart(2, "0")}Z`;

/** People with zip codes stored as text ("abc", then "02134" and "12345"), whose code now pins zip BIGINT: two stored
 *  values would change. The newest row (fetched again at the cursor's edge) casts exactly. */
async function pinned(prefix: string): Promise<Source> {
  const s = await source(prefix, "people", "at", [
    { id: 1, at: at(1), zip: "abc" }, { id: 2, at: at(2), zip: "02134" }, { id: 3, at: at(3), zip: "12345" },
  ], `  key: "id",\n  incremental: "at",`);
  const first = await s.p.json(["run", "people"]);
  expect(first.code, show(first)).toBe(0);
  s.p.write("assets/people.ts", ingestOf(s.url, `  key: "id",\n  incremental: "at",\n  columns: { zip: "BIGINT" },`));
  return s;
}

describe("journey 27: behavior and pin changes, partial commits, EMPTY_EXTRACT", () => {
  test("a. a merge ingest's key changes: INGEST_CONFIG_CHANGED before fetching; revert and it runs", async () => {
    const rows = [1, 2, 3].map((id) => ({ id, code: `C${id}`, at: at(id) }));
    const { p, path, url } = await source("/a", "events", "at", rows, `  key: "id",\n  incremental: "at",`);
    expect((await p.json(["run", "events"])).code).toBe(0);

    p.write("assets/events.ts", ingestOf(url, `  key: "code",\n  incremental: "at",`));
    const before = api.requests(path).length;
    const r = await p.json(["run", "events"]);
    expect(r.code, show(r)).toBe(1);
    expect(api.requests(path).length).toBe(before);             // nothing fetched
    const e = findProblem(r.json, "INGEST_CONFIG_CHANGED");
    expect(e, show(r)).toBeDefined();
    expect(e!.message).toContain("key: id → code");
    expect(e!.effect).toBe("nothing was fetched or written");
    expect(e!.hint).toContain("croft run events --rebuild");
    expect(e!.fix).toMatchObject({ kind: "edit", file: "assets/events.ts" });
    const fixes = e!.details.fixes as Envelope[];
    expect(fixes.find((f) => f.kind === "manual" && f.description.includes("croft run events --rebuild"))).toMatchObject({ requiresHuman: true });
    expect(e!.details).toMatchObject({ changed: ["key"], rows: 3, convertible: false });
    expect(destructiveNext(r.json)).toEqual([]);
    expect(r.json.confirmation).toBeUndefined();
    expect(await p.rows("select count(*)::INT AS n from events")).toEqual([{ n: 3 }]);
    const docs = await p.json(["docs", "INGEST_CONFIG_CHANGED"]);
    expect(docs.json.data).toMatchObject({ source: "file" });

    // Reverted: it runs as before.
    p.write("assets/events.ts", ingestOf(url, `  key: "id",\n  incremental: "at",`));
    const ok = await p.json(["run", "events"]);
    expect(ok.code, show(ok)).toBe(0);
    expect(codes(ok.json)).not.toContain("INGEST_CONFIG_CHANGED");
  }, 180_000);

  test("b. an append ingest gains a key: a convert_key token; croft confirm dedupes in place, the old table in the trash", async () => {
    const { p, state, path, url } = await source("/b", "events", "at", [
      { id: 1, at: at(1), v: "a" }, { id: 2, at: at(2), v: "b" },
    ], `  write: "append",\n  incremental: "at",`);
    p.write("assets/event_count.sql", "-- description: events per id\nSELECT id, count(*) AS n FROM events GROUP BY id\n");
    expect((await p.json(["run"])).code).toBe(0);
    // id 1 changes: an append log stores it again.
    state.rows.push({ id: 1, at: at(3), v: "a2" }, { id: 3, at: at(4), v: "c" });
    expect((await p.json(["run"])).code).toBe(0);
    expect(await p.rows("select count(*)::INT AS n from events")).toEqual([{ n: 4 }]);

    // The key is added (write: "append" goes, so it merges by id).
    p.write("assets/events.ts", ingestOf(url, `  key: "id",\n  incremental: "at",`));
    const before = api.requests(path).length;
    const asked = await p.json(["run", "events"]);
    expect(asked.code, show(asked)).toBe(5);
    expect(api.requests(path).length).toBe(before);
    const c = asked.json.confirmation;
    expect(c).toMatchObject({ command: "croft run events", impact: { asset: "events", rows: 1, downstream: ["event_count"] } });
    expect(c.token).toMatch(/^c_[0-9a-f]{6}$/);
    const needs = findProblem(asked.json, "CONFIRMATION_REQUIRED");
    expect(needs?.fix).toMatchObject({ kind: "manual", requiresHuman: true });
    expect(needs?.hint ?? "").toContain(`croft confirm ${c.token}`);
    expect(stepOf(asked.json, "events")).toMatchObject({ status: "skipped", reason: "needs confirmation" });
    expect(destructiveNext(asked.json)).toEqual([]);
    expect(await p.rows("select count(*)::INT AS n from events")).toEqual([{ n: 4 }]);
    expect(trashVersions(p, "events")).toEqual([]);

    const done = await p.json(["confirm", c.token]);
    expect(done.code, show(done)).toBe(0);
    expect(done.json.data.outcome).toBe("used");
    const s = stepOf(done.json, "events");
    expect(s).toMatchObject({ status: "ok", trashed: { rows: 4 }, rows: { total: 3 } });
    expect(s.reason).toContain("converted in place");
    expect(await p.rows("select id::INT AS id, v from events order by id")).toEqual([{ id: 1, v: "a2" }, { id: 2, v: "b" }, { id: 3, v: "c" }]);
    expect(trashVersions(p, "events")).toHaveLength(1);
    expect(stepOf(done.json, "event_count")).toMatchObject({ status: "ok" });
    const d = await p.json(["describe", "events"]);
    expect(d.json.data.behavior).toMatchObject({ write: "merge", key: ["id"] });

    // From now on it merges by id: a changed row replaces its old one.
    state.rows.push({ id: 2, at: at(5), v: "b2" });
    expect((await p.json(["run", "events"])).code).toBe(0);
    expect(await p.rows("select id::INT AS id, v from events order by id")).toEqual([{ id: 1, v: "a2" }, { id: 2, v: "b2" }, { id: 3, v: "c" }]);
  }, 180_000);

  test("c. a lossy pin: PIN_CHANGES_DATA with samples in the preview, a token; confirm trashes the table and retypes the column", async () => {
    const { p } = await pinned("/c");
    const zips = async () => (await p.rows("select zip from people order by id")).map((r) => r.zip);

    // The preview retypes its own copy, and shows which stored values change and what they become.
    const preview = await p.json(["preview", "people"]);
    expect(preview.code, show(preview)).toBe(0);
    const shown = findProblem(preview.json, "PIN_CHANGES_DATA");
    expect(shown, show(preview)).toMatchObject({ severity: "warning", asset: "people", details: { column: "zip", from: "VARCHAR", to: "BIGINT", changed: 2 } });
    expect(shown!.details.samples).toEqual(expect.arrayContaining([{ value: "abc", becomes: null }, { value: "02134", becomes: "2134" }]));
    expect(shown!.message).toContain("a real run asks for confirmation first");
    expect(await zips()).toEqual(["abc", "02134", "12345"]);

    // The run asks before fetching anything: a token for `croft run people`, the impact in values that change.
    const asked = await p.json(["run", "people"]);
    expect(asked.code, show(asked)).toBe(5);
    const c = asked.json.confirmation;
    expect(c).toMatchObject({ command: "croft run people", impact: { asset: "people", action: "pin change: zip VARCHAR → BIGINT", rows: 2 } });
    expect(findProblem(asked.json, "CONFIRMATION_REQUIRED")).toMatchObject({ fix: { kind: "manual", requiresHuman: true } });
    expect(stepOf(asked.json, "people").skippedBecause).toContain("2 stored values change");
    expect(destructiveNext(asked.json)).toEqual([]);
    expect(await zips()).toEqual(["abc", "02134", "12345"]);

    const done = await p.json(["confirm", c.token]);
    expect(done.code, show(done)).toBe(0);
    expect(done.json.data.outcome).toBe("used");
    const s = stepOf(done.json, "people");
    expect(s).toMatchObject({ status: "ok", trashed: { rows: 3 } });
    expect(s.schemaChanges).toContainEqual({ kind: "widen", column: "zip", from: "VARCHAR", to: "BIGINT" });
    const applied = findProblem(done.json, "PIN_CHANGES_DATA");
    expect(applied, show(done)).toMatchObject({ severity: "warning", details: { changed: 2 } });
    expect(applied!.hint).toContain("croft restore people");
    expect(await p.rows("select id::INT AS id, zip, typeof(zip) AS t from people order by id")).toEqual([
      { id: 1, zip: null, t: "BIGINT" }, { id: 2, zip: 2134, t: "BIGINT" }, { id: 3, zip: 12345, t: "BIGINT" },
    ]);
    expect(trashVersions(p, "people")).toHaveLength(1);
    const list = await p.json(["restore"]);
    expect(list.json.data.versions).toEqual([expect.objectContaining({ asset: "people", kind: "table", rows: 3 })]);
  }, 180_000);

  // §6: a lossy pin "raises PIN_CHANGES_DATA, with samples, and needs confirmation". The run's envelope carries only
  // CONFIRMATION_REQUIRED ("2 stored values change"): the samples the user should see before saying yes are not in it
  // (load/config-change.ts pendingOutcome drops the PIN_CHANGES_DATA problem the confirmation was asked with).
  test("c2. the run that asks for a pin change shows PIN_CHANGES_DATA with its samples", async () => {
    const { p } = await pinned("/c2");
    const asked = await p.json(["run", "people"]);
    expect(asked.code, show(asked)).toBe(5);
    const shown = findProblem(asked.json, "PIN_CHANGES_DATA");
    expect(shown, show(asked)).toBeDefined();
    expect(shown!.details.samples).toEqual(expect.arrayContaining([{ value: "abc", becomes: null }, { value: "02134", becomes: "2134" }]));
    expect(shown!.message).toContain(`"02134" → 2134`);
  }, 120_000);

  test("d. a long first load killed after a partial commit resumes from the committed cursor", async () => {
    // 60,000 events ascending by seq, 10,000 a page: the first part commits at 50,000 rows (§8: every 50k rows).
    const total = 60_000;
    const per = 10_000;
    const path = "/d/events";
    api.route(path, (_req, url) => {
      // seq runs 1..total; since is inclusive; numbered pages of `per`.
      const since = Math.max(1, Number(url.searchParams.get("since") ?? 1));
      const page = Number(url.searchParams.get("page") ?? 1);
      const first = since + (page - 1) * per;
      const n = Math.max(0, Math.min(per, total - first + 1));
      return json(Array.from({ length: n }, (_, i) => ({ id: first + i, seq: first + i, kind: (first + i) % 3 ? "view" : "click" })));
    });
    const { project: p } = await initProject();
    p.remove("assets/example_sales.ts");
    p.write("assets/events.ts", `import { ingest } from "@zabaca/croft";

type Event = { id: number; seq: number };

export default ingest({
  description: "The event log, oldest first",
  key: "id",
  incremental: "seq",
  async *rows({ since, http }) {
    for (let page = 1; ; page++) {
      const rows = (await http.get("${api.url}${path}", { query: { since, page } })).json<Event[]>();
      if (rows.length === 0) return;
      yield rows;
    }
  },
});
`);
    const killed = await p.json(["run", "events", "--follow", "100s"], { env: { CROFT_FAULT: "after_partial_commit" } });
    expect(killed.code, show(killed)).toBe(1);
    expect(killed.json.data.status).toBe("crashed");
    const runId = killed.json.data.runId as string;
    // The first part landed with its cursor, although the run never finished.
    const firstRequests = api.requests(path).length;
    expect(await p.rows("select count(*)::INT AS n, max(seq)::INT AS m from events")).toEqual([{ n: 50_000, m: 50_000 }]);
    const d = await p.json(["describe", "events"]);
    expect(String(d.json.data.behavior.incremental.cursorValue)).toBe("50000");

    // The next run reconciles the killed one and asks the API for what comes after the committed cursor.
    const next = await p.json(["run", "events"]);
    expect(next.code, show(next)).toBe(0);
    const resumed = api.requests(path).slice(firstRequests);
    expect(resumed[0]!.query).toMatchObject({ since: "50000", page: "1" });
    expect(await p.rows("select count(*)::INT AS n, max(seq)::INT AS m from events")).toEqual([{ n: total, m: total }]);
    expect(stepOf(next.json, "events").rows).toMatchObject({ total });
    const logs = await p.json(["logs", runId]);
    expect(logs.json.data.steps[0]).toMatchObject({ status: "ok" });
    expect(logs.json.data.steps[0].reason).toContain("recovered");
  }, 240_000);

  test("e. EMPTY_EXTRACT: [] from an ingest whose lookback window held rows is a warning; nothing is removed", async () => {
    const { p, state } = await source("/e", "charges", "at", [1, 2, 3].map((id) => ({ id, at: at(id), amount: id * 100 })),
      `  key: "id",\n  incremental: { field: "at", lookback: "1 day" },`);
    const first = await p.json(["run", "charges"]);
    expect(first.code, show(first)).toBe(0);
    expect(codes(first.json)).not.toContain("EMPTY_EXTRACT");

    // A revoked token that still answers 200 with an empty list.
    state.empty = true;
    const r = await p.json(["run", "charges"]);
    expect(r.code, show(r)).toBe(0);
    expect(stepOf(r.json, "charges").status).toBe("ok");
    const w = findProblem(r.json, "EMPTY_EXTRACT");
    expect(w, show(r)).toMatchObject({ severity: "warning", asset: "charges", fix: { kind: "command", command: "croft logs charges" }, details: { field: "at", windowRows: 3 } });
    expect(w!.hint).toContain("revoked or expired token");
    expect(await p.rows("select count(*)::INT AS n from charges")).toEqual([{ n: 3 }]);
    const logs = await p.json(["logs", "charges"]);
    expect(logs.code, show(logs)).toBe(0);
    const docs = await p.json(["docs", "EMPTY_EXTRACT"]);
    expect(docs.json.data).toMatchObject({ source: "file", severity: "warning" });
  }, 180_000);
});
