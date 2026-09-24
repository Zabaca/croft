// load/config-change.ts on its own: which changes of write mode, key and incremental field count (pure), and the
// pin guard writeBatch applies to ingests. The run-level flow (asking before fetching, the trash, the conversion)
// is in run/ingest-config.test.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import type { Incremental, Sql, WriteMode } from "../core/types.ts";
import { ensureState } from "../db/state.ts";
import { closeAllWarehouses, type DuckWarehouse, openWarehouse } from "../db/warehouse.ts";
import { behaviorHash } from "../project/resolve.ts";
import { behaviorChange, planPinChanges, type StoredBehavior } from "./config-change.ts";
import { readTableSchema } from "./evolve.ts";
import { tableBatch } from "./table-batch.ts";
import { writeBatch } from "./write.ts";

afterAll(() => closeAllWarehouses());

const CURSOR: Incremental = { kind: "cursor", field: "updated_at", lookbackMs: 0 };

function stored(write: WriteMode, key: string[], incremental: Incremental = CURSOR, kind: string | null = "ingest"): StoredBehavior {
  return { kind, write, key, behaviorHash: behaviorHash(write, key, incremental) };
}

function now(write: WriteMode, key: string[], incremental: Incremental = CURSOR) {
  return { write, key, behaviorHash: behaviorHash(write, key, incremental), hashWith: (w: WriteMode, k: readonly string[]) => behaviorHash(w, k, incremental) };
}

describe("behaviorChange", () => {
  test("the same behavior, a lookback, a reordered or re-cased key: no change", () => {
    expect(behaviorChange(stored("merge", ["id"]), now("merge", ["id"]))).toBeNull();
    expect(behaviorChange(stored("merge", ["id"]), now("merge", ["id"], { ...CURSOR, lookbackMs: 3_600_000 }))).toBeNull();
    expect(behaviorChange(stored("merge", ["a", "b"]), now("merge", ["B", "a"]))).toBeNull();
  });

  test("nothing recorded, or another kind of asset: not a behavior change", () => {
    expect(behaviorChange({ kind: "ingest", write: "merge", key: ["id"], behaviorHash: null }, now("merge", ["x"]))).toBeNull();
    expect(behaviorChange(stored("replace", ["id"], { kind: "none" }, "sql"), now("merge", ["id"]))).toBeNull();
  });

  test("which parts changed, and whether it is an append ingest gaining a key", () => {
    expect(behaviorChange(stored("append", []), now("merge", ["id"]))).toEqual({
      changed: ["write", "key"], from: { write: "append", key: [] }, to: { write: "merge", key: ["id"] }, appendGainsKey: true,
    });
    expect(behaviorChange(stored("append", []), now("append", ["id"]))).toMatchObject({ changed: ["key"], appendGainsKey: true });
    expect(behaviorChange(stored("merge", ["id"]), now("merge", ["email"]))).toMatchObject({ changed: ["key"], appendGainsKey: false });
    expect(behaviorChange(stored("merge", ["id"]), now("merge", ["id"], { ...CURSOR, field: "created_at" })))
      .toMatchObject({ changed: ["incremental"], appendGainsKey: false });
    expect(behaviorChange(stored("replace", [], { kind: "none" }), now("merge", ["id"]))).toMatchObject({ changed: ["write", "key", "incremental"], appendGainsKey: false });
    // A key gained together with another cursor field is not a plain conversion.
    expect(behaviorChange(stored("append", []), now("merge", ["id"], { ...CURSOR, field: "created_at" })))
      .toMatchObject({ changed: ["write", "key", "incremental"], appendGainsKey: false });
    // Dropping the key of a merge ingest back to an append.
    expect(behaviorChange(stored("merge", ["id"]), now("append", []))).toMatchObject({ changed: ["write", "key"], appendGainsKey: false });
  });
});

// ---------------------------------------------------------------------------------------------------------

function warehouse(): DuckWarehouse {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-cfg-")));
  mkdirSync(join(root, ".croft"));
  return openWarehouse({ path: join(root, "warehouse.duckdb"), mode: "read_write", timezone: "UTC", root, stateDir: join(root, ".croft"), register: false, isTTY: false });
}

