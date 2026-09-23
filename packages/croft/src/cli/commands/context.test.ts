import { afterAll, describe, expect, test } from "bun:test";
import { utimesSync } from "node:fs";
import { join } from "node:path";
import { putCatalog } from "../../history/catalog.ts";
import { cleanup as cleanupChildren, spawnHolder, spawnIdle, writeIntent } from "../../read/testkit.ts";
import { toJsonLine } from "../render.ts";
import { capContext, CONTEXT_CAP_BYTES, type ContextData } from "./context.ts";
import {
  busyScenario, cleanup, cli, ISSUES_CATALOG, ISSUES_SEED, makeProject, NOW, runsDb, SCENARIO_FILES, seed, shape,
} from "./inspect-testkit.ts";

afterAll(async () => {
  cleanupChildren();
  await cleanup();
});

const ENV = { CROFT_NOW: NOW };

async function scenario(o: { warehouse?: boolean } = {}) {
  const p = makeProject({ files: SCENARIO_FILES });
  const t = new Date("2026-09-22T18:00:00Z");
  for (const f of Object.keys(SCENARIO_FILES)) utimesSync(join(p.root, f), t, t);
  busyScenario(p.stateDir);
  if (o.warehouse !== false) await seed(p.database, ISSUES_SEED);
  return p;
}

const byAsset = (d: ContextData) => Object.fromEntries(d.assets.map((a) => [a.asset, a])) as Record<string, any>;

