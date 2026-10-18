---
title: Runs, staleness and previews
description: How croft decides what to run, what a run does when one asset fails, and the three ways to try a change, from cheapest to most real.
---

## What `croft run` runs

`croft run` with no names runs every ingest, then every transform that is stale, in dependency order. `croft run <name>` runs that asset and the stale assets downstream of it. Two flags change the selection:

- `--only` runs the named assets and nothing downstream.
- `--upstream` also refreshes the stale assets the named ones read, first.

`croft run --dry-run` prints what would run and why, and runs nothing:

```text
fetch    duckdb_releases   replace; key id
fetch    example_sales     replace; key order_id (nothing is written when no file changed)
rebuild  revenue_by_region input example_sales may have new rows
dry run: 3 of 3 steps would run; nothing ran
```

## When a transform is stale

Every write stamps the rows it changed with one `_loaded_at`, and that stamp is the table's version. A transform is stale when:

- it was never built;
- an input has changed since the transform last read it;
- an input was replaced (after a restore, or a change made outside croft);
- or its own code changed.

A run that changes no rows does not move the version, so it wakes nothing downstream. Code includes `lib/` and the project timezone: an edit in `lib/` makes the assets that import it stale.

## When an asset fails

Each asset's write is all-or-nothing: rows, schema changes, checks, cursor and bookkeeping commit together. A run of several assets is deliberately not one transaction:

- a failed asset keeps its previous data;
- what reads it is skipped, and says why (`skipped: input open_issues failed`);
- everything else still runs.

`croft status` shows what failed, and `croft logs <asset> --failed` shows why. A crash, even `kill -9`, never leaves half a write: the next command that writes reconciles what happened, and an ingest's cursor moves only when its rows commit, so nothing is skipped.

## Three ways to try a change

From cheapest to most real.

**`croft validate` touches no data.** It parses every asset, checks configs, schedules, secrets and every check expression, and binds each SQL asset against its inputs' columns in dependency order. A misspelled column is an error here, with DuckDB's own candidate list. `--types` also type-checks TypeScript transforms against the columns they read.

**`croft preview <asset>` runs the code and changes nothing real.** It snapshots the inputs, builds the asset in a separate preview database, and diffs it against the live table: rows added, removed and changed by key, column changes, check results and a sample. An ingest really fetches, from its real cursor, but stops after `--rows` rows (1,000 by default); its cursor moves only in the preview. `croft query --preview` explores the result. `croft preview <asset> --rebuild` builds from scratch and compares, which is how to find drift or edits made outside croft.

**`croft run` is real.** Checks run before the commit, so a failing check still writes nothing.

There are no named environments to promote between. For one person whose rebuilds take seconds, preview, all-or-nothing writes and the trash cover the same need with fewer states for an agent to get wrong.

## Backfills

`croft run <ingest> --from -90d` refetches a merge ingest from 90 days ago (a date or an ISO time works too). It upserts by key, so nothing is duplicated, and the saved cursor never moves back. Run it with `--dry-run` first. The transforms it skipped are named in its `next[]`.

## Long runs

On a terminal, `croft run` runs in the foreground. Off one (an agent's shell, a script), it follows the run for about 100 seconds, then returns exit 6 while the run keeps going in the background; `croft wait <runId>` follows it again. `--foreground` keeps it in the process.
