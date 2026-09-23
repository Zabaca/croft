import { afterAll, describe, expect, test } from "bun:test";
import { linkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { directQuery } from "./direct.ts";
import { mapQueryError, toDuck, wireSafe } from "./select.ts";
import { cleanup, makeProject } from "./testkit.ts";
import { stringifyLossless, tooManyRows } from "./wire.ts";

afterAll(() => cleanup());

describe("direct mode goes through the full gate", () => {
  const FAST = { intentWaitMs: 200, lockRetryMs: 300, pollMs: 20 };
  const req = (sql: string) => ({ sql, params: [], limit: 100 });
  async function rejection(p: Promise<unknown>): Promise<CroftError> {
    try {
      await p;
    } catch (e) {
      if (e instanceof CroftError) return e;
      throw e;
    }
    throw new Error("expected a CroftError");
  }

  test("an app's query cannot read the warehouse file it has open, by any name, nor run side effects", async () => {
    const p = await makeProject({ seed: ["CREATE TABLE t AS SELECT 1 AS a"] });
    writeFileSync(join(p.root, "files", "a.csv"), "x\n1\n");
    linkSync(p.database, join(p.root, "files", "copy.bin"));
    for (const sql of [
      `SELECT octet_length(content) AS n FROM read_blob('${p.database}')`,
      `SELECT octet_length(content) AS n FROM read_blob('${join(p.root, "files", "copy.bin")}')`,
      `SELECT * FROM '${join(p.root, "files", "..", "warehouse.duckdb")}'`,
    ]) {
      expect([sql, (await rejection(directQuery(p.project, req(sql), FAST))).code]).toEqual([sql, "QUERY_PATH_DENIED"]);
    }
    const e = await rejection(directQuery(p.project, req("SELECT * FROM enable_logging(storage = 'stdout')"), FAST));
    expect(e.code).toBe("QUERY_NOT_SELECT");
    // Files under files/ are still fine.
    expect(await directQuery(p.project, req(`SELECT * FROM read_csv('${join(p.root, "files", "a.csv")}')`), FAST)).toEqual([{ x: 1 }]);
  });
});

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
    expect(other.code).toBe("QUERY_FAILED");
    expect(other.problem.details).toMatchObject({ duckdbErrorType: "Out of Range" });
    const denied = mapQueryError(new Error('Permission Error: Cannot access file "/etc/hosts" - file system operations are disabled by configuration'), "query") as CroftError;
    expect(denied.code).toBe("QUERY_PATH_DENIED");
    expect(mapQueryError("not an error", "query")).toBe("not an error");
  });

  test("runtime errors in a user's query are QUERY_FAILED, not SQL_SYNTAX; parser errors stay SQL_SYNTAX", () => {
    for (const [msg, kind] of [
      ["Conversion Error: Could not convert string 'abc' to INT32", "Conversion"],
      ["Invalid Input Error: Malformed JSON at byte 0 of input", "Invalid Input"],
      ["Out of Range Error: Overflow in multiplication of INT32 (2147483647 * 2)!", "Out of Range"],
      ["Binder Error: No function matches the given name and argument types 'lower(INTEGER)'", "Binder"],
      ["Catalog Error: Scalar Function with name nope does not exist!", "Catalog"],
      ["IO Error: No files found that match the pattern \"files/missing.csv\"", "IO"],
      ["Interrupt Error: Interrupted!", "Interrupt"],
      ["Failed to bind value: Invalid Input Error: Can not bind to parameter number 2, statement only has 1 parameter(s)", "Invalid Input"],
    ] as const) {
      const e = mapQueryError(new Error(`${msg}\nLINE 1: ...`), "query") as CroftError;
      expect([msg, e.code]).toEqual([msg, "QUERY_FAILED"]);
      expect(e.message).toBe(msg);
      expect(e.problem.details).toMatchObject({ duckdb: msg, duckdbErrorType: kind });
    }
    expect((mapQueryError(new Error("Parser Error: syntax error at or near \"x\""), "query") as CroftError).code).toBe("SQL_SYNTAX");
    // A JavaScript error is a croft bug, not a problem with the query: it passes through unchanged.
    const bug = new TypeError("cannot read properties of undefined");
    expect(mapQueryError(bug, "query")).toBe(bug);
  });
});
