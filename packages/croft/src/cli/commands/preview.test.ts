// croft preview, the command: flags, the envelope, and the human output (§4.2). The engine's behavior is tested in
// run/preview.test.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PreviewData } from "../../core/types.ts";
import { cleanup, cli, ISSUES_SEED, ISSUES_TS, makeProject, OPEN_SQL, seed } from "./inspect-testkit.ts";
import { formatPreview, parseRows } from "./preview.ts";

afterAll(async () => {
  await cleanup();
});

async function issues(files: Record<string, string> = {}) {
  const p = makeProject({ files: { "assets/github_issues.ts": ISSUES_TS, "assets/open_issues.sql": OPEN_SQL, ...files } });
  await seed(p.database, ISSUES_SEED);
  return p;
}

describe("croft preview: flags", () => {
  test("is registered with its spec", async () => {
    const p = makeProject({ files: { "assets/github_issues.ts": ISSUES_TS } });
    const help = await cli(["preview", "--help", "--json"], { cwd: p.root });
    expect(help.json.data.command).toMatchObject({ name: "preview", usage: "croft preview <asset…> [--rows N] [--rebuild]" });
  });

  test("--rows takes a whole number of rows, 1 or more", async () => {
    expect(parseRows(undefined)).toBe(1000);
    expect(parseRows("25")).toBe(25);
    for (const bad of ["0", "-3", "1.5", "lots", ""]) expect(() => parseRows(bad)).toThrow("--rows needs a whole number");
    const p = makeProject({ files: { "assets/github_issues.ts": ISSUES_TS } });
    const r = await cli(["preview", "github_issues", "--rows", "0", "--json"], { cwd: p.root });
    expect(r.exit).toBe(2);
    expect(r.json.problems[0]).toMatchObject({ code: "USAGE_ERROR" });
  });

  test("--rows is at most 100,000: a preview is a sample", async () => {
    expect(parseRows("100000")).toBe(100_000);
    for (const big of ["100001", "99999999999999999999999"]) expect(() => parseRows(big)).toThrow("--rows is at most 100,000");
    const p = makeProject({ files: { "assets/github_issues.ts": ISSUES_TS } });
    const r = await cli(["preview", "github_issues", "--rows", "1000000", "--json"], { cwd: p.root });
    expect(r.exit).toBe(2);
    expect(r.json.problems[0]).toMatchObject({ code: "USAGE_ERROR", message: `--rows is at most 100,000; got "1000000"` });
  });

  test("no asset, or a name that is not an asset, is a usage error; the did-you-mean fix previews", async () => {
    const p = makeProject({ files: { "assets/github_issues.ts": ISSUES_TS } });
    const none = await cli(["preview", "--json"], { cwd: p.root });
    expect(none.exit).toBe(2);
    expect(none.json.problems[0]).toMatchObject({ code: "USAGE_ERROR" });
    const typo = await cli(["preview", "github_isues", "--json"], { cwd: p.root });
    expect(typo.exit).toBe(2);
    expect(typo.json.problems[0]).toMatchObject({ code: "USAGE_ERROR", fix: { kind: "command", command: "croft preview github_issues" } });
  });
});

