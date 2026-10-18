---
title: The seven concepts
description: Asset, run, key, incremental, check, schedule and secret. Everything else croft either infers or brings up when it is needed.
---

croft has seven concepts. Everything else is either inferred, or appears in the fix of the error that calls for it, so nobody has to learn it up front.

## 1. Asset

One file in `assets/` makes one table with the file's name. There are two kinds.

- **An ingest** (`ingest()` in a `.ts` file) brings data in from an API or from files. Ingested data may be impossible to fetch again, so croft never refetches or deletes it on its own.
- **A transform** computes a table from other assets: a `.sql` file holding one `SELECT`, or `transform()` in a `.ts` file for per-row code such as one API or LLM call per row. Transforms can always be recomputed, so croft rebuilds them whenever their code or inputs change.

Names match `[a-z][a-z0-9_]*`, are unique across `assets/**`, and live in DuckDB's `main` schema, so SQL always says `FROM github_issues`. Subfolders are for organization only. Shared code goes in `lib/`. SQL keywords such as `order` are refused as names, with a suggested plural.

## 2. Run

`croft run` updates tables. Anything that reads an updated table is updated after it, in the same run. croft finds what a SQL asset reads with DuckDB's own parser, and what a TypeScript transform reads from its `inputs`; there is no dependency list to keep. See [Runs, staleness and previews](/docs/runs/).

## 3. Key

The column or columns that identify a row, such as `id`. With a key, a row that arrives again replaces its old version instead of being duplicated. A key is always unique and never empty, and croft checks both on every write.

## 4. Incremental

Only handle what is new.

- An API ingest names a field, such as `updated_at`, and receives `since`: the newest value it loaded, handed back on the next run.
- A file ingest loads only new or changed files.
- A TypeScript transform reads `newRows()`.
- SQL transforms are always rebuilt in full, which takes seconds on a local DuckDB.

Records that change after they are created (payments, refunds, orders) need an updated-since field, or a lookback: `incremental: { field: "created", unit: "s", lookback: "30 days" }`.

## 5. Check

A rule every row, or the table, must pass, such as `not_null(order_date)`, `amount >= 0` or `min_rows(100)`. Checks run on the rows before they are saved: if one fails, nothing is written and the table keeps its previous data. A **warning** reports a problem without blocking. See [Checks](/docs/guides/checks/).

## 6. Schedule

When an ingest runs on its own, in plain words: `"every hour"`, `"weekdays at 9am"`, `"daily at 6am"`. Transforms have no schedule; they follow their inputs. See [Scheduling](/docs/guides/scheduling/).

## 7. Secret

A value in `.env` that an asset asks for by name: `secrets: ["STRIPE_KEY"]`, then `secret("STRIPE_KEY")`. croft reads `.env` itself and replaces every value from it with `[redacted:NAME]` in its output. See [Secrets](/docs/guides/secrets/).

## How each run writes, inferred

You never pick a write mode. croft infers it from the key and incremental, and `croft describe` says it in plain words:

| Key | Incremental | Each run… |
|---|---|---|
| no | no | replaces the table's contents (unchanged rows keep their `_loaded_at`) |
| yes | no | replaces the contents; the key must be unique |
| no | yes | adds the new rows (only with an explicit `write: "append"`) |
| yes | yes | updates rows whose key matches and adds the rest |

## Three verbs that protect you

These are commands, not concepts:

- `croft preview` tries a change without touching real tables.
- `croft restore` brings back something from the trash.
- `croft confirm` carries out a destructive action after its impact has been shown.

See [Safety](/docs/safety/).

## Things you see but never have to learn

- `_loaded_at` on every table: when each row last changed.
- `_file` on file ingests: which file a row came from.
- `.croft/`, the state folder croft owns. It holds the trash and backups, so it is not a cache: never delete it.
