// TS transform steps (DESIGN.md §3e, §5 "Transforms", "Cost guard"): run through runTransform on real temp
// projects, with inputs seeded straight into the warehouse so their stamps are exact.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { parseChecks } from "../checks/parse.ts";
import { checksHook } from "../checks/run.ts";
import { CroftError } from "../core/errors.ts";
import type { Problem, Sql } from "../core/types.ts";
import { ensureState } from "../db/state.ts";
import { closeAllWarehouses, type DuckWarehouse, openWarehouse } from "../db/warehouse.ts";
import { getCatalog, readCatalogEntry } from "../history/catalog.ts";
import { openLog } from "../history/logs.ts";
import { RunsDb } from "../history/runs-db.ts";
import type { CheckContext, CheckHookResult } from "../load/write.ts";
import { discoverAssets } from "../project/discover.ts";
import { ProjectEnv } from "../project/env.ts";
import { loadProject, type Project } from "../project/root.ts";
import { loadTsAsset } from "../project/ts-asset.ts";
import { markOutOfBand } from "../safety/guards.ts";
import { StepProgress } from "./ingest.ts";
import { POSITIONS } from "./inputs.ts";
import { behaviorHash, behaviorLabel, behaviorWords, DEFAULT_RETRIES, DEFAULT_TIMEOUT_MS, type PlannedStep, resolveWrite } from "./plan.ts";
import { staleReasons } from "./staleness.ts";
import type { ConfirmDecision, ConfirmRequest, StepInput, StepOutcome } from "./step.ts";
import { cleanupProjects, makeProject, PKG, writeFiles } from "./testkit.ts";
import { CHUNK, pendingChunkDir, runTransform } from "./transform.ts";

const g = globalThis as Record<string, unknown>;
const opened: { runs: RunsDb }[] = [];
const servers: Server<undefined>[] = [];

afterEach(() => {
  CHUNK.rows = 500;
  CHUNK.ms = 60_000;
  POSITIONS.maxPending = 100_000;
  for (const k of Object.keys(g)) if (k.startsWith("__t_")) delete g[k];
});

afterAll(async () => {
  for (const o of opened) o.runs.close();
  for (const s of servers) s.stop(true);
  await closeAllWarehouses();
  cleanupProjects();
});

interface H { root: string; project: Project; env: ProjectEnv; w: DuckWarehouse; runs: RunsDb; stateDir: string }

function harness(files: Record<string, string>): H {
  const root = makeProject(files);
  const project = loadProject({ root });
  mkdirSync(project.paths.stateDir, { recursive: true });
  const w = openWarehouse({
    path: project.paths.database, mode: "read_write", timezone: project.timezone, root, stateDir: project.paths.stateDir, isTTY: false, register: false,
  });
  const runs = RunsDb.open(project.paths.stateDir);
  const h = { root, project, env: ProjectEnv.load(root, {}), w, runs, stateDir: project.paths.stateDir };
  opened.push(h);
  return h;
}

const q = (s: string) => `"${s.replaceAll('"', '""')}"`;

interface SeedSpec {
  /** Column → SQL type (the table also gets _loaded_at). */
  columns: Record<string, string>;
  key?: string[];
  /** Values as text DuckDB casts to the column type; _loaded_at is required. */
  rows: Record<string, string | null>[];
}

/** Write an input table the way croft would have: rows with their stamps, and its _croft.assets record. Rows
 *  whose key is already there replace the old ones. */
async function seed(h: H, table: string, s: SeedSpec): Promise<void> {
  await h.w.write("seed", async (tx) => {
    await ensureState(tx);
    const names = Object.keys(s.columns);
    await tx.exec(`CREATE TABLE IF NOT EXISTS main.${q(table)} (${names.map((n) => `${q(n)} ${s.columns[n]}`).join(", ")}, "_loaded_at" TIMESTAMPTZ)`);
    const all = [...names, "_loaded_at"];
    const types = { ...s.columns, _loaded_at: "TIMESTAMPTZ" } as Record<string, string>;
    for (const r of s.rows) {
      if (s.key?.length) {
        await tx.exec(`DELETE FROM main.${q(table)} WHERE ${s.key.map((k, i) => `${q(k)} = CAST($${i + 1} AS ${types[k]})`).join(" AND ")}`,
          s.key.map((k) => r[k] ?? null));
      }
      await tx.exec(`INSERT INTO main.${q(table)} SELECT ${all.map((n, i) => `CAST($${i + 1} AS ${types[n]})`).join(", ")}`, all.map((n) => r[n] ?? null));
    }
    await tx.exec(`INSERT OR REPLACE INTO _croft.assets (name, kind, write_mode, key_columns, last_loaded_at, row_count, max_loaded_at, updated_at)
      SELECT $1, 'ingest', $2, CAST($3::JSON AS VARCHAR[]), max(_loaded_at), count(*), max(_loaded_at), now() FROM main.${q(table)}`,
      [table, s.key?.length ? "merge" : "replace", JSON.stringify(s.key ?? [])]);
  }, { runId: "r_seed" });
}

/** Plan one transform the way the phase-2 planner will: loaded, with its behavior inferred. */
async function plan(h: H, name: string, extra: Partial<PlannedStep> = {}): Promise<PlannedStep> {
  const a = (await discoverAssets(h.root)).assets.find((x) => x.name === name)!;
  const loaded = await loadTsAsset(a, { root: h.root, timezone: h.project.timezone });
  if (!loaded.ok || !loaded.spec) throw new Error(`${name} did not load: ${JSON.stringify(loaded.problems)}`);
  const spec = loaded.spec;
  const write = resolveWrite(spec);
  return {
    asset: name, file: a.file, path: a.path, kind: "transform", action: spec.incremental.kind === "none" ? "rebuild" : "update",
    reasons: ["requested"], reason: "requested", problems: loaded.problems, loaded, spec, inputs: spec.inputs, orderAfter: spec.inputs,
    readBy: [], checks: [], usesHttp: loaded.usesHttp, write, key: spec.key, incremental: spec.incremental,
    behavior: behaviorLabel(write, spec.key), words: behaviorWords(write, spec.key, spec.incremental),
    behaviorHash: behaviorHash(write, spec.key, spec.incremental), retries: DEFAULT_RETRIES, timeoutMs: DEFAULT_TIMEOUT_MS,
    ...(loaded.codeHash ? { codeHash: loaded.codeHash } : {}), ...(spec.confirmAbove !== undefined ? { confirmAbove: spec.confirmAbove } : {}),
    ...extra,
  };
}

let runSeq = 0;

/** One attempt of the step, as the runner makes it. */
async function step(h: H, s: PlannedStep, o: Partial<StepInput> = {}): Promise<StepOutcome & { runId: string; logText: () => string }> {
  const runId = o.runId ?? `r_t${++runSeq}`;
  const log = openLog(h.stateDir, runId, s.asset, { redact: (t) => h.env.redact(t) });
  const progress = new StepProgress(s.asset);
  try {
    const out = await runTransform({
      step: s, project: h.project, env: h.env, warehouse: h.w, runs: h.runs, runId, attempt: 1, maxAttempts: 1,
      signal: new AbortController().signal, progress, log, http: { retryBaseMs: 1 }, ...o,
    });
    return { ...out, runId, logText: () => readFileSync(log.path, "utf8") };
  } finally {
    progress.close();
    log.close();
  }
}

/** The step's failure. */
async function failure(p: Promise<unknown>): Promise<CroftError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
  throw new Error("expected the step to fail");
}

async function all<T = Record<string, unknown>>(h: H, sql: string, params: unknown[] = []): Promise<T[]> {
  return h.w.read((db) => db.all<T>(sql, params), { purpose: "test" });
}

const tx = (h: H, fn: (db: Sql) => Promise<void>) => h.w.write("test", fn, { runId: "r_test" });

const S1 = "2026-03-01T10:00:00.000001Z";
const S2 = "2026-03-01T10:00:00.000002Z";
const S3 = "2026-03-01T10:00:00.000003Z";

const ISSUES = { id: "BIGINT", title: "VARCHAR" };
const issues = (ids: number[], stamp: string, title = (id: number) => `issue ${id}`) =>
  ids.map((id) => ({ id: String(id), title: title(id), _loaded_at: stamp }));

// ---------------------------------------------------------------------------------------------------------
// Asset sources

const fullRefresh = `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["issues"],
  key: "issue_id",
  async *rows({ rows }) {
    for await (const r of rows<{ id: number; title: string }>("issues")) yield { issue_id: r.id, loud: r.title.toUpperCase() };
  },
});
`;

