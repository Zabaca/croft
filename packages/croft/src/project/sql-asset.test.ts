import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Problem } from "../core/types.ts";
import { openMemory } from "../db/connect.ts";
import { assertOneSelect } from "../sql/gate.ts";
import { lexSql, type LoadedSqlAsset, loadSqlAsset, parseSqlHeader, sqlFingerprint, type SqlHeader } from "./sql-asset.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "croft-sql-asset-")));
let db: Awaited<ReturnType<typeof openMemory>>;
let conn: DuckDBConnection;
beforeAll(async () => {
  db = await openMemory({ timezone: "UTC" });
  conn = await db.connect();
});
afterAll(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
});

const ASSETS = ["orders", "customers", "refunds", "open_issues", "github_issues"];
let n = 0;

/** Write `text` as assets/<name>.sql of a fresh project and load it. */
async function load(text: string, o: { name?: string; timezone?: string } = {}): Promise<LoadedSqlAsset> {
  const root = join(base, `p${n++}`);
  const name = o.name ?? "open_issues";
  const file = `assets/${name}.sql`;
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
  return loadSqlAsset({ name, file, path: join(root, file) }, { root, timezone: o.timezone ?? "UTC", conn, assetNames: ASSETS });
}

const codes = (a: LoadedSqlAsset) => a.problems.map((p) => p.code);
const only = (a: LoadedSqlAsset, code: string): Problem => {
  const found = a.problems.filter((p) => p.code === code);
  expect(found.map((p) => p.code), JSON.stringify(a.problems)).toEqual([code]);
  return found[0]!;
};

