import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { CroftError } from "../core/errors.ts";
import { ensureState } from "../db/state.ts";
import { closeAllWarehouses, type DuckWarehouse, openWarehouse } from "../db/warehouse.ts";
import { deleteImpact, deleteTable, deleteWhere, downstreamOf, replacedStamp } from "./delete.ts";
import { detectOutOfBand } from "./guards.ts";
import { listTrash } from "./trash.ts";

const dirs: string[] = [];
afterAll(async () => {
  await closeAllWarehouses();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function warehouse(): { w: DuckWarehouse; state: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-delete-")));
  dirs.push(root);
  const state = join(root, ".croft");
  mkdirSync(join(root, "files"), { recursive: true });
  mkdirSync(state, { recursive: true });
  const w = openWarehouse({ path: join(root, "warehouse.duckdb"), mode: "read_write", timezone: "UTC", root, stateDir: state, isTTY: false, register: false });
  return { w, state };
}

async function readTrash(path: string, sql: string): Promise<Record<string, unknown>[]> {
  const db = await DuckDBInstance.create(path, { access_mode: "READ_ONLY" });
  const c = await db.connect();
  try {
    return (await c.runAndReadAll(sql)).getRowObjectsJS() as Record<string, unknown>[];
  } finally {
    c.disconnectSync();
    db.closeSync();
  }
}

/** orders (5 rows, id 0-4) as croft would leave it, read by daily (SQL) which is read by report; other is unrelated. */
async function seed(w: DuckWarehouse): Promise<void> {
  await w.write("seed", async (tx) => {
    await ensureState(tx);
    await tx.exec(`CREATE TABLE orders AS SELECT range AS id, range * 10 AS amount, TIMESTAMPTZ '2026-09-20 10:00:00+00' + range * INTERVAL 1 HOUR AS _loaded_at FROM range(5)`);
    await tx.exec(`CREATE TABLE daily AS SELECT 1 AS n`);
    await tx.exec(`CREATE TABLE other AS SELECT 1 AS n`);
    await tx.exec(`INSERT INTO _croft.assets (name, kind, write_mode, key_columns, row_count, last_loaded_at, max_loaded_at)
      VALUES ('orders', 'ingest', 'merge', ['id'], 5, '2026-09-20 14:00:00+00', '2026-09-20 14:00:00+00'),
             ('daily', 'sql', 'replace', [], 1, '2026-09-20 15:00:00+00', NULL)`);
    await tx.exec(`INSERT INTO _croft.columns (asset, name, type) VALUES ('orders', 'id', 'BIGINT'), ('orders', 'amount', 'BIGINT'), ('daily', 'n', 'INTEGER')`);
    await tx.exec(`INSERT INTO _croft.writes (asset, loaded_at, run_id, mode) VALUES ('orders', '2026-09-20 14:00:00+00', 'r_0920_0700_aaaa', 'merge')`);
    await tx.exec(`INSERT INTO _croft.inputs (asset, input, seen_loaded_at, input_last_loaded_at) VALUES
      ('daily', 'orders', '2026-09-20 14:00:00+00', '2026-09-25 00:00:00+00'), ('report', 'daily', NULL, NULL), ('report', 'report', NULL, NULL)`);
  }, { runId: "r_seed" });
}

const count = (w: DuckWarehouse, table: string) => w.read(async (db) => Number((await db.all<{ n: number }>(`SELECT count(*)::INT n FROM ${table}`))[0]!.n));

async function expectCode(p: Promise<unknown>, code: string): Promise<CroftError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(CroftError);
    expect((e as CroftError).code as string).toBe(code);
    return e as CroftError;
  }
  throw new Error(`expected ${code}`);
}