/** Incremental: records what it processed in globalThis.__t_seen, and throws at id globalThis.__t_stop. */
const incremental = (input = "issues", extra = "") => `import { transform } from "@zabaca/croft";
const g = globalThis as any;
export default transform({
  inputs: ["${input}"],
  key: "issue_id",
  incremental: true,${extra}
  async *rows({ newRows }) {
    for await (const r of newRows<{ id: number; title: string }>("${input}")) {
      if (g.__t_stop !== undefined && String(g.__t_stop) === String(r.id)) throw new Error("stopped at " + r.id);
      (g.__t_seen ??= []).push(String(r.id));
      yield { issue_id: r.id, title: r.title };
    }
  },
});
`;

// ---------------------------------------------------------------------------------------------------------

describe("full-refresh transforms", () => {
  test("build the table from rows() in one commit, and record what they read", async () => {
    const h = harness({ "assets/loud.ts": fullRefresh });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1, 2, 3], S1) });
    const out = await step(h, await plan(h, "loud"));
    expect(out.result.status).toBe("ok");
    expect(out.result.rows).toEqual({ in: 3, added: 3, updated: 0, unchanged: 0, deleted: 0, total: 3 });
    expect(out.result.created?.columns).toBe(2);
    expect(out.result.inputs).toEqual([{ input: "issues", seenBefore: null, seenAfter: S1, rows: 3 }]);
    expect(await all(h, `SELECT issue_id, loud FROM loud ORDER BY issue_id`)).toEqual([
      { issue_id: 1, loud: "ISSUE 1" }, { issue_id: 2, loud: "ISSUE 2" }, { issue_id: 3, loud: "ISSUE 3" },
    ]);
    const [a] = await all(h, `SELECT kind, write_mode FROM _croft.assets WHERE name = 'loud'`);
    expect(a).toEqual({ kind: "ts", write_mode: "replace" });
    // A full read: the input's last_loaded_at, no key, and seen in full (what staleness compares).
    expect(await all(h, `SELECT input, seen_loaded_at::VARCHAR AS s, seen_key, input_last_loaded_at::VARCHAR AS l FROM _croft.inputs WHERE asset = 'loud'`))
      .toEqual([{ input: "issues", s: "2026-03-01 02:00:00.000001-08", seen_key: null, l: "2026-03-01 02:00:00.000001-08" }]);
    const cat = getCatalog(h.runs, "loud")!;
    expect(cat.kind).toBe("ts");
    expect(cat.reads).toEqual(["issues"]);
    expect(cat.inputsSeen).toEqual({ issues: { seenLoadedAt: S1, seenKey: null, inputLastLoadedAt: S1 } });
    expect(out.catalog).toEqual(cat);
  });

  test("after an out-of-band change of an input, re-reading it clears input_replaced (full-refresh and incremental)", async () => {
    const h = harness({ "assets/loud.ts": fullRefresh, "assets/t.ts": incremental() });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1, 2], S1) });
    const OOB = "2026-03-02T00:00:00.000000Z";
    const reasons = async (name: string, incr: boolean) => {
      const input = await h.w.read((db) => readCatalogEntry(db, { asset: "issues", behavior: "", cursorField: null, lastRunId: null }), { purpose: "test" });
      return staleReasons({ asset: name, file: `assets/${name}.ts`, kind: "ts", incremental: incr, inputs: ["issues"], entry: getCatalog(h.runs, name), inputEntries: { issues: input } });
    };
    for (const [name, incr] of [["loud", false], ["t", true]] as const) {
      const s = await plan(h, name);
      await step(h, s);
      expect(await reasons(name, incr)).toEqual([]);
    }
    // doctor found a change made outside croft; no write followed, so only last_replaced_at moved.
    await tx(h, (db) => markOutOfBand(db, "issues", OOB));
    expect(await reasons("loud", false)).toEqual(["input_replaced"]);
    for (const [name, incr] of [["loud", false], ["t", true]] as const) {
      await step(h, await plan(h, name));
      // What the transform saw is the input's version: the out-of-band change, not the older last_loaded_at.
      expect(getCatalog(h.runs, name)?.inputsSeen?.issues?.inputLastLoadedAt).toBe(OOB);
      expect(await reasons(name, incr)).toEqual([]);
    }
  });

  test("a rebuild replaces the table; unchanged rows keep their _loaded_at", async () => {
    const h = harness({ "assets/loud.ts": fullRefresh });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1, 2, 3], S1) });
    const s = await plan(h, "loud");
    await step(h, s);
    const before = await all<{ issue_id: number; t: string }>(h, `SELECT issue_id, _loaded_at::VARCHAR AS t FROM loud ORDER BY issue_id`);
    await tx(h, (db) => db.exec(`DELETE FROM issues WHERE id = 3`));
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([2], S2, () => "changed") });
    const out = await step(h, s);
    expect(out.result.rows).toEqual({ in: 2, added: 0, updated: 1, unchanged: 1, deleted: 1, total: 2 });
    const after = await all<{ issue_id: number; t: string }>(h, `SELECT issue_id, _loaded_at::VARCHAR AS t FROM loud ORDER BY issue_id`);
    expect(after[0]).toEqual(before[0]!);
    expect(after[1]!.t).not.toBe(before[1]!.t);
  });

  test("newRows() of a full-refresh transform is every row: it keeps no position", async () => {
    const h = harness({ "assets/t.ts": incremental().replace("  incremental: true,\n", "") });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1, 2], S1) });
    const s = await plan(h, "t");
    await step(h, s);
    await step(h, s);
    expect(g.__t_seen).toEqual(["1", "2", "1", "2"]);
  });

  test("an empty input: the table is still built, and the input counts as read", async () => {
    const h = harness({ "assets/loud.ts": fullRefresh, "assets/t.ts": incremental() });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: [] });
    for (const name of ["loud", "t"]) {
      const out = await step(h, await plan(h, name));
      expect(out.result.rows).toEqual({ in: 0, added: 0, updated: 0, unchanged: 0, deleted: 0, total: 0 });
      expect(await all(h, `SELECT count(*)::INTEGER AS n FROM _croft.assets WHERE name = $1`, [name])).toEqual([{ n: 1 }]);
      expect(await all(h, `SELECT input, seen_loaded_at, input_last_loaded_at FROM _croft.inputs WHERE asset = $1`, [name]))
        .toEqual([{ input: "issues", seen_loaded_at: null, input_last_loaded_at: null }]);
    }
  });

  test("an input that is not built yet: DB_NOT_FOUND, with the run that builds it", async () => {
    const h = harness({ "assets/loud.ts": fullRefresh });
    const err = await failure(step(h, await plan(h, "loud")));
    expect(err.code).toBe("DB_NOT_FOUND");
    expect(err.problem.message).toContain("issues");
    expect(err.problem.fix).toEqual({ kind: "command", description: "build issues", command: "croft run issues" });
  });

  test("the code's console output and a subprocess's go to the step log", async () => {
    const h = harness({
      "assets/noisy.ts": `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["issues"],
  async *rows({ rows, log }) {
    console.log("console says hi");
    log("ctx.log says hi");
    await Bun.spawn(["echo", "subprocess says hi"], { stdio: ["ignore", "inherit", "inherit"], env: {} }).exited;
    for await (const r of rows("issues")) yield { id: r.id };
  },
});
`,
    });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1], S1) });
    const out = await step(h, await plan(h, "noisy"));
    const text = out.logText();
    expect(text).toContain("console says hi");
    expect(text).toContain("ctx.log says hi");
    expect(text).toContain("subprocess says hi");
  });
});

