import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allCatalog, type CatalogAsset, putCatalog } from "../../history/catalog.ts";
import { resolveProject } from "../../project/resolve.ts";
import { cleanup as cleanupChildren, spawnHolder, writeServeJson } from "../../read/testkit.ts";
import type { AssetScheduleView, HoldCode } from "../../schedule/due.ts";
import type { Command } from "../command.ts";
import { COMMANDS } from "./index.ts";
import {
  busyScenario, cleanup, cli, DEAD, ISSUES_CATALOG, ISSUES_SEED, ISSUES_TS, makeProject, NOW, OPEN_SQL, runsDb, SCENARIO_FILES, seed, shape,
  type TestProject,
} from "./inspect-testkit.ts";
import { type ScheduleViewFn, SINCE_KEY } from "./schedule.ts";
import { ago, runStatus, schemaChangesFromRuns, status as statusImpl, type StatusDeps, staleText } from "./status.ts";

afterAll(async () => {
  cleanupChildren();
  await cleanup();
});

const ENV = { CROFT_NOW: NOW };
const BEFORE_RUNS = new Date("2026-09-22T18:00:00Z");

/** The code hashes croft computes for the project's asset files now: what a run of them records. */
async function codeHashes(root: string): Promise<Record<string, string>> {
  const r = await resolveProject({ root, timezone: "America/Los_Angeles" });
  return Object.fromEntries(r.assets.flatMap((a) => (a.codeHash ? [[a.name, a.codeHash]] : [])));
}

/** Give each catalog entry whose asset file exists the hash of that file's code, as a run of it would have. */
async function builtWithTheirCode(p: TestProject): Promise<void> {
  const hashes = await codeHashes(p.root);
  const db = runsDb(p.stateDir);
  try {
    for (const c of allCatalog(db)) if (hashes[c.asset]) putCatalog(db, { ...c, codeHash: hashes[c.asset]! });
  } finally {
    db.close();
  }
}

/** The busy scenario, with asset files last edited before every run, each built with the code it has now,
 *  and a warehouse file: status never opens it, only checks that it is there (without it the catalog's
 *  tables are gone, DB_NOT_FOUND). */
async function scenario(o: { warehouse?: boolean } = {}) {
  const p = makeProject({ files: SCENARIO_FILES });
  for (const f of Object.keys(SCENARIO_FILES)) utimesSync(join(p.root, f), BEFORE_RUNS, BEFORE_RUNS);
  busyScenario(p.stateDir);
  await builtWithTheirCode(p);
  if (o.warehouse !== false) writeFileSync(p.database, "");
  return p;
}

const byAsset = (data: { assets: { asset: string }[] }) => Object.fromEntries(data.assets.map((a) => [a.asset, a])) as Record<string, any>;

