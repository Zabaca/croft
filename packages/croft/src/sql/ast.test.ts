import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection } from "@duckdb/node-api";
import { openMemory } from "../db/connect.ts";
import {
  type AstNode, catalogPrefixes, collect, finiteJson, location, NOT_VOLATILE, relationNames, tableArguments, VOLATILE_FUNCTIONS, VOLATILE_KEYWORDS,
  volatileUses, walk,
} from "./ast.ts";
import { planScans } from "./deps.ts";

let db: Awaited<ReturnType<typeof openMemory>>;
let conn: DuckDBConnection;
beforeAll(async () => {
  db = await openMemory({ timezone: "UTC" });
  conn = await db.connect();
});
afterAll(() => db.close());

/** The parsed statement, as the gate returns it (json_serialize_sql's statements[0]); no table has to exist. */
async function ast(sql: string): Promise<unknown> {
  const reader = await conn.runAndReadAll("SELECT json_serialize_sql($1::VARCHAR)", [sql]);
  const s = JSON.parse(String(reader.getRowsJS()[0]![0])) as { error: boolean; statements: unknown[] };
  expect(s.error).toBe(false);
  return s.statements[0];
}

describe("relationNames", () => {
  test("tables in FROM, joins, subqueries and set operations, once each, in the AST's order", async () => {
    const sql = `SELECT o.id FROM Orders o JOIN customers c ON c.id = o.customer_id
      WHERE o.id IN (SELECT order_id FROM refunds) UNION ALL SELECT id FROM main.orders`;
    expect(relationNames(await ast(sql))).toEqual(["orders", "customers", "refunds"]);
  });

  test("CTE names are not relations, unless main.-qualified", async () => {
    expect(relationNames(await ast("WITH recent AS (SELECT * FROM orders) SELECT * FROM recent"))).toEqual(["orders"]);
    expect(relationNames(await ast("WITH orders AS (SELECT * FROM main.orders) SELECT * FROM orders"))).toEqual(["orders"]);
    expect(relationNames(await ast("WITH Recent AS (SELECT 1) SELECT * FROM recent"))).toEqual([]);
  });

  test("files, other schemas and catalog prefixes are not relations", async () => {
    expect(relationNames(await ast("SELECT * FROM 'files/x.csv'"))).toEqual([]);
    expect(relationNames(await ast("SELECT * FROM _croft.assets, information_schema.tables"))).toEqual([]);
    expect(relationNames(await ast("SELECT * FROM other.main.t"))).toEqual([]);
    expect(relationNames(await ast("SELECT * FROM range(3)"))).toEqual([]);
  });

  // Each case as DuckDB 1.5.5 binds it; "agrees with the unoptimized plan" below runs every one against DuckDB.
  const SCOPES: [string, string, string[]][] = [
    ["a CTE hides a table only in its own query", "SELECT * FROM orders WHERE id IN (WITH orders AS (SELECT 1 AS id) SELECT id FROM orders)", ["orders"]],
    ["a CTE in one branch of a UNION", "SELECT id FROM (WITH customers AS (SELECT 1 AS id) SELECT id FROM customers) UNION ALL SELECT id FROM customers", ["customers"]],
    ["a CTE on a parenthesized branch", "(WITH b AS (SELECT 1 AS x) SELECT * FROM b) UNION ALL SELECT x FROM b", ["b"]],
    ["a CTE over a whole UNION", "WITH b AS (SELECT 1 AS x) SELECT * FROM b UNION ALL SELECT * FROM b", []],
    ["a non-recursive CTE's body reads the table of its own name", "WITH orders AS (SELECT * FROM orders WHERE id > 1) SELECT * FROM orders", ["orders"]],
    ["the same under WITH RECURSIVE, when the body does not recurse", "WITH RECURSIVE orders AS (SELECT * FROM orders WHERE id > 1) SELECT * FROM orders", ["orders"]],
    ["a later CTE is not in scope in an earlier one", "WITH a AS (SELECT * FROM b), b AS (SELECT 1 AS x) SELECT * FROM a", ["b"]],
    ["an earlier CTE is in scope in a later one", "WITH b AS (SELECT 1 AS x), a AS (SELECT * FROM b) SELECT * FROM a", []],
    ["a recursive CTE reads itself in its recursive part only", "WITH RECURSIVE orders AS (SELECT id FROM orders WHERE id = 1 UNION ALL SELECT id + 1 FROM orders WHERE id < 3) SELECT * FROM orders", ["orders"]],
    ["a recursive CTE", "WITH RECURSIVE r AS (SELECT id FROM orders UNION ALL SELECT id + 1 FROM r WHERE id < 3) SELECT * FROM r", ["orders"]],
    ["an outer CTE in a scalar subquery", "WITH b AS (SELECT 7 AS x) SELECT (SELECT max(x) FROM b) AS m", []],
    ["an outer CTE in a nested WITH", "WITH b AS (SELECT 1 AS x) SELECT * FROM (WITH a AS (SELECT * FROM b) SELECT * FROM a)", []],
    ["a CTE differing in case", "WITH Recent AS (SELECT 1) SELECT * FROM recent", []],
    ["a table macro's table", "SELECT * FROM histogram(orders, amount)", ["orders"]],
    ["a table macro's table as a string", "SELECT * FROM histogram_values('orders', amount)", ["orders"]],
    ["a table macro's table, main-qualified", "SELECT * FROM histogram(main.orders, amount)", ["orders"]],
    ["a table macro's table as a named argument", "SELECT * FROM histogram_values(col_name := amount, source := 'orders')", ["orders"]],
    ["a table macro over a CTE", "WITH orders AS (SELECT 5 AS amount) SELECT * FROM histogram(orders, amount)", []],
    ["a table macro in a subquery", "SELECT (SELECT count(*) FROM histogram(customers, id)) AS n FROM orders", ["customers", "orders"]],
  ];

  test.each(SCOPES)("CTE scopes and table macros: %s", async (_why, sql, expected) => {
    expect(relationNames(await ast(sql))).toEqual(expected);
  });

  test("agrees with the unoptimized plan on every scope case", async () => {
    const db2 = await openMemory({ timezone: "UTC" });
    try {
      const shadow = await db2.connect();
      await shadow.run("CREATE TABLE orders (id BIGINT, amount DOUBLE)");
      await shadow.run("CREATE TABLE customers (id BIGINT)");
      await shadow.run("CREATE TABLE b (x BIGINT)");
      for (const [why, sql, expected] of SCOPES) expect([why, await planScans(shadow, sql)]).toEqual([why, [...expected].sort()]);
    } finally {
      db2.close();
    }
  });

  test("a table macro's file or computed argument is not a relation", async () => {
    expect(relationNames(await ast("SELECT * FROM histogram('files/x.csv', a)"))).toEqual([]);
    expect(relationNames(await ast("SELECT * FROM histogram(\"files/x.csv\", a)"))).toEqual([]);
    expect(relationNames(await ast("SELECT * FROM histogram('ord' || 'ers', a)"))).toEqual([]);
    expect(relationNames(await ast("SELECT * FROM histogram(_croft.assets, a)"))).toEqual([]);
  });
});

