import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { closeAllWarehouses, type DuckWarehouse, openWarehouse } from "../db/warehouse.ts";
import { kindOfType, tableBatch } from "./table-batch.ts";

afterAll(() => closeAllWarehouses());

function warehouse(): DuckWarehouse {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-tbatch-")));
  mkdirSync(join(root, ".croft"));
  mkdirSync(join(root, "files"));
  return openWarehouse({ path: join(root, "warehouse.duckdb"), mode: "read_write", timezone: "UTC", root, stateDir: join(root, ".croft"), register: false, isTTY: false });
}

describe("tableBatch", () => {
  test("one plan per data column, typed as the TEMP table has it, with the kinds of values it holds", async () => {
    const w = warehouse();
    const batch = await w.write("t", async (tx) => {
      await tx.exec(`CREATE TEMP TABLE out AS SELECT *, row_number() OVER () AS _croft_seq FROM (VALUES
        (1, 'a', NULL::VARCHAR, '{"k": 1}'::JSON, [1, 2], {'x': 1}, TIMESTAMPTZ '2026-09-22 10:00:00+00', DATE '2026-09-22', 1.5::DOUBLE, true),
        (2, 'b', NULL, '[1]'::JSON, NULL, NULL, NULL, NULL, NULL, NULL)
      ) AS v(id, name, empty, j, l, s, "at", day, x, flag)`);
      return tableBatch(tx, { temp: "out", asset: "result" });
    }, { runId: "r_1" });
    expect(batch.temp).toBe("out");
    expect(batch.rows).toBe(2);
    expect(batch.warnings).toEqual([]);
    expect(batch.cursor).toBeUndefined();
    const plan = (c: string) => batch.columns.find((p) => p.column === c);
    expect(batch.columns.map((p) => p.column)).toEqual(["id", "name", "empty", "j", "l", "s", "at", "day", "x", "flag"]);
    expect(plan("id")).toEqual({ column: "id", sourceName: "id", existing: null, incoming: ["integer"], decision: "add", target: "INTEGER" });
    expect(plan("name")).toMatchObject({ incoming: ["string"], target: "VARCHAR" });
    // Present in every row, but only NULL.
    expect(plan("empty")).toMatchObject({ incoming: ["null"], target: "VARCHAR" });
    // JSON columns: the kinds of the values themselves.
    expect(plan("j")!.incoming.sort()).toEqual(["array", "object"]);
    expect(plan("l")).toMatchObject({ incoming: ["array"], target: "INTEGER[]" });
    expect(plan("s")!.incoming).toEqual(["object"]);
    expect(plan("at")).toMatchObject({ incoming: ["iso_instant"], target: "TIMESTAMPTZ" });
    expect(plan("day")).toMatchObject({ incoming: ["iso_date"], target: "DATE" });
    expect(plan("x")).toMatchObject({ incoming: ["float"], target: "DOUBLE" });
    expect(plan("flag")).toMatchObject({ incoming: ["boolean"], target: "BOOLEAN" });
  });

  test("existing types come from the asset's table; an empty batch holds nothing", async () => {
    const w = warehouse();
    const batch = await w.write("t", async (tx) => {
      await tx.exec(`CREATE TABLE result (id BIGINT, name VARCHAR, _loaded_at TIMESTAMPTZ)`);
      await tx.exec(`CREATE TEMP TABLE out AS SELECT 1::BIGINT AS id, 2 AS n, 1::BIGINT AS _croft_seq WHERE false`);
      return tableBatch(tx, { temp: "out", asset: "result" });
    }, { runId: "r_1" });
    expect(batch.rows).toBe(0);
    expect(batch.columns).toEqual([
      { column: "id", sourceName: "id", existing: "BIGINT", incoming: [], decision: "keep", target: "BIGINT" },
      { column: "n", sourceName: "n", existing: null, incoming: [], decision: "add", target: "INTEGER" },
    ]);
  });

  test("reserved columns are not data; the table must carry _croft_seq", async () => {
    const w = warehouse();
    const batch = await w.write("t", async (tx) => {
      await tx.exec(`CREATE TEMP TABLE out AS SELECT 1 AS id, 'f.csv' AS _file, 1::BIGINT AS _croft_seq`);
      return tableBatch(tx, { temp: "out", asset: "result" });
    }, { runId: "r_1" });
    expect(batch.columns.map((p) => p.column)).toEqual(["id"]);
    const e = await w.write("t", async (tx) => {
      await tx.exec(`CREATE TEMP TABLE bare AS SELECT 1 AS id`);
      return tableBatch(tx, { temp: "bare", asset: "result" }).then(() => null, (x: unknown) => x);
    }, { runId: "r_2" });
    expect(e).toBeInstanceOf(CroftError);
    expect((e as CroftError).code).toBe("INTERNAL_ERROR");
  });

  test("kindOfType maps DuckDB types to the value kinds _croft.columns records", () => {
    expect(["TINYINT", "INTEGER", "BIGINT", "UBIGINT", "HUGEINT"].map(kindOfType)).toEqual(["integer", "integer", "integer", "integer", "integer"]);
    expect(["FLOAT", "DOUBLE", "DECIMAL(18,2)"].map(kindOfType)).toEqual(["float", "float", "float"]);
    expect(["TIMESTAMPTZ", "TIMESTAMP", "TIMESTAMP_NS", "DATE"].map(kindOfType)).toEqual(["iso_instant", "iso_naive", "iso_naive", "iso_date"]);
    expect(["VARCHAR[]", "INTEGER[3]", "STRUCT(A INTEGER)", "MAP(VARCHAR,INTEGER)", "UNION(A INTEGER)"].map(kindOfType))
      .toEqual(["array", "array", "object", "object", "object"]);
    expect(["VARCHAR", "UUID", "INTERVAL", "TIME", "BLOB", "BOOLEAN"].map(kindOfType)).toEqual(["string", "string", "string", "string", "string", "boolean"]);
  });
});
