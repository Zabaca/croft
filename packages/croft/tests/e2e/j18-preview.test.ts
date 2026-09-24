// Journey 18: croft preview (DESIGN.md §6 "Ways to try a change" 2, §4.2), through the real CLI off a TTY, the way
// Claude Code runs it. A GitHub-like issues API feeds an SQL asset and an incremental TS transform that calls a
// per-row "LLM" (a mock that counts its calls).
// - a project that never ran previews an ingest and the SQL on it together; nothing real is created;
// - an edited SQL asset previews against snapshots of its live inputs: diff by key, column changes, checks,
//   sample, Explore and Apply; `croft query --preview` explores it; the live table is unchanged;
// - an ingest previews from its saved position, stops at --rows, and the cursor does not move;
// - an incremental TS transform previews only its pending rows, at most --rows paid calls, with ctx.preview;
// - --rebuild shows drift; a failing blocking check exits 3 and leaves the rows to explore.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { at, githubAsset, githubRoute, issue, type Issue, TOKEN } from "./fixtures.ts";
import { bugTest, cleanupAll, codes, initProject, type MockApi, mockApi, type Project, show } from "./harness.ts";

let api: MockApi;
const llm = { calls: 0, previews: [] as boolean[] };
beforeAll(() => {
  api = mockApi();
  api.route("/classify", async (req) => {
    llm.calls++;
    const body = await req.json() as { title: string; preview: boolean };
    llm.previews.push(body.preview);
    return Response.json({ label: /crash/i.test(body.title) ? "bug" : "other" });
  });
});
afterAll(async () => {
  api.stop();
  await cleanupAll();
});

const PATH = "/repos/oven-sh/bun/issues";

const OPEN_SQL = `-- description: open issues
-- key: id
-- check: not_null(title)
SELECT id, title, updated_at FROM github_issues WHERE state = 'open'
`;

const triage = (label: string) => `import { transform } from "@zabaca/croft";

export default transform({
  description: "Labels each issue with a per-row LLM call",
  inputs: ["github_issues"],
  key: "id",
  incremental: true,
  async *rows({ newRows, http, preview }) {
    for await (const r of newRows<{ id: number; title: string }>("github_issues")) {
      const res = await http.post("${api.url}/classify", { title: r.title, preview });
      yield { id: r.id, label: ${label} };
    }
  },
});
`;

async function project(issues: Issue[]): Promise<Project> {
  githubRoute(api, { issues, limited: 0 });
  const { project: p } = await initProject();
  p.write("assets/github_issues.ts", githubAsset(api.url));
  p.secret("GITHUB_TOKEN", TOKEN);
  p.write("assets/open_issues.sql", OPEN_SQL);
  return p;
}

test("journey 18a: a project that never ran previews an ingest and its SQL together; nothing real is created", async () => {
  const p = await project([issue(1, 1), issue(2, 2, { state: "closed" }), issue(3, 3)]);
  const r = await p.json(["preview", "github_issues", "open_issues"]);
  expect(r.code, show(r)).toBe(0);
  const [gh, open] = r.json.data.assets;
  expect(gh).toMatchObject({ asset: "github_issues", kind: "ingest", status: "ok", rows: 3, liveRows: null, capped: false });
  expect(open).toMatchObject({ asset: "open_issues", status: "ok", rows: 2, liveRows: null, diff: { by: ["id"], added: 2 } });
  expect(p.exists("warehouse.duckdb")).toBe(false);
  expect(p.exists(".croft/preview.duckdb")).toBe(true);
  const q = await p.json(["query", "select id from open_issues order by id", "--preview"]);
  expect(q.code, show(q)).toBe(0);
  expect(q.json.data.rows).toEqual([{ id: 1 }, { id: 3 }]);
  // The token never shows up.
  expect(r.stdout).not.toContain(TOKEN);
  // Plain query still has no warehouse.
  const live = await p.json(["query", "select * from open_issues"]);
  expect(live.json.problems[0].code).toBe("DB_NOT_FOUND");
}, 120_000);

