import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import type { CursorType, Fix } from "../core/types.ts";
import { openMemory } from "../db/connect.ts";
import { TxGuard } from "../db/tx-guard.ts";
import { closeAllWarehouses, LeaseSql, openWarehouse } from "../db/warehouse.ts";
import { buildTypedBatch, type BuildTypedBatchOptions, castExpr, CURSOR_TEXT, lossExpr, numCanon, realColumns, type TypedBatchResult } from "./cast.ts";
import { ident } from "./classify.ts";
import { readTableSchema } from "./evolve.ts";
import { parseJsonLossless, STAGE_FILE, type StageOptions, writeStage } from "./stage.ts";
import type { KnownColumn } from "./types.ts";

const dbs: { close(): void }[] = [];
afterAll(async () => {
  dbs.forEach((d) => d.close());
  await closeAllWarehouses();
});

type Load = { batch: TypedBatchResult; rows: Record<string, unknown>[]; types: Record<string, string> };

async function testDb(timezone = "UTC") {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "croft-cast-")));
  const db = await openMemory({ timezone, stateDir: dir });
  dbs.push(db);
  const conn = await db.connect();
  let run = 0;
  const sql = () => new LeaseSql(conn, { mode: "ts", timezone }, new TxGuard());
  const tx = async <T>(fn: (tx: LeaseSql) => Promise<T>): Promise<T> => {
    await conn.run("BEGIN TRANSACTION");
    try {
      const out = await fn(sql());
      await conn.run("COMMIT");
      return out;
    } catch (e) {
      await conn.run("ROLLBACK");
      throw e;
    }
  };
  return {
    tx,
    exec: (s: string) => conn.run(s),
    all: (s: string) => new LeaseSql(conn, { mode: "ts", timezone }, null).all(s),
    /** Stage rows, then build the typed batch in a transaction; returns the batch and its typed rows. */
    async load(source: StageOptions["source"], o: Partial<Omit<BuildTypedBatchOptions, "manifest">> & { stage?: Partial<StageOptions> } = {}): Promise<Load> {
      run++;
      const manifest = await writeStage({
        dir: join(dir, "staging", `r${run}`, "a"), asset: "a", runId: `r${run}`, source, knownColumns: o.knownColumns, ...o.stage,
      });
      return tx(async (t) => {
        const batch = await buildTypedBatch(t, { manifest, knownColumns: [], ...o });
        const rows = await t.all(`SELECT * FROM ${ident(batch.temp)} ORDER BY _croft_seq`);
        const desc = await t.all<{ column_name: string; column_type: string }>(`DESCRIBE ${ident(batch.temp)}`);
        return { batch, rows, types: Object.fromEntries(desc.map((d) => [d.column_name, d.column_type])) };
      });
    },
  };
}

async function failure(p: Promise<unknown>): Promise<CroftError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
  throw new Error("expected a CroftError");
}

const col = (b: TypedBatchResult, name: string) => b.columns.find((c) => c.column === name)!;
const known = (name: string, type: string, extra: Partial<KnownColumn> = {}): KnownColumn => ({ name, type, sourceName: name, ...extra });

describe("a first load types every column by §7", () => {
  test("types, typed values and plan", async () => {
    const db = await testDb("America/Los_Angeles");
    const { batch, rows, types } = await db.load([
      { id: 1, amount: 10, price: 1.5, big: 12345678901234567890n, ok: true, zip: "02134", created_at: "2024-01-02T10:00:00+02:00",
        seen: "2024-01-02T10:00:00", day: "2024-01-02", user: { login: "a", id: 7 }, tags: ["x"], closed_at: null, mixed: 1 },
      { id: 2, amount: 20.25, price: 2, big: 1n, ok: false, zip: "10001", created_at: "2024-01-02T10:00:00Z",
        seen: "2024-01-02T11:30:00.5", day: "2024-01-03", user: { id: 8, login: "b" }, tags: [], mixed: "one" },
    ]);
    expect(types).toEqual({
      _croft_seq: "BIGINT", id: "BIGINT", amount: "DOUBLE", price: "DOUBLE", big: "HUGEINT", ok: "BOOLEAN", zip: "VARCHAR",
      created_at: "TIMESTAMP WITH TIME ZONE", seen: "TIMESTAMP", day: "DATE", user: "JSON", tags: "JSON",
      closed_at: "TIMESTAMP WITH TIME ZONE", mixed: "VARCHAR",
    });
    expect(rows[0]).toMatchObject({
      _croft_seq: 1, id: 1, amount: 10, price: 1.5, big: 12345678901234567890n, ok: true, zip: "02134",
      created_at: "2024-01-02T08:00:00.000000Z", seen: "2024-01-02T10:00:00.000000", day: "2024-01-02",
      user: { id: 7, login: "a" }, tags: ["x"], closed_at: null, mixed: "1",
    });
    expect(rows[1]).toMatchObject({ amount: 20.25, created_at: "2024-01-02T10:00:00.000000Z", seen: "2024-01-02T11:30:00.500000", mixed: "one" });
    expect(batch.rows).toBe(2);
    expect(batch.temp).toBe("_croft_typed_a");
    expect(batch.columns.every((c) => c.decision === "add" && c.present)).toBe(true);
    expect(col(batch, "closed_at")).toMatchObject({ target: "TIMESTAMPTZ", pending: true, incoming: ["null"] });
    expect(batch.warnings.map((w) => [w.code, w.details?.column])).toEqual([["NULL_ONLY_COLUMN", "closed_at"], ["MIXED_TYPES", "mixed"]]);
    expect(batch.cursor).toBeUndefined();
  });

  test("the raw relation is dropped; only the typed TEMP table remains", async () => {
    const db = await testDb();
    await db.load([{ a: 1 }]);
    const tables = await db.all(`SELECT table_name FROM duckdb_tables() WHERE temporary ORDER BY 1`);
    expect(tables).toEqual([{ table_name: "_croft_typed_a" }]);
    expect(await db.all(`SELECT view_name FROM duckdb_views() WHERE temporary AND NOT internal`)).toEqual([]);
  });

  test("a failed build leaves nothing behind: its TEMP tables roll back with the transaction", async () => {
    const db = await testDb();
    await failure(db.load([{ n: 1.5 }], { pins: { n: "BIGINT" } }));
    expect(await db.all(`SELECT table_name FROM duckdb_tables() WHERE temporary`)).toEqual([]);
  });

  test("an empty extraction gives an empty typed table with the stored columns", async () => {
    const db = await testDb();
    const { batch, types } = await db.load([], { knownColumns: [known("id", "BIGINT"), known("at", "TIMESTAMPTZ")] });
    expect(batch.rows).toBe(0);
    expect(types).toEqual({ _croft_seq: "BIGINT", id: "BIGINT", at: "TIMESTAMP WITH TIME ZONE" });
    expect(batch.columns.map((c) => [c.column, c.decision, c.present])).toEqual([["id", "keep", false], ["at", "keep", false]]);
  });

  test("_file passes through for file ingests", async () => {
    const db = await testDb();
    const { rows, types } = await db.load([{ a: 1, [STAGE_FILE]: "files/sales/jan.json" }]);
    expect(types._file).toBe("VARCHAR");
    expect(rows[0]!._file).toBe("files/sales/jan.json");
  });
});

