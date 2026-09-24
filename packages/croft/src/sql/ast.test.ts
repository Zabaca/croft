import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection } from "@duckdb/node-api";
import { openMemory } from "../db/connect.ts";
import { collect, location, relationNames } from "./ast.ts";

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