describe("values arrive as JavaScript types that load back unchanged (§3e)", () => {
  test("a pass-through transform reproduces its input exactly, column types included", async () => {
    const h = harness({
      "assets/copy.ts": `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["src"],
  key: "id",
  async *rows({ rows }) {
    for await (const r of rows("src")) {
      (globalThis as any).__t_types = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v]));
      yield { ...r };
    }
  },
});
`,
    });
    const HUGE = "170141183460469231731687303715884105727";
    await seed(h, "src", {
      columns: { id: "BIGINT", big: "BIGINT", huge: "HUGEINT", zoned: "TIMESTAMPTZ", naive: "TIMESTAMP", day: "DATE", ratio: "DOUBLE", ok: "BOOLEAN", note: "VARCHAR", doc: "JSON" },
      key: ["id"],
      rows: [
        { id: "1", big: "9007199254740993", huge: HUGE, zoned: "2026-03-01T07:30:00.123456Z", naive: "2026-03-01 23:30:00.123456", day: "2026-03-01", ratio: "0.1", ok: "true", note: "a", doc: `{"x":[1,{"y":12345678901234567890}]}`, _loaded_at: S1 },
        { id: "2", big: "-9007199254740993", huge: `-${HUGE}`, zoned: "1999-12-31T23:59:59.999999Z", naive: "1999-12-31 23:59:59.000001", day: "1999-12-31", ratio: "-2.5e300", ok: "false", note: null, doc: `{"a":"b"}`, _loaded_at: S1 },
      ],
    });
    await step(h, await plan(h, "copy"));
    expect(g.__t_types).toEqual({ id: "number", big: "bigint", huge: "bigint", zoned: "string", naive: "string", day: "string", ratio: "number", ok: "boolean", note: "object", doc: "object" });
    const types = await all<{ name: string; type: string }>(h, `SELECT column_name AS name, data_type AS type FROM duckdb_columns() WHERE table_name = $1 ORDER BY column_name`, ["copy"]);
    const src = await all<{ name: string; type: string }>(h, `SELECT column_name AS name, data_type AS type FROM duckdb_columns() WHERE table_name = $1 ORDER BY column_name`, ["src"]);
    expect(types).toEqual(src);
    expect(types.find((t) => t.name === "huge")?.type).toBe("HUGEINT");
    // Same values, compared in SQL; croft's _loaded_at did not come along (no _source_loaded_at column).
    const cols = "id, big, huge, zoned, naive, day, ratio, ok, note, doc::VARCHAR";
    expect(await all(h, `SELECT count(*)::INTEGER AS n FROM (SELECT ${cols} FROM src EXCEPT SELECT ${cols} FROM copy)`)).toEqual([{ n: 0 }]);
    expect(await all(h, `SELECT count(*)::INTEGER AS n FROM (SELECT ${cols} FROM copy EXCEPT SELECT ${cols} FROM src)`)).toEqual([{ n: 0 }]);
  });
});

describe("rows are guarded against renamed columns (UNKNOWN_INPUT_COLUMN)", () => {
  const reader = (body: string) => `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["issues"],
  async *rows({ rows, query }) {
    const g = globalThis as any;
${body}
  },
});
`;

  test("a missing column throws with a did-you-mean and the line that read it", async () => {
    const h = harness({
      "assets/t.ts": reader(`    for await (const r of rows("issues")) {
      yield { id: r.id, t: r.tilte };
    }`),
    });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1], S1) });
    const err = await failure(step(h, await plan(h, "t")));
    expect(err.code).toBe("UNKNOWN_INPUT_COLUMN");
    expect(err.problem.message).toBe(`issues has no column "tilte"; did you mean "title"?`);
    expect(err.problem.file).toBe("assets/t.ts");
    expect(err.problem.line).toBe(7);
    expect(err.problem.fix).toEqual({ kind: "edit", description: `read "title" instead of "tilte"`, file: "assets/t.ts", line: 7, replace: { from: "tilte", to: "title" } });
    expect(err.problem.details).toMatchObject({ input: "issues", column: "tilte", suggestion: "title" });
    expect(await all(h, `SELECT count(*)::INTEGER AS n FROM duckdb_tables() WHERE table_name = 't'`)).toEqual([{ n: 0 }]);

    // A name that appears twice on the line gets no text replacement: applying one could hit the wrong one.
    writeFiles(h.root, {
      "assets/u.ts": reader(`    for await (const r of rows("issues")) {
      yield { id: r.id, t: r.tilte, u: r.tilte };
    }`),
    });
    const twice = await failure(step(h, await plan(h, "u")));
    expect(twice.problem.fix).toEqual({ kind: "edit", description: `read "title" instead of "tilte"`, file: "assets/u.ts", line: 7 });
  });

  test("destructuring is guarded too; spread, keys, in, JSON and inspect behave normally; croft's columns are hidden", async () => {
    const h = harness({
      "assets/t.ts": reader(`    for await (const r of rows("issues")) {
      g.__t_spread = { ...r };
      g.__t_keys = Object.keys(r);
      g.__t_json = JSON.stringify(r);
      g.__t_in = ["title" in r, "nope" in r, "_loaded_at" in r];
      g.__t_stamp = r._loaded_at;
      g.__t_inspect = Bun.inspect(r);
      g.__t_awaited = (await Promise.resolve(r)) === r;
      try {
        const { author } = r as any;
        g.__t_author = author;
      } catch (e) {
        g.__t_destructure = (e as any).problem?.code;
      }
      yield { id: r.id };
    }`),
    });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([7], S1) });
    await step(h, await plan(h, "t"));
    expect(g.__t_spread).toEqual({ id: 7, title: "issue 7" });
    expect(g.__t_keys).toEqual(["id", "title"]);
    expect(g.__t_json).toBe(`{"id":7,"title":"issue 7"}`);
    expect(g.__t_in).toEqual([true, false, true]);
    expect(g.__t_stamp).toBe(S1);
    expect(g.__t_inspect).toContain("issue 7");
    expect(g.__t_awaited).toBe(true);
    expect(g.__t_destructure).toBe("UNKNOWN_INPUT_COLUMN");
    expect(g.__t_author).toBeUndefined();
  });

  test("ctx.query rows are guarded, against the query's own columns", async () => {
    const h = harness({
      "assets/t.ts": reader(`    const [r] = await query<{ n: number }>("select count(*) as n from issues");
    yield { n: (r as any).count };`),
    });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1], S1) });
    const err = await failure(step(h, await plan(h, "t")));
    expect(err.code).toBe("UNKNOWN_INPUT_COLUMN");
    expect(err.problem.message).toBe(`the ctx.query result has no column "count"`);
    expect(err.problem.hint).toContain("n");
  });
});

describe("ctx.query and the declared inputs (UNDECLARED_INPUT)", () => {
  const querying = (sql: string, extra = "") => `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["issues"],
  async *rows({ query, rows }) {
    ${extra}
    yield* await query(${JSON.stringify(sql)}, 1);
  },
});
`;

  test("one SELECT over the declared inputs, with parameters", async () => {
    const h = harness({ "assets/t.ts": querying("select id, upper(title) as t from issues where id > $1 order by id") });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1, 2, 3], S1) });
    await step(h, await plan(h, "t"));
    expect(await all(h, `SELECT id, t FROM t ORDER BY id`)).toEqual([{ id: 2, t: "ISSUE 2" }, { id: 3, t: "ISSUE 3" }]);
  });

  test("a table that is not an input is UNDECLARED_INPUT, in query() and in rows()", async () => {
    const h = harness({ "assets/t.ts": querying("select * from issues join users using (id)") });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1], S1) });
    await seed(h, "users", { columns: { id: "BIGINT" }, key: ["id"], rows: [{ id: "1", _loaded_at: S1 }] });
    const err = await failure(step(h, await plan(h, "t")));
    expect(err.code).toBe("UNDECLARED_INPUT");
    expect(err.problem.message).toBe("t reads users in ctx.query, but users is not in its inputs (\"issues\")");
    expect(err.problem.fix).toEqual({ kind: "edit", description: `add "users" to inputs: ["issues", "users"]`, file: "assets/t.ts" });
    expect(err.problem.line).toBe(6);

    writeFiles(h.root, { "assets/u.ts": querying("select 1", `for await (const u of rows("users")) yield u;`) });
    const e2 = await failure(step(h, await plan(h, "u")));
    expect(e2.code).toBe("UNDECLARED_INPUT");
    expect(e2.problem.message).toContain("reads users in rows()");
    // A CTE named like a table is not a table.
    writeFiles(h.root, { "assets/c.ts": querying("with users as (select 1 as id) select * from users where id = $1") });
    await step(h, await plan(h, "c"));
  });

  test("DuckDB's errors keep their codes, with the line of the query() call", async () => {
    const h = harness({ "assets/t.ts": querying("select nope from issues where id = $1") });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1], S1) });
    const err = await failure(step(h, await plan(h, "t")));
    expect(err.problem).toMatchObject({ code: "UNKNOWN_COLUMN", file: "assets/t.ts", line: 6 });
    expect(err.problem.message).toStartWith("ctx.query: ");
    expect(err.problem.details?.sql).toBe("select nope from issues where id = $1");
  });

  test("the one-SELECT gate: a second statement, and paths into the state folder, are refused", async () => {
    const h = harness({ "assets/t.ts": querying("select * from issues where id = $1; drop table issues") });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1], S1) });
    expect((await failure(step(h, await plan(h, "t")))).code).toBe("SQL_NOT_ONE_STATEMENT");
    // The snapshot rows() just made is in the state folder; SQL may not read it, or anything else there.
    writeFiles(h.root, {
      "assets/p.ts": querying(`select * from read_parquet('${join(h.stateDir, "staging", "**", "*.parquet").replaceAll("\\", "/")}') where 1 = $1`,
        `for await (const _ of rows("issues")) {}`),
    });
    const denied = await failure(step(h, await plan(h, "p")));
    expect(denied.problem).toMatchObject({ code: "QUERY_PATH_DENIED" });
    expect(await all(h, `SELECT count(*)::INTEGER AS n FROM issues`)).toEqual([{ n: 1 }]);
  });
});

