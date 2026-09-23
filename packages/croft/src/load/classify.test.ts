import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { openMemory } from "../db/connect.ts";
import { TxGuard } from "../db/tx-guard.ts";
import { LeaseSql } from "../db/warehouse.ts";
import { classify, classifyCsv, csvKindExpr, ident, stageRaw, valueKindExpr } from "./classify.ts";
import { type StageOptions, writeStage } from "./stage.ts";
import { csvKind, csvStats } from "./types.ts";

const dbs: { close(): void }[] = [];
afterAll(() => dbs.forEach((d) => d.close()));

async function testDb(timezone = "UTC") {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "croft-classify-")));
  const db = await openMemory({ timezone, stateDir: dir });
  dbs.push(db);
  const conn = await db.connect();
  let run = 0;
  return {
    async tx<T>(fn: (tx: LeaseSql) => Promise<T>): Promise<T> {
      await conn.run("BEGIN TRANSACTION");
      try {
        const out = await fn(new LeaseSql(conn, { mode: "ts", timezone }, new TxGuard()));
        await conn.run("COMMIT");
        return out;
      } catch (e) {
        await conn.run("ROLLBACK");
        throw e;
      }
    },
    stage(source: StageOptions["source"], o: Partial<StageOptions> = {}) {
      run++;
      return writeStage({ dir: join(dir, "staging", `r${run}`, "a"), asset: "a", runId: `r${run}`, source, ...o });
    },
  };
}

describe("stageRaw (3a)", () => {
  test("every staged key becomes a JSON column; _croft_seq is BIGINT; integers keep their digits", async () => {
    const db = await testDb();
    const m = await db.stage([{ id: 12345678901234567890n, f: 3.14159, s: "x" }, { id: -12345678901234567890n, u: { b: 1, a: 2 } }]);
    const out = await db.tx(async (tx) => {
      const raw = await stageRaw(tx, m);
      const types = await tx.all<{ n: string; t: string }>(`SELECT column_name n, data_type t FROM duckdb_columns() WHERE table_name = '${raw.table}' ORDER BY column_index`);
      const rows = await tx.all(`SELECT _croft_seq, id->>'$' AS id, f->>'$' AS f, u::VARCHAR AS u FROM ${ident(raw.table)} ORDER BY _croft_seq`);
      return { raw, types, rows };
    });
    expect(out.raw).toMatchObject({ table: "_croft_raw_a", rows: 2, columns: ["id", "f", "s", "u"], hasFile: false });
    expect(out.types).toEqual([
      { n: "_croft_seq", t: "BIGINT" }, { n: "id", t: "JSON" }, { n: "f", t: "JSON" }, { n: "s", t: "JSON" }, { n: "u", t: "JSON" },
    ]);
    expect(out.rows).toEqual([
      { _croft_seq: 1, id: "12345678901234567890", f: "3.14159", u: null },
      { _croft_seq: 2, id: "-12345678901234567890", f: null, u: `{"a":2,"b":1}` },
    ]);
  });

  test("ID and Id reach read_json as one column, so neither loads NULL", async () => {
    const db = await testDb();
    const m = await db.stage([{ ID: 1 }, { Id: 2 }, { id: 3 }]);
    const rows = await db.tx(async (tx) => {
      const raw = await stageRaw(tx, m);
      return tx.all<{ v: string }>(`SELECT "ID"->>'$' AS v FROM ${ident(raw.table)} ORDER BY _croft_seq`);
    });
    expect(rows.map((r) => r.v)).toEqual(["1", "2", "3"]);
  });

  test("the reserved _file column is VARCHAR", async () => {
    const db = await testDb();
    const { STAGE_FILE } = await import("./stage.ts");
    const m = await db.stage([{ a: 1, [STAGE_FILE]: "files/x.json" }]);
    const rows = await db.tx(async (tx) => tx.all(`SELECT _file, typeof(_file) t FROM ${ident((await stageRaw(tx, m)).table)}`));
    expect(rows).toEqual([{ _file: "files/x.json", t: "VARCHAR" }]);
  });

  test("a view (default) and a materialized table classify the same", async () => {
    const db = await testDb();
    const m = await db.stage([{ a: 1, b: "2024-01-01" }, { a: 1.5, c: { x: 1 } }]);
    const [view, table] = await db.tx(async (tx) => {
      const v = await stageRaw(tx, m);
      const t = await stageRaw(tx, m, { table: "raw_t", materialize: true });
      return [
        { kind: v.kind, cols: await classify(tx, v.table, v.columns) },
        { kind: t.kind, cols: await classify(tx, t.table, t.columns) },
      ];
    });
    expect(view!.kind).toBe("view");
    expect(table!.kind).toBe("table");
    expect(view!.cols).toEqual(table!.cols);
    expect(view!.cols.map((c) => c.counts)).toEqual([{ integer: 1, float: 1 }, { iso_date: 1, null: 1 }, { object: 1, null: 1 }]);
  });

  test("an empty extraction is an empty table of the same shape", async () => {
    const db = await testDb();
    const raw = await db.tx((tx) => stageRaw(tx, { asset: "a", parts: [], topLevelKeys: ["x", "y"], rows: 0 }));
    expect(raw).toMatchObject({ rows: 0, columns: ["x", "y"] });
  });

  test("a manifest that disagrees with its parts is refused", async () => {
    const db = await testDb();
    const m = await db.stage([{ a: 1 }, { a: 2 }]);
    const err = await db.tx((tx) => stageRaw(tx, { ...m, rows: 3 })).catch((e) => e);
    expect(err).toBeInstanceOf(CroftError);
    expect((err as CroftError).code).toBe("INTERNAL_ERROR");
  });
});