describe("proven hazards (DESIGN.md §7, Appendix B)", () => {
  test("1.7 into BIGINT: DuckDB rounds it to 2; croft widens an unpinned column and refuses a pinned one", async () => {
    const db = await testDb();
    expect(await db.all(`SELECT TRY_CAST('1.7' AS BIGINT) AS v`)).toEqual([{ v: 2 }]); // the hazard itself
    const widened = await db.load([{ n: 1 }, { n: 1.7 }], { knownColumns: [known("n", "BIGINT")] });
    expect(col(widened.batch, "n")).toMatchObject({ decision: "widen", target: "DOUBLE" });
    expect(widened.rows.map((r) => r.n)).toEqual([1, 1.7]);
    expect(widened.batch.warnings.map((w) => w.code)).toEqual(["TYPE_WIDENED"]);

    const e = await failure(db.load([{ n: 1 }, { n: 1.7 }, { n: 1.5 }], { pins: { n: "BIGINT" } }));
    expect(e.code).toBe("TYPE_PIN_VIOLATION");
    expect(e.problem.details).toMatchObject({ column: "n", badRows: 2, samples: [{ row: 2, value: "1.7", typed: "2" }, { row: 3, value: "1.5", typed: "2" }] });
  });

  test("1.005 into DECIMAL(18,2): the cast reads the text, and the rounding is refused as PIN_ROUNDED", async () => {
    const db = await testDb();
    // Casting the JSON value goes through DOUBLE (1.00); the text gives 1.01. Neither may pass silently.
    expect(await db.all(`SELECT CAST('1.005'::JSON AS DECIMAL(18,2))::VARCHAR AS via_json, CAST('1.005' AS DECIMAL(18,2))::VARCHAR AS via_text`))
      .toEqual([{ via_json: "1.00", via_text: "1.01" }]);
    // DECIMAL(18,2) holds more digits than a JSON number carries: numbers are refused, strings are exact.
    expect((await failure(db.load([{ amount: 1.005 }], { pins: { amount: "DECIMAL(18,2)" } }))).code).toBe("DECIMAL_PRECISION_UNSUPPORTED");
    const e = await failure(db.load([{ amount: "1.25" }, { amount: "1.005" }], { pins: { amount: "DECIMAL(18,2)" } }));
    expect(e.code).toBe("PIN_ROUNDED");
    expect(e.problem.details).toMatchObject({ badRows: 1, samples: [{ row: 2, value: "1.005", typed: "1.01" }] });
    // Within 15 digits JSON numbers are fine, and still read as text.
    const n = await failure(db.load([{ amount: 1.25 }, { amount: 1.005 }], { pins: { amount: "DECIMAL(15,2)" } }));
    expect(n.code).toBe("PIN_ROUNDED");
    await db.load([{ amount: 1.25 }, { amount: 1.005 }], { pins: { amount: "DECIMAL(15,3)" } });
    expect(await db.all(`SELECT typeof(amount) AS t, amount::VARCHAR AS v FROM _croft_typed_a ORDER BY _croft_seq`))
      .toEqual([{ t: "DECIMAL(15,3)", v: "1.250" }, { t: "DECIMAL(15,3)", v: "1.005" }]);
  });

  test("19.999 into DECIMAL(15,2) is rounding; 20 stays exact", async () => {
    const db = await testDb();
    const e = await failure(db.load([{ p: 20 }, { p: 19.999 }], { pins: { p: "DECIMAL(15,2)" } }));
    expect(e.code).toBe("PIN_ROUNDED");
    expect(e.problem.details?.badRows).toBe(1);
  });

  test("+02:00 into TIMESTAMP: DuckDB drops the offset; croft calls it a conflict, or a pin violation", async () => {
    const db = await testDb();
    expect(await db.all(`SELECT '2024-01-01T10:00:00+02:00'::TIMESTAMP::VARCHAR AS v`)).toEqual([{ v: "2024-01-01 10:00:00" }]);
    const c = await failure(db.load([{ t: "2024-01-01T10:00:00+02:00" }], { knownColumns: [known("t", "TIMESTAMP")] }));
    expect(c.code).toBe("TYPE_CONFLICT");
    expect(c.problem.details).toMatchObject({ storedType: "TIMESTAMP", conflictKinds: ["iso_instant"], badRows: 1 });
    expect(c.problem.details).toMatchObject({ existingType: "TIMESTAMP", incomingKinds: ["iso_instant"] });
    const p = await failure(db.load([{ t: "2024-01-01T10:00:00+02:00" }, { t: "2024-01-01T10:00:00" }], { pins: { t: "TIMESTAMP" } }));
    expect(p.code).toBe("TYPE_PIN_VIOLATION");
    expect(p.problem.details).toMatchObject({ badRows: 1, samples: [{ row: 1, value: "2024-01-01T10:00:00+02:00" }] });
    const utc = await db.load([{ t: "2024-01-01T10:00:00Z" }], { pins: { t: "TIMESTAMP" } }); // same wall clock: no loss
    expect(utc.rows[0]!.t).toBe("2024-01-01T10:00:00.000000");
  });

  test("'02134': text on a first load, a conflict for a BIGINT column, and a pin violation (leading zero)", async () => {
    const db = await testDb();
    const first = await db.load([{ zip: "02134" }, { zip: "10001" }]);
    expect(first.types.zip).toBe("VARCHAR");
    expect(first.rows.map((r) => r.zip)).toEqual(["02134", "10001"]);
    const c = await failure(db.load([{ zip: "02134" }], { knownColumns: [known("zip", "BIGINT")] }));
    expect(c.code).toBe("TYPE_CONFLICT");
    expect(c.problem.details).toMatchObject({ storedType: "BIGINT", incomingType: "VARCHAR", samples: [{ row: 1, value: "02134" }] });
    const p = await failure(db.load([{ zip: "02134" }], { pins: { zip: "BIGINT" } }));
    expect(p.code).toBe("TYPE_PIN_VIOLATION");
    const exact = await db.load([{ zip: "12345" }, { zip: 7 }], { pins: { zip: "BIGINT" } }); // exact strings are fine under a pin
    expect(exact.rows.map((r) => r.zip)).toEqual([12345, 7]);
  });

  test("2^53+1: exact in BIGINT, refused in DOUBLE, and blocks widening a BIGINT column that stores it", async () => {
    const db = await testDb();
    const exact = await db.load([{ n: 9007199254740993n }]);
    expect(exact.types.n).toBe("BIGINT");
    expect(exact.rows[0]!.n).toBe(9007199254740993n);

    const mixed = await db.load([{ n: 9007199254740993n }, { n: 1.5 }]);
    expect(mixed.types.n).toBe("VARCHAR");
    expect(mixed.rows.map((r) => r.n)).toEqual(["9007199254740993", "1.5"]);
    expect(mixed.batch.warnings.map((w) => w.code)).toEqual(["MIXED_TYPES"]);

    const intoDouble = await failure(db.load([{ n: 9007199254740993n }, { n: 2.5 }], { knownColumns: [known("n", "DOUBLE")] }));
    expect(intoDouble.code).toBe("TYPE_CONFLICT");
    expect(intoDouble.problem.details).toMatchObject({ badRows: 1, samples: [{ row: 1, value: "9007199254740993", typed: "9007199254740992.0" }] });

    await db.exec(`CREATE TABLE a (n BIGINT)`);
    await db.exec(`INSERT INTO a VALUES (9007199254740993), (5)`);
    const proof = await failure(db.load([{ n: 2.5 }], { knownColumns: [known("n", "BIGINT")] }));
    expect(proof.code).toBe("TYPE_CONFLICT");
    expect(proof.problem.details).toMatchObject({ stored: true, badRows: 1, samples: ["9007199254740993"], existingType: "BIGINT", incomingKinds: ["float"] });
    await db.exec(`DELETE FROM a WHERE n > 100`);
    const widened = await db.load([{ n: 2.5 }], { knownColumns: [known("n", "BIGINT")] });
    expect(col(widened.batch, "n")).toMatchObject({ decision: "widen", target: "DOUBLE", proof: "double" });
    await db.exec(`DROP TABLE a`);
  });

  test("mixed offsets are one TIMESTAMPTZ column; instants compare correctly and the cursor keeps the original text", async () => {
    const db = await testDb("America/Los_Angeles");
    const { batch, rows } = await db.load([
      { id: 1, updated_at: "2024-01-01T10:00:00+02:00" },
      { id: 2, updated_at: "2024-01-01T08:30:00Z" },
      { id: 3, updated_at: "2024-01-01T00:15:00-0800" },
      { id: 4, updated_at: "2024-01-01T09:00:00.123456+01:00" },
    ], { cursor: { field: "updated_at" } });
    expect(batch.cursor).toEqual({ field: "updated_at", type: "timestamp", rawTextColumn: CURSOR_TEXT });
    expect(rows.map((r) => r.updated_at)).toEqual([
      "2024-01-01T08:00:00.000000Z", "2024-01-01T08:30:00.000000Z", "2024-01-01T08:15:00.000000Z", "2024-01-01T08:00:00.123456Z",
    ]);
    const max = await db.tx((t) => t.all(`SELECT ${ident(CURSOR_TEXT)} AS v FROM ${ident(batch.temp)} ORDER BY updated_at DESC LIMIT 1`));
    expect(max).toEqual([{ v: "2024-01-01T08:30:00Z" }]); // the typed maximum, handed back as the API sent it
  });

  test("key order never makes a change: reordered nested keys stage to identical JSON", async () => {
    const db = await testDb();
    const a = await db.load([{ id: 1, user: { login: "x", id: 1, meta: { b: 2, a: 1 } } }]);
    const first = await db.all(`SELECT user::VARCHAR AS u FROM _croft_typed_a`);
    const b = await db.load([{ user: { meta: { a: 1, b: 2 }, id: 1, login: "x" }, id: 1 }]);
    const second = await db.all(`SELECT user::VARCHAR AS u FROM _croft_typed_a`);
    expect(first).toEqual(second);
    expect(first).toEqual([{ u: `{"id":1,"login":"x","meta":{"a":1,"b":2}}` }]);
    expect(a.types.user).toBe("JSON");
    expect(b.types.user).toBe("JSON");
  });

  test("bigint exactness from API text through staging into HUGEINT", async () => {
    const db = await testDb();
    const page = parseJsonLossless(`[{"id":12345678901234567890},{"id":18446744073709551615},{"id":-9223372036854775809},{"id":170141183460469231731687303715884105727}]`) as Record<string, unknown>[];
    const { rows, types } = await db.load([page]);
    expect(types.id).toBe("HUGEINT");
    expect(rows.map((r) => r.id)).toEqual([12345678901234567890n, 18446744073709551615n, -9223372036854775809n, 170141183460469231731687303715884105727n]);
  });

  test("a number beyond DOUBLE (1e400) from res.json(): exact inside a JSON column, text as a column of its own", async () => {
    const db = await testDb();
    const page = () => parseJsonLossless(
      `[{"id":1,"payload":{"k":1,"huge":1e400},"top":5},{"id":2,"payload":{"k":2,"list":[-1e400]},"top":1e400}]`) as Record<string, unknown>[];
    const { batch, rows, types } = await db.load([page()]);
    // Inside a JSON column the number keeps its source text, still a JSON number (§4.3).
    expect(types.payload).toBe("JSON");
    expect(await db.all(`SELECT payload::VARCHAR AS p, json_type(payload, '$.huge') AS t FROM _croft_typed_a ORDER BY id`)).toEqual([
      { p: `{"huge":1e400,"k":1}`, t: "DOUBLE" }, { p: `{"k":2,"list":[-1e400]}`, t: null },
    ]);
    // As a column value no numeric type can hold it: the column is text (MIXED_TYPES), and the text is exact.
    expect(types.top).toBe("VARCHAR");
    expect(rows.map((r) => r.top)).toEqual(["5", "1e400"]);
    expect(batch.warnings.map((w) => [w.code, w.details?.column])).toEqual([["MIXED_TYPES", "top"]]);
    // A DOUBLE column refuses it loudly, naming the value, rather than storing NULL or Infinity.
    const e = await failure(db.load([page()], { knownColumns: [known("id", "BIGINT"), known("payload", "JSON"), known("top", "DOUBLE")] }));
    expect(e.code).toBe("TYPE_CONFLICT");
    expect(e.problem.details).toMatchObject({ column: "top", existingType: "DOUBLE", samples: [{ row: 2, value: "1e400" }] });
  });

  test("integers beyond HUGEINT cannot be stored exactly: TYPE_CONFLICT, never a rounded value", async () => {
    const db = await testDb();
    const e = await failure(db.load([{ id: 10n ** 40n }]));
    expect(e.code).toBe("TYPE_CONFLICT");
    expect(e.problem.details).toMatchObject({ badRows: 1, samples: [{ value: "10000000000000000000000000000000000000000" }] });
    // §4.3 names: the type the values had to fit, and the kinds that arrived.
    expect(e.problem.details).toMatchObject({ existingType: "HUGEINT", incomingKinds: ["bigint"], readBy: [] });
  });

  test("NULL-only placeholders bind in typed SQL, and are retyped when values arrive", async () => {
    const db = await testDb();
    const first = await db.load([{ id: 1, closed_at: null, is_open: null, due_on: null, note: null }]);
    expect(first.types).toMatchObject({ closed_at: "TIMESTAMP WITH TIME ZONE", is_open: "BOOLEAN", due_on: "DATE", note: "VARCHAR" });
    // A VARCHAR placeholder would fail to bind here [V].
    const bound = await db.tx((t) => t.all(
      `SELECT date_diff('day', closed_at, TIMESTAMPTZ '2024-01-01') AS d, coalesce(closed_at, now()) IS NOT NULL AS c, closed_at > TIMESTAMPTZ '2024-01-01' AS g FROM _croft_typed_a`,
    ));
    expect(bound).toEqual([{ d: null, c: true, g: null }]);
    const stored = first.batch.columns.map((c) => known(c.column, c.target!, { pending: c.pending }));
    const later = await db.load([{ id: 2, closed_at: "2024-01-05T00:00:00Z", is_open: "yes", due_on: null, note: 5 }], { knownColumns: stored });
    expect(later.batch.columns.map((c) => [c.column, c.decision, c.target, c.pending])).toEqual([
      ["id", "keep", "BIGINT", false],
      ["closed_at", "retype_pending", "TIMESTAMPTZ", false],
      ["is_open", "retype_pending", "VARCHAR", false],
      ["due_on", "keep", "DATE", true],
      ["note", "retype_pending", "BIGINT", false],
    ]);
    expect(later.rows[0]).toMatchObject({ is_open: "yes", note: 5 });
  });

  test("unserializable values never reach DuckDB", async () => {
    const db = await testDb();
    const e = await failure(db.load([{ id: 1, tags: new Set(["a"]) }]));
    expect(e.code).toBe("UNSERIALIZABLE_VALUE");
  });
});

