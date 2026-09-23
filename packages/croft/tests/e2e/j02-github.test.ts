// Journey 2: a GitHub-like API ingest written from DESIGN §3a (keyset pages sorted ascending, `since`
// inclusive like GitHub's, incremental on updated_at, key id, GITHUB_TOKEN in .env).
// - a 429 with Retry-After is retried inside the attempt;
// - an integer beyond 2^63 survives as exact digits (HUGEINT, a string in --json);
// - a second run asks only from the saved cursor (minus the 1 s boundary lookback), and an updated issue
//   merges by id while unchanged rows keep their _loaded_at.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { at, BIG, githubAsset, githubRoute, issue, TOKEN } from "./fixtures.ts";
import { cleanupAll, findProblem, initProject, type MockApi, mockApi, show } from "./harness.ts";

let api: MockApi;
beforeAll(() => {
  api = mockApi();
});
afterAll(async () => {
  api.stop();
  await cleanupAll();
});

test("journey 2: GitHub-like keyset ingest: secret, 429 retry, big integers, incremental second run merges", async () => {
  const state = { issues: [1, 2, 3, 4, 5, 6, 7].map((id) => issue(id, id)), limited: 1 };
  state.issues[3]!.external_id = `__big__${BIG}`;
  githubRoute(api, state);

  const { project: p } = await initProject();
  p.write("assets/github_issues.ts", githubAsset(api.url));
  p.secret("GITHUB_TOKEN", TOKEN);
  const path = "/repos/oven-sh/bun/issues";

  // First run: no since; the first request is rate limited and retried after Retry-After.
  const first = await p.json(["run", "github_issues"]);
  expect(first.code, show(first)).toBe(0);
  const s1 = first.json.data.steps[0];
  expect(s1).toMatchObject({ asset: "github_issues", status: "ok", attempt: 1, rows: { added: 7, total: 7 } });
  const reqs1 = api.requests(path);
  expect(reqs1[0]!.query.since).toBeUndefined();              // since undefined is dropped from the query
  expect(reqs1[0]!.query).toMatchObject({ state: "all", sort: "updated", direction: "asc", per_page: "3" });
  expect(reqs1[1]!.query.since).toBeUndefined();              // the retry of the 429 asks the same thing
  expect(reqs1[1]!.at - reqs1[0]!.at).toBeGreaterThanOrEqual(900); // Retry-After: 1 honored
  expect(reqs1.map((r) => r.query.since ?? null)).toEqual([null, null, at(3), at(5), at(7)]);
  expect(s1.cursor.after).toBe(at(7));
  expect(s1.cursor.before ?? null).toBeNull(); // omitted on a first load
  expect(state.limited).toBe(0);

  // The secret never shows up in output or logs.
  expect(first.stdout).not.toContain(TOKEN);
  const logs = await p.json(["logs", "github_issues"]);
  expect(logs.code, show(logs)).toBe(0);
  expect(logs.stdout).not.toContain(TOKEN);

  // Big integers survive: HUGEINT, rendered as a string with every digit.
  const q = await p.json(["query", "select id, external_id, closed_at, labels->>'$[*].name' as labels, \"user\"->>'login' as login from github_issues order by id"]);
  expect(q.code, show(q)).toBe(0);
  const types = Object.fromEntries(q.json.data.columns.map((c: { name: string; type: string }) => [c.name, c.type]));
  expect(types.external_id).toBe("HUGEINT");
  expect(q.json.data.rows[3]).toMatchObject({ id: 4, external_id: BIG, login: "u4" });
  expect(q.json.data.rows[0].external_id).toBe("10");
  const d1 = await p.json(["describe", "github_issues"]);
  expect(d1.json.data.behavior).toMatchObject({ write: "merge", key: ["id"] });
  expect(d1.json.data.behavior.incremental).toMatchObject({ field: "updated_at", cursorValue: at(7) });
  const closedAt = d1.json.data.columns.find((c: { name: string }) => c.name === "closed_at");
  expect(closedAt).toMatchObject({ type: "TIMESTAMPTZ", pending: true }); // typed from its name (§7)
  const userCol = d1.json.data.columns.find((c: { name: string }) => c.name === "user");
  expect(userCol.type).toBe("JSON");
  expect(userCol.jsonKeys).toContain("login");
  const stamps = new Map((await p.rows("select id, _loaded_at from github_issues")).map((r) => [r.id, r._loaded_at]));

  // Second run: issue 2 was edited (and so moves to the end), issue 8 is new.
  state.issues[1] = issue(2, 8, { title: "Issue 2 (edited)", state: "closed" });
  state.issues.push(issue(8, 9));
  const before = api.requests(path).length;
  const second = await p.json(["run", "github_issues"]);
  expect(second.code, show(second)).toBe(0);
  const reqs2 = api.requests(path).slice(before);
  // Only from the saved cursor, minus the 1 s boundary lookback, in the saved value's own form.
  expect(reqs2[0]!.query.since).toBe("2026-09-20T10:06:59Z");
  const s2 = second.json.data.steps[0];
  expect(s2.rows).toMatchObject({ added: 1, updated: 1, deleted: 0, total: 8 });
  expect(s2.cursor).toMatchObject({ before: at(7), after: at(9) });
  const rows = await p.rows("select id, title, state, _loaded_at from github_issues order by id");
  expect(rows).toHaveLength(8);
  expect(rows[1]).toMatchObject({ id: 2, title: "Issue 2 (edited)", state: "closed" });
  expect(rows[1]!._loaded_at).not.toBe(stamps.get(2));
  // The re-fetched boundary row (issue 7) and everything not re-fetched keep their stamps.
  for (const r of rows) if (r.id !== 2 && r.id !== 8) expect(r._loaded_at).toBe(stamps.get(r.id));
  const d2 = await p.json(["describe", "github_issues"]);
  expect(d2.json.data.behavior.incremental.cursorValue).toBe(at(9));

  // A third run with nothing new fetches one page and changes nothing.
  const third = await p.json(["run", "github_issues"]);
  expect(third.code, show(third)).toBe(0);
  expect(third.json.data.steps[0].rows).toMatchObject({ added: 0, updated: 0, total: 8 });
  expect(third.json.data.steps[0].cursor?.after ?? at(9)).toBe(at(9));
}, 120_000);

test("journey 2b: a 401 from a wrong token fails with HTTP_ERROR, redacted, and nothing is written", async () => {
  const state = { issues: [issue(1, 1)], limited: 0 };
  const other = mockApi();
  try {
    githubRoute(other, state, "the-right-token-xyz");
    const { project: p } = await initProject();
    p.write("assets/github_issues.ts", githubAsset(other.url));
    p.secret("GITHUB_TOKEN", "the-wrong-token-abc");
    const r = await p.json(["run", "github_issues"]);
    expect(r.code, show(r)).toBe(1);
    const e = findProblem(r.json, "HTTP_ERROR");
    expect(e, show(r)).toBeDefined();
    expect(e!.details).toMatchObject({ status: 401, method: "GET" });
    expect(r.stdout).not.toContain("the-wrong-token-abc");
    // A 401 is not retried (deterministic), so one request only.
    expect(other.requests("/repos/oven-sh/bun/issues")).toHaveLength(1);
    const count = await p.json(["query", "select count(*) n from duckdb_tables() where table_name = 'github_issues'"]);
    expect(count.json.data.rows[0].n).toBe(0);
  } finally {
    other.stop();
  }
}, 60_000);
