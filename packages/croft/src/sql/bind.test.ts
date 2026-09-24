import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { DuckDBConnection } from "@duckdb/node-api";
import { CroftError } from "../core/errors.ts";
import { openMemory } from "../db/connect.ts";
import type { LoadedSqlAsset } from "../project/sql-asset.ts";
import { duckdbPosition, mapAssetError, ShadowCatalog, type ShadowColumn } from "./bind.ts";
import * as deps from "./deps.ts";

let db: Awaited<ReturnType<typeof openMemory>>;
let conn: DuckDBConnection;
beforeAll(async () => {
  db = await openMemory({ timezone: "UTC" });
  conn = await db.connect();
  await conn.run("CREATE TABLE github_issues (id BIGINT, title VARCHAR, created_at TIMESTAMPTZ)");
});
afterAll(() => db.close());

// Until sql/deps.ts planScans is built (builder A of the same wave), a stand-in with its contract: the scans of
// the unoptimized plan, ASCII-lowercased, unique and sorted. It goes away by itself once the real one exists.
async function standInPlanScans(c: DuckDBConnection, body: string): Promise<string[] | null> {
  await c.run("PRAGMA disable_optimizer");
  try {
    const reader = await c.runAndReadAll(`EXPLAIN (FORMAT json) ${body}`);
    const out = new Set<string>();
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== "object") return;
      const table = (n as { extra_info?: { Table?: unknown } }).extra_info?.Table;
      if (typeof table === "string") out.add(table.split(".").at(-1)!.toLowerCase());
      walk((n as { children?: unknown }).children);
    };
    walk(JSON.parse(String(reader.getRowsJS()[0]![1])));
    return [...out].sort();
  } catch {
    return null;
  } finally {
    await c.run("PRAGMA enable_optimizer");
  }
}
// The stub throws before it looks at its connection; the real one fails on the missing connection instead.
const planScansIsStub = await Promise.resolve()
  .then(() => deps.planScans(undefined as unknown as DuckDBConnection, "SELECT 1"))
  .then(() => false, (e: unknown) => String((e as Error | undefined)?.message).startsWith("PHASE_STUB"));
if (planScansIsStub) mock.module("./deps.ts", () => ({ planScans: standInPlanScans }));

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
async function mapped(body: string, o: { prefix?: string; lineOffset?: number; pending?: Record<string, string[]> } = {}): Promise<CroftError> {
  const e = mapAssetError(await duckError((o.prefix ?? "") + body), { file: "assets/open_issues.sql", lineOffset: o.lineOffset ?? 0, body, pending: o.pending });
  expect(e).toBeInstanceOf(CroftError);
  return e as CroftError;
}

