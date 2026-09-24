// The run engine over every kind of step (phase 2): dependency order, dispatch by kind, downstream skips, the
// staleness re-check, checks and warnings on every kind, the cost guard's confirmation, and staged chunks. The
// plans are built the way the phase-2 planner builds them (resolveProject → PlannedStep, here), so these tests
// depend on run/plan.ts for its types only.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import type { Reason } from "../core/types.ts";
import { closeAllWarehouses } from "../db/warehouse.ts";
import { parseChecks } from "../checks/parse.ts";
import { getCatalog } from "../history/catalog.ts";
import { RunsDb } from "../history/runs-db.ts";
import { resolveProject, stepKindOf } from "../project/resolve.ts";
import { loadProject } from "../project/root.ts";
import { Confirmations } from "../safety/confirm.ts";
import { DEFAULT_RETRIES, DEFAULT_TIMEOUT_MS, type PlannedStep, type RunPlan } from "./plan.ts";
import { pruneStaging, type RunEvent, runOrder, STAGING_KEEP_MS } from "./runner.ts";
import { cleanupProjects, makeProject, mockApi, runIn, simpleGet, slowPages } from "./testkit.ts";

const api = mockApi();
afterAll(async () => {
  api.stop();
  await closeAllWarehouses();
  cleanupProjects();
});
beforeEach(() => {
  api.state.log.length = 0;
});

interface PlanOptions {
  /** Named assets: the plan holds them and everything downstream, as `croft run <names>` does. */
  selectors?: string[];
  /** Per asset: fields the planner would decide (action, reasons, hold, …). */
  patch?: Record<string, Partial<PlannedStep>>;
}

/** A plan the way the phase-2 planner makes one: every selected asset (and, when named, its downstream), in
 *  graph order; ingests fetch, SQL and full-refresh TS transforms rebuild, incremental ones update. */
async function phase2Plan(root: string, o: PlanOptions = {}): Promise<RunPlan> {
  const project = loadProject({ root });
  const r = await resolveProject({ root, timezone: project.timezone, selectors: o.selectors ?? [], keepOutput: true });
  const chosen = new Set(r.selected);
  if (o.selectors?.length) for (const d of r.graph.downstream(r.selected)) chosen.add(d);
  const steps = r.assets.filter((a) => chosen.has(a.name)).map((a): PlannedStep => {
    const kind = stepKindOf(a);
    const action = kind === "rows" || kind === "file" ? "fetch" : a.incremental.kind === "new-rows" ? "update" : "rebuild";
    const spec = a.ts?.spec;
    return {
      asset: a.name, file: a.file, path: a.path, kind, action, reasons: ["requested"], reason: "requested", problems: a.problems,
      ...(a.ts ? { loaded: a.ts } : {}), ...(spec ? { spec } : {}), ...(a.sql ? { sql: a.sql } : {}),
      inputs: a.inputs, orderAfter: a.orderAfter, readBy: r.graph.readBy(a.name), checks: a.checks,
      ...(a.usesHttp !== undefined ? { usesHttp: a.usesHttp } : {}), ...(a.confirmAbove !== undefined ? { confirmAbove: a.confirmAbove } : {}),
      write: a.write, key: a.key, incremental: a.incremental, behavior: a.behavior, words: a.words,
      ...(a.codeHash ? { codeHash: a.codeHash } : {}), behaviorHash: a.behaviorHash,
      retries: spec?.retries ?? DEFAULT_RETRIES, timeoutMs: spec?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(a.output ? { output: a.output } : {}),
      ...o.patch?.[a.name],
    };
  });
  return { steps, order: r.graph.order.filter((n) => chosen.has(n)), problems: r.problems, fileDirs: [] };
}

/** Run with a phase-2 plan, collecting the events. */
async function run2(root: string, o: PlanOptions & Parameters<typeof runIn>[2] = {}) {
  const { selectors = [], patch, ...rest } = o;
  const events: RunEvent[] = [];
  const plan = await phase2Plan(root, { selectors, ...(patch ? { patch } : {}) });
  const out = await runIn(root, selectors, { plan, onEvent: (_l, e) => void events.push(e), ...rest });
  return { ...out, events, step: (asset: string) => out.data.steps.find((s) => s.asset === asset)! };
}