describe("croft preview: the result", () => {
  test("--json: PreviewData, with Explore and Apply as next steps; nothing real changes", async () => {
    const p = await issues();
    const before = { mtime: statSync(p.database).mtimeMs, size: statSync(p.database).size };
    const r = await cli(["preview", "open_issues", "--json"], { cwd: p.root });
    expect(r.exit).toBe(0);
    expect(r.json).toMatchObject({ ok: true, command: "preview", problems: [] });
    const d = r.json.data as PreviewData;
    expect(Object.keys(d).sort()).toEqual(["assets", "inputsSnapshotAt", "partial", "rebuild", "rowCap"]);
    expect(d.assets).toHaveLength(1);
    expect(Object.keys(d.assets[0]!).sort()).toEqual([
      "asset", "capped", "checks", "columns", "diff", "downstream", "durationMs", "kind", "liveRows", "partial", "reason", "rows", "sample", "status",
    ]);
    expect(d.assets[0]).toMatchObject({
      asset: "open_issues", kind: "sql", status: "ok", rows: 2, liveRows: null, partial: false,
      diff: { by: ["id"], added: 2, removed: 0, changed: 0, unchanged: 0 },
    });
    expect(d.assets[0]!.checks.map((c) => c.check)).toEqual(["unique(id)", "not_null(id)", "not_null(author)", "id > 0"]);
    expect(d.assets[0]!.sample).toEqual([{ id: 1, title: "Crash on Windows", author: "jarred" }, { id: 3, title: "Faster installs", author: "jarred" }]);
    expect(r.json.next).toEqual([
      { command: `croft query --preview "from open_issues"`, reason: expect.any(String) },
      { command: "croft run open_issues", reason: expect.any(String) },
    ]);
    // The preview database holds the build; the warehouse file was only read.
    expect(existsSync(join(p.stateDir, "preview.duckdb"))).toBe(true);
    expect({ mtime: statSync(p.database).mtimeMs, size: statSync(p.database).size }).toEqual(before);
  });

  test("human output: the preview line, the asset with its diff, columns, checks and sample, then Explore and Apply", async () => {
    const p = await issues();
    const r = await cli(["preview", "open_issues"], { cwd: p.root });
    expect(r.exit).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("Preview: your real tables are not changed.");
    expect(lines[1]).toMatch(/^open_issues\s+2 rows \(new table\)\s+\+2 added · 0 removed · 0 changed \(by key id\)$/);
    expect(lines).toContain("  checks      ok unique(id) · ok not_null(id) · ok not_null(author) · ok id > 0");
    expect(lines.some((l) => /^ {2}sample {6}id {2}title {12,}author$/.test(l))).toBe(true);
    expect(lines.slice(-2)).toEqual([`Explore: croft query --preview "from open_issues"`, "Apply:   croft run open_issues"]);
    // Explore and Apply are not printed twice as next lines.
    expect(r.stdout).not.toContain("next: croft query --preview");
  });

  test("human output of failing checks: fail for a check, warn for a warning; exit 3 and no Apply", async () => {
    const p = await issues({ "assets/open_issues.sql": `-- key: id
-- check: author <> 'jarred' OR id = 1
-- warn: id > 1
SELECT id, title, "user"->>'login' AS author FROM github_issues WHERE state = 'open'
` });
    const r = await cli(["preview", "open_issues"], { cwd: p.root });
    expect(r.exit).toBe(3);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[1]).toEndWith(" · a real run would fail: CHECK_FAILED");
    expect(lines).toContain("  checks      ok unique(id) · ok not_null(id) · fail author <> 'jarred' OR id = 1: 1 row · warn id > 1: 1 row");
    expect(r.stdout).toContain(`Explore: croft query --preview "from open_issues"`);
    expect(r.stdout).not.toContain("Apply:");
    expect(r.stdout).toContain("next: croft preview open_issues");
  });
});

describe("croft preview: redaction", () => {
  test("an asset's error in data is redacted like problems[]: every .env value, declared or not", async () => {
    const p = makeProject({ files: {
      ".env": "REGION=Opensesame\n",
      "assets/broken.ts": `import { ingest } from "@zabaca/croft";
export default ingest({ key: "id", async *rows() { throw new Error("no route to Opensesame"); } });
`,
    } });
    const r = await cli(["preview", "broken", "--json"], { cwd: p.root });
    expect(r.exit).toBe(1);
    const a = (r.json.data as PreviewData).assets[0]!;
    expect(a).toMatchObject({ asset: "broken", status: "failed", error: { code: "ASSET_CODE_ERROR" } });
    expect(a.error!.message).toContain("[redacted:REGION]");
    expect(a.reason).toContain("[redacted:REGION]");
    expect(r.stdout).not.toContain("Opensesame");
    const human = await cli(["preview", "broken"], { cwd: p.root });
    expect(human.stdout).toContain("[redacted:REGION]");
    expect(human.stdout + human.stderr).not.toContain("Opensesame");
  });
});

