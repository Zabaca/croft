// A new flake should be obvious the moment it is written (DESIGN.md §10 "Test strategy", the rules against flaking). Two checks read the
// test sources, as codes-raised.test.ts reads the source:
//
//  1. No assertion on how long something took. An UPPER bound on a measured time (`expect(performance.now() - t0).toBeLessThan(1000)`,
//     `expect(took)...`, `expect(r.ms)...`) is true on the machine that wrote it and false on a busy one. What it checks belongs elsewhere:
//     "it did not wait for X" is the test's own timeout, with X held for good until the test lets go (spawnHolder(..., "release"), a server
//     that never answers, a Retry-After of an hour); "it came after Y" is an order of events; "it waited at least Z" is a LOWER bound,
//     which a slow machine only helps (and is not flagged). The one place a bound after the call is the only check is a synchronous call,
//     which no timeout can end; there the bound goes far from both the time the call takes and the wait it excludes, and the line says
//     so: a comment `timing-gap: <the wait it excludes>` on the line or the one above it.
//  2. No new fixed sleep. A `Bun.sleep(80)` before an assertion about something that "should have happened by then" is a flake waiting
//     for a slow machine: wait for the event or the state (`until(...)`, a line the child prints, a promise a hook resolves). A sleep that
//     makes the delay under test (a held lock, a server that answers late, a child that lives on) is fine, and so is one that gives a thing
//     that must NOT happen time to happen. The allowance below is what exists; it only shrinks, and a file that needs one more says why in
//     the change that raises its number.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const PACKAGE = resolve(import.meta.dir, "..");

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if ((/\.test\.ts$/.test(name) || /testkit\.ts$/.test(name)) && path !== import.meta.path) out.push(path); // not this file: its examples are the patterns
    }
  };
  for (const d of ["src", "tests", "evals"]) walk(join(PACKAGE, d));
  return out.sort();
}

