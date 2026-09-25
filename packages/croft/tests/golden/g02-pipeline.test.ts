// Golden: a pipeline's commands (DESIGN.md §4.3, §10), each --json envelope validated against its schema. One
// project holds every kind of asset: the example file ingest, a GitHub-like cursor ingest (JSON columns, a mock API),
// an SQL transform with a warning, and a paid incremental TypeScript transform. It is validated, dry-run, previewed,
// run (detached and in the foreground), inspected (status, context, describe, query, logs), edited so it is stale,
// broken so a run fails, and slowed so a run outlives --follow and `croft wait` picks it up.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { githubAsset, githubRoute, issue, type Issue, slowAsset, TOKEN } from "../e2e/fixtures.ts";
import { cleanupAll, initProject, json, type MockApi, mockApi, type Project, schedulerEnv } from "../e2e/harness.ts";
import { golden } from "./kit.ts";

let api: MockApi;
let p: Project;
let env: Record<string, string>;
const state: { issues: Issue[]; limited: number } = { issues: [], limited: 0 };

const SALES_BY_REGION = `-- description: Orders and revenue per region
-- key: region
-- check: orders > 0
-- warn: min_rows(1000)
SELECT region, count(*) AS orders, sum(amount) AS amount
FROM example_sales
GROUP BY ALL
`;

const labelsAsset = (llm: string) => `import { transform } from "@zabaca/croft";

type Issue = { id: number; title: string };

export default transform({
  description: "A label for every issue, from a paid API",
  inputs: ["github_issues"],
  key: "issue_id",
  incremental: true,
  async *rows({ newRows, http }) {
    for await (const i of newRows<Issue>("github_issues")) {
      const res = await http.post("${llm}", { id: i.id, title: i.title });
      yield { issue_id: i.id, label: res.json<{ label: string }>().label };
    }
  },
});
`;

const BOOM = `import { ingest } from "@zabaca/croft";

export default ingest({
  async *rows() {
    yield { id: 1 };
    throw new Error("the source broke");
  },
});
`;

beforeAll(async () => {
  env = schedulerEnv();
  api = mockApi();
  state.issues = [issue(1, 1), issue(2, 2), issue(3, 3), issue(4, 4, { state: "closed" })];
  githubRoute(api, state);
  api.route("/label", async (req) => {
    const body = (await req.json()) as { id: number };
    return json({ label: body.id % 2 ? "bug" : "feature" });
  });
  p = (await initProject("golden-pipeline")).project;
  p.secret("GITHUB_TOKEN", TOKEN);
  p.write("assets/github_issues.ts", githubAsset(api.url));
  p.write("assets/sales_by_region.sql", SALES_BY_REGION);
  p.write("assets/issue_labels.ts", labelsAsset(`${api.url}/label`));
}, 120_000);
afterAll(async () => {
  api.stop();
  await cleanupAll();
}, 120_000);

test("validate, and run --dry-run, before anything has run", async () => {
  const v = golden("validate", await p.croft(["validate", "--json"], { env })).data;
  expect(v.order).toEqual(expect.arrayContaining(["example_sales", "github_issues", "sales_by_region", "issue_labels"]));
  const one = golden("validate", await p.croft(["validate", "sales_by_region", "--json"], { env })).data;
  expect(one.assets.map((a: { name: string }) => a.name)).toEqual(["sales_by_region"]);
  const dry = golden("run", await p.croft(["run", "--dry-run", "--json"], { env })).data;
  expect(dry.dryRun).toBe(true);
  expect(dry.steps.length).toBe(4);
}, 120_000);

test("run: detached and followed, then in the foreground; its warnings", async () => {
  const first = golden("run", await p.croft(["run", "--json"], { env }));
  expect(first.data.status).toBe("succeeded");
  expect(first.data.steps.map((s: { asset: string }) => s.asset).sort()).toEqual(["example_sales", "github_issues", "issue_labels", "sales_by_region"]);
  expect(first.problems.map((x: { code: string }) => x.code)).toContain("CHECK_FAILED");
  state.issues.push(issue(5, 5));
  const again = golden("run", await p.croft(["run", "github_issues", "--foreground", "--json"], { env }));
  expect(again.data.steps.find((s: { asset: string }) => s.asset === "github_issues").cursor).toBeDefined();
  const dry = golden("run", await p.croft(["run", "--dry-run", "--json"], { env })).data;
  expect(dry.steps.length).toBeGreaterThan(0);
}, 120_000);

test("status, status --check, context", async () => {
  const st = golden("status", await p.croft(["status", "--json"], { env })).data;
  expect(st.assets.length).toBe(4);
  const check = await p.croft(["status", "--check", "--json"], { env });
  expect(check.code).toBe(golden("status", check, { exit: check.code === 0 ? 0 : 1 }).data.healthy ? 0 : 1);
  const ctx = golden("context", await p.croft(["context", "--json"], { env })).data;
  expect(ctx.assets.length).toBe(4);
  golden("context", await p.croft(["context", "--asset", "issue_labels", "--json"], { env }));
}, 120_000);

test("describe each kind of asset", async () => {
  for (const asset of ["example_sales", "github_issues", "sales_by_region", "issue_labels"]) {
    expect(golden("describe", await p.croft(["describe", asset, "--json"], { env })).data.asset).toBe(asset);
  }
  golden("describe", await p.croft(["describe", "github_issues", "--full-values", "--json"], { env }));
  golden("describe", await p.croft(["describe", "no_such_asset", "--json"], { env }), { failed: true, exit: 2 });
}, 120_000);

