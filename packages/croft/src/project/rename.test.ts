import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { currentIdentity } from "../core/proc.ts";
import { closeAllWarehouses, openWarehouse } from "../db/warehouse.ts";
import { type CatalogAsset, getCatalog, putCatalog } from "../history/catalog.ts";
import { listLeases, tryAcquire } from "../history/leases.ts";
import { RunsDb } from "../history/runs-db.ts";
import { executeRun } from "../run/runner.ts";
import { cleanupProjects, cli, cliEnv, keysetIssues, makeProject as makeRunProject, mockApi, type MockApi, writeFiles } from "../run/testkit.ts";
import { listTrash, trashTable } from "../safety/trash.ts";
import { DEAD, cleanup, ISSUES_CATALOG, ISSUES_SEED, ISSUES_TS, makeProject, NOW, OPEN_SQL, runsDb, seed, type TestProject } from "../cli/commands/inspect-testkit.ts";
import { ProjectEnv } from "./env.ts";
import {
  applyRename, findReferences, findRenamed, jsLiterals, planRename, readJournal, RENAME_JOURNAL, renamedProblem, unfinishedRename,
} from "./rename.ts";
import { resolveProject } from "./resolve.ts";
import { loadProject } from "./root.ts";
import { tsFingerprint } from "./ts-asset.ts";

afterEach(async () => {
  await closeAllWarehouses();
});
afterAll(async () => {
  await cleanup();
  cleanupProjects();
});

const CLOCK = () => new Date(NOW);

const TRIAGE_TS = `import { transform } from "@zabaca/croft";
import { label } from "../lib/labels.ts";
export default transform({
  inputs: ["github_issues"],
  key: "id",
  incremental: true,
  checks: ["id IN (SELECT id FROM github_issues)"],
  async *rows({ newRows }) {
    // every github_issues row gets a label (a comment, not a reference)
    for await (const i of newRows("github_issues")) yield { id: i.id, label: label(i) };
  },
});
`;

const CLOSED_SQL = `-- description: closed github_issues (prose, not a reference)
-- check: id IN (SELECT id FROM github_issues)
SELECT i.id, i.title
FROM github_issues AS i -- the ingest
JOIN github_issues_labels AS l ON l.id = i.id
WHERE i.state = 'closed' AND l.name <> 'github_issues'
`;

const LABELS_TS = `export async function openCount(ctx: { query(sql: string): Promise<unknown> }) {
  return ctx.query(\`
    SELECT count(*) AS n
    FROM github_issues
    WHERE state = 'open'\`);
}
export const label = (i: { title: string }) => (i.title.length > 10 ? "long" : "short");
`;

const FILES: Record<string, string> = {
  "assets/gh/github_issues.ts": ISSUES_TS,
  "assets/open_issues.sql": OPEN_SQL,
  "assets/closed.sql": CLOSED_SQL,
  "assets/triage.ts": TRIAGE_TS,
  "lib/labels.ts": LABELS_TS,
};

const SEED: string[] = [
  ...ISSUES_SEED,
  `INSERT INTO _croft.files VALUES ('github_issues', 'x.json', 1, '2026-09-22 17:00:00+00', NULL, NULL, '2026-09-22 17:00:00+00')`,
  `INSERT INTO _croft.inputs VALUES ('triage', 'github_issues', '2026-09-22 18:00:00+00', '3', '2026-09-22 18:00:00+00'),
     ('open_issues', 'github_issues', '2026-09-22 18:00:00+00', NULL, '2026-09-22 18:00:00+00')`,
  `CREATE TABLE open_issues (id BIGINT, title VARCHAR, author VARCHAR, _loaded_at TIMESTAMPTZ)`,
  `INSERT INTO open_issues VALUES (1, 'Crash on Windows', 'jarred', '2026-09-22 18:00:00+00')`,
  `INSERT INTO _croft.assets VALUES ('open_issues', 'sql', 'replace', ['id'], 'hash-o', 'behavior-o', NULL, NULL, NULL,
     '2026-09-22 18:00:00+00', NULL, 1, '2026-09-22 18:00:00+00', '2026-09-22 18:00:00+00')`,
];

const OPEN_CATALOG: CatalogAsset = {
  ...ISSUES_CATALOG, asset: "open_issues", kind: "sql", write: "replace", rows: 1, columns: [], cursor: null, codeHash: "hash-o",
  reads: ["github_issues"],
  inputsSeen: { github_issues: { seenLoadedAt: "2026-09-22T18:00:00.000000Z", seenKey: null, inputLastLoadedAt: "2026-09-22T18:00:00.000000Z" } },
};

/** A built project: github_issues (an ingest in assets/gh/) with its table, _croft state, a run, an approval, a
 *  trashed version and a preview; open_issues, closed and triage read it; lib/labels.ts queries it. */
