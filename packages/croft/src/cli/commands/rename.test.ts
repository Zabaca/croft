import { afterAll, describe, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { closeAllWarehouses, openWarehouse } from "../../db/warehouse.ts";
import { trashTable } from "../../safety/trash.ts";
import { getCatalog, putCatalog } from "../../history/catalog.ts";
import { tryAcquire } from "../../history/leases.ts";
import { currentIdentity } from "../../core/proc.ts";
import { readJournal } from "../../project/rename.ts";
import { RunsDb } from "../../history/runs-db.ts";
import { cleanupProjects, cli as spawnCli, cliEnv, makeProject as makeRunProject } from "../../run/testkit.ts";
import { cleanup, cli, ISSUES_CATALOG, ISSUES_SEED, ISSUES_TS, makeProject, NOW, OPEN_SQL, runsDb, seed, type TestProject } from "./inspect-testkit.ts";
import { formatRename, renameNext } from "./rename.ts";

afterAll(async () => {
  await cleanup();
});

const ENV = { CROFT_NOW: NOW };

async function issues(): Promise<TestProject> {
  const p = makeProject({ files: { "assets/github_issues.ts": ISSUES_TS, "assets/open_issues.sql": OPEN_SQL } });
  await seed(p.database, ISSUES_SEED);
  const db = runsDb(p.stateDir, () => new Date(NOW));
  putCatalog(db, ISSUES_CATALOG);
  db.approveCode("github_issues", "hash-1");
  db.close();
  return p;
}

async function names(database: string): Promise<string[]> {
  await closeAllWarehouses();
  const db = await DuckDBInstance.create(database, { access_mode: "READ_ONLY" });
  const c = await db.connect();
  try {
    return (await c.runAndReadAll("SELECT name FROM _croft.assets ORDER BY 1")).getRowsJS().map((r) => String(r[0]));
  } finally {
    c.disconnectSync();
    db.closeSync();
  }
}

describe("croft rename", () => {
  test("--json: what moved, the references with file:line, and croft validate next; no confirmation", async () => {
    const p = await issues();
    const r = await cli(["rename", "github_issues", "issues", "--json"], { cwd: p.root, env: ENV });
    expect(r.exit).toBe(0);
    expect(r.json).toMatchObject({ ok: true, command: "rename", problems: [] });
    expect(r.json.confirmation).toBeUndefined();
    const d = r.json.data;
    expect(Object.keys(d)).toEqual(["from", "to", "mode", "runId", "file", "table", "trash", "preview", "references"]);
    expect(d).toMatchObject({
      from: "github_issues", to: "issues", mode: "file",
      file: { from: "assets/github_issues.ts", to: "assets/issues.ts", moved: true },
      table: { renamed: true, rows: 3 }, trash: { versions: 0, left: [], earlier: null }, preview: "none",
      references: [{ file: "assets/open_issues.sql", line: 6, kind: "sql", text: `SELECT id, title, "user"->>'login' AS author FROM github_issues WHERE state = 'open'` }],
    });
    expect(r.json.next).toEqual([{ command: "croft validate", reason: "after updating the 1 reference to github_issues listed above, check the project" }]);
    expect(await names(p.database)).toEqual(["issues"]);
    expect(readFileSync(join(p.root, "assets/open_issues.sql"), "utf8")).toBe(OPEN_SQL);   // user code is never edited
  });

  test("human output lists what moved and every reference as file:line", async () => {
    const p = await issues();
    const r = await cli(["rename", "github_issues", "issues"], { cwd: p.root, env: ENV });
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("Renamed github_issues to issues.");
    expect(r.stdout).toContain("  file     assets/github_issues.ts → assets/issues.ts");
    expect(r.stdout).toContain("  table    github_issues → issues (3 rows), with its cursor, history and scheduler approval");
    expect(r.stdout).toContain("1 reference to github_issues to update (croft does not edit your code):");
    expect(r.stdout).toContain(`  assets/open_issues.sql:6  SELECT id, title, "user"->>'login' AS author FROM github_issues WHERE state = 'open'`);
    expect(r.stdout).toContain("croft validate");
  });

  test("formatRename: adopt, never built, trash and preview lines; renameNext without references", () => {
    const text = formatRename({
      from: "a", to: "b", mode: "adopt", runId: "r_0922_1200_abcd", file: { from: "assets/b.ts", to: "assets/b.ts", moved: false },
      table: { renamed: true, rows: 1 }, trash: { versions: 2, left: [], earlier: null }, preview: "kept", references: [],
    });
    expect(text).toBe([
      "Renamed a to b.",
      "  file     assets/b.ts (already renamed outside croft)",
      "  table    a → b (1 row), with its cursor, history and scheduler approval",
      "  trash    2 versions moved",
      "  preview  not cleared (the preview database was busy); the last preview still shows a until croft preview b",
      "",
      "No code names a.",
    ].join("\n"));
    expect(formatRename({
      from: "a", to: "b", mode: "file", runId: "r", file: { from: "assets/a.sql", to: "assets/b.sql", moved: true },
      table: { renamed: false, rows: null }, trash: { versions: 0, left: [], earlier: null }, preview: "none", references: [],
    })).toContain("  table    none yet: b has never been built");
    expect(renameNext({ from: "a", references: [] })).toEqual([{ command: "croft validate", reason: "check the project" }]);
    const kept = (earlier: { name: string; versions: number; left: string[] }) => formatRename({
      from: "a", to: "b", mode: "file", runId: "r", file: { from: "assets/a.sql", to: "assets/b.sql", moved: true },
      table: { renamed: true, rows: 4 }, trash: { versions: 1, left: [], earlier }, preview: "none", references: [],
    });
    expect(kept({ name: "b_earlier", versions: 2, left: [] })).toContain([
      "  trash    1 version moved",
      "  trash    2 versions of an earlier b (deleted before) kept apart as b_earlier: croft restore b never offers them; croft restore b_earlier can",
    ].join("\n"));
    expect(kept({ name: "b_earlier_2", versions: 0, left: ["/p/.croft/trash/b_earlier_2/x.duckdb"] })).toContain([
      "  trash    1 version of an earlier b (deleted before) kept apart as b_earlier_2: croft restore b never offers it; croft restore b_earlier_2 can",
      "  trash    1 of them could not be renamed inside and cannot be restored as b_earlier_2: /p/.croft/trash/b_earlier_2/x.duckdb",
    ].join("\n"));
  });

  test("R41-09: the trash of an earlier asset of the new name is kept apart; croft restore never offers it as the renamed asset's", async () => {
    const p = await issues();
    // An earlier asset named issues, deleted since: no file, no table, its version still in the trash.
    await seed(p.database, ["CREATE TABLE issues (sku VARCHAR)", "INSERT INTO issues VALUES ('s0'), ('s1')"]);
    const w = openWarehouse({ path: p.database, mode: "read_write", timezone: p.project.timezone, root: p.root, stateDir: p.stateDir });
    await trashTable(w, "issues", "delete (r_0922_0500_old1)", { now: new Date("2026-09-22T12:00:00Z") });
    await closeAllWarehouses();
    await seed(p.database, ["DROP TABLE issues"]);

    const r = await cli(["rename", "github_issues", "issues", "--json"], { cwd: p.root, env: ENV });
    expect(r.exit).toBe(0);
    expect(r.json.data.trash).toEqual({ versions: 0, left: [], earlier: { name: "issues_earlier", versions: 1, left: [] } });
    const list = await cli(["restore", "--json"], { cwd: p.root, env: ENV });
    expect(list.json.data.versions.map((v: { asset: string; rows: number; reason: string }) => [v.asset, v.rows, v.reason]))
      .toEqual([["issues_earlier", 2, "delete (r_0922_0500_old1)"]]);
    // github_issues had no version of its own: there is nothing to restore as issues.
    const mine = await cli(["restore", "issues", "--json"], { cwd: p.root, env: ENV });
    expect(mine.exit).toBe(2);
    expect(mine.json.problems[0]).toMatchObject({ code: "USAGE_ERROR", message: "the trash holds nothing of issues" });
    // The earlier asset's version comes back under the name it is kept as, after confirmation.
    const theirs = await cli(["restore", "issues_earlier", "--json"], { cwd: p.root, env: ENV });
    expect(theirs.exit).toBe(5);
    expect(theirs.json.data).toMatchObject({ asset: "issues_earlier", status: "needs_confirmation", rows: 2 });
  });

  test("refusals: usage (exit 2), a taken name (NAME_CONFLICT, exit 2), a run holding the asset (ASSET_BUSY, exit 4)", async () => {
    const p = await issues();
    const usage = await cli(["rename", "github_issues", "--json"], { cwd: p.root, env: ENV });
    expect(usage.exit).toBe(2);
    expect(usage.json.problems[0]).toMatchObject({ code: "USAGE_ERROR", fix: { command: "croft status" } });

    const taken = await cli(["rename", "github_issues", "open_issues", "--json"], { cwd: p.root, env: ENV });
    expect(taken.exit).toBe(2);
    expect(taken.json.problems[0].code).toBe("NAME_CONFLICT");

    const db = runsDb(p.stateDir, () => new Date(NOW));
    db.createRun({ id: "r_0922_1159_live", trigger: "manual", human: true, argv: ["run", "github_issues"], identity: currentIdentity() });
    tryAcquire(db, "github_issues", "r_0922_1159_live");
    db.close();
    const busy = await cli(["rename", "github_issues", "issues", "--json"], { cwd: p.root, env: ENV });
    expect(busy.exit).toBe(4);
    expect(busy.json.problems[0]).toMatchObject({ code: "ASSET_BUSY", fix: { command: "croft wait r_0922_1159_live" } });
    expect(existsSync(join(p.root, "assets/github_issues.ts"))).toBe(true);
  });
});

describe("a killed rename (CROFT_FAULT) is reported and finished by the same command", () => {
  for (const [fault, tableMoved] of [["rename_before_commit", false], ["rename_after_commit", true]] as const) {
    test(`SIGKILL at ${fault}: status and validate say ASSET_RENAMED with the fix; croft rename finishes it`, async () => {
      const p = await issues();
      const killed = await spawnCli(p.root, ["rename", "github_issues", "issues", "--json"], cliEnv({ CROFT_NOW: NOW, CROFT_FAULT: fault }));
      expect(killed.signal).toBe("SIGKILL");
      expect(readJournal(p.stateDir)).toMatchObject({ from: "github_issues", to: "issues" });
      // The file moved inside the warehouse transaction; the table only when the COMMIT happened.
      expect(existsSync(join(p.root, "assets/issues.ts"))).toBe(true);
      expect(await names(p.database)).toEqual([tableMoved ? "issues" : "github_issues"]);

      const status = await cli(["status", "--json"], { cwd: p.root, env: ENV });
      const renamed = status.json.problems.find((x: { code: string }) => x.code === "ASSET_RENAMED");
      expect(renamed).toMatchObject({
        severity: "error", asset: "issues", fix: { kind: "command", command: "croft rename github_issues issues" }, details: { unfinished: true },
      });
      expect(status.stdout).not.toContain("croft run issues");
      const validate = await cli(["validate", "--json"], { cwd: p.root, env: ENV });
      expect(validate.json.problems.some((x: { code: string; fix?: { command?: string } }) => x.code === "ASSET_RENAMED"
        && x.fix?.command === "croft rename github_issues issues")).toBe(true);

      const again = await cli(["rename", "github_issues", "issues", "--json"], { cwd: p.root, env: ENV });
      expect(again.exit).toBe(0);
      expect(again.json.data).toMatchObject({ mode: "resume", table: { rows: 3 } });
      expect(await names(p.database)).toEqual(["issues"]);
      expect(readJournal(p.stateDir)).toBeNull();
      const db = runsDb(p.stateDir);
      try {
        expect(getCatalog(db, "issues")?.rows).toBe(ISSUES_CATALOG.rows);
        expect(getCatalog(db, "github_issues")).toBeNull();
        expect(db.approvedCode("issues")).toBe("hash-1");
        // The killed rename's run record is marked crashed by the next writing command's reconcile().
        expect(db.listRuns({ limit: 5 }).map((r) => r.status)).toContain("crashed");
      } finally {
        db.close();
      }
      const after = await cli(["status", "--json"], { cwd: p.root, env: ENV });
      expect(after.json.problems.filter((x: { code: string }) => x.code === "ASSET_RENAMED")).toEqual([]);
    });
  }
});

describe("R41-05: while a croft rename is unfinished, no run or preview fetches either name again", () => {
  afterAll(() => cleanupProjects());

  // An ingest that counts its fetches (each one would bill the source again).
  const LOGGED = `import { ingest } from "@zabaca/croft";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
export default ingest({
  key: "id",
  schedule: "every day at 6:00",
  async *rows() {
    appendFileSync(join(process.cwd(), "fetches.log"), "fetch\\n");
    yield JSON.parse(readFileSync(join(process.cwd(), "data.json"), "utf8"));
  },
});
`;

  test("killed after runs.sqlite moved (the approval too): a named, bare, scheduled run and a preview fetch nothing; the rename then finishes", async () => {
    const root = makeRunProject({ "assets/tickets.ts": LOGGED, "data.json": JSON.stringify([1, 2, 3, 4, 5].map((id) => ({ id }))) });
    const env = (extra: Record<string, string> = {}) => cliEnv({ CROFT_NOW: NOW, CROFT_FORBID_OS_JOBS: "1", CROFT_NOTIFY_DRY: "1", ...extra });
    const fetches = () => readFileSync(join(root, "fetches.log"), "utf8").trim().split("\n").length;
    const stepOf = (r: { json?: Record<string, any> }) => r.json?.data?.steps?.find((s: { asset: string }) => s.asset === "support");
    const fix = { kind: "command", command: "croft rename tickets support" };
    expect((await spawnCli(root, ["run", "tickets", "--json"], env())).code).toBe(0);
    expect(fetches()).toBe(1);
    const db = RunsDb.open(join(root, ".croft"));
    db.setScheduling({ state: "on", via: "serve" });
    db.close();
    const killed = await spawnCli(root, ["rename", "tickets", "support", "--json"], env({ CROFT_FAULT: "rename_after_state" }));
    expect(killed.signal).toBe("SIGKILL");

    // Named: the step fails before it fetches, with the rename as its fix.
    const named = await spawnCli(root, ["run", "support", "--json"], env());
    expect(named.code).toBe(2);
    expect(stepOf(named)).toMatchObject({ status: "failed", error: { code: "ASSET_RENAMED", fix } });
    // Bare: skipped, with ASSET_RENAMED as a warning.
    const bare = await spawnCli(root, ["run", "--json"], env());
    expect(bare.code).toBe(0);
    expect(stepOf(bare)).toMatchObject({ status: "skipped" });
    expect(bare.json?.problems).toContainEqual(expect.objectContaining({ code: "ASSET_RENAMED", severity: "warning", fix: expect.objectContaining(fix) }));
    // The scheduler's run of it (the approval moved with the state, so nothing holds it): no fetch either.
    const due = await spawnCli(root, ["run", "--due", "support", "--json"], env());
    expect(stepOf(due)).toMatchObject({ status: "failed", error: { code: "ASSET_RENAMED", fix } });
    // A preview of it.
    const preview = await spawnCli(root, ["preview", "support", "--json"], env());
    expect(preview.code).toBe(2);
    expect(preview.json?.problems).toContainEqual(expect.objectContaining({ code: "ASSET_RENAMED", fix: expect.objectContaining(fix) }));
    expect(fetches()).toBe(1);

    // The same rename finishes it; then support runs from the adopted table (a normal run).
    const again = await spawnCli(root, ["rename", "tickets", "support", "--json"], env());
    expect(again.code).toBe(0);
    expect(again.json?.data).toMatchObject({ mode: "resume", table: { rows: 5 } });
    const after = await spawnCli(root, ["run", "support", "--json"], env());
    expect(after.code).toBe(0);
    expect(stepOf(after)).toMatchObject({ status: "ok", rows: { added: 0, total: 5 } });
    expect(fetches()).toBe(2);
  }, 90_000);
});
