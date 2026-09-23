// ctx.query's snapshot: the DuckDB behaviors it relies on, verified on this DuckDB.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory } from "../db/connect.ts";
import { closeAllWarehouses, type DuckWarehouse, openWarehouse } from "../db/warehouse.ts";
import { OwnTableQuery, SNAPSHOT_FILE, snapshotTable } from "./snapshot.ts";

const dirs: string[] = [];
afterAll(async () => {
  await closeAllWarehouses();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function warehouse(): { w: DuckWarehouse; root: string; state: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-snap-")));
  dirs.push(root);
  const state = join(root, ".croft");
  mkdirSync(join(root, "files"), { recursive: true });
  mkdirSync(state, { recursive: true });
  const w = openWarehouse({ path: join(root, "warehouse.duckdb"), mode: "read_write", timezone: "America/Los_Angeles", root, stateDir: state, isTTY: false, register: false });
  return { w, root, state };
}

async function seed(w: DuckWarehouse, statements: string[]): Promise<void> {
  await w.write("seed", async (tx) => {
    for (const s of statements) await tx.exec(s);
  }, { runId: "r_test" });
}

const HUGE = "170141183460469231731687303715884105727";

describe("DuckDB behaviors the snapshot relies on [V]", () => {
  test("Parquet stores HUGEINT as DOUBLE (lossy), so the snapshot carries it as text", async () => {
    const { w, state } = warehouse();
    await seed(w, [`CREATE TABLE t (h HUGEINT)`, `INSERT INTO t VALUES (${HUGE})`]);
    const raw = join(state, "raw.parquet");
    await w.read((db) => db.exec(`COPY (SELECT h FROM t) TO '${raw}' (FORMAT parquet)`));
    const m = await openMemory({ timezone: "UTC", stateDir: state });
    try {
      const c = await m.connect();
      const row = (await c.runAndReadAll(`SELECT typeof(h) AS t, h::VARCHAR AS v FROM read_parquet('${raw}')`)).getRowObjectsJS()[0]!;
      expect(row.t).toBe("DOUBLE");
      expect(row.v).not.toBe(HUGE);
    } finally {
      m.close();
    }
  });

  test("COPY TO works inside the state folder on a sandboxed warehouse connection, and nowhere else", async () => {
    const { w, root, state } = warehouse();
    await seed(w, [`CREATE TABLE t AS SELECT 1 AS x`]);
    const snap = await snapshotTable(w, "t", join(state, "staging", "r1", "t"));
    expect(snap.path).toBe(join(state, "staging", "r1", "t", SNAPSHOT_FILE));
    expect(existsSync(snap.path!)).toBe(true);
    await expect(w.read((db) => db.exec(`COPY (SELECT 1) TO '${join(root, "out.parquet")}' (FORMAT parquet)`))).rejects.toThrow(/Permission Error/);
    expect(existsSync(join(root, "out.parquet"))).toBe(false);
  });

  test("a table that does not exist yet has no snapshot", async () => {
    const { w, state } = warehouse();
    expect(await snapshotTable(w, "nothing", join(state, "staging", "r1", "nothing"))).toEqual({ path: null, columns: [] });
  });
});

describe("OwnTableQuery", () => {
  test("round-trips HUGEINT, TIMESTAMPTZ, JSON and DECIMAL; params bind; rows come back in ts form", async () => {
    const { w, state } = warehouse();
    await seed(w, [
      `CREATE TABLE own (id BIGINT, h HUGEINT, ts TIMESTAMPTZ, j JSON, d DECIMAL(18,3), _loaded_at TIMESTAMPTZ)`,
      `INSERT INTO own VALUES (1, ${HUGE}, '2024-01-01 00:00:00.123456+00', '{"a":1}', 12.345, now()), (2, -5, NULL, '[1]', 0.5, now())`,
    ]);
    const q = new OwnTableQuery({ warehouse: w, asset: "own", dir: join(state, "staging", "r1", "own"), stateDir: state, timezone: "America/Los_Angeles" });
    try {
      const rows = await q.query<{ id: number; h: bigint; ts: string | null; j: unknown; d: string }>("select id, h, ts, j, d from own where id >= $1 order by id", 1);
      expect(rows[0]).toEqual({ id: 1, h: BigInt(HUGE), ts: "2024-01-01T00:00:00.123456Z", j: { a: 1 }, d: "12.345" }); // DECIMAL wider than 15 digits is exact text in ts form
      expect(rows[1]).toMatchObject({ id: 2, h: -5n, ts: null, j: [1] });
      expect(await q.query("select typeof(h) t from own limit 1")).toEqual([{ t: "HUGEINT" }]);
    } finally {
      q.close();
    }
  });

  test("the snapshot is taken once: writes after it are not seen", async () => {
    const { w, state } = warehouse();
    await seed(w, [`CREATE TABLE own AS SELECT 1 AS id`]);
    const q = new OwnTableQuery({ warehouse: w, asset: "own", dir: join(state, "staging", "r2", "own"), stateDir: state, timezone: "UTC" });
    try {
      expect(await q.query("select count(*)::INT n from own")).toEqual([{ n: 1 }]);
      await seed(w, [`INSERT INTO own VALUES (2)`]);
      expect(await q.query("select count(*)::INT n from own")).toEqual([{ n: 1 }]);
    } finally {
      q.close();
    }
    await expect(q.query("select 1")).rejects.toMatchObject({ code: "QUERY_FAILED" });
  });

  test("the gate: one SELECT, no files, not even the snapshot itself", async () => {
    const { w, state } = warehouse();
    await seed(w, [`CREATE TABLE own AS SELECT 1 AS id`]);
    const dir = join(state, "staging", "r3", "own");
    const q = new OwnTableQuery({ warehouse: w, asset: "own", dir, stateDir: state, timezone: "UTC" });
    try {
      await expect(q.query("insert into own values (2)")).rejects.toMatchObject({ code: "QUERY_NOT_SELECT" });
      await expect(q.query("select 1; select 2")).rejects.toMatchObject({ code: "SQL_NOT_ONE_STATEMENT" });
      await expect(q.query(`select * from read_parquet('${join(dir, SNAPSHOT_FILE)}')`)).rejects.toMatchObject({ code: "QUERY_PATH_DENIED" });
      await expect(q.query(`select * from '${join(state, "runs.sqlite")}'`)).rejects.toMatchObject({ code: "QUERY_PATH_DENIED" });
      await expect(q.query("select nope from own")).rejects.toMatchObject({ code: "QUERY_FAILED" });
      await expect(q.query("select * from other_asset")).rejects.toMatchObject({ code: "QUERY_FAILED" });
    } finally {
      q.close();
    }
  });

  test("on the first run the table does not exist: QUERY_FAILED says so", async () => {
    const { w, state } = warehouse();
    const q = new OwnTableQuery({ warehouse: w, asset: "fresh", dir: join(state, "staging", "r4", "fresh"), stateDir: state, timezone: "UTC" });
    try {
      await expect(q.query("select * from fresh")).rejects.toMatchObject({ code: "QUERY_FAILED", message: expect.stringContaining("has no table yet") });
      expect(await q.query("select 42 as x")).toEqual([{ x: 42 }]);
    } finally {
      q.close();
    }
  });
});