async function built(o: { trash?: boolean; preview?: boolean } = {}): Promise<TestProject> {
  const p = makeProject({ files: FILES });
  await seed(p.database, SEED);
  const db = runsDb(p.stateDir, CLOCK);
  try {
    putCatalog(db, ISSUES_CATALOG);
    putCatalog(db, OPEN_CATALOG);
    db.approveCode("github_issues", "hash-1");
    db.putScheduleState("github_issues", { lastFireAt: "2026-09-22T17:00:00.000Z" });
    const r = db.createRun({ id: "r_0922_1000_aaaa", trigger: "manual", human: true, argv: ["run", "github_issues"], identity: DEAD });
    db.startStep({ runId: r.id, asset: "github_issues", attempt: 1, reason: "requested", codeHash: "hash-1" });
    db.finishStep(r.id, "github_issues", 1, { status: "ok", rows: { in: 3, added: 3, updated: 0 } });
    db.finishRun(r.id, "succeeded");
  } finally {
    db.close();
  }
  if (o.trash !== false) {
    const w = openWarehouse({ path: p.database, mode: "read_write", timezone: p.project.timezone, root: p.root, stateDir: p.stateDir });
    await trashTable(w, "github_issues", "run --allow-shrink (r_0922_1000_aaaa)", { runId: "r_0922_1000_aaaa", now: new Date("2026-09-21T00:00:00Z") });
    await closeAllWarehouses();
  }
  if (o.preview !== false) {
    const dir = join(p.stateDir, "preview");
    mkdirSync(dir, { recursive: true });
    const pr = RunsDb.open(dir);
    putCatalog(pr, ISSUES_CATALOG, "preview");
    pr.close();
    await seed(join(p.stateDir, "preview.duckdb"), [
      "CREATE TABLE github_issues (id BIGINT)", "CREATE SCHEMA live", "CREATE VIEW live.github_issues AS SELECT 1 AS id",
    ]);
  }
  return p;
}

/** Rows of a query on a DuckDB file, through a private read-only instance (croft's are closed first). */
async function q(database: string, sql: string): Promise<unknown[][]> {
  await closeAllWarehouses();
  const db = await DuckDBInstance.create(database, { access_mode: "READ_ONLY" });
  const c = await db.connect();
  try {
    return (await c.runAndReadAll(sql)).getRowsJS();
  } finally {
    c.disconnectSync();
    db.closeSync();
  }
}

async function tables(database: string): Promise<string[]> {
  return (await q(database, "SELECT schema_name || '.' || table_name FROM duckdb_tables() ORDER BY 1")).map((r) => String(r[0]));
}

async function refused(p: Promise<unknown>): Promise<CroftError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
  throw new Error("expected a CroftError");
}

const renameIt = async (p: TestProject, from: string, to: string, o: Parameters<typeof applyRename>[2] = {}) =>
  applyRename(p.root, await planRename(p.root, from, to), { now: CLOCK, ...o });

// ---------------------------------------------------------------------------------------------------------

describe("planRename refuses what cannot happen, with the fix", () => {
  test("the same name, an unknown asset (did you mean), a bad or reserved new name", async () => {
    const p = await built({ trash: false, preview: false });
    expect((await refused(planRename(p.root, "github_issues", "github_issues"))).code).toBe("USAGE_ERROR");

    const unknown = await refused(planRename(p.root, "github_isues", "issues"));
    expect(unknown.code).toBe("USAGE_ERROR");
    expect(unknown.problem.message).toBe("there is no asset or table named github_isues");
    expect(unknown.problem.fix).toEqual({ kind: "command", description: "rename github_issues", command: "croft rename github_issues issues" });

    const invalid = await refused(planRename(p.root, "github_issues", "GitHub-Issues"));
    expect(invalid.code).toBe("NAME_INVALID");
    expect(invalid.problem.fix).toMatchObject({ kind: "command", command: "croft rename github_issues git_hub_issues" });

    const reserved = await refused(planRename(p.root, "github_issues", "order"));
    expect(reserved.code).toBe("NAME_RESERVED");
    expect(reserved.problem.fix).toMatchObject({ kind: "command", command: "croft rename github_issues orders" });
    expect((await refused(planRename(p.root, "github_issues", "_hidden"))).code).toBe("NAME_RESERVED");
    expect((await refused(planRename(p.root, "github_issues", "croft"))).code).toBe("NAME_RESERVED");
  });

  test("a new name that has a file, or names a table, is NAME_CONFLICT; nothing changes", async () => {
    const p = await built({ trash: false, preview: false });
    const file = await refused(planRename(p.root, "github_issues", "open_issues"));
    expect(file.code).toBe("NAME_CONFLICT");
    expect(file.problem.message).toContain("open_issues already names a table (1 row) built from assets/open_issues.sql");

    const db = runsDb(p.stateDir);
    putCatalog(db, { ...ISSUES_CATALOG, asset: "old_orders", rows: 120, columns: [], cursor: null });
    db.close();
    const orphan = await refused(planRename(p.root, "github_issues", "old_orders"));
    expect(orphan.code).toBe("NAME_CONFLICT");
    expect(orphan.problem.message).toContain("whose asset file is gone");
    expect(orphan.problem.fix).toMatchObject({ kind: "manual", requiresHuman: true });

    // A file of the new name that was never built.
    writeFiles(p.root, { "assets/other/issues.sql": "SELECT 1 AS x\n" });
    const taken = await refused(planRename(p.root, "github_issues", "issues"));
    expect(taken.code).toBe("NAME_CONFLICT");
    expect(taken.problem.message).toBe("assets/other/issues.sql already exists; a rename never replaces another asset's file");
    expect(existsSync(join(p.root, "assets/gh/github_issues.ts"))).toBe(true);
  });

  test("a rename that did not finish must be finished first", async () => {
    const p = await built({ trash: false, preview: false });
    writeFileSync(join(p.stateDir, RENAME_JOURNAL), JSON.stringify({
      from: "a", to: "b", fileFrom: "assets/a.ts", fileTo: "assets/b.ts", mode: "file", startedAt: "2026-09-22T18:00:00.000Z", runId: "r_0922_1100_zzzz",
    }));
    const e = await refused(planRename(p.root, "github_issues", "issues"));
    expect(e.code).toBe("USAGE_ERROR");
    expect(e.problem.fix).toEqual({ kind: "command", description: "finish renaming a to b", command: "croft rename a b" });
  });

  test("a table without a file needs the asset that takes it over, of the same kind", async () => {
    const p = await built({ trash: false, preview: false });
    renameSync(join(p.root, "assets/gh/github_issues.ts"), join(p.root, "assets/gh/gone.txt"));
    const nowhere = await refused(planRename(p.root, "github_issues", "issues"));
    expect(nowhere.code).toBe("USAGE_ERROR");
    expect(nowhere.problem.message).toContain("github_issues has no asset file, and there is no asset issues to take over its table");

    writeFiles(p.root, { "assets/issues.sql": "SELECT 1 AS id\n" });
    const kind = await refused(planRename(p.root, "github_issues", "issues"));
    expect(kind.code).toBe("USAGE_ERROR");
    expect(kind.problem.message).toBe("github_issues was built by an ingest, and assets/issues.sql is an SQL transform: it cannot take over that table");
  });
});

