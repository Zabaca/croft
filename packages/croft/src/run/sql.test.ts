import { afterAll, describe, expect, test } from "bun:test";
import { CroftError, problem } from "../core/errors.ts";
import type { AssetKind, Problem } from "../core/types.ts";
import { closeAllWarehouses, type DuckWarehouse, openWarehouse } from "../db/warehouse.ts";
import { getCatalog } from "../history/catalog.ts";
import { openLog } from "../history/logs.ts";
import { RunsDb } from "../history/runs-db.ts";
import { quoteIdent } from "../load/evolve.ts";
import { tableBatch } from "../load/table-batch.ts";
import { writeBatch } from "../load/write.ts";
import { ProjectEnv } from "../project/env.ts";
import { loadProject, type Project } from "../project/root.ts";
import type { LoadedSqlAsset } from "../project/sql-asset.ts";
import { StepProgress } from "./ingest.ts";
import { behaviorHash, behaviorLabel, behaviorWords, type PlannedStep } from "./plan.ts";
import { runSqlStep } from "./sql.ts";
import type { StepInput, StepOutcome } from "./step.ts";
import { cleanupProjects, makeProject } from "./testkit.ts";

const opened: RunsDb[] = [];
afterAll(async () => {
  await closeAllWarehouses();
  for (const r of opened) r.close();
  cleanupProjects();
});

interface Env { project: Project; env: ProjectEnv; warehouse: DuckWarehouse; runs: RunsDb }

function setup(): Env {
  const root = makeProject({}, { timezone: "UTC" });
  const project = loadProject({ root });
  const warehouse = openWarehouse({
    path: project.paths.database, mode: "read_write", timezone: project.timezone, root, stateDir: project.paths.stateDir, register: false, isTTY: false,
  });
  const runs = RunsDb.open(project.paths.stateDir);
  opened.push(runs);
  return { project, env: ProjectEnv.load(root, {}), warehouse, runs };
}

const T0 = "2026-09-22T10:00:00.000000Z";
const T1 = "2026-09-22T11:00:00.000000Z";
const T2 = "2026-09-22T12:00:00.000000Z";
const T3 = "2026-09-22T13:00:00.000000Z";

/** Write an upstream asset the way its own step would: rows from a SELECT, through writeBatch. */
async function seed(e: Env, asset: string, select: string, o: { now: string; kind?: AssetKind; key?: string[] }): Promise<void> {
  await e.warehouse.write(`seed ${asset}`, async (tx) => {
    await tx.exec(`CREATE OR REPLACE TEMP TABLE seed_batch AS SELECT *, row_number() OVER () AS _croft_seq FROM (${select})`);
    const batch = await tableBatch(tx, { temp: "seed_batch", asset });
    await writeBatch(tx, { batch, target: { asset, write: "replace", key: o.key ?? [], runId: "r_seed" }, kind: o.kind ?? "ingest", now: o.now });
    await tx.exec(`DROP TABLE temp.main.seed_batch`);
  }, { runId: "r_seed" });
}

const ISSUES = `SELECT * FROM (VALUES (1, 'crash', 'open'), (2, 'docs', 'closed'), (3, 'hang', 'open')) AS v(id, title, state)`;

interface StepSpec { header?: string[]; key?: string[]; inputs?: string[]; problems?: Problem[]; ok?: boolean }

function sqlStep(name: string, body: string, o: StepSpec = {}): PlannedStep {
  const key = o.key ?? [];
  const header = o.header ?? [];
  const file = `assets/${name}.sql`;
  const sql: LoadedSqlAsset = {
    name, file, path: `/project/${file}`, ok: o.ok ?? true, header: { key, checks: [], warnings: [], lines: header.length }, body,
    headerLines: header.length, astInputs: o.inputs ?? [], codeHash: `code_${name}`, problems: o.problems ?? [],
  };
  const none = { kind: "none" } as const;
  return {
    asset: name, file, path: sql.path, kind: "sql", action: "rebuild", reasons: ["requested"], reason: "requested", problems: [], sql,
    inputs: o.inputs ?? [], orderAfter: o.inputs ?? [], readBy: [], checks: [], write: "replace", key, incremental: none,
    behavior: behaviorLabel("replace", key), words: behaviorWords("replace", key, none), codeHash: `code_${name}`,
    behaviorHash: behaviorHash("replace", key, none), retries: 0, timeoutMs: 60_000,
  };
}