describe("croft context --json", () => {
  test("golden: project, compact assets, running, failures and schema changes of the last 7 days", async () => {
    const p = await scenario();
    const r = await cli(["context", "--json"], { cwd: p.root, env: ENV });
    expect(r.exit).toBe(0);
    expect(r.json).toMatchObject({ ok: true, command: "context", problems: [], next: [] });
    const d = r.json.data as ContextData;
    expect(Object.keys(d)).toEqual(["project", "assets", "checksEnforced", "running", "held", "recentFailures", "recentSchemaChanges", "schemaChangesFrom", "truncated"]);
    expect(d.checksEnforced).toBe(false);
    expect(d.project).toEqual({ root: p.root, database: "warehouse.duckdb", timezone: "America/Los_Angeles", assets: 6, scheduling: { state: "off", via: null } });
    expect(byAsset(d).github_issues).toEqual({
      asset: "github_issues", kind: "ingest", file: "assets/github_issues.ts", description: "Issues of oven-sh/bun",
      behavior: ISSUES_CATALOG.behavior, key: ["id"], cursor: { field: "updated_at", value: "2026-09-22T17:58:03Z" }, rows: 18556,
      lastLoadedAt: "2026-09-22T11:55:00-07:00", status: "ok",
      lastRun: { runId: "r_0922_1155_ok01", at: "2026-09-22T11:55:00-07:00", status: "ok", code: null },
      next: "manual", reads: [], checks: ["unique(id)", "not_null(id)", "not_null(title)", "state IN ('open', 'closed')"],
      schemaChangedAt: "2026-09-22T11:55:00-07:00",
      columns: [{ name: "id", type: "BIGINT" }, { name: "title", type: "VARCHAR" }, { name: "user", type: "JSON", jsonKeys: ["id", "login"] }],
    });
    expect(byAsset(d).taxi_zones.filesGone).toEqual(["files/zones/2025.csv", "files/zones/2024.csv"]);
    expect(byAsset(d).open_issues).toMatchObject({ kind: "sql", status: "never_run", rows: null, next: "after inputs", checks: ["unique(id)", "not_null(id)", "not_null(author)", "warn id > 0"] });
    expect(byAsset(d).sales).toMatchObject({ kind: "ingest", status: "running", behavior: "loads only new and changed files; updates rows by order_id" });
    expect(d.running).toEqual([{ runId: "r_0922_1157_live", asset: "sales", pid: process.pid, since: "2026-09-22T11:56:00-07:00", phase: "extract", rowsFetched: 61200 }]);
    expect(d.held).toEqual([]);
    expect(d.recentFailures).toEqual([
      { asset: "taxi_zones", runId: "r_0922_1157_gone", at: "2026-09-22T11:56:00-07:00", status: "crashed", code: null, message: null },
      { asset: "stripe_charges", runId: "r_0922_1156_bad1", at: "2026-09-22T11:55:00-07:00", status: "failed", code: "CHECK_FAILED", message: "amount >= 0: 2 rows fail" },
    ]);
    expect(d.schemaChangesFrom).toBe("warehouse");
    expect(d.recentSchemaChanges).toEqual([
      { asset: "github_issues", at: "2026-09-22T11:00:00-07:00", runId: "r_0922_1100_bbbb", kind: "add_column", column: "updated_at", from: null, to: "TIMESTAMPTZ", readBy: [] },
    ]);
    expect(d.truncated).toBe(false);
    expect(shape(d.recentSchemaChanges)).toEqual([{ asset: "string", at: "string", runId: "string", kind: "string", column: "string", from: "null", to: "string", readBy: [] }]);
  });

  test("schema changes older than 7 days are left out", async () => {
    const p = await scenario();
    const r = await cli(["context", "--json"], { cwd: p.root, env: { CROFT_NOW: "2026-10-05T00:00:00Z" } });
    expect(r.json.data.recentSchemaChanges).toEqual([]);
    expect(r.json.data.recentFailures).toEqual([]);
  });

  test("--asset narrows everything to the named assets; an unknown name is UNKNOWN_TABLE", async () => {
    const p = await scenario();
    const r = await cli(["context", "--asset", "stripe_charges", "--asset", "sales", "--json"], { cwd: p.root, env: ENV });
    const d = r.json.data as ContextData;
    expect(d.assets.map((a) => a.asset)).toEqual(["sales", "stripe_charges"]);
    expect(d.recentFailures.map((f) => f.asset)).toEqual(["stripe_charges"]);
    expect(d.recentSchemaChanges).toEqual([]);
    expect(d.running.map((x) => x.asset)).toEqual(["sales"]);
    expect(d.project.assets).toBe(6);
    const bad = await cli(["context", "--asset", "stripe_charge", "--json"], { cwd: p.root, env: ENV });
    expect(bad.exit).toBe(2);
    expect(bad.json.problems[0]).toMatchObject({ code: "UNKNOWN_TABLE", hint: "did you mean stripe_charges?" });
  });

  test("a broken asset file is a problem to fix, not a failed command", async () => {
    const p = await scenario();
    await Bun.write(join(p.root, "assets/broken.ts"), `import { ingest } from "@zabaca/croft";\nexport default ingest({ key: 5 });\n`);
    const r = await cli(["context", "--json"], { cwd: p.root, env: ENV });
    expect(r.exit).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.problems.length).toBeGreaterThan(0);
    expect(r.json.problems[0].file).toBe("assets/broken.ts");
    expect(byAsset(r.json.data).broken).toMatchObject({ kind: "ingest", status: "never_run" });
  });

  test("before any run: files only", async () => {
    const p = makeProject({ files: SCENARIO_FILES });
    const r = await cli(["context", "--json"], { cwd: p.root, env: ENV });
    expect(r.exit).toBe(0);
    const d = r.json.data as ContextData;
    expect(d.assets.map((a) => a.status)).toEqual(Array(5).fill("never_run"));
    expect(d).toMatchObject({ running: [], recentFailures: [], recentSchemaChanges: [], truncated: false });
  });
});

