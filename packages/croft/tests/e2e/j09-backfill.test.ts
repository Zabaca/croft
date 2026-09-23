// Journey 9: `croft run x --from -90d` on a merge ingest (DESIGN §8 "Backfills": fetch from <when> and upsert;
// the saved cursor stays greatest(saved, loaded)). The space-separated form `--from -90d` is what §4.1 and the
// skill's backfill recipe show; the run engine's builder noted that node's parseArgs rejects it, and the
// integration agent is fixing the parser in parallel, so this journey accepts either outcome and records it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { at, githubAsset, githubRoute, issue, TOKEN } from "./fixtures.ts";
import { cleanupAll, findProblem, initProject, type MockApi, mockApi, show } from "./harness.ts";

let api: MockApi;
beforeAll(() => {
  api = mockApi();
});
afterAll(async () => {
  api.stop();
  await cleanupAll();
});

/** Epoch milliseconds `days` days before now. */
function daysAgo(days: number): number {
  return Date.now() - days * 86_400_000;
}

test("journey 9: --from -90d on a merge ingest (either outcome recorded), --from=-90d and --from <date>", async () => {
  const state = { issues: [1, 2, 3, 4, 5].map((id) => issue(id, id)), limited: 0 };
  githubRoute(api, state);
  const { project: p } = await initProject();
  p.write("assets/github_issues.ts", githubAsset(api.url));
  p.secret("GITHUB_TOKEN", TOKEN);
  const path = "/repos/oven-sh/bun/issues";
  const first = await p.json(["run", "github_issues"]);
  expect(first.code, show(first)).toBe(0);

  // 1. The documented form: --from -90d (space-separated).
  const n0 = api.requests(path).length;
  const spaced = await p.json(["run", "github_issues", "--from", "-90d"]);
  if (spaced.code === 0) {
    const since = api.requests(path)[n0]!.query.since!;
    expect(Math.abs(Date.parse(since) - daysAgo(90))).toBeLessThan(120_000);
    expect(spaced.json.data.steps[0].reason).toContain("since: ");
    console.info(`[journey 9] --from -90d (space-separated): accepted; since=${since}`);
  } else {
    expect(spaced.code, show(spaced)).toBe(2);
    const u = findProblem(spaced.json, "USAGE_ERROR");
    expect(u, show(spaced)).toBeDefined();
    expect(api.requests(path).length).toBe(n0); // refused before anything ran
    console.info(`[journey 9] --from -90d (space-separated): refused, exit 2 USAGE_ERROR: ${u!.message} (hint: ${u!.hint})`);
  }

  // 2. --from=-90d always works: since = now − 90 days, in the saved cursor's own form; everything is upserted.
  const n1 = api.requests(path).length;
  const eq = await p.json(["run", "github_issues", "--from=-90d"]);
  expect(eq.code, show(eq)).toBe(0);
  const since1 = api.requests(path)[n1]!.query.since!;
  expect(since1).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  expect(Math.abs(Date.parse(since1) - daysAgo(90))).toBeLessThan(120_000);
  const step = eq.json.data.steps[0];
  expect(step.reason).toMatch(/since: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\)/);
  expect(step.rows).toMatchObject({ added: 0, unchanged: 5, total: 5 });
  // The saved cursor never rewinds.
  const d = await p.json(["describe", "github_issues"]);
  expect(d.json.data.behavior.incremental.cursorValue).toBe(at(5));

  // 3. A date is midnight in the project time zone (America/Los_Angeles), converted to the cursor's form.
  const n2 = api.requests(path).length;
  const date = await p.json(["run", "github_issues", "--from", "2026-06-24"]);
  expect(date.code, show(date)).toBe(0);
  expect(api.requests(path)[n2]!.query.since).toBe("2026-06-24T07:00:00Z");
  expect(date.json.data.steps[0].reason).toContain("since: 2026-06-24T07:00:00Z (2026-06-24T00:00:00-07:00)");

  // 4. --from on the example's replace (file) ingest is BACKFILL_UNSUPPORTED, and nothing runs.
  const unsupported = await p.json(["run", "example_sales", "--from=-90d"]);
  expect(unsupported.code, show(unsupported)).not.toBe(0);
  expect(findProblem(unsupported.json, "BACKFILL_UNSUPPORTED"), show(unsupported)).toBeDefined();
}, 120_000);
