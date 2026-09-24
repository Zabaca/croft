import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { ensureState } from "../db/state.ts";
import { closeAllWarehouses, type DuckWarehouse, openWarehouse } from "../db/warehouse.ts";
import { listTrash, plannedTrashPath, pruneTrash, TRASH_RETENTION, trashStamp, trashTable } from "./trash.ts";

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

  test("with where, only the matching rows go to the trash (kind rows), with the asset's _croft rows", async () => {
    const { w } = warehouse();
    await w.write("seed", async (tx) => {
      await ensureState(tx);
      await tx.exec(`CREATE TABLE orders AS SELECT range AS id, range * 10 AS amount FROM range(5)`);
      await tx.exec(`INSERT INTO _croft.assets (name, kind, row_count) VALUES ('orders', 'ingest', 5)`);
    }, { runId: "r_seed" });
    const e = (await trashTable(w, "orders", "delete --where (r_0922_1140_a1b2)", { where: "amount >= 30", now: new Date("2026-09-22T18:40:00Z") }))!;
    expect(e).toMatchObject({ asset: "orders", rows: 2, kind: "rows", where: "amount >= 30" });
    expect(listTrash(join(e.path, "..", "..", ".."), "orders")[0]).toMatchObject({ kind: "rows", where: "amount >= 30", rows: 2 });
    await closeAllWarehouses();
    expect(await readTrash(e.path, `SELECT id::INT id FROM orders ORDER BY id`)).toEqual([{ id: 3 }, { id: 4 }]);
    expect(await readTrash(e.path, `SELECT kind, where_sql FROM _croft.trash`)).toEqual([{ kind: "rows", where_sql: "amount >= 30" }]);
    expect(await readTrash(e.path, `SELECT name, row_count::INT n FROM _croft.assets`)).toEqual([{ name: "orders", n: 5 }]);
  });

  test("a whole table is kind table; a sidecar from before kinds reads as table", async () => {
    const { w, state } = warehouse();
    await w.write("seed", async (tx) => tx.exec(`CREATE TABLE a AS SELECT 1 AS x`), { runId: "r_seed" });
    const e = (await trashTable(w, "a", "first", { now: new Date("2026-01-01T00:00:00Z") }))!;
    expect(e.kind).toBe("table");
    expect(e.where).toBeNull();
    const sidecar = e.path.replace(/\.duckdb$/, ".json");
    const old = JSON.parse(readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    delete old.kind;
    delete old.where;
    writeFileSync(sidecar, JSON.stringify(old));
    expect(listTrash(state, "a")[0]).toMatchObject({ kind: "table", where: null });
  });
});

/** A trashed version on disk without DuckDB: an empty .duckdb file and its sidecar. */
function fakeVersion(state: string, asset: string, at: string, o: { sidecar?: boolean; wal?: boolean } = {}): string {
  const dir = join(state, "trash", asset);
  mkdirSync(dir, { recursive: true });
  const stamp = trashStamp(new Date(at));
  const path = join(dir, `${stamp}.duckdb`);
  writeFileSync(path, "x");
  if (o.wal) writeFileSync(`${path}.wal`, "w");
  if (o.sidecar !== false) {
    writeFileSync(join(dir, `${stamp}.json`), JSON.stringify({ asset, path, trashedAt: new Date(at).toISOString(), reason: "test", runId: null, rows: 1, bytes: 1 }));
  }
  return path;
}

function tempState(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-retention-")));
  dirs.push(root);
  return join(root, ".croft");
}

