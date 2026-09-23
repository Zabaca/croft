// Test fixtures for the read-only and utility commands (query, status, describe, context, logs, secrets,
// confirm): temp projects that import "@zabaca/croft" like a user's, a warehouse seeded with _croft state
// through a private DuckDB instance (closed again, so croft's own read-only instance can open it), runs.sqlite
// rows, and a main() runner that captures output. Not imported by any command.
import { DuckDBInstance } from "@duckdb/node-api";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { STATE_DDL } from "../../db/state.ts";
import { closeAllWarehouses } from "../../db/warehouse.ts";
import { type CatalogAsset, putCatalog } from "../../history/catalog.ts";
import { RunsDb } from "../../history/runs-db.ts";
import { problem } from "../../core/errors.ts";
import { loadProject, type Project } from "../../project/root.ts";
import type { Command } from "../command.ts";
import { main, type MainIO } from "../main.ts";
import { COMMANDS } from "./index.ts";

export const PKG = resolve(import.meta.dir, "../../..");
export const SRC = resolve(import.meta.dir, "../..");

const made: string[] = [];

export interface TestProject { root: string; project: Project; database: string; stateDir: string }

/** A project folder: croft.json, node_modules/@zabaca/croft linked to this package, and `files` written. */
export function makeProject(o: { timezone?: string; files?: Record<string, string> } = {}): TestProject {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-inspect-")));
  made.push(root);
  writeFileSync(join(root, "croft.json"), JSON.stringify({ database: "warehouse.duckdb", timezone: o.timezone ?? "America/Los_Angeles" }));
  mkdirSync(join(root, "node_modules", "@zabaca"), { recursive: true });
  symlinkSync(PKG, join(root, "node_modules", "@zabaca", "croft"));
  for (const d of ["assets", "files", ".croft"]) mkdirSync(join(root, d), { recursive: true });
  writeFiles(root, o.files ?? {});
  const project = loadProject({ root });
  return { root, project, database: project.paths.database, stateDir: project.paths.stateDir };
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

/** Run statements on the warehouse with a private read-write instance, then close it (releasing the lock). */
export async function seed(database: string, statements: string[]): Promise<void> {
  const db = await DuckDBInstance.create(database, { access_mode: "READ_WRITE" });
  const c = await db.connect();
  try {
    for (const s of statements) await c.run(s);
  } finally {
    c.disconnectSync();
    db.closeSync();
  }
}

/** The _croft schema as croft creates it, at format 2. */
export const STATE: string[] = [...STATE_DDL, `INSERT INTO _croft.meta VALUES ('format_version', '2'), ('croft_version', 'test')`];

export const ISSUES_TS = `import { ingest } from "@zabaca/croft";
export default ingest({
  description: "Issues of oven-sh/bun",
  secrets: ["GITHUB_TOKEN"],
  key: "id",
  incremental: "updated_at",
  checks: ["not_null(title)", "state IN ('open', 'closed')"],
  async *rows() { yield []; },
});
`;

export const CHARGES_TS = `import { ingest } from "@zabaca/croft";
export default ingest({
  secrets: ["STRIPE_KEY"],
  key: "id",
  incremental: { field: "created", unit: "s", lookback: "30 days" },
  checks: ["amount >= 0"],
  async *rows() { yield []; },
});
`;

export const OPEN_SQL = `-- assets/open_issues.sql
-- description: Open issues with their author
-- key: id
-- check: not_null(author)
-- warn: id > 0
SELECT id, title, "user"->>'login' AS author FROM github_issues WHERE state = 'open'
`;

/** A warehouse holding github_issues (3 rows, two JSON columns) with its _croft state and two writes. */
export const ISSUES_SEED: string[] = [
  ...STATE,
  `CREATE TABLE github_issues (id BIGINT, title VARCHAR, state VARCHAR, labels JSON, "user" JSON, updated_at TIMESTAMPTZ, _loaded_at TIMESTAMPTZ)`,
  `INSERT INTO github_issues VALUES
     (1, 'Crash on Windows', 'open', '[{"name":"bug","color":"red"}]', '{"login":"jarred","id":7}', '2026-09-20 10:00:00+00', '2026-09-22 17:00:00+00'),
     (2, 'Docs typo', 'closed', '[]', '{"login":"dylan","id":8,"site_admin":false}', '2026-09-21 10:00:00+00', '2026-09-22 17:00:00+00'),
     (3, 'Faster installs', 'open', NULL, '{"login":"jarred","id":7}', '2026-09-22 10:00:00+00', '2026-09-22 18:00:00+00')`,
  `INSERT INTO _croft.assets VALUES ('github_issues', 'ingest', 'merge', ['id'], 'hash-1', 'behavior-1', '2026-09-22T10:00:00Z', 'timestamp', NULL,
     '2026-09-22 18:00:00+00', NULL, 3, '2026-09-22 18:00:00+00', '2026-09-22 18:00:00+00')`,
  `INSERT INTO _croft.columns VALUES
     ('github_issues', 'id', 'BIGINT', 'id', NULL, false, false, ['integer'], true, '2026-09-22 17:00:00+00'),
     ('github_issues', 'title', 'VARCHAR', 'title', NULL, false, false, ['string'], true, '2026-09-22 17:00:00+00'),
     ('github_issues', 'state', 'VARCHAR', 'state', NULL, false, false, ['string'], true, '2026-09-22 17:00:00+00'),
     ('github_issues', 'labels', 'JSON', 'labels', NULL, false, false, ['array'], true, '2026-09-22 17:00:00+00'),
     ('github_issues', 'user', 'JSON', 'user', NULL, false, false, ['object'], true, '2026-09-22 17:00:00+00'),
     ('github_issues', 'updated_at', 'TIMESTAMPTZ', 'updated_at', NULL, false, false, ['iso_instant'], true, '2026-09-22 18:00:00+00')`,
  `INSERT INTO _croft.writes VALUES
     ('github_issues', '2026-09-22 17:00:00+00', 'r_0922_1000_aaaa', 'merge', 2, 2, 0, 0, 0, NULL, '2026-09-21T10:00:00Z', NULL, NULL, '[]', 'hash-1', 1),
     ('github_issues', '2026-09-22 18:00:00+00', 'r_0922_1100_bbbb', 'merge', 2, 1, 0, 1, 0, '2026-09-21T10:00:00Z', '2026-09-22T10:00:00Z', '2026-09-21T09:59:59Z', NULL,
      '[{"kind":"add_column","column":"updated_at","type":"TIMESTAMPTZ"}]', 'hash-1', 1)`,
];

export interface CliResult { exit: number; stdout: string; stderr: string; json: any }

/** Run croft in this process. Off a TTY, with an empty shell environment unless `env` is given. */
export async function cli(argv: string[], o: { cwd: string; env?: Record<string, string | undefined>; commands?: readonly Command[] } & Partial<MainIO>): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const { cwd, env, commands, ...io } = o;
  const exit = await main(argv, {
    cwd, env: env ?? {}, stdinTTY: false, stdoutTTY: false, stderrTTY: false, commands: commands ?? COMMANDS,
    stdout: (t) => out.push(t), stderr: (t) => err.push(t), ...io,
  });
  const stdout = out.join("");
  let json: unknown = null;
  if (argv.includes("--json")) json = JSON.parse(stdout);
  return { exit, stdout, stderr: err.join(""), json };
}

