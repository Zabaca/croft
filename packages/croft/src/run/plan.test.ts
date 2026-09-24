import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Incremental } from "../core/types.ts";
import { type CatalogAsset, type CatalogColumn, putCatalog } from "../history/catalog.ts";
import { RunsDb } from "../history/runs-db.ts";
import { tsFingerprint } from "../project/ts-asset.ts";
import {
  backfillUnsupported, behaviorHash, behaviorLabel, behaviorWords, type BehaviorSide, type DuePlanning, FROM_ONLY_MERGE, fileDirsOf, isGlob, loadErrors,
  pendingBehavior, pendingPins, type PlannedStep, planRun, rebuildCommand, rebuildSelectors, type RunPlan, resolveWrite, selectAssets, skipProblem, staleViewOf,
} from "./plan.ts";
import { staleReasons } from "./staleness.ts";
import { cleanupProjects, makeProject, writeFiles } from "./testkit.ts";

afterAll(() => cleanupProjects());

const none: Incremental = { kind: "none" };
const cursor: Incremental = { kind: "cursor", field: "updated_at", lookbackMs: 0 };

describe("selectAssets", () => {
  const names = ["github_issues", "github_prs", "stripe_charges", "taxi_zones"];

  test("no selector selects everything; names and globs select in name order without duplicates", () => {
    expect(selectAssets(names, [])).toEqual(names);
    expect(selectAssets(names, ["taxi_zones", "github_*"])).toEqual(["github_issues", "github_prs", "taxi_zones"]);
    expect(selectAssets(names, ["github_issues", "github_*"])).toEqual(["github_issues", "github_prs"]);
    expect(selectAssets(names, ["*_zone?"])).toEqual(["taxi_zones"]);
  });

  test("an unknown name suggests the closest; a glob that matches nothing says so", () => {
    try {
      selectAssets(names, ["stripe_chargse"]);
      throw new Error("expected a usage error");
    } catch (e) {
      expect(e).toMatchObject({ code: "USAGE_ERROR", problem: { hint: "did you mean stripe_charges?", fix: { command: "croft run stripe_charges" } } });
    }
    expect(() => selectAssets(names, ["shopify_*"])).toThrow(/no asset matches "shopify_\*"/);
    expect(() => selectAssets([], ["x"])).toThrow(/there is no asset named "x"/);
  });

  test("the did-you-mean fix repeats the command typed, with the name corrected and the other selectors kept", () => {
    const fixOf = (selectors: string[], retry?: (s: readonly string[]) => string) => {
      try {
        selectAssets(names, selectors, [], retry ? { retry } : {});
      } catch (e) {
        return (e as { problem: { fix?: { command?: string } } }).problem.fix?.command;
      }
      throw new Error("expected a usage error");
    };
    expect(fixOf(["taxi_zones", "stripe_chargse"])).toBe("croft run taxi_zones stripe_charges");
    expect(fixOf(["stripe_chargse"], (s) => `croft validate ${s.join(" ")}`)).toBe("croft validate stripe_charges");
  });

  test("isGlob", () => {
    expect(isGlob("a_*")).toBe(true);
    expect(isGlob("a?")).toBe(true);
    expect(isGlob("{a,b}")).toBe(true);
    expect(isGlob("plain_name")).toBe(false);
  });
});