describe("retention: 30 days or 5 versions per asset", () => {
  const NOW = new Date("2026-09-22T12:00:00Z");
  const daysAgo = (d: number, h = 0) => new Date(NOW.getTime() - d * 86_400_000 - h * 3_600_000).toISOString();

  test("keeps every version from the last 30 days, and the 5 newest of each asset however old", () => {
    const state = tempState();
    // 8 versions of a: 3 recent, 5 old. The 5 newest are the 3 recent plus the 2 newest old ones.
    const recent = [1, 2, 29].map((d) => fakeVersion(state, "a", daysAgo(d)));
    const old = [31, 40, 50, 60, 70].map((d) => fakeVersion(state, "a", daysAgo(d), { wal: d === 60 }));
    // b has 2 old versions only: both stay (among its 5 newest).
    const b = [100, 200].map((d) => fakeVersion(state, "b", daysAgo(d)));
    const pruned = pruneTrash(state, { now: NOW });
    expect(pruned.map((e) => e.path).sort()).toEqual([old[2]!, old[3]!, old[4]!].sort());
    for (const p of [...recent, old[0]!, old[1]!, ...b]) expect(existsSync(p)).toBe(true);
    for (const p of [old[2]!, old[3]!, old[4]!]) {
      expect(existsSync(p)).toBe(false);
      expect(existsSync(p.replace(/\.duckdb$/, ".json"))).toBe(false);
      expect(existsSync(`${p}.wal`)).toBe(false);
    }
    expect(listTrash(state, "a")).toHaveLength(5);
    expect(listTrash(state, "b")).toHaveLength(2);
  });

  test("one asset only, and never what `keep` names", () => {
    const state = tempState();
    const a = [40, 50, 60, 70, 80, 90].map((d) => fakeVersion(state, "a", daysAgo(d)));
    const b = [40, 50, 60, 70, 80, 90].map((d) => fakeVersion(state, "b", daysAgo(d)));
    expect(pruneTrash(state, { asset: "a", now: NOW, keep: [a[5]!] })).toEqual([]);
    expect(pruneTrash(state, { asset: "a", now: NOW }).map((e) => e.path)).toEqual([a[5]!]);
    expect(listTrash(state, "b")).toHaveLength(6);
    expect(pruneTrash(state, { now: NOW }).map((e) => e.path)).toEqual([b[5]!]);
  });

  test("the boundary is exactly 30 days; a version without a sidecar is aged by its file name", () => {
    const state = tempState();
    const edge = [30, 30, 30, 30, 30].map((d, i) => fakeVersion(state, "a", daysAgo(d, -i - 1)));
    const at30 = fakeVersion(state, "a", daysAgo(30));
    const past = fakeVersion(state, "a", daysAgo(30, 1), { sidecar: false });
    expect(pruneTrash(state, { now: NOW }).map((e) => e.path)).toEqual([past]);
    for (const p of [...edge, at30]) expect(existsSync(p)).toBe(true);
  });

  test("an empty or missing trash prunes nothing", () => {
    expect(pruneTrash(join(tempState(), "nowhere"), { now: NOW })).toEqual([]);
    const state = tempState();
    for (const d of [40, 50, 60, 70, 80, 90]) fakeVersion(state, "a", daysAgo(d));
    rmSync(join(state, "trash", "a"), { recursive: true });
    mkdirSync(join(state, "trash", "a"));
    expect(pruneTrash(state, { now: NOW })).toEqual([]);
    expect(TRASH_RETENTION).toEqual({ days: 30, versions: 5 });
  });

  test("trashTable prunes the asset's expired versions at trash time and keeps the one it wrote", async () => {
    const { w, state } = warehouse();
    await w.write("seed", async (tx) => tx.exec(`CREATE TABLE a AS SELECT 1 AS x`), { runId: "r_seed" });
    const old = [40, 50, 60, 70, 80].map((d) => fakeVersion(state, "a", daysAgo(d)));
    const other = [40, 50, 60, 70, 80, 90].map((d) => fakeVersion(state, "other", daysAgo(d)));
    const e = (await trashTable(w, "a", "delete", { now: NOW }))!;
    expect(existsSync(e.path)).toBe(true);
    expect(existsSync(old[4]!)).toBe(false);
    expect(listTrash(state, "a")).toHaveLength(5);
    // Only the trashed asset is pruned here; doctor prunes the rest.
    for (const p of other) expect(existsSync(p)).toBe(true);
  });
});