describe("mapAssetError: mapQueryError, located in the asset's file", () => {
  test("a binder error's line is shifted past the header; the column is the caret's", async () => {
    const e = await mapped("SELECT id,\n  titel\nFROM github_issues", { lineOffset: 3 });
    expect(e.problem).toMatchObject({ code: "UNKNOWN_COLUMN", file: "assets/open_issues.sql", line: 5, column: 3 });
    expect(e.problem.details).toMatchObject({ duckdbErrorType: "Binder" });
  });

  test("a qualified column the table lacks is UNKNOWN_COLUMN too", async () => {
    const e = await mapped("SELECT g.id,\n  g.titel\nFROM github_issues g", { lineOffset: 1 });
    expect(e.problem).toMatchObject({ code: "UNKNOWN_COLUMN", message: 'Table "g" does not have a column named "titel"', line: 3, column: 3 });
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

  test("a failure on a line naming a pending column keeps its code and hints at a pin", async () => {
    const e = await mapped("SELECT id,\n  title * 2 AS t\nFROM github_issues", { pending: { github_issues: ["title"] } });
    expect(e.problem).toMatchObject({ code: "QUERY_FAILED", severity: "error", line: 2, details: { pendingColumns: [{ table: "github_issues", column: "title" }] } });
    expect(e.problem.hint).toContain('columns: { title: "<type>" }');
    // A pending column elsewhere in the body is not this error's.
    const other = await mapped("SELECT title,\n  id || 1 + 'x' AS t\nFROM github_issues", { pending: { github_issues: ["title"] } });
    expect(other.problem.details?.pendingColumns).toBeUndefined();
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

// ---------------------------------------------------------------------------------------------------------
// The shadow catalog

/** An SQL asset as project/sql-asset.ts loadSqlAsset returns it, `headerLines` header lines above `body`. */
function asset(name: string, body: string, o: { headerLines?: number; astInputs?: string[] } = {}): LoadedSqlAsset {
  const lines = o.headerLines ?? 0;
  return {
    name, file: `assets/${name}.sql`, path: `/project/assets/${name}.sql`, ok: true,
    header: { key: [], checks: [], warnings: [], lines }, body, headerLines: lines, astInputs: o.astInputs ?? [], problems: [],
  };
}

const ISSUES: ShadowColumn[] = [
  { name: "id", type: "BIGINT" }, { name: "number", type: "BIGINT" }, { name: "title", type: "VARCHAR" },
  { name: "user", type: "JSON" }, { name: "labels", type: "JSON" }, { name: "state", type: "VARCHAR" },
  { name: "pull_request", type: "JSON" }, { name: "comments", type: "BIGINT" }, { name: "created_at", type: "TIMESTAMPTZ" },
  { name: "closed_at", type: "TIMESTAMPTZ" }, { name: "score", type: "VARCHAR" }, { name: "order", type: "BIGINT" },
  { name: "_loaded_at", type: "TIMESTAMPTZ" },
];
const CHARGES: ShadowColumn[] = [
  { name: "id", type: "VARCHAR" }, { name: "created", type: "BIGINT" }, { name: "amount", type: "BIGINT" },
  { name: "amount_refunded", type: "BIGINT" }, { name: "currency", type: "VARCHAR" }, { name: "status", type: "VARCHAR" },
  { name: "_file", type: "VARCHAR" },
];
const FILES = { github_issues: "assets/github_issues.ts", stripe_charges: "assets/stripe_charges.ts", open_issues: "assets/open_issues.sql", issue_triage: "assets/issue_triage.ts" };

// DESIGN.md §3c, with a two-line header above it.
const OPEN_ISSUES = `SELECT
  id,
  number,
  title,
  user->>'login'        AS author,        -- nested objects are JSON columns
  labels->>'$[*].name'  AS label_names,   -- VARCHAR[]
  comments,
  created_at
FROM github_issues
WHERE state = 'open' AND pull_request IS NULL
`;

let cat: ShadowCatalog;
beforeAll(async () => {
  cat = await ShadowCatalog.open("America/Los_Angeles");
  await cat.define("github_issues", ISSUES);
  await cat.define("stripe_charges", CHARGES);
});
afterAll(() => cat.close());

describe("ShadowCatalog.bind", () => {
  test("an asset that binds: its output columns, typed as the catalog records them, and its plan's scans", async () => {
    const r = await cat.bind(asset("open_issues", OPEN_ISSUES, { headerLines: 2, astInputs: ["github_issues"] }));
    expect(r.problems).toEqual([]);
    expect(r.outputColumns).toEqual([
      { name: "id", type: "BIGINT" }, { name: "number", type: "BIGINT" }, { name: "title", type: "VARCHAR" },
      { name: "author", type: "VARCHAR" }, { name: "label_names", type: "VARCHAR[]" }, { name: "comments", type: "BIGINT" },
      { name: "created_at", type: "TIMESTAMPTZ" },
    ]);
    expect(r.planInputs).toEqual(["github_issues"]);
  });

  test("the output feeds the next asset's shadow table, which has _loaded_at like every croft table", async () => {
    const first = await cat.bind(asset("open_issues", OPEN_ISSUES, { astInputs: ["github_issues"] }));
    await cat.define("open_issues", first.outputColumns!);
    const r = await cat.bind(asset("issue_summary",
      "SELECT author, count(*) AS n, max(_loaded_at) AS seen, list(label_names) AS labels FROM open_issues GROUP BY ALL", { astInputs: ["open_issues"] }));
    expect(r.problems).toEqual([]);
    expect(r.outputColumns).toEqual([
      { name: "author", type: "VARCHAR" }, { name: "n", type: "BIGINT" }, { name: "seen", type: "TIMESTAMPTZ" }, { name: "labels", type: "VARCHAR[][]" },
    ]);
    expect(r.planInputs).toEqual(["open_issues"]);
  });

  test("nested types keep DuckDB's spelling, JSON inside them included; reserved columns are left out", async () => {
    const r = await cat.bind(asset("shapes",
      `SELECT g.id, [user] AS users, {'u': user, 'Mixed Case': 1} AS s, 1.5::DECIMAL(18, 2) AS d, g._loaded_at, c._file
       FROM github_issues g, stripe_charges c -- trailing comment`));
    expect(r.problems).toEqual([]);
    expect(r.outputColumns).toEqual([
      { name: "id", type: "BIGINT" }, { name: "users", type: "JSON[]" }, { name: "s", type: 'STRUCT(u JSON, "Mixed Case" INTEGER)' },
      { name: "d", type: "DECIMAL(18,2)" },
    ]);
  });

  test("a trailing ; or -- comment, and `SELECT *` over one asset", async () => {
    for (const body of ["SELECT * FROM stripe_charges;", "SELECT * FROM stripe_charges -- all of it", "SELECT *\nFROM stripe_charges;\n-- done\n"]) {
      const r = await cat.bind(asset("charges", body));
      expect({ body, problems: r.problems, names: r.outputColumns?.map((c) => c.name) })
        .toEqual({ body, problems: [], names: ["id", "created", "amount", "amount_refunded", "currency", "status"] });
    }
  });

  test("the project time zone is set: ::DATE of an instant is a project day", async () => {
    const r = await cat.bind(asset("days", "SELECT created_at::DATE AS day, current_setting('TimeZone') AS tz FROM github_issues"));
    expect(r.outputColumns).toEqual([{ name: "day", type: "DATE" }, { name: "tz", type: "VARCHAR" }]);
  });

  test("UNKNOWN_COLUMN: DuckDB's closest candidate binding becomes an edit fix, past the header", async () => {
    const body = OPEN_ISSUES.replace("  created_at", "  creatd_at");
    const r = await cat.bind(asset("open_issues", body, { headerLines: 3, astInputs: ["github_issues"] }), { assetFiles: FILES });
    expect(r.outputColumns).toBeNull();
    expect(r.planInputs).toBeNull();
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({
      severity: "error", code: "UNKNOWN_COLUMN", asset: "open_issues", file: "assets/open_issues.sql", line: 11, column: 3,
      message: 'Referenced column "creatd_at" not found in FROM clause.',
      hint: 'did you mean "created_at"?',
      fix: { kind: "edit", description: "fix the column name", file: "assets/open_issues.sql", line: 11, replace: { from: "creatd_at", to: "created_at" } },
      details: { column: "creatd_at", duckdbErrorType: "Binder" },
    });
    expect(r.problems[0]!.details?.candidates).toContain("created_at");
  });

  test("UNKNOWN_COLUMN: a qualified name, and the spelling as written", async () => {
    const r = await cat.bind(asset("a", "SELECT g.id,\n  g.Creatd_At\nFROM github_issues g", { headerLines: 1 }));
    expect(r.problems[0]).toMatchObject({
      code: "UNKNOWN_COLUMN", line: 3, column: 3, message: 'Table "g" does not have a column named "Creatd_At"',
      fix: { kind: "edit", line: 3, replace: { from: "Creatd_At", to: "created_at" } },
    });
  });

  test("UNKNOWN_COLUMN: no fix when nothing is close", async () => {
    const r = await cat.bind(asset("a", "SELECT zzzzzz FROM github_issues", { astInputs: ["github_issues"] }));
    expect(r.problems[0]).toMatchObject({ code: "UNKNOWN_COLUMN", hint: "check the column name (croft describe github_issues lists them)" });
    expect(r.problems[0]!.fix).toBeUndefined();
  });

  test("UNKNOWN_TABLE: the did-you-mean comes from the project's assets, never DuckDB's system views", async () => {
    const r = await cat.bind(asset("a", "SELECT id\nFROM github_isues", { headerLines: 2 }), { assetFiles: FILES });
    expect(r.problems).toEqual([expect.objectContaining({
      code: "UNKNOWN_TABLE", asset: "a", line: 4, column: 6, message: "no table named github_isues", hint: "did you mean github_issues?",
      fix: { kind: "edit", description: "fix the table name", file: "assets/a.sql", line: 4, replace: { from: "github_isues", to: "github_issues" } },
    })]);
    const far = await cat.bind(asset("a", "SELECT id FROM nothing_like_it"), { assetFiles: FILES });
    expect(far.problems[0]).toMatchObject({ code: "UNKNOWN_TABLE", hint: "list the tables with: croft status" });
    expect(JSON.stringify(far.problems)).not.toContain("pg_");
    // Without assetFiles, the defined tables are the candidates.
    const defined = await cat.bind(asset("a", "SELECT id FROM stripe_charge"));
    expect(defined.problems[0]).toMatchObject({ code: "UNKNOWN_TABLE", hint: "did you mean stripe_charges?" });
  });

  test("INPUT_NOT_BUILT: an asset with no shadow table yet is info, not an error", async () => {
    const r = await cat.bind(asset("triage_report", "SELECT * FROM issue_triage"), { assetFiles: FILES });
    expect(r.outputColumns).toBeNull();
    expect(r.problems).toEqual([expect.objectContaining({
      severity: "info", code: "INPUT_NOT_BUILT", asset: "triage_report", file: "assets/triage_report.sql", details: { input: "issue_triage" },
    })]);
  });

  test("QUOTE_IDENTIFIER: a keyword column written bare, as an edit fix; ORDER BY stays a keyword", async () => {
    const body = "SELECT id, order\nFROM github_issues\nWHERE order > 1\nORDER BY order";
    const r = await cat.bind(asset("a", body, { headerLines: 1 }));
    expect(r.outputColumns).toBeNull();
    expect(r.problems.map((p) => [p.code, p.line, p.column])).toEqual([["QUOTE_IDENTIFIER", 2, 12], ["QUOTE_IDENTIFIER", 4, 7], ["QUOTE_IDENTIFIER", 5, 10]]);
    expect(r.problems[0]).toMatchObject({
      severity: "error", asset: "a", file: "assets/a.sql",
      message: 'order is an SQL keyword, so as a column name it must be quoted: "order"',
      fix: { kind: "edit", file: "assets/a.sql", line: 2, replace: { from: "order", to: '"order"' } },
    });
    // Once quoted, it binds; `g.order` and `AS order` never needed quotes.
    const fixed = await cat.bind(asset("a", 'SELECT id, "order", g.order AS o2, 1 AS group FROM github_issues g ORDER BY "order"'));
    expect(fixed.problems).toEqual([]);
  });

  test("QUOTE_IDENTIFIER, then the syntax error that remains after quoting", async () => {
    const r = await cat.bind(asset("a", "SELECT id, order\nFROM github_issues\nWHERE id >", { headerLines: 2 }));
    expect(r.problems.map((p) => [p.code, p.line, p.column])).toEqual([["QUOTE_IDENTIFIER", 3, 12], ["SQL_SYNTAX", undefined, undefined]]);
    expect(r.problems[1]).toMatchObject({ asset: "a", file: "assets/a.sql", message: "Parser Error: syntax error at end of input" });
    const inner = await cat.bind(asset("a", "SELECT id, order\nFROM github_issues\nWHERE id > > 1", { headerLines: 2 }));
    expect(inner.problems.map((p) => [p.code, p.line, p.column])).toEqual([["QUOTE_IDENTIFIER", 3, 12], ["SQL_SYNTAX", 5, 12]]);
  });

  test("QUOTE_IDENTIFIER is not claimed for other syntax errors", async () => {
    for (const body of ["SELECT id FROM github_issues WHERE", "SELECT id FROM github_issues ORDER id", "SELECT id, title,, FROM github_issues"]) {
      const r = await cat.bind(asset("a", body));
      expect({ body, codes: r.problems.map((p) => p.code) }).toEqual({ body, codes: ["SQL_SYNTAX"] });
    }
    // A keyword that no table has as a column is not offered either (LIMIT without a number).
    const r = await cat.bind(asset("a", "SELECT id FROM github_issues LIMIT"));
    expect(r.problems.map((p) => p.code)).toEqual(["SQL_SYNTAX"]);
    // Keywords inside strings, quoted names and comments are left alone.
    const s = await cat.bind(asset("a", "SELECT 'order' AS x, \"order\" -- order\nFROM github_issues"));
    expect(s.problems).toEqual([]);
  });

  test("NULL_ONLY_COLUMN: an error a pending column's retype removes; the type that binds is the pin", async () => {
    const pending = { github_issues: ["closed_at", "score"] };
    const text = await cat.bind(asset("a", "SELECT id,\n  left(closed_at, 4) AS year\nFROM github_issues", { headerLines: 2, astInputs: ["github_issues"] }), { pending, assetFiles: FILES });
    expect(text.outputColumns).toBeNull();
    expect(text.problems).toEqual([expect.objectContaining({
      severity: "warning", code: "NULL_ONLY_COLUMN", asset: "a", file: "assets/a.sql", line: 4,
      hint: 'pin the type in assets/github_issues.ts: columns: { closed_at: "VARCHAR" }, or wait until closed_at has values',
      fix: { kind: "edit", description: 'pin the type of closed_at in assets/github_issues.ts: columns: { closed_at: "VARCHAR" }', file: "assets/github_issues.ts", insert: 'columns: { closed_at: "VARCHAR" }' },
      details: expect.objectContaining({ input: "github_issues", column: "closed_at", placeholderType: "TIMESTAMPTZ", pinType: "VARCHAR" }),
    })]);
    const number = await cat.bind(asset("a", "SELECT sum(score) AS total FROM github_issues"), { pending, assetFiles: FILES });
    expect(number.problems[0]).toMatchObject({ code: "NULL_ONLY_COLUMN", details: { column: "score", placeholderType: "VARCHAR", pinType: "DOUBLE" } });
    // Without the input's file, the fix says where in words.
    const manual = await cat.bind(asset("a", "SELECT score * 2 AS s FROM github_issues"), { pending });
    expect(manual.problems[0]!.fix).toEqual({ kind: "manual", description: 'pin the type of score in github_issues\'s definition: columns: { score: "DOUBLE" }' });
    // The shadow table has its own types again.
    const after = await cat.bind(asset("a", "SELECT closed_at, score FROM github_issues"));
    expect(after.outputColumns).toEqual([{ name: "closed_at", type: "TIMESTAMPTZ" }, { name: "score", type: "VARCHAR" }]);
  });

  test("NULL_ONLY_COLUMN is not claimed when the column is not pending, or no type fixes it", async () => {
    const settled = await cat.bind(asset("a", "SELECT left(closed_at, 4) AS y FROM github_issues"), { pending: { github_issues: ["score"] } });
    expect(settled.problems[0]).toMatchObject({ code: "QUERY_FAILED", severity: "error", details: { duckdbErrorType: "Binder" } });
    const hopeless = await cat.bind(asset("a", "SELECT closed_at + [1] AS y FROM github_issues"), { pending: { github_issues: ["closed_at"] } });
    expect(hopeless.problems[0]).toMatchObject({ code: "QUERY_FAILED", severity: "error", details: { pendingColumns: [{ table: "github_issues", column: "closed_at" }] } });
    // A pending column of a table the asset does not read is not tried.
    const elsewhere = await cat.bind(asset("a", "SELECT upper(created) AS c FROM stripe_charges", { astInputs: ["stripe_charges"] }), { pending: { github_issues: ["created"] } });
    expect(elsewhere.problems[0]!.code).toBe("QUERY_FAILED");
  });

  test("DUPLICATE_OUTPUT_COLUMN: repeated names, located at the repeat; the first column of the name is kept", async () => {
    const r = await cat.bind(asset("a", "SELECT id,\n  title,\n  number AS ID\nFROM github_issues", { headerLines: 2 }));
    expect(r.problems).toEqual([expect.objectContaining({
      severity: "error", code: "DUPLICATE_OUTPUT_COLUMN", asset: "a", file: "assets/a.sql", line: 5,
      message: "the output has 2 columns named id; the table would get id, ID_1",
      details: { column: "id", count: 2, renamedTo: ["ID_1"] },
    })]);
    expect(r.outputColumns).toEqual([{ name: "id", type: "BIGINT" }, { name: "title", type: "VARCHAR" }]);
    expect(r.planInputs).toEqual(["github_issues"]);
  });

  test("SELECT * over two assets repeats their _loaded_at, which the SQL step drops: no DUPLICATE_OUTPUT_COLUMN", async () => {
    // run/sql.ts materialize drops every copy of a reserved name, renamed ones (_loaded_at_1) included (R2.1).
    await cat.define("issue_triage", [{ name: "id", type: "BIGINT" }, { name: "priority", type: "VARCHAR" }]);
    const r = await cat.bind(asset("a", "SELECT * FROM open_issues JOIN issue_triage USING (id)"));
    expect(r.problems).toEqual([]);
    expect(r.outputColumns?.map((c) => c.name)).toEqual(["id", "number", "title", "author", "label_names", "comments", "created_at", "priority"]);
  });

  test("reserved names repeated in any case are dropped, _croft_seq too; other repeats are still DUPLICATE_OUTPUT_COLUMN", async () => {
    const r = await cat.bind(asset("a",
      "SELECT g.id, g._loaded_at, c._LOADED_AT, c._file, c._file AS _FILE, 1 AS _croft_seq, 2 AS _Croft_Seq, g.title, c.status AS TITLE\nFROM github_issues g, stripe_charges c"));
    expect(r.problems.map((p) => [p.code, p.details?.column])).toEqual([["DUPLICATE_OUTPUT_COLUMN", "title"]]);
    expect(r.outputColumns?.map((c) => c.name)).toEqual(["id", "title"]);
  });

  test("a DOUBLE constant beyond range (json_serialize_sql writes Infinity) still locates a duplicate", async () => {
    const r = await cat.bind(asset("a", "SELECT id,\n  number AS id\nFROM github_issues WHERE comments < 1e400", { headerLines: 1 }));
    expect(r.problems.map((p) => [p.code, p.line])).toEqual([["DUPLICATE_OUTPUT_COLUMN", 3]]);
  });

  test("parameters are refused; a body that is not one SELECT binds to nothing (the loader says why)", async () => {
    const p = await cat.bind(asset("a", "SELECT id FROM github_issues WHERE id = $1"));
    expect(p.problems[0]).toMatchObject({ code: "QUERY_FAILED", message: "an SQL asset cannot use parameters ($1, ?, $name)" });
    for (const body of ["SELECT 1; SELECT 2", "CREATE TABLE x AS SELECT 1", "", "-- nothing"]) {
      expect(await cat.bind(asset("a", body))).toEqual({ outputColumns: null, problems: [], planInputs: null });
    }
    expect((await cat.bind(asset("a", "SELECT 1 AS one"))).outputColumns).toEqual([{ name: "one", type: "INTEGER" }]);
  });

  test("the shadow database reaches no files", async () => {
    const r = await cat.bind(asset("a", "SELECT * FROM read_csv('/etc/hosts')"));
    expect(r.problems[0]).toMatchObject({ code: "QUERY_PATH_DENIED", asset: "a" });
  });

  test("define replaces a table; an unusable type is a croft bug", async () => {
    await cat.define("scratch", [{ name: "a", type: "BIGINT" }]);
    await cat.define("scratch", [{ name: "b", type: "VARCHAR" }, { name: "_loaded_at", type: "TIMESTAMPTZ" }]);
    const r = await cat.bind(asset("x", "SELECT * FROM scratch"));
    expect(r.outputColumns).toEqual([{ name: "b", type: "VARCHAR" }]);
    const e = await cat.define("broken", [{ name: "a", type: "NOT A TYPE" }]).then(() => null, (x: unknown) => x as CroftError);
    expect(e?.code).toBe("INTERNAL_ERROR");
  });

  test("calls made together run one at a time", async () => {
    const pending = { github_issues: ["closed_at"] };
    const [a, , b, c] = await Promise.all([
      cat.bind(asset("a", "SELECT left(closed_at, 4) AS y FROM github_issues"), { pending }),
      cat.define("parallel", [{ name: "p", type: "BIGINT" }]),
      cat.bind(asset("b", "SELECT closed_at, p FROM github_issues, parallel")),
      cat.bind(asset("c", "SELECT id, id FROM github_issues")),
    ]);
    expect(a.problems[0]!.code).toBe("NULL_ONLY_COLUMN");
    expect(b.outputColumns).toEqual([{ name: "closed_at", type: "TIMESTAMPTZ" }, { name: "p", type: "BIGINT" }]);
    expect(c.problems[0]!.code).toBe("DUPLICATE_OUTPUT_COLUMN");
  });

  test("close is idempotent", async () => {
    const c = await ShadowCatalog.open("UTC");
    c.close();
    c.close();
  });
});
