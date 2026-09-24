import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection } from "@duckdb/node-api";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openMemory } from "../db/connect.ts";
import { loadSqlAsset } from "../project/sql-asset.ts";
import { planScans, splitQualified } from "./deps.ts";

// The shadow catalog every case binds against: empty tables, as sql/bind.ts builds them.
const SHADOW = [
  "CREATE TABLE orders (id BIGINT, customer_id BIGINT, amount DECIMAL(18,2), product VARCHAR, tags VARCHAR[], created_at TIMESTAMPTZ)",
  "CREATE TABLE customers (id BIGINT, name VARCHAR)",
  "CREATE TABLE refunds (order_id BIGINT, amount DECIMAL(18,2))",
  "CREATE TABLE products (id BIGINT, name VARCHAR)",
];

let db: Awaited<ReturnType<typeof openMemory>>;
let shadow: DuckDBConnection;
let front: Awaited<ReturnType<typeof openMemory>>;
let frontConn: DuckDBConnection;
beforeAll(async () => {
  db = await openMemory({ timezone: "UTC" });
  shadow = await db.connect();
  for (const sql of SHADOW) await shadow.run(sql);
  front = await openMemory({ timezone: "UTC" });
  frontConn = await front.connect();
});
afterAll(() => {
  db.close();
  front.close();
});

/** Whether the connection's optimizer is on, from the plan of a query it would prune. */
async function optimizerOn(conn: DuckDBConnection): Promise<boolean> {
  const reader = await conn.runAndReadAll("EXPLAIN (FORMAT json) SELECT * FROM orders WHERE false");
  return !String(reader.getRowsJS()[0]![1]).includes("SEQ_SCAN");
}

describe("planScans", () => {
  test("the tables the unoptimized plan scans, sorted, once each", async () => {
    expect(await planScans(shadow, "SELECT * FROM refunds JOIN orders ON orders.id = refunds.order_id WHERE orders.id IN (SELECT id FROM orders)")).toEqual(["orders", "refunds"]);
    expect(await planScans(shadow, "SELECT 1")).toEqual([]);
  });

  test("scans the optimizer would prune: WHERE false, LIMIT 0", async () => {
    expect(await planScans(shadow, "SELECT * FROM orders WHERE false")).toEqual(["orders"]);
    expect(await planScans(shadow, "SELECT * FROM customers LIMIT 0")).toEqual(["customers"]);
  });

  test("leaves the optimizer as it found it", async () => {
    expect(await optimizerOn(shadow)).toBe(true);
    await planScans(shadow, "SELECT * FROM orders");
    expect(await optimizerOn(shadow)).toBe(true);
    await planScans(shadow, "SELECT * FROM nope");
    expect(await optimizerOn(shadow)).toBe(true);
    await shadow.run("PRAGMA disable_optimizer");
    try {
      expect(await planScans(shadow, "SELECT * FROM orders")).toEqual(["orders"]);
      expect(await optimizerOn(shadow)).toBe(false);
    } finally {
      await shadow.run("PRAGMA enable_optimizer");
    }
  });

  test("null when the body does not bind, is not one statement, or does not parse", async () => {
    expect(await planScans(shadow, "SELECT * FROM missing")).toBeNull();
    expect(await planScans(shadow, "SELECT nope FROM orders")).toBeNull();
    expect(await planScans(shadow, "SELECT 1; SELECT 2")).toBeNull();
    expect(await planScans(shadow, "SELECT 1; DROP TABLE orders")).toBeNull();
    expect(await planScans(shadow, "SELEC 1")).toBeNull();
    expect((await shadow.runAndReadAll("SELECT count(*) FROM orders")).getRowsJS()).toEqual([[0n]]);
  });

  test("a trailing ; or -- comment, and a comment on the first line", async () => {
    expect(await planScans(shadow, "SELECT * FROM orders;")).toEqual(["orders"]);
    expect(await planScans(shadow, "SELECT * FROM orders -- done")).toEqual(["orders"]);
    expect(await planScans(shadow, "-- first\nSELECT * FROM orders; -- done\n")).toEqual(["orders"]);
  });

  test("temp tables and names DuckDB quotes", async () => {
    await shadow.run('CREATE TEMP TABLE "Odd.Name" (id INT)');
    try {
      expect(await planScans(shadow, 'SELECT * FROM "Odd.Name" JOIN orders USING (id)')).toEqual(["odd.name", "orders"]);
    } finally {
      await shadow.run('DROP TABLE "Odd.Name"');
    }
  });

  test("splitQualified", () => {
    expect(splitQualified('"temp".main."we.ird"')).toEqual(["temp", "main", "we.ird"]);
    expect(splitQualified('memory.main."a""b"')).toEqual(["memory", "main", 'a"b']);
    expect(splitQualified("t")).toEqual(["t"]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// The golden corpus (DESIGN.md §10 "Test strategy"): one asset per file in deps-corpus/, with what the AST
// (loadSqlAsset's astInputs), the unoptimized plan (planScans) and the front end's problems must be. Every
// case where the two sources differ says why (`-- @why:`), so the comparison is reviewed, not incidental.
// CROFT_UPDATE_GOLDEN=1 rewrites the expectations from what the code does now; review the diff.

const CORPUS = join(import.meta.dir, "deps-corpus");
const list = (xs: readonly string[] | null) => (xs === null ? "null" : xs.length ? xs.join(", ") : "none");
const expectation = (text: string, key: string) => text.match(new RegExp(`^-- @${key}: (.*)$`, "m"))?.[1]?.trim();

describe("the golden corpus: AST and unoptimized plan on every case", () => {
  const files = readdirSync(CORPUS).filter((f) => f.endsWith(".sql")).sort();

  test("covers what DESIGN.md §10 lists", () => {
    for (const c of ["cte", "cte-shadowing", "subqueries", "union", "catalog-prefix", "file-path", "query-table", "query",
      "table-macro", "pivot-in", "pivot-without-in", "lambdas", "qualify", "trailing-semicolon", "trailing-comment", "two-statements"]) {
      expect(files).toContain(`${c}.sql`);
    }
  });

  for (const f of files) {
    test(f, async () => {
      const path = join(CORPUS, f);
      const text = readFileSync(path, "utf8");
      const name = f.replace(/\.sql$/, "").replaceAll("-", "_");
      const asset = await loadSqlAsset({ name, file: `assets/${name}.sql`, path },
        { root: CORPUS, timezone: "UTC", conn: frontConn, assetNames: ["orders", "customers", "refunds", "products"] });
      const plan = await planScans(shadow, asset.body);
      const actual = { ast: list(asset.astInputs), plan: list(plan), problems: list(asset.problems.map((p) => p.code)) };

      if (process.env.CROFT_UPDATE_GOLDEN === "1") {
        let next = text;
        for (const [k, v] of Object.entries(actual)) next = next.replace(new RegExp(`^-- @${k}: .*$`, "m"), `-- @${k}: ${v}`);
        if (next !== text) writeFileSync(path, next);
        return;
      }
      expect({ ast: expectation(text, "ast"), plan: expectation(text, "plan"), problems: expectation(text, "problems") }).toEqual(actual);
      const differs = plan !== null && [...asset.astInputs, ...plan].some((t) => !asset.astInputs.includes(t) || !plan.includes(t));
      const why = expectation(text, "why");
      if (differs) expect(why, "a case where the AST and the plan differ says why (-- @why:)").toBeString();
      else expect(why, "-- @why: only where the AST and the plan differ").toBeUndefined();
    });
  }
});
