// croft validate --types with generated input types (DESIGN.md §6 "Ways to try a change" 1, §11 phase 5): before
// the project's own tsc runs, .croft/types is regenerated from the column cache, with each SQL asset's output
// columns as its code is now (the bind check's). So a TS transform that reads a column renamed or removed upstream
// is caught before any run: UNKNOWN_INPUT_COLUMN at the line that reads it, with the runtime's did-you-mean and
// edit fix. Every test runs a real tsc.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CatalogAsset, type CatalogColumn, putCatalog } from "../../history/catalog.ts";
import { cleanup, cli, makeProject, PKG, runsDb, type TestProject, writeFiles } from "./inspect-testkit.ts";
import { includesInputTypes } from "./validate.ts";

afterAll(async () => {
  await cleanup();
});

/** The tsconfig croft init writes, with .croft/types included (agent/templates.ts tsconfigJson). */
const TSCONFIG = (include = ["assets", "lib", ".croft/types"]) => JSON.stringify({
  compilerOptions: {
    target: "esnext", module: "esnext", moduleResolution: "bundler", strict: true, skipLibCheck: true, noEmit: true,
    allowImportingTsExtensions: true, resolveJsonModule: true, types: ["bun"],
  },
  include,
}, null, 2);

/** node_modules as bun install leaves it: .bin/tsc linked to typescript's, and Bun's types. */
function withTypescript(p: TestProject, tsconfig = TSCONFIG()): void {
  const nm = join(p.root, "node_modules");
  symlinkSync(join(PKG, "node_modules", "typescript"), join(nm, "typescript"));
  mkdirSync(join(nm, "@types"), { recursive: true });
  symlinkSync(join(PKG, "node_modules", "@types", "bun"), join(nm, "@types", "bun"));
  mkdirSync(join(nm, ".bin"), { recursive: true });
  symlinkSync(join("..", "typescript", "bin", "tsc"), join(nm, ".bin", "tsc"));
  writeFileSync(join(p.root, "tsconfig.json"), tsconfig);
}

const col = (name: string, type: string, o: Partial<CatalogColumn> = {}): CatalogColumn =>
  ({ name, type, sourceName: name, pinned: false, pending: false, format: null, ...o });

const built = (asset: string, kind: CatalogAsset["kind"], key: string[], columns: CatalogColumn[]): CatalogAsset => ({
  asset, kind, behavior: "replace", write: "replace", key, rows: 3, columns: [...columns, col("_loaded_at", "TIMESTAMPTZ", { sourceName: null })],
  cursor: null, lastLoadedAt: "2026-09-22T18:55:00.000000Z", lastReplacedAt: null, lastRunId: "r_0922_1155_ok01", codeHash: null,
});

function catalog(p: TestProject, entries: CatalogAsset[]): void {
  const db = runsDb(p.stateDir);
  try {
    for (const e of entries) putCatalog(db, e);
  } finally {
    db.close();
  }
}

const ISSUES_TS = `import { ingest } from "@zabaca/croft";
export default ingest({ key: "id", async *rows() { yield []; } });
`;
const OPEN_SQL = (alias: string) => `-- key: id
SELECT id, title, "user"->>'login' AS ${alias} FROM github_issues
`;
const TRIAGE_TS = (column: string) => `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["open_issues"],
  async *rows({ rows }) {
    for await (const issue of rows("open_issues")) {
      yield { id: issue.id, who: issue.${column} ?? "nobody" };
    }
  },
});
`;

const validateTypes = (p: TestProject) => cli(["validate", "--types", "--json"], { cwd: p.root, env: { PATH: process.env.PATH } });

/** Plain validate's next step when TS transforms read assets (R51-02). */
const TYPES_REASON = (names: string) => `plain validate does not run tsc: --types checks the input columns read by ${names}`;

