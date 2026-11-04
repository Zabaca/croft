// What croft's bookkeeping log costs for its order number in a lake (DESIGN.md D132, D145; option 07, slice 2): the log's `seq` is one more than
// the highest in the table. Until slice 2 the adapter read that highest number in a subquery inside every INSERT that writes a log row ("subquery"
// below, kept here as raw SQL for the comparison). D132 said this slice should keep the number per transaction instead if that is slow against a
// real Postgres: it is, a network away (db/bookkeeping.ts now reads it once per transaction and table into a connection variable; "adapter"
// below is croft's own code). This measures both on a local SQLite lake, on a Postgres catalog with a local S3-compatible store (the test rig)
// and on that catalog behind a delay proxy (`--latency`, one-way milliseconds), for logs of several sizes.
//
//   bun scripts/bench-lake-seq.ts [--inserts 25] [--runs 9] [--sizes 0,1000,20000] [--out file.md]
//
// "subquery" is the old statement: `(SELECT coalesce(max(seq), 0) FROM log) + 1` in each INSERT. "adapter" is `bookkeepingOf(tx).upsert(...)` as it
// is now. Each cell is the median of `runs` write
// steps of `inserts` log rows each (a step of croft writes about that many bookkeeping rows: the asset, its columns, inputs and the write),
// as the time of the transaction from BEGIN to COMMIT, and per INSERT with the cost of an empty transaction taken off.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extensionsReady } from "../src/db/extension-dir-testkit.ts";
import { delayProxy } from "../src/db/delay-proxy-testkit.ts";
import type { LakeConnection } from "../src/db/lake.ts";
import { lakeRigReady, startLakeRig } from "../src/db/lake-testkit.ts";
import { bookkeepingOf, logDdl } from "../src/db/bookkeeping.ts";
import { closeAllWarehouses, openWarehouse } from "../src/db/warehouse.ts";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1]! : d; };
const INSERTS = Number(arg("inserts", "25"));
const RUNS = Number(arg("runs", "9"));
const SIZES = arg("sizes", "0,1000,20000").split(",").map(Number);
const OUT = arg("out", "");
const LATENCIES = arg("latency", "").split(",").filter(Boolean).map(Number);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

const COLUMNS = "name, kind, write_mode, key_columns, code_hash, behavior_hash, cursor_value, cursor_type, cursor_unit, last_loaded_at, last_replaced_at, row_count, max_loaded_at, updated_at";
const row = (name: string, seq: string) => `('${name}', 'ingest', 'replace', ['id'], 'h', 'b', NULL, NULL, NULL, now(), NULL, 10, now(), now(), ${seq}, false)`;

/** A row of _croft.assets for the adapter, every column named. */
const assetRow = (name: string): Record<string, string> => ({
  name: `'${name}'`, kind: "'ingest'", write_mode: "'replace'", key_columns: "['id']", code_hash: "'h'", behavior_hash: "'b'", cursor_value: "NULL",
  cursor_type: "NULL", cursor_unit: "NULL", last_loaded_at: "now()", last_replaced_at: "NULL", row_count: "10", max_loaded_at: "now()", updated_at: "now()",
});

