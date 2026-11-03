// What a distant catalog costs croft's commands (DESIGN.md D-T2; the second real-lake trial, 2026-11-03).
//
// The trial ran a lake whose Postgres catalog (a hosted one) was about 41 ms away, and every command was slow: a run with nothing new took
// 27 s, a `croft query` 9 s, `croft doctor` 22 s and `croft maintain` 39 s, where DuckDB alone ran the same query in under 2 s. A statement
// that reads a table of the lake costs DuckLake several round trips to the catalog, and croft read its own bookkeeping one statement at a
// time, about 65 of them in a run with nothing to do. This measures the commands of one project against the same Postgres on this machine
// behind a TCP proxy that holds every chunk back half of `--rtt` milliseconds in each direction (the store is not delayed: the bookkeeping
// is in the catalog, and a project in use keeps it there).
//
// The proxy keeps the order of the bytes and nothing else (no loss, no jitter, no bandwidth limit), and a new connection costs one round
// trip, not the several of a TLS handshake. "Catalog round trips" are counted at the proxy: each time the client sends after the server
// has answered.
//
//   bun scripts/bench-lake-latency.ts [--rtt 0,40] [--runs 3] [--out file.md] [--only run,query,doctor,maintain] [--preload tracer.ts --trace dir]
//
// `--preload` is a module the commands are started with (Bun's --preload): a statement timer, say, for a profile; with `--trace dir` each
// measured command gets SQLTIME_LOG=<dir>/<rtt>-<command>.log in its environment for it to write to.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { delayProxy } from "../src/db/delay-proxy-testkit.ts";
import { lakeRigReady, startLakeRig, useLake } from "../src/db/lake-testkit.ts";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1]! : d; };
const RTTS = arg("rtt", "0,40").split(",").map(Number);
const RUNS = Number(arg("runs", "3"));
const OUT = arg("out", "");
const PRELOAD = arg("preload", "");
const TRACE = arg("trace", "");
const ONLY = arg("only", "").split(",").filter(Boolean);
const PKG = resolve(import.meta.dir, "..");
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

// A project like the trial's: two file ingests and a SQL asset over each.
const EVENTS = `import { ingest } from "@zabaca/croft";
export default ingest({ description: "events", file: "files/events.csv", key: "event_id", checks: ["not_null(kind)"] });
`;
const SALES = `import { ingest } from "@zabaca/croft";
export default ingest({ description: "sales", file: "files/sales.csv", key: "id", checks: ["not_null(region)"] });
`;
const DAILY = "-- description: events by kind\n-- key: kind\nSELECT kind, count(*) AS n FROM events GROUP BY kind\n";
const BY_REGION = "-- description: sales by region\n-- key: region\nSELECT region, count(*) AS n, sum(amount) AS amount FROM sales GROUP BY region\n";
const salesCsv = (): string => `id,region,amount\n${Array.from({ length: 120 }, (_, i) => `${i + 1},${["east", "west", "north", "south"][i % 4]},${(i % 17) + 1}.5`).join("\n")}\n`;
const eventsCsv = (): string => `event_id,kind\n${Array.from({ length: 200 }, (_, i) => `${i + 1},${["view", "click", "buy"][i % 3]}`).join("\n")}\n`;

function makeProject(dir: string): string {
  const root = join(dir, "project");
  mkdirSync(join(root, "node_modules", "@zabaca"), { recursive: true });
  symlinkSync(PKG, join(root, "node_modules", "@zabaca", "croft"));
  for (const d of ["assets", "files", ".croft"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "croft.json"), JSON.stringify({ database: "warehouse.duckdb", timezone: "UTC" }));
  writeFileSync(join(root, "assets", "events.ts"), EVENTS);
  writeFileSync(join(root, "assets", "sales.ts"), SALES);
  writeFileSync(join(root, "assets", "daily_events.sql"), DAILY);
  writeFileSync(join(root, "assets", "sales_by_region.sql"), BY_REGION);
  writeFileSync(join(root, "files", "events.csv"), eventsCsv());
  writeFileSync(join(root, "files", "sales.csv"), salesCsv());
  return root;
}

