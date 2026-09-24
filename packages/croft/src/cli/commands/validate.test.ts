import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tsconfigJson } from "../../agent/templates.ts";
import { type CatalogAsset, type CatalogColumn, putCatalog } from "../../history/catalog.ts";
import { ProjectEnv } from "../../project/env.ts";
import { resolveProject } from "../../project/resolve.ts";
import type { Command } from "../command.ts";
import { COMMANDS } from "./index.ts";
import { cleanup, cli, makeProject, PKG, runsDb, type TestProject, writeFiles } from "./inspect-testkit.ts";
import { newRowsCalls, parseTsc, validate, validateProject } from "./validate.ts";

afterAll(async () => {
  await cleanup();
});

// ---------------------------------------------------------------------------------------------------------
// Fixtures

const ISSUES_TS = `import { ingest } from "@zabaca/croft";
export default ingest({ key: "id", incremental: "updated_at", async *rows() { yield []; } });
`;
const CHARGES_TS = `import { ingest } from "@zabaca/croft";
export default ingest({ key: "id", async *rows() { yield []; } });
`;

/** A catalog column as a run leaves it. */
const col = (name: string, type: string, o: Partial<CatalogColumn> = {}): CatalogColumn =>
  ({ name, type, sourceName: name, pinned: false, pending: false, format: null, ...o });

/** github_issues as a run built it: id, title, state, created_at, "user" (JSON), "order", _loaded_at. */
const ISSUES_BUILT: CatalogAsset = {
  asset: "github_issues", kind: "ingest", behavior: "updates rows by id", write: "merge", key: ["id"], rows: 3,
  columns: [
    col("id", "BIGINT"), col("title", "VARCHAR"), col("state", "VARCHAR"), col("created_at", "TIMESTAMPTZ"),
    col("user", "JSON"), col("order", "BIGINT"), col("closed_at", "VARCHAR", { pending: true }),
    col("_loaded_at", "TIMESTAMPTZ", { sourceName: null }),
  ],
  cursor: { field: "updated_at", value: "2026-09-22T17:58:03Z", type: "timestamp", unit: null },
  lastLoadedAt: "2026-09-22T18:55:00.000000Z", lastReplacedAt: null, lastRunId: "r_0922_1155_ok01", codeHash: "hash-1",
};

function catalog(p: TestProject, entries: CatalogAsset[]): void {
  const db = runsDb(p.stateDir);
  try {
    for (const e of entries) putCatalog(db, e);
  } finally {
    db.close();
  }
}

async function check(p: TestProject, o: { selectors?: string[]; shell?: Record<string, string> } = {}) {
  return validateProject({
    project: p.project, env: ProjectEnv.load(p.root, o.shell ?? {}), importTimeoutMs: 10_000,
    ...(o.selectors ? { selectors: o.selectors } : {}),
  });
}

const codes = (problems: readonly { code: string }[]) => problems.map((x) => x.code);

// ---------------------------------------------------------------------------------------------------------