describe("evolution against stored columns (§7 table)", () => {
  test("new field is added, a missing field is kept as a typed NULL column and marked absent", async () => {
    const db = await testDb();
    const { batch, rows, types } = await db.load([{ id: 1, extra: "x" }], { knownColumns: [known("id", "BIGINT"), known("gone", "DOUBLE")] });
    expect(batch.columns.map((c) => [c.column, c.decision, c.present, c.incoming])).toEqual([
      ["id", "keep", true, ["integer"]],
      ["extra", "add", true, ["string"]],
      ["gone", "keep", false, []],
    ]);
    expect(types.gone).toBe("DOUBLE");
    expect(rows[0]).toMatchObject({ id: 1, extra: "x", gone: null });
  });

  test("a row missing a key counts as NULL for that column", async () => {
    const db = await testDb();
    const { batch, rows } = await db.load([{ id: 1, n: 5 }, { id: 2 }]);
    expect(col(batch, "n").incoming).toEqual(["null", "integer"]);
    expect(rows.map((r) => r.n)).toEqual([5, null]);
  });

  test("BIGINT receives integers beyond int64 → HUGEINT", async () => {
    const db = await testDb();
    const { batch, rows } = await db.load([{ n: 1 }, { n: 99999999999999999999n }], { knownColumns: [known("n", "BIGINT")] });
    expect(col(batch, "n")).toMatchObject({ decision: "widen", target: "HUGEINT" });
    expect(rows.map((r) => r.n)).toEqual([1n, 99999999999999999999n]);
  });

  test("DATE receives zoned date-times → TIMESTAMPTZ; dates read as midnight in the project zone", async () => {
    const db = await testDb("America/Los_Angeles");
    const { batch, rows } = await db.load([{ d: "2024-01-02" }, { d: "2024-01-02T10:00:00Z" }], { knownColumns: [known("d", "DATE")] });
    expect(col(batch, "d")).toMatchObject({ decision: "widen", target: "TIMESTAMPTZ" });
    expect(rows.map((r) => r.d)).toEqual(["2024-01-02T08:00:00.000000Z", "2024-01-02T10:00:00.000000Z"]);
  });

  test("TIMESTAMPTZ receives ISO dates: cast on insert at midnight in the project zone", async () => {
    const db = await testDb("Europe/Berlin");
    const { batch, rows } = await db.load([{ t: "2024-07-01" }], { knownColumns: [known("t", "TIMESTAMPTZ")] });
    expect(col(batch, "t").decision).toBe("cast");
    expect(rows[0]!.t).toBe("2024-06-30T22:00:00.000000Z");
  });

  test("VARCHAR receives numbers and booleans → stored as text", async () => {
    const db = await testDb();
    const { rows } = await db.load([{ v: 42 }, { v: true }, { v: 1.5 }, { v: "x" }], { knownColumns: [known("v", "VARCHAR")] });
    expect(rows.map((r) => r.v)).toEqual(["42", "true", "1.5", "x"]);
  });

  test("JSON receives anything → stored as JSON; a new kind warns JSON_KIND_CHANGED", async () => {
    const db = await testDb();
    const { batch, rows } = await db.load([{ user: { login: "a" } }, { user: "deleted-user" }], {
      knownColumns: [known("user", "JSON", { kinds: ["object"] })],
    });
    expect(rows.map((r) => r.user)).toEqual([{ login: "a" }, "deleted-user"]);
    expect(batch.warnings.map((w) => w.code)).toEqual(["JSON_KIND_CHANGED"]);
  });

  test("number ↔ text: TYPE_CONFLICT names both types, the count, 5 samples, readers and ordered fixes", async () => {
    const db = await testDb();
    const rows = Array.from({ length: 9 }, (_, i) => ({ amount: i % 3 === 0 ? `n/a ${i}` : i }));
    const e = await failure(db.load(rows, { knownColumns: [known("amount", "BIGINT")], readBy: ["daily_revenue", "report"] }));
    expect(e.code).toBe("TYPE_CONFLICT");
    expect(e.message).toContain("column amount is BIGINT, but 3 rows have text values");
    expect(e.message).toContain("Read by daily_revenue, report");
    expect(e.problem.details).toMatchObject({
      column: "amount", storedType: "BIGINT", incomingType: "VARCHAR", badRows: 3, readBy: ["daily_revenue", "report"],
      samples: [{ row: 1, value: "n/a 0" }, { row: 4, value: "n/a 3" }, { row: 7, value: "n/a 6" }],
    });
    // §4.3's names for the same facts: the type the column has, and the kinds of value that arrived.
    expect(e.problem.details).toMatchObject({ existingType: "BIGINT", incomingKinds: ["integer", "string"], conflictKinds: ["string"] });
    const fixes = e.problem.details!.fixes as Fix[];
    expect(fixes).toHaveLength(3);
    expect(fixes[0]!.description).toContain("clean the value in rows()");
    expect(fixes[0]!.description).toContain("Number(r.amount)");
    expect(fixes[1]!.description).toContain(`columns: { amount: "BIGINT" }`);
    expect(fixes[2]!.description).toContain(`"VARCHAR"`);
    expect(fixes[2]!.description).toContain("'9' > '10'");
    expect(e.problem.fix).toEqual(fixes[0]);
  });

  test("at most 5 samples", async () => {
    const db = await testDb();
    const e = await failure(db.load(Array.from({ length: 20 }, (_, i) => ({ b: `x${i}` })), { knownColumns: [known("b", "BOOLEAN")] }));
    expect(e.problem.details).toMatchObject({ badRows: 20 });
    expect((e.problem.details!.samples as unknown[]).length).toBe(5);
  });

  test("the real table wins over _croft.columns: TABLE_MODIFIED_OUTSIDE_CROFT", async () => {
    const db = await testDb();
    await db.exec(`CREATE TABLE a (id BIGINT, amount DOUBLE, added VARCHAR, _loaded_at TIMESTAMPTZ)`);
    const { batch, types } = await db.load([{ id: 1, amount: 2.5 }], {
      knownColumns: [known("id", "BIGINT"), known("amount", "BIGINT"), known("dropped", "VARCHAR")],
    });
    expect(types).toMatchObject({ amount: "DOUBLE", added: "VARCHAR" });
    expect(types.dropped).toBeUndefined();
    const w = batch.warnings.find((x) => x.code === "TABLE_MODIFIED_OUTSIDE_CROFT")!;
    expect(w.details?.changes).toEqual([
      "column amount is DOUBLE in the table but BIGINT in croft's records",
      "column dropped was dropped",
      "column added (VARCHAR) was added",
    ]);
    await db.exec(`DROP TABLE a`);
  });

  test("types are spelled as evolve.ts spells them, so _croft.columns records match the real table", async () => {
    const db = await testDb();
    await db.exec(`CREATE TABLE a (id BIGINT, t TIME WITH TIME ZONE, l INT8[], d DECIMAL(10), _loaded_at TIMESTAMPTZ)`);
    const real = await db.tx((t) => realColumns(t, "a"));
    const evolved = await db.tx((t) => readTableSchema(t, "a"));
    expect(real).toEqual(evolved!.filter((c) => c.name !== "_loaded_at"));
    expect(real!.find((c) => c.name === "t")!.type).toBe("TIMETZ");
    // write.ts records _croft.columns.type with evolve.ts's normalizeType: no false TABLE_MODIFIED_OUTSIDE_CROFT.
    const recorded = evolved!.filter((c) => c.name !== "_loaded_at").map((c) => known(c.name, c.type));
    const { batch } = await db.load([{ id: 1 }], { knownColumns: recorded });
    expect(batch.warnings.filter((x) => x.code === "TABLE_MODIFIED_OUTSIDE_CROFT")).toEqual([]);
    await db.exec(`DROP TABLE a`);
  });
});

