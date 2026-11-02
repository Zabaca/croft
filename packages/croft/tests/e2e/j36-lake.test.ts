// Journey 36: a project whose warehouse is a lake (DESIGN.md D138 to D144; option 07, slice 2). The real croft CLI, in a project whose
// croft.json has a `lake` block, run twice: against a local lake (a SQLite catalog and a folder) and against a Postgres catalog and an
// S3-compatible store, both started as child processes of the test. Every journey step is what a person or an agent does:
//   a. run, query, describe, status: the example asset lands in the lake, and its bookkeeping is the log, in format 4, with the machine
//      that wrote it;
//   b. a second run changes nothing; a SQL asset reads the first and is rebuilt when it changes;
//   c. delete, then restore from the local trash, returns the rows exactly (acceptance 9);
//   d. rename moves a table and its bookkeeping;
//   e. preview builds the SQL asset's next version in the preview database without touching the lake;
//   f. the same fixtures in a file and in a lake give the same tables, row counts and bookkeeping counts (acceptance 2).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { lakeRigReady, type LakeRig, localLakeBlock, startLakeRig, useLake } from "../../src/db/lake-testkit.ts";
import { cleanupAll, type Envelope, initProject, type Project, show } from "./harness.ts";

const ready = lakeRigReady();
if (!ready.ready) console.warn(`[j36] SKIPPING the lake journeys: ${ready.skipReason}`);
const maybe = ready.ready ? describe : describe.skip;

let rig: LakeRig | undefined;
beforeAll(async () => {
  if (ready.ready) rig = await startLakeRig();
}, 120_000);
afterAll(async () => {
  await rig?.stop();
  await cleanupAll();
});

/** `croft <args> --json` in `p`, with the extension files named by the environment, as the suite names them everywhere. */
const run = (p: Project, args: string[]): Promise<Awaited<ReturnType<Project["json"]>>> => p.json(args, { env: { CROFT_EXTENSION_DIR: ready.dir } });

const confirmed = async (p: Project, args: string[]): Promise<Envelope> => {
  const asked = await run(p, args);
  expect(asked.code, show(asked)).toBe(5);
  const done = await run(p, ["confirm", asked.json.confirmation.token]);
  expect(done.code, show(done)).toBe(0);
  return done.json;
};

const SUMMARY_SQL = `-- description: orders and quantities by region
-- key: region
SELECT region, count(*) AS orders, sum(quantity) AS quantity FROM example_sales GROUP BY region
`;

type Kind = "local" | "postgres";

async function lakeProject(kind: Kind): Promise<Project> {
  const { project: p } = await initProject(`lake-${kind}`);
  if (kind === "local") useLake(p.root, { block: localLakeBlock() });
  else useLake(p.root, await rig!.lake());
  return p;
}