describe("the bind check", () => {
  test("an unknown column: file, line and column past the header, the candidate as an edit fix (§4.2)", async () => {
    const p = makeProject({
      files: {
        "assets/github_issues.ts": ISSUES_TS,
        "assets/open_issues.sql": "-- description: open issues\n-- key: id\nSELECT id, title,\n  creatd_at\nFROM github_issues WHERE state = 'open'\n",
      },
    });
    catalog(p, [ISSUES_BUILT]);
    const r = await check(p);
    expect(r.data.order).toEqual(["github_issues", "open_issues"]);
    const unknown = r.problems.find((x) => x.code === "UNKNOWN_COLUMN")!;
    expect(unknown).toMatchObject({
      severity: "error", asset: "open_issues", file: "assets/open_issues.sql", line: 4, column: 3,
      fix: { kind: "edit", file: "assets/open_issues.sql", line: 4, replace: { from: "creatd_at", to: "created_at" } },
    });
    expect(r.data.assets.find((a) => a.name === "open_issues")).toEqual({
      name: "open_issues", kind: "sql", inputs: ["github_issues"], outputColumns: null, behavior: "replace; key id", codeChanged: false,
    });
  });

  test("output columns come from prepare() and feed the next asset, so a rename breaks its reader", async () => {
    const p = makeProject({
      files: {
        "assets/github_issues.ts": ISSUES_TS,
        "assets/open_issues.sql": "SELECT id, title AS headline, \"user\"->>'login' AS author FROM github_issues\n",
        "assets/by_author.sql": "SELECT author, count(*) AS n, max(title) AS last_title FROM open_issues GROUP BY author\n",
      },
    });
    catalog(p, [ISSUES_BUILT]);
    const r = await check(p);
    expect(r.data.order).toEqual(["github_issues", "open_issues", "by_author"]);
    const open = r.data.assets.find((a) => a.name === "open_issues")!;
    expect(open.outputColumns).toEqual([{ name: "id", type: "BIGINT" }, { name: "headline", type: "VARCHAR" }, { name: "author", type: "VARCHAR" }]);
    // by_author reads the renamed column: bound against open_issues' output as the code is now.
    expect(r.problems.find((x) => x.asset === "by_author")).toMatchObject({
      code: "UNKNOWN_COLUMN", line: 1, column: 35, details: { column: "title" },
    });
    // The ingest has no output columns of its own (TS), and never loses its kind or behavior.
    expect(r.data.assets.find((a) => a.name === "github_issues")).toMatchObject({ kind: "ingest", outputColumns: null, behavior: "merge by id" });
  });

  test("INPUT_NOT_BUILT: info, only the readers skip, transitively, with croft preview of the root", async () => {
    const p = makeProject({
      files: {
        "assets/github_issues.ts": ISSUES_TS,
        "assets/stripe_charges.ts": CHARGES_TS,
        "assets/daily_revenue.sql": "SELECT created::DATE AS day, sum(amount) AS revenue FROM stripe_charges GROUP BY 1\n",
        "assets/weekly_revenue.sql": "SELECT date_trunc('week', day) AS week, sum(revenue) AS revenue FROM daily_revenue GROUP BY 1\n",
        "assets/open_issues.sql": "SELECT id, title FROM github_issues\n",
      },
    });
    catalog(p, [ISSUES_BUILT]);
    const r = await check(p);
    expect(r.problems.every((x) => x.severity === "info")).toBe(true);
    const daily = r.problems.find((x) => x.asset === "daily_revenue")!;
    expect(daily).toMatchObject({
      code: "INPUT_NOT_BUILT", file: "assets/daily_revenue.sql",
      message: "columns of stripe_charges are unknown until it has run or been previewed; bind check skipped",
      fix: { kind: "command", command: "croft preview stripe_charges" },
      details: { input: "stripe_charges", notBuilt: ["stripe_charges"] },
    });
    const weekly = r.problems.find((x) => x.asset === "weekly_revenue")!;
    expect(weekly).toMatchObject({
      code: "INPUT_NOT_BUILT",
      message: "columns of daily_revenue are unknown until stripe_charges has run or been previewed; bind check skipped",
      fix: { command: "croft preview stripe_charges" },
    });
    // open_issues binds: its input is built.
    expect(r.data.assets.find((a) => a.name === "open_issues")!.outputColumns).toEqual([{ name: "id", type: "BIGINT" }, { name: "title", type: "VARCHAR" }]);
    expect(r.data.assets.find((a) => a.name === "daily_revenue")!.outputColumns).toBeNull();

    // Through the CLI: ok, exit 0, the info shown with its next step.
    const out = await cli(["validate", "--json"], { cwd: p.root });
    expect(out.exit).toBe(0);
    expect(out.json).toMatchObject({ ok: true, command: "validate" });
  });

  test("an input never built but previewed binds against the preview's columns (the column cache holds previews)", async () => {
    const p = makeProject({
      files: {
        "assets/stripe_charges.ts": CHARGES_TS,
        "assets/daily_revenue.sql": "SELECT created::DATE AS day, sum(amount) AS revenue FROM stripe_charges GROUP BY 1\n",
      },
    });
    expect(codes((await check(p)).problems)).toEqual(["INPUT_NOT_BUILT"]);
    // `croft preview stripe_charges` wrote its catalog entry to .croft/preview/runs.sqlite, with source "preview".
    const previewed: CatalogAsset = {
      asset: "stripe_charges", kind: "ingest", behavior: "replaces the table's contents", write: "replace", key: ["id"], rows: 2,
      columns: [col("id", "VARCHAR"), col("created", "TIMESTAMPTZ"), col("amount", "DOUBLE"), col("_loaded_at", "TIMESTAMPTZ", { sourceName: null })],
      cursor: null, lastLoadedAt: "2026-09-22T18:55:00.000000Z", lastReplacedAt: null, lastRunId: "p_0922_1155_ok01", codeHash: "preview-hash",
    };
    const db = runsDb(join(p.stateDir, "preview"));
    try {
      putCatalog(db, previewed, "preview");
    } finally {
      db.close();
    }
    const after = await check(p);
    expect(after.problems).toEqual([]);
    expect(after.data.assets.find((a) => a.name === "daily_revenue")!.outputColumns).toEqual([{ name: "day", type: "DATE" }, { name: "revenue", type: "DOUBLE" }]);
    // A preview is no build: codeChanged still compares with the live catalog only.
    expect(after.data.assets.find((a) => a.name === "stripe_charges")!.codeChanged).toBe(false);
    // A live entry wins over the preview's.
    catalog(p, [{ ...previewed, lastRunId: "r_0922_1200_live", columns: previewed.columns.map((c) => (c.name === "amount" ? col("amount_cents", "BIGINT") : c)) }]);
    const live = await check(p);
    expect(codes(live.problems)).toEqual(["UNKNOWN_COLUMN"]);
  });

  test("an input with errors: its readers skip the bind and say why", async () => {
    const p = makeProject({
      files: {
        "assets/github_issues.ts": ISSUES_TS,
        "assets/open_issues.sql": "SELECT id FROM github_issues; SELECT 2\n",
        "assets/counted.sql": "SELECT count(*) AS n FROM open_issues\n",
      },
    });
    catalog(p, [ISSUES_BUILT]);
    const r = await check(p);
    expect(codes(r.problems.filter((x) => x.asset === "open_issues"))).toEqual(["SQL_NOT_ONE_STATEMENT"]);
    expect(r.problems.find((x) => x.asset === "counted")).toMatchObject({
      code: "INPUT_NOT_BUILT", severity: "info",
      message: "columns of open_issues are unknown until the errors in assets/open_issues.sql are fixed; bind check skipped",
    });
    expect(r.problems.find((x) => x.asset === "counted")!.fix).toBeUndefined();
  });

  test("a built input keeps its cached columns when its code does not bind now", async () => {
    const p = makeProject({
      files: {
        "assets/github_issues.ts": ISSUES_TS,
        "assets/open_issues.sql": "SELECT id, titel FROM github_issues\n",
        "assets/counted.sql": "SELECT count(title) AS n FROM open_issues\n",
      },
    });
    catalog(p, [ISSUES_BUILT, { ...ISSUES_BUILT, asset: "open_issues", kind: "sql", columns: [col("id", "BIGINT"), col("title", "VARCHAR"), col("_loaded_at", "TIMESTAMPTZ")] }]);
    const r = await check(p);
    expect(codes(r.problems)).toEqual(["UNKNOWN_COLUMN"]);
    expect(r.problems[0]!.asset).toBe("open_issues");
    expect(r.data.assets.find((a) => a.name === "counted")!.outputColumns).toEqual([{ name: "n", type: "BIGINT" }]);
  });

  test("QUOTE_IDENTIFIER replaces the loader's SQL_SYNTAX; NULL_ONLY_COLUMN; DUPLICATE_OUTPUT_COLUMN", async () => {
    const p = makeProject({
      files: {
        "assets/github_issues.ts": ISSUES_TS,
        "assets/ordered.sql": "SELECT id, order FROM github_issues\n",
        "assets/closed.sql": "SELECT id, closed_at + INTERVAL 1 DAY AS due FROM github_issues\n",
        "assets/doubled.sql": "SELECT id,\n  title,\n  state AS title\nFROM github_issues\n",
      },
    });
    catalog(p, [ISSUES_BUILT]);
    const r = await check(p);
    expect(codes(r.problems.filter((x) => x.asset === "ordered"))).toEqual(["QUOTE_IDENTIFIER"]);
    expect(r.problems.find((x) => x.asset === "ordered")).toMatchObject({ fix: { replace: { from: "order", to: "\"order\"" } } });
    expect(r.problems.find((x) => x.asset === "closed")).toMatchObject({ code: "NULL_ONLY_COLUMN", severity: "warning" });
    expect(r.problems.find((x) => x.asset === "doubled")).toMatchObject({ code: "DUPLICATE_OUTPUT_COLUMN", severity: "error", line: 3 });
  });

  test("an SQL asset's checks bind against its output: a missing column is UNKNOWN_COLUMN on the check's line", async () => {
    const p = makeProject({
      files: {
        "assets/github_issues.ts": ISSUES_TS,
        "assets/open_issues.sql": "-- key: issue_id\n-- check: not_null(autor)\n-- warn: id > 0 AND titel <> ''\nSELECT id, title, \"user\"->>'login' AS author FROM github_issues\n",
      },
    });
    catalog(p, [ISSUES_BUILT]);
    const r = await check(p);
    const found = r.problems.filter((x) => x.asset === "open_issues");
    expect(found.map((x) => [x.code, x.line, x.column])).toEqual([
      ["UNKNOWN_COLUMN", 1, undefined], ["UNKNOWN_COLUMN", 2, undefined], ["UNKNOWN_COLUMN", 3, 21],
    ]);
    expect(found[0]!.message).toStartWith("check unique(issue_id): ");
    expect(found[1]).toMatchObject({ message: expect.stringContaining("check not_null(autor): "), fix: { kind: "edit", line: 2, replace: { from: "autor", to: "author" } } });
    expect(found[2]).toMatchObject({ message: expect.stringContaining("warning id > 0 AND titel <> '': "), fix: { line: 3, replace: { from: "titel", to: "title" } } });
    // The asset itself binds: its output columns are still reported.
    expect(r.data.assets[1]!.outputColumns?.map((c) => c.name)).toEqual(["id", "title", "author"]);
  });
});