test("journey 18b: edit SQL → preview (diff, columns, checks, sample) → query --preview → run", async () => {
  const p = await project([issue(1, 1), issue(2, 2, { state: "closed" }), issue(3, 3), issue(4, 4)]);
  const first = await p.json(["run"]);
  expect(first.code, show(first)).toBe(0);
  const db = join(p.root, "warehouse.duckdb");
  const before = statSync(db).mtimeMs;

  p.write("assets/open_issues.sql", `-- description: open issues
-- key: id
-- check: not_null(title)
SELECT id, upper(title) AS title, length(title) AS title_length FROM github_issues WHERE state = 'open' AND id <> 4
`);
  const r = await p.croft(["preview", "open_issues"]);
  expect(r.code, show(r)).toBe(0);
  const lines = r.stdout.trimEnd().split("\n");
  expect(lines[0]).toBe("Preview: your real tables are not changed.");
  expect(lines[1]).toMatch(/^open_issues\s+2 rows \(live 3\)\s+\+0 added · 1 removed · 2 changed \(by key id\)$/);
  expect(lines).toContain("  columns     + title_length BIGINT (new) · − updated_at TIMESTAMPTZ");
  expect(lines).toContain("  checks      ok unique(id) · ok not_null(id) · ok not_null(title)");
  expect(lines.some((l) => l.startsWith("  sample      id"))).toBe(true);
  expect(lines.slice(-2)).toEqual([`Explore: croft query --preview "from open_issues"`, "Apply:   croft run open_issues"]);

  // Nothing real changed: the file, the table, what status says.
  expect(statSync(db).mtimeMs).toBe(before);
  expect(await p.rows("select id, title from open_issues order by id")).toEqual([
    { id: 1, title: "Issue 1" }, { id: 3, title: "Issue 3" }, { id: 4, title: "Issue 4" },
  ]);
  // status reads the live catalog mirror, which the preview never wrote: 3 rows, still stale for its edit.
  const status = await p.json(["status"]);
  expect(status.code, show(status)).toBe(0);
  const open = status.json.data.assets.find((x: { asset: string }) => x.asset === "open_issues");
  expect(open).toMatchObject({ rows: 3, stale: true, staleReasons: ["code_changed"] });

  const q = await p.json(["query", "select id, title, title_length from open_issues order by id", "--preview"]);
  expect(q.code, show(q)).toBe(0);
  expect(q.json.data.rows).toEqual([{ id: 1, title: "ISSUE 1", title_length: 7 }, { id: 3, title: "ISSUE 3", title_length: 7 }]);

  const applied = await p.json(["run", "open_issues"]);
  expect(applied.code, show(applied)).toBe(0);
  expect(await p.rows("select id, title from open_issues order by id")).toEqual([{ id: 1, title: "ISSUE 1" }, { id: 3, title: "ISSUE 3" }]);
}, 120_000);

test("journey 18c: an ingest previews from its saved position, stops at --rows, and its cursor does not move", async () => {
  const state = [1, 2, 3].map((id) => issue(id, id));
  const p = await project(state);
  const first = await p.json(["run", "github_issues"]);
  expect(first.code, show(first)).toBe(0);
  state.push(...[4, 5, 6, 7, 8].map((id) => issue(id, id + 1)));
  state[0] = issue(1, 20, { title: "Issue 1 (edited)" });
  githubRoute(api, { issues: state, limited: 0 });

  const n = api.requests(PATH).length;
  const r = await p.json(["preview", "github_issues", "--rows", "4"]);
  expect(r.code, show(r)).toBe(0);
  const a = r.json.data.assets[0];
  expect(a).toMatchObject({ asset: "github_issues", status: "ok", rows: 4, capped: true, partial: true, since: "2026-09-20T10:02:59Z", liveRows: 3 });
  expect(a.downstream).toEqual(["open_issues"]);
  expect(api.requests(PATH).slice(n)[0]!.query.since).toBe("2026-09-20T10:02:59Z");
  const human = await p.croft(["preview", "github_issues", "--rows", "4"]);
  expect(human.stdout.split("\n")[0]).toBe("Preview: nothing is saved and the saved position (since 2026-09-20T10:02:59Z) does not move.");
  expect(human.stdout).toContain("stopped at --rows 4");
  expect(human.stdout).toContain("  downstream  open_issues would update (not built in an ingest preview)");

  // The real run asks from the same position and gets everything.
  const m = api.requests(PATH).length;
  const run = await p.json(["run", "github_issues", "--only"]);
  expect(run.code, show(run)).toBe(0);
  expect(api.requests(PATH).slice(m)[0]!.query.since).toBe("2026-09-20T10:02:59Z");
  expect(run.json.data.steps[0].rows).toMatchObject({ added: 5, updated: 1, total: 8 });
  expect(run.json.data.steps[0].cursor.after).toBe(at(20));
}, 120_000);

