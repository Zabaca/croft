import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { Check } from "../core/types.ts";
import { openMemory } from "../db/connect.ts";
import { analyzeChecks, checkColumns, lexicalReads, minRowsOf, parseChecks, type ParseChecksInput, tokenize, validateChecks, vetCheck } from "./parse.ts";

let db: Awaited<ReturnType<typeof openMemory>>;
let conn: DuckDBConnection;
beforeAll(async () => {
  db = await openMemory({ timezone: "UTC" });
  conn = await db.connect();
});
afterAll(() => db.close());

const input = (o: Partial<ParseChecksInput>): ParseChecksInput => ({ asset: "orders", file: "assets/orders.sql", key: [], checks: [], warnings: [], ...o });
const parse = (o: Partial<ParseChecksInput>) => parseChecks(input(o));
const one = (text: string, blocking = true) => {
  const r = parse(blocking ? { checks: [text] } : { warnings: [text] });
  return { check: r.checks[0], problem: r.problems[0], ...r };
};
const reads = (text: string) => {
  const t = tokenize(text);
  if ("error" in t) throw new Error(t.error);
  return lexicalReads(t.tokens, t.match);
};

describe("parseChecks: the check language, without DuckDB", () => {
  test("a key implies unique(key) and not_null(key), listed first and blocking", () => {
    const r = parse({ key: ["id"], checks: ["amount >= 0"], warnings: ["min_rows(10)"] });
    expect(r.problems).toEqual([]);
    expect(r.checks).toEqual([
      { source: "unique(id)", kind: "unique", blocking: true, scope: "table", sql: '"id"', reads: [] },
      { source: "not_null(id)", kind: "not_null", blocking: true, scope: "batch", sql: '"id"', reads: [] },
      { source: "amount >= 0", kind: "rule", blocking: true, scope: "batch", sql: "amount >= 0", reads: [] },
      { source: "min_rows(10)", kind: "min_rows", blocking: false, scope: "table", sql: "10", reads: [] },
    ]);
  });

  test("a composite key is one unique and one not_null over its columns; odd names are quoted", () => {
    const r = parse({ key: ["day", "Currency Code", 'we"ird'] });
    expect(r.checks.map((c) => [c.source, c.sql])).toEqual([
      ['unique(day, "Currency Code", "we""ird")', '"day", "Currency Code", "we""ird"'],
      ['not_null(day, "Currency Code", "we""ird")', '"day", "Currency Code", "we""ird"'],
    ]);
    expect(checkColumns(r.checks[0]!)).toEqual(["day", "Currency Code", 'we"ird']);
  });

  test("the forms: unique, not_null and min_rows, in any case and spacing", () => {
    expect(one("unique(a, b)").check).toMatchObject({ kind: "unique", scope: "table", sql: '"a", "b"', source: "unique(a, b)" });
    expect(one(" NOT_NULL ( author ) ").check).toMatchObject({ kind: "not_null", scope: "batch", sql: '"author"', source: "NOT_NULL ( author )" });
    expect(one('not_null("Order Date")').check).toMatchObject({ sql: '"Order Date"' });
    expect(one("min_rows(1_000)").check).toMatchObject({ kind: "min_rows", scope: "table", sql: "1000" });
    expect(minRowsOf(one("min_rows(100)").check!)).toBe(100);
  });

  test("anything else is a row rule over the rows written, blocking or not as declared", () => {
    expect(one("state IN ('open', 'closed')").check).toEqual({
      source: "state IN ('open', 'closed')", kind: "rule", blocking: true, scope: "batch", sql: "state IN ('open', 'closed')", reads: [],
    });
    expect(one("net <= gross", false).check).toMatchObject({ kind: "rule", blocking: false });
    // A trailing comment is part of the text; croft puts the expression on its own lines.
    expect(one("amount >= 0 -- refunds are separate").check?.sql).toBe("amount >= 0 -- refunds are separate");
  });

  test("a check listed twice, or a declared unique(key), is kept once", () => {
    const r = parse({ key: ["id"], checks: ["unique(id)", "amount > 0", "amount > 0"], warnings: ["not_null(id)"] });
    expect(r.checks.map((c) => c.source)).toEqual(["unique(id)", "not_null(id)", "amount > 0"]);
  });

  test("tables in a rule's subquery are read (ordering only); the asset itself is not", () => {
    expect(one("id IN (SELECT issue_id FROM issue_triage)").check?.reads).toEqual(["issue_triage"]);
    expect(one("amount <= (SELECT max(amount) FROM orders)").check?.reads).toEqual([]);
  });

  describe("CHECK_INVALID, with the asset, the file and the check", () => {
    const cases: [string, RegExp][] = [
      ["", /is empty/],
      ["   ", /is empty/],
      ["amount >= 0; DROP TABLE orders", /contains ;/],
      ["amount >= 0, state = 'x'", /lists several expressions/],
      ["(amount >= 0", /never closed/],
      ["amount >= 0)", /without its \(/],
      ["state = 'open", /never ends/],
      ['"state = 1', /never ends/],
      ["amount > 0 /* note", /never ends/],
      ["unique()", /names no columns/],
      ["unique(lower(a))", /column names only/],
      ["not_null(a, )", /column names only/],
      ["min_rows(x)", /whole number/],
      ["min_rows(-1)", /whole number/],
      ["min_rows(1.5)", /whole number/],
      ["min_rows(1, 2)", /whole number/],
      ["unique(id) AND amount > 0", /unique\(\) inside a larger expression/],
      ["amount > 0 OR not_null(a)", /not_null\(\) inside a larger expression/],
    ];
    for (const [text, why] of cases) {
      test(JSON.stringify(text), () => {
        const r = one(text);
        expect(r.checks).toEqual([]);
        expect(r.problem).toMatchObject({ code: "CHECK_INVALID", severity: "error", asset: "orders", file: "assets/orders.sql", details: { check: text.trim(), blocking: true } });
        expect(r.problem!.message).toMatch(why);
        expect(r.problem!.hint.length).toBeGreaterThan(0);
      });
    }

    test("a warning is named as one", () => {
      expect(one("unique()", false).problem?.message).toBe('orders: the warning "unique()" names no columns, e.g. unique(id)');
    });

    test("a near miss of a form gets a did-you-mean edit", () => {
      const p = one("notnull(author)").problem!;
      expect(p.message).toContain("did you mean not_null?");
      expect(p.fix).toEqual({ kind: "edit", description: "replace notnull(author) with not_null(author)", file: "assets/orders.sql", replace: { from: "notnull(author)", to: "not_null(author)" } });
      expect(one("uniqe(id)").problem?.fix).toMatchObject({ replace: { to: "unique(id)" } });
      expect(one("min_row(5)").problem?.fix).toMatchObject({ replace: { to: "min_rows(5)" } });
      // A real function call that merely looks short or different is a rule.
      expect(one("isfinite(amount)").check?.kind).toBe("rule");
      expect(one("regexp_matches(email, '@')").check?.kind).toBe("rule");
    });

    test("the other checks still parse", () => {
      const r = parse({ key: ["id"], checks: ["unique()", "amount > 0"] });
      expect(r.checks.map((c) => c.source)).toEqual(["unique(id)", "not_null(id)", "amount > 0"]);
      expect(r.problems.length).toBe(1);
    });
  });
});

describe("lexicalReads: the tables a rule's subqueries name", () => {
  const cases: [string, string[]][] = [
    ["id IN (SELECT id FROM github_issues)", ["github_issues"]],
    ["id IN (select i.id from Github_Issues i join labels AS l on l.id = i.label)", ["github_issues", "labels"]],
    ["EXISTS (FROM a WHERE a.x = orders.x)", ["a"]],
    ["x IN (SELECT id FROM main.a, \"B\" b, other.t, cat.main.c)", ["a", "b"]],
    ["x IN (WITH c AS (SELECT id FROM src) SELECT id FROM c)", ["src"]],
    ["x IN (WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c) SELECT n FROM c)", []],
    ["x IN (SELECT id FROM range(10) r(id))", []],
    ["x IN (SELECT id FROM 'files/x.csv')", []],
    ["x IN (SELECT id FROM (SELECT id FROM inner_t) s)", ["inner_t"]],
    ["x IN (SELECT s.id FROM (SELECT id FROM inner_t) AS s, after_t WHERE s.id = after_t.id)", ["inner_t", "after_t"]],
    ["x IN (SELECT a.id FROM a, LATERAL (SELECT * FROM b) l)", ["a", "b"]],
    ["extract(year FROM created_at) > 2000", []],
    ["substring(s FROM 2 FOR 3) = 'ab' AND trim(both 'x' FROM s) <> ''", []],
    ["x IS DISTINCT FROM y AND x IS NOT DISTINCT FROM z", []],
    ["(SELECT count(*) FROM t WHERE extract(year FROM d) > 1) > 0", ["t"]],
    ["'FROM nowhere' <> x AND \"from\" > 1", []],
    ["x IN (SELECT id FROM t1 UNION SELECT id FROM t2 EXCEPT SELECT id FROM t1)", ["t1", "t2"]],
  ];
  for (const [text, want] of cases) test(text, () => expect(reads(text)).toEqual(want));
});

describe("tokenize", () => {
  test("strings, quoted names, comments and dollar quotes are whole", () => {
    const t = tokenize("a = 'it''s; (' AND \"we\"\"ird\" > E'x\\'y' -- ; )\n/* nested /* ; */ ) */ AND b = $$;($$ AND c = $1");
    if ("error" in t) throw new Error(t.error);
    expect(t.tokens.map((x) => x.text)).toEqual(["a", "=", "'it''s; ('", "AND", '"we""ird"', ">", "E'x\\'y'", "AND", "b", "=", "$$;($$", "AND", "c", "=", "$1"]);
    expect(t.tokens[4]).toMatchObject({ kind: "ident", name: 'we"ird', quoted: true });
    expect(t.tokens[14]).toMatchObject({ kind: "param" });
  });

  test("an unbalanced bracket is an error", () => {
    expect(tokenize("f(a]")).toEqual({ error: "has a ] without its [" });
    expect(tokenize("[1, 2")).toEqual({ error: "has a [ that is never closed" });
  });
});

describe("validateChecks: DuckDB's parser, on any connection", () => {
  const rule = (sql: string, blocking = true): Check => ({ source: sql, kind: "rule", blocking, scope: "batch", sql, reads: [] });
  const invalidOf = async (sql: string) => {
    const ps = await validateChecks(conn, "orders", [rule(sql)], { file: "assets/orders.ts" });
    expect(ps.length).toBe(1);
    expect(ps[0]).toMatchObject({ code: "CHECK_INVALID", asset: "orders", file: "assets/orders.ts", details: { check: sql } });
    return ps[0]!.message;
  };

  test("valid checks: no problems, no tables needed", async () => {
    const r = parse({ key: ["id"], checks: ["amount >= 0", "state IN ('open','closed')", "id IN (SELECT issue_id FROM issue_triage)", "min_rows(3)"],
      warnings: ["EXISTS (FROM refunds r WHERE r.order_id = orders.id)", "amount > 0 -- trailing comment", "len(list_filter(tags, t -> t <> '')) > 0"] });
    expect(r.problems).toEqual([]);
    expect(await validateChecks(conn, "orders", r.checks)).toEqual([]);
  });

  test("syntax errors and injections are refused, never run", async () => {
    expect(await invalidOf("amount >=")).toContain("does not parse");
    // Closing the parenthesis to append a statement, a clause, a second item or a set operation needs a `)`
    // without its `(`: the text pass refuses it before DuckDB sees it.
    expect(await invalidOf("true) FROM orders; DROP TABLE orders; SELECT (1")).toMatch(/\) without its \(/);
    expect(await invalidOf("true) FROM other WHERE (1 = 1")).toMatch(/\) without its \(/);
    expect(await invalidOf("true) AS a, (false")).toMatch(/\) without its \(/);
    expect(await invalidOf("x) FROM t UNION SELECT (1")).toMatch(/\) without its \(/);
    expect(await invalidOf("(1, 2)")).toMatch(/list of values/);
    expect(await invalidOf("x > 0; DROP TABLE orders")).toContain("contains ;");
    expect(await invalidOf("x > 0 /* ) FROM t; DROP TABLE orders; SELECT ( */ AND")).toContain("does not parse");
  });

  test("where the text pass and DuckDB's parser would disagree, DuckDB's AST must be exactly the probe", async () => {
    // vetCheck with a parser that answers for other text: what DuckDB would make of an injection the text pass
    // missed. Each must be refused on the AST's shape alone.
    const real = async (sql: string) => String((await conn.runAndReadAll("SELECT json_serialize_sql($1::VARCHAR)::VARCHAR", [sql])).getRowsJS()[0]![0]);
    const as = (sql: string) => () => real(sql);
    const vet = (serialize: () => Promise<string>) => vetCheck(serialize, "orders", rule("x"));
    expect(await vet(as('SELECT (x) FROM "orders"'))).toEqual({ ok: true, reads: [] });
    for (const sql of [
      'SELECT (x) FROM "orders"; DROP TABLE orders',
      'SELECT (x) FROM "orders"; SELECT 1',
      'SELECT (x) FROM other WHERE (1 = 1) ',
      'SELECT (x) FROM "orders" WHERE true',
      'SELECT (x) FROM "orders" GROUP BY ALL',
      'SELECT (x) FROM "orders" LIMIT 1',
      'SELECT (x) FROM "orders" o',
      'SELECT (x) FROM main."orders"',
      'SELECT (x), (y) FROM "orders"',
      'SELECT (x) FROM t UNION SELECT (1) FROM "orders"',
      'WITH c AS (SELECT 1) SELECT (x) FROM "orders"',
      'SELECT (x) FROM "orders" USING SAMPLE 1',
    ]) {
      const v = await vet(as(sql));
      expect(v.ok, sql).toBe(false);
    }
  });

  test("files, SQL in strings, side effects and parameters are refused", async () => {
    expect(await invalidOf("id IN (SELECT id FROM 'files/ids.csv')")).toContain("reads the file files/ids.csv");
    expect(await invalidOf("id IN (SELECT id FROM read_csv('files/ids.csv'))")).toContain("calls read_csv()");
    expect(await invalidOf("octet_length((SELECT content FROM read_blob('warehouse.duckdb'))) > 0")).toContain("calls read_blob()");
    expect(await invalidOf("id IN (SELECT id FROM query('SELECT 1 AS id'))")).toContain("calls query()");
    expect(await invalidOf("(SELECT count(*) FROM checkpoint()) = 0")).toContain("calls checkpoint()");
    expect(await invalidOf("write_log('x') IS NULL")).toContain("write_log()");
    expect(await invalidOf("amount > $1")).toContain("parameter");
    expect(await invalidOf("amount > ?")).toContain("parameter");
    // Harmless table functions are fine.
    expect(await validateChecks(conn, "orders", [rule("n IN (SELECT range FROM range(10))")])).toEqual([]);
  });

  test("croft-made forms are checked for their documented shape", async () => {
    const bad: Check[] = [
      { source: "unique(x)", kind: "unique", blocking: true, scope: "table", sql: '"x"); DROP TABLE orders; --', reads: [] },
      { source: "min_rows(1)", kind: "min_rows", blocking: true, scope: "table", sql: "1; DROP TABLE orders", reads: [] },
    ];
    const ps = await validateChecks(conn, "orders", bad);
    expect(ps.map((p) => p.code)).toEqual(["CHECK_INVALID", "CHECK_INVALID"]);
  });

  test("no DuckDB function is mistaken for a near miss of unique, not_null or min_rows", async () => {
    const reader = await conn.runAndReadAll("SELECT DISTINCT function_name FROM duckdb_functions() ORDER BY 1");
    const names = reader.getRowsJS().map((r) => String(r[0])).filter((n) => /^[a-z_][a-z0-9_]*$/.test(n));
    expect(names.length).toBeGreaterThan(500);
    const mistaken = names.filter((n) => one(`${n}(x)`).problem?.message.includes("did you mean"));
    expect(mistaken).toEqual([]);
  });

  test("analyzeChecks keeps the valid ones, with the tables DuckDB's AST names", async () => {
    const checks = parse({ checks: ["id IN (WITH x AS (SELECT id FROM a) SELECT id FROM x JOIN main.b USING (id))", "amount >", "unique(id)"] }).checks;
    const r = await analyzeChecks(conn, "orders", checks);
    expect(r.checks.map((c) => [c.source, c.reads])).toEqual([
      ["id IN (WITH x AS (SELECT id FROM a) SELECT id FROM x JOIN main.b USING (id))", ["a", "b"]],
      ["unique(id)", []],
    ]);
    expect(r.problems.map((p) => p.details?.check)).toEqual(["amount >"]);
  });
});
