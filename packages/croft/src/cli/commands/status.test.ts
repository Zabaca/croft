import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { putCatalog } from "../../history/catalog.ts";
import { cleanup as cleanupChildren, spawnHolder, writeServeJson } from "../../read/testkit.ts";
import {
  busyScenario, cleanup, cli, ISSUES_CATALOG, ISSUES_SEED, makeProject, NOW, runsDb, SCENARIO_FILES, seed, shape,
} from "./inspect-testkit.ts";
import { ago, sniffKind } from "./status.ts";

afterAll(async () => {
  cleanupChildren();
  await cleanup();
});

const ENV = { CROFT_NOW: NOW };
const BEFORE_RUNS = new Date("2026-09-22T18:00:00Z");

/** The busy scenario, with asset files last edited before every run. */
function scenario() {
  const p = makeProject({ files: SCENARIO_FILES });
  for (const f of Object.keys(SCENARIO_FILES)) utimesSync(join(p.root, f), BEFORE_RUNS, BEFORE_RUNS);
  busyScenario(p.stateDir);
  return p;
}

const byAsset = (data: { assets: { asset: string }[] }) => Object.fromEntries(data.assets.map((a) => [a.asset, a])) as Record<string, any>;

describe("croft status --json", () => {
  test("golden shape (§4.3), with scheduling off in phase 1", async () => {
    const p = scenario();
    const r = await cli(["status", "--json"], { cwd: p.root, env: ENV });
    expect(r.exit).toBe(0);
    expect(r.json).toMatchObject({ ok: true, command: "status", problems: [] });
    const d = r.json.data;
    expect(Object.keys(d)).toEqual(["healthy", "running", "assets", "scheduling"]);
    expect(d.scheduling).toEqual({ state: "off", via: null, lastTickAt: null });
    expect(shape(d.running)).toEqual([{ runId: "string", asset: "string", pid: "number", since: "string", phase: "string", rowsFetched: "number" }]);
    expect(shape(byAsset(d).github_issues)).toEqual({
      asset: "string", kind: "string", file: "string", status: "string", rows: "number",
      lastRun: { runId: "string", at: "string", status: "string", code: "null" },
      next: { at: "null", reason: "string" }, stale: "boolean", staleReasons: [], held: "boolean", edited: "boolean",
      schemaChangedAt: "string",
    });
  });

  test("every asset's state: ok, failed with its code, running, crashed, never run, no asset file", async () => {
    const p = scenario();
    const d = (await cli(["status", "--json"], { cwd: p.root, env: ENV })).json.data;
    expect(d.assets.map((a: { asset: string }) => a.asset)).toEqual(["github_issues", "old_orders", "open_issues", "sales", "stripe_charges", "taxi_zones"]);
    const a = byAsset(d);
    expect(a.github_issues).toEqual({
      asset: "github_issues", kind: "ingest", file: "assets/github_issues.ts", status: "ok", rows: 18556,
      lastRun: { runId: "r_0922_1155_ok01", at: "2026-09-22T11:55:00-07:00", status: "ok", code: null },
      next: { at: null, reason: "manual" }, stale: false, staleReasons: [], held: false, edited: false,
      schemaChangedAt: "2026-09-22T11:55:00-07:00",
    });
    expect(a.stripe_charges).toMatchObject({ status: "failed", rows: 1130, lastRun: { runId: "r_0922_1156_bad1", status: "failed", code: "CHECK_FAILED" } });
    expect(a.sales).toMatchObject({ status: "running", kind: "ingest", rows: null, lastRun: { runId: "r_0922_1157_live", status: "running" }, stale: false });
    expect(a.taxi_zones).toMatchObject({ status: "crashed", lastRun: { runId: "r_0922_1157_gone", status: "crashed" }, filesGone: ["files/zones/2025.csv", "files/zones/2024.csv"] });
    expect(a.open_issues).toMatchObject({ status: "never_run", kind: "sql", rows: null, lastRun: null, next: { reason: "after inputs" }, stale: true, staleReasons: ["never_built"] });
    expect(a.old_orders).toMatchObject({ status: "no_asset_file", file: null, rows: 120, next: { at: null, reason: "none" },
      lastRun: { runId: "r_0101_0000_old1", status: "ok" } });
    expect(d.healthy).toBe(false);
  });

  test("running[] comes from runs.sqlite: live runs only, with the progress they report", async () => {
    const p = scenario();
    const d = (await cli(["status", "--json"], { cwd: p.root, env: ENV })).json.data;
    expect(d.running).toEqual([{ runId: "r_0922_1157_live", asset: "sales", pid: process.pid, since: "2026-09-22T11:56:00-07:00", phase: "extract", rowsFetched: 61200 }]);
  });

  test("--check exits 1 when unhealthy and 0 when healthy; ok stays true", async () => {
    const p = scenario();
    const bad = await cli(["status", "--check", "--json"], { cwd: p.root, env: ENV });
    expect(bad.exit).toBe(1);
    expect(bad.json.ok).toBe(true);
    expect(bad.json.next.map((n: { command: string }) => n.command)).toEqual(["croft logs stripe_charges --failed", "croft logs taxi_zones --failed"]);
    expect((await cli(["status", "--json"], { cwd: p.root, env: ENV })).exit).toBe(0);

    const good = makeProject({ files: { "assets/github_issues.ts": SCENARIO_FILES["assets/github_issues.ts"]! } });
    utimesSync(join(good.root, "assets/github_issues.ts"), BEFORE_RUNS, BEFORE_RUNS);
    const db = runsDb(good.stateDir);
    putCatalog(db, ISSUES_CATALOG);
    db.close();
    const r = await cli(["status", "--check", "--json"], { cwd: good.root, env: ENV });
    expect(r.exit).toBe(0);
    expect(r.json.data.healthy).toBe(true);
  });

  test("an asset file edited after its last run says so", async () => {
    const p = scenario();
    const later = new Date("2026-09-22T18:58:00Z");
    utimesSync(join(p.root, "assets/github_issues.ts"), later, later);
    const a = byAsset((await cli(["status", "--json"], { cwd: p.root, env: ENV })).json.data);
    expect(a.github_issues.edited).toBe(true);
    expect(a.stripe_charges.edited).toBe(false);
  });

  test("a live croft serve is listed", async () => {
    const p = scenario();
    writeServeJson(p.stateDir, { url: "http://127.0.0.1:7447", pid: process.pid });
    const d = (await cli(["status", "--json"], { cwd: p.root, env: ENV })).json.data;
    expect(d.serve).toEqual({ url: "http://127.0.0.1:7447", pid: process.pid });
  });
});