describe("plain validate points at --types when a TS transform reads an asset (R51-02)", () => {
  const ISSUES = built("github_issues", "ingest", ["id"], [col("id", "BIGINT"), col("title", "VARCHAR"), col("user", "JSON")]);

  test("after a clean check: croft validate --types first, then the preview of what changed", async () => {
    const p = makeProject({
      files: { "assets/github_issues.ts": ISSUES_TS, "assets/open_issues.sql": OPEN_SQL("author"), "assets/triage.ts": TRIAGE_TS("author") },
    });
    catalog(p, [{ ...ISSUES, codeHash: "an older hash" }]);
    const r = await cli(["validate", "--json"], { cwd: p.root });
    expect(r.json.problems.filter((x: { severity: string }) => x.severity !== "info")).toEqual([]);
    expect(r.json.next).toEqual([
      { command: "croft validate --types", reason: TYPES_REASON("triage") },
      { command: "croft preview github_issues", reason: "see what the changed code builds before running it" },
    ]);
    // Asked for one asset, it still names the check: tsc checks the whole project.
    const one = await cli(["validate", "open_issues", "--json"], { cwd: p.root });
    expect(one.json.next[0]).toEqual({ command: "croft validate --types", reason: TYPES_REASON("triage") });
    // Human output shows it as the next step.
    expect((await cli(["validate"], { cwd: p.root })).stdout).toContain("next: croft validate --types");
  }, 60_000);

  test("not after --types, not when there is an error to fix, and not without a TS transform that reads an asset", async () => {
    const p = makeProject({
      files: { "assets/github_issues.ts": ISSUES_TS, "assets/open_issues.sql": OPEN_SQL("author"), "assets/triage.ts": TRIAGE_TS("author") },
    });
    withTypescript(p);
    catalog(p, [ISSUES]);
    const typed = await validateTypes(p);
    expect(typed.json.problems).toEqual([]);
    expect(typed.json.next).toEqual([]);

    writeFiles(p.root, { "assets/open_issues.sql": "-- key: id\nSELECT id, titel FROM github_issues\n" });
    const broken = await cli(["validate", "--json"], { cwd: p.root });
    expect(broken.exit).toBe(2);
    expect(broken.json.next).toEqual([{ command: "croft validate", reason: "re-check after the edit" }]);

    const q = makeProject({ files: { "assets/github_issues.ts": ISSUES_TS, "assets/open_issues.sql": OPEN_SQL("author") } });
    catalog(q, [ISSUES]);
    expect((await cli(["validate", "--json"], { cwd: q.root })).json.next).toEqual([]);
  }, 60_000);

  test("several TS transforms are named, up to a few", async () => {
    const files: Record<string, string> = { "assets/github_issues.ts": ISSUES_TS, "assets/open_issues.sql": OPEN_SQL("author") };
    for (const n of ["a_triage", "b_triage", "c_triage", "d_triage", "e_triage"]) files[`assets/${n}.ts`] = TRIAGE_TS("author");
    const p = makeProject({ files });
    catalog(p, [ISSUES]);
    const r = await cli(["validate", "--json"], { cwd: p.root });
    expect(r.json.next).toEqual([{ command: "croft validate --types", reason: TYPES_REASON("a_triage, b_triage, c_triage and 2 more") }]);
  }, 60_000);
});

