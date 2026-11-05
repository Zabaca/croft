// Makes tests/shard-times.json, the seconds each test file took, for scripts/shard-files.ts (DESIGN.md D196). The input is the log of the
// `test` job of a pull request's run, one file per shard (`gh run view <run> --json jobs`, then `gh api repos/Zabaca/croft/actions/jobs/<id>/logs`),
// from as many runs as you like: a file's time is the mean over the logs that ran it. Bun prints a group header with a timestamp for each
// test file, and a file took the time to the next header (the last one, to the "Ran N tests" line). Run it again when the balance has drifted
// (the slowest shard is 1.5 times the others); a stale table costs balance only.
//
//   bun scripts/shard-timings.ts <log>...        writes tests/shard-times.json, and prints each shard's total for the table as it is
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { dealByTime, readTimes, testFiles, TIMES_FILE } from "./shard-files.ts";

/** Seconds per test file in one job log. */
export function fileSeconds(log: string): Record<string, number> {
  const heads: { at: number; file: string }[] = [];
  let end = 0;
  for (const line of log.split("\n")) {
    const m = line.match(/^(\d{4}-\d\d-\d\dT[\d:.]+Z) (.*)$/);
    if (!m) continue;
    const at = Date.parse(m[1]!);
    const g = m[2]!.match(/^##\[group\](\S+\.(?:test|spec)\.\S+):$/);
    if (g) heads.push({ at, file: g[1]! });
    if (/^\s*Ran \d+ tests? across/.test(m[2]!)) end = at;
  }
  const out: Record<string, number> = {};
  heads.forEach((h, i) => {
    const next = heads[i + 1]?.at ?? end;
    if (next >= h.at) out[h.file] = (next - h.at) / 1000;
  });
  return out;
}

if (import.meta.main) {
  const logs = process.argv.slice(2);
  if (logs.length === 0) {
    console.error("usage: bun scripts/shard-timings.ts <job log>...");
    process.exit(2);
  }
  const sums = new Map<string, { total: number; runs: number }>();
  for (const log of logs) {
    for (const [f, s] of Object.entries(fileSeconds(readFileSync(log, "utf8")))) {
      const cur = sums.get(f) ?? { total: 0, runs: 0 };
      sums.set(f, { total: cur.total + s, runs: cur.runs + 1 });
    }
  }
  // Only files that exist: a log from before a test file was deleted or renamed still names it.
  const present = new Set(testFiles(resolve(import.meta.dir, "..")));
  const table: Record<string, number> = {};
  for (const f of [...sums.keys()].filter((x) => present.has(x)).sort()) table[f] = Math.round((sums.get(f)!.total / sums.get(f)!.runs) * 10) / 10;
  writeFileSync(TIMES_FILE, JSON.stringify(table, null, 1) + "\n");
  const shards = dealByTime(Object.keys(table), readTimes(), 7);
  console.log(`${Object.keys(table).length} files; per shard of 7: ${shards.map((s) => s.reduce((a, f) => a + table[f]!, 0).toFixed(0)).join(" ")} s`);
}
