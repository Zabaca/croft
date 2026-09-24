import { afterAll, describe, expect, test } from "bun:test";
import { putCatalog } from "../../history/catalog.ts";
import { cleanup as cleanupChildren, spawnHolder } from "../../read/testkit.ts";
import { behaviorOf, capValue, checksOf, DESCRIBE_TIMING, durationWords, loadConfigs, staticSecrets, type AssetConfig } from "./describe.ts";
import {
  busyScenario, CHARGES_TS, cleanup, cli, ISSUES_CATALOG, ISSUES_SEED, ISSUES_TS, makeProject, NOW, OPEN_SQL, runsDb, seed, shape, STATE,
} from "./inspect-testkit.ts";

afterAll(async () => {
  cleanupChildren();
  await cleanup();
});

const ENV = { CROFT_NOW: NOW };

async function issues(files: Record<string, string> = {}, extra: string[] = []) {
  const p = makeProject({ files: { "assets/github_issues.ts": ISSUES_TS, "assets/open_issues.sql": OPEN_SQL, ...files } });
  await seed(p.database, [...ISSUES_SEED, ...extra]);
  return p;
}

/** An incremental transform with a lookup: teams is read in full with rows() on every run, never with newRows(). */
const LOOKUP_TS = `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["github_issues", "teams"], key: "issue_id", incremental: true,
  async *rows({ newRows, rows }) {
    const teams: string[] = [];
    for await (const t of rows<{ team: string }>("teams")) teams.push(t.team);
    for await (const i of newRows("github_issues")) yield { issue_id: i.id, team: teams[i.id % teams.length] };
  },
});
`;
const TEAMS_SEED = [
  `CREATE TABLE teams (team VARCHAR, team_name VARCHAR, _loaded_at TIMESTAMPTZ)`,
  `INSERT INTO teams VALUES ('a', 'Alpha', '2026-09-22 18:30:00+00'), ('b', 'Beta', '2026-09-22 18:30:00+00')`,
  `INSERT INTO _croft.assets VALUES ('teams', 'sql', 'replace', ['team'], 'hash-t', 'behavior-t', NULL, NULL, NULL,
     '2026-09-22 18:30:00+00', NULL, 2, '2026-09-22 18:30:00+00', '2026-09-22 18:30:00+00')`,
];

