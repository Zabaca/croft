import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cleanup as cleanupChildren, spawnHolder } from "../../read/testkit.ts";
import { CHARGES_TS, cleanup, cli, ISSUES_SEED, ISSUES_TS, makeProject, seed, shape } from "./inspect-testkit.ts";
import { parseLimit } from "./query.ts";

afterAll(async () => {
  cleanupChildren();
  await cleanup();
});

async function issues(files: Record<string, string> = {}) {
  const p = makeProject({ files: { "assets/github_issues.ts": ISSUES_TS, ...files } });
  await seed(p.database, ISSUES_SEED);
  return p;
}

describe("croft query: the JSON contract", () => {
  test("golden shape: {columns, rows, rowCount, truncatedRows, truncatedValues}", async () => {
    const p = await issues();
    const r = await cli(["query", "select state, count(*) AS n from github_issues group by 1 order by 1", "--json"], { cwd: p.root });
    expect(r.exit).toBe(0);
    expect(r.json).toMatchObject({ schemaVersion: 1, ok: true, command: "query", database: "warehouse.duckdb", timezone: "America/Los_Angeles", problems: [], next: [] });
    expect(r.json.data).toEqual({
      columns: [{ name: "state", type: "VARCHAR" }, { name: "n", type: "BIGINT" }],
      rows: [{ state: "closed", n: 1 }, { state: "open", n: 2 }],
      rowCount: 2, truncatedRows: 0, truncatedValues: 0,
    });
    expect(shape(r.json.data)).toEqual({
      columns: [{ name: "string", type: "string" }], rows: [{ state: "string", n: "number" }],
      rowCount: "number", truncatedRows: "number", truncatedValues: "number",
    });
  });

  test("HUGEINT, DECIMAL and integers beyond 2^53 are strings; TIMESTAMPTZ carries the project offset", async () => {
    const p = await issues();
    const r = await cli(["query", "select 9007199254740993::BIGINT AS big, 12::HUGEINT AS huge, 1.50::DECIMAL(5,2) AS d, 7 AS small, updated_at FROM github_issues WHERE id = 1", "--json"], { cwd: p.root });
    expect(r.json.data.rows).toEqual([{ big: "9007199254740993", huge: "12", d: "1.50", small: 7, updated_at: "2026-09-20T03:00:00-07:00" }]);
    expect(r.json.data.columns.map((c: { type: string }) => c.type)).toEqual(["BIGINT", "HUGEINT", "DECIMAL(5,2)", "INTEGER", "TIMESTAMPTZ"]);
  });

  test("JSON columns come back as JSON values", async () => {
    const p = await issues();
    const r = await cli(["query", `select "user", labels from github_issues where id = 1`, "--json"], { cwd: p.root });
    expect(r.json.data.rows).toEqual([{ user: { login: "jarred", id: 7 }, labels: [{ name: "bug", color: "red" }] }]);
  });

  test("human output is an aligned table with the row count and time", async () => {
    const p = await issues();
    const r = await cli(["query", "select state, count(*) AS n from github_issues group by 1 order by 1"], { cwd: p.root });
    expect(r.exit).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines.slice(0, 3)).toEqual(["state    n", "closed   1", "open     2"]);
    expect(lines[3]).toMatch(/^\(2 rows, \d+(\.\d)? m?s\)$/);
    expect(r.stderr).toBe("");
  });

  test("counts get thousands separators for people, ids do not", async () => {
    const p = await issues();
    const r = await cli(["query", "select 17352 AS n, 2291 AS id"], { cwd: p.root });
    expect(r.stdout.split("\n")[1]).toBe("17,352   2291");
  });
});

