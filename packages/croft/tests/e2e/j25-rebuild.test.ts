// Journey 25: croft run --rebuild (DESIGN.md §4.1, §6 "Destructive operations need confirmation", §8 "What a code
// change does", "Backfills"). What a rebuild costs decides whether it asks:
//   a. an ingest: a token (exit 5) before anything is fetched; croft confirm moves the table to the trash, then
//      refetches from scratch (no cursor), so a record the source no longer has is gone and croft restore can bring
//      the old table back; the dry run shows the same confirmation and offers no run;
//   b. an incremental TS transform that pays per row: its code changed, status names the rebuild as a human's
//      decision; the rebuild asks once, and that one token covers both the trash and the cost guard (LARGE_REPROCESS);
//      the confirmed run pays for every input row once with the new code;
//   c. an SQL transform: recomputed from its inputs with no token and nothing in the trash;
//   d. a bare --rebuild, a pattern, or --rebuild with --from: USAGE_ERROR (exit 2), nothing runs (d2, a reported bug:
//      those refusals carry a hint but no fix).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  bugTest, cleanupAll, codes, destructiveNext, type Envelope, findProblem, initProject, json, type MockApi, mockApi, type Project, show, stepOf,
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

interface Issue { id: number; title: string; state: string; updated_at: string }

const at = (min: number) => `2026-09-20T10:${String(min).padStart(2, "0")}:00Z`;
const issue = (id: number, o: Partial<Issue> = {}): Issue => ({ id, title: `Issue ${id}`, state: id % 2 ? "open" : "closed", updated_at: at(id), ...o });

const issuesAsset = (url: string) => `import { ingest } from "@zabaca/croft";

type Issue = { id: number; updated_at: string };

export default ingest({
  description: "Issues from the tracker",
  key: "id",
  incremental: "updated_at",
  async *rows({ since, http }) {
    const res = await http.get("${url}", { query: { since } });
    yield res.json<Issue[]>();
  },
});
`;

const OPEN_SQL = `-- description: the open issues
-- key: id
SELECT id, title FROM issues WHERE state = 'open'
`;

/** One paid "LLM" call per new input row (§3e's shape), with a prompt version the mock records. */
const labelsAsset = (url: string, prompt: string) => `import { transform } from "@zabaca/croft";

type Issue = { id: number; title: string };

export default transform({
  description: "An LLM label for every issue",
  inputs: ["issues"],
  key: "issue_id",
  incremental: true,
  confirmAbove: 5,
  async *rows({ newRows, http }) {
    for await (const issue of newRows<Issue>("issues")) {
      const res = await http.post("${url}", { id: issue.id, prompt: "${prompt}" });
      yield { issue_id: issue.id, label: res.json<{ label: string }>().label };
    }
  },
});
`;

interface Tracker { p: Project; state: { issues: Issue[] }; path: string }

/** A project whose issues ingest reads the mock tracker under `prefix` (ascending by updated_at, since inclusive). */
async function tracker(prefix: string, issues: Issue[]): Promise<Tracker> {
  const state = { issues };
  const path = `${prefix}/issues`;
  api.route(path, (_req, url) => {
    const since = url.searchParams.get("since");
    return json([...state.issues].sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))
      .filter((r) => !since || Date.parse(r.updated_at) >= Date.parse(since)));
  });
  const { project: p } = await initProject();
  p.remove("assets/example_sales.ts");
  p.write("assets/issues.ts", issuesAsset(`${api.url}${path}`));
  return { p, state, path };
}

