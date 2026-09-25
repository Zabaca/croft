// Journey 26: renaming an asset (DESIGN.md §4.1 rename, §6 "Nothing implicit destroys ingested data", §9 recipe
// "Rename: croft rename <old> <new>; fix every reference it lists; validate; preview; run").
//   a. croft rename github_issues issues: the file, the table, the cursor, the history and the scheduler's approval
//      move together, with no confirmation; the references to update come back as file:line, and croft never edits
//      them; after they are fixed, the next run continues from the saved cursor;
//   b. a file renamed by hand: validate and status report ASSET_RENAMED with the fix croft rename <old> <new>, never
//      a run; croft rename adopts the old table without a single request to the API.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { githubAsset, githubRoute, issue, TOKEN } from "./fixtures.ts";
import { cleanupAll, codes, type Envelope, findProblem, initProject, json, type MockApi, mockApi, schedulerEnv, show } from "./harness.ts";

let api: MockApi;
beforeAll(() => {
  api = mockApi();
});
afterAll(async () => {
  api.stop();
  await cleanupAll();
});

const ISSUES_PATH = "/repos/oven-sh/bun/issues";

const openSql = (table: string) => `-- description: the open issues
-- key: id
SELECT id, title FROM ${table} WHERE state = 'open'
`;

const statsTs = (table: string) => `import { transform } from "@zabaca/croft";

type Issue = { id: number; state: string };

export default transform({
  description: "Issue counts by state",
  inputs: ["${table}"],
  key: "state",
  async *rows({ rows }) {
    const n = new Map<string, number>();
    for await (const r of rows<Issue>("${table}")) n.set(r.state, (n.get(r.state) ?? 0) + 1);
    for (const [state, count] of n) yield { state, count };
  },
});
`;

/** The 1-based line of `text` that contains `needle`. */
const lineOf = (text: string, needle: string) => text.split("\n").findIndex((l) => l.includes(needle)) + 1;

const assetOf = (env: Envelope, name: string) => (env.data.assets as Envelope[]).find((a) => a.asset === name);

