// An app reading in direct mode (DESIGN.md §5 "@zabaca/croft/read", "Direct mode"): the public query() of
// src/read.ts (the entry that dist/read.js is built from) in a loop, with no croft serve recorded, so every query
// opens the live file read-only and closes it again, stepping aside for write intents.
//
// Usage: bun direct-reader-testkit.ts <project root> <sql> [loops]
//   It prints {"event":"ready"} once, queries back to back (in `loops` concurrent loops, default 1: concurrent
//   queries of one process share one open instance) until a line arrives on stdin, then prints one summary
//   line: {"event":"done","ok":n,"errors":{"<code>":n},"maxMs":…,"values":[first, last],"monotonic":bool}.
//   The query's first column of its first row is the value followed (a count that only grows while writers add);
//   `monotonic` is per loop, `values` the first and last value read by any loop.
import { query } from "../../src/read.ts";

const [rootArg, sqlArg, loopsArg] = process.argv.slice(2);
if (!rootArg || !sqlArg) {
  console.error("usage: bun direct-reader-testkit.ts <project root> <sql> [loops]");
  process.exit(2);
}
const root: string = rootArg;
const sql: string = sqlArg;
let stop = false;
process.stdin.once("data", () => (stop = true));
process.stdin.once("end", () => (stop = true));

let ok = 0;
let maxMs = 0;
const errors: Record<string, number> = {};
const values: number[] = [];
let monotonic = true;
async function loop(): Promise<void> {
  let last = -1;
  while (!stop) {
    const t0 = performance.now();
    try {
      const rows = await query(sql, [], { project: root });
      const v = Number(Object.values(rows[0] ?? {})[0]);
      if (v < last) monotonic = false;
      last = v;
      values.push(v);
      ok++;
    } catch (e) {
      const code = (e as { code?: string }).code ?? String(e);
      errors[code] = (errors[code] ?? 0) + 1;
    }
    maxMs = Math.max(maxMs, performance.now() - t0);
    // Yield to the event loop so the stop line is read.
    await new Promise<void>((r) => setImmediate(r));
  }
}

console.log(JSON.stringify({ event: "ready", t: Date.now() }));
await Promise.all(Array.from({ length: Math.max(1, Number(loopsArg ?? 1)) }, loop));
console.log(JSON.stringify({ event: "done", ok, errors, maxMs: Math.round(maxMs), values: [values[0] ?? null, values.at(-1) ?? null], monotonic }));
process.exit(0);