async function measure(label: string, conn: LakeConnection, root: string, out: string[]): Promise<void> {
  const stateDir = join(root, ".croft");
  mkdirSync(stateDir, { recursive: true });
  const w = openWarehouse({ path: join(root, `w-${label}.duckdb`), mode: "read_write", timezone: "UTC", root, stateDir, lake: conn, register: false, isTTY: false });
  await w.write("ddl", async (tx) => {
    await tx.exec("CREATE SCHEMA _croft");
    for (const { ddl } of logDdl()) await tx.exec(ddl);
  }, { runId: "bench" });
  let filled = 0;
  for (const size of SIZES) {
    // Grow the log to `size` rows in one bulk insert (numbered after what is there).
    if (size > filled) {
      await w.write("fill", (tx) => tx.exec(`INSERT INTO _croft.assets_log SELECT 'fill' || range, 'ingest', 'replace', ['id'], 'h', 'b', NULL, NULL, NULL, now(), NULL, 1, now(), now(), ${filled} + range + 1, false FROM range(${size - filled})`), { runId: "bench" });
      filled = size;
    }
    const empty: number[] = [];
    const sub: number[] = [];
    const once: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      let t0 = performance.now();
      await w.write("empty", async (tx) => { await tx.all("SELECT 1"); }, { runId: "bench" });
      empty.push(performance.now() - t0);
      t0 = performance.now();
      await w.write("subquery", async (tx) => {
        for (let k = 0; k < INSERTS; k++) await tx.exec(`INSERT INTO _croft.assets_log (${COLUMNS}, seq, closed) VALUES ${row(`sub${i}_${k}`, "(SELECT coalesce(max(seq), 0) FROM _croft.assets_log) + 1")}`);
      }, { runId: "bench" });
      sub.push(performance.now() - t0);
      t0 = performance.now();
      await w.write("adapter", async (tx) => {
        const bk = await bookkeepingOf(tx);
        for (let k = 0; k < INSERTS; k++) await bk.upsert("assets", assetRow(`once${i}_${k}`));
      }, { runId: "bench" });
      once.push(performance.now() - t0);
      filled += 2 * INSERTS;
    }
    const e = median(empty);
    const per = (xs: number[]) => ((median(xs) - e) / INSERTS).toFixed(2);
    out.push(`| ${label} | ${size.toLocaleString("en-US")} | ${e.toFixed(0)} | ${median(sub).toFixed(0)} | ${median(once).toFixed(0)} | ${per(sub)} | ${per(once)} |`);
    console.log(out.at(-1));
  }
}

async function main(): Promise<void> {
  const ready = lakeRigReady();
  if (!ready.ready) throw new Error(`the lake rig is not ready: ${ready.skipReason}`);
  const out: string[] = [];
  out.push(`croft lake seq benchmark: bun ${Bun.version}, ${process.platform} ${process.arch}, ${INSERTS} log rows per step, ${RUNS} steps per cell (median)`);
  out.push("");
  out.push("| lake | log rows | empty step ms | subquery step ms | adapter step ms | subquery ms/INSERT | adapter ms/INSERT |");
  out.push("|---|---:|---:|---:|---:|---:|---:|");
  console.log(out.join("\n"));
  const dir = mkdtempSync(join(tmpdir(), "croft-bench-seq-"));
  const rig = await startLakeRig();
  try {
    // A local lake: a SQLite catalog and a folder.
    const localRoot = join(dir, "local");
    mkdirSync(join(localRoot, "data"), { recursive: true });
    const local: LakeConnection = {
      label: "local", kind: "local", secretDir: join(localRoot, ".croft", "lake-secrets"), secretNames: [],
      mode: (access) => ({ kind: "lake-local", extensionDir: ready.dir, secretDir: join(localRoot, ".croft", "lake-secrets"), lake: { catalog: { kind: "sqlite", path: join(localRoot, "catalog.sqlite") }, dataPath: join(localRoot, "data") + "/", access } }),
    };
    await measure("SQLite catalog, local folder", local, localRoot, out);
    // A Postgres catalog on this machine, and the store.
    const lake = await rig.lake();
    const { rigConnection } = await import("../src/db/lake-testkit.ts");
    const pgRoot = join(dir, "pg");
    await measure("Postgres catalog, local S3 store", rigConnection(rig, lake, { stateDir: join(pgRoot, ".croft"), extensionDir: ready.dir }), pgRoot, out);
    // The same catalog behind a network that takes `--latency` ms each way (a Postgres in another city): the cost of a bookkeeping INSERT that
    // asks the catalog for the highest number is a round trip or more, which a catalog on this machine hides.
    for (const ms of LATENCIES) {
      const proxy = delayProxy(rig.pg.port, ms);
      const far = await rig.lake({ port: proxy.port });
      const farRoot = join(dir, `pg-${ms}`);
      try {
        await measure(`Postgres catalog, ${2 * ms} ms round trip`, rigConnection(rig, far, { stateDir: join(farRoot, ".croft"), extensionDir: ready.dir, override: { port: proxy.port } }), farRoot, out);
      } finally {
        proxy.stop();
      }
    }
  } finally {
    await closeAllWarehouses();
    await rig.stop();
    rmSync(dir, { recursive: true, force: true });
  }
  if (OUT) writeFileSync(OUT, `${out.join("\n")}\n`);
}

void extensionsReady;
await main();
