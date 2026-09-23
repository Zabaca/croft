import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatementType } from "@duckdb/node-api";
import { CroftError } from "../core/errors.ts";
import { statementTarget, TxGuard } from "./tx-guard.ts";
import { closeAllWarehouses, openWarehouse } from "./warehouse.ts";

afterAll(() => closeAllWarehouses());

// A WITH clause far longer than the 40 tokens the lexer used to stop at.
const LONG_CTE = `WITH ${Array.from({ length: 12 }, (_, i) => `c${i} AS (SELECT ${i} AS a, 'x' AS b FROM range(3))`).join(", ")}`;

describe("statementTarget", () => {
  const cases: [string, StatementType, string | null][] = [
    ["INSERT INTO t VALUES (1)", StatementType.INSERT, "main.t"],
    ["insert or replace into _croft.meta (key, value) values ($1, $2)", StatementType.INSERT, "_croft.meta"],
    ["INSERT INTO \"Odd Name\" BY NAME SELECT * FROM x", StatementType.INSERT, "main.odd name"],
    ["WITH s AS (SELECT (1) a) INSERT INTO t SELECT * FROM s", StatementType.INSERT, "main.t"],
    ["UPDATE T SET a = 1", StatementType.UPDATE, "main.t"],
    ["DELETE FROM main.t WHERE _file = $1", StatementType.DELETE, "main.t"],
    ["TRUNCATE t", StatementType.DELETE, "main.t"],
    ["MERGE INTO t USING next n ON t.id = n.id WHEN MATCHED THEN DELETE", StatementType.MERGE_INTO, "main.t"],
    ["ALTER TABLE t ADD COLUMN c INTEGER", StatementType.ALTER, "main.t"],
    ["ALTER TABLE IF EXISTS \"T\" ALTER COLUMN a TYPE BIGINT", StatementType.ALTER, "main.t"],
    ["-- widen\n/* note */ ALTER TABLE _croft.columns ADD COLUMN z INT", StatementType.ALTER, "_croft.columns"],
    ["ALTER VIEW v RENAME TO w", StatementType.ALTER, null],
    ["CREATE OR REPLACE TEMP TABLE next AS SELECT 1", StatementType.CREATE, "temp.main.next"],
    ["CREATE TABLE IF NOT EXISTS _croft.meta (key VARCHAR)", StatementType.CREATE, "_croft.meta"],
    ["CREATE VIEW v AS SELECT 1", StatementType.CREATE, null],
    ["DROP TABLE IF EXISTS t", StatementType.DROP, "main.t"],
    ["COPY t FROM 'x.csv'", StatementType.COPY, "main.t"],
    ["COPY t TO 'x.csv'", StatementType.COPY, null],
    ["COPY (SELECT 1) TO 'x.parquet'", StatementType.COPY, null],
    ["SELECT * FROM t", StatementType.SELECT, null],
    // The whole statement is lexed, however long its WITH clause.
    [`${LONG_CTE} UPDATE t SET a = 1`, StatementType.UPDATE, "main.t"],
    [`${LONG_CTE} DELETE FROM t WHERE a IN (SELECT a FROM c11)`, StatementType.DELETE, "main.t"],
    ["WITH s AS (SELECT ')' AS p, $$)($$ AS q, E'\\')' AS r) UPDATE t SET a = 1", StatementType.UPDATE, "main.t"],
    // Catalog-qualified names: a write transaction touches one database besides temp, so the catalog drops.
    ["DELETE FROM \"warehouse\".main.t", StatementType.DELETE, "main.t"],
    ["UPDATE Warehouse.Main.T SET a = 1", StatementType.UPDATE, "main.t"],
    ["ALTER TABLE \"w\".main.\"T\" ADD COLUMN c INT", StatementType.ALTER, "main.t"],
    ["INSERT INTO w._croft.writes VALUES (1)", StatementType.INSERT, "_croft.writes"],
    // TEMP tables stay apart from main ones.
    ["INSERT INTO temp.main.batch_1 VALUES (1)", StatementType.INSERT, "temp.main.batch_1"],
    ["INSERT INTO temp.batch_1 VALUES (1)", StatementType.INSERT, "temp.main.batch_1"],
    ["CREATE TEMP TABLE b AS SELECT 1", StatementType.CREATE, "temp.main.b"],
  ];
  for (const [sql, type, target] of cases) test(sql.slice(0, 120), () => expect(statementTarget(sql, type)).toBe(target));
});

