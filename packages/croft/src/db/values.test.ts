import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { openMemory } from "./connect.ts";
import { formatDate, formatInstant, offsetSeconds, renderRows, resultColumns, type RenderContext } from "./values.ts";

const LA = "America/Los_Angeles";
const dbs: { close(): void }[] = [];
afterAll(() => dbs.forEach((d) => d.close()));

async function conn(timezone = LA): Promise<DuckDBConnection> {
  const db = await openMemory({ timezone });
  dbs.push(db);
  return db.connect();
}

async function rows(sql: string, ctx: RenderContext, c?: DuckDBConnection) {
  const reader = await (c ?? (await conn(ctx.timezone))).runAndReadAll(sql);
  return renderRows(reader, ctx);
}

const json: RenderContext = { mode: "json", timezone: LA };
const ts: RenderContext = { mode: "ts", timezone: LA };

describe("json mode (§4.3)", () => {
  test("integers beyond ±2^53, HUGEINT and DECIMAL become strings", async () => {
    const [r] = await rows(`SELECT 42::BIGINT a, 9007199254740993::BIGINT b, -9007199254740993::BIGINT c,
      9007199254740991::BIGINT d, 7::HUGEINT e, 1.50::DECIMAL(10,2) f, 3::DECIMAL(38,0) g, 18446744073709551615::UBIGINT h,
      7::INTEGER i, 2.5::DOUBLE j, 'NaN'::DOUBLE k, 'inf'::DOUBLE l, true m, 'x' n`, json);
    expect(r).toEqual({ a: 42, b: "9007199254740993", c: "-9007199254740993", d: 9007199254740991, e: "7", f: "1.50",
      g: "3", h: "18446744073709551615", i: 7, j: 2.5, k: "NaN", l: "Infinity", m: true, n: "x" });
  });

  test("TIMESTAMPTZ renders in the project zone with its offset, across DST", async () => {
    const [r] = await rows(`SELECT
      TIMESTAMPTZ '2024-01-02T10:00:00Z' winter,
      TIMESTAMPTZ '2024-07-01T10:00:00Z' summer,
      TIMESTAMPTZ '2026-03-08T09:59:59Z' before_spring,
      TIMESTAMPTZ '2026-03-08T10:00:00Z' after_spring,
      TIMESTAMPTZ '2026-11-01T08:30:00Z' first_130,
      TIMESTAMPTZ '2026-11-01T09:30:00Z' second_130,
      TIMESTAMPTZ '2024-01-02T10:00:00.123456Z' micros,
      TIMESTAMPTZ '2024-01-02T10:00:00.5Z' millis`, json);
    expect(r).toEqual({
      winter: "2024-01-02T02:00:00-08:00",
      summer: "2024-07-01T03:00:00-07:00",
      before_spring: "2026-03-08T01:59:59-08:00",
      after_spring: "2026-03-08T03:00:00-07:00",
      first_130: "2026-11-01T01:30:00-07:00",
      second_130: "2026-11-01T01:30:00-08:00",
      micros: "2024-01-02T02:00:00.123456-08:00",
      millis: "2024-01-02T02:00:00.500-08:00",
    });
    // Every rendering parses back to the same instant.
    expect(new Date(r!.after_spring as string).toISOString()).toBe("2026-03-08T10:00:00.000Z");
    expect(new Date(r!.second_130 as string).toISOString()).toBe("2026-11-01T09:30:00.000Z");
  });

  test("the JSON day agrees with ::DATE in SQL", async () => {
    const [r] = await rows(`SELECT TIMESTAMPTZ '2024-01-02T03:00:00Z' t, (TIMESTAMPTZ '2024-01-02T03:00:00Z')::DATE d`, json);
    expect(r).toEqual({ t: "2024-01-01T19:00:00-08:00", d: "2024-01-01" });
    expect((r!.t as string).slice(0, 10)).toBe(r!.d as string);
  });

  test("half-hour and 30-minute-DST zones", async () => {
    for (const [tz, instant, expected] of [
      ["Asia/Kolkata", "2024-01-02T10:00:00Z", "2024-01-02T15:30:00+05:30"],
      ["America/St_Johns", "2024-07-01T10:00:00Z", "2024-07-01T07:30:00-02:30"],
      ["America/St_Johns", "2024-01-01T10:00:00Z", "2024-01-01T06:30:00-03:30"],
      ["Australia/Lord_Howe", "2024-01-01T00:00:00Z", "2024-01-01T11:00:00+11:00"],
      ["Australia/Lord_Howe", "2024-07-01T00:00:00Z", "2024-07-01T10:30:00+10:30"],
      ["UTC", "2024-07-01T00:00:00Z", "2024-07-01T00:00:00+00:00"],
      // St John's springs forward at 02:00 NST = 05:30 UTC, not on a UTC hour.
      ["America/St_Johns", "2026-03-08T05:29:59Z", "2026-03-08T01:59:59-03:30"],
      ["America/St_Johns", "2026-03-08T05:30:00Z", "2026-03-08T03:00:00-02:30"],
      // Lord Howe falls back by 30 minutes: 02:00 +11:00 = 15:00 UTC.
      ["Australia/Lord_Howe", "2026-04-04T14:59:59Z", "2026-04-05T01:59:59+11:00"],
      ["Australia/Lord_Howe", "2026-04-04T15:00:00Z", "2026-04-05T01:30:00+10:30"],
    ] as const) {
      const [r] = await rows(`SELECT TIMESTAMPTZ '${instant}' t`, { mode: "json", timezone: tz });
      expect(r!.t).toBe(expected);
    }
  });

  test("TIMESTAMP is naive ISO, DATE is YYYY-MM-DD, JSON is parsed", async () => {
    const [r] = await rows(`SELECT TIMESTAMP '2026-03-01 23:30:00.123456' a, TIMESTAMP '2026-03-01 23:30:00' b,
      DATE '2026-03-01' c, '{"k":[1,2,{"z":null}],"big":9007199254740993}'::JSON d, 'infinity'::TIMESTAMP e,
      '-infinity'::DATE f, DATE '0044-03-15' g, TIME '12:34:56.5' h`, json);
    expect(r).toEqual({ a: "2026-03-01T23:30:00.123456", b: "2026-03-01T23:30:00", c: "2026-03-01",
      d: { k: [1, 2, { z: null }], big: 9007199254740992 }, e: "infinity", f: "-infinity", g: "0044-03-15", h: "12:34:56.500" });
  });

  test("nested values render recursively", async () => {
    const [r] = await rows(`SELECT [TIMESTAMPTZ '2024-07-01T10:00:00Z'] l, {'a': 9007199254740993::BIGINT, 'j': '{"x":1}'::JSON} s,
      MAP {'k': 1.25::DECIMAL(5,2)} m, [1,2]::INTEGER[2] arr`, json);
    expect(r).toEqual({ l: ["2024-07-01T03:00:00-07:00"], s: { a: "9007199254740993", j: { x: 1 } },
      m: [{ key: "k", value: "1.25" }], arr: [1, 2] });
  });

  test("other types are strings DuckDB can cast back", async () => {
    const [r] = await rows(`SELECT '00000000-0000-0000-0000-000000000001'::UUID u, INTERVAL 2 DAY i, '\\xAA'::BLOB b`, json);
    expect(r!.u).toBe("00000000-0000-0000-0000-000000000001");
    expect(typeof r!.i).toBe("string");
    expect(r!.b).toBe("\\xAA");
  });

  test("column names and types", async () => {
    const c = await conn();
    const reader = await c.runAndReadAll(`SELECT 1::BIGINT a, '{}'::JSON j, 1.5::DECIMAL(4,1) d, 2 a`);
    expect(resultColumns(reader)).toEqual([
      { name: "a", type: "BIGINT" }, { name: "j", type: "JSON" }, { name: "d", type: "DECIMAL(4,1)" }, { name: "a:1", type: "INTEGER" },
    ]);
  });
});

