// Journey 5: type drift. An API field switches from number to text. The load fails with TYPE_CONFLICT
// (§7: "the load rolls back and the cursor does not move"): nothing is written, the cursor stays, and the
// failure is not retried. Once the source is fixed, the next run picks up from the old cursor.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { at, githubAsset, githubRoute, issue, TOKEN } from "./fixtures.ts";
import { cleanupAll, findProblem, initProject, type MockApi, mockApi, show } from "./harness.ts";

let api: MockApi;
let driftDetails: Record<string, unknown> | undefined;
beforeAll(() => {
  api = mockApi();
});
afterAll(async () => {
  api.stop();
  await cleanupAll();
});

test("journey 5: number → text drift is TYPE_CONFLICT; nothing written; the cursor did not move", async () => {
  const state = { issues: [1, 2, 3, 4].map((id) => issue(id, id, { score: id * 7 })), limited: 0 };
  githubRoute(api, state);
  const { project: p } = await initProject();
  p.write("assets/github_issues.ts", githubAsset(api.url));
  p.secret("GITHUB_TOKEN", TOKEN);
  const path = "/repos/oven-sh/bun/issues";

  const first = await p.json(["run", "github_issues"]);
  expect(first.code, show(first)).toBe(0);
  const d1 = await p.json(["describe", "github_issues"]);
  expect(d1.json.data.columns.find((c: { name: string }) => c.name === "score").type).toBe("BIGINT");
  expect(d1.json.data.behavior.incremental.cursorValue).toBe(at(4));
  const before = await p.rows("select id, title, score, _loaded_at from github_issues order by id");

  // Issue 3 is edited and its score is now text; issue 5 is new with a text score.
  state.issues[2] = issue(3, 5, { title: "Issue 3 (edited)", score: "high" });
  state.issues.push(issue(5, 6, { score: "low" }));
  const n0 = api.requests(path).length;
  const drift = await p.json(["run", "github_issues"]);
  expect(drift.code, show(drift)).toBe(1);
  expect(drift.json.ok).toBe(false);
  expect(drift.json.data.status).toBe("failed");
  const step = drift.json.data.steps[0];
  expect(step.status).toBe("failed");
  const tc = findProblem(drift.json, "TYPE_CONFLICT");
  expect(tc, show(drift)).toBeDefined();
  expect(tc!.asset).toBe("github_issues");
  driftDetails = tc!.details;
  // §4.3 names these existingType and incomingKinds; the build calls them storedType and incoming (5b below).
  expect(tc!.details).toMatchObject({ column: "score" });
  expect(tc!.details.existingType ?? tc!.details.storedType).toBe("BIGINT");
  for (const k of ["badRows", "samples", "readBy"]) expect(tc!.details).toHaveProperty(k);
  // 2 bad records; the re-fetched keyset boundary row counts again, before dedupe.
  expect(tc!.details.badRows).toBeGreaterThanOrEqual(2);
  expect(JSON.stringify(tc!.details.samples)).toContain("high");
  // Deterministic: not retried (one attempt's worth of requests).
  expect(step.attempt).toBe(1);
  const reqs = api.requests(path).slice(n0);
  expect(reqs[0]!.query.since).toBe("2026-09-20T10:03:59Z");
  expect(reqs.length).toBeLessThanOrEqual(2);

  // Nothing was written: same rows, same stamps, same cursor; the table still has 4 rows.
  expect(await p.rows("select id, title, score, _loaded_at from github_issues order by id")).toEqual(before);
  const d2 = await p.json(["describe", "github_issues"]);
  expect(d2.json.data.behavior.incremental.cursorValue).toBe(at(4));
  expect(d2.json.data.columns.find((c: { name: string }) => c.name === "score").type).toBe("BIGINT");

  // status and logs --failed point at the failure.
  const st = await p.json(["status"]);
  const sa = st.json.data.assets.find((a: { asset: string }) => a.asset === "github_issues");
  expect(sa).toMatchObject({ status: "failed", lastRun: { status: "failed", code: "TYPE_CONFLICT" } });
  expect(st.json.data.healthy).toBe(false);
  const check = await p.croft(["status", "--check"]);
  expect(check.code).toBe(1);
  const failed = await p.json(["logs", "github_issues", "--failed"]);
  expect(failed.code, show(failed)).toBe(0);
  expect(failed.json.data.steps[0].error.code).toBe("TYPE_CONFLICT");

  // The source is fixed (numbers again): the next run resumes from the unchanged cursor and loads both rows.
  state.issues[2] = issue(3, 5, { title: "Issue 3 (edited)", score: 99 });
  state.issues[4] = issue(5, 6, { score: 1 });
  const n1 = api.requests(path).length;
  const fixed = await p.json(["run", "github_issues"]);
  expect(fixed.code, show(fixed)).toBe(0);
  expect(api.requests(path)[n1]!.query.since).toBe("2026-09-20T10:03:59Z");
  expect(fixed.json.data.steps[0].rows).toMatchObject({ added: 1, updated: 1, total: 5 });
  expect(fixed.json.data.steps[0].cursor).toMatchObject({ before: at(4), after: at(6) });
}, 120_000);

// DESIGN §4.3 fixes TYPE_CONFLICT details as {column, existingType, incomingKinds, badRows, samples, readBy}
// (the earlier storedType / incoming / conflictKinds stay as extra fields).
test("journey 5b: TYPE_CONFLICT details use the §4.3 names", () => {
  expect(driftDetails).toBeDefined();
  for (const k of ["column", "existingType", "incomingKinds", "badRows", "samples", "readBy"]) expect(driftDetails).toHaveProperty(k);
  expect(driftDetails).toMatchObject({ column: "score", existingType: "BIGINT" });
  expect(driftDetails!.incomingKinds).toEqual(expect.arrayContaining(["string"]));
});