describe("deleteImpact", () => {
  test("a whole table: every row; with --where: the rows it matches; downstream from _croft.inputs, transitively", async () => {
    const { w } = warehouse();
    await seed(w);
    expect(await deleteImpact(w, "orders", null)).toEqual({ asset: "orders", rows: 5, rowsBefore: 5, where: null, downstream: ["daily", "report"] });
    expect(await deleteImpact(w, "orders", "amount >= 30")).toEqual({ asset: "orders", rows: 2, rowsBefore: 5, where: "amount >= 30", downstream: ["daily", "report"] });
    expect((await deleteImpact(w, "orders", "  amount > 100 -- none\n")).rows).toBe(0);
    expect(await deleteImpact(w, "other", null)).toEqual({ asset: "other", rows: 1, rowsBefore: 1, where: null, downstream: [] });
    expect(await w.read((db) => downstreamOf(db, "report"))).toEqual([]);
  });

  test("a table that does not exist is UNKNOWN_TABLE, with a guess", async () => {
    const { w } = warehouse();
    await seed(w);
    const e = await expectCode(deleteImpact(w, "order", null), "UNKNOWN_TABLE");
    expect(e.problem.hint).toContain("orders");
    expect(e.problem.fix).toMatchObject({ kind: "command", command: "croft status" });
  });

  test("--where is one SQL condition over the table: anything else is refused before anything runs", async () => {
    const { w } = warehouse();
    await seed(w);
    for (const [where, code, text] of [
      ["", "USAGE_ERROR", "empty"],
      ["amount > 1; DROP TABLE orders", "USAGE_ERROR", ";"],
      ["amount > 1, id < 3", "USAGE_ERROR", "several"],
      ["amount > 1) OR (true", "USAGE_ERROR", "without its"],
      ["id IN (SELECT id FROM read_csv('files/x.csv'))", "USAGE_ERROR", "read_csv"],
      ["id IN (SELECT x FROM '.croft/runs.sqlite')", "USAGE_ERROR", "file"],
      ["id IN (SELECT 1 FROM _croft.assets)", "USAGE_ERROR", "_croft.assets"],
      ["random() < 0.5", "USAGE_ERROR", "random()"],
      ["id = $1", "USAGE_ERROR", "parameter"],
      ["amont > 1", "UNKNOWN_COLUMN", "amont"],
      ["id IN (SELECT id FROM nowhere)", "UNKNOWN_TABLE", "nowhere"],
      ["amount > 'abc'", "USAGE_ERROR", "abc"],
    ] as const) {
      const e = await expectCode(deleteImpact(w, "orders", where), code);
      expect(e.problem.message, where).toContain(text);
      expect(e.problem.hint.length, where).toBeGreaterThan(0);
      expect(e.problem.fix, where).toBeDefined();
    }
    // A condition over the clock is allowed (the count is recomputed at confirmation), and so is a subquery over
    // the project's tables.
    expect((await deleteImpact(w, "orders", "_loaded_at < now() - INTERVAL 1 DAY")).rows).toBe(5);
    expect((await deleteImpact(w, "orders", "id IN (SELECT n FROM other)")).rows).toBe(1);
    expect(await count(w, "orders")).toBe(5);
  });
});

describe("deleteTable", () => {
  test("moves the table and its _croft state to the trash, then drops both; downstream state stays", async () => {
    const { w, state } = warehouse();
    await seed(w);
    const r = await deleteTable(w, "orders", { runId: "r_0922_1140_dddd", now: new Date("2026-09-22T18:40:00Z") });
    expect(r).toMatchObject({ asset: "orders", rows: 5, rowsBefore: 5, rowsAfter: 0, where: null, downstream: ["daily", "report"] });
    expect(r.trashed).toMatchObject({ asset: "orders", rows: 5, kind: "table", reason: "delete (r_0922_1140_dddd)" });
    expect(listTrash(state, "orders")).toHaveLength(1);
    const tables = await w.read((db) => db.all<{ t: string }>(`SELECT table_name t FROM duckdb_tables() WHERE schema_name = 'main' ORDER BY 1`));
    expect(tables.map((t) => t.t)).toEqual(["daily", "other"]);
    const left = await w.read((db) => db.all<{ n: number }>(`SELECT
      (SELECT count(*) FROM _croft.assets WHERE name = 'orders') + (SELECT count(*) FROM _croft.columns WHERE asset = 'orders')
      + (SELECT count(*) FROM _croft.writes WHERE asset = 'orders') AS n`));
    expect(Number(left[0]!.n)).toBe(0);
    // What daily has seen of orders is daily's state, kept: a rebuilt orders makes it stale again.
    expect(await w.read((db) => db.all(`SELECT asset, input FROM _croft.inputs WHERE input = 'orders'`))).toEqual([{ asset: "daily", input: "orders" }]);
    await closeAllWarehouses();
    expect(await readTrash(r.trashed.path, `SELECT count(*)::INT n FROM orders`)).toEqual([{ n: 5 }]);
    expect(await readTrash(r.trashed.path, `SELECT name FROM _croft.assets`)).toEqual([{ name: "orders" }]);
  });

  test("a table that is gone is UNKNOWN_TABLE and nothing goes to the trash", async () => {
    const { w, state } = warehouse();
    await seed(w);
    await expectCode(deleteTable(w, "missing"), "UNKNOWN_TABLE");
    expect(listTrash(state)).toEqual([]);
  });

  test("a table croft has no state for (made outside croft) is deleted all the same", async () => {
    const { w } = warehouse();
    await w.write("seed", (tx) => tx.exec(`CREATE TABLE scratch AS SELECT 1 AS x`), { runId: "r_seed" });
    const r = await deleteTable(w, "scratch", { now: new Date("2026-09-22T18:40:00Z") });
    expect(r.rows).toBe(1);
    expect(await w.read((db) => db.all(`SELECT count(*)::INT n FROM duckdb_tables() WHERE table_name = 'scratch'`))).toEqual([{ n: 0 }]);
  });
});

