// Loaded before every test file (bunfig.toml [test] preload): tripwires for what a test must never touch on
// the machine that runs it. CROFT_FORBID_OS_JOBS: registering the scheduler (launchd, crontab) refuses instead of
// installing a job. CROFT_NOTIFY_DRY: a failure notification is logged instead of shown. Both take effect in
// this process and in children given this environment; tests/e2e/harness.ts passes them to every croft it
// spawns.
process.env.CROFT_FORBID_OS_JOBS = "1";
process.env.CROFT_NOTIFY_DRY = "1";

// Bun's default per-test timeout is 5 s. A test that normally takes 1-3 s (a CLI process or two, a query worker)
// hit it on a busy CI runner, four in one run (ubuntu, 2026-10-19); timing that a test checks is its own
// assertion, never this. Tests that set their own timeout keep it.
import { setDefaultTimeout } from "bun:test";
setDefaultTimeout(60_000);
