// Journey 17: TypeScript transforms that call a paid API once per input row (DESIGN.md §3e, §5 "Transforms" and
// "Cost guard", §6 "Destructive operations need confirmation", §8 "What a code change does"). The mock "LLM"
// counts its calls per input row, so every journey proves what was billed and what was not.
//   a. an incremental keyed transform: one call per new or changed input row; an unchanged input and a code
//      edit bill nothing again;
//   b. kill -9 mid-chunk (CROFT_FAULT=mid_chunk): the committed chunk stays and the resume bills only the rows
//      after it, with a one-column and a two-column key; a kill after the chunk was staged re-bills nothing;
//      Ctrl-C keeps the committed chunk;
//   c. a failed check keeps the chunk it staged: once the lookup table the check reads is fixed, the next run
//      commits that chunk without calling the LLM again;
//   d. the cost guard: more pending rows than confirmAbove → exit 5 with a confirmation; a changed impact is
//      CONFIRMATION_STALE; croft confirm runs it; a known LLM SDK counts as making requests;
//   e. an upstream column rename → UNKNOWN_INPUT_COLUMN with a did-you-mean edit fix, before any call;
//   f. a full-refresh transform that makes requests → TRANSFORM_MAKES_REQUESTS from validate.
// Chunks are 500 rows (transform.ts CHUNK; a CLI run cannot shrink it), so the chunk journeys use 800 input rows
// of one ingest write: every row shares one _loaded_at, and positions must use the key to resume.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bugTest, cleanupAll, codes, type Envelope, findProblem, initProject, json, type MockApi, mockApi, type Project, show, until,
} from "./harness.ts";

let api: MockApi;
beforeAll(() => {
  api = mockApi();
});
afterAll(async () => {
  api.stop();
  await cleanupAll();
});

// ---------------------------------------------------------------------------------------------------------
// The mock API: an issue tracker and an "LLM" that labels one issue per call

interface Issue { id?: number; title: string; [column: string]: unknown }

interface Llm {
  url: string;
  /** Calls per issue id. */
  calls: Map<number, number>;
  /** The prompt version each call carried, per issue id. */
  prompts: Map<number, string[]>;
  total(): number;
  times(id: number): number;
  /** Answer the calls for ids above `slowAbove` after `delayMs` (a run is fast enough to finish between polls). */
  slowAbove: number;
  delayMs: number;
}

type Labeler = (body: { id: number; title: string }) => string;

const byParity: Labeler = ({ id }) => (id % 2 ? "bug" : "feature");

function llmRoute(path: string, label: Labeler = byParity): Llm {
  const llm: Llm = {
    url: `${api.url}${path}`,
    calls: new Map(),
    prompts: new Map(),
    total: () => [...llm.calls.values()].reduce((a, b) => a + b, 0),
    times: (id) => llm.calls.get(id) ?? 0,
    slowAbove: Infinity,
    delayMs: 0,
  };
  api.route(path, async (req) => {
    const body = (await req.json()) as { id: number; title: string; prompt?: string };
    llm.calls.set(body.id, llm.times(body.id) + 1);
    llm.prompts.set(body.id, [...(llm.prompts.get(body.id) ?? []), body.prompt ?? ""]);
    if (body.id > llm.slowAbove) await Bun.sleep(llm.delayMs);
    return json({ label: label(body) });
  });
  return llm;
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// ---------------------------------------------------------------------------------------------------------
// Asset sources

const issuesAsset = (url: string, key: string | string[] = "id") => `import { ingest } from "@zabaca/croft";

export default ingest({
  description: "Issues from the tracker",
  key: ${JSON.stringify(key)},
  async *rows({ http }) {
    const res = await http.get("${url}");
    yield res.json<Record<string, unknown>[]>();
  },
});
`;

interface LabelsOptions { llm: string; input?: string; checks?: string[]; confirmAbove?: number; prompt?: string }

/** DESIGN §3e's shape: keyed, incremental, newRows(), one paid call per input row, yielded before the next. */
const labelsAsset = (o: LabelsOptions) => `// assets/issue_labels.ts: one LLM call per issue
import { transform } from "@zabaca/croft";

type Issue = { id: number; title: string };

export default transform({
  description: "An LLM label for every issue",
  inputs: ["${o.input ?? "issues"}"],
  key: "issue_id",
  incremental: true,${o.confirmAbove !== undefined ? `\n  confirmAbove: ${o.confirmAbove},` : ""}${o.checks ? `\n  checks: ${JSON.stringify(o.checks)},` : ""}
  async *rows({ newRows, http }) {
    for await (const issue of newRows<Issue>("${o.input ?? "issues"}")) {
      const res = await http.post("${o.llm}", { id: issue.id, title: issue.title, prompt: "${o.prompt ?? "v1"}" });
      yield { issue_id: issue.id, title: issue.title, label: res.json<{ label: string }>().label };
    }
  },
});
`;

/** A lookup table as an SQL asset (a check subquery reads it). */
const allowedSql = (names: string[]) => `-- description: the labels an issue may get
-- key: name
SELECT * FROM (VALUES ${names.map((n) => `('${n}')`).join(", ")}) AS t(name)
`;

interface Setup { p: Project; state: { issues: Issue[] }; llm: Llm }

/** A project whose `issues` ingest (key id) reads `n` issues from the mock tracker under `prefix`, and an LLM
 *  route next to it. The example asset is removed so bare runs are about these assets only. */
async function setup(prefix: string, n: number, o: { label?: Labeler; issue?: (i: number) => Issue; key?: string | string[] } = {}): Promise<Setup> {
  const state = { issues: range(1, n).map(o.issue ?? ((id) => ({ id, title: `Issue ${id}` }))) };
  api.route(`${prefix}/issues`, () => json(state.issues));
  const llm = llmRoute(`${prefix}/v1/label`, o.label);
  const { project: p } = await initProject();
  p.remove("assets/example_sales.ts");
  p.write("assets/issues.ts", issuesAsset(`${api.url}${prefix}/issues`, o.key));
  return { p, state, llm };
}

/** A step of a run envelope (or of the run a confirm carried out). */
function step(env: Envelope, asset: string): Envelope {
  const steps = (env.data?.steps ?? env.data?.result?.steps ?? []) as Envelope[];
  const s = steps.find((x) => x.asset === asset);
  if (!s) throw new Error(`no step for ${asset} in ${JSON.stringify(env).slice(0, 2000)}`);
  return s;
}

/** Whether the warehouse has a table of this name (the check that "nothing was written" to a new asset). */
async function hasTable(p: Project, name: string): Promise<boolean> {
  const [row] = await p.rows(`select count(*) n from duckdb_tables() where schema_name = 'main' and table_name = '${name}'`);
  return Number(row!.n) === 1;
}

/** 1-based line of the first line of `text` that contains `needle`. */
function lineOf(text: string, needle: string): number {
  const i = text.split("\n").findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`no line with ${needle}`);
  return i + 1;
}