describe("references to update, with file:line (croft never edits them)", () => {
  test("SQL FROM/JOIN and check lines, TS inputs, rows()/newRows(), checks and SQL strings, lib/; no comments, prose or longer names", async () => {
    const p = await built({ trash: false, preview: false });
    const plan = await planRename(p.root, "github_issues", "issues");
    expect(plan).toMatchObject({
      from: "github_issues", to: "issues", mode: "file", fileFrom: "assets/gh/github_issues.ts", fileTo: "assets/gh/issues.ts", hasTable: true, rows: 18_556,
    });
    expect(plan.references.map((r) => `${r.file}:${r.line} ${r.kind}`)).toEqual([
      "assets/closed.sql:2 check",
      "assets/closed.sql:4 sql",
      "assets/open_issues.sql:6 sql",
      "assets/triage.ts:4 ts_input",
      "assets/triage.ts:7 check",
      "assets/triage.ts:10 ts_input",
      "lib/labels.ts:4 sql",
    ]);
    expect(plan.references[2]!.text).toBe(`SELECT id, title, "user"->>'login' AS author FROM github_issues WHERE state = 'open'`);
    expect(plan.references[5]!.text).toBe(`for await (const i of newRows("github_issues")) yield { id: i.id, label: label(i) };`);
    // The asset files are unchanged.
    expect(readFileSync(join(p.root, "assets/triage.ts"), "utf8")).toBe(TRIAGE_TS);
  });

  test("the renamed file's own references are listed under its new path; quoted and upper-case SQL names count; imports", async () => {
    const p = makeProject({
      files: {
        "assets/sales.ts": `import { ingest } from "@zabaca/croft";
export default ingest({
  key: "id",
  async *rows({ query }) {
    const [last] = await query('SELECT max(id) AS m FROM "sales"');
    yield [];
  },
});
`,
        "assets/report.sql": "SELECT * FROM SALES\nUNION ALL SELECT * FROM main.\"sales\"\n",
        "lib/util.ts": `export { default } from "../assets/sales.ts";\nexport const t = 'sales_2024';\n`,
      },
    });
    const refs = await findReferences(p.project, "sales", { from: "assets/sales.ts", to: "assets/revenue.ts" });
    expect(refs.map((r) => `${r.file}:${r.line} ${r.kind}`)).toEqual([
      "assets/report.sql:1 sql", "assets/report.sql:2 sql", "assets/revenue.ts:5 sql", "lib/util.ts:1 import",
    ]);
  });

  test("jsLiterals: template chunks around ${…}, escapes, comments and regexes", () => {
    const code = "const a = `SELECT ${x} FROM t`; // 'no'\nconst b = \"it's\"; /* \"no\" */ const r = /a'b/g; f('c')";
    const { literals, blank } = jsLiterals(code);
    expect(literals.map((l) => l.text)).toEqual(["SELECT ", " FROM t", "it's", "c"]);
    expect(blank).not.toContain("no");
    expect(blank.length).toBe(code.length);
  });
});