for (const kind of ["local", "postgres"] as const) {
  maybe(`journey 36 (${kind} lake): the warehouse is a lake`, () => {
    let p: Project;
    beforeAll(async () => {
      p = await lakeProject(kind);
    }, 120_000);

    test("a. validate, run, query, describe and status work on a lake, and its bookkeeping is the log", async () => {
      const v = await run(p, ["validate"]);
      expect(v.code, show(v)).toBe(0);
      expect(v.json.data.addons).toEqual([expect.objectContaining({ addon: "lake", ok: true })]);
      const first = await run(p, ["run"]);
      expect(first.code, show(first)).toBe(0);
      expect(first.json.data.steps[0]).toMatchObject({ asset: "example_sales", status: "ok", rows: { added: 120, total: 120 } });
      // The warehouse file is never made; the lake is what holds the table.
      expect(existsSync(join(p.root, "warehouse.duckdb"))).toBe(false);
      const q = await run(p, ["query", "select count(*)::INT as n, sum(quantity)::INT as q from example_sales"]);
      expect(q.code, show(q)).toBe(0);
      expect(q.json.data.rows).toEqual([{ n: 120, q: 417 }]);
      const d = await run(p, ["describe", "example_sales"]);
      expect(d.code, show(d)).toBe(0);
      expect(d.json.data).toMatchObject({ asset: "example_sales", rows: 120, kind: "ingest" });
      const s = await run(p, ["status"]);
      expect(s.code, show(s)).toBe(0);
      expect(s.json.data.assets[0]).toMatchObject({ asset: "example_sales", status: "ok" });
      // The bookkeeping: a log, format 4, and the machine that wrote.
      const meta = Object.fromEntries((await run(p, ["query", "select key, value from _croft.meta", "--full-values"])).json.data.rows.map((r: { key: string; value: string }) => [r.key, r.value]));
      expect(meta).toMatchObject({ format_version: "4", bookkeeping: "log" });
      expect(JSON.parse(meta.last_writer)).toMatchObject({ machine: expect.stringMatching(/^[0-9a-f]{16}$/), croft: expect.any(String) });
    }, 120_000);

    test("b. a second run changes nothing; a SQL asset that reads the table is built and follows it", async () => {
      const again = await run(p, ["run"]);
      expect(again.code, show(again)).toBe(0);
      expect(again.json.data.steps[0]).toMatchObject({ asset: "example_sales", status: "unchanged", rows: { added: 0, updated: 0 } });
      p.write("assets/region_summary.sql", SUMMARY_SQL);
      const built = await run(p, ["run"]);
      expect(built.code, show(built)).toBe(0);
      const summary = await run(p, ["query", "select region, orders::INT as orders, quantity::INT as quantity from region_summary order by region"]);
      expect(summary.json.data.rowCount).toBeGreaterThan(1);
      const total = (summary.json.data.rows as { orders: number }[]).reduce((n, r) => n + r.orders, 0);
      expect(total).toBe(120);
    }, 120_000);

    test("c. delete, then restore, round-trips the table exactly from the local trash (acceptance 9)", async () => {
      const before = (await run(p, ["query", "select * from example_sales order by order_id", "--limit", "1000"])).json.data.rows;
      await confirmed(p, ["delete", "example_sales"]);
      const gone = await run(p, ["query", "select count(*) from example_sales"]);
      expect(gone.code).not.toBe(0);
      await confirmed(p, ["restore", "example_sales"]);
      const after = (await run(p, ["query", "select * from example_sales order by order_id", "--limit", "1000"])).json.data.rows;
      expect(after).toEqual(before);
      expect(readdirSync(join(p.stateDir, "trash", "example_sales")).some((f) => f.endsWith(".duckdb"))).toBe(true);
    }, 180_000);

    test("d. rename moves the table and its bookkeeping", async () => {
      const r = await run(p, ["rename", "region_summary", "regions"]);
      expect(r.code, show(r)).toBe(0);
      const names = (await run(p, ["query", "select name from _croft.assets order by name"])).json.data.rows.map((x: { name: string }) => x.name);
      expect(names).toEqual(["example_sales", "regions"]);
      expect((await run(p, ["query", "select sum(orders)::INT as n from regions"])).json.data.rows).toEqual([{ n: 120 }]);
    }, 120_000);

    test("e. preview builds in the preview database and leaves the lake alone", async () => {
      const before = (await run(p, ["query", "select count(*)::INT as n from _croft.writes"])).json.data.rows;
      p.write("assets/regions.sql", SUMMARY_SQL.replace("count(*) AS orders", "count(*)::BIGINT AS orders, 1 AS one"));
      const pv = await run(p, ["preview", "regions"]);
      expect(pv.code, show(pv)).toBe(0);
      expect(pv.json.data.assets[0]).toMatchObject({ asset: "regions", status: "ok" });
      expect((await run(p, ["query", "select count(*)::INT as n from _croft.writes"])).json.data.rows).toEqual(before);
    }, 180_000);

    test("f. a column of a type a lake cannot hold (ENUM, UNION, VARINT) is refused before anything is written, with the cast that fixes it (acceptance 8)", async () => {
      const writes = async () => (await run(p, ["query", "select count(*)::INT as n from _croft.writes"])).json.data.rows;
      const before = await writes();
      for (const [kind, expr] of [["ENUM", "CAST('a' AS ENUM('a', 'b'))"], ["UNION", "union_value(num := 1)"], ["VARINT", "CAST(5 AS VARINT)"]] as const) {
        p.write("assets/odd.sql", `-- description: a column a lake cannot hold\n-- key: id\nSELECT 1 AS id, ${expr} AS odd\n`);
        const r = await run(p, ["run", "odd"]);
        expect(r.code, show(r)).not.toBe(0);
        const problem = r.json.problems?.[0] ?? r.json.data?.steps?.[0]?.problem;
        expect(problem, show(r)).toMatchObject({ code: "LAKE_TYPE_UNSUPPORTED", effect: "nothing was written" });
        expect(problem.message).toMatch(new RegExp(`odd is (${kind}|BIGNUM)`));
        expect(problem.hint).toContain("CAST(odd AS");
      }
      // Nothing was written: no table, no bookkeeping row, and the fix (the cast the hint gives) runs.
      expect((await run(p, ["query", "select count(*) from odd"])).code).not.toBe(0);
      expect(await writes()).toEqual(before);
      p.write("assets/odd.sql", "-- description: fixed\n-- key: id\nSELECT 1 AS id, CAST(CAST('a' AS ENUM('a', 'b')) AS VARCHAR) AS odd\n");
      const fixed = await run(p, ["run", "odd"]);
      expect(fixed.code, show(fixed)).toBe(0);
      expect((await run(p, ["query", "select odd from odd"])).json.data.rows).toEqual([{ odd: "a" }]);
    }, 180_000);

    test("g. croft backup says it does not cover a lake yet, and copies nothing", async () => {
      const b = await run(p, ["backup"]);
      expect(b.code, show(b)).toBe(2);
      expect(b.json.problems[0]).toMatchObject({ code: "LAKE_UNSUPPORTED", effect: "nothing was copied" });
      expect(existsSync(join(p.stateDir, "backups"))).toBe(false);
    }, 120_000);

    // Full refresh in a lake (D146): a SQL transform whose SELECT keeps its shape is rewritten in place, as a file's is, so its table is one
    // table of the lake across runs (a CREATE OR REPLACE would make a new one each time and leave the old to maintenance). Read from the
    // SQLite catalog, which a local lake has on disk.
    (kind === "local" ? test : test.skip)("h. a SQL transform that keeps its shape is changed in place: one table of the lake across runs, rows replaced", async () => {
      p.write("assets/stable.sql", "-- description: stable\n-- key: id\nSELECT range AS id, 'a' AS v FROM range(30)\n");
      expect((await run(p, ["run", "stable"])).code).toBe(0);
      p.write("assets/stable.sql", "-- description: stable\n-- key: id\nSELECT range AS id, 'b' AS v FROM range(25)\n");
      const again = await run(p, ["run", "stable"]);
      expect(again.code, show(again)).toBe(0);
      expect(again.json.data.steps[0]).toMatchObject({ asset: "stable", rows: { updated: 25, deleted: 5, total: 25 } });
      const { Database } = await import("bun:sqlite");
      const db = new Database(join(p.root, "lake", "catalog.sqlite"), { readonly: true });
      try {
        const tables = db.query("SELECT table_id, end_snapshot FROM ducklake_table WHERE table_name = 'stable'").all() as { table_id: number; end_snapshot: number | null }[];
        expect(tables.length).toBe(1);
        expect(tables[0]!.end_snapshot).toBeNull();
      } finally {
        db.close();
      }
    }, 180_000);
  });
}

