// croft preview's engine (run/preview.ts): each test runs real `croft run`s in a child process to make the live
// warehouse, then previews in this process, and reads both databases back through child `croft query` calls, so
// the warehouse is never opened in two access modes by one process.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { exitCodeFor } from "../core/errors.ts";
import type { PreviewAsset } from "../core/types.ts";
import { RunsDb } from "../history/runs-db.ts";
import { ProjectEnv } from "../project/env.ts";
import { cleanup as cleanupHolders, spawnHolder } from "../read/testkit.ts";
import { loadProject } from "../project/root.ts";
import { capRows, previewDatabasePath, runPreview, type PreviewInput } from "./preview.ts";
import { cleanupProjects, MAIN, makeProject, writeFiles } from "./testkit.ts";

// ---------------------------------------------------------------------------------------------------------
// A mock API: GitHub-like issues (ascending by updated_at, inclusive since) and a per-row "LLM" that counts calls.

interface Issue { id: number; title: string; state: string; updated_at: string }
const at = (min: number) => `2026-09-20T10:${String(min).padStart(2, "0")}:00Z`;
const issue = (id: number, min: number, extra: Partial<Issue> = {}): Issue => ({ id, title: `Issue ${id}`, state: "open", updated_at: at(min), ...extra });

interface Api { url: string; issues: Issue[]; calls: number; previews: boolean[]; sinces: (string | null)[]; stop(): void }
let api: Api;

beforeAll(() => {
  const state = { issues: [] as Issue[], calls: 0, previews: [] as boolean[], sinces: [] as (string | null)[] };
  const server: Server<undefined> = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/issues") {
        const since = u.searchParams.get("since");
        state.sinces.push(since);
        const rows = [...state.issues].sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id - b.id)
          .filter((r) => since === null || Date.parse(r.updated_at) >= Date.parse(since));
        return Response.json(rows);
      }
      if (u.pathname === "/classify") {
        state.calls++;
        const body = await req.json() as { title: string; preview: boolean };
        state.previews.push(body.preview);
        return Response.json({ label: body.title.includes("crash") ? "bug" : "other" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  api = Object.assign(state, { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }) as Api;
});

afterAll(() => {
  api.stop();
  cleanupHolders();
  cleanupProjects();
});

const ISSUES = () => `import { ingest } from "@zabaca/croft";
export default ingest({
  key: "id",
  incremental: "updated_at",
  checks: ["not_null(title)"],
  async *rows({ since, http }) {
    const res = await http.get("${api.url}/issues", { query: { since } });
    yield res.json<Record<string, unknown>[]>();
  },
});
`;

const TRIAGE = (label = "res.json<{ label: string }>().label") => `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["issues"],
  key: "id",
  incremental: true,
  async *rows({ newRows, http, preview }) {
    for await (const r of newRows<{ id: number; title: string }>("issues")) {
      const res = await http.post("${api.url}/classify", { title: r.title, preview });
      yield { id: r.id, label: ${label} };
    }
  },
});
`;

const OPEN = `-- key: id
-- check: not_null(title)
SELECT id, title FROM issues WHERE state = 'open'
`;

const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", TMPDIR: process.env.TMPDIR ?? "/tmp", NO_COLOR: "1",
  TZ: "America/Los_Angeles", CROFT_FORBID_OS_JOBS: "1", CROFT_NOTIFY_DRY: "1", CROFT_RETRY_DELAYS: "10,20" };

