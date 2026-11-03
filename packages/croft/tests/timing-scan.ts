// What tests/timing-assertions.test.ts looks for in the test sources (its header says why): an upper bound asserted on a measured time, and
// fixed sleeps. Kept apart so that the test and the script that counts the allowance read the same patterns.
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const PACKAGE = resolve(import.meta.dir, "..");

/** The test sources: test files, the helpers they share (testkits, the e2e harness, the golden kit), not the scan or its test. */
export function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.test\.ts$/.test(name) || /testkit\.ts$/.test(name) || /(?:^|\/)(?:harness|kit)\.ts$/.test(path)) {
        if (!/timing-assertions\.test\.ts$/.test(path)) out.push(path); // not the test of this scan: its examples are the patterns
      }
    }
  };
  for (const d of ["src", "tests", "evals"]) walk(join(PACKAGE, d));
  return out.sort();
}

/** What a piece of code measures: a clock read, or a value named for a duration (a call such as backoffMs(1) is a value, not a measurement). */
const MEASURES = /performance\.now\(\)|Date\.now\(\)|\b(?:took|elapsed|waited|latency|slowestMs|maxMs)\b|\.(?:ms|latency|durationMs|tookMs|waitedMs|heldMs|wallMs|maxMs)\b|\b\w+Ms\b(?!\()/;
/** A timing-gap comment must say what the bound is far from: a reason, not the bare tag. */
const GAP = /timing-gap:\s*\S[^\n]{7,}/;

/** The text of the parenthesis that opens just before `from`, up to its match (or the end). */
function balanced(text: string, from: number): { arg: string; end: number } {
  let depth = 1;
  let i = from;
  for (; i < text.length && depth > 0; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
  }
  return { arg: text.slice(from, i - 1), end: i };
}

/**
 * The places where `text` asserts an upper bound on a measured time (`expect(x).toBeLessThan(…)` with x a clock read, a duration-named value, or a
 * variable assigned from a clock read; the same split over lines; or a comparison of one passed on, `expect(ms < 1000).toBe(true)`), minus those
 * that carry a `timing-gap:` comment with a reason, on the statement's lines or the two above.
 */
export function timingAssertions(text: string): { line: number; code: string }[] {
  const lines = text.split("\n");
  const lineAt = (index: number) => text.slice(0, index).split("\n").length - 1;
  const clockVars = [...text.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=[^;\n]*(?:performance\.now\(\)|Date\.now\(\))/g)].map((m) => m[1]!);
  const measured = (arg: string) => MEASURES.test(arg) || clockVars.some((v) => new RegExp(`(?<![\\w.])${v}(?!\\w)`).test(arg));
  const found: { line: number; code: string }[] = [];
  for (const m of text.matchAll(/\bexpect\(/g)) {
    const { arg, end } = balanced(text, m.index! + m[0].length);
    const rest = text.slice(end, end + 40);
    const upper = /^\s*\.toBeLessThan(?:OrEqual)?\(/.test(rest);
    const compared = /(?<![<=>-])\s<=?\s(?![<=>])/.test(arg); // a comparison inside the expect: passed on to toBe(true), or into an object
    if (!measured(arg) || !(upper || compared)) continue;
    const start = lineAt(m.index!);
    const last = lineAt(end);
    if (lines.slice(Math.max(0, start - 2), last + 1).some((l) => GAP.test(l))) continue;
    found.push({ line: start + 1, code: lines[start]!.trim() });
  }
  return found;
}

/** Fixed sleeps: Bun.sleep(…), Bun.sleepSync(…), a local sleep(…) helper given a number or a constant, node:timers/promises' setTimeout, and a promise that resolves from a setTimeout. */
const SLEEP = /\bBun\.sleep(?:Sync)?\(|\bsleep\(\s*(?:[\d_]+|[A-Z][A-Z0-9_]*)\s*[,)]|\bawait\s+setTimeout\(|new Promise(?:<[^>]*>)?\(\(?(?:r|res|resolve)\)? => setTimeout\(/g;
export function countSleeps(text: string): number {
  return (text.match(SLEEP) ?? []).length;
}
