// Loaded before every test file (bunfig.toml [test] preload): tripwires for what a test must never touch on
// the machine that runs it. CROFT_FORBID_OS_JOBS: registering the scheduler (launchd, crontab) refuses instead of
// installing a job. CROFT_NOTIFY_DRY: a failure notification is logged instead of shown. Both take effect in
// this process and in children given this environment; tests/e2e/harness.ts passes them to every croft it
// spawns.
process.env.CROFT_FORBID_OS_JOBS = "1";
process.env.CROFT_NOTIFY_DRY = "1";
// CROFT_TEST_HARNESS: the mark that lets CROFT_BOOKKEEPING=log take effect (db/bookkeeping.ts defaultBookkeeping()). Nobody else sets it.
process.env.CROFT_TEST_HARNESS = "1";

// Bun's default per-test timeout is 5 s. A test that normally takes 1-3 s (a CLI process or two, a query worker)
// hit it on a busy CI runner, four in one run (ubuntu, 2026-10-19); timing that a test checks is its own
// assertion, never this. Tests that set their own timeout keep it.
//
// This call reaches the FIRST test file of a `bun test` run and no other: with several files, every later one starts again
// at 5 s [V: Bun 1.3.14 and 1.4.4; three one-test files that sleep 6 s, run together: the first passed, the other two timed out
// at 5000 ms; one file alone passes; `[test] timeout` in bunfig.toml is not read]. The suite therefore runs as
// `bun test --timeout 60000` (package.json "test", ci.yml, publish-npm.yml), which sets it for every file; this call stays
// for a bare `bun test <one file>`, and the files that start real processes set their own default as well.
import { setDefaultTimeout } from "bun:test";
setDefaultTimeout(60_000);

// The leak guard (tests/leak-guard.ts, DESIGN.md §10): every test file gets a last afterAll that fails the file, by name, when a process it
// started is still running. A hook registered here belongs to the run, not to a file [V: Bun 1.3.14, a preload afterAll ran once, after the
// last file], so the plugin appends an import of tests/file-guard.ts to each test file as it loads; the query makes that a module of its
// own per file. At the end of the file, line numbers stay what they were, and the import (a dynamic one, after the file's own hooks have
// registered) puts the check last, after the file's own afterAll hooks, which stop what the file started.
import { plugin } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FILE_GUARD = join(import.meta.dir, "file-guard.ts");
if (process.platform !== "win32") { // croft does not run natively on Windows (DESIGN.md §2); the guard reads `ps`
  plugin({
    name: "croft-leak-guard",
    setup(build) {
      build.onLoad({ filter: /\.test\.ts$/ }, ({ path }) => {
        if (path.includes("/node_modules/")) return undefined;
        const source = readFileSync(path, "utf8");
        return { contents: `${source}\nawait import(${JSON.stringify(`${FILE_GUARD}?f=${Buffer.from(path).toString("hex")}`)});\n`, loader: "ts" };
      });
    },
  });
}