describe("newRows() positions never skip rows (§3e)", () => {
  test("5 rows sharing one stamp, stopped after 2: the next run reads rows 3-5, and only those", async () => {
    CHUNK.rows = 2;
    const h = harness({ "assets/t.ts": incremental() });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1, 2, 3, 4, 5], S1) });
    const s = await plan(h, "t");
    g.__t_stop = 3;
    const err = await failure(step(h, s));
    expect(err.code).toBe("ASSET_CODE_ERROR");
    expect(err.problem.effect).toBe(`2 rows from 1 earlier chunk were saved; the next run continues after the input position saved with them (issues: id=2 at ${S1})`);
    expect(err.problem.details).toMatchObject({ savedRows: 2, savedChunks: 1, positions: [{ input: "issues", seenLoadedAt: S1, seenKey: ["2"] }] });
    expect(g.__t_seen).toEqual(["1", "2"]);
    expect(await all(h, `SELECT issue_id FROM t ORDER BY issue_id`)).toEqual([{ issue_id: 1 }, { issue_id: 2 }]);
    expect(await all(h, `SELECT seen_loaded_at::VARCHAR AS s, seen_key::VARCHAR AS k, input_last_loaded_at AS l FROM _croft.inputs WHERE asset = 't'`))
      .toEqual([{ s: "2026-03-01 02:00:00.000001-08", k: `["2"]`, l: null }]);

    delete g.__t_stop;
    g.__t_seen = [];
    const out = await step(h, s);
    expect(g.__t_seen).toEqual(["3", "4", "5"]);
    expect(out.result.reason).toBe("requested; 3 new input rows; 2 commits");
    expect(await all(h, `SELECT issue_id FROM t ORDER BY issue_id`)).toEqual([1, 2, 3, 4, 5].map((issue_id) => ({ issue_id })));
    expect(await all(h, `SELECT seen_key::VARCHAR AS k, input_last_loaded_at::VARCHAR AS l FROM _croft.inputs WHERE asset = 't'`))
      .toEqual([{ k: `["5"]`, l: "2026-03-01 02:00:00.000001-08" }]);

    // Nothing new: nothing processed, still recorded.
    g.__t_seen = [];
    const idle = await step(h, s);
    expect(g.__t_seen).toEqual([]);
    expect(idle.result.rows).toMatchObject({ in: 0, added: 0, total: 5 });

    // A changed row and a new one, and only those.
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: [...issues([2], S2, () => "changed"), ...issues([6], S2)] });
    const next = await step(h, s);
    expect(g.__t_seen).toEqual(["2", "6"]);
    expect(next.result.rows).toMatchObject({ in: 2, added: 1, updated: 1, total: 6 });
    expect(next.result.inputs).toEqual([{ input: "issues", seenBefore: S1, seenAfter: S2, rows: 2 }]);
  });

  test("keys compare by their type (9 < 10 as BIGINT), and composite keys column by column", async () => {
    CHUNK.rows = 1;
    const h = harness({
      "assets/t.ts": `import { transform } from "@zabaca/croft";
const g = globalThis as any;
export default transform({
  inputs: ["events"],
  key: ["region", "n"],
  incremental: true,
  async *rows({ newRows }) {
    for await (const r of newRows("events")) {
      const id = r.region + r.n;
      if (g.__t_stop === id) throw new Error("stop");
      (g.__t_seen ??= []).push(id);
      yield { region: r.region, n: r.n };
    }
  },
});
`,
    });
    const rows = [["b", 10], ["a", 9], ["b", 9], ["a", 10], ["a", 100]].map(([region, n]) => ({ region: String(region), n: String(n), _loaded_at: S1 }));
    await seed(h, "events", { columns: { region: "VARCHAR", n: "BIGINT" }, key: ["region", "n"], rows });
    const s = await plan(h, "t");
    g.__t_stop = "a100";
    await failure(step(h, s));
    expect(g.__t_seen).toEqual(["a9", "a10"]);
    delete g.__t_stop;
    g.__t_seen = [];
    await step(h, s);
    expect(g.__t_seen).toEqual(["a100", "b9", "b10"]);
    expect(await all(h, `SELECT seen_key::VARCHAR AS k FROM _croft.inputs WHERE asset = 't'`)).toEqual([{ k: `["b","10"]` }]);
  });

  test("a HUGEINT key resumes in numeric order: nothing skipped after a stop, nothing re-read after a full run", async () => {
    CHUNK.rows = 1;
    const h = harness({ "assets/t.ts": incremental("big") });
    await seed(h, "big", { columns: { id: "HUGEINT", title: "VARCHAR" }, key: ["id"], rows: ["10", "100", "2", "9"].map((id) => ({ id, title: `t${id}`, _loaded_at: S1 })) });
    const s = await plan(h, "t");
    g.__t_stop = "10";
    await failure(step(h, s));
    expect(g.__t_seen).toEqual(["2", "9"]);
    expect(await all(h, `SELECT seen_key::VARCHAR AS k FROM _croft.inputs WHERE asset = 't'`)).toEqual([{ k: `["9"]` }]);
    delete g.__t_stop;
    g.__t_seen = [];
    await step(h, s);
    expect(g.__t_seen).toEqual(["10", "100"]);
    // One new row: only it is read.
    await seed(h, "big", { columns: { id: "HUGEINT", title: "VARCHAR" }, key: ["id"], rows: [{ id: "5", title: "t5", _loaded_at: S2 }] });
    g.__t_seen = [];
    await step(h, s);
    expect(g.__t_seen).toEqual(["5"]);
    expect(await all(h, `SELECT issue_id::VARCHAR AS id FROM t ORDER BY issue_id`)).toEqual(["2", "5", "9", "10", "100"].map((id) => ({ id })));
  });

  test("calls kept in flight (read ahead): a chunk never commits a position past a row whose output is pending", async () => {
    CHUNK.rows = 2;
    const h = harness({
      "assets/t.ts": `import { transform } from "@zabaca/croft";
const g = globalThis as any;
const classify = async (r: { id: number; title: string }) => ({ issue_id: r.id, label: r.title.toUpperCase() });
export default transform({
  inputs: ["issues"],
  key: "issue_id",
  incremental: true,
  async *rows({ newRows }) {
    const inflight: Promise<{ issue_id: number; label: string }>[] = [];
    for await (const r of newRows<{ id: number; title: string }>("issues")) {
      if (String(g.__t_stop) === String(r.id)) throw new Error("rate limited at " + r.id);
      (g.__t_seen ??= []).push(r.id);
      inflight.push(classify(r));
      if (inflight.length >= 3) yield await inflight.shift()!;
    }
    for (const p of inflight) yield await p;
  },
});
`,
    });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1, 2, 3, 4, 5, 6], S1) });
    const s = await plan(h, "t");
    g.__t_stop = 6;
    const err = await failure(step(h, s));
    expect(err.code).toBe("ASSET_CODE_ERROR");
    // Rows 1 and 2 were saved with the position after row 2, although the code had asked for rows up to 5.
    expect(await all(h, `SELECT issue_id FROM t ORDER BY issue_id`)).toEqual([{ issue_id: 1 }, { issue_id: 2 }]);
    expect(await all(h, `SELECT seen_key::VARCHAR AS k FROM _croft.inputs WHERE asset = 't'`)).toEqual([{ k: `["2"]` }]);
    expect(err.problem.effect).toBe(`2 rows from 1 earlier chunk were saved; the next run continues after the input position saved with them (issues: id=2 at ${S1})`);
    delete g.__t_stop;
    g.__t_seen = [];
    await step(h, s);
    expect(g.__t_seen).toEqual([3, 4, 5, 6]);
    expect(await all(h, `SELECT issue_id FROM t ORDER BY issue_id`)).toEqual([1, 2, 3, 4, 5, 6].map((issue_id) => ({ issue_id })));
  });

  test("rows that yield nothing: a chunk's position waits for the outputs (re-read, never skipped); a finished run's is exact", async () => {
    CHUNK.rows = 2;
    const odd = incremental().replace(`(g.__t_seen ??= []).push(String(r.id));`, `(g.__t_seen ??= []).push(String(r.id));\n      if (r.id % 2 === 0) continue;`);
    const h = harness({ "assets/t.ts": odd });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1, 2, 3, 4, 5, 6, 7], S1) });
    const s = await plan(h, "t");
    g.__t_stop = 6;
    await failure(step(h, s));
    // Outputs 1 and 3 committed; croft cannot tell that row 3 had its output, so the position is after row 2.
    expect(await all(h, `SELECT issue_id FROM t ORDER BY issue_id`)).toEqual([{ issue_id: 1 }, { issue_id: 3 }]);
    expect(await all(h, `SELECT seen_key::VARCHAR AS k FROM _croft.inputs WHERE asset = 't'`)).toEqual([{ k: `["2"]` }]);
    delete g.__t_stop;
    g.__t_seen = [];
    await step(h, s);
    expect(g.__t_seen).toEqual(["3", "4", "5", "6", "7"]);
    expect(await all(h, `SELECT issue_id FROM t ORDER BY issue_id`)).toEqual([1, 3, 5, 7].map((issue_id) => ({ issue_id })));
    // The code finished: every row it asked past is processed, the ones that yielded nothing included.
    expect(await all(h, `SELECT seen_key::VARCHAR AS k, input_last_loaded_at IS NOT NULL AS whole FROM _croft.inputs WHERE asset = 't'`)).toEqual([{ k: `["7"]`, whole: true }]);
  });

  test("more rows waiting for outputs than croft keeps positions for: the position waits, and nothing is skipped", async () => {
    CHUNK.rows = 1;
    POSITIONS.maxPending = 2;
    const third = incremental().replace(`(g.__t_seen ??= []).push(String(r.id));`, `(g.__t_seen ??= []).push(String(r.id));\n      if (r.id % 3 !== 0) continue;`);
    const h = harness({ "assets/t.ts": third });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1, 2, 3, 4, 5, 6, 7, 8], S1) });
    const s = await plan(h, "t");
    g.__t_stop = 7;
    await failure(step(h, s));
    expect(await all(h, `SELECT issue_id FROM t ORDER BY issue_id`)).toEqual([{ issue_id: 3 }, { issue_id: 6 }]);
    expect(await all(h, `SELECT seen_loaded_at FROM _croft.inputs WHERE asset = 't'`)).toEqual([{ seen_loaded_at: null }]);
    delete g.__t_stop;
    g.__t_seen = [];
    await step(h, s);
    expect(g.__t_seen).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(await all(h, `SELECT seen_key::VARCHAR AS k FROM _croft.inputs WHERE asset = 't'`)).toEqual([{ k: `["8"]` }]);
  });

  test("a timestamp key with microseconds resumes exactly", async () => {
    CHUNK.rows = 1;
    const h = harness({
      "assets/t.ts": `import { transform } from "@zabaca/croft";
const g = globalThis as any;
export default transform({
  inputs: ["ticks"],
  key: "at",
  incremental: true,
  async *rows({ newRows }) {
    for await (const r of newRows("ticks")) {
      if (g.__t_stop === r.at) throw new Error("stop");
      (g.__t_seen ??= []).push(r.at);
      yield { at: r.at };
    }
  },
});
`,
    });
    const ats = ["2026-03-01T10:00:00.000001Z", "2026-03-01T10:00:00.000002Z", "2026-03-01T10:00:00.000003Z"];
    await seed(h, "ticks", { columns: { at: "TIMESTAMPTZ" }, key: ["at"], rows: ats.map((at) => ({ at, _loaded_at: S1 })) });
    const s = await plan(h, "t");
    g.__t_stop = ats[2];
    await failure(step(h, s));
    expect(g.__t_seen).toEqual(ats.slice(0, 2));
    delete g.__t_stop;
    g.__t_seen = [];
    await step(h, s);
    expect(g.__t_seen).toEqual([ats[2]]);
  });

  test("a loop left early does not count its last row as processed", async () => {
    const h = harness({
      "assets/t.ts": `import { transform } from "@zabaca/croft";
const g = globalThis as any;
export default transform({
  inputs: ["issues"],
  key: "issue_id",
  incremental: true,
  async *rows({ newRows }) {
    for await (const r of newRows("issues")) {
      if (g.__t_breakAt === r.id) break;
      (g.__t_seen ??= []).push(r.id);
      yield { issue_id: r.id };
    }
  },
});
`,
    });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1, 2, 3], S1) });
    const s = await plan(h, "t");
    g.__t_breakAt = 2;
    await step(h, s);
    expect(g.__t_seen).toEqual([1]);
    expect(await all(h, `SELECT seen_key::VARCHAR AS k, input_last_loaded_at AS l FROM _croft.inputs WHERE asset = 't'`)).toEqual([{ k: `["1"]`, l: null }]);
    delete g.__t_breakAt;
    g.__t_seen = [];
    await step(h, s);
    expect(g.__t_seen).toEqual([2, 3]);
  });

  test("two inputs: newRows() of one, rows() and query() of the other inside the loop; pages of rows", async () => {
    CHUNK.rows = 2;
    const h = harness({
      "assets/t.ts": `import { transform } from "@zabaca/croft";
const g = globalThis as any;
export default transform({
  inputs: ["issues", "users"],
  key: "issue_id",
  incremental: true,
  async *rows({ rows, newRows, query }) {
    const names = new Map<number, string>();
    for await (const u of rows("users")) names.set(u.id, u.name);
    for await (const r of newRows("issues")) {
      (g.__t_seen ??= []).push(r.id);
      const [c] = await query<{ n: number }>("select count(*) as n from users where id = $1", r.author_id);
      yield [{ issue_id: r.id, author: names.get(r.author_id) ?? null, known: c!.n }];
    }
  },
});
`,
    });
    const U1 = "2026-03-01T09:00:00Z";
    await seed(h, "users", { columns: { id: "BIGINT", name: "VARCHAR" }, key: ["id"], rows: [{ id: "1", name: "ann", _loaded_at: U1 }, { id: "2", name: "bo", _loaded_at: U1 }] });
    await seed(h, "issues", { columns: { id: "BIGINT", author_id: "BIGINT" }, key: ["id"], rows: [1, 2, 3].map((id) => ({ id: String(id), author_id: String(id), _loaded_at: S1 })) });
    const s = await plan(h, "t");
    await step(h, s);
    expect(await all(h, `SELECT issue_id, author, known FROM t ORDER BY issue_id`)).toEqual([
      { issue_id: 1, author: "ann", known: 1 }, { issue_id: 2, author: "bo", known: 1 }, { issue_id: 3, author: null, known: 0 },
    ]);
    const inputs = async () => all(h, `SELECT input, seen_loaded_at::VARCHAR AS s, seen_key::VARCHAR AS k, input_last_loaded_at::VARCHAR AS l FROM _croft.inputs WHERE asset = 't' ORDER BY input`);
    // The lookup keeps no newRows() position; both inputs count as read in full.
    expect(await inputs()).toEqual([
      { input: "issues", s: "2026-03-01 02:00:00.000001-08", k: `["3"]`, l: "2026-03-01 02:00:00.000001-08" },
      { input: "users", s: null, k: null, l: "2026-03-01 01:00:00-08" },
    ]);
    // The lookup changed: read again, and no issue is processed again.
    await seed(h, "users", { columns: { id: "BIGINT", name: "VARCHAR" }, key: ["id"], rows: [{ id: "3", name: "cy", _loaded_at: S2 }] });
    g.__t_seen = [];
    await step(h, s);
    expect(g.__t_seen).toEqual([]);
    expect((await inputs())[1]).toEqual({ input: "users", s: null, k: null, l: "2026-03-01 02:00:00.000002-08" });
  });

  test("an input without a key cannot be read with newRows(): INPUT_NEEDS_KEY", async () => {
    const h = harness({ "assets/t.ts": incremental("logs") });
    await seed(h, "logs", { columns: ISSUES, rows: issues([1], S1) });
    const err = await failure(step(h, await plan(h, "t")));
    expect(err.code).toBe("INPUT_NEEDS_KEY");
    expect(err.problem.line).toBe(8);
  });
});