describe("applyRename moves the file, table and state together", () => {
  test("file, table, _croft rows, runs.sqlite (catalog, readers, approval, schedule, steps), trash and preview", async () => {
    const p = await built();
    const result = await renameIt(p, "github_issues", "issues");
    expect(result).toMatchObject({
      from: "github_issues", to: "issues", mode: "file",
      file: { from: "assets/gh/github_issues.ts", to: "assets/gh/issues.ts", moved: true },
      table: { renamed: true, rows: 3 }, trash: { versions: 1, left: [], earlier: null }, preview: "cleared", problems: [],
    });
    expect(result.references).toHaveLength(7);

    // The file, with its extension, in its folder; its text as it was.
    expect(existsSync(join(p.root, "assets/gh/github_issues.ts"))).toBe(false);
    expect(readFileSync(join(p.root, "assets/gh/issues.ts"), "utf8")).toBe(ISSUES_TS);

    // The table and every _croft row.
    expect(await tables(p.database)).toContain("main.issues");
    expect(await tables(p.database)).not.toContain("main.github_issues");
    expect(await q(p.database, "SELECT count(*)::INTEGER FROM issues")).toEqual([[3]]);
    expect(await q(p.database, "SELECT name, cursor_value, code_hash FROM _croft.assets ORDER BY name")).toEqual([
      ["issues", "2026-09-22T10:00:00Z", "hash-1"], ["open_issues", null, "hash-o"],
    ]);
    for (const t of ["columns", "files", "writes"]) {
      expect(await q(p.database, `SELECT DISTINCT asset FROM _croft.${t} ORDER BY 1`)).toEqual([["issues"]]);
    }
    expect(await q(p.database, "SELECT asset, input, seen_key::VARCHAR FROM _croft.inputs ORDER BY asset")).toEqual([
      ["open_issues", "issues", null], ["triage", "issues", "3"],
    ]);

    // runs.sqlite: the mirror, what readers saw, the scheduler's approval and fires, the history; leases released.
    const db = runsDb(p.stateDir);
    try {
      expect(getCatalog(db, "github_issues")).toBeNull();
      expect(getCatalog(db, "issues")).toMatchObject({ asset: "issues", rows: 18_556, codeHash: "hash-1", cursor: ISSUES_CATALOG.cursor });
      expect(getCatalog(db, "open_issues")).toMatchObject({ reads: ["issues"], inputsSeen: { issues: OPEN_CATALOG.inputsSeen!.github_issues } });
      expect(db.approvedCode("issues")).toBe("hash-1");
      expect(db.scheduleState("issues")).toMatchObject({ lastFireAt: "2026-09-22T17:00:00.000Z", approvedCodeHash: "hash-1" });
      expect(db.scheduleState("github_issues")).toBeNull();
      expect(db.latestStep("issues")).toMatchObject({ runId: "r_0922_1000_aaaa", status: "ok", codeHash: "hash-1" });
      expect(db.latestStep("github_issues")).toBeNull();
      expect(listLeases(db)).toEqual([]);
      // The rename's own run record, so a run that meets its leases can name it.
      expect(db.getRun(result.runId)).toMatchObject({ status: "succeeded", argv: ["rename", "github_issues", "issues"], human: true });
    } finally {
      db.close();
    }

    // The trash: the folder, and the version renamed inside its file (restore reads main.<asset>).
    expect(existsSync(join(p.stateDir, "trash", "github_issues"))).toBe(false);
    const [version] = listTrash(p.stateDir, "issues");
    expect(version).toMatchObject({ asset: "issues", reason: "run --allow-shrink (r_0922_1000_aaaa)", rows: 3 });
    expect(await tables(version!.path)).toEqual(["_croft.assets", "_croft.columns", "_croft.files", "_croft.inputs", "_croft.trash", "_croft.writes", "main.issues"]);
    expect(await q(version!.path, "SELECT (SELECT name FROM _croft.assets), (SELECT asset FROM _croft.trash), (SELECT count(*)::INTEGER FROM issues)")).toEqual([["issues", "issues", 3]]);
    expect(JSON.parse(readFileSync(version!.path.replace(/\.duckdb$/, ".json"), "utf8"))).toMatchObject({ asset: "issues", path: version!.path });

    // The preview read github_issues: it is emptied.
    expect(existsSync(join(p.stateDir, "preview"))).toBe(false);
    expect(await tables(join(p.stateDir, "preview.duckdb"))).toEqual([]);

    // Nothing left to finish.
    expect(readJournal(p.stateDir)).toBeNull();
    expect(await findRenamed(p.root)).toEqual([]);
  });

  test("with readCopy on, the read copy is refreshed: it has the new name too", async () => {
    const p = await built({ trash: false, preview: false });
    writeFileSync(join(p.root, "croft.json"), JSON.stringify({ database: "warehouse.duckdb", timezone: "America/Los_Angeles", readCopy: true }));
    await renameIt(p, "github_issues", "issues");
    expect(await tables(join(p.root, "warehouse.read.duckdb"))).toContain("main.issues");
  });

  test("an unreadable journal (a stop while it was written, before anything moved) does not block a rename", async () => {
    const p = await built({ trash: false, preview: false });
    writeFileSync(join(p.stateDir, RENAME_JOURNAL), "{");
    expect((await renameIt(p, "github_issues", "issues")).mode).toBe("file");
    expect(readJournal(p.stateDir)).toBeNull();
  });

  test("an asset never built: only the file (and runs.sqlite); no warehouse file is created", async () => {
    const p = makeProject({ files: { "assets/draft.sql": "SELECT 1 AS id\n", "assets/uses.sql": "SELECT id FROM draft\n" } });
    const r = await renameIt(p, "draft", "final");
    expect(r).toMatchObject({ mode: "file", file: { moved: true, to: "assets/final.sql" }, table: { renamed: false, rows: null }, preview: "none" });
    expect(r.references.map((x) => `${x.file}:${x.line}`)).toEqual(["assets/uses.sql:1"]);
    expect(existsSync(join(p.root, "assets/final.sql"))).toBe(true);
    expect(existsSync(p.database)).toBe(false);
  });

  test("a file refused for its name (reserved) is renamed to fix it", async () => {
    const p = makeProject({ files: { "assets/order.sql": "SELECT 1 AS id\n" } });
    const r = await renameIt(p, "order", "orders");
    expect(r.file).toEqual({ from: "assets/order.sql", to: "assets/orders.sql", moved: true });
  });

  test("a run holding either name refuses at once (ASSET_BUSY, croft wait); nothing changes", async () => {
    const p = await built({ trash: false, preview: false });
    const db = runsDb(p.stateDir, CLOCK);
    db.createRun({ id: "r_0922_1200_live", trigger: "manual", human: true, argv: ["run", "github_issues"], identity: currentIdentity() });
    expect(tryAcquire(db, "github_issues", "r_0922_1200_live").ok).toBe(true);
    db.close();
    const e = await refused(renameIt(p, "github_issues", "issues"));
    expect(e.code).toBe("ASSET_BUSY");
    expect(e.problem.fix).toMatchObject({ kind: "command", command: "croft wait r_0922_1200_live" });
    expect(existsSync(join(p.root, "assets/gh/github_issues.ts"))).toBe(true);
    expect(await tables(p.database)).toContain("main.github_issues");
    expect(readJournal(p.stateDir)).toBeNull();
    const after = runsDb(p.stateDir);
    expect(after.listRuns().map((r) => r.id)).toEqual(["r_0922_1200_live", "r_0922_1000_aaaa"]);
    after.close();
  });

  test("a table of the new name that the catalog does not know is found under the lock: NAME_CONFLICT, nothing moves", async () => {
    const p = await built({ trash: false, preview: false });
    await seed(p.database, ["CREATE TABLE issues (x INTEGER)"]);
    const e = await refused(renameIt(p, "github_issues", "issues"));
    expect(e.code).toBe("NAME_CONFLICT");
    expect(existsSync(join(p.root, "assets/gh/github_issues.ts"))).toBe(true);
    expect(await q(p.database, "SELECT count(*)::INTEGER FROM github_issues")).toEqual([[3]]);
    expect(readJournal(p.stateDir)).toBeNull();
  });
});

