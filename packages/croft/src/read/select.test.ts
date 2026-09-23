import { describe, expect, test } from "bun:test";
import { CroftError } from "../core/errors.ts";
import { mapQueryError, toDuck, wireSafe } from "./select.ts";
import { stringifyLossless, tooManyRows } from "./wire.ts";

describe("wireSafe", () => {
  test("in-process rows equal their JSON round trip", () => {
    const rows = [
      { a: -0, b: [1, -0, { c: -0 }], d: 12n, e: "x", f: null, g: true, h: { i: [2n] } },
      JSON.parse('{"__proto__": {"x": -1}, "n": 1}'),
    ];
    for (const r of rows) wireSafe(r);
    expect(rows).toStrictEqual(JSON.parse(JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v))));
    expect(Object.is(rows[0]!.a, 0)).toBe(true);
    expect(Object.hasOwn(rows[1], "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe("params", () => {
  test("toDuck binds like the warehouse: Dates as ISO instants, plain objects as lossless JSON", () => {
    expect(toDuck(undefined)).toBeNull();
    expect(toDuck(5)).toBe(5);
    expect(toDuck(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01T00:00:00.000Z");
    expect(toDuck({ big: 9007199254740993n })).toBe('{"big":9007199254740993}');
  });

  test("stringifyLossless keeps bigint digits", () => {
    expect(stringifyLossless([1n, 2 ** 53, { x: -123456789012345678901234567890n }])).toBe("[1,9007199254740992,{\"x\":-123456789012345678901234567890}]");
  });
});

describe("errors", () => {
  test("QUERY_TOO_MANY_ROWS names the limit", () => {
    const e = tooManyRows(10_000);
    expect(e.code).toBe("QUERY_TOO_MANY_ROWS");
    expect(e.message).toContain("10,000");
    expect(e.problem.details).toEqual({ limit: 10_000 });
  });

  test("DuckDB messages map to codes; CroftErrors pass through", () => {
    const own = new CroftError("DB_BUSY", { message: "m", hint: "h" });
    expect(mapQueryError(own, "query")).toBe(own);
    const table = mapQueryError(new Error('Catalog Error: Table with name nope does not exist!\nDid you mean "t"?'), "query") as CroftError;
    expect(table.code).toBe("UNKNOWN_TABLE");
    expect(table.message).toBe("no table named nope");
    const column = mapQueryError(new Error('Binder Error: Referenced column "creatd_at" not found in FROM clause!'), "query") as CroftError;
    expect(column.code).toBe("UNKNOWN_COLUMN");
    const other = mapQueryError(new Error("Out of Range Error: Overflow in multiplication"), "query") as CroftError;
    expect(other.code).toBe("SQL_SYNTAX");
    expect(other.problem.details).toMatchObject({ duckdbErrorType: "Out of Range" });
    const denied = mapQueryError(new Error('Permission Error: Cannot access file "/etc/hosts" - file system operations are disabled by configuration'), "query") as CroftError;
    expect(denied.code).toBe("QUERY_PATH_DENIED");
    expect(mapQueryError("not an error", "query")).toBe("not an error");
  });
});