describe("chunked commits (§3e)", () => {
  test("each chunk commits its rows, checks and positions together", async () => {
    CHUNK.rows = 3;
    const h = harness({ "assets/t.ts": incremental() });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1, 2, 3, 4, 5, 6, 7], S1) });
    const seen: number[] = [];
    const checks = async (db: Sql, c: CheckContext): Promise<CheckHookResult> => {
      const [r] = await db.all<{ n: number }>(`SELECT count(*)::INTEGER AS n FROM ${c.batch}`);
      seen.push(r!.n);
      return { problems: [], results: [{ check: "not_null(issue_id)", ok: true }] };
    };
    const out = await step(h, await plan(h, "t"), { checks, attempt: 2, maxAttempts: 3 });
    expect(seen).toEqual([3, 3, 1]);
    expect(out.result.checks).toEqual([{ check: "not_null(issue_id)", ok: true }]);
    expect(out.result.rows).toEqual({ in: 7, added: 7, updated: 0, unchanged: 0, deleted: 0, total: 7 });
    expect(out.result.attempt).toBe(2);
    const writes = await all<{ rows_in: number; attempt: number; inputs: unknown }>(h, `SELECT rows_in::INTEGER AS rows_in, attempt, inputs FROM _croft.writes WHERE asset = 't' ORDER BY loaded_at`);
    expect(writes.map((w) => [w.rows_in, w.attempt])).toEqual([[3, 2], [3, 2], [1, 2]]);
    // Per chunk: the input rows it covers, and the positions around it.
    expect(writes.map((w) => w.inputs)).toEqual([
      [{ input: "issues", seenBefore: null, seenAfter: S1, rows: 3 }],
      [{ input: "issues", seenBefore: S1, seenAfter: S1, rows: 3 }],
      [{ input: "issues", seenBefore: S1, seenAfter: S1, rows: 1 }],
    ]);
    expect(out.result.inputs).toEqual([{ input: "issues", seenBefore: null, seenAfter: S1, rows: 7 }]);
    expect(existsSync(pendingChunkDir(h.stateDir, "t"))).toBe(false);
  });

  test("a chunk that is 60 s old commits at the next input row even when small", async () => {
    CHUNK.ms = 0;
    const h = harness({ "assets/t.ts": incremental() });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1, 2, 3], S1) });
    await step(h, await plan(h, "t"));
    // One commit per row, at each next request (the last when newRows() says it is done), then the final one,
    // which records that the input was read to its end.
    const writes = await all<{ n: number; l: string | null }>(h, `SELECT rows_in::INTEGER AS n FROM _croft.writes WHERE asset = 't' ORDER BY loaded_at`);
    expect(writes.map((w) => w.n)).toEqual([1, 1, 1, 0]);
  });

  test("an interrupted step keeps its committed chunks", async () => {
    CHUNK.rows = 2;
    const h = harness({
      "assets/t.ts": incremental().replace(`(g.__t_seen ??= []).push(String(r.id));`, `(g.__t_seen ??= []).push(String(r.id)); if (r.id === 3) g.__t_abort();`),
    });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1, 2, 3, 4], S1) });
    const ac = new AbortController();
    g.__t_abort = () => ac.abort(new CroftError("INTERRUPTED", { message: "Ctrl-C", hint: "run again" }));
    const err = await failure(step(h, await plan(h, "t"), { signal: ac.signal }));
    expect(err.code).toBe("INTERRUPTED");
    expect(err.problem.effect).toContain("2 rows from 1 earlier chunk were saved");
    expect(await all(h, `SELECT issue_id FROM t ORDER BY issue_id`)).toEqual([{ issue_id: 1 }, { issue_id: 2 }]);
  });

  test("min_rows is checked once the run has finished: a first build larger than one chunk is not refused at its first chunk", async () => {
    CHUNK.rows = 2;
    const h = harness({ "assets/t.ts": incremental("issues", `\n  checks: ["min_rows(3)", "issue_id > 0"],`) });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1, 2, 3, 4, 5], S1) });
    const s = await plan(h, "t", {});
    const parsed = parseChecks({ asset: "t", file: s.file, key: s.key, checks: s.spec!.checks, warnings: s.spec!.warnings });
    expect(parsed.problems).toEqual([]);
    const checks = checksHook(parsed.checks, { file: s.file });
    const out = await step(h, { ...s, checks: parsed.checks }, { checks });
    expect(out.result.rows.total).toBe(5);
    expect(out.result.checks.map((c) => [c.check, c.ok])).toEqual([["unique(issue_id)", true], ["not_null(issue_id)", true], ["issue_id > 0", true], ["min_rows(3)", true]]);
    // Still enforced, on the finished table: 2 rows are too few.
    const h2 = harness({ "assets/t.ts": incremental("issues", `\n  checks: ["min_rows(3)"],`) });
    await seed(h2, "issues", { columns: ISSUES, key: ["id"], rows: issues([1, 2], S1) });
    const s2 = await plan(h2, "t");
    const c2 = parseChecks({ asset: "t", file: s2.file, key: s2.key, checks: ["min_rows(3)"], warnings: [] }).checks;
    const err = await failure(step(h2, { ...s2, checks: c2 }, { checks: checksHook(c2, { file: s2.file }) }));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.problem.message).toStartWith("min_rows(3): the table has 2 rows");
  });

  test("a duplicate key in a chunk names the asset's file", async () => {
    const h = harness({
      "assets/t.ts": `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["issues"],
  key: "label",
  async *rows({ rows }) {
    for await (const r of rows<{ id: number; title: string }>("issues")) yield { label: r.title, id: r.id };
  },
});
`,
    });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1, 2], S1, () => "same") });
    const err = await failure(step(h, await plan(h, "t")));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.problem.file).toBe("assets/t.ts");
    expect(err.problem.fix).toMatchObject({ file: "assets/t.ts" });
  });

  test("an unserializable row names its row in the whole run, not in its chunk", async () => {
    CHUNK.rows = 2;
    const h = harness({ "assets/t.ts": incremental().replace("yield { issue_id: r.id, title: r.title };", "yield { issue_id: r.id, title: r.id === 4 ? new Map() : r.title };") });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1, 2, 3, 4], S1) });
    const err = await failure(step(h, await plan(h, "t")));
    expect(err.code).toBe("UNSERIALIZABLE_VALUE");
    expect(err.problem.message).toStartWith("row 4 of t:");
    expect(err.problem.details?.row).toBe(4);
  });
});