describe("crash safety: every stop leaves a state that the same rename finishes", () => {
  test("a failure before the commit rolls everything back, the file included", async () => {
    const p = await built();
    const e = await refused(renameIt(p, "github_issues", "issues", {
      onPoint: (at) => {
        if (at === "rename_before_commit") throw new CroftError("INTERRUPTED", { message: "stopped", hint: "run it again" });
      },
    }));
    expect(e.code).toBe("INTERRUPTED");
    expect(existsSync(join(p.root, "assets/gh/github_issues.ts"))).toBe(true);
    expect(existsSync(join(p.root, "assets/gh/issues.ts"))).toBe(false);
    expect(await q(p.database, "SELECT name FROM _croft.assets ORDER BY 1")).toEqual([["github_issues"], ["open_issues"]]);
    expect(await tables(p.database)).toContain("main.github_issues");
    expect(readJournal(p.stateDir)).toBeNull();
    const db = runsDb(p.stateDir);
    expect(db.listRuns({ limit: 1 })[0]).toMatchObject({ status: "failed", argv: ["rename", "github_issues", "issues"] });
    expect(listLeases(db)).toEqual([]);
    db.close();
  });

  for (const at of ["rename_after_commit", "rename_after_state", "rename_after_trash"] as const) {
    test(`a stop at ${at}: the journal stays, findRenamed says so, and the same rename finishes`, async () => {
      const p = await built();
      const e = await refused(renameIt(p, "github_issues", "issues", {
        onPoint: (point) => {
          if (point === at) throw new Error("disk full");
        },
      }));
      expect(e.code).toBe("INTERNAL_ERROR");
      expect(e.problem.message).toBe("github_issues was renamed to issues in the warehouse, but the rename stopped before it finished: disk full");
      expect(e.problem.fix).toEqual({ kind: "command", description: "finish renaming github_issues to issues", command: "croft rename github_issues issues" });
      expect(readJournal(p.stateDir)).toMatchObject({ from: "github_issues", to: "issues" });
      const pending = await findRenamed(p.root);
      expect(pending).toEqual([{ from: "github_issues", to: "issues", file: "assets/gh/issues.ts", rows: 18_556, unfinished: true }]);
      expect(renamedProblem(pending[0]!)).toMatchObject({
        code: "ASSET_RENAMED", severity: "error", asset: "issues", fix: { kind: "command", command: "croft rename github_issues issues" },
      });
      // Another rename waits for this one.
      expect((await refused(planRename(p.root, "open_issues", "open"))).problem.fix).toMatchObject({ command: "croft rename github_issues issues" });

      const plan = await planRename(p.root, "github_issues", "issues");
      expect(plan.mode).toBe("resume");
      const done = await applyRename(p.root, plan, { now: CLOCK });
      expect(done).toMatchObject({ mode: "resume", table: { rows: 3 }, preview: "cleared" });
      expect(existsSync(join(p.root, "assets/gh/issues.ts"))).toBe(true);
      expect(await q(p.database, "SELECT name FROM _croft.assets ORDER BY 1")).toEqual([["issues"], ["open_issues"]]);
      const db = runsDb(p.stateDir);
      try {
        expect(getCatalog(db, "github_issues")).toBeNull();
        expect(getCatalog(db, "issues")?.rows).toBe(18_556);
        expect(db.approvedCode("issues")).toBe("hash-1");
      } finally {
        db.close();
      }
      expect(listTrash(p.stateDir, "issues")).toHaveLength(1);
      expect(existsSync(join(p.stateDir, "trash", "github_issues"))).toBe(false);
      expect(readJournal(p.stateDir)).toBeNull();
      expect(await findRenamed(p.root)).toEqual([]);
    });
  }

  test("unfinishedRename: the error croft delete and croft restore throw for either name while the rename is unfinished", async () => {
    const p = await built({ trash: false, preview: false });
    expect(unfinishedRename(p.stateDir, "github_issues")).toBeNull();
    writeFileSync(join(p.stateDir, RENAME_JOURNAL), JSON.stringify({
      from: "github_issues", to: "issues", fileFrom: "assets/gh/github_issues.ts", fileTo: "assets/gh/issues.ts", mode: "file",
      startedAt: "2026-09-22T18:59:00.000Z", runId: "r_0922_1159_dead",
    }));
    for (const name of ["github_issues", "issues"]) {
      expect(unfinishedRename(p.stateDir, name)?.problem).toEqual({
        ...renamedProblem({ from: "github_issues", to: "issues", file: "assets/gh/issues.ts", unfinished: true }), asset: name, effect: "nothing was changed",
      });
    }
    expect(unfinishedRename(p.stateDir, "open_issues")).toBeNull();
  });

  test("a stop before the commit that left the file moved (a crash): the same rename finishes it", async () => {
    const p = await built({ preview: false });
    // What SIGKILL between the file's move and the COMMIT leaves: the journal, the file moved, the warehouse as it was.
    writeFileSync(join(p.stateDir, RENAME_JOURNAL), JSON.stringify({
      from: "github_issues", to: "issues", fileFrom: "assets/gh/github_issues.ts", fileTo: "assets/gh/issues.ts", mode: "file",
      startedAt: "2026-09-22T18:59:00.000Z", runId: "r_0922_1159_dead",
    }));
    renameSync(join(p.root, "assets/gh/github_issues.ts"), join(p.root, "assets/gh/issues.ts"));
    const r = await renameIt(p, "github_issues", "issues");
    expect(r).toMatchObject({ mode: "resume", file: { moved: false }, table: { renamed: true, rows: 3 }, trash: { versions: 1 } });
    expect(await q(p.database, "SELECT count(*)::INTEGER FROM issues")).toEqual([[3]]);
  });
});