describe("journey 25: --rebuild", () => {
  test("a. an ingest: a token first; confirm trashes the table and refetches from scratch; c. SQL needs no token", async () => {
    const { p, state, path } = await tracker("/a", [1, 2, 3, 4].map((id) => issue(id)));
    p.write("assets/open_issues.sql", OPEN_SQL);
    const first = await p.json(["run"]);
    expect(first.code, show(first)).toBe(0);

    // The source lost issue 1 (deleted upstream) and gained issue 5. A normal run fetches only what is new since the
    // cursor, so issue 1 would stay forever; a rebuild from scratch is the only way to drop it.
    state.issues = [2, 3, 4, 5].map((id) => issue(id));
    const normal = await p.json(["run", "issues"]);
    expect(normal.code, show(normal)).toBe(0);
    expect(await p.rows("select id::INT AS id from issues order by id")).toEqual([1, 2, 3, 4, 5].map((id) => ({ id })));

    // The dry run shows what --rebuild would trash and confirm, asks nothing, and offers no run.
    const dry = await p.json(["run", "issues", "--rebuild", "--dry-run"]);
    expect(dry.code, show(dry)).toBe(0);
    const planned = stepOf(dry.json, "issues");
    expect(planned.confirmation).toMatchObject({ action: "rebuild", command: "croft run issues --rebuild", impact: { asset: "issues", rows: 5 } });
    expect(planned.window ?? null).toBeNull();
    expect(destructiveNext(dry.json)).toEqual([]);

    // Off a TTY: exit 5 with a token; nothing is fetched and nothing changes.
    const before = api.requests(path).length;
    const asked = await p.json(["run", "issues", "--rebuild"]);
    expect(asked.code, show(asked)).toBe(5);
    const c = asked.json.confirmation;
    expect(c).toMatchObject({ command: "croft run issues --rebuild", impact: { asset: "issues", action: "ingest; --rebuild refetches from scratch", rows: 5 } });
    expect(c.impact.downstream).toEqual(["open_issues"]);
    expect(String(c.impact.trashPath)).toContain(join(".croft", "trash", "issues"));
    const needs = findProblem(asked.json, "CONFIRMATION_REQUIRED");
    expect(needs?.fix).toMatchObject({ kind: "manual", requiresHuman: true });
    expect(needs?.hint ?? "").toContain(`croft confirm ${c.token}`);
    expect(stepOf(asked.json, "issues")).toMatchObject({ status: "skipped", reason: "needs confirmation" });
    expect(destructiveNext(asked.json)).toEqual([]);
    expect(api.requests(path).length).toBe(before);
    expect(trashVersions(p, "issues")).toEqual([]);
    expect(await p.rows("select count(*)::INT AS n from issues")).toEqual([{ n: 5 }]);

    // croft confirm: the old table goes to the trash, then everything is fetched again with no cursor.
    const done = await p.json(["confirm", c.token]);
    expect(done.code, show(done)).toBe(0);
    expect(done.json.data).toMatchObject({ token: c.token, outcome: "used" });
    const rebuilt = stepOf(done.json, "issues");
    expect(rebuilt).toMatchObject({ status: "ok", rows: { total: 4 }, trashed: { rows: 5 } });
    expect(rebuilt.reason).toContain("from scratch (--rebuild)");
    const refetch = api.requests(path).slice(before);
    expect(refetch).toHaveLength(1);
    expect(refetch[0]!.query.since).toBeUndefined();
    expect(await p.rows("select id::INT AS id from issues order by id")).toEqual([2, 3, 4, 5].map((id) => ({ id })));
    // Downstream rebuilt in the same run; the old table waits in the trash.
    expect(stepOf(done.json, "open_issues")).toMatchObject({ status: "ok" });
    expect(await p.rows("select id::INT AS id from open_issues order by id")).toEqual([{ id: 3 }, { id: 5 }]);
    expect(trashVersions(p, "issues")).toHaveLength(1);
    const list = await p.json(["restore"]);
    expect(list.json.data.versions).toEqual([expect.objectContaining({ asset: "issues", kind: "table", rows: 5 })]);
    expect(list.json.data.versions[0].reason).toContain("--rebuild");
    const d = await p.json(["describe", "issues"]);
    expect(Date.parse(d.json.data.behavior.incremental.cursorValue)).toBe(Date.parse(at(5)));

    // c. An SQL transform is recomputed from its inputs: no token, nothing in the trash.
    const sql = await p.json(["run", "open_issues", "--rebuild"]);
    expect(sql.code, show(sql)).toBe(0);
    expect(sql.json.confirmation).toBeUndefined();
    expect(stepOf(sql.json, "open_issues")).toMatchObject({ status: "ok", reason: "requested; from scratch (--rebuild)" });
    expect(stepOf(sql.json, "open_issues").trashed).toBeUndefined();
    expect(trashVersions(p, "open_issues")).toEqual([]);
    expect(codes(sql.json)).not.toContain("CONFIRMATION_REQUIRED");
  }, 180_000);

  test("b. an incremental TS transform that pays per row: one token covers the trash and the cost guard", async () => {
    const { p, state } = await tracker("/b", [1, 2, 3, 4].map((id) => issue(id)));
    const calls: { id: number; prompt: string }[] = [];
    const llm = "/b/v1/label";
    api.route(llm, async (req) => {
      const body = (await req.json()) as { id: number; prompt: string };
      calls.push(body);
      return json({ label: `${body.prompt}:${body.id % 2 ? "bug" : "feature"}` });
    });
    p.write("assets/issue_labels.ts", labelsAsset(`${api.url}${llm}`, "v1"));
    const first = await p.json(["run"]);
    expect(first.code, show(first)).toBe(0);
    expect(calls).toHaveLength(4);
    // Three more issues: only they are paid for.
    state.issues.push(issue(5), issue(6), issue(7));
    expect((await p.json(["run"])).code).toBe(0);
    expect(calls).toHaveLength(7);

    // A new prompt applies to new rows only; status names the rebuild as a person's decision, never as next.
    p.write("assets/issue_labels.ts", labelsAsset(`${api.url}${llm}`, "v2"));
    const st = await p.json(["status"]);
    const edited = findProblem(st.json, "EDITED_SINCE_LAST_RUN");
    expect(edited, show(st)).toBeDefined();
    expect(edited!.message).toContain("7 rows were built by older code; to redo them: croft run issue_labels --rebuild");
    expect(edited!.fix).toMatchObject({ kind: "manual", requiresHuman: true });
    expect(destructiveNext(st.json)).toEqual([]);

    // The rebuild would pay for 7 rows, more than confirmAbove (5): one confirmation, naming both.
    const asked = await p.json(["run", "issue_labels", "--rebuild"]);
    expect(asked.code, show(asked)).toBe(5);
    const c = asked.json.confirmation;
    expect(c).toMatchObject({
      command: "croft run issue_labels --rebuild",
      impact: { asset: "issue_labels", action: "incremental transform; --rebuild processes every input row again", rows: 7, estimatedRequests: 7 },
    });
    expect(findProblem(asked.json, "CONFIRMATION_REQUIRED")!.message).toContain("every input row is processed again (about 7");
    expect(codes(asked.json)).not.toContain("LARGE_REPROCESS");
    expect(calls).toHaveLength(7);
    expect(destructiveNext(asked.json)).toEqual([]);

    // Confirmed: the old labels go to the trash, every issue is labeled again with the new prompt, and the cost guard
    // does not ask a second time.
    const done = await p.json(["confirm", c.token]);
    expect(done.code, show(done)).toBe(0);
    expect(done.json.data.outcome).toBe("used");
    expect(done.json.data.result.confirmation).toBeUndefined();
    expect(stepOf(done.json, "issue_labels")).toMatchObject({ status: "ok", requests: 7, rows: { total: 7 }, trashed: { rows: 7 } });
    expect(calls.slice(7).map((x) => x.prompt)).toEqual(Array(7).fill("v2"));
    expect(calls.slice(7).map((x) => x.id).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(await p.rows("select distinct split_part(label, ':', 1) AS v from issue_labels")).toEqual([{ v: "v2" }]);
    expect(trashVersions(p, "issue_labels")).toHaveLength(1);
    // Nothing is left to process, and nothing is left edited.
    const after = await p.json(["run", "issue_labels"]);
    expect(after.code, show(after)).toBe(0);
    expect(calls).toHaveLength(14);
    expect(findProblem((await p.json(["status"])).json, "EDITED_SINCE_LAST_RUN")).toBeUndefined();
  }, 180_000);

  test("d. a bare --rebuild, a pattern, --rebuild with --from: USAGE_ERROR, nothing runs", async () => {
    const { p, path } = await tracker("/d", [issue(1)]);
    expect((await p.json(["run"])).code).toBe(0);
    const before = api.requests(path).length;
    for (const [args, message] of REFUSED) {
      const r = await p.json(args);
      expect(r.code, show(r)).toBe(2);
      const u = findProblem(r.json, "USAGE_ERROR");
      expect(u?.message, show(r)).toBe(message);
      expect(u!.hint, show(r)).toContain("croft run <asset> --rebuild");
      expect(r.json.confirmation).toBeUndefined();
      expect(destructiveNext(r.json)).toEqual([]);
    }
    expect(api.requests(path).length).toBe(before);
    const runs = await p.json(["logs", "--runs"]);
    expect(runs.json.data.runs).toHaveLength(1);
  }, 120_000);

  // Every problem carries a fix (§9 "Error design"); these three refusals have a hint only.
  bugTest("d2. every --rebuild refusal carries a fix, and none is a destructive command", async () => {
    const { p } = await tracker("/d2", [issue(1)]);
    for (const [args] of REFUSED) {
      const r = await p.json(args);
      const fix = findProblem(r.json, "USAGE_ERROR")!.fix;
      expect(fix, show(r)).toBeDefined();
      if (fix.kind === "command") expect(fix.command).not.toMatch(/--rebuild|croft confirm/);
    }
  }, 120_000);
});

const REFUSED: [string[], string][] = [
  [["run", "--rebuild"], "--rebuild takes the names of the assets to build from scratch"],
  [["run", "iss*", "--rebuild"], "--rebuild takes exact asset names, not a glob (iss*)"],
  [["run", "issues", "--rebuild", "--from", "-1d"], "--rebuild and --from do not go together"],
];