test("query: rows, JSON columns, caps, and a failed query", async () => {
  const q = golden("query", await p.croft(["query", "select id, title, user, labels, updated_at from github_issues order by id", "--json"], { env })).data;
  expect(q.rowCount).toBe(5);
  const capped = golden("query", await p.croft(["query", "from example_sales", "--limit", "3", "--json"], { env })).data;
  expect(capped.truncatedRows).toBeGreaterThan(0);
  golden("query", await p.croft(["query", "select 12345678901234567890::HUGEINT AS big, 1.5::DECIMAL(10,2) AS d", "--json"], { env }));
  golden("query", await p.croft(["query", "select * from no_such_table", "--json"], { env }), { failed: true, exit: 2 });
}, 120_000);

test("logs: the last run, an asset, a run id, --runs and --failed", async () => {
  golden("logs", await p.croft(["logs", "--json"], { env }));
  golden("logs", await p.croft(["logs", "github_issues", "--json"], { env }));
  const runs = golden("logs", await p.croft(["logs", "--runs", "--json"], { env })).data;
  const runId = runs.runs[0].runId as string;
  golden("logs", await p.croft(["logs", runId, "--json"], { env }));
  golden("logs", await p.croft(["logs", "--failed", "--json"], { env }));
}, 120_000);

test("preview an SQL transform and an ingest, then query --preview", async () => {
  p.write("assets/sales_by_region.sql", SALES_BY_REGION.replace("sum(amount) AS amount", "sum(amount) AS amount, avg(amount) AS average"));
  const sql = golden("preview", await p.croft(["preview", "sales_by_region", "--json"], { env })).data;
  expect(sql.assets[0].columns).toContainEqual(expect.objectContaining({ column: "average", change: "added" }));
  golden("query", await p.croft(["query", "--preview", "select * from sales_by_region", "--json"], { env }));
  state.issues.push(issue(6, 6));
  golden("preview", await p.croft(["preview", "github_issues", "--rows", "2", "--json"], { env }));
  golden("preview", await p.croft(["preview", "issue_labels", "--rebuild", "--json"], { env }));
}, 120_000);

test("an edited asset: validate, the dry run and status say so", async () => {
  golden("validate", await p.croft(["validate", "--json"], { env }));
  const dry = golden("run", await p.croft(["run", "--dry-run", "--json"], { env })).data;
  expect(dry.steps.find((s: { asset: string }) => s.asset === "sales_by_region").reasons).toContain("code_changed");
  const st = golden("status", await p.croft(["status", "--json"], { env })).data;
  expect(st.assets.find((a: { asset: string }) => a.asset === "sales_by_region").edited).toBe(true);
  golden("context", await p.croft(["context", "--json"], { env }));
}, 120_000);

test("a failed run: the run, logs --failed, status and context", async () => {
  p.write("assets/boom.ts", BOOM);
  const failed = golden("run", await p.croft(["run", "boom", "--json"], { env }), { exit: 1 });
  expect(failed.ok).toBe(false);
  expect(failed.data.steps[0].error.code).toBe("ASSET_CODE_ERROR");
  golden("logs", await p.croft(["logs", "boom", "--failed", "--json"], { env }));
  golden("status", await p.croft(["status", "--json"], { env }));
  golden("status", await p.croft(["status", "--check", "--json"], { env }), { exit: 1 });
  expect(golden("context", await p.croft(["context", "--json"], { env })).data.recentFailures.length).toBeGreaterThan(0);
  golden("describe", await p.croft(["describe", "boom", "--json"], { env }));
  p.remove("assets/boom.ts");
  golden("run", await p.croft(["run", "no_such_asset", "--json"], { env }), { failed: true, exit: 2 });
  golden("validate", await p.croft(["validate", "no_such_asset", "--json"], { env }), { failed: true, exit: 2 });
}, 120_000);

test("a run that outlives --follow: exit 6, then croft wait", async () => {
  let page = 0;
  api.route("/slow", async (_req, url) => {
    const n = Number(url.searchParams.get("page") ?? 1);
    page = n;
    await Bun.sleep(300);
    return json({ rows: [{ id: n * 2 - 1, page: n }, { id: n * 2, page: n }], more: n < 10 });
  });
  p.write("assets/slow_api.ts", slowAsset(api.url));
  const started = golden("run", await p.croft(["run", "slow_api", "--follow", "1s", "--json"], { env }), { exit: 6 });
  expect(started.data.status).toBe("running");
  const runId = started.data.runId as string;
  const still = golden("wait", await p.croft(["wait", runId, "--timeout", "0.2s", "--json"], { env }), { exit: 6 });
  expect(still.data.status).toBe("running");
  const running = golden("status", await p.croft(["status", "--json"], { env })).data;
  expect(running.running.length).toBe(1);
  const done = golden("wait", await p.croft(["wait", runId, "--timeout", "60s", "--json"], { env }));
  expect(done.data.status).toBe("succeeded");
  expect(page).toBe(10);
  golden("wait", await p.croft(["wait", "r_0000_0000_zzzz", "--json"], { env }), { failed: true, exit: 2 });
}, 120_000);
