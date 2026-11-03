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
  A changed input row is sent, and paid for, again; to pay once per key, write `incremental: { once: "key" }`.
  Preview them with `--rows 20`: by default a preview hands them up to 1,000 input rows, each a paid call.
- TS transforms read `newRows("x")` with no type argument: rows get x's column types, and `croft validate --types`
  catches a column renamed upstream. A BIGINT is `number | bigint`: `Number(row.x)` before arithmetic.
- Use `ctx.http` and `res.json()` (lossless numbers), never raw fetch + JSON.parse for API data.
- Nested fields are JSON: `col->>'field'`, `col->>'$[*].name'`, `json_each(col)`. `croft describe` lists keys.
  Parenthesise `->` beside AND, OR, NOT or =: `(col->'k') = 2` (without, DuckDB reads `col->('k' = 2)`). Lambdas: `lambda x: x + 1`, never `x -> x + 1`.
- Columns named like SQL keywords must be quoted: `"order"`.
- Apps read with `import { query } from "@zabaca/croft/read"`; `query<"x">(sql)` types the rows as table x's (croft docs serve). It talks to `croft serve` when one is running (found via CROFT_URL or .croft/serve.json), otherwise opens the file briefly. Never open the .duckdb files directly.
- `croft serve` runs until stopped: ask the user to start it in their own terminal instead of running it in your shell.
- A person who needs to read tables gets a key of their own (croft docs keys): the user names the tables to share in `serve.sharedTables`, then `croft serve key add <name>` prints the key once (`data.key` with `--json`; hand it to the user, never paste it elsewhere), `key list` shows who has one, `key remove <name>` takes access away at once. A key works only with `"serverMode"` on (`data.serverMode` of `key add --json` says whether it is; otherwise the key is refused until it is); with it on, `data.quack` is how their own DuckDB 2.0 attaches over Quack (croft docs quack).
- For a GUI (DuckDB UI, DBeaver), set "readCopy": true in croft.json and open warehouse.read.duckdb, never warehouse.duckdb. With `"serverMode"` on (croft docs server-mode) the copy is read-only on disk: open it read-only.

## APIs
- Keyset paging (re-query with since = newest value seen) ONLY if the API sorts ascending by that field.
  Newest-first APIs (Stripe, most list endpoints): filter by since and follow the API's own cursor
  (`croft new api x --pagination cursor`).
- Records that change after creation (payments, refunds, orders, tickets) need an updated-since field or a
  lookback: incremental: { field: "created", unit: "s", lookback: "30 days" }. Epoch cursors need `unit`.
- A status the code expects (a 404 for "not there"): `http.get(url, { okStatus: [404] })`, never
  `.catch(() => null)`, which also hides 429s and outages. Bytes (PDFs, images): `http.getBytes(url)`.
- An API with a stated quota (so many requests an hour or a day): ask the user to put it in croft.json
  `"http": {"budgets": {"<host>": {"perHour": 50}}}`. HTTP_WAIT or HTTP_BUDGET_SPENT: wait until the time it gives.

## Ask the user first (show the printed impact; wait for an explicit yes in this conversation)
- `croft confirm <token>` (every destructive action ends here: rebuild of an ingest or incremental TS transform,
  --allow-shrink, delete, restore, lossy pin changes, key conversion, large paid reprocessing).
- Adding `allowShrink: true`; changing key/write/incremental of an ingest that has data.
- Raising `confirmAbove` of a transform that makes requests (more paid calls would run without asking).
- Renaming or deleting files in assets/ (use `croft rename`); `croft schedule on|off|pause`.
- `croft serve` (it runs scheduled work unattended, and a `--host` other than 127.0.0.1 exposes data beyond this machine).
- `croft serve key add <name>` and naming tables in `serve.sharedTables`: they give a person access to data. Show which tables the key will read. `croft serve key remove` and `key list` need no asking.
- Turning `"serverMode"` on or off in croft.json (apps then read the read copy, as of the last run, and DuckDB 2.0 clients with a key can attach over Quack; turning it on also needs the server add-on installed, the `bun add` command `croft validate` prints when it is missing, croft docs addons), `serverMode.acceptFullCopyCost` (disk and write time at every run), and `serverMode.quackPlaintextOnNetwork` (it lets Quack listen beyond this machine, in plaintext, behind a proxy of the user's own).
- Adding or changing a `"lake"` block in croft.json (the warehouse then lives in a catalog and a bucket folder that someone else runs, with two logins and two keys named by secret names; it needs the lake add-on, the `bun add` command `croft validate` prints, croft docs lake). One machine writes a lake. Never make a Postgres, a bucket or a key yourself, never put a secret's value in croft.json, never run CHECKPOINT or set an expiry on a lake, and never put anything else in its folder (DuckLake's cleanup deletes it).
- Setting `lake.maintenance.enabled` to false (the lake then grows until `croft maintain` is run by hand), and `croft maintain --orphans` (it ends in `croft confirm`: the files it lists are not the lake's own and are gone for good once deleted). `croft maintain` itself, `croft maintain --dry-run` and `croft backup` of a lake need no asking: a pass removes nothing the 30 days or 5 versions promise keeps, and croft runs one by itself (every 24 hours unless `lake.maintenance.everyHours` says otherwise).
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
- Lake (croft docs lake): LAKE_CONNECTION_LOST or LAKE_ATTACH_FAILED are about the catalog or the bucket, not the project: check
  `croft doctor`, tell the user, run again when they are reachable. LAKE_COMMIT_UNCERTAIN: look at `croft status` before running
  again. LAKE_OTHER_WRITER: tell the user; do not run from this machine until they decide which machine writes.
- Lake maintenance: croft runs it by itself (croft docs lake); `croft maintain --dry-run` says what a pass would expire,
  `croft maintain` runs one. LAKE_MAINTENANCE_FAILED is a warning (the lake is fine, croft tries again within the hour).
  A version of a table in a lake older than a few days is read with `AT (VERSION => n)` or `AT (TIMESTAMP => ...)` in
  `croft query`, within the 30 days or the table's 5 newest versions.
- Backup: croft backup (into .croft/backups/), or croft backup <folder> on another disk; safe while croft serve
  runs. A lake's backup is a pg_dump of the catalog and a mirror of the bucket folder (LAKE_BACKUP_TOOL_MISSING: ask the
  user to install the Postgres client tools). Never copy warehouse*.duckdb by hand. Putting a backup back replaces
  data: ask the user (croft docs backup).

## Output
- JSON timestamps carry the project offset; ::DATE uses the croft.json timezone.
- `query` rows are capped: check data.truncatedRows before concluding anything; aggregate in SQL.
- `query` cuts values at 80 characters, with `--json` too (data.truncatedValues counts them); add `--full-values`.

## Long work
- Off a TTY, `croft run` returns after ~100 s with exit 6 and keeps running: `croft wait <runId> --timeout 100s`.
- Never retry a non-retryable error unchanged.
