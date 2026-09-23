import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import type { ColumnPlan } from "../core/types.ts";
import { closeAllWarehouses, type DuckWarehouse, openWarehouse } from "../db/warehouse.ts";
import { evolveTable, isReservedColumn, normalizeType, quoteIdent, quoteLiteral, readTableSchema, safeType, tableRef, tempRef } from "./evolve.ts";

afterAll(() => closeAllWarehouses());

function warehouse(): DuckWarehouse {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-evolve-")));
  mkdirSync(join(root, ".croft"));
  return openWarehouse({ path: join(root, "warehouse.duckdb"), mode: "read_write", timezone: "UTC", root, stateDir: join(root, ".croft"), register: false, isTTY: false });
}

const plan = (column: string, p: Partial<ColumnPlan> = {}): ColumnPlan =>
  ({ column, sourceName: column, existing: null, incoming: ["integer"], decision: "add", ...p });

async function rejection(p: Promise<unknown>): Promise<CroftError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
  throw new Error("expected a CroftError");
}

const schema = (w: DuckWarehouse, t: string) => w.read((db) => readTableSchema(db, t), { purpose: "t" });

describe("identifiers and types", () => {
  test("quoteIdent always quotes and doubles embedded quotes", () => {
    expect(quoteIdent("order")).toBe('"order"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
    expect(quoteLiteral("it's")).toBe("'it''s'");
    expect(tableRef("warehouse", "t")).toBe('"warehouse".main."t"');
    expect(tempRef("x")).toBe('temp.main."x"');
  });

  test("normalizeType maps DuckDB's spellings and common aliases to croft's names", () => {
    expect(normalizeType("TIMESTAMP WITH TIME ZONE")).toBe("TIMESTAMPTZ");
    expect(normalizeType("timestamptz")).toBe("TIMESTAMPTZ");
    expect(normalizeType("decimal(18, 2)")).toBe("DECIMAL(18,2)");
    expect(normalizeType("numeric(10,4)")).toBe("DECIMAL(10,4)");
    expect(normalizeType("int8")).toBe("BIGINT");
    expect(normalizeType("text")).toBe("VARCHAR");
    expect(normalizeType("VARCHAR[]")).toBe("VARCHAR[]");
    expect(normalizeType(" json ")).toBe("JSON");
  });

  test("safeType refuses anything that is not a plain type, because pins reach DDL", () => {
    expect(safeType("decimal(18,2)", "amount")).toBe("DECIMAL(18,2)");
    for (const bad of ["BIGINT); DROP TABLE x; --", "VARCHAR DEFAULT 'x'", "INT -- c", "\"x\"", ""]) {
      expect(() => safeType(bad, "c")).toThrow(CroftError);
    }
  });

  test("reserved columns", () => {
    expect(["_loaded_at", "_FILE", "_croft_seq"].every(isReservedColumn)).toBe(true);
    expect(isReservedColumn("loaded_at")).toBe(false);
  });
});

describe("evolveTable", () => {
  test("creates the table on the first load: plan order, _file when the batch has it, _loaded_at last", async () => {
    const w = warehouse();
    const r = await w.write("t", (tx) => evolveTable(tx, {
      table: "sales",
      plans: [plan("order_id", { target: "BIGINT" }), plan("closed_at", { incoming: ["null"], target: "TIMESTAMPTZ" }), plan("note", { target: undefined }),
        plan("_loaded_at", { target: "VARCHAR" })],
      batchColumns: [{ name: "order_id", type: "BIGINT" }, { name: "note", type: "VARCHAR" }, { name: "_file", type: "VARCHAR" }, { name: "_croft_seq", type: "BIGINT" }],
    }), { runId: "r" });
    expect(r).toEqual({ created: true, changes: [], columns: [
      { name: "order_id", type: "BIGINT" }, { name: "closed_at", type: "TIMESTAMPTZ" }, { name: "note", type: "VARCHAR" },
      { name: "_file", type: "VARCHAR" }, { name: "_loaded_at", type: "TIMESTAMPTZ" },
    ] });
  });

  test("adds new columns, widens, retypes pending columns; unchanged columns cost nothing", async () => {
    const w = warehouse();
    await w.write("t", async (tx) => {
      await tx.exec(`CREATE TABLE t (id BIGINT, amount BIGINT, refunded_at TIMESTAMPTZ, _loaded_at TIMESTAMPTZ)`);
      await tx.exec(`INSERT INTO t VALUES (1, 9007199254740993, NULL, now())`);
    }, { runId: "r" });
    const r = await w.write("t", (tx) => evolveTable(tx, {
      table: "t",
      plans: [plan("id", { existing: "BIGINT", decision: "keep" }), plan("amount", { existing: "BIGINT", decision: "widen", target: "HUGEINT" }),
        plan("refunded_at", { existing: "TIMESTAMPTZ", decision: "retype_pending", target: "VARCHAR", incoming: ["string"] }),
        plan("Tags", { target: "JSON", incoming: ["array"] }), plan("ID", { existing: "BIGINT", decision: "cast", target: "BIGINT" })],
      batchColumns: [],
    }), { runId: "r" });
    expect(r.created).toBe(false);
    expect(r.changes).toEqual([
      { kind: "widen", column: "amount", from: "BIGINT", to: "HUGEINT" },
      { kind: "retype_pending", column: "refunded_at", to: "VARCHAR" },
      { kind: "add_column", column: "Tags", type: "JSON" },
    ]);
    expect(await schema(w, "t")).toEqual([
      { name: "id", type: "BIGINT" }, { name: "amount", type: "HUGEINT" }, { name: "refunded_at", type: "VARCHAR" },
      { name: "_loaded_at", type: "TIMESTAMPTZ" }, { name: "Tags", type: "JSON" },
    ]);
    expect(await w.read((db) => db.all(`SELECT amount FROM t`), { purpose: "t" })).toEqual([{ amount: 9007199254740993n }]);
  });

  test("a pending column that holds values outside croft is not retyped", async () => {
    const w = warehouse();
    await w.write("t", async (tx) => {
      await tx.exec(`CREATE TABLE t (id BIGINT, closed_at VARCHAR, _loaded_at TIMESTAMPTZ)`);
      await tx.exec(`INSERT INTO t VALUES (1, 'yesterday', now())`);
    }, { runId: "r" });
    const e = await rejection(w.write("t", (tx) => evolveTable(tx, {
      table: "t", plans: [plan("closed_at", { existing: "VARCHAR", decision: "retype_pending", target: "TIMESTAMPTZ", incoming: ["iso_instant"] })], batchColumns: [],
    }), { runId: "r" }));
    expect(e.code).toBe("TYPE_CONFLICT");
    expect(e.problem.details).toMatchObject({ column: "closed_at", tableType: "VARCHAR", wanted: "TIMESTAMPTZ", nonNull: 1 });
  });

  test("an 'add' for a column that already exists: same type is a no-op, an all-NULL column is retyped", async () => {
    const w = warehouse();
    await w.write("t", (tx) => tx.exec(`CREATE TABLE t (a BIGINT, b VARCHAR, _loaded_at TIMESTAMPTZ)`), { runId: "r" });
    const r = await w.write("t", (tx) => evolveTable(tx, {
      table: "t", plans: [plan("a", { target: "BIGINT" }), plan("b", { target: "DATE", incoming: ["iso_date"] })], batchColumns: [],
    }), { runId: "r" });
    expect(r.changes).toEqual([{ kind: "retype_pending", column: "b", to: "DATE" }]);
  });

  test("conflicts fail loudly: a conflict decision, and a keep whose type the table no longer has", async () => {
    const w = warehouse();
    await w.write("t", (tx) => tx.exec(`CREATE TABLE t (a BIGINT, _loaded_at TIMESTAMPTZ)`), { runId: "r" });
    const e1 = await rejection(w.write("t", (tx) => evolveTable(tx, {
      table: "t", plans: [plan("a", { existing: "BIGINT", decision: "conflict", incoming: ["string"], samples: ["x"], badRows: 1 })], batchColumns: [],
    }), { runId: "r" }));
    expect(e1.code).toBe("TYPE_CONFLICT");
    expect(e1.problem.details).toMatchObject({ column: "a", badRows: 1, samples: ["x"] });
    const e2 = await rejection(w.write("t", (tx) => evolveTable(tx, {
      table: "t", plans: [plan("a", { existing: "VARCHAR", decision: "keep" })], batchColumns: [],
    }), { runId: "r" }));
    expect(e2.code).toBe("TYPE_CONFLICT");
    expect(e2.problem.details).toMatchObject({ tableType: "BIGINT", wanted: "VARCHAR" });
  });

  test("croft's own columns come back when they were dropped outside croft", async () => {
    const w = warehouse();
    await w.write("t", (tx) => tx.exec(`CREATE TABLE t (a BIGINT)`), { runId: "r" });
    const r = await w.write("t", (tx) => evolveTable(tx, {
      table: "t", plans: [plan("a", { existing: "BIGINT", decision: "keep" })], batchColumns: [{ name: "_file", type: "VARCHAR" }],
    }), { runId: "r" });
    expect(r.changes).toEqual([{ kind: "add_column", column: "_file", type: "VARCHAR" }, { kind: "add_column", column: "_loaded_at", type: "TIMESTAMPTZ" }]);
  });

  test("an injected pin type never reaches DDL", async () => {
    const w = warehouse();
    const e = await rejection(w.write("t", (tx) => evolveTable(tx, {
      table: "t", plans: [plan("a", { target: "BIGINT); DROP TABLE _croft.meta; --" })], batchColumns: [],
    }), { runId: "r" }));
    expect(e.code).toBe("ASSET_INVALID");
    expect(await schema(w, "t")).toBeNull();
  });
});

describe("DDL before DML", () => {
  test("evolving after DML on the same table is DDL_AFTER_DML at the ALTER, not a failed COMMIT", async () => {
    const w = warehouse();
    await w.write("t", async (tx) => {
      await tx.exec(`CREATE TABLE t (id BIGINT, a BIGINT, _loaded_at TIMESTAMPTZ)`);
      await tx.exec(`INSERT INTO t VALUES (1, 1, now())`);
    }, { runId: "r" });
    const e = await rejection(w.write("t", async (tx) => {
      // The same qualified form evolveTable uses: TxGuard keys tables by their written name.
      const ref = tableRef((await tx.all<{ d: string }>(`SELECT current_database() AS d`))[0]!.d, "t");
      await tx.exec(`DELETE FROM ${ref} WHERE id = 1`);
      await evolveTable(tx, { table: "t", plans: [plan("b", { target: "VARCHAR" })], batchColumns: [] });
    }, { runId: "r" }));
    expect(e.code).toBe("DDL_AFTER_DML");
    expect(await schema(w, "t")).toEqual([{ name: "id", type: "BIGINT" }, { name: "a", type: "BIGINT" }, { name: "_loaded_at", type: "TIMESTAMPTZ" }]);
    expect(await w.read((db) => db.all(`SELECT id FROM t`), { purpose: "t" })).toEqual([{ id: 1 }]);
  });

  test("evolving first and writing after commits both", async () => {
    const w = warehouse();
    await w.write("t", async (tx) => {
      await tx.exec(`CREATE TABLE t (id BIGINT, a BIGINT, _loaded_at TIMESTAMPTZ)`);
      await tx.exec(`INSERT INTO t VALUES (1, 1, now())`);
    }, { runId: "r" });
    await w.write("t", async (tx) => {
      await evolveTable(tx, { table: "t", plans: [plan("a", { existing: "BIGINT", decision: "widen", target: "HUGEINT" }), plan("b", { target: "VARCHAR" })], batchColumns: [] });
      const ref = tableRef((await tx.all<{ d: string }>(`SELECT current_database() AS d`))[0]!.d, "t");
      await tx.exec(`UPDATE ${ref} SET b = 'x', a = 170141183460469231731687303715884105727`);
      await tx.exec(`DELETE FROM ${ref} WHERE id = 2`);
    }, { runId: "r" });
    expect(await w.read((db) => db.all(`SELECT a, b FROM t`), { purpose: "t" })).toEqual([{ a: 170141183460469231731687303715884105727n, b: "x" }]);
  });
});