let runSeq = 0;

async function run(e: Env, step: PlannedStep, o: Partial<StepInput> & { at?: string } = {}): Promise<StepOutcome & { runId: string }> {
  const runId = `r_${++runSeq}`;
  const log = openLog(e.project.paths.stateDir, runId, step.asset);
  const progress = new StepProgress(step.asset);
  const { at, ...rest } = o;
  try {
    const out = await runSqlStep({
      step, project: e.project, env: e.env, warehouse: e.warehouse, runs: e.runs, runId, attempt: 1, maxAttempts: 1,
      signal: new AbortController().signal, progress, log, now: () => new Date(at ?? T1), ...rest,
    });
    return { ...out, runId };
  } finally {
    progress.close();
    log.close();
  }
}

async function failure(p: Promise<unknown>): Promise<CroftError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
  throw new Error("expected a CroftError");
}

const read = <T = Record<string, unknown>>(e: Env, sql: string, params?: unknown[]) => e.warehouse.read((db) => db.all<T>(sql, params), { purpose: "test" });
const columns = async (e: Env, table: string) =>
  (await read<{ n: string }>(e, `SELECT column_name AS n FROM duckdb_columns() WHERE table_name = $1 AND schema_name = 'main' ORDER BY column_index`, [table])).map((r) => r.n);
const rows = (e: Env, table: string, order = "id") => read(e, `SELECT * EXCLUDE (_loaded_at) FROM ${quoteIdent(table)} ORDER BY ${order}`);
const stamps = async (e: Env, table: string) => Object.fromEntries((await read<{ k: unknown; s: string }>(e,
  `SELECT id AS k, strftime(_loaded_at AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%S.%fZ') AS s FROM ${quoteIdent(table)}`)).map((r) => [String(r.k), r.s]));
const inputsOf = (e: Env, asset: string) => read(e,
  `SELECT input, strftime(seen_loaded_at AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%S.%fZ') AS seen, seen_key AS k,
     strftime(input_last_loaded_at AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%S.%fZ') AS last
   FROM _croft.inputs WHERE asset = $1 ORDER BY input`, [asset]);
const temps = (e: Env) => e.warehouse.write("temps", (tx) => tx.all<{ name: string }>(
  `SELECT table_name AS name FROM duckdb_tables() WHERE database_name = 'temp' UNION ALL SELECT view_name FROM duckdb_views() WHERE temporary AND NOT internal`),
{ runId: "r_temps" });