describe("croft status --json", () => {
  test("golden shape (§4.3), with scheduling off (no scheduler before phase 3)", async () => {
    const p = await scenario();
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
    const p = await scenario();
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
    const p = await scenario();
    const d = (await cli(["status", "--json"], { cwd: p.root, env: ENV })).json.data;
    expect(d.running).toEqual([{ runId: "r_0922_1157_live", asset: "sales", pid: process.pid, since: "2026-09-22T11:56:00-07:00", phase: "extract", rowsFetched: 61200 }]);
  });

  const INGEST = `import { ingest } from "@zabaca/croft";\nexport default ingest({ async *rows() { yield []; } });\n`;
  const PARALLEL = { "assets/a.ts": INGEST, "assets/b.ts": INGEST, "assets/c.ts": INGEST };
  /** A live run of this process with a, b and c extracting side by side. */
  function parallelRun(o: { progress?: unknown; events?: string[] }) {
    const p = makeProject({ files: PARALLEL });
    const db = runsDb(p.stateDir);
    try {
      const run = db.createRun({ id: "r_0922_1200_para", trigger: "manual", human: true, argv: ["run"] });
      for (const asset of ["a", "b", "c"]) db.startStep({ runId: run.id, asset, attempt: 1, reason: "requested" });
      if (o.progress !== undefined) db.setRunProgress(run.id, o.progress);
    } finally {
      db.close();
    }
    if (o.events) {
      mkdirSync(join(p.stateDir, "logs", "r_0922_1200_para"), { recursive: true });
      writeFileSync(join(p.stateDir, "logs", "r_0922_1200_para", "events.ndjson"), o.events.map((l) => `${l}\n`).join(""));
    }
    return p;
  }
  const progressEvent = (asset: string, phase: string, rowsFetched: number) =>
    JSON.stringify({ type: "progress", runId: "r_0922_1200_para", asset, phase, rowsFetched, requests: 1, elapsedMs: 10, at: "2026-09-22T19:00:00.000Z" });
  const running = async (root: string) => {
    const d = (await cli(["status", "--json"], { cwd: root })).json.data;
    return (d.running as { asset: string; phase: unknown; rowsFetched: unknown }[])
      .map(({ asset, phase, rowsFetched }) => ({ asset, phase, rowsFetched })).sort((x, y) => x.asset.localeCompare(y.asset));
  };

  test("steps extracting side by side each show their own progress: runs.summary has the newest, events.ndjson the others", async () => {
    const p = parallelRun({
      progress: { asset: "b", phase: "write", rowsFetched: 900, requests: 9, elapsedMs: 5000 },
      events: [
        JSON.stringify({ type: "step", runId: "r_0922_1200_para", asset: "a", attempt: 1, status: "running" }),
        progressEvent("a", "extract", 10),
        progressEvent("b", "extract", 850),
        progressEvent("a", "extract", 40),
        progressEvent("b", "write", 900),
      ],
    });
    expect(await running(p.root)).toEqual([
      { asset: "a", phase: "extract", rowsFetched: 40 },
      { asset: "b", phase: "write", rowsFetched: 900 },
      { asset: "c", phase: null, rowsFetched: null },
    ]);
  });

  test("progress that is absent or unreadable is null, never an error", async () => {
    expect(await running(parallelRun({}).root)).toEqual([
      { asset: "a", phase: null, rowsFetched: null }, { asset: "b", phase: null, rowsFetched: null }, { asset: "c", phase: null, rowsFetched: null },
    ]);
    const odd = parallelRun({
      progress: { asset: "a", phase: 7, rowsFetched: "12" },
      events: ["not json", JSON.stringify({ type: "progress", asset: "b" }), JSON.stringify({ type: "progress", asset: "c", phase: "extract", rowsFetched: -1 }), "{\"type\":\"progress\",\"asset\":"],
    });
    expect(await running(odd.root)).toEqual([
      { asset: "a", phase: null, rowsFetched: null }, { asset: "b", phase: null, rowsFetched: null }, { asset: "c", phase: "extract", rowsFetched: null },
    ]);
    // Only the phase is known: the human line says what it knows.
    const human = await cli(["status"], { cwd: odd.root });
    expect(human.stdout).toMatch(/running {2}r_0922_1200_para {2}c {2}pid \d+ {2}since .+ {2}extract$/m);
  });

  test("--check exits 1 when unhealthy and 0 when healthy; ok stays true", async () => {
    const p = await scenario();
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
    await builtWithTheirCode(good);
    writeFileSync(good.database, "");
    const r = await cli(["status", "--check", "--json"], { cwd: good.root, env: ENV });
    expect(r.exit).toBe(0);
    expect(r.json.data.healthy).toBe(true);
    expect(r.json.problems).toEqual([]);
  });

  test("an asset whose code changed since its last run is edited; a touched file whose code is the same is not", async () => {
    const p = await scenario();
    const later = new Date("2026-09-22T18:58:00Z");
    // Formatting and comments are not code (the fingerprint of DESIGN §8).
    writeFileSync(join(p.root, "assets/stripe_charges.ts"), `// Stripe charges\n${SCENARIO_FILES["assets/stripe_charges.ts"]}`);
    utimesSync(join(p.root, "assets/stripe_charges.ts"), later, later);
    writeFileSync(join(p.root, "assets/github_issues.ts"), ISSUES_TS.replace('key: "id"', 'key: "number"'));
    const r = await cli(["status", "--json"], { cwd: p.root, env: ENV });
    const a = byAsset(r.json.data);
    expect(a.github_issues).toMatchObject({ edited: true, stale: false, staleReasons: [] });
    expect(a.stripe_charges.edited).toBe(false);
    // An ingest's edit changes what the next run fetches, never what it has loaded.
    expect(r.json.problems).toEqual([expect.objectContaining({
      severity: "warning", code: "EDITED_SINCE_LAST_RUN", asset: "github_issues", file: "assets/github_issues.ts",
      fix: expect.objectContaining({ kind: "command", command: "croft run github_issues" }),
    })]);
    expect(r.stdout).not.toContain("--rebuild");
    const human = await cli(["status"], { cwd: p.root, env: ENV });
    expect(human.stdout).toMatch(/^github_issues .* ok · schema changed 5 min ago · edited since its last run$/m);
  });

  test("a file whose code does not load falls back to its modification time", async () => {
    const p = await scenario();
    writeFileSync(join(p.root, "assets/github_issues.ts"), "export default ingest({ key: \n");
    utimesSync(join(p.root, "assets/github_issues.ts"), BEFORE_RUNS, BEFORE_RUNS);
    expect(byAsset((await cli(["status", "--json"], { cwd: p.root, env: ENV })).json.data).github_issues.edited).toBe(false);
    const later = new Date("2026-09-22T18:58:00Z");
    utimesSync(join(p.root, "assets/github_issues.ts"), later, later);
    const r = await cli(["status", "--json"], { cwd: p.root, env: ENV });
    expect(r.exit).toBe(0);
    expect(byAsset(r.json.data).github_issues).toMatchObject({ kind: "ingest", status: "ok", edited: true });
  });

  test("a live croft serve is listed", async () => {
    const p = await scenario();
    writeServeJson(p.stateDir, { url: "http://127.0.0.1:7447", pid: process.pid });
    const d = (await cli(["status", "--json"], { cwd: p.root, env: ENV })).json.data;
    expect(d.serve).toEqual({ url: "http://127.0.0.1:7447", pid: process.pid });
  });
});