describe("deleteWhere", () => {
  test("moves the matching rows to the trash, deletes them, keeps the recorded numbers true and bumps last_replaced_at", async () => {
    const { w, state } = warehouse();
    await seed(w);
    const at = new Date("2026-09-22T18:40:00Z");
    const r = await deleteWhere(w, "orders", "amount >= 30", { runId: "r_0922_1140_wwww", now: at });
    expect(r).toMatchObject({ asset: "orders", rows: 2, rowsBefore: 5, rowsAfter: 3, where: "amount >= 30", downstream: ["daily", "report"] });
    expect(r.trashed).toMatchObject({ rows: 2, kind: "rows", where: "amount >= 30", reason: `delete --where "amount >= 30" (r_0922_1140_wwww)` });
    expect(listTrash(state, "orders")[0]!.kind).toBe("rows");
    expect(await w.read((db) => db.all(`SELECT id::INT id FROM orders ORDER BY id`))).toEqual([{ id: 0 }, { id: 1 }, { id: 2 }]);
    const [a] = await w.read((db) => db.all<Record<string, unknown>>(`SELECT row_count::INT n, epoch_us(max_loaded_at)::VARCHAR m,
      epoch_us(last_replaced_at)::VARCHAR r, epoch_us(last_loaded_at)::VARCHAR l FROM _croft.assets WHERE name = 'orders'`));
    expect(a!.n).toBe(3);
    expect(a!.m).toBe(String(BigInt(Date.parse("2026-09-20T12:00:00Z")) * 1000n));
    // last_loaded_at did not move (no row was written); last_replaced_at passed every version daily has seen, although
    // the clock is earlier than that (2026-09-25).
    expect(a!.l).toBe(String(BigInt(Date.parse("2026-09-20T14:00:00Z")) * 1000n));
    expect(a!.r).toBe(String(BigInt(Date.parse("2026-09-25T00:00:00Z")) * 1000n + 1n));
    // The numbers croft recorded agree with the table: no OUT_OF_BAND_CHANGE later.
    expect(await w.read((db) => detectOutOfBand(db, "orders"))).toBeNull();
    await closeAllWarehouses();
    expect(await readTrash(r.trashed.path, `SELECT id::INT id FROM orders ORDER BY id`)).toEqual([{ id: 3 }, { id: 4 }]);
  });

  test("a predicate that matches nothing deletes nothing and trashes nothing", async () => {
    const { w, state } = warehouse();
    await seed(w);
    const e = await expectCode(deleteWhere(w, "orders", "amount > 1000"), "USAGE_ERROR");
    expect(e.problem.message).toContain("matches no rows");
    expect(listTrash(state)).toEqual([]);
    expect(await count(w, "orders")).toBe(5);
  });

  test("an invalid predicate is refused before the trash", async () => {
    const { w, state } = warehouse();
    await seed(w);
    await expectCode(deleteWhere(w, "orders", "amount > 1; DROP TABLE other"), "USAGE_ERROR");
    expect(listTrash(state)).toEqual([]);
    expect(await count(w, "other")).toBe(1);
  });
});

describe("replacedStamp", () => {
  test("the later of now and 1 µs past every version croft recorded of the table or its readers saw", async () => {
    const { w } = warehouse();
    await seed(w);
    const late = new Date("2027-01-01T00:00:00Z");
    expect(await w.read((db) => replacedStamp(db, "orders", late))).toBe(BigInt(late.getTime()) * 1000n);
    expect(await w.read((db) => replacedStamp(db, "orders", new Date("2026-01-01T00:00:00Z")))).toBe(BigInt(Date.parse("2026-09-25T00:00:00Z")) * 1000n + 1n);
    expect(await w.read((db) => replacedStamp(db, "daily", new Date("2026-01-01T00:00:00Z")))).toBe(BigInt(Date.parse("2026-09-20T15:00:00Z")) * 1000n + 1n);
  });
});