describe("the trash of an earlier asset of the new name is kept apart, never mixed with the renamed asset's (R41-09)", () => {
  /** An earlier asset named `issues`, deleted since (no file, no table, no catalog entry): its versions are still in
   *  the trash, the newest of them newer than github_issues's version, so `croft restore issues` would pick it. */
  async function earlierIssues(p: TestProject, at: readonly string[] = ["2026-09-22T12:00:00Z"]): Promise<string[]> {
    await closeAllWarehouses();
    await seed(p.database, [
      "CREATE TABLE issues (sku VARCHAR, title VARCHAR)",
      "INSERT INTO issues VALUES ('s0', 'old 0'), ('s1', 'old 1')",
      `INSERT INTO _croft.assets VALUES ('issues', 'ingest', 'replace', ['sku'], 'hash-old', 'behavior-old', NULL, NULL, NULL,
         '2026-09-20 18:00:00+00', NULL, 2, '2026-09-20 18:00:00+00', '2026-09-20 18:00:00+00')`,
    ]);
    const w = openWarehouse({ path: p.database, mode: "read_write", timezone: p.project.timezone, root: p.root, stateDir: p.stateDir });
    const paths: string[] = [];
    for (const t of at) paths.push((await trashTable(w, "issues", "delete (r_0922_0500_old1)", { runId: "r_0922_0500_old1", now: new Date(t) }))!.path);
    await closeAllWarehouses();
    await seed(p.database, ["DROP TABLE issues", "DELETE FROM _croft.assets WHERE name = 'issues'"]);
    return paths;
  }

  /** What `croft restore <asset>` would offer, newest first: its reason, rows and the table and _croft names inside. */
  async function offered(p: TestProject, asset: string): Promise<unknown[][]> {
    const out: unknown[][] = [];
    for (const v of listTrash(p.stateDir, asset)) {
      const [[inside, state, trash]] = await q(v.path, `SELECT (SELECT string_agg(table_name, ',') FROM duckdb_tables() WHERE schema_name = 'main'),
        (SELECT string_agg(DISTINCT name, ',') FROM _croft.assets), (SELECT asset FROM _croft.trash)`) as [[unknown, unknown, unknown]];
      const sidecar = JSON.parse(readFileSync(v.path.replace(/\.duckdb$/, ".json"), "utf8")) as { asset: string; path: string };
      expect(sidecar).toMatchObject({ asset, path: v.path });
      out.push([v.asset, v.reason, v.rows, inside, state, trash]);
    }
    return out;
  }

  const OWN = ["issues", "run --allow-shrink (r_0922_1000_aaaa)", 3, "issues", "issues", "issues"];
  /** An earlier version, kept apart as `name`: the name in the trash folder, the sidecar, the table and _croft. */
  const earlierAs = (name: string) => [name, "delete (r_0922_0500_old1)", 2, name, name, name];
  const EARLIER = earlierAs("issues_earlier");

  test("they move to <new>_earlier, renamed inside their files: restore offers only the renamed asset's versions as <new>", async () => {
    const p = await built({ preview: false });
    await earlierIssues(p);
    const plan = await planRename(p.root, "github_issues", "issues");
    expect(plan.earlier).toEqual({ name: "issues_earlier", versions: [expect.stringMatching(/^20260922T120000/)] });
    const r = await applyRename(p.root, plan, { now: CLOCK });
    expect(r.trash).toEqual({ versions: 1, left: [], earlier: { name: "issues_earlier", versions: 1, left: [] } });
    expect(await offered(p, "issues")).toEqual([OWN]);
    expect(await offered(p, "issues_earlier")).toEqual([EARLIER]);
    expect(existsSync(join(p.stateDir, "trash", "github_issues"))).toBe(false);
    // The earlier versions' lease was taken and released with the others.
    const db = runsDb(p.stateDir);
    expect(listLeases(db)).toEqual([]);
    db.close();
  });

  test("without versions of its own, the renamed asset has nothing to restore; <new>_earlier is taken, so _earlier_2", async () => {
    const p = await built({ trash: false, preview: false });
    await earlierIssues(p, ["2026-09-20T12:00:00Z", "2026-09-22T12:00:00Z"]);
    writeFiles(p.root, { "assets/issues_earlier.sql": "SELECT 1 AS id\n" });
    const r = await renameIt(p, "github_issues", "issues");
    expect(r.trash).toEqual({ versions: 0, left: [], earlier: { name: "issues_earlier_2", versions: 2, left: [] } });
    expect(listTrash(p.stateDir, "issues")).toEqual([]);
    expect(await offered(p, "issues_earlier_2")).toEqual([earlierAs("issues_earlier_2"), earlierAs("issues_earlier_2")]);
  });

  test("an empty trash folder of the new name moves nothing aside", async () => {
    const p = await built({ preview: false });
    mkdirSync(join(p.stateDir, "trash", "issues"), { recursive: true });
    const plan = await planRename(p.root, "github_issues", "issues");
    expect(plan.earlier).toBeNull();
    expect((await applyRename(p.root, plan, { now: CLOCK })).trash).toEqual({ versions: 1, left: [], earlier: null });
    expect(await offered(p, "issues")).toEqual([OWN]);
  });

  for (const at of ["rename_after_commit", "rename_after_state", "rename_after_earlier", "rename_after_trash"] as const) {
    test(`a stop at ${at}: the journal keeps the earlier versions apart, and the same rename finishes without mixing them`, async () => {
      const p = await built({ preview: false });
      await earlierIssues(p);
      const e = await refused(renameIt(p, "github_issues", "issues", {
        onPoint: (point) => {
          if (point === at) throw new Error("disk full");
        },
      }));
      expect(e.code).toBe("INTERNAL_ERROR");
      expect(readJournal(p.stateDir)).toMatchObject({ from: "github_issues", to: "issues", earlier: { name: "issues_earlier", versions: [expect.any(String)] } });
      const plan = await planRename(p.root, "github_issues", "issues");
      expect(plan).toMatchObject({ mode: "resume", earlier: { name: "issues_earlier" } });
      const done = await applyRename(p.root, plan, { now: CLOCK });
      expect(done.trash.earlier).toMatchObject({ name: "issues_earlier", left: [] });
      expect(await offered(p, "issues")).toEqual([OWN]);
      expect(await offered(p, "issues_earlier")).toEqual([EARLIER]);
      expect(readJournal(p.stateDir)).toBeNull();
    });
  }
});

