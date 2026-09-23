import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { ensureState } from "../db/state.ts";
import { closeAllWarehouses, type DuckWarehouse, openWarehouse } from "../db/warehouse.ts";
import { listTrash, plannedTrashPath, trashStamp, trashTable } from "./trash.ts";

const dirs: string[] = [];
afterAll(async () => {
  await closeAllWarehouses();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function warehouse(): { w: DuckWarehouse; root: string; state: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-trash-")));
  dirs.push(root);
  const state = join(root, ".croft");
  mkdirSync(join(root, "files"), { recursive: true });
  mkdirSync(state, { recursive: true });
  const w = openWarehouse({ path: join(root, "warehouse.duckdb"), mode: "read_write", timezone: "UTC", root, stateDir: state, isTTY: false, register: false });
  return { w, root, state };
}

/** Open a trash file (never the warehouse) with its own instance. */
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

describe("trashTable", () => {
  test("copies the table exactly (HUGEINT, JSON, TIMESTAMPTZ, DECIMAL) plus its _croft rows, through ATTACH on the sandboxed connection", async () => {
    const { w, state } = warehouse();
    await w.write("seed", async (tx) => {
      await ensureState(tx);
      await tx.exec(`CREATE TABLE zones (h HUGEINT, j JSON, t TIMESTAMPTZ, d DECIMAL(18,3), _loaded_at TIMESTAMPTZ)`);
      await tx.exec(`INSERT INTO zones VALUES (170141183460469231731687303715884105727, '{"a":[1,2]}', '2024-01-01 00:00:00.123456+00', 12.345, now()), (1, NULL, NULL, 0.001, now())`);
      await tx.exec(`INSERT INTO _croft.assets (name, kind, write_mode, row_count) VALUES ('zones', 'ingest', 'replace', 2), ('other', 'ingest', 'replace', 9)`);
      await tx.exec(`INSERT INTO _croft.columns (asset, name, type) VALUES ('zones', 'h', 'HUGEINT'), ('other', 'x', 'BIGINT')`);
    }, { runId: "r_seed" });
    const at = new Date("2026-09-22T18:40:00.123Z");
    const e = (await trashTable(w, "zones", "run --allow-shrink (r_0922_1140_a1b2)", { runId: "r_0922_1140_a1b2", now: at }))!;
    expect(e).toMatchObject({ asset: "zones", rows: 2, runId: "r_0922_1140_a1b2", trashedAt: "2026-09-22T18:40:00.123Z" });
    expect(e.path).toBe(join(state, "trash", "zones", "20260922T184000.123Z.duckdb"));
    expect(e.bytes).toBeGreaterThan(0);
    await closeAllWarehouses();

    expect(await readTrash(e.path, `SELECT h::VARCHAR h, typeof(h) th, j::VARCHAR j, typeof(j) tj, epoch_us(t) t, d::VARCHAR d, typeof(d) td FROM zones ORDER BY h DESC`)).toEqual([
      { h: "170141183460469231731687303715884105727", th: "HUGEINT", j: `{"a":[1,2]}`, tj: "JSON", t: 1704067200123456n, d: "12.345", td: "DECIMAL(18,3)" },
      { h: "1", th: "HUGEINT", j: null, tj: "JSON", t: null, d: "0.001", td: "DECIMAL(18,3)" },
    ]);
    expect(await readTrash(e.path, `SELECT name, row_count::INT n FROM _croft.assets`)).toEqual([{ name: "zones", n: 2 }]);
    expect(await readTrash(e.path, `SELECT asset, name FROM _croft.columns`)).toEqual([{ asset: "zones", name: "h" }]);
    expect(await readTrash(e.path, `SELECT asset, reason, run_id FROM _croft.trash`)).toEqual([{ asset: "zones", reason: "run --allow-shrink (r_0922_1140_a1b2)", run_id: "r_0922_1140_a1b2" }]);
    // The warehouse is unchanged: trashing only copies.
    const again = openWarehouse({ path: join(state, "..", "warehouse.duckdb"), mode: "read_write", timezone: "UTC", root: join(state, ".."), stateDir: state, isTTY: false, register: false });
    expect(await again.read((db) => db.all(`SELECT count(*)::INT n FROM zones`))).toEqual([{ n: 2 }]);
    expect(await again.read((db) => db.all(`SELECT count(*)::INT n FROM duckdb_databases() WHERE database_name LIKE 'croft_trash%'`))).toEqual([{ n: 0 }]);
  });

  test("a table that does not exist has nothing to trash", async () => {
    const { w } = warehouse();
    expect(await trashTable(w, "missing", "test")).toBeNull();
  });

  test("two trashings in the same millisecond get two files; listTrash is newest first and survives a missing sidecar", async () => {
    const { w, state } = warehouse();
    await w.write("seed", async (tx) => {
      await tx.exec(`CREATE TABLE a AS SELECT range AS x FROM range(3)`);
      await tx.exec(`CREATE TABLE b AS SELECT 1 AS y`);
    }, { runId: "r_seed" });
    const at = new Date("2026-01-01T00:00:00Z");
    const one = (await trashTable(w, "a", "first", { now: at }))!;
    const two = (await trashTable(w, "a", "second", { now: at }))!;
    expect(two.path).not.toBe(one.path);
    const other = (await trashTable(w, "b", "delete", { now: new Date("2026-02-01T00:00:00Z") }))!;
    const all = listTrash(state);
    expect(all.map((e) => e.asset)).toEqual(["b", "a", "a"]);
    expect(all[0]).toMatchObject({ asset: "b", rows: 1, reason: "delete", path: other.path });
    expect(listTrash(state, "a").map((e) => e.reason).sort()).toEqual(["first", "second"]);
    rmSync(one.path.replace(/\.duckdb$/, ".json"));
    writeFileSync(join(state, "trash", "a", "stray.txt"), "x");
    const a = listTrash(state, "a");
    expect(a).toHaveLength(2);
    expect(a.find((e) => e.path === one.path)).toMatchObject({ reason: "unknown", trashedAt: "2026-01-01T00:00:00.000Z" });
    expect(listTrash(join(state, "nowhere"))).toEqual([]);
  });

  test("stamps and planned paths", () => {
    expect(trashStamp(new Date("2026-09-22T18:40:00.123Z"))).toBe("20260922T184000.123Z");
    expect(plannedTrashPath("/s", "zones", new Date("2026-09-22T18:40:00Z"))).toBe("/s/trash/zones/20260922T184000.000Z.duckdb");
  });
});