describe("journey 26: croft rename", () => {
  test("a. the file, table, cursor, history and approval move together; the references are listed, not edited", async () => {
    const state = { issues: [1, 2, 3].map((id) => issue(id, id, id === 2 ? { state: "closed" } : {})), limited: 0 };
    githubRoute(api, state);
    const { project: p } = await initProject();
    p.remove("assets/example_sales.ts");
    p.write("assets/github_issues.ts", githubAsset(api.url));
    p.write("assets/open_issues.sql", openSql("github_issues"));
    p.write("assets/issue_stats.ts", statsTs("github_issues"));
    p.secret("GITHUB_TOKEN", TOKEN);
    const first = await p.json(["run"]);
    expect(first.code, show(first)).toBe(0);
    const firstRun = first.json.data.runId as string;
    const cursor = (await p.json(["describe", "github_issues"])).json.data.behavior.incremental.cursorValue as string;

    // Scheduling on (no OS job): the ingest was run by hand, so the scheduler may run it.
    const sched = { env: schedulerEnv() };
    const on = await p.json(["schedule", "on", "--no-os-job"], sched);
    expect(on.code, show(on)).toBe(0);
    expect(assetOf(on.json, "github_issues")).toMatchObject({ schedule: "every hour", held: null });

    // The rename: no confirmation, nothing fetched.
    const before = api.requests(ISSUES_PATH).length;
    const r = await p.json(["rename", "github_issues", "issues"]);
    expect(r.code, show(r)).toBe(0);
    expect(r.json.confirmation).toBeUndefined();
    expect(r.json.data).toMatchObject({
      from: "github_issues", to: "issues", mode: "file",
      file: { from: "assets/github_issues.ts", to: "assets/issues.ts", moved: true },
      table: { renamed: true, rows: 3 }, preview: "none",
    });
    const sql = openSql("github_issues");
    const ts = statsTs("github_issues");
    const refs = (r.json.data.references as Envelope[]).map((x) => [x.file, x.line, x.kind]);
    expect(refs).toEqual(expect.arrayContaining([
      ["assets/open_issues.sql", lineOf(sql, "FROM github_issues"), "sql"],
      ["assets/issue_stats.ts", lineOf(ts, "inputs:"), "ts_input"],
      ["assets/issue_stats.ts", lineOf(ts, "rows<Issue>"), "ts_input"],
    ]));
    expect(refs).toHaveLength(3);
    expect(r.json.next).toEqual([{ command: "croft validate", reason: "after updating the 3 references to github_issues listed above, check the project" }]);
    expect(api.requests(ISSUES_PATH).length).toBe(before);

    // What moved: the file, the table (under its new name only), its cursor, its history.
    expect(p.exists("assets/issues.ts")).toBe(true);
    expect(p.exists("assets/github_issues.ts")).toBe(false);
    expect(await p.rows("select count(*)::INT AS n from issues")).toEqual([{ n: 3 }]);
    expect((await p.json(["query", "select count(*) from github_issues"])).code).not.toBe(0);
    const d = await p.json(["describe", "issues"]);
    expect(d.code, show(d)).toBe(0);
    expect(d.json.data).toMatchObject({ asset: "issues", kind: "ingest", file: "assets/issues.ts", rows: 3 });
    expect(d.json.data.behavior.incremental.cursorValue).toBe(cursor);
    expect(d.json.data.recentRuns.map((x: Envelope) => x.runId)).toContain(firstRun);
    // The scheduler's approval moved with it: issues is not held.
    const sched2 = await p.json(["schedule", "status"], sched);
    expect(sched2.code, show(sched2)).toBe(0);
    expect(assetOf(sched2.json, "issues")).toMatchObject({ schedule: "every hour", held: null });
    expect(assetOf(sched2.json, "github_issues")).toBeUndefined();
    expect((sched2.json.problems as Envelope[]).filter((x) => x.code === "SCHEDULE_HELD")).toEqual([]);

    // croft never edits user code: the references still name github_issues, and validate says so.
    expect(p.read("assets/open_issues.sql")).toBe(sql);
    expect(p.read("assets/issue_stats.ts")).toBe(ts);
    const broken = await p.json(["validate"]);
    expect(broken.code, show(broken)).toBe(2);
    const unknown = (broken.json.problems as Envelope[]).filter((x) => x.code === "UNKNOWN_TABLE").map((x) => x.asset).sort();
    expect(unknown).toEqual(["issue_stats", "open_issues"]);

    // Fix every reference; validate; run: the ingest continues from its cursor, and the readers rebuild.
    p.write("assets/open_issues.sql", openSql("issues"));
    p.write("assets/issue_stats.ts", statsTs("issues"));
    const valid = await p.json(["validate"]);
    expect(valid.code, show(valid)).toBe(0);
    state.issues.push(issue(4, 4));
    const run = await p.json(["run"]);
    expect(run.code, show(run)).toBe(0);
    const since = api.requests(ISSUES_PATH).slice(before).map((x) => x.query.since);
    expect(since[0], JSON.stringify(since)).toBeDefined();
    expect(Date.parse(since[0]!)).toBeGreaterThanOrEqual(Date.parse(cursor) - 1000);
    const steps = run.json.data.steps as Envelope[];
    expect(steps.map((s) => [s.asset, s.status])).toEqual(expect.arrayContaining([["issues", "ok"], ["open_issues", "ok"], ["issue_stats", "ok"]]));
    expect(steps.find((s) => s.asset === "issues")!.rows).toMatchObject({ added: 1, total: 4 });
    expect(await p.rows("select id::INT AS id from open_issues order by id")).toEqual([{ id: 1 }, { id: 3 }, { id: 4 }]);

    const off = await p.json(["schedule", "off"], sched);
    expect(off.code, show(off)).toBe(0);
  }, 180_000);

  test("b. a file renamed by hand: ASSET_RENAMED in validate and status; croft rename adopts the table without a request", async () => {
    const state = { tickets: [1, 2, 3].map((id) => ({ id, subject: `Ticket ${id}`, updated_at: `2026-09-20T10:0${id}:00Z` })) };
    const path = "/b/tickets";
    api.route(path, (_req, url) => {
      const since = url.searchParams.get("since");
      return json(state.tickets.filter((t) => !since || Date.parse(t.updated_at) >= Date.parse(since)));
    });
    const { project: p } = await initProject();
    p.remove("assets/example_sales.ts");
    const code = `import { ingest } from "@zabaca/croft";

type Ticket = { id: number; updated_at: string };

export default ingest({
  description: "Support tickets",
  key: "id",
  incremental: "updated_at",
  async *rows({ since, http }) {
    yield (await http.get("${api.url}${path}", { query: { since } })).json<Ticket[]>();
  },
});
`;
    p.write("assets/tickets.ts", code);
    expect((await p.json(["run"])).code).toBe(0);
    const cursor = (await p.json(["describe", "tickets"])).json.data.behavior.incremental.cursorValue as string;

    // Renamed outside croft, as a file manager or `mv` would.
    p.write("assets/support_tickets.ts", code);
    p.remove("assets/tickets.ts");
    const fix = { kind: "command", command: "croft rename tickets support_tickets" };

    const validate = await p.json(["validate"]);
    expect(validate.code, show(validate)).toBe(2);
    const renamed = findProblem(validate.json, "ASSET_RENAMED");
    expect(renamed, show(validate)).toMatchObject({ severity: "error", asset: "support_tickets", fix, details: { from: "tickets", to: "support_tickets", rows: 3 } });
    expect(renamed!.hint).toContain("adopts");

    const status = await p.json(["status"]);
    expect(status.code, show(status)).toBe(0);
    expect(findProblem(status.json, "ASSET_RENAMED"), show(status)).toMatchObject({ asset: "support_tickets", fix });
    expect(assetOf(status.json, "support_tickets")).toMatchObject({ status: "never_run", rows: null });
    expect(assetOf(status.json, "tickets")).toMatchObject({ status: "no_asset_file", rows: 3 });
    // Neither status nor its next[] sends the agent to a run that would fetch everything again.
    expect(status.json.next.map((n: Envelope) => n.command)).not.toContain("croft run support_tickets");
    const human = await p.croft(["status"]);
    expect(human.stdout).toContain("croft rename tickets support_tickets");
    expect(human.stdout).not.toContain("croft run support_tickets");
    const describeOld = await p.json(["describe", "tickets"]);
    expect(codes(describeOld.json)).toContain("ASSET_RENAMED");

    // Adopt: the old table, cursor and history become support_tickets; the API sees nothing.
    const before = api.requests(path).length;
    const adopt = await p.json(["rename", "tickets", "support_tickets"]);
    expect(adopt.code, show(adopt)).toBe(0);
    expect(adopt.json.data).toMatchObject({
      from: "tickets", to: "support_tickets", mode: "adopt",
      file: { to: "assets/support_tickets.ts", moved: false }, table: { renamed: true, rows: 3 }, references: [],
    });
    expect(api.requests(path).length).toBe(before);

    const after = await p.json(["status"]);
    expect(codes(after.json)).not.toContain("ASSET_RENAMED");
    expect(assetOf(after.json, "support_tickets")).toMatchObject({ status: "ok", rows: 3 });
    expect(assetOf(after.json, "tickets")).toBeUndefined();
    expect((await p.json(["validate"])).code).toBe(0);
    const d = await p.json(["describe", "support_tickets"]);
    expect(d.json.data.behavior.incremental.cursorValue).toBe(cursor);

    // The next run continues from the adopted cursor.
    state.tickets.push({ id: 4, subject: "Ticket 4", updated_at: "2026-09-20T10:04:00Z" });
    const run = await p.json(["run", "support_tickets"]);
    expect(run.code, show(run)).toBe(0);
    expect(api.requests(path).length).toBe(before + 1);
    expect(Date.parse(api.requests(path).at(-1)!.query.since!)).toBeGreaterThanOrEqual(Date.parse(cursor) - 1000);
    expect(run.json.data.steps[0].rows).toMatchObject({ added: 1, total: 4 });
  }, 180_000);
});