describe("pins", () => {
  test("pinned DECIMAL with more than 15 digits refuses JSON numbers, accepts strings exactly", async () => {
    const db = await testDb();
    const e = await failure(db.load([{ amount: 12.5 }], { pins: { amount: "DECIMAL(20,2)" } }));
    expect(e.code).toBe("DECIMAL_PRECISION_UNSUPPORTED");
    await db.load([{ amount: "123456789012345678.12" }, { amount: 7 }], { pins: { amount: "DECIMAL(20,2)" } });
    expect(await db.all(`SELECT amount::VARCHAR AS v FROM _croft_typed_a ORDER BY _croft_seq`)).toEqual([{ v: "123456789012345678.12" }, { v: "7.00" }]);
    await db.load([{ amount: 12.5 }], { pins: { amount: "DECIMAL(15,2)" } });
    expect(await db.all(`SELECT amount::VARCHAR AS v FROM _croft_typed_a`)).toEqual([{ v: "12.50" }]);
  });

  test("a pin with a strptime format parses text, and refuses text that does not match", async () => {
    const db = await testDb();
    const ok = await db.load([{ day: "25/03/2026" }, { day: null }], { pins: { day: { type: "DATE", format: "%d/%m/%Y" } } });
    expect(ok.rows.map((r) => r.day)).toEqual(["2026-03-25", null]);
    expect(col(ok.batch, "day")).toMatchObject({ pinned: true, format: "%d/%m/%Y" });
    const e = await failure(db.load([{ day: "2026-03-25" }], { pins: { day: { type: "DATE", format: "%d/%m/%Y" } } }));
    expect(e.code).toBe("TYPE_PIN_VIOLATION");
  });

  test("a VARCHAR pin keeps objects as JSON text; a JSON pin keeps strings as JSON", async () => {
    const db = await testDb();
    const { rows, types } = await db.load([{ v: { b: 1, a: 2 }, j: "s" }], { pins: { v: "VARCHAR", j: "JSON" } });
    expect(types).toMatchObject({ v: "VARCHAR", j: "JSON" });
    expect(rows[0]).toMatchObject({ v: `{"a":2,"b":1}`, j: "s" });
  });

  test("a pin by source name applies to the cleaned column", async () => {
    const db = await testDb();
    const { types } = await db.load([{ "Price ($)": 5 }], { pins: { "Price ($)": "DOUBLE" } });
    expect(types.Price).toBe("DOUBLE");
  });

  test("BOOLEAN pins refuse anything but true and false", async () => {
    const db = await testDb();
    const e = await failure(db.load([{ f: true }, { f: "t" }, { f: 1 }], { pins: { f: "BOOLEAN" } }));
    expect(e.code).toBe("TYPE_PIN_VIOLATION");
    expect(e.problem.details?.badRows).toBe(2);
  });
});