describe("classify (3b)", () => {
  test("counts by kind: json_type plus text rules and ISO sub-kinds confirmed by DuckDB's casts", async () => {
    const db = await testDb();
    const m = await db.stage([
      { i: 1, b: 9223372036854775808n, f: 1.5, s: "x", z: "2024-01-01T10:00:00+02:00", n: "2024-01-01T10:00:00", d: "2024-01-01", o: { a: 1 }, t: true, nul: null },
      { i: -5, b: -9223372036854775809n, f: 1e21, s: "2024-02-30", z: "2024-01-01 10:00:00Z", n: "2024-01-01T10:00", d: "2024-12-31", o: [1], t: false },
      { i: 9223372036854775807n, b: 10n ** 30n, f: -0.25, s: "2024-01-01T10:00Z", z: "2024-01-01T10:00:00.123456-0800", n: "2024-01-01 10:00:00.5", d: "2024-1-1", o: "str" },
      { i: -9223372036854775808n, b: 18446744073709551615n, s: "2024-01-01t10:00:00z", z: "2024-13-01T10:00:00Z", o: 5 },
    ]);
    const cols = await db.tx(async (tx) => {
      const raw = await stageRaw(tx, m);
      return classify(tx, raw.table, raw.columns);
    });
    const by = Object.fromEntries(cols.map((c) => [c.name, c.counts]));
    expect(by.i).toEqual({ integer: 4 });                          // int64 edges stay integer
    expect(by.b).toEqual({ bigint: 4 });                           // beyond int64, both signs, beyond uint64
    expect(by.f).toEqual({ float: 3, null: 1 });                   // 1e21 is written with an exponent
    expect(by.s).toEqual({ string: 4 });                           // invalid date, zoned without seconds, lower-case t/z
    expect(by.z).toEqual({ iso_instant: 3, string: 1 });           // month 13 fails DuckDB's cast
    expect(by.n).toEqual({ iso_naive: 3, null: 1 });
    expect(by.d).toEqual({ iso_date: 2, string: 1, null: 1 });     // 2024-1-1 is not ISO
    expect(by.o).toEqual({ object: 1, array: 1, string: 1, integer: 1 });
    expect(by.t).toEqual({ boolean: 2, null: 2 });
    expect(by.nul).toEqual({ null: 4 });                           // JSON null and a missing key are both NULL
  });

  test("counts integers beyond ±2^53 that fit int64", async () => {
    const db = await testDb();
    const m = await db.stage([{ x: 9007199254740992n }, { x: 9007199254740993n }, { x: -9007199254740993n }, { x: 5 }]);
    const [c] = await db.tx(async (tx) => {
      const raw = await stageRaw(tx, m);
      return classify(tx, raw.table, raw.columns);
    });
    expect(c).toEqual({ name: "x", counts: { integer: 4 }, unsafeIntegers: 2 });
  });

  test("valueKindExpr classifies single JSON values", async () => {
    const db = await testDb();
    const rows = await db.tx((tx) => tx.all<{ k: string }>(
      `SELECT ${valueKindExpr("v")} AS k FROM (VALUES ('1'::JSON), ('1.0'::JSON), ('"2024-01-01"'::JSON), ('null'::JSON), (NULL::JSON), ('{}'::JSON)) t(v)`,
    ));
    expect(rows.map((r) => r.k)).toEqual(["integer", "float", "iso_date", "null", "null", "object"]);
  });
});