describe("runSqlStep", () => {
  test("builds the table from the SELECT, records what it read of each input, and mirrors the catalog", async () => {
    const e = setup();
    await seed(e, "issues", ISSUES, { now: T0, key: ["id"] });
    const step = sqlStep("open_issues", "SELECT id, title FROM issues WHERE state = 'open'", { key: ["id"], inputs: ["issues"] });
    const out = await run(e, step);
    expect(out.result).toMatchObject({
      asset: "open_issues", status: "ok", reason: "requested", behavior: "replace; key id", attempt: 1, maxAttempts: 1,
      rows: { in: 2, added: 2, updated: 0, unchanged: 0, deleted: 0, total: 2 }, schemaChanges: [], checks: [],
      inputs: [{ input: "issues", seenBefore: null, seenAfter: T0, rows: 3 }],
      created: { columns: 2, jsonColumns: 0 }, logsCommand: "croft logs open_issues",
    });
    expect(out.warnings).toEqual([]);
    expect(out.problems).toEqual([]);
    expect(await rows(e, "open_issues")).toEqual([{ id: 1, title: "crash" }, { id: 3, title: "hang" }]);
    expect(await read(e, `SELECT kind, write_mode, key_columns, code_hash FROM _croft.assets WHERE name = 'open_issues'`))
      .toEqual([{ kind: "sql", write_mode: "replace", key_columns: ["id"], code_hash: "code_open_issues" }]);
    expect(await inputsOf(e, "open_issues")).toEqual([{ input: "issues", seen: T0, k: null, last: T0 }]);
    const writes = await read<{ inputs: unknown; attempt: number }>(e, `SELECT inputs, attempt FROM _croft.writes WHERE asset = 'open_issues'`);
    expect(writes).toEqual([{ inputs: [{ input: "issues", seenBefore: null, seenAfter: T0, rows: 3 }], attempt: 1 }]);
    expect(out.catalog).toMatchObject({
      asset: "open_issues", kind: "sql", write: "replace", key: ["id"], rows: 2, reads: ["issues"], codeHash: "code_open_issues", lastRunId: out.runId,
      cursor: null, lastLoadedAt: T1, inputsSeen: { issues: { seenLoadedAt: T0, seenKey: null, inputLastLoadedAt: T0 } },
    });
    expect(out.catalog!.columns.map((c) => [c.name, c.type])).toEqual([["id", "INTEGER"], ["title", "VARCHAR"], ["_loaded_at", "TIMESTAMPTZ"]]);
    expect(getCatalog(e.runs, "open_issues")).toEqual(out.catalog!);
    expect(await temps(e)).toEqual([]);
  });

  test("SELECT * over every asset kind leaves croft's reserved columns out, joins included", async () => {
    const e = setup();
    await seed(e, "issues", ISSUES, { now: T0 });
    await seed(e, "sales", `SELECT * FROM (VALUES (1, 9.5, 'files/a.csv')) AS v(id, amount, _file)`, { now: T0 });
    await seed(e, "triage", `SELECT * FROM (VALUES (1, 'bug'), (3, 'perf')) AS v(id, label)`, { now: T0, kind: "ts" });
    expect(await columns(e, "sales")).toEqual(["id", "amount", "_file", "_loaded_at"]);
    const build = async (name: string, body: string, inputs: string[]) => {
      await run(e, sqlStep(name, body, { inputs }));
      return columns(e, name);
    };
    expect(await build("all_issues", "SELECT * FROM issues", ["issues"])).toEqual(["id", "title", "state", "_loaded_at"]);
    expect(await build("all_sales", "SELECT * FROM sales", ["sales"])).toEqual(["id", "amount", "_loaded_at"]);
    expect(await build("all_triage", "SELECT * FROM triage", ["triage"])).toEqual(["id", "label", "_loaded_at"]);
    expect(await build("again", "SELECT * FROM all_issues", ["all_issues"])).toEqual(["id", "title", "state", "_loaded_at"]);
    expect(await build("joined", "SELECT * FROM issues JOIN triage USING (id)", ["issues", "triage"])).toEqual(["id", "title", "state", "label", "_loaded_at"]);
    expect(await build("shouting", "SELECT id, _LOADED_AT, _File FROM sales", ["sales"])).toEqual(["id", "_loaded_at"]);
    expect(await rows(e, "joined")).toEqual([{ id: 1, title: "crash", state: "open", label: "bug" }, { id: 3, title: "hang", state: "open", label: "perf" }]);
  });

  test("a trailing `;` or `--` comment, comments before the SELECT and a header all work", async () => {
    const e = setup();
    await seed(e, "issues", ISSUES, { now: T0 });
    for (const [name, body] of [
      ["a", "SELECT id FROM issues;"],
      ["b", "SELECT id FROM issues -- the ids"],
      ["c", "SELECT id FROM issues; -- done"],
      ["d", "-- ids only\nWITH x AS (SELECT id FROM issues)\nSELECT * FROM x\n-- end"],
      ["e", "FROM issues SELECT id"],
    ] as const) {
      const out = await run(e, sqlStep(name, body, { header: ["-- description: ids", "-- key: id"], key: ["id"], inputs: ["issues"] }));
      expect(out.result.rows.total).toBe(3);
      expect(await columns(e, name)).toEqual(["id", "_loaded_at"]);
    }
  });

  test("a rebuild is a diff: unchanged rows keep their stamp, and an unchanged result moves nothing", async () => {
    const e = setup();
    await seed(e, "issues", ISSUES, { now: T0, key: ["id"] });
    const step = sqlStep("open_issues", "SELECT id, title FROM issues WHERE state = 'open'", { key: ["id"], inputs: ["issues"] });
    await run(e, step, { at: T1 });
    const same = await run(e, step, { at: T2 });
    expect(same.result.rows).toEqual({ in: 2, added: 0, updated: 0, unchanged: 2, deleted: 0, total: 2 });
    expect(same.result.inputs).toEqual([{ input: "issues", seenBefore: T0, seenAfter: T0, rows: 3 }]);
    expect(same.catalog!.lastLoadedAt).toBe(T1);
    await seed(e, "issues", `SELECT * FROM (VALUES (1, 'crash!', 'open'), (2, 'docs', 'open'), (3, 'hang', 'closed')) AS v(id, title, state)`, { now: T2, key: ["id"] });
    const changed = await run(e, step, { at: T3 });
    expect(changed.result.rows).toEqual({ in: 2, added: 1, updated: 1, unchanged: 0, deleted: 1, total: 2 });
    expect(await stamps(e, "open_issues")).toEqual({ 1: T3, 2: T3 });
    expect(await inputsOf(e, "open_issues")).toEqual([{ input: "issues", seen: T2, k: null, last: T2 }]);
  });

  test("a keyless rebuild diffs by content, duplicates included", async () => {
    const e = setup();
    await seed(e, "issues", ISSUES, { now: T0 });
    const step = sqlStep("states", "SELECT state FROM issues", { inputs: ["issues"] });
    expect((await run(e, step, { at: T1 })).result.rows).toMatchObject({ added: 3, total: 3 });
    expect((await run(e, step, { at: T2 })).result.rows).toMatchObject({ added: 0, deleted: 0, unchanged: 3, total: 3 });
  });

  test("a changed SELECT shape recreates the table, restamping every row", async () => {
    const e = setup();
    await seed(e, "issues", ISSUES, { now: T0 });
    await run(e, sqlStep("open_issues", "SELECT id, title FROM issues", { inputs: ["issues"] }), { at: T1 });
    const out = await run(e, sqlStep("open_issues", "SELECT id, title, upper(state) AS state FROM issues", { inputs: ["issues"] }), { at: T2 });
    expect(out.result.schemaChanges).toEqual([{ kind: "recreate", reason: "shape_changed" }]);
    expect(out.result.created).toBeUndefined();
    expect(out.result.rows).toEqual({ in: 3, added: 3, updated: 0, unchanged: 0, deleted: 3, total: 3 });
    expect(await stamps(e, "open_issues")).toEqual({ 1: T2, 2: T2, 3: T2 });
    expect(await columns(e, "open_issues")).toEqual(["id", "title", "state", "_loaded_at"]);
  });

  test("types no pin could spell (STRUCT, MAP, lists) and JSON keys reach the table and the catalog", async () => {
    const e = setup();
    await seed(e, "issues", ISSUES, { now: T0 });
    const out = await run(e, sqlStep("shaped", `SELECT id, {'t': title, 'n': id} AS s, MAP {'state': state} AS m, [id, id] AS l,
      json_object('title', title) AS j FROM issues`, { key: ["id"], inputs: ["issues"] }));
    expect(out.catalog!.columns.map((c) => c.type)).toEqual(["INTEGER", "STRUCT(T VARCHAR,N INTEGER)", "MAP(VARCHAR,VARCHAR)", "INTEGER[]", "JSON", "TIMESTAMPTZ"]);
    expect(out.catalog!.columns.find((c) => c.name === "j")!.jsonKeys).toEqual(["title"]);
    expect(out.result.created).toEqual({ columns: 5, jsonColumns: 1 });
  });

  test("an empty result still builds the table", async () => {
    const e = setup();
    await seed(e, "issues", ISSUES, { now: T0 });
    const out = await run(e, sqlStep("none", "SELECT id, title FROM issues WHERE false", { key: ["id"], inputs: ["issues"] }));
    expect(out.result.rows).toEqual({ in: 0, added: 0, updated: 0, unchanged: 0, deleted: 0, total: 0 });
    expect(await columns(e, "none")).toEqual(["id", "title", "_loaded_at"]);
  });

  test("an input it no longer reads loses its _croft.inputs row", async () => {
    const e = setup();
    await seed(e, "issues", ISSUES, { now: T0 });
    await seed(e, "triage", `SELECT * FROM (VALUES (1, 'bug')) AS v(id, label)`, { now: T1, kind: "ts" });
    await run(e, sqlStep("x", "SELECT id, label FROM issues JOIN triage USING (id)", { inputs: ["issues", "triage"] }), { at: T2 });
    expect((await inputsOf(e, "x")).map((r) => r.input)).toEqual(["issues", "triage"]);
    await run(e, sqlStep("x", "SELECT id, 'none' AS label FROM issues", { inputs: ["issues"] }), { at: T3 });
    expect(await inputsOf(e, "x")).toEqual([{ input: "issues", seen: T0, k: null, last: T0 }]);
  });
});