describe("behavior", () => {
  test("write mode from key and incremental (§1), unless write overrides it", () => {
    expect(resolveWrite({ key: [], incremental: none })).toBe("replace");
    expect(resolveWrite({ key: ["id"], incremental: none })).toBe("replace");
    expect(resolveWrite({ key: [], incremental: cursor })).toBe("append");
    expect(resolveWrite({ key: ["id"], incremental: cursor })).toBe("merge");
    expect(resolveWrite({ key: ["id"], incremental: { kind: "files" } })).toBe("merge");
    expect(resolveWrite({ key: [], incremental: cursor, write: "append" })).toBe("append");
    expect(resolveWrite({ key: ["id"], incremental: none, write: "merge" })).toBe("merge");
  });

  test("labels and plain words", () => {
    expect(behaviorLabel("merge", ["id"])).toBe("merge by id");
    expect(behaviorLabel("replace", [])).toBe("replace");
    expect(behaviorLabel("replace", ["LocationID"])).toBe("replace; key LocationID");
    expect(behaviorLabel("append", [])).toBe("append");
    expect(behaviorWords("merge", ["id"], { kind: "cursor", field: "created", unit: "s", lookbackMs: 30 * 86_400_000 }))
      .toBe("updates rows by id; fetches created newer than the saved position, re-reading the last 30 days (created is epoch seconds)");
    expect(behaviorWords("replace", [], none)).toBe("replaces the table's contents; unchanged rows keep their _loaded_at");
    expect(behaviorWords("merge", ["order_id"], { kind: "files" })).toBe("updates rows by order_id; loads new and changed files only; rows of deleted files are kept");
    // An incremental TS transform (newRows()): each input row once, again when it changes (§3e).
    expect(behaviorWords("merge", ["issue_id"], { kind: "new-rows", inputs: ["github_issues"] }))
      .toBe("updates rows by issue_id; processes new and changed input rows once");
    expect(behaviorWords("append", [], { kind: "new-rows", inputs: ["events"] })).toBe("adds the new rows; processes new and changed input rows once");
  });

  test("the behavior hash changes with write, key and cursor field, not with the lookback", () => {
    const a = behaviorHash("merge", ["id"], { kind: "cursor", field: "updated_at", lookbackMs: 0 });
    expect(behaviorHash("merge", ["id"], { kind: "cursor", field: "updated_at", lookbackMs: 5000 })).toBe(a);
    expect(behaviorHash("merge", ["id", "x"], { kind: "cursor", field: "updated_at", lookbackMs: 0 })).not.toBe(a);
    expect(behaviorHash("merge", ["id"], { kind: "cursor", field: "created", lookbackMs: 0 })).not.toBe(a);
    expect(behaviorHash("append", ["id"], { kind: "cursor", field: "updated_at", lookbackMs: 0 })).not.toBe(a);
  });

  test("file ingest directories for the sandbox: the fixed part of each path or glob; URLs have none", () => {
    expect(fileDirsOf("/p", { file: "files/sales/*.csv" })).toEqual(["/p/files/sales"]);
    expect(fileDirsOf("/p", { file: ["exports/a.csv", "/data/in/**/*.json", "https://x.test/a.csv"] })).toEqual(["/p/exports", "/data/in"]);
    expect(fileDirsOf("/p", { file: "*.csv" })).toEqual(["/p"]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// The phase-2 planner

const INGEST = `import { ingest } from "@zabaca/croft";
export default ingest({ key: "id", incremental: "updated_at", async *rows() {} });
`;
const TRIAGE = `import { transform } from "@zabaca/croft";
export default transform({ inputs: ["open_issues"], key: "id", incremental: true, async *rows() {} });
`;
/** api → open_issues (SQL) → triage (incremental TS); consts (SQL) reads nothing. */
const PROJECT = {
  "assets/api.ts": INGEST,
  "assets/open_issues.sql": "-- key: id\nSELECT id, title FROM api WHERE state = 'open'\n",
  "assets/triage.ts": TRIAGE,
  "assets/consts.sql": "SELECT 1 AS x\n",
};

const T1 = "2026-09-22T17:00:00.000000Z";
const T2 = "2026-09-22T18:00:00.000000Z";
const col = (name: string, type: string, pending = false): CatalogColumn => ({ name, type, sourceName: name, pinned: false, pending, format: null });
const API_COLUMNS = [col("id", "BIGINT"), col("title", "VARCHAR"), col("state", "VARCHAR"), col("updated_at", "TIMESTAMPTZ"), col("_loaded_at", "TIMESTAMPTZ")];

function entry(asset: string, o: Partial<CatalogAsset> = {}): CatalogAsset {
  return {
    asset, kind: "ingest", behavior: "", write: "replace", key: [], rows: 10, columns: [], cursor: null,
    lastLoadedAt: T1, lastReplacedAt: null, lastRunId: "r_0922_1000_aaaa", codeHash: null, ...o,
  };
}

const by = (plan: RunPlan) => Object.fromEntries(plan.steps.map((s) => [s.asset, s])) as Record<string, PlannedStep>;
const codes = (s: PlannedStep | undefined) => (s?.problems ?? []).map((p) => p.code);

/** Every asset built once, in the state the plan's own code hashes give: nothing is stale. */
async function builtCatalog(root: string): Promise<CatalogAsset[]> {
  const fresh = by(await planRun({ root, timezone: "America/Los_Angeles", selectors: [], catalog: [] }));
  return [
    entry("api", { kind: "ingest", write: "merge", key: ["id"], columns: API_COLUMNS, codeHash: fresh.api!.codeHash ?? null }),
    entry("consts", { kind: "sql", codeHash: fresh.consts!.codeHash!, columns: [col("x", "INTEGER"), col("_loaded_at", "TIMESTAMPTZ")] }),
    entry("open_issues", {
      kind: "sql", key: ["id"], codeHash: fresh.open_issues!.codeHash!, columns: [col("id", "BIGINT"), col("title", "VARCHAR"), col("_loaded_at", "TIMESTAMPTZ")],
      inputsSeen: { api: { seenLoadedAt: T1, seenKey: null, inputLastLoadedAt: T1 } },
    }),
    entry("triage", {
      kind: "ts", write: "merge", key: ["id"], codeHash: fresh.triage!.codeHash!,
      inputsSeen: { open_issues: { seenLoadedAt: T1, seenKey: [5], inputLastLoadedAt: T1 } },
    }),
  ];
}

function withEntry(catalog: CatalogAsset[], asset: string, o: Partial<CatalogAsset>): CatalogAsset[] {
  return catalog.map((c) => (c.asset === asset ? { ...c, ...o } : c));
}

describe("planRun: what a run takes", () => {
  test("a new project: every ingest fetches, every transform is never built; steps come in run order, ready to run", async () => {
    const root = makeProject({
      ...PROJECT,
      "assets/sales.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ file: "exports/*.csv", incremental: true, key: "order_id" });\n`,
    });
    const plan = await planRun({ root, timezone: "America/Los_Angeles", selectors: [], catalog: [] });
    expect(plan.order).toEqual(["api", "consts", "open_issues", "sales", "triage"]);
    expect(plan.steps.map((s) => s.asset)).toEqual(plan.order);
    expect(plan.problems).toEqual([]);
    const s = by(plan);
    expect(s.api).toMatchObject({ kind: "rows", action: "fetch", reasons: ["requested", "never_built"], reason: "requested", write: "merge", behavior: "merge by id", retries: 2, timeoutMs: 600_000, inputs: [], readBy: ["open_issues"] });
    expect(s.sales).toMatchObject({ kind: "file", action: "fetch", write: "merge" });
    expect(s.consts).toMatchObject({ kind: "sql", action: "rebuild", reasons: ["never_built"], reason: "never built", inputs: [], readBy: [] });
    // The SQL step gets what runSqlStep needs: the loaded file, its inputs (AST ∪ plan scans), its code hash and words.
    expect(s.open_issues).toMatchObject({
      kind: "sql", action: "rebuild", reason: "never built", inputs: ["api"], orderAfter: ["api"], readBy: ["triage"], key: ["id"], write: "replace",
      behavior: "replace; key id", words: "replaces the table's contents (key id, which must be unique); unchanged rows keep their _loaded_at",
    });
    expect(s.open_issues!.sql?.body).toContain("FROM api");
    expect(s.open_issues!.codeHash).toBe(s.open_issues!.sql!.codeHash!);
    expect(s.open_issues!.checks.map((c) => c.source)).toEqual(["unique(id)", "not_null(id)"]);
    expect(s.open_issues!.reasons).toEqual(["never_built"]);
    // An incremental TS transform updates; its words say it processes each input row once.
    expect(s.triage).toMatchObject({
      kind: "transform", action: "update", inputs: ["open_issues"], readBy: [], usesHttp: false,
      words: "updates rows by id; processes new and changed input rows once",
    });
    expect(s.triage!.spec?.role).toBe("transform");
    expect(s.triage!.loaded?.ok).toBe(true);
    // No step has a problem: the bind check has no columns for api yet (INPUT_NOT_BUILT is not the run's news).
    expect(plan.steps.flatMap((x) => x.problems)).toEqual([]);
    expect(plan.fileDirs).toEqual([join(root, "exports")]);
  });

  test("a bare run takes every ingest and what is stale; fresh transforms stay out; the reasons say why", async () => {
    const root = makeProject(PROJECT);
    const catalog = await builtCatalog(root);
    const plan = await planRun({ root, timezone: "America/Los_Angeles", selectors: [], catalog });
    // consts reads nothing and nothing changed: not in the run. The rest follow api, which always fetches.
    expect(plan.order).toEqual(["api", "open_issues", "triage"]);
    const s = by(plan);
    expect(s.api).toMatchObject({ action: "fetch", reasons: ["requested"], reason: "requested" });
    expect(s.open_issues).toMatchObject({ action: "rebuild", reasons: ["input_changed"], reason: "input api may have new rows" });
    expect(s.triage).toMatchObject({ action: "update", reasons: ["input_changed"], reason: "input open_issues may have new rows (TS code unchanged)" });

    // Edited SQL is stale on its own: code_changed.
    const edited = await planRun({ root, timezone: "America/Los_Angeles", selectors: [], catalog: withEntry(catalog, "consts", { codeHash: "old" }) });
    expect(by(edited).consts).toMatchObject({ action: "rebuild", reasons: ["code_changed"], reason: "SQL changed (assets/consts.sql)" });
    // An input with rows the transform has not read, and one replaced (restored, or changed outside croft).
    const moved = withEntry(withEntry(catalog, "api", { lastLoadedAt: T2 }), "open_issues", { lastReplacedAt: T2, lastLoadedAt: T1 });
    const later = by(await planRun({ root, timezone: "America/Los_Angeles", selectors: ["open_issues", "triage"], catalog: moved, only: true }));
    expect(later.open_issues).toMatchObject({ reasons: ["requested", "input_changed"], reason: "requested; input api has new rows" });
    expect(later.triage!.reasons).toEqual(["requested", "input_replaced", "input_changed"]);
    // An incremental TS transform processes new input rows only: the rows a restore brought back are not new, so the
    // reason says how to redo them (§6 "Trash, restore and delete": "input restored; --rebuild offered").
    expect(later.triage!.reason).toBe("requested; input open_issues was replaced (restored, or changed outside croft): only new input rows are processed, "
      + "and croft run triage --rebuild redoes every row; input open_issues may have new rows (TS code unchanged)");
    expect(later.open_issues!.reason).not.toContain("--rebuild");
  });

  test("named assets run whatever their staleness, then their stale downstream; --only stops there; --upstream adds stale inputs", async () => {
    const root = makeProject(PROJECT);
    const catalog = await builtCatalog(root);
    const plan = (selectors: string[], o: { only?: boolean; upstream?: boolean; catalog?: CatalogAsset[] } = {}) =>
      planRun({ root, timezone: "America/Los_Angeles", selectors, catalog: o.catalog ?? catalog, ...o });

    const consts = await plan(["consts"]);
    expect(consts.steps.map((s) => [s.asset, s.action, s.reason])).toEqual([["consts", "rebuild", "requested"]]);
    expect((await plan(["api"])).order).toEqual(["api", "open_issues", "triage"]);
    expect((await plan(["open_issues"])).order).toEqual(["open_issues", "triage"]);
    expect((await plan(["api"], { only: true })).order).toEqual(["api"]);
    expect((await plan(["open_*"], { only: true })).order).toEqual(["open_issues"]);

    // --upstream: nothing upstream is stale, so nothing is added.
    expect((await plan(["triage"], { upstream: true, only: true })).order).toEqual(["triage"]);
    // open_issues has unread rows of api: it runs first. api itself is built, so it does not.
    const staleOpen = withEntry(catalog, "api", { lastLoadedAt: T2 });
    const up = await plan(["triage"], { upstream: true, catalog: staleOpen });
    expect(up.order).toEqual(["open_issues", "triage"]);
    expect(by(up).open_issues).toMatchObject({ reasons: ["input_changed"], reason: "input api has new rows" });
    // An input never built is fetched first, and what reads it follows.
    const noApi = catalog.filter((c) => c.asset !== "api");
    const first = await plan(["triage"], { upstream: true, catalog: noApi });
    expect(first.order).toEqual(["api", "open_issues", "triage"]);
    expect(by(first).api!.reasons).toEqual(["never_built"]);
    expect(by(first).open_issues).toMatchObject({ reasons: ["input_changed"], reason: "input api may have new rows" });
    // A bare run with --only: every ingest and what is stale on its own, not what follows an ingest.
    expect((await plan([], { only: true })).order).toEqual(["api"]);
    expect((await plan([], { only: true, catalog: staleOpen })).order).toEqual(["api", "open_issues"]);
  });

  // §3f: a table read only in a check's subquery orders the steps. It is no input (nothing downstream follows it),
  // but the check cannot run until the table exists.
  test("--upstream builds the never-built tables its checks read; without it, the step names that table before it runs", async () => {
    const root = makeProject({
      ...PROJECT,
      "assets/regions.sql": "SELECT 'open' AS state\n",
      "assets/report.sql": "-- key: id\n-- check: title IN (SELECT state FROM regions)\nSELECT id, title FROM open_issues\n",
    });
    const catalog = await builtCatalog(root);
    const plan = (selectors: string[], o: { only?: boolean; upstream?: boolean } = {}) =>
      planRun({ root, timezone: "America/Los_Angeles", selectors, catalog, ...o });

    const up = await plan(["report"], { upstream: true });
    expect(up.order).toEqual(["regions", "report"]);
    expect(by(up).regions).toMatchObject({ action: "rebuild", reasons: ["never_built"], reason: "never built" });
    expect(by(up).report!.problems).toEqual([]);
    // Built and fresh, the table a check reads is left alone, as a built input is.
    const withRegions = [...catalog, entry("regions", { kind: "sql", codeHash: by(up).regions!.codeHash! })];
    expect((await planRun({ root, timezone: "America/Los_Angeles", selectors: ["report"], catalog: withRegions, upstream: true })).order).toEqual(["report"]);

    // Not built, and not in the run: the step fails before it runs, naming the table and how to build it.
    const alone = by(await plan(["report"]));
    expect(codes(alone.report)).toEqual(["CHECK_INVALID"]);
    const p = alone.report!.problems[0]!;
    expect(p).toMatchObject({
      severity: "error", asset: "report", file: "assets/report.sql", line: 2,
      message: `report: the check "title IN (SELECT state FROM regions)" reads regions, which has never been built`,
      hint: "build regions first (croft run regions), or both in one run: croft run report --upstream",
      fix: { kind: "command", command: "croft run report --upstream" },
      details: { check: "title IN (SELECT state FROM regions)", table: "regions" },
    });
    expect(p.hint).not.toContain("correct the check");
    // Named too, or in a bare run, it is built first: no problem.
    expect(by(await plan(["regions", "report"])).report!.problems).toEqual([]);
    expect(by(await plan([])).report!.problems).toEqual([]);
    // Once built, the check reads it as it is.
    expect(by(await planRun({ root, timezone: "America/Los_Angeles", selectors: ["report"], catalog: withRegions })).report!.problems).toEqual([]);
  });

  test("only croft.json's timezone changed: the transforms rebuild, the reason names the zone, and nothing is 'edited'", async () => {
    const root = makeProject(PROJECT);
    const catalog = await builtCatalog(root);          // built in America/Los_Angeles
    const s = by(await planRun({ root, timezone: "UTC", selectors: [], catalog }));
    expect(s.consts).toMatchObject({ action: "rebuild", reasons: ["code_changed"], reason: "time zone changed (America/Los_Angeles → UTC)" });
    expect(s.open_issues).toMatchObject({ reasons: ["code_changed", "input_changed"], reason: "time zone changed (America/Los_Angeles → UTC); input api may have new rows" });
    // An incremental TS transform is forward-only, and gets no EDITED_SINCE_LAST_RUN for a zone change.
    expect(s.triage!.problems).toEqual([]);
    expect(s.triage!.reason).toBe("input open_issues may have new rows (time zone changed from America/Los_Angeles: the new zone applies to new input rows only)");
    // An edit made with the zone change is still an edit.
    writeFiles(root, { "assets/consts.sql": "SELECT 2 AS x\n" });
    expect(by(await planRun({ root, timezone: "UTC", selectors: ["consts"], catalog })).consts!.reason).toBe("requested; SQL changed (assets/consts.sql)");
  });

  test("without a catalog it reads the mirror in runs.sqlite, and creates nothing when there is none", async () => {
    const root = makeProject(PROJECT);
    const bare = await planRun({ root, timezone: "America/Los_Angeles", selectors: [] });
    expect(bare.order).toEqual(["api", "consts", "open_issues", "triage"]);
    expect(existsSync(join(root, ".croft", "runs.sqlite"))).toBe(false);
    const db = RunsDb.open(join(root, ".croft"));
    try {
      for (const e of await builtCatalog(root)) putCatalog(db, e);
    } finally {
      db.close();
    }
    expect((await planRun({ root, timezone: "America/Los_Angeles", selectors: [] })).order).toEqual(["api", "open_issues", "triage"]);
  });

  test("staleViewOf gives the runner what staleness needs to check a step again", async () => {
    const root = makeProject(PROJECT);
    const catalog = await builtCatalog(root);
    const plan = await planRun({ root, timezone: "America/Los_Angeles", selectors: ["open_issues"], catalog, only: true });
    const lookup = (c: CatalogAsset[]) => (a: string) => c.find((x) => x.asset === a) ?? null;
    const step = plan.steps[0]!;
    expect(staleViewOf(step, lookup(catalog))).toMatchObject({ asset: "open_issues", kind: "sql", incremental: false, inputs: ["api"], codeHash: step.codeHash });
    expect(staleReasons(staleViewOf(step, lookup(catalog)))).toEqual([]);
    expect(staleReasons(staleViewOf(step, lookup(withEntry(catalog, "api", { lastLoadedAt: T2 }))))).toEqual(["input_changed"]);
  });
});

describe("planRun: static errors fail their own step", () => {
  test("the bind check: an error fails the step when nothing before it can change its inputs' columns", async () => {
    const root = makeProject({
      "assets/api.ts": INGEST,
      "assets/typo.sql": "-- key: id\nSELECT id, titel FROM api\n",
      "assets/keyword.sql": `SELECT id, order FROM api\n`,
      "assets/after.sql": "SELECT id FROM typo\n",
    });
    const catalog = [entry("api", { write: "merge", key: ["id"], columns: [...API_COLUMNS, col("order", "BIGINT")] })];
    const named = by(await planRun({ root, timezone: "UTC", selectors: ["typo", "keyword"], catalog }));
    expect(codes(named.typo)).toEqual(["UNKNOWN_COLUMN"]);
    expect(named.typo!.problems[0]).toMatchObject({ severity: "error", asset: "typo", file: "assets/typo.sql", line: 2 });
    expect(loadErrors(named.typo!)).toHaveLength(1);
    // Quoting a keyword fixes the parse: QUOTE_IDENTIFIER replaces the loader's SQL_SYNTAX.
    expect(codes(named.keyword)).toEqual(["QUOTE_IDENTIFIER"]);
    // What reads a failing asset is still planned: the runner skips it when its input fails.
    expect(named.after).toMatchObject({ action: "rebuild", problems: [] });

    // In a bare run api fetches first and may bring the column: the step itself reports it if it is still missing.
    const bare = by(await planRun({ root, timezone: "UTC", selectors: [], catalog }));
    expect(codes(bare.typo)).toEqual([]);
    // A keyword is wrong whatever api brings.
    expect(codes(bare.keyword)).toEqual(["QUOTE_IDENTIFIER"]);
  });

  test("a cycle fails the assets on it, not the run; a broken transform is in a bare run even when it is not stale", async () => {
    const root = makeProject({
      "assets/a.sql": "SELECT * FROM b\n",
      "assets/b.sql": "SELECT * FROM a\n",
      "assets/api.ts": INGEST,
      "assets/broken.ts": `import { transform } from "@zabaca/croft";\nexport default transform({ inputs: [ });\n`,
    });
    const plan = await planRun({ root, timezone: "UTC", selectors: [], catalog: [entry("broken", { kind: "ts" })] });
    expect(plan.problems).toEqual([]);
    const s = by(plan);
    expect(codes(s.a)).toEqual(["CYCLE"]);
    expect(s.a!.problems[0]).toMatchObject({ asset: "a", file: "assets/a.sql" });
    expect(codes(s.b)).toEqual(["CYCLE"]);
    expect(s.b!.problems[0]).toMatchObject({ asset: "b", file: "assets/b.sql" });
    expect(s.api).toMatchObject({ action: "fetch", problems: [] });
    expect(s.broken).toMatchObject({ kind: "transform", action: "rebuild", reasons: ["requested"] });
    expect(loadErrors(s.broken!).length).toBeGreaterThan(0);
    // The cycle's assets come last: they are out of the graph's order.
    expect(plan.order).toEqual(["api", "broken", "a", "b"]);
  });

  test("an incremental TS transform edited since its last run carries EDITED_SINCE_LAST_RUN (forward-only)", async () => {
    const root = makeProject(PROJECT);
    const catalog = withEntry(await builtCatalog(root), "triage", { codeHash: "older", rows: 42 });
    const s = by(await planRun({ root, timezone: "UTC", selectors: ["triage"], catalog }));
    expect(s.triage!.reasons).toEqual(["requested"]);
    expect(s.triage!.reason).toBe("requested (code edited: the new code applies to new input rows only)");
    expect(s.triage!.problems).toMatchObject([{ code: "EDITED_SINCE_LAST_RUN", severity: "warning" }]);
    expect(s.triage!.problems[0]!.message).toContain("42 rows were built by older code");
  });

  // An agent that just wrote assets/order.ts and runs `croft run order` must hear the real reason (NAME_RESERVED,
  // rename to orders), not "there is no asset named order".
  test("a selector naming a file that failed discovery reports that file's problem", async () => {
    const root = makeProject({
      "assets/order.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ async *rows() {} });\n`,
      "assets/_private.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ async *rows() {} });\n`,
      "assets/a/dup.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ async *rows() {} });\n`,
      "assets/b/dup.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ async *rows() {} });\n`,
      "assets/fine.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ async *rows() {} });\n`,
    });
    const codeOf = async (selectors: string[]) => {
      try {
        await planRun({ root, timezone: "UTC", selectors });
        return null;
      } catch (e) {
        return e as { code: string; problem: { file?: string; hint: string; details?: Record<string, unknown> } };
      }
    };
    const reserved = await codeOf(["order"]);
    expect(reserved).toMatchObject({ code: "NAME_RESERVED", problem: { file: "assets/order.ts", details: { name: "order", suggestion: "orders" } } });
    expect(reserved!.problem.hint).toContain("orders.ts");
    expect(await codeOf(["_private"])).toMatchObject({ code: "NAME_RESERVED", problem: { file: "assets/_private.ts" } });
    expect(await codeOf(["dup"])).toMatchObject({ code: "NAME_CONFLICT" });
    expect(await codeOf(["ord*"])).toMatchObject({ code: "NAME_RESERVED" });
    expect(await codeOf(["nothing"])).toMatchObject({ code: "USAGE_ERROR" });
    // A glob that also matches a valid asset runs it, and reports the broken file as a problem.
    const plan = await planRun({ root, timezone: "UTC", selectors: ["*"] });
    expect(plan.steps.map((s) => s.asset)).toEqual(["fine"]);
    expect(plan.problems.map((p) => p.code).sort()).toEqual(["NAME_CONFLICT", "NAME_RESERVED", "NAME_RESERVED"]);
    // Naming only valid assets reports nothing about the others.
    expect((await planRun({ root, timezone: "UTC", selectors: ["fine"] })).problems).toEqual([]);
  });

  test("retries and timeout come from the asset", async () => {
    const root = makeProject({
      "assets/api.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ retries: 0, timeout: "30m", async *rows() {} });\n`,
    });
    const plan = await planRun({ root, timezone: "UTC", selectors: ["api"] });
    expect(plan.steps[0]).toMatchObject({ retries: 0, timeoutMs: 30 * 60_000 });
  });
});

// R2.2: validate binds every SQL asset against the NEW output of the SQL it reads; a named run bound against the
// input's BUILT columns, so after an edit to two chained SQL assets validate passed and `croft run daily` (its dry
// run, `croft preview daily`) failed with UNKNOWN_COLUMN, pointing at the correct file.
describe("planRun: SQL binds against the new output of the SQL it reads, as validate does", () => {
  const ORDERS_COLUMNS = [col("id", "BIGINT"), col("amount", "BIGINT"), col("status", "VARCHAR"), col("updated_at", "TIMESTAMPTZ"), col("_loaded_at", "TIMESTAMPTZ")];
  const SHOP = {
    "assets/orders.ts": INGEST,
    "assets/clean_orders.sql": "-- key: id\nSELECT id, amount, status FROM orders\n",
    "assets/daily.sql": "-- key: status\nSELECT status, sum(amount) AS total FROM clean_orders GROUP BY ALL\n",
    "assets/weekly.sql": "SELECT count(*) AS n FROM clean_orders\n",
  };
  const seen = (input: string) => ({ [input]: { seenLoadedAt: T1, seenKey: null, inputLastLoadedAt: T1 } });

  /** SHOP built once, as its files are now: nothing is stale. */
  async function shop() {
    const root = makeProject(SHOP);
    const s = by(await planRun({ root, timezone: "UTC", selectors: [], catalog: [] }));
    const catalog = [
      entry("orders", { write: "merge", key: ["id"], columns: ORDERS_COLUMNS, codeHash: s.orders!.codeHash ?? null }),
      entry("clean_orders", {
        kind: "sql", key: ["id"], codeHash: s.clean_orders!.codeHash!, inputsSeen: seen("orders"),
        columns: [col("id", "BIGINT"), col("amount", "BIGINT"), col("status", "VARCHAR"), col("_loaded_at", "TIMESTAMPTZ")],
      }),
      entry("daily", { kind: "sql", key: ["status"], codeHash: s.daily!.codeHash!, inputsSeen: seen("clean_orders"), columns: [col("status", "VARCHAR"), col("total", "HUGEINT")] }),
      entry("weekly", { kind: "sql", codeHash: s.weekly!.codeHash!, inputsSeen: seen("clean_orders"), columns: [col("n", "BIGINT")] }),
    ];
    return { root, catalog };
  }

  test("a new column upstream, used downstream: the run rebuilds the input first and binds against its new columns", async () => {
    const { root, catalog } = await shop();
    expect((await planRun({ root, timezone: "UTC", selectors: ["daily"], catalog })).order).toEqual(["daily"]);
    writeFiles(root, {
      "assets/clean_orders.sql": "-- key: id\nSELECT id, amount, status, round(amount * 1.2, 2) AS amount_vat FROM orders\n",
      "assets/daily.sql": "-- key: status\nSELECT status, sum(amount_vat) AS total_vat FROM clean_orders GROUP BY ALL\n",
    });
    const only = await planRun({ root, timezone: "UTC", selectors: ["daily"], catalog, only: true });
    expect(only.order).toEqual(["clean_orders", "daily"]);
    const s = by(only);
    expect(codes(s.daily)).toEqual([]);
    expect(s.clean_orders).toMatchObject({
      action: "rebuild", reasons: ["code_changed"], reason: "SQL changed (assets/clean_orders.sql); daily reads its new columns", problems: [],
      neededBy: ["daily"],
    });
    expect(s.daily).toMatchObject({ action: "rebuild", reasons: ["requested", "code_changed", "input_changed"] });
    expect(s.daily!.neededBy).toBeUndefined();
    // Without --only, what else reads the rebuilt input follows it, as for any asset a run takes.
    const all = await planRun({ root, timezone: "UTC", selectors: ["daily"], catalog });
    expect(all.order).toEqual(["clean_orders", "daily", "weekly"]);
    expect(codes(by(all).daily)).toEqual([]);
    // A preview plans the same way (it names the same assets): no UNKNOWN_COLUMN for amount_vat.
    expect(by(await planRun({ root, timezone: "UTC", selectors: ["daily"], catalog })).daily!.problems).toEqual([]);
  });

  test("an input whose SQL changed but whose columns did not is left alone; a never-built SQL input is built first", async () => {
    const { root, catalog } = await shop();
    writeFiles(root, { "assets/clean_orders.sql": "-- key: id\nSELECT id, amount, status FROM orders WHERE status <> 'void'\n" });
    expect((await planRun({ root, timezone: "UTC", selectors: ["daily"], catalog, only: true })).order).toEqual(["daily"]);
    // Never built: nothing to read yet, so it runs first (its own input, orders, is built).
    const unbuilt = catalog.filter((c) => c.asset !== "clean_orders");
    const first = by(await planRun({ root, timezone: "UTC", selectors: ["daily"], catalog: unbuilt, only: true }));
    expect(Object.keys(first)).toEqual(["clean_orders", "daily"]);
    expect(first.clean_orders).toMatchObject({ action: "rebuild", reasons: ["never_built"], reason: "never built; daily reads it" });
    expect(codes(first.daily)).toEqual([]);
  });

  test("a broken SQL input is not taken: the reader reads its table as it is", async () => {
    const { root, catalog } = await shop();
    writeFiles(root, { "assets/clean_orders.sql": "-- key: id\nSELECT id, amount, status, nope FROM orders\n" });
    const s = by(await planRun({ root, timezone: "UTC", selectors: ["daily"], catalog, only: true }));
    expect(Object.keys(s)).toEqual(["daily"]);
    expect(codes(s.daily)).toEqual([]);
  });
});

// R2.2: a named run of an asset whose input was never built, and is not in the run, dropped the bind's
// INPUT_NOT_BUILT: the dry run said it would run, and the run failed with UNKNOWN_TABLE "no table named orders".
describe("planRun: an input never built that the run does not build", () => {
  test("the step is skipped with INPUT_NOT_BUILT naming the run that builds the input; what reads it too", async () => {
    const root = makeProject(PROJECT);
    const plan = await planRun({ root, timezone: "UTC", selectors: ["open_issues"], catalog: [] });
    expect(plan.order).toEqual(["open_issues", "triage"]);
    const s = by(plan);
    expect(s.open_issues).toMatchObject({ action: "skip", reason: "input api has never been built, and this run does not build it (croft run api does)" });
    expect(s.open_issues!.problems).toMatchObject([{
      code: "INPUT_NOT_BUILT", severity: "warning", asset: "open_issues", file: "assets/open_issues.sql",
      message: "open_issues reads api, which has never been built, and this run does not build it",
      hint: "build api first (croft run api), or both in one run: croft run open_issues --upstream",
      fix: { kind: "command", command: "croft run api" },
      details: { input: "api", inputs: ["api"] },
    }]);
    expect(loadErrors(s.open_issues!)).toEqual([]);
    // triage reads open_issues, which this run no longer builds; building api builds both after it.
    expect(s.triage).toMatchObject({ action: "skip", reason: "input open_issues has never been built, and this run does not build it (croft run api does)" });
    expect(s.triage!.problems[0]).toMatchObject({
      code: "INPUT_NOT_BUILT", message: "triage reads open_issues, which has never been built, and this run does not build it",
      hint: "build api first (croft run api), or both in one run: croft run triage --upstream",
      fix: { command: "croft run api" }, details: { input: "open_issues", notBuilt: ["api"] },
    });

    // A TS transform too, whose input is built: only what is missing counts.
    const withApi = [entry("api", { write: "merge", key: ["id"], columns: API_COLUMNS })];
    const t = by(await planRun({ root, timezone: "UTC", selectors: ["triage"], catalog: withApi }));
    expect(t.triage).toMatchObject({ action: "skip", problems: [{ code: "INPUT_NOT_BUILT", fix: { command: "croft run open_issues" } }] });
    // --upstream builds it first; so does naming it, or a bare run.
    expect(by(await planRun({ root, timezone: "UTC", selectors: ["open_issues"], catalog: [], upstream: true })).open_issues!.action).toBe("rebuild");
    expect(by(await planRun({ root, timezone: "UTC", selectors: ["api", "open_issues"], catalog: [] })).open_issues!.problems).toEqual([]);
    expect(by(await planRun({ root, timezone: "UTC", selectors: [], catalog: [] })).triage!.action).toBe("update");
    // An input never built that reads another never built: the fix builds the root, and so everything after it.
    const deep = by(await planRun({ root, timezone: "UTC", selectors: ["triage"], catalog: [], only: true }));
    expect(deep.triage).toMatchObject({
      action: "skip", reason: "input open_issues has never been built, and this run does not build it (croft run api does)",
      problems: [{ code: "INPUT_NOT_BUILT", fix: { command: "croft run api" }, details: { inputs: ["open_issues"], notBuilt: ["api"] } }],
    });
    // An input that fails to load is the run's own news: its reader is planned, and skipped when it fails.
    writeFiles(root, { "assets/open_issues.sql": "-- key: id\nSELECT id, title FROM api WHERE\n" });
    const broken = by(await planRun({ root, timezone: "UTC", selectors: ["open_issues"], catalog: withApi }));
    expect(broken.triage).toMatchObject({ action: "update", problems: [] });
  });
});

// R2.2: DESIGN §3c's warn example `-- warn: id IN (SELECT issue_id FROM issue_triage)`, with issue_triage reading
// open_issues, made an ordering edge that closed a cycle: both assets failed with CYCLE on every run, though a
// warning never blocks anything.
describe("planRun: a warning's subquery does not order the steps", () => {
  const TRIAGE_OPEN = `import { transform } from "@zabaca/croft";
export default transform({ inputs: ["open_issues"], key: "issue_id", incremental: true, async *rows() {} });
`;
  const FILES = {
    "assets/github_issues.sql": "-- key: id\nSELECT i AS id, 'Issue ' || i AS title FROM range(1, 4) t(i)\n",
    "assets/open_issues.sql": "-- key: id\n-- warn: id IN (SELECT issue_id FROM issue_triage)\nSELECT id, title FROM github_issues\n",
    "assets/issue_triage.ts": TRIAGE_OPEN,
  };
  const WARNING = "id IN (SELECT issue_id FROM issue_triage)";

  test("no cycle; a warning whose table is not built when it would run is skipped with an info note", async () => {
    const root = makeProject(FILES);
    const plan = await planRun({ root, timezone: "UTC", selectors: [], catalog: [] });
    expect(plan.problems).toEqual([]);
    expect(plan.order).toEqual(["github_issues", "open_issues", "issue_triage"]);
    const s = by(plan);
    expect(s.open_issues!.orderAfter).toEqual(["github_issues"]);
    expect(s.issue_triage).toMatchObject({ action: "update", problems: [] });
    // issue_triage is built after open_issues (a warning does not wait for it): the warning is left out this run.
    expect(s.open_issues!.checks.map((c) => c.source)).toEqual(["unique(id)", "not_null(id)"]);
    expect(s.open_issues!.problems).toMatchObject([{
      code: "INPUT_NOT_BUILT", severity: "info", asset: "open_issues", file: "assets/open_issues.sql", line: 2,
      message: `open_issues: the warning "${WARNING}" reads issue_triage, which has not been built yet, so it is skipped in this run`,
      details: { check: WARNING, table: "issue_triage" },
    }]);
    expect(loadErrors(s.open_issues!)).toEqual([]);

    // Once issue_triage is built, the warning reads it as it is, whatever runs after.
    const built = [entry("issue_triage", { kind: "ts", write: "merge", key: ["issue_id"] })];
    const later = by(await planRun({ root, timezone: "UTC", selectors: ["open_issues"], catalog: [...built, entry("github_issues", { kind: "sql" })] }));
    expect(later.open_issues!.checks.map((c) => c.source)).toContain(WARNING);
    expect(later.open_issues!.problems).toEqual([]);
  });

  test("a blocking check that reads a downstream table is still a cycle: it runs before the write commits", async () => {
    const root = makeProject({ ...FILES, "assets/open_issues.sql": `-- key: id\n-- check: ${WARNING}\nSELECT id, title FROM github_issues\n` });
    const s = by(await planRun({ root, timezone: "UTC", selectors: [], catalog: [] }));
    expect(codes(s.open_issues)).toEqual(["CYCLE"]);
    expect(codes(s.issue_triage)).toEqual(["CYCLE"]);
  });
});

describe("the --from matrix (§8)", () => {
  const step = (o: Partial<Parameters<typeof backfillUnsupported>[0]>) =>
    ({ asset: "x", file: "assets/x.ts", kind: "rows", write: "merge", incremental: cursor, ...o }) as Parameters<typeof backfillUnsupported>[0];

  test("merge and append cursor ingests take --from; everything else is BACKFILL_UNSUPPORTED with its own fix", () => {
    expect(backfillUnsupported(step({}))).toBeNull();
    expect(backfillUnsupported(step({ write: "append" }))).toBeNull();
    expect(backfillUnsupported(step({ write: "replace", incremental: none }))?.problem.hint).toBe("replace ingests always fetch everything: croft run x");
    expect(backfillUnsupported(step({ kind: "transform" }))?.code).toBe("BACKFILL_UNSUPPORTED");
  });

  // §8's table: the texts name --rebuild where a rebuild is what backfills. A rebuild that trashes (an ingest, an
  // incremental TS transform) is never a command fix: it asks first, and a destructive command is the user's to run.
  test("BACKFILL_UNSUPPORTED names --rebuild as §8 does; only a rebuild that needs no confirmation is a command fix", () => {
    const file = backfillUnsupported(step({ kind: "file", incremental: { kind: "files" } }))!.problem;
    expect(file.hint).toBe("changed files reload automatically; croft run x --rebuild reloads all files (its table goes to the trash first, after confirmation)");
    expect(file.fix).toEqual({ kind: "command", description: "load the new and changed files", command: "croft run x" });
    const sql = backfillUnsupported(step({ kind: "sql", incremental: none }))!.problem;
    expect(sql.hint).toBe("use croft run x --rebuild: a transform is recomputed from its inputs");
    expect(sql.fix).toEqual({ kind: "command", description: "recompute the transform", command: "croft run x --rebuild" });
    const full = backfillUnsupported(step({ kind: "transform", incremental: none }))!.problem;
    expect(full.fix).toMatchObject({ kind: "command", command: "croft run x --rebuild" });
    const inc = backfillUnsupported(step({ kind: "transform", incremental: { kind: "new-rows", inputs: ["a"] } }))!.problem;
    expect(inc.hint).toBe("use croft run x --rebuild: it processes every input row again with the code as it is now (its table goes to the trash first, after confirmation)");
    expect(inc.fix).toMatchObject({ kind: "manual", requiresHuman: true });
    expect(inc.fix!.description).toContain("croft run x --rebuild");
  });

  // The runner's rule: under --from only fetches run (a merge ingest backfills); every transform is skipped, what
  // reads a backfilled ingest included, and a bare `croft run` updates them afterwards.
  test("in a bare run or a glob, what --from does not apply to is skipped, and so is every transform, as the runner skips it", async () => {
    const root = makeProject({
      ...PROJECT,
      "assets/zones.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ async *rows() {} });\n`,
      "assets/zone_report.sql": "SELECT count(*) AS n FROM zones\n",
      "assets/broken.ts": `import { transform } from "@zabaca/croft";\nexport default transform({ inputs: [ });\n`,
    });
    const catalog = await builtCatalog(root);
    const s = by(await planRun({ root, timezone: "UTC", selectors: [], catalog: withEntry(catalog, "consts", { codeHash: "old" }), from: "-7d" }));
    expect(s.api).toMatchObject({ action: "fetch" });
    expect(s.zones).toMatchObject({ action: "skip", reason: FROM_ONLY_MERGE });
    expect(s.zone_report).toMatchObject({ action: "skip", reason: FROM_ONLY_MERGE });
    expect(s.consts).toMatchObject({ action: "skip", reason: FROM_ONLY_MERGE });
    expect(s.open_issues).toMatchObject({ action: "skip", reason: FROM_ONLY_MERGE });
    expect(s.triage).toMatchObject({ action: "skip", reason: FROM_ONLY_MERGE });
    // A transform that does not load is skipped too: the runner never gets to its errors.
    expect(s.broken).toMatchObject({ action: "skip", reason: FROM_ONLY_MERGE });
    expect(by(await planRun({ root, timezone: "UTC", selectors: ["api"], catalog, from: "-7d" })).open_issues).toMatchObject({ action: "skip", reason: FROM_ONLY_MERGE });
    // Named exactly, a transform is refused by the runner's checkRunFlags (BACKFILL_UNSUPPORTED) before anything runs.
    expect(by(await planRun({ root, timezone: "UTC", selectors: ["consts"], catalog, from: "-7d" })).consts!.action).toBe("skip");
  });
});

describe("planRun --rebuild (§4.1, §6)", () => {
  test("names only: a bare --rebuild or a glob is USAGE_ERROR, before any asset code is imported", async () => {
    const root = makeProject(PROJECT);
    await expect(planRun({ root, timezone: "UTC", selectors: [], catalog: [], rebuild: true })).rejects.toMatchObject({
      code: "USAGE_ERROR", problem: { message: "--rebuild takes the names of the assets to build from scratch" },
    });
    await expect(planRun({ root, timezone: "UTC", selectors: ["api", "open_*"], catalog: [], rebuild: true })).rejects.toMatchObject({
      code: "USAGE_ERROR", problem: { message: "--rebuild takes exact asset names, not a glob (open_*)" },
    });
    expect(() => rebuildSelectors(["api"])).not.toThrow();
    expect(rebuildCommand("api")).toBe("croft run api --rebuild");
  });

  test("the named assets are built from scratch; what else the run takes runs as in any run", async () => {
    const root = makeProject(PROJECT);
    const catalog = withEntry(await builtCatalog(root), "triage", { codeHash: "older", rows: 42 });
    const s = by(await planRun({ root, timezone: "America/Los_Angeles", selectors: ["api", "triage"], catalog, rebuild: true }));
    expect(s.api).toMatchObject({ kind: "rows", action: "fetch", rebuild: true, reasons: ["requested", "rebuild"], reason: "requested; from scratch (--rebuild)" });
    // An incremental TS transform processes every input row again: a rebuild, not an update. The new code builds
    // every row, so the warning about rows older code built does not apply, and neither does "new rows only".
    expect(s.triage).toMatchObject({ kind: "transform", action: "rebuild", rebuild: true });
    expect(s.triage!.reasons.slice(0, 2)).toEqual(["requested", "rebuild"]);
    expect(s.triage!.reason).toStartWith("requested; from scratch (--rebuild)");
    expect(s.triage!.reason).not.toContain("new input rows only");
    expect(codes(s.triage)).toEqual([]);
    // Downstream of api, open_issues is updated as any run updates it: not rebuilt.
    expect(s.open_issues).toMatchObject({ action: "rebuild", reasons: ["input_changed"] });
    expect(s.open_issues!.rebuild).toBeUndefined();
    // An SQL transform named: recomputed, as every run of it is.
    const sql = by(await planRun({ root, timezone: "America/Los_Angeles", selectors: ["consts"], catalog, rebuild: true }));
    expect(sql.consts).toMatchObject({ action: "rebuild", rebuild: true, reason: "requested; from scratch (--rebuild)" });
    // Without --rebuild nothing is marked, and the incremental transform updates.
    const plain = by(await planRun({ root, timezone: "America/Los_Angeles", selectors: ["triage"], catalog }));
    expect(plain.triage).toMatchObject({ action: "update" });
    expect(plain.triage!.rebuild).toBeUndefined();
    expect(codes(plain.triage)).toEqual(["EDITED_SINCE_LAST_RUN"]);
  });
});

// R32-08 (the run's side): `croft run --due`, started by the scheduler, imported every TS transform to plan, so the
// top-level code of an edit nobody had run executed unattended (§6 "The scheduler only runs code a human has run").
describe("planRun --due: code nobody ran by hand is never imported", () => {
  const MARK = (name: string) => `import { appendFileSync } from "node:fs";\nappendFileSync(new URL("../imported.txt", import.meta.url), "${name}\\n");\n`;
  const marked = (root: string) => (existsSync(join(root, "imported.txt")) ? readFileSync(join(root, "imported.txt"), "utf8").split("\n").filter(Boolean) : []);

  test("a TS asset whose bundle is not the approved code is planned from the scheduler's facts, not imported, and held", async () => {
    const root = makeProject({
      "assets/api.ts": MARK("api") + INGEST,
      "assets/open_issues.sql": "-- key: id\nSELECT id, title FROM api\n",
      "assets/triage.ts": MARK("triage") + TRIAGE,
      "assets/fresh.ts": `${MARK("fresh")}import { transform } from "@zabaca/croft";\nexport default transform({ inputs: ["api"], async *rows() {} });\n`,
    });
    const hashOf = (name: string) => tsFingerprint(join(root, "assets", `${name}.ts`), { root, timezone: "UTC" });
    // api is the code a person ran; triage was edited since; fresh was never run by hand.
    const approved: Record<string, string> = { api: await hashOf("api"), triage: "the code a person ran before the edit" };
    const catalog = [
      entry("api", { write: "merge", key: ["id"], columns: API_COLUMNS, codeHash: approved.api! }),
      entry("open_issues", { kind: "sql", key: ["id"], columns: [col("id", "BIGINT"), col("title", "VARCHAR")], inputsSeen: { api: { seenLoadedAt: T1, seenKey: null, inputLastLoadedAt: T1 } } }),
      entry("triage", { kind: "ts", write: "merge", key: ["id"], codeHash: approved.triage!, inputsSeen: { open_issues: { seenLoadedAt: T1, seenKey: [5], inputLastLoadedAt: T1 } } }),
    ];
    const known: Record<string, { kind: "ts"; inputs: string[]; incremental: boolean }> = { triage: { kind: "ts", inputs: ["open_issues"], incremental: true } };
    const due: DuePlanning = {
      hold: (st) => (st.kind === "sql" || (st.codeHash !== undefined && st.codeHash === approved[st.asset]) ? null
        : { hold: "code_not_run_by_hand", reason: "held: code edited, not run by hand yet" }),
      fire: () => null,
      imports: { approved: (a) => approved[a] ?? null, known: (a) => known[a] ?? null },
    };
    const plan = await planRun({ root, timezone: "UTC", selectors: ["api"], catalog, due });
    // Only the approved ingest's code ran; triage (edited) and fresh (never run by hand) were only bundled.
    expect(marked(root)).toEqual(["api"]);
    expect(plan.order).toEqual(["api", "open_issues", "triage"]);
    const s = by(plan);
    expect(s.api).toMatchObject({ action: "fetch", reasons: ["schedule_due"] });
    expect(s.api!.hold).toBeUndefined();
    // triage is planned from what the scheduler knows of it (it reads open_issues), and held.
    expect(s.triage).toMatchObject({
      kind: "transform", notImported: true, hold: "code_not_run_by_hand", reason: "held: code edited, not run by hand yet",
      inputs: ["open_issues"], codeHash: await hashOf("triage"),
    });
    expect(s.triage!.spec).toBeUndefined();
    expect(s.fresh).toBeUndefined();
    // Held even when the hold itself would let it through (an approval between the import and the hold).
    const lenient: DuePlanning = { ...due, hold: () => null };
    const again = by(await planRun({ root, timezone: "UTC", selectors: ["api"], catalog, due: lenient }));
    expect(again.triage).toMatchObject({ notImported: true, hold: "code_not_run_by_hand", reason: "held: its code has not been run by hand yet" });
    // A run by hand imports as always.
    await planRun({ root, timezone: "UTC", selectors: ["triage"], catalog });
    expect(marked(root)).toEqual(["api", "fresh", "triage"]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// What the catalog mirror shows before the run: behavior and pin changes (§6), renamed files (ASSET_RENAMED)

describe("pendingBehavior: a behavior change the catalog mirror shows before a run (INGEST_CONFIG_CHANGED)", () => {
  const seq: Incremental = { kind: "cursor", field: "seq", lookbackMs: 0 };
  const side = (o: Partial<BehaviorSide> = {}): BehaviorSide => {
    const write = o.write ?? "append";
    const key = o.key ?? [];
    const incremental = o.incremental ?? seq;
    return { asset: "events", file: "assets/events.ts", kind: "rows", codeHash: "new-code", write, key, incremental, behaviorHash: behaviorHash(write, key, incremental), ...o };
  };
  const built = (o: Partial<CatalogAsset> = {}) =>
    entry("events", { write: "append", key: [], rows: 1200, cursor: { field: "seq", value: "9", type: "integer", unit: null }, codeHash: "old-code", ...o });
  const rebuild = "croft run events --rebuild refetches everything under the new rules (its table goes to the trash first, and it asks for confirmation)";

  test("an append ingest gaining a key, with the same cursor: a run asks to convert it in place; a warning with the run's three fixes", () => {
    const p = pendingBehavior(side({ write: "merge", key: ["id"] }), built());
    expect(p).toMatchObject({ convertible: true, rows: 1200, change: { changed: ["write", "key"], from: { write: "append", key: [] }, to: { write: "merge", key: ["id"] } } });
    expect(p!.problem).toMatchObject({
      code: "INGEST_CONFIG_CHANGED", severity: "warning", asset: "events", file: "assets/events.ts",
      message: "events now has the key id, but its 1200 stored rows were appended without one: croft run events counts the stored rows with the same id and asks before converting them in place (it keeps the latest row of each id, and the table goes to the trash first)",
      hint: `ask the user; if they agree, croft run events asks for the conversion and they confirm it. Otherwise remove the key again, or ${rebuild}`,
      effect: "croft run events stops to ask before it fetches anything",
      fix: { kind: "edit", description: "put the write mode and key back as it was (write: append → merge; key: none → id)", file: "assets/events.ts" },
    });
    expect(p!.problem.details).toMatchObject({ changed: ["write", "key"], rows: 1200, convertible: true, pending: true });
    expect(p!.problem.details!.fixes).toEqual([
      { kind: "edit", description: "put the write mode and key back as it was (write: append → merge; key: none → id)", file: "assets/events.ts" },
      { kind: "manual", requiresHuman: true, description: `ask the user whether to refetch from the source: ${rebuild}` },
      { kind: "manual", requiresHuman: true, description: "ask the user whether to convert in place: croft run events asks for confirmation, moves the table to the trash first, then keeps the latest row of each id" },
    ]);
    // A keyed append (write stays append) converts in place too.
    expect(pendingBehavior(side({ key: ["id"] }), built())).toMatchObject({ convertible: true, change: { changed: ["key"] } });
  });

  test("another key, write mode or cursor field: a run fails before it fetches; an error with the run's fixes and words", () => {
    const merged = built({ write: "merge", key: ["id"] });
    const key = pendingBehavior(side({ write: "merge", key: ["uuid"] }), merged)!;
    expect(key).toMatchObject({ convertible: false });
    expect(key.problem).toMatchObject({
      code: "INGEST_CONFIG_CHANGED", severity: "error",
      message: "events's 1200 stored rows were written as merge by id, but its code now says merge by uuid (key: id → uuid); croft does not rewrite stored rows on its own",
      hint: `put the key back as it was in assets/events.ts, or ${rebuild}`,
      effect: "croft run events fails before it fetches anything",
      fix: { kind: "edit", description: "put the key back as it was (key: id → uuid)", file: "assets/events.ts" },
    });
    expect(key.problem.details!.fixes).toHaveLength(2);
    // The cursor field, from the mirror's saved cursor.
    const field = pendingBehavior(side({ write: "merge", key: ["id"], incremental: { kind: "cursor", field: "created", lookbackMs: 0 } }), merged)!;
    expect(field.problem.message).toBe("events's 1200 stored rows were written as merge by id, but its code now says merge by id (incremental: seq → created); croft does not rewrite stored rows on its own");
    expect(field.problem.severity).toBe("error");
    // An append ingest gaining a key AND a new cursor field is not converted in place.
    expect(pendingBehavior(side({ write: "merge", key: ["id"], incremental: { kind: "cursor", field: "created", lookbackMs: 0 } }), built())).toMatchObject({ convertible: false });
    // A cursor added to a replace ingest: "incremental: now created".
    const replaced = built({ write: "replace", key: ["id"], cursor: null });
    const added = pendingBehavior(side({ write: "merge", key: ["id"], incremental: { kind: "cursor", field: "created", lookbackMs: 0 } }), replaced)!;
    expect(added.problem.message).toContain("(write: replace → merge; incremental: now created)");
  });

  test("nothing when the code is the code that built it, the table is empty, it is no ingest, or nothing that counts changed", () => {
    const merge = side({ write: "merge", key: ["id"] });
    expect(pendingBehavior(merge, built({ codeHash: "new-code" }))).toBeNull();
    expect(pendingBehavior(merge, built({ codeHash: null }))).toBeNull();
    expect(pendingBehavior({ ...merge, codeHash: undefined }, built())).toBeNull();
    expect(pendingBehavior(merge, built({ rows: 0 }))).toBeNull();
    expect(pendingBehavior(merge, null)).toBeNull();
    expect(pendingBehavior(merge, built({ kind: "sql" }))).toBeNull();
    expect(pendingBehavior({ ...merge, kind: "sql" }, built())).toBeNull();
    // A reordered or re-cased key, and a lookback, are no change.
    const two = built({ write: "merge", key: ["a", "b"] });
    expect(pendingBehavior(side({ write: "merge", key: ["B", "a"] }), two)).toBeNull();
    expect(pendingBehavior(side({ write: "merge", key: ["a", "b"], incremental: { kind: "cursor", field: "seq", lookbackMs: 86_400_000 } }), two)).toBeNull();
    // A file ingest's incremental setting is not in the mirror: only its write mode and key are compared.
    const files = built({ write: "merge", key: ["order_id"], cursor: null });
    expect(pendingBehavior(side({ kind: "file", write: "merge", key: ["order_id"], incremental: { kind: "files" } }), files)).toBeNull();
    expect(pendingBehavior(side({ kind: "file", write: "merge", key: ["sku"], incremental: { kind: "files" } }), files)).toMatchObject({ change: { changed: ["key"] } });
  });
});

describe("pendingPins: pins that differ from the stored type, as the catalog mirror has it", () => {
  const pinCol = (name: string, type: string, o: Partial<CatalogColumn> = {}): CatalogColumn => ({ ...col(name, type), ...o });
  const stored = entry("events", {
    rows: 10, codeHash: "old-code",
    columns: [pinCol("zip", "VARCHAR"), pinCol("amount", "DOUBLE"), pinCol("note", "VARCHAR", { pending: true }), pinCol("n", "INTEGER"), pinCol("_loaded_at", "TIMESTAMPTZ")],
  });
  const side = (pins: Record<string, { type: string; format?: string }>): BehaviorSide => ({
    asset: "events", file: "assets/events.ts", kind: "rows", codeHash: "new-code", write: "replace", key: [], incremental: { kind: "none" },
    behaviorHash: behaviorHash("replace", [], { kind: "none" }), pins,
  });

  test("a pin to another type is listed; an alias, a pending column, a column not stored and an unchanged code are not", () => {
    expect(pendingPins(side({ zip: { type: "BIGINT" }, amount: { type: "decimal(18, 2)" } }), stored)).toEqual([
      { column: "zip", from: "VARCHAR", to: "BIGINT" }, { column: "amount", from: "DOUBLE", to: "DECIMAL(18,2)" },
    ]);
    expect(pendingPins(side({ zip: { type: "text" }, n: { type: "INT" }, note: { type: "BIGINT" }, gone: { type: "DATE" } }), stored)).toEqual([]);
    expect(pendingPins(side({ zip: { type: "BIGINT" } }), { ...stored, codeHash: "new-code" })).toEqual([]);
    expect(pendingPins(side({ zip: { type: "BIGINT" } }), { ...stored, rows: 0 })).toEqual([]);
    // A pin that is no plain type is the run's ASSET_INVALID, not a pin change.
    expect(pendingPins(side({ zip: { type: "VARCHAR; DROP TABLE x" } }), stored)).toEqual([]);
  });
});

describe("planRun: an asset ASSET_RENAMED reports is never fetched from scratch (§6)", () => {
  test("named exactly, it fails before it runs with the rename as its fix; a bare run or a glob skips it, and what reads it", async () => {
    const root = makeProject({ "assets/purchases.ts": INGEST, "assets/by_day.sql": "SELECT id FROM purchases\n", "assets/consts.sql": "SELECT 1 AS x\n" });
    const hash = by(await planRun({ root, timezone: "UTC", selectors: ["purchases"], catalog: [] })).purchases!.codeHash!;
    // orders.ts was renamed to purchases.ts outside croft: its table is an orphan with the same code.
    const catalog = [entry("orders", { write: "merge", key: ["id"], rows: 1130, columns: API_COLUMNS, codeHash: hash })];

    const named = by(await planRun({ root, timezone: "UTC", selectors: ["purchases"], catalog }));
    expect(named.purchases!.renamed).toEqual({ from: "orders", to: "purchases", unfinished: false });
    expect(loadErrors(named.purchases!)).toMatchObject([{
      code: "ASSET_RENAMED", severity: "error", asset: "purchases", file: "assets/purchases.ts",
      fix: { kind: "command", description: "adopt orders's table and state as purchases", command: "croft rename orders purchases" },
    }]);
    // What reads it is planned: the runner skips it when purchases fails, as for any failed input.
    expect(named.by_day!.action).toBe("rebuild");

    const bare = by(await planRun({ root, timezone: "UTC", selectors: [], catalog }));
    const why = "looks like orders renamed outside croft: croft rename orders purchases adopts its table and state (a run would fetch everything again)";
    expect(bare.purchases).toMatchObject({ action: "skip", reason: why, renamed: { from: "orders", to: "purchases" } });
    expect(loadErrors(bare.purchases!)).toEqual([]);
    expect(skipProblem(bare.purchases!)).toMatchObject({ code: "ASSET_RENAMED", severity: "warning", fix: { command: "croft rename orders purchases" } });
    expect(bare.by_day).toMatchObject({
      action: "skip", reason: "input purchases has never been built: it looks like orders renamed outside croft (croft rename orders purchases adopts its table)",
      renamed: { from: "orders", to: "purchases" },
    });
    expect(skipProblem(bare.by_day!)).toBeUndefined();
    expect(bare.consts!.action).toBe("rebuild");
    // A glob is not a name: skipped too.
    expect(by(await planRun({ root, timezone: "UTC", selectors: ["purch*"], catalog })).purchases!.action).toBe("skip");
    // Without the orphan it is a first build.
    const fresh = by(await planRun({ root, timezone: "UTC", selectors: ["purchases"], catalog: [] })).purchases!;
    expect(fresh.problems).toEqual([]);
    expect(fresh.renamed).toBeUndefined();
  });

  test("a croft rename that did not finish: neither name runs until `croft rename <old> <new>` finishes it", async () => {
    const root = makeProject({ "assets/orders.ts": INGEST, "assets/consts.sql": "SELECT 1 AS x\n" });
    writeFiles(root, { ".croft/rename.json": JSON.stringify({ from: "orders", to: "purchases", fileFrom: "assets/orders.ts", fileTo: "assets/purchases.ts", mode: "file" }) });
    const catalog = [entry("orders", { write: "merge", key: ["id"], rows: 1130, columns: API_COLUMNS })];
    const named = by(await planRun({ root, timezone: "UTC", selectors: ["orders"], catalog }));
    expect(named.orders!.renamed).toEqual({ from: "orders", to: "purchases", unfinished: true });
    expect(loadErrors(named.orders!)).toMatchObject([{ code: "ASSET_RENAMED", asset: "orders", fix: { command: "croft rename orders purchases" } }]);
    const bare = by(await planRun({ root, timezone: "UTC", selectors: [], catalog }));
    expect(bare.orders).toMatchObject({ action: "skip", reason: "croft rename orders purchases did not finish: orders does not run until the same command finishes it" });
    expect(bare.consts!.action).toBe("rebuild");
  });
});