const OPEN_ISSUES = `-- description: Open issues (not pull requests) with author and label names
-- key: id
-- check: not_null(author)
-- warn: id IN (SELECT issue_id FROM issue_triage)
SELECT
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

// ---------------------------------------------------------------------------------------------------------

describe("parseSqlHeader", () => {
  test("reads description, key, check and warn; the body starts after the header", () => {
    const { header, body, problems } = parseSqlHeader(OPEN_ISSUES, "assets/open_issues.sql");
    expect(problems).toEqual([]);
    expect(header).toEqual({
      description: "Open issues (not pull requests) with author and label names",
      key: ["id"], checks: ["not_null(author)"], warnings: ["id IN (SELECT issue_id FROM issue_triage)"], lines: 4,
    });
    expect(body.startsWith("SELECT\n  id,")).toBe(true);
    expect(OPEN_ISSUES.split("\n")[header.lines]).toBe("SELECT");
  });

  test("plain comments and blank lines may sit between; the first other line ends the header", () => {
    const text = "-- assets/daily.sql\n\n-- key: day, currency\n--   CHECK :  net <= gross  \n\nSELECT 1\n-- check: ignored\n";
    const { header, body } = parseSqlHeader(text, "assets/daily.sql");
    expect(header).toEqual({ key: ["day", "currency"], checks: ["net <= gross"], warnings: [], lines: 5 });
    expect(body).toBe("SELECT 1\n-- check: ignored\n");
  });

  test("no header: the whole text is the body", () => {
    expect(parseSqlHeader("SELECT 1", "a.sql")).toEqual({ header: { key: [], checks: [], warnings: [], lines: 0 }, body: "SELECT 1", problems: [] });
    expect(parseSqlHeader("", "a.sql").header.lines).toBe(0);
  });

  test("keys accumulate across lines; quoted key columns are unquoted; empty values are ignored", () => {
    const { header } = parseSqlHeader('-- key: day\n-- key: "Order ""X"" ID", day\n-- check:\n-- description:\nSELECT 1', "a.sql");
    expect(header.key).toEqual(["day", 'Order "X" ID']);
    expect(header.checks).toEqual([]);
    expect(header.description).toBeUndefined();
  });

  test("CRLF line endings and a byte-order mark", () => {
    const { header, body } = parseSqlHeader("\uFEFF-- key: id\r\n-- description: x\r\nSELECT 1\r\n", "a.sql");
    expect(header).toMatchObject({ key: ["id"], description: "x", lines: 2 });
    expect(body).toBe("SELECT 1\r\n");
  });

  test("an unknown name is HEADER_UNKNOWN_KEY with a did-you-mean edit; the rest still parses", () => {
    const { header, problems } = parseSqlHeader("-- key: id\n  -- chek: amount >= 0\n-- warn: x > 0\nSELECT 1", "assets/a.sql");
    expect(header).toMatchObject({ key: ["id"], checks: [], warnings: ["x > 0"], lines: 3 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      code: "HEADER_UNKNOWN_KEY", severity: "error", file: "assets/a.sql", line: 2, column: 6,
      hint: "rename it: -- check: amount >= 0",
      fix: { kind: "edit", file: "assets/a.sql", line: 2, replace: { from: "chek", to: "check" } },
      details: { name: "chek", suggestion: "check" },
    });
    expect(problems[0]!.message).toContain("did you mean check?");
  });

  test("other did-you-means: keys, warning, desc", () => {
    const guess = (line: string) => parseSqlHeader(`${line}\nSELECT 1`, "a.sql").problems[0]?.details?.suggestion;
    expect(guess("-- keys: id")).toBe("key");
    expect(guess("-- warning: x > 0")).toBe("warn");
    expect(guess("-- desc: hello")).toBe("description");
    expect(guess("-- checks: x > 0")).toBe("check");
  });

  test("a word and a colon is a header line; a URL or a sentence is a plain comment", () => {
    const { problems } = parseSqlHeader("-- Note: amounts are in cents\n-- https://example.com/docs\n-- see: the wiki\n-- this query: counts\nSELECT 1", "a.sql");
    expect(problems.map((p) => [p.line, p.details?.name, p.details?.suggestion])).toEqual([[1, "Note", undefined], [3, "see", undefined]]);
    expect(problems[0]!.hint).toContain("leave out the colon");
    expect(problems[0]!.fix).toMatchObject({ kind: "edit", line: 1 });
  });

  describe("key, check and warn lines after the header ends", () => {
    test("after a leading /* */ comment: HEADER_UNKNOWN_KEY on each, and they are not applied", () => {
      const text = "/* Revenue per day */\n-- key: day\n-- check: net <= gross\nSELECT 1 AS day, 2 AS net, 3 AS gross\n";
      const { header, problems } = parseSqlHeader(text, "assets/rev.sql");
      expect(header).toMatchObject({ key: [], checks: [], lines: 0 });
      expect(problems.map((p) => [p.code, p.severity, p.line, p.column])).toEqual([["HEADER_UNKNOWN_KEY", "error", 2, 4], ["HEADER_UNKNOWN_KEY", "error", 3, 4]]);
      expect(problems[0]).toMatchObject({
        file: "assets/rev.sql",
        message: "line 2: -- key: comes after the header, which ends at line 1, so croft ignores it; header lines must come first",
        fix: { kind: "edit", file: "assets/rev.sql", line: 2 },
        details: { name: "key", bodyStartsAt: 1 },
      });
      expect(problems[0]!.hint).toBe("move -- key: day to the top of the file, above the first line that is not a -- comment (a /* */ comment ends the header)");
      expect(problems[0]!.fix!.description).toContain("move it into the header");
    });

    test("at the bottom of the file, or between the body's lines", () => {
      const { header, problems } = parseSqlHeader("-- key: day\nSELECT 1 AS day, 2 AS net\n  -- WARN: net > 0\nFROM t\n-- check: net <= gross", "a.sql");
      expect(header).toMatchObject({ key: ["day"], checks: [], warnings: [], lines: 1 });
      expect(problems.map((p) => [p.line, p.details?.name])).toEqual([[3, "warn"], [5, "check"]]);
    });

    test("plain comments, comments after code, and text in strings or block comments are not header lines", () => {
      const body = [
        "SELECT id, -- key: not a header line, code comes first on this line",
        "  -- note: plain comments are fine anywhere",
        "  -- description: so is a description (it only documents)",
        "  '", "-- check: inside a string", "' AS s,",
        "  /*", "-- check: inside a block comment", "*/",
        "  $$", "-- warn: inside a dollar-quoted string", "$$ AS d,",
        '  "', "-- key: inside a quoted name", '" AS q',
        "FROM t",
      ].join("\n");
      expect(parseSqlHeader(`-- key: id\n${body}`, "a.sql").problems).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("loadSqlAsset", () => {
  test("a good asset: ok, its inputs from the AST, a code hash, the body verbatim", async () => {
    const a = await load(OPEN_ISSUES);
    expect(a.problems).toEqual([]);
    expect(a).toMatchObject({ name: "open_issues", file: "assets/open_issues.sql", ok: true, headerLines: 4, astInputs: ["github_issues"] });
    expect(a.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.body).toBe(OPEN_ISSUES.split("\n").slice(4).join("\n"));
    expect(a.header.key).toEqual(["id"]);
  });

  test("a trailing ; or -- comment is kept in the body and accepted", async () => {
    for (const tail of [";", "; -- done", " -- done", ";\n-- done\n"]) {
      const a = await load(`SELECT id FROM orders${tail}`);
      expect([tail, a.problems]).toEqual([tail, []]);
      expect(a.body).toBe(`SELECT id FROM orders${tail}`);
    }
  });

  test("every problem carries the asset's name", async () => {
    const a = await load("-- chek: x\nSELECT now() FROM orders, other.main.t");
    expect(codes(a)).toEqual(["HEADER_UNKNOWN_KEY", "CATALOG_PREFIX", "VOLATILE_SQL"]);
    expect(a.problems.every((p) => p.asset === "open_issues")).toBe(true);
  });

  test("an unreadable file is ASSET_INVALID", async () => {
    const a = await loadSqlAsset({ name: "gone", file: "assets/gone.sql", path: join(base, "nope", "gone.sql") }, { root: base, timezone: "UTC", conn, assetNames: [] });
    expect(a.ok).toBe(false);
    expect(only(a, "ASSET_INVALID")).toMatchObject({ asset: "gone", file: "assets/gone.sql" });
  });

  test("a header problem does not stop the body's checks", async () => {
    const a = await load("-- chek: x > 0\nSELECT id FROM orders");
    expect(codes(a)).toEqual(["HEADER_UNKNOWN_KEY"]);
    expect(a.ok).toBe(false);
    expect(a.codeHash).toBeDefined();
    expect(a.astInputs).toEqual(["orders"]);
  });

  describe("the one-SELECT gate", () => {
    test("syntax errors are located past the header", async () => {
      const p = only(await load("-- key: id\n-- description: x\nSELECT id\nFROM orders\nWHERE id = = 1"), "SQL_SYNTAX");
      expect(p).toMatchObject({ file: "assets/open_issues.sql", line: 5, column: 12, asset: "open_issues" });
    });

    test("two statements are SQL_NOT_ONE_STATEMENT; none is too", async () => {
      expect(only(await load("-- key: id\nSELECT 1; SELECT 2"), "SQL_NOT_ONE_STATEMENT").message).toContain("found 2 statements");
      expect(only(await load("-- key: id\n-- nothing yet\n"), "SQL_NOT_ONE_STATEMENT").message).toContain("no SQL statement");
    });

    test("anything but a SELECT is SQL_NOT_SELECT", async () => {
      for (const sql of ["INSERT INTO orders VALUES (1)", "CREATE TABLE x AS SELECT 1", "COPY orders TO 'files/x.csv'", "SELECT * FROM query_table('orders')", "SELECT * FROM checkpoint()"]) {
        const a = await load(`-- key: id\n${sql}`);
        expect([sql, codes(a)]).toEqual([sql, ["SQL_NOT_SELECT"]]);
        expect(a.codeHash).toBeUndefined();
      }
    });

    test("DESCRIBE, SUMMARIZE and SHOW are SQL_NOT_SELECT in an asset", async () => {
      for (const sql of ["DESCRIBE orders", "SUMMARIZE orders", "SHOW TABLES", "SELECT * FROM (DESCRIBE orders)"]) {
        const p = only(await load(sql), "SQL_NOT_SELECT");
        expect(p.hint).toContain("croft query");
      }
    });
  });

  describe("PIVOT_NEEDS_VALUES", () => {
    test("a PIVOT without IN, located at its ON column, before the gate counts two statements", async () => {
      const a = await load("-- key: customer_id\nSELECT *\nFROM (PIVOT orders\n      ON product USING sum(amount))");
      const p = only(a, "PIVOT_NEEDS_VALUES");
      expect(p).toMatchObject({ line: 4, column: 10, details: { column: "product" }, fix: { kind: "edit", line: 4 } });
      expect(p.hint).toBe("list the values: ON product IN ('pro', 'basic'), or use sum(x) FILTER (WHERE product = 'pro')");
      expect(a.codeHash).toBeUndefined();
    });

    test("the statement form, several ON columns, and IN (SELECT ...)", async () => {
      expect(only(await load("PIVOT orders ON product"), "PIVOT_NEEDS_VALUES").details).toEqual({ column: "product" });
      expect(only(await load("PIVOT_WIDER orders ON customer_id IN (1, 2), product USING count(*)"), "PIVOT_NEEDS_VALUES").details).toEqual({ column: "product" });
      expect(only(await load("PIVOT orders ON product IN (SELECT DISTINCT product FROM orders)"), "PIVOT_NEEDS_VALUES").details).toEqual({ column: "product" });
    });

    test("a pivot over a subquery, and a standard PIVOT next to one without IN", async () => {
      const sub = only(await load("PIVOT (SELECT o.* FROM orders o JOIN customers c ON c.id = o.customer_id) ON product"), "PIVOT_NEEDS_VALUES");
      expect(sub.details).toEqual({ column: "product" });
      const mixed = await load(`SELECT * FROM orders PIVOT (sum(amount) FOR product IN ('pro')) AS p