describe("cursor", () => {
  const cursorOf = async (rows: Record<string, unknown>[], cursor: { field: string; unit?: "s" | "ms"; type?: CursorType }, known: KnownColumn[] = []) => {
    const db = await testDb();
    return db.load(rows, { cursor, knownColumns: known });
  };

  test("types from the typed column: timestamp, date, integer with unit, string", async () => {
    expect((await cursorOf([{ t: "2024-01-01T00:00:00Z" }], { field: "t" })).batch.cursor?.type).toBe("timestamp");
    expect((await cursorOf([{ t: "2024-01-01T00:00:00" }], { field: "t" })).batch.cursor?.type).toBe("timestamp");
    expect((await cursorOf([{ d: "2024-01-01" }], { field: "d" })).batch.cursor?.type).toBe("date");
    const epoch = await cursorOf([{ created: 1700000000 }, { created: 1700000100 }], { field: "created", unit: "s" });
    expect(epoch.batch.cursor).toEqual({ field: "created", type: "integer", unit: "s", rawTextColumn: CURSOR_TEXT });
    expect(epoch.rows.map((r) => r[CURSOR_TEXT])).toEqual(["1700000000", "1700000100"]);
    expect((await cursorOf([{ id: "abc" }], { field: "id" })).batch.cursor?.type).toBe("string");
  });

  test("the field resolves by source name and case", async () => {
    const r = await cursorOf([{ "Updated At": "2024-01-01T00:00:00Z" }], { field: "Updated At" });
    expect(r.batch.cursor?.field).toBe("Updated_At");
    expect((await cursorOf([{ UpdatedAt: "2024-01-01T00:00:00Z" }], { field: "updatedat" })).batch.cursor?.field).toBe("UpdatedAt");
  });

  test("CURSOR_TYPE_MISMATCH for unusable columns, a unit on a non-integer, or a changed type", async () => {
    expect((await failure(cursorOf([{ x: 1.5 }], { field: "x" }))).code).toBe("CURSOR_TYPE_MISMATCH");
    expect((await failure(cursorOf([{ x: true }], { field: "x" }))).code).toBe("CURSOR_TYPE_MISMATCH");
    expect((await failure(cursorOf([{ x: "2024-01-01T00:00:00Z" }], { field: "x", unit: "s" }))).code).toBe("CURSOR_TYPE_MISMATCH");
    expect((await failure(cursorOf([{ x: "abc" }], { field: "x", type: "timestamp" }))).code).toBe("CURSOR_TYPE_MISMATCH");
    const widened = await cursorOf([{ x: "2024-01-01T10:00:00Z" }], { field: "x", type: "date" }, [known("x", "DATE")]);
    expect(widened.batch.cursor?.type).toBe("timestamp"); // DATE → TIMESTAMPTZ keeps the cursor ordered
  });

  test("UNKNOWN_COLUMN when rows lack the field, with a suggestion; zero rows is no cursor", async () => {
    const e = await failure(cursorOf([{ updated: "2024-01-01T00:00:00Z" }], { field: "updated_at" }));
    expect(e.code).toBe("UNKNOWN_COLUMN");
    expect(e.problem.details?.suggestion).toBe("updated");
    expect((await cursorOf([], { field: "updated_at" })).batch.cursor).toBeUndefined();
    const knownEmpty = await cursorOf([], { field: "t" }, [known("t", "TIMESTAMPTZ")]);
    expect(knownEmpty.batch.cursor?.type).toBe("timestamp");
    expect(knownEmpty.types[CURSOR_TEXT]).toBe("VARCHAR");
  });
});