const env = (extra: Record<string, string>): Record<string, string> => ({
  PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp", NO_COLOR: "1", TZ: "UTC",
  CROFT_FORBID_OS_JOBS: "1", CROFT_NOTIFY_DRY: "1", ...(PRELOAD ? { BUN_OPTIONS: `--preload ${PRELOAD}` } : {}), ...extra,
});

async function croft(root: string, args: string[], e: Record<string, string>): Promise<{ ms: number; code: number; err: string }> {
  const t0 = performance.now();
  const proc = Bun.spawn([process.execPath, join(PKG, "bin", "croft.mjs"), ...args], { cwd: root, env: env(e), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { ms: performance.now() - t0, code, err: code === 0 ? "" : `${out}\n${err}`.slice(0, 800) };
}

let changed = 0;
const COMMANDS: { id: string; label: string; args: string[]; before?: (root: string) => void }[] = [
  { id: "run", label: "run, nothing new", args: ["run", "--foreground"] },
  { id: "change", label: "run, one file changed (an ingest and the SQL asset over it)", args: ["run", "--foreground"],
    before: (root) => writeFileSync(join(root, "files", "sales.csv"), salesCsv().replace("120", String(130 + ++changed))) },
  { id: "query", label: "query (count of a table)", args: ["query", "select count(*) from events"] },
  { id: "doctor", label: "doctor", args: ["doctor"] },
  { id: "maintain", label: "maintain", args: ["maintain"] },
].filter((c) => ONLY.length === 0 || ONLY.includes(c.id));

async function main(): Promise<void> {
  const ready = lakeRigReady();
  if (!ready.ready) throw new Error(`the lake rig is not ready: ${ready.skipReason}`);
  const out: string[] = [];
  out.push(`croft lake latency benchmark: bun ${Bun.version}, ${process.platform} ${process.arch}, DuckDB 2.0.0, ${RUNS} runs per cell (median); a Postgres 17 on this machine behind a delay proxy, the store not delayed`);
  out.push("");
  out.push("| round trip to the catalog | command | seconds | catalog round trips |");
  out.push("|---:|---|---:|---:|");
  console.log(out.join("\n"));
  const dir = mkdtempSync(join(tmpdir(), "croft-bench-lat-"));
  const rig = await startLakeRig();
  try {
    for (const rtt of RTTS) {
      const proxy = delayProxy(rig.pg.port, rtt / 2);
      try {
        const lake = await rig.lake({ port: proxy.port });
        const root = makeProject(join(dir, `rtt-${rtt}`));
        const e = { CROFT_EXTENSION_DIR: ready.dir, ...lake.env };
        useLake(root, lake);
        const run = async (args: string[], trace?: string) => {
          proxy.reset();
          const r = await croft(root, args, trace ? { ...e, SQLTIME_LOG: trace } : e);
          if (r.code !== 0) throw new Error(`croft ${args.join(" ")} failed:\n${r.err}`);
          return { ...r, trips: proxy.trips() };
        };
        // The lake, and a few runs, as a project in use has had.
        const first = await run(["run", "--foreground"]);
        out.push(`| ${rtt} ms | first run (4 assets built) | ${(first.ms / 1000).toFixed(1)} | ${first.trips} |`);
        console.log(out.at(-1));
        writeFileSync(join(root, "files", "sales.csv"), salesCsv().replace("120", "121"));
        await run(["run", "--foreground"]);
        await run(["run", "--foreground"]);
        for (const c of COMMANDS) {
          const times: number[] = [];
          const trips: number[] = [];
          for (let i = 0; i < RUNS; i++) {
            c.before?.(root);
            const r = await run(c.args, TRACE ? join(TRACE, `${rtt}-${c.id}.log`) : undefined);
            times.push(r.ms / 1000);
            trips.push(r.trips);
          }
          out.push(`| ${rtt} ms | ${c.label} | ${median(times).toFixed(1)} | ${median(trips)} |`);
          console.log(out.at(-1));
        }
      } finally {
        proxy.stop();
      }
    }
  } finally {
    await rig.stop();
    rmSync(dir, { recursive: true, force: true });
  }
  if (OUT) writeFileSync(OUT, `${out.join("\n")}\n`);
}

await main();