describe("croft query: truncation", () => {
  test("50 rows by default; the rest are counted, not returned", async () => {
    const p = await issues();
    const r = await cli(["query", "select i from range(5000) t(i)", "--json"], { cwd: p.root });
    expect(r.json.data.rows).toHaveLength(50);
    expect(r.json.data.rows[49]).toEqual({ i: 49 });
    expect(r.json.data).toMatchObject({ rowCount: 5000, truncatedRows: 4950, truncatedValues: 0 });
    expect(r.json.next[0].command).toContain("--limit");
  });

  test("--limit N lifts the row cap; --limit 0 returns only the count", async () => {
    const p = await issues();
    const r = await cli(["query", "select i from range(120) t(i)", "--limit", "100", "--json"], { cwd: p.root });
    expect(r.json.data).toMatchObject({ rowCount: 120, truncatedRows: 20 });
    expect(r.json.data.rows).toHaveLength(100);
    const zero = await cli(["query", "select i from range(120) t(i)", "--limit", "0", "--json"], { cwd: p.root });
    expect(zero.json.data).toMatchObject({ rows: [], rowCount: 120, truncatedRows: 120 });
    const all = await cli(["query", "select i from range(3) t(i)", "--limit", "10", "--json"], { cwd: p.root });
    expect(all.json.data).toMatchObject({ rowCount: 3, truncatedRows: 0 });
    expect(all.json.next).toEqual([]);
  });

  test("human output says how many rows exist and how to see more", async () => {
    const p = await issues();
    const r = await cli(["query", "select i from range(120) t(i)"], { cwd: p.root });
    expect(r.stdout).toContain("(50 of 120 rows shown; --limit N shows more)");
    expect(r.stdout).toContain("(120 rows, ");
  });

  test("values are cut to 80 characters (objects as their JSON text); --full-values keeps them whole", async () => {
    const p = await issues();
    const sql = `select repeat('x', 200) AS long, 'short' AS s, {'a': repeat('y', 100)}::JSON AS obj, {'a': 1}::JSON AS small`;
    const r = await cli(["query", sql, "--json"], { cwd: p.root });
    const row = r.json.data.rows[0];
    expect(row.long).toBe(`${"x".repeat(79)}…`);
    expect(row.s).toBe("short");
    expect(row.obj).toBe(`{"a":"${"y".repeat(73)}…`);
    expect(row.small).toEqual({ a: 1 });
    expect(r.json.data.truncatedValues).toBe(2);
    const full = await cli(["query", sql, "--json", "--full-values"], { cwd: p.root });
    expect(full.json.data.rows[0]).toMatchObject({ long: "x".repeat(200), obj: { a: "y".repeat(100) } });
    expect(full.json.data.truncatedValues).toBe(0);
    const human = await cli(["query", sql], { cwd: p.root });
    expect(human.stdout).toContain("(values cut to 80 characters; --full-values shows them whole)");
  });

  test("--limit must be a whole number", async () => {
    expect(parseLimit(undefined)).toBe(50);
    expect(parseLimit("7")).toBe(7);
    const p = await issues();
    const r = await cli(["query", "select 1", "--limit", "-3", "--json"], { cwd: p.root });
    expect(r.exit).toBe(2);
    expect(r.json.problems[0]).toMatchObject({ code: "USAGE_ERROR" });
    expect((await cli(["query", "select 1", "--limit", "ten", "--json"], { cwd: p.root })).json.problems[0].message).toContain("--limit");
  });
});

describe("croft query: redaction", () => {
  const PIN_TS = `import { ingest } from "@zabaca/croft";
export default ingest({ secrets: ["API_PIN"], async *rows() { yield []; } });
`;

  test("a declared secret is redacted from query data even when it looks like an ordinary word", async () => {
    const p = await issues({ "assets/pins.ts": PIN_TS, ".env": "API_PIN=abcdefgh\nLOG_LEVEL=verbose\n" });
    const r = await cli(["query", "select 'abcdefgh' AS v, 'pin: abcdefgh!' AS w, 'verbose' AS level", "--json"], { cwd: p.root });
    expect(r.exit).toBe(0);
    expect(r.json.data.rows).toEqual([{ v: "[redacted:API_PIN]", w: "pin: [redacted:API_PIN]!", level: "verbose" }]);
    expect(r.json.data.redactedValues).toBe(true);
    expect(r.stdout).not.toContain("abcdefgh");
    const human = await cli(["query", "select 'abcdefgh' AS v"], { cwd: p.root });
    expect(human.stdout).toContain("[redacted:API_PIN]");
    expect(human.stdout).not.toContain("abcdefgh");
  });

  test("an undeclared plain word from .env stays (it is still redacted from messages)", async () => {
    const p = await issues({ ".env": "API_PIN=abcdefgh\n" });
    const r = await cli(["query", "select 'abcdefgh' AS v", "--json"], { cwd: p.root });
    expect(r.json.data.rows).toEqual([{ v: "abcdefgh" }]);
  });

  test("a secret is redacted before a value is cut, so no part of it survives the cut", async () => {
    const p = await issues({ "assets/pins.ts": PIN_TS, ".env": "API_PIN=abcdefgh\n" });
    const r = await cli(["query", `select repeat('x', 76) || 'abcdefgh' AS v`, "--json"], { cwd: p.root });
    const v = r.json.data.rows[0].v as string;
    expect(v).toBe(`${"x".repeat(76)}[re…`);
    expect(v).not.toContain("abc");
  });

  test("secrets of an asset file that does not import are still found in its text", async () => {
    const broken = `import { ingest } from "@zabaca/croft";\nthrow new Error("boom");\nexport default ingest({ secrets: ["API_PIN"], async *rows() {} });\n`;
    const p = await issues({ "assets/pins.ts": broken, ".env": "API_PIN=abcdefgh\n" });
    const r = await cli(["query", "select 'abcdefgh' AS v", "--json"], { cwd: p.root });
    expect(r.json.data.rows).toEqual([{ v: "[redacted:API_PIN]" }]);
  });

  test("a shell value of a declared secret is redacted too", async () => {
    const p = await issues({ "assets/charges.ts": CHARGES_TS });
    const r = await cli(["query", "select 'sk_live_123456' AS k", "--json"], { cwd: p.root, env: { STRIPE_KEY: "sk_live_123456" } });
    expect(r.json.data.rows[0].k).not.toContain("sk_live_123456");
  });
});

