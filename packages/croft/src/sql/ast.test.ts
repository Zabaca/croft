import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection } from "@duckdb/node-api";
import { openMemory } from "../db/connect.ts";
import {
  catalogPrefixes, collect, finiteJson, location, NOT_VOLATILE, relationNames, VOLATILE_FUNCTIONS, VOLATILE_KEYWORDS, volatileUses, walk,
} from "./ast.ts";

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