describe("validate --types catches a TS transform reading a column its input does not have", () => {
  test("renamed in the upstream SQL, before any run: UNKNOWN_INPUT_COLUMN at the line, the new name as the fix", async () => {
    const p = makeProject({
      files: { "assets/github_issues.ts": ISSUES_TS, "assets/open_issues.sql": OPEN_SQL("author"), "assets/triage.ts": TRIAGE_TS("author") },
    });
    withTypescript(p);
    catalog(p, [
      built("github_issues", "ingest", ["id"], [col("id", "BIGINT"), col("title", "VARCHAR"), col("user", "JSON", { jsonKeys: ["id", "login"] })]),
      built("open_issues", "sql", ["id"], [col("id", "BIGINT"), col("title", "VARCHAR"), col("author", "VARCHAR")]),
    ]);
    const ok = await validateTypes(p);
    expect(ok.json.problems).toEqual([]);
    expect(ok.json.data.types).toEqual({ status: "ok", errors: 0 });
    expect(ok.exit).toBe(0);
    const typesDir = join(p.root, ".croft", "types");
    expect(readFileSync(join(typesDir, "open_issues.d.ts"), "utf8")).toContain("  author: string | null;\n");

    // The SQL renames the column; nothing has run since. Plain validate binds the SQL, which is fine, and points at
    // --types: only tsc sees what the TS transform reads.
    writeFiles(p.root, { "assets/open_issues.sql": OPEN_SQL("author_login") });
    const plain = await cli(["validate", "--json"], { cwd: p.root });
    expect(plain.json.problems).toEqual([]);
    expect(plain.json.next).toEqual([{ command: "croft validate --types", reason: TYPES_REASON("triage") }]);
    const r = await validateTypes(p);
    expect(r.exit).toBe(2);
    expect(r.json.data.types).toEqual({ status: "failed", errors: 1 });
    expect(r.json.problems).toEqual([{
      severity: "error", code: "UNKNOWN_INPUT_COLUMN", docs: "croft docs UNKNOWN_INPUT_COLUMN",
      asset: "triage", file: "assets/triage.ts", line: 6, column: 40,
      message: 'open_issues has no column "author"; did you mean "author_login"?',
      hint: 'the column may have been renamed upstream; read "author_login" instead',
      fix: { kind: "edit", description: 'read "author_login" instead of "author"', file: "assets/triage.ts", line: 6, replace: { from: "author", to: "author_login" } },
      details: {
        tsc: "TS2339", input: "open_issues", column: "author", suggestion: "author_login",
        columns: ["id", "title", "author_login", "_loaded_at"], types: ".croft/types/open_issues.d.ts",
      },
    }]);
    // The generated type follows the SQL as it is now.
    const open = readFileSync(join(typesDir, "open_issues.d.ts"), "utf8");
    expect(open).toContain("From the output columns of assets/open_issues.sql as its code is now.");
    expect(open).toContain("  author_login: string | null;\n");
    expect(open).toContain("  /** BIGINT, the key */\n  id: number | bigint;\n");
    // Only tsc confirms the fix, so the re-check keeps --types.
    expect(r.json.next).toEqual([{ command: "croft validate --types", reason: "re-check after the edit" }]);

    // Applying the fix clears it.
    writeFiles(p.root, { "assets/triage.ts": TRIAGE_TS("author_login") });
    const fixed = await validateTypes(p);
    expect(fixed.json.problems).toEqual([]);
    expect(fixed.exit).toBe(0);
  }, 60_000);

  test("a tsconfig.json with \"pretty\": true: tsc still prints lines croft parses (--pretty false wins), no escapes", async () => {
    const p = makeProject({
      files: { "assets/github_issues.ts": ISSUES_TS, "assets/open_issues.sql": OPEN_SQL("author_login"), "assets/triage.ts": TRIAGE_TS("author") },
    });
    const pretty = JSON.parse(TSCONFIG()) as { compilerOptions: Record<string, unknown> };
    pretty.compilerOptions.pretty = true;
    withTypescript(p, JSON.stringify(pretty, null, 2));
    catalog(p, [built("github_issues", "ingest", ["id"], [col("id", "BIGINT"), col("title", "VARCHAR"), col("user", "JSON")])]);
    const r = await validateTypes(p);
    expect(r.exit).toBe(2);
    expect(r.json.data.types).toEqual({ status: "failed", errors: 1 });
    expect(r.json.problems).toEqual([expect.objectContaining({
      code: "UNKNOWN_INPUT_COLUMN", file: "assets/triage.ts", line: 6, message: 'open_issues has no column "author"; did you mean "author_login"?',
    })]);
    expect(JSON.stringify(r.json)).not.toContain("\\u001b");
  }, 60_000);

  test("removed from a built input: the hint lists its columns; a destructured name keeps its binding; a computed name needs Row", async () => {
    const p = makeProject({
      files: {
        "assets/scores.ts": ISSUES_TS,
        "assets/report.ts": `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["scores"],
  async *rows({ rows }) {
    for await (const r of rows("scores")) {
      const { player } = r;
      const col: string = "points";
      yield { player, rank: r.rank, p: r[col] };
    }
  },
});
`,
      },
    });
    withTypescript(p);
    catalog(p, [built("scores", "ingest", ["id"], [col("id", "BIGINT"), col("player_name", "VARCHAR"), col("points", "DOUBLE")])]);
    const r = await validateTypes(p);
    expect(r.exit).toBe(2);
    expect(r.json.data.types).toEqual({ status: "failed", errors: 3 });
    const [player, rank, dynamic] = r.json.problems;
    expect(player).toMatchObject({
      code: "UNKNOWN_INPUT_COLUMN", asset: "report", file: "assets/report.ts", line: 6, column: 15,
      message: 'scores has no column "player"; did you mean "player_name"?',
      // Replacing the name in `const { player } = r` would rename the variable too.
      fix: { kind: "edit", description: 'read "player_name" instead of "player": { player_name: player } keeps the name player', file: "assets/report.ts", line: 6 },
    });
    expect(player.fix.replace).toBeUndefined();
    expect(rank).toMatchObject({
      code: "UNKNOWN_INPUT_COLUMN", line: 8, column: 31,
      message: 'scores has no column "rank"',
      hint: "scores has these columns: id, player_name, points, _loaded_at",
      fix: { kind: "edit", description: "read one of the columns of scores (.croft/types/scores.d.ts lists them)", file: "assets/report.ts", line: 8 },
      details: { input: "scores", column: "rank", columns: ["id", "player_name", "points", "_loaded_at"] },
    });
    expect(dynamic).toMatchObject({
      code: "ASSET_INVALID", line: 8, column: 40,
      message: expect.stringContaining("TS7053: Element implicitly has an 'any' type because expression of type 'string' can't be used to index type 'ScoresRow'."),
      hint: 'scores\'s generated row type names its columns; for a column name computed at run time, read the input as a Row: rows<Row>("scores"), or (row as Row)[name]',
      fix: { kind: "edit", description: 'read scores with rows<Row>("scores") (import type { Row } from "@zabaca/croft")', file: "assets/report.ts", line: 8 },
    });
  }, 60_000);
});

