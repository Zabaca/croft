import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import type { Sql } from "../core/types.ts";
import { closeAllWarehouses, type DuckWarehouse, openWarehouse } from "../db/warehouse.ts";
import { cursorTypeFor, DEFAULT_TIMESTAMP_LOOKBACK_MS, detectSinceIgnored, effectiveLookbackMs, nextCursor, parseFrom, renderSince,
  resolveCursorType, validateCursorSpec, zonedWallToInstant } from "./cursor.ts";

afterAll(() => closeAllWarehouses());

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

function thrown(fn: () => unknown): CroftError {
  try {
    fn();
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
  throw new Error("expected a CroftError");
}

describe("cursor type", () => {
  test("follows the column type", () => {
    expect(cursorTypeFor("TIMESTAMP WITH TIME ZONE")).toBe("timestamp");
    expect(cursorTypeFor("TIMESTAMP")).toBe("timestamp");
    expect(cursorTypeFor("DATE")).toBe("date");
    expect(cursorTypeFor("BIGINT")).toBe("integer");
    expect(cursorTypeFor("HUGEINT")).toBe("integer");
    expect(cursorTypeFor("VARCHAR")).toBe("string");
    expect(cursorTypeFor("DOUBLE")).toBeNull();
    expect(cursorTypeFor("JSON")).toBeNull();
    expect(cursorTypeFor("BOOLEAN")).toBeNull();
  });

  test("is fixed on the first load; only date → timestamp may follow a widened column", () => {
    expect(resolveCursorType({ field: "created", columnType: "BIGINT", unit: "s" })).toBe("integer");
    expect(resolveCursorType({ field: "day", columnType: "TIMESTAMPTZ", saved: "date" })).toBe("timestamp");
    expect(thrown(() => resolveCursorType({ field: "id", columnType: "VARCHAR", saved: "integer" })).code).toBe("CURSOR_TYPE_MISMATCH");
    expect(thrown(() => resolveCursorType({ field: "score", columnType: "DOUBLE" })).code).toBe("CURSOR_TYPE_MISMATCH");
    expect(thrown(() => resolveCursorType({ field: "updated_at", columnType: "TIMESTAMPTZ", unit: "s" })).code).toBe("CURSOR_TYPE_MISMATCH");
  });

  test("validate reports lookback and unit misuse as CURSOR_TYPE_MISMATCH", () => {
    const codes = (o: Parameters<typeof validateCursorSpec>[0]) => validateCursorSpec(o).map((p) => [p.code, p.message]);
    expect(codes({ asset: "a", field: "id", type: "integer", lookbackMs: DAY })).toEqual([
      ["CURSOR_TYPE_MISMATCH", "cursor id holds plain integers, so a lookback has no unit to subtract"],
    ]);
    expect(codes({ asset: "a", field: "name", type: "string", lookbackMs: DAY })).toHaveLength(1);
    expect(codes({ asset: "a", field: "updated_at", type: "timestamp", unit: "s" })).toHaveLength(1);
    expect(codes({ asset: "a", field: "score", columnType: "DOUBLE" })).toHaveLength(1);
    expect(codes({ asset: "a", field: "created", type: "integer", unit: "s", lookbackMs: 30 * DAY })).toEqual([]);
    expect(codes({ asset: "a", field: "updated_at", type: "timestamp", lookbackMs: MIN })).toEqual([]);
    expect(codes({ asset: "a", field: "updated_at" })).toEqual([]);
    const [p] = validateCursorSpec({ asset: "a", field: "id", columnType: "BIGINT", lookbackMs: DAY, file: "assets/a.ts" });
    expect(p!.fix).toMatchObject({ kind: "edit", file: "assets/a.ts" });
    expect(p!.severity).toBe("error");
  });
});

describe("renderSince: the saved value minus lookback, in its own form", () => {
  const ts = (saved: string, lookbackMs: number, keyed = false) => renderSince(saved, { type: "timestamp", lookbackMs, keyed });

  test("Z keeps Z", () => {
    expect(ts("2026-09-22T17:58:03Z", 30 * DAY)).toBe("2026-08-23T17:58:03Z");
    expect(ts("2026-09-22T17:58:03Z", 0)).toBe("2026-09-22T17:58:03Z");
  });

  test("a keyed timestamp cursor re-reads 1 second by default", () => {
    expect(DEFAULT_TIMESTAMP_LOOKBACK_MS).toBe(1000);
    expect(ts("2026-09-22T17:58:03Z", 0, true)).toBe("2026-09-22T17:58:02Z");
    expect(effectiveLookbackMs({ type: "timestamp", keyed: true })).toBe(1000);
    expect(effectiveLookbackMs({ type: "date", keyed: true })).toBe(0);
    expect(effectiveLookbackMs({ type: "integer", keyed: true })).toBe(0);
    expect(effectiveLookbackMs({ type: "timestamp", keyed: false })).toBe(0);
    expect(effectiveLookbackMs({ type: "timestamp", keyed: true, lookbackMs: 5 * MIN })).toBe(5 * MIN);
  });

  test("+02:00 keeps its offset, across midnight too", () => {
    expect(ts("2026-09-22T19:58:03+02:00", HOUR)).toBe("2026-09-22T18:58:03+02:00");
    expect(ts("2026-09-22T00:30:00+02:00", HOUR)).toBe("2026-09-21T23:30:00+02:00");
    expect(ts("2026-09-22T00:30:00-0700", 10 * MIN)).toBe("2026-09-22T00:20:00-0700");
    expect(ts("2026-09-22 17:58:03+00", 1000)).toBe("2026-09-22 17:58:02+00");
  });

  test("a naive value stays naive", () => {
    expect(ts("2026-09-22T17:58:03", 10 * MIN)).toBe("2026-09-22T17:48:03");
    expect(ts("2026-03-01T00:00:00", DAY)).toBe("2026-02-28T00:00:00");
  });

  test("fractional precision is kept, rounding down", () => {
    expect(ts("2026-09-22T17:58:03.123Z", 1000)).toBe("2026-09-22T17:58:02.123Z");
    expect(ts("2026-09-22T17:58:03.123456+02:00", 1)).toBe("2026-09-22T17:58:03.122456+02:00");
    expect(ts("2026-09-22T17:58:03.5Z", 1500)).toBe("2026-09-22T17:58:02.0Z");
    expect(ts("2026-09-22T17:58:03Z", 1500)).toBe("2026-09-22T17:58:01Z");
    expect(ts("2026-09-22T17:58Z", 30_000)).toBe("2026-09-22T17:57Z");
    expect(ts("2026-09-22T17:58:03.123456789Z", 1000)).toBe("2026-09-22T17:58:02.123456000Z");
  });

  test("dates stay dates", () => {
    expect(renderSince("2026-09-22", { type: "date", lookbackMs: 30 * DAY })).toBe("2026-08-23");
    expect(renderSince("2026-09-22", { type: "date", lookbackMs: 12 * HOUR })).toBe("2026-09-21");
    expect(renderSince("2026-09-22", { type: "date", keyed: true })).toBe("2026-09-22");
  });

  test("epoch cursors give numbers in their unit", () => {
    expect(renderSince("1726000000", { type: "integer", unit: "s", lookbackMs: 30 * DAY })).toBe(1726000000 - 30 * 86400);
    expect(renderSince("1726000000", { type: "integer", unit: "s", lookbackMs: 1500 })).toBe(1725999998);
    expect(renderSince("1726000000000", { type: "integer", unit: "ms", lookbackMs: 1000 })).toBe(1725999999000);
    expect(renderSince("1726000000", { type: "integer", unit: "s" })).toBe(1726000000);
    expect(renderSince("42", { type: "integer", keyed: true })).toBe(42);
  });

  test("integers beyond 2^53 come back as exact text", () => {
    expect(renderSince("12345678901234567890", { type: "integer" })).toBe("12345678901234567890");
  });

  test("lookback without arithmetic is CURSOR_TYPE_MISMATCH", () => {
    expect(thrown(() => renderSince("42", { type: "integer", lookbackMs: DAY, field: "id" })).message).toBe("cursor id holds plain integers, so a lookback has no unit to subtract");
    expect(thrown(() => renderSince("abc", { type: "string", lookbackMs: DAY })).code).toBe("CURSOR_TYPE_MISMATCH");
    expect(renderSince("abc", { type: "string", keyed: true })).toBe("abc");
    expect(thrown(() => renderSince("not a time", { type: "timestamp", lookbackMs: 1 })).code).toBe("CURSOR_TYPE_MISMATCH");
  });
});

describe("parseFrom", () => {
  const LA = "America/Los_Angeles";
  const now = new Date("2026-09-22T17:00:00Z"); // 10:00 in Los Angeles
  const from = (input: string, type: "timestamp" | "date" | "integer" | "string", o: { unit?: "s" | "ms"; template?: string; timezone?: string } = {}) =>
    parseFrom(input, { type, now, timezone: o.timezone ?? LA, unit: o.unit, template: o.template });
  const epoch = (iso: string) => Date.parse(iso) / 1000;

  test("a date is midnight in the project time zone, converted to the cursor's type and echoed", () => {
    expect(from("2026-06-24", "integer", { unit: "s" })).toEqual({ since: epoch("2026-06-24T07:00:00Z"), instant: "2026-06-24T00:00:00-07:00" });
    expect(from("2026-06-24", "integer", { unit: "ms" })).toEqual({ since: epoch("2026-06-24T07:00:00Z") * 1000, instant: "2026-06-24T00:00:00-07:00" });
    expect(from("2026-06-24", "date")).toEqual({ since: "2026-06-24", instant: "2026-06-24T00:00:00-07:00" });
    expect(from("2026-06-24", "timestamp")).toEqual({ since: "2026-06-24T07:00:00Z", instant: "2026-06-24T00:00:00-07:00" });
    expect(from("2026-06-24", "timestamp", { timezone: "UTC" })).toEqual({ since: "2026-06-24T00:00:00Z", instant: "2026-06-24T00:00:00+00:00" });
  });

  test("timestamps copy the saved cursor's form", () => {
    expect(from("2026-06-24", "timestamp", { template: "2026-09-22T17:58:03+02:00" }).since).toBe("2026-06-24T09:00:00+02:00");
    expect(from("2026-06-24", "timestamp", { template: "2026-09-22T17:58:03.123" }).since).toBe("2026-06-24T00:00:00.000");
    expect(from("2026-06-24", "timestamp", { template: "2026-09-22 17:58:03+00" }).since).toBe("2026-06-24 07:00:00+00");
    expect(from("2026-06-24T10:00:00Z", "timestamp", { template: "2026-09-22T17:58:03Z" }).since).toBe("2026-06-24T10:00:00Z");
  });

  test("full ISO values: an offset is an instant; a naive time is read in the project zone", () => {
    expect(from("2026-06-24T10:00:00Z", "integer", { unit: "s" }).since).toBe(epoch("2026-06-24T10:00:00Z"));
    expect(from("2026-06-24T10:00:00+02:00", "integer", { unit: "s" }).since).toBe(epoch("2026-06-24T08:00:00Z"));
    expect(from("2026-06-24T10:00:00", "integer", { unit: "s" })).toEqual({ since: epoch("2026-06-24T17:00:00Z"), instant: "2026-06-24T10:00:00-07:00" });
    expect(from("2026-06-24T10:00:00", "date").since).toBe("2026-06-24");
  });

  test("relative values count back from now", () => {
    expect(from("-90d", "integer", { unit: "s" }).since).toBe(epoch("2026-06-24T17:00:00Z"));
    expect(from("-12h", "timestamp").since).toBe("2026-09-22T05:00:00Z");
    expect(from("-12h", "date").since).toBe("2026-09-21");                   // 22:00 the evening before, in LA
    expect(from("-30m", "integer", { unit: "ms" }).since).toBe(Date.parse("2026-09-22T16:30:00Z"));
    expect(from("-2w", "date").since).toBe("2026-09-08");
    expect(from("- 90 days", "date").since).toBe("2026-06-24");
  });

  test("today is midnight today in the project zone", () => {
    expect(from("today", "date")).toEqual({ since: "2026-09-22", instant: "2026-09-22T00:00:00-07:00" });
    expect(from("today", "timestamp").since).toBe("2026-09-22T07:00:00Z");
    expect(from("TODAY", "integer", { unit: "s" }).since).toBe(epoch("2026-09-22T07:00:00Z"));
    expect(parseFrom("today", { type: "date", now: new Date("2026-09-23T05:00:00Z"), timezone: LA }).since).toBe("2026-09-22");
  });

  test("midnight across DST changes", () => {
    expect(from("2026-03-08", "timestamp").since).toBe("2026-03-08T08:00:00Z");
    expect(from("2026-03-09", "timestamp").since).toBe("2026-03-09T07:00:00Z");
    expect(from("2026-11-01", "timestamp").since).toBe("2026-11-01T07:00:00Z");
    expect(from("2026-11-02", "timestamp").since).toBe("2026-11-02T08:00:00Z");
    const wall = (iso: string) => BigInt(Date.parse(iso)) * 1000n;
    // 02:30 does not exist on 2026-03-08 in Los Angeles: it moves forward to 03:30 PDT.
    expect(zonedWallToInstant(wall("2026-03-08T02:30:00Z"), LA)).toBe(wall("2026-03-08T10:30:00Z"));
    // 01:30 happens twice on 2026-11-01: the first one (PDT) is taken.
    expect(zonedWallToInstant(wall("2026-11-01T01:30:00Z"), LA)).toBe(wall("2026-11-01T08:30:00Z"));
    expect(zonedWallToInstant(wall("2026-11-01T03:00:00Z") + 1n, LA)).toBe(wall("2026-11-01T11:00:00Z") + 1n);
    // A zone whose DST starts at midnight: 2026-03-29 00:00 does not exist in Asia/Beirut; it becomes 01:00.
    expect(zonedWallToInstant(wall("2026-03-29T00:00:00Z"), "Asia/Beirut")).toBe(wall("2026-03-28T22:00:00Z"));
  });

  test("string and plain integer cursors", () => {
    expect(from("abc-123", "string")).toEqual({ since: "abc-123" });
    expect(from("12345", "integer")).toEqual({ since: 12345 });
    expect(from("1750748400", "integer", { unit: "s" })).toEqual({ since: 1750748400 });
    expect(thrown(() => from("2026-06-24", "integer")).code).toBe("CURSOR_TYPE_MISMATCH");
  });

  test("anything else is a usage error that lists the accepted forms", () => {
    for (const bad of ["", "yesterday-ish", "2026-13-01", "-90", "+90d", "2026-02-30"]) {
      const e = thrown(() => from(bad, "timestamp"));
      expect(e.code).toBe("USAGE_ERROR");
      expect(e.problem.hint).toContain("-90d");
    }
  });
});

describe("typed maximum in DuckDB", () => {
  function warehouse(): DuckWarehouse {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-cursor-")));
    mkdirSync(join(root, ".croft"));
    return openWarehouse({ path: join(root, "warehouse.duckdb"), mode: "read_write", timezone: "UTC", root, stateDir: join(root, ".croft"), register: false, isTTY: false });
  }
  const w = warehouse();
  let n = 0;
  async function withBatch<T>(type: string, rows: [unknown, string | null][], fn: (tx: Sql, temp: string) => Promise<T>, rawType = "VARCHAR"): Promise<T> {
    return w.write("c", async (tx) => {
      const temp = `c_${++n}`;
      await tx.exec(`CREATE TEMP TABLE ${temp} (v ${type}, raw ${rawType}, _croft_seq BIGINT)`);
      for (const [i, [v, raw]] of rows.entries()) await tx.exec(`INSERT INTO temp.main.${temp} VALUES ($1, $2, $3)`, [v, raw, i + 1]);
      return fn(tx, temp);
    }, { runId: "r" });
  }
  const next = (type: string, rows: [unknown, string | null][], saved: string | null, rawType?: string) =>
    withBatch(type, rows, (tx, temp) => nextCursor(tx, { temp, field: "v", rawTextColumn: "raw", saved }), rawType);

  test("offsets compare as instants and the original text is kept", async () => {
    const rows: [unknown, string][] = [["2026-09-22T17:58:03Z", "2026-09-22T17:58:03Z"], ["2026-09-22T20:00:00+02:00", "2026-09-22T20:00:00+02:00"]];
    expect(await next("TIMESTAMPTZ", rows, null)).toEqual({ value: "2026-09-22T20:00:00+02:00", advanced: true, batchMax: "2026-09-22T20:00:00+02:00" });
    expect(await next("TIMESTAMPTZ", rows, "2026-09-22T19:00:00Z")).toEqual({ value: "2026-09-22T19:00:00Z", advanced: false, batchMax: "2026-09-22T20:00:00+02:00" });
    // A tie in another form keeps the saved text.
    expect((await next("TIMESTAMPTZ", rows, "2026-09-22T18:00:00Z")).value).toBe("2026-09-22T18:00:00Z");
  });

  test("ties inside the batch take the last row yielded", async () => {
    expect((await next("TIMESTAMPTZ", [["2026-09-22T18:00:00Z", "2026-09-22T18:00:00Z"], ["2026-09-22T20:00:00+02:00", "2026-09-22T20:00:00+02:00"]], null)).value)
      .toBe("2026-09-22T20:00:00+02:00");
  });

  test("integers compare numerically, strings lexically, and a JSON raw column is unwrapped", async () => {
    expect((await next("BIGINT", [[999, "999"], [1000, "1000"]], "998")).value).toBe("1000");
    expect((await next("BIGINT", [[999, "999"]], "1000")).advanced).toBe(false);
    expect((await next("VARCHAR", [["b", "b"], ["a", "a"]], "aa")).value).toBe("b");
    expect((await next("TIMESTAMPTZ", [["2026-09-22T17:58:03Z", '"2026-09-22T17:58:03Z"']], null, "JSON")).value).toBe("2026-09-22T17:58:03Z");
  });

  test("an empty or all-NULL batch leaves the cursor unchanged", async () => {
    expect(await next("TIMESTAMPTZ", [], "2026-09-22T17:58:03Z")).toEqual({ value: "2026-09-22T17:58:03Z", advanced: false, batchMax: null });
    expect(await next("TIMESTAMPTZ", [[null, null]], null)).toEqual({ value: null, advanced: false, batchMax: null });
  });

  test("a missing raw text falls back to the typed value's text", async () => {
    expect((await next("BIGINT", [[5, null]], null)).value).toBe("5");
  });

  test("a saved value the column cannot read is CURSOR_TYPE_MISMATCH", async () => {
    let e: unknown;
    try {
      await next("TIMESTAMPTZ", [["2026-09-22T17:58:03Z", "x"]], "not a timestamp");
    } catch (err) {
      e = err;
    }
    expect((e as CroftError).code).toBe("CURSOR_TYPE_MISMATCH");
  });

  test("SINCE_IGNORED compares typed values, epoch numbers included", async () => {
    const rows: [unknown, string][] = [[100, "100"], [200, "200"], [300, "300"], [5000, "5000"]];
    const p = await withBatch("BIGINT", rows, (tx, temp) => detectSinceIgnored(tx, { asset: "a", temp, field: "v", since: 1000 }));
    expect(p).toMatchObject({ code: "SINCE_IGNORED", severity: "warning", details: { older: 3, rows: 4, since: 1000 } });
    expect(await withBatch("BIGINT", rows, (tx, temp) => detectSinceIgnored(tx, { asset: "a", temp, field: "v", since: 250 }))).toBeNull();
    expect(await withBatch("TIMESTAMPTZ", [["2026-01-01T00:00:00Z", null]], (tx, temp) => detectSinceIgnored(tx, { asset: "a", temp, field: "v", since: "garbage" }))).toBeNull();
  });
});