describe("formatPreview", () => {
  test("an ingest preview (§4.2): the saved position, what was fetched, the diff and what is downstream", () => {
    const text = formatPreview({
      assets: [{
        asset: "github_issues", kind: "ingest", status: "ok", reason: "fetched from the saved position; stopped at --rows 1000", rows: 1000, liveRows: 18_556,
        partial: true, capped: true, requests: 10, since: "2026-09-22T17:58:03Z",
        diff: { by: ["id"], added: 788, removed: 0, changed: 212, unchanged: 0 },
        columns: [{ column: "milestone", change: "added", type: "JSON", note: "new" }, { column: "closed_at", change: "added", type: "TIMESTAMPTZ", note: "no values yet; typed from its name" }],
        checks: [{ check: "unique(id)", ok: true }, { check: "not_null(title)", ok: true }], sample: [], downstream: ["open_issues", "issue_triage"], durationMs: 3400,
      }],
      partial: true, inputsSnapshotAt: null, rebuild: false, rowCap: 1000,
    }, { apply: "croft run github_issues" });
    expect(text.split("\n")).toEqual([
      "Preview: nothing is saved and the saved position (since 2026-09-22T17:58:03Z) does not move.",
      "github_issues fetched 1,000 rows (10 requests, 3.4 s, stopped at --rows 1,000)",
      "  columns     + milestone JSON (new) · + closed_at TIMESTAMPTZ (no values yet; typed from its name)",
      "  checks      ok unique(id) · ok not_null(title)",
      "  diff        212 would update, 788 would add (by key id)",
      "  note        fetched from the saved position; stopped at --rows 1000",
      "  downstream  open_issues, issue_triage would update (not built in an ingest preview)",
      "Apply:   croft run github_issues",
    ]);
  });

  test("partial and --rebuild diffs, failures and skips", () => {
    const base = { kind: "ts" as const, columns: [], checks: [], sample: [], downstream: [], durationMs: 5, capped: false };
    const text = formatPreview({
      assets: [
        { ...base, asset: "issue_triage", status: "ok", reason: "r", rows: 37, liveRows: 812, partial: true, capped: true, diff: { by: ["id"], added: 30, removed: 0, changed: 7, unchanged: 963 } },
        { ...base, asset: "daily", kind: "sql", status: "ok", reason: "r", rows: 812, liveRows: 812, partial: false, diff: { by: [], added: 1, removed: 1, changed: 0, unchanged: 811 } },
        { ...base, asset: "broken", status: "failed", reason: "x", rows: null, liveRows: null, partial: false, diff: null,
          error: { severity: "error", code: "ASSET_CODE_ERROR", message: "broken failed in its own code: TypeError: x is undefined", hint: "fix it", docs: "croft docs ASSET_CODE_ERROR" } },
        { ...base, asset: "later", status: "skipped", reason: "input broken failed in this preview", rows: null, liveRows: null, partial: false, diff: null },
      ],
      partial: true, inputsSnapshotAt: null, rebuild: true, rowCap: 1000,
    }, { logs: ".croft/preview" });
    const lines = text.split("\n");
    expect(lines).toContain("issue_triage  37 rows built (live 812)   of 1,000 keys touched, 37 differ: +30 added · 0 removed · 7 changed (by key id)");
    expect(lines).toContain("daily         812 rows (live 812)   2 of 812 rows differ: +1 added · 1 removed · 0 changed (by whole rows)");
    expect(lines).toContain("broken        failed: ASSET_CODE_ERROR: broken failed in its own code: TypeError: x is undefined");
    expect(lines).toContain("  log         .croft/preview/logs/broken.log");
    expect(lines).toContain("later         skipped: input broken failed in this preview");
  });
});