export function runsDb(stateDir: string, now?: () => Date): RunsDb {
  return RunsDb.open(stateDir, now ? { now } : {});
}

/** A process identity that is certainly not running. */
export const DEAD = { pid: 999_999, procStart: "0", bootId: "no-such-boot" };

/** The clock the scenario's runs.sqlite rows were written with; pass as CROFT_NOW so "ago" is stable. */
export const NOW = "2026-09-22T19:00:00.000Z";

export const ISSUES_CATALOG: CatalogAsset = {
  asset: "github_issues", kind: "ingest", behavior: "updates rows by id; fetches issues updated after the saved position",
  write: "merge", key: ["id"], rows: 18_556,
  columns: [
    { name: "id", type: "BIGINT", sourceName: "id", pinned: false, pending: false, format: null },
    { name: "title", type: "VARCHAR", sourceName: "title", pinned: false, pending: false, format: null },
    { name: "user", type: "JSON", sourceName: "user", pinned: false, pending: false, format: null, jsonKeys: ["id", "login"] },
    { name: "_loaded_at", type: "TIMESTAMPTZ", sourceName: null, pinned: false, pending: false, format: null },
  ],
  cursor: { field: "updated_at", value: "2026-09-22T17:58:03Z", type: "timestamp", unit: null },
  lastLoadedAt: "2026-09-22T18:55:00.000000Z", lastReplacedAt: null, lastRunId: "r_0922_1155_ok01", codeHash: "hash-1",
};

