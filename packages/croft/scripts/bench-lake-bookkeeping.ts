// What a lake's first maintenance pass does to croft's own speed, against a store a long way off (DESIGN.md D162; the first real-lake trial,
// 2026-11-02, found a run with nothing new going from 3.8 s before the first pass to 8.7 to 9.1 s after it, on R2).
//
// The pass's flush moved croft's own bookkeeping (`_croft`, a few rows at a time, kept inside the catalog) into tiny Parquet files in the
// bucket, and every read of it then cost a listing and a range read or two against the store. This measures a run with nothing new, which is
// mostly those reads, in four states of the same project: before any pass; after a pass that flushes every schema (what croft did until D162,
// reproduced here with DuckLake's own call, since croft no longer makes it); after croft's pass as it is now (only the assets' schema); and
// after that flush and then croft's pass, which brings the bookkeeping back into the catalog (D179, the second real-lake trial).
//
// The store is the test rig's, on this machine, behind a TCP proxy that holds every chunk back half of `--rtt` milliseconds in each direction
// (as the seq benchmark's proxy does for the catalog, bench-lake-seq.ts). It keeps the order of the bytes and nothing else: no loss, no jitter,
// no bandwidth limit, and a new connection costs one round trip, not the several of a TLS handshake. The catalog is not delayed (the trial's
// was a few milliseconds away). Each cell is the median wall time of `croft run --foreground` (the real CLI, a process of its own), and the
// number of requests the store was asked (counted at the proxy, one per HTTP request line seen).
//
//   bun scripts/bench-lake-bookkeeping.ts [--rtt 0,100,250] [--runs 3] [--out file.md]
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { delayProxy } from "../src/db/delay-proxy-testkit.ts";
import { lakeRigReady, startLakeRig, useLake } from "../src/db/lake-testkit.ts";
import { closeAllWarehouses, openWarehouse } from "../src/db/warehouse.ts";
import { lakeConnection } from "../src/db/lake.ts";
import { ProjectEnv } from "../src/project/env.ts";
import { loadProject } from "../src/project/root.ts";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1]! : d; };
const RTTS = arg("rtt", "0,100,250").split(",").map(Number);
const RUNS = Number(arg("runs", "3"));
const OUT = arg("out", "");
const PKG = resolve(import.meta.dir, "..");
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

const ASSET = `import { ingest } from "@zabaca/croft";
export default ingest({ description: "sales", file: "files/sales.csv", key: "id", checks: ["not_null(region)"] });
`;
const SUMMARY = "-- description: sales by region\n-- key: region\nSELECT region, count(*) AS n, sum(amount) AS amount FROM sales GROUP BY region\n";
const csv = (): string => `id,region,amount\n${Array.from({ length: 120 }, (_, i) => `${i + 1},${["east", "west", "north", "south"][i % 4]},${(i % 17) + 1}.5`).join("\n")}\n`;

function makeProject(dir: string): string {
  const root = join(dir, "project");
  mkdirSync(join(root, "node_modules", "@zabaca"), { recursive: true });
  symlinkSync(PKG, join(root, "node_modules", "@zabaca", "croft"));
  for (const d of ["assets", "files", ".croft"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "croft.json"), JSON.stringify({ database: "warehouse.duckdb", timezone: "UTC" }));
  writeFileSync(join(root, "assets", "sales.ts"), ASSET);
  writeFileSync(join(root, "assets", "sales_by_region.sql"), SUMMARY);
  writeFileSync(join(root, "files", "sales.csv"), csv());
  return root;
}

const env = (extra: Record<string, string>): Record<string, string> => ({
  PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp", NO_COLOR: "1", TZ: "UTC",
  CROFT_FORBID_OS_JOBS: "1", CROFT_NOTIFY_DRY: "1", ...extra,
});

