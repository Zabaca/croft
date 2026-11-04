// The pull request's run of the suite with the bookkeeping as a log runs only the test files that touch the bookkeeping, chosen by
// scripts/bookkeeping-tests.ts from what the files say (.github/workflows/ci.yml, DESIGN.md D191). The rule has to stay true as files come and go,
// so this checks it on a throwaway package, and on this one: every test file that names the bookkeeping is chosen, whatever its folder.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { bookkeepingTests, NAMES_BOOKKEEPING } from "../scripts/bookkeeping-tests.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "croft-bk-select-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const put = (file: string, text: string) => {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), text);
};

test("a test file is chosen when its own text names the bookkeeping; journeys, lake-* files and other files are not", () => {
  put("src/a/names-schema.test.ts", 'await db.run("select * from _croft.assets");\n');
  put("src/a/names-word.test.ts", "// the Bookkeeping adapter\n");
  put("src/a/uses-kit.test.ts", 'import { fixture } from "./kit-testkit.ts";\n'); // a test kit naming it does not choose its users
  put("src/a/kit-testkit.ts", "export const fixture = () => bookkeepingEnv();\n");
  put("src/a/plain.test.ts", 'import { test } from "bun:test";\n');
  put("src/a/lake-thing.test.ts", "select * from _croft.assets\n"); // a lake's bookkeeping is always a log
  put("tests/e2e/journey.test.ts", "// _croft is named, but the journeys have their own jobs\n");
  put("tests/golden/golden.test.ts", "select * from _croft.writes\n");
  put("src/a/not-a-test.ts", "bookkeeping\n");
  expect(bookkeepingTests(dir)).toEqual(["./src/a/names-schema.test.ts", "./src/a/names-word.test.ts", "./tests/golden/golden.test.ts"]);
});

test("every test file of croft that names the bookkeeping is chosen, outside the journeys and the lake-* files", () => {
  const pkg = resolve(import.meta.dir, "..");
  const all = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "node_modules" ? [] : all(join(d, e.name))) : [join(d, e.name)]));
  const naming = ["src", "tests"].flatMap((d) => all(join(pkg, d)))
    .filter((f) => f.endsWith(".test.ts") && !f.startsWith(join(pkg, "tests", "e2e") + "/") && !basename(f).startsWith("lake-") && NAMES_BOOKKEEPING.test(readFileSync(f, "utf8")))
    .map((f) => `./${relative(pkg, f)}`);
  const chosen = bookkeepingTests(pkg);
  expect(naming.length).toBeGreaterThan(20); // the rule finds the bookkeeping's tests, not a handful
  expect(naming.filter((f) => !chosen.includes(f))).toEqual([]);
  for (const f of ["./src/db/bookkeeping.test.ts", "./src/db/state.test.ts"]) expect(chosen, f).toContain(f);
  expect(chosen.every((f) => f.startsWith("./src/") || f.startsWith("./tests/")), "paths start with ./ so bun test takes them as paths").toBe(true);
});