describe("croft query: the gate and the sandbox", () => {
  test("anything but one SELECT is QUERY_NOT_SELECT (exit 2), with the §4.2 hint", async () => {
    const p = await issues();
    const r = await cli(["query", "copy github_issues to 'out.csv'", "--json"], { cwd: p.root });
    expect(r.exit).toBe(2);
    expect(r.json.ok).toBe(false);
    expect(r.json.problems[0]).toMatchObject({
      code: "QUERY_NOT_SELECT", message: "query runs exactly one SELECT (DESCRIBE, SUMMARIZE and SHOW also work)",
      hint: "to export, put the SELECT in an asset or pipe --json output; exports are post-v1",
    });
    const human = await cli(["query", "copy github_issues to 'out.csv'"], { cwd: p.root });
    expect(human.stderr).toContain("error QUERY_NOT_SELECT");
    expect((await cli(["query", "delete from github_issues", "--json"], { cwd: p.root })).json.problems[0].code).toBe("QUERY_NOT_SELECT");
    expect((await cli(["query", "attach 'x.duckdb'", "--json"], { cwd: p.root })).json.problems[0].code).toBe("QUERY_NOT_SELECT");
  });

  test("two statements are SQL_NOT_ONE_STATEMENT; DESCRIBE and SUMMARIZE work", async () => {
    const p = await issues();
    expect((await cli(["query", "select 1; select 2", "--json"], { cwd: p.root })).json.problems[0].code).toBe("SQL_NOT_ONE_STATEMENT");
    const d = await cli(["query", "describe github_issues", "--json"], { cwd: p.root });
    expect(d.exit).toBe(0);
    expect(d.json.data.rows.map((r: { column_name: string }) => r.column_name)).toContain("labels");
  });

  test("paths outside files/ are QUERY_PATH_DENIED: the database, the state folder, .env, the system", async () => {
    const p = await issues({ ".env": "X=secretvalue\n" });
    for (const sql of [
      "select * from read_csv('/etc/hosts')",
      "select * from 'warehouse.duckdb'",
      "select * from read_blob('.croft/runs.sqlite')",
      "select * from read_text('.env')",
      `select * from read_csv('${join(p.root, "croft.json")}')`,
    ]) {
      const r = await cli(["query", sql, "--json"], { cwd: p.root });
      expect(r.exit).toBe(2);
      expect(r.json.problems[0].code).toBe("QUERY_PATH_DENIED");
    }
  });

  test("zero-asset reads of files/ work, relative to the project from any folder inside it", async () => {
    const p = await issues({ "files/sales/a.csv": "order_id,amount\n1,10\n2,20\n", "files/sales/b.csv": "order_id,amount\n3,30\n" });
    const before = process.cwd();
    const fromRoot = await cli(["query", "select count(*) AS n, sum(amount::INTEGER) AS total from 'files/sales/*.csv'", "--json"], { cwd: p.root });
    expect(fromRoot.json.data.rows).toEqual([{ n: 3, total: "60" }]);   // sum() of INTEGER is HUGEINT: a string
    const fromSub = await cli(["query", "select * from read_csv('files/sales/a.csv') order by order_id", "--json"], { cwd: join(p.root, "assets") });
    expect(fromSub.exit).toBe(0);
    expect(fromSub.json.data.rowCount).toBe(2);
    expect(process.cwd()).toBe(before);
    const outside = await cli(["query", "select * from '../x.csv'", "--json"], { cwd: p.root });
    expect(outside.json.problems[0].code).toBe("QUERY_PATH_DENIED");
  });

  test("an unknown table is UNKNOWN_TABLE", async () => {
    const p = await issues();
    const r = await cli(["query", "select * from nope", "--json"], { cwd: p.root });
    expect(r.exit).toBe(2);
    expect(r.json.problems[0].code).toBe("UNKNOWN_TABLE");
  });
});

