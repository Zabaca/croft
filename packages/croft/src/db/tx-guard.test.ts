import { describe, expect, test } from "bun:test";
import { StatementType } from "@duckdb/node-api";
import { CroftError } from "../core/errors.ts";
import { statementTarget, TxGuard } from "./tx-guard.ts";

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
    ["CREATE OR REPLACE TEMP TABLE next AS SELECT 1", StatementType.CREATE, "main.next"],
    ["CREATE TABLE IF NOT EXISTS _croft.meta (key VARCHAR)", StatementType.CREATE, "_croft.meta"],
    ["CREATE VIEW v AS SELECT 1", StatementType.CREATE, null],
    ["DROP TABLE IF EXISTS t", StatementType.DROP, "main.t"],
    ["COPY t FROM 'x.csv'", StatementType.COPY, "main.t"],
    ["COPY t TO 'x.csv'", StatementType.COPY, null],
    ["COPY (SELECT 1) TO 'x.parquet'", StatementType.COPY, null],
    ["SELECT * FROM t", StatementType.SELECT, null],
  ];
  for (const [sql, type, target] of cases) test(sql, () => expect(statementTarget(sql, type)).toBe(target));
});

describe("TxGuard", () => {
  test("ALTER after DML on the same table throws DDL_AFTER_DML", () => {
    for (const dml of ["UPDATE t SET a = 1", "DELETE FROM t", "INSERT INTO t VALUES (1)", "MERGE INTO t USING s ON true WHEN MATCHED THEN DELETE"]) {
      const g = new TxGuard();
      const type = dml.startsWith("UPDATE") ? StatementType.UPDATE : dml.startsWith("DELETE") ? StatementType.DELETE
        : dml.startsWith("INSERT") ? StatementType.INSERT : StatementType.MERGE_INTO;
      g.record(type, dml);
      let caught: unknown;
      try {
        g.check(StatementType.ALTER, "ALTER TABLE main.t ADD COLUMN c INT");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(CroftError);
      expect((caught as CroftError).code).toBe("DDL_AFTER_DML");
      expect((caught as CroftError).problem.details).toMatchObject({ table: "main.t" });
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
    expect(g.tables()).toEqual(["main.raw"]);
  });

  test("CREATE TABLE IF NOT EXISTS does not exempt a table that already existed", () => {
    const g = new TxGuard();
    g.record(StatementType.CREATE, "CREATE TABLE IF NOT EXISTS _croft.assets (name VARCHAR)");
    g.record(StatementType.UPDATE, "UPDATE _croft.assets SET name = 'x'");
    expect(() => g.check(StatementType.ALTER, "ALTER TABLE _croft.assets ADD COLUMN z INT")).toThrow(CroftError);
  });

  test("a dropped table is forgotten", () => {
    const g = new TxGuard();
    g.record(StatementType.UPDATE, "UPDATE t SET a = 1");
    g.record(StatementType.DROP, "DROP TABLE t");
    g.check(StatementType.ALTER, "ALTER TABLE t ADD COLUMN c INT");
  });
});
