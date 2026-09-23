---
name: croft
description: Build and operate this project's data pipelines with the croft CLI (DuckDB). Use when adding a data
  source, loading an API or files, debugging a failed run, backfilling, or answering a question from project data.
---
<!-- croft {{version}} -->
croft is not dbt, dlt, SQLMesh or Dagster; do not assume their behavior. Ask the CLI: `croft docs <topic>`,
`croft docs <ERROR_CODE>`, `croft docs --list`, `croft help <command>`. Every command takes `--json` →
{ok, data, problems[], next[], confirmation?}.

## This version
{{phase}}

## Orient
croft context --json        # assets, columns, behavior, running, recent failures and schema changes, asset problems
croft status                # failed, never run, edited since its last run, no asset file

## Loop (always)
1. New asset: start from the closest template in `croft docs ingest` (API or file); don't invent APIs.
2. `croft run <name>`; apply each problem's `fix` and run it again. A broken asset file fails only its own step.
3. Verify with `croft query "..."` (one SELECT, 50-row cap) and `croft describe <name>` (behavior, columns, cursor, samples).
4. When a step fails: `croft logs <name> --failed`, fix the cause, `croft run <name>`.

## Conventions
- One file in assets/ = one table with that name; SQL says `FROM github_issues`. Shared code goes in lib/.
- To use a file, make a file ingest (`file: "files/x.csv"`); `croft query "from 'files/x.csv'"` looks at one first.
- PIVOT needs an IN list: `PIVOT t ON cat IN ('a', 'b') USING sum(x)`, or use `sum(x) FILTER (WHERE cat = 'a')`.
- Avoid now()/current_date in assets (values freeze until the next rebuild); compute ages at query time.
- Set `key` whenever records have an id. Incremental API ingests need a key.
- Use `ctx.http` and `res.json()` (lossless numbers), never raw fetch + JSON.parse for API data.
- Nested fields are JSON: `col->>'field'`, `col->>'$[*].name'`, `json_each(col)`. `croft describe` lists keys.
- Columns named like SQL keywords must be quoted: `"order"`.
- Apps read with `import { query } from "@zabaca/croft/read"` (it opens the file briefly per query). Never open the .duckdb files directly, in code or in a GUI (DuckDB UI, DBeaver): a program holding warehouse.duckdb blocks every run.

## APIs
- Keyset paging (re-query with since = newest value seen) ONLY if the API sorts ascending by that field.
  Newest-first APIs (Stripe, most list endpoints): filter by since and follow the API's own cursor
  (the cursor template in `croft docs ingest`).
- Records that change after creation (payments, refunds, orders, tickets) need an updated-since field or a
  lookback: incremental: { field: "created", unit: "s", lookback: "30 days" }. Epoch cursors need `unit`.

## Ask the user first (show the printed impact; wait for an explicit yes in this conversation)
- `croft confirm <token>` (every destructive action ends here; in this version that is `--allow-shrink`, which
  moves a replace ingest's current rows to the trash before it writes fewer).
- Adding `allowShrink: true`; changing key/write/incremental of an ingest that has data.
- Renaming or deleting files in assets/ (the table stays under the old name; this version cannot rename or drop it).
- Deleting .croft/ or warehouse*.duckdb, or `git clean -X` (the trash lives in .croft/).
- Weakening or deleting a failing check.

## Recipes
- Failed run: croft status --json → croft logs <asset> --failed → fix → croft run <asset> → croft status.
- Backfill (merge ingests: key + incremental): check the cursor with croft describe <asset>, then
  croft run <asset> --from -90d (or a date: --from 2026-06-24; a text cursor takes a value in its own format).
  The saved cursor never moves back.
- Wrong number: croft describe <asset> --json → query the upstream with the same filter; `croft docs internals`
  shows how _croft.writes maps rows to runs.
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
