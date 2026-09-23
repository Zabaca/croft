import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { ensureState } from "../db/state.ts";
import { closeAllWarehouses, type DuckWarehouse, openWarehouse } from "../db/warehouse.ts";
import { assertNoShrink, compareSchema, detectOutOfBand, detectTableModified, diffSchema, isoMicros, markOutOfBand, readStoredColumns,
  shrinkGuardDisabled, tableStats, wouldShrink } from "./guards.ts";

afterAll(() => closeAllWarehouses());

function warehouse(): DuckWarehouse {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-guards-")));
  mkdirSync(join(root, ".croft"));
  return openWarehouse({ path: join(root, "warehouse.duckdb"), mode: "read_write", timezone: "UTC", root, stateDir: join(root, ".croft"), register: false, isTTY: false });
}

function thrown(fn: () => unknown): CroftError {
  try {
    fn();
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
  throw new Error("expected a CroftError");
}

describe("shrink guard", () => {
  test("more than half of the rows, all of them included", () => {
    expect(wouldShrink(265, 0)).toBe(true);
    expect(wouldShrink(10, 4)).toBe(true);
    expect(wouldShrink(3, 1)).toBe(true);
    expect(wouldShrink(10, 5)).toBe(false);
    expect(wouldShrink(2, 1)).toBe(false);
    expect(wouldShrink(1, 1)).toBe(false);
    expect(wouldShrink(0, 0)).toBe(false);
    expect(wouldShrink(5, 50)).toBe(false);
  });

  test("SHRINK_GUARD carries rowsBefore/rowsAfter and a fix only a human can apply", () => {
    const e = thrown(() => assertNoShrink({ asset: "taxi_zones", rowsBefore: 265, rowsAfter: 0, extract: { requests: 1, lastStatus: 401, bodyPreview: "{}" } }));
    expect(e.code).toBe("SHRINK_GUARD");
    expect(e.exit).toBe(1);
    expect(e.problem).toMatchObject({
      severity: "error", asset: "taxi_zones",
      message: "taxi_zones would go from 265 rows to 0; croft does not let a replace ingest remove more than half of its rows",
      fix: { kind: "manual", requiresHuman: true },
      details: { rowsBefore: 265, rowsAfter: 0, requests: 1, lastStatus: 401, bodyPreview: "{}" },
    });
    expect((e.problem.fix as { description: string }).description).toContain("returned 0 of 265 rows");
  });

  test("allowShrink lets it through with SHRINK_GUARD_DISABLED; no shrink, no warning", () => {
    expect(assertNoShrink({ asset: "a", rowsBefore: 10, rowsAfter: 1, allowShrink: true })).toMatchObject({
      code: "SHRINK_GUARD_DISABLED", severity: "warning", details: { rowsBefore: 10, rowsAfter: 1 },
    });
    expect(assertNoShrink({ asset: "a", rowsBefore: 10, rowsAfter: 9 })).toBeNull();
  });

  test("SHRINK_GUARD_DISABLED for an asset that sets allowShrink", () => {
    const p = shrinkGuardDisabled("taxi_zones", { file: "assets/taxi_zones.ts", line: 7 });
    expect(p).toMatchObject({ code: "SHRINK_GUARD_DISABLED", severity: "warning", file: "assets/taxi_zones.ts", line: 7,
      fix: { kind: "edit", file: "assets/taxi_zones.ts", line: 7 } });
    expect(p.message).toContain("allowShrink: true");
  });
});

describe("out-of-band changes", () => {
  async function setup(w: DuckWarehouse) {
    await w.write("setup", async (tx) => {
      await ensureState(tx);
      await tx.exec(`CREATE TABLE t (id BIGINT, _loaded_at TIMESTAMPTZ)`);
      await tx.exec(`INSERT INTO t VALUES (1, '2026-09-22T10:00:00Z'), (2, '2026-09-22T10:00:00.000001Z')`);
      await tx.exec(`INSERT INTO _croft.assets (name, row_count, max_loaded_at) VALUES ('t', 2, '2026-09-22T10:00:00.000001Z')`);
    }, { runId: "r" });
  }
  const detect = (w: DuckWarehouse) => w.read((db) => detectOutOfBand(db, "t"), { purpose: "t" });

  test("agreeing numbers are not a change; no state is not a change", async () => {
    const w = warehouse();
    expect(await detect(w)).toBeNull();
    await setup(w);
    expect(await detect(w)).toBeNull();
    expect(await w.read((db) => tableStats(db, "t"), { purpose: "t" })).toMatchObject({ exists: true, rowCount: 2, maxLoadedAtUs: 1790071200000001n });
  });

  test("an extra row, a restamped row, a deleted row and a dropped table are all reported", async () => {
    const w = warehouse();
    await setup(w);
    await w.write("x", (tx) => tx.exec(`INSERT INTO t VALUES (3, NULL)`), { runId: "x" });
    expect((await detect(w))?.problem).toMatchObject({
      code: "OUT_OF_BAND_CHANGE", severity: "warning", asset: "t",
      details: { expected: { rowCount: 2, maxLoadedAt: "2026-09-22T10:00:00.000001Z" }, actual: { exists: true, rowCount: 3, maxLoadedAt: "2026-09-22T10:00:00.000001Z" } },
    });
    await w.write("x", (tx) => tx.exec(`DELETE FROM t WHERE id = 3`), { runId: "x" });
    expect(await detect(w)).toBeNull();
    await w.write("x", (tx) => tx.exec(`UPDATE t SET _loaded_at = '2026-09-23T00:00:00Z' WHERE id = 1`), { runId: "x" });
    expect((await detect(w))?.actual).toEqual({ exists: true, rowCount: 2, maxLoadedAt: "2026-09-23T00:00:00.000000Z" });
    await w.write("x", (tx) => tx.exec(`DROP TABLE t`), { runId: "x" });
    const gone = await detect(w);
    expect(gone?.actual).toEqual({ exists: false, rowCount: 0, maxLoadedAt: null });
    expect(gone?.problem.message).toContain("the table no longer exists");
  });

  test("markOutOfBand bumps last_replaced_at and records the real numbers, so it is reported once", async () => {
    const w = warehouse();
    await setup(w);
    await w.write("x", (tx) => tx.exec(`DELETE FROM t WHERE id = 2`), { runId: "x" });
    await w.write("mark", (tx) => markOutOfBand(tx, "t", "2026-09-22T12:00:00.000000Z"), { runId: "m" });
    expect(await detect(w)).toBeNull();
    expect((await w.read((db) => db.all(`SELECT row_count, max_loaded_at, last_replaced_at FROM _croft.assets`), { purpose: "t" }))).toEqual([
      { row_count: 1, max_loaded_at: "2026-09-22T10:00:00.000000Z", last_replaced_at: "2026-09-22T12:00:00.000000Z" },
    ]);
  });

  test("isoMicros is ISO-8601 UTC with microseconds", () => {
    expect(isoMicros(1790071200000001n)).toBe("2026-09-22T10:00:00.000001Z");
    expect(isoMicros(-1n)).toBe("1969-12-31T23:59:59.999999Z");
  });
});

describe("TABLE_MODIFIED_OUTSIDE_CROFT", () => {
  test("diffSchema ignores croft's own columns and compares names case-insensitively", () => {
    const d = diffSchema(
      [{ name: "ID", type: "BIGINT" }, { name: "amount", type: "VARCHAR" }, { name: "extra", type: "DATE" }, { name: "_loaded_at", type: "TIMESTAMPTZ" }],
      [{ name: "id", type: "BIGINT" }, { name: "amount", type: "DOUBLE" }, { name: "gone", type: "JSON" }, { name: "_file", type: "VARCHAR" }],
    );
    expect(d).toEqual({
      added: [{ name: "extra", type: "DATE" }], dropped: [{ name: "gone", type: "JSON" }], retyped: [{ column: "amount", stored: "DOUBLE", real: "VARCHAR" }],
    });
  });

  test("compareSchema: nothing recorded yet, or equal, is no problem; a dropped table is", () => {
    expect(compareSchema("t", [{ name: "a", type: "BIGINT" }], [])).toBeNull();
    expect(compareSchema("t", [{ name: "a", type: "TIMESTAMP WITH TIME ZONE" }], [{ name: "a", type: "TIMESTAMPTZ" }])).toBeNull();
    expect(compareSchema("t", null, [{ name: "a", type: "BIGINT" }])).toMatchObject({ code: "TABLE_MODIFIED_OUTSIDE_CROFT", details: { exists: false } });
  });

  test("reads duckdb_columns() and _croft.columns", async () => {
    const w = warehouse();
    await w.write("setup", async (tx) => {
      await ensureState(tx);
      await tx.exec(`CREATE TABLE t (id BIGINT, amount DOUBLE, _loaded_at TIMESTAMPTZ)`);
      await tx.exec(`INSERT INTO _croft.columns (asset, name, type, kinds, added_at) VALUES ('t', 'id', 'BIGINT', ['integer'], now()), ('t', 'amount', 'DOUBLE', [], now())`);
    }, { runId: "r" });
    expect(await w.read((db) => detectTableModified(db, "t"), { purpose: "t" })).toBeNull();
    expect((await w.read((db) => readStoredColumns(db, "t"), { purpose: "t" })).map((c) => [c.name, c.type, c.kinds])).toEqual([
      ["amount", "DOUBLE", []], ["id", "BIGINT", ["integer"]],
    ]);
    await w.write("x", async (tx) => {
      await tx.exec(`ALTER TABLE t ALTER amount TYPE VARCHAR`);
      await tx.exec(`ALTER TABLE t ADD COLUMN note VARCHAR`);
    }, { runId: "x" });
    const p = await w.read((db) => detectTableModified(db, "t"), { purpose: "t" });
    expect(p).toMatchObject({ code: "TABLE_MODIFIED_OUTSIDE_CROFT", severity: "warning", asset: "t" });
    expect(p?.message).toBe("t's columns were changed outside croft: added note VARCHAR; retyped amount (DOUBLE → VARCHAR)");
  });

  test("no _croft schema yet means nothing to compare", async () => {
    const w = warehouse();
    expect(await w.read((db) => detectTableModified(db, "t"), { purpose: "t" })).toBeNull();
    expect(await w.read((db) => readStoredColumns(db, "t"), { purpose: "t" })).toEqual([]);
    expect(await w.read((db) => tableStats(db, "t"), { purpose: "t" })).toEqual({ exists: false, rowCount: 0, maxLoadedAtUs: null, columns: [] });
  });
});
