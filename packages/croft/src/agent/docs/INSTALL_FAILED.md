# INSTALL_FAILED: something croft needed to install is not in place

Three things are installed, and INSTALL_FAILED says which one failed:
- the project's own packages: a project pins its croft in package.json, and the global croft runs that copy. When
  node_modules has no @zabaca/croft (croft init --no-install, or bun install failed or never ran), commands refuse;
- the scheduler's per-user job (croft schedule on): launchctl or crontab refused it, cron is not installed, or the
  system is neither macOS nor Linux;
- croft's own files: a croft install without its schemas/ folder.

What to do:
- Packages: run bun install in the project folder (the hint gives the exact command) and fix what it reports.
- The scheduler: follow the hint (log in to the Mac's desktop session for launchd; install and start cron on Linux),
  then croft schedule on again; ask the user before installing system software. Without an OS job, scheduling
  still works: croft schedule on --no-os-job, and keep croft serve running, which ticks every minute (croft docs
  scheduling).
- croft's own files: reinstall the project's packages. Then croft doctor to check.
