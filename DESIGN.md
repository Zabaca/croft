# croft: design v1

> **Status.** Final design for v1, dated 2026-09-22. It was produced by a design panel: four independent drafts (simplicity, AI operator, correctness and builder lenses), a synthesis, and three adversarial reviews (a non-data-engineer walking real journeys, Claude Code operating the tool, and a technical review backed by spikes). Claims are marked **[V]** when verified by a spike on Bun 1.3.14 with `@duckdb/node-api` 1.5.5-r.5 (DuckDB 1.5.5) on macOS arm64, and **[U]** when relied on but unverified. Appendix B lists the spikes. The working name during design was "tsdb"; the product is named **croft** (D52).

## Thesis

croft is one TypeScript/Bun command-line tool that replaces the Dagster + dlt + SQLMesh stack for people who are not data engineers and who build with Claude Code. It has three parts:

- **Ingest (the dlt part).** An ingest pulls data from APIs and files.
- **Transform (the SQLMesh part).** A transform computes tables from other tables in SQL or TypeScript.
- **Keep fresh (the Dagster part).** croft keeps everything up to date on a schedule.

All data lives in one local DuckDB file.

A croft project is a folder. Each file in `assets/` defines one table, and the table has the file's name. `croft run` brings tables up to date, and every table that reads an updated table is updated after it in the same run.

Every write is all-or-nothing, and checks run on the rows before they are saved. croft never refetches or deletes ingested data on its own, because that data may be impossible to fetch again. Anything destructive goes through the trash and needs explicit confirmation.

**Who operates it.** In practice Claude Code will write most assets and run most commands, so the tool is designed for two users at once:

- **The human** gets few concepts, zero setup and plain-language output.
- **The agent** gets `--json` on every command, stable error codes with machine-applicable fixes, a fast side-effect-free validation loop, and a shipped skill.

**Requirements.** These come from the user:

1. The audience is non-data-engineers who build with Claude Code, and setup must simply work.
2. There is no compatibility with dlt, SQLMesh or Dagster formats.
3. It is CLI only; there is no UI.
4. DuckDB is the only target.

---

## 1. Mental model & vocabulary

A user learns **seven concepts**.

| # | Concept | What the user needs to know |
|---|---|---|
| 1 | **Asset** | One file in `assets/` makes one table with that file's name. An **ingest** (`ingest()` in a `.ts` file) brings data in from an API or from files. A **transform** (a `.sql` file holding one SELECT, or `transform()` in a `.ts` file) computes a table from other assets. Ingested data may be impossible to fetch again, so croft never refetches or deletes it on its own. Transforms can always be recomputed, so croft rebuilds them whenever their code or inputs change. |
| 2 | **Run** | `croft run` updates tables. Anything that reads an updated table is updated after it, in the same run. |
| 3 | **Key** | The column or columns that identify a row, such as `id`. With a key, a row that arrives again replaces its old version instead of being duplicated. A key is always unique and never empty; croft checks this. |
| 4 | **Incremental** | Only handle what is new. An API ingest names a field (such as `updated_at`) and receives `since`. A file ingest loads only new or changed files. A TypeScript transform reads `newRows()`. SQL transforms are always rebuilt in full, which takes seconds on a local DuckDB. |
| 5 | **Check** | A rule every row, or the table, must pass. If a check fails, nothing is written and the table keeps its previous data. A **warning** reports a problem without blocking. |
| 6 | **Schedule** | When an ingest runs on its own, for example `"every hour"`. Transforms have no schedule: they follow their inputs. |
| 7 | **Secret** | A value in `.env` that an asset asks for by name. |

**Three verbs protect the user.** They are commands, not concepts:

- `croft preview` tries a change without touching real tables.
- `croft restore` brings back something from the trash.
- `croft confirm` approves a destructive action after its impact has been shown.

**Advanced options appear only when needed.** Examples are column type pins, a cursor's `lookback` or `unit`, and a CSV `encoding`. Each of these appears in the `fix` of the error that calls for it, so nobody has to learn them up front. The honest count for a typical journey (the "Stripe and GitHub into a revenue table" walk-through in the reviews) is the seven concepts, JSON column access (`col->>'field'`), and one or two options surfaced by errors.

**Things the user sees but never has to learn:**

- `_loaded_at` on every table, recording when each row last changed.
- `_file` on file ingests.
- The tool-owned `.croft/` folder.

**Write behavior is inferred from key and incremental.** It is always stated in plain words by `describe` and in run output. An optional `write:` setting overrides the inference.

| key | incremental | Each run… | (DE name) |
|---|---|---|---|
| – | – | replaces the table's contents (unchanged rows keep their `_loaded_at`) | replace |
| ✓ | – | replaces the contents; the key must be unique | replace + PK |
| – | ✓ | adds the new rows (only allowed with an explicit `write: "append"`, see §3) | append |
| ✓ | ✓ | updates rows whose key matches and adds the rest | merge / upsert |

**Data-engineering jargon is hidden:**

| Jargon | What replaces it |
|---|---|
| DAG, lineage, dependency declaration | croft reads your SQL with DuckDB's own parser, and TS `inputs`; `describe` shows "reads / read by" |
| Write disposition, model kinds, materializations | inferred from *key* and *incremental* (table above) |
| Partitions, intervals, watermarks, cursors | `since`, `newRows()`, `--from` |
| Schema inference, evolution, normalization, variant columns | automatic, with one published rule set; real conflicts fail loudly with fixes (§7) |
| Fingerprints, snapshots, virtual environments, plan/apply | "code changed → rebuilt"; `run --dry-run` explains; `preview` tries |
| Write-audit-publish, audits | "checks run before anything is saved" |
| Sensors, auto-materialize | "transforms follow their inputs" |
| Ops, jobs, IO managers, resources | none; `ctx.http` and `ctx.secret()` |
| Backfill | a flag: `croft run stripe_charges --from -90d` |

---

## 2. Install & bootstrap

**From zero:**

```sh
curl -fsSL https://bun.sh/install | bash   # only if `bun --version` fails or is older than 1.3.14
bun add -g croft                            # installs the `croft` launcher into ~/.bun/bin
croft init my-data                          # scaffolds, runs bun install, runs the offline example
cd my-data
croft query "from example_sales limit 5"
```

```
$ croft init my-data
Created my-data/ (croft 0.1.0, timezone America/Los_Angeles)
Installed dependencies (bun install, 2.1 s)
Ran example_sales: 120 rows · checks ok
Next: cd my-data && croft query "from example_sales limit 5"
Claude Code: CLAUDE.md and .claude/skills/croft/SKILL.md are ready.
```

**The launcher.** The global `croft` is only a launcher:

- It walks up from the current directory to the nearest `croft.json`, changes into the project root, and execs that project's pinned copy in `node_modules/croft` with `bun --no-env-file`. That way the global and project versions can never disagree, and Bun's automatic `.env` loading (which depends on the working directory and also reads `.env.local`) is switched off [V]. croft reads `<root>/.env` itself (§9).
- If `node_modules` is missing (for example after `git clone`), it runs `bun install` first.
- Outside a project, only `init`, `doctor`, `docs` and `--version` work.
- If `~/.bun/bin` is not on `PATH`, `bunx croft …` inside the project resolves the same local binary.

The CLI ships TypeScript source with a `#!/usr/bin/env bun` bin, so it has no build step. The one exception is `croft/read`, the helper apps import (§5). It ships as prebuilt JavaScript plus `.d.ts`, because Node refuses to strip types from files under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) [V]. The built `read.js` ran under Node 24.3 and 24.20 [V].

**`croft init` in an empty folder** generates:

| File | Contents |
|---|---|
| `croft.json` | `{"$schema": "./node_modules/croft/croft.schema.json", "database": "warehouse.duckdb", "timezone": "America/Los_Angeles"}`. The timezone is detected at init, so "daily at 06:00" keeps its meaning on a UTC server. Optional keys: `readCopy` (default `true`), `notify`, `concurrency`. |
| `package.json` | `{"private": true, "type": "module", "dependencies": {"croft": "0.1.0"}, "devDependencies": {"@types/bun": "1.3.14", "typescript": "5.9.2"}}`, with exact pins |
| `tsconfig.json` | strict, `moduleResolution: "bundler"`, `types: ["bun"]`, includes `assets` and `lib`. Editors and Claude get type errors. |
| `.env` / `.env.example` | `# Secrets for your assets, e.g. GITHUB_TOKEN=...`. `.env` is git-ignored. |
| `.gitignore` | `warehouse*.duckdb*`, `.croft/`, `.env`, `node_modules/` |
| `CLAUDE.md` | a managed block between markers (§9); appended if the file already exists |
| `.claude/skills/croft/SKILL.md` | the version-stamped skill (§9) |
| `assets/example_sales.ts` | a file ingest of `files/example_sales.csv`, so the first run needs no network |
| `files/example_sales.csv` | 120 rows of sample data |

**`croft init` inside an existing app repo.** "Add data pipelines to my app" is a common starting point. When the target folder already has a `package.json`, init never overwrites the app's files:

- It creates the project in a `data/` subfolder with its own `package.json`, `tsconfig.json` and `.gitignore`.
- It adds `"data"` to the root `tsconfig.json` `exclude` list, so `next build` does not type-check assets without Bun types. It shows this edit as a diff and applies it only with confirmation on a TTY; otherwise it prints it.
- It appends a root `CLAUDE.md` block that points at `data/`. The block says: "read croft data only with `import { query } from "croft/read"`; never open the .duckdb file directly".
- It prints the one app-side step: `bun add croft` (or npm/pnpm) in the app, plus `serverExternalPackages: ['@duckdb/node-api']` for Next.js.

**Runtime files.** croft creates these at runtime. The user never edits them:

- `warehouse.duckdb`, and `warehouse.read.duckdb`, the read copy for apps and GUIs (§5).
- `.croft/`, containing `runs.sqlite`, `staging/`, `logs/`, `trash/`, `backups/` and `preview.duckdb`.

**Synced and network folders.** On many Macs, `~/Documents` and `~/Desktop` are synced to iCloud by default. File sync can corrupt a DuckDB file mid-write and breaks its locks. The same applies to Dropbox, OneDrive, network filesystems and WSL's `/mnt/<drive>` (drvfs/9p). When `init` or `doctor` detects such a location (by path prefix plus `statfs`), croft moves the database and `.croft/` to `~/.local/share/croft/<project>-<hash>/`. It records that path in `croft.json` and says so in plain words. Asset files stay in the project folder.

**Dependencies:**

- **Bun ≥ 1.3.14.** This is the version everything was verified on, and the launcher enforces it with `BUN_TOO_OLD`. `package.json` declares `"engines": {"bun": ">=1.3.14"}`. Bun 1.4.2 is the current `latest`, and CI runs against `bun@latest` as well as the floor. `doctor` warns (instead of printing ok) on a Bun newer than the last CI-tested one.
- **One runtime npm dependency**, `@duckdb/node-api` 1.5.5-r.5, pinned exactly. It ships prebuilt native libraries as optional per-platform packages (darwin x64/arm64, linux x64/arm64 for glibc and musl, win32 x64/arm64) with no postinstall script, so Bun's lifecycle-script blocking does not affect it [V]. DuckDB 1.5.5 loaded on Bun 1.3.0 through 1.4.2 [V]. The Linux binding needs glibc ≥ 2.25 [V].
- **No extension downloads.** The `json`, `parquet` and `icu` extensions are statically linked [V], so croft never runs `INSTALL`. URL files are fetched with Bun's `fetch`, not httpfs.
- **Nothing else.** Everything else is a Bun built-in. There is no Python, Docker, system DuckDB or virtualenv; `bun.lock` is the whole environment.

**Platforms:**

- **Tier 1 (CI):** macOS arm64/x64, Linux x64/arm64 with glibc.
- **Tier 2 (smoke test only):** Linux musl. Runtime behavior there is [U].
- **Windows:** use WSL with the project inside the Linux filesystem, not under `/mnt/c`. Native Windows is unsupported in v1, because its lock and rename semantics differ (a read copy cannot be renamed over a file a reader has open) and none of it is exercised.
- **WSL** otherwise works as Linux. `doctor` warns that WSL stops its VM when no terminal is open, so scheduled runs pause.

**Install-time failures.** `doctor` runs after `init` and whenever the launcher detects a problem. Every CLI start runs a cheap subset of these checks.