async function rows(root: string, sql: string): Promise<Record<string, unknown>[]> {
  await closeAllWarehouses();
  const db = await DuckDBInstance.create(join(root, "warehouse.duckdb"), { access_mode: "READ_ONLY" });
  const c = await db.connect();
  try {
    return (await c.runAndReadAll(sql)).getRowObjectsJS() as Record<string, unknown>[];
  } finally {
    c.disconnectSync();
    db.closeSync();
  }
}

function withRuns<T>(root: string, fn: (db: RunsDb) => T): T {
  const db = RunsDb.open(join(root, ".croft"));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** The step events of a run, as "asset:status". */
const stepEvents = (events: RunEvent[]) => events.filter((e) => e.type === "step").map((e) => `${String(e.asset)}:${String(e.status)}`);

const ISSUES = [
  { id: 1, state: "open", amount: 5 },
  { id: 2, state: "closed", amount: 7 },
  { id: 3, state: "open", amount: 1 },
];

const issuesIngest = (extra = "") => simpleGet(api.url, "/zones", `\n  key: "id",${extra}`);

const OPEN_ISSUES = `-- key: id
SELECT id, amount FROM issues WHERE state = 'open'
`;

const doubled = (extra = "", body = "yield { id: r.id, twice: Number(r.amount) * 2 };") => `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["open_issues"],
  key: "id",${extra}
  async *rows({ rows }) {
    for await (const r of rows<{ id: number; amount: number }>("open_issues")) {
      ${body}
    }
  },
});
`;

const SUMMARY = `SELECT count(*) AS n, sum(twice) AS total FROM doubled
`;

describe("dependency order and dispatch by kind", () => {
  test("ingest → SQL → TS transform → SQL run in order, each by its own kind, and approve the code they ran", async () => {
    api.state.zones = ISSUES;
    const root = makeProject({
      "assets/issues.ts": issuesIngest(), "assets/open_issues.sql": OPEN_ISSUES, "assets/doubled.ts": doubled(), "assets/summary.sql": SUMMARY,
    });
    const out = await run2(root);
    expect(out.exit).toBe(0);
    expect(out.data.steps.map((s) => [s.asset, s.status])).toEqual([
      ["issues", "ok"], ["open_issues", "ok"], ["doubled", "ok"], ["summary", "ok"],
    ]);
    // Each step starts once the one it reads has ended.
    const seq = stepEvents(out.events);
    expect(seq).toEqual(["issues:running", "issues:ok", "open_issues:running", "open_issues:ok", "doubled:running", "doubled:ok", "summary:running", "summary:ok"]);
    expect(out.step("open_issues").inputs).toEqual([expect.objectContaining({ input: "issues", rows: 3 })]);
    expect(await rows(root, "select id, twice from doubled order by id")).toEqual([{ id: 1n, twice: 10n }, { id: 3n, twice: 2n }]);
    expect(await rows(root, "select n::INT n, total::INT total from summary")).toEqual([{ n: 2, total: 12 }]);
    const plan = await phase2Plan(root);
    withRuns(root, (db) => {
      for (const s of plan.steps) expect(db.approvedCode(s.asset)).toBe(s.codeHash!);
      expect(getCatalog(db, "summary")).toMatchObject({ kind: "sql", rows: 1, reads: ["doubled"] });
      expect(db.stepsFor(out.data.runId).map((s) => [s.asset, s.status])).toEqual([
        ["issues", "ok"], ["open_issues", "ok"], ["doubled", "ok"], ["summary", "ok"],
      ]);
    });
  });

  test("SQL steps run one at a time, even with room for more steps at once", async () => {
    api.state.zones = ISSUES;
    const root = makeProject({
      "assets/issues.ts": issuesIngest(),
      "assets/a.sql": "SELECT id FROM issues\n", "assets/b.sql": "SELECT id, amount FROM issues\n", "assets/c.sql": "SELECT count(*) AS n FROM issues\n",
    });
    const out = await run2(root, { concurrency: 4 });
    expect(out.exit).toBe(0);
    const seq = stepEvents(out.events).filter((e) => !e.startsWith("issues"));
    // Never two SQL steps running at once: every start is followed by its own end.
    expect(seq).toEqual(["a:running", "a:ok", "b:running", "b:ok", "c:running", "c:ok"]);
  });

  test("runOrder puts every step after the planned steps it reads, whatever the plan's order, and survives a cycle", () => {
    const step = (asset: string, orderAfter: string[]) => ({ asset, orderAfter }) as PlannedStep;
    expect(runOrder({ steps: [step("z", []), step("b", ["z"]), step("a", ["B"])], order: [] })).toEqual(["z", "b", "a"]);
    expect(runOrder({ steps: [step("x", ["y"]), step("y", ["x"]), step("w", [])], order: ["w", "x", "y"] })).toEqual(["w", "x", "y"]);
    // Inputs that are not in the plan do not hold a step back.
    expect(runOrder({ steps: [step("t", ["not_planned"])], order: ["t"] })).toEqual(["t"]);
  });
});

describe("a failed input skips its downstream", () => {
  test("downstream steps are skipped transitively, recorded, and say why; other branches still run", async () => {
    api.state.zones = ISSUES;
    const root = makeProject({
      "assets/issues.ts": issuesIngest(), "assets/open_issues.sql": OPEN_ISSUES,
      "assets/doubled.ts": doubled("", `throw new Error("boom at " + r.id);`), "assets/summary.sql": SUMMARY,
      "assets/report.sql": "SELECT * FROM summary\n", "assets/closed.sql": "SELECT id FROM issues WHERE state = 'closed'\n",
    });
    const out = await run2(root);
    const runId = out.data.runId;
    expect(out.exit).toBe(1);
    expect(out.data.status).toBe("failed");
    expect(out.step("doubled")).toMatchObject({ status: "failed", error: { code: "ASSET_CODE_ERROR" } });
    expect(out.step("summary")).toMatchObject({ status: "skipped", attempt: 0, skippedBecause: `input doubled failed (${runId})` });
    expect(out.step("report")).toMatchObject({ status: "skipped", skippedBecause: `input summary was not built: input doubled failed (${runId})` });
    expect(out.step("closed").status).toBe("ok");
    expect(out.problems.filter((p) => p.severity === "error").map((p) => p.code)).toEqual(["ASSET_CODE_ERROR"]);
    // status reads the skip from runs.sqlite; nothing was attempted.
    withRuns(root, (db) => {
      expect(db.latestStep("summary")).toMatchObject({ runId, status: "skipped", attempt: 0 });
      expect(db.latestStep("report")).toMatchObject({ runId, status: "skipped" });
    });
    expect(stepEvents(out.events)).toContain("summary:skipped");
  });

  test("a blocking check that fails is exit 3 (checks alone failed), with every check's result, and downstream skipped", async () => {
    api.state.zones = ISSUES.map((r) => (r.id === 3 ? { ...r, amount: -1 } : r));
    const root = makeProject({ "assets/issues.ts": issuesIngest(`\n  checks: ["amount >= 0"],`), "assets/open_issues.sql": OPEN_ISSUES });
    const out = await run2(root);
    expect(out.exit).toBe(3);
    const s = out.step("issues");
    expect(s.error?.code).toBe("CHECK_FAILED");
    expect(s.checks).toEqual([
      expect.objectContaining({ check: "unique(id)", ok: true }), expect.objectContaining({ check: "not_null(id)", ok: true }),
      expect.objectContaining({ check: "amount >= 0", ok: false, failing: 1 }),
    ]);
    expect(out.step("open_issues")).toMatchObject({ status: "skipped", skippedBecause: `input issues failed (${out.data.runId})` });
    // Nothing was written.
    withRuns(root, (db) => expect(getCatalog(db, "issues")).toBeNull());
  });

  test("Ctrl-C during an input: the steps still waiting for it are skipped as interrupted (exit 130)", async () => {
    api.state.slowPages = 50;
    api.state.slowDelayMs = 50;
    try {
      const root = makeProject({ "assets/slow.ts": slowPages(api.url), "assets/after.sql": "SELECT count(*) AS n FROM slow\n" });
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 300);
      const out = await run2(root, { signal: ac.signal });
      expect(out.exit).toBe(130);
      expect(out.step("slow").error?.code).toBe("INTERRUPTED");
      expect(out.step("after")).toMatchObject({ status: "skipped", skippedBecause: "the run was interrupted before this step started" });
    } finally {
      api.state.slowPages = 5;
      api.state.slowDelayMs = 300;
    }
  });

  test("a held step does not run, and neither does what reads it; a static error fails its own step before it runs", async () => {
    api.state.zones = ISSUES;
    const root = makeProject({
      "assets/issues.ts": issuesIngest(), "assets/open_issues.sql": OPEN_ISSUES, "assets/doubled.ts": doubled(),
      "assets/closed.sql": "SELECT id FROM issues WHERE state = 'closed'\n", "assets/closed_count.sql": "SELECT count(*) AS n FROM closed\n",
    });
    const bind = { severity: "error" as const, code: "UNKNOWN_COLUMN", message: "Referenced column \"stat\" not found", hint: "did you mean state?", docs: "croft docs UNKNOWN_COLUMN", asset: "closed" };
    const out = await run2(root, { patch: { open_issues: { hold: "code_not_run_by_hand" }, closed: { problems: [bind] } } });
    expect(out.step("issues").status).toBe("ok");
    expect(out.step("open_issues")).toMatchObject({ status: "skipped", skippedBecause: "held: its code has not been run by hand yet" });
    expect(out.step("doubled")).toMatchObject({ status: "skipped", skippedBecause: "input open_issues is held: its code has not been run by hand yet" });
    expect(out.step("closed")).toMatchObject({ status: "failed", attempt: 1, error: { code: "UNKNOWN_COLUMN" } });
    expect(out.step("closed_count").skippedBecause).toBe(`input closed failed (${out.data.runId})`);
    expect(out.exit).toBe(2);
  });

  test("--allow-shrink names a replace ingest, never a transform", async () => {
    const root = makeProject({ "assets/issues.ts": issuesIngest(), "assets/open_issues.sql": OPEN_ISSUES });
    await expect(runIn(root, ["open_issues"], { plan: await phase2Plan(root), allowShrink: true })).rejects.toMatchObject({
      code: "USAGE_ERROR", message: "open_issues is a transform; only replace ingests have a shrink guard",
    });
  });

  test("a failed check next to another failure is exit 1", async () => {
    api.state.zones = ISSUES.map((r) => (r.id === 3 ? { ...r, amount: -1 } : r));
    api.state.failures = 100;
    try {
      const root = makeProject({ "assets/issues.ts": issuesIngest(`\n  checks: ["amount >= 0"],`), "assets/flaky.ts": simpleGet(api.url, "/flaky", "\n  retries: 0,") });
      const out = await run2(root);
      expect(out.problems.filter((p) => p.severity === "error").map((p) => p.code).sort()).toEqual(["CHECK_FAILED", "HTTP_ERROR"]);
      expect(out.exit).toBe(1);
    } finally {
      api.state.failures = 0;
    }
  });
});