describe("ts mode (§3e)", () => {
  test("timestamps are ISO strings with microseconds", async () => {
    const [r] = await rows(`SELECT TIMESTAMPTZ '2026-03-01T07:30:00.123456Z' tz, TIMESTAMP '2026-03-01 23:30:00.123456' naive,
      TIMESTAMP '2026-03-01 23:30:00' whole, TIMESTAMPTZ '2026-03-01T07:30:00Z' tzwhole, DATE '2026-03-01' d`, ts);
    expect(r).toEqual({ tz: "2026-03-01T07:30:00.123456Z", naive: "2026-03-01T23:30:00.123456",
      whole: "2026-03-01T23:30:00.000000", tzwhole: "2026-03-01T07:30:00.000000Z", d: "2026-03-01" });
  });

  test("integers: number, or bigint beyond ±2^53; HUGEINT and DECIMAL(38,0) are bigint", async () => {
    const [r] = await rows(`SELECT 42::BIGINT a, 9007199254740993::BIGINT b, 5::HUGEINT c,
      170141183460469231731687303715884105727::HUGEINT d, 12::DECIMAL(38,0) e, 1.5::DECIMAL(10,2) f, 7::INTEGER g`, ts);
    expect(r).toEqual({ a: 42, b: 9007199254740993n, c: 5n, d: 170141183460469231731687303715884105727n, e: 12n, f: 1.5, g: 7 });
  });

  test("JSON is parsed, keeping unsafe integers exact", async () => {
    const [r] = await rows(`SELECT '{"big":9007199254740993,"small":3,"f":1.5}'::JSON j`, ts);
    expect(r!.j).toEqual({ big: 9007199254740993n, small: 3, f: 1.5 });
  });

  test("HUGEINT survives a Parquet snapshot as DECIMAL(38,0) and arrives as bigint", async () => {
    const state = mkdtempSync(join(tmpdir(), "croft-values-"));
    const db = await openMemory({ timezone: LA, stateDir: state });
    dbs.push(db);
    const c = await db.connect();
    const file = join(realpathSync(state), "in-h.parquet");
    // DECIMAL(38,0) holds 38 digits; HUGEINT's extremes (39 digits) do not fit.
    await c.run(`COPY (SELECT 99999999999999999999999999999999999999::HUGEINT::DECIMAL(38,0) v) TO '${file}' (FORMAT parquet)`);
    const [r] = await rows(`SELECT v FROM read_parquet('${file}')`, ts, c);
    expect(r!.v).toBe(99999999999999999999999999999999999999n);
  });
});