describe("ASSET_RENAMED: findRenamed and the adopt mode", () => {
  test("a never-built file whose code hash is an orphan's recorded hash; the rename adopts the table and state", async () => {
    const p = await built({ trash: false, preview: false });
    const hash = await tsFingerprint(join(p.root, "assets/gh/github_issues.ts"), p.project);
    const db = runsDb(p.stateDir);
    putCatalog(db, { ...ISSUES_CATALOG, codeHash: hash });
    db.close();
    await seed(p.database, [`UPDATE _croft.assets SET code_hash = '${hash}' WHERE name = 'github_issues'`]);
    // Renamed outside croft: a new file with the same code, and the old one gone.
    renameSync(join(p.root, "assets/gh/github_issues.ts"), join(p.root, "assets/tickets.ts"));
    const found = await findRenamed(p.root);
    expect(found).toEqual([{ from: "github_issues", to: "tickets", file: "assets/tickets.ts", rows: 18_556 }]);
    const pr = renamedProblem(found[0]!);
    expect(pr).toMatchObject({
      severity: "error", code: "ASSET_RENAMED", asset: "tickets", file: "assets/tickets.ts",
      message: "assets/tickets.ts has never been built, and its code is the code that built github_issues (18,556 rows), whose asset file is gone: github_issues was renamed outside croft",
      fix: { kind: "command", description: "adopt github_issues's table and state as tickets", command: "croft rename github_issues tickets" },
      details: { from: "github_issues", to: "tickets", rows: 18_556, unfinished: false },
    });
    expect(pr.hint).not.toContain("croft run");

    // Code hashes the caller has are used as they are (no bundling).
    expect(await findRenamed(p.root, { codeHash: () => "other" })).toEqual([]);

    const plan = await planRename(p.root, "github_issues", "tickets");
    expect(plan).toMatchObject({ mode: "adopt", fileFrom: "assets/tickets.ts", fileTo: "assets/tickets.ts", hasTable: true });
    const r = await applyRename(p.root, plan, { now: CLOCK });
    expect(r).toMatchObject({ mode: "adopt", file: { moved: false }, table: { renamed: true, rows: 3 } });
    expect(await q(p.database, "SELECT name FROM _croft.assets ORDER BY 1")).toEqual([["open_issues"], ["tickets"]]);
    expect(await findRenamed(p.root)).toEqual([]);
  });

  test("an SQL file renamed outside croft is found too", async () => {
    const p = makeProject({ files: { "assets/daily.sql": "-- key: d\nSELECT 1 AS d\n" } });
    const resolved = await resolveProject({ root: p.root, timezone: p.project.timezone });
    const hash = resolved.assets[0]!.codeHash!;
    const db = runsDb(p.stateDir);
    putCatalog(db, { ...ISSUES_CATALOG, asset: "daily", kind: "sql", rows: 1, columns: [], cursor: null, codeHash: hash });
    db.close();
    renameSync(join(p.root, "assets/daily.sql"), join(p.root, "assets/per_day.sql"));
    expect(await findRenamed(p.root)).toEqual([{ from: "daily", to: "per_day", file: "assets/per_day.sql", rows: 1 }]);
  });

  test("no match: other code, a candidate that was built, or no orphan", async () => {
    const p = await built({ trash: false, preview: false });
    expect(await findRenamed(p.root)).toEqual([]);                    // no orphan
    renameSync(join(p.root, "assets/gh/github_issues.ts"), join(p.root, "assets/tickets.ts"));
    expect(await findRenamed(p.root)).toEqual([]);                    // the orphan's hash is hash-1: other code
    const db = runsDb(p.stateDir);
    putCatalog(db, { ...ISSUES_CATALOG, asset: "tickets", codeHash: "hash-1" });
    db.close();
    // tickets was built: not a candidate, whatever its code.
    expect(await findRenamed(p.root, { codeHash: (n) => (n === "tickets" ? "hash-1" : null) })).toEqual([]);
  });
});