maybe("journey 36 (equal): a file and a lake given the same fixtures hold the same tables, row counts and bookkeeping counts (acceptance 2)", () => {
  test("the example, a SQL asset on it, a second run and a delete and restore", async () => {
    const { project: file } = await initProject("equal-file");
    const lake = await lakeProject("postgres");
    const counts = async (p: Project) => {
      const tables = (await run(p, ["query", "select table_name from duckdb_tables() where schema_name = 'main' order by 1"])).json.data.rows;
      const rows = (await run(p, ["query", "select name, row_count::INT as row_count from _croft.assets order by name"])).json.data.rows;
      const writes = (await run(p, ["query", "select asset, mode, rows_in::INT as rows_in, added::INT as added, updated::INT as updated, unchanged::INT as unchanged, deleted::INT as deleted from _croft.writes order by loaded_at, asset"])).json.data.rows;
      const cols = (await run(p, ["query", "select asset, name, type from _croft.columns order by asset, name"])).json.data.rows;
      return { tables, rows, writes, cols };
    };
    for (const p of [file, lake]) {
      p.write("assets/region_summary.sql", SUMMARY_SQL);
      expect((await run(p, ["run"])).code).toBe(0);
      expect((await run(p, ["run"])).code).toBe(0);
      await confirmed(p, ["delete", "region_summary"]);
      await confirmed(p, ["restore", "region_summary"]);
    }
    const a = await counts(file);
    const b = await counts(lake);
    expect(b).toEqual(a);
  }, 240_000);
});
