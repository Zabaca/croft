// Loaded before every test file (bunfig.toml [test] preload): tripwires for what a test must never touch on
// the machine that runs it. CROFT_FORBID_OS_JOBS: registering the scheduler (launchd, crontab) refuses instead of
// installing a job. CROFT_NOTIFY_DRY: a failure notification is logged instead of shown. Both take effect in
// this process and in children given this environment; tests/e2e/harness.ts passes them to every croft it
// spawns.
process.env.CROFT_FORBID_OS_JOBS = "1";
process.env.CROFT_NOTIFY_DRY = "1";
