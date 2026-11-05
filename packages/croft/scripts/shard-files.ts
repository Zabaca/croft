// CI: the test files of one shard of the pull request's run of the whole suite, one path per line (.github/workflows/ci.yml, DESIGN.md D196).
// Bun's own `--shard=K/N` deals the sorted files out in turn and knows nothing of how long a file takes, so one shard got the heavy journeys
// (11 minutes against 2 to 7 for the others). This deals them by the seconds each took in a recent run (tests/shard-times.json, made by
// scripts/shard-timings.ts from the logs of a run): longest first, each to the shard with the least so far. It is a partition by construction,
// whatever the table says: a file the table has not met (a new test) weighs the table's median, and a file it still names but that is gone is
// ignored. A stale table costs balance, never a test: nothing fails because a file is missing from it.
//
//   bun scripts/shard-files.ts K N     the paths of shard K of N, relative to packages/croft and starting with ./, sorted
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** What `bun test` runs: `*.test.*`, `*_test.*`, `*.spec.*` and `*_spec.*` with a JavaScript or TypeScript extension (tests/shards.test.ts checks this against Bun). */
const TEST_FILE = /[._](?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/;

/** The test files under a package folder, as Bun finds them: all folders but node_modules and those that start with a dot. Relative paths, sorted. */
export function testFiles(pkg: string): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (e.isDirectory()) return e.name === "node_modules" || e.name.startsWith(".") ? [] : walk(join(dir, e.name));
      return TEST_FILE.test(e.name) ? [join(dir, e.name)] : [];
    });
  return walk(pkg).map((f) => relative(pkg, f)).sort();
}

/** The weight of a file the table does not know: the median of those it does (1 s with no table at all). */
function fallback(seconds: Record<string, number>): number {
  const known = Object.values(seconds).sort((a, b) => a - b);
  return known.length === 0 ? 1 : known[Math.floor(known.length / 2)]!;
}

/** `files` dealt in `n` shards by `seconds`, longest first, each to the shard with the least so far (the first, on a tie). Each shard sorted. */
export function dealByTime(files: string[], seconds: Record<string, number>, n: number): string[][] {
  const unknown = fallback(seconds);
  const weight = (f: string) => seconds[f] ?? unknown;
  const shards: string[][] = Array.from({ length: n }, () => []);
  const load = new Array<number>(n).fill(0);
  for (const f of [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1))) {
    const k = load.indexOf(Math.min(...load));
    shards[k]!.push(f);
    load[k]! += weight(f);
  }
  return shards.map((s) => s.sort());
}

export const TIMES_FILE = resolve(import.meta.dir, "../tests/shard-times.json");
export function readTimes(file = TIMES_FILE): Record<string, number> {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, number>) : {};
}

if (import.meta.main) {
  const [k, n] = [Number(process.argv[2]), Number(process.argv[3])];
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 1 || k > n) {
    console.error("usage: bun scripts/shard-files.ts K N   (K from 1 to N)");
    process.exit(2);
  }
  const files = dealByTime(testFiles(resolve(import.meta.dir, "..")), readTimes(), n)[k - 1]!;
  // Nothing chosen is a broken rule, not an empty run: `bun test` given no files runs them all.
  if (files.length === 0) {
    console.error(`shard-files: shard ${k}/${n} has no test file`);
    process.exit(1);
  }
  console.log(files.map((f) => `./${f}`).join("\n"));
}
