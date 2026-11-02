// croft's merge benchmark (DESIGN.md D133): what a keyed write costs in a DuckDB file under the two ways of counting
// what it changed, "returning" (one MERGE whose returned actions are counted) and "classify" (classify the batch against
// the table, merge only the changed rows, delete the unmatched ones; nothing returns anything, which is all a lake can do).
//
//   bun scripts/bench-merge.ts [--rows 100000] [--runs 7] [--big] [--lake] [--only text] [--out file.md]
//
// It runs croft's own write path (writeBatch) on a warehouse file, one transaction per run: the batch staged as a TEMP
// table, the write, the bookkeeping and the COMMIT. "whole step" is that, from staging to commit; "merge statement"
// is the time of the MERGE statement alone, and "classify" what the classify path spends deciding (its temp table and
// counts) and deleting. Each run starts from a copy of the same file; the two ways alternate, and the median is reported.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sql } from "../src/core/types.ts";
import { DuckDBInstance } from "@duckdb/node-api";
import { connect, instanceConfig } from "../src/db/connect.ts";
import { extensionsReady } from "../src/db/extension-dir-testkit.ts";
import { ensureState } from "../src/db/state.ts";
import { closeAllWarehouses, LeaseSql, openWarehouse } from "../src/db/warehouse.ts";
import { tableBatch } from "../src/load/table-batch.ts";
import { type Counting, writeBatch } from "../src/load/write.ts";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1]! : d; };
const ROWS = Number(arg("rows", "100000"));
const RUNS = Number(arg("runs", "7"));
const BIG = process.argv.includes("--big");
const LAKE = process.argv.includes("--lake");
const OUT = arg("out", "");
const ONLY = arg("only", "");