describe("croft context when the warehouse file is missing", () => {
  test("DB_NOT_FOUND, and what was built shows as unknown rather than as its old row count", async () => {
    const p = await scenario({ warehouse: false });
    const r = await cli(["context", "--json"], { cwd: p.root, env: ENV });
    expect(r.exit).toBe(0);
    expect(r.json.problems.map((x: { code: string }) => x.code)).toEqual(["DB_NOT_FOUND"]);
    expect(r.json.problems[0].message).toContain("warehouse.duckdb is missing: croft built it before");
    const a = byAsset(r.json.data);
    expect(a.github_issues).toMatchObject({ status: "unknown", rows: null });
    expect(a.old_orders).toMatchObject({ status: "no_asset_file", rows: null });
    expect(a.stripe_charges).toMatchObject({ status: "failed", rows: null });

    const human = await cli(["context"], { cwd: p.root, env: ENV });
    const line = human.stdout.split("\n").find((l) => l.startsWith("github_issues "))!;
    expect(line).toContain("rows unknown");
    expect(line).toContain("unknown: the warehouse file is missing");
    expect(line).not.toContain("18,556");
  });
});

describe("croft context never waits on DuckDB", () => {
  test("while another process holds the warehouse write lock it answers at once, schema changes from the runs", async () => {
    const p = await scenario();
    const holder = spawnHolder(p.database, 20_000);
    await holder.waitFor("held");
    const started = performance.now();
    const r = await cli(["context", "--json"], { cwd: p.root, env: ENV });
    const took = performance.now() - started;
    holder.proc.kill("SIGKILL");
    expect(r.exit).toBe(0);
    expect(took).toBeLessThan(2000);
    expect(r.json.data.schemaChangesFrom).toBe("runs");
    expect(r.json.data.recentSchemaChanges).toEqual([
      { asset: "github_issues", at: "2026-09-22T11:55:00-07:00", runId: "r_0922_1155_ok01", kind: "add_column", column: "milestone", from: null, to: "JSON", readBy: [] },
    ]);
    expect(r.json.data.assets).toHaveLength(6);
  });

  test("a warehouse that cannot be read is reported, and the rest of the payload still comes", async () => {
    const p = await scenario({ warehouse: false });
    await Bun.write(p.database, "this is not a DuckDB file, it is some text long enough to have a header".repeat(100));
    const r = await cli(["context", "--json"], { cwd: p.root, env: ENV });
    expect(r.exit).toBe(0);
    expect(r.json.data.schemaChangesFrom).toBe("runs");
    expect(r.json.data.assets).toHaveLength(6);
    expect(r.json.problems.map((x: { code: string }) => x.code)).toEqual(["DB_UNREADABLE"]);
  });

  test("a writer's announced intent keeps it off the warehouse", async () => {
    const p = await scenario();
    const idle = spawnIdle();
    await idle.waitFor("up");
    writeIntent(p.stateDir, idle.pid);
    const r = await cli(["context", "--json"], { cwd: p.root, env: ENV });
    idle.proc.kill("SIGKILL");
    expect(r.exit).toBe(0);
    expect(r.json.data.schemaChangesFrom).toBe("runs");
  });
});