describe("a rename in a real project keeps history: the next run continues from the cursor", () => {
  let api: MockApi;
  afterAll(() => api?.stop());

  test("ingest + SQL + incremental TS transform: rename, update the references, run again", async () => {
    api = mockApi();
    api.state.issues = [
      { id: 1, title: "a", updated_at: "2026-09-01T00:00:00Z" },
      { id: 2, title: "b", updated_at: "2026-09-02T00:00:00Z" },
      { id: 3, title: "c", updated_at: "2026-09-03T00:00:00Z" },
    ];
    const triage = (input: string) => `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["${input}"], key: "id", incremental: true,
  async *rows({ newRows }) {
    for await (const i of newRows<{ id: number; title: string }>("${input}")) yield { id: i.id, upper: i.title.toUpperCase() };
  },
});
`;
    const root = makeRunProject({
      "assets/issues.ts": keysetIssues(api.url),
      "assets/open.sql": "SELECT id, title FROM issues\n",
      "assets/triage.ts": triage("issues"),
    });
    const run = async (selectors: string[]) => {
      const out = await executeRun({
        project: loadProject({ root }), env: ProjectEnv.load(root, {}), selectors, argv: ["run", ...selectors], interactive: false,
        retryDelaysMs: [10, 20], http: { retryBaseMs: 5 }, now: CLOCK,
      });
      await closeAllWarehouses();
      return out;
    };
    const first = await run([]);
    expect(first.data.steps.map((s) => `${s.asset}:${s.status}`)).toEqual(["issues:ok", "open:ok", "triage:ok"]);
    const project = loadProject({ root });

    const plan = await planRename(root, "issues", "tickets");
    expect(plan.references.map((r) => `${r.file}:${r.line} ${r.kind}`)).toEqual([
      "assets/open.sql:1 sql", "assets/triage.ts:3 ts_input", "assets/triage.ts:5 ts_input",
    ]);
    await applyRename(root, plan, { now: CLOCK });

    // Before the references are updated, validate-level code still names issues; the orphan is gone.
    writeFiles(root, { "assets/open.sql": "SELECT id, title FROM tickets\n", "assets/triage.ts": triage("tickets") });
    api.state.issues.push({ id: 4, title: "d", updated_at: "2026-09-04T00:00:00Z" });
    api.state.log = [];
    const second = await run(["tickets"]);
    const step = second.data.steps.find((s) => s.asset === "tickets")!;
    expect(step.status).toBe("ok");
    // The saved cursor was used: only what is new was fetched, and nothing was added twice.
    const since = api.state.log[0]!.query.since;
    expect(since).toBeDefined();
    expect(since! > "2026-09-02").toBe(true);
    expect(step.rows).toMatchObject({ added: 1, total: 4 });
    // The incremental transform continues from its position on the renamed input: only the new row.
    // (A new process: this one has the old triage.ts imported.)
    const third = await cli(root, ["run", "triage", "--foreground", "--json"], cliEnv({ CROFT_NOW: NOW }));
    expect(third.json?.data.steps.find((s: { asset: string }) => s.asset === "triage")).toMatchObject({ status: "ok", rows: { in: 1, added: 1, total: 4 } });

    // The approval travelled: the fingerprint ignores the file name, so tickets is neither edited nor held.
    const db = RunsDb.open(project.paths.stateDir);
    try {
      const entry = getCatalog(db, "tickets")!;
      expect(db.approvedCode("tickets")).toBe(entry.codeHash);
      expect(getCatalog(db, "issues")).toBeNull();
    } finally {
      db.close();
    }
    const resolved = await resolveProject({ root, timezone: project.timezone });
    const db2 = RunsDb.open(project.paths.stateDir);
    try {
      expect(resolved.assets.find((a) => a.name === "tickets")!.codeHash).toBe(db2.approvedCode("tickets")!);
    } finally {
      db2.close();
    }
    expect(readdirSync(join(root, "assets")).sort()).toEqual(["open.sql", "tickets.ts", "triage.ts"]);
  });
});