interface Scenario { name: string; write: "merge" | "replace"; table: number; batch: { from: number; to: number }; changed: boolean; note: string }
const k = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}M` : n >= 1000 ? `${n / 1000}k` : String(n));
const scenarios: Scenario[] = [
  { name: `merge, ${k(ROWS)} table, ${k(ROWS)} batch`, write: "merge", table: ROWS, batch: { from: ROWS / 2, to: ROWS * 3 / 2 }, changed: true,
    note: "25% unchanged, 25% updated, 50% new (the lake spike's shape)" },
  { name: `replace, ${k(ROWS)} table, ${k(ROWS)} batch`, write: "replace", table: ROWS, batch: { from: ROWS / 2, to: ROWS * 3 / 2 }, changed: true,
    note: "as above, and the other half of the table is deleted" },
  { name: `merge, ${k(ROWS)} table, nothing changed`, write: "merge", table: ROWS, batch: { from: 0, to: ROWS }, changed: false,
    note: "a re-run that finds the same rows (no changed rows, so the classify path runs no MERGE)" },
  { name: `merge, ${k(ROWS)} table, ${k(ROWS / 10)} new rows`, write: "merge", table: ROWS, batch: { from: ROWS, to: ROWS + ROWS / 10 }, changed: true,
    note: "an incremental ingest that only adds" },
  ...(BIG ? [{ name: "merge, 1M table, 10k batch", write: "merge" as const, table: 1_000_000, batch: { from: 995_000, to: 1_005_000 }, changed: true,
    note: "5k overlap (half of it changed), 5k new, against a large table" }] : []),
];

const select = (from: number, to: number, changed: boolean) =>
  `SELECT id, ${changed ? "CASE WHEN id % 2 = 0 THEN v + 1 ELSE v END" : "v"} AS v, s, g, d FROM (
     SELECT range::BIGINT AS id, (range % 97)::DOUBLE AS v, 'x' || range AS s, (range % 13)::INTEGER AS g, DATE '2026-01-01' + (range % 365)::INTEGER AS d FROM range(${from}, ${to}))`;

type Bucket = "merge" | "classify" | "insert" | "delete";
/** A Sql that adds up the time of the statements it forwards, by what they are. */
function timed(inner: Sql, t: Record<Bucket, number>): Sql {
  const bucket = (text: string): Bucket | null => {
    if (/^\s*MERGE\b/i.test(text)) return "merge";
    if (/^\s*INSERT INTO\b.*__croft_action/is.test(text)) return "insert";
    if (/__croft_w\d+_cls|__croft_action/.test(text)) return "classify";
    if (/^\s*DELETE FROM\b.*\bAS __t\b/is.test(text)) return "delete";
    return null;
  };
  const wrap = async <T>(text: string, f: () => Promise<T>): Promise<T> => {
    const b = bucket(text);
    const t0 = performance.now();
    try { return await f(); } finally { if (b) t[b] += performance.now() - t0; }
  };
  return { all: (text, params) => wrap(text, () => inner.all(text, params)), exec: (text, params) => wrap(text, () => inner.exec(text, params)) };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function main(): Promise<void> {
  const out: string[] = [];
  const log = (s = "") => { console.log(s); out.push(s); };
  log(`croft merge benchmark: bun ${Bun.version}, ${process.platform} ${process.arch}, ${RUNS} runs per cell (median)`);
  log("");
  log("| scenario | counting | whole step ms | merge statement ms | classify ms | insert ms | delete ms | counts (added/updated/unchanged/deleted) |");
  log("|---|---|---:|---:|---:|---:|---:|---|");
  const summary: { name: string; returning: number; classify: number; mReturning: number; mClassify: number }[] = [];
  for (const sc of scenarios.filter((x) => x.name.includes(ONLY))) {
    const dir = mkdtempSync(join(tmpdir(), "croft-bench-"));
    mkdirSync(join(dir, ".croft"));
    const base = join(dir, "base.duckdb");
    const open = (path: string) => openWarehouse({ path, mode: "read_write", timezone: "UTC", root: dir, stateDir: join(dir, ".croft"), register: false, isTTY: false, writeIntent: false });
    const target = (runId: string) => ({ asset: "bench", write: sc.write, key: ["id"], runId, allowShrink: true });
    // The table, written once through croft's own path, then closed so each run can start from a copy of the file.
    {
      const w = open(base);
      await w.write("seed", async (tx) => {
        await tx.exec(`CREATE TEMP TABLE seed_batch AS SELECT *, row_number() OVER () AS _croft_seq FROM (${select(0, sc.table, false)})`);
        const batch = await tableBatch(tx, { temp: "seed_batch", asset: "bench" });
        await writeBatch(tx, { batch, target: target("r_seed"), kind: "ingest", counting: "returning" });
      }, { runId: "r_seed" });
      await w.close();
      await closeAllWarehouses();
    }
    const cells: Record<Counting, { whole: number[]; merge: number[]; classify: number[]; insert: number[]; del: number[]; counts: string }> = {
      returning: { whole: [], merge: [], classify: [], insert: [], del: [], counts: "" }, classify: { whole: [], merge: [], classify: [], insert: [], del: [], counts: "" },
    };
    for (let run = 0; run < RUNS + 1; run++) {
      for (const counting of (run % 2 ? ["classify", "returning"] : ["returning", "classify"]) as Counting[]) {
        const path = join(dir, `run-${counting}-${run}.duckdb`);
        copyFileSync(base, path);
        const w = open(path);
        // The file is opened and warm before the clock starts: what is timed is the step, not the open.
        await w.read((db) => db.all("SELECT count(*) FROM bench"), { purpose: "bench" });
        const t: Record<Bucket, number> = { merge: 0, classify: 0, insert: 0, delete: 0 };
        let counts = "";
        const t0 = performance.now();
        await w.write("bench", async (raw) => {
          const tx = timed(raw, t);
          await tx.exec(`CREATE TEMP TABLE bench_batch AS SELECT *, row_number() OVER () AS _croft_seq FROM (${select(sc.batch.from, sc.batch.to, sc.changed)})`);
          const batch = await tableBatch(tx, { temp: "bench_batch", asset: "bench" });
          const res = await writeBatch(tx, { batch, target: target(`r_${counting}_${run}`), kind: "ingest", counting });
          counts = `${res.rows.added}/${res.rows.updated}/${res.rows.unchanged}/${res.rows.deleted}`;
        }, { runId: `r_${counting}_${run}` });
        const whole = performance.now() - t0;
        await w.close();
        await closeAllWarehouses();
        rmSync(path, { force: true });
        if (run === 0) continue; // the first pair warms the machine's file cache and DuckDB's code paths
        const c = cells[counting];
        c.whole.push(whole); c.merge.push(t.merge); c.classify.push(t.classify); c.insert.push(t.insert); c.del.push(t.delete); c.counts = counts;
      }
    }
    if (cells.returning.counts !== cells.classify.counts) throw new Error(`the two ways counted differently in "${sc.name}": ${cells.returning.counts} against ${cells.classify.counts}`);
    for (const counting of ["returning", "classify"] as Counting[]) {
      const c = cells[counting];
      log(`| ${sc.name} | ${counting} | ${median(c.whole).toFixed(0)} | ${median(c.merge).toFixed(0)} | ${counting === "classify" ? median(c.classify).toFixed(0) : "-"} | ${counting === "classify" ? median(c.insert).toFixed(0) : "-"} | ${counting === "classify" ? median(c.del).toFixed(0) : "-"} | ${c.counts} |`);
    }
    summary.push({ name: sc.name, returning: median(cells.returning.whole), classify: median(cells.classify.whole), mReturning: median(cells.returning.merge), mClassify: median(cells.classify.merge) });
    rmSync(dir, { recursive: true, force: true });
  }
  log("");
  log("| scenario | classify vs returning, whole step | merge statement alone (classify path vs returning) |");
  log("|---|---:|---:|");
  for (const s of summary) {
    const pct = (a: number, b: number) => `${a >= b ? "+" : ""}${(((a - b) / b) * 100).toFixed(1)}%`;
    log(`| ${s.name} | ${pct(s.classify, s.returning)} (${s.returning.toFixed(0)} to ${s.classify.toFixed(0)} ms) | ${pct(s.mClassify, s.mReturning)} (${s.mReturning.toFixed(0)} to ${s.mClassify.toFixed(0)} ms) |`);
  }
  if (LAKE) await lakeSection(log);
  if (OUT) await Bun.write(OUT, out.join("\n") + "\n");
}


// ---------------------------------------------------------------------------------------------------------
// In a lake (--lake): croft's classify-then-merge write step against a plain MERGE that counts nothing, which is the most
// a lake does for an upsert. The lake is a local one (a SQLite catalog and a local folder, the suite's lake profile): no
// network, so the figures are the statements' own, not R2's latency.

async function lakeSection(log: (s?: string) => void): Promise<void> {
  const ext = extensionsReady(["sqlite", "ducklake"]);
  if (!ext.ready) { log(`lake section skipped: ${ext.skipReason}`); return; }
  log("");
  log(`In a local lake (SQLite catalog, local folder), ${RUNS} runs per cell (median), the table seeded through croft's own write path:`);
  log("");
  log("| scenario | step | whole step ms | classify ms | insert ms | merge statement ms | delete ms |");
  log("|---|---|---:|---:|---:|---:|---:|");
  const open = async () => {
    const root = mkdtempSync(join(tmpdir(), "croft-bench-lake-"));
    mkdirSync(join(root, "data")); mkdirSync(join(root, "secrets"));
    const instance = await DuckDBInstance.create(":memory:", instanceConfig("read_write"));
    const conn = await connect(instance, {
      profile: "serve", timezone: "UTC",
      mode: { kind: "lake-test", extensionDir: ext.dir, secretDir: join(root, "secrets"), lake: { catalog: { kind: "sqlite", path: join(root, "meta.sqlite") }, dataPath: join(root, "data") + "/", access: "write" } },
    }, `:memory:bench-lake-${Math.random()}`);
    await conn.run("USE lake");
    return { sql: new LeaseSql(conn, { mode: "ts", timezone: "UTC" }, null), conn, close: () => { conn.disconnectSync(); instance.closeSync(); rmSync(root, { recursive: true, force: true }); } };
  };
  for (const sc of scenarios.filter((s) => !s.name.includes("1M") && s.name.includes(ONLY))) {
    const target = (runId: string) => ({ asset: "bench", write: sc.write, key: ["id"], runId, allowShrink: true });
    const croft: Record<Bucket | "whole", number[]> = { whole: [], merge: [], classify: [], insert: [], delete: [] };
    const plain: { whole: number[]; merge: number[]; del: number[] } = { whole: [], merge: [], del: [] };
    for (let run = 0; run < RUNS + 1; run++) {
      for (const step of ["croft", "plain"] as const) {
        const lake = await open();
        const { conn } = lake;
        await conn.run("BEGIN");
        await ensureState(lake.sql, { bookkeeping: "log" }); // the lake's bookkeeping: an append-only log
        await lake.sql.exec(`CREATE TEMP TABLE seed_batch AS SELECT *, row_number() OVER () AS _croft_seq FROM (${select(0, sc.table, false)})`);
        await writeBatch(lake.sql, { batch: await tableBatch(lake.sql, { temp: "seed_batch", asset: "bench" }), target: target("r_seed"), kind: "ingest" });
        await conn.run("COMMIT");
        const t: Record<Bucket, number> = { merge: 0, classify: 0, insert: 0, delete: 0 };
        const tx = timed(lake.sql, t);
        const t0 = performance.now();
        await conn.run("BEGIN");
        await tx.exec(`CREATE TEMP TABLE bench_batch AS SELECT *, row_number() OVER () AS _croft_seq FROM (${select(sc.batch.from, sc.batch.to, sc.changed)})`);
        if (step === "croft") {
          await writeBatch(tx, { batch: await tableBatch(tx, { temp: "bench_batch", asset: "bench" }), target: target(`r_${run}`), kind: "ingest", counting: "classify" });
        } else {
          // The most a lake does for an upsert: one MERGE, nothing counted, no bookkeeping. (A lake takes one UPDATE or DELETE
          // action to a MERGE, so a replace's deletes are a statement of their own.)
          await tx.exec(
            `MERGE INTO bench AS t USING bench_batch AS s ON (t.id = s.id)
             WHEN MATCHED AND (t.v IS DISTINCT FROM s.v OR t.s IS DISTINCT FROM s.s OR t.g IS DISTINCT FROM s.g OR t.d IS DISTINCT FROM s.d)
               THEN UPDATE SET v = s.v, s = s.s, g = s.g, d = s.d, _loaded_at = now()
             WHEN NOT MATCHED THEN INSERT (id, v, s, g, d, _loaded_at) VALUES (s.id, s.v, s.s, s.g, s.d, now())`);
          if (sc.write === "replace") await tx.exec(`DELETE FROM bench AS __t WHERE NOT EXISTS (SELECT 1 FROM bench_batch AS __s WHERE __t.id = __s.id)`);
        }
        await conn.run("COMMIT");
        const whole = performance.now() - t0;
        lake.close();
        if (run === 0) continue;
        if (step === "croft") { croft.whole.push(whole); for (const b of Object.keys(t) as Bucket[]) croft[b].push(t[b]); }
        else { plain.whole.push(whole); plain.merge.push(t.merge); plain.del.push(t.delete); }
      }
    }
    log(`| ${sc.name} | croft: classify, insert, merge, delete | ${median(croft.whole).toFixed(0)} | ${median(croft.classify).toFixed(0)} | ${median(croft.insert).toFixed(0)} | ${median(croft.merge).toFixed(0)} | ${median(croft.delete).toFixed(0)} |`);
    log(`| ${sc.name} | one plain MERGE, nothing counted | ${median(plain.whole).toFixed(0)} | - | - | ${median(plain.merge).toFixed(0)} | ${median(plain.del).toFixed(0)} |`);
  }
}

await main();
process.exit(0);
