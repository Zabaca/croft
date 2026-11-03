// What a lake's maintenance costs and leaves (DESIGN.md D149 to D152; option 07, slice 3): a lake that lives for a week or a month in seconds
// (db/lake-simulation-testkit.ts: hourly runs over the five assets of the lake spike, each snapshot stamped with the hour of its run) and the
// pass croft runs, on a local lake (a SQLite catalog and a folder) or a Postgres catalog with an S3-compatible store (the test rig).
//
//   bun scripts/simulate-lake-maintenance.ts --scenario week|week-aged|month [--days 30] [--kind local,postgres] [--full-refresh replace|in-place] [--out file.md]
//
// - week: 168 hourly runs, then one pass with `now` the end of the week. Nothing is older than 30 days, so the pass flushes and merges and
//   expires nothing: it shows what the snapshots cost while all of them are kept.
// - week-aged: the same week, but ended 40 days ago when the pass is made, so only each asset's 5 newest versions, the state at the start of
//   the window and the newest snapshot stay (acceptance 1: the counts fall to what the kept versions need).
// - month: 30 days of hourly runs (--days) with a pass every 24 hours (the default), the last at the end: what a pass costs while 30 days of
//   snapshots are kept by the promise; with --days 45, the days after the 30th show the steady state, where each pass expires the oldest day.
// "replace" writes the full-refresh asset as the spike did (CREATE OR REPLACE TABLE, a new lake table each run); "in-place" as croft does (D146).
import { writeFileSync } from "node:fs";
import { lakeRigReady, openTestLake, startLakeRig, type TestLakeKind } from "../src/db/lake-testkit.ts";
import { catalogBytes, folderBytes, type FullRefresh, pass, simulate, statsOf } from "../src/db/lake-simulation-testkit.ts";
import { closeAllWarehouses } from "../src/db/warehouse.ts";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1]! : d; };
const SCENARIO = arg("scenario", "week") as "week" | "week-aged" | "month";
const KINDS = (arg("kind", "local,postgres").split(",") as TestLakeKind[]);
const FULL: FullRefresh = arg("full-refresh", "in-place") === "replace" ? "replace" : "in place";
const OUT = arg("out", "");
const DAYS = Number(arg("days", "30"));
const DAY = 86_400_000;
const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

const ready = lakeRigReady();
if (!ready.ready) {
  console.error(`cannot run: ${ready.skipReason}`);
  process.exit(2);
}

const rig = KINDS.includes("postgres") ? await startLakeRig() : undefined;
const tables: string[] = [];
try {
  for (const kind of KINDS) {
    const l = await openTestLake(kind, { extensionDir: ready.dir, ...(rig ? { rig } : {}) });
    try {
      const NOW = new Date("2026-11-02T12:00:00Z");
      const hours = SCENARIO === "month" ? DAYS * 24 : 7 * 24;
      const end = SCENARIO === "week-aged" ? new Date(NOW.getTime() - 40 * DAY) : NOW;
      const start = new Date(end.getTime() - hours * 3_600_000);
      const t0 = performance.now();
      const sim = await simulate(l, { start, hours, fullRefresh: FULL, ...(SCENARIO === "month" ? { maintainEveryHours: 24 } : {}) });
      const wrote = performance.now() - t0;
      const row = (label: string, s: Awaited<ReturnType<typeof statsOf>>, extra: { catalog: number; data: number }) =>
        `| ${kind} | ${label} | ${s.snapshots} | ${s.dataFiles} | ${s.liveFiles} | ${s.inlinedTables} | ${s.pendingDeletion} | ${mb(extra.catalog)} | ${mb(extra.data)} |`;
      if (SCENARIO === "month") {
        const costs = sim.passes.map((p) => p.tookMs);
        const last = sim.passes[sim.passes.length - 1]!;
        const sorted = [...costs].sort((a, b) => a - b);
        const expired = sim.passes.reduce((n, p) => n + p.plan.expired, 0);
        console.log(JSON.stringify({ kind, passesExpired: sim.passes.map((p) => p.plan.expired), snapshotsAfter: sim.passes.map((p) => p.after.snapshots) }));
        tables.push(`| ${kind} | ${DAYS} days, a pass every 24 h (${expired} snapshots expired in all) | ${sim.commits} commits in ${(wrote / 1000).toFixed(0)} s | ${sim.passes.length} passes: median ${sorted[Math.floor(sorted.length / 2)]} ms, max ${sorted[sorted.length - 1]} ms, last ${last.tookMs} ms | `
          + `${last.before.snapshots} → ${last.after.snapshots} snapshots at the last pass, ${last.after.dataFiles} files, ${last.after.inlinedTables} inlined tables | ${mb(await catalogBytes(l))} catalog, ${mb(folderBytes(l.dataDir))} data |`);
        console.log(JSON.stringify({ kind, scenario: SCENARIO, passes: costs, last: last.after }));
      } else {
        const before = await statsOf(l);
        const beforeBytes = { catalog: await catalogBytes(l), data: folderBytes(l.dataDir) };
        const report = await pass(l, NOW);
        const after = await statsOf(l);
        const afterBytes = { catalog: await catalogBytes(l), data: folderBytes(l.dataDir) };
        tables.push(row("before the pass", before, beforeBytes), row(`after the pass (${report.tookMs} ms, ${report.plan.expired} snapshots expired)`, after, afterBytes));
        console.log(JSON.stringify({ kind, scenario: SCENARIO, commits: sim.commits, steps: report.steps.map((s) => ({ step: s.step, ms: s.tookMs, did: s.did })), before, after }));
      }
    } finally {
      await l.close();
    }
  }
} finally {
  await closeAllWarehouses();
  await rig?.stop();
}
const header = SCENARIO === "month"
  ? "| lake | scenario | writes | passes | at the last pass | size |\n|---|---|---|---|---|---|"
  : "| lake | when | snapshots | data files | read now | inlined tables | waiting for deletion | catalog | data |\n|---|---|---:|---:|---:|---:|---:|---:|---:|";
const text = `${header}\n${tables.join("\n")}\n`;
console.log(text);
if (OUT) writeFileSync(OUT, text);
