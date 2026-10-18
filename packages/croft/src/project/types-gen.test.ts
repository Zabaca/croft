// Generated input types (project/types-gen.ts): the DuckDB → TypeScript mapping, the files' text, and what
// generateInputTypes writes to .croft/types from the column cache. The real-tsc tests (the types match what a TS
// transform is handed, and catch a renamed column) are in types-gen-tsc.test.ts.
import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CatalogAsset, type CatalogColumn, putCatalog } from "../history/catalog.ts";
import { RunsDb } from "../history/runs-db.ts";
import { renderRows } from "../db/values.ts";
import { previewDirectory } from "../run/preview.ts";
import type { StepResult } from "../core/types.ts";
import { generateInputTypes, renderTypes, rowTypeName, type TypeSource, TYPES_DIR, tsType, typeSources, vouchedNotNull } from "./types-gen.ts";

const made: string[] = [];
afterAll(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-types-")));
  made.push(root);
  writeFileSync(join(root, "croft.json"), JSON.stringify({ database: "warehouse.duckdb", timezone: "UTC" }));
  return root;
}

const col = (name: string, type: string, o: Partial<CatalogColumn> = {}): CatalogColumn =>
  ({ name, type, sourceName: name, pinned: false, pending: false, format: null, ...o });

const entry = (asset: string, columns: CatalogColumn[], o: Partial<CatalogAsset> = {}): CatalogAsset => ({
  asset, kind: "ingest", behavior: "replace", write: "replace", key: [], rows: 1, columns, cursor: null,
  lastLoadedAt: null, lastReplacedAt: null, lastRunId: null, codeHash: null, ...o,
});

function seed(stateDir: string, entries: CatalogAsset[], source: "run" | "preview" = "run"): void {
  const db = RunsDb.open(stateDir);
  try {
    for (const e of entries) putCatalog(db, e, source);
  } finally {
    db.close();
  }
}

/** A finished run whose step for `asset` ended `status` with these check results (what RunsDb.lastStepChecks
 *  reads); returns its id, for the catalog entry's lastRunId. */
function ran(stateDir: string, asset: string, checks: StepResult["checks"], status: StepResult["status"] = "ok"): string {
  const db = RunsDb.open(stateDir);
  try {
    const r = db.createRun({ trigger: "manual", human: true, argv: [] });
    db.startStep({ runId: r.id, asset, attempt: 1, reason: "requested" });
    db.finishStep(r.id, asset, 1, { status });
    db.finishRun(r.id, status === "ok" ? "succeeded" : "failed", { data: { runId: r.id, steps: [{ asset, status, checks }] } });
    return r.id;
  } finally {
    db.close();
  }
}

const passed = (check: string, blocking?: boolean) => ({ check, ok: true, ...(blocking === undefined ? {} : { blocking }), failing: 0 });

// ---------------------------------------------------------------------------------------------------------