describe("croft query: usage and state", () => {
  test("--preview is refused clearly until croft preview exists", async () => {
    const p = await issues();
    const r = await cli(["query", "select 1", "--preview", "--json"], { cwd: p.root });
    expect(r.exit).toBe(2);
    expect(r.json.problems[0]).toMatchObject({ code: "USAGE_ERROR" });
    expect(r.json.problems[0].message).toContain("--preview");
  });

  test("no SQL is a usage error", async () => {
    const p = await issues();
    const r = await cli(["query", "--json"], { cwd: p.root });
    expect(r.exit).toBe(2);
    expect(r.json.problems[0].code).toBe("USAGE_ERROR");
    expect((await cli(["query", "a", "b", "--json"], { cwd: p.root })).json.problems[0].code).toBe("USAGE_ERROR");
  });

  test("before the first run, files/ can be queried (the zero-asset path) and nothing is created", async () => {
    const p = makeProject({ files: { "assets/github_issues.ts": ISSUES_TS, "files/sales/a.csv": "order_id,amount\n1,10\n2,20\n", "files/sales/b.csv": "order_id,amount\n3,30\n" } });
    const r = await cli(["query", "select count(*) AS n, sum(amount::INTEGER) AS total from 'files/sales/*.csv'", "--json"], { cwd: p.root });
    expect(r.exit).toBe(0);
    expect(r.json).toMatchObject({ ok: true, problems: [] });
    expect(r.json.data.rows).toEqual([{ n: 3, total: "60" }]);
    // From a subfolder too, and plain SQL with no table at all.
    const sub = await cli(["query", "select * from read_csv('files/sales/a.csv') order by order_id", "--json"], { cwd: join(p.root, "assets") });
    expect(sub.exit).toBe(0);
    expect(sub.json.data.rowCount).toBe(2);
    expect((await cli(["query", "select 1 AS one", "--json"], { cwd: p.root })).json.data.rows).toEqual([{ one: 1 }]);
    // A read-only command never creates the warehouse (or anything in the state folder).
    expect(existsSync(p.database)).toBe(false);
    expect(readdirSync(p.stateDir)).toEqual([]);
  });

  test("before the first run the sandbox still holds: only files/ is reachable", async () => {
    const p = makeProject({ files: { "assets/github_issues.ts": ISSUES_TS, ".env": "X=secretvalue\n" } });
    for (const sql of ["select * from read_csv('/etc/hosts')", "select * from read_text('.env')", "select * from read_text('croft.json')", "select * from '../x.csv'"]) {
      const r = await cli(["query", sql, "--json"], { cwd: p.root });
      expect(r.exit).toBe(2);
      expect(r.json.problems[0].code).toBe("QUERY_PATH_DENIED");
    }
    const write = await cli(["query", "create table t as select 1", "--json"], { cwd: p.root });
    expect(write.exit).toBe(2);
    expect(write.json.problems[0].code).toBe("QUERY_NOT_SELECT");
    expect(existsSync(p.database)).toBe(false);
  });

  test("before the first run, an asset's table is DB_NOT_FOUND with the run that builds it; another name is UNKNOWN_TABLE", async () => {
    const p = makeProject({ files: { "assets/github_issues.ts": ISSUES_TS } });
    const r = await cli(["query", "select count(*) from github_issues", "--json"], { cwd: p.root });
    expect(r.exit).toBe(2);
    expect(r.json.problems[0]).toMatchObject({
      code: "DB_NOT_FOUND", fix: { kind: "command", command: "croft run github_issues" }, details: { table: "github_issues", asset: "github_issues" },
    });
    expect(r.json.problems[0].message).toContain("github_issues");
    const other = await cli(["query", "select * from github_isues", "--json"], { cwd: p.root });
    expect(other.exit).toBe(2);
    expect(other.json.problems[0]).toMatchObject({ code: "UNKNOWN_TABLE", details: { table: "github_isues" } });
    expect(other.json.problems[0].hint).toContain("github_issues");
    expect(existsSync(p.database)).toBe(false);
  });

  test("outside a project: PROJECT_NOT_FOUND", async () => {
    const r = await cli(["query", "select 1", "--json"], { cwd: "/" });
    expect(r.json.problems[0].code).toBe("PROJECT_NOT_FOUND");
  });

  test("a query waits for another program's lock to go, then answers", async () => {
    const p = await issues();
    const holder = spawnHolder(p.database, 1200);
    await holder.waitFor("held");
    const started = Date.now();
    const r = await cli(["query", "select count(*) AS n from github_issues", "--json"], { cwd: p.root });
    expect(r.exit).toBe(0);
    expect(r.json.data.rows).toEqual([{ n: 3 }]);
    expect(Date.now() - started).toBeGreaterThan(500);
  });
});