describe("croft status: human output", () => {
  test("the §4.2 table: rows, last run, next, status with its notes and fixes", async () => {
    const p = await scenario();
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
    expect(row("old_orders")).toBe("old_orders | 120 | 5 min ago | — | no asset file (its table is kept)");
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

describe("croft status when the warehouse file is missing", () => {
  // The catalog mirror in runs.sqlite says what was built; the warehouse file says whether it is still there.
  // status stats the file (it never opens it), so a deleted or moved warehouse is not reported as healthy.
  test("a catalog without its warehouse file: DB_NOT_FOUND, not healthy, the rows unknown", async () => {
    const p = await scenario({ warehouse: false });
    const r = await cli(["status", "--json"], { cwd: p.root, env: ENV });
    expect(r.exit).toBe(0);
    expect(r.json.ok).toBe(true);
    const d = r.json.data;
    expect(d.healthy).toBe(false);
    const problem = r.json.problems.find((x: { code: string }) => x.code === "DB_NOT_FOUND");
    expect(problem).toMatchObject({ severity: "error", fix: { kind: "manual", requiresHuman: true }, details: { path: p.database } });
    expect(problem.message).toContain("warehouse.duckdb is missing");
    expect(problem.message).toContain("built it before");
    expect(problem.message).not.toContain("nothing has run");
    const a = byAsset(d);
    // What was built is unknown now; what failed, is running or never ran is still true.
    expect(a.github_issues).toMatchObject({ status: "unknown", rows: null, lastRun: { runId: "r_0922_1155_ok01", status: "ok" } });
    expect(a.old_orders).toMatchObject({ status: "no_asset_file", rows: null });
    expect(a.stripe_charges).toMatchObject({ status: "failed", rows: null });
    expect(a.taxi_zones).toMatchObject({ status: "crashed", rows: null });
    expect(a.sales).toMatchObject({ status: "running" });
    expect(a.open_issues).toMatchObject({ status: "never_run" });
    expect((await cli(["status", "--check", "--json"], { cwd: p.root, env: ENV })).exit).toBe(1);
  });

  test("human output says the rows are unknown and why", async () => {
    const p = await scenario({ warehouse: false });
    const r = await cli(["status"], { cwd: p.root, env: ENV });
    const lines = r.stdout.trimEnd().split("\n");
    const row = (name: string) => lines.find((l) => l.startsWith(`${name} `))!.replace(/ {2,}/g, " | ");
    expect(row("github_issues")).toBe("github_issues | — | 5 min ago | manual | unknown: the warehouse file is missing · schema changed 5 min ago");
    expect(r.stdout).toContain("DB_NOT_FOUND");
  });

  test("before anything was built there is nothing to miss", async () => {
    const p = makeProject({ files: SCENARIO_FILES });
    const r = await cli(["status", "--json"], { cwd: p.root, env: ENV });
    expect(r.json.problems).toEqual([]);
    expect(r.json.data.healthy).toBe(false);                       // never built: stale, as before
    expect(r.json.data.assets.map((a: { status: string }) => a.status)).toEqual(Array(5).fill("never_run"));
  });
});

describe("croft status never waits on DuckDB", () => {
  test("it answers while another process holds the warehouse write lock", async () => {
    const p = await scenario({ warehouse: false });
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
    const p = await scenario();
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

// ---------------------------------------------------------------------------------------------------------
// Staleness (DESIGN.md §5 "Versions, staleness and atomicity", §8 "What a code change does"), from the catalog
// mirror and the asset files alone.

const TRIAGE_TS = `import { transform } from "@zabaca/croft";
export default transform({ inputs: ["github_issues"], key: "issue_id", incremental: true, async *rows() {} });
`;
const REPORT_TS = `import { transform } from "@zabaca/croft";
export default transform({ inputs: ["open_issues"], async *rows() {} });
`;
/** github_issues loaded at 18:55 (UTC); what the transforms saw of it. */
const LOADED = "2026-09-22T18:55:00.000000Z";
const EARLIER = "2026-09-22T18:00:00.000000Z";

/**
 * github_issues (ingest) → open_issues (SQL) → issue_report (full-refresh TS), and issue_triage (incremental TS)
 * reading github_issues. Every asset built by a run of its current code at 11:55 America/Los_Angeles, each
 * transform having read its inputs at their current version, unless `o` says otherwise.
 */
async function pipeline(o: { seen?: Record<string, string>; hashes?: Record<string, string>; entries?: Record<string, Partial<CatalogAsset>>;
  running?: string; files?: Record<string, string> } = {}) {
  const files = {
    "assets/github_issues.ts": ISSUES_TS, "assets/open_issues.sql": OPEN_SQL, "assets/issue_triage.ts": TRIAGE_TS, "assets/issue_report.ts": REPORT_TS,
    ...o.files,
  };
  const p = makeProject({ files });
  for (const f of Object.keys(files)) utimesSync(join(p.root, f), BEFORE_RUNS, BEFORE_RUNS);
  const hashes = { ...(await codeHashes(p.root)), ...o.hashes };
  let clock = Date.parse("2026-09-22T18:55:00.000Z");
  const db = runsDb(p.stateDir, () => new Date(clock));
  try {
    const run = db.createRun({ id: "r_0922_1155_all1", trigger: "manual", human: true, argv: ["run"], identity: DEAD });
    const reads: Record<string, string[]> = { github_issues: [], open_issues: ["github_issues"], issue_triage: ["github_issues"], issue_report: ["open_issues"] };
    for (const [asset, inputs] of Object.entries(reads)) {
      db.startStep({ runId: run.id, asset, attempt: 1, reason: "requested", codeHash: hashes[asset]! });
      db.finishStep(run.id, asset, 1, { status: "ok" });
      const seen = Object.fromEntries(inputs.map((i) => [i, { seenLoadedAt: LOADED, seenKey: null, inputLastLoadedAt: o.seen?.[`${asset}.${i}`] ?? LOADED }]));
      putCatalog(db, {
        ...ISSUES_CATALOG, asset, kind: asset === "github_issues" ? "ingest" : asset === "open_issues" ? "sql" : "ts", lastRunId: run.id,
        codeHash: hashes[asset]!, lastLoadedAt: LOADED, ...(inputs.length ? { inputsSeen: seen, reads: inputs, cursor: null } : {}),
        ...o.entries?.[asset],
      });
    }
    db.finishRun(run.id, "succeeded");
    if (o.running) {
      const live = db.createRun({ id: "r_0922_1158_live", trigger: "manual", human: true, argv: ["run", o.running] });
      db.startStep({ runId: live.id, asset: o.running, attempt: 1, reason: "requested" });
    }
  } finally {
    db.close();
  }
  writeFileSync(p.database, "");
  return p;
}

const status = async (p: TestProject) => {
  const r = await cli(["status", "--json"], { cwd: p.root, env: ENV });
  expect(r.exit).toBe(0);
  return { r, a: byAsset(r.json.data) };
};

describe("croft status: staleness", () => {
  test("fresh: every transform built with its code from its inputs' current version; NEXT is after inputs", async () => {
    const { r, a } = await status(await pipeline());
    for (const name of ["github_issues", "open_issues", "issue_triage", "issue_report"]) {
      expect(a[name]).toMatchObject({ status: "ok", stale: false, staleReasons: [], edited: false });
    }
    expect(a.github_issues.next).toEqual({ at: null, reason: "manual" });
    for (const name of ["open_issues", "issue_triage", "issue_report"]) expect(a[name].next).toEqual({ at: null, reason: "after inputs" });
    expect(a.issue_triage.kind).toBe("ts");
    expect(r.json.data.healthy).toBe(true);
    expect(r.json.problems).toEqual([]);
    expect(r.json.next).toEqual([]);
  });

  test("input_changed: an input loaded rows after the transform last read it", async () => {
    const p = await pipeline({ seen: { "open_issues.github_issues": EARLIER, "issue_triage.github_issues": EARLIER } });
    const { r, a } = await status(p);
    expect(a.open_issues).toMatchObject({ status: "ok", stale: true, staleReasons: ["input_changed"], edited: false });
    expect(a.issue_triage).toMatchObject({ stale: true, staleReasons: ["input_changed"] });
    // What a transform reads is known from the definition: issue_report reads open_issues, which did not change.
    expect(a.issue_report).toMatchObject({ stale: false, staleReasons: [] });
    expect(a.github_issues.staleReasons).toEqual([]);
    expect(r.json.data.healthy).toBe(false);
    expect((await cli(["status", "--check", "--json"], { cwd: p.root, env: ENV })).exit).toBe(1);
    expect(r.json.next).toEqual([{ command: "croft run --dry-run", reason: "2 assets are stale (issue_triage, open_issues): see what a run would update and why" }]);
    const human = (await cli(["status"], { cwd: p.root, env: ENV })).stdout;
    expect(human).toMatch(/^open_issues +18,556 +5 min ago +after inputs +ok · stale: inputs changed \(croft run open_issues\)$/m);
  });

  test("input_replaced: an input changed out of band after the transform last read it", async () => {
    const { a } = await status(await pipeline({ entries: { github_issues: { lastReplacedAt: "2026-09-22T18:56:00.000000Z" } } }));
    expect(a.open_issues).toMatchObject({ stale: true, staleReasons: ["input_replaced"] });
    expect(a.issue_triage).toMatchObject({ stale: true, staleReasons: ["input_replaced"] });
  });

  test("code_changed: an SQL transform edited since it was built is stale and edited; EDITED_SINCE_LAST_RUN says the run rebuilds it", async () => {
    const p = await pipeline();
    writeFileSync(join(p.root, "assets/open_issues.sql"), OPEN_SQL.replace("WHERE state = 'open'", "WHERE state <> 'closed'"));
    const { r, a } = await status(p);
    expect(a.open_issues).toMatchObject({ stale: true, staleReasons: ["code_changed"], edited: true });
    // Its readers are not stale until it is rebuilt: their input has not changed yet.
    expect(a.issue_report).toMatchObject({ stale: false });
    expect(r.json.problems).toEqual([expect.objectContaining({
      code: "EDITED_SINCE_LAST_RUN", severity: "warning", asset: "open_issues", file: "assets/open_issues.sql",
      fix: { kind: "command", description: "rebuild open_issues with the new code", command: "croft run open_issues" },
    })]);
    const human = (await cli(["status"], { cwd: p.root, env: ENV })).stdout;
    expect(human).toContain("ok · stale: code changed (croft run open_issues) · edited since its last run");
    expect(human).toContain("EDITED_SINCE_LAST_RUN");
  });

  test("an incremental TS transform edited is forward-only: not stale, and the warning never offers a rebuild", async () => {
    const p = await pipeline({ hashes: { issue_triage: "older-code" }, entries: { issue_triage: { rows: 18_556 } } });
    const { r, a } = await status(p);
    expect(a.issue_triage).toMatchObject({ status: "ok", stale: false, staleReasons: [], edited: true });
    expect(r.json.data.healthy).toBe(true);
    const edited = r.json.problems.find((x: { code: string }) => x.code === "EDITED_SINCE_LAST_RUN");
    expect(edited).toMatchObject({ severity: "warning", asset: "issue_triage", file: "assets/issue_triage.ts" });
    expect(edited.message).toBe("issue_triage edited since its last run; 18,556 rows were built by older code");
    expect(edited.effect).toBe("the next run processes new input rows with the new code");
    expect(JSON.stringify(r.json)).not.toContain("--rebuild");
    expect((await cli(["status"], { cwd: p.root, env: ENV })).stdout).not.toContain("--rebuild");
  });

  test("a full-refresh TS transform edited is stale (code_changed)", async () => {
    const { a } = await status(await pipeline({ hashes: { issue_report: "older-code" } }));
    expect(a.issue_report).toMatchObject({ stale: true, staleReasons: ["code_changed"], edited: true });
  });

  test("a run that already tried the new code: edited is about the last run, the table still needs the rebuild", async () => {
    const p = await pipeline({ hashes: { open_issues: "older-code" } });
    const now = (await codeHashes(p.root)).open_issues!;
    const db = runsDb(p.stateDir, () => new Date("2026-09-22T18:59:00.000Z"));
    try {
      const run = db.createRun({ id: "r_0922_1159_bad2", trigger: "manual", human: true, argv: ["run", "open_issues"], identity: DEAD });
      db.startStep({ runId: run.id, asset: "open_issues", attempt: 1, reason: "code_changed", codeHash: now });
      db.finishStep(run.id, "open_issues", 1, { status: "failed" });
      db.finishRun(run.id, "failed");
    } finally {
      db.close();
    }
    const { r, a } = await status(p);
    expect(a.open_issues).toMatchObject({ status: "failed", stale: true, staleReasons: ["code_changed"], edited: false });
    expect(r.json.problems.map((x: { code: string }) => x.code)).not.toContain("EDITED_SINCE_LAST_RUN");
  });

  /** A later run that skipped `asset` without running its code, recorded as the runner records it: with the code
   *  hash the asset has now (runner.ts startStep), at `attempt` 0 (its input failed) or 1 (it stopped to ask). */
  function skippedRun(p: TestProject, asset: string, o: { attempt: number; codeHash?: string; at?: string }) {
    const db = runsDb(p.stateDir, () => new Date(o.at ?? "2026-09-22T18:59:00.000Z"));
    try {
      const run = db.createRun({ id: `r_0922_1159_skp${o.attempt}`, trigger: "manual", human: true, argv: ["run"], identity: DEAD });
      db.startStep({ runId: run.id, asset, attempt: o.attempt, reason: "requested", ...(o.codeHash ? { codeHash: o.codeHash } : {}) });
      db.finishStep(run.id, asset, o.attempt, { status: "skipped", reason: "requested" });
      db.finishRun(run.id, "failed");
    } finally {
      db.close();
    }
  }

  for (const [why, attempt] of [["its input failed", 0], ["it stopped for a confirmation", 1]] as const) {
    test(`a skipped step never ran the code (${why}): the edit is still since the last run that did`, async () => {
      const p = await pipeline({ hashes: { issue_triage: "older-code" }, entries: { issue_triage: { rows: 18_556 } } });
      skippedRun(p, "issue_triage", { attempt, codeHash: (await codeHashes(p.root)).issue_triage! });
      const { r, a } = await status(p);
      expect(a.issue_triage).toMatchObject({ status: "skipped", stale: false, edited: true });
      const edited = r.json.problems.find((x: { code: string }) => x.code === "EDITED_SINCE_LAST_RUN");
      expect(edited).toMatchObject({ severity: "warning", asset: "issue_triage" });
      expect(edited.message).toBe("issue_triage edited since its last run; 18,556 rows were built by older code");
      expect((await cli(["status"], { cwd: p.root, env: ENV })).stdout).toMatch(/^issue_triage .* skipped · edited since its last run$/m);
    });
  }

  test("a skipped step never ran the code: without a code hash, the file's time is compared with the last run that did", async () => {
    // A file that does not bundle has no code hash.
    const p = await pipeline({ files: { "assets/issue_triage.ts": "export default transform({ inputs: [\n" } });
    const edit = new Date("2026-09-22T18:57:00Z");
    utimesSync(join(p.root, "assets/issue_triage.ts"), edit, edit);
    skippedRun(p, "issue_triage", { attempt: 0 });
    const { a } = await status(p);
    expect(a.issue_triage).toMatchObject({ status: "skipped", edited: true });
  });

  test("a skipped step after a run of the current code: not edited", async () => {
    const p = await pipeline();
    skippedRun(p, "issue_triage", { attempt: 0, codeHash: (await codeHashes(p.root)).issue_triage! });
    const { r, a } = await status(p);
    expect(a.issue_triage).toMatchObject({ status: "skipped", edited: false });
    expect(r.json.problems.map((x: { code: string }) => x.code)).not.toContain("EDITED_SINCE_LAST_RUN");
  });

  test("a transform whose definition no longer loads: edited, but its code is no reason to run (whether it is incremental is unknown)", async () => {
    // Written before anything imports it: this process caches a module it has imported once.
    const p = await pipeline({ files: { "assets/issue_triage.ts": `${TRIAGE_TS}throw new Error("top-level boom");\n` }, hashes: { issue_triage: "older-code" } });
    const { r, a } = await status(p);
    expect(a.issue_triage).toMatchObject({ kind: "ts", status: "ok", stale: false, staleReasons: [], edited: true });
    expect(r.json.problems.map((x: { code: string }) => x.code)).not.toContain("EDITED_SINCE_LAST_RUN");
  });

  test("an asset being run right now is not stale", async () => {
    const { a } = await status(await pipeline({ seen: { "open_issues.github_issues": EARLIER }, running: "open_issues" }));
    expect(a.open_issues).toMatchObject({ status: "running", stale: false, staleReasons: [], edited: false });
  });

  test("a TS transform never run: its kind comes from its definition, and NEXT is after inputs", async () => {
    const p = makeProject({ files: { "assets/github_issues.ts": ISSUES_TS, "assets/issue_triage.ts": TRIAGE_TS } });
    const { a } = await status(p);
    expect(a.issue_triage).toMatchObject({ kind: "ts", status: "never_run", stale: true, staleReasons: ["never_built"], next: { reason: "after inputs" } });
  });

  test("a project whose files cannot all be resolved still gets its status", async () => {
    const p = await pipeline();
    // At the time of writing resolveProject throws a raw SyntaxError on this SQL (sql/gate.ts reads DuckDB's
    // `Infinity` as JSON); whatever resolving does with it, status answers from the catalog and the files.
    writeFileSync(join(p.root, "assets/open_issues.sql"), "-- key: id\nSELECT 1e400 AS id FROM github_issues\n");
    const { r, a } = await status(p);
    expect(a.github_issues).toMatchObject({ status: "ok" });
    expect(a.open_issues).toMatchObject({ status: "ok", kind: "sql" });
    expect(r.json.ok).toBe(true);
  });
});

describe("helpers", () => {
  test("schemaChangesFromRuns reads the run engine's stored result ({data: {steps}}) and a bare {steps}", () => {
    const p = makeProject({ files: {} });
    const db = runsDb(p.stateDir);
    try {
      const engine = db.createRun({ trigger: "manual", human: true, argv: ["run", "a"] });
      db.finishRun(engine.id, "succeeded", {
        data: { runId: engine.id, status: "succeeded", steps: [{ asset: "a", schemaChanges: [{ kind: "add_column", column: "x", type: "BIGINT" }] }] },
        problems: [], next: [], exit: 0, ok: true,
      });
      const bare = db.createRun({ trigger: "manual", human: true, argv: ["run", "b"] });
      db.finishRun(bare.id, "succeeded", { steps: [{ asset: "b", schemaChanges: [{ kind: "widen", column: "y", from: "INTEGER", to: "BIGINT" }] }] });
      const live = db.createRun({ trigger: "manual", human: true, argv: ["run", "c"] });
      db.setRunProgress(live.id, { asset: "c", phase: "extract", rowsFetched: 5, requests: 1, elapsedMs: 10 });
      const changes = schemaChangesFromRuns(db, new Date(0));
      expect(changes.map((c) => [c.asset, c.change.column])).toEqual(expect.arrayContaining([["a", "x"], ["b", "y"]]));
      expect(changes).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test("ago", () => {
    const now = new Date("2026-09-22T19:00:00Z");
    expect(ago("2026-09-22T18:59:48Z", now)).toBe("12 s ago");
    expect(ago("2026-09-22T11:55:00.123456-07:00", now)).toBe("5 min ago");
    expect(ago("2026-09-22T16:00:00Z", now)).toBe("3 h ago");
    expect(ago("2026-09-20T19:00:00Z", now)).toBe("2 days ago");
    expect(ago(null, now)).toBe("—");
  });

  test("staleText: the reasons a run would update an asset, in words; never built is the head's to say", () => {
    expect(staleText(["code_changed", "input_changed"])).toBe("stale: code changed, inputs changed");
    expect(staleText(["input_replaced"])).toBe("stale: an input was replaced");
    expect(staleText(["never_built"])).toBeNull();
    expect(staleText([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------
// Scheduling (phase 3, §8): NEXT, held, the scheduling line and SCHEDULER_STALE. The scheduler's view
// (schedule/due.ts, another builder's) is a fake: `croft status` runs through runStatus with it.

describe("croft status: scheduling", () => {
  const SCHEDULED_TS = ISSUES_TS.replace('key: "id",', 'key: "id",\n  schedule: "every hour",');
  // NOW is 12:00 in Los Angeles: the hourly ingest fires next at 13:00.
  const NEXT_FIRE = "2026-09-22T20:00:00.000Z";

  function view(o: { held?: Record<string, { code: HoldCode; reason: string }>; next?: string | null } = {}): AssetScheduleView[] {
    const base = { lastFireAt: null, lastAttemptAt: null, due: false, dueReason: null };
    return [
      { ...base, asset: "github_issues", kind: "ingest", schedule: { text: "every hour", cron: "0 * * * *" }, nextFireAt: o.next === undefined ? NEXT_FIRE : o.next,
        lastFireAt: "2026-09-22T19:00:00.000Z", held: o.held?.github_issues ?? null },
      ...(["open_issues", "issue_triage", "issue_report"] as const).map((asset) => ({
        ...base, asset, kind: asset === "open_issues" ? "sql" as const : "ts" as const, schedule: null, nextFireAt: null, held: o.held?.[asset] ?? null,
      })),
    ];
  }

  function statusCommand(d: StatusDeps): Command {
    const spec = COMMANDS.find((c) => c.name === "status")!;
    const { load: _load, ...rest } = spec;
    return { ...rest, run: (ctx) => runStatus(ctx, d), human: statusImpl.human!.bind(statusImpl) };
  }

  const never: ScheduleViewFn = async () => {
    throw new Error("the scheduler's view must not be read while scheduling is off");
  };

  function run(p: TestProject, argv: string[], d: StatusDeps, env: Record<string, string> = ENV) {
    return cli(["status", ...argv], { cwd: p.root, env, commands: [statusCommand(d)] });
  }

  function turnOn(p: TestProject, o: { via?: "os-job" | "serve"; since?: string; heartbeat?: string; paused?: string | null } = {}) {
    const db = runsDb(p.stateDir);
    try {
      db.setScheduling(o.paused !== undefined ? { state: "paused", via: o.via ?? "os-job", pausedUntil: o.paused } : { state: "on", via: o.via ?? "os-job" });
      db.setSetting(SINCE_KEY, o.since ?? "2026-09-22T18:00:00.000Z");
      if (o.heartbeat) db.heartbeat(o.heartbeat);
    } finally {
      db.close();
    }
  }

  test("off: a scheduled ingest's NEXT says its schedule is off, and the scheduler's view is not read", async () => {
    const p = await pipeline({ files: { "assets/github_issues.ts": SCHEDULED_TS } });
    const r = await run(p, ["--json"], { scheduleView: never });
    expect(r.exit).toBe(0);
    const a = byAsset(r.json.data);
    expect(a.github_issues.next).toEqual({ at: null, reason: "scheduling off", schedule: "every hour" });
    expect(a.open_issues.next).toEqual({ at: null, reason: "after inputs" });
    expect(r.json.data.scheduling).toEqual({ state: "off", via: null, lastTickAt: null });
    expect(r.json.data.healthy).toBe(true);
    expect(r.json.problems).toEqual([]);
    const human = await run(p, [], { scheduleView: never });
    expect(human.stdout).toMatch(/^github_issues +18,556 +5 min ago +every hour \(off\) +ok$/m);
  });

  test("on and ticking: NEXT is the next fire; the scheduling line has the last tick", async () => {
    const p = await pipeline({ files: { "assets/github_issues.ts": SCHEDULED_TS } });
    turnOn(p, { heartbeat: "2026-09-22T18:59:48.000Z" });
    const r = await run(p, ["--json"], { scheduleView: async () => view() });
    expect(r.exit).toBe(0);
    const d = r.json.data;
    expect(d.scheduling).toEqual({ state: "on", via: "os-job", lastTickAt: "2026-09-22T11:59:48-07:00", stale: false });
    const a = byAsset(d);
    expect(a.github_issues).toMatchObject({ next: { at: "2026-09-22T13:00:00-07:00", reason: "schedule", schedule: "every hour" }, held: false });
    expect(a.github_issues).not.toHaveProperty("hold");
    expect(a.issue_report.next).toEqual({ at: null, reason: "after inputs" });
    expect(d.healthy).toBe(true);
    expect(r.json.problems).toEqual([]);
    const human = (await run(p, [], { scheduleView: async () => view() })).stdout;
    expect(human).toMatch(/^github_issues +18,556 +5 min ago +in 60 min +ok$/m);
    expect(human.trimEnd().split("\n").at(-1)).toBe("Scheduling on · last tick 12 s ago · 0 running");
  });

  test("held: SCHEDULE_HELD with its reason; --check counts it; next says the run that releases it", async () => {
    const p = await pipeline({ files: { "assets/github_issues.ts": SCHEDULED_TS } });
    turnOn(p, { heartbeat: "2026-09-22T18:59:48.000Z" });
    const held = { issue_triage: { code: "SCHEDULE_HELD" as const, reason: "code edited 12 min ago, not run by hand yet" },
      open_issues: { code: "leased" as const, reason: "running in r_0922_1159_abcd" } };
    const d: StatusDeps = { scheduleView: async () => view({ held }) };
    const r = await run(p, ["--json"], d);
    const a = byAsset(r.json.data);
    expect(a.issue_triage).toMatchObject({ held: true, hold: held.issue_triage, status: "ok" });
    // Holds that pass by themselves (a lease, a pause, a backoff) are shown but are not "held".
    expect(a.open_issues).toMatchObject({ held: false, hold: held.open_issues });
    expect(r.json.data.healthy).toBe(false);
    expect(r.json.problems).toEqual([expect.objectContaining({
      severity: "warning", code: "SCHEDULE_HELD", asset: "issue_triage",
      message: "issue_triage is held from the scheduler: code edited 12 min ago, not run by hand yet",
      fix: expect.objectContaining({ kind: "command", command: "croft run issue_triage" }),
    })]);
    expect(r.json.next).toEqual([{ command: "croft run issue_triage", reason: "releases it for the scheduler (code edited 12 min ago, not run by hand yet)" }]);
    expect((await run(p, ["--check", "--json"], d)).exit).toBe(1);
    const human = (await run(p, [], d)).stdout;
    expect(human).toMatch(/^issue_triage +18,556 +5 min ago +after inputs +held: code edited 12 min ago, not run by hand yet \(croft run issue_triage\)$/m);
  });

  test("stale: SCHEDULER_STALE (a warning) with the diagnosis and the tick log; not healthy", async () => {
    const p = await pipeline({ files: { "assets/github_issues.ts": SCHEDULED_TS } });
    turnOn(p, { via: "serve", heartbeat: "2026-09-22T18:50:00.000Z" });
    mkdirSync(join(p.stateDir, "logs"), { recursive: true });
    writeFileSync(join(p.stateDir, "logs", "tick.log"), "── 2026-09-22T18:50:00.000Z croft serve (pid 99) starts croft tick\n");
    const d: StatusDeps = { scheduleView: async () => view() };
    const r = await run(p, ["--json"], d);
    expect(r.exit).toBe(0);
    expect(r.json.data.scheduling).toEqual({ state: "on", via: "serve", lastTickAt: "2026-09-22T11:50:00-07:00", stale: true });
    expect(r.json.data.healthy).toBe(false);
    const stale = r.json.problems.find((x: { code: string }) => x.code === "SCHEDULER_STALE");
    expect(stale).toMatchObject({ severity: "warning", details: { cause: "serve_not_running", via: "serve", quietForMs: 600_000 } });
    expect(stale.message).toBe("the scheduler has not ticked for 10 min (last tick 2026-09-22T11:50:00-07:00): scheduling is on for croft serve only (croft schedule on --no-os-job), and croft serve is not running");
    expect((await run(p, ["--check", "--json"], d)).exit).toBe(1);
    const human = (await run(p, [], d)).stdout;
    expect(human).toContain("Scheduling on · last tick 10 min ago (stale) · 0 running\n");
    expect(human).toContain(`  ${join(p.stateDir, "logs", "tick.log")}, last lines:\n    ── 2026-09-22T18:50:00.000Z croft serve (pid 99) starts croft tick\n`);
    expect(human).toContain("warn  SCHEDULER_STALE  the scheduler has not ticked for 10 min");
  });

  test("paused: NEXT says paused; the scheduling line says until when", async () => {
    const p = await pipeline({ files: { "assets/github_issues.ts": SCHEDULED_TS } });
    turnOn(p, { paused: "2026-09-22T21:00:00.000Z", heartbeat: "2026-09-22T17:00:00.000Z" });
    const d: StatusDeps = { scheduleView: async () => view() };
    const r = await run(p, ["--json"], d);
    expect(r.json.data.scheduling).toEqual({ state: "paused", via: "os-job", lastTickAt: "2026-09-22T10:00:00-07:00", pausedUntil: "2026-09-22T14:00:00-07:00" });
    expect(byAsset(r.json.data).github_issues.next).toEqual({ at: null, reason: "paused", schedule: "every hour" });
    expect(r.json.data.healthy).toBe(true);
    const human = (await run(p, [], d)).stdout;
    expect(human).toMatch(/^github_issues +18,556 +5 min ago +paused +ok$/m);
    expect(human.trimEnd().split("\n").at(-1)).toBe("Scheduling paused until 14:00 · last tick 2 h ago · 0 running");
  });

  test("paused with no end: the line names the command that resumes it, --no-os-job for croft serve only (R32-10)", async () => {
    const p = await pipeline({ files: { "assets/github_issues.ts": SCHEDULED_TS } });
    const d: StatusDeps = { scheduleView: async () => view() };
    turnOn(p, { paused: null, heartbeat: "2026-09-22T17:00:00.000Z" });
    expect((await run(p, [], d)).stdout.trimEnd().split("\n").at(-1)).toBe("Scheduling paused until croft schedule on · last tick 2 h ago · 0 running");
    turnOn(p, { via: "serve", paused: null });
    expect((await run(p, [], d)).stdout.trimEnd().split("\n").at(-1))
      .toBe("Scheduling paused until croft schedule on --no-os-job · last tick 2 h ago · 0 running");
  });

  test("the scheduler's view failing: NEXT comes from the schedule itself, with a warning", async () => {
    const p = await pipeline({ files: { "assets/github_issues.ts": SCHEDULED_TS } });
    turnOn(p, { heartbeat: "2026-09-22T18:59:48.000Z" });
    const r = await run(p, ["--json"], { scheduleView: async () => { throw new Error("no such table: schedule_state"); } });
    expect(r.exit).toBe(0);
    expect(byAsset(r.json.data).github_issues.next).toEqual({ at: "2026-09-22T13:00:00-07:00", reason: "schedule", schedule: "every hour" });
    expect(r.json.problems).toEqual([expect.objectContaining({ code: "INTERNAL_ERROR", severity: "warning" })]);
    expect(r.json.problems[0].message).toContain("no such table: schedule_state");
  });
});

// The read copy (readCopy on, §5; R32-11): where it is and how current, in data.readCopy and a line under the
// scheduling line. A refresh that failed, or a copy older than the last run that wrote data, is a warning whose
// hint names .croft/readcopy.log. It is not an asset's health: `healthy` does not change.
describe("croft status: the read copy (R32-11)", () => {
  async function readCopyProject(): Promise<TestProject> {
    const p = await scenario();
    writeFileSync(join(p.root, "croft.json"), JSON.stringify({ database: "warehouse.duckdb", timezone: "America/Los_Angeles", readCopy: true }));
    return p;
  }

  /** The read copy's lines: the one under the scheduling line, and a warning's hint (next[] follows them). */
  async function copyLines(p: TestProject): Promise<string[]> {
    const lines = (await cli(["status"], { cwd: p.root, env: ENV })).stdout.split("\n");
    const i = lines.findIndex((l) => l.startsWith("Read copy "));
    expect(lines[i - 1]).toStartWith("Scheduling off");
    return lines.slice(i, lines[i + 1]?.startsWith("  hint: ") ? i + 2 : i + 1);
  }

  function copyAt(p: TestProject, iso: string): void {
    const f = join(p.root, "warehouse.read.duckdb");
    writeFileSync(f, "a copy");
    utimesSync(f, new Date(iso), new Date(iso));
  }

  /** The readCopy setting a refresh leaves, covering the last run that wrote data unless `extra` says otherwise. */
  function refreshedAt(p: TestProject, iso: string, extra: Record<string, unknown> = {}): void {
    const db = runsDb(p.stateDir);
    try {
      const last = db.sqlite.query(`SELECT id AS runId, finished_at AS at FROM runs WHERE status <> 'running' AND finished_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM steps s WHERE s.run_id = runs.id AND s.status = 'ok') ORDER BY finished_at DESC, id DESC LIMIT 1`).get();
      db.setSetting("readCopy", { requested: 1, holder: null, refreshedAt: iso, method: "clone", heldMs: 1, covers: last, lastError: null, ...extra });
    } finally {
      db.close();
    }
  }

  test("off: no readCopy in data, no line (the golden shape has none)", async () => {
    const p = await scenario();
    const r = await cli(["status", "--json"], { cwd: p.root, env: ENV });
    expect(r.json.data).not.toHaveProperty("readCopy");
    expect((await cli(["status"], { cwd: p.root, env: ENV })).stdout).not.toContain("Read copy");
  });

  test("current: its path and time in data.readCopy and on the last line", async () => {
    const p = await readCopyProject();
    copyAt(p, "2026-09-22T18:58:00.000Z");
    refreshedAt(p, "2026-09-22T18:58:00.000Z");
    const r = await cli(["status", "--json"], { cwd: p.root, env: ENV });
    expect(Object.keys(r.json.data)).toEqual(["healthy", "running", "assets", "scheduling", "readCopy"]);
    expect(r.json.data.readCopy).toMatchObject({
      path: join(p.root, "warehouse.read.duckdb"), exists: true, asOf: "2026-09-22T11:58:00-07:00", refreshedAt: "2026-09-22T11:58:00-07:00",
      method: "clone", lastError: null, health: "ok", log: join(p.stateDir, "readcopy.log"),
    });
    expect(await copyLines(p)).toEqual(["Read copy warehouse.read.duckdb · as of 11:58 (2 min ago)"]);
  });

  test("a refresh that failed: a warning line and a hint naming .croft/readcopy.log; healthy is unchanged", async () => {
    const p = await readCopyProject();
    const before = (await cli(["status", "--json"], { cwd: p.root, env: ENV })).json.data.healthy;
    copyAt(p, "2026-09-22T17:00:00.000Z");
    const message = "the read copy was not refreshed: /bin/cp could not copy the warehouse: cp: warehouse.read.duckdb: No space left on device";
    refreshedAt(p, "2026-09-22T17:00:00.000Z", { lastError: { at: "2026-09-22T18:55:00.000Z", code: null, message } });
    const r = await cli(["status", "--json"], { cwd: p.root, env: ENV });
    expect(r.json.data.readCopy).toMatchObject({ health: "failed", lastError: { at: "2026-09-22T11:55:00-07:00", code: null, message } });
    expect(r.json.data.healthy).toBe(before);
    expect(await copyLines(p)).toEqual([
      "Read copy warehouse.read.duckdb · as of 10:00 (2 h ago) · the last refresh failed 5 min ago: /bin/cp could not copy the warehouse: cp: warehouse.read.duckdb: No space left on device",
      "  hint: fix what .croft/readcopy.log says (free disk space, for example); the next croft run that writes data refreshes the copy",
    ]);
  });

  test("older than the last run that wrote data: a warning", async () => {
    const p = await readCopyProject();
    copyAt(p, "2026-09-22T17:00:00.000Z");
    refreshedAt(p, "2026-09-22T17:00:00.000Z", { covers: { runId: "r_0922_0959_old1", at: "2026-09-22T16:59:00.000Z" } });
    const r = await cli(["status", "--json"], { cwd: p.root, env: ENV });
    expect(r.json.data.readCopy).toMatchObject({ health: "behind", lastWrite: { runId: expect.stringMatching(/^r_/) } });
    const [line, hint] = await copyLines(p);
    expect(line).toStartWith("Read copy warehouse.read.duckdb · as of 10:00 (2 h ago), older than the last run that wrote data (r_");
    expect(hint).toBe("  hint: the next croft run that writes data refreshes the copy; no refresh followed that run (readCopy was off then, or the refresh was cut short; .croft/readcopy.log has each failure)");
  });
});