describe("tsType: DuckDB types as a TS transform receives them (db/values.ts, mode ts)", () => {
  test("scalars", () => {
    const cases: [string, string][] = [
      ["BOOLEAN", "boolean"],
      ["TINYINT", "number"], ["SMALLINT", "number"], ["INTEGER", "number"], ["UTINYINT", "number"], ["USMALLINT", "number"], ["UINTEGER", "number"],
      // Integers beyond ±2^53 arrive as bigint.
      ["BIGINT", "number | bigint"], ["UBIGINT", "number | bigint"],
      ["HUGEINT", "bigint"], ["UHUGEINT", "bigint"], ["VARINT", "bigint"], ["BIGNUM", "bigint"],
      ["FLOAT", "number"], ["DOUBLE", "number"],
      // DECIMAL: up to 15 digits a number, wider its exact text, DECIMAL(38,0) (the HUGEINT stand-in) a bigint.
      ["DECIMAL(10,2)", "number"], ["DECIMAL(15,0)", "number"], ["DECIMAL(16,2)", "string"], ["DECIMAL(18,3)", "string"],
      ["DECIMAL(38,0)", "bigint"], ["DECIMAL(38,2)", "string"], ["DECIMAL", "string"], ["NUMERIC(4,1)", "number"],
      ["VARCHAR", "string"], ["VARCHAR(20)", "string"], ["ENUM('a','b')", "string"],
      // JSON is the parsed value: croft cannot know its shape.
      ["JSON", "unknown"],
      // Dates and times are strings, never Date (§3e: a pass-through must reload as the same type).
      ["DATE", "string"], ["TIME", "string"], ["TIMETZ", "string"], ["TIMESTAMP", "string"], ["TIMESTAMPTZ", "string"],
      ["TIMESTAMP WITH TIME ZONE", "string"], ["TIMESTAMP_S", "string"], ["TIMESTAMP_MS", "string"], ["TIMESTAMP_NS", "string"],
      ["UUID", "string"], ["BLOB", "string"], ["INTERVAL", "string"], ["BIT", "string"],
      ["timestamptz", "string"], ["bigint", "number | bigint"],
      // A type croft does not know: nothing is claimed.
      ["GEOMETRY", "unknown"], ["", "unknown"], ["!!", "unknown"],
    ];
    for (const [sql, ts] of cases) expect([sql, tsType(sql)]).toEqual([sql, ts]);
  });

  test("lists, maps, structs and unions; their elements may be NULL", () => {
    expect(tsType("VARCHAR[]")).toBe("(string | null)[]");
    expect(tsType("BIGINT[]")).toBe("(number | bigint | null)[]");
    expect(tsType("INTEGER[][]")).toBe("((number | null)[] | null)[]");
    expect(tsType("INTEGER[3]")).toBe("(number | null)[]");
    expect(tsType("JSON[]")).toBe("unknown[]");
    expect(tsType("MAP(VARCHAR, INTEGER)")).toBe("{ key: string; value: number | null }[]");
    expect(tsType("MAP(VARCHAR,DECIMAL(10,2)[])")).toBe("{ key: string; value: (number | null)[] | null }[]");
    // The column cache upper-cases a STRUCT's field names (load/evolve.ts normalizeType), so they are not claimed.
    expect(tsType("STRUCT(a INTEGER, b VARCHAR)")).toBe("{ [field: string]: unknown }");
    expect(tsType("STRUCT(A INTEGER)[]")).toBe("({ [field: string]: unknown } | null)[]");
    expect(tsType("UNION(n INTEGER, s VARCHAR)")).toBe("{ tag: string; value: unknown }");
  });
});

describe("tsType in json mode: DuckDB types as @zabaca/croft/read returns them (db/values.ts, mode json)", () => {
  test("strings where JSON cannot hold the number: HUGEINT, every DECIMAL, and BIGINT beyond ±2^53", () => {
    const cases: [string, string][] = [
      ["BOOLEAN", "boolean"], ["INTEGER", "number"], ["DOUBLE", "number"],
      ["BIGINT", "number | string"], ["UBIGINT", "number | string"],
      ["HUGEINT", "string"], ["BIGNUM", "string"],
      ["DECIMAL(10,2)", "string"], ["DECIMAL(38,0)", "string"], ["DECIMAL", "string"],
      ["VARCHAR", "string"], ["TIMESTAMPTZ", "string"], ["DATE", "string"], ["JSON", "unknown"],
      ["BIGINT[]", "(number | string | null)[]"], ["MAP(VARCHAR, HUGEINT)", "{ key: string; value: string | null }[]"],
    ];
    for (const [sql, ts] of cases) expect([sql, tsType(sql, "json")]).toEqual([sql, ts]);
  });

  test("the types say what the read API hands over: each rendered value is one of its type's members", async () => {
    const db = await DuckDBInstance.create(":memory:");
    const conn = await db.connect();
    try {
      const sql = `SELECT true AS b, 7::INTEGER AS i, 1.5::DOUBLE AS d, 42::BIGINT AS small, 9007199254740993::BIGINT AS big,
        12345678901234567890123::HUGEINT AS huge, 12.34::DECIMAL(10,2) AS dec, 'x' AS v,
        TIMESTAMPTZ '2026-09-01 10:00:00+00' AS ts, DATE '2026-09-01' AS day`;
      const reader = await conn.runAndReadAll(sql);
      const [row] = renderRows(reader, { mode: "json", timezone: "UTC" }) as Record<string, unknown>[];
      const types: Record<string, string> = {
        b: "BOOLEAN", i: "INTEGER", d: "DOUBLE", small: "BIGINT", big: "BIGINT", huge: "HUGEINT", dec: "DECIMAL(10,2)",
        v: "VARCHAR", ts: "TIMESTAMPTZ", day: "DATE",
      };
      for (const [col, type] of Object.entries(types)) {
        const members = tsType(type, "json").split(" | ");
        expect([col, members.includes(typeof row![col])]).toEqual([col, true]);
      }
      expect(row!.small).toBe(42);
      expect(row!.big).toBe("9007199254740993");
    } finally {
      conn.disconnectSync();
    }
  });
});