describe("croft describe --json", () => {
  test("golden: config, state, columns with JSON keys, checks, recent writes and 3 samples", async () => {
    const p = await issues();
    const r = await cli(["describe", "github_issues", "--json"], { cwd: p.root, env: ENV });
    expect(r.exit).toBe(0);
    expect(r.json).toMatchObject({ ok: true, command: "describe", problems: [] });
    const d = r.json.data;
    expect(Object.keys(d)).toEqual([
      "asset", "kind", "file", "description", "next", "behavior", "reads", "readBy", "rows", "columns", "inputsSeen",
      "builtWithCodeHash", "checks", "recentWrites", "recentRuns", "samples", "truncatedValues", "source",
    ]);
    // open_issues.sql selects from it.
    expect(d).toMatchObject({
      asset: "github_issues", kind: "ingest", file: "assets/github_issues.ts", description: "Issues of oven-sh/bun",
      next: { at: null, reason: "manual" }, reads: [], readBy: ["open_issues"], rows: 3, inputsSeen: {}, builtWithCodeHash: "hash-1",
      source: "warehouse", truncatedValues: 0, recentRuns: [],
    });
    expect(d.behavior).toEqual({
      words: "updates rows by id; fetches rows with updated_at after the saved position",
      write: "merge", key: ["id"],
      incremental: { kind: "cursor", field: "updated_at", cursorValue: "2026-09-22T10:00:00Z", cursorType: "timestamp", unit: null, lookback: null },
    });
    expect(d.columns.map((c: { name: string; type: string }) => `${c.name} ${c.type}`)).toEqual([
      "id BIGINT", "title VARCHAR", "state VARCHAR", "labels JSON", "user JSON", "updated_at TIMESTAMPTZ", "_loaded_at TIMESTAMPTZ",
    ]);
    const col = (n: string) => d.columns.find((c: { name: string }) => c.name === n);
    expect(col("user")).toEqual({
      name: "user", type: "JSON", pinned: false, pending: false, sourceName: "user", format: null,
      addedAt: "2026-09-22T10:00:00-07:00", jsonKeys: ["id", "login", "site_admin"], kinds: ["object"],
    });
    expect(col("labels").jsonKeys).toEqual(["color", "name"]);
    expect(col("id").jsonKeys).toBeNull();
    expect(d.checks).toEqual([
      { check: "unique(id)", blocking: true, implied: true },
      { check: "not_null(id)", blocking: true, implied: true },
      { check: "not_null(title)", blocking: true, implied: false },
      { check: "state IN ('open', 'closed')", blocking: true, implied: false },
    ]);
    expect(d.recentWrites).toEqual([
      { runId: "r_0922_1100_bbbb", at: "2026-09-22T11:00:00-07:00", mode: "merge", rowsIn: 2, added: 1, updated: 0, unchanged: 1, deleted: 0,
        cursorBefore: "2026-09-21T10:00:00Z", cursorAfter: "2026-09-22T10:00:00Z",
        schemaChanges: [{ kind: "add_column", column: "updated_at", type: "TIMESTAMPTZ" }] },
      { runId: "r_0922_1000_aaaa", at: "2026-09-22T10:00:00-07:00", mode: "merge", rowsIn: 2, added: 2, updated: 0, unchanged: 0, deleted: 0,
        cursorBefore: null, cursorAfter: "2026-09-21T10:00:00Z", schemaChanges: [] },
    ]);
    expect(d.samples).toHaveLength(3);
    expect(d.samples[0]).toEqual({
      id: 3, title: "Faster installs", state: "open", labels: null, user: { login: "jarred", id: 7 }, updated_at: "2026-09-22T03:00:00-07:00",
    });
    expect(shape(d.recentWrites)).toEqual([{
      runId: "string", at: "string", mode: "string", rowsIn: "number", added: "number", updated: "number", unchanged: "number",
      deleted: "number", cursorBefore: "string", cursorAfter: "string", schemaChanges: [{ kind: "string", column: "string", type: "string" }],
    }]);
  });

  test("recent runs come from runs.sqlite", async () => {
    const p = await issues();
    busyScenario(p.stateDir);
    const d = (await cli(["describe", "github_issues", "--json"], { cwd: p.root, env: ENV })).json.data;
    expect(d.recentRuns).toEqual([{ runId: "r_0922_1155_ok01", status: "ok", at: "2026-09-22T11:55:00-07:00", durationMs: 300_000, code: null }]);
    // The engine's words (catalog) win over croft's own summary.
    expect(d.behavior.words).toBe(ISSUES_CATALOG.behavior);
  });

  test("an SQL transform never built: header checks, behavior in words, how to build it", async () => {
    const p = await issues();
    const r = await cli(["describe", "open_issues", "--json"], { cwd: p.root, env: ENV });
    expect(r.exit).toBe(0);
    expect(r.json.data).toMatchObject({
      asset: "open_issues", kind: "sql", file: "assets/open_issues.sql", description: "Open issues with their author",
      next: { reason: "after inputs" }, rows: null, columns: [], samples: [], recentWrites: [], source: "warehouse",
      reads: ["github_issues"], readBy: [],
      // Never built: every row of its input is new to it.
      inputsSeen: { github_issues: { seenLoadedAt: null, inputLastLoadedAt: null, pendingRows: 3 } },
      behavior: { words: "rebuilt in full when an input or its SQL changes; rows matched by id", write: "replace", key: ["id"], incremental: null },
      checks: [
        { check: "unique(id)", blocking: true, implied: true }, { check: "not_null(id)", blocking: true, implied: true },
        { check: "not_null(author)", blocking: true, implied: false }, { check: "id > 0", blocking: false, implied: false },
      ],
    });
    expect(r.json.next).toEqual([{ command: "croft run open_issues", reason: "build the table" }]);
  });

  const TRIAGE_TS = `import { transform } from "@zabaca/croft";
export default transform({ inputs: ["github_issues"], key: "issue_id", incremental: true,
  async *rows({ newRows }) { for await (const i of newRows<{ id: number }>("github_issues")) yield { issue_id: i.id }; } });
`;

  test("inputs seen: the input rows after the transform's position, and the input's version it last read in full", async () => {
    const p = await issues({ "assets/issue_triage.ts": TRIAGE_TS }, [
      `INSERT INTO _croft.inputs (asset, input, seen_loaded_at, seen_key, input_last_loaded_at)
         VALUES ('open_issues', 'github_issues', '2026-09-22 17:30:00+00', NULL, '2026-09-22 17:30:00+00')`,
    ]);
    const d = (await cli(["describe", "open_issues", "--json"], { cwd: p.root, env: ENV })).json.data;
    expect(d).toMatchObject({ kind: "sql", reads: ["github_issues"], next: { reason: "after inputs" } });
    // inputLastLoadedAt is what staleness compares with (history/catalog.ts InputSeen), not the input's version now.
    expect(d.inputsSeen).toEqual({
      github_issues: { seenLoadedAt: "2026-09-22T10:30:00-07:00", inputLastLoadedAt: "2026-09-22T10:30:00-07:00", pendingRows: 1 },
    });
    const human = await cli(["describe", "open_issues"], { cwd: p.root, env: ENV });
    expect(human.stdout).toContain("Input      github_issues: 1 new row since 2026-09-22T10:30:00-07:00");
  });

  test("inputs seen: a composite position counts the rows of its own stamp that come after its key (§3e)", async () => {
    // Rows 1 and 2 share the stamp 17:00; the position is (17:00, id 1): row 2 and row 3 (18:00) are pending.
    const p = await issues({ "assets/issue_triage.ts": TRIAGE_TS }, [
      `INSERT INTO _croft.inputs (asset, input, seen_loaded_at, seen_key, input_last_loaded_at)
         VALUES ('issue_triage', 'github_issues', '2026-09-22 17:00:00+00', '["1"]', NULL)`,
    ]);
    const d = (await cli(["describe", "issue_triage", "--json"], { cwd: p.root, env: ENV })).json.data;
    expect(d).toMatchObject({ kind: "ts", reads: ["github_issues"], next: { reason: "after inputs" } });
    expect(d.inputsSeen).toEqual({
      github_issues: { seenLoadedAt: "2026-09-22T10:00:00-07:00", inputLastLoadedAt: null, pendingRows: 2 },
    });
    expect(d.behavior.words).toBe("processes only new input rows; updates rows by issue_id");
    // The position's own row is done: at (17:00, id 2) only row 3 is left.
    const later = await issues({ "assets/issue_triage.ts": TRIAGE_TS }, [
      `INSERT INTO _croft.inputs (asset, input, seen_loaded_at, seen_key, input_last_loaded_at)
         VALUES ('issue_triage', 'github_issues', '2026-09-22 17:00:00+00', '["2"]', NULL)`,
    ]);
    expect((await cli(["describe", "issue_triage", "--json"], { cwd: later.root, env: ENV })).json.data.inputsSeen.github_issues.pendingRows).toBe(1);
  });

  test("inputs seen: a lookup an incremental transform reads in full with rows() is read in full each run, with nothing pending", async () => {
    const p = await issues({ "assets/issue_triage.ts": LOOKUP_TS }, [
      ...TEAMS_SEED,
      `INSERT INTO _croft.inputs (asset, input, seen_loaded_at, seen_key, input_last_loaded_at) VALUES
         ('issue_triage', 'github_issues', '2026-09-22 17:00:00+00', '["2"]', '2026-09-22 18:00:00+00'),
         ('issue_triage', 'teams', NULL, NULL, '2026-09-22 18:30:00+00')`,
    ]);
    const d = (await cli(["describe", "issue_triage", "--json"], { cwd: p.root, env: ENV })).json.data;
    expect(d.reads).toEqual(["github_issues", "teams"]);
    expect(d.inputsSeen).toEqual({
      github_issues: { seenLoadedAt: "2026-09-22T10:00:00-07:00", inputLastLoadedAt: "2026-09-22T11:00:00-07:00", pendingRows: 1 },
      teams: { seenLoadedAt: null, inputLastLoadedAt: "2026-09-22T11:30:00-07:00", pendingRows: 0, readInFull: true },
    });
    const human = (await cli(["describe", "issue_triage"], { cwd: p.root, env: ENV })).stdout;
    expect(human).toContain("Input      github_issues: 1 new row since 2026-09-22T10:00:00-07:00");
    expect(human).toContain("Input      teams: read in full each run, last at 2026-09-22T11:30:00-07:00");
    expect(human).not.toContain("none read yet");
  });

  test("inputs seen: a lookup of an incremental transform never built is read in full each run; its newRows() input is all pending", async () => {
    const p = await issues({ "assets/issue_triage.ts": LOOKUP_TS }, TEAMS_SEED);
    const d = (await cli(["describe", "issue_triage", "--json"], { cwd: p.root, env: ENV })).json.data;
    expect(d.inputsSeen).toEqual({
      github_issues: { seenLoadedAt: null, inputLastLoadedAt: null, pendingRows: 3 },
      teams: { seenLoadedAt: null, inputLastLoadedAt: null, pendingRows: 0, readInFull: true },
    });
    const human = (await cli(["describe", "issue_triage"], { cwd: p.root, env: ENV })).stdout;
    expect(human).toContain("Input      github_issues: 3 rows, none read yet");
    expect(human).toContain("Input      teams: read in full each run, not read yet");
  });

  test("inputs seen: a lookup keeps nothing pending even with a position its older code saved with newRows()", async () => {
    const p = await issues({ "assets/issue_triage.ts": LOOKUP_TS }, [
      ...TEAMS_SEED,
      `INSERT INTO _croft.inputs (asset, input, seen_loaded_at, seen_key, input_last_loaded_at) VALUES
         ('issue_triage', 'teams', '2026-09-22 17:00:00+00', NULL, '2026-09-22 18:30:00+00')`,
    ]);
    const d = (await cli(["describe", "issue_triage", "--json"], { cwd: p.root, env: ENV })).json.data;
    expect(d.inputsSeen.teams).toEqual({ seenLoadedAt: "2026-09-22T10:00:00-07:00", inputLastLoadedAt: "2026-09-22T11:30:00-07:00", pendingRows: 0, readInFull: true });
  });

  test("inputs seen: when the code's newRows() reads cannot be told, every input counts (as the cost guard counts them)", async () => {
    // newRows handed to other code: the scan cannot tell which inputs it reads (project/ts-asset.ts detectNewRows).
    const p = await issues({ "assets/issue_triage.ts": LOOKUP_TS.replace('for await (const i of newRows("github_issues"))', "for await (const i of each(newRows))")
      .replace("export default", 'const each = (f: (n: string) => AsyncIterable<{ id: number }>) => f("github_issues");\nexport default') }, TEAMS_SEED);
    const d = (await cli(["describe", "issue_triage", "--json"], { cwd: p.root, env: ENV })).json.data;
    expect(d.inputsSeen).toEqual({
      github_issues: { seenLoadedAt: null, inputLastLoadedAt: null, pendingRows: 3 },
      teams: { seenLoadedAt: null, inputLastLoadedAt: null, pendingRows: 2 },
    });
  });

  test("a header key croft does not know is reported (project/sql-asset.ts parseSqlHeader)", async () => {
    const p = await issues({ "assets/open_issues.sql": OPEN_SQL.replace("-- check: not_null(author)", "-- chek: not_null(author)") });
    const r = await cli(["describe", "open_issues", "--json"], { cwd: p.root, env: ENV });
    expect(r.json.problems.map((x: { code: string }) => x.code)).toContain("HEADER_UNKNOWN_KEY");
    expect(r.json.data.checks.map((c: { check: string }) => c.check)).toEqual(["unique(id)", "not_null(id)", "id > 0"]);
  });

  test("an epoch cursor is shown with its instant; a lookback in words", async () => {
    const p = await issues({ "assets/stripe_charges.ts": CHARGES_TS }, [
      `CREATE TABLE stripe_charges (id VARCHAR, amount BIGINT, created BIGINT, _loaded_at TIMESTAMPTZ)`,
      `INSERT INTO stripe_charges VALUES ('ch_1', 500, 1758600000, '2026-09-22 18:00:00+00')`,
      `INSERT INTO _croft.assets VALUES ('stripe_charges', 'ingest', 'merge', ['id'], 'h2', 'b2', '1758600000', 'integer', 's',
         '2026-09-22 18:00:00+00', NULL, 1, '2026-09-22 18:00:00+00', '2026-09-22 18:00:00+00')`,
    ]);
    const r = await cli(["describe", "stripe_charges", "--json"], { cwd: p.root, env: ENV });
    expect(r.json.data.behavior).toEqual({
      words: "updates rows by id; fetches rows with created after the saved position, re-reading the last 30 days (created is epoch seconds)",
      write: "merge", key: ["id"],
      incremental: { kind: "cursor", field: "created", cursorValue: "1758600000", cursorType: "integer", unit: "s", lookback: "30 days" },
    });
    const human = await cli(["describe", "stripe_charges"], { cwd: p.root, env: ENV });
    expect(human.stdout).toContain("Cursor     created = 1758600000 (2025-09-22T21:00:00-07:00)");
  });

  test("an asset whose file is gone is described from the warehouse; ORPHAN_TABLE says so, and next[] never deletes (§4.3)", async () => {
    const p = await issues();
    const db = runsDb(p.stateDir);
    putCatalog(db, ISSUES_CATALOG);
    db.close();
    await Bun.write(`${p.root}/assets/github_issues.ts`, "");
    const { unlinkSync } = await import("node:fs");
    unlinkSync(`${p.root}/assets/github_issues.ts`);
    const r = await cli(["describe", "github_issues", "--json"], { cwd: p.root, env: ENV });
    // open_issues.sql still reads it.
    expect(r.json.data).toMatchObject({ file: null, kind: "ingest", rows: 3, next: { reason: "none" }, readBy: ["open_issues"] });
    // A destructive command never appears in next (§4.3); the orphan is a warning with a manual, human fix.
    expect(r.json.next.map((n: { command: string }) => n.command).join("\n")).not.toMatch(/\bdelete\b/);
    expect(r.exit).toBe(0);
    expect(r.json.problems).toEqual([expect.objectContaining({
      severity: "warning", code: "ORPHAN_TABLE", asset: "github_issues",
      fix: expect.objectContaining({ kind: "manual", requiresHuman: true }),
    })]);
    expect(r.json.problems[0].message).toContain("assets/github_issues.ts");
  });

  test("sample values are redacted, then cut to 80 characters", async () => {
    const pin = `import { ingest } from "@zabaca/croft";\nexport default ingest({ secrets: ["PIN"], async *rows() {} });\n`;
    const p = await issues({ "assets/pins.ts": pin, ".env": "PIN=abcdefgh\n" }, [
      `CREATE TABLE notes (id INTEGER, body VARCHAR, _loaded_at TIMESTAMPTZ)`,
      `INSERT INTO notes VALUES (1, repeat('x', 76) || 'abcdefgh', now()), (2, 'the pin abcdefgh', now())`,
      `INSERT INTO _croft.assets VALUES ('notes', 'ingest', 'replace', [], NULL, NULL, NULL, NULL, NULL, now(), NULL, 2, now(), now())`,
    ]);
    const r = await cli(["describe", "notes", "--json"], { cwd: p.root, env: ENV });
    const bodies = r.json.data.samples.map((s: { body: string }) => s.body).sort();
    expect(bodies).toEqual(["the pin [redacted:PIN]", `${"x".repeat(76)}[re…`]);
    expect(r.json.data.truncatedValues).toBe(1);
    expect(r.json.data.redactedValues).toBe(true);
    expect(r.stdout).not.toContain("abcdefgh");
    const full = await cli(["describe", "notes", "--json", "--full-values"], { cwd: p.root, env: ENV });
    expect(full.json.data.samples.map((s: { body: string }) => s.body).sort()[1]).toBe(`${"x".repeat(76)}[redacted:PIN]`);
  });

  test("an unknown asset is UNKNOWN_TABLE with a suggestion; a missing name is a usage error", async () => {
    const p = await issues();
    const r = await cli(["describe", "github_isues", "--json"], { cwd: p.root, env: ENV });
    expect(r.exit).toBe(2);
    expect(r.json.problems[0]).toMatchObject({ code: "UNKNOWN_TABLE", hint: "did you mean github_issues?", fix: { command: "croft describe github_issues" } });
    expect((await cli(["describe", "--json"], { cwd: p.root })).json.problems[0].code).toBe("USAGE_ERROR");
  });

  test("before the first run there is no warehouse: config only", async () => {
    const p = makeProject({ files: { "assets/github_issues.ts": ISSUES_TS } });
    const r = await cli(["describe", "github_issues", "--json"], { cwd: p.root, env: ENV });
    expect(r.exit).toBe(0);
    expect(r.json.data).toMatchObject({ source: "none", rows: null, columns: [], builtWithCodeHash: null, description: "Issues of oven-sh/bun" });
    expect(r.json.data.behavior.words).toBe("updates rows by id; fetches rows with updated_at after the saved position");
  });

  test("a broken asset file still describes its table, and reports why the file does not load", async () => {
    const p = await issues({ "assets/github_issues.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ key: 5 });\n` });
    const r = await cli(["describe", "github_issues", "--json"], { cwd: p.root, env: ENV });
    expect(r.exit).toBe(2);
    expect(r.json.data).toMatchObject({ rows: 3, kind: "ingest", source: "warehouse" });
    expect(r.json.problems.length).toBeGreaterThan(0);
  });
});

describe("croft describe: human output", () => {
  test("the §4.2 layout", async () => {
    const p = await issues();
    const r = await cli(["describe", "github_issues"], { cwd: p.root, env: ENV });
    expect(r.exit).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toBe("github_issues · ingest · assets/github_issues.ts · manual");
    expect(lines).toContain("About      Issues of oven-sh/bun");
    expect(lines).toContain("Behavior   updates rows by id; fetches rows with updated_at after the saved position");
    expect(lines).toContain("Cursor     updated_at = 2026-09-22T10:00:00Z");
    expect(lines).toContain("Table      3 rows · 6 columns · last write 2026-09-22T11:00:00-07:00 (+1 added, 0 updated)");
    expect(r.stdout).toContain("Columns    id BIGINT · title VARCHAR · state VARCHAR · labels JSON {color, name} · user JSON {id, login, site_admin} · updated_at TIMESTAMPTZ");
    expect(lines).toContain("Read by    open_issues");
    expect(lines).toContain("Checks     unique(id) · not_null(id) · not_null(title) · state IN ('open', 'closed')");
    expect(r.stdout).not.toContain("not enforced");
    expect(r.stdout).toMatch(/Sample {5}id +title +state/);
  });
});

describe("croft describe while a run holds the warehouse", () => {
  test("it falls back to the catalog mirror instead of waiting, and says so", async () => {
    const p = await issues();
    const db = runsDb(p.stateDir);
    putCatalog(db, ISSUES_CATALOG);
    putCatalog(db, {
      ...ISSUES_CATALOG, asset: "open_issues", kind: "sql", cursor: null, reads: ["github_issues"],
      inputsSeen: { github_issues: { seenLoadedAt: "2026-09-22T17:30:00.000000Z", seenKey: null, inputLastLoadedAt: "2026-09-22T17:30:00.000000Z" } },
    });
    db.close();
    const holder = spawnHolder(p.database, 20_000);
    await holder.waitFor("held");
    const saved = DESCRIBE_TIMING.busyWaitMs;
    DESCRIBE_TIMING.busyWaitMs = 300;
    try {
      const started = performance.now();
      const r = await cli(["describe", "github_issues", "--json"], { cwd: p.root, env: ENV });
      expect(performance.now() - started).toBeLessThan(3000);
      expect(r.exit).toBe(0);
      expect(r.json.data).toMatchObject({
        source: "catalog", rows: 18556, samples: [], recentWrites: [], builtWithCodeHash: "hash-1",
        behavior: { words: ISSUES_CATALOG.behavior, incremental: { cursorValue: "2026-09-22T17:58:03Z" } },
      });
      expect(typeof r.json.data.catalogRefreshedAt).toBe("string");
      expect(r.json.data.columns.find((c: { name: string }) => c.name === "user").jsonKeys).toEqual(["id", "login"]);
      expect(r.json.next[0].command).toBe("croft describe github_issues");
      expect(r.stderr).toContain("the warehouse is busy");
      const human = await cli(["describe", "github_issues"], { cwd: p.root, env: ENV });
      expect(human.stdout).toContain("from the catalog");
      // What a transform has seen comes from the catalog too; counting what is new needs the warehouse.
      const sql = await cli(["describe", "open_issues", "--json"], { cwd: p.root, env: ENV });
      expect(sql.json.data).toMatchObject({ source: "catalog", reads: ["github_issues"] });
      expect(sql.json.data.inputsSeen).toEqual({
        github_issues: { seenLoadedAt: "2026-09-22T10:30:00-07:00", inputLastLoadedAt: "2026-09-22T10:30:00-07:00", pendingRows: null },
      });
      expect((await cli(["describe", "open_issues"], { cwd: p.root, env: ENV })).stdout)
        .toContain("Input      github_issues: ? new rows since 2026-09-22T10:30:00-07:00");
    } finally {
      DESCRIBE_TIMING.busyWaitMs = saved;
      holder.proc.kill("SIGKILL");
    }
  });

  test("a lookup read in full each run has nothing pending, even from the catalog", async () => {
    const p = await issues({ "assets/issue_triage.ts": LOOKUP_TS }, TEAMS_SEED);
    const db = runsDb(p.stateDir);
    putCatalog(db, {
      ...ISSUES_CATALOG, asset: "issue_triage", kind: "ts", cursor: null, reads: ["github_issues", "teams"],
      inputsSeen: {
        github_issues: { seenLoadedAt: "2026-09-22T17:00:00.000000Z", seenKey: ["2"], inputLastLoadedAt: "2026-09-22T18:00:00.000000Z" },
        teams: { seenLoadedAt: null, seenKey: null, inputLastLoadedAt: "2026-09-22T18:30:00.000000Z" },
      },
    });
    db.close();
    const holder = spawnHolder(p.database, 20_000);
    await holder.waitFor("held");
    const saved = DESCRIBE_TIMING.busyWaitMs;
    DESCRIBE_TIMING.busyWaitMs = 300;
    try {
      const r = await cli(["describe", "issue_triage", "--json"], { cwd: p.root, env: ENV });
      expect(r.json.data.source).toBe("catalog");
      expect(r.json.data.inputsSeen).toEqual({
        github_issues: { seenLoadedAt: "2026-09-22T10:00:00-07:00", inputLastLoadedAt: "2026-09-22T11:00:00-07:00", pendingRows: null },
        teams: { seenLoadedAt: null, inputLastLoadedAt: "2026-09-22T11:30:00-07:00", pendingRows: 0, readInFull: true },
      });
      expect((await cli(["describe", "issue_triage"], { cwd: p.root, env: ENV })).stdout)
        .toContain("Input      teams: read in full each run, last at 2026-09-22T11:30:00-07:00");
    } finally {
      DESCRIBE_TIMING.busyWaitMs = saved;
      holder.proc.kill("SIGKILL");
    }
  });
});

describe("helpers", () => {
  test("loadConfigs reads an SQL asset's header with project/sql-asset.ts parseSqlHeader", async () => {
    const p = makeProject({
      files: { "assets/open_issues.sql": OPEN_SQL, "assets/daily.sql": "-- key: day, currency\n\n-- check: net <= gross\nSELECT 1\n-- check: ignored" },
    });
    const sql = (name: string) => ({ name, file: `assets/${name}.sql`, path: `${p.root}/assets/${name}.sql`, kind: "sql" as const });
    const configs = await loadConfigs(p.project, [sql("open_issues"), sql("daily")]);
    expect(configs.map(({ name, description, key, checks, warnings, write, loaded }) => ({ name, description, key, checks, warnings, write, loaded }))).toEqual([
      { name: "open_issues", description: "Open issues with their author", key: ["id"], checks: ["not_null(author)"], warnings: ["id > 0"], write: "replace", loaded: true },
      { name: "daily", description: null, key: ["day", "currency"], checks: ["net <= gross"], warnings: [], write: "replace", loaded: true },
    ]);
  });

  test("staticSecrets finds secrets lists and secret() calls", () => {
    expect(staticSecrets(`ingest({ secrets: ["A_KEY", 'B'], rows({ secret }) { secret("C"); secret(\`D\`); secret(name); } })`)).toEqual(["A_KEY", "B", "C", "D"]);
    expect(staticSecrets("nothing here")).toEqual([]);
  });

  test("durationWords", () => {
    expect(durationWords(30 * 86_400_000)).toBe("30 days");
    expect(durationWords(600_000)).toBe("10 minutes");
    expect(durationWords(1000)).toBe("1 second");
    expect(durationWords(1500)).toBe("1500 ms");
  });

  test("behaviorOf infers write modes the way the design describes them", () => {
    const base: AssetConfig = {
      name: "x", file: "assets/x.ts", path: "/x", kind: "ingest", description: null, schedule: null, key: [], write: null,
      incremental: { kind: "none" }, inputs: [], checks: [], warnings: [], secrets: [], loaded: true, problems: [],
    };
    expect(behaviorOf(base, null)).toMatchObject({ write: "replace", words: "replaces the table on each run; rows matched by row content" });
    expect(behaviorOf({ ...base, incremental: { kind: "files" } }, null)).toMatchObject({ write: "append", words: "loads only new and changed files; appends their rows" });
    expect(behaviorOf({ ...base, key: ["order_id"], incremental: { kind: "files" } }, null).words).toBe("loads only new and changed files; updates rows by order_id");
    expect(behaviorOf({ ...base, incremental: { kind: "cursor", field: "ts", lookbackMs: 0 } }, null).words).toBe("appends new rows; fetches rows with ts after the saved position");
    expect(behaviorOf({ ...base, kind: "ts", key: ["k"] }, null).words).toBe("recomputed in full when an input changes; rows matched by k");
    expect(behaviorOf({ ...base, kind: null }, null).write).toBeNull();
    expect(checksOf(null, [])).toEqual([]);
  });

  test("capValue redacts before cutting and turns long objects into cut JSON text", () => {
    const redact = (s: string) => s.replaceAll("secret", "[redacted:S]");
    expect(capValue("a secret", { full: false, redact })).toEqual({ value: "a [redacted:S]", cut: 0, redacted: true });
    expect(capValue({ k: "secret" }, { full: false, redact })).toEqual({ value: { k: "[redacted:S]" }, cut: 0, redacted: true });
    expect(capValue(12, { full: false, redact })).toEqual({ value: 12, cut: 0, redacted: false });
    const long = capValue({ k: "y".repeat(100) }, { full: false, redact, width: 10 });
    expect(long).toEqual({ value: `{"k":"yyy…`, cut: 1, redacted: false });
    expect(capValue("x".repeat(100), { full: true, redact }).cut).toBe(0);
  });
});