describe("castExpr and lossExpr (shared with file ingests)", () => {
  const check = async (text: string | null, type: string, format?: string) => {
    const db = await testDb("America/New_York");
    const t = text === null ? "NULL::VARCHAR" : `'${text.replaceAll("'", "''")}'`;
    const typed = castExpr(t, type, { format });
    const [r] = await db.all(`SELECT CAST(${typed} AS VARCHAR) AS v, ${lossExpr(t, typed, type, { format })} AS lost`);
    return r as { v: string | null; lost: boolean };
  };

  test.each([
    ["1.7", "BIGINT", true], ["2", "BIGINT", false], ["02134", "BIGINT", true], ["+12", "BIGINT", false],
    ["0x10", "BIGINT", true], ["1_000", "BIGINT", true], [" 12", "BIGINT", true], ["1e3", "BIGINT", false],
    ["9007199254740993", "DOUBLE", true], ["9007199254740992", "DOUBLE", false], ["0.1", "DOUBLE", false], ["1e300", "DOUBLE", false],
    ["1.005", "DECIMAL(18,2)", true], ["1.25", "DECIMAL(18,2)", false], ["1e-30", "DECIMAL(18,2)", true], ["0", "DECIMAL(18,2)", false],
    ["12345678901234567890", "HUGEINT", false], ["true", "BOOLEAN", false], ["t", "BOOLEAN", true], ["yes", "BOOLEAN", true],
    ["2024-01-01T10:00:00+02:00", "TIMESTAMP", true], ["2024-01-01T10:00:00Z", "TIMESTAMP", false], ["2024-01-01T10:00:00", "TIMESTAMP", false],
    ["2024-01-01", "TIMESTAMP", false], ["2024-01-01T10:00:00", "DATE", true], ["2024-01-01", "DATE", false],
    ["2024-01-01T10:00:00", "TIMESTAMPTZ", false], ["2024-01-01", "TIMESTAMPTZ", false], ["garbage", "TIMESTAMPTZ", true],
    ["anything", "VARCHAR", false], [null, "BIGINT", false],
  ] as const)("%p → %s: lost = %p", async (text, type, lost) => {
    expect((await check(text, type)).lost).toBe(lost);
  });

  test("money format: currency, groups and accounting negatives", async () => {
    expect(await check("$1,234.50", "DECIMAL(18,2)", "money")).toEqual({ v: "1234.50", lost: false });
    expect(await check("($3.00)", "DECIMAL(18,2)", "money")).toEqual({ v: "-3.00", lost: false });
    expect(await check("-$5", "DECIMAL(18,2)", "money")).toEqual({ v: "-5.00", lost: false });
    expect(await check("$1.005", "DECIMAL(18,2)", "money")).toMatchObject({ lost: true });
  });

  test("date formats parse with strptime and a mismatch is a loss", async () => {
    expect(await check("03/25/2026", "DATE", "%m/%d/%Y")).toEqual({ v: "2026-03-25", lost: false });
    expect(await check("25/03/2026", "DATE", "%m/%d/%Y")).toEqual({ v: null, lost: true });
  });

  test.each([
    ["4.35", "DOUBLE", false], ["0.30000000000000004", "DOUBLE", false], ["5e-324", "DOUBLE", false], ["1e+21", "DOUBLE", false],
    ["1152921504606846976", "DOUBLE", false], // 2^60 is exact in a DOUBLE
    ["3.14159265358979323846", "DOUBLE", true], // CSV text with more digits than a DOUBLE holds
    ["2.50", "DOUBLE", false], ["-0", "DOUBLE", false], ["1.0", "BIGINT", false], ["12345678901234567890123.5", "DOUBLE", true],
  ] as const)("no false losses: %p → %s: lost = %p", async (text, type, lost) => {
    expect((await check(text, type)).lost).toBe(lost);
  });

  test("DuckDB casts DOUBLE → DECIMAL from the binary value, which is why numbers compare as canonical text", async () => {
    const db = await testDb();
    expect(await db.all(`SELECT 4.35::DOUBLE::DECIMAL(38,18)::VARCHAR AS dec, 4.35::DOUBLE::VARCHAR AS txt`))
      .toEqual([{ dec: "4.349999999999999488", txt: "4.35" }]);
  });

  test("every JS double survives a DOUBLE column (random sample)", async () => {
    const db = await testDb();
    const values: number[] = [0.1 + 0.2, 1 / 3, Math.PI, 5e-324, 1.7976931348623157e308, -1e-300, 123456.78901234567];
    const buf = new Float64Array(1);
    const bits = new BigUint64Array(buf.buffer);
    // Doubles at or beyond 2^53 are integers that JS prints rounded (330241567007236416 as ...400); the loss
    // check refuses those on purpose (next test), so the sample skips them.
    const push = (v: number) => {
      if (Number.isFinite(v) && !(Number.isInteger(v) && !Number.isSafeInteger(v))) values.push(v);
    };
    while (values.length < 3000) {
      bits[0] = BigInt.asUintN(64, BigInt(Math.floor(Math.random() * 2 ** 53)) * 2048n + BigInt(Math.floor(Math.random() * 2048)));
      push(buf[0]!);
      push((Math.random() - 0.5) * 10 ** Math.floor(Math.random() * 40 - 20));
    }
    const { batch } = await db.load(values.map((x) => ({ x })), { knownColumns: [known("x", "DOUBLE")] });
    expect(batch.rows).toBe(values.length);
    const back = await db.all(`SELECT x FROM _croft_typed_a ORDER BY _croft_seq`);
    expect(back.map((r) => r.x)).toEqual(values);
  });

  test("integers beyond 2^53 as JS numbers: exact text passes, JS's rounded text is refused (UNSAFE_INTEGER explains)", async () => {
    const db = await testDb();
    // 1.5e17 prints as its exact digits; 2 ** 60 prints as 1152921504606847000, 24 away from the double's value.
    // From a lossless API parse that same text would be a real change, so it is refused either way.
    const ok = await db.load([{ x: 1.5e17 }, { x: 0.5 }], { knownColumns: [known("x", "DOUBLE")] });
    expect(ok.batch.warnings.map((w) => w.code)).toEqual(["UNSAFE_INTEGER"]);
    const e = await failure(db.load([{ x: 2 ** 60 }, { x: 0.5 }], { knownColumns: [known("x", "DOUBLE")] }));
    expect(e.code).toBe("TYPE_CONFLICT");
    expect(e.problem.details).toMatchObject({ samples: [{ row: 1, value: "1152921504606847000", typed: "1.152921504606847e+18" }] });
  });

  test("numCanon: exact canonical numbers at any magnitude", async () => {
    const db = await testDb();
    const texts = ["1.50", "15e-1", "+1.5", "0001.5000", "-0.0", "0", "1e21", "1000000000000000000000", "-12.340e2", "5e-324", ".5", "5."];
    const got = await db.all(`SELECT v, ${numCanon("v")} AS c FROM (SELECT unnest([${texts.map((t) => `'${t}'`).join(", ")}]) AS v)`);
    expect(Object.fromEntries(got.map((r) => [r.v, r.c]))).toEqual({
      "1.50": "15e-1", "15e-1": "15e-1", "+1.5": "15e-1", "0001.5000": "15e-1", "-0.0": "0", "0": "0", "1e21": "1e21",
      "1000000000000000000000": "1e21", "-12.340e2": "-1234e0", "5e-324": "5e-324", ".5": "5e-1", "5.": "5e0",
    });
  });

  test("casts read the text, never the JSON value", () => {
    expect(castExpr(`(v->>'$')`, "DECIMAL(18,2)", { json: "v" })).toBe(`TRY_CAST((v->>'$') AS DECIMAL(18,2))`);
    expect(castExpr(`(v->>'$')`, "JSON", { json: "v" })).toBe("v");
  });
});

