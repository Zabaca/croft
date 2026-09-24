# SCHEDULER_STALE: scheduling is on, but no scheduler tick came for 3 minutes (warning)

Scheduling is on for the project, and every tick records a heartbeat. None came for more than 3 minutes (or
within 70 s of croft schedule on), so scheduled ingests are not running. details.cause names the likely cause
and details.logTail shows the end of the tick log. croft doctor shows the same diagnosis.

- privacy: macOS blocks the background job from a project in ~/Documents, ~/Desktop or ~/Downloads. The user
  gives Bun Full Disk Access (the hint names the path to add), or moves the project; then croft schedule on.
- bun_missing: the Bun the job runs is gone (a version manager's path, removed on upgrade). croft schedule on
  points the job at the Bun installed now.
- croft_missing: the project's croft is not installed; bun install in the project.
- wsl: the WSL VM sleeps when no terminal is open. Use croft schedule on --no-os-job and keep croft serve
  running in a WSL terminal.
- not_registered, job_missing, job_not_loaded: the job or the project's entry is gone; croft schedule on puts
  them back. A LaunchAgent needs a logged-in desktop session, not only SSH.
- serve_not_running: scheduling is on for croft serve only (--no-os-job) and croft serve is not running. Ask the
  user to start croft serve in their own terminal and keep it running.
- serve_not_ticking: croft serve runs but its ticks fail; read .croft/logs/tick.log.
- unknown: read the tick log the problem names (~/.croft/logs/tick.log for the per-user job).

croft schedule on, croft schedule off and restarting croft serve change what runs unattended: ask the user
first. croft docs scheduling explains the scheduler.
