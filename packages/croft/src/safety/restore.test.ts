import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { ensureState } from "../db/state.ts";
import { closeAllWarehouses, type DuckWarehouse, openWarehouse } from "../db/warehouse.ts";
import { deleteTable, deleteWhere } from "./delete.ts";
import { detectOutOfBand } from "./guards.ts";
import { listVersions, restoreImpact, restoreVersion } from "./restore.ts";
import { listTrash, type TrashEntry, trashStamp, trashTable } from "./trash.ts";

const dirs: string[] = [];
afterAll(async () => {
  await closeAllWarehouses();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function warehouse(): { w: DuckWarehouse; state: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-restore-")));
  dirs.push(root);
  const state = join(root, ".croft");
  mkdirSync(join(root, "files"), { recursive: true });
  mkdirSync(state, { recursive: true });
  const w = openWarehouse({ path: join(root, "warehouse.duckdb"), mode: "read_write", timezone: "UTC", root, stateDir: state, isTTY: false, register: false });
  return { w, state };
}

/** orders: 5 rows (id 0-4, a HUGEINT and a JSON column), merge by id, cursor 4; read by daily. */
async function seed(w: DuckWarehouse): Promise<void> {
  await w.write("seed", async (tx) => {
    await ensureState(tx);
    await tx.exec(`CREATE TABLE orders AS SELECT range AS id, range * 10 AS amount, (range * 170141183460469231731687303715884105)::HUGEINT AS h,
      ('{"n":' || range || '}')::JSON AS j, TIMESTAMPTZ '2026-09-20 10:00:00+00' + range * INTERVAL 1 HOUR AS _loaded_at FROM range(5)`);
    await tx.exec(`CREATE TABLE daily AS SELECT 1 AS n`);
    await tx.exec(`INSERT INTO _croft.assets (name, kind, write_mode, key_columns, cursor_value, row_count, last_loaded_at, max_loaded_at)
      VALUES ('orders', 'ingest', 'merge', ['id'], '4', 5, '2026-09-20 14:00:00+00', '2026-09-20 14:00:00+00')`);
    await tx.exec(`INSERT INTO _croft.columns (asset, name, type) VALUES ('orders', 'id', 'BIGINT'), ('orders', 'amount', 'BIGINT')`);
    await tx.exec(`INSERT INTO _croft.writes (asset, loaded_at, run_id, mode) VALUES ('orders', '2026-09-20 14:00:00+00', 'r_0920_0700_aaaa', 'merge')`);
    await tx.exec(`INSERT INTO _croft.inputs (asset, input, seen_loaded_at, input_last_loaded_at) VALUES ('daily', 'orders', '2026-09-20 14:00:00+00', '2026-09-20 14:00:00+00')`);
  }, { runId: "r_seed" });
}

/** What croft records of orders, and the table itself. */
async function orders(w: DuckWarehouse): Promise<{ rows: Record<string, unknown>[]; asset: Record<string, unknown> | undefined; columns: string[]; writes: number }> {
  return w.read(async (db) => ({
    rows: await db.all(`SELECT id::INT id, h::VARCHAR h, typeof(h) th, j::VARCHAR j, typeof(j) tj FROM orders ORDER BY id`),
    asset: (await db.all(`SELECT cursor_value, row_count::INT n, epoch_us(last_replaced_at)::VARCHAR r FROM _croft.assets WHERE name = 'orders'`))[0],
    columns: (await db.all<{ c: string }>(`SELECT column_name c FROM duckdb_columns() WHERE table_name = 'orders' AND schema_name = 'main' ORDER BY column_index`)).map((r) => r.c),
    writes: Number((await db.all<{ n: number }>(`SELECT count(*)::INT n FROM _croft.writes WHERE asset = 'orders'`))[0]!.n),
  }));
}

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

const T1 = new Date("2026-09-21T10:00:00Z");
const T2 = new Date("2026-09-22T10:00:00Z");

describe("restoreVersion: a whole-table version", () => {
  test("the current table goes to the trash first; then the table and its _croft rows come back exactly, and downstream goes stale", async () => {
    const { w, state } = warehouse();
    await seed(w);
    const before = await orders(w);
    const v1 = (await trashTable(w, "orders", "run --allow-shrink (r_0921_1000_aaaa)", { now: T1 }))!;
    // The table then changes: a shrink, a new column, another cursor and another write.
    await w.write("shrink", async (tx) => {
      await tx.exec(`ALTER TABLE orders ADD COLUMN extra VARCHAR`);
      await tx.exec(`DELETE FROM orders WHERE id >= 2`);
      await tx.exec(`UPDATE _croft.assets SET cursor_value = '9', row_count = 2, last_loaded_at = '2026-09-21 12:00:00+00' WHERE name = 'orders'`);
      await tx.exec(`INSERT INTO _croft.writes (asset, loaded_at, run_id, mode) VALUES ('orders', '2026-09-21 12:00:00+00', 'r_0921_1200_bbbb', 'replace')`);
      await tx.exec(`UPDATE _croft.inputs SET input_last_loaded_at = '2026-09-21 12:00:00+00' WHERE asset = 'daily'`);
    }, { runId: "r_shrink" });

    expect(await restoreImpact(w, v1)).toMatchObject({ asset: "orders", kind: "table", rows: 5, skipped: 0, currentRows: 2, downstream: ["daily"] });
    const r = await restoreVersion(w, v1, { runId: "r_0922_1000_rrrr", now: T2 });
    expect(r).toMatchObject({ asset: "orders", kind: "table", rows: 5, skipped: 0, rowsAfter: 5, downstream: ["daily"] });
    expect(r.restored.path).toBe(v1.path);
    expect(r.trashed).toMatchObject({ asset: "orders", rows: 2, kind: "table", reason: "replaced by restore (r_0922_1000_rrrr)" });
    expect(listTrash(state, "orders")).toHaveLength(2);

    const after = await orders(w);
    expect(after.rows).toEqual(before.rows);
    expect(after.columns).toEqual(["id", "amount", "h", "j", "_loaded_at"]);
    expect(after.writes).toBe(1);
    expect(after.asset).toMatchObject({ cursor_value: "4", n: 5, r: String(BigInt(T2.getTime()) * 1000n) });
    expect(await w.read((db) => detectOutOfBand(db, "orders"))).toBeNull();
  });

  test("with the table gone (deleted), it comes back with its state and nothing else goes to the trash", async () => {
    const { w, state } = warehouse();
    await seed(w);
    const before = await orders(w);
    const del = await deleteTable(w, "orders", { now: T1 });
    expect(await restoreImpact(w, del.trashed)).toMatchObject({ kind: "table", rows: 5, currentRows: null });
    const r = await restoreVersion(w, del.trashed, { now: T2 });
    expect(r.trashed).toBeNull();
    expect(r.rows).toBe(5);
    expect(listTrash(state, "orders")).toHaveLength(1);
    const after = await orders(w);
    expect(after.rows).toEqual(before.rows);
    expect(after.asset).toMatchObject({ cursor_value: "4", n: 5 });
  });

  test("the retention pass of its own trash never prunes the version it is restoring", async () => {
    const { w, state } = warehouse();
    await seed(w);
    const old = (await trashTable(w, "orders", "old", { now: new Date("2026-05-01T00:00:00Z") }))!;
    // Five newer versions, all older than 30 days by T2: the restore's own trash would push `old` out.
    for (const d of ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"]) {
      const at = new Date(`${d}T00:00:00Z`);
      const path = join(state, "trash", "orders", `${trashStamp(at)}.duckdb`);
      writeFileSync(path, "not a database: never read");
      writeFileSync(path.replace(/\.duckdb$/, ".json"), JSON.stringify({ asset: "orders", trashedAt: at.toISOString(), reason: "x", rows: 0 }));
    }
    const r = await restoreVersion(w, old, { now: T2 });
    expect(r.rows).toBe(5);
    expect(existsSync(old.path)).toBe(true);
    expect(listTrash(state, "orders").map((e) => e.trashedAt.slice(0, 10))).toEqual(["2026-09-22", "2026-06-05", "2026-06-04", "2026-06-03", "2026-06-02", "2026-05-01"]);
  });

  test("a version whose file is gone is refused, and nothing changes", async () => {
    const { w, state } = warehouse();
    await seed(w);
    const v = (await trashTable(w, "orders", "x", { now: T1 }))!;
    rmSync(v.path);
    const e = await expectCode(restoreVersion(w, v, { now: T2 }), "USAGE_ERROR");
    expect(e.problem.message).toContain("no longer");
    expect(listTrash(state, "orders")).toEqual([]);
    expect((await orders(w)).rows).toHaveLength(5);
  });
});

describe("restoreVersion: the rows of a delete --where", () => {
  test("puts the rows back into the table as it is now; rows whose key is back already are skipped", async () => {
    const { w, state } = warehouse();
    await seed(w);
    const del = await deleteWhere(w, "orders", "amount >= 30", { now: T1 });
    expect(del.trashed.kind).toBe("rows");
    // id 3 came back meanwhile (a refetch).
    await w.write("refetch", (tx) => tx.exec(`INSERT INTO orders VALUES (3, 30, 3, '{"n":3}', '2026-09-21 12:00:00+00')`), { runId: "r_x" });
    expect(await restoreImpact(w, del.trashed)).toMatchObject({ kind: "rows", rows: 1, skipped: 1, currentRows: 4 });
    const r = await restoreVersion(w, del.trashed, { runId: "r_0922_1000_rrrr", now: T2 });
    expect(r).toMatchObject({ kind: "rows", rows: 1, skipped: 1, rowsAfter: 5 });
    // The table it added to went to the trash first.
    expect(r.trashed).toMatchObject({ rows: 4, kind: "table" });
    expect(listTrash(state, "orders")).toHaveLength(2);
    const after = await orders(w);
    expect(after.rows.map((x) => x.id)).toEqual([0, 1, 2, 3, 4]);
    expect(after.asset).toMatchObject({ cursor_value: "4", n: 5 });
  });

  test("with the table gone, the rows cannot go back: restore the whole table first", async () => {
    const { w } = warehouse();
    await seed(w);
    const rows = await deleteWhere(w, "orders", "amount >= 30", { now: T1 });
    await deleteTable(w, "orders", { now: T2 });
    const e = await expectCode(restoreVersion(w, rows.trashed, { now: T2 }), "USAGE_ERROR");
    expect(e.problem.message).toContain("does not exist");
    expect(e.problem.hint).toContain("croft restore orders");
  });
});

describe("restoreVersion: a rows version whose delete never happened (R41-10)", () => {
  /** A keyless append table of 10 events; n < 3 goes to the trash as a delete --where would, but is not deleted. */
  async function stopped(): Promise<{ w: DuckWarehouse; state: string; v: TrashEntry }> {
    const { w, state } = warehouse();
    await w.write("seed", async (tx) => {
      await ensureState(tx);
      await tx.exec(`CREATE TABLE events AS SELECT range AS n, 'e' || range AS v FROM range(10)`);
      await tx.exec(`INSERT INTO _croft.assets (name, kind, write_mode, key_columns, row_count) VALUES ('events', 'ingest', 'append', [], 10)`);
    }, { runId: "r_seed" });
    const v = (await trashTable(w, "events", `delete --where "n < 3" (r_0921_1000_dddd)`, { now: T1, where: "n < 3", pending: true }))!;
    return { w, state, v: listTrash(state, "events").find((e) => e.path === v.path)! };
  }
  const count = (w: DuckWarehouse) => w.read(async (db) => (await db.all<{ n: number; d: number }>(`SELECT count(*)::INT n, count(DISTINCT n)::INT d FROM events`))[0]);

  test("it is listed as not applied; with every row still in the table it is refused and nothing changes", async () => {
    const { w, state, v } = await stopped();
    expect(v).toMatchObject({ kind: "rows", rows: 3, applied: false });
    const e = await expectCode(restoreImpact(w, v), "USAGE_ERROR");
    expect(e.problem.message).toContain("did not finish");
    expect(e.problem.message).toContain("all 3 are still in the table");
    await expectCode(restoreVersion(w, v, { now: T2 }), "USAGE_ERROR");
    expect(await count(w)).toEqual({ n: 10, d: 10 });
    expect(listTrash(state, "events")).toHaveLength(1);
  });

  test("with some of its rows gone since, only the missing ones go back (a keyless table gets no second copy)", async () => {
    const { w, v } = await stopped();
    await w.write("gone", (tx) => tx.exec(`DELETE FROM events WHERE n = 1`), { runId: "r_x" });
    expect(await restoreImpact(w, v)).toMatchObject({ kind: "rows", rows: 1, skipped: 2 });
    const r = await restoreVersion(w, v, { now: T2 });
    expect(r).toMatchObject({ rows: 1, skipped: 2, rowsAfter: 10 });
    expect(await count(w)).toEqual({ n: 10, d: 10 });
  });

  test("a version with no sidecar (a crash right after the trash commit) is treated the same way", async () => {
    const { w, state, v } = await stopped();
    rmSync(v.path.replace(/\.duckdb$/, ".json"));
    const [bare] = listTrash(state, "events");
    expect(bare).toMatchObject({ kind: "table", applied: false });
    const e = await expectCode(restoreImpact(w, bare!), "USAGE_ERROR");
    expect(e.problem.message).toContain("did not finish");
  });

  test("a delete that finished restores as before, and its rows are not compared with the table", async () => {
    const { w } = warehouse();
    await w.write("seed", async (tx) => {
      await ensureState(tx);
      await tx.exec(`CREATE TABLE events AS SELECT * FROM (VALUES (1, 'a'), (1, 'a'), (2, 'b')) v(n, v)`);
    }, { runId: "r_seed" });
    const del = await deleteWhere(w, "events", "n = 1", { now: T1 });
    // Another copy of a deleted row arrives (an append): the version still puts both of its copies back.
    await w.write("append", (tx) => tx.exec(`INSERT INTO events VALUES (1, 'a')`), { runId: "r_x" });
    expect(await restoreImpact(w, del.trashed)).toMatchObject({ rows: 2, skipped: 0 });
  });
});

describe("restoreVersion: changes made outside croft", () => {
  test("are reported (OUT_OF_BAND_CHANGE) before the restore takes the table's numbers", async () => {
    const { w } = warehouse();
    await seed(w);
    const del = await deleteWhere(w, "orders", "amount >= 30", { now: T1 });
    await w.write("outside", (tx) => tx.exec(`DELETE FROM orders WHERE id = 0`), { runId: "r_x" });
    const r = await restoreVersion(w, del.trashed, { now: T2 });
    expect(r.problems.map((p) => p.code)).toEqual(["OUT_OF_BAND_CHANGE"]);
    expect(r.problems[0]!.message).toContain("1 row removed (3 → 2)");
  });
});

describe("listVersions", () => {
  test("the trash, newest first, for one asset or all", async () => {
    const { w, state } = warehouse();
    await seed(w);
    await trashTable(w, "orders", "a", { now: T1 });
    await trashTable(w, "daily", "b", { now: T2 });
    expect(listVersions(state).map((v) => [v.asset, v.reason])).toEqual([["daily", "b"], ["orders", "a"]]);
    expect(listVersions(state, "orders").map((v) => v.reason)).toEqual(["a"]);
    expect(listVersions(state, "nothing")).toEqual([]);
  });
});