describe("croft status: human output", () => {
  test("the §4.2 table: rows, last run, next, status with its notes and fixes", async () => {
    const p = scenario();
    const r = await cli(["status"], { cwd: p.root, env: ENV });
    expect(r.exit).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^ASSET +ROWS +LAST RUN +NEXT +STATUS$/);
    const row = (name: string) => lines.find((l) => l.startsWith(`${name} `))!.replace(/ {2,}/g, " | ");
    expect(row("github_issues")).toBe("github_issues | 18,556 | 5 min ago | manual | ok · schema changed 5 min ago");
    expect(row("stripe_charges")).toBe("stripe_charges | 1,130 | 5 min ago | manual | failed: CHECK_FAILED (croft logs stripe_charges --failed)");
    expect(row("sales")).toBe("sales | — | 4 min ago | manual | running (r_0922_1157_live)");
    expect(row("taxi_zones")).toBe("taxi_zones | 265 | 4 min ago | manual | crashed (croft logs taxi_zones --failed) · 2 files gone");
    expect(row("open_issues")).toBe("open_issues | — | — | after inputs | never run (croft run open_issues)");
    expect(row("old_orders")).toBe("old_orders | 120 | 5 min ago | — | no asset file (croft delete old_orders)");
    expect(lines).toContain(`running  r_0922_1157_live  sales  pid ${process.pid}  since 4 min  extract  61,200 rows fetched`);
    expect(lines.at(-3)).toBe("Scheduling off · 1 running");
    expect(r.stdout).toContain("next: croft logs stripe_charges --failed");
  });

  test("a project with no assets says what to do", async () => {
    const p = makeProject();
    const r = await cli(["status"], { cwd: p.root, env: ENV });
    expect(r.stdout).toContain("No assets yet");
    expect(r.stdout).toContain("Scheduling off · 0 running");
  });
});

describe("croft status never waits on DuckDB", () => {
  test("it answers while another process holds the warehouse write lock", async () => {
    const p = scenario();
    await seed(p.database, ISSUES_SEED);
    const holder = spawnHolder(p.database, 20_000);
    await holder.waitFor("held");
    const started = performance.now();
    const r = await cli(["status", "--json"], { cwd: p.root, env: ENV });
    const took = performance.now() - started;
    expect(r.exit).toBe(0);
    expect(r.json.data.assets).toHaveLength(6);
    expect(took).toBeLessThan(1500);
    holder.proc.kill("SIGKILL");
  });

  test("it never opens the warehouse: a file that is not a database changes nothing", async () => {
    const p = scenario();
    writeFileSync(p.database, "not a duckdb file");
    const r = await cli(["status", "--json"], { cwd: p.root, env: ENV });
    expect(r.exit).toBe(0);
    expect(r.json.data.assets).toHaveLength(6);
  });

  test("without runs.sqlite it lists the files and creates nothing", async () => {
    const p = makeProject({ files: SCENARIO_FILES });
    const r = await cli(["status", "--json"], { cwd: p.root, env: ENV });
    expect(r.exit).toBe(0);
    expect(r.json.data.assets.map((a: { status: string }) => a.status)).toEqual(Array(5).fill("never_run"));
    expect(existsSync(join(p.stateDir, "runs.sqlite"))).toBe(false);
  });

  test("names that are not assets are reported, not fatal", async () => {
    const p = makeProject({ files: { "assets/Bad-Name.ts": "export default 1;\n" } });
    const r = await cli(["status", "--json"], { cwd: p.root, env: ENV });
    expect(r.exit).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.problems[0].code).toBe("NAME_INVALID");
  });
});

describe("helpers", () => {
  test("ago", () => {
    const now = new Date("2026-09-22T19:00:00Z");
    expect(ago("2026-09-22T18:59:48Z", now)).toBe("12 s ago");
    expect(ago("2026-09-22T11:55:00.123456-07:00", now)).toBe("5 min ago");
    expect(ago("2026-09-22T16:00:00Z", now)).toBe("3 h ago");
    expect(ago("2026-09-20T19:00:00Z", now)).toBe("2 days ago");
    expect(ago(null, now)).toBe("—");
  });

  test("sniffKind reads the kind from the text without importing", () => {
    const p = makeProject({ files: { "assets/a.ts": "export default transform({ inputs: [] })", "assets/b.ts": "export default ingest({})", "assets/c.ts": "" } });
    const at = (f: string) => ({ kind: "ts" as const, path: join(p.root, "assets", f) });
    expect(sniffKind(at("a.ts"))).toBe("ts");
    expect(sniffKind(at("b.ts"))).toBe("ingest");
    expect(sniffKind(at("c.ts"))).toBeNull();
    expect(sniffKind({ kind: "sql", path: "x" })).toBe("sql");
  });
});