describe("static checks", () => {
  test("load problems surface: VOLATILE_SQL, CHECK_INVALID, CYCLE, ASSET_OPENS_DATABASE, TRANSFORM_MAKES_REQUESTS, SCHEDULE_INVALID", async () => {
    const p = makeProject({
      files: {
        "assets/github_issues.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ key: "id", schedule: 5, async *rows() { yield []; } });\n`,
        "assets/stamped.sql": "-- check: id >\nSELECT id, now() AS seen FROM github_issues\n",
        "assets/a.sql": "SELECT * FROM b\n",
        "assets/b.sql": "SELECT * FROM a\n",
        "assets/opener.ts": `import { DuckDBInstance } from "@duckdb/node-api";\nimport { transform } from "@zabaca/croft";\nexport default transform({ inputs: ["github_issues"], async *rows() { yield []; } });\n`,
        "assets/enriched.ts": `import { transform } from "@zabaca/croft";\nexport default transform({ inputs: ["github_issues"], async *rows(ctx) { await ctx.http.get("https://example.com"); yield []; } });\n`,
      },
    });
    catalog(p, [ISSUES_BUILT]);
    const r = await check(p);
    const by = (code: string) => r.problems.filter((x) => x.code === code).map((x) => x.asset);
    expect(by("VOLATILE_SQL")).toEqual(["stamped"]);
    expect(by("CHECK_INVALID")).toEqual(["stamped"]);
    expect(by("CYCLE")).toEqual(["a"]);
    // The cycle's assets skip the bind without another problem: CYCLE says why.
    expect(codes(r.problems.filter((x) => x.asset === "a" || x.asset === "b"))).toEqual(["CYCLE"]);
    expect(by("ASSET_OPENS_DATABASE")).toEqual(["opener"]);
    expect(by("TRANSFORM_MAKES_REQUESTS")).toEqual(["enriched"]);
    expect(by("SCHEDULE_INVALID")).toEqual(["github_issues"]);
    // Project problems come first, then each asset's in run order; the cycle's assets are last in `order`.
    expect(r.problems[0]!.code).toBe("CYCLE");
    expect(r.data.order).not.toContain("a");
    expect(r.data.assets.map((x) => x.name)).toEqual(["github_issues", "enriched", "opener", "stamped", "a", "b"]);
  });

  // R2.2: DESIGN §3c's own warn example, with issue_triage reading open_issues, was reported as a CYCLE, and both
  // assets were left out of the order. A warning's subquery does not order the steps (§3f: it runs after commit).
  test("a warning that reads a downstream table is no cycle; a blocking check that does is", async () => {
    const files = {
      "assets/github_issues.ts": ISSUES_TS,
      "assets/open_issues.sql": "-- key: id\n-- warn: id IN (SELECT issue_id FROM issue_triage)\nSELECT id, title FROM github_issues\n",
      "assets/issue_triage.ts": `import { transform } from "@zabaca/croft";\nexport default transform({ inputs: ["open_issues"], key: "issue_id", incremental: true, async *rows() { yield []; } });\n`,
    };
    const p = makeProject({ files });
    catalog(p, [ISSUES_BUILT]);
    const r = await check(p);
    expect(codes(r.problems)).toEqual([]);
    expect(r.data.order).toEqual(["github_issues", "open_issues", "issue_triage"]);
    writeFiles(p.root, { "assets/open_issues.sql": files["assets/open_issues.sql"].replace("-- warn:", "-- check:") });
    const blocking = await check(p);
    expect(codes(blocking.problems)).toEqual(["CYCLE"]);
    expect(blocking.problems[0]!.hint).toContain("a check in assets/open_issues.sql reads issue_triage");
  });

  test("INPUT_NEEDS_KEY: an incremental transform's newRows() input without a key, at the call", async () => {
    const p = makeProject({
      files: {
        "assets/github_issues.ts": ISSUES_TS,
        "assets/open_issues.sql": "SELECT id, title FROM github_issues\n",
        "assets/keyed.sql": "-- key: id\nSELECT id, title FROM github_issues\n",
        "assets/triage.ts": `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["open_issues", "keyed", "github_issues"], key: "id", incremental: true,
  async *rows(ctx) {
    // ctx.newRows("github_issues") in a comment does not count
    for await (const r of ctx.newRows("keyed")) yield r;
    for await (const r of ctx.newRows<{ id: number }>('open_issues')) yield r;
    for await (const r of ctx.rows("github_issues")) yield r;
  },
});
`,
        "assets/full.ts": `import { transform } from "@zabaca/croft";
export default transform({ inputs: ["open_issues"], async *rows(ctx) { for await (const r of ctx.newRows("open_issues")) yield r; } });
`,
      },
    });
    catalog(p, [ISSUES_BUILT]);
    const r = await check(p);
    const needs = r.problems.filter((x) => x.code === "INPUT_NEEDS_KEY");
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({
      severity: "error", asset: "triage", file: "assets/triage.ts", line: 7, details: { input: "open_issues", inputFile: "assets/open_issues.sql" },
    });
    expect(needs[0]!.fix?.description).toContain("-- key: <column> to the header of assets/open_issues.sql");
  });

  test("newRowsCalls: literal names only, comments ignored, strings kept", () => {
    expect(newRowsCalls(`/* ctx.newRows("a") */ const x = "// not a comment"; ctx.newRows("b");\nctx.newRows(name); ctx.newRows(\`c\`, 1)`))
      .toEqual([{ input: "b", line: 1 }, { input: "c", line: 2 }]);
  });

  test("a transform input that is no asset is UNKNOWN_TABLE with a did-you-mean edit fix", async () => {
    const p = makeProject({
      files: {
        "assets/github_issues.ts": ISSUES_TS,
        "assets/triage.ts": `import { transform } from "@zabaca/croft";\nexport default transform({\n  inputs: ["github_isues"],\n  async *rows() { yield []; },\n});\n`,
      },
    });
    const r = await check(p);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({
      code: "UNKNOWN_TABLE", asset: "triage", line: 3, hint: "did you mean github_issues?",
      fix: { kind: "edit", replace: { from: "github_isues", to: "github_issues" } },
    });
  });

  test("SECRET_MISSING is a warning with the .env fix, gone once the secret is set", async () => {
    const p = makeProject({
      files: { "assets/stripe_charges.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ secrets: ["STRIPE_KEY"], async *rows() { yield []; } });\n` },
    });
    const r = await check(p);
    expect(r.problems).toEqual([expect.objectContaining({
      code: "SECRET_MISSING", severity: "warning", asset: "stripe_charges", file: "assets/stripe_charges.ts",
      fix: expect.objectContaining({ kind: "manual", requiresHuman: true }),
    })]);
    expect((await check(p, { shell: { STRIPE_KEY: "sk_test_1234567890" } })).problems).toEqual([]);
    writeFileSync(join(p.root, ".env"), "STRIPE_KEY=sk_test_1234567890\n");
    expect((await check(p)).problems).toEqual([]);
  });
});

describe("croft validate (the command)", () => {
  test("named assets: only those are checked (their inputs are still bound); an unknown name is USAGE_ERROR", async () => {
    const p = makeProject({
      files: {
        "assets/github_issues.ts": ISSUES_TS,
        "assets/open_issues.sql": "SELECT id, title AS headline FROM github_issues\n",
        "assets/by_title.sql": "SELECT headline FROM open_issues\n",
        "assets/broken.sql": "SELECT nope FROM github_issues\n",
      },
    });
    catalog(p, [ISSUES_BUILT]);
    const r = await cli(["validate", "by_title", "--json"], { cwd: p.root });
    expect(r.exit).toBe(0);
    expect(r.json.data.assets.map((a: { name: string }) => a.name)).toEqual(["by_title"]);
    expect(r.json.data.assets[0].outputColumns).toEqual([{ name: "headline", type: "VARCHAR" }]);
    expect(r.json.data.order).toEqual(["github_issues", "broken", "open_issues", "by_title"]);
    expect(r.json.problems).toEqual([]);

    const all = await cli(["validate", "--json"], { cwd: p.root });
    expect(all.exit).toBe(2);
    expect(all.json).toMatchObject({ ok: false, next: [{ command: "croft validate", reason: "re-check after the edit" }] });
    expect(codes(all.json.problems)).toEqual(["UNKNOWN_COLUMN"]);

    const bad = await cli(["validate", "by_titel", "--json"], { cwd: p.root });
    expect(bad.exit).toBe(2);
    expect(bad.json.problems[0]).toMatchObject({ code: "USAGE_ERROR", hint: "did you mean by_title?" });
    // The did-you-mean fix repeats the command typed: validate touches no data, and neither does its fix.
    expect(bad.json.problems[0].fix).toMatchObject({ kind: "command", command: "croft validate by_title" });
    const typed = await cli(["validate", "open_issues", "by_titel", "--types", "--json"], { cwd: p.root });
    expect(typed.json.problems[0].fix.command).toBe("croft validate open_issues by_title --types");
    const glob = await cli(["validate", "open_*", "by_titel", "--json"], { cwd: p.root });
    expect(glob.json.problems[0].fix.command).toBe("croft validate 'open_*' by_title");
  });

  test("codeChanged against the catalog's code hash, and croft preview of what changed as the next step", async () => {
    const p = makeProject({
      files: { "assets/github_issues.ts": ISSUES_TS, "assets/open_issues.sql": "SELECT id, title FROM github_issues\n" },
    });
    catalog(p, [ISSUES_BUILT]);
    const first = await check(p);
    const hash = (name: string) => first.data.assets.find((a) => a.name === name);
    expect(hash("github_issues")!.codeChanged).toBe(true);        // hash-1 is not its code's hash
    expect(hash("open_issues")!.codeChanged).toBe(false);         // never built
    const r = await cli(["validate", "--json"], { cwd: p.root });
    expect(r.json.next).toEqual([{ command: "croft preview github_issues", reason: "see what the changed code builds before running it" }]);
  });

  test("a code hash that changed only because croft.json's timezone did is no code change", async () => {
    const p = makeProject({ timezone: "UTC", files: { "assets/github_issues.ts": ISSUES_TS, "assets/open_issues.sql": "SELECT id, title FROM github_issues\n" } });
    const inLA = await resolveProject({ root: p.root, timezone: "America/Los_Angeles" });
    const hashIn = (name: string) => inLA.assets.find((a) => a.name === name)!.codeHash!;
    catalog(p, [
      { ...ISSUES_BUILT, codeHash: hashIn("github_issues") },
      { ...ISSUES_BUILT, asset: "open_issues", kind: "sql", codeHash: hashIn("open_issues"), columns: [col("id", "BIGINT"), col("title", "VARCHAR")] },
    ]);
    const r = await check(p);
    expect(r.data.assets.map((a) => [a.name, a.codeChanged])).toEqual([["github_issues", false], ["open_issues", false]]);
  });

  test("never opens the warehouse or creates anything: a file that is no database, and a locked one", async () => {
    const p = makeProject({
      files: { "assets/github_issues.ts": ISSUES_TS, "assets/open_issues.sql": "SELECT id, title FROM github_issues\n" },
    });
    catalog(p, [ISSUES_BUILT]);
    writeFileSync(p.database, "not a database");
    const before = readdirSync(p.root, { recursive: true }).map(String).filter((f) => !f.startsWith("node_modules")).sort();
    const t0 = performance.now();
    const r = await cli(["validate", "--json"], { cwd: p.root });
    expect(r.exit).toBe(0);
    expect(r.json.problems).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(10_000);
    expect(readdirSync(p.root, { recursive: true }).map(String).filter((f) => !f.startsWith("node_modules")).sort()).toEqual(before);

    // A fresh project: no runs.sqlite is created.
    const fresh = makeProject({ files: { "assets/github_issues.ts": ISSUES_TS } });
    expect((await cli(["validate", "--json"], { cwd: fresh.root })).exit).toBe(0);
    expect(existsSync(join(fresh.stateDir, "runs.sqlite"))).toBe(false);
  });

  test("an empty project points at the ingest templates", async () => {
    const p = makeProject();
    const r = await cli(["validate", "--json"], { cwd: p.root });
    expect(r.exit).toBe(0);
    expect(r.json.data).toEqual({ order: [], assets: [] });
    expect(r.json.next).toEqual([{ command: "croft docs ingest", reason: "assets/ has no assets yet; start from a template" }]);
  });

  test("human output: checked N assets, each problem with its fix or next step, then the counts (§4.2)", async () => {
    const p = makeProject({
      files: {
        "assets/github_issues.ts": ISSUES_TS,
        "assets/stripe_charges.ts": CHARGES_TS,
        "assets/open_issues.sql": "-- key: id\nSELECT id, creatd_at FROM github_issues\n",
        "assets/daily_revenue.sql": "SELECT sum(amount) AS revenue FROM stripe_charges\n",
      },
    });
    catalog(p, [ISSUES_BUILT]);
    // The registry shows validate's problems in its own layout (humanShowsProblems, requested of the registry).
    const commands: Command[] = COMMANDS.map((c) => (c.name !== "validate" ? c : {
      ...c, humanShowsProblems: true, load: async () => ({ ...(await c.load!()), humanShowsProblems: true }),
    }));
    const r = await cli(["validate"], { cwd: p.root, commands });
    expect(r.exit).toBe(2);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^checked 4 assets in \d+(\.\d+)? (ms|s)$/);
    expect(r.stdout).toContain([
      "error UNKNOWN_COLUMN  assets/open_issues.sql:2:12",
      "      Referenced column \"creatd_at\" not found in FROM clause.",
    ].join("\n"));
    expect(r.stdout).toContain("      fix: replace creatd_at with created_at on line 2");
    expect(r.stdout).toContain([
      "info  INPUT_NOT_BUILT  assets/daily_revenue.sql",
      "      columns of stripe_charges are unknown until it has run or been previewed; bind check skipped",
      "      next: croft preview stripe_charges",
    ].join("\n"));
    expect(lines.slice(-2)).toEqual(["1 error, 0 warnings, 1 info", "next: croft validate  # re-check after the edit"]);
    expect(r.stdout.match(/UNKNOWN_COLUMN/g)).toHaveLength(1);
  });

  test("human() on its own: a clean project, and --types", () => {
    const ctx = { startedAt: performance.now(), render: { color: false } } as never;
    const clean = validate.human!({ data: { order: ["a"], assets: [{ name: "a", kind: "sql", inputs: [], outputColumns: [], behavior: "replace", codeChanged: false }] }, problems: [], next: [] }, ctx);
    expect(clean).toMatch(/^checked 1 asset in \d+ ms\n0 errors, 0 warnings$/);
    const typed = validate.human!({ data: { order: [], assets: [], types: { status: "failed", errors: 2 } }, problems: [], next: [] }, ctx);
    expect(typed!.split("\n")[1]).toBe("types: 2 errors (tsc --noEmit)");
  });
});

