# DB_BUSY: another croft process is writing the warehouse, and the wait ran out

Only one process can write a DuckDB file at a time. croft takes turns: a command that needs the file waits while
another croft run writes (off a terminal for at most 90 s, on one up to 10 minutes for a run), and --no-wait gives
up at once. DB_BUSY means the wait ended first. The message names the holder: croft run <id> and the asset it is
writing, croft's read server when it did not step aside, or the croft process by pid. details.holder and
details.waitedMs have the same.

It also covers the scheduler's per-user registry (~/.croft/projects.json), when another croft kept its lock for
more than 12 s, and a pre-upgrade backup waiting for a writer.

Nothing was changed; retryable is true.

What to do:
- croft status shows what is running. Wait for it: croft wait <runId> (the id the message names), then run the
  command again.
- Long runs are normal (a first load, a big backfill); do not stop them to get the file.
- A registry lock that stays busy: the hint names the process holding it; ask the user before killing anything.
- A program that is not croft holding the file is DB_HELD_BY_OTHER_PROGRAM.
