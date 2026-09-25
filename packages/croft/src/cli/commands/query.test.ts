import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { cleanup as cleanupChildren, spawnHolder } from "../../read/testkit.ts";
import { putCatalog } from "../../history/catalog.ts";
import { CHARGES_TS, cleanup, cli, DEAD, ISSUES_CATALOG, ISSUES_SEED, ISSUES_TS, makeProject, runsDb, seed, shape } from "./inspect-testkit.ts";
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
  test("--preview without a preview is DB_NOT_FOUND, naming croft preview; no file is created", async () => {
    const p = await issues();
    const r = await cli(["query", "select 1", "--preview", "--json"], { cwd: p.root });
    expect(r.exit).toBe(2);
    expect(r.json.problems[0]).toMatchObject({ code: "DB_NOT_FOUND" });
    expect(r.json.problems[0].hint).toContain("croft preview <asset>");
    expect(existsSync(join(p.stateDir, "preview.duckdb"))).toBe(false);
  });

  test("--preview reads the preview database, through its views over the snapshots in the state folder", async () => {
    const p = await issues();
    const dir = join(p.stateDir, "preview");
    mkdirSync(dir, { recursive: true });
    const snap = join(dir, "github_issues.parquet");
    await seed(join(p.stateDir, "preview.duckdb"), [
      `COPY (SELECT 1 AS id, 'from the snapshot' AS title) TO '${snap}' (FORMAT parquet)`,
      `CREATE VIEW github_issues AS SELECT * FROM read_parquet('${snap}')`,
      `CREATE TABLE open_issues AS SELECT 7 AS id, 'built by the preview' AS title`,
    ]);
    const r = await cli(["query", "select o.title AS built, g.title AS read from open_issues o, github_issues g", "--preview", "--json"], { cwd: p.root });
    expect(r.exit).toBe(0);
    expect(r.json.data.rows).toEqual([{ built: "built by the preview", read: "from the snapshot" }]);
    // The live warehouse is not what --preview reads.
    const live = await cli(["query", "select count(*) AS n from github_issues", "--json"], { cwd: p.root });
    expect(live.json.data.rows).toEqual([{ n: 3 }]);
    // The SQL itself still cannot name a file in the state folder.
    const denied = await cli(["query", `select * from read_parquet('${snap}')`, "--preview", "--json"], { cwd: p.root });
    expect(denied.exit).toBe(2);
    expect(denied.json.problems[0].code).toBe("QUERY_PATH_DENIED");
    // A table the preview does not hold: UNKNOWN_TABLE, listing what it holds.
    const unknown = await cli(["query", "select * from nope", "--preview", "--json"], { cwd: p.root });
    expect(unknown.exit).toBe(2);
    expect(unknown.json.problems[0]).toMatchObject({ code: "UNKNOWN_TABLE", details: { preview: ["github_issues", "open_issues"] } });
    expect(unknown.json.problems[0].hint).toContain("the preview holds github_issues, open_issues");
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

  test("a warehouse that was built before and is now missing says so, not that nothing has run", async () => {
    // The warehouse file was deleted or moved after runs had built it: runs.sqlite still lists the run and the
    // table. The problem must not tell the agent a fresh project story ("nothing has run").
    const p = makeProject({ files: { "assets/github_issues.ts": ISSUES_TS } });
    const db = runsDb(p.stateDir);
    const run = db.createRun({ id: "r_0922_1155_ok01", trigger: "manual", human: true, argv: ["run", "github_issues"], identity: DEAD });
    db.finishRun(run.id, "succeeded");
    putCatalog(db, ISSUES_CATALOG);
    db.close();
    const r = await cli(["query", "select count(*) from github_issues", "--json"], { cwd: p.root });
    expect(r.exit).toBe(2);
    const problem = r.json.problems[0];
    expect(problem).toMatchObject({ code: "DB_NOT_FOUND", fix: { kind: "manual", requiresHuman: true }, details: { table: "github_issues", asset: "github_issues" } });
    expect(problem.message).toContain("warehouse.duckdb is missing");
    expect(problem.message).toContain("built it before");
    expect(problem.message).not.toContain("nothing has run");
    const other = await cli(["query", "select * from github_isues", "--json"], { cwd: p.root });
    expect(other.json.problems[0].code).toBe("UNKNOWN_TABLE");
    expect(other.json.problems[0].message).not.toContain("nothing has run");
    expect(other.json.problems[0].message).toContain("warehouse.duckdb is missing");
    expect(existsSync(p.database)).toBe(false);
  });

  test("runs that built no table yet: not built, and no claim that nothing has run", async () => {
    const p = makeProject({ files: { "assets/github_issues.ts": ISSUES_TS } });
    const db = runsDb(p.stateDir);
    const run = db.createRun({ id: "r_0922_1155_bad1", trigger: "manual", human: true, argv: ["run", "github_issues"], identity: DEAD });
    db.finishRun(run.id, "failed");
    db.close();
    const r = await cli(["query", "select count(*) from github_issues", "--json"], { cwd: p.root });
    expect(r.json.problems[0]).toMatchObject({ code: "DB_NOT_FOUND", fix: { kind: "command", command: "croft run github_issues" } });
    expect(r.json.problems[0].message).toBe("github_issues is not built yet: no run has written a table, so warehouse.duckdb does not exist");
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

// Once the warehouse exists, a table it does not have (e2e j28, bug 2 of W5.2): an asset never built is DB_NOT_FOUND with
// its run, as before the first run (§3b "Zero-asset path"); another name stays UNKNOWN_TABLE and suggests the closest
// asset (§5 "Errors from user queries"). Before, both were UNKNOWN_TABLE "list the tables with: croft status", no fix.
describe("croft query: a table the warehouse does not have", () => {
  /** github_issues is built (the seeded warehouse); stripe_charges is an asset that has not been built. */
  const both = () => issues({ "assets/stripe_charges.ts": CHARGES_TS });
  const problemOf = async (p: { root: string }, sql: string) => {
    const r = await cli(["query", sql, "--json"], { cwd: p.root });
    expect(r.exit).toBe(2);
    expect(r.json.problems).toHaveLength(1);
    return r.json.problems[0];
  };
  /** A finished run with one step of stripe_charges. */
  function stripeStep(p: { stateDir: string }, id: string, finish: { status: "failed" | "ok"; reason?: string; error?: { code: string } }) {
    const db = runsDb(p.stateDir);
    try {
      const run = db.createRun({ id, trigger: "manual", human: true, argv: ["run", "stripe_charges"], identity: DEAD });
      db.startStep({ runId: run.id, asset: "stripe_charges", attempt: 1, reason: finish.reason ?? "requested" });
      db.finishStep(run.id, "stripe_charges", 1, { status: finish.status, ...(finish.error ? { error: finish.error as never } : {}) });
      db.finishRun(run.id, finish.status === "ok" ? "succeeded" : "failed");
    } finally {
      db.close();
    }
  }

  test("an asset never built: it is not built yet, and the fix is its run", async () => {
    const p = await both();
    expect(await problemOf(p, "select count(*) from stripe_charges")).toMatchObject({
      code: "DB_NOT_FOUND", message: "stripe_charges is not built yet: it has never run, so warehouse.duckdb has no table stripe_charges",
      hint: "build it first: croft run stripe_charges",
      fix: { kind: "command", description: "build stripe_charges", command: "croft run stripe_charges" },
      details: { table: "stripe_charges", asset: "stripe_charges", duckdbErrorType: "Catalog" },
    });
    // Whatever case it is written in.
    expect(await problemOf(p, `select count(*) from "Stripe_Charges"`)).toMatchObject({ code: "DB_NOT_FOUND", fix: { command: "croft run stripe_charges" } });
  });

  test("an asset whose run failed: not built yet, the logs say why, and the fix is still its run", async () => {
    const p = await both();
    stripeStep(p, "r_0922_1156_bad1", { status: "failed", error: { code: "HTTP_ERROR" } });
    expect(await problemOf(p, "select count(*) from stripe_charges")).toMatchObject({
      code: "DB_NOT_FOUND", message: "stripe_charges is not built yet: its last run failed (HTTP_ERROR, r_0922_1156_bad1)",
      hint: "croft logs stripe_charges --failed says why; once that is fixed, croft run stripe_charges builds it",
      fix: { kind: "command", command: "croft run stripe_charges" },
    });
  });

  test("an asset croft delete removed: croft restore brings it back", async () => {
    const p = await both();
    stripeStep(p, "r_0922_1156_del1", { status: "ok", reason: "deleted" });
    expect(await problemOf(p, "select count(*) from stripe_charges")).toMatchObject({
      code: "DB_NOT_FOUND", message: "stripe_charges has no table: croft delete removed it (r_0922_1156_del1)",
      hint: "croft restore stripe_charges brings it back from the trash; croft run stripe_charges would build it from scratch",
      fix: { kind: "command", command: "croft restore stripe_charges" },
    });
  });

  test("an asset croft built whose table is gone: not \"not built yet\"; croft doctor checks the tables", async () => {
    const p = await both();
    const db = runsDb(p.stateDir);
    putCatalog(db, { ...ISSUES_CATALOG, asset: "stripe_charges", lastRunId: "r_0922_1155_ok02" });
    db.close();
    const problem = await problemOf(p, "select count(*) from stripe_charges");
    expect(problem).toMatchObject({ code: "DB_NOT_FOUND", fix: { kind: "command", command: "croft doctor" } });
    expect(problem.message).toBe("warehouse.duckdb has no table stripe_charges, although croft built it (run r_0922_1155_ok02): it was dropped or replaced outside croft");
  });

  test("a file renamed outside croft: ASSET_RENAMED with croft rename, never a run that fetches everything again", async () => {
    const p = await issues();
    const { resolveProject } = await import("../../project/resolve.ts");
    const hash = (await resolveProject({ root: p.root, timezone: "America/Los_Angeles" })).assets.find((a) => a.name === "github_issues")!.codeHash!;
    const db = runsDb(p.stateDir);
    putCatalog(db, { ...ISSUES_CATALOG, codeHash: hash });
    db.close();
    renameSync(join(p.root, "assets/github_issues.ts"), join(p.root, "assets/issues.ts"));
    expect(await problemOf(p, "select count(*) from issues")).toMatchObject({
      code: "ASSET_RENAMED", fix: { kind: "command", command: "croft rename github_issues issues" }, details: { table: "issues", from: "github_issues", to: "issues" },
    });
  });

  test("a typo in a built table's name: UNKNOWN_TABLE suggesting the asset, with the query corrected", async () => {
    const p = await both();
    expect(await problemOf(p, "select count(*) from github_issue where state = 'open'")).toMatchObject({
      code: "UNKNOWN_TABLE", message: "no table named github_issue",
      hint: "did you mean github_issues?",
      fix: { kind: "command", description: "query github_issues", command: `croft query "select count(*) from github_issues where state = 'open'"` },
      details: { table: "github_issue", suggestion: "github_issues" },
    });
    // Named twice: the suggestion, but no rewritten query.
    const twice = await problemOf(p, "select github_issue.id from github_issue");
    expect(twice).toMatchObject({ code: "UNKNOWN_TABLE", hint: "did you mean github_issues?", details: { suggestion: "github_issues" } });
    expect(twice.fix).toBeUndefined();
  });

  test("a typo in the name of an asset not built yet: the suggestion, and its run", async () => {
    const p = await both();
    expect(await problemOf(p, "select count(*) from stripe_charge")).toMatchObject({
      code: "UNKNOWN_TABLE", message: "no table named stripe_charge",
      hint: "did you mean stripe_charges? It is not built yet: croft run stripe_charges builds it",
      fix: { kind: "command", description: "build stripe_charges", command: "croft run stripe_charges" },
      details: { table: "stripe_charge", suggestion: "stripe_charges" },
    });
  });

  test("a name like no asset's: UNKNOWN_TABLE naming the assets", async () => {
    const p = await both();
    const problem = await problemOf(p, "select * from customers");
    expect(problem).toMatchObject({
      code: "UNKNOWN_TABLE", message: "no table named customers",
      hint: "no asset is named customers; the assets are github_issues, stripe_charges (croft status shows which are built)",
      details: { table: "customers" },
    });
    expect(problem.fix).toBeUndefined();
  });
});
