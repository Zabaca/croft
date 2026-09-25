---
name: croft
description: Build and operate this project's data pipelines with the croft CLI (DuckDB). Use when adding a data
  source, writing SQL or TypeScript transforms, adding checks, scheduling, debugging a failed run, backfilling,
  renaming, or answering a question from project data.
---
<!-- croft {{version}} -->
croft is not dbt, dlt, SQLMesh or Dagster; do not assume their behavior. Ask the CLI: `croft docs <topic>`,
`croft docs <ERROR_CODE>`, `croft docs --list`, `croft new --list`. Every command takes `--json` →
{ok, data, problems[], next[], confirmation?}.

## Orient
croft context --json        # assets, columns, behavior, schedules, running, held, recent failures and schema changes
croft status                # failed, stale, held, never run, edited since its last run, no asset file

## Loop (always)
1. New asset: `croft new api|file|sql|transform <name>`; edit the template, don't invent APIs.
2. `croft validate --json` after EVERY edit; apply each problem's `fix`. When the edit is to a TS transform or
   an asset one reads, add `--types`: tsc then checks the columns the transform reads.
3. `croft preview <name>`: read columns, checks, diff and samples.
4. `croft run <name>`; then verify with `croft query "..."` (one SELECT, 50-row cap).

## Conventions
- One file in assets/ = one table with that name; SQL says `FROM github_issues`. Shared code goes in lib/.
- SQL assets: `-- name: value` header lines (description, key, check, warn), then ONE SELECT (a trailing `;` is fine).
  SQL transforms are always rebuilt in full; there is no incremental SQL. Only ingests have schedules.
- SQL assets read assets, never files: to use a file, make a file ingest (`croft new file x`).
- PIVOT needs an IN list: `PIVOT t ON cat IN ('a', 'b') USING sum(x)`, or use `sum(x) FILTER (WHERE cat = 'a')`.
- Avoid now()/current_date in assets (values freeze until the next rebuild); compute ages at query time.
- Set `key` whenever records have an id. Incremental API ingests need a key.
- TS transforms that call an API or LLM per row: keep `incremental: true` + `newRows()` (the template default).
  Preview them with `--rows 20`: by default a preview hands them up to 1,000 input rows, each a paid call.
- TS transforms read `newRows("x")` with no type argument: rows get x's column types, and `croft validate --types`
  catches a column renamed upstream. A BIGINT is `number | bigint`: `Number(row.x)` before arithmetic.
- Use `ctx.http` and `res.json()` (lossless numbers), never raw fetch + JSON.parse for API data.
- Nested fields are JSON: `col->>'field'`, `col->>'$[*].name'`, `json_each(col)`. `croft describe` lists keys.
- Columns named like SQL keywords must be quoted: `"order"`.
- Apps read with `import { query } from "@zabaca/croft/read"`. It talks to `croft serve` when one is running (found via CROFT_URL or .croft/serve.json), otherwise opens the file briefly. Never open the .duckdb files directly.
- `croft serve` runs until stopped: ask the user to start it in their own terminal instead of running it in your shell.
- For a GUI (DuckDB UI, DBeaver), set "readCopy": true in croft.json and open warehouse.read.duckdb, never warehouse.duckdb.

## APIs
- Keyset paging (re-query with since = newest value seen) ONLY if the API sorts ascending by that field.
  Newest-first APIs (Stripe, most list endpoints): filter by since and follow the API's own cursor
  (`croft new api x --pagination cursor`).
- Records that change after creation (payments, refunds, orders, tickets) need an updated-since field or a
  lookback: incremental: { field: "created", unit: "s", lookback: "30 days" }. Epoch cursors need `unit`.

## Ask the user first (show the printed impact; wait for an explicit yes in this conversation)
- `croft confirm <token>` (every destructive action ends here: rebuild of an ingest or incremental TS transform,
  --allow-shrink, delete, restore, lossy pin changes, key conversion, large paid reprocessing).
- Adding `allowShrink: true`; changing key/write/incremental of an ingest that has data.
- Raising `confirmAbove` of a transform that makes requests (more paid calls would run without asking).
- Renaming or deleting files in assets/ (use `croft rename`); `croft schedule on|off|pause`.
- `croft serve` (it runs scheduled work unattended, and a `--host` other than 127.0.0.1 exposes data beyond this machine).
- Deleting .croft/ or warehouse*.duckdb, or `git clean -X` (the trash and backups live in .croft/).
- Weakening or deleting a failing check.

## Recipes
- Failed run: croft status --json → croft logs <asset> --failed → fix → croft validate --json → croft preview <asset>
  → croft run <asset> → croft status.
- Held asset: it was edited and not run by hand; run it by hand once (croft run <asset>) after checking the preview.
- Schedule: add `schedule: "every hour"` to the ingest (`croft docs scheduling`); `croft validate` shows the next fires;
  run it by hand once (new code is held until then), then ask the user before `croft schedule on`.
- Backfill: croft run <asset> --dry-run --from -90d, then the same without --dry-run. Merge ingests only.
  Then run the transforms it skipped (its next[] names them), or they stay stale.
  A date works too (--from 2026-06-24); a text cursor takes a value in its own format. The saved cursor never moves back.
- Rename: croft rename <old> <new>; fix every reference it lists; validate; preview; run.
- Wrong number: croft describe <asset> --json → croft preview <asset> --rebuild (drift) → query the upstream
  with the same filter; `croft docs internals` shows how _croft.writes maps rows to runs.
- API changed: new fields appear automatically; fill them for old rows with --from (merge ingests).
  TYPE_CONFLICT: clean the value in rows()/map() first; a pin can rewrite stored values.
- Missing secret: ask the user to add NAME=... to .env (or run `croft secrets set NAME` in their terminal);
  check with `croft secrets --json`. Never read .env.
- Warehouse file missing (DB_NOT_FOUND in status): ask the user where it went before running anything; a run
  builds a new, empty one and refetches from the sources.

## Output
- JSON timestamps carry the project offset; ::DATE uses the croft.json timezone.
- `query` rows are capped: check data.truncatedRows before concluding anything; aggregate in SQL.

## Long work
- Off a TTY, `croft run` returns after ~100 s with exit 6 and keeps running: `croft wait <runId> --timeout 100s`.
- Never retry a non-retryable error unchanged.
