// CI: the test files that touch croft's bookkeeping, one path per line (.github/workflows/ci.yml, DESIGN.md D191). A pull request runs
// only these with the bookkeeping kept as a log (D132); the full suite on the log runs on main and daily. Nothing lists them by hand: a
// test file is chosen when its text, or the text of a test kit it imports by a relative path (`*-testkit.ts`, `testkit.ts`), names the
// bookkeeping (the modules of croft itself all name it, so following them would choose every test), so a new test that
// reads or writes the state tables is in the run the day it is written. The end-to-end journeys are not chosen here: a pull request
// already runs them with the bookkeeping as a log, on a lake (the lake jobs).
//
//   bun scripts/bookkeeping-tests.ts            the paths, relative to packages/croft and starting with ./, sorted
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** What names the bookkeeping: the `_croft` schema its tables live in, or the word (`bookkeeping`, `Bookkeeping`, CROFT_BOOKKEEPING). */
export const NAMES_BOOKKEEPING = /_croft\b|bookkeeping/i;
const IMPORT = /\bfrom\s+["'](\.[^"']*)["']|\bimport\s*\(\s*["'](\.[^"']*)["']\s*\)/g;

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    return e.isDirectory() ? (e.name === "node_modules" ? [] : filesUnder(full)) : [full];
  });
}

/** The test files of a package folder (src/ and tests/) that touch the bookkeeping, as paths relative to it, each starting with `./` so that `bun test` takes it for a path and not for a substring. */
export function bookkeepingTests(pkg: string): string[] {
  const text = new Map<string, string>();
  const read = (file: string) => {
    if (!text.has(file)) text.set(file, readFileSync(file, "utf8"));
    return text.get(file)!;
  };
  const imports = (file: string): string[] =>
    [...read(file).matchAll(IMPORT)].map((m) => resolve(dirname(file), (m[1] ?? m[2])!)).filter((f) => existsSync(f) && /(?:^|[-/])testkit\.ts$/.test(f));
  const tests = ["src", "tests"].flatMap((d) => (existsSync(join(pkg, d)) ? filesUnder(join(pkg, d)) : [])).filter((f) => f.endsWith(".test.ts") && !f.startsWith(join(pkg, "tests", "e2e") + "/"));
  return tests
    .filter((f) => NAMES_BOOKKEEPING.test(read(f)) || imports(f).some((m) => NAMES_BOOKKEEPING.test(read(m))))
    .map((f) => `./${relative(pkg, f)}`)
    .sort();
}

if (import.meta.main) {
  const files = bookkeepingTests(resolve(import.meta.dir, ".."));
  // Nothing chosen is a broken rule, not an empty run: `bun test` given no files runs them all.
  if (files.length === 0) {
    console.error("bookkeeping-tests: no test file names the bookkeeping, so the rule is broken");
    process.exit(1);
  }
  console.log(files.join("\n"));
}