test("journey 18d: an incremental LLM transform previews only pending rows, at most --rows calls; --rebuild shows drift", async () => {
  const state = [issue(1, 1, { title: "Crash on start" }), issue(2, 2), issue(3, 3)];
  const p = await project(state);
  p.write("assets/issue_triage.ts", triage("res.json<{ label: string }>().label"));
  const first = await p.json(["run"]);
  expect(first.code, show(first)).toBe(0);
  state.push(issue(4, 4, { title: "another crash" }), issue(5, 5), issue(6, 6), issue(7, 7), issue(8, 8));
  githubRoute(api, { issues: state, limited: 0 });
  const fetched = await p.json(["run", "github_issues", "--only"]);
  expect(fetched.code, show(fetched)).toBe(0);

  const calls = llm.calls;
  llm.previews.length = 0;
  const r = await p.json(["preview", "issue_triage", "--rows", "2"]);
  expect(r.code, show(r)).toBe(0);
  expect(llm.calls - calls).toBe(2);
  expect(llm.previews).toEqual([true, true]);
  expect(r.json.data.assets[0]).toMatchObject({ asset: "issue_triage", partial: true, capped: true, rows: 2, diff: { added: 2, changed: 0 } });
  const human = await p.croft(["preview", "issue_triage", "--rows", "2"]);
  expect(human.stdout).toMatch(/issue_triage\s+2 rows built \(live 3\)\s+of 2 keys touched, 2 differ/);

  // Nothing moved: the real run processes all 5 pending rows.
  const before = llm.calls;
  const run = await p.json(["run", "issue_triage"]);
  expect(run.code, show(run)).toBe(0);
  expect(llm.calls - before).toBe(5);

  // New code applies to new rows only; --rebuild shows how far the table drifted from what it would be.
  p.write("assets/issue_triage.ts", triage("res.json<{ label: string }>().label.toUpperCase()"));
  const rebuild = await p.json(["preview", "issue_triage", "--rebuild"]);
  expect(rebuild.code, show(rebuild)).toBe(0);
  expect(rebuild.json.data).toMatchObject({ rebuild: true, partial: false });
  expect(rebuild.json.data.assets[0]).toMatchObject({ rows: 8, liveRows: 8, diff: { by: ["id"], added: 0, removed: 0, changed: 8, unchanged: 0 } });
  const text = await p.croft(["preview", "issue_triage", "--rebuild"]);
  expect(text.stdout).toMatch(/issue_triage\s+8 rows \(live 8\)\s+8 of 8 rows differ/);
}, 120_000);

test("journey 18e: a failing blocking check exits 3, names the fix, and leaves the rows to explore", async () => {
  const p = await project([issue(1, 1), issue(2, 2, { title: "" })]);
  const first = await p.json(["run"]);
  expect(first.code, show(first)).toBe(0);
  p.write("assets/open_issues.sql", `-- key: id
-- check: length(title) > 0
SELECT id, title FROM github_issues
`);
  const r = await p.json(["preview", "open_issues"]);
  expect(r.code, show(r)).toBe(3);
  const failed = r.json.problems.find((x: { code: string }) => x.code === "CHECK_FAILED");
  expect(failed).toMatchObject({ severity: "error", asset: "open_issues", file: "assets/open_issues.sql" });
  expect(failed.hint).toContain("croft preview open_issues");
  expect(r.json.data.assets[0]).toMatchObject({ status: "failed", rows: 2 });
  expect(r.json.next.map((n: { command: string }) => n.command)).toContain("croft preview open_issues");
  expect(r.json.next.map((n: { command: string }) => n.command)).not.toContain("croft run open_issues");
  const q = await p.json(["query", "select id from open_issues where length(title) = 0", "--preview"]);
  expect(q.json.data.rows).toEqual([{ id: 2 }]);
}, 120_000);

// BUG (reported): DESIGN §6 says "The column cache is filled by runs, by previews and by `columns` pins", and
// validate's INPUT_NOT_BUILT says the columns are unknown "until it has run or been previewed", with the next step
// `croft preview github_issues`. validate reads only the live catalog mirror, and a preview writes its catalog to
// .croft/preview/runs.sqlite, so after that preview validate still skips the bind and points at the same preview:
// an agent following the hints loops.
bugTest("journey 18f: after previewing a never-built input, validate binds the SQL on it (the column cache holds previews)", async () => {
  const p = await project([issue(1, 1), issue(2, 2)]);
  const before = await p.json(["validate"]);
  expect(before.code, show(before)).toBe(0);
  expect(codes(before.json)).toContain("INPUT_NOT_BUILT");
  expect(before.json.problems.find((x: { code: string }) => x.code === "INPUT_NOT_BUILT").fix.command).toBe("croft preview github_issues");
  const r = await p.json(["preview", "github_issues"]);
  expect(r.code, show(r)).toBe(0);
  const after = await p.json(["validate"]);
  expect(codes(after.json)).not.toContain("INPUT_NOT_BUILT");
  expect(after.json.data.assets.find((a: { name: string }) => a.name === "open_issues").outputColumns).not.toBeNull();
}, 120_000);