describe("checks and warnings on every kind of step", () => {
  test("an ingest's key checks run in its write; a failing warning is a warning and a result after the commit", async () => {
    api.state.zones = [...ISSUES, { id: 4, state: "open", amount: 150 }];
    const root = makeProject({ "assets/issues.ts": issuesIngest(`\n  warnings: ["amount < 100"],`) });
    const out = await run2(root);
    expect(out.exit).toBe(0);
    expect(out.step("issues").checks).toEqual([
      expect.objectContaining({ check: "unique(id)", ok: true }), expect.objectContaining({ check: "not_null(id)", ok: true }),
      expect.objectContaining({ check: "amount < 100", ok: false, failing: 1 }),
    ]);
    const w = out.problems.find((p) => p.code === "CHECK_FAILED")!;
    expect(w).toMatchObject({ severity: "warning", asset: "issues", file: "assets/issues.ts" });
    expect(w.message).toContain("amount < 100: 1 of 4 rows");
    expect(await rows(root, "select count(*)::INT n from issues")).toEqual([{ n: 4 }]);
  });

  test("a TS transform's warnings run after its commit too", async () => {
    api.state.zones = ISSUES;
    const root = makeProject({ "assets/issues.ts": issuesIngest(), "assets/open_issues.sql": OPEN_ISSUES, "assets/doubled.ts": doubled(`\n  warnings: ["twice < 5"],`) });
    const out = await run2(root);
    expect(out.exit).toBe(0);
    expect(out.step("doubled").checks).toContainEqual(expect.objectContaining({ check: "twice < 5", ok: false, failing: 1 }));
    expect(out.problems.find((p) => p.code === "CHECK_FAILED")).toMatchObject({ severity: "warning", asset: "doubled" });
  });

  test("a check the last run ran covers the rows this write changed; a new or edited one the whole table, once", async () => {
    const root = makeProject({ "assets/issues.ts": issuesIngest(`\n  warnings: ["amount >= 0"],`) });
    const warned = (out: Awaited<ReturnType<typeof run2>>) => out.step("issues").checks.find((c) => c.check.startsWith("amount"))!;
    api.state.zones = [{ id: 1, state: "open", amount: 5 }];
    expect(warned(await run2(root))).toMatchObject({ ok: true });
    api.state.zones = [{ id: 1, state: "open", amount: 5 }, { id: 2, state: "open", amount: -1 }];
    expect(warned(await run2(root))).toMatchObject({ ok: false, failing: 1 });
    // Only row 3 changed: the warning looks at it alone, and says nothing about row 2 again.
    api.state.zones.push({ id: 3, state: "open", amount: 4 });
    expect(warned(await run2(root))).toMatchObject({ ok: true });
    // An edited warning has not seen the table yet: it covers all of it this once. (The asset's module is
    // imported once per process, so the edit goes into the plan, as the planner would put the edited file's.)
    const edited = parseChecks({ asset: "issues", file: "assets/issues.ts", key: ["id"], checks: [], warnings: ["amount > -1"] }).checks;
    const patch = { issues: { checks: edited } };
    api.state.zones.push({ id: 4, state: "open", amount: 9 });
    const first = await run2(root, { patch });
    expect(warned(first)).toMatchObject({ check: "amount > -1", ok: false, failing: 1 });
    expect(first.problems.find((p) => p.code === "CHECK_FAILED")?.details).toMatchObject({ scope: "table", checked: 4 });
    api.state.zones.push({ id: 5, state: "open", amount: 2 });
    expect(warned(await run2(root, { patch }))).toMatchObject({ check: "amount > -1", ok: true });
  });

  test("a new blocking check covers the whole table once, so rows written before it are checked too", async () => {
    const root = makeProject({ "assets/issues.ts": issuesIngest() });
    api.state.zones = [{ id: 1, state: "open", amount: 0 }];
    expect((await run2(root)).exit).toBe(0);
    const positive = parseChecks({ asset: "issues", file: "assets/issues.ts", key: ["id"], checks: ["amount > 0"], warnings: [] }).checks;
    api.state.zones.push({ id: 2, state: "open", amount: 3 });
    const out = await run2(root, { patch: { issues: { checks: positive } } });
    expect(out.exit).toBe(3);
    expect(out.step("issues").error?.details).toMatchObject({ check: "amount > 0", failing: 1, scope: "table" });
  });

  test("a column that stopped arriving names the assets that read it (readBy per column)", async () => {
    const root = makeProject({
      "assets/wide.ts": `import { ingest } from "@zabaca/croft";
export default ingest({
  key: "id",
  async *rows() {
    const noX = (globalThis as any).__r_noX === true;
    yield Array.from({ length: 120 }, (_, i) => (noX ? { id: i } : { id: i, x: "v" + i }));
  },
});
`,
      "assets/reader.sql": "SELECT id FROM wide\n",
    });
    const g = globalThis as Record<string, unknown>;
    try {
      expect((await run2(root)).exit).toBe(0);
      g.__r_noX = true;
      const out = await run2(root);
      const stopped = out.problems.find((p) => p.code === "COLUMN_STOPPED_ARRIVING");
      expect(stopped?.details).toMatchObject({ column: "x", readBy: ["reader"] });
    } finally {
      delete g.__r_noX;
    }
  });
});