describe("rowTypeName", () => {
  test("PascalCase plus Row: a name no asset, keyword or croft type takes", () => {
    expect(rowTypeName("github_issues")).toBe("GithubIssuesRow");
    expect(rowTypeName("x")).toBe("XRow");
    expect(rowTypeName("sales_2026_q1")).toBe("Sales2026Q1Row");
    expect(rowTypeName("string")).toBe("StringRow");
    expect(rowTypeName("a__b")).toBe("ABRow");
  });
});

// ---------------------------------------------------------------------------------------------------------

const ISSUES: TypeSource = {
  asset: "github_issues", from: "run", key: ["id"],
  columns: [
    { name: "id", type: "BIGINT" },
    { name: "title", type: "VARCHAR" },
    { name: "user", type: "JSON", jsonKeys: ["id", "login"] },
    { name: "closed_at", type: "VARCHAR", pending: true },
    { name: "Weird Name", type: "DOUBLE" },
    { name: "_loaded_at", type: "TIMESTAMPTZ" },
  ],
};

/** A file's leading comment as one line. */
const header = (text: string) => {
  const lines = text.split("\n");
  const end = lines.findIndex((l) => !l.startsWith("// "));
  return lines.slice(0, end === -1 ? lines.length : end).map((l) => l.slice(3)).join(" ");
};

