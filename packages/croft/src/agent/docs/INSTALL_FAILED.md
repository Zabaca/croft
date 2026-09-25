# INSTALL_FAILED: something croft needed to install is not in place

Three things are installed, and INSTALL_FAILED says which one failed:
- the project's own packages: a project pins its croft in package.json, and the global croft runs that copy. When
  node_modules has no @zabaca/croft (croft init --no-install, or bun install failed or never ran), commands refuse;
- the scheduler's per-user job (croft schedule on): launchctl or crontab refused it, cron is not installed, or the
  system is neither macOS nor Linux;
- croft's own files: a croft install without its schemas/ folder.

croft validate --types also reports what its type check needs, as info: nothing failed, but the TS transforms were
not checked, or not fully. Its file is tsconfig.json, or none:
- no TypeScript compiler (node_modules/.bin/tsc): types were not checked. package.json lists typescript;
- no tsconfig.json: types were not checked;
- a tsconfig.json whose "include" leaves out .croft/types (a project made before croft generated input row types):
  tsc ran, but read every input row as a Row, so it cannot catch a column renamed upstream (UNKNOWN_INPUT_COLUMN).

What to do:
- Packages: run bun install in the project folder (the hint gives the exact command) and fix what it reports.
- The scheduler: follow the hint (log in to the Mac's desktop session for launchd; install and start cron on Linux),
  then croft schedule on again; ask the user before installing system software. Without an OS job, scheduling
  still works: croft schedule on --no-os-job, and keep croft serve running, which ticks every minute (croft docs
  scheduling).
- croft's own files: reinstall the project's packages. Then croft doctor to check.
- No tsc: run bun install in the project folder; croft never installs it itself. Then croft validate --types.
- No tsconfig.json: add one that includes assets, lib and .croft/types (croft init writes one for a new project:
  strict, moduleResolution "bundler", types ["bun"]). Then croft validate --types.
- A tsconfig.json without .croft/types: add ".croft/types/**/*.d.ts" to "include", as croft init writes it (the fix
  is that edit). Then croft validate --types checks the column names each TS transform reads.