describe("staleness is checked again just before a transform", () => {
  const files = () => ({ "assets/issues.ts": issuesIngest(), "assets/open_issues.sql": OPEN_ISSUES, "assets/doubled.ts": doubled() });
  const predicted = { open_issues: { reasons: ["input_changed"] as Reason[] }, doubled: { reasons: ["input_changed"] as Reason[] } };

  test("a transform planned for an input change that did not come is skipped as up to date, and not recorded", async () => {
    api.state.zones = ISSUES;
    const root = makeProject(files());
    const first = await run2(root, { patch: predicted });
    expect(first.data.steps.map((s) => s.status)).toEqual(["ok", "ok", "ok"]);
    const again = await run2(root, { patch: predicted });
    expect(again.exit).toBe(0);
    expect(again.step("open_issues")).toMatchObject({ status: "skipped", skippedBecause: "up to date: issues did not change" });
    expect(again.step("doubled")).toMatchObject({ status: "skipped", skippedBecause: "up to date: open_issues did not change" });
    withRuns(root, (db) => expect(db.latestStep("open_issues")).toMatchObject({ runId: first.data.runId, status: "ok" }));
    // New input rows: stale again, so both run.
    api.state.zones = [...ISSUES, { id: 9, state: "open", amount: 3 }];
    const changed = await run2(root, { patch: predicted });
    expect(changed.data.steps.map((s) => s.status)).toEqual(["ok", "ok", "ok"]);
    expect(await rows(root, "select count(*)::INT n from doubled")).toEqual([{ n: 3 }]);
    // Asked for by name (or for any reason but staleness), a fresh transform runs anyway.
    const named = await run2(root);
    expect(named.step("open_issues").status).toBe("ok");
  });
});