/** Apply an edit fix with a replace, the way an agent does: on the named line only. */
function applyEdit(p: Project, fix: Envelope): void {
  const path = join(p.root, fix.file as string);
  const lines = readFileSync(path, "utf8").split("\n");
  const i = (fix.line as number) - 1;
  expect(lines[i]).toContain(fix.replace.from);
  lines[i] = lines[i]!.replace(new RegExp(`(?<![\\w$])${fix.replace.from}(?![\\w$])`), fix.replace.to);
  writeFileSync(path, lines.join("\n"));
}

// ---------------------------------------------------------------------------------------------------------

describe("journey 17: TypeScript transforms that call a paid API", () => {
  test("a. incremental and keyed: one call per new or changed input row; an unchanged input or a code edit bills nothing again", async () => {
    const { p, state, llm } = await setup("/a", 6);
    p.write("assets/issue_labels.ts", labelsAsset({ llm: llm.url }));

    const v = await p.json(["validate"]);
    expect(v.code, show(v)).toBe(0);
    const order = v.json.data.order as string[];
    expect(order.indexOf("issues")).toBeLessThan(order.indexOf("issue_labels"));
    expect(v.json.data.assets.find((a: { name: string }) => a.name === "issue_labels"))
      .toMatchObject({ kind: "ts", inputs: ["issues"], behavior: "merge by issue_id" });
    // The per-row shape the warning asks for does not get the warning.
    expect(codes(v.json)).not.toContain("TRANSFORM_MAKES_REQUESTS");

    // A bare run fetches the ingest, then builds the never-built transform: one call per issue.
    const first = await p.json(["run"]);
    expect(first.code, show(first)).toBe(0);
    expect(step(first.json, "issue_labels")).toMatchObject({ status: "ok", requests: 6, rows: { in: 6, added: 6, total: 6 } });
    expect(llm.total()).toBe(6);
    expect(range(1, 6).filter((id) => llm.times(id) !== 1)).toEqual([]);
    expect(await p.rows("select issue_id, label from issue_labels order by issue_id")).toEqual(
      range(1, 6).map((id) => ({ issue_id: id, label: id % 2 ? "bug" : "feature" })));

    // The source did not change: the transform is up to date and nothing is billed.
    const same = await p.json(["run"]);
    expect(same.code, show(same)).toBe(0);
    const skipped = step(same.json, "issue_labels");
    expect(skipped.status, show(same)).toBe("skipped");
    expect(String(skipped.skippedBecause ?? skipped.reason)).toContain("up to date");
    expect(llm.total()).toBe(6);

    // One new issue and one edited title: two calls, for exactly those rows.
    state.issues.push({ id: 7, title: "Issue 7" });
    state.issues[0] = { id: 1, title: "Crash on start" };
    const dry = await p.croft(["run", "--dry-run"]);
    expect(dry.code, show(dry)).toBe(0);
    expect(dry.stdout).toMatch(/update\s+issue_labels\s+input issues/);
    expect(llm.total()).toBe(6);
    const more = await p.croft(["run"]);
    expect(more.code, show(more)).toBe(0);
    expect(more.stdout).toMatch(/ok\s+issue_labels\s+2 requests, 2 rows/);
    expect(llm.total()).toBe(8);
    expect([llm.times(1), llm.times(7)]).toEqual([2, 1]);
    expect(await p.rows("select issue_id, title from issue_labels where issue_id in (1, 7) order by 1"))
      .toEqual([{ issue_id: 1, title: "Crash on start" }, { issue_id: 7, title: "Issue 7" }]);
    const d = await p.json(["describe", "issue_labels"]);
    expect(d.code, show(d)).toBe(0);
    expect(d.json.data.inputsSeen.issues.pendingRows).toBe(0);

    // A code edit (a new prompt) applies to new input rows only (§8): the 7 rows built by the old prompt are
    // not paid for again, and status says so without offering a later phase's --rebuild.
    p.write("assets/issue_labels.ts", labelsAsset({ llm: llm.url, prompt: "v2" }));
    const st = await p.json(["status"]);
    const edited = findProblem(st.json, "EDITED_SINCE_LAST_RUN");
    expect(edited, show(st)).toBeDefined();
    expect(edited!.message).toContain("7 rows were built by older code");
    expect(JSON.stringify(edited)).not.toContain("--rebuild");
    const afterEdit = await p.json(["run"]);
    expect(afterEdit.code, show(afterEdit)).toBe(0);
    expect(llm.total()).toBe(8);
    state.issues.push({ id: 8, title: "Issue 8" });
    const newCode = await p.json(["run"]);
    expect(newCode.code, show(newCode)).toBe(0);
    expect(step(newCode.json, "issue_labels")).toMatchObject({ status: "ok", requests: 1, rows: { in: 1, added: 1, total: 8 } });
    expect(llm.total()).toBe(9);
    expect(llm.prompts.get(8)).toEqual(["v2"]);
    expect(range(1, 7).every((id) => !llm.prompts.get(id)!.includes("v2"))).toBe(true);
  }, 120_000);

  test("b. kill -9 mid-chunk (CROFT_FAULT=mid_chunk): the first chunk stays committed and the resume bills only the rows after it", async () => {
    const { p, llm } = await setup("/b", 800);
    p.write("assets/issue_labels.ts", labelsAsset({ llm: llm.url }));
    // One write: all 800 issues share one _loaded_at, so the position must carry the key to resume.
    const ingest = await p.json(["run", "issues", "--only"]);
    expect(ingest.code, show(ingest)).toBe(0);

    const killed = await p.json(["run", "issue_labels"], { env: { CROFT_FAULT: "mid_chunk" } });
    expect(killed.code, show(killed)).toBe(1);
    expect(killed.json.data.status).toBe("crashed");
    expect(codes(killed.json)).toContain("RUN_CRASHED");
    // The first chunk (500 rows) committed with its position; the rows of the chunk being filled are lost.
    expect(await p.rows("select count(*) n, min(issue_id) lo, max(issue_id) hi from issue_labels")).toEqual([{ n: 500, lo: 1, hi: 500 }]);
    // Rows 1..reached were each billed once before the kill; rows 501..reached were the chunk being filled.
    const billed = llm.total();
    const reached = Math.max(...llm.calls.keys());
    expect(billed).toBe(reached);
    expect(reached).toBeGreaterThan(500);
    expect(reached).toBeLessThan(800);
    const d = await p.json(["describe", "issue_labels"]);
    expect(d.json.data.inputsSeen.issues.pendingRows, show(d)).toBe(300);

    // The transform is stale, so a bare run picks it up and continues after the committed position.
    const resumed = await p.json(["run"]);
    expect(resumed.code, show(resumed)).toBe(0);
    const s = step(resumed.json, "issue_labels");
    expect(s).toMatchObject({ status: "ok", requests: 300, rows: { in: 300, added: 300, total: 800 } });
    expect(await p.rows("select count(*) n, count(distinct issue_id) d from issue_labels")).toEqual([{ n: 800, d: 800 }]);
    // No committed row was billed again: only the lost chunk's rows were paid for twice.
    expect(range(1, 500).filter((id) => llm.times(id) !== 1)).toEqual([]);
    expect(range(1, 800).filter((id) => llm.times(id) === 0)).toEqual([]);
    expect([...llm.calls].filter(([id, n]) => n > 1 && (id <= 500 || id > reached))).toEqual([]);
    expect(llm.total()).toBe(billed + 300);

    // The crashed run's step committed a chunk, so reconcile recovered it as ok (§5 "Crash recovery").
    const logs = await p.json(["logs", killed.json.data.runId]);
    expect(logs.code, show(logs)).toBe(0);
    expect(logs.json.data.steps[0]).toMatchObject({ asset: "issue_labels", status: "ok" });
    expect(logs.json.data.steps[0].reason).toContain("recovered");
  }, 120_000);

  test("b2. a kill inside the chunk's write transaction (CROFT_FAULT=before_commit) re-bills nothing: the next run commits the staged chunk", async () => {
    const { p, llm } = await setup("/b2", 800);
    p.write("assets/issue_labels.ts", labelsAsset({ llm: llm.url }));
    expect((await p.json(["run", "issues", "--only"])).code).toBe(0);

    const killed = await p.json(["run", "issue_labels"], { env: { CROFT_FAULT: "before_commit" } });
    expect(killed.code, show(killed)).toBe(1);
    expect(killed.json.data.status).toBe("crashed");
    expect(await hasTable(p, "issue_labels")).toBe(false);
    expect(llm.total()).toBe(500);

    const resumed = await p.json(["run"]);
    expect(resumed.code, show(resumed)).toBe(0);
    const s = step(resumed.json, "issue_labels");
    expect(s).toMatchObject({ status: "ok", requests: 300, rows: { added: 800, total: 800 } });
    expect(s.reason).toContain("500 rows from a chunk staged earlier");
    expect(llm.total()).toBe(800);
    expect(range(1, 800).filter((id) => llm.times(id) !== 1)).toEqual([]);
  }, 120_000);

  test("b2b. positions over a two-column key: the resume continues where the kill left off, though the numbers restart per repo", async () => {
    // Rows 1-400 are bun#1-400 and rows 401-800 zig#1-400, all at one stamp: the committed chunk ends at zig#100.
    const { p, llm } = await setup("/b2b", 800, {
      key: ["repo", "number"],
      issue: (i) => ({ repo: i <= 400 ? "bun" : "zig", number: ((i - 1) % 400) + 1, title: `Issue ${i}` }),
    });
    p.write("assets/issue_labels.ts", `import { transform } from "@zabaca/croft";

type Issue = { repo: string; number: number; title: string };

export default transform({
  description: "An LLM label for every issue of every repo",
  inputs: ["issues"],
  key: ["repo", "number"],
  incremental: true,
  async *rows({ newRows, http }) {
    for await (const issue of newRows<Issue>("issues")) {
      const id = (issue.repo === "bun" ? 1000 : 2000) + issue.number;
      const res = await http.post("${llm.url}", { id, title: issue.title });
      yield { repo: issue.repo, number: issue.number, label: res.json<{ label: string }>().label };
    }
  },
});
`);
    expect((await p.json(["run", "issues", "--only"])).code).toBe(0);
    const killed = await p.json(["run", "issue_labels"], { env: { CROFT_FAULT: "mid_chunk" } });
    expect(killed.code, show(killed)).toBe(1);
    expect(await p.rows("select repo, count(*) n, max(number) hi from issue_labels group by 1 order by 1"))
      .toEqual([{ repo: "bun", n: 400, hi: 400 }, { repo: "zig", n: 100, hi: 100 }]);
    const billed = llm.total();

    const resumed = await p.json(["run", "issue_labels"]);
    expect(resumed.code, show(resumed)).toBe(0);
    expect(step(resumed.json, "issue_labels")).toMatchObject({ status: "ok", requests: 300, rows: { in: 300, added: 300, total: 800 } });
    const committed = [...range(1001, 1400), ...range(2001, 2100)];
    expect(committed.filter((id) => llm.times(id) !== 1)).toEqual([]);
    expect(range(2101, 2400).filter((id) => llm.times(id) === 0)).toEqual([]);
    expect(llm.total()).toBe(billed + 300);
  }, 120_000);

  test("b3. Ctrl-C of a foreground run keeps the committed chunk and says so; the next run continues after it", async () => {
    const { p, llm } = await setup("/b3", 800);
    p.write("assets/issue_labels.ts", labelsAsset({ llm: llm.url }));
    expect((await p.json(["run", "issues", "--only"])).code).toBe(0);

    // Rows past 520 answer slowly, so the stop lands while the second chunk fills (a call for row 501 is made
    // only once the first chunk has committed).
    llm.slowAbove = 520;
    llm.delayMs = 20;
    const run = p.start(["run", "issue_labels", "--foreground", "--json"]);
    await until(() => llm.calls.size >= 540);
    run.proc.kill("SIGINT");
    const stopped = await run.done;
    llm.slowAbove = Infinity;
    expect(llm.calls.size).toBeLessThan(800);
    expect(stopped.code, show(stopped)).toBe(130);
    const e = findProblem(stopped.json!, "INTERRUPTED");
    expect(e, show(stopped)).toBeDefined();
    expect(e!.details).toMatchObject({ savedRows: 500, savedChunks: 1 });
    expect(e!.effect).toContain("500 rows from 1 earlier chunk were saved");
    expect((await p.rows("select count(*) n from issue_labels"))[0]!.n).toBe(500);
    const billed = llm.total();

    const resumed = await p.json(["run", "issue_labels"]);
    expect(resumed.code, show(resumed)).toBe(0);
    expect(step(resumed.json, "issue_labels")).toMatchObject({ status: "ok", requests: 300, rows: { in: 300, total: 800 } });
    expect(range(1, 500).filter((id) => llm.times(id) !== 1)).toEqual([]);
    expect(llm.total()).toBe(billed + 300);
  }, 120_000);

  // BUG: `croft run` reports the crash (the detached child died), and marks the RUN crashed in runs.sqlite, but
  // leaves its STEPS running (run/detach.ts followRun → markCrashed). status only turns a running step of a
  // dead *running* run into crashed, so until some writing command reconciles, status shows the asset
  // "running (r_…)" with 0 running, healthy: true, and `status --check` exits 0.
  bugTest("b4. right after croft run reports a crash, status says the transform crashed, not running", async () => {
    const { p, llm } = await setup("/b4", 800);
    p.write("assets/issue_labels.ts", labelsAsset({ llm: llm.url }));
    expect((await p.json(["run", "issues", "--only"])).code).toBe(0);
    const killed = await p.json(["run", "issue_labels"], { env: { CROFT_FAULT: "mid_chunk" } });
    expect(killed.code, show(killed)).toBe(1);
    expect(killed.json.data.status).toBe("crashed");

    const st = await p.json(["status"]);
    expect(st.json.data.running).toEqual([]);
    const a = st.json.data.assets.find((x: { asset: string }) => x.asset === "issue_labels");
    expect(a.lastRun, show(st)).toMatchObject({ runId: killed.json.data.runId, status: "crashed" });
    expect(a.status).toBe("crashed");
    expect(st.json.data.healthy).toBe(false);
    const check = await p.croft(["status", "--check"]);
    expect(check.code, show(check)).toBe(1);
    expect(check.stdout).not.toContain("running (r_");
  }, 120_000);

  let checkFailedText: string | undefined;

  test("c. a failed check keeps its staged chunk; after the lookup the check reads is fixed, the next run commits it without calling the LLM again", async () => {
    const { p, llm } = await setup("/c", 6, { label: ({ id }) => (id === 4 ? "question" : id % 2 ? "bug" : "feature") });
    p.write("assets/allowed_labels.sql", allowedSql(["bug", "feature"]));
    p.write("assets/issue_labels.ts", labelsAsset({ llm: llm.url, checks: ["label IN (SELECT name FROM allowed_labels)"] }));

    // A table read in a check's subquery is ordered before the asset (§3f).
    const v = await p.json(["validate"]);
    expect(v.code, show(v)).toBe(0);
    const order = v.json.data.order as string[];
    expect(order.indexOf("allowed_labels")).toBeLessThan(order.indexOf("issue_labels"));

    const failed = await p.json(["run"]);
    expect(failed.code, show(failed)).toBe(3);
    expect(step(failed.json, "allowed_labels").status).toBe("ok");
    const e = findProblem(failed.json, "CHECK_FAILED");
    expect(e, show(failed)).toMatchObject({
      asset: "issue_labels", file: "assets/issue_labels.ts", effect: "nothing was written",
      details: { check: "label IN (SELECT name FROM allowed_labels)", failing: 1 },
    });
    expect(e!.details.sample).toEqual([{ issue_id: 4, title: "Issue 4", label: "question" }]);
    expect(await hasTable(p, "issue_labels")).toBe(false);
    expect(llm.total()).toBe(6);

    // Again with nothing fixed: the staged chunk is committed again and fails the same way; nothing is re-billed.
    const again = await p.croft(["run", "issue_labels"]);
    expect(again.code, show(again)).toBe(3);
    expect(again.stdout).toContain("CHECK_FAILED");
    checkFailedText = again.stdout;
    expect(llm.total()).toBe(6);

    // The fix is in the lookup, not in the paid rows.
    p.write("assets/allowed_labels.sql", allowedSql(["bug", "feature", "question"]));
    const fixed = await p.json(["run"]);
    expect(fixed.code, show(fixed)).toBe(0);
    expect(step(fixed.json, "allowed_labels")).toMatchObject({ status: "ok", rows: { added: 1, total: 3 } });
    const s = step(fixed.json, "issue_labels");
    expect(s).toMatchObject({ status: "ok", requests: 0, rows: { added: 6, total: 6 } });
    expect(s.reason).toContain("6 rows from a chunk staged earlier");
    expect(s.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
    expect(llm.total()).toBe(6);
    expect(await p.rows("select label from issue_labels where issue_id = 4")).toEqual([{ label: "question" }]);
  }, 120_000);

  // BUG (cosmetic, cli/commands/run.ts stepLines): a failed step prints `${code}: ${message}` as is, so the sample
  // rows of a CHECK_FAILED message (lines of their own) start at column 2 instead of under the step, unlike
  // DESIGN §3f's rendering, and they break the column layout of the run's lines.
  bugTest("c2. the human run output keeps CHECK_FAILED's sample rows under the failed step", () => {
    expect(checkFailedText).toBeDefined();
    const lines = checkFailedText!.split("\n");
    const head = lines.findIndex((l) => /^failed\s+issue_labels\s+CHECK_FAILED/.test(l));
    expect(head, checkFailedText).toBeGreaterThanOrEqual(0);
    const indent = lines[head]!.indexOf("CHECK_FAILED");
    // Every line of the step's block (up to the next step or the "done" line) starts at or right of the column
    // of the step's text.
    const block: string[] = [];
    for (let i = head + 1; i < lines.length && !/^(done|ok|failed|skipped)\b/.test(lines[i]!); i++) block.push(lines[i]!);
    expect(block.length, checkFailedText).toBeGreaterThan(0);
    expect(block.filter((l) => l.trim() !== "" && l.length - l.trimStart().length < indent), checkFailedText).toEqual([]);
  });

  let reprocessConfirmed: Envelope | undefined;

  test("d. the cost guard: more pending rows than confirmAbove → exit 5 with a confirmation; a changed impact is stale; croft confirm runs it", async () => {
    const { p, state, llm } = await setup("/d", 6);
    p.write("assets/issue_labels.ts", labelsAsset({ llm: llm.url, confirmAbove: 4 }));
    expect((await p.json(["run", "issues", "--only"])).code).toBe(0);

    // The dry run already shows the question the run will ask.
    const dry = await p.json(["run", "--dry-run"]);
    expect(dry.code, show(dry)).toBe(0);
    expect(step(dry.json, "issue_labels").confirmation).toMatchObject({
      action: "large_reprocess", command: "croft run issue_labels", impact: { asset: "issue_labels", rows: 6, estimatedRequests: 6 },
    });

    // A bare run fetches the ingest and stops at the transform: exit 5, a token, no call made.
    const asked = await p.json(["run"]);
    expect(asked.code, show(asked)).toBe(5);
    expect(step(asked.json, "issues").status).toBe("ok");
    const held = step(asked.json, "issue_labels");
    expect(held.status).toBe("skipped");
    expect(held.skippedBecause).toContain("would process 6 input rows");
    const c = asked.json.confirmation;
    expect(c, show(asked)).toBeDefined();
    expect(c.token).toMatch(/^c_[0-9a-f]{6}$/);
    expect(c).toMatchObject({ command: "croft run issue_labels", impact: { asset: "issue_labels", rows: 6, estimatedRequests: 6 } });
    expect(findProblem(asked.json, "CONFIRMATION_REQUIRED")?.hint ?? "").toContain(`croft confirm ${c.token}`);
    expect(asked.json.next.some((n: { command: string }) => n.command.includes("confirm"))).toBe(false);
    expect(llm.total()).toBe(0);
    expect(await hasTable(p, "issue_labels")).toBe(false);

    // One more issue arrives before the user answers: the token's impact is stale, and nothing runs.
    state.issues.push({ id: 7, title: "Issue 7" });
    expect((await p.json(["run", "issues", "--only"])).code).toBe(0);
    const stale = await p.json(["confirm", c.token]);
    expect(stale.code, show(stale)).toBe(5);
    const sp = findProblem(stale.json, "CONFIRMATION_STALE");
    expect(sp, show(stale)).toBeDefined();
    expect(sp!.details).toMatchObject({ reason: "impact_changed", impact: { rows: 7 }, previousImpact: { rows: 6 } });
    expect(llm.total()).toBe(0);

    // A new token for the new impact; croft confirm carries it out.
    const asked2 = await p.json(["run", "issue_labels"]);
    expect(asked2.code, show(asked2)).toBe(5);
    expect(asked2.json.confirmation.impact.rows).toBe(7);
    const done = await p.json(["confirm", asked2.json.confirmation.token]);
    expect(done.code, show(done)).toBe(0);
    reprocessConfirmed = done.json;
    expect(done.json.data).toMatchObject({ token: asked2.json.confirmation.token, command: "croft run issue_labels" });
    expect(step(done.json, "issue_labels")).toMatchObject({ status: "ok", requests: 7, rows: { in: 7, added: 7, total: 7 } });
    expect(range(1, 7).filter((id) => llm.times(id) !== 1)).toEqual([]);

    // Under confirmAbove the transform runs without asking.
    state.issues.push({ id: 8, title: "Issue 8" }, { id: 9, title: "Issue 9" });
    const small = await p.json(["run"]);
    expect(small.code, show(small)).toBe(0);
    expect(small.json.confirmation).toBeUndefined();
    expect(step(small.json, "issue_labels")).toMatchObject({ status: "ok", requests: 2 });
    expect(llm.total()).toBe(9);

    // The spent token cannot run anything again.
    const spent = await p.json(["confirm", asked2.json.confirmation.token]);
    expect(spent.code, show(spent)).toBe(5);
    expect(findProblem(spent.json, "CONFIRMATION_STALE")?.details).toMatchObject({ reason: "used" });
    expect(llm.total()).toBe(9);
  }, 120_000);

  // BUG (cli/commands/run.ts settleConfirmation; R flagged it in p2w2-elsewhere.md): a confirmed LARGE_REPROCESS
  // run spends its token in the runner but trashes nothing, so settleConfirmation takes it for a run that did not
  // need the confirmation. croft confirm then reports outcome "not_needed" with the note "nothing destructive was
  // left to do, so it ran as a plain command", for a token that was needed and used (§6: outcome "used").
  bugTest("d2. croft confirm of a cost-guard token reports outcome used, not not_needed", () => {
    expect(reprocessConfirmed).toBeDefined();
    expect(reprocessConfirmed!.data.outcome).toBe("used");
    expect(reprocessConfirmed!.data.note).toBeUndefined();
  });

  test("d3. a transform that calls an LLM through a known SDK package (openai) is held by the cost guard", async () => {
    const { p, llm } = await setup("/d3", 6);
    p.write("node_modules/openai/package.json", JSON.stringify({ name: "openai", version: "5.0.0", type: "module", exports: { ".": "./index.js" } }));
    p.write("node_modules/openai/index.js", `export default class OpenAI {
  constructor() {
    this.responses = { create: async ({ input, id }) => {
      const res = await fetch(${JSON.stringify(llm.url)}, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, title: input }) });
      return { output_text: (await res.json()).label };
    } };
  }
}
`);
    p.write("assets/sdk_labels.ts", `import { transform } from "@zabaca/croft";
import OpenAI from "openai";

const client = new OpenAI();
type Issue = { id: number; title: string };

export default transform({
  description: "Labels from the openai SDK",
  inputs: ["issues"],
  key: "issue_id",
  incremental: true,
  confirmAbove: 4,
  async *rows({ newRows }) {
    for await (const issue of newRows<Issue>("issues")) {
      const r = await client.responses.create({ input: issue.title, id: issue.id } as never);
      yield { issue_id: issue.id, label: (r as { output_text: string }).output_text };
    }
  },
});
`);
    const asked = await p.json(["run"]);
    expect(asked.code, show(asked)).toBe(5);
    expect(asked.json.confirmation).toMatchObject({ command: "croft run sdk_labels", impact: { rows: 6 } });
    expect(llm.total()).toBe(0);
  }, 120_000);

  test("e. an upstream column rename stops the transform with UNKNOWN_INPUT_COLUMN before any call; its edit fix repairs it", async () => {
    const { p, llm } = await setup("/e", 6, { issue: (id) => ({ id, title: `Issue ${id}`, author: `u${id}` }) });
    p.write("assets/open_issues.sql", "-- key: id\nSELECT id, title, author FROM issues\n");
    const transformText = `import { transform } from "@zabaca/croft";

type Issue = { id: number; title: string; author: string };

export default transform({
  description: "An LLM label for every issue, with its author",
  inputs: ["open_issues"],
  key: "issue_id",
  incremental: true,
  async *rows({ newRows, http }) {
    for await (const issue of newRows<Issue>("open_issues")) {
      const who = issue.author;
      const res = await http.post("${llm.url}", { id: issue.id, title: issue.title });
      yield { issue_id: issue.id, who, label: res.json<{ label: string }>().label };
    }
  },
});
`;
    p.write("assets/issue_labels.ts", transformText);
    const built = await p.json(["run"]);
    expect(built.code, show(built)).toBe(0);
    expect(llm.total()).toBe(6);

    // The SQL asset renames the column; its table is recreated without "author" (an ingest would keep it).
    p.write("assets/open_issues.sql", "-- key: id\nSELECT id, title, author AS author_login FROM issues\n");
    const broken = await p.json(["run"]);
    expect(broken.code, show(broken)).toBe(1);
    expect(step(broken.json, "open_issues")).toMatchObject({ status: "ok", schemaChanges: [{ kind: "recreate" }] });
    expect(step(broken.json, "issue_labels").status).toBe("failed");
    const e = findProblem(broken.json, "UNKNOWN_INPUT_COLUMN");
    expect(e, show(broken)).toBeDefined();
    const line = lineOf(transformText, "const who = issue.author;");
    expect(e).toMatchObject({
      asset: "issue_labels", file: "assets/issue_labels.ts", line, effect: "nothing was written",
      message: `open_issues has no column "author"; did you mean "author_login"?`,
      fix: { kind: "edit", file: "assets/issue_labels.ts", line, replace: { from: "author", to: "author_login" } },
    });
    // The guard stopped the code at the first row, before its paid call; the old rows are kept.
    expect(llm.total()).toBe(6);
    expect(await p.rows("select count(*) n, count(who) w from issue_labels")).toEqual([{ n: 6, w: 6 }]);

    // Apply the fix as an agent would, and run again.
    applyEdit(p, e!.fix);
    const repaired = await p.json(["run"]);
    expect(repaired.code, show(repaired)).toBe(0);
    // The recreate gave every open_issues row a new stamp (§5 "Transforms"), so all 6 are new to the transform.
    expect(step(repaired.json, "issue_labels")).toMatchObject({ status: "ok", rows: { in: 6, total: 6 } });
    expect(llm.total()).toBe(12);
    expect(await p.rows("select who from issue_labels order by issue_id")).toEqual(range(1, 6).map((id) => ({ who: `u${id}` })));
  }, 120_000);

  test("f. validate warns TRANSFORM_MAKES_REQUESTS for full-refresh transforms that make requests, and only for them", async () => {
    const { p, llm } = await setup("/f", 3);
    const labelCounts = `import { transform } from "@zabaca/croft";

export default transform({
  description: "Label counts, recomputed in full, asking the LLM again for every issue",
  inputs: ["issues"],
  async *rows({ rows, http }) {
    const n = new Map<string, number>();
    for await (const issue of rows<{ id: number; title: string }>("issues")) {
      const res = await http.post("${llm.url}", { id: issue.id, title: issue.title });
      const label = res.json<{ label: string }>().label;
      n.set(label, (n.get(label) ?? 0) + 1);
    }
    for (const [label, count] of n) yield { label, count };
  },
});
`;
    p.write("assets/label_counts.ts", labelCounts);
    p.write("assets/title_lengths.ts", `import { transform } from "@zabaca/croft";

export default transform({
  description: "Title lengths from a service, through fetch",
  inputs: ["issues"],
  async *rows({ rows }) {
    for await (const issue of rows<{ id: number; title: string }>("issues")) {
      const res = await fetch("${llm.url}", { method: "POST", body: JSON.stringify({ id: issue.id, title: issue.title }) });
      yield { id: issue.id, label: ((await res.json()) as { label: string }).label };
    }
  },
});
`);
    p.write("assets/issue_count.ts", `import { transform } from "@zabaca/croft";

export default transform({
  description: "How many issues there are (no requests)",
  inputs: ["issues"],
  async *rows({ rows }) {
    let n = 0;
    for await (const _ of rows("issues")) n++;
    yield { n };
  },
});
`);
    p.write("assets/issue_labels.ts", labelsAsset({ llm: llm.url }));

    const v = await p.json(["validate"]);
    expect(v.code, show(v)).toBe(0);
    expect(v.json.ok).toBe(true);
    const warned = (v.json.problems as Envelope[]).filter((x) => x.code === "TRANSFORM_MAKES_REQUESTS");
    expect(warned.map((x) => x.asset).sort()).toEqual(["label_counts", "title_lengths"]);
    const w = warned.find((x) => x.asset === "label_counts")!;
    expect(w).toMatchObject({
      severity: "warning", file: "assets/label_counts.ts", line: lineOf(labelCounts, "async *rows"),
      details: { via: ["ctx.http"] }, fix: { kind: "edit", file: "assets/label_counts.ts" },
    });
    expect(w.message).toContain("every rebuild pays for every row again");
    expect(w.fix.description).toContain("incremental: true");
    expect(warned.find((x) => x.asset === "title_lengths")!.details.via.join(" ")).toContain("fetch");

    const human = await p.croft(["validate"]);
    expect(human.code, show(human)).toBe(0);
    expect(human.stdout).toMatch(/warn\s+TRANSFORM_MAKES_REQUESTS\s+assets\/label_counts\.ts:\d+/);
    expect(human.stdout).toContain("0 errors, 2 warnings");
    expect(llm.total()).toBe(0);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------
// R2.1 findings that W2.3 FX1 is fixing (scratchpad/r21.json), seen end to end through the CLI. Once the fixes
// land these start passing, and test.failing turns that into a failure: make them plain tests then.

describe("journey 17: R2.1 findings, end to end", () => {
  // R2.1 (run/transform.ts pendingCounts): the cost guard counts every keyed input's rows after its position,
  // including a lookup read only with rows(), which never gets a position. With 10 lookup rows and
  // confirmAbove 4, every run asks again (LARGE_REPROCESS for 10 rows) even with no new issue to process.
  test("g. a keyed lookup read with rows() does not count toward the cost guard", async () => {
    const { p, llm } = await setup("/g", 3);
    p.write("assets/teams.sql", "-- key: id\nSELECT range AS id, 'team ' || range AS team FROM range(10)\n");
    p.write("assets/team_labels.ts", `import { transform } from "@zabaca/croft";

type Issue = { id: number; title: string };

export default transform({
  description: "LLM labels plus a team from a lookup table",
  inputs: ["issues", "teams"],
  key: "issue_id",
  incremental: true,
  confirmAbove: 4,
  async *rows({ newRows, rows, http }) {
    const teams = new Map<number, string>();
    for await (const t of rows<{ id: number; team: string }>("teams")) teams.set(t.id, t.team);
    for await (const issue of newRows<Issue>("issues")) {
      const res = await http.post("${llm.url}", { id: issue.id, title: issue.title });
      yield { issue_id: issue.id, label: res.json<{ label: string }>().label, team: teams.get(issue.id % 10) ?? null };
    }
  },
});
`);
    const first = await p.json(["run"]);
    if (first.code === 5) {
      const ok = await p.json(["confirm", first.json.confirmation.token]);
      expect(ok.code, show(ok)).toBe(0);
    } else {
      expect(first.code, show(first)).toBe(0);
    }
    expect(llm.total()).toBe(3);
    // No new issue: nothing to process, nothing to ask.
    const second = await p.json(["run", "team_labels"]);
    expect(second.code, show(second)).toBe(0);
    expect(second.json.confirmation).toBeUndefined();
    expect(llm.total()).toBe(3);
  }, 120_000);

  // R2.1 (project/ts-asset.ts detectRequests): the Vercel AI SDK (`ai`, `@ai-sdk/*`) is not a known request
  // package, so a transform calling generateText() per row runs its whole backlog with no LARGE_REPROCESS.
  test("h. a transform that calls an LLM through the ai SDK is held by the cost guard", async () => {
    const { p, llm } = await setup("/h", 6);
    p.write("node_modules/ai/package.json", JSON.stringify({ name: "ai", version: "5.0.0", type: "module", exports: { ".": "./index.js" } }));
    p.write("node_modules/ai/index.js", `export async function generateText({ prompt, id }) {
  const res = await fetch(${JSON.stringify(llm.url)}, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, title: prompt }) });
  return { text: (await res.json()).label };
}
`);
    p.write("assets/ai_labels.ts", `import { transform } from "@zabaca/croft";
import { generateText } from "ai";

type Issue = { id: number; title: string };

export default transform({
  description: "Labels from the ai SDK",
  inputs: ["issues"],
  key: "issue_id",
  incremental: true,
  confirmAbove: 4,
  async *rows({ newRows }) {
    for await (const issue of newRows<Issue>("issues")) {
      const { text } = await generateText({ prompt: issue.title, id: issue.id } as never);
      yield { issue_id: issue.id, label: text };
    }
  },
});
`);
    const asked = await p.json(["run"]);
    expect(asked.code, show(asked)).toBe(5);
    expect(asked.json.confirmation).toMatchObject({ command: "croft run ai_labels", impact: { rows: 6 } });
    expect(llm.total()).toBe(0);
  }, 120_000);

  // R2.1 (run/transform.ts stagedChunk): a chunk that failed CHECK_FAILED is re-committed on every later run while
  // the code hash and positions are unchanged, even after the input row it came from was corrected; the code
  // never runs again for it, so the fix the error names ("correct … the data") cannot work.
  test("i. after the input row itself is corrected, the next run recomputes it instead of re-committing the stale staged chunk", async () => {
    const { p, state, llm } = await setup("/i", 4, { label: ({ title }) => (title.endsWith("?") ? "question" : "bug") });
    state.issues[1] = { id: 2, title: "Why?" };
    p.write("assets/issue_labels.ts", labelsAsset({ llm: llm.url, checks: ["label IN ('bug', 'feature')"] }));
    const failed = await p.json(["run"]);
    expect(failed.code, show(failed)).toBe(3);
    expect(findProblem(failed.json, "CHECK_FAILED")?.details.sample).toEqual([{ issue_id: 2, title: "Why?", label: "question" }]);

    state.issues[1] = { id: 2, title: "Crash when saving" };
    const fixed = await p.json(["run"]);
    expect(fixed.code, show(fixed)).toBe(0);
    expect(llm.times(2)).toBe(2);
    expect(await p.rows("select title, label from issue_labels where issue_id = 2")).toEqual([{ title: "Crash when saving", label: "bug" }]);
  }, 120_000);

  // R2.1 (checks/run.ts): min_rows is a whole-table check evaluated at every chunk commit, so a first build larger
  // than one chunk fails min_rows(n > 500) at its first 500-row chunk, on every attempt.
  test("j. min_rows on a chunked first build is judged on the finished table, not on the first chunk", async () => {
    const { p, llm } = await setup("/j", 800);
    p.write("assets/issue_labels.ts", labelsAsset({ llm: llm.url, checks: ["min_rows(600)"] }));
    const r = await p.json(["run"]);
    expect(r.code, show(r)).toBe(0);
    expect(step(r.json, "issue_labels")).toMatchObject({ status: "ok", rows: { total: 800 } });
  }, 120_000);
});