describe("inside a real warehouse write lease", () => {
  test("the sandbox lets read_json reach .croft/staging, and the batch commits with the write", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-cast-wh-")));
    const stateDir = join(root, ".croft");
    mkdirSync(join(root, "files"));
    mkdirSync(stateDir);
    const w = openWarehouse({ path: join(root, "warehouse.duckdb"), mode: "read_write", timezone: "UTC", root, stateDir, isTTY: false, register: false });
    const manifest = await writeStage({
      dir: join(stateDir, "staging", "r_1", "orders"), asset: "orders", runId: "r_1", source: [{ id: 1, amount: 2.5, at: "2024-01-01T00:00:00Z" }],
    });
    const out = await w.write("orders", async (tx) => {
      const b = await buildTypedBatch(tx, { manifest, knownColumns: [], cursor: { field: "at" } });
      await tx.exec(`CREATE TABLE orders AS SELECT * EXCLUDE (_croft_seq, ${CURSOR_TEXT}) FROM ${ident(b.temp)}`);
      return tx.all(`SELECT id, amount, "at" FROM orders`); // AT is a reserved keyword: kept, but quoted (§7)
    }, { runId: "r_1" });
    expect(out).toEqual([{ id: 1, amount: 2.5, at: "2024-01-01T00:00:00.000000Z" }]);

    // Staging outside the project's allowed directories is refused by the sandbox.
    const outside = join(realpathSync(mkdtempSync(join(tmpdir(), "croft-outside-"))), "s");
    const elsewhere = await writeStage({ dir: outside, asset: "orders", runId: "r_2", source: [{ id: 2 }] });
    const err = await w.write("orders", (tx) => buildTypedBatch(tx, { manifest: elsewhere, knownColumns: [] }), { runId: "r_2" }).catch((e) => e);
    expect(String(err)).toContain("Permission Error");
    await w.close();
  });
});