describe("the cost guard's confirmation (LARGE_REPROCESS)", () => {
  const guarded = (name = "triage") => `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["issues"],
  key: "id",
  incremental: true,
  confirmAbove: 2,
  async *rows({ newRows, http }) {
    for await (const r of newRows<{ id: number }>("issues")) {
      await http.get("${api.url}/zones");
      yield { id: r.id, by: "${name}" };
    }
  },
});
`;
  const project = (extra: Record<string, string> = {}) => {
    api.state.zones = ISSUES;
    return makeProject({ "assets/issues.ts": issuesIngest(), "assets/triage.ts": guarded(), "assets/report.sql": "SELECT count(*) AS n FROM triage\n", ...extra });
  };

  test("off a TTY: a token for `croft run triage` (exit 5), its downstream waits; the confirmed run spends it and processes", async () => {
    const root = project();
    const asked = await run2(root);
    expect(asked.exit).toBe(5);
    expect(asked.confirmation).toMatchObject({ command: "croft run triage", impact: { asset: "triage", rows: 3, downstream: ["report"], estimatedRequests: 3 } });
    const token = asked.confirmation!.token;
    expect(asked.step("issues").status).toBe("ok");
    expect(asked.step("triage")).toMatchObject({ status: "skipped", reason: "needs confirmation" });
    expect(asked.step("report")).toMatchObject({ status: "skipped", skippedBecause: `input triage is waiting for confirmation ${token}` });
    expect(asked.problems.filter((p) => p.code === "CONFIRMATION_REQUIRED")).toHaveLength(1);
    expect(asked.next.some((n) => n.command.includes("confirm"))).toBe(false);

    // `croft confirm` runs exactly the stored command with the token.
    const done = await run2(root, { selectors: ["triage"], confirmToken: token });
    expect(done.exit).toBe(0);
    expect(done.step("triage")).toMatchObject({ status: "ok", rows: { added: 3 } });
    expect(done.step("report").status).toBe("ok");
    withRuns(root, (db) => expect(new Confirmations(db).get(token)?.usedAt).not.toBeNull());
  });

  test("a confirmation is accepted without --allow-shrink only for one transform named exactly", async () => {
    const root = project();
    const plan = await phase2Plan(root);
    await expect(runIn(root, ["issues"], { plan, confirmToken: "c_123456" })).rejects.toMatchObject({ code: "USAGE_ERROR" });
    await expect(runIn(root, ["triage", "report"], { plan, confirmToken: "c_123456" })).rejects.toMatchObject({ code: "USAGE_ERROR" });
    await expect(runIn(root, ["tri*"], { plan, confirmToken: "c_123456" })).rejects.toMatchObject({ code: "USAGE_ERROR" });
  });

  test("on a TTY the run asks y/N: no fails the step with LARGE_REPROCESS, yes processes", async () => {
    const root = project();
    const questions: string[] = [];
    const no = await run2(root, { interactive: true, prompt: async (q) => (questions.push(q), false) });
    expect(no.exit).toBe(1);
    expect(no.step("triage").error?.code).toBe("LARGE_REPROCESS");
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("triage would process 3 input rows");
    expect(questions[0]).toContain("then: report update");
    expect(questions[0]).toEndWith("Proceed? [y/N] ");
    const yes = await run2(root, { interactive: true, prompt: async () => true });
    expect(yes.exit).toBe(0);
    expect(yes.step("triage").rows.added).toBe(3);
  });

  test("a second step that needs a confirmation is skipped with a next hint; only one token is issued", async () => {
    const root = project({ "assets/triage2.ts": guarded("triage2") });
    const out = await run2(root, { concurrency: 1 });
    expect(out.exit).toBe(5);
    expect(out.confirmation?.command).toBe("croft run triage");
    expect(out.problems.filter((p) => p.code === "CONFIRMATION_REQUIRED").map((p) => p.asset)).toEqual(["triage"]);
    const second = out.step("triage2");
    expect(second).toMatchObject({ status: "skipped", reason: "needs confirmation" });
    expect(second.skippedBecause).toContain(`run it after confirmation ${out.confirmation!.token} is settled`);
    expect(out.next).toContainEqual({ command: "croft run triage2", reason: "triage2 needs its own confirmation; run it after the pending one is settled" });
    withRuns(root, (db) => expect(db.sqlite.query("select count(*) n from confirmations").get()).toEqual({ n: 1 }));
  });

  test("a run nobody started by hand has nobody to ask: the guard fails the step", async () => {
    const root = project();
    const out = await run2(root, { human: false });
    expect(out.step("triage").error?.code).toBe("LARGE_REPROCESS");
    expect(out.confirmation).toBeUndefined();
  });

  test("a scheduled run holds the transform instead (§5: until a person runs it), recorded for the tick", async () => {
    const root = project();
    // Scheduling on, and every asset's code run by hand before (a scheduled step checks both as it starts).
    const plan = await phase2Plan(root);
    withRuns(root, (db) => {
      db.setScheduling({ state: "on", via: "serve" });
      for (const s of plan.steps) db.approveCode(s.asset, (s.codeHash ?? s.sql?.codeHash)!);
    });
    const out = await run2(root, { human: false, trigger: "schedule" });
    expect(out.step("triage")).toMatchObject({ status: "skipped" });
    expect(out.step("triage").skippedBecause).toStartWith("held (LARGE_REPROCESS): ");
    expect(out.problems.find((p) => p.code === "LARGE_REPROCESS")?.severity).toBe("warning");
    expect(out.confirmation).toBeUndefined();
    expect(out.exit).toBe(0);
    withRuns(root, (db) => expect(db.latestStep("triage")).toMatchObject({ status: "skipped", error: { code: "LARGE_REPROCESS" } }));
  });
});

describe("staged chunks", () => {
  test("pruneStaging keeps a chunk until nothing in it changed for 3 days, whatever the _chunks folder's own time", async () => {
    const root = makeProject({});
    const stateDir = join(root, ".croft");
    const chunks = join(stateDir, "staging", "_chunks");
    const now = Date.now();
    const old = (now - STAGING_KEEP_MS - 60_000) / 1000;
    for (const [asset, at] of [["stale", old], ["fresh", now / 1000]] as const) {
      mkdirSync(join(chunks, asset), { recursive: true });
      writeFileSync(join(chunks, asset, "chunk.json"), "{}");
      utimesSync(join(chunks, asset, "chunk.json"), at, at);
      utimesSync(join(chunks, asset), old, old);
    }
    utimesSync(chunks, old, old);
    const removed = withRuns(root, (db) => pruneStaging(stateDir, db, now));
    expect(removed).toEqual([join(chunks, "stale")]);
    expect(existsSync(join(chunks, "fresh", "chunk.json"))).toBe(true);
  });
});