describe("a failed chunk is not paid for twice", () => {
  function counter(): { url: string; calls: () => number } {
    let calls = 0;
    const server = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch(req) {
        calls++;
        const id = new URL(req.url).searchParams.get("id");
        return Response.json({ label: `label ${id}` });
      },
    });
    servers.push(server);
    return { url: `http://127.0.0.1:${server.port}`, calls: () => calls };
  }

  const paid = (api: string) => `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["issues"],
  key: "issue_id",
  incremental: true,
  async *rows({ newRows, http }) {
    for await (const r of newRows("issues")) {
      const res = await http.get("${api}/label", { query: { id: r.id } });
      yield { issue_id: r.id, label: res.json<{ label: string }>().label };
    }
  },
});
`;

  const failOnce = () => {
    let failed = false;
    return async (_db: Sql, c: CheckContext): Promise<Problem[]> => {
      if (!failed) {
        failed = true;
        throw new CroftError("CHECK_FAILED", { asset: c.asset, message: "label is wrong", hint: "fix it" });
      }
      return [];
    };
  };

  test("a failed check keeps the staged chunk; the next attempt commits it without calling the API again", async () => {
    CHUNK.rows = 2;
    const api = counter();
    const h = harness({ "assets/t.ts": paid(api.url) });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1, 2, 3, 4, 5], S1) });
    const s = await plan(h, "t");
    expect(s.usesHttp).toBe(true);
    const checks = failOnce();
    const err = await failure(step(h, s, { checks }));
    expect(err.code).toBe("CHECK_FAILED");
    expect(api.calls()).toBe(2);
    expect(existsSync(join(pendingChunkDir(h.stateDir, "t"), "chunk.json"))).toBe(true);
    expect(await all(h, `SELECT count(*)::INTEGER AS n FROM duckdb_tables() WHERE table_name = 't'`)).toEqual([{ n: 0 }]);

    const out = await step(h, s, { checks });
    expect(api.calls()).toBe(5);
    expect(out.result.requests).toBe(3);
    expect(out.result.reason).toContain("2 rows from a chunk staged earlier");
    expect(out.logText()).toContain("computed once already");
    expect(await all(h, `SELECT issue_id, label FROM t ORDER BY issue_id`)).toEqual([1, 2, 3, 4, 5].map((i) => ({ issue_id: i, label: `label ${i}` })));
    expect(existsSync(pendingChunkDir(h.stateDir, "t"))).toBe(false);
  });

  test("a chunk a check refused is thrown away once the input data changes, and the code runs on the corrected rows", async () => {
    CHUNK.rows = 2;
    const api = counter();
    const h = harness({ "assets/t.ts": paid(api.url).replace("label: res.json<{ label: string }>().label", "label: res.json<{ label: string }>().label, title: r.title") });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: [...issues([1], S1, () => "ok"), ...issues([2], S1, () => "bad"), ...issues([3], S1, () => "ok")] });
    const parsed = parseChecks({ asset: "t", file: "assets/t.ts", key: ["issue_id"], checks: ["title <> 'bad'"], warnings: [] }).checks;
    const s = { ...(await plan(h, "t")), checks: parsed };
    const checks = checksHook(parsed, { file: s.file });
    const e1 = await failure(step(h, s, { checks }));
    expect(e1.code).toBe("CHECK_FAILED");
    expect(api.calls()).toBe(2);
    // Nothing changed: the same chunk is committed again (no new calls), and refused again.
    const e2 = await failure(step(h, s, { checks }));
    expect(e2.code).toBe("CHECK_FAILED");
    expect(api.calls()).toBe(2);
    expect(e2.problem.hint).toContain("computed by an earlier run");
    // The user corrects the data, as the fix says: the chunk is computed again from the corrected rows.
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([2], S2, () => "fixed") });
    const out = await step(h, s, { checks });
    expect(out.result.status).toBe("ok");
    expect(api.calls()).toBe(5);
    expect(await all(h, `SELECT issue_id, title FROM t ORDER BY issue_id`)).toEqual([
      { issue_id: 1, title: "ok" }, { issue_id: 2, title: "fixed" }, { issue_id: 3, title: "ok" },
    ]);
  });

  test("a staged chunk is thrown away when the checks change, and kept across input changes after a busy database", async () => {
    CHUNK.rows = 2;
    const api = counter();
    const h = harness({ "assets/t.ts": paid(api.url) });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1, 2, 3], S1) });
    const s = await plan(h, "t");
    await failure(step(h, s, { checks: failOnce() }));
    expect(api.calls()).toBe(2);
    // A check was added since: the staged rows were not made for it.
    const parsed = parseChecks({ asset: "t", file: s.file, key: ["issue_id"], checks: ["issue_id > 0"], warnings: [] }).checks;
    await step(h, { ...s, checks: parsed }, { checks: checksHook(parsed, { file: s.file }) });
    expect(api.calls()).toBe(5);

    // A busy database is not about the chunk's rows: it is committed as it is, even after its input grew.
    const h2 = harness({ "assets/t.ts": paid(api.url) });
    await seed(h2, "issues", { columns: ISSUES, key: ["id"], rows: issues([1, 2, 3], S1) });
    const s2 = await plan(h2, "t");
    let busy = true;
    const busyOnce = async (): Promise<Problem[]> => {
      if (busy) {
        busy = false;
        throw new CroftError("DB_BUSY", { message: "busy", hint: "wait" });
      }
      return [];
    };
    expect((await failure(step(h2, s2, { checks: busyOnce }))).code).toBe("DB_BUSY");
    expect(api.calls()).toBe(7);
    await seed(h2, "issues", { columns: ISSUES, key: ["id"], rows: issues([4], S2) });
    const out = await step(h2, s2, { checks: busyOnce });
    expect(out.result.reason).toContain("2 rows from a chunk staged earlier");
    expect(api.calls()).toBe(9);
    expect(await all(h2, `SELECT issue_id FROM t ORDER BY issue_id`)).toEqual([1, 2, 3, 4].map((issue_id) => ({ issue_id })));
  });

  test("a staged chunk from other code, or from other positions, is thrown away", async () => {
    CHUNK.rows = 2;
    const api = counter();
    const h = harness({ "assets/t.ts": paid(api.url) });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1, 2, 3], S1) });
    await failure(step(h, await plan(h, "t"), { checks: failOnce() }));
    expect(api.calls()).toBe(2);
    // The code changed since: its rows are computed again.
    await step(h, await plan(h, "t", { codeHash: "edited" }));
    expect(api.calls()).toBe(5);

    const h2 = harness({ "assets/t.ts": paid(api.url) });
    await seed(h2, "issues", { columns: ISSUES, key: ["id"], rows: issues([1, 2, 3], S1) });
    await failure(step(h2, await plan(h2, "t"), { checks: failOnce() }));
    expect(api.calls()).toBe(7);
    // Positions moved under it (another attempt committed): it no longer fits.
    await tx(h2, async (db) => {
      await db.exec(`INSERT INTO _croft.inputs (asset, input, seen_loaded_at, seen_key) VALUES ('t', 'issues', $1::TIMESTAMPTZ, '["1"]')`, [S1]);
    });
    await step(h2, await plan(h2, "t"));
    expect(api.calls()).toBe(9);
    expect(await all(h2, `SELECT issue_id FROM t ORDER BY issue_id`)).toEqual([{ issue_id: 2 }, { issue_id: 3 }]);
  });
});