JOIN customers c ON c.id = p.customer_id
JOIN (PIVOT refunds ON order_id) AS r ON true`);
      expect(only(mixed, "PIVOT_NEEDS_VALUES")).toMatchObject({ line: 3, column: 24, details: { column: "order_id" } });
    });

    test("with IN, a PIVOT is one SELECT", async () => {
      const a = await load("PIVOT orders ON product IN ('pro', 'basic') USING sum(amount) GROUP BY customer_id");
      expect(a.problems).toEqual([]);
      expect(a.astInputs).toEqual(["orders"]);
      expect((await load("SELECT * FROM orders PIVOT (sum(amount) FOR product IN ('pro'))")).problems).toEqual([]);
    });

    test("the word pivot in a string, a name or a comment is not a PIVOT", async () => {
      expect(codes(await load("SELECT 'pivot t on b' AS \"pivot\" -- pivot\n; SELECT 2"))).toEqual(["SQL_NOT_ONE_STATEMENT"]);
      expect(codes(await load("SELECT 1 AS pivot_count; SELECT 2"))).toEqual(["SQL_NOT_ONE_STATEMENT"]);
    });

    test("two statements, one of them a PIVOT without IN, report the PIVOT", async () => {
      expect(codes(await load("SELECT 1; PIVOT orders ON product"))).toEqual(["PIVOT_NEEDS_VALUES"]);
    });
  });

  describe("SQL_READS_FILES", () => {
    test("a path in FROM, a file function, a list of files, a glob", async () => {
      for (const [sql, files, ingest] of [
        ["SELECT * FROM 'files/sales.csv'", ["files/sales.csv"], "sales"],
        ["SELECT * FROM read_parquet('files/sales/*.parquet')", ["files/sales/*.parquet"], "sales"],
        ["SELECT * FROM read_csv(['files/a.csv', 'files/b.csv'], header := true)", ["files/a.csv", "files/b.csv"], "a"],
        ["SELECT count(*) FROM glob('files/*')", ["files/*"], "files"],
        ["SELECT * FROM read_json(getvariable('x'))", [], "asset"],
      ] as const) {
        const p = only(await load(`-- key: id\n${sql}`), "SQL_READS_FILES");
        expect([sql, p.details?.files]).toEqual([sql, files]);
        expect(p.fix).toEqual({
          kind: "command", description: "write a file ingest for the file, point its file: at it, then read its table by name", command: `croft new file ${ingest}`,
        });
        expect(p.hint).toBe(`load the file with a file ingest (croft new file ${ingest} writes one; point its file: at the file), then read its table by name`);
        expect(p.line).toBe(2);
      }
    });

    test("any path, even one the gate would refuse: the fix is a file ingest either way", async () => {
      const a = await load("SELECT * FROM '/etc/passwd.csv' JOIN orders USING (id)");
      expect(codes(a)).toEqual(["SQL_READS_FILES"]);
      expect(a.astInputs).toEqual(["orders"]);
      expect(a.codeHash).toBeUndefined();
    });

    test("a file named like an asset points at its table", async () => {
      const p = only(await load("SELECT * FROM read_csv('files/orders.csv')"), "SQL_READS_FILES");
      expect(p.hint).toBe("read the table instead: FROM orders");
      expect(p.fix).toMatchObject({ kind: "edit", file: "assets/open_issues.sql", line: 1 });
    });

    test("a table macro given a path, as a string, a quoted name or source :=, once each", async () => {
      for (const [sql, shown] of [
        ["SELECT * FROM histogram('files/sales.csv', amount)", "histogram('files/sales.csv')"],
        ['SELECT * FROM histogram_values("files/sales.csv", amount)', "histogram_values('files/sales.csv')"],
        ["SELECT * FROM histogram(col_name := amount, source := 'files/sales.csv')", "histogram('files/sales.csv')"],
      ] as const) {
        const p = only(await load(sql), "SQL_READS_FILES");
        expect([sql, p.details?.files, p.message]).toEqual([sql, ["files/sales.csv"], `open_issues reads ${shown} directly; croft cannot tell when a file changed, so the table would go stale`]);
      }
    });
  });

  test("a DOUBLE constant beyond range (json_serialize_sql writes Infinity) loads", async () => {
    const a = await load("-- key: id\nSELECT id, amount FROM orders WHERE amount < 1e400 AND amount > -1e400");
    expect(a.problems).toEqual([]);
    expect(a.ok).toBe(true);
    expect(a.astInputs).toEqual(["orders"]);
    expect(a.codeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a key or check line after the header is an error of the asset", async () => {
    const a = await load("/* Revenue per day */\n-- key: id\nSELECT id FROM orders");
    expect(codes(a)).toEqual(["HEADER_UNKNOWN_KEY"]);
    expect(a.ok).toBe(false);
    expect(a.problems[0]).toMatchObject({ asset: "open_issues", line: 2 });
  });

  describe("CATALOG_PREFIX", () => {
    test("a catalog or schema prefix; main. is fine", async () => {
      for (const sql of ["SELECT * FROM other.main.orders", "SELECT * FROM memory.main.orders", "SELECT * FROM warehouse.orders", "SELECT * FROM _croft.assets", "SELECT * FROM information_schema.tables"]) {
        const a = await load(sql);
        expect([sql, codes(a)]).toEqual([sql, ["CATALOG_PREFIX"]]);
      }
      expect((await load("SELECT * FROM main.orders JOIN MAIN.customers USING (id)")).problems).toEqual([]);
    });

    test("the fix drops the prefix as written, located at the table", async () => {
      const p = only(await load('-- key: id\nSELECT o.id\nFROM  Other . "Main".orders o'), "CATALOG_PREFIX");
      expect(p).toMatchObject({
        line: 3, column: 7, hint: "drop the prefix: FROM orders", details: { table: "Other.Main.orders" },
        fix: { kind: "edit", line: 3, replace: { from: 'Other . "Main".orders', to: "orders" } },
      });
    });

    test("a table macro's table with a prefix, as written", async () => {
      const p = only(await load("SELECT * FROM histogram(other.main.orders, amount)"), "CATALOG_PREFIX");
      expect(p).toMatchObject({ line: 1, column: 25, fix: { kind: "edit", replace: { from: "other.main.orders", to: "orders" } } });
      expect(codes(await load("SELECT * FROM histogram_values(_croft.assets, row_count)"))).toEqual(["CATALOG_PREFIX"]);
    });

    test("a table outside the project gets no replacement", async () => {
      const p = only(await load("SELECT * FROM _croft.assets"), "CATALOG_PREFIX");
      expect(p.message).toBe("_croft.assets is outside the project's tables; an SQL asset reads only those, by plain name, so croft can track its inputs");
      expect(p.fix).not.toHaveProperty("replace");
    });
  });

  describe("VOLATILE_SQL", () => {
    test("functions and the clock keywords, once each, located at the first; a warning", async () => {
      const a = await load("-- key: id\nSELECT id, now() AS seen, random() AS r, NOW() AS again\nFROM orders\nWHERE created_at < current_date");
      const p = only(a, "VOLATILE_SQL");
      expect(p).toMatchObject({ severity: "warning", line: 2, column: 12, details: { functions: ["now()", "random()", "current_date"] } });
      expect(p.message).toStartWith("now(), random() and current_date give a different value on every run; open_issues keeps");
      expect(a.ok).toBe(true);
      expect(a.codeHash).toBeDefined();
    });

    test("a column named like a keyword through its table is not the clock", async () => {
      expect((await load("SELECT o.current_date, gen_random_uuid() FROM orders o")).problems.map((p) => p.details?.functions)).toEqual([["gen_random_uuid()"]]);
      expect((await load("SELECT current_localtimestamp(), ago(INTERVAL 1 DAY)")).problems[0]!.details?.functions).toEqual(["current_localtimestamp()", "ago()"]);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("sqlFingerprint", () => {
  const hash = async (text: string, tz = "UTC") => {
    const a = await load(text, { timezone: tz });
    expect(a.codeHash, JSON.stringify(a.problems)).toBeDefined();
    return a.codeHash!;
  };
  const BASE = "-- key: id\n-- check: amount >= 0\nSELECT id, sum(amount) AS total FROM orders WHERE product = 'pro' GROUP BY id";

  test("ignores whitespace, comments, keyword case, table and function name case, a trailing ;", async () => {
    const h = await hash(BASE);
    for (const same of [
      "-- key: id\n-- check: amount >= 0\n\nselect id,\n  SUM(amount)   as total -- the total\nfrom ORDERS where product = 'pro'\ngroup by id;",
      "-- key: id\n-- a note\n-- check: amount >= 0\n/* block */ SELECT id, sum(amount) AS total FROM \"Orders\" WHERE product = 'pro' GROUP BY id -- end",
      "\uFEFF-- KEY: id\n-- Check: amount >= 0\nSELECT id, sum(amount) AS total FROM orders WHERE product = 'pro' GROUP BY id",
    ]) expect([same, await hash(same)]).toEqual([same, h]);
  });

  test("detects real changes: values, aliases, column names as written, the header, the time zone", async () => {
    const h = await hash(BASE);
    const changed = [
      BASE.replace("'pro'", "'basic'"),
      BASE.replace("AS total", "AS Total"),                      // renames the output column
      BASE.replace("sum(amount) AS total", "sum(AMOUNT)"),      // an unaliased column is named as written
      BASE.replace("amount >= 0", "amount > 0"),
      BASE.replace("-- key: id", "-- key: id, product"),
      `-- description: totals\n${BASE}`,
      BASE.replace("-- check: amount >= 0", "-- warn: amount >= 0"),
    ];
    const hashes = await Promise.all(changed.map((t) => hash(t)));
    for (let i = 0; i < changed.length; i++) expect([changed[i], hashes[i]]).not.toEqual([changed[i], h]);
    expect(new Set(hashes).size).toBe(changed.length);
    expect(await hash(BASE, "America/Los_Angeles")).not.toBe(h);
  });

  test("integers beyond 2^53 stay exact", async () => {
    const a = await hash("SELECT * FROM orders WHERE id = 9007199254740993");
    const b = await hash("SELECT * FROM orders WHERE id = 9007199254740992");
    const c = await hash("SELECT * FROM orders WHERE id = 12345678901234567891");
    const d = await hash("SELECT * FROM orders WHERE id = 12345678901234567890");
    expect(a).not.toBe(b);
    expect(c).not.toBe(d);
  });

  test("works on the gate's AST too, ignoring the header's line count", async () => {
    const ast = await assertOneSelect(conn, "SELECT 1 AS x");
    const header: SqlHeader = { key: ["x"], checks: [], warnings: [], lines: 1 };
    expect(sqlFingerprint(ast, header, "UTC")).toBe(sqlFingerprint(ast, { ...header, lines: 7 }, "UTC"));
    expect(sqlFingerprint(ast, header, "UTC")).not.toBe(sqlFingerprint(ast, { ...header, key: [] }, "UTC"));
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("lexSql", () => {
  test("counts statements outside strings, names, comments and dollar quotes", () => {
    for (const [sql, count] of [
      ["select 1", 1],
      ["select 1;", 1],
      ["select 1; -- two; three\n", 1],
      ["select ';' AS \"a;b\" /* ; /* nested ; */ ; */", 1],
      ["select $$ ; $$, $tag$ ; $$ ; $tag$, E'\\'; '", 1],
      ["select 1; select 2", 2],
      [";;  ;", 0],
      ["", 0],
      ["select 'unterminated ; ", 1],
    ] as const) expect([sql, lexSql(sql).statements]).toEqual([sql, count]);
  });

  test("tokens carry their parenthesis depth", () => {
    const t = lexSql("SELECT (a, f(b)) FROM t").tokens.map((x) => `${x.text}@${x.depth}`);
    expect(t).toEqual(["SELECT@0", "(@0", "a@1", ",@1", "f@1", "(@1", "b@2", ")@1", ")@0", "FROM@0", "t@0"]);
  });
});