| Problem | Detection | Code and fix |
|---|---|---|
| Bun missing or too old | launcher checks `Bun.version` | `BUN_TOO_OLD`: `bun upgrade` |
| Started with Node (`npx croft`) | shebang guard | `NEEDS_BUN`: the Bun install one-liner |
| Native binding missing (optional deps skipped, `node_modules` copied from another OS, x64 Bun under Rosetta) | `import("@duckdb/node-api")` in a subprocess fails, or binding arch ≠ `process.arch` | `DUCKDB_BINDING_MISSING`: `rm -rf node_modules && bun install`, or "install the arm64 build of Bun" |
| Binding fails to load (old glibc) | dlopen error text | `DUCKDB_BINDING_LOAD`: required glibc version |
| Database written by a newer DuckDB/croft | `_croft.meta.format_version` | `DB_NEWER_FORMAT`: refuses to open rather than risk a downgrade |
| Database held by another program (DuckDB CLI/UI, DBeaver, the user's app) | parse DuckDB's lock error `…held in <path> (PID n)` [V] | `DB_HELD_BY_OTHER_PROGRAM`: "close /opt/homebrew/bin/duckdb (PID 812); point GUIs at warehouse.read.duckdb instead" |
| Synced, network or WSL-drvfs storage | path prefix + `statfs` | database relocated automatically (above); `doctor` shows where |
| Project not writable | test write to `.croft/` | plain explanation |
| Referenced secret missing | declared `secrets` vs environment and `.env` | `SECRET_MISSING`: "add NAME=… to .env (or `croft secrets set NAME`)" |
| Claude files older than the CLI | version stamp in SKILL.md | `CLAUDE_FILES_OUTDATED`: `croft init --claude` |
| Scheduler not ticking | heartbeat older than 3 min | `SCHEDULER_STALE`, with the tail of the tick log and a likely cause (§8) |

```
$ croft doctor
Environment
  ok    bun 1.3.14 (darwin-arm64), needs >= 1.3.14
  ok    croft 0.1.0 (project-pinned; launcher 0.1.0)
  ok    duckdb 1.5.5 binding darwin-arm64 · json, parquet, icu built in
  ok    warehouse.duckdb 412 MB · writable · not locked · format written by duckdb 1.5.5
  ok    read copy warehouse.read.duckdb refreshed 5 min ago · APFS clone (instant)
Project
  ok    6 assets · 0 errors, 1 warning (details: croft validate)
  warn  SECRET_MISSING STRIPE_KEY (used by stripe_charges)
        fix: add STRIPE_KEY=... to .env (or run `croft secrets set STRIPE_KEY` in your terminal)
Scheduling
  off   turn on with: croft schedule on
1 warning
```

---

## 3. Asset definitions

### Layout and naming

- An asset's name is its file's base name. It must match `[a-z][a-z0-9_]*` and be unique across `assets/**`.
- Subfolders are for organization only.
- Every table lives in DuckDB's `main` schema, so SQL always says `FROM github_issues`.
- `new`, `croft` and names starting with `_` are reserved.
- DuckDB's 75 reserved keywords (`order`, `end`, `limit`, `window`, `group`, …) are rejected with `NAME_RESERVED` and a suggested plural ("rename to orders"), because `FROM order` is a parser error in every downstream asset [V].
- A `.ts` file and a `.sql` file with the same name is `NAME_CONFLICT`.

```
my-data/
  croft.json  package.json  tsconfig.json  .env  CLAUDE.md  .claude/skills/croft/SKILL.md
  assets/
    github_issues.ts     (a) API ingest: secret, ascending keyset pages, incremental → merge
    stripe_charges.ts    (a) API ingest: newest-first cursor pages, epoch cursor with lookback → merge
    taxi_zones.ts        (b) CSV from a URL → replace
    sales.ts             (b) folder of CSV exports, only new/changed files
    open_issues.sql      (c) SQL transform
    daily_revenue.sql    (d) SQL transform (aggregate; always a full rebuild in v1)
    issue_triage.ts      (e) TS transform reading github_issues, incremental → merge
  lib/triage.ts          shared code (never an asset; changes are detected)
  files/sales/*.csv      input files the user drops in
```

### (a) API ingests

**GitHub issues.** This API sorts ascending and filters by "updated since", so keyset paging is safe.

```ts
// assets/github_issues.ts
import { ingest, fail } from "croft";

type Issue = { id: number; updated_at: string };

export default ingest({
  description: "Issues and pull requests of oven-sh/bun",
  schedule: "every hour",
  secrets: ["GITHUB_TOKEN"],
  key: "id",                    // a re-fetched issue replaces its old row
  incremental: "updated_at",    // croft remembers the newest updated_at it saved
  checks: ["not_null(title)", "state IN ('open', 'closed')"],

  async *rows({ since, http, secret }) {
    // since: undefined on the first run, later the saved value, e.g. "2026-09-22T17:58:03Z"
    let from = since;
    for (;;) {
      const res = await http.get("https://api.github.com/repos/oven-sh/bun/issues", {
        headers: { Authorization: `Bearer ${secret("GITHUB_TOKEN")}` },
        query: { state: "all", sort: "updated", direction: "asc", per_page: 100, since: from },
      });
      const page = res.json<Issue[]>();
      yield page;                                   // an array is one batch of rows
      if (page.length < 100) return;                // last page
      const last = page.at(-1)!.updated_at;
      if (last === from) fail("KEYSET_STUCK", "100+ issues share one updated_at");
      from = last;                                  // ask again from the newest value seen
    }
  },
});
```

**Stripe charges.** This API returns the newest first, pages with `starting_after`, has no "updated since" filter, and uses epoch seconds. Charges also change after creation (refunds, disputes, captures), so the ingest re-reads a 30-day window on every run and merges by id.

```ts
// assets/stripe_charges.ts
import { ingest } from "croft";

type Charge = { id: string; created: number };
type Page = { data: Charge[]; has_more: boolean };

export default ingest({
  description: "Stripe charges; re-reads the last 30 days to pick up refunds and disputes",
  schedule: "every hour",
  secrets: ["STRIPE_KEY"],
  key: "id",
  incremental: { field: "created", unit: "s", lookback: "30 days" },
  checks: ["amount >= 0", "not_null(currency)"],

  async *rows({ since, http, secret }) {
    // since is a number here (epoch seconds, already minus 30 days); undefined on the first run
    let after: string | undefined;
    for (;;) {
      const res = await http.get("https://api.stripe.com/v1/charges", {
        headers: { Authorization: `Bearer ${secret("STRIPE_KEY")}` },
        query: { limit: 100, "created[gte]": since, starting_after: after },
      });
      const page = res.json<Page>();
      yield page.data;
      if (!page.has_more || page.data.length === 0) return;
      after = page.data.at(-1)!.id;
    }
  },
});
```

`croft new api <name> --pagination keyset|cursor|link|page` writes these patterns, each with a comment saying when it applies:

- `keyset` re-queries from the newest value seen and needs an ascending sort.
- `cursor` follows the API's own cursor (`starting_after`/`has_more`, `next_page_token`).
- `link` follows `res.next` from the `Link` header.
- `page` uses page numbers and is only safe for data that does not change during extraction.

The skill states the rules in plain words (§9):

- Use keyset only when the API sorts ascending by that field.
- Records that change after they are created need an "updated since" field or a `lookback`.

**Cursor semantics.** croft enforces these; user code does not have to.

- **Typed cursor.** On the first load, the cursor field's column type fixes the cursor type:
  - a timestamp or date column gives a timestamp cursor;
  - an integer column gives an integer cursor, with `unit: "s" | "ms"` if it holds epoch time;
  - a text column gives a string cursor.
- **`since` keeps the source's JSON type.** A timestamp cursor receives the *original text* the API sent, for example `"2026-09-22T17:58:03Z"`. An integer cursor receives a number.
- **Typed maximum.** After staging, croft computes the maximum on the *typed* column in DuckDB, so timestamps with different offsets compare as instants. It then stores that row's original text.
- **Commits with the data.** The cursor is saved in the same transaction as the rows.
- **Never regresses.** The new cursor is `greatest(saved, loaded)`. Zero rows leave it unchanged.
- **Boundary rows are re-fetched on purpose.** Whether `since` is inclusive is the API's choice, not croft's. So a keyed timestamp cursor gets a default lookback of 1 second: an exclusive API (`updated_at > since`) still returns rows that tie on the boundary, and the key deduplicates them. Unchanged rows are not rewritten and keep their `_loaded_at`, so the overlap costs nothing downstream (§5). This is why an incremental API ingest needs a `key`: without one, `validate` reports `INCREMENTAL_WITHOUT_KEY` as an **error**, unless `write: "append"` is set explicitly for append-only sources such as event logs.
- **Lookback** re-reads a safety margin: `since = saved − lookback`, computed in the cursor's own type and rendered in the saved value's own form. A timestamp keeps its offset (or its lack of one) and its fractional precision; an epoch cursor gets a number. Lookback on an integer cursor without `unit`, or on a string cursor, is `CURSOR_TYPE_MISMATCH` in `validate`.
- **Warnings:**
  - `SINCE_IGNORED` when most loaded rows are older than `since`, which means the code probably did not pass `since` to the API.
  - `EMPTY_EXTRACT` when an ingest with a lookback returns no rows even though its window held rows last time, usually a revoked token or a changed filter.

**`ctx.query(sql)`** in an ingest runs one read-only SELECT against a snapshot of the ingest's *own* table. It answers questions such as "which ids do we already have". Asset code must never open the database itself (§5).

**`ctx.http`** is `fetch` plus the following:

- It retries network errors, 429 and 5xx up to 3 times, honoring `Retry-After`.
- It has a 30 s per-request timeout, linked to the run's abort signal.
- It throws `HTTP_ERROR` with the method, redacted URL, status, attempt count and the first 500 bytes of the body.
- It exposes `res.next` from the `Link` header.
- It drops `null`/`undefined` query values, so `since` can be passed unconditionally.
- It redacts every value found in `.env` from every log and error.
- `res.json()` is **lossless**. Integers beyond 2^53 become `bigint` via the `JSON.parse` reviver's `context.source`. croft's NDJSON writer turns them back into exact digits with `JSON.rawJSON`, so `12345678901234567890` reaches DuckDB intact [V]. Both APIs exist on Bun 1.3.0 through 1.4.2 [V]. Plain `JSON.parse` would give `12345678901234567000` [V].

### (b) File ingests

```ts
// assets/taxi_zones.ts: a CSV from a URL, refreshed monthly
import { ingest } from "croft";

export default ingest({
  description: "NYC taxi zone lookup",
  file: "https://d37ci6vzurychx.cloudfront.net/misc/taxi_zone_lookup.csv",
  schedule: "monthly",
  key: "LocationID",
  checks: ["min_rows(250)"],
});
```

```ts
// assets/sales.ts: every CSV dropped into files/sales/ is loaded once; changed files are reloaded
import { ingest } from "croft";

export default ingest({
  description: "Daily order exports from the shop",
  file: "files/sales/*.csv",
  incremental: true,
  key: "order_id",                                        // exports overlap; the key removes repeats
  map: (row) => ({ ...row, email: String(row.email ?? "").trim().toLowerCase() }),
  checks: ["amount >= 0"],
});
```

How file ingests work:

- **Format.** It comes from the extension (`.csv`, `.tsv`, `.json`, `.ndjson`/`.jsonl`, `.parquet`), from `Content-Type` for URLs, or from `format:`.
- **URLs** download into `.croft/staging/` with `fetch` and a conditional GET (ETag / Last-Modified). An unchanged file is a no-op.
- **Globs** are read with `union_by_name = true`, so a column that appears only in later files (a `coupon` column added in March) is kept, not dropped. Without it, DuckDB silently dropped such a column [V].
- **Tracking files.** Every file ingest adds a `_file` column. With `incremental: true`, `_croft.files` records path, size, mtime and sha256.
  - A changed file has its old rows deleted by `_file` and is reloaded in the same transaction.
  - Rows of a deleted file are kept, and `status` says "2 files gone".
  - A keyless incremental file ingest that loads identical rows from different files gets `DUPLICATE_ROWS_ACROSS_FILES`, with the fix "add a key".
- **`map(row)`** is an optional per-row hook for cleaning values. It gives file ingests the same "clean it in code" fix that API ingests have.
- **CSV and TSV** are read with `all_varchar = true` and typed by croft's rules (§7), never by DuckDB's sniffer. The sniffer read `01/02/2024` as 2024-02-01, but read the same file month-first when one `03/25/2024` row was present [V].
- **Header detection.** DuckDB can only guess the header when some column is not text. A header-less export of names and cities silently lost its first data row [V]. So when `csv.header` is not declared and every sniffed column is text, the first load fails with `CSV_HEADER_AMBIGUOUS`. The error shows the first two lines and offers `csv: { header: true | false }`. Preview and the first run always print the header they used.
- **Encoding.** croft reads CSV as UTF-8. If DuckDB reports invalid UTF-8, croft retries as `latin-1` and warns `CSV_ENCODING_GUESSED` [V]. `csv: { encoding: "latin-1" }` makes the choice explicit.
- **JSON and NDJSON** go through the same pipeline as API rows.
- **Parquet** keeps the file's types, except that nested types become `JSON` (§7).

**Zero-asset path.** To look at a file without making an asset, run `croft query "from 'files/sales/*.csv'"` [V].

### (c) SQL transform

```sql
-- assets/open_issues.sql
-- description: Open issues (not pull requests) with author and label names
-- key: id
-- check: not_null(author)
-- warn: id IN (SELECT issue_id FROM issue_triage)
SELECT
  id,
  number,
  title,
  user->>'login'        AS author,        -- nested objects are JSON columns
  labels->>'$[*].name'  AS label_names,   -- VARCHAR[]
  comments,
  created_at
FROM github_issues
WHERE state = 'open' AND pull_request IS NULL
```

**The header** is the run of `-- name: value` comment lines at the top of the file. Allowed names:

- `description`
- `key` (comma-separated for several columns)
- `check` (repeatable)
- `warn` (repeatable)

An unknown name is `HEADER_UNKNOWN_KEY` with a did-you-mean suggestion (`chek` → `check`). Transforms have no schedule: they follow their inputs.

**The body** must be exactly one SELECT, with CTEs allowed. croft checks it in two ways:

- `connection.extractStatements(sql)` must report exactly one statement, and `prepare()` must report `statementType` SELECT. Otherwise the error is `SQL_NOT_ONE_STATEMENT` ("found 2 statements") or `SQL_NOT_SELECT`. `json_serialize_sql` alone is not enough, because it serializes `SELECT 1; SELECT 2` as two statements [V].
- A `PIVOT` with an `IN` list is a normal single SELECT [V]. Without an `IN` list, DuckDB rewrites it into two statements whose columns depend on the data, so it cannot be checked or bound statically [V]. It gets `PIVOT_NEEDS_VALUES` with the fix "list the values: `ON product IN ('pro', 'basic')`, or use `sum(x) FILTER (WHERE product = 'pro')`".

**Dependencies** are the union of two sources:

- **The AST's `BASE_TABLE` nodes,** minus CTE names scoped per query node. The AST is also used to reject catalog prefixes such as `other.main.t` (`CATALOG_PREFIX`, fix "drop the prefix"); DuckDB would otherwise report them as `main.t`.
- **The scans of the *unoptimized* bound plan** (`PRAGMA disable_optimizer; EXPLAIN (FORMAT json) …` over the shadow catalog of §6). This finds tables that the AST hides, inside `query_table('orders')`, `query('SELECT … FROM custs')`, table macros and PIVOT, and it respects CTE shadowing. The optimizer must be off, because it prunes scans (`WHERE false`, `LIMIT 0`) [V].

Tables named in `-- check:`/`-- warn:` subqueries are dependencies too, but they only affect ordering. Reading files directly (`FROM 'files/x.csv'`, `read_parquet(…)`) in an asset is `SQL_READS_FILES`, with the fix "make a file ingest (`croft new file x`)", because croft cannot tell when such a file changed. In `croft query`, reading files is fine.

**Volatile SQL.** `now()`, `current_date`, `random()`, `gen_random_uuid()` and similar functions produce values that freeze until the next rebuild. `validate` warns `VOLATILE_SQL` and suggests computing such columns at query time. `current_date` and `current_timestamp` appear in the AST as `COLUMN_REF` nodes rather than functions, and the detector handles that [V].

**How the body is executed, and reserved columns.** Inside the write transaction the verbatim body becomes `CREATE TEMP VIEW __body AS <sql>`, and the result is read as `SELECT COLUMNS(c -> c NOT IN ('_loaded_at', '_file')) FROM __body`. This form has several properties [V]:

- It tolerates a trailing `;` or `--` comment, which an agent writes routinely. A text wrapper around the body broke on them.
- `SELECT *` over an asset stays correct. A naive wrapper keeps the upstream's stale `_loaded_at` next to a junk `_loaded_at_1`, or fails an `INSERT BY NAME` with `Duplicate column name`.
- Unlike `EXCLUDE`, it does not fail when a reserved column is absent.
- Duplicate output names, which DuckDB silently renames to `a_1`, are a `validate` error: `DUPLICATE_OUTPUT_COLUMN`.

### (d) An aggregate SQL transform, and why v1 has no incremental SQL

```sql
-- assets/daily_revenue.sql
-- description: Revenue per day (project time zone) and currency, net of refunds
-- key: day, currency
-- check: net <= gross
SELECT
  to_timestamp(created)::DATE                     AS day,        -- project time zone days
  currency,
  sum(amount) / 100.0                             AS gross,
  sum(amount_refunded) / 100.0                    AS refunded,
  (sum(amount) - sum(amount_refunded)) / 100.0    AS net
FROM stripe_charges
WHERE status = 'succeeded'
GROUP BY ALL
```

In v1, every SQL transform is recomputed in full whenever an input changed or its SQL changed. On a local DuckDB this takes milliseconds to seconds; the reviews measured 0.1 s for thousands of rows. A full recompute is always correct: late rows, updated rows, re-dated rows and deleted rows need no special handling.

Incremental SQL was designed as `new.<table>`, a transaction-scoped view of "rows written since this asset last ran". It handled a late-arriving row [V], but the technical review showed it going silently stale in common cases [V]:

- an input joined without `new.` (renaming a customer never reached old orders);
- a merge update that moved a row between groups (an issue going from open to closed left the open count too high);
- deleted rows, which `_loaded_at` cannot show;
- keyless appends over updated inputs, which duplicated rows.

It is the first post-v1 candidate. It returns only with pre-images of updated and deleted rows, for when a project hits a real size wall (§11).

Rebuilds do not wake downstream incremental work unnecessarily. The rebuilt result is written as a *diff*: rows that did not change keep their `_loaded_at`. So a paid TypeScript transform downstream only sees rows whose values actually changed (§5).

### (e) TypeScript transform

```ts
// assets/issue_triage.ts
import { transform } from "croft";
import { triage } from "../lib/triage.ts";

type Issue = { id: number; title: string; body: string | null; labels: { name: string }[] };

export default transform({
  description: "Priority and reason for every issue, computed in TypeScript",
  inputs: ["github_issues"],
  key: "issue_id",
  incremental: true,           // each input row is processed once; changed rows are processed again
  checks: ["priority IN ('p0', 'p1', 'p2')", "not_null(reason)"],
  async *rows({ newRows, log }) {
    let n = 0;
    for await (const issue of newRows<Issue>("github_issues")) {
      const { priority, reason } = triage(issue.title, issue.body ?? "", issue.labels.map((l) => l.name));
      yield { issue_id: issue.id, priority, reason };
      if (++n % 1000 === 0) log(`${n} issues triaged`);
    }
  },
});
```

```ts
// lib/triage.ts
export function triage(title: string, body: string, labels: string[]) {
  if (labels.includes("crash") || /segfault|panic/i.test(title + body)) return { priority: "p0", reason: "crash" };
  if (labels.includes("bug")) return { priority: "p1", reason: "bug label" };
  return { priority: "p2", reason: "default" };
}
```

**Incremental by default for per-row work.** The `croft new transform` template is keyed and incremental. An incremental transform needs every input it reads with `newRows()` to have a key, because its resumable position uses that key (below). Otherwise `validate` reports `INPUT_NEEDS_KEY`, with the fix "add `-- key:` to the input" (or `key:` in its TS config). The most common TypeScript transform in this audience calls an LLM or another paid API once per row, and a full-refresh transform would pay again for every row whenever the input changes. A full-refresh transform (no `incremental`, reading `rows()`) is still allowed for whole-table computations. If a full-refresh transform uses `ctx.http`, `validate` warns `TRANSFORM_MAKES_REQUESTS`.

**The context API:**

- `rows(name)` streams a whole input.
- `newRows(name)` streams the rows written since the last successful run, which on the first run or after `--rebuild` is all of them.
- `query(sql, ...params)` runs one SELECT over the declared inputs. Reading any other table is `UNDECLARED_INPUT`, checked through the AST.
- `log(...)` writes to the step's log.
- `http`, `secret()`, `signal` and `preview` work as in ingests.

**Rows are guarded against renamed columns.** Rows from `rows()`, `newRows()` and `query()` are wrapped in a `Proxy`. Reading a column that the input does not have throws `UNKNOWN_INPUT_COLUMN`, for example `github_issues has no column "author"; did you mean "author_login"?`.

- The guard covers destructuring. Spread, `JSON.stringify`, `Object.keys`, `in`, template strings and `Bun.inspect` behave normally [V].
- `structuredClone(row)` fails on a Proxy [V], so the docs say to use `{ ...row }`.
- Overhead measured about 17 ms per 2M property reads [V].

Without the guard, a renamed upstream column would arrive as `undefined`, be stored as NULL, and pass every rule check.

**User code never holds the warehouse lock.** On first use of an input, croft:

1. takes a short read-only lease;
2. runs `COPY (SELECT … ORDER BY _loaded_at, <input key>) TO '.croft/staging/<run>/in-<input>.parquet'` [V];
3. releases the lease;
4. streams the Parquet file through a private in-memory DuckDB, which is sandboxed and set to the project time zone like every croft connection.

About 150k rows export in 8 ms [V]. HUGEINT columns are cast to `DECIMAL(38,0)` in the snapshot, because Parquet would otherwise turn them into DOUBLE [V]. A transform can therefore call an LLM for each row for hours without blocking anything.

**Values arrive as JavaScript types that load back unchanged:**

- JSON → the parsed value.
- TIMESTAMPTZ → an ISO string with `Z` and microseconds (`"2026-03-01T07:30:00.123456Z"`).
- TIMESTAMP → an ISO string *without* an offset (`"2026-03-01T23:30:00.123456"`).
- DATE → `"YYYY-MM-DD"`.
- Integers → `number`, or `bigint` when outside ±2^53; DECIMAL(38,0) snapshots also arrive as `bigint`.
- Other DECIMAL → `number`.

Strings are used for timestamps instead of `Date` because a pass-through `yield { ...row }` must reload as the same type. With `Date`, a naive TIMESTAMP came back as TIMESTAMPTZ shifted by 8 hours, and it lost its microseconds [V]. `new Date(row.created_at)` is one call away when code needs date arithmetic.

**Positions never skip rows.** An incremental transform's position is the composite `(_loaded_at, key)` of the last input row it fully processed. It is taken from the snapshot's own SQL values, never from a JavaScript `Date`, because a `Date` keeps milliseconds while stamps differ by microseconds; a Date-based position would re-read, and re-bill, rows already processed. The snapshot is ordered the same way, and the next run reads `_loaded_at > s OR (_loaded_at = s AND key > k)`.

Recording only "the largest `_loaded_at` consumed" would lose rows: one write gives many rows the same stamp, and merges leave rows in physical rather than stamp order. A spike that stopped after 2 of 5 rows recorded a position that skipped rows 3–5 forever [V]. Full-refresh transforms read `rows()` and keep no position, so their inputs need no key.

**Long paid transforms commit in chunks.** An incremental TS transform writes a chunk every 500 output rows or 60 s, whichever comes first. Each chunk is its own all-or-nothing transaction: its rows, the checks on them, and its position commit together.

- A failure, a timeout or Ctrl-C loses at most the current chunk. The next run resumes from the last committed position.
- A retry reuses the failed chunk's staged output when the code hash and position are unchanged, so a failed check does not re-bill the calls that produced the chunk.
- A first build of 18,000 issues at 1 s per LLM call (five hours) therefore finishes across as many runs as it takes, and never starts over.
- Full-refresh transforms and ingests still commit once per run. Resumable first loads for ingests are post-v1 (§11).

The output goes through the same load pipeline as an ingest.

### (f) Checks

**The check language is the same in TypeScript and SQL.** TypeScript uses `checks: [...]` (blocking) and `warnings: [...]`. SQL uses `-- check:` and `-- warn:`.

| Check | Meaning | Evaluated on |
|---|---|---|
| `unique(a, b)` | no two rows share these values | whole table after the write |
| `not_null(a, b)` | none of these columns is NULL | rows written by this run |
| `min_rows(n)` | the table has at least n rows | whole table after the write |
| any boolean SQL expression, e.g. `amount >= 0`, `state IN ('open','closed')`, `issue_id IN (SELECT id FROM github_issues)` | every row satisfies it; NULL counts as a pass (combine with `not_null`) | rows written by this run |

- A key implies `unique(key)` and `not_null(key)`.
- Tables named in a check's subquery are ordered before the asset.
- When a check's text changes, its next evaluation covers the whole table.
- **Every check is parsed before use.** croft serializes `SELECT (<expr>) FROM <asset>` with `json_serialize_sql` and requires exactly one statement with one select item. Identifiers are quoted with `"` escaping, and every statement croft builds runs through `prepare()`, which accepts a single statement. Concatenating a check into a multi-statement `run()` would execute an embedded `; DROP TABLE …` [V].

**Blocking checks run inside the write transaction, after the write and before commit.** A failure rolls back data, schema changes and cursor together [V]. Warnings run after commit and are recorded.

```
$ croft run open_issues
fail  open_issues   CHECK_FAILED not_null(author): 3 of 4,211 rows
                      id=2291  title="Crash on Windows when …"  author=NULL
                      id=2307  title="bun test hangs with …"    author=NULL
                    Nothing was written. open_issues still has its previous 4,208 rows.
                    fix: correct assets/open_issues.sql or the data, then: croft run open_issues
exit 3
```

Cross-asset checks that need their own query (for example "every open issue has a triage row" written as an anti-join) are post-v1. Most of them can be written as a row rule with a subquery, as in example (c).

---

## 4. CLI surface

### Conventions

- **JSON.** `--json` prints exactly one envelope to stdout (§4.3); progress and logs go to stderr.
- **No interactivity off a TTY.** croft never prompts when stdin is not a TTY, and uses no colors or spinners when stdout is not a TTY or `NO_COLOR` is set.
- **Truncation.** Output is truncated by default (50 rows, 80-character values, 3 sample rows), with a note on how to get more (`--limit`, `--full-values`).
- **Exit codes:**

  | Code | Meaning |
  |---|---|
  | 0 | ok |
  | 1 | an asset failed, or `status --check` found something unhealthy |
  | 2 | invalid project or usage |
  | 3 | blocking checks failed, and nothing else failed |
  | 4 | busy (lock or lease wait exceeded) |
  | 5 | needs a human (confirmation or a human-only step) |
  | 6 | still running (detached run, `wait`) |
  | 130 | interrupted |

- **Selectors** are asset names or globs (`'github_*'`). Destructive commands accept exact names only.
- **Timestamps** in JSON are ISO-8601 *with the project offset* (for example `2026-09-21T22:00:00-07:00`), so they agree with `::DATE` in SQL. The envelope carries `timezone`.

### 4.1 Commands (19)

| Group | Command | Purpose |
|---|---|---|
| Setup | `init [dir] [--claude]` | scaffold a project (or `data/` inside an existing app); `--claude` only refreshes the Claude files |
| | `doctor` | environment plus project summary, under 1 s, no writes |
| | `new <kind> <name>` / `new --list` | write a commented, working template. Kinds: `api [--pagination keyset\|cursor\|link\|page]`, `file`, `sql`, `transform` |
| | `secrets [set NAME [--stdin]]` | list declared secrets as set or missing; `set` writes `.env` from a hidden prompt or stdin |
| | `docs [topic\|ERROR_CODE]` / `docs --list` | offline docs for the installed version |
| Inspect | `context` | the whole project in one payload, for agents (capped at 20 KB; `--asset` filters) |
| | `status [--check]` | freshness and health of every asset, and running runs; never waits on the database |
| | `describe <asset>` | behavior in words, columns, JSON keys, reads/read by, checks, cursor, recent writes, samples |
| | `query "<sql>"` | one SELECT against the warehouse (read-only, sandboxed); `--preview` targets the preview database |
| | `logs [asset\|run-id] [--failed] [--runs] [--follow]` | console output and errors of a step; `--runs` lists past runs and steps |
| Try | `validate [asset…] [--types]` | static checks and a bind check of every SQL asset; never touches the warehouse |
| | `preview <asset…> [--rows N] [--rebuild]` | build in a sandbox and diff against the live tables |
| Execute | `run [selector…]` | update assets and everything downstream (flags below) |
| | `wait <run-id> [--timeout 100s]` | block until a detached run ends; exit 6 if still running |
| | `confirm <token>` | carry out a destructive action whose impact was printed (§6) |
| Maintain | `rename <old> <new>` | rename an asset: file, table and state together; lists references to update |
| | `delete <asset> [--where "<expr>"]` | move a whole table, or matching rows, to the trash (needs confirmation) |
| | `restore [asset] [--at <time>]` | list the trash, or bring a version back (needs confirmation) |
| Schedule | `schedule on\|off\|status\|pause [--for 2h]\|start` | turn scheduled runs on or off; `start` runs the per-minute tick in the foreground (servers, containers, WSL) |

**`run` flags:**

- `--dry-run`: what would run and why, with windows and confirmations, without running.
- `--only`: skip downstream.
- `--upstream`: refresh stale inputs first.
- `--rebuild`: from scratch; §6 says when it needs confirmation.
- `--from <date|ISO|-90d>`: backfill a merge ingest (§8).
- `--allow-shrink`: override `SHRINK_GUARD`, with confirmation.
- `--foreground`: do not detach (§5).
- `--follow <dur>`: how long a non-TTY invocation follows a detached run before returning. The default is 100 s.
- `--no-wait`: exit 4 at once instead of waiting for a lock.
- `--events`: NDJSON progress on stderr.
- `--due`: only scheduled work that is due; used by the scheduler.

**Bare `croft run`** fetches every ingest and updates every transform that is stale. It is the obvious "run my pipeline". Incremental ingests make it cheap. The skill tells agents to name assets when working on one of them.

### 4.2 Examples

```
$ croft new api stripe_charges --pagination cursor
Created assets/stripe_charges.ts (cursor pagination: starting_after/has_more).
Edit: the URL, the cursor field and whether records change after creation (see comments).
Next: add STRIPE_KEY to .env (ask the user), then: croft preview stripe_charges

$ croft secrets
GITHUB_TOKEN   set (.env)   used by github_issues
STRIPE_KEY     missing      used by stripe_charges → add STRIPE_KEY=... to .env
```

```
$ croft validate
checked 7 assets in 0.6 s
error UNKNOWN_COLUMN  assets/open_issues.sql:9:3
      Referenced column "creatd_at" not found in github_issues. Candidate bindings: "created_at"
      fix: replace creatd_at with created_at on line 9
info  INPUT_NOT_BUILT  assets/daily_revenue.sql
      columns of stripe_charges are unknown until it has run or been previewed; bind check skipped
      next: croft preview stripe_charges
1 error, 0 warnings, 1 info · next: croft validate
```

```json
{"schemaVersion":1,"ok":false,"command":"validate","croftVersion":"0.1.0","database":"warehouse.duckdb",
 "timezone":"America/Los_Angeles","durationMs":612,
 "data":{"order":["github_issues","stripe_charges","taxi_zones","sales","issue_triage","open_issues","daily_revenue"],
   "assets":[{"name":"open_issues","kind":"sql","inputs":["github_issues","issue_triage"],"behavior":"replace; key id",
     "outputColumns":null,"codeChanged":true}]},
 "problems":[{"severity":"error","code":"UNKNOWN_COLUMN","message":"Referenced column \"creatd_at\" not found in github_issues.",
   "asset":"open_issues","file":"assets/open_issues.sql","line":9,"column":3,"hint":"did you mean \"created_at\"?",
   "fix":{"kind":"edit","description":"fix the column name","file":"assets/open_issues.sql","line":9,
          "replace":{"from":"creatd_at","to":"created_at"}},"docs":"croft docs UNKNOWN_COLUMN"}],
 "next":[{"command":"croft validate","reason":"re-check after the edit"}]}
```

```
$ croft preview open_issues
Preview: your real tables are not changed.
open_issues   4,211 rows (live 4,208)   +3 added · 0 removed · 12 changed (by key id)
  columns     + comments BIGINT
  checks      ok unique(id) · ok not_null(id) · ok not_null(author) · warn id IN (…issue_triage): 2 rows
  sample      id    title                         author   comments
              2291  Crash on Windows when …       jarred   3
Explore: croft query --preview "from open_issues where comments > 10"
Apply:   croft run open_issues
```

```
$ croft preview github_issues
Preview: nothing is saved and the saved position (since 2026-09-22T17:58:03Z) does not move.
github_issues fetched 1,000 rows (10 requests, 3.4 s, stopped at --rows 1000)
  columns     + milestone JSON (new) · closed_at TIMESTAMPTZ (no values yet; typed from its name)
  checks      ok unique(id) · ok not_null(id) · ok not_null(title) · ok state IN (…)
  diff        212 would update, 788 would add (by key id)
  downstream  open_issues, issue_triage would update (not built in an ingest preview)
Apply: croft run github_issues
```

```
$ croft run --dry-run
fetch    github_issues    merge by id, since 2026-09-22T17:58:03Z
fetch    stripe_charges   merge by id, since 1756000000 (2025-08-23T18:46:40-07:00) = saved − 30 days
fetch    taxi_zones       replace (unchanged files are skipped via ETag)
fetch    sales            2 new files
rebuild  open_issues      SQL changed (assets/open_issues.sql)
update   issue_triage     input github_issues will have new rows (TS code unchanged)
update   daily_revenue    input stripe_charges will have new rows
```

```
$ croft run
run r_0922_1015_k3f9 · 7 assets
ok    github_issues    184 requests, 18,342 rows (41.2 s) · new table, 31 columns (7 JSON)
                       added 18,342 · checks 4/4 ok · since → 2026-09-22T17:58:03Z
ok    stripe_charges   12 requests, 1,130 rows · added 1,102 · updated 21 · unchanged 7
ok    taxi_zones       unchanged (ETag) · skipped
ok    sales            2 new files, 1,904 rows added · checks 2/2 ok
ok    issue_triage     18,342 rows (2.3 s) · checks 3/3 ok
ok    open_issues      rebuilt 4,211 rows (0.1 s) · checks 3/3 ok · 1 warning
ok    daily_revenue    rebuilt 812 rows (0.1 s) · checks 2/2 ok
done 44.0 s · 6 updated · 0 failed
```

**Off a TTY (how Claude runs it), a long run detaches instead of dying at the shell timeout:**

```
$ croft run stripe_charges --json
{"schemaVersion":1,"ok":true,"command":"run","data":{"runId":"r_0922_1130_x1c8","status":"running",
 "progress":{"asset":"stripe_charges","phase":"extract","rowsFetched":61200,"requests":612,"elapsedMs":100000}},
 "problems":[],"next":[{"command":"croft wait r_0922_1130_x1c8 --timeout 100s","reason":"still running"}]}
exit 6
```

```
$ croft status
ASSET            ROWS     LAST RUN     NEXT            STATUS
github_issues    18,556   5 min ago    in 55 min       ok
stripe_charges   1,130    5 min ago    in 55 min       ok · schema changed today (+ 1 column)
taxi_zones       265      2 days ago   Oct 1 00:00     ok
sales            1,904    5 min ago    manual          ok · 1 file gone
issue_triage     18,556   5 min ago    after inputs    held: code edited 12 min ago, not run by hand yet
open_issues      4,211    5 min ago    after inputs    failed: CHECK_FAILED (croft logs open_issues --failed)
daily_revenue    812      5 min ago    after inputs    ok
old_orders       120      —            —               no asset file (croft delete old_orders)
Scheduling on · last tick 12 s ago · 0 running
```

`status` exits 0 because the command itself worked; `status --check` exits 1 when anything is failed, crashed, held or stale, which makes it a health probe. In JSON, `ok` always means "the command worked", and `data.healthy` carries health.

```
$ croft describe stripe_charges
stripe_charges · ingest · assets/stripe_charges.ts · every hour (next 11:00 America/Los_Angeles)
Behavior   updates rows by id; re-reads charges created in the last 30 days (created is epoch seconds)
Cursor     created = 1758600000 (2025-09-22T21:00:00-07:00)
Read by    daily_revenue
Table      1,130 rows · 38 columns · last write 10:15 (+1,102 added, 21 updated)
Columns    id VARCHAR · amount BIGINT · amount_refunded BIGINT · currency VARCHAR · created BIGINT
           refunded_at TIMESTAMPTZ (no values yet; typed from its name) · metadata JSON {order_id, … 3 keys} …
Checks     unique(id) · not_null(id) · amount >= 0 · not_null(currency)
Recent     r_0922_1115_p7q2 ok 3.2 s · r_0922_1015_k3f9 ok 9.8 s
```

```
$ croft query "select state, count(*) n from github_issues group by 1"
state    n
open     1,204
closed   17,352
(2 rows, 9 ms)
```

```
$ croft query "copy github_issues to 'out.csv'"
error QUERY_NOT_SELECT  query runs exactly one SELECT (DESCRIBE, SUMMARIZE and SHOW also work)
      hint: to export, put the SELECT in an asset or pipe --json output; exports are post-v1
exit 2
```

**Destructive actions return a confirmation token instead of acting (§6):**

```
$ croft run taxi_zones --allow-shrink
needs confirmation: taxi_zones would go from 265 rows to 0 (replace ingest; SHRINK_GUARD override)
  first: the current 265 rows go to the trash (croft restore taxi_zones)
  then:  zone_trips is rebuilt
  ask the user; if they agree: croft confirm c_7f3a9e    (valid 15 min)
exit 5

$ croft confirm c_7f3a9e
ok    taxi_zones   0 rows (replaced; previous 265 rows in trash 2026-09-22 11:40)
```

On a TTY the same command asks `Proceed? [y/N]` and needs no token.

```
$ croft restore
TABLE        TRASHED            ROWS   SIZE    WHY
taxi_zones   2026-09-22 11:40   265    18 KB   run --allow-shrink (r_0922_1140_a1b2)
old_orders   2026-09-20 09:02   120    9 KB    delete

$ croft schedule on
Scheduling is on for ~/my-data (one job per user; checked every minute; survives restarts).
Waiting for the first tick… ok (after 38 s)
  github_issues   every hour   next 11:00
  stripe_charges  every hour   next 11:00
  taxi_zones      monthly      next Oct 1 00:00
Turn off: croft schedule off
```

### 4.3 The JSON contract

**The envelope** is `{schemaVersion: 1, ok, command, croftVersion, database, timezone, durationMs, data, problems[], next[], confirmation?}`.

- `ok` means the command itself did what it was asked. For `run`, it is false when any asset failed.
- A **problem** has `severity` (`error` | `warning` | `info`), `code`, `message`, `hint` and `docs`. Where they apply it also has `asset`, `file`, `line`, `column`, `runId`, `fix`, `effect`, `retryable` and `details`.
- `fix` is one of:
  - `{kind: "edit", description, file, line?, replace?: {from, to}, insert?}`
  - `{kind: "command", description, command, requiresHuman?}`
  - `{kind: "manual", description, requiresHuman?}`
- `next` is `[{command, reason}]`. **A destructive command never appears in `next`.** It appears only as `confirmation: {token, expiresAt, command, impact}`.

**Data shapes** are frozen by golden tests and published as JSON Schemas:

- **`query`:** `{columns: [{name, type}], rows, rowCount, truncatedRows, truncatedValues}`. HUGEINT, DECIMAL and integers beyond ±2^53 are strings. `--limit N` and `--full-values` lift the caps.
- **`run` / `wait`:** `{runId, status: running|succeeded|failed|crashed|interrupted, progress?: {asset, phase: extract|write|checks, rowsFetched, requests, elapsedMs}, steps: StepResult[]}`. A StepResult has:
  - `asset`, `status` (`ok`|`failed`|`skipped`|`unchanged`), `reason`, `skippedBecause?`
  - `behavior`, `attempt`, `maxAttempts`, `nextRetryAt?`
  - `rows: {in, added, updated, unchanged, deleted, total}`
  - `schemaChanges[]`, `cursor?: {before, after, sinceUsed}`
  - `inputs?: [{input, seenBefore, seenAfter, rows}]`
  - `requests?`, `checks[]`, `trashed?: {path, rows}`, `logsCommand`, `durationMs`, `error?`
- **`status`:** `{healthy, running: [{runId, asset, pid, since, phase, rowsFetched}], assets: [{asset, kind, rows, lastRun: {runId, at, status, code}, next: {at, reason}, stale, staleReasons[], held, edited, filesGone?, schemaChangedAt?}]}`.
- **`describe`:** `{asset, kind, file, behavior: {words, write, key, incremental: {kind, field, cursorValue, cursorType, unit, lookback}}, reads, readBy, columns: [{name, type, pinned, pending, sourceName, format, addedAt, jsonKeys, kinds}], inputsSeen: {input: {seenLoadedAt, inputLastLoadedAt, pendingRows}}, builtWithCodeHash, checks, recentWrites, samples}`.
- **`validate`:** `{order, assets: [{name, kind, inputs, outputColumns: [{name, type}] | null, behavior, codeChanged}]}`. `outputColumns` comes from `prepare()`.
- **`context`:** `{project, assets: [compact describe], running, held, recentFailures, recentSchemaChanges: [{asset, at, runId, kind, column, from, to, readBy}]}`, capped at 20 KB with `truncated: true`.
- **Error `details`:**
  - `HTTP_ERROR`: `{method, url (redacted), status, attempts, retryAfterMs, requestIndex, rowsBeforeError}`
  - `TIMEOUT`: `{phase, rowsSoFar, lastRequest}`
  - `TYPE_CONFLICT`: `{column, existingType, incomingKinds, badRows, samples, readBy}`
  - `CHECK_FAILED`: `{check, failing, sample}`

**Exit precedence:** 1 if any non-check failure, 3 only when every failure is `CHECK_FAILED`, 6 if still running, and 5 when the only outcome is a pending confirmation.

---

## 5. Runtime architecture

### Processes

There is no daemon, socket or server. Four kinds of process exist:

1. **Short-lived CLI invocations.**
2. **Detached runs.** Off a TTY, `croft run` always executes in a detached child process (`detached` + `unref`; a child outlived its parent and was reparented [V]). The invoking process follows the child's events for `--follow` (default 100 s) and prints the result if the run finished. Otherwise it returns exit 6 with the run id.
   - This keeps every run from being killed by Claude Code's shell timeout (120 s by default, 600 s at most). A killed run would lose all extraction work.
   - On a TTY, runs stay in the foreground, and `--foreground` forces that off a TTY too.
3. **The per-user scheduler job** (§8). It starts `croft run --due` for each registered project that has due work.
4. **`croft schedule start`**, a foreground loop for servers, containers and WSL. It spawns a fresh `croft tick` subprocess every minute and never ticks in-process. An in-process tick would keep stale `lib/` code, because a cache-busted `import()` does not re-import dependencies [V], and it would risk a second database instance in one process.

Each command imports asset files fresh, so edits are always picked up. Each TS file is imported in isolation, so one broken file fails only its own asset.

**Signals.** SIGINT and SIGTERM abort the run's `AbortSignal`. The in-flight step is recorded as `interrupted` (its transaction, if any, is discarded), and the process exits 130.

### Owning the DuckDB file

**The warehouse file is open only while DuckDB itself is working.** It is never open while user code or the network runs. The measured facts behind this:

- Opening, querying and closing a file with 1–2M rows costs 3–6 ms [V].
- `closeSync()` releases the OS lock at once, and a waiting process got the file about 57 ms later [V].
- A read-write holder blocks every other process, readers included. A read-only holder blocks writers. Read-only holders can coexist [V].
- The lock error names the holder: `Conflicting lock is held in /opt/homebrew/bin/duckdb (PID 812)` [V].

**The owning process must never touch the warehouse file any other way.** DuckDB's cross-process lock is a POSIX `fcntl` lock, and such locks belong to the *process*: closing *any* descriptor on the file releases them. Four measured hazards follow:

- **Two instances on one file.** Two `DuckDBInstance`s opened on the same file inside one process both succeed, and data is lost on reopen. A spike wrote 1,000 + 500 + 100 rows through two instances and reopened to 1,100 [V].
- **A second read-only instance.** Opening and then closing a read-only instance on the same file in the same process released the first instance's lock, and another process then opened the file read-write and wrote to it [V].
- **Plain file descriptors.** `fs.openSync` + `closeSync` on the warehouse (for example to hash it or read its size) released the lock the same way [V].
- **What is safe.** `statSync` and APFS `copyFile(…, COPYFILE_FICLONE)` did not release the lock [V].

The rules that follow from these:

- `db/warehouse.ts` obtains instances only through `DuckDBInstance.fromCache(path)`, which returns the same instance for the same file, including via realpath and case-variant paths [V]. It always uses one configuration, because a different configuration for a cached path is refused [V].
- croft never opens the warehouse with `fs` APIs or with a second instance, and never `ATTACH`es it from another database, while it may hold it.
- File copies of the warehouse (the read copy, pre-upgrade backups) are made by a **child process** while croft holds the write lease. A child's descriptors cannot release the parent's locks.
- `validate` rejects asset or `lib/` code that imports `@duckdb/node-api` or `croft/read`, with `ASSET_OPENS_DATABASE` and the fix "use `ctx.query()`". Ingests and transforms both have `ctx.query()` for read-only lookups.
- `croft/read` also refuses to open a second instance: if a croft runtime is loaded in the same process (`globalThis[Symbol.for("croft.warehouse")]`), it runs through the current lease.
- A test opens a second read-write instance in the same process and asserts that croft refuses.

**Leases.** `warehouse.read(fn)` and `warehouse.write(label, fn)` open the file on demand and close it 100 ms after the last lease ends. Each process picks one access mode for its whole life, because a cached path cannot be reopened with another configuration:

- Processes that write (`run`, `confirm`, `delete`, `restore`) use read-write, even for their read leases.
- `query`, `describe` and `preview` use read-only.

- **Lock conflicts** are retried with jittered backoff (25 ms up to 1 s). After 2 s the holder is printed: croft's own run, from `runs.sqlite` (for example "croft run r_…, writing daily_revenue, 8 s"), or a foreign program (`DB_HELD_BY_OTHER_PROGRAM`).
- **Default waits.** Off a TTY every wait is capped at 90 s, then exit 4 with the holder, so a wait never outlives the agent's shell. On a TTY: 60 s for `query`/`preview`/`describe` and 10 min for run writes. Scheduled writes wait 30 min. `--no-wait` exits 4 at once.
- **Fairness.** A writer that sees registered waiters yields for 200 ms between write steps.
- **Asset leases** in `runs.sqlite` guarantee that only one run touches an asset at a time. A manual `croft run x` while the scheduler runs `x` waits for the lease, or exits 4 with `ASSET_BUSY` naming the run. A tick skips leased assets, and they stay due. A lease records the PID, the process start time and the boot id (`kern.boottime` or `/proc/sys/kernel/random/boot_id`). It counts as dead when the boot id differs or the start time does not match, because PIDs are reused after a reboot and a PID check alone could leave an asset busy forever.

**One connection factory.** Every connection croft opens goes through a single factory. This covers the warehouse, the preview database, a TS transform's private in-memory database, and `croft/read`. The factory sets the project time zone and applies the sandbox. `TimeZone` is a per-connection setting [V], and a connection that skipped it would put rows into different days.

**Sandboxing every DuckDB instance.** Every instance is created with `autoinstall_known_extensions = false`, `autoload_known_extensions = false` and `allow_community_extensions = false` [V]. Otherwise DuckDB would download and load native extensions from the network on demand, and croft promises never to install anything. Right after connecting (and after croft's own `ATTACH`es and `SET TimeZone`), croft runs the statements below. `allowed_directories` cannot be passed as an instance option ("Failed to set config"), so these have to be `SET` statements [V]. `croft query` instances allow only `files/`, and a project path outside it gets `QUERY_PATH_DENIED`.

```sql
SET allowed_directories = ['<project>/files', '<project>/.croft', <directories of declared file ingests>];
SET enable_external_access = false;
SET lock_configuration = true;
```

After this [V]:

- Tables query normally.
- `read_csv` inside allowed directories works.
- Staging reads, trash `ATTACH`es under `.croft/`, and spilling large sorts to disk all keep working.
- `COPY … TO` the warehouse path fails with a Permission Error.
- `read_text('.env')` fails, so SQL cannot read secrets.
- Reading `/etc/hosts` or an `https://` URL fails.
- Re-enabling either setting fails ("the configuration has been locked").

This matters because a READ_ONLY connection is not safe on its own: `COPY (SELECT 1) TO '<warehouse path>'` on a read-only connection overwrote the warehouse with a 4-byte CSV that no longer opened [V].

A second rule covers the rest. **All user-authored SQL must be exactly one SELECT.** Two tests must both pass:

- `extractStatements` returns one statement.
- `json_serialize_sql` succeeds on it. It only accepts SELECT forms; `DESCRIBE`, `SUMMARIZE` and `SHOW` also pass [V]. This applies to `query`, SQL assets, checks and `ctx.query`. It matters because sandbox settings alone do not stop `DETACH` followed by a read-write `ATTACH` of an already-permitted path [V].

### One ingest step, end to end

```
1  plan         staleness from the runs.sqlite mirror, confirmed under a short read lease
2  extract      NO database lock. Generator → .croft/staging/<run>/<asset>/part-NNNN.ndjson (50k rows/part).
                The writer canonicalizes JSON (object keys sorted, bigint as raw digits) so unchanged rows
                compare equal. It cleans and case-resolves column names (§7) and renames source columns
                called _loaded_at/_file. It throws ROW_NOT_OBJECT for non-object rows and
                UNSERIALIZABLE_VALUE (row, field, type) for Map, Set, typed arrays, functions, NaN and
                ±Infinity, which JSON.stringify would silently turn into {} or null. JS tracks
                top-level keys, row counts and unsafe-integer warnings.
                manifest.json is written last. Up to 4 extractions run concurrently ("concurrency").
3  write lease  RW open, in-process write mutex, BEGIN
   a  stage     CREATE TEMP TABLE raw AS SELECT * FROM read_json(parts, columns = {every key: 'JSON'});
                every row carries a _croft_seq in yield order; the real table schema is read from
                duckdb_columns(), and a mismatch with _croft.columns is TABLE_MODIFIED_OUTSIDE_CROFT
   b  classify  per column: counts by json_type + string sub-kinds (ISO instant / naive / date) (§7)
   c  plan      compare with _croft.columns and pins → add / widen / keep / TYPE_CONFLICT
   d  cast      typed temp table with explicit, whitelisted casts (§7)
   e  verify    round-trip loss check: no value may change when cast back and compared (§7)
   f  dedupe    by key: highest cursor, then highest _croft_seq (last yielded), wins
   g  evolve    ALTER TABLE ADD COLUMN / ALTER COLUMN TYPE (DDL is transactional [V]). All DDL on a table
                comes before any DML on it in the same transaction: DELETE or UPDATE followed by ALTER
                failed at COMMIT ("another transaction has altered this table") [V]. A file reload
                therefore computes its batch, ALTERs, and only then DELETEs by _file and inserts.
                The Sql wrapper tracks touched tables per transaction and throws DDL_AFTER_DML at the
                offending statement, not at COMMIT; restore uses CREATE OR REPLACE ... FROM trash
   h  write     replace: MERGE … WHEN MATCHED AND <row differs> THEN UPDATE
                         WHEN NOT MATCHED THEN INSERT  WHEN NOT MATCHED BY SOURCE THEN DELETE   [V]
                append:  INSERT BY NAME
                merge:   MERGE … WHEN MATCHED AND <row differs> THEN UPDATE SET <batch columns>
                         WHEN NOT MATCHED THEN INSERT
                Written rows get one _loaded_at stamp; unchanged rows keep theirs.
   i  guards    KEY_NULL, SHRINK_GUARD
   j  checks    blocking checks; any failure → ROLLBACK
   k  state     cursor = greatest(saved, typed max) as original text; _croft.assets/columns/files/writes;
                row_count and max(_loaded_at) recorded for out-of-band detection
   COMMIT
4  after        runs.sqlite step + catalog mirror; release asset lease; delete staging (kept 3 days on
                failure); warnings evaluated and recorded; read copy refreshed at the end of the run
```

**Replace as a diff.** A replace without a key matches rows by a hash of all non-reserved columns, with multiplicity. A replace keeps `_loaded_at` on unchanged rows, so a taxi-zones refresh that changes 2 of 265 rows wakes downstream work for 2 rows, not 265. `MERGE … WHEN NOT MATCHED BY SOURCE THEN DELETE` produced the expected `UPDATE`/`DELETE`/`INSERT` actions and kept the stamp of the unchanged row [V].

Diff writes also keep the file small. Thirty hourly full rewrites (DELETE + INSERT, or CREATE OR REPLACE) of a 300k-row table doubled the file from 9.8 MB to 19.3 MB. A merge that touched 10% of rows stayed at 9.5 MB [V].

**Why dedupe always runs first.** MERGE with duplicate source keys silently applies one duplicate to a matched row and *inserts both* for an unmatched key [V]. With a PRIMARY KEY on the target, it fails outright [V]. croft therefore deduplicates before every merge and puts no constraints on user tables; uniqueness is a check.

### Transforms

A **SQL transform** step works like this:

1. `CREATE TEMP VIEW __body AS <sql>` (§3c).
2. `CREATE TEMP TABLE next AS SELECT COLUMNS(c -> c NOT IN ('_loaded_at', '_file')) FROM __body`.
3. Diff `next` into the target exactly like a replace ingest, matching rows by key or by row hash.
4. Run checks, drop the temp objects, and commit.

If the output *shape* changed (columns added, removed or retyped), the table is recreated and every row gets a new stamp. `CREATE OR REPLACE` rolls back cleanly on failure [V]. SQL steps run one at a time, because DuckDB already parallelizes inside each query.

A **TS transform** step extracts like an ingest, reading its inputs from Parquet snapshots (§3e), and then loads through the same pipeline. Incremental TS transforms commit in chunks of 500 rows or 60 s, each with its own checks and composite position (§3e).

**Cost guard.** An incremental TS transform that uses `ctx.http` and would process more than 1,000 input rows in one run (the `confirmAbove` setting) raises `LARGE_REPROCESS`. This happens on a first build, after an upstream rebuild that restamped every row, and after a restore.

- A scheduled run holds the transform until a human runs it.
- A manual run asks for confirmation, with the row count in the impact.

This is how "never spend the user's API money implicitly" is enforced rather than just documented.

### How commands behave while a run is writing

| Command | Needs | Behavior |
|---|---|---|
| `status`, `logs`, `context`, `docs`, `validate`, `run --dry-run` | `runs.sqlite` + files (+ an in-memory DuckDB for binding) | never waits |
| `query`, `preview`, `describe` samples | a read-only lease | waits only for the current *write step* (usually seconds), printing the holder |
| `run`, `delete`, `restore`, `confirm` | asset leases + write leases per step | extraction proceeds in parallel; writes queue behind the current step |
| scheduler tick | asset leases | skips leased assets; due work stays due |

### Where state lives

**Data-coupled state** lives inside `warehouse.duckdb`. It commits atomically with the data it describes and is the source of truth.

```sql
CREATE SCHEMA _croft;
CREATE TABLE _croft.meta    (key VARCHAR PRIMARY KEY, value VARCHAR);   -- format_version, duckdb_version, croft_version
CREATE TABLE _croft.assets  (name VARCHAR PRIMARY KEY, kind VARCHAR,    -- ingest | sql | ts
  write_mode VARCHAR, key_columns VARCHAR[], code_hash VARCHAR, behavior_hash VARCHAR,
  cursor_value VARCHAR, cursor_type VARCHAR, cursor_unit VARCHAR,
  last_loaded_at TIMESTAMPTZ, last_replaced_at TIMESTAMPTZ,
  row_count BIGINT, max_loaded_at TIMESTAMPTZ, updated_at TIMESTAMPTZ);
CREATE TABLE _croft.columns (asset VARCHAR, name VARCHAR, type VARCHAR, source_name VARCHAR, format VARCHAR,
  pinned BOOLEAN, pending BOOLEAN, kinds VARCHAR[], present_last_batch BOOLEAN, added_at TIMESTAMPTZ,
  PRIMARY KEY (asset, name));
CREATE TABLE _croft.inputs  (asset VARCHAR, input VARCHAR, seen_loaded_at TIMESTAMPTZ, seen_key JSON,
  PRIMARY KEY (asset, input));                                        -- composite position (§3e)
CREATE TABLE _croft.files   (asset VARCHAR, path VARCHAR, size BIGINT, mtime TIMESTAMPTZ, etag VARCHAR,
  sha256 VARCHAR, loaded_at TIMESTAMPTZ, PRIMARY KEY (asset, path));
CREATE TABLE _croft.writes  (asset VARCHAR, loaded_at TIMESTAMPTZ, run_id VARCHAR, mode VARCHAR,
  rows_in BIGINT, added BIGINT, updated BIGINT, unchanged BIGINT, deleted BIGINT,
  cursor_before VARCHAR, cursor_after VARCHAR, since_used VARCHAR, inputs JSON,
  schema_changes JSON, code_hash VARCHAR, PRIMARY KEY (asset, loaded_at));
```

`croft docs internals` documents these tables. For example, `_croft.writes` maps any row's `_loaded_at` to the run that wrote it.

**Observability and coordination state** lives in `.croft/runs.sqlite` (bun:sqlite, WAL, `busy_timeout = 5000`). It stays readable while DuckDB is locked.

```sql
CREATE TABLE runs     (id TEXT PRIMARY KEY, trigger TEXT, human INTEGER, argv TEXT, pid INTEGER,
                       proc_start TEXT, boot_id TEXT, started_at TEXT, finished_at TEXT, status TEXT, summary TEXT);
                       -- status: running|succeeded|failed|crashed|interrupted
CREATE TABLE steps    (run_id TEXT, asset TEXT, attempt INTEGER, status TEXT, reason TEXT, started_at TEXT,
                       finished_at TEXT, rows_in INTEGER, added INTEGER, updated INTEGER, error TEXT,
                       code_hash TEXT, log_path TEXT, PRIMARY KEY (run_id, asset, attempt));
CREATE TABLE leases   (asset TEXT PRIMARY KEY, run_id TEXT, pid INTEGER, proc_start TEXT, boot_id TEXT, since TEXT);
CREATE TABLE lock_holder  (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER, run_id TEXT, asset TEXT,
                           action TEXT, since TEXT);
CREATE TABLE lock_waiters (pid INTEGER PRIMARY KEY, purpose TEXT, since TEXT);
CREATE TABLE schedule_state (asset TEXT PRIMARY KEY, phrase TEXT, cron TEXT, file_hash TEXT,
                             last_fire_at TEXT, last_attempt_at TEXT,       -- UTC instants
                             approved_code_hash TEXT);                      -- §6 scheduler hold
CREATE TABLE tick     (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER, proc_start TEXT, heartbeat_at TEXT);
CREATE TABLE confirmations (token TEXT PRIMARY KEY, command TEXT, impact TEXT, impact_hash TEXT,
                            created_at TEXT, expires_at TEXT, used_at TEXT);
CREATE TABLE catalog  (asset TEXT PRIMARY KEY, json TEXT, source TEXT, refreshed_at TEXT);
                       -- mirror of _croft.* (source: run | preview | pins); DuckDB wins
```

### Versions, staleness and atomicity

**`_loaded_at` is each table's data version.**

- Every write stamps changed rows with `_loaded_at = greatest(now(), last_loaded_at + 1 µs)`. This is strictly increasing per table, even if the clock steps back.
- A transform is stale when:
  - it was never built;
  - an input's `last_loaded_at` is newer than its `seen_loaded_at`;
  - an input's `last_replaced_at` is newer (after a restore or an out-of-band change);
  - or its code changed (§8).
- `newRows(x)` means rows after the composite position `(seen_loaded_at, seen_key)`.
- Writes are serialized by the file lock, and inputs are read inside the consuming step's own transaction (SQL) or snapshot (TS). So no committed row can fall between two positions unseen.

**Atomicity.**

- Each asset write is all-or-nothing: schema changes, rows, checks, cursor, file list and bookkeeping commit together. The one exception is by design: incremental TS transforms commit in chunks, and each chunk is all-or-nothing.
- A multi-asset run is deliberately *not* one transaction. A failed asset keeps its old data, and its downstream shows `skipped: input open_issues failed (r_…)`.

**Out-of-band changes.** At every commit croft records `row_count` and `max(_loaded_at)`. At the next write lease and in `doctor`, it compares them with the table. A mismatch means something other than croft wrote the table. croft then reports `OUT_OF_BAND_CHANGE` and bumps `last_replaced_at`, so downstream rebuilds.

**Crash recovery.**

- `kill -9` during extraction changes nothing in the database.
- `kill -9` inside the transaction is discarded by DuckDB. A process holding 2M uncommitted rows plus an `ALTER` plus a state update was killed, and all three were gone after reopening. A commit followed by a kill before checkpoint was recovered from the WAL [V].
- Every command that writes, and every tick, starts with `reconcile()`:
  1. Runs marked `running` whose PID is dead become `crashed`.
  2. Their steps are matched against `_croft.writes.run_id` under a short read lease. A commit that landed just before the crash becomes `ok (recovered)`, because DuckDB is authoritative.
  3. Their leases are released, and their staging is scheduled for deletion.
- Cursors move only on commit, so a crash means extraction is redone, never skipped: at-least-once extraction, exactly-once visibility.
- Durability across power loss relies on DuckDB's WAL fsync [U].

### The user's own app, GUIs and the read copy

An app or GUI that keeps the live file open blocks every croft write, and even well-behaved open-per-query readers delay writers. Two overlapping readers delayed a writer by 2.4 s [V]. So by default croft maintains **`warehouse.read.duckdb`**, a consistent copy refreshed at the end of every run that changed data:

1. Under the write lease, run `CHECKPOINT`. A copy taken without it missed committed rows still in the WAL (1,000 of 1,500) [V].
2. A child process clones the file to a temporary name (`cp -c` on macOS, `cp --reflink=auto` on Linux). A child is used because the owning process must not open the file (above).
3. Atomically rename it into place.

On APFS the clone takes 0.1–0.2 ms [V]. Elsewhere it is a full copy; Linux reflink is [U]. `doctor` prints the measured cost and suggests `"readCopy": false` when it exceeds about 5 s per run.

**`import { query } from "croft/read"`** is how apps read data. It ships as prebuilt JavaScript and works in Bun and Node [V].

- It finds the project from a `{ project }` option, then the `CROFT_PROJECT` environment variable, then by walking up from the current directory (including `./data/croft.json`). If none is found, it fails with a clear message.
- It opens the **read copy** read-only per query and closes it. It checks inode and mtime, so it never serves a stale handle after a refresh.
- It sets the project time zone from `croft.json` on its connection, and it uses no Bun-only APIs.
- It never touches the live file unless `readCopy` is off. In that case it first checks `.croft/write-intent`, which a waiting croft writer creates. While that file is fresh, the reader waits up to 2 s so the writer can get in. Two overlapping app readers otherwise starved a writer for the whole test window [V]. After that it retries on lock conflicts for up to 5 s. The read copy is POSIX-only in v1.

Other readers are covered the same way:

- The `DB_HELD_BY_OTHER_PROGRAM` fix tells users to point the DuckDB UI, DBeaver or notebooks at `warehouse.read.duckdb`.
- Deploying data together with a hosted app is out of scope for v1, because croft is local-first (§11).

---

## 6. Environments & safety model

**Principle.** croft never hands user code a writable database handle. It sandboxes every DuckDB connection, and it detects writes it did not make.

- An ingest yields rows.
- A TS transform receives snapshot inputs and yields rows.
- A SQL asset is one validated SELECT.
- AI-written code can still produce *bad rows*; the layers below catch those.

This is enforced (§5), not only a convention:

- User SQL is restricted to a single SELECT on sandboxed connections.
- TS assets may not import the DuckDB binding (`ASSET_OPENS_DATABASE`).
- Anything that still writes out of band is reported (`OUT_OF_BAND_CHANGE`).

### Ways to try a change, from cheapest to most real

**1. `croft validate` touches no data.**

- It parses headers and SQL, finds dependencies and cycles, imports TS assets to check their config shape, and checks schedule phrases, secrets and every check expression.
- It runs a **bind check**. An in-memory DuckDB gets empty tables built from the cached column lists. Each SQL asset is `prepare()`d in dependency order, and its output columns become the empty input of the next asset. DuckDB's own messages supply "Candidate bindings" and caret positions, shifted past the header [V].
- **Inputs never built.** The column cache is filled by runs, by previews and by `columns` pins. An input with no cache yields `INPUT_NOT_BUILT` (info), and only the assets that read it skip the bind. They are never reported as errors the agent cannot fix.
- A binder error that involves a column still `pending` (all NULL so far) is reported as `NULL_ONLY_COLUMN`, with an edit fix that adds a pin.
- `validate --json` returns every SQL asset's output columns, so the agent knows what the next asset can use.
- `--types` also runs `tsc --noEmit`.

**2. `croft preview <asset…>` runs the code and changes nothing real.** It works in `.croft/preview.duckdb`.

- **Inputs are snapshotted.** Under one short read lease, croft copies every live input the preview needs to `.croft/preview/<name>.parquet`. The preview database then sees them as views, so everything in a preview, including later `query --preview` calls, reads one consistent snapshot. The live file is never `ATTACH`ed from a second instance, which would risk releasing its lock (§5).
- **SQL transforms** (and SQL downstream of them) are built from those snapshots.
- **TS transforms** read Parquet snapshots, as in a real run. `--rows` (default 1,000) caps the *input* rows they receive, and `ctx.preview` is true, so a per-row LLM transform costs at most 1,000 calls in a preview.
- **Ingests** fetch from the real saved cursor and stop the generator after `--rows` rows. The cursor does not move. Downstream assets are listed but not built from a partial sample, because a diff against a partial input would suggest that correct SQL is wrong.
- **The output** diffs against live: row counts, added/removed/changed by key, column changes, check results, samples, and `data.partial` / `data.inputsSnapshotAt` in JSON. When the preview could only build part of the table (capped input rows, or an incremental TS transform), the diff covers only the keys the preview produced ("of 1,000 keys touched, 37 differ"). It never reports every other row as removed. `croft query --preview` explores the result. The preview file stays until the next preview.
- **`preview --rebuild`** builds the asset from scratch and compares it with the live table. It is how to find incremental drift or out-of-band edits: "3 of 812 rows differ".

**3. The real run.** Writes are all-or-nothing, and blocking checks run before commit. That is write-audit-publish without the name.

**No named environments in v1.** For one person whose rebuilds take seconds, promotion machinery adds concepts and states that an agent can corrupt. Preview, all-or-nothing writes, the trash and the scheduler hold (below) cover the same need. See decision D8.

### The scheduler only runs code a human has run

The scheduler reads the working tree, so it could otherwise run an ingest the agent is in the middle of editing. Two debugging edits are common:

- a fixture `yield [{ id: 1, title: "test" }]`, which a merge would write over real issue 1;
- a temporary filter, which would move the cursor past rows that were never loaded.

To prevent this, the tick runs an asset only if its current code hash equals `approved_code_hash`. That hash is set by the last successful **human-initiated** `croft run` or `croft preview` of that asset. Human-initiated means a command from a terminal or from Claude Code, as opposed to the scheduler.

Otherwise the asset is skipped with `SCHEDULE_HELD`, and `status` shows it plainly: "held: code edited 12 min ago, not run by hand yet; `croft run github_issues` releases it". New assets are held until they have been run by hand once. `croft schedule pause --for 2h` pauses everything during a larger refactor.

### Nothing implicit destroys ingested data

- **Deleting an asset file** leaves its table in place, shown as "no asset file".
- **Renaming a file outside croft** creates a new, never-built asset whose code hash matches the orphan's. `validate` reports `ASSET_RENAMED`, with the fix `croft rename <old> <new>`, which adopts the orphan's table and state instead of refetching history.
- **Columns** are never removed automatically.
- **Types** widen only when the widening is proven lossless (§7).
- **Changing ingest code never refetches.**
- **Shrink guard.** A replace ingest that would remove more than half of its rows (including all of them) fails with `SHRINK_GUARD`, because an expired token that returns `[]` must not wipe the table. The error's fix is `{kind: "manual", requiresHuman: true}`: "find out why the source returned 0 of 265 rows before overriding". Its details include the request count, last status and body preview. `--allow-shrink` is a destructive operation: trash first, then confirmation. `allowShrink: true` in the asset produces the warning `SHRINK_GUARD_DISABLED`.
- **Behavior changes.** Changing an ingest's `key`, `write` mode or incremental field while it has data fails with `INGEST_CONFIG_CHANGED`. The fixes offered are:
  - revert the change;
  - `croft run x --rebuild`, which refetches from scratch (trash first, confirmation);
  - when a key is added to an append ingest, **convert in place**: deduplicate the existing rows by the new key, keeping the latest `_loaded_at` (trash first, confirmation).

  Adding a `lookback` applies directly.
- **Pin changes.** A new `columns` pin on an existing ingest column is tested first by counting values that would change: `try_cast(x AS new)::old IS DISTINCT FROM x`.
  - A lossless pin applies directly.
  - A lossy pin (for example, `VARCHAR` → `BIGINT` turns `'02134'` into `2134` [V]) raises `PIN_CHANGES_DATA`, with samples, and needs confirmation. The old column goes to the trash first.

### Destructive operations need confirmation

| Operation | Why it is destructive | Trash first |
|---|---|---|
| `run --rebuild` of an ingest | refetches; old history may be gone at the source | yes |
| `run --rebuild` of an incremental TS transform, or `LARGE_REPROCESS` | may spend money | yes (rebuild only) |
| `run --allow-shrink` | removes most rows of an ingest | yes |
| `delete <asset>` / `delete <asset> --where "<expr>"` | removes a table or rows | yes |
| `restore <asset>` | overwrites the current table | the current version |
| lossy pin change, key conversion | rewrites stored values | yes |

These do **not** need confirmation, because they are recomputable or reversible:

- `run --rebuild` of a SQL or full-refresh TS transform;
- `run --from` on a merge ingest (an upsert; the cursor never regresses);
- `rename`.

**How confirmation works:**

- **On a TTY,** croft prints the impact and asks `Proceed? [y/N]`.
- **Off a TTY,** it exits 5 with `confirmation: {token, expiresAt, command, impact: {asset, rows, bytes, trashPath, downstream[]}}`. The action runs only through `croft confirm <token>`. That command recomputes the impact and fails with `CONFIRMATION_STALE` if it changed, for example because the scheduler added rows in the meantime.
- Tokens are single-use and expire after 15 minutes. Destructive commands never appear in `next`.
- Because every destructive path funnels into one command prefix, one Claude Code permission rule gates them all: `"ask": ["Bash(croft confirm:*)"]`. `croft docs claude-permissions` prints it. The skill's rule is: never run `croft confirm` without the user's explicit yes in this conversation.

### Trash, restore and delete

- **Format.** A trashed version is a standalone DuckDB file, `.croft/trash/<asset>/<time>.duckdb`, holding the table (or the deleted rows, or the old column) plus its `_croft` rows. It is written through `ATTACH`, which preserves HUGEINT, JSON, TIMESTAMPTZ and DECIMAL exactly and took 1 ms for a small table [V].
- **Two commits.** One transaction cannot write to two database files ("a single transaction can only write to a single attached database") [V]. So trashing commits first and the destructive change commits second. A crash between them only leaves an extra trash file.
- **Restore** reads the trash file read-only and writes the warehouse in one transaction [V]. It also bumps `last_replaced_at`. Downstream SQL transforms then rebuild, and incremental TS transforms show "input restored; `--rebuild` offered".
- **`delete <asset> --where "<expr>"`** validates the predicate as a single SELECT expression. Its impact is a row count. It moves the rows to the trash, then deletes them and bumps `last_replaced_at`.
- **Retention** is 30 days or 5 versions per asset.
- **Before an engine upgrade.** Before the first open with a newer DuckDB, `warehouse.duckdb` is copied whole to `.croft/backups/`, together with `warehouse.duckdb.wal` if one exists. A crash can leave committed data only in the WAL. "Newer engine" is decided from the version recorded in `runs.sqlite`, because a file written by a newer format cannot be opened to read `_croft.meta`.
- **Deleting `.croft/` deletes the trash.** `.croft/` holds the trash and backups, so it is not a disposable cache. The skill forbids deleting it or running `git clean -X`.

### Guards aimed at agents

- Destructive commands take exact names only, with no globs and no `--all`.
- `query` is one sandboxed SELECT.
- Destructive commands appear only behind `croft confirm`.
- The skill's "ask the user first" list (§9).
- Agent evals score whether the agent ever confirmed without asking (§10).

---

## 7. Schema inference, evolution & nested data

**Inference follows croft's rules, not DuckDB's sniffer.** The sniffer depends on the batch:

- A timestamp column mixing `+02:00` and `Z` offsets was inferred as VARCHAR, and so was one with mixed fractional seconds; a uniform batch of the same field was inferred as TIMESTAMP [V].
- CSV dates flip between day-first and month-first depending on the rows present [V].

So two loads of the same API could type differently. Instead, croft stages every top-level value as `JSON`. This keeps integers of any size exact, but fractions are re-rendered as IEEE doubles: `3.14159265358979323846` becomes `3.141592653589793`, and `1.50` becomes `1.5` [V]. It classifies each column with `json_type()` plus regular expressions for string sub-kinds [V], and decides the type from fixed rules. The pipeline measured 53 ms staging, 26 ms classification and 34 ms typed cast for 1M×5 values [V].

### Type of a new column

| Values seen (non-null) | Type |
|---|---|
| all booleans | BOOLEAN |
| all integers within int64 | BIGINT; beyond int64 → HUGEINT |
| integers and fractions | DOUBLE if every integer is within ±2^53, otherwise VARCHAR (raw text) + `MIXED_TYPES` warning |
| strings: ISO-8601 date-time with `Z` or an offset | TIMESTAMPTZ |
| strings: ISO-8601 date-time without an offset | TIMESTAMP |
| strings: `YYYY-MM-DD` | DATE |
| other strings | VARCHAR (no UUID, time or number guessing, so the zip code `02134` stays text) |
| any object or array | JSON |
| mixed scalar kinds | VARCHAR (raw text) + `MIXED_TYPES` warning |
| only NULLs so far | a placeholder typed **from the column name**, marked `pending` (below) |

**NULL-only columns.** Nullable timestamps such as `closed_at` and `refunded_at` are NULL in almost every first load. A VARCHAR placeholder breaks typed SQL: `date_diff`, comparison with TIMESTAMPTZ and `COALESCE` all fail to bind [V]. So the placeholder is typed from the name:

- `*_at`, `*_time`, `*_timestamp` → TIMESTAMPTZ
- `*_date`, `*_on` → DATE
- `is_*`, `has_*` → BOOLEAN
- anything else → VARCHAR

Pending columns hold only NULLs, so they are retyped freely when real values arrive.

**CSV text** follows the same string rules, plus these:

- `^-?(0|[1-9]\d*)$` → BIGINT, and plain decimals → DOUBLE.
- Money and thousands-separated numbers (`$1,234.50`, `($3.00)`) → DECIMAL(18, s), with the parsed format recorded [V]. Comma-decimal formats (`1.234,50`) are ambiguous and need a pin.
- `true`/`false` → BOOLEAN, and empty → NULL.
- **Dates such as `03/25/2026`** get a format decided *once per column* and stored in `_croft.columns.format`, so it never flips between loads:
  - a day greater than 12 in the first position means day-first;
  - in the second position, month-first;
  - both means VARCHAR + `MIXED_DATE_FORMATS`;
  - neither is ambiguous: month-first when the project time zone is in the Americas, otherwise day-first, with `AMBIGUOUS_DATE_FORMAT` naming the choice and the pin that overrides it.

  A later value that does not parse with the stored format is a `TYPE_CONFLICT`, never a silent flip.

**Parquet** types are normalized on read to the lattice above: SMALLINT/INTEGER → BIGINT, FLOAT → DOUBLE, UUID → VARCHAR, and nested types → JSON. Otherwise INTEGER-versus-BIGINT drift between files would be a `TYPE_CONFLICT`.

### Evolution of an existing column

This runs inside the load transaction and is recorded in `_croft.writes.schema_changes`.

| Situation | Result |
|---|---|
| new field | `ADD COLUMN`; old rows NULL |
| field disappears | column kept; new rows NULL. In a merge, stored values stay, and `COLUMN_STOPPED_ARRIVING` warns (below) |
| `pending` column gets real values | `ALTER … TYPE` (existing values are all NULL) |
| BIGINT receives integers beyond int64 | widen to HUGEINT + `TYPE_WIDENED` |
| BIGINT receives fractions | widen to DOUBLE only after the lossless proof `v::DOUBLE::HUGEINT = v` holds for existing and incoming values (it catches 9007199254740993 [V]), + `TYPE_WIDENED` |
| DATE receives date-times | widen to TIMESTAMP (naive values) or TIMESTAMPTZ (zoned values, dates read as midnight in the project time zone), + `TYPE_WIDENED` |
| incoming values of the **same kind** in another format (another ISO offset or precision) | cast on insert; type kept |
| VARCHAR receives numbers or booleans | stored as text |
| JSON receives anything | stored as JSON |
| anything else, including number ↔ text, float → integer, boolean ↔ number, naive ↔ zoned | **`TYPE_CONFLICT`**: the load rolls back and the cursor does not move |
| pinned column | never widened; a value that does not cast exactly fails with `TYPE_PIN_VIOLATION` and sample rows |

**Casts are whitelisted and verified.** Every cast reads the JSON *text* (`v->>'$'`), never the JSON value: casting JSON to DECIMAL goes through DOUBLE, so `1.005` became `1.00`, while the text gave `1.01` [V]. The "same kind" row above is the only implicit cast. DuckDB casts that looked clean are silently lossy:

- `'2024-01-01T10:00:00+02:00'::TIMESTAMP` drops the offset.
- `'1.5'::BIGINT` rounds to 2, including through `try_cast`.
- An implicit INSERT cast stored DOUBLE 1.7 as 2 in a BIGINT column [V].

So after every cast, a **round-trip loss check** counts rows where the raw value is not NULL and either the typed value is NULL or it differs from the raw value when compared canonically:

- Numbers compare as `TRY_CAST(text AS DECIMAL(38,18)) IS DISTINCT FROM typed::DECIMAL(38,18)`. This catches `1.7` → 2 and `19.999` → `DECIMAL(18,2)`.
- Timestamps compare as epoch instants.
- Any loss fails the load. For a pinned DECIMAL, the failure is `PIN_ROUNDED`, with a count.

**Money on JSON sources.** A `DECIMAL` pin with more than 15 significant digits on a JSON or API source is `DECIMAL_PRECISION_UNSUPPORTED`, because the digits beyond double precision are already gone. The fix is to yield such values as strings. CSV sources are unaffected, because `all_varchar` keeps the text.

**`TYPE_CONFLICT`** names the column, both types, the count of bad rows, 5 sample values and the downstream assets that read the column. Its fixes, in order:

1. Clean the value in `rows()` or `map()`. The error includes a generated snippet.
2. Pin a type with a `format`.
3. Pin `VARCHAR` to accept text on purpose. This makes `min`/`max`/`ORDER BY` lexicographic downstream (`'9' > '10'` [V]), and the fix text says so.

A loud failure at the ingest is chosen over silently widening to text, because text breaks downstream SQL with confusing errors far from the cause.

**Drift that does not fail a load is still reported:**

- `COLUMN_STOPPED_ARRIVING`: a column that was non-null in at least 95% of earlier rows is absent from a whole batch of at least 100 rows. It lists `readBy`.
- `JSON_KIND_CHANGED`: a JSON column gains a new kind, for example object → string. This matters because `col->>'login'` silently returns NULL on a string [V].
- `TYPE_WIDENED`, as above.

All three appear in `status` ("schema changed today") and in `context.recentSchemaChanges`.

### Nested data becomes JSON columns

Nested values are stored raw and exact. The table's schema therefore never changes because of nested data, and nested type drift can never fail a load. Querying uses idioms Claude already knows:

- `user->>'login'`; `user` needs no quoting [V].
- `labels->>'$[*].name'`, which returns `VARCHAR[]` [V].
- `json_each(labels)` for one row per element.

`describe` lists the keys seen inside each JSON column, so JSON stays discoverable. The skill recommends a SQL asset that extracts typed columns once, when heavy analysis needs them.

**Rejected alternatives:**

- Native STRUCTs: inserting a STRUCT with an extra field silently drops that field [V].
- Flattening to `user__login` columns: it adds dozens of columns and routes every nested leaf through the conflict machinery.
- Child tables: they force joins on non-data-engineers.

### Column names

Column names are kept as written, because DuckDB identifiers are case-insensitive; that keeps SQL matching the API docs. Unicode letters work unquoted (`SELECT 名前`, `SELECT café`) [V]. The cleanup happens in the JavaScript NDJSON writer, before anything reaches `read_json`. `read_json` matches keys case-sensitively: it loaded NULL for `ID` into a column declared `Id`, and failed on an empty key or on both `Id` and `id` [V]. The rules:

- Characters other than letters (any script), digits and `_` become `_`.
- Runs of `_` collapse, and leading and trailing `_` are trimmed, so `Amount ($)` becomes `Amount`.
- A leading digit gains a `col_` prefix. A name that ends up empty becomes `col_<position>`.
- Each key is resolved case-insensitively against the stored spelling in `_croft.columns`, so `ID` and `Id` land in the same column. Distinct names that still collide get `_2`, with a warning.
- Source fields named `_loaded_at` or `_file` become `_source_loaded_at` and `_source_file`.
- The original name is kept in `_croft.columns.source_name`.
- Every identifier croft generates (MERGE, INSERT, checks, keys) is quoted.

Names that are reserved SQL keywords (`order`, `group`, `end`, `limit`) are kept, but they must be quoted in SQL (`"limit"`) [V]. Non-reserved keywords such as `user`, `type` and `position` work unquoted [V]. `describe` shows them quoted, and `validate` turns the resulting parser error into `QUOTE_IDENTIFIER` with an edit fix.

### Merge semantics

- A column absent from the whole batch keeps its stored values, and `COLUMN_STOPPED_ARRIVING` watches it.
- A present column overwrites, including with NULL. Within a batch, a row that lacks a key the other rows have counts as NULL for that column. Partial-update APIs that send only changed fields need a post-v1 `partial: true` mode.
- A NULL key fails with `KEY_NULL`.
- Duplicate keys within a batch keep the row with the highest cursor, then the last one yielded.
- JSON values are canonicalized (sorted keys, minified) at staging, so key order and whitespace never count as a change [V]. Unchanged rows keep their `_loaded_at`.

### Time zones

- Every croft session runs `SET TimeZone = '<project timezone>'` after connecting. Setting it as an instance option fails [V].
- TIMESTAMPTZ stores instants, so `created_at::DATE` and `date_trunc('day', …)` produce *the user's* days: `2024-01-02T10:00:00Z` became `2024-01-02 03:00:00-07` under America/Los_Angeles [V].
- `--json` renders timestamps as ISO-8601 with the project offset, so the JSON agrees with SQL's days. croft renders values itself, because `getRowObjectsJson()` formats TIMESTAMPTZ in the process-local zone [V].

### SQL transforms

SQL transforms define their own shape. Each rebuild takes whatever the SELECT returns, minus reserved columns.

---

## 8. Scheduling, incrementality & backfills

### Writing a schedule

Only ingests have schedules; transforms follow their inputs. An ingest can say `schedule:` with any of these:

- `"every 15 minutes"`
- `"every hour"` / `"hourly"`
- `"daily at 06:00"`
- `"weekdays at 9am"`
- `"every monday at 08:30"`
- `"monthly"`
- a 5-field cron expression

`validate` shows the cron form and the next three fire times in the project time zone. Due times come from croft's own time-zone-aware matcher, about 100 lines using `Intl`. Fire times are defined as instants, so DST cannot drop or double them:

- A local time that does not exist (02:30 on a spring-forward day) fires at the first valid minute after the gap.
- A repeated local time (01:30 on a fall-back day) fires once, at its first occurrence.
- `last_fire_at` is stored in UTC.

Naive wall-clock matching would never fire "daily at 02:30" on 2026-03-08 in Los Angeles, and would fire "daily at 01:30" twice on 2026-11-01 [V]. Golden tests cover both days. Bun's `Bun.cron.parse` is not used, because its time-zone behavior changed between versions: on 1.3.14 it returned the same UTC result for every zone, and on 1.4.2 it honored the zone [V].

### Turning it on

`croft schedule on` makes sure **one per-user OS job** exists and adds the project to a registry, `~/.croft/projects.json`.

**The job:**

- **macOS:** a LaunchAgent, `~/Library/LaunchAgents/dev.croft.tick.plist`, with `StartInterval` 60.
- **Linux:** one crontab line.
- It runs `~/.croft/tick.ts` with an absolute Bun path, preferring a stable symlink (`~/.bun/bin/bun`, `/opt/homebrew/bin/bun`) over a version-manager path that disappears on upgrade.
- Its output goes to `~/.croft/logs/tick.log`.

**Each tick only plans and spawns.** It never does the work itself: launchd runs at most one process per job, so a tick busy with a 40-minute transform would drop every later fire [U]. For every registered project that still exists and has scheduling on, the per-user tick starts the project-pinned `croft tick`, which:

1. exits at once if another tick for the project is alive (a singleton row with PID and process start time), since cron can start overlapping ticks;
2. records a heartbeat and runs `reconcile()`;
3. computes due work from the `runs.sqlite` mirror;
4. spawns one detached `croft run --due` per independent group of due assets (the children take the leases);
5. exits, usually within a second.

The per-user tick also prunes projects whose folder is gone, so moving or deleting a project cannot leave a job firing forever. It spawns every process with an absolute `process.execPath`, because launchd's `PATH` does not include `~/.bun/bin`.

**`schedule on` waits for the first heartbeat, up to 70 s.** If none arrives, it prints the tail of `tick.log` with the likely cause:

- macOS privacy protection blocking background access to `~/Documents`, `~/Desktop` or `~/Downloads` [U];
- a missing Bun path;
- on WSL, a VM that sleeps when no terminal is open [U].

`status` and `doctor` show `SCHEDULER_STALE`, with the same diagnosis, whenever the last heartbeat is older than 3 minutes. On servers, in containers and on WSL, `croft schedule start` runs the same per-minute loop in the foreground instead, spawning a fresh `croft tick` each minute. Windows gets no OS registration in v1 (tier 2), so there too the answer is `schedule start`, or a documented Task Scheduler entry.

**The first task of phase 3 is a spike on launchd and crontab registration,** including test fires, wake behavior and privacy protection, and it gates the rest of the phase. None of this could be verified without modifying the host.

Why not `Bun.cron`, which registers OS jobs too:

- It only exists since Bun 1.3.11 [V].
- It registers one job per title, which is orphaned when a project moves.
- Its logs go to `/tmp`.
- Its registration was never observed working [U].

Writing a plist or a crontab line directly is about 150 lines, and croft controls the logs.

### What counts as due

`croft tick` reads schedules from `schedule_state`, which is cached by file hash, so a tick with nothing due takes about 50 ms and imports no asset code. The due set is:

- ingests whose schedule fired since `last_fire_at`, plus their stale downstream;
- **any stale transform**, even when no ingest is due. A transform can be left stale by `run --only`, an edit that has since been run by hand, or an earlier failure. Without this rule it would wait for its input's next scheduled fetch.

The tick skips anything **held**:

- `SCHEDULE_HELD`: code not yet run by hand (§6);
- `LARGE_REPROCESS`: the cost guard (§5);
- `paused`;
- or leased by another run.

`last_attempt_at` is recorded when an attempt starts, and `last_fire_at` when a due fire is handled. After its final retry, a deterministic failure (`TYPE_CONFLICT`, `CHECK_FAILED`, SQL errors) waits for the next fire time, or for a change to its code or inputs. It is never retried every minute.

### What the user experiences

- **Downstream follows automatically.** Transforms have no schedule and update in the same run as their inputs.
- **Missed times run once.** After a laptop sleeps through 8 hourly fires, the ingest runs once on wake. Its cursor fetches everything since, so no data is skipped.
- **Overlaps skip.** An asset still leased by the previous tick is skipped and stays due.
- **Retries.** TS assets get 2 retries (after 30 s and 2 min) on retryable errors: network errors, 429/5xx after `http`'s own retries, and `DB_BUSY`. SQL and deterministic errors (`TYPE_CONFLICT`, `CHECK_FAILED`, SQL errors) are not retried.
- **Timeout** means "no progress": no row yielded and no request completed for 10 minutes. `timeout: "30m"` changes it. Chunked TS transforms (§3e) can run for hours as long as they progress.
- **Failures** show in `status`. By default, a failed *scheduled* run also raises a desktop notification (`osascript` on macOS, `notify-send` on Linux). `"notify": {"desktop": false, "webhook": "https://hooks.slack.com/…"}` in `croft.json` changes this. A webhook receives the failure envelope.

### Incrementality by asset type

| Asset | Mechanism | What happens on each run |
|---|---|---|
| API ingest | `incremental: "field"` or `{field, unit, lookback}` → `since` | fetch from the saved position (minus lookback); save the new maximum with the rows |
| File ingest | `incremental: true` | load new files; reload changed files in place; keep rows of deleted files |
| SQL transform | none in v1 | recompute in full, written as a diff so unchanged rows keep `_loaded_at` |
| TS transform | `incremental: true` + `newRows()` | process rows written since the last run; the cost guard holds large batches |

### What a code change does

- **SQL transforms** are rebuilt. They are local, so the only cost is time; `VOLATILE_SQL` flags the ones that are not deterministic.
  - The fingerprint hashes DuckDB's AST JSON with `query_location` removed and every `*_name` identifier lowercased, plus the header and the **project time zone**. Changing `timezone` in `croft.json` rebuilds every transform, because `::DATE` results depend on it [V].
  - It ignores whitespace, comments and keyword or identifier case, and it detects real changes [V].
  - It avoids the `json_deserialize_sql` round trip and its uint64 `query_location` precision trap [V].
- **Full-refresh TS transforms** are rebuilt.
  - The fingerprint hashes the `Bun.build` output of the file with `packages: "external"` and `minify: {whitespace: true, syntax: true, identifiers: false}`, plus the versions of imported packages and the project time zone.
  - This covers edits in `lib/`, ignores comments and formatting, and costs under 1.2 ms per asset [V].
  - Identifier minification must stay off: with it on, a comment-only edit changed the hash [V].
- **Incremental TS transforms** apply new code to new rows only, because they may call paid services. `status` says: "issue_triage edited since last run; 18,556 rows were built by older code; to redo them: `croft run issue_triage --rebuild`" (trash plus confirmation).
- **Ingests** never refetch because of a code change.
- **In every case,** a changed asset is held from the scheduler until it has been run by hand (§6).

### Backfills

A backfill is a flag, and it is defined per asset type:

| Asset | `croft run x --from <when>` |
|---|---|
| merge ingest (key + incremental) | fetches from `<when>` and upserts. The saved cursor stays `greatest(saved, loaded)`, so the schedule never rewinds. |
| append ingest (`write: "append"`) | `BACKFILL_WOULD_DUPLICATE` (exit 2) unless `<when>` is after the saved cursor. Fix: add a key. |
| replace ingest | `BACKFILL_UNSUPPORTED`: "replace ingests always fetch everything: `croft run x`" |
| file ingest | `BACKFILL_UNSUPPORTED`: "changed files reload automatically; `croft run x --rebuild` reloads all files" |
| SQL / TS transform | `BACKFILL_UNSUPPORTED`: "use `croft run x --rebuild`" |

`<when>` accepts `2026-06-24`, a full ISO timestamp, or a relative value (`-90d`, `-12h`, `today`). croft converts it to the cursor's type and echoes the conversion: `since: 1750748400 (2026-06-24T00:00:00-07:00)`. `run --dry-run --from -90d` shows the same without fetching.

The same flag fills a new field for old rows of a merge ingest: `croft run stripe_charges --from 2024-01-01`.

**Large first loads.** Off a TTY, a run detaches, so a long first load is never killed by the agent's shell (§5). The agent polls with `croft wait <id> --timeout 100s` or uses its own background shell.

A crash, a kill or a rate-limit failure late in a long first load must not force a refetch from zero. So cursor ingests use **monotone partial commits** (phase 4). While writing parts, the JavaScript writer checks that every cursor value in the new parts is at least every value in earlier parts. If so, every 50k rows or 5 minutes croft commits those parts, with the cursor set to their typed maximum. If the order is not monotone (newest-first APIs), the ingest keeps single-transaction behavior.

---

## 9. Claude Code integration

The agent has never seen this tool. Everything it needs ships inside the installed version, and `croft init --claude` refreshes it.

**1. The `CLAUDE.md` managed block:**

```markdown
<!-- croft:start (managed by `croft init --claude`) -->
## Data pipelines (croft)
This project loads and transforms data with croft (TypeScript + DuckDB). Load the `croft` skill for any work in
assets/, lib/ or on warehouse.duckdb. Start with `croft context --json`.
Loop: edit → `croft validate --json` → `croft preview <asset>` → `croft run <asset>` → `croft query "..."`.
Never modify warehouse*.duckdb or .croft/ except through croft. Never read .env or handle secret values.
Ask the user before any command in the skill's "Ask the user first" list, including every `croft confirm`.
<!-- croft:end -->
```

**2. `.claude/skills/croft/SKILL.md`:**

```markdown
---
name: croft
description: Build and operate this project's data pipelines with the croft CLI (DuckDB). Use when adding a data
  source, writing SQL or TypeScript transforms, adding checks, scheduling, debugging a failed run, backfilling,
  renaming, or answering a question from project data.
---
<!-- croft 0.1.0 -->
croft is not dbt, dlt, SQLMesh or Dagster; do not assume their behavior. Ask the CLI: `croft docs <topic>`,
`croft docs <ERROR_CODE>`, `croft docs --list`, `croft new --list`. Every command takes `--json` →
{ok, data, problems[], next[], confirmation?}.

## Orient
croft context --json        # assets, columns, behavior, schedules, running, held, recent failures and schema changes
croft status                # failed, stale, held, edited, orphaned

## Loop (always)
1. New asset: `croft new api|file|sql|transform <name>`; edit the template, don't invent APIs.
2. `croft validate --json` after EVERY edit; apply each problem's `fix`.
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
- Use `ctx.http` and `res.json()` (lossless numbers), never raw fetch + JSON.parse for API data.
- Nested fields are JSON: `col->>'field'`, `col->>'$[*].name'`, `json_each(col)`. `croft describe` lists keys.
- Columns named like SQL keywords must be quoted: `"order"`.
- Apps read with `import { query } from "croft/read"` (reads warehouse.read.duckdb); never open the .duckdb files.

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
- Renaming or deleting files in assets/ (use `croft rename`); `croft schedule on|off|pause`.
- Deleting .croft/ or warehouse*.duckdb, or `git clean -X` (the trash and backups live in .croft/).
- Weakening or deleting a failing check.

## Recipes
- Failed run: croft status --json → croft logs <asset> --failed → fix → croft validate --json → croft preview <asset>
  → croft run <asset> → croft status.
- Held asset: it was edited and not run by hand; run it by hand once (croft run <asset>) after checking the preview.
- Backfill: croft run <asset> --dry-run --from -90d, then the same without --dry-run. Merge ingests only.
- Rename: croft rename <old> <new>; fix every reference it lists; validate; preview; run.
- Wrong number: croft describe <asset> --json → croft preview <asset> --rebuild (drift) → query the upstream
  with the same filter; `croft docs internals` shows how _croft.writes maps rows to runs.
- API changed: new fields appear automatically; fill them for old rows with --from (merge ingests).
  TYPE_CONFLICT: clean the value in rows()/map() first; a pin can rewrite stored values.
- Missing secret: ask the user to add NAME=... to .env (or run `croft secrets set NAME` in their terminal);
  check with `croft secrets --json`. Never read .env.

## Output
- JSON timestamps carry the project offset; ::DATE uses the croft.json timezone.
- `query` rows are capped: check data.truncatedRows before concluding anything; aggregate in SQL.

## Long work
- Off a TTY, `croft run` returns after ~100 s with exit 6 and keeps running: `croft wait <runId> --timeout 100s`.
- Never retry a non-retryable error unchanged.
```

**3. The machine-readable contract** is in §4.3. In summary:

- Every command has `--json`, with `schemaVersion: 1`, frozen by golden tests and published JSON Schemas.
- `run --events` streams NDJSON progress.
- Asset names are table names everywhere.
- Timestamps carry the project offset, and durations are in milliseconds.

**4. Error design.** Every problem carries:

- a stable `code` from a registry;
- a `hint`, which is the literal next command or edit;
- a machine-applicable `fix`;
- an `effect` stating what was and was not written;
- `retryable`;
- a `docs` page.

A test fails if any thrown code is unregistered or has no fix template and docs page. User-code stack traces are trimmed to frames in `assets/` and `lib/`. DuckDB errors are mapped to codes, with positions shifted past the header. Users never need to learn the codes; each one has `croft docs CODE`.

**The codes:**

- **Project:** `DUPLICATE_OUTPUT_COLUMN`, `DECIMAL_PRECISION_UNSUPPORTED`, `QUERY_PATH_DENIED`, `ASSET_INVALID`, `NAME_INVALID`, `NAME_RESERVED`, `NAME_CONFLICT`, `HEADER_UNKNOWN_KEY`, `SQL_SYNTAX`, `SQL_NOT_SELECT`, `SQL_NOT_ONE_STATEMENT`, `PIVOT_NEEDS_VALUES`, `CATALOG_PREFIX`, `SQL_READS_FILES`, `INPUT_NEEDS_KEY`, `UNKNOWN_TABLE`, `UNKNOWN_COLUMN`, `QUOTE_IDENTIFIER`, `UNDECLARED_INPUT`, `CYCLE`, `SCHEDULE_INVALID`, `CHECK_INVALID`, `SECRET_MISSING`, `INCREMENTAL_WITHOUT_KEY`, `CURSOR_TYPE_MISMATCH`, `ASSET_OPENS_DATABASE`, `ASSET_RENAMED`, `QUERY_NOT_SELECT`.
- **Run:** `HTTP_ERROR`, `ASSET_CODE_ERROR`, `ROW_NOT_OBJECT`, `UNSERIALIZABLE_VALUE`, `CSV_HEADER_AMBIGUOUS`, `PIN_ROUNDED`, `DDL_AFTER_DML` (an internal invariant), `KEYSET_STUCK`, `TIMEOUT`, `INTERRUPTED`, `TYPE_CONFLICT`, `TYPE_PIN_VIOLATION`, `KEY_NULL`, `CHECK_FAILED`, `SHRINK_GUARD`, `INGEST_CONFIG_CHANGED`, `PIN_CHANGES_DATA`, `UNKNOWN_INPUT_COLUMN`, `BACKFILL_UNSUPPORTED`, `BACKFILL_WOULD_DUPLICATE`, `LARGE_REPROCESS`.
- **Coordination:** `DB_BUSY`, `DB_HELD_BY_OTHER_PROGRAM`, `ASSET_BUSY`, `SCHEDULE_HELD`.
- **Safety:** `CONFIRMATION_REQUIRED`, `CONFIRMATION_STALE`, `REQUIRES_HUMAN`.
- **Environment:** `BUN_TOO_OLD`, `NEEDS_BUN`, `DUCKDB_BINDING_MISSING`, `DUCKDB_BINDING_LOAD`, `DB_NEWER_FORMAT`, `CLAUDE_FILES_OUTDATED`, `SCHEDULER_STALE`.
- **Warnings and info:** `ENV_FILE_IGNORED`, `TABLE_MODIFIED_OUTSIDE_CROFT`, `VOLATILE_SQL`, `MIXED_TYPES`, `NULL_ONLY_COLUMN`, `UNSAFE_INTEGER`, `SINCE_IGNORED`, `EMPTY_EXTRACT`, `TYPE_WIDENED`, `COLUMN_STOPPED_ARRIVING`, `JSON_KIND_CHANGED`, `CSV_ENCODING_GUESSED`, `AMBIGUOUS_DATE_FORMAT`, `MIXED_DATE_FORMATS`, `DUPLICATE_ROWS_ACROSS_FILES`, `TRANSFORM_MAKES_REQUESTS`, `SHRINK_GUARD_DISABLED`, `INPUT_NOT_BUILT`, `EDITED_SINCE_LAST_RUN`, `ORPHAN_TABLE`, `OUT_OF_BAND_CHANGE`.

**5. Introspection commands:**

- `context`, `status`, `describe` (columns, JSON keys, behavior in words, cursor, samples);
- `run --dry-run` (actions, reasons, windows, confirmations);
- `validate` (with output columns), `preview` (including `--rebuild` for drift);
- `logs` (`--failed`, `--runs`), `secrets`, `doctor`, `docs internals`.

**6. Protecting the agent's context window:**

- Row caps (50 in `query`; 3 samples in check failures, 20 in `--json`).
- Values cut to 80 characters.
- Logs default to the last 200 lines.
- `context` capped at 20 KB.
- Every `.env` value redacted from all output and logs.

**7. What `init` deliberately does not write.** It does not write `.claude/settings.json`. Permission rules and hooks change what Claude Code may do without asking, so they stay the user's decision (D27).

- `croft docs claude-permissions` prints a suggested snippet: `"ask": ["Bash(croft confirm:*)"]`, and a deny rule for reading `.env`. Because every destructive action funnels into `croft confirm`, that one prefix rule gates all of them.
- `croft init --claude --with-hook` opts into a PostToolUse hook that runs `croft validate --hook` on edits under `assets/`. The hook's exit-code semantics are [U].

**8. Secrets.** croft loads secrets itself; Bun's automatic `.env` loading is off (`bun --no-env-file`) [V]. Bun's loading depends on the working directory, so a scheduled tick started from `/` would see no secrets. It also silently lets `.env.local` override `.env`. The rules:

- croft reads `<project>/.env`. Shell environment variables take precedence over it, and `croft secrets` shows where each value came from.
- `.env.local` and `.env.*` are ignored, with the `doctor` warning `ENV_FILE_IGNORED`.
- Only declared names reach code, through `ctx.secret()`. They are not placed in `process.env`.
- `croft secrets set` writes `.env` with mode 0600.

**Secrets without a TTY.** Inside Claude Code the user usually has no interactive terminal, so the primary instruction is "open `.env` in your editor and add `STRIPE_KEY=…`".

- `croft secrets set NAME` is a convenience: a hidden prompt on a TTY, or `--stdin` for piping from a password manager.
- Off a TTY without `--stdin`, it exits 5 with `REQUIRES_HUMAN`.
- `croft secrets --json` returns `[{name, status: "set"|"missing", source: ".env"|"env", usedBy}]`, so the agent can confirm a secret exists without reading it.

Declaring `secrets` drives `doctor`, `validate`, error messages and what `ctx.secret()` returns. It is not a hard isolation boundary, because asset code could still read the file. That is why every value in `.env` is redacted from all output, not only declared ones. SQL cannot read `.env`: the sandbox blocks `read_text('.env')` [V].

---

## 10. Implementation layout

**One package**, `croft`, with bin `croft` → `src/cli/main.ts`. Its exports:

- `.` → `src/index.ts`
- `./read` → `dist/read.js` + `dist/read.d.ts`, built from `src/read.ts` with `bun build --target node` at publish time

**Dependencies:**

- **Runtime:** only `@duckdb/node-api`, pinned exactly, because both the storage format and the AST shape depend on its version.
- **Everything else is a Bun built-in:** `bun:sqlite`, `Bun.Glob`, `Bun.file`/`Bun.write`, `Bun.hash`/`Bun.CryptoHasher`, `Bun.build` (fingerprints), `fetch`, `node:util` `parseArgs`, `node:child_process` (detached runs, notifications), `node:fs` `copyFile` with `COPYFILE_FICLONE` (read copy, trash), and `Bun.serve` (test mocks).
- **No CLI framework and no schema library.** Validators are hand-written so their errors read well.

```
src/
  index.ts             ingest(), transform(), fail(), public types       read.ts   croft/read (built to dist/)
  cli/                 main.ts (launcher delegation, parseArgs), render.ts (human/JSON, truncation, offsets),
                       detach.ts (non-TTY detach + follow), commands/*.ts
  core/                errors.ts (CroftError, code registry, fix templates, exit codes), types.ts, time.ts
  project/             root.ts (croft.json, .env, relocation), init.ts (empty folder, existing repo → data/),
                       discover.ts (names), ts-asset.ts (isolated import, config validation, Bun.build fingerprint,
                       import scan for ASSET_OPENS_DATABASE), sql-asset.ts (header, AST deps, fingerprint,
                       reserved columns), graph.ts
  sql/                 ast.ts (serialize, walk, CTE scopes, catalog prefixes, file refs, volatile functions),
                       deps.ts (AST ∪ unoptimized-plan scans), gate.ts (extractStatements + serialize: one SELECT),
                       bind.ts (shadow catalog, prepare, error → code mapping), connect.ts (factory: time zone + sandbox)
  db/                  warehouse.ts (fromCache registry, one mode per process, leases with boot id, lock retry,
                       holder lookup), state.ts (_croft DDL + migrations), values.ts (DuckDB → JS, round-trip safe),
                       readcopy.ts (checkpoint + child-process clone + rename)
  load/                stage.ts (NDJSON parts, canonical + lossless JSON), classify.ts (json_type + regex kinds),
                       types.ts (type rules, name-typed placeholders, CSV money/date formats), cast.ts (whitelist,
                       round-trip loss check), evolve.ts (ALTERs), write.ts (diff-replace, append, merge, dedupe),
                       files.ts (globs, union_by_name, encoding fallback, URLs, conditional GET, _croft.files)
  run/                 plan.ts (staleness, due, reasons, dry-run), runner.ts (concurrency, retries, timeouts,
                       leases, signals), ingest.ts, sql.ts (temp-view wrapper, rebuild + diff), transform.ts (ordered
                       Parquet snapshots, proxy rows, composite positions, chunked commits, cost guard), context.ts,
                       backfill.ts (--from matrix), preview.ts (snapshots, preview db, partial diffs)
  checks/              parse.ts (check language → validated SQL), run.ts
  http/                http.ts (retries, Retry-After, Link, lossless JSON, redaction)
  schedule/            phrase.ts (English → cron), cron.ts (DST-defined matcher), register.ts (launchd, crontab),
                       tick.ts (per-user registry, per-project plan-and-spawn, singleton, heartbeats), notify.ts
  history/             runs-db.ts (bun:sqlite), reconcile.ts, logs.ts
  safety/              trash.ts (ATTACH-based trash/restore), confirm.ts (tokens, impact hash), guards.ts (shrink,
                       config change, pin change, hold), rename.ts, delete.ts, oob.ts (out-of-band detection)
  agent/               templates/* (api by pagination, file, sql, transform), skill.md, claude-md.md,
                       docs/*.md (one page per topic and per error code; embedded; served by `croft docs`)
```

### Public types

```ts
export type Row = Record<string, unknown>;
export type ColumnType = "BOOLEAN" | "BIGINT" | "HUGEINT" | "DOUBLE" | "VARCHAR" | "DATE" | "TIMESTAMP"
  | "TIMESTAMPTZ" | "JSON" | `DECIMAL(${number},${number})` | (string & {});
export type ColumnPin = ColumnType | { type: ColumnType; format?: string };   // format: strptime pattern
export type RowSource = AsyncIterable<Row | Row[]> | Iterable<Row | Row[]> | Promise<Row[]>;
export type FileFormat = "csv" | "tsv" | "json" | "ndjson" | "parquet";

interface Common {
  description?: string;
  key?: string | string[];
  write?: "replace" | "append" | "merge";    // override the inferred behavior
  checks?: string[];                         // blocking: "unique(id)", "not_null(a, b)", "min_rows(10)", "amount >= 0"
  warnings?: string[];                       // non-blocking, same language
  columns?: Record<string, ColumnPin>;
  secrets?: string[];
  retries?: number;                          // default 2 for TS code
  timeout?: string;                          // no-progress timeout, default "10m"
}
export interface CursorSpec {
  field: string;
  unit?: "s" | "ms";                         // integer cursors holding epoch time
  lookback?: string;                         // "10 minutes", "30 days"
}
interface IngestBase extends Common {
  schedule?: string;                         // "every hour" | "daily at 06:00" | 5-field cron (ingests only)
  allowShrink?: boolean;
}
export interface RowsIngest extends IngestBase {
  rows(ctx: IngestContext): RowSource;
  incremental?: string | CursorSpec;
  file?: never; map?: never;
}
export interface FileIngest extends IngestBase {
  file: string | string[];                   // path, glob or URL
  format?: FileFormat;
  csv?: { delimiter?: string; header?: boolean; skip?: number; encoding?: "utf-8" | "latin-1" | "utf-16" };
  incremental?: boolean;                     // only new or changed files
  map?(row: Row): Row | null;                // clean values; null drops the row
  rows?: never;
}
export interface TransformConfig extends Common {
  inputs: string[];                          // assets this code reads
  incremental?: boolean;                     // newRows() + merge instead of replace; chunked commits (§3e)
  confirmAbove?: number;                     // cost guard threshold, default 1000 input rows (§5)
  rows(ctx: TransformContext): RowSource;
}

interface BaseContext {
  readonly asset: string;
  readonly runId: string;
  readonly preview: boolean;                 // true under `croft preview` (rows capped, nothing saved)
  readonly signal: AbortSignal;              // timeout, Ctrl-C/SIGTERM, preview row cap
  readonly http: Http;
  secret(name: string): string;              // declared names only; throws SECRET_MISSING
  log(...args: unknown[]): void;
}
export interface IngestContext extends BaseContext {
  readonly since?: string | number;          // saved cursor (minus lookback) in its own JSON type, or --from
  query<T extends Row = Row>(sql: string, ...params: unknown[]): Promise<T[]>;   // one SELECT over its own table
}
export interface TransformContext extends BaseContext {
  rows<T extends Row = Row>(input: string): AsyncIterable<T>;      // rows are Proxy-guarded (§3e)
  newRows<T extends Row = Row>(input: string): AsyncIterable<T>;
  query<T extends Row = Row>(sql: string, ...params: unknown[]): Promise<T[]>;   // one SELECT over inputs
}
export interface HttpInit {
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | null | undefined>;   // null/undefined omitted
  retries?: number; timeoutMs?: number;
}
export interface HttpResponse {
  status: number; url: string; headers: Headers; text: string;
  json<T = unknown>(): T;                    // lossless: unsafe integers → bigint
  next?: string;                             // rel="next" from the Link header
}
export interface Http {
  get(url: string, init?: HttpInit): Promise<HttpResponse>;
  post(url: string, body: unknown, init?: HttpInit): Promise<HttpResponse>;
}
export interface AssetDefinition { readonly __croft: "ingest" | "transform"; readonly config: RowsIngest | FileIngest | TransformConfig }
export declare function ingest(config: RowsIngest | FileIngest): AssetDefinition;
export declare function transform(config: TransformConfig): AssetDefinition;
export declare function fail(code: "KEYSET_STUCK" | (string & {}), message: string): never;
```

`croft/read`:

```ts
export interface ReadOptions { project?: string; timeoutMs?: number }
export declare function query<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string, params?: unknown[], options?: ReadOptions): Promise<T[]>;
```

### Internal types

```ts
export type AssetKind = "ingest" | "sql" | "ts";
export type WriteMode = "replace" | "append" | "merge";
export type CursorType = "timestamp" | "date" | "integer" | "string";
export type Incremental =
  | { kind: "none" }
  | { kind: "cursor"; field: string; unit?: "s" | "ms"; lookbackMs: number }
  | { kind: "files" }
  | { kind: "new-rows"; inputs: string[] };                  // TS newRows()
export interface Check { source: string; kind: "unique" | "not_null" | "min_rows" | "rule";
  blocking: boolean; scope: "batch" | "table"; sql: string; reads: string[] }
export interface ResolvedAsset {
  name: string; file: string; kind: AssetKind;
  inputs: string[];                                          // from the AST or `inputs`
  orderAfter: string[];                                      // inputs + tables read by its checks
  write: WriteMode; key: string[]; incremental: Incremental;
  schedule?: { text: string; cron: string };                 // ingests only
  checks: Check[]; pins: Record<string, { type: string; format?: string }>;
  codeHash: string; behaviorHash: string;                    // codeHash includes the project time zone
  sql?: { body: string; headerLines: number };
  usesHttp?: boolean;                                        // TS: for TRANSFORM_MAKES_REQUESTS / cost guard
  definition?: AssetDefinition;
}
export type Reason = "requested" | "schedule_due" | "never_built" | "code_changed" | "input_changed"
  | "input_replaced" | "rebuild" | "backfill";
export type Hold = "code_not_run_by_hand" | "large_reprocess" | "paused" | "leased";
export interface PlanStep { asset: string; action: "fetch" | "rebuild" | "update" | "skip";
  reasons: Reason[]; hold?: Hold; window?: { sinceValue: string | number; sinceType: CursorType };
  confirmation?: Impact }
export type SchemaChange =
  | { kind: "add_column"; column: string; type: string }
  | { kind: "widen"; column: string; from: string; to: string }
  | { kind: "retype_pending"; column: string; to: string }
  | { kind: "recreate"; reason: "shape_changed" };
export type ValueKind = "null" | "boolean" | "integer" | "bigint" | "float" | "iso_instant" | "iso_naive"
  | "iso_date" | "string" | "object" | "array";
export interface ColumnPlan { column: string; sourceName: string; existing: string | null; incoming: ValueKind[];
  decision: "keep" | "add" | "widen" | "cast" | "retype_pending" | "conflict"; target?: string;
  badRows?: number; samples?: unknown[] }
export interface StageManifest { runId: string; asset: string; parts: { path: string; rows: number }[];
  topLevelKeys: string[]; rows: number; sinceUsed?: string | number; complete: true }
export interface StepResult {
  asset: string; status: "ok" | "failed" | "skipped" | "unchanged"; reason: string; skippedBecause?: string;
  behavior: string; attempt: number; maxAttempts: number; nextRetryAt?: string;
  rows: { in: number; added: number; updated: number; unchanged: number; deleted: number; total: number };
  schemaChanges: SchemaChange[]; cursor?: { before?: string; after?: string; sinceUsed?: string };
  inputs?: { input: string; seenBefore: string | null; seenAfter: string; rows: number }[];
  requests?: number; checks: { check: string; ok: boolean; failing?: number; sample?: Row[] }[];
  trashed?: { path: string; rows: number }; logsCommand: string; durationMs: number; error?: Problem;
}
export type Fix =
  | { kind: "edit"; description: string; file: string; line?: number; replace?: { from: string; to: string }; insert?: string }
  | { kind: "command"; description: string; command: string; requiresHuman?: boolean }
  | { kind: "manual"; description: string; requiresHuman?: boolean };
export interface Problem {
  severity: "error" | "warning" | "info"; code: string; message: string; hint: string; docs: string;
  asset?: string; file?: string; line?: number; column?: number; runId?: string;
  fix?: Fix; effect?: string; retryable?: boolean; details?: Record<string, unknown>;
}
export interface Impact { asset: string; action: string; rows: number; bytes?: number; trashPath?: string;
  downstream: string[]; estimatedRequests?: number }
export interface Confirmation { token: string; expiresAt: string; command: string; impact: Impact }
export interface Envelope<T> { schemaVersion: 1; ok: boolean; command: string; croftVersion: string;
  database: string; timezone: string; durationMs: number; data: T; problems: Problem[];
  next: { command: string; reason: string }[]; confirmation?: Confirmation }
export interface LockHolder { pid: number | null; program: string | null; runId?: string; asset?: string;
  action?: string; since?: string }
export interface Sql { all<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string, params?: unknown[]): Promise<void> }   // always prepare(): one statement per call
export interface Warehouse {
  read<T>(fn: (db: Sql) => Promise<T>, o?: { waitMs?: number; purpose: string }): Promise<T>;
  write<T>(label: string, fn: (tx: Sql) => Promise<T>, o?: { waitMs?: number; runId: string; asset?: string }): Promise<T>;
  holder(): Promise<LockHolder | null>;
}
```

### Test strategy (`bun test`)

1. **Unit tests, no DuckDB:**
   - Phrase → cron, and the tz-aware matcher across DST in several zones.
   - The check language → SQL, and header parsing with did-you-mean.
   - Name cleanup, including keywords and collapsing.
   - The lossless JSON reader and writer at the 2^53, int64 and uint64 edges, and canonical key order.
   - Link parsing, relative `--from` parsing, selectors.
   - The staleness planner, holds and confirmation-token staleness over fake state.
2. **DuckDB `:memory:` tests** (about 4 ms per instance):
   - Dependency extraction: a golden corpus with CTEs, CTE shadowing, subqueries, UNION, catalog prefixes, quoted file paths, `query_table()`, `query()`, table macros, PIVOT with and without IN, lambdas, QUALIFY, trailing `;` and `--`, and two-statement input. The AST and the unoptimized plan are compared on every case.
   - Fingerprint stability under formatting and case.
   - The type matrix: existing type × incoming kind → decision, including the whitelist and round-trip loss cases (`+02:00` → TIMESTAMP, `1.5` → BIGINT, `'02134'` → BIGINT).
   - Every write mode, including diff-replace, merge dedupe and unchanged-row skipping with reordered JSON keys.
   - The DDL-before-DML invariant (file reload with a widen).
   - Composite `newRows()` positions across equal stamps, and chunk resume after a kill mid-chunk.
   - Round trips of TS values: naive and zoned timestamps with microseconds, HUGEINT through a snapshot.
   - Reserved-column exclusion for `SELECT *` over every asset kind.
   - Check rollback; trash and restore.
   - The sandbox: `COPY TO` the warehouse, `DETACH`/`ATTACH`, reading outside allowed directories, and re-enabling settings, all refused.
   - The single-instance registry.
   - One scenario test per silent-loss hazard: implicit rounding, dropped struct field, MERGE duplicates, sniffer date flip, union-by-name column drop, JSON kind change.
3. **End-to-end fixture projects** driven by spawning the real CLI. A `Bun.serve` mock API covers:
   - ascending keyset, newest-first `starting_after`, and Link pagination;
   - epoch cursors;
   - 429 with `Retry-After`, and flaky 500s;
   - an empty page as if auth failed;
   - type drift between pages, and big integers.

   Every `--json` output is golden-tested against its JSON Schema.
4. **Concurrency:** a run plus a query; a foreign read-only holder; two runs on one asset; a tick overlapping a manual run; a detached run followed by `wait`.
5. **Crash tests.** `CROFT_FAULT=after_stage|before_commit|after_commit_before_sqlite|between_trash_and_drop` makes the child `SIGKILL` itself. The parent then asserts that data and state agree, the cursor is at most the committed maximum, and the next run succeeds.
6. **Scheduler tests** with a fake clock (`CROFT_NOW`) and a fake `HOME`. They check plist and crontab generation, registry pruning, heartbeat verification, the tick singleton, holds, stale-transform pickup, and DST golden days (2026-03-08 and 2026-11-01 in several zones). Real OS registration is exercised in a phase-3 spike and in manual release checks, because CI cannot install launchd jobs.
7. **`croft/read` under Node** (current LTS) in CI, including the Next.js `serverExternalPackages` setup.
8. **CI matrix.** macOS arm64, Linux x64 glibc and Linux arm64 are tier 1, each on the Bun floor (1.3.14) and `bun@latest`. Alpine and Windows get smoke tests.
9. **Agent evals** from phase 2 onward. Headless Claude Code sessions run fixture tasks:
   - "add Stripe charges and daily revenue, schedule hourly";
   - "the pipeline failed last night, fix it";
   - "rename a column used downstream";
   - "backfill 90 days";
   - "why is this number wrong";
   - "the API changed a field type".

   They are scored on success, number of commands, and whether the agent ever ran `croft confirm` without asking. Every stumble becomes a hint, a doc page or a template.

---

## 11. v1 scope, cut list, and phased build order

### Cut from v1

Each item is marked with where it goes instead, if anywhere.

- **Incremental SQL** (`new.<table>`). It is designed and verified, and it is post-v1 #1.
- **`--to`/`--step` windowed backfills.** `--from` on merge ingests covers the need.
- **Schedules on transforms.** Transforms follow their inputs.
- **Windows scheduler registration.** Windows uses `croft schedule start` or a documented Task Scheduler entry.
- **File reads inside SQL assets** (`SQL_READS_FILES`). Files come in through file ingests.
- **Named or virtual environments,** fingerprinted physical tables, plan/apply promotion, `copy` and `--database`.
- **The daemon,** server mode, remote execution, multiple projects per database.
- **Child tables, native STRUCT typing and flattening** of nested data. JSON columns are used instead.
- **SQL time windows and partitions** as concepts; view-kind SQL models; SQL macros and templating.
- **Standalone check files** (`checks/*.sql`). Row rules with subqueries cover most cases.
- **`query --write`.** `delete --where` and fixing the asset cover the need.
- **Exports:** `croft export`, and deploying data with a hosted app.
- **`croft refs`** (column reference search). `rename` lists references, and `validate` plus the Proxy guard catch breakage.
- **Modeling features:** SCD2 history, delete propagation from sources, column lineage, SQL unit tests with fixtures, and quarantine of bad rows.
- **Source frameworks:** a declarative REST source DSL, and database sources as a feature. A Postgres ingest via `Bun.sql` is a doc recipe.
- **Scale and platform:** parallel SQL execution; OS keychain secrets; sensors and freshness policies; xlsx (needs a downloaded extension); a compiled single binary (works only with a dylib-embedding workaround [V]); tier-1 Windows.
- **Excluded by requirement:** a web UI, and dlt/SQLMesh/Dagster compatibility.

### Phases

Each phase is usable end to end, and each ships `--json`, error codes, docs pages and skill updates for what it adds. Estimates assume one engineer directing Claude Code. They were revised upward after the technical review, which judged the transform and scheduling estimates about 2× optimistic.

| Phase | Ships | Usable result | Effort |
|---|---|---|---|
| **1. Load and look** | launcher; `init` (empty folder and existing repo), relocation off synced folders; `doctor`; `docs`; skill and CLAUDE.md; `ingest()` for rows and files/URLs (`union_by_name`, encoding fallback, `map`); staging, classification, type rules, whitelisted casts, round-trip loss check, evolution (DDL before DML), JSON columns; replace (as a diff), append and merge with dedupe; typed cursors and lookback; the shrink guard with minimal trash and confirmation tokens; connection factory, sandbox and single-SELECT gate; `fromCache` instance registry; leases (with boot id) and lock diagnostics; `reconcile`; `run` (detach off a TTY, `wait`, signals), `query`, `status`, `describe`, `context`, `logs`, `secrets`; read copy (child-process clone) and `croft/read` (built JS) | Claude pulls an API or a folder of CSVs into DuckDB incrementally, answers questions from it, and an app reads it | ~3.5 weeks |
| **2. Transform and trust** | SQL assets (single-statement check, temp-view wrapper, reserved columns, PIVOT, catalog and file-read errors, `VOLATILE_SQL`); dependencies from AST + unoptimized plan; graph, staleness and fingerprints; bind check (`INPUT_NOT_BUILT`, `NULL_ONLY_COLUMN`, `QUOTE_IDENTIFIER`); TS transforms (full and incremental, ordered Parquet snapshots, round-trip value types, Proxy rows, composite positions, chunked commits, cost guard); checks and warnings in the write transaction; `preview` (snapshots, partial diffs, `--rebuild`); `run --dry-run` | raw → clean → report tables that cannot receive bad data, and per-row LLM transforms that survive failures without re-billing | ~4 weeks |
| **3. Keep it fresh** | gate: a spike on launchd and crontab registration; schedule phrases and the DST-defined matcher; per-user job, registry and heartbeats; `croft tick` (plan-and-spawn, singleton); holds, `pause`, stale-transform pickup; retries, no-progress timeouts, catch-up once, skip on overlap; desktop and webhook notifications; `schedule start` | hands-off hourly pipeline that survives sleep, crashes and reboots, and never runs half-finished edits | ~2.5 weeks |
| **4. Grow safely** | monotone partial commits for cursor ingests (resumable first loads); full trash, `restore` and `delete` (whole table and `--where`); `--rebuild` rules; `--from` backfill matrix; `INGEST_CONFIG_CHANGED` and key conversion; `PIN_CHANGES_DATA`; `rename` and `ASSET_RENAMED`; drift warnings; `OUT_OF_BAND_CHANGE`; pre-upgrade backups; `EMPTY_EXTRACT` | long-lived sources and paid transforms change shape without refetching or losing data | ~2 weeks |
| **5. Agent-grade release** | all templates (every pagination style), a docs page per code, JSON Schemas and golden tests, generated input types (`.croft/types`, so `validate --types` catches renames in TS), agent evals in CI, CI matrix (Bun floor and latest), opt-in hook, npm 0.1 | Claude Code operates a project from a cold start, measured by evals | ~1.5 weeks |

The total is about 13.5 engineer-weeks and roughly 13–15k lines. If that is too long, phases 1 and 2 (about 7.5 weeks) are a coherent first release: load, look, transform and trust, with manual or `schedule start` runs.

**Post-v1 candidates, in order:**

1. Incremental SQL (`new.<table>`), with pre-images of updated and deleted rows.
2. `croft refs`.
3. `croft export`, plus a story for hosted apps.
4. `partial: true` merges for APIs that send only changed fields.
5. Opt-in typed nested columns.
6. SQL time windows.
7. Keychain secrets.
8. SCD2.
9. Table-level check queries.
10. Native Windows.

---

## 12. Top risks and mitigations

| Risk | Mitigation |
|---|---|
| The user's app or a SQL GUI holds the live file and blocks writes | the read copy is on by default; `croft/read` reads only the copy; lock errors name the program and PID and point GUIs at the copy; `doctor` shows the holder |
| A long write step blocks other commands | the lock is held per write step only; extraction and TS code run lock-free; `status`/`context`/`validate` never touch DuckDB; off a TTY, waits cap at 90 s and name the holder |
| The agent's shell timeout kills long runs | off a TTY, runs always detach and return exit 6 with a run id; `wait`; `status.running[]` |
| AI-edited code runs unattended on real data | the scheduler hold (only code a human has run); per-file import isolation; checks inside the transaction; trash |
| AI-written SQL or tools overwrite the database | sandboxed connections (external access locked, allowed directories only); single-SELECT gate; the asset import scan; out-of-band detection |
| Paid per-row transforms run up bills | incremental template by default; the cost guard (`LARGE_REPROCESS`); preview caps input rows; unchanged rows keep `_loaded_at` through diff writes; `TRANSFORM_MAKES_REQUESTS` |
| Wrong numbers from API semantics (records that change after creation, newest-first paging, epoch cursors) | pagination-specific templates; typed cursors with `unit` and `lookback`; `KEYSET_STUCK`; the skill's API rules; `SINCE_IGNORED`, `EMPTY_EXTRACT` |
| Silent corruption through DuckDB implicit behavior (rounding casts, dropped offsets, dropped struct fields, MERGE duplicates, sniffer date flips, union-by-name drops) [V] | whitelisted casts plus a round-trip loss check; JSON staging; dedupe before merge; own CSV typing with per-column formats; `union_by_name`; one scenario test per hazard |
| Strict type conflicts stop a scheduled pipeline | preview shows conflicts before the first real load; name-typed placeholders avoid most wrong first guesses; errors state the effect and give fixes in order; notifications |
| Scheduler silently not running (privacy protection, WSL idle, moved projects, version managers) | `schedule on` waits for a real heartbeat; `SCHEDULER_STALE` reads the tick log and names a cause; the registry prunes moved projects; stable Bun path |
| Bun or DuckDB behavior changes across versions (as `Bun.cron.parse` did) | enforced Bun floor; CI on the floor and on latest; DuckDB pinned exactly; the fingerprint ignores `query_location`; format check; backup before an engine upgrade |
| Inferred write behavior surprises (forgot `key`) | behavior stated in words everywhere; `INCREMENTAL_WITHOUT_KEY` is an error; a key implies uniqueness checks |
| Synced folders corrupt the database | automatic relocation to `~/.local/share/croft/…` |
| Agent runs destructive commands casually | trash for every destructive action; `croft confirm` tokens with recomputed impact; one `ask` rule gates all of them; destructive commands never in `next`; skill rules; evals |
| Missed dependencies make tables silently stale (`query_table`, `query()`, macros) [V] | dependencies are the union of the AST and the unoptimized bound plan; a golden corpus compares both |
| Long paid transforms never finish, or re-bill after a failure | chunked commits with composite positions; staged-chunk reuse on retry; no-progress timeouts |
| DST drops or doubles scheduled runs [V] | fire times defined as instants; golden DST tests |
| Estimates slip (the technical review judged the first plan ~2× optimistic) | re-estimated phases; phases 1–2 are a coherent first release; the phase-3 registration spike gates the rest of scheduling |
| Scope creep toward matching Dagster, dlt and SQLMesh | fixed 7-concept vocabulary; explicit cut list; each phase gated on agent evals |

---

## 13. Decision log

Each entry gives the options, the choice and the reason. **(rev)** marks decisions changed or extended after the adversarial reviews.

**D1. Daemon or per-step open.**
- Options: a `Bun.serve` daemon owning the file; short-lived processes opening the file per step.
- Choice: per step; there is no daemon.
- Reason: open plus close costs 3–6 ms [V]. A daemon would run stale code after edits, add an IPC path to debug, and keep the file locked away from users' own tools.

**D2. Table naming.**
- Options: folder = schema; flat names in `main`.
- Choice: flat.
- Reason: `FROM github_issues` works everywhere, in apps too, and subfolders still organize.

**D3. Config file.**
- Options: `croft.config.ts`; `croft.json`.
- Choice: `croft.json` with a JSON Schema.
- Reason: config is data. It cannot fail to import, and the launcher and tick read it without executing user code.

**D4. Asset API.**
- Options: one `asset()`; `ingest()`/`transform()` plus `.sql`; file suffixes.
- Choice: `ingest()`, `transform()` and `.sql` files.
- Reason: the precious-versus-rebuildable split drives the safety rules, and two functions let TypeScript enforce which options apply.

**D5. SQL header.**
- Options: a YAML comment block; `-- name: value` lines.
- Choice: line comments.
- Reason: there are only five keys, and repeatable `check` lines read naturally.

**D6. Write behavior. (rev)**
- Options: an explicit mode everywhere; inferred from key and incremental.
- Choice: inferred, with an optional `write` override. An incremental API ingest without a key is an error unless `write: "append"` is explicit.
- Reason: this is one fewer thing to learn, and the one inference that silently duplicates rows now has to be stated on purpose.

**D7. SQL incrementality. (rev)**
- Options: `$start/$end` time intervals; `new.<table>` views; none in v1.
- Choice: none in v1. SQL transforms are rebuilt in full and written as a diff.
- Reason: local rebuilds take seconds. Full recompute is always correct. `new.<table>` went silently stale in common cases [V]: a joined input read without `new.`, a row that moved between groups, deleted rows, and keyless appends over updated inputs. Two reviewers independently recommended the cut. `new.<table>` returns post-v1 only with pre-images of updated and deleted rows.

**D8. Environments. (rev)**
- Options: SQLMesh-style view environments; blue-green physical tables; file-clone dev copies (`copy` + `--database`); preview only.
- Choice: preview, all-or-nothing writes, trash and the scheduler hold.
- Reason: promotion machinery adds concepts and states an agent can corrupt. The file-clone escape hatch shared `.croft/` state with the real warehouse (leases, catalog, trash), so it was cut rather than patched.

**D9. What the scheduler runs. (rev)**
- Options: published snapshots of the last manual run; the working tree; the working tree gated by a human run.
- Choice: the working tree, but only assets whose current code a human has run successfully (`SCHEDULE_HELD`).
- Reason: snapshots create a second source of truth. An ungated working tree would let debugging edits (fixtures, temporary filters) merge into real data at the next tick.

**D10. Guarding destructive operations. (rev)**
- Options: a trailing `--yes`; a human-only `approve`; `croft confirm <token>`.
- Choice: tokens. Off a TTY, a destructive command exits 5 with its impact and a token, and `croft confirm` recomputes the impact before acting. On a TTY, a y/N prompt.
- Reason: consent is tied to the impact that was shown, stale impacts are refused, and one Claude Code prefix rule (`Bash(croft confirm:*)`) gates every destructive path. A trailing flag cannot be targeted reliably.

**D11. Trash format.**
- Options: Parquet; `ALTER … SET SCHEMA` (not implemented [V]); a file clone; an attached `.duckdb` per trashed item.
- Choice: an attached `.duckdb`.
- Reason: it is lossless for every type, 1 ms for small tables, and restorable in one transaction [V].

**D12. Nested data.**
- Options: JSON columns; native STRUCT/LIST; `a__b` flattening; child tables.
- Choice: JSON columns, plus `JSON_KIND_CHANGED` detection.
- Reason: no schema churn and no nested type conflicts. STRUCT silently drops new fields [V], flattening multiplies conflicts, and child tables force joins.

**D13. Type inference.**
- Options: DuckDB's `read_json` sniffing; JSON staging plus croft's rules.
- Choice: JSON staging plus rules.
- Reason: the sniffer's result depends on the batch [V].

**D14. CSV typing. (rev)**
- Options: DuckDB's sniffer; `all_varchar` plus croft's rules.
- Choice: `all_varchar` plus rules, with `union_by_name`, UTF-8 then latin-1 fallback, money parsing, and a date format decided once per column.
- Reason: the sniffer flips date order [V]; globs without `union_by_name` drop late columns [V]; Excel exports are often latin-1 [V].

**D15. Type conflicts. (rev)**
- Options: widen to VARCHAR automatically; fail; quarantine.
- Choice: fail, with fixes ordered clean → pin with format → pin VARCHAR. Implicit casts are whitelisted to "same kind, other format" and verified by a round-trip loss check.
- Reason: DuckDB casts drop offsets and round fractions without producing NULLs [V], so a NULL-based loss check was not enough.

**D16. All-NULL columns. (rev)**
- Options: create later; a VARCHAR placeholder; a placeholder typed from the name.
- Choice: typed from the name (`*_at` → TIMESTAMPTZ, …), marked pending.
- Reason: VARCHAR placeholders break `date_diff`, comparisons and `COALESCE` [V]. Pending columns can be retyped freely.

**D17. Column names. (rev)**
- Options: snake_case everything; keep as written.
- Choice: keep, with minimal cleanup (collapsing `_` runs). Keywords are kept and quoted, with `QUOTE_IDENTIFIER` help.
- Reason: SQL matches the API docs the agent reads.

**D18. Session time zone. (rev)**
- Options: UTC; the project time zone.
- Choice: the project time zone. JSON renders timestamps with the project offset.
- Reason: `::DATE` gives the user's days [V]. UTC JSON output made correct day buckets look wrong to an agent.

**D19. Cursor value. (rev)**
- Options: the JS maximum of strings; a typed maximum in DuckDB.
- Choice: the typed maximum, stored as the original text, never regressing. The cursor type (timestamp, date, integer with unit, string) is fixed on the first load, and `since`, lookback and `--from` are rendered in that type.
- Reason: this orders correctly across offsets, hands the API back exactly what it sent, and keeps epoch-second APIs from receiving ISO strings.

**D20. Pagination. (rev)**
- Options: `http.paginate` presets; plain `get` plus templates.
- Choice: plain `get`, with `croft new api --pagination keyset|cursor|link|page` and `KEYSET_STUCK`.
- Reason: one obvious loop per API style. Keyset is safe only for ascending sorts [V].

**D21. Big integers.**
- Options: exact strings; `JSON.rawJSON` objects; `bigint`.
- Choice: `bigint` in user code, raw digits in NDJSON [V].

**D22. Code-change policy. (rev)**
- Choice: SQL and full-refresh TS transforms rebuild; incremental TS transforms are forward-only, with an offered `--rebuild`; ingests never refetch. Now enforced by the cost guard (`LARGE_REPROCESS`) and diff writes that keep `_loaded_at` for unchanged rows.
- Reason: rebuild when it is free and deterministic; never spend the user's API money implicitly.

**D23. TS fingerprint.**
- Choice: a `Bun.build` bundle hash with identifier minification off [V].

**D24. Cron evaluation. (rev)**
- Choice: croft's own matcher.
- Reason: `Bun.cron.parse` behaves differently on 1.3.14 and 1.4.2 [V].

**D25. Run concurrency.**
- Options: one project lock; per-asset leases.
- Choice: leases.
- Reason: a long scheduled load must not block unrelated work.

**D26. Secrets. (rev)**
- Options: OS keychain; `.env` via Bun's automatic loading; `.env` parsed by croft.
- Choice: `.env` parsed by croft, with Bun's loading off (`--no-env-file` [V]). Only declared names reach `ctx.secret()`; every `.env` value is redacted. "Edit `.env`" is the primary instruction, and `secrets set` (with `--stdin`) is a convenience.
- Reason: Bun's loading depends on the working directory (scheduled ticks saw no secrets) and silently prefers `.env.local`. `.env` works everywhere, including under Claude Code, where the user has no TTY.

**D27. Claude Code settings.**
- Options: `init` writes permission rules and hooks; `init` writes neither.
- Choice: neither. `croft docs claude-permissions` prints the suggested `ask` rule, and the hook is opt-in.
- Reason: settings that change what the agent may do belong to the user.

**D28. Validation naming.**
- Choice: `validate` for the project, after every edit; `doctor` for the environment plus a summary.

**D29. Check syntax. (rev)**
- Choice: one string language shared by TS and SQL, where each check is parsed as a single expression and executed through `prepare()`.
- Reason: interpolating check text into a multi-statement call executed an embedded `DROP TABLE` [V].

**D30. Merge implementation.**
- Choice: always deduplicate first, and put no constraints on user tables.
- Reason: MERGE mishandles duplicate source keys both ways [V].

**D31. Emptiness guard. (rev)**
- Choice: `SHRINK_GUARD` above 50% loss for ingests. Its override is a destructive operation (trash + confirmation), and its fix requires a human.
- Reason: the override was the one path that wiped irreplaceable data without the trash.

**D32. App access. (rev)**
- Options: an open-per-query helper on the live file; a read copy.
- Choice: a read copy by default, and `croft/read` reads only the copy. It ships as built JS.
- Reason: readers on the live file delay writers [V]; GUIs left open block everything; Node cannot import TS from `node_modules` [V].

**D33. Long runs. (rev)**
- Options: rely on the agent to background runs; `--background` plus `wait`; auto-detach off a TTY.
- Choice: auto-detach off a TTY, with `--follow 100s`, then exit 6 with a run id.
- Reason: an agent cannot know in advance that a first load takes 30 minutes. A killed foreground run loses everything.

**D34. Launcher.**
- Choice: a global shim delegating to the project-pinned version; `bunx` still works.

**D35. Platforms. (rev)**
- Choice: tier 1 is macOS and Linux glibc; musl and Windows are tier 2. The Bun floor is 1.3.14, the verified version, with CI on the floor and on latest.
- Reason: `Bun.cron` did not exist before 1.3.11, and parse behavior changed after 1.3.14 [V], so "1.3 or newer" was false.

**D36. Standalone check files and notifications. (rev)**
- Choice: check files are cut (row rules with subqueries instead). Failure notifications are kept: desktop by default for scheduled runs, and an optional webhook.
- Reason: "something failed overnight" must reach a user who never reads logs.

**D37. Scheduler registration. (new)**
- Options: `Bun.cron` per project; one per-user job written by croft.
- Choice: one per-user job, a project registry and heartbeats.
- Reason: `Bun.cron` is new and version-dependent, orphans jobs when projects move, and logs where croft never looks. A heartbeat proves the job actually runs.

**D38. Replace semantics. (new)**
- Options: DELETE + INSERT; a diff (MERGE with `NOT MATCHED BY SOURCE THEN DELETE`).
- Choice: a diff.
- Reason: restamping every row on every replace would wake, and bill, every downstream incremental transform [V].

**D39. TypeScript transforms. (new)**
- Choice: the template is keyed and incremental; rows are Proxy-guarded; there is a cost guard.
- Reason: the audience's most common transform calls an LLM per row. Renamed columns must fail loudly instead of becoming NULL [V].

**D40. User SQL safety. (new)**
- Options: trust READ_ONLY; parse-gate only; sandbox only; both.
- Choice: both: a single-SELECT gate plus sandboxed instances.
- Reason: READ_ONLY still allows `COPY TO` over the warehouse [V], and the sandbox alone still allows `DETACH`/`ATTACH` of permitted paths [V].

**D41. Command surface. (new)**
- Choice: 19 commands. `plan` became `run --dry-run`; `history` became `logs --runs`; `trash` became `restore` with no arguments; `drop` became `delete`. `copy`, `--database`, `query --write` and `--step` are cut; `confirm` and `rename` are added.
- Reason: fewer commands to learn, without losing any agent-facing capability.

**D42. `init` in an existing repo. (new)**
- Choice: a `data/` subproject; never overwrite app files; exclude `data` from the app's tsconfig.
- Reason: "add pipelines to my Next.js app" is a primary journey, and clobbering `package.json` or `tsconfig.json` is unacceptable.

**D43. Synced folders. (new)**
- Options: warn; relocate automatically.
- Choice: relocate the database and `.croft/` to `~/.local/share/croft/…`.
- Reason: `~/Documents` and `~/Desktop` are commonly iCloud-synced, and asking a non-data-engineer to pick a path is not "just works".

**D44. Backfills. (new)**
- Choice: `--from` on merge ingests only, with a per-type matrix of explicit errors elsewhere; relative dates; conversion to the cursor type.
- Reason: `--from` on append or replace ingests duplicated or truncated data silently.

**D45. Dependency extraction. (new)**
- Options: AST `BASE_TABLE` nodes only; the optimized plan; AST plus the unoptimized bound plan.
- Choice: AST ∪ unoptimized plan scans. The AST also rejects catalog prefixes and file reads.
- Reason: the AST misses `query_table()`, `query()` and macros, and the optimizer prunes scans [V]. A missed dependency means silently stale tables.

**D46. Long incremental TS transforms. (new)**
- Options: one transaction per run; chunked commits.
- Choice: chunks of 500 rows or 60 s, each with its checks and a composite `(_loaded_at, key)` position; staged-chunk reuse on retry; no-progress timeouts.
- Reason: a per-row LLM first build takes hours. As one transaction it could never finish, and every retry would re-bill everything. A position based on the timestamp alone skipped rows [V].

**D47. What a tick does. (new)**
- Options: the tick runs the due work; the tick plans and spawns.
- Choice: plan and spawn, with a singleton row. `schedule start` spawns a fresh tick process each minute.
- Reason: launchd runs one process per job, so a busy tick drops fires [U]. Cron overlaps ticks. An in-process loop keeps stale `lib/` code [V].

**D48. JavaScript value types for TS code. (new)**
- Options: `Date` for timestamps; ISO strings.
- Choice: ISO strings (naive without offset, zoned with `Z`, microseconds kept); HUGEINT snapshotted as DECIMAL(38,0), arriving as `bigint`.
- Reason: pass-through rows must reload unchanged. `Date` turned naive timestamps into shifted TIMESTAMPTZ, and Parquet turned HUGEINT into DOUBLE [V].

**D49. Schedules. (new)**
- Options: schedules on any asset; ingests only.
- Choice: ingests only. The tick also refreshes any stale transform.
- Reason: transforms follow their inputs, and this removes the "scheduled transform inside a downstream set" special case.

**D50. Resumable first loads. (new)**
- Options: post-v1; monotone partial commits in v1.
- Choice: monotone partial commits for cursor ingests in phase 4. Commit every 50k rows or 5 minutes while cursor values are non-decreasing; otherwise use a single transaction.
- Reason: a long first load that dies late would otherwise refetch from zero, forever if it keeps dying. The chunked-commit machinery already exists for TS transforms.

**D51. Rejected: deferring incremental TS transforms.** The storage reviewer suggested deferring them, because three of its bugs lived on that path: `Date` precision, the naive-timestamp shift, and HUGEINT through Parquet. All three are fixed (D46, D48), and the path is the only protection for the audience's most expensive transform. It stays in v1.

**D52. Name. (new)**
- Options: `tsdb` (the working name); `croft`, `rowen`, `rowjar`, `bothy`, `quern` and others from a naming panel. The panel checked each against the npm registry, Homebrew and existing commands.
- Choice: **croft**, a small plot of land one household works itself.
- Reason: it matches one folder, one local project that you own and run. It is one syllable and five letters, and it reads cleanly as `croft run`, `import { ingest } from "croft"`, `croft.json`, `.croft/` and the skill name. On 2026-09-22 the npm name, the Homebrew formula and local commands were all free. `tsdb` was taken on npm and read as "time-series database". Known neighbors are small: a PyPI dataset-publishing tool, and a Rust TUI at croft.software. Search needs a qualifier ("croft cli").

---

## Open questions for the user

Decided on 2026-09-22: the name is **croft** (D52).

1. **Desktop notifications** on scheduled failures are proposed as on by default. Keep that default?
2. **The read copy** doubles disk use on filesystems without copy-on-write clones (most Linux ext4), and costs a full copy after each run that changed data. It is proposed as on by default, with `doctor` suggesting it be turned off when it gets slow. Keep that default?
3. **Scope.** v1 is about 13.5 engineer-weeks over 5 phases. Should phases 1–2 (load, look, transform and trust; about 7.5 weeks) ship first, with scheduling after?

---

## Appendix A: Changes after review

**From the non-data-engineer review:**

- `croft/read` now ships as built JavaScript, because it crashed under Node/Next.js. It locates the project explicitly, and `init` inside an app repo creates `data/` without touching the app's files.
- The Bun floor was raised to 1.3.14 and is enforced, with CI on `bun@latest`. The earlier "1.3 or newer" was false.
- `SELECT *` over an asset no longer collides with `_loaded_at`: reserved columns are excluded automatically.
- CSV handling:
  - globs use `union_by_name`, fixing a silent column drop;
  - UTF-8 falls back to latin-1;
  - money and thousands separators parse;
  - date format is decided once per column;
  - file ingests get a `map()` hook;
  - duplicate rows across files and deleted files are reported.
- Long runs detach automatically off a TTY; lock waits cap at 90 s.
- Paid per-row TS transforms are incremental by template, protected by a cost guard, and capped in preview.
- Scheduling uses one per-user job with a registry and a verified heartbeat, and diagnoses privacy protection, WSL idle, missing Bun and moved projects. `Bun.cron` is no longer used.
- The Stripe journey is taught correctly: typed epoch cursors with `unit` and `lookback`, newest-first cursor pagination, and a rule for records that change after creation.
- NULL-only placeholders are typed from the column name, and `NULL_ONLY_COLUMN` maps binder errors to a pin fix.
- Cut: incremental SQL, `--step`/`--to`, `checks/` files, `copy`/`--database`, `query --write`, `initial`. Merged: `plan`, `history`, `trash` and `drop` into other commands. The result is 19 commands and 7 concepts.
- Synced and WSL-drvfs folders get automatic database relocation.
- Secrets: "edit `.env`" is the primary instruction, `--stdin` is supported, and all `.env` values are redacted.
- `INPUT_NOT_BUILT` handles validation of SQL over never-run ingests.

**From the Claude Code operator review:**

- `query` became a sandboxed single SELECT. A READ_ONLY connection had overwritten the warehouse via `COPY TO`. All user SQL is gated, and every instance is sandboxed.
- `--allow-shrink` is a destructive operation (trash + confirmation) whose fix requires a human.
- Confirmation tokens via `croft confirm` replace `--yes`. The impact is recomputed at confirmation, destructive commands never appear in `next`, and one permission rule gates them all.
- The scheduler hold (`SCHEDULE_HELD`) keeps half-finished edits away from real data.
- A backfill matrix replaces silent duplication and truncation. `--from` accepts relative dates and converts to the cursor type.
- Type safety:
  - casts are whitelisted, with a round-trip loss check;
  - pin changes that alter stored values need confirmation;
  - `TYPE_WIDENED`, `COLUMN_STOPPED_ARRIVING` and `JSON_KIND_CHANGED` report drift;
  - `TYPE_CONFLICT` fixes are reordered.
- `restore` marks downstream stale. `delete --where` replaces `query --write`. `OUT_OF_BAND_CHANGE` detects outside writes. The safety principle is reworded to what is enforced.
- Proxy-guarded rows raise `UNKNOWN_INPUT_COLUMN`, and generated input types move into v1 (phase 5).
- `rename` and `ASSET_RENAMED` stop file renames from refetching history.
- Preview semantics are defined: partial inputs, capped TS transforms, no lock held during user code, and `--rebuild` for drift.
- JSON contracts are specified for `query`, `run`, `wait`, `status`, `describe`, `validate` and `context`, along with exit precedence and the meaning of `ok`.
- Replace became a diff that keeps `_loaded_at`; bare `run` has a defined meaning.
- The skill was rewritten with an "ask the user first" list and operating recipes.
- Checks are parsed as single expressions and executed via `prepare()`. This closes statement injection.
- JSON is canonicalized for unchanged-row detection.
- `logs --failed`, `problems[].runId`, and the skipped-because-input-failed state were added.

**From the technical review (transformation and scheduling):**

- Incremental SQL is cut (D7).
- Dependencies come from the AST plus the unoptimized plan (D45). Catalog prefixes, file reads, volatile functions and reserved-keyword asset names are reported.
- SQL bodies are checked with `extractStatements` and run through a temp view with a `COLUMNS` filter, which tolerates trailing `;` and `--`.
- Keyed replaces and SQL rebuilds are diff-MERGEs that keep `_loaded_at` on unchanged rows.
- Incremental TS transforms get composite positions, ordered snapshots, chunked commits, staged-chunk reuse and no-progress timeouts (D46).
- TS values round-trip as ISO strings, and HUGEINT is snapshotted as DECIMAL(38,0) (D48).
- Every open goes through `DuckDBInstance.fromCache` with one mode per process.
- The tick plans and spawns, with a singleton. `schedule start` spawns a fresh tick per minute (D47).
- DST fire rules are defined; the time zone is part of every fingerprint; one connection factory sets it.
- Leases carry process start time and boot id.
- Stale transforms are picked up by the tick. Deterministic failures wait for the next fire time.
- The DDL-before-DML invariant is enforced.
- Estimates are revised to about 13.5 weeks, and the phase-3 OS-registration spike gates scheduling.

**From the technical review (storage and ingestion):**

- **A second instance in the same process is invisible to the OS lock** (the blocker). A second read-write instance lost committed data, a second read-only one served stale data, and closing either, or closing any `fs` descriptor on the file, released the first instance's lock [V]. The fixes:
  - every open goes through `fromCache`;
  - `croft/read` reuses a loaded runtime's lease;
  - `validate` rejects imports of the binding or `croft/read` in assets and `lib/`;
  - ingests get `ctx.query()`;
  - `schedule start` spawns subprocesses;
  - copies are made by a child process.
- **Casts** read JSON text, the loss check compares exact decimals, and `PIN_ROUNDED` and `DECIMAL_PRECISION_UNSUPPORTED` were added. The claim that JSON staging keeps fractional text exact was corrected: integers stay exact, fractions become doubles.
- **DDL before DML** is enforced by the Sql wrapper (`DDL_AFTER_DML`), and restore uses `CREATE OR REPLACE`.
- **Positions** come from SQL values, never `Date`, and naive timestamps round-trip as strings.
- **Names** are cleaned and resolved case-insensitively in the JS writer before `read_json`. Source `_loaded_at`/`_file` columns are renamed, every generated identifier is quoted, and `ROW_NOT_OBJECT`, `UNSERIALIZABLE_VALUE` and `DUPLICATE_OUTPUT_COLUMN` were added.
- **CSV:** header-less all-text files fail with `CSV_HEADER_AMBIGUOUS` instead of losing a row; `union_by_name` and encoding handling were confirmed.
- **Secrets** are parsed by croft with Bun's loading off, so `.env.local` and the working directory no longer matter.
- **Query sandbox:** extension autoinstall and autoload are off, allowed directories are narrowed to `files/` for `query`, and `QUERY_PATH_DENIED` was added.
- **Preview** snapshots its inputs to Parquet instead of attaching the live file.
- **Readers:** the write-intent handshake stops app readers starving writers when the read copy is off.
- **Copies:** the read copy uses `CHECKPOINT` plus a child-process clone under the write lease. The pre-upgrade backup includes the WAL and reads the "newer engine" version from `runs.sqlite`.
- **Cursors:** the "inclusive start" claim was replaced by a 1-second default lookback; lookback renders in the saved value's own form; resumable first loads (monotone partial commits) moved into v1 (D50).
- **Staging and schema:** `_croft_seq` orders dedupe; per-row absence means NULL (with post-v1 `partial: true`); the real schema is read from `duckdb_columns()`, with `TABLE_MODIFIED_OUTSIDE_CROFT`; Parquet types are normalized.
- **Platforms:** native Windows is unsupported in v1 (use WSL on ext4).
- **Rejected:** deferring incremental TS transforms (D51).

---

## Appendix B: Verification ledger

All spikes ran on macOS arm64 with `@duckdb/node-api` 1.5.5-r.5 (DuckDB 1.5.5), under Bun 1.3.14 unless noted. They live in the design scratchpad (`spike/`), and they are recorded here so implementation can turn each into a test.

| Area | Result |
|---|---|
| Runtime | node-api loads under Bun 1.3.0–1.4.2; `JSON.rawJSON` and reviver `context.source` exist on all of them; `Bun.cron` is absent before 1.3.11; `Bun.cron.parse` ignores tz on 1.3.14 and honors it on 1.4.2; the built `croft/read` works on Node 24.3/24.20, while a `.ts` export under `node_modules` fails on Node |
| Locking | a second process cannot open a file held read-write, even READ_ONLY; the error names the holder path and PID; open+close is 3–6 ms; lock handoff is about 57 ms; overlapping readers delayed a writer 2.4 s; two instances on one file in one process lost data |
| Sandbox | a READ_ONLY connection executed `COPY TO` over the warehouse, leaving 4 bytes and an unopenable file; `allowed_directories` + `enable_external_access=false` + `lock_configuration=true` blocked `COPY TO` the warehouse, reads outside allowed dirs, and re-enabling; `DETACH` + read-write `ATTACH` of an already-attached path still worked; `json_serialize_sql` rejects COPY, EXPLAIN ANALYZE and PIVOT, accepts DESCRIBE/SUMMARIZE, and reports 2 statements for `select 1; select 2`; a multi-statement `run()` executed an injected `DROP TABLE` |
| SQL assets | dependency extraction through CTEs, subqueries, EXISTS, UNION and 3-part names; quoted file paths appear as BASE_TABLE; `query_table()`/`query()` hide their tables; dynamic PIVOT fails to serialize and prepare, while PIVOT with an IN list works; `prepare()` yields output columns; the AST fingerprint (without `query_location`, lowercased names) is stable across formatting and case |
| Reserved columns | the `SELECT q.*, stamp AS _loaded_at` wrapper kept the upstream `_loaded_at` and added `_loaded_at_1`; `INSERT BY NAME` raised `Duplicate column name`; `EXCLUDE` of a present column works, and of an absent one is a binder error |
| Writes | DDL is transactional (CREATE, ALTER ADD/TYPE, CREATE OR REPLACE); MERGE with duplicate source keys applies one to matched rows and inserts both for unmatched ones, and fails with a PK; `MERGE … WHEN NOT MATCHED BY SOURCE THEN DELETE` gives UPDATE/DELETE/INSERT actions and keeps an unchanged row's stamp; `INSERT BY NAME` fills missing columns with NULL; kill -9 inside a transaction rolls back; committed data before checkpoint survives via the WAL |
| Types | the sniffer types mixed-offset and mixed-fraction timestamps as VARCHAR; JSON staging keeps integer text exact (fractions become doubles); `json_type` classification; `1.7` into BIGINT stores 2; `'1.5'::BIGINT` is 2 even via `try_cast`; `+02:00`→TIMESTAMP drops the offset; `'02134'`→BIGINT gives 2134; a VARCHAR pin sorts `9 > 100 > 10`; STRUCT insert drops an extra field; the lossless proof catches 2^53+1; a VARCHAR NULL-only column breaks `date_diff`, comparisons and `COALESCE`; JSON `IS DISTINCT FROM` is text-based (key order, whitespace, `1.0` vs `1`); `->>` on a JSON string returns NULL |
| CSV | the sniffer flips day/month order depending on the rows; a glob without `union_by_name` drops later columns; latin-1 files fail as UTF-8 and load with `encoding='latin-1'`; money strings parse to DECIMAL; `strptime` with a pinned format works; a read-only instance can query CSV globs |
| Time | `SET TimeZone` after connecting works, as an instance option it fails; `::DATE` of TIMESTAMPTZ yields project-zone days; `getRowObjectsJson` renders TIMESTAMPTZ in the process-local zone |
| TS code | the `Bun.build` fingerprint with `identifiers: false` is stable under comment edits, detects `lib/` changes, and costs about 0.5–1.2 ms; with identifier minification it changed on a comment edit; Proxy rows guard unknown columns, including destructuring, at 17 ms per 2M reads, but break `structuredClone`; a detached child outlives its parent |
| Stripe shape | against a newest-first mock, the keyset loop got stuck after 2 requests, and a `starting_after` loop fetched all 250 records in 3 requests |
| Trash | an ATTACH copy preserves HUGEINT, JSON, TIMESTAMPTZ and DECIMAL in 1 ms; one transaction cannot write two databases; restore from a read-only attached file works in one transaction; APFS `COPYFILE_FICLONE` clones in 0.1–0.2 ms |
| Process locks | `fs.openSync`+`closeSync` on the held file released DuckDB's lock (a child then wrote); opening and closing a second read-only instance in the same process did the same; `statSync` and APFS `COPYFILE_FICLONE` did not; `DuckDBInstance.fromCache` shares one instance across realpath and case-variant paths and refuses a different configuration; a byte copy without `CHECKPOINT` missed 500 WAL rows, and with it was complete |
| Transactions | DELETE or UPDATE followed by ALTER on the same table failed at COMMIT; ALTER before DML, including MERGE, worked |
| Dependencies | the unoptimized bound plan found `query_table`, `query()`, table macros, PIVOT with IN, and correct CTE shadowing; the optimized plan dropped scans under `WHERE false` and `LIMIT 0`; `current_date`/`current_timestamp` are COLUMN_REF nodes in the AST; the 75 reserved keywords break `FROM <name>` |
| SQL wrapper | a temp view plus `COLUMNS(c -> c <> '_loaded_at')` handled `SELECT *` over assets, trailing `;` and `--`; `extractStatements` counts statements; a failing check after CREATE OR REPLACE rolled back cleanly |
| TS positions and values | stream order of a merged input was not stamp order, and a max-stamp position skipped 3 of 5 rows; a naive TIMESTAMP passed through `Date` came back as TIMESTAMPTZ shifted 8 h without microseconds; HUGEINT became DOUBLE in Parquet and survives as DECIMAL(38,0); a cache-busted `import()` kept the old `lib/` module |
| Scheduling math | wall-clock matching skips 02:30 on 2026-03-08 and doubles 01:30 on 2026-11-01 in Los Angeles; `TimeZone` is per connection and changes `::DATE` keys |
| Staging precision | `read_json` into JSON columns re-rendered `3.14159265358979323846` as `3.141592653589793` and `1.50` as `1.5`; integers beyond int64 kept their digits; JSON→DECIMAL(18,2) gave `1.00` for `1.005` while text gave `1.01`; TRY_CAST of JSON `1.7` to BIGINT gave 2 |
| Staging names | `read_json` matched keys case-sensitively (`ID` loaded NULL into `Id`), failed with "Duplicate struct entry name" for `Id` + `id`, and rejected an empty key |
| CSV header | a header-less all-text CSV lost its first data row, with or without `all_varchar`; numeric files were detected correctly |
| Secrets | `bun --no-env-file` disables `.env` loading (default loading read `.env` from the working directory) |
| Throughput | a 200k-row batch merged into a 2M-row, 20-column table in 327 ms including checks |
| Storage | 30 hourly full rewrites doubled a 9.8 MB file to 19.3 MB; 10% merges stayed at 9.5 MB; the sandbox blocks `read_text('.env')` and https; spilling works under the sandbox; Unicode identifiers work unquoted |

**Unverified [U]:**

- OS job registration on each platform (not run, to avoid modifying this machine's launchd) and macOS privacy-protection behavior for background jobs.
- WSL idle shutdown.
- Linux reflink.
- musl and Windows runtime behavior.
- Power-loss durability.
- Claude Code hook exit-code semantics, and permission-rule matching beyond a command prefix.