describe("tableArguments", () => {
  const fnOf = async (sql: string) => {
    let fn: AstNode | undefined;
    walk(await ast(sql), (n) => {
      if (n.type === "TABLE_FUNCTION") fn ??= n.function as AstNode;
    });
    return fn!;
  };

  test("the table a table macro names: an identifier, a string, or source :=", async () => {
    expect(tableArguments(await fnOf("SELECT * FROM histogram(orders, amount)"))).toMatchObject([{ catalog: "", schema: "", name: "orders" }]);
    expect(tableArguments(await fnOf("SELECT * FROM histogram(w.main.orders, amount)"))).toMatchObject([{ catalog: "w", schema: "main", name: "orders" }]);
    expect(tableArguments(await fnOf("SELECT * FROM histogram('files/x.csv', amount)"))).toMatchObject([{ name: "files/x.csv", literal: true }]);
    expect(tableArguments(await fnOf("SELECT * FROM histogram(col_name := amount, source := 'orders')"))).toMatchObject([{ name: "orders" }]);
  });

  test("null when the table is computed or missing", async () => {
    expect(tableArguments(await fnOf("SELECT * FROM histogram('ord' || 'ers', amount)"))).toBeNull();
    expect(tableArguments(await fnOf("SELECT * FROM histogram((SELECT 'orders'), amount)"))).toBeNull();
    expect(tableArguments(await fnOf("SELECT * FROM histogram(col_name := amount)"))).toBeNull();
    expect(tableArguments(await fnOf("SELECT * FROM histogram(source := 'a' || 'b', col_name := amount)"))).toBeNull();
  });
});

test("collect marks each relation that a CTE in scope hides, and a table macro's table", async () => {
  const { uses } = collect(await ast("WITH w AS (SELECT * FROM w) SELECT * FROM w, histogram(t, a), (SELECT * FROM w) x"));
  expect(uses.filter((u) => u.kind === "relation").map((u) => u.kind === "relation" && [u.name, u.cte, u.via ?? null])).toEqual([
    ["w", false, null], ["w", true, null], ["t", false, "histogram"], ["w", true, null],
  ]);
});

test("collect finds functions, table functions and relations with their positions", async () => {
  const { uses, ctes } = collect(await ast("WITH w AS (SELECT 1) SELECT lower(b) FROM t, range(2)"));
  // The AST's order: the select list comes before FROM.
  expect(uses.map((u) => `${u.kind}:${u.name}`)).toEqual(["scalar:lower", "relation:t", "table_function:range"]);
  expect(uses.find((u) => u.kind === "scalar")!).toMatchObject({ at: 28 });
  expect([...ctes]).toEqual(["w"]);
  expect(location({ query_location: 18446744073709552000 })).toBeUndefined();
});