describe("the cost guard (LARGE_REPROCESS, §5)", () => {
  const guarded = (extra = "") => `import { transform } from "@zabaca/croft";
const g = globalThis as any;
export default transform({
  inputs: ["issues"],
  key: "issue_id",
  incremental: true,
  confirmAbove: 3,${extra}
  async *rows({ newRows, http }) {
    g.__t_ran = true;
    for await (const r of newRows("issues")) {
      if (g.__t_api) await http.get(g.__t_api);
      yield { issue_id: r.id };
    }
  },
});
`;

  const confirmation = { token: "c_123", expiresAt: "2026-03-01T10:15:00Z", command: "croft run t", impact: { asset: "t", action: "x", rows: 5, downstream: [] } };

  test("more pending rows than confirmAbove, with requests: no code runs until someone says yes", async () => {
    const h = harness({ "assets/t.ts": guarded() });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1, 2, 3, 4, 5], S1) });
    const s = await plan(h, "t", { readBy: ["report"] });
    expect(s.usesHttp).toBe(true);

    const bare = await failure(step(h, s));
    expect(bare.code).toBe("LARGE_REPROCESS");
    expect(bare.problem.message).toBe("t would process 5 input rows (issues 5), more than its confirmAbove of 3, and its code makes requests (an API or an LLM) for them");
    expect(bare.problem.details).toEqual({ pending: 5, confirmAbove: 3, inputs: { issues: 5 } });
    expect(g.__t_ran).toBeUndefined();

    const asked: ConfirmRequest[] = [];
    const decide = (d: ConfirmDecision) => async (r: ConfirmRequest) => {
      asked.push(r);
      return d;
    };
    const pending = await step(h, s, { confirm: decide({ kind: "pending", confirmation }) });
    expect(pending.result.status).toBe("skipped");
    expect(pending.result.skippedBecause).toContain("confirmation c_123 is waiting for a human");
    expect(pending.problems.map((p) => p.code)).toEqual(["CONFIRMATION_REQUIRED"]);
    expect(pending.problems[0]!.hint).toBe("ask the user, and only if they agree: croft confirm c_123 (valid 15 min)");
    expect(pending.confirmation).toEqual(confirmation);
    expect(asked[0]).toMatchObject({
      asset: "t", action: "large_reprocess", command: "croft run t",
      impact: { asset: "t", action: "incremental transform; LARGE_REPROCESS override", rows: 5, downstream: ["report"], estimatedRequests: 5 },
    });
    expect(asked[0]!.problem.code).toBe("LARGE_REPROCESS");
    expect((await failure(step(h, s, { confirm: decide({ kind: "declined" }) }))).code).toBe("LARGE_REPROCESS");
    expect(g.__t_ran).toBeUndefined();
    expect(await all(h, `SELECT count(*)::INTEGER AS n FROM duckdb_tables() WHERE table_name = 't'`)).toEqual([{ n: 0 }]);

    const granted = await step(h, s, { confirm: decide({ kind: "granted" }) });
    expect(granted.result.rows.total).toBe(5);
    expect(granted.logText()).toContain("confirmed: t processes 5 input rows");

    // After the first build only the new rows count.
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([6, 7], S2) });
    expect((await step(h, s)).result.rows.total).toBe(7);
  });

  test("only inputs read with newRows() count: a keyed lookup read with rows() is not paid per row", async () => {
    const h = harness({
      "assets/triage.ts": `import { transform } from "@zabaca/croft";
const g = globalThis as any;
export default transform({
  inputs: ["issues", "labels"],
  key: "issue_id",
  incremental: true,
  confirmAbove: 3,
  async *rows({ newRows, rows, http }) {
    const names = new Map<number, string>();
    for await (const l of rows<{ id: number; name: string }>("labels")) names.set(l.id, l.name);
    for await (const r of newRows<{ id: number; title: string }>("issues")) {
      if (g.__t_api) await http.get(g.__t_api);
      yield { issue_id: r.id, label: names.get(r.id) ?? null };
    }
  },
});
`,
    });
    await seed(h, "labels", { columns: { id: "BIGINT", name: "VARCHAR" }, key: ["id"], rows: Array.from({ length: 10 }, (_, i) => ({ id: String(i), name: `l${i}`, _loaded_at: S1 })) });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1, 2], S1) });
    const s = await plan(h, "triage");
    expect(s.usesHttp).toBe(true);
    expect(s.loaded?.readsNewRows).toEqual(["issues"]);
    // 2 new issues and 10 labels: under confirmAbove 3, since the labels are not processed row by row.
    expect((await step(h, s)).result.rows.total).toBe(2);
    expect((await step(h, s)).result.status).toBe("ok");
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([3, 4, 5, 6], S2) });
    const err = await failure(step(h, s));
    expect(err.code).toBe("LARGE_REPROCESS");
    expect(err.problem.details).toEqual({ pending: 4, confirmAbove: 3, inputs: { issues: 4 } });
  });

  test("an input croft could not tell is read with newRows() is counted before its first row is handed over", async () => {
    const h = harness({
      "assets/t.ts": `import { transform } from "@zabaca/croft";
const g = globalThis as any;
const method = ["new", "Rows"].join("");
export default transform({
  inputs: ["issues"],
  key: "issue_id",
  incremental: true,
  confirmAbove: 3,
  async *rows(ctx) {
    for await (const r of (ctx as any)[method]("issues")) {
      await ctx.http.get(g.__t_api ?? "http://127.0.0.1:9/");
      (g.__t_seen ??= []).push(r.id);
      yield { issue_id: r.id };
    }
  },
});
`,
    });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1, 2, 3, 4, 5], S1) });
    const s = await plan(h, "t");
    expect(s.loaded?.readsNewRows).toEqual([]);
    const err = await failure(step(h, s, { confirm: async () => ({ kind: "granted" }) }));
    expect(err.code).toBe("LARGE_REPROCESS");
    expect(err.problem.message).toContain("t would process 5 input rows (issues 5)");
    expect(err.problem.hint).toContain(`newRows("issues")`);
    expect(g.__t_seen).toBeUndefined();
  });

  test("no guard for code that makes no requests, for full-refresh transforms, or under preview", async () => {
    const h = harness({
      "assets/quiet.ts": guarded().replace(/\s+if \(g.__t_api\) await http.get\(g.__t_api\);/, "").replace("{ newRows, http }", "{ newRows }"),
      "assets/whole.ts": guarded().replace("  incremental: true,\n", ""),
      "assets/t.ts": guarded(),
    });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1, 2, 3, 4, 5], S1) });
    const quiet = await plan(h, "quiet");
    expect(quiet.usesHttp).toBe(false);
    expect((await step(h, quiet)).result.rows.total).toBe(5);
    expect((await step(h, await plan(h, "whole"))).result.rows.total).toBe(5);
    const preview = await step(h, await plan(h, "t"), { preview: { rows: 2 } });
    expect(preview.result.rows.total).toBe(2);
  });
});

