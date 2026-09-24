import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection } from "@duckdb/node-api";
import { CroftError } from "../core/errors.ts";
import { openMemory } from "../db/connect.ts";
import { duckdbPosition, mapAssetError, ShadowCatalog } from "./bind.ts";

let db: Awaited<ReturnType<typeof openMemory>>;
let conn: DuckDBConnection;
beforeAll(async () => {
  db = await openMemory({ timezone: "UTC" });
  conn = await db.connect();
  await conn.run("CREATE TABLE github_issues (id BIGINT, title VARCHAR, created_at TIMESTAMPTZ)");
});
afterAll(() => db.close());

/** The error DuckDB gives when preparing `sql`. */
async function duckError(sql: string): Promise<Error> {
  try {
    (await conn.prepare(sql)).destroySync();
  } catch (e) {
    return e as Error;
  }
  throw new Error(`${sql} prepared`);
}

/** mapAssetError for a body that DuckDB saw as `prefix + body`, in a file with `lineOffset` header lines. */
async function mapped(body: string, o: { prefix?: string; lineOffset?: number } = {}): Promise<CroftError> {
  const e = mapAssetError(await duckError((o.prefix ?? "") + body), { file: "assets/open_issues.sql", lineOffset: o.lineOffset ?? 0, body });
  expect(e).toBeInstanceOf(CroftError);
  return e as CroftError;
}

describe("mapAssetError: mapQueryError, located in the asset's file", () => {
  test("a binder error's line is shifted past the header; the column is the caret's", async () => {
    const e = await mapped("SELECT id,\n  titel\nFROM github_issues", { lineOffset: 3 });
    expect(e.problem).toMatchObject({ code: "UNKNOWN_COLUMN", file: "assets/open_issues.sql", line: 5, column: 3 });
    expect(e.problem.details).toMatchObject({ duckdbErrorType: "Binder" });
  });

  test("an unknown table", async () => {
    const e = await mapped("SELECT id\nFROM github_isues", { lineOffset: 2 });
    expect(e.problem).toMatchObject({ code: "UNKNOWN_TABLE", message: "no table named github_isues", line: 4, column: 6 });
  });

  test("the SQL step's view wrapper on the first line does not move the column", async () => {
    const e = await mapped("SELECT titel FROM github_issues;", { prefix: "CREATE TEMP VIEW __body AS ", lineOffset: 1 });
    expect(e.problem).toMatchObject({ code: "UNKNOWN_COLUMN", line: 2, column: 8 });
  });

  test("a long line's excerpt is cut; the column still counts from the line's start", async () => {
    const cols = Array.from({ length: 12 }, (_, i) => `title AS c${i}`).join(", ");
    const body = `SELECT id, ${cols}, zzz FROM github_issues`;
    const e = await mapped(body);
    expect(e.problem).toMatchObject({ line: 1, column: body.indexOf("zzz") + 1 });
  });

  test("columns count code points; the caret counts wide characters twice", async () => {
    for (const lead of ["'é🙂'", "'中文字'", `'${"é🙂".repeat(40)}'`]) {
      const body = `SELECT 1,\n  ${lead} || zzz FROM github_issues`;
      const e = await mapped(body);
      const second = body.split("\n")[1]!;
      expect({ lead, ...e.problem }).toMatchObject({ lead, line: 2, column: Array.from(second.slice(0, second.indexOf("zzz"))).length + 1 });
    }
  });

  test("a parser error without an excerpt keeps the file, without a line", async () => {
    const e = await mapped("SELECT id FROM github_issues WHERE");
    expect(e.problem.code).toBe("SQL_SYNTAX");
    expect(e.problem.file).toBe("assets/open_issues.sql");
    expect(e.problem.line).toBeUndefined();
  });

  test("croft's own errors and errors that are not DuckDB's come back unchanged", () => {
    const own = new CroftError("CHECK_INVALID", { message: "m", hint: "h" });
    expect(mapAssetError(own, { file: "f", lineOffset: 1, body: "" })).toBe(own);
    const bug = new TypeError("x is undefined");
    expect(mapAssetError(bug, { file: "f", lineOffset: 1, body: "" })).toBe(bug);
  });
});

test("duckdbPosition: no excerpt, or a line the SQL lacks", () => {
  expect(duckdbPosition("Parser Error: syntax error at end of input", "SELECT")).toBeNull();
  expect(duckdbPosition("Binder Error: x\n\nLINE 9: SELECT x\n               ^", "SELECT x")).toEqual({ line: 9 });
});

test("ShadowCatalog is a phase-2 stub until builder B lands", async () => {
  const e = await ShadowCatalog.open("UTC").then(() => null, (x: unknown) => x as CroftError);
  expect(e?.code).toBe("INTERNAL_ERROR");
  expect(e?.message).toStartWith("PHASE_STUB");
});