describe("CSV text classification", () => {
  const values = [
    "", "  ", null, "42", "-7", "02134", "+5", "9223372036854775808", "3.25", "-0.5", ".5", "1e5", "true", "FALSE", "yes",
    "$1,234.50", "($3.00)", "-$5", "$-5.00", "1,234", "€12", "1.234,50", "03/25/2026", "25.03.2026", "3-5-2026", "03/25-2026",
    "13/13/2026", "2026-03-25", "2026-03-25T10:00:00Z", "2026-03-25T10:00:00", "hello",
  ];

  test("csvKindExpr (SQL) agrees with csvKind (JS) on every sample", async () => {
    const db = await testDb();
    const got = await db.tx((tx) => tx.all<{ v: string | null; k: string }>(
      `SELECT v, ${csvKindExpr("v")} AS k FROM (SELECT unnest($1::VARCHAR[]) AS v, generate_subscripts($1::VARCHAR[], 1) AS i) ORDER BY i`,
      [values],
    ));
    expect(got.map((r) => r.k)).toEqual(values.map((v) => csvKind(v)));
  });

  test("classifyCsv (SQL) matches csvStats (JS)", async () => {
    const db = await testDb();
    const columns: Record<string, (string | null)[]> = {
      money: ["$1,234.50", "($3.005)", "12", ""],
      dates: ["25/03/2026", "01/02/2026", null, "13/01/2026"],
      mixed: ["1", "9007199254740993", "2.5", "x"],
      seps: ["01/02/2026", "01.02.2026", "03/25/2026", ""],
    };
    const names = Object.keys(columns);
    const stats = await db.tx(async (tx) => {
      await tx.exec(`CREATE TEMP TABLE csv (${names.map((n) => `${ident(n)} VARCHAR`).join(", ")})`);
      for (let i = 0; i < 4; i++) {
        await tx.exec(`INSERT INTO csv VALUES (${names.map((_, j) => `$${j + 1}`).join(", ")})`, names.map((n) => columns[n]![i]));
      }
      return classifyCsv(tx, "csv", names);
    });
    for (const n of names) expect(stats.get(n)).toEqual(csvStats(columns[n]!));
    expect(stats.get("money")).toMatchObject({ maxScale: 3, counts: { money: 2, integer: 1, empty: 1 } });
    expect(stats.get("dates")).toMatchObject({ firstOver12: 2, secondOver12: 0, dateSeparators: ["/"] });
    expect(stats.get("mixed")).toMatchObject({ unsafeIntegers: 1 });
    expect(stats.get("seps")!.dateSeparators).toEqual([".", "/"]);
  });
});