describe("type errors on a generated row type's columns get a hint that says what to write (R51-09)", () => {
  const REVENUE_TS = (expr: string) => `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["sales"],
  key: "id",
  incremental: true,
  async *rows({ newRows }) {
    for await (const row of newRows("sales")) {
      yield { id: row.id, revenue: ${expr} };
    }
  },
});
`;

  test("arithmetic on a BIGINT (number | bigint): Number(row.x); a column that may be NULL: a default", async () => {
    // Every integer from CSV or JSON is BIGINT: a number, and a bigint only beyond ±2^53 (db/values.ts).
    const p = makeProject({ files: { "assets/sales.ts": ISSUES_TS, "assets/revenue.ts": REVENUE_TS("row.quantity * row.unit_price") } });
    withTypescript(p);
    catalog(p, [built("sales", "ingest", ["id"], [col("id", "BIGINT"), col("quantity", "BIGINT"), col("unit_price", "DOUBLE")])]);
    const r = await validateTypes(p);
    expect(r.exit).toBe(2);
    expect(r.json.data.types).toEqual({ status: "failed", errors: 3 });
    const [quantityNull, bigint, priceNull] = r.json.problems;
    expect(quantityNull).toMatchObject({
      code: "ASSET_INVALID", asset: "revenue", file: "assets/revenue.ts", line: 8,
      message: "TS18047: 'row.quantity' is possibly 'null'.",
      hint: "quantity of sales may be NULL (every column but the key may): give it a default, (row.quantity ?? 0), or skip the rows where it is null",
      fix: { kind: "edit", description: "handle a NULL row.quantity on line 8", file: "assets/revenue.ts", line: 8 },
      details: { tsc: "TS18047", input: "sales", column: "quantity" },
    });
    expect(bigint).toMatchObject({
      code: "ASSET_INVALID", line: 8,
      message: "TS2365: Operator '*' cannot be applied to types 'number | bigint' and 'number'.",
      hint: "a BIGINT column is number | bigint (a bigint only beyond ±2^53): for arithmetic, write Number(row.quantity), exact up to ±2^53",
      fix: { kind: "edit", description: "convert the BIGINT value with Number(row.quantity) on line 8", file: "assets/revenue.ts", line: 8 },
      details: { tsc: "TS2365", input: "sales", column: "quantity" },
    });
    expect(priceNull).toMatchObject({ message: "TS18047: 'row.unit_price' is possibly 'null'.", details: { column: "unit_price" } });

    // What the hints say to write passes.
    writeFiles(p.root, { "assets/revenue.ts": REVENUE_TS("Number(row.quantity ?? 0) * (row.unit_price ?? 0)") });
    const fixed = await validateTypes(p);
    expect(fixed.json.problems).toEqual([]);
    expect(fixed.exit).toBe(0);
  }, 60_000);

  test("a number | bigint anywhere else still gets the Number() hint; other errors keep the generic one", async () => {
    const p = makeProject({ files: { "assets/sales.ts": ISSUES_TS, "assets/revenue.ts": REVENUE_TS("Math.round(row.id) + ([] as string[]).length.nope") } });
    withTypescript(p);
    catalog(p, [built("sales", "ingest", ["id"], [col("id", "BIGINT")])]);
    const r = await validateTypes(p);
    expect(r.json.problems.map((x: { message: string; hint: string }) => [x.message.slice(0, 7), x.hint.slice(0, 40)])).toEqual([
      ["TS2345:", "a BIGINT column is number | bigint (a bi"],
      ["TS2339:", "fix the type error; the project's own ts"],
    ]);
    expect(r.json.problems[0].fix.description).toBe("convert the BIGINT value with Number(row.id) on line 8");
  }, 60_000);
});