test("offsets match DuckDB's ICU for random instants in several zones", async () => {
  // Not Africa/Casablanca: its future Ramadan rules differ between DuckDB's bundled ICU data and the
  // runtime's (2045-12-01: DuckDB +01:00, Bun +00:00).
  for (const tz of [LA, "Europe/London", "Asia/Kolkata", "America/St_Johns", "Australia/Lord_Howe", "Pacific/Chatham", "America/Sao_Paulo"]) {
    const c = await conn(tz);
    // 1901..2099, random seconds; DuckDB computes the wall clock and offset itself.
    const reader = await c.runAndReadAll(`SELECT epoch_us(t)::BIGINT us, strftime(t, '%Y-%m-%dT%H:%M:%S') wall,
      date_part('timezone', t)::INTEGER tzoff
      FROM (SELECT make_timestamptz(((random() * 6.2e9) - 2.1e9)::BIGINT * 1000000) t FROM range(400))`);
    for (const [us, wall, off] of reader.getRowsJS() as [bigint, string, number][]) {
      const expected = `${wall}${off < 0 ? "-" : "+"}${String(Math.floor(Math.abs(off) / 3600)).padStart(2, "0")}:${String(Math.floor((Math.abs(off) % 3600) / 60)).padStart(2, "0")}`;
      if (Math.abs(off) % 60 !== 0) continue; // pre-standard-time local mean time; ISO has no seconds offset
      expect(formatInstant(us, { mode: "json", timezone: tz })).toBe(expected);
    }
  }
});

test("offsetSeconds and formatDate edge cases", () => {
  expect(offsetSeconds(LA, Date.UTC(2024, 0, 1))).toBe(-8 * 3600);
  expect(offsetSeconds(LA, Date.UTC(2024, 6, 1))).toBe(-7 * 3600);
  // Years 0–99 must not be read as 1900–1999.
  expect(offsetSeconds("Asia/Kolkata", Date.parse("0050-06-01T00:00:00Z"))).toBe(offsetSeconds("Asia/Kolkata", Date.parse("0051-06-01T00:00:00Z")));
  // Before standard time, Los Angeles used local mean time, an offset with seconds.
  expect(formatInstant(BigInt(Date.parse("1850-01-01T00:00:00Z")) * 1000n, { mode: "json", timezone: LA })).toBe("1849-12-31T16:07:02-07:52:58");
  expect(formatDate(0)).toBe("1970-01-01");
  expect(formatDate(-1)).toBe("1969-12-31");
  expect(formatDate(19783)).toBe("2024-03-01");
  expect(formatDate(2932897)).toBe("+010000-01-01");
  expect(formatDate(-719529)).toBe("-000001-12-31");
});
