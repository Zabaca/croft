import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection } from "@duckdb/node-api";
import { CroftError } from "../core/errors.ts";
import { openMemory } from "../db/connect.ts";
import { assertOneSelect, findFunctions, type GateOptions, lineColumn } from "./gate.ts";

let db: Awaited<ReturnType<typeof openMemory>>;
let conn: DuckDBConnection;
beforeAll(async () => {
  db = await openMemory({ timezone: "UTC" });
  conn = await db.connect();
  await conn.run("CREATE TABLE t (a INTEGER, b VARCHAR)");
});
afterAll(() => db.close());

async function code(sql: string, o?: GateOptions): Promise<CroftError> {
  try {
    await assertOneSelect(conn, sql, o);
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
  throw new Error(`gate accepted ${JSON.stringify(sql)}`);
}

describe("passes exactly one SELECT", () => {
  for (const sql of [
    "select 1",
    "select 1;",
    "select 1; -- trailing comment",
    "SELECT a FROM t WHERE b = 'x;y'",
    "from t",
    "with x as (select 1 a) select * from x",
    "describe t",
    "summarize t",
    "show tables",
    "values (1), (2)",
    "pivot t on b in ('x') using sum(a)",
    "select * from read_csv('files/a.csv')", // files are fine outside serve; the sandbox limits paths
  ]) {
    test(sql, async () => {
      const ast = await assertOneSelect(conn, sql);
      expect(ast.node.type).toBe("SELECT_NODE");
    });
  }
});

describe("rejects", () => {
  test("two statements", async () => {
    const e = await code("select 1; select 2");
    expect(e.code).toBe("SQL_NOT_ONE_STATEMENT");
    expect(e.message).toContain("found 2 statements");
  });

  test("an injected second statement", async () => {
    expect((await code("select 1; drop table t")).code).toBe("SQL_NOT_ONE_STATEMENT");
  });

  test("empty input and comments only", async () => {
    for (const sql of ["", "   ", "-- nothing"]) {
      const e = await code(sql);
      expect(e.code).toBe("SQL_NOT_ONE_STATEMENT");
      expect(e.message).toContain("no SQL statement");
    }
  });

  test("COPY, ATTACH, DETACH and every other non-SELECT", async () => {
    for (const sql of [
      "copy t to 'out.csv'",
      "attach 'x.duckdb' as x",
      "detach x",
      "insert into t values (1, 'a')",
      "update t set a = 1",
      "create table u as select 1",
      "drop table t",
      "pragma version",
      "explain select 1",
      "set threads = 1",
      "call pragma_version()",
      "pivot t on b",
    ]) {
      const e = await code(sql);
      expect([sql, e.code]).toEqual([sql, sql === "pivot t on b" ? "SQL_NOT_ONE_STATEMENT" : "QUERY_NOT_SELECT"]);
    }
    expect((await code("copy t to 'out.csv'")).problem.hint).toContain("exports are post-v1");
  });

  test("SQL assets report SQL_NOT_SELECT", async () => {
    expect((await code("insert into t values (1, 'a')", { notSelectCode: "SQL_NOT_SELECT" })).code).toBe("SQL_NOT_SELECT");
  });

  test("syntax errors carry line and column", async () => {
    const e = await code("select *\nfrom t\nwhere a = = 1", { file: "assets/x.sql", lineOffset: 2 });
    expect(e.code).toBe("SQL_SYNTAX");
    expect(e.problem).toMatchObject({ line: 5, column: 11, file: "assets/x.sql" });
    const tail = await code("select * from t where");
    expect(tail.code).toBe("SQL_SYNTAX");
    expect(tail.problem.line).toBe(1);
    expect(tail.problem.column).toBe(22);
    const first = await code("selec 1");
    expect(first.problem).toMatchObject({ line: 1, column: 1 });
  });

  test("positions count code points, not bytes or UTF-16 units", async () => {
    const e = await code("select '😀日本' = = 1");
    expect(e.problem.column).toBe(16);
  });
});

describe("serve profile", () => {
  test("denies file, glob and settings functions anywhere in the query", async () => {
    for (const [sql, name] of [
      ["select * from glob('*')", "glob"],
      ["select * from read_csv('files/a.csv')", "read_csv"],
      ["select * from read_text('.env')", "read_text"],
      ["select * from read_parquet('x.parquet')", "read_parquet"],
      ["from duckdb_settings()", "duckdb_settings"],
      ["select path from duckdb_databases()", "duckdb_databases"],
      ["select a from t where a in (select 1 from read_json('x.json'))", "read_json"],
      ["with x as (select * from glob('*')) select * from x", "glob"],
      ["select current_setting('temp_directory')", "current_setting"],
      ["from query('from duckdb_settings()')", "query"],
    ] as const) {
      const e = await code(sql, { profile: "serve" });
      expect(e.code).toBe("QUERY_PATH_DENIED");
      expect(e.message).toContain(`${name}()`);
    }
    const located = await code("select a\nfrom glob('*')", { profile: "serve" });
    expect(located.problem).toMatchObject({ line: 2, column: 6 });
  });

  test("allows tables", async () => {
    await assertOneSelect(conn, "select b, count(*) from t group by 1", { profile: "serve" });
    await assertOneSelect(conn, "describe t", { profile: "serve" });
  });

  test("still applies the one-SELECT rule first", async () => {
    expect((await code("copy t to 'x.csv'", { profile: "serve" })).code).toBe("QUERY_NOT_SELECT");
  });
});

test("the AST is returned for dependency extraction", async () => {
  const ast = await assertOneSelect(conn, "select a from t");
  expect(JSON.stringify(ast)).toContain('"table_name":"t"');
  expect(findFunctions(ast, () => true)).toBeNull();
  expect(findFunctions(await assertOneSelect(conn, "select lower(b) from t"), (n) => n === "lower")).toEqual({ name: "lower", location: 7 });
});

test("lineColumn", () => {
  expect(lineColumn("abc", 0)).toEqual({ line: 1, column: 1 });
  expect(lineColumn("ab\ncd", 4)).toEqual({ line: 2, column: 2 });
  expect(lineColumn("a", 99)).toEqual({ line: 1, column: 2 });
});