describe("--types", () => {
  /** node_modules as bun install leaves it: .bin/tsc linked to typescript's, and Bun's types. */
  function withTypescript(p: TestProject): void {
    const nm = join(p.root, "node_modules");
    symlinkSync(join(PKG, "node_modules", "typescript"), join(nm, "typescript"));
    mkdirSync(join(nm, "@types"), { recursive: true });
    symlinkSync(join(PKG, "node_modules", "@types", "bun"), join(nm, "@types", "bun"));
    mkdirSync(join(nm, ".bin"), { recursive: true });
    symlinkSync(join("..", "typescript", "bin", "tsc"), join(nm, ".bin", "tsc"));
    writeFileSync(join(p.root, "tsconfig.json"), tsconfigJson());
  }

  test("the project's own tsc --noEmit: each type error a problem at its file and line", async () => {
    const p = makeProject({
      files: {
        "assets/typed.ts": `import { ingest } from "@zabaca/croft";\nconst n: number = "one";\nexport default ingest({ async *rows() { yield [{ n }]; } });\n`,
      },
    });
    withTypescript(p);
    const r = await cli(["validate", "--types", "--json"], { cwd: p.root, env: { PATH: process.env.PATH } });
    expect(r.exit).toBe(2);
    expect(r.json.data.types).toEqual({ status: "failed", errors: 1 });
    expect(r.json.problems).toEqual([expect.objectContaining({
      code: "ASSET_INVALID", severity: "error", asset: "typed", file: "assets/typed.ts", line: 2, column: 7,
      message: expect.stringContaining("TS2322: Type 'string' is not assignable to type 'number'."),
    })]);

    writeFiles(p.root, { "assets/typed.ts": `import { ingest } from "@zabaca/croft";\nconst n: number = 1;\nexport default ingest({ async *rows() { yield [{ n }]; } });\n` });
    const ok = await cli(["validate", "--types", "--json"], { cwd: p.root });
    expect(ok.exit).toBe(0);
    expect(ok.json.data.types).toEqual({ status: "ok", errors: 0 });
  }, 60_000);

  test("no tsc in the project: an info problem and a skip, nothing installed", async () => {
    const p = makeProject({ files: { "assets/github_issues.ts": ISSUES_TS } });
    const r = await cli(["validate", "--types", "--json"], { cwd: p.root });
    expect(r.exit).toBe(0);
    expect(r.json.data.types).toEqual({ status: "skipped", errors: 0 });
    expect(r.json.problems).toEqual([expect.objectContaining({ severity: "info", message: expect.stringContaining("node_modules/.bin/tsc") })]);
    expect(existsSync(join(p.root, "node_modules", ".bin"))).toBe(false);
    // Without --types, no types field.
    expect((await cli(["validate", "--json"], { cwd: p.root })).json.data.types).toBeUndefined();
  });

  test("parseTsc: located and project-wide diagnostics, continuation lines", () => {
    expect(parseTsc([
      "assets/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "lib/b.ts(10,1): error TS2345: Argument of type 'X' is not assignable to parameter of type 'Y'.",
      "  Property 'z' is missing in type 'X'.",
      "error TS5083: Cannot read file '/x/tsconfig.json'.",
    ].join("\n"))).toEqual([
      { file: "assets/a.ts", line: 3, column: 7, severity: "error", code: "TS2322", message: "Type 'string' is not assignable to type 'number'." },
      { file: "lib/b.ts", line: 10, column: 1, severity: "error", code: "TS2345", message: "Argument of type 'X' is not assignable to parameter of type 'Y'.\nProperty 'z' is missing in type 'X'." },
      { severity: "error", code: "TS5083", message: "Cannot read file '/x/tsconfig.json'." },
    ]);
  });
});