describe("runSqlStep failures", () => {
  test("a DuckDB error points into the asset's file, past the header, and nothing is written", async () => {
    const e = setup();
    await seed(e, "issues", ISSUES, { now: T0 });
    const header = ["-- description: open issues", "-- key: id"];
    await run(e, sqlStep("open_issues", "SELECT id, title FROM issues", { header, key: ["id"], inputs: ["issues"] }), { at: T1 });
    const before = { rows: await rows(e, "open_issues"), writes: await read(e, `SELECT * FROM _croft.writes`), inputs: await inputsOf(e, "open_issues") };
    const col = await failure(run(e, sqlStep("open_issues", "SELECT id,\n  titel\nFROM issues", { header, key: ["id"], inputs: ["issues"] }), { at: T2 }));
    expect(col.code).toBe("UNKNOWN_COLUMN");
    expect(col.problem).toMatchObject({ file: "assets/open_issues.sql", line: 4, column: 3 });
    const table = await failure(run(e, sqlStep("open_issues", "SELECT id FROM isues", { header, key: ["id"], inputs: ["isues"] }), { at: T2 }));
    expect(table.code).toBe("UNKNOWN_TABLE");
    expect(table.problem).toMatchObject({ file: "assets/open_issues.sql", line: 3, column: 16 });
    // A runtime error has no position in the file, but still names it.
    const conv = await failure(run(e, sqlStep("open_issues", "SELECT id, title::INTEGER AS title FROM issues", { header, key: ["id"], inputs: ["issues"] }), { at: T2 }));
    expect(conv.code).toBe("QUERY_FAILED");
    expect(conv.problem.file).toBe("assets/open_issues.sql");
    expect(conv.problem.line).toBeUndefined();
    expect(conv.problem.details).toMatchObject({ duckdbErrorType: "Conversion" });
    expect({ rows: await rows(e, "open_issues"), writes: await read(e, `SELECT * FROM _croft.writes`), inputs: await inputsOf(e, "open_issues") }).toEqual(before);
    expect(await temps(e)).toEqual([]);
  });

  test("a failing checks hook rolls back the rows, the shape, _croft.inputs and the bookkeeping; results and phase otherwise", async () => {
    const e = setup();
    await seed(e, "issues", ISSUES, { now: T0 });
    await run(e, sqlStep("open_issues", "SELECT id, title FROM issues", { key: ["id"], inputs: ["issues"] }), { at: T1 });
    await seed(e, "issues", `SELECT * FROM (VALUES (1, NULL, 'open'), (2, 'docs', 'closed'), (3, 'hang', 'open')) AS v(id, title, state)`, { now: T2 });
    const snapshot = async () => ({
      rows: await rows(e, "open_issues"), cols: await columns(e, "open_issues"), inputs: await inputsOf(e, "open_issues"),
      assets: await read(e, `SELECT * FROM _croft.assets WHERE name = 'open_issues'`), writes: await read(e, `SELECT * FROM _croft.writes WHERE asset = 'open_issues'`),
    });
    const before = await snapshot();
    let phase = "";
    const failed = await failure(run(e, sqlStep("open_issues", "SELECT id, title, state FROM issues", { key: ["id"], inputs: ["issues"] }), {
      at: T3,
      checks: async (tx, ctx) => {
        const [bad] = await tx.all<{ n: number }>(`SELECT count(*)::INTEGER AS n FROM ${ctx.table} WHERE title IS NULL`);
        if (bad!.n > 0) throw new CroftError("CHECK_FAILED", { message: `not_null(title): ${bad!.n} of ${ctx.rows.total} rows`, hint: "fix the SQL" });
      },
    }));
    expect(failed.code).toBe("CHECK_FAILED");
    expect(await snapshot()).toEqual(before);
    expect(await temps(e)).toEqual([]);
    const progress = new StepProgress("open_issues");
    const good = await run(e, sqlStep("open_issues", "SELECT id, coalesce(title, '?') AS title FROM issues", { key: ["id"], inputs: ["issues"] }), {
      at: T3, progress,
      checks: async () => {
        phase = progress.phase;
        return { problems: [{ ...problem("CHECK_FAILED", { message: "title <> '?': 1 row", hint: "" }), severity: "warning" }], results: [{ check: "not_null(title)", ok: true }] };
      },
    });
    progress.close();
    expect(phase).toBe("checks");
    expect(good.result.checks).toEqual([{ check: "not_null(title)", ok: true }]);
    expect(good.warnings.map((w) => [w.code, w.message, w.asset, w.runId])).toEqual([["CHECK_FAILED", "title <> '?': 1 row", "open_issues", good.runId]]);
  });

  test("its non-blocking checks run after the commit and never fail the step", async () => {
    const e = setup();
    await seed(e, "issues", ISSUES, { now: T0 });
    const step = sqlStep("open_issues", "SELECT id, title FROM issues", { key: ["id"], inputs: ["issues"] });
    step.checks = [{ source: "id > 1", kind: "rule", blocking: false, scope: "batch", sql: "id > 1", reads: [] }];
    const out = await run(e, step);
    expect(out.result.status).toBe("ok");
    expect(await rows(e, "open_issues")).toEqual([{ id: 1, title: "crash" }, { id: 2, title: "docs" }, { id: 3, title: "hang" }]);
    // Either a result for the check, or a warning that it could not run; never an error.
    expect(out.result.checks.length + out.warnings.length).toBeGreaterThan(0);
    expect(out.warnings.every((w) => w.severity !== "error")).toBe(true);
  });

  test("a duplicate key is CHECK_FAILED unique(key) in the asset's file, never a silent dedupe", async () => {
    const e = setup();
    await seed(e, "issues", ISSUES, { now: T0 });
    const err = await failure(run(e, sqlStep("by_state", "SELECT state AS id, title FROM issues", { key: ["id"], inputs: ["issues"] })));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.problem).toMatchObject({ asset: "by_state", file: "assets/by_state.sql", details: { check: "unique(id)", failing: 2 } });
    expect(await columns(e, "by_state")).toEqual([]);
  });

  test("duplicate output names and a SELECT of only reserved columns are refused before anything is written", async () => {
    const e = setup();
    await seed(e, "issues", ISSUES, { now: T0 });
    await seed(e, "triage", `SELECT * FROM (VALUES (1, 'bug')) AS v(id, label)`, { now: T0, kind: "ts" });
    const dup = await failure(run(e, sqlStep("d", "SELECT * FROM issues JOIN triage ON issues.id = triage.id", { inputs: ["issues", "triage"] })));
    expect(dup.code).toBe("DUPLICATE_OUTPUT_COLUMN");
    expect(dup.problem).toMatchObject({ asset: "d", file: "assets/d.sql", details: { columns: ["id"] } });
    const cased = await failure(run(e, sqlStep("d", "SELECT id, title AS ID FROM issues", { inputs: ["issues"] })));
    expect(cased.code).toBe("DUPLICATE_OUTPUT_COLUMN");
    const reserved = await failure(run(e, sqlStep("r", "SELECT _loaded_at FROM issues", { inputs: ["issues"] })));
    expect(reserved.code).toBe("ASSET_INVALID");
    expect(reserved.problem.file).toBe("assets/r.sql");
    expect(await columns(e, "d")).toEqual([]);
    expect(await columns(e, "r")).toEqual([]);
  });

  test("a step whose SQL did not load does not run; nor does one without its SQL", async () => {
    const e = setup();
    const bad = problem("SQL_NOT_SELECT", { message: "assets/x.sql is not a SELECT", hint: "write one SELECT", file: "assets/x.sql", line: 1 });
    const err = await failure(run(e, sqlStep("x", "DELETE FROM issues", { ok: false, problems: [bad] })));
    expect(err.code).toBe("SQL_NOT_SELECT");
    expect(err.problem).toMatchObject({ file: "assets/x.sql", line: 1 });
    const { sql: _sql, ...bare } = sqlStep("y", "SELECT 1 AS x");
    expect((await failure(run(e, bare))).code).toBe("INTERNAL_ERROR");
  });

  test("an aborted step writes nothing", async () => {
    const e = setup();
    const ac = new AbortController();
    ac.abort();
    const err = await failure(run(e, sqlStep("x", "SELECT 1 AS id"), { signal: ac.signal }));
    expect(err.code).toBe("INTERRUPTED");
    expect(await columns(e, "x")).toEqual([]);
  });
});