/** croft in a child process (off a TTY): the live warehouse's writer and every reader after a preview. */
async function croft(root: string, args: string[]): Promise<{ code: number; json: any; stdout: string; stderr: string }> {
  const p = Bun.spawn([process.execPath, MAIN, ...args, "--json"], { cwd: root, env: ENV, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  let json: unknown = null;
  try { json = JSON.parse(stdout); } catch { /* the test shows stdout */ }
  return { code, json, stdout, stderr };
}

async function run(root: string, ...args: string[]): Promise<any> {
  const r = await croft(root, ["run", ...args, "--foreground"]);
  if (r.code !== 0) throw new Error(`croft run failed (${r.code}): ${r.stdout}\n${r.stderr}`);
  return r.json;
}

async function rows(root: string, sql: string, o: { preview?: boolean } = {}): Promise<Record<string, unknown>[]> {
  const r = await croft(root, ["query", sql, "--limit", "1000", ...(o.preview ? ["--preview"] : [])]);
  if (r.code !== 0) throw new Error(`croft query failed (${r.code}): ${r.stdout}\n${r.stderr}`);
  return r.json.data.rows;
}

function preview(root: string, selectors: string[], o: Partial<PreviewInput> = {}) {
  const project = loadProject({ root });
  return runPreview({ project, env: ProjectEnv.load(root, {}), selectors, http: { retryBaseMs: 5 }, ...o });
}

const byName = (assets: PreviewAsset[], name: string) => assets.find((a) => a.asset === name)!;

/** The code hash the scheduler may run for `asset` (live runs.sqlite). */
function approved(root: string, asset: string): string | null {
  const db = RunsDb.open(loadProject({ root }).paths.stateDir);
  try {
    return db.approvedCode(asset);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------------------------------------

describe("capRows: at most --rows rows of a source", () => {
  const drain = async (s: unknown) => {
    const out: unknown[] = [];
    for await (const v of s as AsyncIterable<unknown>) out.push(v);
    return out;
  };

  test("arrays are cut at the cap, the generator is stopped, and the cap is reported", async () => {
    let stopped = false;
    let asked = 0;
    async function* source() {
      try {
        for (let i = 0; i < 10; i++) {
          asked++;
          yield [i * 2, i * 2 + 1];
        }
      } finally {
        stopped = true;
      }
    }
    let capped = false;
    expect(await drain(capRows(source(), 3, () => { capped = true; }))).toEqual([[0, 1], [2]]);
    expect(capped).toBe(true);
    expect(stopped).toBe(true);
    expect(asked).toBe(2);
  });

  test("single rows, a sync iterable and a promised array; a source with fewer rows is not capped", async () => {
    let capped = 0;
    const onCap = () => { capped++; };
    expect(await drain(capRows([{ a: 1 }, { a: 2 }, { a: 3 }], 2, onCap))).toEqual([{ a: 1 }, { a: 2 }]);
    expect(await drain(capRows(Promise.resolve([{ a: 1 }, { a: 2 }, { a: 3 }]), 1, onCap))).toEqual([[{ a: 1 }]]);
    expect(capped).toBe(2);
    expect(await drain(capRows([{ a: 1 }], 5, onCap))).toEqual([{ a: 1 }]);
    expect(await drain(capRows(Promise.resolve([{ a: 1 }]), 5, onCap))).toEqual([[{ a: 1 }]]);
    expect(capped).toBe(2);
  });

  test("anything that is not a source passes through for writeStage to report", () => {
    expect(capRows("rows", 5, () => {})).toBe("rows");
    expect(capRows(null, 5, () => {})).toBeNull();
    expect(capRows(42, 5, () => {})).toBe(42);
  });
});

describe("croft preview: SQL", () => {
  test("builds the edited SQL against live snapshots, diffs it by key, and changes nothing real", async () => {
    api.issues = [issue(1, 1), issue(2, 2, { state: "closed" }), issue(3, 3), issue(4, 4)];
    const root = makeProject({ "assets/issues.ts": ISSUES(), "assets/open_issues.sql": OPEN, "assets/titles.sql": "-- key: id\nSELECT id, upper(title) AS t FROM open_issues\n" });
    await run(root);
    const dbFile = loadProject({ root }).paths.database;
    const before = statSync(dbFile).mtimeMs;
    const approvedBefore = approved(root, "open_issues");
    writeFiles(root, { "assets/open_issues.sql": `-- key: id
-- check: not_null(title)
SELECT id, title || '!' AS title, length(title) AS n FROM issues WHERE state = 'open' AND id <> 4
` });
    const out = await preview(root, ["open_issues"]);
    expect(out.problems.filter((p) => p.severity === "error")).toEqual([]);
    const a = byName(out.data.assets, "open_issues");
    expect(a).toMatchObject({ kind: "sql", status: "ok", rows: 2, liveRows: 3, partial: false, capped: false });
    expect(a.diff).toEqual({ by: ["id"], added: 0, removed: 1, changed: 2, unchanged: 0 });
    expect(a.columns).toEqual([{ column: "n", change: "added", type: "BIGINT", note: "new" }]);
    expect(a.checks.map((c) => [c.check, c.ok])).toEqual([["unique(id)", true], ["not_null(id)", true], ["not_null(title)", true]]);
    expect(a.sample[0]).toMatchObject({ id: 1, title: "Issue 1!", n: 7 });
    // SQL downstream of it is built from its preview.
    const t = byName(out.data.assets, "titles");
    expect(t).toMatchObject({ status: "ok", rows: 2, liveRows: 3, diff: { by: ["id"], added: 0, removed: 1, changed: 2, unchanged: 0 } });
    expect(t.reason).toContain("the preview of open_issues");
    expect(out.data).toMatchObject({ partial: false, rebuild: false, rowCap: 1000 });
    expect(out.data.inputsSnapshotAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$/);
    expect(out.built).toEqual(["open_issues", "titles"]);
    expect(out.apply).toEqual(["open_issues"]);

    // Nothing real changed: the warehouse file, its table, and the live catalog mirror.
    expect(statSync(dbFile).mtimeMs).toBe(before);
    expect(await rows(root, "select id, title from open_issues order by id")).toEqual([{ id: 1, title: "Issue 1" }, { id: 3, title: "Issue 3" }, { id: 4, title: "Issue 4" }]);
    const live = RunsDb.open(loadProject({ root }).paths.stateDir);
    try {
      const entry = live.catalogGet<{ rows: number }>("open_issues")!;
      expect(entry.source).toBe("run");
      expect(entry.value.rows).toBe(3);
    } finally {
      live.close();
    }
    // A human-initiated preview approves the code it ran (the scheduler hold, §6).
    expect(approvedBefore).not.toBeNull();
    expect(approved(root, "open_issues")).not.toBeNull();
    expect(approved(root, "open_issues")).not.toBe(approvedBefore);
    // The preview's own catalog, with source "preview".
    const pr = RunsDb.open(join(loadProject({ root }).paths.stateDir, "preview"));
    try {
      expect(pr.catalogGet("open_issues")?.source).toBe("preview");
    } finally {
      pr.close();
    }
    // query --preview reads the preview; the live version sits in the live schema.
    expect(await rows(root, "select id, title, n from open_issues order by id", { preview: true })).toEqual([{ id: 1, title: "Issue 1!", n: 7 }, { id: 3, title: "Issue 3!", n: 7 }]);
    expect(await rows(root, "select count(*) as n from live.open_issues", { preview: true })).toEqual([{ n: 3 }]);
    expect(await rows(root, "select count(*) as n from issues", { preview: true })).toEqual([{ n: 4 }]);
  }, 60_000);

  test("a failing blocking check fails the asset like a run would (exit 3), and keeps its table to explore", async () => {
    api.issues = [issue(1, 1), issue(2, 2)];
    const root = makeProject({ "assets/issues.ts": ISSUES(), "assets/open_issues.sql": OPEN });
    await run(root);
    const approvedBefore = approved(root, "open_issues");
    writeFiles(root, { "assets/open_issues.sql": "-- key: id\n-- check: title <> 'Issue 2'\n-- warn: id > 1\nSELECT id, title FROM issues\n" });
    const out = await preview(root, ["open_issues"]);
    const a = byName(out.data.assets, "open_issues");
    expect(a.status).toBe("failed");
    expect(a.error).toMatchObject({ code: "CHECK_FAILED", asset: "open_issues", file: "assets/open_issues.sql" });
    expect(a.error!.hint).toContain("croft preview open_issues");
    expect(a.checks.find((c) => c.check === "title <> 'Issue 2'")).toMatchObject({ ok: false, failing: 1 });
    expect(a.checks.find((c) => c.check === "id > 1")).toMatchObject({ ok: false, failing: 1 });
    expect(exitCodeFor(out.problems)).toBe(3);
    expect(out.problems.find((p) => p.code === "CHECK_FAILED" && p.severity === "warning")).toBeDefined();
    expect(out.apply).toEqual([]);
    expect(out.next[0]!.command).toBe("croft preview open_issues");
    expect(await rows(root, "select id from open_issues where title = 'Issue 2'", { preview: true })).toEqual([{ id: 2 }]);
    // A failed preview approves nothing.
    expect(approved(root, "open_issues")).toBe(approvedBefore);
  }, 60_000);

  test("an input with no table skips the asset with INPUT_NOT_BUILT and the preview that builds it; nothing is created", async () => {
    const root = makeProject({ "assets/issues.ts": ISSUES(), "assets/open_issues.sql": OPEN });
    const out = await preview(root, ["open_issues"]);
    const a = byName(out.data.assets, "open_issues");
    expect(a).toMatchObject({ status: "skipped", reason: "input issues is not built yet", diff: null, rows: null });
    expect(out.problems.find((p) => p.code === "INPUT_NOT_BUILT")).toMatchObject({
      severity: "info", asset: "open_issues", fix: { kind: "command", command: "croft preview issues open_issues" },
    });
    expect(existsSync(loadProject({ root }).paths.database)).toBe(false);
    expect(out.apply).toEqual([]);
  }, 60_000);

  test("a project that never ran previews an ingest and the SQL on it together; the warehouse is not created", async () => {
    api.issues = [issue(1, 1), issue(2, 2, { state: "closed" }), issue(3, 3)];
    const root = makeProject({ "assets/issues.ts": ISSUES(), "assets/open_issues.sql": OPEN });
    const out = await preview(root, ["issues", "open_issues"]);
    const i = byName(out.data.assets, "issues");
    const o = byName(out.data.assets, "open_issues");
    expect(i).toMatchObject({ kind: "ingest", status: "ok", rows: 3, liveRows: null, capped: false, diff: { added: 3, changed: 0 } });
    expect(i.columns.map((c) => c.column)).toEqual(["id", "title", "state", "updated_at"]);
    expect(o).toMatchObject({ status: "ok", rows: 2, liveRows: null, diff: { by: ["id"], added: 2, removed: 0 } });
    expect(o.reason).toContain("the preview of issues");
    expect(out.data.inputsSnapshotAt).toBeNull();
    expect(existsSync(loadProject({ root }).paths.database)).toBe(false);
    expect(existsSync(previewDatabasePath(loadProject({ root }).paths.stateDir))).toBe(true);
    expect(out.apply).toEqual(["issues", "open_issues"]);
  }, 60_000);
});

describe("croft preview: ingests", () => {
  test("fetches from the saved position, stops at --rows, never moves the cursor, and lists what is downstream", async () => {
    api.issues = [issue(1, 1), issue(2, 2), issue(3, 3)];
    const root = makeProject({ "assets/issues.ts": ISSUES(), "assets/open_issues.sql": OPEN, "assets/triage.ts": TRIAGE() });
    await run(root);
    api.issues.push(issue(4, 5), issue(5, 6), issue(6, 7));
    api.issues[0] = issue(1, 8, { title: "Issue 1 (edited)" });
    api.sinces.length = 0;
    const out = await preview(root, ["issues"], { rows: 2 });
    const a = byName(out.data.assets, "issues");
    expect(api.sinces).toEqual(["2026-09-20T10:02:59Z"]);   // the saved cursor (10:03) minus the 1 s lookback
    expect(a).toMatchObject({ status: "ok", rows: 2, capped: true, partial: true, since: "2026-09-20T10:02:59Z", liveRows: 3 });
    // Rows 3 (unchanged, re-read by the lookback) and 4 (new): cut at 2.
    expect(a.diff).toEqual({ by: ["id"], added: 1, removed: 0, changed: 0, unchanged: 1 });
    expect(a.reason).toContain("stopped at --rows 2");
    expect(a.downstream).toEqual(["open_issues", "triage"]);
    expect(out.built).toEqual(["issues"]);
    // Downstream of an ingest preview is listed, not built.
    expect(out.data.assets.map((x) => x.asset)).toEqual(["issues"]);

    // The live cursor did not move: the next real run asks from the same position and gets everything.
    api.sinces.length = 0;
    const r = await run(root, "issues", "--only");
    expect(api.sinces).toEqual(["2026-09-20T10:02:59Z"]);
    expect(r.data.steps[0].rows).toMatchObject({ added: 3, updated: 1 });
  }, 60_000);

  test("--rebuild fetches an ingest from scratch (no saved position) and compares what it got with live", async () => {
    api.issues = [issue(1, 1), issue(2, 2), issue(3, 3)];
    const root = makeProject({ "assets/issues.ts": ISSUES() });
    await run(root);
    api.issues[1] = issue(2, 2, { title: "Issue 2 (edited in place)" });
    api.sinces.length = 0;
    const out = await preview(root, ["issues"], { rebuild: true, rows: 2 });
    expect(api.sinces).toEqual([null]);
    const a = byName(out.data.assets, "issues");
    expect(a.since).toBeUndefined();
    expect(a).toMatchObject({ status: "ok", rows: 2, liveRows: 3, capped: true, partial: true });
    expect(a.diff).toEqual({ by: ["id"], added: 0, removed: 0, changed: 1, unchanged: 1 });
    expect(a.reason).toContain("fetched from scratch (--rebuild)");
  }, 60_000);

  test("a replace ingest that would lose more than half its rows warns that a real run would stop (SHRINK_GUARD)", async () => {
    const asset = (n: number) => `import { ingest } from "@zabaca/croft";
export default ingest({ key: "id", rows() { return Array.from({ length: ${n} }, (_, i) => ({ id: i + 1, v: "x" })); } });
`;
    const root = makeProject({ "assets/things.ts": asset(4) });
    await run(root);
    writeFiles(root, { "assets/things.ts": asset(1) });
    const out = await preview(root, ["things"]);
    const a = byName(out.data.assets, "things");
    expect(a).toMatchObject({ status: "ok", rows: 1, liveRows: 4, capped: false, diff: { by: ["id"], added: 0, removed: 3, changed: 0, unchanged: 1 } });
    expect(out.problems.find((p) => p.code === "SHRINK_GUARD")).toMatchObject({ severity: "warning", asset: "things" });
    expect(exitCodeFor(out.problems)).toBe(0);
  }, 60_000);

  test("a failing ingest fails alone; what reads it is skipped, and the live table is untouched", async () => {
    api.issues = [issue(1, 1)];
    const root = makeProject({ "assets/issues.ts": ISSUES(), "assets/open_issues.sql": OPEN });
    await run(root);
    writeFiles(root, { "assets/issues.ts": `import { ingest } from "@zabaca/croft";
export default ingest({ key: "id", incremental: "updated_at", async *rows() { throw new Error("boom"); } });
` });
    const out = await preview(root, ["issues", "open_issues"]);
    expect(byName(out.data.assets, "issues")).toMatchObject({ status: "failed", error: { code: "ASSET_CODE_ERROR" } });
    expect(byName(out.data.assets, "open_issues")).toMatchObject({ status: "skipped", reason: "input issues failed in this preview" });
    expect(exitCodeFor(out.problems)).toBe(1);
    expect(await rows(root, "select count(*) as n from issues")).toEqual([{ n: 1 }]);
  }, 60_000);
});

describe("croft preview: TS transforms", () => {
  test("an incremental transform processes only its pending rows, capped at --rows, with ctx.preview; positions do not move", async () => {
    api.issues = [issue(1, 1, { title: "crash on start" }), issue(2, 2), issue(3, 3)];
    const root = makeProject({ "assets/issues.ts": ISSUES(), "assets/triage.ts": TRIAGE() });
    await run(root);
    expect(api.calls).toBeGreaterThanOrEqual(3);
    api.issues.push(issue(4, 4, { title: "another crash" }), issue(5, 5), issue(6, 6));
    await run(root, "issues", "--only");
    const calls = api.calls;
    api.previews.length = 0;
    const out = await preview(root, ["triage"], { rows: 2 });
    const a = byName(out.data.assets, "triage");
    expect(api.calls - calls).toBe(2);                     // --rows 2: at most 2 paid calls
    expect(api.previews).toEqual([true, true]);           // ctx.preview
    expect(a).toMatchObject({ kind: "ts", status: "ok", partial: true, capped: true, rows: 2, liveRows: 3 });
    expect(a.diff).toEqual({ by: ["id"], added: 2, removed: 0, changed: 0, unchanged: 0 });
    expect(a.reason).toContain("processed 2 new input rows");
    expect(await rows(root, "select id, label from triage order by id", { preview: true })).toEqual([
      { id: 1, label: "bug" }, { id: 2, label: "other" }, { id: 3, label: "other" }, { id: 4, label: "bug" }, { id: 5, label: "other" },
    ]);
    // The live positions did not move: the next real run processes all 3 new rows.
    const before = api.calls;
    const r = await run(root, "triage");
    expect(api.calls - before).toBe(3);
    expect(r.data.steps.find((s: { asset: string }) => s.asset === "triage").rows).toMatchObject({ added: 3 });
  }, 60_000);

  test("--rebuild builds from scratch and shows drift against the live table", async () => {
    api.issues = [issue(1, 1, { title: "crash" }), issue(2, 2), issue(3, 3)];
    const root = makeProject({ "assets/issues.ts": ISSUES(), "assets/triage.ts": TRIAGE() });
    await run(root);
    writeFiles(root, { "assets/triage.ts": TRIAGE("res.json<{ label: string }>().label.toUpperCase()") });
    const calls = api.calls;
    const out = await preview(root, ["triage"], { rebuild: true });
    const a = byName(out.data.assets, "triage");
    expect(api.calls - calls).toBe(3);
    expect(a).toMatchObject({ status: "ok", partial: false, capped: false, rows: 3, liveRows: 3 });
    expect(a.diff).toEqual({ by: ["id"], added: 0, removed: 0, changed: 3, unchanged: 0 });
    expect(out.data.rebuild).toBe(true);
    // The edited incremental transform carries its warning (the new code applies to new rows only).
    expect(out.problems.map((p) => p.code)).toContain("EDITED_SINCE_LAST_RUN");
  }, 60_000);
});

describe("croft preview: partial previews and what is downstream", () => {
  const THINGS = `import { ingest } from "@zabaca/croft";
export default ingest({ key: "id", rows() { return [1, 2, 3, 4, 5].map((i) => ({ id: i, v: i })); } });
`;
  const DOUBLED = (factor: number) => `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["things"],
  key: "id",
  async *rows({ rows }) {
    for await (const r of rows<{ id: number; v: number }>("things")) yield { id: r.id, twice: r.v * ${factor} };
  },
});
`;
  const SUMMARY = "-- key: n\nSELECT count(*) AS n, sum(twice) AS total FROM doubled\n";

  test("a full-refresh transform with a capped input is partial: only the keys it built count, and SQL on it is not built", async () => {
    const root = makeProject({ "assets/things.ts": THINGS, "assets/doubled.ts": DOUBLED(2), "assets/summary.sql": SUMMARY });
    await run(root);
    writeFiles(root, { "assets/doubled.ts": DOUBLED(3) });
    const out = await preview(root, ["doubled"], { rows: 2 });
    const a = byName(out.data.assets, "doubled");
    expect(a).toMatchObject({ status: "ok", partial: true, capped: true, rows: 2, liveRows: 5 });
    expect(a.diff).toEqual({ by: ["id"], added: 0, removed: 0, changed: 2, unchanged: 0 });
    expect(a.downstream).toEqual(["summary"]);
    expect(out.data.assets.map((x) => x.asset)).toEqual(["doubled"]);
    expect(out.data.partial).toBe(true);
  }, 60_000);

  test("uncapped, SQL downstream of a full-refresh transform is built from its preview", async () => {
    const root = makeProject({ "assets/things.ts": THINGS, "assets/doubled.ts": DOUBLED(2), "assets/summary.sql": SUMMARY });
    await run(root);
    writeFiles(root, { "assets/doubled.ts": DOUBLED(3) });
    const out = await preview(root, ["doubled"]);
    expect(byName(out.data.assets, "doubled")).toMatchObject({ status: "ok", partial: false, diff: { changed: 5, removed: 0 } });
    const s = byName(out.data.assets, "summary");
    expect(s).toMatchObject({ status: "ok", partial: false, rows: 1, liveRows: 1, diff: { by: ["n"], changed: 1 } });
    expect(await rows(root, "select n, total from summary", { preview: true })).toEqual([{ n: 5, total: "45" }]);
    expect(out.apply).toEqual(["doubled"]);
  }, 60_000);
});

describe("croft preview: files", () => {
  test("a CSV ingest's first load says which header it used", async () => {
    const root = makeProject({
      "files/zones.csv": "id,name\n1,Midtown\n2,Harlem\n",
      "assets/zones.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ file: "files/zones.csv", key: "id" });\n`,
    });
    const out = await preview(root, ["zones"]);
    const a = byName(out.data.assets, "zones");
    expect(a).toMatchObject({ status: "ok", rows: 2, liveRows: null });
    expect(a.reason).toContain("CSV header: first line (detected): id, name");
  }, 60_000);
});

describe("croft preview: locks and interrupts", () => {
  test("waits for a program that holds the warehouse, announcing no write intent, then previews", async () => {
    api.issues = [issue(1, 1)];
    const root = makeProject({ "assets/issues.ts": ISSUES(), "assets/open_issues.sql": OPEN });
    await run(root);
    const project = loadProject({ root });
    const holder = spawnHolder(project.paths.database, 2500);
    await holder.waitFor("held");
    const waits: string[] = [];
    const pending = preview(root, ["open_issues"], { onWait: (_h, _ms, what) => waits.push(what) });
    await Bun.sleep(800);
    const intents = join(project.paths.stateDir, "write-intent.d");
    expect(existsSync(intents) ? readdirSync(intents) : []).toEqual([]);
    const out = await pending;
    expect(waits).toContain("the warehouse");
    expect(byName(out.data.assets, "open_issues")).toMatchObject({ status: "ok", rows: 1 });
  }, 60_000);

  test("Ctrl-C interrupts the asset that runs, skips the rest, and exits 130", async () => {
    const root = makeProject({
      "assets/hang.ts": `import { ingest } from "@zabaca/croft";
export default ingest({ key: "id", async *rows({ signal }) { await new Promise((r) => signal.addEventListener("abort", r)); yield [{ id: 1 }]; } });
`,
      "assets/other.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ key: "id", rows() { return [{ id: 1 }]; } });\n`,
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 500);
    const out = await preview(root, ["hang", "other"], { signal: ac.signal });
    expect(byName(out.data.assets, "hang")).toMatchObject({ status: "failed", error: { code: "INTERRUPTED" } });
    expect(byName(out.data.assets, "other")).toMatchObject({ status: "skipped" });
    expect(exitCodeFor(out.problems)).toBe(130);
  }, 60_000);
});