describe("the 20 KB cap", () => {
  test("a big project is cut to 20 KB with truncated: true and the names it left out", async () => {
    const p = makeProject();
    const db = runsDb(p.stateDir);
    const columns = Array.from({ length: 30 }, (_, i) => ({
      name: `column_number_${i}`, type: i % 5 === 0 ? "JSON" : "VARCHAR", sourceName: null, pinned: false, pending: false, format: null,
      ...(i % 5 === 0 ? { jsonKeys: Array.from({ length: 20 }, (_, k) => `key_${k}`) } : {}),
    }));
    for (let i = 0; i < 120; i++) putCatalog(db, { ...ISSUES_CATALOG, asset: `asset_${String(i).padStart(3, "0")}`, columns });
    db.close();
    const r = await cli(["context", "--json"], { cwd: p.root, env: ENV });
    expect(r.exit).toBe(0);
    const d = r.json.data as ContextData;
    expect(d.truncated).toBe(true);
    expect(Buffer.byteLength(toJsonLine(d))).toBeLessThanOrEqual(CONTEXT_CAP_BYTES);
    expect(d.assets.length).toBeGreaterThan(0);
    expect(d.assets.length + (d.omitted?.length ?? 0)).toBe(120);
    expect(d.omitted!.at(-1)).toBe("asset_119");
    expect(r.json.next[0].command).toBe("croft context --asset <name>");
    // --asset brings one back in full.
    const one = await cli(["context", "--asset", "asset_119", "--json"], { cwd: p.root, env: ENV });
    expect(one.json.data.truncated).toBe(false);
    expect(one.json.data.assets[0].columns).toHaveLength(30);
  });

  test("capContext sheds JSON keys first, then column lists, then assets", () => {
    const asset = (i: number) => ({
      asset: `a${i}`, kind: "ingest" as const, file: null, description: null, behavior: "b", key: [], cursor: null, rows: 1, lastLoadedAt: null,
      status: "ok" as const, lastRun: null, next: "manual", reads: [], checks: [],
      columns: [{ name: "c", type: "JSON", jsonKeys: Array.from({ length: 50 }, (_, k) => `k${k}`) }],
    });
    const d: ContextData = {
      project: { root: "/p", database: "w", timezone: "UTC", assets: 3, scheduling: { state: "off", via: null } },
      assets: [asset(1), asset(2), asset(3)], checksEnforced: false, running: [], held: [], recentFailures: [], recentSchemaChanges: [], schemaChangesFrom: "warehouse", truncated: false,
    };
    const size = Buffer.byteLength(toJsonLine(d));
    expect(capContext(d, size)).toBe(d);
    const noKeys = capContext(d, size - 10);
    expect(noKeys.truncated).toBe(true);
    expect(noKeys.assets[0]!.columns).toEqual([{ name: "c", type: "JSON" }]);
    expect(d.assets[0]!.columns![0]!.jsonKeys).toHaveLength(50);   // the input is not changed
    const noCols = capContext(d, Buffer.byteLength(toJsonLine({ ...d, assets: d.assets.map(({ columns: _c, ...a }) => a) })) + 5);
    expect(noCols.assets.every((a) => a.columns === undefined)).toBe(true);
    const few = capContext(d, 600);
    expect(few.omitted!.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(toJsonLine(few))).toBeLessThanOrEqual(600);
  });
});

describe("croft context: human output", () => {
  test("a readable overview", async () => {
    const p = await scenario();
    const r = await cli(["context"], { cwd: p.root, env: ENV });
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain(`${p.root} · warehouse.duckdb · America/Los_Angeles · 6 assets · scheduling off`);
    expect(r.stdout).toContain("github_issues · ingest · assets/github_issues.ts · 18,556 rows · ok");
    expect(r.stdout).toContain("  cursor    updated_at = 2026-09-22T17:58:03Z");
    expect(r.stdout).toContain("  columns   id BIGINT · title VARCHAR · user JSON {id, login}");
    expect(r.stdout).toContain("Recent failures (7 days)");
    expect(r.stdout).toContain("  stripe_charges r_0922_1156_bad1 failed CHECK_FAILED 5 min ago");
    expect(r.stdout).toContain("Recent schema changes (7 days)");
    expect(r.stdout).toContain("  github_issues + updated_at TIMESTAMPTZ 60 min ago");
    expect(r.stdout).toContain("taxi_zones · ingest · assets/taxi_zones.ts · 265 rows · crashed (croft logs taxi_zones --failed) · 2 files gone");
    // A running step with the progress the run engine reports (§4.3 running[]: phase, rowsFetched).
    expect(r.stdout).toContain("Running\n  r_0922_1157_live sales since 4 min ago · extract · 61,200 rows fetched");
    expect(r.stdout.split("\n")).toContain("checks: not enforced until phase 2");
  });
});