describe("catalogPrefixes", () => {
  test("catalog-qualified names and schemas other than main, as written", async () => {
    const found = catalogPrefixes(await ast(`SELECT * FROM other.main.orders, warehouse.t, _croft.assets, Main.ok, ok2,
      'files/x.csv', information_schema.tables`));
    expect(found.map((p) => [p.shown, p.name])).toEqual([
      ["other.main.orders", "orders"], ["warehouse.t", "t"], ["_croft.assets", "assets"], ["information_schema.tables", "tables"],
    ]);
    expect(found[0]!.at).toBe(14);
  });
});

describe("volatileUses", () => {
  test("volatile functions and the clock keywords (COLUMN_REF nodes), each once, in the AST's order", async () => {
    const uses = volatileUses(await ast(`SELECT now(), CURRENT_DATE, current_timestamp, Random(), now(), localtimestamp,
      t.current_date, lower(x), today() FROM t WHERE created < current_date`));
    expect(uses.map((u) => u.shown)).toEqual(["now()", "current_date", "current_timestamp", "random()", "localtimestamp", "today()"]);
    expect(uses[0]!.at).toBe(7);
    expect(volatileUses(await ast("SELECT id, upper(name) FROM t"))).toEqual([]);
  });

  test("every function DuckDB marks VOLATILE or CONSISTENT_WITHIN_QUERY is classified", async () => {
    const reader = await conn.runAndReadAll(`SELECT DISTINCT function_name FROM duckdb_functions()
      WHERE stability IN ('VOLATILE', 'CONSISTENT_WITHIN_QUERY') ORDER BY 1`);
    const marked = reader.getRowsJS().map((r) => String(r[0]));
    const unclassified = marked.filter((f) => !VOLATILE_FUNCTIONS.has(f) && !NOT_VOLATILE.has(f));
    expect(unclassified, "classify these in sql/ast.ts: VOLATILE_FUNCTIONS or NOT_VOLATILE").toEqual([]);
  });

  test("every macro that expands to a volatile function is listed too", async () => {
    const reader = await conn.runAndReadAll(`SELECT DISTINCT function_name, macro_definition FROM duckdb_functions()
      WHERE macro_definition IS NOT NULL AND function_type IN ('macro', 'table_macro')`);
    const calls = new RegExp(`\\b(${[...VOLATILE_FUNCTIONS, ...VOLATILE_KEYWORDS].join("|")})\\b`, "i");
    const missed = reader.getRowsJS().map((r) => [String(r[0]), String(r[1])] as const)
      .filter(([name, def]) => calls.test(def) && !VOLATILE_FUNCTIONS.has(name) && !NOT_VOLATILE.has(name))
      .map(([name]) => name);
    expect(missed).toEqual([]);
  });

  test("every listed name is a DuckDB function or a clock keyword", async () => {
    const reader = await conn.runAndReadAll("SELECT DISTINCT function_name FROM duckdb_functions()");
    const known = new Set(reader.getRowsJS().map((r) => String(r[0])));
    // The clock keywords reach DuckDB as COLUMN_REF nodes; current_time() and current_timestamp() as calls
    // are the parser's spellings of get_current_time() and get_current_timestamp().
    const parserOnly = new Set([...VOLATILE_KEYWORDS, "current_time", "current_timestamp"]);
    expect([...VOLATILE_FUNCTIONS, ...NOT_VOLATILE].filter((f) => !known.has(f) && !parserOnly.has(f))).toEqual([]);
  });
});

test("finiteJson quotes DuckDB's bare Infinity outside strings", async () => {
  const raw = String((await conn.runAndReadAll("SELECT json_serialize_sql('SELECT 1e400, -1e400')")).getRowsJS()[0]![0]);
  expect(() => JSON.parse(raw)).toThrow();
  const values = JSON.parse(finiteJson(raw)).statements[0].node.select_list.map((n: { value: { value: unknown } }) => n.value?.value ?? n);
  expect(values[0]).toBe("Infinity");
  expect(JSON.parse(finiteJson('{"a":Infinity,"b":[-Infinity,NaN,-1],"c":"x:Infinity,\\"NaN"}'))).toEqual({ a: "Infinity", b: ["-Infinity", "NaN", -1], c: 'x:Infinity,"NaN' });
  expect(finiteJson('{"a":1}')).toBe('{"a":1}');
});

test("walk visits every node in the AST's order", async () => {
  const seen: string[] = [];
  walk(await ast("SELECT a FROM t"), (n) => {
    if (n.class === "COLUMN_REF" || n.type === "BASE_TABLE") seen.push(String(n.class ?? n.type));
  });
  expect(seen).toEqual(["COLUMN_REF", "BASE_TABLE"]);
});