describe("renderTypes: one file per asset, and an index that augments CroftAssets", () => {
  test("an asset's row type: keys are never NULL, a pending column is unknown, odd names are quoted", () => {
    const r = renderTypes([ISSUES]);
    expect(r.files.get("github_issues.d.ts")).toBe(`// github_issues: its rows as TS transforms read them: ctx.rows("github_issues"), ctx.newRows("github_issues") and
// ctx.query<"github_issues">(sql). From the columns of its table as last built.
// Generated by croft after each run and preview, and by croft validate --types; edits are overwritten.
export type GithubIssuesRow = {
  /** BIGINT, the key */
  id: number | bigint;
  /** VARCHAR */
  title: string | null;
  /** JSON (keys seen: id, login) */
  user: unknown;
  /** VARCHAR, NULL in every row so far: its type is not settled */
  closed_at: unknown;
  /** DOUBLE */
  "Weird Name": number | null;
  /** TIMESTAMPTZ: when croft loaded the row; readable, but left out of { ...row } */
  _loaded_at: string;
};

// The same rows as an app reads them: query<"github_issues">(sql) from @zabaca/croft/read. DECIMAL, HUGEINT and
// integers beyond ±2^53 arrive as strings there.
export type GithubIssuesReadRow = {
  /** BIGINT, the key */
  id: number | string;
  /** VARCHAR */
  title: string | null;
  /** JSON (keys seen: id, login) */
  user: unknown;
  /** VARCHAR, NULL in every row so far: its type is not settled */
  closed_at: unknown;
  /** DOUBLE */
  "Weird Name": number | null;
  /** TIMESTAMPTZ: when croft loaded the row */
  _loaded_at: string;
};
`);
    expect(r.files.get("index.d.ts")).toBe(`// Input row types by asset name, for TS transforms: ctx.rows("x") and ctx.newRows("x") hand over x's row type,
// and ctx.query<"x">(sql) returns x's rows. Reading a column x does not have is then a type error, which
// croft validate --types reports. rows<Row>("x") opts out, for column names computed at run time.
// For apps, query<"x">(sql) from @zabaca/croft/read returns x's rows as that module renders them.
// Generated by croft after each run and preview, and by croft validate --types; edits are overwritten.
// It applies when tsconfig.json includes ".croft/types" (an app with the project in data/: data/.croft/types).
export {};
declare module "@zabaca/croft" {
  interface CroftAssets {
    github_issues: import("./github_issues.js").GithubIssuesRow;
  }
}
declare global {
  interface CroftTables {
    github_issues: import("./github_issues.js").GithubIssuesReadRow;
  }
}
`);
    expect(r.types).toEqual({
      GithubIssuesRow: {
        asset: "github_issues", file: ".croft/types/github_issues.d.ts", columns: ["id", "title", "user", "closed_at", "Weird Name", "_loaded_at"],
        // As the file writes them: validate --types words its hints from them.
        columnTypes: {
          id: "number | bigint", title: "string | null", user: "unknown", closed_at: "unknown", "Weird Name": "number | null", _loaded_at: "string",
        },
      },
    });
  });

  test("a column a blocking not_null check vouches for is never NULL, in both row types (D107)", () => {
    const r = renderTypes([{
      asset: "triage", from: "run", key: ["id"], notNull: ["ID", "Label", "meta", "note", "Odd Name"],
      columns: [
        { name: "id", type: "BIGINT" }, { name: "label", type: "VARCHAR" }, { name: "score", type: "DECIMAL(10,2)" },
        { name: "meta", type: "JSON" }, { name: "note", type: "VARCHAR", pending: true }, { name: "Odd Name", type: "BIGINT" },
      ],
    }]);
    const text = r.files.get("triage.d.ts")!;
    // Names match as DuckDB's do, without regard to case; the key stays the key.
    expect(text).toContain("export type TriageRow = {\n  /** BIGINT, the key */\n  id: number | bigint;\n"
      + "  /** VARCHAR, never NULL: a blocking not_null check */\n  label: string;\n  /** DECIMAL(10,2) */\n  score: number | null;\n");
    expect(text).toContain("  /** BIGINT, never NULL: a blocking not_null check */\n  \"Odd Name\": number | bigint;\n");
    expect(text).toContain("export type TriageReadRow = {\n  /** BIGINT, the key */\n  id: number | string;\n"
      + "  /** VARCHAR, never NULL: a blocking not_null check */\n  label: string;\n  /** DECIMAL(10,2) */\n  score: string | null;\n");
    // A JSON column stays unknown (a JSON null is not SQL NULL), and a pending one's type is not settled.
    expect(text).toContain("  /** JSON */\n  meta: unknown;\n");
    expect(text).toContain("  /** VARCHAR, NULL in every row so far: its type is not settled */\n  note: unknown;\n");
    expect(r.types.TriageRow!.columnTypes).toMatchObject({ label: "string", score: "number | null", "Odd Name": "number | bigint" });
  });

  test("where the columns came from: a preview, or an SQL asset's code as it is now", () => {
    const r = renderTypes([
      { asset: "stripe_charges", from: "preview", key: [], columns: [{ name: "amount", type: "BIGINT" }] },
      { asset: "daily", from: "code", file: "assets/daily.sql", key: ["day"], columns: [{ name: "day", type: "DATE" }] },
    ]);
    expect(header(r.files.get("stripe_charges.d.ts")!)).toEndWith("From the columns the last croft preview gave it; it has never been built. "
      + "Generated by croft after each run and preview, and by croft validate --types; edits are overwritten.");
    expect(header(r.files.get("daily.d.ts")!)).toContain("From the output columns of assets/daily.sql as its code is now.");
    // An SQL table always has croft's _loaded_at, which the SELECT's own columns leave out.
    expect(r.types.DailyRow!.columns).toEqual(["day", "_loaded_at"]);
    expect(r.files.get("daily.d.ts")).toContain("  day: string;\n");
  });

  test("a line break in a folder name cannot end the header comment", () => {
    const r = renderTypes([{ asset: "daily", from: "code", file: "assets/odd\nname\u2028/daily.sql", key: [], columns: [{ name: "d", type: "DATE" }] }]);
    const text = r.files.get("daily.d.ts")!;
    const lines = text.split(/\r?\n|\u2028|\u2029/);
    expect(lines.slice(0, lines.indexOf("export type DailyRow = {")).every((l) => l.startsWith("// "))).toBe(true);
    expect(header(text)).toContain("assets/odd name /daily.sql");
  });

  test("_file and croft's columns are never NULL; comment text cannot close the comment", () => {
    const r = renderTypes([{
      asset: "sales", from: "run", key: [],
      columns: [{ name: "note", type: "JSON", jsonKeys: ["a*/b"] }, { name: "_file", type: "VARCHAR" }, { name: "_loaded_at", type: "TIMESTAMPTZ" }],
    }]);
    const text = r.files.get("sales.d.ts")!;
    expect(text).toContain("/** JSON (keys seen: a* /b) */");
    expect(text).toContain("  /** VARCHAR: the file the row came from; readable, but left out of { ...row } */\n  _file: string;\n");
  });

  test("an asset named index: its row type lives in index.d.ts", () => {
    const r = renderTypes([ISSUES, { asset: "index", from: "run", key: [], columns: [{ name: "n", type: "INTEGER" }] }]);
    expect([...r.files.keys()].sort()).toEqual(["github_issues.d.ts", "index.d.ts"]);
    const index = r.files.get("index.d.ts")!;
    expect(index).toContain("export type IndexRow = {\n  /** INTEGER */\n  n: number | null;\n");
    expect(index).toContain("    index: IndexRow;\n");
    expect(index).toContain(`    github_issues: import("./github_issues.js").GithubIssuesRow;\n`);
    expect(r.types.IndexRow!.file).toBe(".croft/types/index.d.ts");
  });

  test("two names with one PascalCase form get distinct type names", () => {
    const r = renderTypes([
      { asset: "a_b", from: "run", key: [], columns: [{ name: "x", type: "INTEGER" }] },
      { asset: "a__b", from: "run", key: [], columns: [{ name: "y", type: "INTEGER" }] },
    ]);
    expect(Object.keys(r.types).sort()).toEqual(["ABRow", "AB_2Row"]);
    expect(r.types.ABRow!.asset).toBe("a__b");
    expect(r.types.AB_2Row!.asset).toBe("a_b");
    expect(r.files.get("a_b.d.ts")).toContain("export type AB_2Row = {");
  });

  test("assets are sorted, and one with no columns gets no type", () => {
    const r = renderTypes([
      { asset: "zeta", from: "run", key: [], columns: [{ name: "z", type: "INTEGER" }] },
      { asset: "empty", from: "run", key: [], columns: [] },
      { asset: "alpha", from: "run", key: [], columns: [{ name: "a", type: "INTEGER" }] },
    ]);
    expect(r.assets).toEqual(["alpha", "zeta"]);
    const index = r.files.get("index.d.ts")!;
    expect(index.indexOf("alpha:")).toBeLessThan(index.indexOf("zeta:"));
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("typeSources: the column cache", () => {
  test("live entries, then previewed assets never built; a live entry wins", () => {
    const root = tempRoot();
    const state = join(root, ".croft");
    seed(state, [entry("orders", [col("id", "BIGINT"), col("_loaded_at", "TIMESTAMPTZ", { sourceName: null })], { key: ["id"] })]);
    seed(previewDirectory(state), [
      entry("orders", [col("id", "VARCHAR")]),
      entry("refunds", [col("amount", "DOUBLE", { pending: true }), col("meta", "JSON", { jsonKeys: ["k"] })]),
    ], "preview");
    expect(typeSources(state)).toEqual([
      { asset: "orders", from: "run", key: ["id"], columns: [{ name: "id", type: "BIGINT", pending: false }, { name: "_loaded_at", type: "TIMESTAMPTZ", pending: false }] },
      { asset: "refunds", from: "preview", key: [], columns: [{ name: "amount", type: "DOUBLE", pending: true }, { name: "meta", type: "JSON", pending: false, jsonKeys: ["k"] }] },
    ]);
  });

  test("a live entry's notNull: the blocking not_null checks the step that built it passed (D107)", () => {
    const root = tempRoot();
    const state = join(root, ".croft");
    const run = ran(state, "triage", [
      passed("unique(id)", true), passed("not_null(id)", true), passed("not_null(label, \"Odd Name\")", true),
      passed("not_null(reason)", false), passed("label IN ('a', 'b')", true),
    ]);
    seed(state, [entry("triage", [col("id", "BIGINT"), col("label", "VARCHAR"), col("reason", "VARCHAR"), col("Odd Name", "INTEGER")], { key: ["id"], lastRunId: run })]);
    seed(previewDirectory(state), [entry("drafts", [col("label", "VARCHAR")], { lastRunId: run })], "preview");
    const [live, previewed] = typeSources(state);
    expect(live!.notNull).toEqual(["id", "label", "Odd Name"]);
    // The preview's runs.sqlite records no steps.
    expect(previewed!.asset).toBe("drafts");
    expect(previewed!.notNull).toBeUndefined();
  });

  test("no runs.sqlite: nothing, and nothing is created", () => {
    const root = tempRoot();
    expect(typeSources(join(root, ".croft"))).toEqual([]);
    expect(existsSync(join(root, ".croft"))).toBe(false);
  });
});

describe("vouchedNotNull: the columns a step's passing blocking not_null checks cover (D107)", () => {
  test("blocking not_null only: not a warning, a failure, an older croft's unmarked result, unique or a rule", () => {
    const results: StepResult["checks"] = [
      passed("not_null(id)", true), passed("not_null(a, \"B c\")", true), passed("not_null(id, a)", true),
      passed("not_null(w)", false), { check: "not_null(f)", ok: false, blocking: true, failing: 1 }, passed("not_null(old)"),
      passed("unique(u)", true), passed("r IS NOT NULL", true), passed("not_null(", true),
    ];
    expect(vouchedNotNull("t", results)).toEqual(["id", "a", "B c"]);
    expect(vouchedNotNull("t", null)).toEqual([]);
  });
});

describe("generateInputTypes: .croft/types on disk", () => {
  test("writes each asset's file and the index; the folder is <root>/.croft/types", () => {
    const root = tempRoot();
    seed(join(root, ".croft"), [entry("orders", [col("id", "BIGINT")], { key: ["id"] }), entry("refunds", [col("amount", "DOUBLE")])]);
    const r = generateInputTypes(root);
    expect(TYPES_DIR).toBe(".croft/types");
    expect(r.dir).toBe(join(root, ".croft", "types"));
    expect(r.assets).toEqual(["orders", "refunds"]);
    expect(readdirSync(r.dir).sort()).toEqual(["index.d.ts", "orders.d.ts", "refunds.d.ts"]);
    expect(readFileSync(join(r.dir, "orders.d.ts"), "utf8")).toContain("export type OrdersRow = {\n  /** BIGINT, the key */\n  id: number | bigint;\n};\n");
    expect(r.changed.sort()).toEqual(["index.d.ts", "orders.d.ts", "refunds.d.ts"]);
  });

  test("unchanged files are left alone; a file of an asset no longer cached is removed, other files stay", () => {
    const root = tempRoot();
    const state = join(root, ".croft");
    seed(state, [entry("orders", [col("id", "BIGINT")]), entry("refunds", [col("amount", "DOUBLE")])]);
    const first = generateInputTypes(root);
    const orders = join(first.dir, "orders.d.ts");
    const old = new Date(Date.now() - 60_000);
    utimesSync(orders, old, old);
    writeFileSync(join(first.dir, "notes.txt"), "mine");
    const db = RunsDb.open(state);
    try {
      db.catalogDelete("refunds");
    } finally {
      db.close();
    }
    const again = generateInputTypes(root);
    expect(again.changed.sort()).toEqual(["index.d.ts", "refunds.d.ts"]);
    expect(statSync(orders).mtimeMs).toBe(old.getTime());
    expect(readdirSync(first.dir).sort()).toEqual(["index.d.ts", "notes.txt", "orders.d.ts"]);
    expect(readFileSync(join(first.dir, "index.d.ts"), "utf8")).not.toContain("refunds");
  });

  test("code sources replace the cache for their assets (validate --types: SQL as it is now)", () => {
    const root = tempRoot();
    seed(join(root, ".croft"), [entry("open_issues", [col("author", "VARCHAR"), col("_loaded_at", "TIMESTAMPTZ")], { kind: "sql" })]);
    const r = generateInputTypes(root, { code: [{ asset: "open_issues", from: "code", file: "assets/open_issues.sql", key: [], columns: [{ name: "author_login", type: "VARCHAR" }] }] });
    expect(r.types.OpenIssuesRow!.columns).toEqual(["author_login", "_loaded_at"]);
    expect(readFileSync(join(r.dir, "open_issues.d.ts"), "utf8")).not.toContain("author:");
  });

  test("narrowing follows the record of the table as last built, in every write mode (D107)", () => {
    const root = tempRoot();
    const state = join(root, ".croft");
    const label = (r: ReturnType<typeof generateInputTypes>, asset: string) => r.types[rowTypeName(asset)]!.columnTypes.label;
    const vouched = ran(state, "merged", [passed("not_null(label)", true)]);
    const warned = ran(state, "warned", [passed("not_null(label)", false)]);
    const older = ran(state, "older", [passed("not_null(label)")]);
    const restored = ran(state, "restored", []);
    seed(state, [
      // A merge leaves old rows unchecked, but they passed the check when they were written or when it was new (§3f).
      entry("merged", [col("label", "VARCHAR")], { write: "merge", key: ["id"], lastRunId: vouched }),
      // A warning never refused a row; a step an older croft recorded does not say which checks were blocking; a
      // restore runs no checks.
      entry("warned", [col("label", "VARCHAR")], { lastRunId: warned }),
      entry("older", [col("label", "VARCHAR")], { lastRunId: older }),
      entry("restored", [col("label", "VARCHAR")], { lastRunId: restored }),
    ]);
    const r = generateInputTypes(root);
    expect(["merged", "warned", "older", "restored"].map((a) => [a, label(r, a)])).toEqual([
      ["merged", "string"], ["warned", "string | null"], ["older", "string | null"], ["restored", "string | null"],
    ]);
    // A later run that did not end ok wrote the table (a chunked transform's committed chunks): nothing is vouched for.
    const failed = ran(state, "merged", [], "failed");
    seed(state, [entry("merged", [col("label", "VARCHAR")], { write: "merge", key: ["id"], lastRunId: failed })]);
    expect(label(generateInputTypes(root), "merged")).toBe("string | null");
  });

  test("code sources narrow where the code's not_null and the last run both say so (D107)", () => {
    const root = tempRoot();
    const state = join(root, ".croft");
    const run = ran(state, "open_issues", [passed("not_null(author, title)", true)]);
    seed(state, [entry("open_issues", [col("author", "VARCHAR"), col("title", "VARCHAR"), col("body", "VARCHAR")], { kind: "sql", lastRunId: run })]);
    const r = generateInputTypes(root, { code: [{
      asset: "open_issues", from: "code", key: [], notNull: ["author", "body"],
      columns: [{ name: "author", type: "VARCHAR" }, { name: "title", type: "VARCHAR" }, { name: "body", type: "VARCHAR" }],
    }] });
    // author: both. title: the code dropped the check, so the next build may write NULL. body: the check is new,
    // and the table has not passed it yet.
    expect(r.types.OpenIssuesRow!.columnTypes).toMatchObject({ author: "string", title: "string | null", body: "string | null" });
  });

  test("code sources keep the JSON keys a run saw in a column of the same name", () => {
    const root = tempRoot();
    seed(join(root, ".croft"), [entry("enriched", [col("meta", "JSON", { jsonKeys: ["plan", "seats"] }), col("n", "INTEGER")], { kind: "sql" })]);
    const r = generateInputTypes(root, { code: [{ asset: "enriched", from: "code", key: [], columns: [{ name: "meta", type: "JSON" }, { name: "other", type: "JSON" }] }] });
    const text = readFileSync(join(r.dir, "enriched.d.ts"), "utf8");
    expect(text).toContain("  /** JSON (keys seen: plan, seats) */\n  meta: unknown;\n  /** JSON */\n  other: unknown;\n");
  });

  test("a relocated state folder: the column cache is read there, the types still go to <root>/.croft/types", () => {
    const root = tempRoot();
    const state = join(root, "..", `${root.split("/").pop()}-state`);
    made.push(state);
    writeFileSync(join(root, "croft.json"), JSON.stringify({ database: "warehouse.duckdb", timezone: "UTC", stateDir: state }));
    seed(state, [entry("orders", [col("id", "BIGINT")])]);
    const r = generateInputTypes(root);
    expect(r.dir).toBe(join(root, ".croft", "types"));
    expect(r.assets).toEqual(["orders"]);
    // Given explicitly, too.
    expect(generateInputTypes(root, { stateDir: state }).assets).toEqual(["orders"]);
  });

  test("nothing cached: no folder is made, and an old one is emptied of croft's files", () => {
    const root = tempRoot();
    const none = generateInputTypes(root);
    expect(none.assets).toEqual([]);
    expect(existsSync(join(root, ".croft"))).toBe(false);

    const dir = join(root, ".croft", "types");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.d.ts"), "old");
    writeFileSync(join(dir, "gone.d.ts"), "old");
    expect(generateInputTypes(root).changed.sort()).toEqual(["gone.d.ts", "index.d.ts"]);
    expect(existsSync(dir)).toBe(false);
  });

  test("the preview's column cache is the folder croft preview writes", () => {
    const root = tempRoot();
    seed(previewDirectory(join(root, ".croft")), [entry("refunds", [col("amount", "DOUBLE")])], "preview");
    expect(generateInputTypes(root).assets).toEqual(["refunds"]);
  });
});
