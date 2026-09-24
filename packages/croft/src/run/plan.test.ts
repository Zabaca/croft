import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Incremental } from "../core/types.ts";
import { type CatalogAsset, type CatalogColumn, putCatalog } from "../history/catalog.ts";
import { RunsDb } from "../history/runs-db.ts";
import {
  backfillUnsupported, behaviorHash, behaviorLabel, behaviorWords, FROM_ONLY_MERGE, fileDirsOf, isGlob, loadErrors, type PlannedStep,
  planRun, type RunPlan, resolveWrite, selectAssets, staleViewOf,
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
    expect(later.triage!.reason).toBe("requested; input open_issues was replaced (restored, or changed outside croft); input open_issues may have new rows (TS code unchanged)");
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

describe("the --from matrix (§8)", () => {
  const step = (o: Partial<Parameters<typeof backfillUnsupported>[0]>) =>
    ({ asset: "x", file: "assets/x.ts", kind: "rows", write: "merge", incremental: cursor, ...o }) as Parameters<typeof backfillUnsupported>[0];

  test("merge and append cursor ingests take --from; everything else is BACKFILL_UNSUPPORTED with its own fix", () => {
    expect(backfillUnsupported(step({}))).toBeNull();
    expect(backfillUnsupported(step({ write: "append" }))).toBeNull();
    expect(backfillUnsupported(step({ write: "replace", incremental: none }))?.problem.hint).toBe("replace ingests always fetch everything: croft run x");
    expect(backfillUnsupported(step({ kind: "file" }))?.problem.hint).toContain("changed files reload automatically");
    expect(backfillUnsupported(step({ kind: "sql" }))?.problem.hint).toContain("nothing to backfill: croft run x");
    expect(backfillUnsupported(step({ kind: "transform" }))?.code).toBe("BACKFILL_UNSUPPORTED");
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
