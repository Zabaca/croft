// Journey 11: kill -9 a run (DESIGN §5 "Crash recovery"): cursors move only on commit, so a crash means
// extraction is redone, never skipped. After the kill, the next command reconciles: the run is crashed, its
// step shows crashed (no commit) or "ok (recovered)" (the commit landed before runs.sqlite heard of it), and
// the table's newest updated_at and the saved cursor agree.
//   a. a real `kill -9` of the detached run process mid-extract (a slow API);
//   b. CROFT_FAULT=before_commit (SIGKILL inside the write transaction), through the default detached path;
//   c. CROFT_FAULT=after_commit_before_sqlite.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { at, githubAsset, githubRoute, issue, type Issue, TOKEN } from "./fixtures.ts";
import { alive, cleanupAll, initProject, type MockApi, mockApi, type Project, show, until } from "./harness.ts";

let api: MockApi;
beforeAll(() => {
  api = mockApi();
});
afterAll(async () => {
  api.stop();
  await cleanupAll();
});

const PATH = "/repos/oven-sh/bun/issues";

async function project(state: { issues: Issue[]; limited: number; delayMs?: number }): Promise<Project> {
  githubRoute(api, state);
  const { project: p } = await initProject();
  p.write("assets/github_issues.ts", githubAsset(api.url));
  p.secret("GITHUB_TOKEN", TOKEN);
  const first = await p.json(["run", "github_issues"]);
  if (first.code !== 0) throw new Error(show(first));
  return p;
}

/** The saved cursor and the table's newest updated_at name the same instant; returns both and the row count. */
async function agree(p: Project): Promise<{ cursor: string; rows: number }> {
  const d = await p.json(["describe", "github_issues"]);
  expect(d.code, show(d)).toBe(0);
  const cursor = d.json.data.behavior.incremental.cursorValue as string;
  const [row] = await p.rows("select max(updated_at) mx, count(*) n from github_issues");
  expect(Date.parse(String(row!.mx))).toBe(Date.parse(cursor));
  return { cursor, rows: Number(row!.n) };
}

/** A run's steps as `croft logs <run-id> --json` reports them. */
async function stepsOf(p: Project, runId: string): Promise<{ status: string; reason: string | null; error: { code: string } | null }[]> {
  const r = await p.json(["logs", runId]);
  expect(r.code, show(r)).toBe(0);
  return r.json.data.steps;
}

describe("journey 11: crashes", () => {
  test("a. kill -9 of the detached run mid-extract: nothing lands; the next run reconciles and redoes the work", async () => {
    const state = { issues: [1, 2, 3, 4].map((id) => issue(id, id)), limited: 0, delayMs: 0 };
    const p = await project(state);
    expect(await agree(p)).toEqual({ cursor: at(4), rows: 4 });

    for (let id = 5; id <= 12; id++) state.issues.push(issue(id, id));
    state.delayMs = 700;
    const n0 = api.requests(PATH).length;
    const parent = await p.json(["run", "github_issues", "--follow", "0.3s"]);
    expect(parent.code, show(parent)).toBe(6);
    const runId = parent.json.data.runId as string;
    await until(() => api.requests(PATH).length > n0);
    const st = await p.json(["status"]);
    const running = st.json.data.running.find((x: { runId: string }) => x.runId === runId);
    expect(running, show(st)).toBeDefined();
    process.kill(running.pid, "SIGKILL");
    await until(() => !alive(running.pid));
    state.delayMs = 0;

    // Read-only commands see the dead process at once.
    const st2 = await p.json(["status"]);
    expect(st2.json.data.running).toEqual([]);
    const sa = st2.json.data.assets.find((a: { asset: string }) => a.asset === "github_issues");
    expect(sa.lastRun, show(st2)).toMatchObject({ runId, status: "crashed" });
    const waited = await p.json(["wait", runId, "--timeout", "5s"]);
    expect(waited.code, show(waited)).toBe(1);
    expect(waited.json.data.status).toBe("crashed");
    // Nothing landed and the cursor did not move.
    expect(await agree(p)).toEqual({ cursor: at(4), rows: 4 });

    // The next run reconciles the dead run and fetches from the old cursor again.
    const n1 = api.requests(PATH).length;
    const next = await p.json(["run", "github_issues"]);
    expect(next.code, show(next)).toBe(0);
    expect(api.requests(PATH)[n1]!.query.since).toBe("2026-09-20T10:03:59Z");
    expect(next.json.data.steps[0].rows).toMatchObject({ added: 8, total: 12 });
    const steps = await stepsOf(p, runId);
    expect(steps[0]).toMatchObject({ status: "crashed" });
    expect(steps[0]!.error?.code).toBe("RUN_CRASHED");
    const runs = await p.json(["logs", "--runs"]);
    expect(runs.json.data.runs.find((r: { runId: string }) => r.runId === runId)).toMatchObject({ status: "crashed" });
    expect(await agree(p)).toEqual({ cursor: at(12), rows: 12 });
  }, 120_000);

  test("b. SIGKILL inside the write transaction (CROFT_FAULT=before_commit), off a TTY: the parent reports the crash; nothing lands", async () => {
    const state = { issues: [1, 2, 3].map((id) => issue(id, id)), limited: 0 };
    const p = await project(state);
    state.issues.push(issue(4, 4), issue(5, 5));
    const killed = await p.json(["run", "github_issues", "--follow", "30s"], { env: { CROFT_FAULT: "before_commit" } });
    // The parent survives its child and reports what happened, without waiting out --follow.
    expect(killed.code, show(killed)).toBe(1);
    expect(killed.ms).toBeLessThan(25_000);
    expect(killed.json.data.status).toBe("crashed");
    const runId = killed.json.data.runId as string;
    expect(await agree(p)).toEqual({ cursor: at(3), rows: 3 });

    const next = await p.json(["run", "github_issues"]);
    expect(next.code, show(next)).toBe(0);
    expect(next.json.data.steps[0].rows).toMatchObject({ added: 2, total: 5 });
    const steps = await stepsOf(p, runId);
    expect(steps[0]).toMatchObject({ status: "crashed" });
    expect(await agree(p)).toEqual({ cursor: at(5), rows: 5 });
  }, 120_000);

  test("c. SIGKILL after the commit, before runs.sqlite (CROFT_FAULT=after_commit_before_sqlite): recovered as ok", async () => {
    const state = { issues: [1, 2].map((id) => issue(id, id)), limited: 0 };
    const p = await project(state);
    state.issues.push(issue(3, 3));
    const killed = await p.json(["run", "github_issues", "--follow", "30s"], { env: { CROFT_FAULT: "after_commit_before_sqlite" } });
    expect(killed.code, show(killed)).toBe(1);
    const runId = killed.json.data.runId as string;
    // DuckDB is authoritative: the commit landed with its cursor.
    expect(await agree(p)).toEqual({ cursor: at(3), rows: 3 });

    // Any writing command reconciles; a run of the same asset finds nothing new.
    const next = await p.json(["run", "github_issues"]);
    expect(next.code, show(next)).toBe(0);
    expect(next.json.data.steps[0].rows).toMatchObject({ added: 0, updated: 0, total: 3 });
    const steps = await stepsOf(p, runId);
    expect(steps[0]).toMatchObject({ status: "ok", reason: "requested (recovered)" });
    expect(await agree(p)).toEqual({ cursor: at(3), rows: 3 });
  }, 120_000);
});
