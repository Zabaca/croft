# Scheduling: ingests that run on their own, and transforms that follow them

Only ingests have schedules. Add schedule: to an ingest (the templates in croft docs ingest show where):

  schedule: "every hour"          also: every 15 minutes, daily at 06:00, weekdays at 9am,
                                  every monday at 08:30, monthly, or a 5-field cron such as 0 6 * * 1-5

Transforms have no schedule: when a scheduled ingest runs, the stale transforms that read it run in the same
run. Times are in croft.json's timezone, and daylight saving time never drops or doubles a fire. croft validate
shows each schedule's cron and its next three fire times; croft docs SCHEDULE_INVALID lists every form.

## Turning it on (ask the user first)

croft schedule on|off|pause changes what runs unattended, so it is on the skill's "Ask the user first" list.

- croft schedule on: scheduling is on for this project. croft installs one scheduler job per user (a LaunchAgent
  on macOS, one crontab line on Linux) that checks every registered project every minute, and waits up to 70 s
  for its first tick. It survives restarts; a laptop that was asleep runs what it missed once when it wakes.
- croft schedule on --no-os-job: on, without the job, for servers, containers and WSL: croft serve ticks every
  minute while it runs (croft docs serve).
- croft schedule pause, or croft schedule pause --for 2h: nothing starts until the pause ends or croft schedule on.
- croft schedule off: nothing runs on a schedule; the job goes once no project needs it.
- croft schedule status (or croft schedule): the setting, the last tick, and each asset's schedule, next and
  last fire, whether it is due, and what holds it.

## What the scheduler runs

Every minute a tick looks at runs.sqlite (it imports no asset code unless an asset file changed) and starts one
croft run per group of due assets, in the background:

- an ingest whose schedule fired since it last ran, with the stale transforms downstream of it;
- any stale transform, even when no ingest is due (after croft run --only, say).

Missed fires run once: after 8 hours asleep, an hourly ingest runs once and its cursor fetches everything since.
An asset still running from an earlier run is skipped and stays due. croft logs --runs marks these runs
"schedule".

## Held: the scheduler only runs code a person has run

A new asset, or one whose code changed (its file, the lib/ code it imports, or its packages), is held until a
person runs it: SCHEDULE_HELD in croft status, croft context and croft schedule status, and the tick skips it.
croft run <asset> (or a croft preview <asset> that succeeds) releases it. Check the preview first. Other holds:
LARGE_REPROCESS (a transform that pays per row met its cost guard in a scheduled run: croft run <asset> asks the
user), a pause, and an asset another run holds.

## When a scheduled run fails

- Retryable errors (network, 429 and 5xx after ctx.http's own retries, DB_BUSY) get two more attempts, after
  30 s and 2 min. Deterministic errors (HTTP 4xx, TYPE_CONFLICT, CHECK_FAILED, SQL errors) are not retried.
- A failed ingest waits for its next fire. A failed transform waits for a change to its code or inputs (15
  minutes after a retryable failure). Nothing is retried every minute.
- A desktop notification names the project, the asset and the error, unless croft.json says
  "notify": {"desktop": false}. "notify": {"webhook": "https://..."} also posts the failure envelope (what
  croft run --json prints, with .env values redacted) to that URL. .croft/logs/notify.log says why a
  notification did not go out.
- Fix it the usual way: croft status --json, croft logs <asset> --failed, fix, croft validate --json,
  croft preview <asset>, croft run <asset>. The run by hand also releases the edited asset.

## When nothing runs

croft status and croft doctor report SCHEDULER_STALE when no tick came for 3 minutes, with the likely cause and
the end of the tick log: ~/.croft/logs/tick.log for the per-user job, .croft/logs/tick.log for croft serve.
croft docs SCHEDULER_STALE lists the causes.