/**
 * runs.sqlite for a busy project, as the run engine would leave it:
 * - github_issues: ok 5 minutes ago (catalog: 18,556 rows), and a schema change in that run's summary;
 * - stripe_charges: its last step failed with CHECK_FAILED;
 * - sales: a live run (this test process) is extracting it right now;
 * - taxi_zones: its run's process is gone while the step still says running (crashed); catalog says 2 files gone;
 * - old_orders: a catalog entry whose asset file was deleted;
 * - open_issues.sql: never run.
 */
export function busyScenario(stateDir: string): void {
  let clock = Date.parse("2026-09-22T18:50:00.000Z");
  const db = runsDb(stateDir, () => new Date(clock));
  try {
    const ok = db.createRun({ id: "r_0922_1155_ok01", trigger: "manual", human: true, argv: ["run", "github_issues"], identity: DEAD });
    db.startStep({ runId: ok.id, asset: "github_issues", attempt: 1, reason: "requested" });
    clock += 5 * 60_000;
    db.finishStep(ok.id, "github_issues", 1, { status: "ok", rows: { in: 212, added: 200, updated: 12 } });
    db.finishRun(ok.id, "succeeded", {
      steps: [{ asset: "github_issues", status: "ok", schemaChanges: [{ kind: "add_column", column: "milestone", type: "JSON" }] }],
    });
    putCatalog(db, ISSUES_CATALOG);

    const bad = db.createRun({ id: "r_0922_1156_bad1", trigger: "manual", human: true, argv: ["run", "stripe_charges"], identity: DEAD });
    db.startStep({ runId: bad.id, asset: "stripe_charges", attempt: 1, reason: "requested" });
    db.finishStep(bad.id, "stripe_charges", 1, {
      status: "failed", error: problem("CHECK_FAILED", { message: "amount >= 0: 2 rows fail", hint: "fix the rows", asset: "stripe_charges" }),
    });
    db.finishRun(bad.id, "failed");
    putCatalog(db, { ...ISSUES_CATALOG, asset: "stripe_charges", rows: 1130, columns: [], lastRunId: "r_0922_1100_prev", cursor: null, behavior: "" });

    clock += 60_000;
    const live = db.createRun({ id: "r_0922_1157_live", trigger: "manual", human: true, argv: ["run", "sales"] });
    db.sqlite.query("UPDATE runs SET summary = ? WHERE id = ?")
      .run(JSON.stringify({ progress: { asset: "sales", phase: "extract", rowsFetched: 61_200, requests: 612, elapsedMs: 100_000 } }), live.id);
    db.startStep({ runId: live.id, asset: "sales", attempt: 1, reason: "requested" });

    const gone = db.createRun({ id: "r_0922_1157_gone", trigger: "schedule", human: false, argv: ["run", "--due"], identity: DEAD });
    db.startStep({ runId: gone.id, asset: "taxi_zones", attempt: 1, reason: "schedule_due" });
    putCatalog(db, { ...ISSUES_CATALOG, asset: "taxi_zones", rows: 265, columns: [], cursor: null, filesGone: ["files/zones/2025.csv", "files/zones/2024.csv"] });

    putCatalog(db, { ...ISSUES_CATALOG, asset: "old_orders", rows: 120, columns: [], cursor: null, lastRunId: "r_0101_0000_old1" });
  } finally {
    db.close();
  }
}

export const SCENARIO_FILES: Record<string, string> = {
  "assets/github_issues.ts": ISSUES_TS,
  "assets/stripe_charges.ts": CHARGES_TS,
  "assets/sales.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ file: "files/sales/*.csv", incremental: true, key: "order_id" });\n`,
  "assets/taxi_zones.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ file: "files/zones/*.csv", key: "LocationID" });\n`,
  "assets/open_issues.sql": OPEN_SQL,
};

/** The type skeleton of a JSON value: what golden tests freeze. Arrays show the shape of their first item. */
export function shape(v: unknown): unknown {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
  if (typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, shape(x)]));
  return typeof v;
}

export async function cleanup(): Promise<void> {
  await closeAllWarehouses();
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}