describe("croft preview's row cap", () => {
  test("each input gives at most `rows` rows, to rows(), newRows() and query(); ctx.preview is true", async () => {
    const h = harness({
      "assets/t.ts": `import { transform } from "@zabaca/croft";
const g = globalThis as any;
export default transform({
  inputs: ["issues"],
  key: "issue_id",
  incremental: true,
  async *rows({ rows, newRows, query, preview }) {
    g.__t_preview = preview;
    let all = 0;
    for await (const _ of rows("issues")) all++;
    g.__t_all = all;
    g.__t_query = (await query<{ n: bigint }>("select count(*) as n from issues"))[0]!.n;
    for await (const r of newRows("issues")) yield { issue_id: r.id };
  },
});
`,
    });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1, 2, 3, 4, 5], S1) });
    const out = await step(h, await plan(h, "t"), { preview: { rows: 2 } });
    expect(g.__t_preview).toBe(true);
    expect(g.__t_all).toBe(2);
    expect(g.__t_query).toBe(2);
    expect(await all(h, `SELECT issue_id FROM t ORDER BY issue_id`)).toEqual([{ issue_id: 1 }, { issue_id: 2 }]);
    expect(out.result.reason).toContain("inputs capped at 2 rows");
    // A capped read is not a full read: staleness still sees the input as changed.
    expect(await all(h, `SELECT input_last_loaded_at AS l FROM _croft.inputs WHERE asset = 't'`)).toEqual([{ l: null }]);
    expect(getCatalog(h.runs, "t")).not.toBeNull();
  });
});

describe("a crash in the middle of a chunk (CROFT_FAULT=mid_chunk)", () => {
  test("the process dies after one committed chunk; the next run resumes after it", async () => {
    const h = harness({ "assets/t.ts": incremental().replace(`(g.__t_seen ??= []).push(String(r.id));`, `require("node:fs").appendFileSync(g.__t_file ?? "/dev/null", r.id + "\\n");`) });
    await seed(h, "issues", { columns: ISSUES, key: ["id"], rows: issues([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], S1) });
    await h.w.close();
    const seenFile = join(h.root, "seen.txt");
    const script = join(h.root, "child.ts");
    const src = (p: string) => JSON.stringify(join(PKG, "src", p));
    writeFileSync(script, `
import { openWarehouse } from ${src("db/warehouse.ts")};
import { RunsDb } from ${src("history/runs-db.ts")};
import { openLog } from ${src("history/logs.ts")};
import { discoverAssets } from ${src("project/discover.ts")};
import { ProjectEnv } from ${src("project/env.ts")};
import { loadProject } from ${src("project/root.ts")};
import { loadTsAsset } from ${src("project/ts-asset.ts")};
import { StepProgress } from ${src("run/ingest.ts")};
import { behaviorHash, behaviorLabel, resolveWrite } from ${src("run/plan.ts")};
import { CHUNK, runTransform } from ${src("run/transform.ts")};
CHUNK.rows = 4;
(globalThis as any).__t_file = ${JSON.stringify(seenFile)};
const root = ${JSON.stringify(h.root)};
const project = loadProject({ root });
const a = (await discoverAssets(root)).assets.find((x) => x.name === "t")!;
const loaded = await loadTsAsset(a, { root, timezone: project.timezone });
const spec = loaded.spec!;
const write = resolveWrite(spec);
const step: any = { asset: "t", file: a.file, path: a.path, kind: "transform", action: "update", reasons: ["requested"], reason: "requested",
  problems: [], loaded, spec, inputs: spec.inputs, orderAfter: spec.inputs, readBy: [], checks: [], usesHttp: false, write, key: spec.key,
  incremental: spec.incremental, behavior: behaviorLabel(write, spec.key), words: "", behaviorHash: behaviorHash(write, spec.key, spec.incremental),
  retries: 0, timeoutMs: 60000, codeHash: loaded.codeHash };
const w = openWarehouse({ path: project.paths.database, mode: "read_write", timezone: project.timezone, root, stateDir: project.paths.stateDir, isTTY: false });
const runs = RunsDb.open(project.paths.stateDir);
const log = openLog(project.paths.stateDir, "r_child", "t");
await runTransform({ step, project, env: ProjectEnv.load(root, {}), warehouse: w, runs, runId: "r_child", attempt: 1, maxAttempts: 1,
  signal: new AbortController().signal, progress: new StepProgress("t"), log, fault: "mid_chunk" });
console.log("finished without the fault");
`);
    const child = spawn(process.execPath, ["--no-env-file", script], {
      cwd: h.root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: h.root, CROFT_FORBID_OS_JOBS: "1", CROFT_NOTIFY_DRY: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout!.on("data", (d) => (output += d));
    child.stderr!.on("data", (d) => (output += d));
    const [code, signal] = await new Promise<[number | null, string | null]>((r) => child.on("exit", (c, s) => r([c, s])));
    expect({ code, signal, output }).toMatchObject({ code: null, signal: "SIGKILL" });
    // Rows 1-4 committed; rows 5 and 6 were processed in the second chunk and lost with it.
    expect(readFileSync(seenFile, "utf8").trim().split("\n")).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(await all(h, `SELECT count(*)::INTEGER AS n FROM t`)).toEqual([{ n: 4 }]);
    expect(await all(h, `SELECT seen_key::VARCHAR AS k FROM _croft.inputs WHERE asset = 't'`)).toEqual([{ k: `["4"]` }]);

    writeFileSync(seenFile, "");
    g.__t_file = seenFile;
    await step(h, await plan(h, "t"));
    expect(readFileSync(seenFile, "utf8").trim().split("\n")).toEqual(["5", "6", "7", "8", "9", "10"]);
    expect(await all(h, `SELECT count(*)::INTEGER AS n FROM t`)).toEqual([{ n: 10 }]);
  }, 30_000);
});