describe("includesInputTypes: whether tsconfig.json reaches .croft/types", () => {
  test("only a pattern naming .croft does: TypeScript's wildcards skip dot folders", () => {
    expect(includesInputTypes(TSCONFIG())).toBe(true);
    expect(includesInputTypes(`{ "include": ["assets", "./.croft/types/"] }`)).toBe(true);
    expect(includesInputTypes(`{ "include": [".croft/types/**/*.d.ts"] }`)).toBe(true);
    expect(includesInputTypes(`{ "include": [".croft"] }`)).toBe(true);
    expect(includesInputTypes(`{ "include": [".croft/**"] }`)).toBe(true);
    expect(includesInputTypes(`{ "include": [".croft/*"] }`)).toBe(false);         // "*" never crosses a "/"
    expect(includesInputTypes(`// JSONC\n{ "include": ["assets", "lib",], }`)).toBe(false);
    expect(includesInputTypes(`{ "include": ["**/*"] }`)).toBe(false);
    expect(includesInputTypes(`{ "compilerOptions": {} }`)).toBe(false);          // the default "**/*"
    expect(includesInputTypes(`{ "extends": "./base.json" }`)).toBeNull();         // the base's include: unknown
    expect(includesInputTypes(`{ "include": "assets" }`)).toBeNull();
    expect(includesInputTypes("{ not json")).toBeNull();
    expect(includesInputTypes("")).toBeNull();
  });
});

describe("the types folder", () => {
  test("plain validate writes nothing; validate --types writes it before tsc", async () => {
    const p = makeProject({ files: { "assets/github_issues.ts": ISSUES_TS } });
    withTypescript(p);
    catalog(p, [built("github_issues", "ingest", ["id"], [col("id", "BIGINT")])]);
    await cli(["validate", "--json"], { cwd: p.root });
    expect(existsSync(join(p.root, ".croft", "types"))).toBe(false);
    const r = await validateTypes(p);
    expect(r.exit).toBe(0);
    expect(existsSync(join(p.root, ".croft", "types", "github_issues.d.ts"))).toBe(true);
  }, 60_000);

  test("a tsconfig.json that does not include .croft/types: an info problem with the edit; tsc runs as before", async () => {
    const p = makeProject({ files: { "assets/github_issues.ts": ISSUES_TS } });
    withTypescript(p, TSCONFIG(["assets", "lib"]));
    catalog(p, [built("github_issues", "ingest", ["id"], [col("id", "BIGINT")])]);
    const r = await validateTypes(p);
    expect(r.exit).toBe(0);
    expect(r.json.data.types).toEqual({ status: "ok", errors: 0 });
    expect(r.json.problems).toEqual([expect.objectContaining({
      severity: "info", code: "INSTALL_FAILED", file: "tsconfig.json",
      message: "tsconfig.json does not include .croft/types, so TS transforms read every input row as a Row: tsc cannot catch a column renamed upstream",
      hint: 'add ".croft/types/**/*.d.ts" to "include" in tsconfig.json, as croft init writes it',
      fix: { kind: "edit", description: 'add ".croft/types/**/*.d.ts" to the "include" list', file: "tsconfig.json" },
    })]);
    // No catalog, no types: nothing to say.
    const q = makeProject({ files: { "assets/github_issues.ts": ISSUES_TS } });
    withTypescript(q, TSCONFIG(["assets", "lib"]));
    expect((await validateTypes(q)).json.problems).toEqual([]);
  }, 60_000);

  // Root writes through any mode bits (the Linux CI container runs as root), so the refusal cannot be staged there.
  test.skipIf(process.getuid?.() === 0)("a folder croft cannot write: a warning, and tsc still runs", async () => {
    const p = makeProject({ files: { "assets/github_issues.ts": ISSUES_TS } });
    withTypescript(p);
    catalog(p, [built("github_issues", "ingest", ["id"], [col("id", "BIGINT")])]);
    const dir = join(p.root, ".croft", "types");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    try {
      const r = await validateTypes(p);
      expect(r.json.data.types).toEqual({ status: "ok", errors: 0 });
      expect(r.json.problems).toEqual([expect.objectContaining({
        severity: "warning", code: "PROJECT_NOT_WRITABLE", file: ".croft/types",
        message: expect.stringContaining("could not write .croft/types"),
        hint: "tsc checked the TS transforms without their current input row types; make .croft/types writable (or delete it), then run croft validate --types again",
        fix: { kind: "manual", description: "make .croft/types writable, or delete the folder" },
      })]);
      expect(r.exit).toBe(0);
    } finally {
      chmodSync(dir, 0o700);
    }
  }, 60_000);
});
