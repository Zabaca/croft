import { afterAll, describe, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
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

  test("DuckDB 2.0's refusal of an arrow lambda is LAMBDA_ARROW, with the lambda keyword in the hint", async () => {
    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();
    try {
      const e = await conn.run("SELECT list_transform([1, 2], x -> x + 1)").then(() => null, (err: Error) => err);
      const mapped = mapQueryError(e, "query") as CroftError;
      expect(mapped.code).toBe("LAMBDA_ARROW");
      expect(mapped.problem.hint).toContain("lambda x: x + 1");
      expect(mapped.problem.details).toMatchObject({ duckdbErrorType: "Binder" });
    } finally {
      conn.disconnectSync();
      instance.closeSync();
    }
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

  test("-> takes everything to its left (->> no longer does on DuckDB 2.0): such a failure's hint says to parenthesise, other failures keep theirs", async () => {
    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();
    try {
      await conn.run(`CREATE TABLE t AS SELECT '{"k":"v","n":2}'::JSON AS j, true AS a`);
      const value = async (expr: string) => (await conn.runAndReadAll(`SELECT ${expr} AS r FROM t`)).getRowObjectsJson()[0]!.r;
      const failure = (expr: string) => conn.run(`SELECT ${expr} AS r FROM t`).then(() => null, (e: Error) => e);
      // On DuckDB 2.0, ->> binds more tightly than AND, OR, NOT and =: it compares as written [V].
      for (const expr of [`j->>'k' = 'v'`, `a AND j->>'k' = 'v'`, `false OR j->>'k' = 'v'`, `1 = 1 AND j->>'k' = 'v'`, `j->>'n' = '2' AND j->>'k' = 'v'`]) {
        expect([expr, await value(expr)]).toEqual([expr, true]);
      }
      expect(await value(`a AND (j->'k') = '"v"'`)).toBe(true);
      // -> still takes what precedes it, and what follows up to =, as the JSON and the path it reads [V].
      for (const [expr, says] of [[`j->'n' = 2`, "json_extract(JSON, BOOLEAN)"], [`j->'n' > 1`, "json_extract(JSON, BOOLEAN)"],
        [`a AND j->'k' = '"v"'`, "json_extract(BOOLEAN, BOOLEAN)"], [`a AND j->'k'`, "Failed to cast value"]] as const) {
        const e = mapQueryError(await failure(expr), "query") as CroftError;
        expect([expr, e.code]).toEqual([expr, "QUERY_FAILED"]);
        expect(e.message, expr).toContain(says);
        expect(e.problem.hint, expr).toContain("(j->'k') = 2");
        expect(e.problem.hint, expr).not.toContain("->>");
      }
      // A conversion error over plain text is about the data.
      const text = mapQueryError(await failure(`CAST(j->>'k' AS INTEGER)`), "query") as CroftError;
      expect(text.problem.hint).toBe("fix the query; DuckDB's message says what went wrong");
    } finally {
      conn.closeSync();
      instance.closeSync();
    }
  });
});
