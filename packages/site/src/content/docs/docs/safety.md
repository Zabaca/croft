---
title: "Safety: confirm, trash, restore"
description: Nothing implicit destroys ingested data. What needs a confirmation, what goes to the trash, and how to bring it back.
---

Ingested data may be impossible to fetch again: an API that keeps 90 days of history, a token that expired, an export that was deleted. So croft's rule is that nothing implicit destroys it.

## What croft never does on its own

- **Deleting an asset file** leaves its table in place, shown as "no asset file".
- **Renaming a file** outside croft is detected, and `croft rename <old> <new>` adopts the old table instead of refetching its history.
- **Columns** are never removed automatically, and **types** widen only when every stored value converts exactly.
- **Changing ingest code never refetches.** Changing an ingest's key, write mode or incremental field while it has data stops the run with `INGEST_CONFIG_CHANGED`, and asks how to go on.
- **A replace ingest that would lose more than half its rows** fails with `SHRINK_GUARD`. An expired token that returns `[]` must not wipe the table.
- **The scheduler runs only code a person has run.** An edited asset is held until it is run by hand once.

## What needs a confirmation

| Operation | Why |
|---|---|
| `croft run <ingest> --rebuild` | refetches; old history may be gone at the source |
| `croft run <transform> --rebuild` of an incremental TypeScript transform, or a large reprocessing | may spend money (one paid call per row) |
| `croft run <ingest> --allow-shrink` | removes most rows of an ingest |
| `croft delete <asset>`, `croft delete <asset> --where "…"` | removes a table or rows |
| `croft restore <asset>` | replaces the current table |
| a lossy type pin, or adding a key to an append ingest | rewrites stored values |

Each takes exact names only, with no globs. Each moves what it replaces or removes to the trash first.

These need no confirmation, because they can be recomputed or undone: a `--rebuild` of a SQL transform, `--from` backfills (an upsert), and `croft rename`.

## How a confirmation works

On a terminal, croft prints the impact and asks `Proceed? [y/N]`.

Off a terminal, which is how an agent runs it, the command stops with exit 5 and a confirmation in its JSON: a token, when it expires, the command, and the impact (the asset, the rows, where the trash copy goes, what downstream is affected). Then:

1. The agent shows the person the impact.
2. Only after the person says yes, it runs `croft confirm <token>`.
3. `croft confirm` counts the impact again, and refuses with `CONFIRMATION_STALE` if it changed in the meantime, for example because the scheduler added rows.

Tokens are single-use and expire after 15 minutes. No other command takes a token, and a destructive command never appears in any `next[]`. That is why one Claude Code rule, `"ask": ["Bash(croft confirm:*)"]`, gates every destructive step. See [Claude Code permissions](/docs/guides/claude-permissions/).

## The trash

A trashed version is a standalone DuckDB file in `.croft/trash/<asset>/`, holding the table (or the deleted rows) with its state, types preserved exactly.

```sh
croft restore                    # list the trash, newest first
croft restore orders             # bring back the newest version of orders
croft restore orders --at <time> # or another one
```

A restore puts the current table in the trash first, so a restore can itself be undone, and the transforms that read it rebuild. Versions are kept for 30 days, and the 5 newest of each table are kept however old.

`.croft/` holds the trash and the backups croft makes before a DuckDB upgrade, so it is not a cache. Never delete it, and never run `git clean -X` in a croft project.

See [The trash](/docs/guides/trash/) for the details.

## Backups

The trash undoes a croft command; a backup survives losing the folder or the disk. `croft backup` copies the warehouse, the run history and the trash, as one consistent moment, to a new folder:

```sh
croft backup                     # a new folder in .croft/backups/
croft backup /Volumes/Backup     # or inside a folder on another disk
```

It takes the file the way a croft writer does, so it is safe while `croft serve` runs or a run is going: serve steps aside for the moment a checkpoint and a copy-on-write clone take. Never copy `warehouse.duckdb` by hand; a copy taken mid-write, or with commits still in its WAL, can miss rows. croft never overwrites or deletes a backup. Putting one back is a few manual steps, described in [Backups](/docs/guides/backup/).
