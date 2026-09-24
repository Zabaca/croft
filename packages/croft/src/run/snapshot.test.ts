// Snapshots for ingests' ctx.query and TS transforms' inputs: the DuckDB behaviors they rely on, verified on this
// DuckDB.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory } from "../db/connect.ts";
import { ensureState } from "../db/state.ts";
import { renderValueRows, resultShape } from "../db/values.ts";
import { closeAllWarehouses, type DuckWarehouse, openWarehouse } from "../db/warehouse.ts";
import {
  afterPosition, countAfter, INPUT_FILES, OwnTableQuery, readInputFacts, SNAPSHOT_FILE, snapshotColumnsSql, snapshotInput, snapshotTable,
} from "./snapshot.ts";

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

describe("TS transform input snapshots (§3e)", () => {
  const S1 = "2026-03-01T10:00:00.000001Z";
  const S2 = "2026-03-01T10:00:00.000002Z";

  /** A keyed input the way croft leaves one: rows with stamps, and its _croft.assets record. */
  async function input(w: DuckWarehouse, key: string[] | null = ["id"]): Promise<void> {
    await w.write("seed", async (tx) => {
      await ensureState(tx);
      await tx.exec(`CREATE TABLE ev (id BIGINT, region VARCHAR, h HUGEINT, _loaded_at TIMESTAMPTZ)`);
      // Inserted out of order: the snapshot orders them.
      await tx.exec(`INSERT INTO ev VALUES
        (10, 'b', ${HUGE}, '${S1}'), (9, 'a', -${HUGE}, '${S1}'), (100, 'a', 1, '${S1}'), (3, 'z', 2, '${S2}'), (1, 'b', 3, '${S2}')`);
      await tx.exec(`INSERT INTO _croft.assets (name, kind, key_columns, last_loaded_at, row_count)
        VALUES ('ev', 'ingest', CAST($1::JSON AS VARCHAR[]), '${S2}', 5)`, [JSON.stringify(key ?? [])]);
    }, { runId: "r_test" });
  }

  async function read(state: string, file: string): Promise<Record<string, unknown>[]> {
    const m = await openMemory({ timezone: "America/Los_Angeles", stateDir: state });
    try {
      const c = await m.connect();
      const cols = (await c.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet('${file}')`)).getRowObjectsJS()
        .map((r) => ({ name: String(r.column_name), type: String(r.column_name) === "h" ? "HUGEINT" : String(r.column_type) }));
      // The input's own types: HUGEINT went in as text and comes back through the cast.
      const result = await c.stream(`SELECT ${snapshotColumnsSql(cols)} FROM read_parquet('${file}')`);
      const out: Record<string, unknown>[] = [];
      for (;;) {
        const chunk = await result.fetchChunk();
        if (!chunk || chunk.rowCount === 0) break;
        out.push(...renderValueRows(chunk.getRows(), resultShape(result), { mode: "ts", timezone: "America/Los_Angeles" }));
      }
      return out;
    } finally {
      m.close();
    }
  }

  test("the facts of an input: its columns, its key as the table spells it, and last_loaded_at", async () => {
    const { w } = warehouse();
    await input(w, ["ID"]);
    const facts = await w.read((db) => readInputFacts(db, "ev"));
    expect(facts).toEqual({
      columns: [{ name: "id", type: "BIGINT" }, { name: "region", type: "VARCHAR" }, { name: "h", type: "HUGEINT" }, { name: "_loaded_at", type: "TIMESTAMPTZ" }],
      key: [{ name: "id", type: "BIGINT" }], lastLoadedAt: S2, rows: 5,
    });
    expect(await w.read((db) => readInputFacts(db, "missing"))).toBeNull();
  });

  test("an all.parquet snapshot is ordered by (_loaded_at, key), and HUGEINT comes back exact", async () => {
    const { w, state } = warehouse();
    await input(w);
    const snap = (await snapshotInput(w, { input: "ev", dir: join(state, "staging", "r1", "t", "in", "ev"), kind: "all" }))!;
    expect(snap.path).toBe(join(realpathSync(state), "staging", "r1", "t", "in", "ev", INPUT_FILES.all));
    expect(snap).toMatchObject({ rows: 5, capped: false, after: null });
    expect(snap.facts.lastLoadedAt).toBe(S2);
    const rows = await read(state, snap.path);
    expect(rows.map((r) => r.id)).toEqual([9, 10, 100, 1, 3]);
    expect(rows[0]).toMatchObject({ h: -BigInt(HUGE), _loaded_at: S1 });
    expect(rows[1]).toMatchObject({ h: BigInt(HUGE) });
  });

  test("a new.parquet snapshot starts after a composite position; keys compare by their own type", async () => {
    const { w, state } = warehouse();
    await input(w);
    const dir = join(state, "staging", "r1", "t", "in", "ev");
    const after = async (stamp: string, key: string[] | null) =>
      (await read(state, (await snapshotInput(w, { input: "ev", dir, kind: "new", after: { stamp, key } }))!.path)).map((r) => r.id);
    // BIGINT 10 < 100, although "100" < "9" as text.
    expect(await after(S1, ["10"])).toEqual([100, 1, 3]);
    expect(await after(S1, ["100"])).toEqual([1, 3]);
    expect(await after(S1, null)).toEqual([1, 3]);
    expect(await after(S2, ["1"])).toEqual([3]);
    expect(await after("2026-03-01T10:00:00Z", ["1000"])).toEqual([9, 10, 100, 1, 3]);
    // A position whose key does not fit (the input's key changed) re-reads that stamp rather than skip rows.
    expect(await after(S1, ["a", "1"])).toEqual([1, 3]);
    expect(await w.read(async (db) => countAfter(db, "ev", (await readInputFacts(db, "ev"))!, { stamp: S1, key: ["10"] }))).toBe(3);
    expect(await w.read(async (db) => countAfter(db, "ev", (await readInputFacts(db, "ev"))!, null))).toBe(5);
  });

  test("composite keys compare column by column", async () => {
    const pos = afterPosition({ stamp: S1, key: ["a", "10"] }, [{ name: "region", type: "VARCHAR" }, { name: "id", type: "BIGINT" }]);
    expect(pos.sql).toBe(`"_loaded_at" > CAST($1 AS TIMESTAMPTZ) OR ("_loaded_at" = CAST($1 AS TIMESTAMPTZ) AND ("region" > CAST($2 AS VARCHAR) OR ("region" = CAST($2 AS VARCHAR) AND ("id" > CAST($3 AS BIGINT)))))`);
    expect(pos.params).toEqual([S1, "a", "10"]);
    const { w, state } = warehouse();
    await input(w, ["region", "id"]);
    const snap = (await snapshotInput(w, { input: "ev", dir: join(state, "staging", "r2", "t", "in", "ev"), kind: "new", after: { stamp: S1, key: ["a", "10"] } }))!;
    expect((await read(state, snap.path)).map((r) => `${r.region}${r.id}`)).toEqual(["a100", "b10", "b1", "z3"]);
  });

  test("a row cap copies one row more, to tell a capped input from one of exactly that size", async () => {
    const { w, state } = warehouse();
    await input(w);
    const dir = join(state, "staging", "r1", "t", "in", "ev");
    expect(await snapshotInput(w, { input: "ev", dir, kind: "all", limit: 2 })).toMatchObject({ rows: 2, capped: true });
    expect(await snapshotInput(w, { input: "ev", dir, kind: "all", limit: 5 })).toMatchObject({ rows: 5, capped: false });
    expect(await snapshotInput(w, { input: "missing", dir, kind: "all" })).toBeNull();
  });

  test("a streamed Parquet scan keeps the file's order, through filters and many row groups [V]", async () => {
    const { state } = warehouse();
    const m = await openMemory({ timezone: "UTC", stateDir: state });
    try {
      const c = await m.connect();
      const file = join(realpathSync(state), "big.parquet");
      await c.run(`COPY (SELECT (i % 7)::BIGINT AS g, i AS id FROM range(200000) r(i) ORDER BY g, id) TO '${file}' (FORMAT parquet, ROW_GROUP_SIZE 10000)`);
      const result = await c.stream(`SELECT g, id FROM read_parquet('${file}') WHERE id % 3 <> 0`);
      let prev: [bigint, bigint] | null = null;
      let rows = 0;
      let disorder = 0;
      for (;;) {
        const chunk = await result.fetchChunk();
        if (!chunk || chunk.rowCount === 0) break;
        for (const r of chunk.getRows()) {
          const cur: [bigint, bigint] = [r[0] as bigint, r[1] as bigint];
          if (prev && (cur[0] < prev[0] || (cur[0] === prev[0] && cur[1] <= prev[1]))) disorder++;
          prev = cur;
          rows++;
        }
      }
      expect(rows).toBe(133333);
      expect(disorder).toBe(0);
    } finally {
      m.close();
    }
  });
});