/** An upper-bound matcher, and what a line measures: a clock read, or a value named for a duration (a function call such as backoffMs(1) is a value, not a measurement). */
const UPPER_BOUND = /\.toBeLessThan(?:OrEqual)?\(/;
const MEASURES = /performance\.now\(\)|Date\.now\(\)|\b(?:took|elapsed|waited|latency|slowestMs|maxMs)\b|\.(?:ms|latency|durationMs|tookMs|waitedMs|heldMs|wallMs|maxMs)\b|\b\w+Ms\b(?!\()/;

/** The lines of `text` that assert an upper bound on a measured time and carry no `timing-gap:` comment (this line or the two above it). */
export function timingAssertions(text: string): { line: number; code: string }[] {
  const lines = text.split("\n");
  const found: { line: number; code: string }[] = [];
  lines.forEach((code, i) => {
    const m = UPPER_BOUND.exec(code);
    if (!m || !MEASURES.test(code.slice(0, m.index))) return;
    if ([code, lines[i - 1], lines[i - 2]].some((l) => l !== undefined && /timing-gap:/.test(l))) return;
    found.push({ line: i + 1, code: code.trim() });
  });
  return found;
}

/** Fixed sleeps: Bun.sleep(…), Bun.sleepSync(…), a local sleep(…) helper, and a promise that resolves from a setTimeout. */
const SLEEP = /\bBun\.sleep(?:Sync)?\(|\bsleep\(\s*[\d_]+|new Promise(?:<[^>]*>)?\(\(?(?:r|res|resolve)\)? => setTimeout\(/g;
export function countSleeps(text: string): number {
  return (text.match(SLEEP) ?? []).length;
}

/** Fixed sleeps in each test file as of this change (tests and the helpers they share). It only shrinks: see the header. */
const SLEEPS: Record<string, number> = {
  "src/cli/commands/doctor.test.ts": 1,
  "src/cli/commands/logs.test.ts": 1,
  "src/cli/commands/maintain.test.ts": 2,
  "src/cli/commands/query.test.ts": 1,
  "src/cli/commands/serve.test.ts": 1,
  "src/cli/commands/wait.test.ts": 1,
  "src/core/output.test.ts": 6,
  "src/db/backup.test.ts": 2,
  "src/db/lake-steps.test.ts": 1,
  "src/db/lake.test.ts": 2,
  "src/db/mode-testkit.ts": 4,
  "src/db/readcopy.test.ts": 3,
  "src/db/warehouse.test.ts": 16,
  "src/history/concurrency.test.ts": 6,
  "src/project/env.test.ts": 1,
  "src/read/direct.test.ts": 2,
  "src/read/http.test.ts": 2,
  "src/read/testkit.ts": 3,
  "src/run/detach.test.ts": 9,
  "src/run/due-run.test.ts": 1,
  "src/run/preview.test.ts": 1,
  "src/run/runner.test.ts": 3,
  "src/run/testkit.ts": 2,
  "src/schedule/registry.test.ts": 1,
  "src/schedule/user-tick.test.ts": 6,
  "src/serve/copy-maker.test.ts": 4,
  "src/serve/handoff.test.ts": 5,
  "src/serve/instance-readcopy.test.ts": 6,
  "src/serve/instance.test.ts": 11,
  "src/serve/key-queries.test.ts": 3,
  "src/serve/lake-engine.test.ts": 2,
  "src/serve/loop.test.ts": 2,
  "src/serve/quack.test.ts": 7,
  "src/serve/queue.test.ts": 10,
  "src/serve/readers-process.test.ts": 1,
  "src/serve/readers-testkit.ts": 2,
  "src/serve/readers.test.ts": 4,
  "src/serve/refresh-slow-testkit.ts": 1,
  "src/serve/server.test.ts": 7,
  "src/serve/worker.test.ts": 2,
  "tests/concurrency/cc-testkit.ts": 3,
  "tests/concurrency/direct.test.ts": 3,
  "tests/concurrency/probe-writer-testkit.ts": 2,
  "tests/concurrency/runs.test.ts": 6,
  "tests/concurrency/serve.test.ts": 7,
  "tests/e2e/j07-detach.test.ts": 2,
  "tests/e2e/j14-asset-output.test.ts": 1,
  "tests/e2e/j15-secret-renderings.test.ts": 2,
  "tests/e2e/j17-ts-transforms.test.ts": 1,
  "tests/e2e/j23-read-copy.test.ts": 1,
  "tests/e2e/j34-quack.test.ts": 1,
  "tests/e2e/j37-lake-faults.test.ts": 1,
  "tests/golden/g02-pipeline.test.ts": 1,
  "tests/leak-guard.test.ts": 1,
};

describe("tests assert no upper bound on a time measured", () => {
  test("the matcher sees what it should, and not what it should not", () => {
    expect(timingAssertions("expect(performance.now() - t0).toBeLessThan(1000);")).toHaveLength(1);
    expect(timingAssertions("expect(Date.now() - start).toBeLessThanOrEqual(1000 + SLACK);")).toHaveLength(1);
    expect(timingAssertions("expect(r.ms, show(r)).toBeLessThan(15_000);")).toHaveLength(1);
    expect(timingAssertions("expect(took).toBeLessThan(50);")).toHaveLength(1);
    expect(timingAssertions("expect(r.tookMs).toBeLessThan(20_000);")).toHaveLength(1);
    // A lower bound, a count, a size, a function's value and a bound with its gap named are not flagged.
    expect(timingAssertions("expect(Date.now() - t0).toBeGreaterThanOrEqual(250);")).toEqual([]);
    expect(timingAssertions("expect(rows.length).toBeLessThan(100);")).toEqual([]);
    expect(timingAssertions("expect(backoffMs(20)).toBeLessThanOrEqual(1000);")).toEqual([]);
    expect(timingAssertions("// timing-gap: a lock treated as live is waited out to LOCK_STALE_MS\nexpect(Date.now() - t0).toBeLessThan(5000);")).toEqual([]);
    expect(timingAssertions("expect(Date.now() - t0).toBeLessThan(5000); // timing-gap: the 60 s wait")).toEqual([]);
  });

  test("no test file asserts an upper bound on how long something took", () => {
    const found = sources().flatMap((f) => timingAssertions(readFileSync(f, "utf8")).map((x) => `${relative(PACKAGE, f)}:${x.line}: ${x.code}`));
    expect(found, `Wait for the event or the state instead, or hold the thing the code must not wait for and let the test's timeout end a hang; see this file's header.\n${found.join("\n")}\n`).toEqual([]);
  });
});

describe("no new fixed sleeps", () => {
  test("the matcher counts sleeps", () => {
    expect(countSleeps("await Bun.sleep(80);\nBun.sleepSync(10);\nawait sleep(5);\nawait new Promise((r) => setTimeout(r, 20));\nawait sleep(ms);")).toBe(4);
  });

  test("a test file has no more fixed sleeps than it had, and the allowance names no more than there are", () => {
    const actual: Record<string, number> = {};
    for (const f of sources()) {
      const n = countSleeps(readFileSync(f, "utf8"));
      if (n > 0) actual[relative(PACKAGE, f)] = n;
    }
    const more = Object.entries(actual).filter(([f, n]) => n > (SLEEPS[f] ?? 0)).map(([f, n]) => `${f}: ${n} (allowed ${SLEEPS[f] ?? 0})`);
    expect(more, `A new fixed sleep. Wait for the event or the state instead (see this file's header); if the sleep makes the delay under test, raise the file's number and say why in the change.\n${more.join("\n")}\n`).toEqual([]);
    const fewer = Object.entries(SLEEPS).filter(([f, n]) => (actual[f] ?? 0) < n).map(([f, n]) => `${f}: ${actual[f] ?? 0} (allowed ${n})`);
    expect(fewer, `Fewer sleeps than allowed: lower the number in SLEEPS, so it cannot grow back.\n${fewer.join("\n")}\n`).toEqual([]);
  });
});