function ddlAfterDml(fn: () => void): CroftError {
  try {
    fn();
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
  throw new Error("expected DDL_AFTER_DML");
}

describe("TxGuard", () => {
  test("ALTER after DML on the same table throws DDL_AFTER_DML", () => {
    for (const dml of ["UPDATE t SET a = 1", "DELETE FROM t", "INSERT INTO t VALUES (1)", "MERGE INTO t USING s ON true WHEN MATCHED THEN DELETE"]) {
      const g = new TxGuard();
      const type = dml.startsWith("UPDATE") ? StatementType.UPDATE : dml.startsWith("DELETE") ? StatementType.DELETE
        : dml.startsWith("INSERT") ? StatementType.INSERT : StatementType.MERGE_INTO;
      g.record(type, dml);
      const caught = ddlAfterDml(() => g.check(StatementType.ALTER, "ALTER TABLE main.t ADD COLUMN c INT"));
      expect(caught.code).toBe("DDL_AFTER_DML");
      expect(caught.problem.details).toMatchObject({ table: "main.t" });
    }
  });

  test("ALTER before DML, ALTER of another table, and tables created in the transaction pass", () => {
    const g = new TxGuard();
    g.check(StatementType.ALTER, "ALTER TABLE t ADD COLUMN c INT");
    g.record(StatementType.ALTER, "ALTER TABLE t ADD COLUMN c INT");
    g.record(StatementType.DELETE, "DELETE FROM t WHERE x");
    g.check(StatementType.ALTER, "ALTER TABLE other ADD COLUMN c INT");
    g.record(StatementType.CREATE, "CREATE TEMP TABLE raw AS SELECT 1");
    g.record(StatementType.INSERT, "INSERT INTO raw VALUES (2)");
    g.check(StatementType.ALTER, "ALTER TABLE raw ADD COLUMN c INT");
    // Replacing the table makes it new in this transaction.
    g.record(StatementType.CREATE, "CREATE OR REPLACE TABLE t AS SELECT * FROM trash.t");
    g.check(StatementType.ALTER, "ALTER TABLE t ADD COLUMN d INT");
    expect(g.tables()).toEqual(["temp.main.raw"]);
  });

  test("CREATE TABLE IF NOT EXISTS does not exempt a table that already existed", () => {
    const g = new TxGuard();
    g.record(StatementType.CREATE, "CREATE TABLE IF NOT EXISTS _croft.assets (name VARCHAR)");
    g.record(StatementType.UPDATE, "UPDATE _croft.assets SET name = 'x'");
    expect(() => g.check(StatementType.ALTER, "ALTER TABLE _croft.assets ADD COLUMN z INT")).toThrow(CroftError);
    // The words only count where they belong, not in a string of the query.
    const h = new TxGuard();
    h.record(StatementType.UPDATE, "UPDATE t SET a = 1");
    h.record(StatementType.CREATE, "CREATE OR REPLACE TEMPORARY TABLE t AS SELECT 'IF NOT EXISTS' AS note");
    h.check(StatementType.ALTER, "ALTER TABLE t ADD COLUMN c INT");
  });

  test("a dropped table is forgotten", () => {
    const g = new TxGuard();
    g.record(StatementType.UPDATE, "UPDATE t SET a = 1");
    g.record(StatementType.DROP, "DROP TABLE t");
    g.check(StatementType.ALTER, "ALTER TABLE t ADD COLUMN c INT");
  });

  test("t, main.t and \"db\".main.t are one table, in either order", () => {
    const names = ["t", "main.t", "\"warehouse\".main.t", "Warehouse.MAIN.\"T\""];
    for (const written of names) {
      for (const altered of names) {
        const g = new TxGuard();
        g.record(StatementType.DELETE, `DELETE FROM ${written} WHERE id = 1`);
        const e = ddlAfterDml(() => g.check(StatementType.ALTER, `ALTER TABLE ${altered} ADD COLUMN c INT`));
        expect({ written, altered, code: e.code, table: e.problem.details?.table }).toEqual({ written, altered, code: "DDL_AFTER_DML", table: "main.t" });
      }
    }
  });

  test("catalog.table counts once the catalog is known, from the statements or the constructor", () => {
    const g = new TxGuard();
    g.record(StatementType.UPDATE, "UPDATE warehouse.t SET a = 1");
    expect(ddlAfterDml(() => g.check(StatementType.ALTER, "ALTER TABLE \"warehouse\".main.t ADD COLUMN c INT")).code).toBe("DDL_AFTER_DML");
    const named = new TxGuard({ database: "Warehouse" });
    named.record(StatementType.DELETE, "DELETE FROM warehouse.t");
    expect(ddlAfterDml(() => named.check(StatementType.ALTER, "ALTER TABLE t ADD COLUMN c INT")).code).toBe("DDL_AFTER_DML");
    // Without either, a two-part name is a schema, as DuckDB resolves it first.
    const plain = new TxGuard();
    plain.record(StatementType.DELETE, "DELETE FROM staging.t");
    plain.check(StatementType.ALTER, "ALTER TABLE t ADD COLUMN c INT");
  });

  test("a TEMP table is a different table from the main one it shadows", () => {
    const g = new TxGuard();
    g.record(StatementType.UPDATE, "UPDATE temp.main.t SET a = 1");
    g.check(StatementType.ALTER, "ALTER TABLE \"warehouse\".main.t ADD COLUMN c INT");
    // Once a TEMP t exists, t and main.t name it [V]; the catalog-qualified name still names the real one.
    const s = new TxGuard();
    s.record(StatementType.CREATE, "CREATE TEMP TABLE t AS SELECT 1 AS a");
    s.record(StatementType.INSERT, "INSERT INTO t VALUES (2)");
    s.record(StatementType.DELETE, "DELETE FROM main.t WHERE a = 1");
    s.check(StatementType.ALTER, "ALTER TABLE \"warehouse\".main.t ADD COLUMN c INT");
    s.check(StatementType.ALTER, "ALTER TABLE t ADD COLUMN c INT");   // created in this transaction
    s.record(StatementType.DELETE, "DELETE FROM \"warehouse\".main.t");
    expect(ddlAfterDml(() => s.check(StatementType.ALTER, "ALTER TABLE warehouse.main.t ADD COLUMN d INT")).code).toBe("DDL_AFTER_DML");
    expect(s.tables().sort()).toEqual(["main.t", "temp.main.t"]);
    // Dropping the TEMP table uncovers the real one again.
    s.record(StatementType.DROP, "DROP TABLE temp.main.t");
    expect(ddlAfterDml(() => s.check(StatementType.ALTER, "ALTER TABLE t ADD COLUMN e INT")).code).toBe("DDL_AFTER_DML");
  });

  test("a write behind a long WITH clause is recorded", () => {
    const g = new TxGuard();
    g.record(StatementType.UPDATE, `${LONG_CTE} UPDATE t SET a = 1`);
    expect(ddlAfterDml(() => g.check(StatementType.ALTER, "ALTER TABLE t ADD COLUMN c INT")).code).toBe("DDL_AFTER_DML");
  });
});

describe("TxGuard in a real write transaction", () => {
  async function seeded() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-guard-")));
    mkdirSync(join(root, ".croft"));
    const w = openWarehouse({ path: join(root, "warehouse.duckdb"), mode: "read_write", timezone: "UTC", root, stateDir: join(root, ".croft"), register: false, isTTY: false });
    await w.write("seed", async (tx) => {
      await tx.exec("CREATE TABLE t (id INTEGER, v VARCHAR)");
      await tx.exec("INSERT INTO t VALUES (1, 'a'), (2, 'b')");
    }, { runId: "r" });
    return w;
  }

  const cases: [string, string, string][] = [
    ["UPDATE behind a long CTE", `${LONG_CTE} UPDATE t SET v = 'x' WHERE id = 1`, "ALTER TABLE t ADD COLUMN c INTEGER"],
    ["DELETE via a catalog-qualified name", "DELETE FROM \"warehouse\".main.t WHERE id = 1", "ALTER TABLE t ADD COLUMN c INTEGER"],
    ["DELETE on t, ALTER on the qualified name", "DELETE FROM t WHERE id = 1", "ALTER TABLE \"warehouse\".main.t ADD COLUMN c INTEGER"],
  ];
  for (const [name, dml, alter] of cases) {
    test(`${name}: DDL_AFTER_DML at the ALTER, not a raw error at COMMIT`, async () => {
      const w = await seeded();
      const err = await w.write("bad", async (tx) => {
        await tx.exec(dml);
        await tx.exec(alter);
      }, { runId: "r" }).then(() => null, (e: Error) => e);
      expect(err).toBeInstanceOf(CroftError);
      expect((err as CroftError).code).toBe("DDL_AFTER_DML");
      expect(await w.read((db) => db.all("SELECT * FROM t ORDER BY id"), { purpose: "t" })).toEqual([{ id: 1, v: "a" }, { id: 2, v: "b" }]);
    });
  }
});
