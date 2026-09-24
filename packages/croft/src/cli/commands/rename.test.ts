import { afterAll, describe, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { closeAllWarehouses } from "../../db/warehouse.ts";
import { getCatalog, putCatalog } from "../../history/catalog.ts";
import { tryAcquire } from "../../history/leases.ts";
import { currentIdentity } from "../../core/proc.ts";
import { readJournal } from "../../project/rename.ts";
import { cli as spawnCli, cliEnv } from "../../run/testkit.ts";
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
      table: { renamed: true, rows: 3 }, trash: { versions: 0, left: [] }, preview: "none",
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
      table: { renamed: true, rows: 1 }, trash: { versions: 2, left: [] }, preview: "kept", references: [],
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
      table: { renamed: false, rows: null }, trash: { versions: 0, left: [] }, preview: "none", references: [],
    })).toContain("  table    none yet: b has never been built");
    expect(renameNext({ from: "a", references: [] })).toEqual([{ command: "croft validate", reason: "check the project" }]);
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