/** A people table croft wrote: id BIGINT, zip VARCHAR, with its _croft records. */
async function seed(w: DuckWarehouse, zips: (string | null)[]): Promise<void> {
  await w.write("seed", async (tx) => {
    await ensureState(tx);
    await tx.exec(`CREATE TABLE people (id BIGINT, zip VARCHAR, _loaded_at TIMESTAMPTZ)`);
    for (const [n, zip] of zips.entries()) await tx.exec(`INSERT INTO people VALUES ($1, $2, '2026-01-01T00:00:00Z')`, [n + 1, zip]);
    await tx.exec(`INSERT INTO _croft.assets (name, kind, write_mode, key_columns, row_count, max_loaded_at, last_loaded_at)
      VALUES ('people', 'ingest', 'merge', ['id'], ${zips.length}, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
    for (const [name, type] of [["id", "BIGINT"], ["zip", "VARCHAR"]]) {
      await tx.exec(`INSERT INTO _croft.columns (asset, name, type, source_name, pinned, pending, kinds, present_last_batch, added_at)
        VALUES ('people', $1, $2, $1, false, false, [], true, '2026-01-01T00:00:00Z')`, [name, type]);
    }
  }, { runId: "r_seed" });
}

/** Write one row (id only) the way a merge ingest would, with these pins. */
function writeId(w: DuckWarehouse, id: number, o: { pins?: Record<string, { type: string; format?: string }>; kind?: "ingest" | "ts" } = {}) {
  return w.write("t", async (tx) => {
    await tx.exec(`CREATE OR REPLACE TEMP TABLE b AS SELECT ${id}::BIGINT AS id, 1::BIGINT AS _croft_seq`);
    const batch = await tableBatch(tx, { temp: "b", asset: "people" });
    return writeBatch(tx, { batch, target: { asset: "people", write: "merge", key: ["id"], runId: `r_${id}` }, kind: o.kind ?? "ingest", ...(o.pins ? { pins: o.pins } : {}) });
  }, { runId: `r_${id}` });
}

const read = <T = Record<string, unknown>>(w: DuckWarehouse, sql: string) => w.read((db) => db.all<T>(sql), { purpose: "test" });
const zipType = async (w: DuckWarehouse) => (await w.read((db) => readTableSchema(db, "people"), { purpose: "test" }))!.find((c) => c.name === "zip")!.type;

async function rejection(p: Promise<unknown>): Promise<CroftError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
  throw new Error("expected a CroftError");
}

describe("the pin guard in writeBatch (ingests)", () => {
  test("a lossless changed pin retypes its column before the write, though the batch does not carry it", async () => {
    const w = warehouse();
    await seed(w, ["12345", null]);
    const r = await writeId(w, 3, { pins: { zip: { type: "BIGINT" } } });
    expect(r.schemaChanges).toEqual([{ kind: "widen", column: "zip", from: "VARCHAR", to: "BIGINT" }]);
    expect(await zipType(w)).toBe("BIGINT");
    expect(await read(w, `SELECT id::INT AS id, zip FROM people ORDER BY id`)).toEqual([{ id: 1, zip: 12345 }, { id: 2, zip: null }, { id: 3, zip: null }]);
    expect(await read(w, `SELECT type, pinned FROM _croft.columns WHERE asset = 'people' AND name = 'zip'`)).toEqual([{ type: "BIGINT", pinned: true }]);
    expect((await read(w, `SELECT schema_changes::VARCHAR AS s FROM _croft.writes WHERE asset = 'people'`))[0]!.s).toContain("\"zip\"");
  });

  test("a lossy pin that reaches the write unconfirmed is PIN_CHANGES_DATA; nothing is written", async () => {
    const w = warehouse();
    await seed(w, ["02134", "abc", "7"]);
    const e = await rejection(writeId(w, 4, { pins: { zip: { type: "BIGINT" } } }));
    expect(e.code).toBe("PIN_CHANGES_DATA");
    expect(e.problem.details).toMatchObject({ column: "zip", from: "VARCHAR", to: "BIGINT", changed: 2, nonNull: 3 });
    expect(e.problem.effect).toBe("nothing was written");
    expect(await zipType(w)).toBe("VARCHAR");
    expect(await read(w, `SELECT count(*)::INT AS n FROM people`)).toEqual([{ n: 3 }]);
  });

  test("transforms keep their own pin handling", async () => {
    const w = warehouse();
    await seed(w, ["12345"]);
    const r = await writeId(w, 2, { kind: "ts", pins: { zip: { type: "VARCHAR" } } });
    expect(r.schemaChanges).toEqual([]);
  });
});

describe("planPinChanges", () => {
  async function plan(w: DuckWarehouse, pins: Record<string, { type: string; format?: string }>) {
    return w.read(async (db: Sql) => {
      const real = (await readTableSchema(db, "people"))!;
      return planPinChanges(db, { asset: "people", real, stored: [], pins });
    }, { purpose: "test" });
  }

  test("counts the stored values a pin would change, with samples of what they become", async () => {
    const w = warehouse();
    await seed(w, ["02134", "1.5", "abc", "42", null]);
    expect(await plan(w, { zip: { type: "BIGINT" } })).toEqual([{
      column: "zip", from: "VARCHAR", to: "BIGINT", pending: false, nonNull: 4, changed: 3,
      samples: [{ value: "02134", becomes: "2134" }, { value: "1.5", becomes: "2" }, { value: "abc", becomes: null }],
    }]);
    expect(await plan(w, { ZIP: { type: "varchar" } })).toEqual([]);
    expect(await plan(w, { other: { type: "BIGINT" } })).toEqual([]);
  });

  test("text in a money format, read through the pin's format", async () => {
    const w = warehouse();
    await seed(w, ["$1,234.50", "(3.00)"]);
    const [p] = await plan(w, { zip: { type: "DECIMAL(18,2)", format: "money" } });
    expect(p).toMatchObject({ to: "DECIMAL(18,2)", changed: 0, nonNull: 2 });
  });

  test("a stored non-text column is tested by the round trip try_cast(x AS new)::old", async () => {
    const w = warehouse();
    await seed(w, ["1"]);
    await w.write("amounts", async (tx) => {
      await tx.exec(`ALTER TABLE people ADD COLUMN amount DOUBLE`);
      await tx.exec(`UPDATE people SET amount = 1.005`);
    }, { runId: "r_a" });
    const out = await plan(w, { amount: { type: "DECIMAL(18,2)" } });
    expect(out).toMatchObject([{ column: "amount", from: "DOUBLE", to: "DECIMAL(18,2)", changed: 1 }]);
    expect(await plan(w, { amount: { type: "VARCHAR" } })).toMatchObject([{ changed: 0 }]);
  });
});
