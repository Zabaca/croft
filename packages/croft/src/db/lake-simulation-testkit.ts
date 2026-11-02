// A lake that lives for weeks in a few seconds (DESIGN.md D152; option 07, slice 3): hourly runs over five assets written the way the lake spike
// wrote them (a few rows inlined in the catalog, a merge of 50 rows, and a full refresh), each snapshot said to have been made at the hour of its
// run (the lake clock of lake-testkit.ts), and croft's maintenance pass run at the times a test says, with `now` the simulated time. It gives
// the acceptance test of the week and scripts/simulate-lake-maintenance.ts (the numbers in the pull request) the same lake.
// Test support, left out of the published package (package.json "files").
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { MAINTENANCE_LOCK_LABEL } from "./lake.ts";
import { type LakeStats, lakeStats, type PassReport, runPass } from "./lake-maintenance.ts";
import type { TestLake } from "./lake-testkit.ts";

const HOUR = 3_600_000;

/** How the full-refresh asset is written: `replace`, as the spike did (CREATE OR REPLACE TABLE: a new lake table each run), or `in place`,
 *  as croft's own full refresh is (a table whose shape is kept has its rows changed, D146). */
export type FullRefresh = "replace" | "in place";

export interface SimulationOptions {
  /** The time of the first run, and how many hourly runs. */
  start: Date;
  hours: number;
  fullRefresh: FullRefresh;
  /** A pass is made after every this many hours, with `now` as that hour. Omit for none. */
  maintainEveryHours?: number;
  /** Called after each pass. */
  onPass?: (p: { at: Date; report: PassReport }) => void;
  /** The retry policy of a pass. */
  retry?: { attempts: number; baseMs: number };
}

export interface SimulationResult {
  /** The lake's counts after the last run, before any pass (when a pass was made, the counts just before the first). */
  firstPassBefore: LakeStats | null;
  passes: PassReport[];
  commits: number;
  /** The simulated time of the last run. */
  end: Date;
}

/** The five assets of the spike's week. */
export async function createSimulatedAssets(l: TestLake): Promise<void> {
  await l.w.write("assets", async (tx) => {
    // The bookkeeping rows of a step, in a schema of their own: croft's own _croft is made by the warehouse, in the log form.
    await tx.exec("CREATE SCHEMA IF NOT EXISTS bk");
    await tx.exec("CREATE TABLE IF NOT EXISTS bk.writes (asset VARCHAR, loaded_at TIMESTAMPTZ, run_id VARCHAR, rows_in BIGINT, added BIGINT, updated BIGINT)");
    await tx.exec("CREATE TABLE IF NOT EXISTS bk.assets_log (name VARCHAR, row_count BIGINT, last_loaded_at TIMESTAMPTZ, written_at TIMESTAMPTZ)");
    for (const t of ["tiny_a", "tiny_b", "inc_a", "inc_b"]) await tx.exec(`CREATE TABLE ${t} (id BIGINT, v DOUBLE, _loaded_at TIMESTAMPTZ)`);
    await tx.exec("CREATE TABLE full_r AS SELECT range AS id, 0.0::DOUBLE AS v, now() AS _loaded_at FROM range(2000)");
  }, { runId: "r_setup" });
}

/** One hourly run of the five assets: a commit each, with the bookkeeping rows a croft step writes. */
export async function simulatedRun(l: TestLake, h: number, fullRefresh: FullRefresh): Promise<number> {
  const run = `r${h}`;
  const book = async (tx: { exec(sql: string): Promise<void> }, asset: string) => {
    await tx.exec(`INSERT INTO bk.writes VALUES ('${asset}', now(), '${run}', 50, 25, 25)`);
    await tx.exec(`INSERT INTO bk.assets_log SELECT '${asset}', count(*), max(_loaded_at), now() FROM ${asset}`);
  };
  let commits = 0;
  const write = async (asset: string, body: (tx: { exec(sql: string): Promise<void> }) => Promise<void>) => {
    await l.w.write(asset, async (tx) => {
      await body(tx);
      await book(tx, asset);
    }, { runId: run, asset });
    commits++;
  };
  for (const a of ["tiny_a", "tiny_b"]) await write(a, (tx) => tx.exec(`INSERT INTO ${a} SELECT ${h} * 5 + range, random(), now() FROM range(5)`));
  for (const a of ["inc_a", "inc_b"]) {
    await write(a, (tx) => tx.exec(`MERGE INTO ${a} t USING (SELECT (${h} * 25 + range)::BIGINT id, random() v FROM range(50)) s ON t.id = s.id
      WHEN MATCHED THEN UPDATE SET v = s.v, _loaded_at = now() WHEN NOT MATCHED THEN INSERT VALUES (s.id, s.v, now())`));
  }
  await write("full_r", (tx) => fullRefresh === "replace"
    ? tx.exec(`CREATE OR REPLACE TABLE full_r AS SELECT range AS id, ${h}::DOUBLE AS v, now() AS _loaded_at FROM range(2000)`)
    : tx.exec(`UPDATE full_r SET v = ${h}::DOUBLE, _loaded_at = now()`));
  return commits;
}

/** Hourly runs from `start`, each hour's snapshots stamped with its time; a pass every so often. */
export async function simulate(l: TestLake, o: SimulationOptions): Promise<SimulationResult> {
  await createSimulatedAssets(l);
  await l.clock.mark(new Date(o.start.getTime() - HOUR));
  const passes: PassReport[] = [];
  let firstPassBefore: LakeStats | null = null;
  let commits = 0;
  let at = o.start;
  for (let h = 0; h < o.hours; h++) {
    at = new Date(o.start.getTime() + h * HOUR);
    commits += await simulatedRun(l, h, o.fullRefresh);
    await l.clock.mark(at);
    if (o.maintainEveryHours && (h + 1) % o.maintainEveryHours === 0) {
      const report = await pass(l, at, o.retry);
      firstPassBefore ??= report.before;
      passes.push(report);
      o.onPass?.({ at, report });
    }
  }
  return { firstPassBefore, passes, commits, end: at };
}

/** One pass of the maintenance, as croft makes it (under its lock), with `now` the simulated time. */
export function pass(l: TestLake, now: Date, retry?: { attempts: number; baseMs: number }, pins: readonly number[] = []): Promise<PassReport> {
  return l.w.write(MAINTENANCE_LOCK_LABEL, (sql) => runPass(sql, { now, pins, ...(retry ? { retry } : {}) }), { runId: "maintenance", transaction: false, touchesLake: false });
}

export async function statsOf(l: TestLake): Promise<LakeStats> {
  return l.r.read((db) => lakeStats(db), { purpose: "simulation" });
}

/** The bytes of a folder (the lake's data files). */
export function folderBytes(dir: string): number {
  let n = 0;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else n += statSync(p).size;
    }
  };
  try {
    walk(dir);
  } catch {
    return 0;
  }
  return n;
}

/** The bytes the catalog takes: a SQLite file, or the Postgres database. */
export async function catalogBytes(l: TestLake): Promise<number> {
  if (l.kind === "local") return statSync(join(l.root, "lake", "catalog.sqlite")).size;
  return Number(await l.rig!.pg.sql(`select pg_database_size('${l.db}')`));
}