async function croft(root: string, args: string[], e: Record<string, string>): Promise<{ ms: number; code: number; err: string }> {
  const t0 = performance.now();
  const proc = Bun.spawn([process.execPath, join(PKG, "bin", "croft.mjs"), ...args], { cwd: root, env: env(e), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { ms: performance.now() - t0, code, err: code === 0 ? "" : `${out}\n${err}`.slice(0, 600) };
}

type State = "before any pass" | "after a pass that flushes every schema (until D162)" | "after croft's pass (assets only)" | "after that flush, then croft maintain (D179)";
const STATES: State[] = ["before any pass", "after a pass that flushes every schema (until D162)", "after croft's pass (assets only)", "after that flush, then croft maintain (D179)"];

async function main(): Promise<void> {
  const ready = lakeRigReady();
  if (!ready.ready) throw new Error(`the lake rig is not ready: ${ready.skipReason}`);
  const out: string[] = [];
  out.push(`croft lake bookkeeping benchmark: bun ${Bun.version}, ${process.platform} ${process.arch}, DuckDB 2.0.0, ${RUNS} runs per cell (median)`);
  out.push("");
  out.push("| round trip to the store | state | run with nothing new, s | store requests in it |");
  out.push("|---:|---|---:|---:|");
  const dir = mkdtempSync(join(tmpdir(), "croft-bench-bk-"));
  const rig = await startLakeRig();
  try {
    for (const rtt of RTTS) {
      for (const state of STATES) {
        const lake = await rig.lake();
        const proxy = delayProxy(rig.s3.port, rtt / 2);
        const work = join(dir, `${rtt}-${STATES.indexOf(state)}`);
        const root = makeProject(work);
        // The project reaches the store through the proxy; the first runs and the pass go straight to it, so only the measured runs wait.
        const direct = { ...lake.block, bucket: { ...(lake.block.bucket as object) } } as Record<string, unknown>;
        const e = { CROFT_EXTENSION_DIR: ready.dir, ...lake.env };
        useLake(root, { block: direct, env: lake.env });
        const run = async (args: string[]) => { const r = await croft(root, args, e); if (r.code !== 0) throw new Error(`croft ${args.join(" ")} failed:\n${r.err}`); return r; };
        // The lake, and a few runs, as a project in use has had.
        await run(["run", "--foreground"]);
        writeFileSync(join(root, "files", "sales.csv"), csv().replace("120", "121"));
        await run(["run", "--foreground"]);
        await run(["run", "--foreground"]);
        if (state !== "before any pass") {
          if (state === "after croft's pass (assets only)") {
            await run(["maintain"]);
          } else {
            // (the last state flushes as the one before it did, and then mends it with croft's own pass)
            // What croft's flush did before: every schema. DuckLake's own call, as the writer, under no lock of croft's (nothing else runs).
            const project = loadProject({ root });
            const w = openWarehouse({ path: project.paths.database, mode: "read_write", timezone: "UTC", root, stateDir: project.paths.stateDir, lake: lakeConnection(project, ProjectEnv.load(root, e), { extensionDir: ready.dir })!, register: false, isTTY: false });
            try {
              await w.write("flush", async (sql) => { await sql.all("CALL ducklake_flush_inlined_data('lake')"); }, { runId: "bench", transaction: false, touchesLake: false });
            } finally {
              await w.close();
              await closeAllWarehouses();
            }
            if (state === "after that flush, then croft maintain (D179)") await run(["maintain"]);
          }
        }
        // Now the same project, with the store a round trip of `rtt` away.
        const far = { ...lake.block, bucket: { ...(lake.block.bucket as object), endpoint: `127.0.0.1:${proxy.port}` } };
        useLake(root, { block: far });
        const times: number[] = [];
        const reqs: number[] = [];
        for (let i = 0; i < RUNS; i++) {
          proxy.reset();
          const r = await run(["run", "--foreground"]);
          times.push(r.ms / 1000);
          reqs.push(proxy.requests());
        }
        out.push(`| ${rtt} ms | ${state} | ${median(times).toFixed(1)} | ${median(reqs)} |`);
        console.log(out.at(-1));
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

await main();
