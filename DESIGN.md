# croft: design v1

> **Status.** Final design for v1, dated 2026-09-22. It was produced by a design panel: four independent drafts (simplicity, AI operator, correctness and builder lenses), a synthesis, and three adversarial reviews (a non-data-engineer walking real journeys, Claude Code operating the tool, and a technical review backed by spikes). Claims are marked **[V]** when verified by a spike on Bun 1.3.14 with `@duckdb/node-api` 1.5.5-r.5 (DuckDB 1.5.5) on macOS arm64, and **[U]** when relied on but unverified. Appendix B lists the spikes. The working name during design was "tsdb"; the product is named **croft** (D52). **Phases 1, 2 and 3 are complete** (§11) in `packages/croft`, with about 2,985 tests, including an end-to-end suite that drives the real CLI through 24 user journeys (`tests/e2e`) and a concurrency suite of real processes (`tests/concurrency`). The document was brought in line with that code (`packages/croft/src`), which is the source of truth where the two differ, on 2026-09-23 for phase 1 and on 2026-09-24 for phases 2 and 3. Decisions the build refined carry a **Build:** note, and decisions it changed have their own entries from D54 on (§13).

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
bun add -g @zabaca/croft                   # installs the `croft` launcher into ~/.bun/bin
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

- It walks up from the current directory to the nearest `croft.json`, changes into the project root, and execs that project's pinned copy in `node_modules/@zabaca/croft` with `bun --no-env-file`. That way the global and project versions can never disagree, and Bun's automatic `.env` loading (which depends on the working directory and also reads `.env.local`) is switched off [V]. croft reads `<root>/.env` itself (§9).
- If `node_modules` is missing entirely (for example after `git clone`), it runs `bun install` first, but only for commands that can change data. `init`, `doctor`, `docs`, `version` and `help` (and mistyped names, which get a did-you-mean) run from the launcher's own copy without installing, because `doctor` promises no writes. If the pinned copy is still missing (a failed install, or a `node_modules` without croft), the launcher refuses with `INSTALL_FAILED` instead of retrying the install on every command.
- Outside a project, only `init`, `doctor`, `docs`, `version` (`--version`) and `help` work.
- If `~/.bun/bin` is not on `PATH`, `bunx croft …` inside the project resolves the same local binary.
- **No `.env` values leak through the launcher.** The launcher itself runs as plain `bun`, so Bun may have loaded `.env` files from the current folder into it. The pinned copy gets an environment rebuilt without those values, and a copy that runs locally with them loaded starts itself again with `--no-env-file`. Deleting keys from `process.env` is not enough, because Bun spawns children with the environment it started with unless it is given one [V]. For the same reason every child croft spawns gets an explicit `env` (§9.8).

The bin is `bin/croft.mjs`, a small plain-JavaScript entry. Its `#!/bin/sh` first line runs the file with `bun` when Bun is on `PATH` and with `node` otherwise, and prints `NEEDS_BUN` itself when neither runtime exists (`npx croft` on a machine without Bun). Under Node it answers `NEEDS_BUN`; under Bun it imports `src/cli/main.ts`. The CLI itself is TypeScript source with no build step. The one exception is `@zabaca/croft/read`, the helper apps import (§5). It ships as prebuilt JavaScript plus `.d.ts`, because Node refuses to strip types from files under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) [V]. The built `read.js` ran under Node 24.3 and 24.20 [V]. `npm pack` and `npm publish` build it through the package's `prepack` script, so a clean checkout ships it too (§10).

**`croft init` in an empty folder** generates:

| File | Contents |
|---|---|
| `croft.json` | `{"$schema": "./node_modules/@zabaca/croft/croft.schema.json", "database": "warehouse.duckdb", "timezone": "America/Los_Angeles"}`. The timezone is detected at init, so "daily at 06:00" keeps its meaning on a UTC server. Optional keys: `serve` (`{"port": 7447, "host": "127.0.0.1"}`, plus `queryTimeoutMs` 30000, `maxConcurrent` 4, `maxBytes` 64 MB, `maxRows` 100,000 and `allowOrigins` `[]`, §5), `readCopy` (default `false`), `notify` (`{"desktop": true, "webhook": null}`, §8), `concurrency`. Keys that a later phase's feature reads are accepted and validated early, and `croft docs config` marks them unused until then (`core/phase.ts`). The phase-3 keys (`readCopy`, `notify.*`, `serve.*`) were such keys in phases 1 and 2, and phase 3 reads them. |
| `package.json` | `{"private": true, "type": "module", "dependencies": {"@zabaca/croft": "0.1.0"}, "devDependencies": {"@types/bun": "1.3.14", "typescript": "5.9.2"}}`, with exact pins |
| `tsconfig.json` | strict, `moduleResolution: "bundler"`, `types: ["bun"]`, includes `assets` and `lib`. Editors and Claude get type errors. |
| `.env` / `.env.example` | `# Secrets for your assets, e.g. GITHUB_TOKEN=...`. `.env` is git-ignored and created with mode 0600; an existing `.env` is never touched. |
| `.gitignore` | `warehouse*.duckdb*`, `.croft/`, `.env`, `node_modules/` |
| `CLAUDE.md` | a managed block between markers (§9); appended if the file already exists |
| `.claude/skills/croft/SKILL.md` | the version-stamped skill (§9) |
| `assets/example_sales.ts` | a file ingest of `files/example_sales.csv`, so the first run needs no network |
| `files/example_sales.csv` | 120 rows of sample data |

**Where the database and state folder may live.** `croft.json` can also carry `stateDir`, which croft writes when it relocates (below). Both locations are checked when `croft.json` is read, because the sandbox (§5) lets SQL read the state folder and `croft query` read `files/`. `stateDir` may not be or hold the project folder or `~`, or overlap `files/`, `assets/`, `lib/` or the database. `database` may not sit in `files/` or the state folder, or be named `preview.duckdb` or `*.read.duckdb`. Each violation is `CONFIG_INVALID`. Paths are resolved with `lstat` and `readlink`, never by opening the files (§5).

**Re-running `init`.** `croft init` with no folder, run inside a project, targets that project: plain `init` refuses (it never overwrites a project) with the fix `croft init --claude`, and `--claude` refreshes the Claude files. An explicit folder is resolved from where the user typed the command, because the launcher runs the pinned copy from the project root (it passes the original folder in `CROFT_CALLER_CWD`). `--no-install` skips `bun install`. A folder croft cannot write is `PROJECT_NOT_WRITABLE`, and a failed `bun install` is `INSTALL_FAILED` (the project is created, and `next` says to run `bun install`).

**`croft init` inside an existing app repo.** "Add data pipelines to my app" is a common starting point. When the target folder already has a `package.json`, init never overwrites the app's files:

- It creates the project in a `data/` subfolder with its own `package.json`, `tsconfig.json` and `.gitignore`.
- It adds `"data"` to the root `tsconfig.json` `exclude` list, so `next build` does not type-check assets without Bun types. It shows this edit as a diff and applies it only with confirmation on a TTY; otherwise it prints it.
- It appends a root `CLAUDE.md` block that points at `data/`. The block says: "read croft data only with `import { query } from "@zabaca/croft/read"`; never open the .duckdb file directly".
- It also writes the skill at the app root (`.claude/skills/croft/SKILL.md`), so Claude Code started at the app root can load the skill the root block names. That is a new croft-owned file, never an overwrite. `init --claude` and `doctor` handle both copies. A parent folder counts as the app root only when croft's own files are there (the skill, or croft markers in its `CLAUDE.md`), so `--claude` never writes into a folder croft never touched.
- It prints the app-side steps: `bun add @zabaca/croft@<version>`, pinned to the project's croft version (or `pnpm add`, `yarn add` or `npm install`, picked from the app's lockfile), plus `serverExternalPackages: ['@duckdb/node-api']` when `next` is one of the app's dependencies.

**Runtime files.** croft creates these at runtime. The user never edits them:

- `warehouse.duckdb`, and, only when `readCopy` is on, `warehouse.read.duckdb`, a copy for GUIs and notebooks (§5).
- `.croft/`, the state folder. It holds `runs.sqlite`, `staging/`, `logs/`, `trash/`, `backups/`, `preview.duckdb`, `preview/` and `types/`. It also holds `serve.json` while `croft serve` runs, and `write-intent.d/` while a writer holds or waits for the file.
  - `staging/_chunks/<asset>/` holds an incremental TS transform's chunk while it waits for its commit, so a later attempt can reuse it (§3e).
  - `preview/` holds what the last preview used: the input snapshots, the `_croft` rows of the assets it copied (`preview/_croft/`), its own `runs.sqlite` (catalog source `preview`) and its step logs (`preview/logs/<asset>.log`). `preview.duckdb` also has a `live` schema: `live.<asset>` is the live version of each asset the preview built, and `croft query --preview` can read it (§6).
  - `runs.sqlite` also keeps the project's settings, such as whether scheduling is on (its `settings` table, added in phase 3 as migration 2, §5).
  - `logs/tick.log` holds the output of the ticks `croft serve` starts, and `logs/notify.log` the failure notifications that could not go out (§8). A failed refresh of the read copy is logged to `readcopy.log` (§5).
- `~/.croft/`, the scheduler's per-user folder (`CROFT_HOME` moves it): `projects.json`, the registry of projects with scheduling on, and its lock files; `tick.ts`, the script the per-user OS job runs; and `logs/tick.log`, the job's output (§8).

**Synced and network folders.** On many Macs, `~/Documents` and `~/Desktop` are synced to iCloud by default. File sync can corrupt a DuckDB file mid-write and breaks its locks. The same applies to Dropbox, OneDrive, network filesystems and WSL's `/mnt/<drive>` (drvfs/9p). When `init` detects such a location (by path prefix plus `statfs`), it puts the database and the state folder in `~/.local/share/croft/<project>-<hash>/` instead, as `warehouse.duckdb` and `.croft/` side by side, so the database stays outside the state folder. It records both paths in `croft.json` (as `~/…` when they are under the home folder, so the file still reads right for another user name) and says so in plain words. Asset files stay in the project folder. `init` creates the state folder right away, in the project or relocated.

`doctor` never writes, so on an existing project it reports the location with a manual fix instead: stop croft, move the database and `.croft/`, and set `database` and `stateDir` in `croft.json`. A sync folder is `DB_ON_SYNCED_FOLDER` (a warning). A network filesystem or a 9p mount such as a WSL drive is `SERVE_UNSAFE_FILESYSTEM` (an error), because DuckDB's file lock does not hold there (§5, "Same kernel only").

**Dependencies:**

- **Bun ≥ 1.3.14.** This is the version everything was verified on, and the launcher enforces it with `BUN_TOO_OLD`. `package.json` declares `"engines": {"bun": ">=1.3.14"}`. Bun 1.4.2 is the current `latest`, and CI runs against `bun@latest` as well as the floor. The last CI-tested Bun is `BUN_TESTED` in `src/cli/version.ts`, next to the floor, which is read from `package.json` `engines`. On a newer Bun, `doctor` warns with `BUN_UNTESTED` instead of printing ok.
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
| Bun newer than the last CI-tested one | `Bun.version` vs `BUN_TESTED` | `BUN_UNTESTED` (a warning in `doctor`) |
| Started with Node (`npx croft`) | `bin/croft.mjs` checks `typeof Bun`; its `sh` first line falls back to `node`, and prints the problem itself when neither runtime exists | `NEEDS_BUN`: the Bun install one-liner |
| `bun install` failed, or the pinned copy is missing | `init`'s install result; the launcher finds no pinned copy after its install, or in a `node_modules` without croft | `INSTALL_FAILED`: fix what `bun install` reports, then `bun install` |
| The scheduler's OS job could not be installed | `croft schedule on`: `launchctl bootstrap` failed, `crontab` is missing or failed, or the platform is neither macOS nor Linux | `INSTALL_FAILED`: log in to the Mac's desktop session (launchd's gui domain needs one), or install and start cron; or `croft schedule on --no-os-job` and keep `croft serve` running (§8) |
| Native binding missing (optional deps skipped, `node_modules` copied from another OS, x64 Bun under Rosetta) | `import("@duckdb/node-api")` in a subprocess fails, or binding arch ≠ `process.arch`. Commands load lazily (§10), so only the commands that need DuckDB fail | `DUCKDB_BINDING_MISSING`: `rm -rf node_modules && bun install`, or "install the arm64 build of Bun" |
| Binding fails to load (old glibc) | dlopen error text | `DUCKDB_BINDING_LOAD`: required glibc version |
| Database written by a newer DuckDB/croft | `_croft.meta.format_version` | `DB_NEWER_FORMAT`: refuses to open rather than risk a downgrade |
| Database file cannot be opened (damaged, or not a DuckDB file) | DuckDB's open error | `DB_UNREADABLE`: check or restore the file |
| Database held by another program (DuckDB CLI/UI, DBeaver, the user's app) | parse DuckDB's lock error `…held in <path> (PID n)` [V] | `DB_HELD_BY_OTHER_PROGRAM`: "close /opt/homebrew/bin/duckdb (PID 812); apps should query through `croft serve`; for GUIs, turn on `readCopy` and open warehouse.read.duckdb" |
| Synced storage (iCloud, Dropbox, OneDrive, Google Drive) | path prefix | `init` relocates automatically (above); `doctor` warns `DB_ON_SYNCED_FOLDER` with the manual move |
| Network filesystem, or a 9p/WSL drive | `statfs` magic number, `/mnt/<drive>` under WSL; `doctor` also asks `db/fs-kind.ts`, which reads the mount table (§5, "Same kernel only") | `init` relocates automatically; `doctor` reports `SERVE_UNSAFE_FILESYSTEM` (an error) with the manual move |
| Project not writable | `doctor`: test write to the state folder; `init`: a failed write | `PROJECT_NOT_WRITABLE`: make the folder writable, or create the project elsewhere |
| Bun's and DuckDB's tzdata disagree for the project zone | compare offsets every 12 h over the next 2 years, and every 15 min across transitions | `TZDATA_MISMATCH` (a warning): the first mismatching instant with both offsets; take days from SQL until Bun and croft are upgraded. Also raised when DuckDB does not know the zone |
| Referenced secret missing | declared `secrets` vs environment and `.env`; the names come from importing the asset configs, as `croft secrets` does. Finding the assets needs DuckDB, so without a loadable binding the check is skipped with an info line | `SECRET_MISSING`: "add NAME=… to .env (or `croft secrets set NAME`)". A warning in `doctor`; it is an error only when an asset that needs the secret runs |
| Claude files older than the CLI | version stamp in SKILL.md | `CLAUDE_FILES_OUTDATED`: `croft init --claude` |
| Scheduler not ticking | scheduling on, and no tick for 3 min since the latest of the last heartbeat, turning it on and the end of a pause | `SCHEDULER_STALE` (a warning), with the tail of the tick log and a likely cause (§8) |

```
$ croft doctor
Environment
  ok    bun 1.3.14 (darwin-arm64), needs >= 1.3.14
  ok    croft 0.1.0 (project-pinned; launcher 0.1.0)
  ok    duckdb 1.5.5 binding darwin-arm64 · json, parquet, icu built in
  ok    warehouse.duckdb 412 MB · writable · held read-only by croft serve (steps aside for writes) · duckdb 1.5.5
  ok    croft serve on 127.0.0.1:7447 (pid 4121) · token in .croft/serve.json · 1,204 queries today
Project
  ok    6 assets · 0 errors, 1 warning (details: croft validate)
  warn  SECRET_MISSING STRIPE_KEY (used by stripe_charges)
        fix: add STRIPE_KEY=... to .env (or run `croft secrets set STRIPE_KEY` in your terminal)
Scheduling
  ok    on · ticks from croft serve (pid 4121) · last tick 12 s ago
1 warning
```

Each problem appears inline under its check, with its code in front and its fix on the next line (the command spec's `humanShowsProblems`, §10). `doctor` never opens the warehouse while a live croft write intent exists; it prints `busy: croft run … is writing` instead of waiting, and the `DB_BUSY` path covers only races.

The Project section's asset line is its own check (id `assets`). It runs `croft validate`'s checks, which never open the warehouse, and shows only the counts: it is an error when validate finds an error (so `doctor` exits 1), and ok otherwise, warnings included. Before `bun install`, or without a loadable DuckDB binding, it is an info line that only counts the asset files.

The Scheduling section (id `scheduling`) is an info line while scheduling is off, and ok while it is on ("on · ticks from the per-user OS job | croft serve (pid 4121) · last tick 12 s ago") or paused (with the time it resumes). A scheduler quiet for 3 minutes while on is the warning `SCHEDULER_STALE`, with its likely cause and the tail of the tick log under the line; only then is the OS job inspected (`launchctl print` or `crontab -l`, §8).

Phases 1 and 2 named the server "croft's read server", because their texts could name only commands the build had (§4.1). Phase 3 ships `croft serve`, and `status` names it so ("croft serve http://127.0.0.1:7447 (pid 4121)"), but `doctor` and the lock messages keep the old words: "held read-only by croft's read server (pid 4121; steps aside for writes)", "read server on 127.0.0.1:7447 (pid 4121)". `LockHolder.program` carries the same name. The holder of the lock is the server's query worker, a child process with its own PID (§5), which `db/warehouse.ts` recognizes as croft's.

---

## 3. Asset definitions

### Layout and naming

- An asset's name is its file's base name. It must match `[a-z][a-z0-9_]*` and be unique across `assets/**`.
- Subfolders are for organization only.
- Every table lives in DuckDB's `main` schema, so SQL always says `FROM github_issues`.
- `new` (kept free for post-v1 incremental SQL, §3d), `croft` and names starting with `_` are reserved.
- DuckDB's 75 reserved keywords (`order`, `end`, `limit`, `window`, `group`, …), and 30 of its 35 `type_function` keywords (`left`, `join`, `like`, `is`, …), are rejected with `NAME_RESERVED` and a suggested plural ("rename to orders"), because `FROM order` is a parser error in every downstream asset [V].
- A `.ts` file and a `.sql` file with the same name is `NAME_CONFLICT`.
- `croft run` naming such a file (`croft run order` with `assets/order.ts`) reports that file's own problem (`NAME_RESERVED` with the rename, or `NAME_CONFLICT`), not "there is no asset named order"; a glob that matches it reports it alongside the assets it runs.

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
import { ingest, fail } from "@zabaca/croft";

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
import { ingest } from "@zabaca/croft";

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

`croft new` is phase 5. Until then, the keyset, cursor and Link-header patterns, and the file ingests of §3b, are templates on the docs page `croft docs ingest` (D60).

The skill states the rules in plain words (§9):

- Use keyset only when the API sorts ascending by that field.
- Records that change after they are created need an "updated since" field or a `lookback`.

**Cursor semantics.** croft enforces these; user code does not have to.

- **Typed cursor.** The cursor column's SQL type fixes the cursor type, on the first load that has a non-null cursor value (an all-NULL placeholder typed from the name, §7, does not fix it):
  - a timestamp or date column gives a timestamp cursor;
  - an integer column gives an integer cursor, with `unit: "s" | "ms"` if it holds epoch time;
  - a text column gives a string cursor.

  One change is allowed later: a date cursor becomes a timestamp cursor when its column widens from DATE. A cursor field missing from every row of a non-empty batch is `UNKNOWN_COLUMN`, with a did-you-mean. A column of any other type, a `unit` on a non-integer column, or a type that differs from the saved cursor type is `CURSOR_TYPE_MISMATCH`.
- **`since` keeps the source's JSON type.** A timestamp cursor receives the *original text* the API sent, for example `"2026-09-22T17:58:03Z"`. An integer cursor receives a number, or an exact digit string beyond ±2^53. A text cursor converts nothing: `--from` takes a value written like the saved cursor and passes it through as is (§8).
- **Typed maximum.** After staging, croft computes the maximum on the *typed* column in DuckDB, so timestamps with different offsets compare as instants. It then stores that row's original text.
- **Commits with the data.** The cursor is saved in the same transaction as the rows.
- **Never regresses.** The new cursor is `greatest(saved, loaded)`. Zero rows leave it unchanged.
- **Boundary rows are re-fetched on purpose.** Whether `since` is inclusive is the API's choice, not croft's. So a keyed timestamp cursor gets a default lookback of 1 second (also when `lookback` is set to zero, which cannot be told apart from unset): an exclusive API (`updated_at > since`) still returns rows that tie on the boundary, and the key deduplicates them. Unchanged rows are not rewritten and keep their `_loaded_at`, so the overlap costs nothing downstream (§5). This is why an incremental API ingest needs a `key`: without one, `validate` reports `INCREMENTAL_WITHOUT_KEY` as an **error**, unless `write: "append"` is set explicitly for append-only sources such as event logs. The same rule covers incremental TS transforms. Incremental file ingests are exempt, because they reload changed files by `_file`. Two related settings are `ASSET_INVALID`: `write: "merge"` without a key, and `write: "replace"` together with `incremental`, which would replace the whole table with only the newly fetched rows.
- **Lookback** re-reads a safety margin: `since = saved − lookback`, computed in the cursor's own type and rendered in the saved value's own form. A timestamp keeps its offset (or its lack of one) and its fractional precision; an epoch cursor gets a number. Lookback on an integer cursor without `unit`, or on a string cursor, is `CURSOR_TYPE_MISMATCH` in `validate`.
- **Warnings:**
  - `SINCE_IGNORED` when most loaded rows are older than `since`, which means the code probably did not pass `since` to the API.
  - `EMPTY_EXTRACT` when an ingest with a lookback returns no rows even though its window held rows last time, usually a revoked token or a changed filter.

**`ctx.query(sql)`** in an ingest runs one read-only SELECT against a snapshot of the ingest's *own* table. It answers questions such as "which ids do we already have". Asset code must never open the database itself (§5).

**`ctx.http`** is `fetch` plus the following:

- It retries network errors, timeouts, 429 and 5xx up to 3 times, POST included, honoring `Retry-After`. `retries: 0` turns retrying off for a call, and a stream body is never retried. A `Retry-After` longer than croft waits inside a run (`maxRetryAfterMs`, default 5 minutes) is not slept through: the request fails at once with `HTTP_ERROR` carrying `retryAfterMs`, so the runner can schedule the retry.
- It has a 30 s per-request timeout, linked to the run's abort signal. Aborting the run is never retried.
- It returns 2xx and 3xx responses (a 304 included), and throws `HTTP_ERROR` for any status of 400 or above, with the method, redacted URL, status, attempt count and the first 500 bytes of the body.
- It exposes `res.next` from the `Link` header.
- It drops `null`/`undefined` query values, so `since` can be passed unconditionally.
- It redacts `.env` values from every URL, log line and error (§9.6).
- `res.json()` is **lossless**. Integers beyond 2^53 become `bigint` via the `JSON.parse` reviver's `context.source`. croft's NDJSON writer turns them back into exact digits with `JSON.rawJSON`, so `12345678901234567890` reaches DuckDB intact [V]. Both APIs exist on Bun 1.3.0 through 1.4.2 [V]. Plain `JSON.parse` would give `12345678901234567000` [V]. A number beyond DOUBLE's range (`1e400`), which `JSON.parse` turns into `Infinity`, comes back as `JSON.rawJSON(<its source text>)` (§7, "Nested data").
- croft's own `HttpClient` also has `getBytes()`, which keeps the body as raw bytes for file downloads (text would corrupt Parquet, gzip and latin-1 files). It follows the same retry, `Retry-After`, timeout, redaction and `HTTP_ERROR` rules, and a 304 counts as success. It is not part of the public `Http` type; file ingests download through it with a 10-minute per-request timeout (§3b).

### (b) File ingests

```ts
// assets/taxi_zones.ts: a CSV from a URL, refreshed monthly
import { ingest } from "@zabaca/croft";

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
import { ingest } from "@zabaca/croft";

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
- **URLs** download into `.croft/staging/` through `ctx.http`'s `getBytes()` (§3a), with a conditional GET (ETag / Last-Modified) and a 10-minute per-request timeout. An unchanged file is a no-op.
- **Snapshots.** Every file a load reads is first copied (a copy-on-write clone where the file system has one) into the run's staging folder, so the recorded sha256 is exactly what was loaded even if the user edits the file mid-run, and the write step reads only inside the state folder (§5, "Sandboxing").
- **Globs** are read with `union_by_name = true`, so a column that appears only in later files (a `coupon` column added in March) is kept, not dropped. Without it, DuckDB silently dropped such a column [V].
- **Tracking files.** Every file ingest adds a `_file` column. With `incremental: true`, `_croft.files` records path, size, mtime and sha256.
  - A changed file is reloaded in one transaction as a diff limited to that file's rows. Without a key, that is the content diff of §5 inside those files. Unchanged rows keep their `_loaded_at`, and the counts are exact.
  - **With a key, a key's row belongs to the latest file that provided it** (its `_file`); files loaded together provide their keys in read order (D58). A changed file is reloaded as one MERGE limited to the rows it owns. Because exports overlap, the reload also reads the asset's other present files: a key the changed file dropped falls back to the most recently loaded file that still has it (that file's row, in full), and only a key no present file has is deleted. New files take over the keys they contain; re-exporting an older file makes it the latest provider of its keys again.
  - Rows of a deleted file are kept, and `status` says "2 files gone". A deleted file cannot be read, so it cannot hold a key another file dropped; its own rows stay.
  - A keyless incremental file ingest that loads identical rows from different files gets `DUPLICATE_ROWS_ACROSS_FILES`, with the fix "add a key".
- **`map(row)`** is an optional per-row hook for cleaning values. It gives file ingests the same "clean it in code" fix that API ingests have.
- **CSV and TSV** are read with `all_varchar = true` and typed by croft's rules (§7), never by DuckDB's sniffer. The sniffer read `01/02/2024` as 2024-02-01, but read the same file month-first when one `03/25/2024` row was present [V].
- **Header detection.** DuckDB can only guess the header when some column is not text. A header-less export of names and cities silently lost its first data row [V]. So when `csv.header` is not declared and every sniffed column is text, the first load fails with `CSV_HEADER_AMBIGUOUS`. The error shows the first two lines and offers `csv: { header: true | false }`. It is a first-load error only. Later loads reuse the header decision stored with the columns: named columns mean a header line, and `column0`, `column1`, … mean none. So after the first load a header-only file is an empty file (0 rows), and an all-text file with a new column name is read with its header. Preview and the first run always print the header they used: a CSV ingest's first load carries `StepResult.csvHeader` (`{header, from: declared|sniffed|known, columns}`, where `known` means the cells match the stored columns), and the run prints `CSV header: first line (detected): a, b, …` or `CSV header: none (…); the first line is data, columns named …`.
- **Encoding.** croft reads CSV as UTF-8. If DuckDB reports invalid UTF-8, croft retries as `latin-1` and warns `CSV_ENCODING_GUESSED` [V]. `csv: { encoding: "latin-1" }` makes the choice explicit.
- **JSON and NDJSON** go through the same pipeline as API rows.
- **Parquet** keeps the file's types, except that nested types become `JSON` (§7).

**Zero-asset path.** To look at a file without making an asset, run `croft query "from 'files/sales/*.csv'"` [V]. Paths are relative to the project folder, wherever croft was started. It works before anything has run: with no warehouse yet, `croft query` runs on a private in-memory DuckDB with the same sandbox (`files/` only), so file reads work and no database is created. A table named there is `DB_NOT_FOUND` when it is an asset, and `UNKNOWN_TABLE` otherwise (with the closest asset name). The wording follows `runs.sqlite`, in three cases:

- **Built before and now missing** (the catalog lists tables): the file was deleted or moved. The fix is manual and the user's: put it back, or point `database` in `croft.json` at it. A run would start a new, empty warehouse and refetch everything from the sources.
- **Runs that wrote no table yet:** the fix is `croft run <asset>` for that one asset, not a bare `croft run`, which would fetch every ingest.
- **Nothing run yet:** the same fix.

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

The grammar as built:

- The header is the leading run of `--` comment lines and blank lines; the first other line starts the body. Plain comments may sit between header lines.
- Any `-- word: value` line is a header line, matched without regard to case. So a comment such as `-- Note: …` is `HEADER_UNKNOWN_KEY`, with the hint to leave out the colon. A URL (`-- https://…`) is not a header line.
- `key` values accumulate across lines, repeated descriptions are joined, and empty values are ignored.
- **Header lines must come first** (D73). A `-- key:`, `-- check:` or `-- warn:` line below the header is `HEADER_UNKNOWN_KEY` at its line and is not applied; that includes a header written below a leading `/* */` comment, which ends the header like any SQL line. A `-- description:` line there only documents, so it stays a plain comment.

**The body** must be exactly one SELECT, with CTEs allowed. croft checks it in two ways:

- `connection.extractStatements(sql)` must report exactly one statement, and `prepare()` must report `statementType` SELECT. Otherwise the error is `SQL_NOT_ONE_STATEMENT` ("found 2 statements") or `SQL_NOT_SELECT`. `json_serialize_sql` alone is not enough, because it serializes `SELECT 1; SELECT 2` as two statements [V].
- A `PIVOT` with an `IN` list is a normal single SELECT [V]. Without an `IN` list, DuckDB rewrites it into two statements whose columns depend on the data, so it cannot be checked or bound statically [V]. It gets `PIVOT_NEEDS_VALUES` with the fix "list the values: `ON product IN ('pro', 'basic')`, or use `sum(x) FILTER (WHERE product = 'pro')`". croft tells the rewrite apart from two real statements by comparing DuckDB's `extractStatements` count with its own lexer's, when the text contains `PIVOT` or `PIVOT_WIDER`. `IN (SELECT …)` also yields two statements [V] and gets the same code.
- `DESCRIBE`, `SUMMARIZE` and `SHOW` pass the query gate, and their prepared `statementType` is SELECT [V], but they read the catalog and build no table (`DESCRIBE`'s plan scans nothing, and `SHOW TABLES` has no inputs at all). In an SQL asset they are `SQL_NOT_SELECT`.

**Dependencies** are the union of two sources:

- **The AST's `BASE_TABLE` nodes,** minus CTE names scoped per query node. The scopes follow DuckDB 1.5.5 [V]: a CTE's body sees only earlier CTEs, never itself, so a non-recursive `WITH orders AS (SELECT * FROM orders)` reads the table; a recursive CTE sees itself in its recursive part only. The table a table macro names (`histogram` and `histogram_values`: the first argument, or `source :=`) is a relation and an input too. Only unqualified and `main.` names count.
- **The scans of the *unoptimized* bound plan** (`PRAGMA disable_optimizer; EXPLAIN (FORMAT json) …` over the shadow catalog of §6). This finds tables that the AST hides, inside `query_table('orders')`, `query('SELECT … FROM custs')`, table macros and PIVOT, and it respects CTE shadowing. The optimizer must be off, because it prunes scans (`WHERE false`, `LIMIT 0`) [V]. `PRAGMA disable_optimizer` works on a connection whose configuration is locked, while `SET enable_optimizer` is refused [V]. (The shipped gate refuses `query()` and `query_table()` in all user SQL, §5, so of these only table macros and PIVOT reach the plan.)

**Other schemas and catalogs** are `CATALOG_PREFIX`: any qualifier other than `main.`, not only three-part names such as `other.main.t`. That includes `warehouse.orders` and `memory.main.orders`, which DuckDB resolves to the table while the AST's dependency list leaves them out, so the dependency would silently go missing; and `_croft.*` and `information_schema.*`. Only an asset name gets the edit fix that drops the prefix.

Tables named in a blocking `-- check:` subquery are dependencies too, but they only affect ordering. A `-- warn:` subquery's tables order nothing: a warning runs after the commit against the tables as they are, so it may read a table downstream of its own asset (the `open_issues` example). While such a table has not been built, the warning is skipped for the run with an `INPUT_NOT_BUILT` info note. The run order is deterministic (ties broken by name). A cycle is `CYCLE`, reported once per strongly connected component as the shortest path from its smallest name, with the files. An asset that reads its own table is a cycle; a check whose subquery reads its own asset is not, because checks run after the write. Reading files directly (`FROM 'files/x.csv'`, `read_parquet(…)`) in an asset is `SQL_READS_FILES`, because croft cannot tell when such a file changed. Its fix is "make a file ingest" (`croft new file x`; before phase 5, the templates of `croft docs ingest`), or `FROM <asset>` when the file's base name is an asset. The asset then skips the gate, so the gate's other refusals (`QUERY_PATH_DENIED`) appear once the file read is gone. In `croft query`, reading files is fine.

**Volatile SQL.** `now()`, `current_date`, `random()`, `gen_random_uuid()` and similar functions produce values that freeze until the next rebuild. `validate` warns `VOLATILE_SQL` and suggests computing such columns at query time. The list is DuckDB 1.5.5's own VOLATILE and CONSISTENT_WITHIN_QUERY functions, minus those that give an asset the same value on every run (`current_database`, `current_schema`, `error`, …). It adds `current_localtime` and `current_localtimestamp`, which DuckDB marks consistent, and the macros `ago`, `pg_conf_load_time` and `pg_postmaster_start_time`, which expand to `current_timestamp`. A test fails when DuckDB marks a new function. `current_date`, `current_time`, `current_timestamp`, `localtime` and `localtimestamp` appear in the AST as `COLUMN_REF` nodes rather than functions, and the detector handles that [V].

**How the body is executed, and reserved columns.** Inside the write transaction the step runs, in order (D71):

1. `DESCRIBE <body>`, for the output names as the SELECT wrote them. A view (and any subquery) renames a repeated name: `SELECT * FROM a JOIN b USING (id)` over two assets yields `_loaded_at` and `_loaded_at_1` [V].
2. `CREATE OR REPLACE TEMP VIEW __body AS <sql>`, with the body verbatim.
3. `CREATE TEMP TABLE __croft_next AS SELECT *, row_number() OVER () AS _croft_seq FROM (SELECT COLUMNS(c -> lower(c) NOT IN ('_loaded_at', '_file', '_croft_seq', <renamed copies of those>)) FROM __body)`. The rows are materialized once. The table is not named `next`, because `next` is a valid asset name that a TEMP table would shadow for unqualified reads in checks.

This form has several properties [V]:

- It tolerates a trailing `;` or `--` comment, which an agent writes routinely. A text wrapper around the body broke on them.
- `SELECT *` over an asset stays correct. A naive wrapper keeps the upstream's stale `_loaded_at` next to a junk `_loaded_at_1`, or fails an `INSERT BY NAME` with `Duplicate column name`. The filter compares names without regard to case and also drops the view's renamed copies, so a join or a differently cased `_LOADED_AT` puts no junk reserved column into the table.
- Unlike `EXCLUDE`, it does not fail when a reserved column is absent.
- Duplicate output names, which DuckDB silently renames to `a_1`, are `DUPLICATE_OUTPUT_COLUMN`, in `validate` and again at run time. Repeated reserved names (`_loaded_at`, `_file`, `_croft_seq`, in any case) do not count, since the step drops every copy, so `SELECT *` over a join of two assets validates and runs.
- A SELECT of only reserved columns is `ASSET_INVALID`.

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
import { transform } from "@zabaca/croft";
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

**Incremental by default for per-row work.** The `croft new transform` template is keyed and incremental. An incremental transform needs every input it reads with `newRows()` to have a key, because its resumable position uses that key (below). Otherwise `validate` reports `INPUT_NEEDS_KEY`, with the fix "add `-- key:` to the input" (or `key:` in its TS config). The most common TypeScript transform in this audience calls an LLM or another paid API once per row, and a full-refresh transform would pay again for every row whenever the input changes. A full-refresh transform (no `incremental`, reading `rows()`) is still allowed for whole-table computations. If a full-refresh transform makes requests, `validate` warns `TRANSFORM_MAKES_REQUESTS`. "Makes requests" means it uses `ctx.http`, a bare `fetch()`, or a known HTTP-client or LLM SDK package: `http`, `https`, `undici`, `axios`, `openai`, `@anthropic-ai/*`, the Vercel AI SDK (`ai`, `@ai-sdk/*`), `langchain` and `@langchain/*`, `@mistralai/*`, `@google/genai`, `cohere-ai`, `groq-sdk`, `ollama`, `replicate`, `llamaindex`, `together-ai`, `voyageai`, `@huggingface/inference`, `@azure/openai`, `@google-cloud/vertexai`, `@aws-sdk/client-bedrock*` and a few more. Packages stay external in the bundle, so a request an SDK makes inside itself is never seen: the import is the sign. The check is lexical, over the `Bun.build` output with string, template, regex and comment contents blanked, so helpers in `lib/` count and tree-shaken code does not; an unrelated local variable named `http` also counts. The cost guard (§5) uses the same detection.

**The context API:**

- `rows(name)` streams a whole input.
- `newRows(name)` streams the rows written since the last successful run, which on the first run or after `--rebuild` is all of them. In a full-refresh transform, which keeps no position, `newRows()` is `rows()`. On an input without a key it raises `INPUT_NEEDS_KEY` at run time too, not only in `validate`.
- `query(sql, ...params)` runs one SELECT over the declared inputs. Reading any other table is `UNDECLARED_INPUT`, checked through the AST.
- `log(...)` writes to the step's log.
- `http`, `secret()`, `signal` and `preview` work as in ingests.

An input with no table yet fails the step with `DB_NOT_FOUND` and the fix `croft run <input>`.

**Rows are guarded against renamed columns.** Rows from `rows()`, `newRows()` and `query()` are wrapped in a `Proxy`. Reading a column that the input does not have throws `UNKNOWN_INPUT_COLUMN`, for example `github_issues has no column "author"; did you mean "author_login"?`. The error carries the asset's file and line from the stack, and a replace fix when the name appears once on that line.

- The guard covers destructuring. Spread, `JSON.stringify`, `Object.keys`, `in`, template strings and `Bun.inspect` behave normally [V].
- `structuredClone(row)` fails on a Proxy [V], so the docs say to use `{ ...row }`.
- croft's own columns (`_loaded_at`, `_file`) can be read on a row but are not enumerable, so `yield { ...row }` passes the data through without them (and no `_source_loaded_at` column appears).
- Overhead measured about 17 ms per 2M property reads [V].

Without the guard, a renamed upstream column would arrive as `undefined`, be stored as NULL, and pass every rule check. The guard fires only when the input no longer has the column. An ingest never drops a column (§6), so a field an API renamed keeps its old column, NULL in new rows, and a transform reads NULL there without an error. Only SQL inputs, which are recreated on a shape change, lose the old column. For an ingest input, a `not_null` check on the transform's output catches the rename.

**User code never holds the warehouse lock.** On first use of an input, croft:

1. takes a short read-only lease;
2. runs `COPY (SELECT … ORDER BY _loaded_at, <input key>) TO …` [V] into `<staging>/<asset>/in/<input>/`: `all.parquet` for `rows()` and `query()` (which sees each input as a view over it), or `new.parquet`, only the rows after the transform's position, for `newRows()`. Each file has its own short lease, taken on first use;
3. releases the lease;
4. streams the Parquet file through a private in-memory DuckDB, which is sandboxed and set to the project time zone like every croft connection.

About 150k rows export in 8 ms [V]. HUGEINT and UHUGEINT columns are stored as text in the snapshot and cast back when read, because Parquet would otherwise turn them into DOUBLE [V] (D70). The order uses the table's own typed columns, so HUGEINT keys sort as numbers. Under `croft preview` each input is capped at `--rows` rows. A transform can therefore call an LLM for each row for hours without blocking anything.

**Values arrive as JavaScript types that load back unchanged:**

- JSON → the parsed value.
- TIMESTAMPTZ → an ISO string with `Z` and microseconds (`"2026-03-01T07:30:00.123456Z"`).
- TIMESTAMP → an ISO string *without* an offset (`"2026-03-01T23:30:00.123456"`).
- DATE → `"YYYY-MM-DD"`.
- Integers → `number`, or `bigint` when outside ±2^53. HUGEINT (and DECIMAL(38,0)) always arrives as `bigint`.
- Other DECIMAL of up to 15 digits → `number`, which holds 15 significant digits exactly. Wider DECIMAL → its exact decimal text, as a string.

Strings are used for timestamps instead of `Date` because a pass-through `yield { ...row }` must reload as the same type. With `Date`, a naive TIMESTAMP came back as TIMESTAMPTZ shifted by 8 hours, and it lost its microseconds [V]. `new Date(row.created_at)` is one call away when code needs date arithmetic.

**Positions never skip rows.** An incremental transform's position is the composite `(_loaded_at, key)` of the last input row it fully processed. It is taken from the snapshot's own SQL values, never from a JavaScript `Date`, because a `Date` keeps milliseconds while stamps differ by microseconds; a Date-based position would re-read, and re-bill, rows already processed. The snapshot is ordered the same way, and the next run reads `_loaded_at > s OR (_loaded_at = s AND key > k)`.

Recording only "the largest `_loaded_at` consumed" would lose rows: one write gives many rows the same stamp, and merges leave rows in physical rather than stamp order. A spike that stopped after 2 of 5 rows recorded a position that skipped rows 3–5 forever [V]. Full-refresh transforms read `rows()` and keep no position, so their inputs need no key.

**When an input row counts as processed** (D72). croft cannot see which outputs belong to which input row, so a position must never pass a row whose outputs may still be pending:

- While the code runs, row n of a `newRows()` iterator counts as processed once n ≤ min(rows the code asked past, outputs it yielded while that iterator was the `newRows()` iterator it asked most recently). The usual `for await` loop yields a row's outputs before asking for the next row, so it is tracked exactly when each row yields one output, and conservatively (the position lags, and a failure re-reads rows rather than skip them) when a row yields none.
- Read-ahead (asking for rows 1–3, then yielding row 1's output) is safe when outputs are yielded in input order, at most one per row. Out-of-order results, or several outputs per row while calls are in flight, can still move a position too far.
- Once the code has finished, every row it asked past counts. A loop left early (a `break`, a throw) does not count its last row, so the next run reads it again.
- With several `newRows()` iterators on one input, the least advanced one decides the position.
- `_croft.inputs.seen_key` is a JSON array of DuckDB's own text for each key value (`CAST(k AS VARCHAR)`), cast back to the column's type when compared, so `9 < 10` for BIGINT keys. A position whose key count no longer matches the input's key compares by stamp alone, which re-reads the rows of that one stamp rather than skip any.

**Long paid transforms commit in chunks** (D67). An incremental TS transform cuts a chunk at the first `newRows()` request after the chunk holds 500 rows or has been open 60 s, and the code gets its next input row only after that commit. Only at a request are the outputs of every row up to the position known to be yielded, so the cut is exact for the usual loop; an input row that makes many output rows can grow one chunk past 500. Each chunk is its own all-or-nothing transaction: its rows, the checks on them, and its position commit together.

- Before its commit a chunk waits in `<state>/staging/_chunks/<asset>/` (NDJSON parts, `manifest.json` and `chunk.json`), outside the run's staging folder, so a later run can find it.
- A failure, a timeout or Ctrl-C loses at most the current chunk. The next run resumes from the last committed position. Rows the code yielded before it failed are not committed, so each failed attempt can re-bill up to one chunk.
- A retry, or a later run, commits a staged chunk without running the code again when the code hash, the hash of the blocking checks and the positions committed under it are unchanged, so a failed check does not re-bill the calls that produced the chunk. A chunk that a commit refused for its rows (`CHECK_FAILED`, `KEY_NULL`: anything but a busy database, an interruption, a timeout or another transient failure) is reused only while every input is still at the version it was staged from; once the user corrects the data, the code runs on it again.
- `min_rows` is checked at the run's last chunk only, when the table holds the whole run, so the first chunk of a large first build is not refused. `unique` and the other checks run on every chunk: a chunk that breaks `unique` would otherwise commit, and a forward-only transform could never undo it.
- `_croft.writes.inputs` holds each chunk's `[{input, seenBefore, seenAfter, rows}]`. Middle chunks record `input_last_loaded_at` as NULL; the final commit sets it only for the inputs read to the end (§5).
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

- A key implies `unique(key)` and `not_null(key)`, written from the key (`unique(a, b)`, `not_null(a, b)`, with odd names double-quoted) and listed first. A declared check that repeats one of them is kept once.
- "Rows written by this run" are the table's rows stamped with the write's `_loaded_at`: added and updated rows, as the table holds them after the write. Unchanged rows of a replace diff passed the same check when they were written, so they are not checked again.
- `unique` leaves out rows with a NULL in its columns, as SQL does.
- A new or edited check covers the whole table once. croft decides this against the check sources in `StepResult.checks` of the asset's last ok step (`runs.summary`); with no such step, or after a crash that left no summary, every check covers the whole table.
- Tables named in a blocking check's subquery are ordered before the asset. A warning's are not: it runs after the commit, and is skipped with an info note (`INPUT_NOT_BUILT`) while its table has not been built.
- **Every check is parsed before use.** croft serializes `SELECT (<expr>) FROM <asset>` with `json_serialize_sql` and requires exactly one statement with one select item. Identifiers are quoted with `"` escaping, and every statement croft builds runs through `prepare()`, which accepts a single statement. Concatenating a check into a multi-statement `run()` would execute an embedded `; DROP TABLE …` [V].
- **A check reads the project's tables only,** by plain name (or `main.x`). These are `CHECK_INVALID`: file paths; `_croft.*`, other schemas and catalog-qualified names ("name the table without a prefix"); a table macro whose table is a path or is computed (it must name its table directly); a path-like string given to a catalog table function; table functions that read files or run SQL given as text; functions with side effects; and parameters. Value functions such as `unnest` and `json_each` take values and never open files, so they stay valid. Every rule is vetted again on the write connection before it runs.

**Blocking checks run inside the write transaction, after the write and before commit.** A failure rolls back data, schema changes and cursor together [V]. A blocking check that cannot run (a bind or conversion error on this data) is `CHECK_INVALID`, and rolls the write back like a failure: data a check cannot vouch for is not committed.

**Warnings run after commit,** on a read lease, for every kind of asset, and are recorded. A failing warning is `CHECK_FAILED` at warning severity, and a warning that cannot run is `CHECK_INVALID` at warning severity; neither ever fails the step, whose rows are already written. A chunked TS transform does not report every stamp it wrote, so when its newest stamp does not cover all its changed rows, its warnings cover the whole table (a correct superset).

In an incremental TS transform, `min_rows` is judged at the run's last chunk (§3e).

```
$ croft run open_issues
fail  open_issues   CHECK_FAILED not_null(author): 3 of 4,211 rows
                      id=2291  title="Crash on Windows when …"  author=NULL
                      id=2307  title="bun test hangs with …"    author=NULL
                    effect: nothing was written; open_issues keeps its previous 4,208 rows
                    fix: correct assets/open_issues.sql or the data, then: croft run open_issues
exit 3
```

The message holds the summary, up to 3 sample rows, and an `also failing: …` line for each other blocking check that failed: every blocking check runs, so one failure does not hide the next.

Cross-asset checks that need their own query (for example "every open issue has a triage row" written as an anti-join) are post-v1. Most of them can be written as a row rule with a subquery, as in example (c).

---

## 4. CLI surface

### Conventions

- **JSON.** `--json` prints exactly one envelope to stdout (§4.3); progress and logs go to stderr. Output of asset code, a subprocess's included, never reaches stdout (§5, "Asset console output").
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
- **Values that start with `-`.** `--from -90d` works as written, with the space: a string option takes the next argument as its value even when it starts with `-`, unless that argument is one of the command's own flags. `--from=<value>` is needed only when the value is itself a flag name. (`node:util` `parseArgs` alone refuses `--from -90d` as ambiguous.)
- **Timestamps** in JSON are ISO-8601 *with the project offset* (for example `2026-09-21T22:00:00-07:00`), so they agree with `::DATE` in SQL. Offsets are always `±HH:MM` (§7, "Time zones"). The envelope carries `timezone`.

### 4.1 Commands (20)

| Group | Command | Purpose |
|---|---|---|
| Setup | `init [dir] [--claude] [--no-install]` | scaffold a project (or `data/` inside an existing app); `--claude` only refreshes the Claude files; inside a project, no `dir` means that project (§2) |
| | `doctor` | environment plus project summary, under 1 s, no writes |
| | `new <kind> <name>` / `new --list` | write a commented, working template. Kinds: `api [--pagination keyset\|cursor\|link\|page]`, `file`, `sql`, `transform`. Phase 5; until then the templates are the docs pages `croft docs ingest`, `croft docs sql` and `croft docs transforms` (D60) |
| | `secrets [set NAME [--stdin]]` | list declared secrets as set or missing; `set` writes `.env` from a hidden prompt or stdin |
| | `docs [topic\|ERROR_CODE]` / `docs --list` | offline docs for the installed version; the topics include `ingest` (API and file templates), `sql` (the SQL asset header, body and templates), `transforms` (TS transform templates: per-row paid, per-row, whole-table), `checks` (the check language), `scheduling`, `serve`, `read-copy`, `internals` and `config` (`croft.json`) |
| Inspect | `context` | the whole project in one payload, for agents (capped at 20 KB; `--asset` filters) |
| | `status [--check]` | freshness and health of every asset, and running runs; never waits on the database |
| | `describe <asset>` | behavior in words, columns, JSON keys, reads/read by, checks, cursor, recent writes, samples |
| | `query "<sql>"` | one SELECT against the warehouse (read-only, sandboxed); `--preview` queries what the last `croft preview` built (`.croft/preview.duckdb`) |
| | `logs [asset\|run-id] [--failed] [--runs] [--follow]` | console output and errors of a step; `--runs` lists past runs and steps |
| Try | `validate [asset…] [--types]` | static checks and a bind check of every SQL asset; never touches the warehouse |
| | `preview <asset…> [--rows N] [--rebuild]` | build in a sandbox and diff against the live tables |
| Execute | `run [selector…]` | update assets and everything downstream (flags below) |
| | `wait <run-id> [--timeout 100s]` | block until a detached run ends; exit 6 if still running |
| | `confirm <token>` | carry out a destructive action whose impact was printed (§6) |
| Maintain | `rename <old> <new>` | rename an asset: file, table and state together; lists references to update |
| | `delete <asset> [--where "<expr>"]` | move a whole table, or matching rows, to the trash (needs confirmation) |
| | `restore [asset] [--at <time>]` | list the trash, or bring a version back (needs confirmation) |
| Schedule | `schedule on\|off\|status\|pause [--for 2h]` | turn scheduled runs on or off; ticks come from the per-user OS job, or from `croft serve` while it runs (`on --no-os-job` for servers) (§8); a bare `croft schedule` is `status` |
| Serve | `serve [--host h] [--port 7447]` | optional read server for apps over HTTP, with the scheduler built in; steps aside for every write; one per project (§5) |

`croft tick` also exists as an internal command, run every minute by the per-user OS job and by `croft serve` (§8). It is not counted above and is not meant to be run by hand. It is hidden (`CommandSpec.hidden`): help, did-you-mean and SKILL.md's command list leave it out.

**Which phase ships what** (D59). `core/phase.ts` is the manifest of which command, and which `run`, `query` and `init` flag, ships in which phase (§11). The registry must register exactly the current phase's commands.

- Phase 1 has `init`, `doctor`, `docs`, `help`, `version`, `secrets`, `context`, `status`, `describe`, `query`, `logs`, `run`, `wait` and `confirm`. Phase 2 adds `validate` and `preview`. Phase 3 adds `schedule`, `serve` and the hidden `tick`. `rename`, `delete` and `restore` come in phase 4, and `new` in phase 5.
- Of `run`'s flags, `--dry-run`, `--only` and `--upstream` ship in phase 2, `--due` (hidden) in phase 3 and `--rebuild` in phase 4. `validate --hook` and `init --with-hook` are phase 5.
- `query --preview` works from phase 2 (phase 1 registered it only to refuse with a clear message). No later-phase flag is registered.
- The manifest also lists the `croft.json` keys a later phase reads (§2).
- `PHASE_COMPLETE` says whether the current phase is finished (D78). While it is false, `core/codes-raised.test.ts` lets the codes the phase lists stay unraised as its waves are built; a release requires it true.
- `phaseStub()` in `core/phase.ts` is what a module of the next wave throws (`INTERNAL_ERROR`, a message starting `PHASE_STUB`) until it is built, so builders code against final signatures in parallel.

`agent/contract.test.ts` checks every agent-facing text against the manifest and the registry: CLAUDE.md, SKILL.md, every `croft docs` page, and every string and template literal in the source (`core/phase.ts` aside), read with the TypeScript parser, since any of them can reach an agent as a hint, fix, `next[]` entry or message. A `croft <command>` must exist in this build, and a `--flag` must be an option of that command and not one a later phase adds; only a whole lower-case kebab word counts as a flag, so other programs' flags (`tsc --noEmit`) are not read as croft's. So a build's hints name only its own commands. Where the v1 text of a problem points at a later phase's command or flag (`croft restore`, `croft rename`, `croft delete`, `--rebuild` or `croft new` in phase 3, such as the `--rebuild` fixes in §8's backfill table), the build says what it can do instead, and the test's allowlist of known exceptions is empty. Since the scan reads every string, another program's long flag that croft passes is built from parts (GNU cp's reflink flag is `"-" + "-reflink=auto"` in `db/readcopy.ts`) or written short (`notify-send -a croft`), so it does not read as a croft option.

**`run` flags:**

- `--dry-run`: what would run and why, with windows and confirmations, without running. It plans exactly as the run does, reads only `runs.sqlite`, never waits and never issues a token. It exits 0 and lists the static errors that would fail steps in `problems[]` ("fails before it runs"); it exits 2 only for a project-level discovery error, as the run would. An asset under another run's live lease shows `hold: "leased"` (the real run would wait for it). The cost guard's row count is an estimate from `runs.sqlite`, over the keyed inputs the code reads with `newRows()`: an input never read counts all its rows; after a read, the rows the input's steps added and updated since the saved position, at least 1 and at most its row count. An input not built yet counts 0. When such an input is built earlier in the same run, the dry run cannot count its rows: the step's reason says it "may need confirmation", unknown until that input is built, and `next` says the run may stop to ask.
- `--only`: skip downstream. On a bare run it keeps every ingest and every transform that is stale on its own, and leaves out the transforms that would run only because an ingest runs.
- `--upstream`: also refresh, first, what the named assets need that is stale: what they read and the tables their checks read, directly or not. An ingest counts only when it was never built (a schedule that fired does not make an ingest stale; only the scheduler acts on it); a transform counts when it is stale or its own input is refreshed by the run.
- `--rebuild`: from scratch; §6 says when it needs confirmation.
- `--from <date|ISO|-90d>`: backfill a merge ingest (§8).
- `--allow-shrink`: override `SHRINK_GUARD`, with confirmation.
- `--foreground`: do not detach (§5).
- `--follow <dur>`: how long a non-TTY invocation follows a detached run before returning. The default is 100 s.
- `--no-wait`: exit 4 at once instead of waiting for a lock.
- `--events`: NDJSON progress on stderr.
- `--due`: only scheduled work that is due; used by the scheduler (hidden). `croft tick` names the due assets of one group; without names it runs what is due now, and a named asset whose file is gone since the tick is dropped. It goes with no other run flag (`USAGE_ERROR`). Its run has trigger `schedule` and `human: false`, applies the scheduler's holds (§8), and waits up to 30 min for the database lock.

`--run-id` and `--detached` are hidden options (`OptionSpec.hidden`) that the parent passes to its detached child (§5). They are parsed, but never shown in help or suggested by did-you-mean. **No option carries a confirmation token:** a destructive action runs only through `croft confirm <token>` (§6, D56).

**Bare `croft run`** fetches every ingest and updates every transform that is stale. It is the obvious "run my pipeline". Incremental ingests make it cheap. The skill tells agents to name assets when working on one of them. It also takes every asset with a static error, and every asset on a cycle, stale or not, so each fails visibly instead of being silently left out. A static error (a load error, `CHECK_INVALID`, `CYCLE`, a bind error) fails its own step before it runs, never the whole run; `CYCLE` is attached to each step on the cycle.

A named run takes the named assets, stale or not, and then (unless `--only`) every transform downstream of an asset the run takes. `RunPlan.steps` lists only the assets the run takes, in run order. The runner checks staleness again just before each transform, so one whose inputs did not change after all is skipped as `up to date: <inputs> did not change`.

- **Reshaped SQL inputs.** A run that takes an SQL asset also rebuilds first each stale SQL input it reads whose new output columns differ from its table, or that was never built (reason: `<reader> reads its new columns`), so the reader binds and reads what `validate` checked (an edit that adds a column upstream and uses it downstream). Other stale inputs still need `--upstream`.
- **Inputs never built.** A transform whose input was never built, and is not built by the run, is skipped with `INPUT_NOT_BUILT` (at warning severity here) and the fix `croft run <root input>`, which builds the input and what reads it; it never fails later with `UNKNOWN_TABLE`. The dry run says the same.

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
      Referenced column "creatd_at" not found in FROM clause.
      fix: replace creatd_at with created_at on line 9
info  INPUT_NOT_BUILT  assets/daily_revenue.sql
      columns of stripe_charges are unknown until it has run or been previewed; bind check skipped
      next: croft preview stripe_charges
1 error, 0 warnings, 1 info
next: croft validate  # re-check after the edit
```

```json
{"schemaVersion":1,"ok":false,"command":"validate","croftVersion":"0.1.0","database":"warehouse.duckdb",
 "timezone":"America/Los_Angeles","durationMs":612,
 "data":{"order":["github_issues","stripe_charges","taxi_zones","sales","issue_triage","open_issues","daily_revenue"],
   "assets":[{"name":"open_issues","kind":"sql","inputs":["github_issues","issue_triage"],"behavior":"replace; key id",
     "outputColumns":null,"codeChanged":true}]},
 "problems":[{"severity":"error","code":"UNKNOWN_COLUMN","message":"Referenced column \"creatd_at\" not found in FROM clause.",
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
fetch    github_issues    merge by id, since 2026-09-22T17:58:02Z (2026-09-22T10:58:02-07:00) = saved − 1 second
fetch    stripe_charges   merge by id, since 1756000000 (2025-08-23T18:46:40-07:00) = saved − 30 days
fetch    taxi_zones       replace; key LocationID (nothing is written when no file changed)
fetch    sales            merge by order_id, new and changed files only
rebuild  open_issues      SQL changed (assets/open_issues.sql); input github_issues may have new rows
update   issue_triage     input github_issues may have new rows (TS code unchanged)
rebuild  daily_revenue    input stripe_charges may have new rows
dry run: 7 of 7 steps would run; nothing ran
```

SQL and full-refresh TS transforms show `rebuild`, incremental TS transforms `update`. A transform downstream of an ingest the run fetches "may have new rows": a dry run cannot know that it will. An ingest's line ends with `= saved − <lookback>` when a lookback applies, including a keyed timestamp cursor's default of 1 second (§3a).

```
$ croft run
run r_0922_1015_k3f9 · 7 assets
ok       github_issues      184 requests, 18,342 rows (41.2 s) · new table, 31 columns (7 JSON)
                            added 18,342 · updated 0 · unchanged 0 · 18,342 rows now · checks 4/4 ok · since → 2026-09-22T17:58:03Z
ok       stripe_charges     12 requests, 1,130 rows (3.1 s)
                            added 1,102 · updated 21 · unchanged 7 · 1,130 rows now · checks 4/4 ok · since → 1758600000
ok       taxi_zones         unchanged · requested; files unchanged
ok       sales              1,904 rows (0.4 s) · new table, 6 columns
                            added 1,904 · updated 0 · unchanged 0 · 1,904 rows now · checks 3/3 ok
ok       issue_triage       18,342 rows (2.3 s) · new table, 3 columns
                            added 18,342 · updated 0 · unchanged 0 · 18,342 rows now · checks 4/4 ok
ok       open_issues        4,211 rows (0.1 s) · new table, 7 columns
                            added 4,211 · updated 0 · unchanged 0 · 4,211 rows now · checks 3/3 ok · 1 warning
ok       daily_revenue      812 rows (0.1 s) · new table, 5 columns
                            added 812 · updated 0 · unchanged 0 · 812 rows now · checks 3/3 ok
done 41.2 s · 6 updated · 0 failed
```

Each step shows its rows in and time, the table it created, then the write's counts, the table's rows now and its checks: blocking checks as `checks n/n ok`, and warnings that failed or could not run as `1 warning`. A step's reason follows on its own line when it says more than "requested". The run's time is its longest step's.

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
issue_triage     18,556   5 min ago    after inputs    held: code edited 12 min ago, not run by hand yet; croft run issue_triage releases it
open_issues      4,211    5 min ago    after inputs    failed: CHECK_FAILED (croft logs open_issues --failed)
daily_revenue    812      5 min ago    after inputs    ok
old_orders       120      —            —               no asset file (croft delete old_orders)
Scheduling on · last tick 12 s ago · 0 running
```

`status` exits 0 because the command itself worked; `status --check` exits 1 when anything is failed, crashed, held or stale, or the scheduler is stale, which makes it a health probe. In JSON, `ok` always means "the command worked", and `data.healthy` carries health.

The NEXT column of a scheduled ingest reads `every hour (off)` while scheduling is off and `paused` while it is paused. The last line reads `Scheduling paused until 14:00 · …` during a pause, and `Scheduling on · last tick 14 min ago (stale) · …` when the scheduler has stopped ticking, with the tail of the tick log under it. A running `croft serve` ends the line: `· croft serve http://127.0.0.1:7447 (pid 4121)`.

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

$ croft serve
croft serve · http://127.0.0.1:7447 · database warehouse.duckdb (read-only, steps aside for writes)
token: .croft/serve.json (hosted apps: set CROFT_SERVE_TOKEN)
scheduler: on, ticking every minute
apps: import from "@zabaca/croft/read" in this project, or set CROFT_URL + CROFT_SERVE_TOKEN
^C to stop

$ croft schedule on
Scheduling is on for ~/my-data (one job per user; checked every minute; survives restarts).
Waiting for the first tick… ok (after 38 s)
  github_issues   every hour   0 * * * *   next 11:00
  stripe_charges  every hour   0 * * * *   next 11:00
  taxi_zones      monthly      0 0 1 * *   next Oct 1 00:00
Turn off: croft schedule off

$ croft schedule status
Scheduling on · ticks from the per-user OS job · last tick 12 s ago
Job: launchd dev.croft.tick · installed, loaded · bun /Users/ana/.bun/bin/bun
ASSET           SCHEDULE      CRON        NEXT          LAST FIRE     STATUS
github_issues   every hour    0 * * * *   in 55 min     10:00         —
stripe_charges  every hour    0 * * * *   in 55 min     10:00         —
taxi_zones      monthly       0 0 1 * *   Oct 1 00:00   Sep 1 00:00   —
sales           manual        —           —             —             —
issue_triage    after inputs  —           —             —             held: code edited 12 min ago, not run by hand yet; croft run issue_triage releases it
open_issues     after inputs  —           —             —             —
daily_revenue   after inputs  —           —             —             —
```

`croft serve` stops on SIGINT, SIGTERM or SIGHUP with `croft serve stopped (SIGINT)` and exit 0, the normal way to stop a server (a second signal during the shutdown exits 130). A server not bound to loopback adds a line: `not loopback: put an HTTPS reverse proxy or tunnel in front of <address> (it must send Host: 127.0.0.1:7447)`, and, with a generated token, asks for `CROFT_SERVE_TOKEN` in `.env`, since hosted apps need a token that does not change on every start. With scheduling off, the scheduler line says how to turn it on (`croft schedule on`, or `croft schedule on --no-os-job` on a server).

`croft schedule on` with `--no-os-job` says "ticked by croft serve only (no OS job): nothing runs on a schedule while croft serve is stopped", and whether a `croft serve` is running. The STATUS column of `croft schedule status` shows `due: fired at 11:00` (or `due: fired at 11:00; 3 missed fires run once`), `held: …` for a hold a person must lift (the scheduler only runs code a human has run, §6), or the hold that passes by itself (`leased`, `paused`, `backoff`).

### 4.3 The JSON contract

**The envelope** is `{schemaVersion: 1, ok, command, croftVersion, database, timezone, durationMs, data, problems[], next[], confirmation?}`.

- `ok` means the command itself did what it was asked. For `run`, it is false when any asset failed.
- A **problem** has `severity` (`error` | `warning` | `info`), `code`, `message`, `hint` and `docs`. Where they apply it also has `asset`, `file`, `line`, `column`, `runId`, `fix`, `effect`, `retryable` and `details`.
- `fix` is one of:
  - `{kind: "edit", description, file, line?, replace?: {from, to}, insert?}`
  - `{kind: "command", description, command, requiresHuman?}`
  - `{kind: "manual", description, requiresHuman?}`
- `next` is `[{command, reason}]`. **A destructive command never appears in `next`.** It appears only as `confirmation: {token, expiresAt, command, impact}`.
- When output redaction (§9.6) changed a value inside `data`, `data` carries `redactedValues: true`, so the reader knows values were altered. `run` and `preview` declare every secret the project's assets declare, not only those of the planned assets: the planned assets' loaded specs, plus the literal `secrets: [...]` and `secret("…")` names of every TS asset file, read without importing it.

**Data shapes** are frozen by golden tests and published as JSON Schemas. `croft serve` returns the same envelopes over HTTP (§5).

- **`query`:** `{columns: [{name, type}], rows, rowCount, truncatedRows, truncatedValues}`. HUGEINT, DECIMAL and integers beyond ±2^53 are strings, inside JSON columns too. A number in a JSON column that DOUBLE cannot hold (`1e400`) keeps its source text. `--limit N` and `--full-values` lift the caps. Over HTTP (`croft serve`), `data` is `{columns, rows, rowCount, tookMs}`, never truncated, with `stale: true` and `asOf` when the answer came from the read copy (§5). `tookMs` counts from the request's arrival, queue wait included.
- **`run` / `wait`:** `{runId, status: running|succeeded|failed|crashed|interrupted, progress?: {asset, phase: extract|write|checks, rowsFetched, requests, elapsedMs}, steps: StepResult[]}`. A StepResult has:
  - `asset`, `status` (`ok`|`failed`|`skipped`|`unchanged`), `reason`, `skippedBecause?`
  - `behavior`, `attempt`, `maxAttempts`, `nextRetryAt?`
  - `rows: {in, added, updated, unchanged, deleted, total}`
  - `schemaChanges[]`, `cursor?: {before, after, sinceUsed}`
  - `inputs?: [{input, seenBefore, seenAfter, rows}]`: for an SQL step, `seenAfter` is the input's `last_loaded_at` as read inside the step's own transaction and `rows` its row count; for a TS transform, the position reached. The same list goes to `_croft.writes.inputs`.
  - `requests?`, `checks[]`, `trashed?: {path, rows}`, `logsCommand`, `durationMs`, `error?`
  - `created?: {columns, jsonColumns}` when the step created the table (the source of "new table, 31 columns (7 JSON)" in §4.2), and `csvHeader?` on a CSV ingest's first load (§3b)
  - `skippedBecause` says why a step did not run: `input X failed (r_…)` or `input X is waiting for confirmation c_…` for a direct input, and `input Y was not built: <why>` for one further up. A transform found fresh on the runner's re-check is skipped with `up to date: <inputs> did not change`. Skips caused by an input are recorded in `runs.sqlite` (attempt 0, status `skipped`), so `status` shows them; the others are not.
- **`confirm`:** `{token, command, result, outcome: used|not_needed|unused|running, note?}`. `result` is the confirmed command's own `data` (`null` in human mode, where its output passes through as is), and its problems, `next`, confirmation and exit carry over to the envelope. `outcome` says what became of the token (§6).
- **`status`:** `{healthy, running: [{runId, asset, pid, since, phase, rowsFetched}], assets: [{asset, kind, file, status, rows, lastRun: {runId, at, status, code}, next: {at, reason, schedule?}, stale, staleReasons[], held, hold?: {code, reason}, edited, filesGone?, schemaChangedAt?}], scheduling: {state: "on"|"off"|"paused", via: "os-job"|"serve"|null, lastTickAt, stale?, pausedUntil?}, serve?: {url, pid}}`.
  - `scheduling.stale` is present only while scheduling is on, and `pausedUntil` only while it is paused, so the off shape stays `{state: "off", via: null, lastTickAt: null}`.
  - `next.reason` is `schedule` (at the next fire, while scheduling is on), `scheduling off` or `paused` (a scheduled ingest the scheduler does not run now), `manual` (an ingest without a schedule), `after inputs` (a transform) or `none` (no asset file); `next.schedule` is the ingest's schedule as written.
  - `hold` says why the scheduler does not run the asset now, while scheduling is on or paused: `SCHEDULE_HELD`, `LARGE_REPROCESS`, `leased`, `paused` or `backoff`. `held` is true only for the holds a human must lift (`SCHEDULE_HELD`, `LARGE_REPROCESS`), and makes `healthy` false.
  - `problems[]` add one `SCHEDULE_HELD` warning per human-held asset, with the fix `croft run <asset>`, and `SCHEDULER_STALE` (details `{cause, via, lastTickAt, quietForMs, logFile, logTail}`) when the scheduler stopped ticking (§8).
  - Over HTTP (`GET /status` of `croft serve`), `serve` also carries `{host, port, version, startedAt, engine}`, the server's own state (§5).
  - An asset's `status` is `ok`, `failed`, `crashed`, `interrupted`, `running`, `skipped`, `never_run`, `no_asset_file` or `unknown`. `unknown` means it was built before but the warehouse file is missing; `rows` is then `null`, as it is for an asset never built.
  - When the catalog lists tables but the database file is missing, `status` reports `DB_NOT_FOUND` with `healthy: false`, and `context` carries the same problem and the same `unknown` assets. Both check the file with a `stat`, without opening DuckDB (§3b gives the wording).
  - `edited` means the code hash now differs from the hash of the code the asset's last run used (the step's, else the catalog's); the file's modification time decides only when a hash is unknown, so touching a file or editing a comment is not an edit. A skipped step (its input failed, it stopped for a confirmation, it was held) never ran the code, so it does not clear an edit. An edited asset whose table older code built also gets `EDITED_SINCE_LAST_RUN` in `problems[]`, worded per kind (§8).
  - `next[]` suggests `croft run --dry-run` when assets are stale for a reason other than `never_built`.
- **`describe`:** `{asset, kind, file, next, schedule, behavior: {words, write, key, incremental: {kind, field, cursorValue, cursorType, unit, lookback}}, reads, readBy, columns: [{name, type, pinned, pending, sourceName, format, addedAt, jsonKeys, kinds}], inputsSeen: {input: {seenLoadedAt, inputLastLoadedAt, pendingRows, readInFull?}}, builtWithCodeHash, checks, recentWrites, samples}`. `next` has `status`'s shape. `schedule` is `{text, cron, nextFires, lastFireAt, lastAttemptAt, scheduling, pausedUntil?}` for an ingest with a schedule, and null otherwise: `nextFires` are the next three fire times in the project zone, which happen only while `scheduling` is on. In `inputsSeen`:
  - `seenLoadedAt` is the stamp of the transform's composite position; declared inputs it has not read yet appear with `seenLoadedAt: null`.
  - `inputLastLoadedAt` is the input's version when the transform last read all of it (null until then): the value staleness compares, the same as `_croft.inputs.input_last_loaded_at` (§5). It is not the input's current version.
  - `pendingRows` counts the input rows after the composite position `(seen_loaded_at, seen_key)`, the count `newRows()` and the cost guard use. It is null when unknown (no table, no `_loaded_at` column) or when `describe` fell back to the catalog mirror.
  - `readInFull: true` marks a lookup of an incremental TS transform: an input its code reads only with `rows()`, never with `newRows()`. It is read in full each run, so its `pendingRows` is 0, even when the warehouse is busy.
- **`validate`:** `{order, assets: [{name, kind, inputs, outputColumns: [{name, type}] | null, behavior, codeChanged, schedule?: {text, cron, next}}], types?: {status: ok|failed|skipped, errors}}`. `outputColumns` comes from `prepare()`. `schedule` is a scheduled ingest's, with `next` its next three fire times (ISO with the project offset); the human output adds one line per scheduled ingest: `<asset>: <text> (cron <cron>); next <date time>, <time>, <time>`. `inputs` joins the unoptimized plan's scans to each asset's AST inputs, and `order` comes from the graph rebuilt with them. `types` is present with `--types`. `next[]` is `croft validate` after an error or a fixable warning, otherwise `croft preview <assets whose code changed>`, and `croft docs ingest` in a project with no assets.
- **`preview`:** `{assets: [{asset, kind, status: ok|failed|skipped, reason, rows, liveRows, partial, capped, requests?, since?, diff: {by, added, removed, changed, unchanged} | null, columns: [{column, change: added|removed|retyped, type, from?, note?}], checks, sample, downstream, durationMs, error?}], partial, inputsSnapshotAt, rebuild, rowCap}` (§6). A CSV ingest's header decision is in its `reason` ("CSV header: first line (detected): …").
- **`run --dry-run`:** `{dryRun: true, order, steps: [{asset, file, kind, action: fetch|rebuild|update|skip, reasons, reason, behavior, hold?, skippedBecause?, window?: {sinceValue, sinceType, sinceAt?, source: saved|from, saved?, lookback?}, confirmation?: {action: allow_shrink|large_reprocess, command, impact}, problems}]}`. `problems` are the static errors that would fail the step before it runs.
- **`context`:** `{project, assets: [compact describe], running, held, recentFailures, recentSchemaChanges: [{asset, at, runId, kind, column, from, to, readBy}]}`, capped at 20 KB with `truncated: true`. A compact asset carries `staleReasons`, and `edited: true` when it applies. `recentSchemaChanges[].readBy` lists the assets that read the changed asset (asset level, not column level). `problems[]` hold each asset's load and `CHECK_INVALID` problems and `EDITED_SINCE_LAST_RUN`. `project.scheduling` has `status`'s shape; a compact asset carries `schedule?`, `nextFireAt?` and `hold?`; `held` lists the assets held until a human runs them; and `problems[]` add `SCHEDULER_STALE` and `SCHEDULE_HELD` as in `status`.
- **`schedule`:** `{action: on|off|pause|status, root, scheduling, job: {kind: launchd|crontab, label, file, installed, loaded, bun, bunExists, bunStable?, changed?, removed?} | null, registry: {file, projects, osJob} | null, serve: {url, pid} | null, firstTick?: {ok, at, waitedMs, alreadyTicking?} | null, assets: [{asset, kind, schedule, cron, nextFireAt, lastFireAt, lastAttemptAt, due, dueReason, held}], assetsUnavailable?}`. `scheduling` has `status`'s shape. `assets` holds the scheduled ingests and the held assets after `on`, every asset for `status`, and none after `off` and `pause`; `held` is `{code, reason}` or null. `firstTick` is null with `--no-os-job`, where nothing is waited for.
- **`serve`:** one envelope when the server starts, `{url, host, port, pid, loopback, database, startedAt, version, token: {source: CROFT_SERVE_TOKEN|generated, from: .env|env|null, file}, scheduling: {state, via, pausedUntil, tickEveryMs}, stopped: null}`, and nothing more when it stops (exit 0).
- **`tick`** (internal): `{exited: null|scheduling_off|paused|another_tick, heartbeatAt, spawned: [{runId, assets}], held: [{asset, code, reason}], importedAssetCode, tookMs}`.
- **Error `details`:**
  - `HTTP_ERROR`: `{method, url (redacted), status, attempts, retryAfterMs, requestIndex, rowsBeforeError}`
  - `TIMEOUT`: `{phase, rowsSoFar, lastRequest}`; over HTTP, `{phase: "query", timeoutMs}`
  - `SERVE_UNAVAILABLE`: `{reason, retryAfterMs, …}`. `reason` is `write` (a writer holds the file, or the query was stopped for one after the grace; with `writeIntent`), `busy` (every slot stayed full, or 64 queries already wait), `restarted` (its query worker was killed to end another query, or crashed), `unavailable` (the file cannot be opened: a GUI holds it; the holder is named) or `stopping` (§5)
  - `QUERY_TOO_MANY_ROWS` over HTTP: `{limit, maxRows}` when `limit` asked for more than `serve.maxRows` and the result passed `maxRows`; the hint then says to page
  - `TYPE_CONFLICT`: `{column, existingType, incomingKinds, badRows, samples, readBy}`, plus, where they apply, `sourceName`, `storedType` (the same as `existingType`), `incomingType` (the type the incoming values would get in a new column), `incoming` (the same as `incomingKinds`), `conflictKinds` (the kinds that do not fit), `format` (file ingests) and `fixes` (every fix, in order; `fix` is the first). The duplicate names are kept for readers of the earlier ones.
  - `CHECK_FAILED`: `{check, failing, sample, checked, scope}`, and for a blocking failure `results` (the result of every blocking check). `failing` counts, per kind: the rows that fail (`not_null`, rules), the rows that share their values with another row (`unique`), or the rows missing (`min_rows`). `checked` is the rows in scope, and `scope` is `batch` or `table`. `sample` holds up to 20 rows.
  - `QUERY_FAILED`: `{duckdb, duckdbErrorType}`. `QUERY_FAILED` is any error DuckDB raised while binding or running a user query (Binder, Catalog, Conversion, Invalid Input, Out of Range, IO, …), and `duckdbErrorType` names the kind. `SQL_SYNTAX` is only for parser errors, and a missing table or column is still `UNKNOWN_TABLE` or `UNKNOWN_COLUMN`. In an SQL asset, a missing column named through a table (`g.x`: DuckDB's Binder Error "Table "g" does not have a column named "x"", with candidate bindings [V]) is `UNKNOWN_COLUMN` too.
  - `ASSET_CODE_ERROR` raised through `fail()`: `{requestedCode}` (§10, "Public types")

**Exit precedence:**

- 130 when interrupted, then 6 while still running.
- 3 only when every failure is `CHECK_FAILED`.
- 1 when any failure has exit 1. `CHECK_FAILED` together with other failures is also 1, unless every other failure is a coordination (exit 4) or safety (exit 5) outcome; then the highest of those is used, because "retry later" and "ask a human" still hold.
- Otherwise the highest exit among the failures (2 < 4 < 5).
- 5 when the only outcome is a pending confirmation.

---

## 5. Runtime architecture

### Processes

No process ever owns the database for writing, and there is no write daemon. Five kinds of process exist:

1. **Short-lived CLI invocations.**
2. **Detached runs.** Off a TTY, `croft run` always executes in a detached child process (`detached` + `unref`; a child outlived its parent and was reparented [V]). The invoking process follows the child's events for `--follow` (default 100 s) and prints the result if the run finished. Otherwise it returns exit 6 with the run id. Build: once the child has recorded its finished run, the parent lets it exit (up to 3 s) before returning, because the child closes the warehouse last (a checkpoint), and the next command otherwise saw the file change or waited on its lock.
   - This keeps every run from being killed by Claude Code's shell timeout (120 s by default, 600 s at most). A killed run would lose all extraction work.
   - On a TTY, runs stay in the foreground, and `--foreground` forces that off a TTY too.
   - The run folder `<state>/logs/<run>/` holds, besides the step logs, files whose names start with `_` (which no asset name can): `_process.log` (the child's own stdout and stderr, created with mode 0600; everything in it is redacted, including subprocess output that reaches it through the fd capture below), `_process.json` (the spawn handshake: the child's pid, start time and boot id, written by the parent), and `_not_started.json` (the problem of a child that refused to start, such as a `--from` that cannot apply, §8).
   - `croft wait` for a child that died before it recorded its run (kill -9, OOM, a reboot during a slow import) reports it `crashed` (exit 1, `RUN_CRASHED`) from the handshake, never "still running" forever.
   - A live run writes its progress `{asset, phase, rowsFetched, requests, elapsedMs}` to `runs.summary.progress` at most every 500 ms (and what changed inside a window at its end), which `status` and `context` show as `running[]`; the finished run's result replaces it.
3. **The per-user scheduler job** (§8). Every minute it starts the project-pinned `croft tick` for each registered project that has scheduling on, and that tick spawns `croft run --due` for due work.
4. **`croft serve`** (optional), a long-running *read* server with the scheduler built in (§5, "Server mode"). It answers app queries over HTTP and steps aside whenever a run writes. It spawns a fresh `croft tick` subprocess once at start and then every minute (skipping a minute while the previous tick still runs), and never ticks in-process. An in-process tick would keep stale `lib/` code, because a cache-busted `import()` does not re-import dependencies [V], and it would risk a second database instance in one process.
   - **Its query worker.** croft serve itself opens no DuckDB file. It holds the warehouse in a query worker, a child process it spawns and kills (`serve/worker.ts`, spoken to over Bun's IPC channel), and while a writer holds the live file with `readCopy` on, a second worker serves the read copy (D76). A worker exits by itself when croft serve goes away (the IPC channel closes, or it is reparented), and ignores terminal signals.
   - Each tick runs as `<bun> --no-env-file <croft's bin> tick` in the project folder, detached, with the server's environment minus `CROFT_SERVE_TOKEN` and `CROFT_CONFIRM_GRANT`, its output appended to `<state>/logs/tick.log` (mode 0600, one header line per tick, moved to `tick.log.1` past 5 MB).
5. **Subprocesses spawned by a tick** (`croft run --due`), which do the scheduled work.

Each command imports asset files fresh, so edits are always picked up. Each TS file is imported in isolation, so one broken file fails only its own asset. With selectors, a TS file whose text calls only `ingest()` is imported only when it is selected or needed before the selection, so `croft run x` never runs the top-level code of unrelated ingests; SQL files and possible transforms are always loaded, since the graph needs their inputs.

**Asset console output.** Asset code runs in croft's own process, so its `console.*` (and direct `process.stdout`/`process.stderr` writes) would otherwise land on croft's stdout, breaking the one `--json` envelope and printing secrets unredacted. Inside a run, top-level output of an asset (collected while it is imported) and everything `rows()` and `map()` print, however deep their async work goes (an `AsyncLocalStorage` scope per step), go to that step's log, redacted like every log, which `croft logs` shows. Commands that only import assets (`query`, `describe`, `context`, `secrets`) print top-level output on stderr, prefixed with the file and redacted. Output that escapes any scope goes to stderr, redacted; never to stdout.

**Capture at the file descriptors** (D62). A subprocess (Bun Shell `$`, which prints by default; `Bun.spawn` or `child_process` with inherited stdio) and `Bun.write(Bun.stdout)` write to fds 1 and 2 directly, past `console` and `process.stdout`. So while asset code runs:

- fds 1 and 2 point at an unlinked temporary file (`dup2` through `bun:ffi`, since Bun has no `dup2` of its own). A file, not a pipe, so a write to it never blocks.
- croft writes its own output (the envelope, progress) to close-on-exec duplicates of its real stdout and stderr, so no subprocess inherits them.
- croft reads the file back every 50 ms, when a capture ends and at exit, in whole lines. Captured output goes to the running step's log when exactly one step runs, and otherwise to stderr, redacted.
- The CLI and the detached child keep the capture on until exit once asset code has run, so a subprocess that outlives its step cannot reach stdout either.

So Bun Shell's `$` needs no `.quiet()` inside an asset: its output, and that of `Bun.spawn` with inherited stdio, goes to the step log, redacted. The limits: output from concurrent steps is not attributed to a step; a partial line is held until a newline arrives, its step ends or 64 KB build up; a native crash can lose the last ~50 ms of output; and there is no capture on Windows (or where `bun:ffi` cannot load libc).

**Signals.** SIGINT and SIGTERM abort the run's `AbortSignal`. The in-flight step is recorded as `interrupted` (its transaction, if any, is discarded), and the process exits 130.

### Owning the DuckDB file

**In every process that runs user code, the warehouse file is open only while DuckDB itself is working.** It is never open while user code or the network runs. The one long-lived holder is `croft serve`'s query worker, which runs no user code, holds the file read-only, and is killed for every write (Server mode, below). Releasing the file by ending the process (`SIGKILL`) lets the kernel drop its locks however DuckDB's objects stand, so the lock-held-after-close hazards below cannot keep a writer out of serve's file. The measured facts behind this:

- Opening, querying and closing a file with 1–2M rows costs 3–6 ms [V].
- `closeSync()` releases the OS lock at once, and a waiting process got the file about 57 ms later [V].
- A read-write holder blocks every other process, readers included. A read-only holder blocks writers. Read-only holders can coexist [V].
- The lock error names the holder: `Conflicting lock is held in /opt/homebrew/bin/duckdb (PID 812)` [V].

**The owning process must never touch the warehouse file any other way.** DuckDB's cross-process lock is a POSIX `fcntl` lock, and such locks belong to the *process*: closing *any* descriptor on the file releases them. The measured hazards, and what is safe:

- **Two instances on one file.** Two `DuckDBInstance`s opened on the same file inside one process both succeed, and data is lost on reopen. A spike wrote 1,000 + 500 + 100 rows through two instances and reopened to 1,100 [V].
- **A second read-only instance.** Opening and then closing a read-only instance on the same file in the same process released the first instance's lock, and another process then opened the file read-write and wrote to it [V].
- **Plain file descriptors.** `fs.openSync` + `closeSync` on the warehouse (for example to hash it or read its size) released the lock the same way [V].
- **realpath.** Under Bun on macOS, `fs.realpathSync` and `realpathSync.native` open the file (open + `F_GETPATH`), and closing that descriptor released the lock the same way [V]. croft resolves file paths with `lstat` and `readlink` instead (`physicalPath` in `project/root.ts`).
- **What is safe.** `statSync`, `lstatSync`, `readlinkSync`, realpath of a *directory*, and APFS `copyFile(…, COPYFILE_FICLONE)` did not release the lock [V].

The rules that follow from these:

- `db/warehouse.ts` obtains instances only through `DuckDBInstance.fromCache(path)`, which returns the same instance for the same file, including via realpath and case-variant paths [V]. It always uses one configuration, because a different configuration for a cached path is refused [V]. croft computes the canonical path itself without opening the file (`canonicalPath` in `db/connect.ts`: `lstat`/`readlink`, the native realpath of the parent directory only, and the directory entry's own spelling for case variants).
- croft never opens the warehouse with `fs` APIs or with a second instance, and never `ATTACH`es it from another database, while it may hold it.
- File copies of the warehouse (the read copy, pre-upgrade backups) are made by a **child process** while croft holds the write lease. A child's descriptors cannot release the parent's locks.
- `validate` rejects asset or `lib/` code that imports `@duckdb/node-api`, `@duckdb/node-bindings` (and its per-platform `@duckdb/node-bindings-*` packages), `duckdb`, `duckdb-async` or `@zabaca/croft/read`, with `ASSET_OPENS_DATABASE` and the fix "use `ctx.query()`". Such an asset is still bundled for its code hash but is never imported. Ingests and transforms both have `ctx.query()` for read-only lookups.
- `@zabaca/croft/read` also refuses to open a second instance. `db/warehouse.ts` registers every open warehouse by canonical path in `globalThis[Symbol.for("croft.warehouses")]` (and the latest in `Symbol.for("croft.warehouse")`). If a croft runtime in the same process holds the *same* file, the query runs through its current lease; a runtime registered for a different file is ignored, because routing through it would read the wrong database.
- A test opens a second read-write instance in the same process and asserts that croft refuses.

**Leases.** `warehouse.read(fn)` and `warehouse.write(label, fn)` open the file on demand and close it 100 ms after the last lease ends. Each process picks one access mode for its whole life, because a cached path cannot be reopened with another configuration:

- Processes that write (`run`, `confirm`, `delete`, `restore`, `rename`, and `init` when it runs the example) use read-write, even for their read leases. They always create a write intent first (Server mode, below).
- `query`, `describe`, `preview`, `doctor`, `tick` and `croft serve`'s query worker use read-only, and never create an intent. `tick` opens the file only when its `reconcile()` must check a crashed step against it. `doctor` does not open the file at all while a live intent exists (§2). `preview` opens its own `.croft/preview.duckdb` read-write, with no write intent, for the whole preview, so two previews, or a preview and `croft query --preview`, take turns.

- **Lock conflicts** are retried with jittered backoff (25 ms up to 1 s). After 2 s the holder is printed. It is one of: croft's own run, from `runs.sqlite` (for example "croft run r_…, writing daily_revenue, 8 s"); `croft serve`, recognized by the PID in `serve.json` or as its query worker ("croft's read server (pid 4121) has not stepped aside", with the worker's PID; the build keeps the phase-1 name, §2); or a foreign program (`DB_HELD_BY_OTHER_PROGRAM`).
- **Default waits.** Off a TTY every wait is capped at 90 s, then exit 4 with the holder, so a wait never outlives the agent's shell. On a TTY: 60 s for `query`/`preview`/`describe` and 10 min for run writes. Scheduled writes wait 30 min. `--no-wait` exits 4 at once. Ctrl-C (the run's `AbortSignal`) ends a lock wait, or a write queued behind this process's own write, at once with `INTERRUPTED` (exit 130). A lease that already holds the file is never cut; the ingest body refuses further statements instead.
- **Fairness.** A writer that sees registered waiters yields for 200 ms between write steps.
- **Asset leases** in `runs.sqlite` guarantee that only one run touches an asset at a time. A manual `croft run x` while the scheduler runs `x` waits for the lease, or exits 4 with `ASSET_BUSY` naming the run. A tick skips leased assets, and they stay due. A lease records the PID, the process start time and the boot id (`kern.boottime` or `/proc/sys/kernel/random/boot_id`). It counts as dead when the boot id differs or the start time does not match, because PIDs are reused after a reboot and a PID check alone could leave an asset busy forever.

**One connection factory.** Every connection croft opens goes through a single factory. This covers the warehouse, the preview database, a TS transform's private in-memory database, and `@zabaca/croft/read`. The factory sets the project time zone and applies the sandbox. `TimeZone` is a per-connection setting [V], and a connection that skipped it would put rows into different days.

**Sandboxing every DuckDB instance.** Every instance is created with `autoinstall_known_extensions = false`, `autoload_known_extensions = false` and `allow_community_extensions = false` [V]. Otherwise DuckDB would download and load native extensions from the network on demand, and croft promises never to install anything. The first connection to a fresh instance runs `SET GLOBAL TimeZone` (and, for `croft serve`, `memory_limit` and `threads`), then the statements below. `lock_configuration` is instance-wide and refuses every later `SET`, a per-session `SET TimeZone` included, so the zone is set globally before locking and every later connection inherits it [V]. Later connections check that the instance carries the same sandbox. `allowed_directories` cannot be passed as an instance option ("Failed to set config"), so these have to be `SET` statements [V]. `croft query` instances allow only `files/`, and a project path outside it gets `QUERY_PATH_DENIED`. `croft query --preview` is the exception: the preview's views read Parquet snapshots in the state folder, so its connection uses the warehouse sandbox (`files/` and the state folder), while the gate, with the state folder protected, still refuses any state-folder path in the SQL text. The run's warehouse instance allows only `files/` and the state folder, not the directories of declared file ingests: files are loaded from their snapshots under the state folder (§3b), so a `file: "*.csv"` ingest never opens the whole project folder to SQL.

```sql
SET allowed_directories = ['<project>/files', '<project>/.croft'];
SET enable_external_access = false;
SET lock_configuration = true;
```

After this [V]:

- Tables query normally.
- `read_csv` inside allowed directories works.
- Staging reads, trash `ATTACH`es under `.croft/`, and spilling large sorts to disk all keep working.
- `COPY … TO` the warehouse path fails with a Permission Error.
- `read_text('.env')` fails, so SQL cannot read secrets. This holds only because the state folder, which the warehouse connection allows, never holds the project folder; `croft.json` validation enforces that (§2).
- Reading `/etc/hosts` or an `https://` URL fails.
- Re-enabling either setting fails ("the configuration has been locked").

This matters because a READ_ONLY connection is not safe on its own: `COPY (SELECT 1) TO '<warehouse path>'` on a read-only connection overwrote the warehouse with a 4-byte CSV that no longer opened [V].

A second rule covers the rest. **All user-authored SQL must be exactly one SELECT.** Two tests must both pass:

- `extractStatements` returns one statement.
- `json_serialize_sql` succeeds on it. It only accepts SELECT forms; `DESCRIBE`, `SUMMARIZE` and `SHOW` also pass [V]. This applies to `query`, SQL assets, checks and `ctx.query`. It matters because sandbox settings alone do not stop `DETACH` followed by a read-write `ATTACH` of an already-permitted path [V].

**The gate also walks the AST** (`sql/gate.ts`), because a SELECT can still do harm. DuckDB's sandbox always lets a connection read its own database file, its WAL and its `.tmp` folder, even outside `allowed_directories`, and a second descriptor on the warehouse drops the process's lock (above).

1. **Paths.** Every path a query names (`read_*`, `glob`, `sniff_csv`, `parquet_*`, `read_duckdb`, a replacement-scan table name such as `FROM 'files/x.csv'`, a `histogram()` table) must be a string literal. The gate resolves it the way `open(2)` will: symlinks, `..` after a symlink, `~`, `file://`, and globs expanded through DuckDB's own `glob()`. It refuses the attached databases, their WAL and temp files (also by inode, which catches hard links), paths the caller protects, and anything outside `allowed_directories`, with `QUERY_PATH_DENIED`. Callers that run user SQL on a warehouse or memory connection protect the state folder, so SQL reaches neither `runs.sqlite` nor `serve.json`.
2. **Table functions are an allowlist** of every table function and table macro of DuckDB 1.5.5, classified; a test fails when DuckDB ships one that is not listed, and until then the gate refuses it. Those with side effects are refused: `enable_logging` (which changed the whole instance even on a locked READ_ONLY connection [V]), `checkpoint`, the profiling and PEG-parser switches, and `arrow_scan`. So are those that run SQL or name a table given as a string, which the walk cannot see (`query`, `query_table`, `json_execute_serialized_sql`). All of these get `QUERY_NOT_SELECT` (`SQL_NOT_SELECT` in SQL assets), as does the scalar `write_log`.

Paths are checked just before DuckDB opens them, not atomically. A macro or view created in the warehouse outside croft can shadow a built-in name; the gate trusts the warehouse's own catalog.

**Errors from user queries.** A parser error is `SQL_SYNTAX`. A missing table or column is `UNKNOWN_TABLE` or `UNKNOWN_COLUMN`. Any other error DuckDB raises while binding or running the query is `QUERY_FAILED`, with `details.duckdbErrorType` naming the kind (§4.3). DuckDB's own "Did you mean" can name a system view (`pg_constraint` for an unrelated name) [V], so croft's `UNKNOWN_TABLE` suggests only the project's asset names.

### One ingest step, end to end

```
1  plan         staleness from the runs.sqlite mirror, confirmed under a short read lease
2  extract      NO database lock. Generator → .croft/staging/<run>/<asset>/part-NNNN.ndjson (50k rows/part).
                The writer canonicalizes JSON (object keys sorted, bigint as raw digits) so unchanged rows
                compare equal. It cleans and case-resolves column names (§7) and renames source columns
                called _loaded_at/_file. It throws ROW_NOT_OBJECT for non-object rows and
                UNSERIALIZABLE_VALUE (row, field, type) for Map, Set, typed arrays, functions, NaN and
                ±Infinity, which JSON.stringify would silently turn into {} or null, and also for
                RegExp, Error, Promises and thenables (hint: a missing await), WeakMap/WeakSet/WeakRef,
                invalid Dates, circular references and strings with unpaired surrogates (read_json
                rejects them). A top-level undefined counts as absent; a nested one is omitted from
                objects and becomes null in arrays, as in JSON. JS tracks top-level keys, row counts
                and unsafe-integer warnings.
                manifest.json is written last. Up to 4 extractions run concurrently ("concurrency").
3  write lease  write intent created, RW open, in-process write mutex, BEGIN
   a  stage     CREATE TEMP VIEW raw AS SELECT * FROM read_json(parts, columns = {every key: 'JSON'})
                (a view, not a table: inside the write transaction DuckDB scanned a table created by
                the same transaction about 4.5× slower, 1247 ms vs 417 ms for 1M × 5 [V]);
                every row carries a _croft_seq in yield order; the real table schema is read from
                duckdb_columns(), and a mismatch with _croft.columns is TABLE_MODIFIED_OUTSIDE_CROFT
   b  classify  per column: counts by json_type + string sub-kinds (ISO instant / naive / date) (§7)
   c  plan      compare with _croft.columns and pins → add / widen / keep / TYPE_CONFLICT
   d  cast      typed temp table with explicit, whitelisted casts (§7)
   e  verify    round-trip loss check: no value may change when cast back and compared (§7)
   f  dedupe    by key: highest cursor, then highest _croft_seq (last yielded), wins. KEY_NULL is
                checked on the batch before anything is written. (A transform never dedupes: a
                duplicate key in its batch is CHECK_FAILED unique(key), D65)
   g  evolve    ALTER TABLE ADD COLUMN / ALTER COLUMN TYPE (DDL is transactional [V]). All DDL on a table
                comes before any DML on it in the same transaction: DELETE or UPDATE followed by ALTER
                failed at COMMIT ("another transaction has altered this table") [V]. A file reload
                therefore computes its batch, ALTERs, and only then writes its diff.
                The Sql wrapper tracks touched tables per transaction and throws DDL_AFTER_DML at the
                offending statement, not at COMMIT; restore uses CREATE OR REPLACE ... FROM trash.
                That guard lexes the whole statement and normalizes names: t, main.t and <db>.main.t
                are one table, and temp.main.t is another, which shadows t and main.t while it exists
   h  guards    SHRINK_GUARD, before the DML, from the deduplicated source count (for a replace,
                that is the table's total after the write)
   i  write     replace: MERGE … WHEN MATCHED AND <row differs> THEN UPDATE
                         WHEN NOT MATCHED THEN INSERT  WHEN NOT MATCHED BY SOURCE THEN DELETE   [V]
                         (without a key: the content diff below)
                append:  INSERT BY NAME
                merge:   MERGE … WHEN MATCHED AND <row differs> THEN UPDATE SET <batch columns>
                         WHEN NOT MATCHED THEN INSERT
                file reload: the replace diff limited to the reloaded files' rows (… WHEN NOT
                         MATCHED BY SOURCE AND _file IN (…) THEN DELETE); with a key, a row whose
                         key the reloaded file dropped is first replaced by the row of the most
                         recently loaded other file that still has it (§3b, D58)
                Written rows get one _loaded_at stamp; unchanged rows keep theirs.
   j  checks    blocking checks; any failure → ROLLBACK
   k  state     cursor = greatest(saved, typed max) as original text; _croft.assets/columns/files/writes
                (with the step attempt); row_count and max(_loaded_at) recorded for out-of-band detection
   COMMIT
4  after        runs.sqlite step + catalog mirror; release asset lease; delete staging (kept 3 days on
                failure); warnings evaluated and recorded; instance closed, then write intent
                removed; read copy refreshed at the end of the run when `readCopy` is on
```

**Replace as a diff.** A replace without a key pairs old and new rows by exact `IS NOT DISTINCT FROM` equality on every non-reserved column plus a `row_number()` occurrence index, so repeated rows match with multiplicity. DuckDB runs this as a hash join, so, unlike a stored hash column, two different rows can never pair on a hash collision. A replace keeps `_loaded_at` on unchanged rows, so a taxi-zones refresh that changes 2 of 265 rows wakes downstream work for 2 rows, not 265. `MERGE … WHEN NOT MATCHED BY SOURCE THEN DELETE` produced the expected `UPDATE`/`DELETE`/`INSERT` actions and kept the stamp of the unchanged row [V].

Diff writes also keep the file small. Thirty hourly full rewrites (DELETE + INSERT, or CREATE OR REPLACE) of a 300k-row table doubled the file from 9.8 MB to 19.3 MB. A merge that touched 10% of rows stayed at 9.5 MB [V].

**Why dedupe always runs first.** MERGE with duplicate source keys silently applies one duplicate to a matched row and *inserts both* for an unmatched key [V]. With a PRIMARY KEY on the target, it fails outright [V]. croft therefore deduplicates before every merge and puts no constraints on user tables; uniqueness is a check.

### Transforms

A **SQL transform** step works like this, in one write lease and one transaction:

1. Read each input's `last_loaded_at`, version and row count inside the transaction: what the SELECT sees.
2. `DESCRIBE <body>`, then `CREATE OR REPLACE TEMP VIEW __body AS <sql>`, then `CREATE TEMP TABLE __croft_next AS …` without the reserved columns, with `_croft_seq` added (§3c, D71).
3. Diff `__croft_next` into the target exactly like a replace ingest, matching rows by key or by exact row content. A duplicate key is `CHECK_FAILED unique(key)` before anything is written (D65).
4. Run the blocking checks, record `_croft.inputs`, drop the temp objects, read the catalog entry back, and commit.
5. After the commit: the catalog mirror, then the warnings on a read lease (§3f).

The output *shape* is the ordered list of the SELECT's columns with their exact types, followed by `_loaded_at`. Any other shape (a column added, removed, retyped, renamed or moved, or a stray column such as `_file` left from a former ingest table) recreates the table with `CREATE OR REPLACE TABLE t AS SELECT <columns>, NULL::TIMESTAMPTZ AS _loaded_at FROM __croft_next LIMIT 0`, so STRUCT, MAP and ENUM types survive without being spelled out as text; `evolveTable`'s type whitelist would refuse them. Every row then gets a new stamp: the step reports `schemaChanges: [{kind: "recreate", reason: "shape_changed"}]` rather than a new table, and counts every row as added and every previous row as deleted. `CREATE OR REPLACE` rolls back cleanly on failure [V]. A SQL asset's columns are never pending, and it gets no `COLUMN_STOPPED_ARRIVING` or `JSON_KIND_CHANGED`. SQL steps run one at a time, because DuckDB already parallelizes inside each query.

`_croft.inputs` gets, for every input the SQL reads, `seen_loaded_at` = the `last_loaded_at` it read, `input_last_loaded_at` = the version it read, and `seen_key` NULL. Rows for inputs the SQL no longer reads are deleted in the same transaction.

A DuckDB error in the user's SQL is located in the asset's file (the header's lines are added and the caret becomes the column). A binder error that involves a pending column keeps its code (`QUERY_FAILED`, an error: the step failed) and gets a hint to pin the type, with `details.pendingColumns`; only `validate` reports `NULL_ONLY_COLUMN`, a warning code that could not stand for a failed step (§6).

A **TS transform** step extracts like an ingest, reading its inputs from Parquet snapshots (§3e), and then loads through the same pipeline. Incremental TS transforms commit in chunks (§3e), each with its own checks and composite position.

**Static errors in a run.** The planner binds each SQL asset it takes against the columns the catalog mirror has for its inputs, or against the output of an SQL input the run rebuilds first. A bind error fails its step before it runs only when no input the same run refreshes earlier (an ingest or a TS transform, directly or through SQL the run rebuilds) could still change the columns. Otherwise only the errors a new column cannot fix count (`QUOTE_IDENTIFIER`, `SQL_SYNTAX`, `DUPLICATE_OUTPUT_COLUMN`, `UNKNOWN_TABLE`, `QUERY_PATH_DENIED`), so an ingest that adds a column in the same run never fails the SQL that reads it; the step reports any other error when it runs. A check that reads a table never built, which the run does not build first, is `CHECK_INVALID` on its step, with the fix `croft run <asset> --upstream`.

**Cost guard.** An incremental TS transform that makes requests (the detection of §3e) and would process more than 1,000 input rows in one run (the `confirmAbove` setting) raises `LARGE_REPROCESS`. This happens on a first build, after an upstream rebuild that restamped every row, and after a restore. It is checked before any of the transform's code runs.

- The count is the rows after the position of each keyed input the code reads with `newRows()`, found by a lexical scan of the bundle (`newRows("x")`, `ctx.newRows("x")`). A lookup read with `rows()` is not processed row by row, so it does not count. When the scan cannot tell (a computed name), every keyed input counts.
- An input the scan missed is counted when `newRows()` first reads it, before its first row is handed over. If that goes past `confirmAbove` without an approved count, the step fails with `LARGE_REPROCESS` and an edit fix, rather than ask mid-run.
- The impact's action is `incremental transform; LARGE_REPROCESS override`, with `estimatedRequests` equal to the pending rows and `downstream` from the step's readers.
- A scheduled run holds the transform until a human runs it: the step is recorded as skipped, with `LARGE_REPROCESS` as a warning, the run succeeds, and the tick leaves the transform alone until a successful run by hand.
- A preview cannot ask for a confirmation: it stays within `confirmAbove` (§6).
- A manual run asks for confirmation, with the row count in the impact. The token is for `croft run <transform>`, the one transform named. A run issues at most one token: a second step that needs one is skipped (`skippedBecause`), with a `next` hint `croft run <transform>`, which only asks again and so is not destructive.

This is how "never spend the user's API money implicitly" is enforced rather than just documented.

### How commands behave while a run is writing

| Command | Needs | Behavior |
|---|---|---|
| `status`, `logs`, `context`, `docs`, `validate`, `run --dry-run` | `runs.sqlite` + files (+ an in-memory DuckDB for binding) | never waits |
| `doctor` | a read-only lease only while no write intent is live | never waits: reports `busy: croft run … is writing` |
| `query`, `preview`, `describe` samples | a read-only lease | waits only for the current *write step* (usually seconds), printing the holder |
| `run`, `delete`, `restore`, `confirm`, `rename` | asset leases + write leases per step, each behind a write intent | extraction proceeds in parallel; writes queue behind the current step |
| scheduler tick | `runs.sqlite`; a read-only lease only to reconcile a crashed run | skips leased assets; due work stays due |
| `croft serve` queries | its query worker's read-only instance | closed while `write-intent.d/` holds a live entry; queries wait up to 10 s, then `503` (or read-copy answers marked `stale`) |

`status`, `context` and `describe` resolve the asset files the way `validate` does (`project/resolve.ts`): TS assets are imported in isolation, with a 5 s import timeout each, and SQL is parsed on a private in-memory DuckDB. So an asset's top-level code runs on `croft status`, which needs it for kinds, code hashes and inputs. `status` still never opens the warehouse.

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
  input_last_loaded_at TIMESTAMPTZ,                                   -- format 3
  PRIMARY KEY (asset, input));                                        -- composite position (§3e)
CREATE TABLE _croft.files   (asset VARCHAR, path VARCHAR, size BIGINT, mtime TIMESTAMPTZ, etag VARCHAR,
  sha256 VARCHAR, loaded_at TIMESTAMPTZ, PRIMARY KEY (asset, path));
CREATE TABLE _croft.writes  (asset VARCHAR, loaded_at TIMESTAMPTZ, run_id VARCHAR, mode VARCHAR,
  rows_in BIGINT, added BIGINT, updated BIGINT, unchanged BIGINT, deleted BIGINT,
  cursor_before VARCHAR, cursor_after VARCHAR, since_used VARCHAR, inputs JSON,
  schema_changes JSON, code_hash VARCHAR, attempt INTEGER, PRIMARY KEY (asset, loaded_at));
  -- attempt: the runs.sqlite step attempt that committed (format 2; NULL in rows written before it)
```

`croft docs internals` documents these tables. For example, `_croft.writes` maps any row's `_loaded_at` to the run that wrote it.

`_croft.meta.format_version` is **3** (D69). Format 2 added `_croft.writes.attempt`, so `reconcile()` can tell a step's retries apart. Format 3 adds `_croft.inputs.input_last_loaded_at`: the input's version when the transform last read all of it (an SQL step's transaction, a TS transform's finished snapshot), which staleness compares. The version is the later of the input's `last_loaded_at` and `last_replaced_at` at the time of reading, while `seen_loaded_at` stays `last_loaded_at`. It is NULL while an incremental transform has committed only part of a snapshot. croft adds each column to an older database on its next write (a read lease on a format-2 database reads the missing column as NULL), and a croft that reads an older format refuses a newer database with `DB_NEWER_FORMAT`.

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
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);            -- migration 2 (phase 3); value is JSON
```

`runs.sqlite` versions its schema with `PRAGMA user_version`: each migration is appended and never edited, and a croft that finds a newer schema refuses with `DB_NEWER_FORMAT`. Migration 2 (phase 3) adds `settings`, per-project values as JSON:

- `scheduling`: `{state: on|off|paused, via: os-job|serve|null, pausedUntil?}`, which `croft schedule` writes and every tick reads (§8). A pause whose `pausedUntil` has passed reads as on. `scheduling.since` is when it was last turned on or resumed, from which a scheduler with no tick yet counts as stale.
- `schedule.facts`: what the scheduler knows of each asset without importing it (kind, schedule, inputs, code hash), keyed by file hash (§8, D79). `schedule.spawned`: the runs ticks started that may not hold their leases yet.
- `readCopy`: the read copy's coordination and last refresh, `{requested, holder: {pid, procStart, bootId}, refreshedAt, method, heldMs, lastError}` (Server mode, below).

A preview writes its catalog entries, with source `preview`, into its own `.croft/preview/runs.sqlite`, so the live catalog is never overwritten (D66).

While a run works, `runs.summary` holds `{progress: {asset, phase, rowsFetched, requests, elapsedMs}}`, written at most every 500 ms (§5, "Processes"). When the run ends it holds the whole command result, `{data: {runId, status, steps}, problems, next, confirmation?, exit, ok}`, redacted, so a detached run's parent and `croft wait` print exactly what an in-process run prints.

### Versions, staleness and atomicity

**`_loaded_at` is each table's data version.**

- Every write stamps changed rows with one `_loaded_at`: the greatest of `now()` and 1 µs past each of `last_loaded_at`, the newest `_croft.writes.loaded_at` and the table's `max(_loaded_at)`. This is strictly increasing per table, even if the clock steps back or rows were restamped out of band, and it keeps the `_croft.writes` primary key unique.
- `last_loaded_at` moves only when rows were added, updated or deleted, so an unchanged run does not wake downstream work. Every write still records a `_croft.writes` row.
- A transform is stale when:
  - it was never built (`never_built`);
  - an input with rows has no `_croft.inputs` row, or its `input_last_loaded_at` is null or older than the input's `last_loaded_at` (`input_changed`; an input that never had rows changes nothing);
  - an input's `last_replaced_at` is newer than its `input_last_loaded_at` (`input_replaced`: after a restore or an out-of-band change). Because the step records the later of the two as the version it read, this clears once the transform has read the input again, even when no written row followed the change;
  - or its code changed (`code_changed`, §8). An incremental TS transform is forward-only: its code change is `EDITED_SINCE_LAST_RUN`, never a reason to run.
- Unknowns never make an asset stale on their own: an input not built yet, a code hash that was never recorded, code that does not load. They are for `validate` and the planner to report.
- `newRows(x)` means rows after the composite position `(seen_loaded_at, seen_key)`. SQL and full-refresh steps record the input's `last_loaded_at` with no key.
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
  2. Their steps are matched against `_croft.writes` by run id, asset and attempt under a short read lease. A row without an attempt, written before format 2, counts when its `loaded_at` is at or after the step's `started_at`. A commit that landed just before the crash becomes `ok (recovered)`, because DuckDB is authoritative; chunks committed by an earlier failed attempt of the same step do not count. A step with no commit becomes `crashed` (`RUN_CRASHED`). For a chunked TS transform, the commit that landed can be any chunk: a step whose attempt committed at least one chunk is ok too, its reason ending `(recovered)`, or `(recovered: N commits)` for more than one. The asset then stays stale with its pending rows, and its next run continues after the last committed chunk.
  3. Their leases are released, and their staging is scheduled for deletion. Write intents of dead processes are deleted.
  4. A recovered step's catalog mirror entry (rows, columns, cursor) is re-read from `_croft.*` under the same read lease, so `status` and `context` show what committed rather than the previous load.
- Cursors move only on commit, so a crash means extraction is redone, never skipped: at-least-once extraction, exactly-once visibility.
- A process whose boot id cannot be read (a `PATH` without `/usr/sbin`, where macOS keeps `sysctl`; croft calls `/usr/sbin/sysctl` and `/bin/ps` by absolute path) records `unknown`. An empty or unknown boot id, on either side, is unknown, never dead: the PID and start time decide. Reading it as dead once made every writing command mark live runs crashed, take their leases and delete their staging.
- Durability across power loss relies on DuckDB's WAL fsync [U].

### Server mode, apps and GUIs

An app or GUI that keeps the live file open blocks every croft write. Even well-behaved open-per-query readers delay writers: two overlapping app readers held a writer off for 2.4 s [V]. croft solves this with one cooperative reader rather than many independent ones.

**`croft serve`** is an optional long-running process:

- **Reads over HTTP.** It answers queries over HTTP (`Bun.serve`) against the live file, so there is no copy, no doubled disk and no stale data.
- **Runs no user code.** Every write stays in a short-lived `croft run` process with freshly imported code, so D1's reasons still hold: no stale asset code, no crash of user code taking the server down, and no inter-process write protocol.
- **Runs the scheduler.** While scheduling is on for the project, it spawns a fresh `croft tick` subprocess at start and then every minute (§5, "Processes"). That makes it the one command to keep running on a server, in a container or on WSL. There, `croft schedule on --no-os-job` switches scheduling on without installing an OS job. `croft schedule off` and `pause` stop its ticks too, because `croft tick` itself exits at once when scheduling is off or paused (§8). On a laptop, the per-user OS job (§8) still works without it.

**Write intents.** Before a process opens the warehouse read-write, `db/warehouse.ts` creates its own intent file: `<state>/write-intent.d/<pid>-<procStart>.json`, holding `{pid, procStart, bootId, runId, since}`. It is written to a temp name with `O_EXCL`, then renamed. The rules:

- Every read-write open goes through `db/warehouse.ts`, so no command can skip the intent. That covers `run`, `confirm`, `delete`, `restore`, `rename`, `init` when it runs the example, and migrations.
- The intent is removed only *after* `closeSync()` of that instance returns (after the 100 ms linger). Leases inside that window reuse it, and an in-process reference count covers concurrent leases.
- The server stays closed while the directory holds any **live** entry. One shared file was wrong: when two writers overlapped, the first to finish deleted it, the server reopened within 14–38 ms, and the second writer gave up after 6 s, in 3 of 3 runs. With one file per writer, the second writer got in after 505–615 ms [V].
- **Liveness** uses the same check as asset leases: the boot id and the process start time must match, not only the PID, because PIDs are reused after a reboot. One function (`core/proc.ts`, used by `db/intent.ts`) implements it for the server, `doctor` and `@zabaca/croft/read`. The start time is `/proc/<pid>/stat` starttime (clock ticks since boot) on Linux. On macOS it is `ps -o lstart= -p <pid>` run under `LC_ALL=C TZ=UTC` and stored as epoch seconds, so the holder's and the checker's locale and time zone never matter. Records in the older lstart-text format are compared leniently: seconds past the quarter hour, plus the date or year. The server's poll and `reconcile()` delete dead intents.
- **Foreign holders.** A writer whose lock error names a non-croft holder (the DuckDB UI or DBeaver) withdraws its intent until that holder is gone. The server keeps serving meanwhile. Build: the writer withdraws its intent after 2 s of a foreign holder and announces it again every 5 s, so while a GUI holds the file, croft serve is closed for about 2 s out of every 7.

**Handing the file over.** The server polls the intent directory every 50 ms. `fs.watch` only shortens the delay and is never relied on, because on macOS it merges and drops events [V]; croft serve creates the directory so it can be watched. When a live intent appears, the server:

1. stops admitting new queries into DuckDB (they wait in the HTTP layer);
2. lets in-flight queries finish, and after 2 s (`graceMs`) calls `connection.interrupt()` on each query still running, repeating every 20 ms until that query's promise has settled (the client gets `503` with `Retry-After`). A query that has not settled 500 ms (`killAfterMs`) after its first interrupt is abandoned: its worker is killed, which ends it;
3. only then destroys prepared statements and result readers and disconnects **every** connection, idle ones included (no connection pool survives a handoff);
4. kills the query worker (`SIGKILL`) and awaits its exit (D76). The first build called `closeSync()` on the instance in croft serve's own process instead.

The lock is released only when the instance *and all its connections* are closed. In spikes, the lock stayed held in three cases [V]:

- an instance closed with an idle connection still open;
- a connection disconnected while its interrupted query had not yet settled; that query's promise never settled;
- a partly read stream.

In the documented order, the writer got the file about 20 ms after the interrupt. But DuckDB checks for interrupts only between tasks, and a SELECT can spend many seconds inside one scalar or list expression, or while planning one [V] (Appendix B), so no interrupt ends it. The kernel drops a process's locks when it exits, whatever DuckDB's objects are doing, so killing the worker bounds the handoff: **a writer gets the file within `graceMs` + `killAfterMs` + the few milliseconds a kill takes**, whatever the queries do (about 2.6 s measured, with a query stuck in `list_sort(range(1.5e8))`) [V].

**Two liveness checks.** Stepping aside uses a quick one: the intent's PID exists in this boot, with no `ps` spawn in the path, so the file is released within milliseconds. Reopening needs the full proof (boot id and start time) and deletes dead intents, so a reused PID costs at most one brief close.

When the directory is empty again, the server reopens. A spare worker is started while the writer works, so reopening takes about 5 ms. A reopened read-only instance sees every commit made in between, including one that was only in the WAL because its writer was killed after COMMIT [V]. Queries that arrive during a write step wait for it, up to 10 s, and otherwise get `503` with `Retry-After`. A worker that dies while serving (killed to end a stuck query, the OOM killer, a crash) is replaced at once; the queries it ran beside the stuck one get a retryable `503` (`reason: "restarted"`), which the read client retries.

With `readCopy` on, the server instead answers from `warehouse.read.duckdb` while an intent is live, marking the query envelope's `data` with `stale: true` and `asOf`, the copy's modification time (its checkpoint) with the project offset. That covers queries that arrive then, queries already waiting when the server steps aside, and queries interrupted for the writer after the grace. The copy has its own worker with the same sandbox, gate and limits and its own admission, started for the queries that need it and killed 100 ms after the last one, so a GUI can open the copy read-write between writes and a refreshed copy is picked up by the next open. A missing or unopenable copy leaves the query waiting as before. In a spike with short queries, one writer and one connection per query, a writer got the file in 10–23 ms across 5 writes while the server answered 2,226 queries in 6 s [V].

**Before the warehouse exists.** `croft serve` may start first: queries get `DB_NOT_FOUND` until a run creates the file, and then the engine opens it. A database from a newer croft (`DB_NEWER_FORMAT`) or an unreadable file (`DB_UNREADABLE`) fails the start; found at a later reopen, each refuses the queries instead.

**Query limits.** Every query passes the same one-SELECT gate as `croft query`, on a sandboxed read-only connection. Then:

- **Tables only.** Serve connections use `allowed_directories = []`, and the gate is an allowlist: user tables in the `main` schema, CTEs (which may not shadow a built-in view), and `range`, `generate_series`, `unnest`, `json_each` and `json_tree`. DuckDB's built-in views need no parentheses (`FROM duckdb_databases`, `pragma_database_list`, `pg_settings`, `duckdb_logs`), so a denylist of function calls is not enough. They are refused, as are every other schema and catalog and the scalars `current_setting`, `getvariable` and `sleep_ms`. HTTP clients can read tables but no files, paths or settings (`QUERY_PATH_DENIED`).
- **`SHOW TABLES` only.** It lists the `main` schema's names (views included, though querying one is refused). `SHOW ALL TABLES`, a bare `DESCRIBE` or `SHOW` (DuckDB's `__show_tables_expanded`), and `SHOW databases`, `schemas` or `variables` are refused, inside `FROM (…)` and CTEs too, with the hint "SHOW TABLES lists the project's tables, and DESCRIBE <table> the columns of one". Other profiles are unchanged.
- **Big literal ranges.** `range()` and `generate_series()` used as values (scalars or lists) with literal bounds past 10,000,000 values are refused (`QUERY_PATH_DENIED`, hint: `FROM range(n)`), since DuckDB folds or evaluates such a list in one step that no interrupt reaches; as tables they stream and stay interruptible. Bounds that are not literals pass, and the watchdog ends them.
- **A deadline** (`serve.queryTimeoutMs`, default 30000), enforced with repeated `interrupt()` and, when those cannot stop the query, by killing its worker `killAfterMs` later (`TIMEOUT`, details `{phase: "query", timeoutMs}`). A request that goes away is `INTERRUPTED` the same way.
- **Concurrency:** at most `serve.maxConcurrent` queries (default 4, below the worker-thread count) run in DuckDB at once. The rest queue, and the queue wait counts toward the 10 s wait. At most 64 wait; more are refused at once with `503` (`reason: "busy"`), so a burst during a write step cannot pile up.
- **Request bodies:** at most 8 MB each (`413`), and the `/query` bodies being read or waiting for the engine may add up to 64 MB, measured from `Content-Length`; past that a `/query` gets `503` with `Retry-After` before its body is read.
- **Memory:** the instance sets `memory_limit` (default 25% of RAM) and `threads`.
- **No silent truncation.** Values are never truncated over HTTP. A result larger than `limit` (default 10,000 rows, capped at `serve.maxRows`, default 100,000) or `serve.maxBytes` (default 64 MB, the rows' JSON as sent) fails with `QUERY_TOO_MANY_ROWS`; it is never a partial result.
- **Streaming inside the worker.** The worker reads the result from DuckDB chunk by chunk (DuckDB produces only the chunks read), renders and counts each as JSON, and fails as soon as `limit` or `maxBytes` is passed, so memory follows what is answered, not what the query could return: `SELECT *` over 20M rows with `limit` 10 reads one chunk. The answer is still complete before anything is sent to the HTTP client, and rows travel to croft serve as the JSON text the client will parse.

**Security.**

- **A token is always required**, on `/query`, `/status` and `/health` alike. `croft serve` generates a random token (32 bytes, base64url) into `<state>/serve.json` (mode 0600, git-ignored), along with its URL and PID. `CROFT_SERVE_TOKEN` (the shell, then `.env`) overrides it, and hosted apps use that. Tokens are compared in constant time (`crypto.timingSafeEqual` over equal-length digests). Build: a generated token is new on every start, because `serve.json` is removed when the server stops (D84); local apps read `serve.json` again for each query, and the banner asks for `CROFT_SERVE_TOKEN` when the server is not on loopback. A `CROFT_SERVE_TOKEN` with whitespace, control or non-ASCII characters is `USAGE_ERROR`.
- **Request checks,** in order: Host, Origin, then the token. The `Host` must name the bound address, or `localhost`, `127.0.0.1` or `[::1]` when the server listens on loopback or on every interface (DNS rebinding). Its port must match when it carries one; a Host without a port is accepted, since the name is what defeats rebinding, and a reverse proxy must send `Host: 127.0.0.1:<port>`, which the refusal's hint and the banner say. The server rejects a request whose `Origin` is not in `serve.allowOrigins` (browser pages), and a `/query` without `Content-Type: application/json`. A CORS preflight is answered after the Host and Origin checks.
- **Binding.** It listens on `127.0.0.1` by default. `::` and `0.0.0.0` bind every interface. Anything but loopback must sit behind HTTPS (a reverse proxy or tunnel), which the startup banner states. The printed URL uses the address actually bound. Build [V]: `--host localhost` binds `127.0.0.1`, because Bun 1.3.14 binds `localhost` to `::1` only; `reusePort` is off, because with it a second server on the same port took over connections; and since Bun reports a foreign address as `EADDRINUSE` too, croft checks the machine's interfaces to say which it is.
- **One server per project.** A second `croft serve` for the project is `USAGE_ERROR`, naming the running server's PID and URL. `serve.json` is claimed atomically (a hard link), so two servers starting at once cannot both win, and a dead server's record is replaced.
- **Stopping.** SIGINT, SIGTERM and SIGHUP stop the ticks, remove `serve.json` (apps fall back to reading the file), stop listening and kill the workers, then exit 0: that is how a server is normally stopped, and service managers treat anything else as failure. A second signal during the shutdown exits 130.

**Same kernel only.** Every croft process that touches a project must run on the same kernel, because DuckDB's lock is a POSIX `fcntl` lock. Inside a container, run `croft run` in the same container (for example `docker exec`). `doctor` and `serve` refuse a database, or a state folder (where the write intents live), on a filesystem whose locks cannot be trusted, with `SERVE_UNSAFE_FILESYSTEM` (`db/fs-kind.ts`):

- VM and container shares: virtiofs, grpcfuse, fakeowner and osxfs (Docker Desktop), 9p (also WSL's drives), and VirtualBox, VMware and Parallels shared folders;
- network filesystems: NFS, SMB/CIFS (SMB2/3 included), AFP, AFS, sshfs, WebDAV (davfs2), curlftpfs and GVfs;
- cluster filesystems: CephFS, GlusterFS, Lustre, GPFS, BeeGFS, OCFS2, GFS2 and JuiceFS;
- cloud storage mounted through FUSE (rclone, s3fs, gcsfuse, goofys, mountpoint-s3, blobfuse), and any FUSE mount whose source names another machine (`user@host:`, `host:path`, `remote:`, a URL).

On Linux the type comes from the longest mount point in `/proc/self/mounts` that holds the folder, and without `/proc` from the `statfs` magic number, where every FUSE mount looks alike and is not refused. On macOS it comes from `df -P` and `mount`. Nothing here opens the warehouse. Whether each of these really fails to share the lock is [U].

**The HTTP API** returns the same envelopes as the CLI's `--json`:

| Endpoint | Returns |
|---|---|
| `POST /query` with `{sql, params?, limit?}` | the `query` envelope (§4.3), untruncated values, `stale`/`asOf` in `data` when served from the read copy. Integers beyond ±2^53 in the body are read exactly, so `bigint` params bind as in direct mode; any other key is refused with a did-you-mean |
| `GET /status` | the `status` envelope, built without importing asset code (croft serve runs none), so staleness only the code can tell (`code_changed`) is left to `croft status`; `data.serve` also carries `{host, port, version, startedAt, engine: {state, writeIntent, inFlight, queued, openConnections, queriesToday}}` |
| `GET /health` | `{ok, pid, version, database, writeIntent: {pid, runId, since} \| null, queriesToday}` |

`queriesToday` counts the queries admitted since midnight in the project's time zone. Errors are problem envelopes with a status the read client understands: `401` (a missing or wrong token, with `WWW-Authenticate: Bearer`) and `403` (Host, Origin) are `SERVE_UNAUTHORIZED`; `SERVE_UNAVAILABLE`, `DB_BUSY` and `DB_HELD_BY_OTHER_PROGRAM` are `503` with `Retry-After` in whole seconds (at least 1); `QUERY_TOO_MANY_ROWS` is `422`; other exit-2 codes are `400`; an oversized body is `413` and a body that is not JSON `415` (both `USAGE_ERROR`); anything else is `500` `INTERNAL_ERROR`, with no stack. Problem texts are redacted with the project's `.env` values; rows are not, so they equal direct mode's. A client that leaves before its body arrives gets a quiet `499`.

The idle timeout (30 s) applies while a `/query` body is read, so a body that never comes does not hold a socket. While the query queues and runs, the socket's timeout is the query's own budget (queue wait, `serve.queryTimeoutMs`, the kill of a stuck query and a margin), and it is set back to the idle timeout before the answer goes out, so keep-alive sockets are reaped.

**`import { query } from "@zabaca/croft/read"`** is how apps read data. It ships as prebuilt JavaScript and works in Bun and Node [V].

- **Finding the project.** It uses a `{ project }` option, then `CROFT_PROJECT`, then walks up from the current directory (including `./data/croft.json`). It resolves the state folder from `croft.json`, which records a relocated `.croft/` (§2).
- **Server mode.** With a `{ url }` option or `CROFT_URL`, it always uses HTTP. The token comes from the `token` option, `CROFT_SERVE_TOKEN`, or the local `serve.json`. The `serve.json` token is used for an explicit URL only when `serve.json` records the same origin, so the local token is never sent to another host; it is looked up only when needed.
  - This is the path for production apps, including an app hosted elsewhere (Vercel, Fly) that calls a `croft serve` on a machine the user runs.
  - An explicit URL never falls back to the file. An unreachable server is retried with backoff until `timeoutMs` (default 10 s), so a restarting server is tolerated; then, or when the server still answers `503` after `timeoutMs`, `query()` throws `SERVE_UNAVAILABLE`. A reply is awaited up to `timeoutMs` plus 60 s, because the query itself may run up to `serve.queryTimeoutMs`.
  - A `401` or `403` is `SERVE_UNAUTHORIZED` (a missing or wrong token), never retried. `SERVE_UNAVAILABLE` is only for an unreachable or busy server.
  - Loopback URLs (including `0.0.0.0` and `::`) never go through an environment proxy, so `HTTP_PROXY` never sees the token. `node:http` could not promise that: under Bun 1.3.14 every `node:http` variant (the default agent, `agent: false`, a new `Agent`, `createConnection`) and `fetch` went through `HTTP_PROXY`/`http_proxy` for a `127.0.0.1` target [V]. So loopback requests speak a minimal HTTP/1.1 over `node:net` (`node:tls` for https), which cannot be proxied (D55). Other hosts use `fetch`, so a hosted app keeps its platform's egress proxy.
- **Local server.** With no URL but a live server recorded in `serve.json`, it uses that server. A recorded server that refuses the connection, or accepts it and sends no complete reply, counts as absent, and the query falls back to direct mode. One that answers `401`, or still answers `503` after `timeoutMs`, throws instead of falling back.
- **Direct mode.** Otherwise it opens the live file read-only per query and closes it. It first checks the state folder's `write-intent.d/`, and while any live intent exists it waits up to 2 s so the writer can get in; without this, overlapping readers starved a writer [V]. After that it retries on lock conflicts for up to 5 s. It checks `_croft.meta.format_version` once per file per process (`DB_NEWER_FORMAT`), as croft's own read leases do. If a croft runtime holding the same file is loaded in the same process, it uses that runtime's lease instead (§5).
  - Concurrent direct queries in one process share one open instance, with reference counting, and the last one out closes it, so the file is still never held between queries. A query that arrives while the file is open and a writer has a live intent does not join; it waits for the close and then for the intent, so a steady stream of queries cannot keep a writer out.
  - Direct mode is a separate, lazily imported chunk of the build. A hosted app that only uses server mode never loads the native DuckDB binding.
- **Same results in both modes.** Both return rows with the §4.3 value rendering: strings for HUGEINT, DECIMAL and integers beyond ±2^53, and ISO strings with the project offset for timestamps. Direct mode also turns `-0` into `0`, so its rows equal their JSON round trip. `query()` throws if an envelope reports any truncation. A golden test runs the same query in both modes.
- It sets the project time zone on its connection and uses no Bun-only APIs.

**The read copy is opt-in** (`"readCopy": true`), for tools that need a file: the DuckDB UI, DBeaver and notebooks. When it is on, `warehouse.read.duckdb` is refreshed at the end of every run that changed data (a run with a step whose status is `ok`), after the warehouse is closed:

1. Under a write lease (the write intent first, then the lock, so croft serve steps aside), run `CHECKPOINT`, in the run's own process. A copy taken without it missed committed rows still in the WAL (1,000 of 1,500) [V]. The WAL is then checked by `stat` to be empty.
2. Still under the lease, a child process clones the file to a temporary name next to the copy, `.<copy>.<pid>-<random>.tmp`: `cp -c` (clonefile) on macOS, `cp` with reflink=auto on Linux, and a plain `cp` when that fails. A child is used because the owning process must not open the file (above); it is `/bin/cp` by absolute path, with an explicit environment. The lease covers the checkpoint and the whole clone and nothing else: for a plain copy that is the whole copy, since a write during it would tear it. `heldMs` records how long it held. A warehouse the refresh opened itself is closed before the rename.
3. The temporary file gets the checkpoint's time as its modification time, which becomes croft serve's `asOf`. A `<copy>.wal` a GUI left next to the old copy is removed first, because DuckDB would replay it onto the new one. Then the file is atomically renamed into place: a reader holding the old copy keeps reading it.

On APFS the clone takes 0.1–0.2 ms [V], and a refresh held the write lease 2–3 ms for a 624 MB warehouse [V]. Elsewhere it is a full copy, and Linux reflink is [U]. The read copy is POSIX-only in v1.

Refreshes coalesce. Within a process, calls made during a refresh share one follow-up. Across processes, the `readCopy` setting in `runs.sqlite` (§5, "Where state lives") records the refreshing process: a request made while another live process refreshes returns `coalesced`, and that process runs once more (at most 10 rounds); a dead refresher is taken over. A refresh never fails the run: its errors go to `<state>/readcopy.log` and the setting's `lastError`, and a copy that missed a refresh only shows older data, which croft serve marks with `asOf`.

The v1 `DB_HELD_BY_OTHER_PROGRAM` fix points apps at `croft serve` and GUIs at the read copy, and when the holder is `croft serve` itself its message says "held by croft serve (pid n); stop it to open the file read-write in another program". Build: its hint says "close <program>, then retry; apps should open the file only per query (@zabaca/croft/read does)", and a lock held by croft serve's query worker is `DB_BUSY`, "croft's read server (pid n) has not stepped aside" (§2).

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

- It parses headers and SQL, finds dependencies and cycles, imports TS assets to check their config shape, and checks schedule phrases, secrets and every check expression. An asset import that does not finish within 30 s is `ASSET_INVALID`, so top-level code that never returns cannot hang `validate`. A schedule that does not parse is `SCHEDULE_INVALID`, an error, so the ingest does not load; its suggestion is a schedule that parses (§8). A schedule that parses is shown with its cron and next three fire times. (Phases 1 and 2, before the phrase parser, refused only a schedule that was not a string.)
- What only the whole project shows: a TS transform's input that is no asset is `UNKNOWN_TABLE` with an edit fix; an incremental transform's `newRows()` input without a key is `INPUT_NEEDS_KEY`, found from literal `newRows("name")` calls in the asset and the project files it imports (a computed name is left to the run); and a declared secret that is not set is `SECRET_MISSING`, a warning as in `doctor`, because only the user can set it and nothing fails until the asset runs.
- It runs a **bind check**. An in-memory DuckDB gets empty tables built from the cached column lists, `_loaded_at` and `_file` included. Each SQL asset is `prepare()`d in dependency order, and its output columns become the empty input of the next asset, so each asset binds against its inputs' code as it is now. DuckDB's own messages supply "Candidate bindings" and caret positions, shifted past the header [V]. The unoptimized plan's scans join each asset's inputs, and the graph (`order`, `CYCLE`) is built again with them.
- **Inputs never built.** The column cache is filled by runs, by previews (the preview's own catalog, for a table never built) and by `columns` pins. An input with no cache yields `INPUT_NOT_BUILT` (info), and only the assets that read it skip the bind, transitively. The message names the root assets to preview ("columns of daily_revenue are unknown until stripe_charges has run or been previewed; bind check skipped"), with the fix `croft preview <roots>`; for an input whose own code has errors it says "until the errors in assets/x.sql are fixed". They are never reported as errors the agent cannot fix. The assets of a cycle skip the bind with no extra problem.
- A binder error that goes away when a column still `pending` (all NULL so far) gets another type is `NULL_ONLY_COLUMN`, a warning. croft retypes the column in the shadow catalog, trying DOUBLE, BIGINT, VARCHAR, TIMESTAMPTZ, DATE, BOOLEAN and JSON in order, and the first type that binds is the pin in the edit fix (`columns: { x: "T" }`, inserted into the input asset's file). At run time the step's error keeps its own code, with a pin hint (§5).
- An SQL asset's checks are bound against its output columns. A check naming a missing column is `UNKNOWN_COLUMN` on the check's header line (the `-- key:` line for the checks a key implies); any other bind failure of a check is `CHECK_INVALID`. TS assets' checks are not bound, since their output shape is not known statically.
- `validate --json` returns every SQL asset's output columns, so the agent knows what the next asset can use. The prepared statement's column types drop the `JSON` alias inside nested types (`VARCHAR[]` for `JSON[]`), so croft reads the types from a TEMP view's `duckdb_columns()`, which keeps it [V].
- `--types` also runs the project's own `node_modules/.bin/tsc --noEmit`, with Bun, so no Node is needed. Each type error is `ASSET_INVALID` at its file, line and column (at most 50, then a count). No tsc, or no `tsconfig.json`, is an info problem (code `INSTALL_FAILED`, lowered to info) with `data.types.status: "skipped"`; croft never installs anything.

**2. `croft preview <asset…>` runs the code and changes nothing real.** It works in `.croft/preview.duckdb`.

- **Planned like a run.** The preview plans as `croft run <assets>` would (§4.1), so each step carries the bind check's problems, and it builds each asset through the step a run uses (§5), against the preview database and the preview's own `runs.sqlite` (`.croft/preview/runs.sqlite`, catalog source `preview`), so the live catalog is never overwritten (D66). The last preview's file and `.croft/preview/` are emptied first.
- **Inputs are snapshotted.** Under one short read lease, croft copies every live table the preview reads or compares with to `.croft/preview/<name>.parquet`, and the `_croft` rows of those assets to `.croft/preview/_croft/`. The preview database then sees them as views with the live column types: `main.<input>` for an input the preview does not build, and `live.<asset>` for the live version of every asset it builds. So everything in a preview, including later `query --preview` calls, reads one consistent snapshot. The live file is never `ATTACH`ed from a second instance, which would risk releasing its lock (§5).
- **SQL transforms** are built from those snapshots. SQL downstream of a named asset is built too, but only when every input it reads from the preview is complete, is not an ingest, and passed its checks; otherwise it is listed in that asset's `downstream`. A named asset reads the preview of any input built in the same preview; a listed downstream asset is read from live.
- **TS transforms** read Parquet snapshots, as in a real run. `--rows` (default 1,000, at most 100,000; anything else is `USAGE_ERROR`) caps the *input* rows they receive from each input, and `ctx.preview` is true. The cost guard (§5) holds in a preview too: an incremental transform that makes requests is handed at most its `confirmAbove` input rows. Without `--rows` its cap is lowered to fit, and its reason says so; an explicit `--rows` beyond it is `LARGE_REPROCESS`, whose fix is the `--rows` that fits. A preview never asks.
- **Ingests** fetch from the real saved cursor, with `ctx.preview` true, and stop the generator after `--rows` rows; reaching exactly `--rows` counts as capped, since the generator is stopped without asking for more. The cursor moves only in the preview database. File ingests are not capped: they make no requests, and they read their new and changed files. Downstream assets are listed but not built from a partial sample, because a diff against a partial input would suggest that correct SQL is wrong. A CSV ingest's header decision is in its `reason` and on a `note` line.
- **Two ways a build starts.** Merge and append ingests and incremental TS transforms start from a copy of the live table and its `_croft` state, so they continue from the saved cursor or positions exactly as a real run would, and the write's own counts are the diff ("212 would update, 788 would add"). Everything else (SQL, full-refresh TS, replace ingests, `--rebuild`, a table never built) is built from scratch in an empty preview table and diffed against `live.<asset>` by key, or by whole rows without one. So `ctx.query` in a replace ingest sees no table of its own during a preview.
- **The output** diffs against live: row counts, added/removed/changed by key, column changes, check results, samples, and `data.partial` / `data.inputsSnapshotAt` in JSON. When the preview could only build part of the table (capped input rows, or an incremental TS transform), the diff covers only the keys the preview produced ("of 1,000 keys touched, 37 differ"). It never reports every other row as removed. A replace ingest that fetched everything does report removals, and warns `SHRINK_GUARD` when a real run would stop. `croft query --preview` explores the result. The preview file stays until the next preview.
- **Checks.** Every check and warning runs on the preview table after its write, with a real run's scope (a new or edited check covers the whole table). A failing blocking check fails the asset (`CHECK_FAILED`, exit 3), as the real run would, but the preview table keeps the rows for `croft query --preview`. `min_rows` is not evaluated on a partial build from scratch.
- **`preview --rebuild`** builds the asset from scratch and compares it with the live table. It is how to find incremental drift or out-of-band edits: "3 of 812 rows differ".
- **Logs.** A preview's step logs go to `.croft/preview/logs/<asset>.log`, under a run id starting with `p_`. `croft logs` does not show them; a failed asset's human output prints the log path.
- A successful preview is human-initiated, so it approves the asset's code for the scheduler (§6, "The scheduler only runs code a human has run").

**3. The real run.** Writes are all-or-nothing, and blocking checks run before commit. That is write-audit-publish without the name.

**No named environments in v1.** For one person whose rebuilds take seconds, promotion machinery adds concepts and states that an agent can corrupt. Preview, all-or-nothing writes, the trash and the scheduler hold (below) cover the same need. See decision D8.

### The scheduler only runs code a human has run

The scheduler reads the working tree, so it could otherwise run an ingest the agent is in the middle of editing. Two debugging edits are common:

- a fixture `yield [{ id: 1, title: "test" }]`, which a merge would write over real issue 1;
- a temporary filter, which would move the cursor past rows that were never loaded.

To prevent this, the tick runs an asset only if its current code hash equals `approved_code_hash`. That hash is set by the last successful **human-initiated** `croft run` or `croft preview` of that asset (a file ingest whose files did not change counts: its code ran). Human-initiated means a command from a terminal or from Claude Code, as opposed to the scheduler.

Otherwise the asset is skipped with `SCHEDULE_HELD`, and `status` shows it plainly: "held: code edited 12 min ago, not run by hand yet; `croft run github_issues` releases it". New assets are held until they have been run by hand once ("new: code edited …"). `croft schedule pause --for 2h` pauses everything during a larger refactor.

Build:

- `SCHEDULE_HELD` is a warning (exit 0), never a failure (D77). A scheduled run records the held step as skipped with the warning and succeeds, so a held asset sends no failure notification; `status`, `context` and `schedule` list one warning per held asset, with the fix `croft run <asset>`.
- A held step is skipped even when its code no longer loads (an edit in progress), rather than failing ("code edited … and it does not load; fix it, then `croft run <asset>` releases it").
- The code hash covers `lib/` and the project time zone, so an edit in `lib/` holds the TS assets that import it, and a change of `timezone` holds every asset. The scheduler's facts cache sees both in its file hash and reads those assets again once (§8, D79).

### Nothing implicit destroys ingested data

- **Deleting an asset file** leaves its table in place, shown as "no asset file". `describe` reports such an orphan table as the warning `ORPHAN_TABLE`, with a manual `requiresHuman` fix (put the file back, or ask the user whether the table should go). `croft delete` never appears in its `next[]`, because deleting is destructive (§4.3).
- **Renaming a file outside croft** creates a new, never-built asset whose code hash matches the orphan's. `validate` reports `ASSET_RENAMED`, with the fix `croft rename <old> <new>`, which adopts the orphan's table and state instead of refetching history.
- **Columns** are never removed automatically.
- **Types** widen only when the widening is proven lossless (§7).
- **Changing ingest code never refetches.**
- **Shrink guard.** A replace ingest that would remove more than half of its rows (including all of them) fails with `SHRINK_GUARD`, because an expired token that returns `[]` must not wipe the table. The error's fix is `{kind: "manual", requiresHuman: true}`: "find out why the source returned 0 of 265 rows before overriding". Its details include the request count, last status and body preview. `--allow-shrink` is a destructive operation: trash first, then confirmation. `allowShrink: true` in a replace ingest is a standing decision made in code (D63):
  - Loading the asset gives the warning `SHRINK_GUARD_DISABLED`, so every run of the asset carries it.
  - A shrink under it needs no confirmation, but the current rows still go to the trash first. The trash reason is `allowShrink: true (<run>)`, `StepResult.trashed` is set, and the write's own `SHRINK_GUARD_DISABLED` after the shrink carries `details.trashPath`.
  - It wins over `--allow-shrink`, so no token is issued.
  - On a merge or append ingest the key does nothing, since only replace ingests have a shrink guard, and the load warning says so instead.
- **Behavior changes.** Changing an ingest's `key`, `write` mode or incremental field while it has data fails with `INGEST_CONFIG_CHANGED`. The fixes offered are:
  - revert the change;
  - `croft run x --rebuild`, which refetches from scratch (trash first, confirmation);
  - when a key is added to an append ingest, **convert in place**: deduplicate the existing rows by the new key, keeping the latest `_loaded_at` (trash first, confirmation).

  Adding a `lookback` applies directly.
- **Pin changes.** Pins in the current code are authoritative: a pin removed from the code unpins the column, and a pin that differs from the stored type retypes the column to the pin's type. A pin type must be a plain SQL type; anything else is `ASSET_INVALID`. A new `columns` pin on an existing ingest column is tested first by counting values that would change: `try_cast(x AS new)::old IS DISTINCT FROM x`.
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
- `rename`;
- a shrink of a replace ingest that sets `allowShrink: true` (the user decided in code, and the trash still comes first).

**How confirmation works:**

- **On a TTY,** croft prints the impact and asks `Proceed? [y/N]`.
- **Off a TTY,** it exits 5 with `confirmation: {token, expiresAt, command, impact: {asset, rows, bytes, trashPath, downstream[]}}`. The action runs only through `croft confirm <token>`. That command recomputes the impact and fails with `CONFIRMATION_STALE` if it changed, for example because the scheduler added rows in the meantime.
- **`croft confirm` checks the token before running anything.** A used or expired token is `CONFIRMATION_STALE`, and an unknown one is `USAGE_ERROR`; the stored command does not run at all.
- **Only `croft confirm` carries a token** (D56). No command takes a token as a flag. `confirm` runs the stored command again in its own process and passes the token in-process. When that run detaches (off a TTY, §5), the child receives the token through a one-time grant: `confirm` writes `confirm-grant.json` next to the run's logs, holding the token and the hash of a random secret, and passes the secret in `CROFT_CONFIRM_GRANT` to that `--detached` child only. The child removes the grant as it redeems it; every other croft process ignores the variable and never passes it on. A hand-made `--detached` run with a value typed into the variable matches no grant and is refused (`USAGE_ERROR`).
- **What becomes of the token** is `data.outcome` (§4.3):
  - `used`: the command reached its confirmation and spent the token, whether it then acted or found the impact stale;
  - `not_needed`: nothing destructive was left to do (the source recovered, say), so it ran as a plain command. `confirm` passes its envelope through with a `note`, and the token is spent anyway, so it can never run the command a second time;
  - `unused`: the command failed before the confirmation point; the token stays valid until it expires;
  - `running`: a detached run is still going (exit 6); it spends the token when it reaches it or ends.

  A destructive step that ran without spending the token would be croft's bug, reported as `INTERNAL_ERROR`.
- Tokens are single-use and expire after 15 minutes. Destructive commands never appear in `next`.
- A run issues at most one token. A second step that needs one (another `LARGE_REPROCESS`) is skipped, with a `next` hint `croft run <transform>` that only asks again (§5, "Cost guard").
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
- The skill's "ask the user first" list (§9). It includes raising `confirmAbove` of a transform that makes requests, because `LARGE_REPROCESS`'s own hint offers that as the way past the confirmation, so an edit could otherwise get around the cost guard.
- Agent evals score whether the agent ever ran `croft confirm` without asking, and whether it tried to read `.env` (§10).

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

A string counts as an ISO date-time or date only when DuckDB's own cast accepts it (`TRY_CAST`): a zoned date-time needs seconds, because DuckDB cannot cast `2024-01-01T10:00Z`, and `2024-02-30` or month 13 stay text. A JS number at or beyond 2^53 is printed rounded (`2**60` → `1152921504606847000`), so staging warns `UNSAFE_INTEGER` for it.

**NULL-only columns.** Nullable timestamps such as `closed_at` and `refunded_at` are NULL in almost every first load. A VARCHAR placeholder breaks typed SQL: `date_diff`, comparison with TIMESTAMPTZ and `COALESCE` all fail to bind [V]. So the placeholder is typed from the name:

- `*_at`, `*_time`, `*_timestamp` → TIMESTAMPTZ
- `*_date`, `*_on` → DATE
- `is_*`, `has_*` → BOOLEAN
- anything else → VARCHAR

camelCase names follow the same rules (`closedAt`, `startDate`, `isActive`, `hasMore`). Pending columns hold only NULLs, so they are retyped freely when real values arrive.

**CSV text** follows the same string rules, plus these:

- `^-?(0|[1-9]\d*)$` → BIGINT, and plain decimals → DOUBLE. "Plain" is strict: `+5`, `.5` and `1e5` stay text.
- Money and thousands-separated numbers (`$1,234.50`, `($3.00)`) → DECIMAL(18, s), with the parsed format recorded [V]. Comma-decimal formats (`1.234,50`) are ambiguous and need a pin.
- `true`/`false`, in any case → BOOLEAN; empty or whitespace-only → NULL.
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
| DOUBLE receives a JS number at or beyond 2^53 | **`TYPE_CONFLICT`**: JS already printed it rounded, and the same text from a lossless API parse would be a real change |
| anything else, including number ↔ text, float → integer, boolean ↔ number, naive ↔ zoned | **`TYPE_CONFLICT`**: the load rolls back and the cursor does not move |
| pinned column | never widened; a value that does not cast exactly fails with `TYPE_PIN_VIOLATION` and sample rows. Integer text with leading zeros counts as a loss, so `'02134'` under a BIGINT pin is `TYPE_PIN_VIOLATION` (unpinned, it is text and already a `TYPE_CONFLICT`) |

**Casts are whitelisted and verified.** Every cast reads the JSON *text* (`v->>'$'`), never the JSON value: casting JSON to DECIMAL goes through DOUBLE, so `1.005` became `1.00`, while the text gave `1.01` [V]. The "same kind" row above is the only implicit cast. DuckDB casts that looked clean are silently lossy:

- `'2024-01-01T10:00:00+02:00'::TIMESTAMP` drops the offset.
- `'1.5'::BIGINT` rounds to 2, including through `try_cast`.
- An implicit INSERT cast stored DOUBLE 1.7 as 2 in a BIGINT column [V].

So after every cast, a **round-trip loss check** counts rows where the raw value is not NULL and either the typed value is NULL or it differs from the raw value when compared canonically:

- Numbers are compared by casting the typed value back to VARCHAR, which gives the shortest round-trip form for DOUBLE, and comparing both sides in an exact canonical "digits × 10^exponent" form. Integer text in a DOUBLE column is compared exactly as HUGEINT. This catches `1.7` → 2 and `19.999` → `DECIMAL(18,2)`. An earlier `TRY_CAST(text AS DECIMAL(38,18))` formula gave 11,218 false losses among 40,011 random doubles, because DuckDB casts DOUBLE to DECIMAL from the binary value (4.35 → 4.349999999999999488) [V].
- Timestamps compare as epoch instants.
- Any loss fails the load. For a pinned DECIMAL, the failure is `PIN_ROUNDED`, with a count.

**Money on JSON sources.** `DECIMAL_PRECISION_UNSUPPORTED` is raised only when *fractional JSON numbers* arrive under a `DECIMAL` pin with precision above 15, because the digits beyond double precision are already gone. Strings and integers are exact, so the fix is to yield such values as strings. This includes the common money pin `DECIMAL(18,2)`: on a JSON source it refuses fractional numbers, so either yield amounts as strings (or integer cents) or pin a precision of 15 or less, such as `DECIMAL(15,2)`. CSV sources are unaffected, because `all_varchar` keeps the text.

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

**Numbers beyond DOUBLE.** `res.json()` returns a number DOUBLE cannot hold (`1e400`) as `JSON.rawJSON(<its source text>)` instead of `Infinity` (§3a). Inside a JSON column it stays a JSON number with its own source text. As a column's own value no numeric type can hold it, so it is staged as text: a VARCHAR column (`MIXED_TYPES` when it sits next to numbers), or a `TYPE_CONFLICT` in an existing numeric column.

**Rejected alternatives:**

- Native STRUCTs: inserting a STRUCT with an extra field silently drops that field [V].
- Flattening to `user__login` columns: it adds dozens of columns and routes every nested leaf through the conflict machinery.
- Child tables: they force joins on non-data-engineers.

### Column names

Column names are kept as written, because DuckDB identifiers are case-insensitive; that keeps SQL matching the API docs. Unicode letters work unquoted (`SELECT 名前`, `SELECT café`) [V]. The cleanup happens in the JavaScript NDJSON writer, before anything reaches `read_json`. `read_json` matches keys case-sensitively: it loaded NULL for `ID` into a column declared `Id`, and failed on an empty key or on both `Id` and `id` [V]. The rules:

- Names are NFC-normalized first, so a composed and a decomposed `café` are one column. Characters other than letters (any script), combining marks, digits and `_` become `_`.
- Runs of `_` collapse, and leading and trailing `_` are trimmed, so `Amount ($)` becomes `Amount`.
- A leading digit gains a `col_` prefix. A name that ends up empty becomes `col_<n>`, where n is the key's 1-based position in its row.
- Each key is resolved case-insensitively against the stored spelling in `_croft.columns` and the columns already seen in the batch, so `ID` and `Id` land in the same column, and the first spelling wins. Only when two such keys appear in the *same row* does the key that does not own the column move to `<its own spelling>_2` (then `_3`, …) for the rest of the batch, with the warning `COLUMN_NAME_COLLISION`. Earlier rows keep the merged column.
- Source fields named `_loaded_at` or `_file` become `_source_loaded_at` and `_source_file`.
- The original name is kept in `_croft.columns.source_name`.
- Every identifier croft generates (MERGE, INSERT, checks, keys) is quoted.

Names that are reserved SQL keywords (`order`, `group`, `end`, `limit`) are kept, but they must be quoted in SQL (`"limit"`) [V]. Non-reserved keywords such as `user`, `type` and `position` work unquoted [V]. `describe` shows them quoted, and `validate` turns the resulting parser error into `QUOTE_IDENTIFIER` with an edit fix. DuckDB's parse error often points past the bare keyword (`SELECT id, order FROM t` fails "at or near FROM", while `WHERE order > 1` fails at `order`) [V], so `validate` tries quoting each keyword written at or before the error, and keeps a quote only when the error goes away or moves on and the quoted body parses in the end; `ORDER BY` stays a keyword.

### Merge semantics

- A column absent from the whole batch keeps its stored values, and `COLUMN_STOPPED_ARRIVING` watches it.
- A present column overwrites, including with NULL. Within a batch, a row that lacks a key the other rows have counts as NULL for that column. Partial-update APIs that send only changed fields need a post-v1 `partial: true` mode.
- A NULL key fails with `KEY_NULL`, for every kind of asset. A SQL asset whose SELECT does not return a key column is refused even when the result has no rows.
- In an ingest, duplicate keys within a batch keep the row with the highest cursor, then the last one yielded. In a SQL or TS transform, a duplicate key fails `CHECK_FAILED unique(key)` before anything is written, with `details` `{check, failing, sample}` (up to 20 rows) and 3 example keys in the message (D65).
- JSON values are canonicalized (sorted keys, minified) at staging, so key order and whitespace never count as a change [V]. Unchanged rows keep their `_loaded_at`.

### Time zones

- Every croft instance runs `SET GLOBAL TimeZone = '<project timezone>'` on its first connection, before the sandbox locks the configuration (§5), and every later connection inherits it. Setting it as an instance option fails [V].
- TIMESTAMPTZ stores instants, so `created_at::DATE` and `date_trunc('day', …)` produce *the user's* days: `2024-01-02T10:00:00Z` became `2024-01-02 03:00:00-07` under America/Los_Angeles [V].
- `--json` renders timestamps as ISO-8601 with the project offset, so the JSON agrees with SQL's days. croft renders values itself, because `getRowObjectsJson()` formats TIMESTAMPTZ in the process-local zone [V]. `formatInstant` in `core/time.ts` is the one renderer, for the CLI, `croft serve`, `@zabaca/croft/read` and cursors.
- Offsets are always `±HH:MM`. Historic local-mean-time offsets with seconds are rounded to the minute (half away from zero), and the wall clock is shifted with them, so the string still names the exact instant. Instants beyond the range of JS dates render in UTC (`+00:00`).
- Offsets come from the runtime's `Intl` data, while `::DATE` and SQL's time functions use DuckDB's bundled ICU data. `croft doctor` warns with `TZDATA_MISMATCH` when the two disagree for the project zone over the next two years, or when DuckDB does not know the zone (§2).

### SQL transforms

SQL transforms define their own shape. Each rebuild takes whatever the SELECT returns, minus reserved columns, with DuckDB's own types. Any change of shape recreates the table (§5, "Transforms"), so none of the evolution rules above apply: a SQL asset's columns are never pending, never widened, and never raise `COLUMN_STOPPED_ARRIVING` or `JSON_KIND_CHANGED`.

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

Build: the parser (`schedule/phrase.ts`) takes more, all of it additive:

- `every N minutes` (N divides 60) and `every minute`; `every hour at :15`; `every N hours` (N divides 24);
- `daily` / `every day at …`, `weekends at …`, and `every <day> at …` with abbreviated or plural days, lists joined by `,` or `and`, and ranges (`mon-fri`, `monday to friday`, `monday through wednesday`); `monthly at …` (on the 1st);
- the cron macros `@hourly`, `@daily`, `@midnight`, `@weekly`, `@monthly`, `@yearly` and `@annually`.

A time is `HH:MM`, `9am`, `6:30pm`, `noon` or `midnight`, in any case; a phrase without one fires at 00:00, like `@daily`. Anything else is `SCHEDULE_INVALID`, an error, so the ingest does not load (§6). Its suggestion, when one is close, is always a schedule that parses: a misspelled word (`evry hour`), a missing `at` or `every`, a bare time (`9am` → `daily at 9am`), the nearest N that divides the hour or the day. A 6-field cron's suggestion drops the seconds field, or else a trailing year (AWS style); a 7-field Quartz cron drops both.

**Cron fields** follow Vixie cron: names in any case, 7 is Sunday like 0, `a/n` runs from `a` to the field's end, and `?` in a day field means `*`. When both day fields are restricted, a day matching either fires (`0 0 13 * 5`: the 13th and every Friday); when either starts with `*`, a day must match both. Quartz's `L`, `W` and `#` are refused, and so is a cron that can never fire (`0 0 30 2 *`).

`validate` shows the cron form and the next three fire times in the project time zone. Due times come from croft's own time-zone-aware matcher (`schedule/cron.ts`, local times from `Intl`). Fire times are defined as instants, so DST cannot drop or double them:

- A local time that does not exist (02:30 on a spring-forward day) fires at the first valid minute after the gap, the transition itself. Several times inside the gap fold into that one fire.
- A repeated local time (01:30 on a fall-back day) fires once, at its first occurrence, when the cron names a fixed time ("daily at 01:30").
- Build: a cron whose minute or hour field starts with `*` (`every 15 minutes`, `every hour`, `every 2 hours`) is an interval, and fires at both passes of a repeated local time, so its fires stay evenly spaced in real time (D80). That is cron's own rule for its wildcard jobs, and the golden test "every 15 minutes across the overlap: no duplicates, no missing instants" requires it.
- `last_fire_at` is stored in UTC.
- The latest fire is looked for at most 400 days back: a schedule whose last fire is older (a Feb 29 cron, say) reads as "no fire" to the tick.

Naive wall-clock matching would never fire "daily at 02:30" on 2026-03-08 in Los Angeles, and would fire "daily at 01:30" twice on 2026-11-01 [V]. Golden tests cover both days, in Los Angeles and New York, and the transition days of Europe/London, Australia/Sydney, Asia/Kolkata (no DST) and Australia/Lord_Howe (a 30-minute shift). Bun's `Bun.cron.parse` is not used, because its time-zone behavior changed between versions: on 1.3.14 it returned the same UTC result for every zone, and on 1.4.2 it honored the zone [V].

### Turning it on

`croft schedule on` makes sure **one per-user OS job** exists and adds the project to a registry, `~/.croft/projects.json`. With `--no-os-job` (servers and containers running `croft serve`), it only records scheduling as on.

Build: `on` records the setting first (`runs.sqlite` `settings`, §5), then the registry, then the job, so the job's first run (`RunAtLoad`) already finds the project. If the job cannot be installed, the setting and the registry are put back as they were (`INSTALL_FAILED`, §2). `--no-os-job` also removes the job when no other project uses it. `off` records scheduling off, takes the project out of the registry, and removes the job once no project needs it. `pause [--for 2h]` makes every tick exit at once until the pause ends (`--for` takes a minute to a year: `30m`, `2h`, `1d`, `1h30m`) or until `croft schedule on`; it refuses while scheduling is off. A bare `croft schedule` is `status`.

**The job:**

- **macOS:** a LaunchAgent, `~/Library/LaunchAgents/dev.croft.tick.plist`, with `StartInterval` 60. Build: its keys are `Label`; `ProgramArguments` `[<absolute bun>, "--no-env-file", "~/.croft/tick.ts"]`; `EnvironmentVariables` with `HOME`, and `PATH` set to Bun's folder, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`, `/usr/sbin` and `/sbin`, so scheduled runs find Homebrew tools as manual runs do; `StartInterval` 60; `RunAtLoad`; `AbandonProcessGroup`, so launchd does not kill what the tick started when it exits; and `StandardOutPath` and `StandardErrorPath`, both `~/.croft/logs/tick.log`. The plist is written with mode 0644, since launchd refuses one that is group- or world-writable. It is loaded with `launchctl bootstrap gui/<uid>` (retried while launchd still tears down a job just booted out) and removed with `launchctl bootout gui/<uid>/<label>`, with `launchctl` called by absolute path.
- **Linux:** one crontab line, between marker lines, read with `crontab -l` and written with `crontab -`; every other line is kept byte for byte:

  ```
  # croft:dev.croft.tick begin
  * * * * * /home/ana/.bun/bin/bun --no-env-file /home/ana/.croft/tick.ts >> /home/ana/.croft/logs/tick.log 2>&1
  # croft:dev.croft.tick end
  ```

- It runs `~/.croft/tick.ts` with an absolute Bun path, preferring a stable symlink (`~/.bun/bin/bun`, `/opt/homebrew/bin/bun`) over a version-manager path that disappears on upgrade. Build: the stable candidates are `$BUN_INSTALL/bin/bun`, `~/.bun/bin/bun`, `/opt/homebrew/bin/bun` and `/usr/local/bin/bun`, and a stable Bun older than croft needs (a curl install left behind) never wins (D83). Each candidate's `bun --version` is asked once, and the job takes, in order: the first stable candidate at least as new as the running Bun and croft's floor (`engines.bun`); the running Bun, when its own path is stable; the first stable candidate at or above the floor; the running Bun, marked unstable, which `schedule on` points out.
- Its output goes to `~/.croft/logs/tick.log`, moved to `tick.log.1` once it passes 5 MB.
- The label is `dev.croft.tick`. `CROFT_JOB_LABEL` (for tests) must be a reverse-DNS name (`[A-Za-z0-9][A-Za-z0-9._-]{0,127}`), or it is `USAGE_ERROR` before any path or line is built from it.
- Installing and removing are idempotent: an unchanged job is not rewritten or reloaded. With `CROFT_FORBID_OS_JOBS=1` (tests) croft refuses to run `launchctl` or `crontab`, and to touch the real user's home, which it takes from the password database rather than `HOME` (§10).

**The per-user tick script,** `~/.croft/tick.ts`, is plain JavaScript generated from a template (version 2), and imports nothing from croft: one script serves every project on the machine, and each project pins its own croft. An older croft never overwrites a script from a newer template. Every minute it:

1. moves `tick.log` to `tick.log.1` once it passes 5 MB;
2. reads `projects.json` next to itself, tells the projects that are there from those gone or missing (below), and prunes the gone ones;
3. for each project the OS job ticks whose `runs.sqlite` says scheduling is on (a pause that has ended counts as on; a project whose setting says `via: serve` is skipped even when its registry entry says `os-job`, because `runs.sqlite` is the project's source of truth), starts `<bun> --no-env-file <the pinned croft's bin> tick` in the project folder, detached, with its output in `tick.log`. The child runs on the job's absolute Bun (`process.execPath`), because launchd's `PATH` does not include `~/.bun/bin`, and its `PATH` starts with that Bun's folder. Its environment is explicit: `HOME`, `PATH`, `LANG` and `CROFT_HOME`, plus, when set, `TMPDIR`, `USER`, `LOGNAME`, `TZ` and croft's test variables (`CROFT_JOB_LABEL`, `CROFT_FORBID_OS_JOBS`, `CROFT_NOTIFY_DRY`, `CROFT_NOW`). Nothing else passes, secrets in the job's environment included;
4. does not start a pinned croft whose `engines.bun` is newer than the job's Bun, or one that is not installed, and logs why, with the fix (`croft schedule on` or `bun install` in that folder).

**Pruning.** The per-user tick and `croft schedule` prune a project only when it is surely gone, so moving or deleting a project cannot leave a job firing forever, and neither an unplugged disk nor a privacy block can unschedule one:

- **gone:** its `croft.json` is missing (`ENOENT` or `ENOTDIR`) while the folder around it is there, on a mounted disk. It is pruned at once.
- **missing:** its disk is not mounted (`/Volumes/<disk>`, `/media/…`, `/run/media/<user>/<disk>` or `/mnt/<disk>`; a disk counts as mounted when its folder is on another device than the folder above it), or its parent folder is gone too. It stays registered with `missingSince` and is pruned after 30 days missing; seeing it again clears the mark.
- **unknown:** a permission error (`EPERM` from macOS privacy protection, `EACCES`) says nothing about the project. It is logged, and that line is what the privacy diagnosis reads, but the project is kept.

The registry is rewritten only when something changed, and each change of state is logged once.

**The registry lock.** Its writers are `croft schedule` in any project and the per-user tick, possibly at once. Every change is a read-modify-write under two locks, written to a temp name and renamed into place, so a reader sees the whole old file or the whole new one (D82):

1. the OS lock: an exclusive `bun:sqlite` transaction on `projects.json.lock.db`, an empty file that holds no data. SQLite's lock is a POSIX `fcntl` lock, which the kernel drops when its holder exits or dies, so nobody ever breaks it and two writers never both hold it;
2. holding it, the pid file older crofts use (`projects.json.lock`, created with `O_EXCL`), broken only when its pid is dead or it is older than 10 s. Only the OS lock's holder can be breaking it.

A writer that cannot get both within 12 s fails with `DB_BUSY` (its hint gives `lsof <lock.db>`, or the pid the lock file holds). The tick script waits at most 2 s and prunes the next minute instead. A lock file that is not a database is `CONFIG_INVALID`, with the fix to delete it.

**Each tick only plans and spawns.** It never does the work itself: launchd runs at most one process per job, so a tick busy with a 40-minute transform would drop every later fire [U]. For every registered project that still exists and has scheduling on, the per-user tick starts the project-pinned `croft tick`, which:

1. exits at once unless scheduling is on for this project (not off, not paused), so ticks from `croft serve` obey `schedule off|pause` too;
2. exits at once if another tick for the project is alive (a singleton row with PID and process start time), since cron can start overlapping ticks;
3. records a heartbeat and runs `reconcile()`. Build: the warehouse is opened read-only, and only when a crashed step must be checked against it; with nothing to reconcile (no running run, lease, lock holder, waiter or write intent), reconcile is not even loaded, since it brings the database engine along. A scheduled run found crashed gets its failure notification from this tick, since it never reached its own;
4. computes due work from `runs.sqlite` and its facts cache (below);
5. spawns one detached `croft run --due <assets…>` per group of due assets connected through what reads them (the children take the leases), with an explicit environment that never carries a confirmation grant. Build: before each child starts, its ingests get `last_fire_at` (the fire they handle) and `last_attempt_at`, so a child that dies early is not started again every minute, and the run is noted (the setting `schedule.spawned`) until it holds its leases, so a slow child is not started twice;
6. exits, usually within a second, with one line for `tick.log` (`tick: started r_… (orders)`, or `tick: nothing due`) and one per held asset.

**`schedule on` waits for the first heartbeat, up to 70 s.** Build: it does not wait when the unchanged job ticked this project within the last 2 minutes. When no heartbeat comes, it exits 0 with the warning `SCHEDULER_STALE`, and scheduling stays on. The warning carries the tail of `tick.log` and the likely cause:

- macOS privacy protection blocking background access to `~/Documents`, `~/Desktop` or `~/Downloads` [U] (on the Mac where the real job was checked, reading `~/Documents` worked with no block [V]);
- a missing Bun path;
- a job Bun older than the project's croft needs (`bun_too_old`, fixed by `croft schedule on` in that folder);
- the project's pinned croft not installed (`cd <root> && bun install`);
- on WSL, a VM that sleeps when no terminal is open, or cron not running [U].

`status` and `doctor` show `SCHEDULER_STALE`, with the same diagnosis, whenever scheduling is on and no tick came for 3 minutes, counted from the latest of the last heartbeat, turning scheduling on (the setting `scheduling.since`) and the end of a pause. For the OS job the diagnosis can also be `not_registered`, `job_missing` or `job_not_loaded`; for scheduling by `croft serve` only, `serve_not_running` or `serve_not_ticking`, from `<state>/logs/tick.log`. On servers, in containers and on WSL, `croft serve` runs the same per-minute loop in the foreground instead, spawning a fresh `croft tick` each minute, and also answers app queries (§5). Native Windows is unsupported in v1 (§2).

**The OS job was verified on macOS** [V] (2026-09-24), in the phase-3 spike that gated the rest of the phase and then with croft itself:

- A LaunchAgent with `StartInterval` 60 and `RunAtLoad` ran at load and again 60 s later. `launchctl bootstrap gui/<uid>` loaded it and `launchctl bootout gui/<uid>/<label>` removed it cleanly. The job's `PATH` was `/usr/bin:/bin:/usr/sbin:/sbin` (no `~/.bun/bin`, hence the absolute Bun in `ProgramArguments`), its working folder `/`, `HOME` was set and the uid was the user's. `ProgramArguments` `[<absolute bun>, "--no-env-file", <script>]` worked.
- `croft schedule on`, with a temporary `CROFT_HOME` and job label, installed and bootstrapped the plist; the first heartbeat came after 1 s; an every-minute ingest ran twice from launchd (trigger `schedule`, ticks of about 13 ms); and `croft schedule off` booted the job out and deleted the plist.
- Still [U]: crontab registration on a real Linux machine, wake behavior, and privacy protection on other Macs. CI never installs a job.

Why not `Bun.cron`, which registers OS jobs too:

- It only exists since Bun 1.3.11 [V].
- It registers one job per title, which is orphaned when a project moves.
- Its logs go to `/tmp`.
- Its registration was never observed working [U].

Writing a plist or a crontab line directly is about 150 lines, and croft controls the logs.

### What counts as due

`croft tick` reads schedules from `schedule_state`, which is cached by file hash, so a tick with nothing due takes about 50 ms and imports no asset code. Build: what the scheduler knows of an asset without importing it (kind, schedule, inputs, code hash) is cached in `runs.sqlite` by file hash (D79). `schedule_state` keeps phrase, cron and file hash, and the setting `schedule.facts` the rest. The file hash covers the asset file and the project time zone, and for TS assets the size and modification time of everything in `lib/` and of `package.json` and the lockfile, on which the TS code hash depends. Only an asset whose hash changed is imported again, so a tick with nothing changed imports no asset code: about 80 ms from process start to exit, with 20 TS ingests and 20 SQL transforms [V]. The due set is:

- ingests whose schedule fired since `last_fire_at`, plus their stale downstream. Build: an ingest is due when its latest fire is after both `last_fire_at` and the start of its last successful step, so a run by hand covers the fires before it. The tick names only the ingest; the run takes the stale downstream, as any run does;
- **any stale transform**, even when no ingest is due. A transform can be left stale by `run --only`, an edit that has since been run by hand, or an earlier failure. Without this rule it would wait for its input's next scheduled fetch. Build: a transform whose input was never built is not due on its own; it follows that input's run.

The tick skips anything **held**, and a held asset stays due. As built, the holds apply in this order:

- `paused`: scheduling is paused;
- `SCHEDULE_HELD`: code not yet run by hand (§6);
- `LARGE_REPROCESS`: the cost guard (§5), until a person runs the transform;
- `leased`: another run holds it, or a run a tick started has not taken its leases yet;
- `backoff`: a transform whose last attempt failed (below).

`last_attempt_at` is recorded when an attempt starts, and `last_fire_at` when a due fire is handled; `last_fire_at` never moves back. After its final retry, a deterministic failure (`TYPE_CONFLICT`, `CHECK_FAILED`, SQL errors) waits for the next fire time, or for a change to its code or inputs. It is never retried every minute. Build: an ingest waits for its next fire, whatever failed. A transform's deterministic failure (`ASSET_INVALID` too, anything not retryable) waits for a change to its code or inputs, or a run by hand; its retryable failure, crash or interruption waits 15 minutes, or the server's longer `Retry-After`, before the scheduler tries it again.

A `--due` run checks the holds again when it plans, since the world may have changed since the tick: a pause or a lease that appeared meanwhile skips the step, and `schedule off` landing between the tick and its child holds every step (`held: scheduling is off`).

### What the user experiences

- **Downstream follows automatically.** Transforms have no schedule and update in the same run as their inputs.
- **Missed times run once.** After a laptop sleeps through 8 hourly fires, the ingest runs once on wake. Its cursor fetches everything since, so no data is skipped. Only the latest fire counts, and `croft schedule status` says so: `due: fired at 20:00; 4 missed fires run once`.
- **Overlaps skip.** An asset still leased by the previous tick is skipped and stays due.
- **Retries.** TS assets get 2 retries (after 30 s and 2 min) on retryable errors: network errors, 429/5xx after `http`'s own retries, and `DB_BUSY`. SQL and deterministic errors (`TYPE_CONFLICT`, `CHECK_FAILED`, SQL errors) are not retried. A chunked TS transform keeps its committed chunks across retries, but each failed attempt loses, and so can re-bill, the chunk it was filling (§3e). A server's `Retry-After` (`HTTP_ERROR` `details.retryAfterMs`, §3a) is honored: the next attempt waits `max(delay, retryAfterMs)`. A wait longer than a run holds on for (5 minutes, like `maxRetryAfterMs`) ends the step at once, with `nextRetryAt` set to when the server allows the next try, rather than retrying inside the server's backoff window.
- **Timeout** means "no progress": no row yielded and no request completed for 10 minutes. `timeout: "30m"` changes it. Chunked TS transforms (§3e) can run for hours as long as they progress.
- **Failures** show in `status`. By default, a failed *scheduled* run also raises a desktop notification (`osascript` on macOS, `notify-send` on Linux). `"notify": {"desktop": false, "webhook": "https://hooks.slack.com/…"}` in `croft.json` changes this. A webhook receives the failure envelope. Build (`schedule/notify.ts`):
  - The desktop notification is in plain words: the project folder, the failed assets, the first error's code and message, and `croft logs <asset> --failed`. Its title is `croft: <project>`. macOS shows it with `osascript` (`display notification`), and Linux with `notify-send -a croft -- <title> <body>` when it is installed.
  - The webhook receives `{project, text, data: {runId, status, steps}, problems, next, exit, ok}`: the run's summary as `croft run --json` prints it, plus `text`, the notification in one line, because Slack-style incoming webhooks reject a post without it. The run's progress and any confirmation (which holds a token) are left out. Each attempt has 10 s, and there are 3, retrying network errors, timeouts, 429 and 5xx (a `Retry-After` up to 30 s is honored) and never another 4xx. A loopback URL is posted over a plain socket, so `HTTP_PROXY` never sees it; any other host goes through `fetch`.
  - Everything sent or written is redacted as a run summary is (§9.6), with the run's own declared secrets. A webhook URL counts as secret too (Slack's path is its credential), so logs name only its host.
  - A notification never fails the run. One that could not go out is a line in `<state>/logs/notify.log`. A held asset is a warning and notifies nothing, and a scheduled run that crashed is notified by the tick that finds it.
  - With `CROFT_NOTIFY_DRY=1` (tests), each notification is recorded in `<state>/logs/notifications.ndjson` instead of being shown; a loopback webhook is still posted (tests run a mock), and any other is recorded, not sent.

### Incrementality by asset type

| Asset | Mechanism | What happens on each run |
|---|---|---|
| API ingest | `incremental: "field"` or `{field, unit, lookback}` → `since` | fetch from the saved position (minus lookback); save the new maximum with the rows |
| File ingest | `incremental: true` | load new files; reload changed files in place; keep rows of deleted files |
| SQL transform | none in v1 | recompute in full, written as a diff so unchanged rows keep `_loaded_at` |
| TS transform | `incremental: true` + `newRows()` | process rows written since the last run; the cost guard holds large batches |

### What a code change does

- **SQL transforms** are rebuilt. They are local, so the only cost is time; `VOLATILE_SQL` flags the ones that are not deterministic.
  - The fingerprint hashes DuckDB's AST JSON with `query_location` removed and every `*_name` key lowercased (table, schema, catalog, function and star-qualifier names), plus the header and the **project time zone**. Changing `timezone` in `croft.json` rebuilds every transform, because `::DATE` results depend on it [V].
  - It ignores whitespace, comments, keyword case and the case of those names, and it detects real changes [V]. It keeps the case of column references and aliases (D74): DuckDB names an unaliased expression's column after the text as written (`SELECT sum(AMOUNT)` gives a column named `sum(AMOUNT)`, `S.K` gives `K`), so a case change there can rename a column. A spurious rebuild is safe; a missed one is not. `FROM main.orders` and `FROM orders` hash differently, because under CTE shadowing they mean different things.
  - It avoids the `json_deserialize_sql` round trip and its uint64 `query_location` precision trap [V]. The AST is re-serialized losslessly (integers beyond 2^53 stay exact, and the bare `Infinity` that `json_serialize_sql` writes for `1e400` [V] becomes valid JSON), so `id = 9007199254740993` and `id = 9007199254740992` hash differently.
  - A code hash that changed only because `timezone` did is shown as "time zone changed (A → B)", not as an edit: the transforms rebuild, but there is no `EDITED_SINCE_LAST_RUN`. croft finds this by hashing the unchanged code in the zone it was built in.
- **Full-refresh TS transforms** are rebuilt.
  - The fingerprint hashes the `Bun.build` output of the file with `packages: "external"` and `minify: {whitespace: true, syntax: true, identifiers: false}`, plus the versions of imported packages (except croft itself, so an upgrade does not mark every asset edited and hold it from the scheduler) and the project time zone. Bun names a default export after its file, so that identifier is replaced with a fixed name; a renamed file keeps its hash, which `ASSET_RENAMED` relies on.
  - This covers edits in `lib/`, ignores comments and formatting, and costs under 1.2 ms per asset [V].
  - Identifier minification must stay off: with it on, a comment-only edit changed the hash [V].
- **Incremental TS transforms** apply new code to new rows only, because they may call paid services. `status` says: "issue_triage edited since last run; 18,556 rows were built by older code; to redo them: `croft run issue_triage --rebuild`" (trash plus confirmation). Until `--rebuild` ships in phase 4, `EDITED_SINCE_LAST_RUN` ends at "… rows were built by older code", and its hint says the rows built earlier keep their values. A time zone change applies to new input rows only, in the same way.
- **Ingests** never refetch because of a code change.
- **In every case,** a changed asset is held from the scheduler until it has been run by hand (§6). Since the time zone is part of every code hash, changing `timezone` in `croft.json` holds every asset.

### Backfills

A backfill is a flag, and it is defined per asset type:

| Asset | `croft run x --from <when>` |
|---|---|
| merge ingest (key + incremental) | fetches from `<when>` and upserts. The saved cursor stays `greatest(saved, loaded)`, so the schedule never rewinds. When `<when>` is *after* the saved cursor, the cursor stays where it was, so the next run fetches the rows in between instead of skipping them (the step's reason says so). |
| append ingest (`write: "append"`) | `BACKFILL_WOULD_DUPLICATE` (exit 2) once it has a saved cursor: a `<when>` at or before it would store rows twice, and one after it would skip the rows in between (keeping the cursor instead would store the rows after `<when>` twice). Before its first load `--from` works. Fix: add a key. |
| replace ingest | `BACKFILL_UNSUPPORTED`: "replace ingests always fetch everything: `croft run x`" |
| file ingest | `BACKFILL_UNSUPPORTED`: "changed files reload automatically; `croft run x --rebuild` reloads all files" |
| SQL / TS transform | `BACKFILL_UNSUPPORTED`: "use `croft run x --rebuild`" |

`<when>` accepts `2026-06-24`, a full ISO timestamp, or a relative value (`-90d`, `-12h`, `today`). croft converts it to the cursor's type and echoes the conversion: `since: 1782284400 (2026-06-24T00:00:00-07:00)`. `run --dry-run --from -90d` shows the same without fetching, and the skill's recipe backfills with `croft run <asset> --dry-run --from -90d`, then the same without `--dry-run`. (Phase 1, which had no `--dry-run`, checked the cursor with `croft describe <asset>` first.)

**Transforms in a `--from` run.** Only fetches run. Every transform is skipped with `--from applies to merge ingests`, those that read a backfilled ingest included, in the plan, the dry run and the run alike. They stay stale (their input's `last_loaded_at` moved), so the next bare `croft run` rebuilds them.

**A text cursor converts nothing** (D64). `--from` takes a value written like the saved cursor (`v0006` for `v0005`) and passes it through as is. A relative value or `today` is always `CURSOR_TYPE_MISMATCH`. So is a date or a timestamp, unless the saved cursor is written the same way (a date field pinned to VARCHAR, say). The error comes before the run, exits 2, and its hint shows the saved value. Before the first load there is no saved value, so only relative values and `today` are refused. The skill's backfill recipe (`--from -90d`) applies to time cursors only.

A `--from` that cannot apply is refused before the run starts: no run is recorded and no step fails. An asset named exactly refuses the whole command (exit 2, the error above); in a bare `croft run --from …` or a glob, the assets it does not apply to are skipped with the reason. Refusals that need only the plan (`BACKFILL_UNSUPPORTED`) come from the invoking process; those that need the saved cursor (`BACKFILL_WOULD_DUPLICATE`) come from the detached child before it records the run, and the parent prints them as its own result.

Why the cursor holds (D57): a `--from` later than the saved cursor used to save `greatest(saved, loaded)` like any run, which jumped the schedule over `[saved, <when>)`. Nothing ever fetched those rows again, and `--from` needs no confirmation (§6), so `croft run x --from today` lost data silently. Holding the cursor costs one wider fetch on the next run; merge makes the re-read rows a no-op.

The same flag fills a new field for old rows of a merge ingest: `croft run stripe_charges --from 2024-01-01`.

**Large first loads.** Off a TTY, a run detaches, so a long first load is never killed by the agent's shell (§5). The agent polls with `croft wait <id> --timeout 100s` or uses its own background shell.

A crash, a kill or a rate-limit failure late in a long first load must not force a refetch from zero. So cursor ingests use **monotone partial commits** (phase 4). While writing parts, the JavaScript writer checks that every cursor value in the new parts is at least every value in earlier parts. If so, every 50k rows or 5 minutes croft commits those parts, with the cursor set to their typed maximum. If the order is not monotone (newest-first APIs), the ingest keeps single-transaction behavior.

---

## 9. Claude Code integration

The agent has never seen this tool. Everything it needs ships inside the installed version, and `croft init --claude` refreshes it.

**Each phase ships these texts cut to its commands** (D59). Items 1 and 2 are the full v1 texts, the target for later phases. A phase ships them cut (`src/agent/claude-md.md` and `skill.md`): lines that send the agent to a command, flag or feature the phase lacks are left out or reworded, and SKILL.md gains a "This version" section rendered from the manifest in `core/phase.ts`, naming the commands the build has, the ones it lacks and what it does not do yet. `agent/templates.test.ts` lists every cut line with its reason, so no rule below disappears unnoticed; it replaced a test that compared the files with this section verbatim. `agent/contract.test.ts` guarantees that every command named in agent-facing text exists in the build (§4.1).

Phase 2 shipped the `CLAUDE.md` block below word for word, and its SKILL.md left out or reworded only the lines about phase 3–5 commands (`croft new`, `--rebuild`, `rename`, `restore`, `delete`, `schedule`, `serve`, `readCopy`). Its loop step 1 points at the templates in `croft docs ingest`, `croft docs sql` and `croft docs transforms` and at `croft docs checks`, which stand in for phase 5's `croft new` as `croft docs ingest` did in phase 1 (D60).

Phase 3 ships the `CLAUDE.md` block word for word too, and its SKILL.md restores the phase-3 lines of item 2 word for word: `scheduling` in the description, schedules and holds in the `context` line, "Only ingests have schedules.", the Apps line with `croft serve`, the rule that `croft serve` runs until stopped, the `readCopy` line for GUIs, the ask-first line about `croft serve`, and the Held asset recipe. It leaves out or rewords only the lines about phase 4–5 features (`croft new`, `--rebuild`, `rename`, `restore`, `delete`, pre-upgrade backups): the ask-first line about renaming keeps `croft schedule on|off|pause` and says instead that the table stays under the old name. One more line differs for a reason that is not a phase: the `croft status` line of Orient uses the command's own words ("failed, stale, held, never run, edited since its last run, no asset file"). `templates.test.ts` lists 11 cut lines. The shipped SKILL.md also adds a Schedule recipe, which serves the eval task "schedule hourly":

```
- Schedule: add `schedule: "every hour"` to the ingest (`croft docs scheduling`); `croft validate` shows the next fires;
  run it by hand once (new code is held until then), then ask the user before `croft schedule on`.
```

Phase 3 adds the docs topics `scheduling`, `serve` and `read-copy`, and code pages for `SCHEDULE_INVALID`, `SCHEDULE_HELD`, `SCHEDULER_STALE`, `SERVE_UNAUTHORIZED` and `SERVE_UNAVAILABLE` (28 code pages in all). The ingest templates of `croft docs ingest` carry the `schedule:` lines of §3 again.

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
  Preview them with `--rows 20`: by default a preview hands them up to 1,000 input rows, each a paid call.
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

- **Project:** `DUPLICATE_OUTPUT_COLUMN`, `DECIMAL_PRECISION_UNSUPPORTED`, `QUERY_PATH_DENIED`, `ASSET_INVALID`, `NAME_INVALID`, `NAME_RESERVED`, `NAME_CONFLICT`, `HEADER_UNKNOWN_KEY`, `SQL_SYNTAX`, `SQL_NOT_SELECT`, `SQL_NOT_ONE_STATEMENT`, `PIVOT_NEEDS_VALUES`, `CATALOG_PREFIX`, `SQL_READS_FILES`, `INPUT_NEEDS_KEY`, `UNKNOWN_TABLE`, `UNKNOWN_COLUMN`, `QUOTE_IDENTIFIER`, `UNDECLARED_INPUT`, `CYCLE`, `SCHEDULE_INVALID`, `CHECK_INVALID`, `SECRET_MISSING`, `INCREMENTAL_WITHOUT_KEY`, `CURSOR_TYPE_MISMATCH`, `ASSET_OPENS_DATABASE`, `ASSET_RENAMED`, `QUERY_NOT_SELECT`, `USAGE_ERROR` (bad flags or arguments), `PROJECT_NOT_FOUND`, `QUERY_FAILED` (DuckDB failed while binding or running a user query, §5), `CONFIG_INVALID` (`croft.json`), `DB_NOT_FOUND` (no warehouse file; worded by `runs.sqlite` as built before and now missing, runs that wrote no table yet, or nothing run yet, §3b).
- **Run:** `HTTP_ERROR`, `ASSET_CODE_ERROR`, `ROW_NOT_OBJECT`, `UNSERIALIZABLE_VALUE`, `CSV_HEADER_AMBIGUOUS`, `PIN_ROUNDED`, `DDL_AFTER_DML` (an internal invariant), `KEYSET_STUCK`, `TIMEOUT`, `INTERRUPTED`, `TYPE_CONFLICT`, `TYPE_PIN_VIOLATION`, `KEY_NULL`, `CHECK_FAILED`, `SHRINK_GUARD`, `INGEST_CONFIG_CHANGED`, `PIN_CHANGES_DATA`, `UNKNOWN_INPUT_COLUMN`, `BACKFILL_UNSUPPORTED`, `BACKFILL_WOULD_DUPLICATE`, `LARGE_REPROCESS`, `INTERNAL_ERROR` (a croft bug), `RUN_CRASHED` (a step whose process died before it committed, found by `reconcile()`), `FILE_NOT_FOUND` and `FILE_UNREADABLE` (a file ingest's file or URL, §3b).
- **Coordination:** `DB_BUSY`, `DB_HELD_BY_OTHER_PROGRAM`, `ASSET_BUSY`, `SCHEDULE_HELD` (a warning with exit 0: a held asset never fails a run, D77), `SERVE_UNAVAILABLE`, `SERVE_UNAUTHORIZED` (a `401`/`403` from `croft serve`; exit 2, never retried), `SERVE_UNSAFE_FILESYSTEM`, `QUERY_TOO_MANY_ROWS`.
- **Safety:** `CONFIRMATION_REQUIRED`, `CONFIRMATION_STALE`, `REQUIRES_HUMAN`.
- **Environment:** `BUN_TOO_OLD`, `NEEDS_BUN`, `DUCKDB_BINDING_MISSING`, `DUCKDB_BINDING_LOAD`, `DB_NEWER_FORMAT`, `CLAUDE_FILES_OUTDATED`, `SCHEDULER_STALE`, `PROJECT_NOT_WRITABLE`, `DB_UNREADABLE`, `INSTALL_FAILED`.
- **Warnings and info:** `ENV_FILE_IGNORED`, `TABLE_MODIFIED_OUTSIDE_CROFT`, `VOLATILE_SQL`, `MIXED_TYPES`, `NULL_ONLY_COLUMN`, `UNSAFE_INTEGER`, `SINCE_IGNORED`, `EMPTY_EXTRACT`, `TYPE_WIDENED`, `COLUMN_STOPPED_ARRIVING`, `JSON_KIND_CHANGED`, `CSV_ENCODING_GUESSED`, `AMBIGUOUS_DATE_FORMAT`, `MIXED_DATE_FORMATS`, `DUPLICATE_ROWS_ACROSS_FILES`, `TRANSFORM_MAKES_REQUESTS`, `SHRINK_GUARD_DISABLED`, `INPUT_NOT_BUILT`, `EDITED_SINCE_LAST_RUN`, `ORPHAN_TABLE`, `OUT_OF_BAND_CHANGE`, `ENV_FILE_INVALID` (a `.env` line croft cannot parse), `COLUMN_NAME_COLLISION` (§7), `BUN_UNTESTED`, `DB_ON_SYNCED_FOLDER`, `TZDATA_MISMATCH`.

`src/core/errors.ts` is the full registry: each code's category, severity and exit code.

**5. Introspection commands:**

- `context`, `status`, `describe` (columns, JSON keys, behavior in words, cursor, samples);
- `run --dry-run` (actions, reasons, windows, confirmations);
- `validate` (with output columns), `preview` (including `--rebuild` for drift);
- `logs` (`--failed`, `--runs`), `secrets`, `doctor`, `docs internals`;
- `schedule status` (each asset as the scheduler sees it: schedule, cron, next and last fire, due, held; phase 3).

All of these but `schedule status` ship from phase 2. (Phase 1, which had no `run --dry-run`, `validate` or `preview`, backfilled with `croft run <asset> --from <when>`, checking the saved cursor first with `croft describe <asset>`.)

**6. Protecting the agent's context window:**

- Row caps (50 in `query`; 3 samples in check failures, 20 in `--json`).
- Values cut to 80 characters.
- Logs default to the last 200 lines.
- `context` capped at 20 KB.
- `.env` values redacted (D54). Every `.env` value of 4 or more characters is redacted from messages, hints and logs. In command data (query rows, samples), declared secrets are always redacted, and any other `.env` value only when it looks like a credential: 8 or more characters, and not only letters or only digits. Otherwise `PORT=5432` or `LOG_LEVEL=info` would rewrite ordinary values the agent reasons from. `data` then carries `redactedValues: true` (§4.3). A declared secret set in the shell instead of `.env` is covered too: declaring the project's secret names (`ProjectEnv.declare()`) registers their shell values, so redaction hides them even when no `secret()` call handed them out.
  - **A value is redacted in its renderings, not just its raw text** (D61):
    - escaped, as in JSON (including `\/`, as PHP writes it), in `util.inspect`'s quoting, and as `\xHH` or `\uHHHH`, up to three levels of escaping;
    - split over lines by `util.inspect`, which writes a multi-line string as `'…\n' +` continuation lines;
    - each line of 8 or more characters of a multi-line value (a PEM key's body), on its own;
    - URL and form encoding (space as `+`), with percent escapes in either hex case;
    - for values of 8 or more characters, base64 and base64url, including the value inside a longer encoded credential such as a Basic auth header (at most the characters of two bytes at either edge remain).
  - **Not covered:** other encodings (hex, gzip, encryption), and a value split across two writes of a stream.

**7. What `init` deliberately does not write.** It does not write `.claude/settings.json`. Permission rules and hooks change what Claude Code may do without asking, so they stay the user's decision (D27).

- `croft docs claude-permissions` prints a suggested snippet: `"ask": ["Bash(croft confirm:*)"]`, and deny rules for reading `.env` and `.env.*` (`"Read(./.env)"`, `"Read(./.env.*)"`, plus the `./data/` variants for a project inside an app). Because every destructive action funnels into `croft confirm`, that one prefix rule gates all of them.
- `croft init --claude --with-hook` opts into a PostToolUse hook that runs `croft validate --hook` on edits under `assets/`. The hook's exit-code semantics are [U].

**8. Secrets.** croft loads secrets itself; Bun's automatic `.env` loading is off (`bun --no-env-file`) [V]. Bun's loading depends on the working directory, so a scheduled tick started from `/` would see no secrets. It also silently lets `.env.local` override `.env`. The rules:

- croft reads `<project>/.env`. Shell environment variables take precedence over it, and `croft secrets` shows where each value came from.
- `.env.local` and `.env.*` are ignored, with the `doctor` warning `ENV_FILE_IGNORED`.
- Only declared names reach code, through `ctx.secret()`. They are not placed in `process.env`.
- `croft secrets set` writes `.env` with mode 0600.
- Every child process croft spawns gets its environment passed explicitly. Without that, Bun hands a child the environment it started with, which includes any values it loaded from `.env` [V]. The launcher strips those values for the same reason (§2).
- A `.env` line croft cannot parse is `ENV_FILE_INVALID` in `doctor`.

**Secrets without a TTY.** Inside Claude Code the user usually has no interactive terminal, so the primary instruction is "open `.env` in your editor and add `STRIPE_KEY=…`".

- `croft secrets set NAME` is a convenience: a hidden prompt on a TTY, or `--stdin` for piping from a password manager.
- Off a TTY without `--stdin`, it exits 5 with `REQUIRES_HUMAN`.
- `croft secrets --json` returns `[{name, status: "set"|"missing", source: ".env"|"env", usedBy}]`, so the agent can confirm a secret exists without reading it.

Declaring `secrets` drives `doctor`, `validate`, error messages and what `ctx.secret()` returns. It is not a hard isolation boundary, because asset code could still read the file. That is why `.env` values are redacted from output, not only declared ones (point 6 gives the rules). SQL cannot read `.env`: the sandbox blocks `read_text('.env')` [V].

---

## 10. Implementation layout

**One package**, `@zabaca/croft` on npm, with bin `croft` → `bin/croft.mjs`, which imports `src/cli/main.ts` (§2). The command is plain `croft`, just as `@zabaca/zbc` ships the command `zbc`. The package root also ships `croft.schema.json` (draft-07), and `package.json` `files` lists `bin`, `src`, `dist` and `croft.schema.json`, and leaves out tests, test kits and fixtures. Its exports:

- `.` → `src/index.ts`
- `./read` → `dist/read.js` + `dist/read.d.ts`, built from `src/read.ts` with `bun build --target node` and code splitting at publish time. Direct mode is a separate hashed chunk (`dist/read-*.js`) that `read.js` imports only on first use, so the entry never imports `@duckdb/node-api`. The `.d.ts` is generated from `src/read-types.ts`, and a build test typechecks one consumer against both `dist/read.d.ts` and `src/read.ts` to catch drift.

**Packing.** `dist/` is git-ignored, so the build runs from `package.json`: the `prepack` and `build` scripts both run `scripts/build-read.ts`. `npm pack` or `npm publish` from a clean checkout therefore ships `dist/read.js`, `dist/read.d.ts` and their chunks. `tests/pack.test.ts` packs a copy without `dist/` and `node_modules` and checks the tarball.

**Dependencies:**

- **Runtime:** only `@duckdb/node-api`, pinned exactly, because both the storage format and the AST shape depend on its version.
- **Everything else is a Bun built-in:** `bun:sqlite` (`runs.sqlite`, and the scheduler registry's OS lock), `Bun.Glob`, `Bun.file`/`Bun.write`, `Bun.hash`/`Bun.CryptoHasher`, `Bun.build` (fingerprints), `fetch`, `node:util` `parseArgs`, `node:child_process` (detached runs, notifications, `croft tick` spawns, `launchctl` and `crontab`, and the `cp -c`/`cp --reflink=auto` clones behind the read copy and backups), `Bun.spawn` with its IPC channel (`croft serve`'s query workers), `node:fs` (write-intent files; `watch` only as a latency hint), `node:crypto` `timingSafeEqual` (serve tokens), `node:net`/`node:tls` (the read client's proxy-proof loopback HTTP, §5, also used for loopback webhooks), and `Bun.serve` (`croft serve` and test mocks).
- **No CLI framework and no schema library.** Validators are hand-written so their errors read well.

```
src/
  index.ts             ingest(), transform(), fail(), public types       read.ts   @zabaca/croft/read (built to dist/)
  cli/                 main.ts (parseArgs, envelopes, exit codes), launcher.ts (pinned-copy delegation, install,
                       .env cleanup), render.ts (human/JSON, truncation, offsets, redaction), version.ts
                       (BUN_FLOOR, BUN_TESTED), commands/index.ts (registry),
                       commands/*.ts (schedule.ts also holds what status, doctor, context and describe show of
                       scheduling, and SCHEDULER_STALE; it imports no DuckDB, since doctor imports it)
  core/                errors.ts (CroftError, code registry, fix templates, exit codes), types.ts,
                       time.ts (formatInstant, the one timestamp renderer), proc.ts (pid + start time + boot id),
                       output.ts (asset output, console and fds 1 and 2 → step log or stderr),
                       phase.ts (the phase manifest: commands, flags and config keys by phase; phaseStub()),
                       codes-raised.test.ts (every registered code is raised, or listed for a later phase)
  read/                run.ts (routing: url, serve.json, direct), http.ts (loopback over node:net, else fetch),
                       server.ts, direct.ts (lazy chunk; shared instance, intent wait), locate.ts, select.ts
  project/             root.ts (croft.json, .env, relocation), init.ts (empty folder, existing repo → data/),
                       discover.ts (names), ts-asset.ts (isolated import, config validation, Bun.build fingerprint,
                       import scan for ASSET_OPENS_DATABASE), sql-asset.ts (header, AST deps, fingerprint,
                       reserved columns), graph.ts (order, reads/readBy, upstream/downstream, CYCLE),
                       resolve.ts (resolveProject: every asset loaded and checked, and the graph; ResolvedAsset;
                       selection and write behavior; bindProject)
  sql/                 ast.ts (serialize, walk: collect, location; CTE scopes, relationNames, catalog prefixes,
                       file refs, volatile functions; gate.ts imports it),
                       deps.ts (AST ∪ unoptimized-plan scans), gate.ts (extractStatements + serialize: one SELECT;
                       AST walk: literal paths, table-function allowlist, serve allowlist),
                       bind.ts (shadow catalog, prepare, error → code mapping)
  db/                  connect.ts (factory: time zone + sandbox; canonicalPath without opening the file),
                       warehouse.ts (fromCache registry, one mode per process, leases with boot id, lock retry,
                       holder lookup), state.ts (_croft DDL + migrations, format check), values.ts (DuckDB → JS,
                       round-trip safe), tx-guard.ts (DDL_AFTER_DML), readcopy.ts (opt-in: checkpoint +
                       child-process clone + rename; coalesced refreshes), intent.ts (write-intent file),
                       fs-kind.ts (filesystems whose locks cannot be trusted: SERVE_UNSAFE_FILESYSTEM)
  serve/               server.ts (Bun.serve: /query, /status, /health; limits, statuses, serve.json), auth.ts
                       (token, Host, Origin, Content-Type), instance.ts (the engine: workers, admission, handoff,
                       read-copy answers, watchdog), worker.ts (the query worker process: one read-only instance,
                       the serve gate, streamed results), query-worker.ts (its handle over IPC; kill to release),
                       queue.ts (admission, maxQueued, interrupt then kill), handoff.ts (watch write-intent,
                       quick and full liveness), loop.ts (spawn croft tick at start and every minute), types.ts
  load/                stage.ts (NDJSON parts, canonical + lossless JSON), classify.ts (json_type + regex kinds),
                       types.ts (type rules, name-typed placeholders, CSV money/date formats), cast.ts (whitelist,
                       round-trip loss check), evolve.ts (ALTERs), write.ts (diff-replace, append, merge, dedupe;
                       a transform's shape and key; positions and checks in the write transaction), table-batch.ts
                       (a SQL step's result as a typed batch), files.ts (globs, union_by_name, encoding fallback,
                       URLs, conditional GET, _croft.files)
  run/                 step.ts (the step contract: StepInput, StepOutcome, ConfirmDecider, shared by runIngest,
                       runSqlStep and runTransform), plan.ts (what a run takes, actions, reasons, the bind check's
                       problems, --from matrix), staleness.ts (stale reasons, EDITED_SINCE_LAST_RUN), dry-run.ts,
                       runner.ts (concurrency, retries, timeouts, leases, signals, confirmations), detach.ts
                       (non-TTY detach + follow), ingest.ts, sql.ts (temp-view wrapper, rebuild + diff),
                       transform.ts (chunked commits, cost guard), inputs.ts (ctx.rows/newRows/query, proxy rows,
                       composite positions), snapshot.ts (ordered Parquet snapshots), preview.ts (snapshots,
                       preview db, partial diffs)
  checks/              parse.ts (check language → validated SQL; vetting), run.ts (checksHook, runWarnings)
  http/                http.ts (retries, Retry-After, Link, lossless JSON, redaction)
  schedule/            phrase.ts (English → cron), cron.ts (DST-defined matcher), types.ts (parseSchedule, nextFires,
                       latestFireAtOrBefore), register.ts (launchd, crontab, pickBun), registry.ts (projects.json,
                       its locks, pruning), user-tick.ts (the ~/.croft/tick.ts template), heartbeat.ts (heartbeat
                       wait, diagnosis), home.ts (CROFT_HOME, job label), os.ts (OsRunner, the refusing tripwire),
                       tick.ts (per-project plan-and-spawn, singleton), due.ts (due set, holds, facts cache,
                       groups), notify.ts (desktop and webhook)
  history/             runs-db.ts (bun:sqlite), catalog.ts (the catalog mirror), leases.ts, reconcile.ts, logs.ts
  safety/              trash.ts (ATTACH-based trash/restore), confirm.ts (tokens, impact hash, detached-run grants),
                       guards.ts (shrink, config change, pin change, hold), rename.ts, delete.ts, oob.ts (out-of-band
                       detection)
  agent/               templates/* (api by pagination, file, sql, transform), skill.md, claude-md.md (each phase's
                       cut of §9), docs/*.md (one page per topic and per error code; embedded; served by
                       `croft docs`; until `croft new`, the templates are docs/ingest.md, sql.md and
                       transforms.md), contract.test.ts (§4.1)
```

**Commands load lazily.** `cli/commands/index.ts` registers each command with `lazyCommand(spec, loader)`. The spec (`name`, `summary`, `usage`, `options`, `maxPositionals`, `humanShowsProblems`) is all that help, flag parsing and did-you-mean need. The module (`run`, `human`) is imported only when that command runs, so a broken DuckDB binding fails only the commands that need DuckDB, reported as `DUCKDB_BINDING_MISSING` or `DUCKDB_BINDING_LOAD` with the fix `croft doctor`. `docs`, `help` and `version` import nothing heavy and are what a broken install still answers with. A command whose human output shows its own problems (`doctor`, `validate`) sets `humanShowsProblems`; otherwise `main.ts` appends the standard problem blocks.

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

`fail()` raises only `KEYSET_STUCK` as itself. Any other code becomes `ASSET_CODE_ERROR`, with the requested code in `details.requestedCode`, because croft's control-flow, check and safety codes (`INTERRUPTED`, `CHECK_FAILED`, `CONFIRMATION_REQUIRED`, …) are reported only by croft.

`@zabaca/croft/read`:

```ts
export interface ReadOptions {
  project?: string;                          // project root; else CROFT_PROJECT, else walk up from cwd
  url?: string;                              // croft serve URL; else CROFT_URL, else .croft/serve.json, else direct
  token?: string;                            // else CROFT_SERVE_TOKEN, else the local serve.json
  limit?: number;                            // max rows; default 10,000; more is QUERY_TOO_MANY_ROWS, never truncation
  timeoutMs?: number;
}
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
// ResolvedAsset is project/resolve.ts's (below, D68): it carries the loaded TS and SQL modules, whose types core/
// does not import.
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
  created?: { columns: number; jsonColumns: number };                // this step created the table (§4.2)
  csvHeader?: { header: boolean; from: "declared" | "sniffed" | "known"; columns: string[] };   // first CSV load
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
// Phase-2 command data (§4.3): validate, preview, run --dry-run
export interface ValidateAsset { name: string; kind: AssetKind | null; inputs: string[];
  outputColumns: { name: string; type: string }[] | null; behavior: string; codeChanged: boolean;
  schedule?: { text: string; cron: string; next: string[] } }      // scheduled ingests (phase 3): next three fires
export interface ValidateData { order: string[]; assets: ValidateAsset[];
  types?: { status: "ok" | "failed" | "skipped"; errors: number } }            // --types only
export interface PreviewColumnChange { column: string; change: "added" | "removed" | "retyped"; type: string;
  from?: string; note?: string }
export interface PreviewAsset { asset: string; kind: AssetKind | null; status: "ok" | "failed" | "skipped";
  reason: string; rows: number | null; liveRows: number | null; partial: boolean; capped: boolean;
  requests?: number; since?: string;
  diff: { by: string[]; added: number; removed: number; changed: number; unchanged: number } | null;
  columns: PreviewColumnChange[]; checks: StepResult["checks"]; sample: Row[]; downstream: string[];
  durationMs: number; error?: Problem }
export interface PreviewData { assets: PreviewAsset[]; partial: boolean; inputsSnapshotAt: string | null;
  rebuild: boolean; rowCap: number }
export interface DryRunWindow { sinceValue: string | number; sinceType: CursorType; sinceAt?: string;
  source: "saved" | "from"; saved?: string | number; lookback?: string }
export interface DryRunConfirmation { action: "allow_shrink" | "large_reprocess"; command: string; impact: Impact }
export interface DryRunStep { asset: string; file: string; kind: "rows" | "file" | "transform" | "sql";
  action: "fetch" | "rebuild" | "update" | "skip"; reasons: Reason[]; reason: string; behavior: string;
  hold?: Hold; skippedBecause?: string; window?: DryRunWindow; confirmation?: DryRunConfirmation;
  problems: Problem[] }                                      // static errors that would fail it before it runs
export interface DryRunData { dryRun: true; order: string[]; steps: DryRunStep[] }
```

**Outside `core/types.ts`.** `ResolvedAsset` is `project/resolve.ts`'s, the planner's step is `run/plan.ts`'s, and the step contract is `run/step.ts`'s. `core/types.ts` must not import the project modules, because the declaration check of `src/read.ts` type-checks it without them (D68).

```ts
// project/resolve.ts: every asset discovered, loaded and checked (validate, the planner, status, describe, context)
export interface ResolvedAsset {
  name: string; file: string; path: string;
  kind: AssetKind | null;                                    // null: a TS file that loads as neither kind
  loaded: boolean;                                           // false: an ingest neither selected nor upstream (not imported)
  ok: boolean;                                               // loaded, with no error-severity problem
  inputs: string[];                                          // the AST's relations (+ plan scans) or `inputs`
  orderAfter: string[];                                      // inputs + tables read by its checks
  write: WriteMode; key: string[]; incremental: Incremental;
  behavior: string; words: string; behaviorHash: string;
  schedule?: { text: string; cron: string };                 // ingests only, from phase 3
  checks: Check[]; pins: Record<string, { type: string; format?: string }>;
  codeHash?: string;                                         // includes the project time zone; absent when the code does not parse
  timeZoneChanged?: { from: string; to: string };            // the same code; only croft.json's timezone changed
  description?: string;
  usesHttp?: boolean;                                        // TS: for TRANSFORM_MAKES_REQUESTS / cost guard
  confirmAbove?: number;
  ts?: LoadedTsAsset;                                        // the loaded module; ts.definition replaces `definition`
  sql?: LoadedSqlAsset;                                      // header, body, headerLines, AST inputs, fingerprint
  problems: Problem[]; output?: string[];
}
// run/plan.ts: one step per asset the run takes, in run order
export interface PlannedStep {
  asset: string; file: string; path: string; kind: "rows" | "file" | "transform" | "sql";
  action: "fetch" | "rebuild" | "update" | "skip"; reasons: Reason[]; hold?: Hold; reason: string;
  problems: Problem[];                                       // any error fails the step before it runs
  inputs: string[]; orderAfter: string[]; readBy: string[]; checks: Check[];
  sql?: LoadedSqlAsset; loaded?: LoadedTsAsset; spec?: TsAssetSpec; usesHttp?: boolean; confirmAbove?: number;
  write: WriteMode; key: string[]; incremental: Incremental; behavior: string; words: string;
  codeHash?: string; behaviorHash: string; retries: number; timeoutMs: number; output?: string[];
}
export interface RunPlan { steps: PlannedStep[]; order: string[]; problems: Problem[]; fileDirs: string[] }
// run/step.ts: what runIngest, runSqlStep and runTransform take; each returns a StepOutcome or throws a CroftError
export interface StepInput { step: PlannedStep; project: Project; env: ProjectEnv; warehouse: DuckWarehouse;
  runs: RunsDb; runId: string; attempt: number; maxAttempts: number; signal: AbortSignal; progress: StepProgress;
  log: LogWriter; checks?: WriteBatchInput["checks"]; readBy?: Record<string, string[]>; confirm?: ConfirmDecider;
  preview?: { rows: number }; http?: Partial<Omit<HttpOptions, "signal" | "redact" | "log">>; fault?: string;
  now?: () => Date }
export interface ConfirmRequest { asset: string; action: "allow_shrink" | "large_reprocess"; command: string;
  impact: Impact; problem: Problem }
export type ConfirmDecision = { kind: "granted" } | { kind: "pending"; confirmation: Confirmation } | { kind: "declined" };
export type ConfirmDecider = (r: ConfirmRequest) => Promise<ConfirmDecision>;
// load/write.ts and history/catalog.ts, phase-2 additions
//   WriteResult.checks: StepResult["checks"]            what the checks hook reported
//   CheckHookResult { problems: Problem[]; results: StepResult["checks"] }
//   InputPosition { input; seenLoadedAt; seenKey?; inputLastLoadedAt? }   upserted into _croft.inputs with the write
//   CatalogAsset.inputsSeen?: Record<input, { seenLoadedAt; seenKey; inputLastLoadedAt }>; CatalogAsset.reads?
```

### Test strategy (`bun test`)

`bunfig.toml` preloads `tests/preload.ts`, which sets two tripwires before any test file loads: `CROFT_FORBID_OS_JOBS=1` (registering the scheduler refuses instead of installing a launchd or crontab job) and `CROFT_NOTIFY_DRY=1` (a failure notification is logged instead of shown). The e2e harness passes both to every croft it spawns. Build: under `CROFT_FORBID_OS_JOBS=1` the scheduler's `OsRunner` refuses to run anything (tests inject a fake one), and `croft schedule` refuses a home or croft folder that is the real user's, taken from the password database since Bun's `os.userInfo().homedir` returns `HOME` [V]; tests set `HOME`, `CROFT_HOME` and a unique `CROFT_JOB_LABEL`. `CROFT_NOTIFY_DRY=1` records each notification in `<state>/logs/notifications.ndjson`; a loopback webhook is still posted, so tests use a mock server. `core/codes-raised.test.ts` is a gate: every registered code is raised somewhere in the source, or listed with the later phase that raises it, and that list only shrinks. It does not count comparisons, `case` labels or `[…].includes()` lists as raising a code.

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
3. **End-to-end fixture projects** driven by spawning the real CLI (`tests/e2e` holds 24 journey files; phase 2 added `j16`–`j19`, for SQL transforms, TS transforms, preview, and validate with the dry run; phase 3 added `j20` (schedule: holds, a scheduled run with its downstream, pause, missed fires run once, a stale scheduler, off), `j21` (serve: an app reading through it, tokens, a second server refused, the banner, a scheduled run while it serves), `j22` (a scheduled failure: the desktop record and the webhook, redacted, then backoff) and `j23` (the read copy, with a GUI-like process holding it)). A `Bun.serve` mock API covers:
   - ascending keyset, newest-first `starting_after`, and Link pagination;
   - epoch cursors;
   - 429 with `Retry-After`, and flaky 500s;
   - an empty page as if auth failed;
   - type drift between pages, and big integers.

   Every `--json` output is golden-tested against its JSON Schema.
4. **Concurrency:**
   - a run plus a query; a foreign read-only holder; two runs on one asset; a tick overlapping a manual run; a detached run followed by `wait`;
   - `croft serve` under steady load while runs write. The writer must get the file within 100 ms with no query in flight, and within 2 s + 100 ms with a 60 s query in flight.
   - two writers, where A removes its intent while B still waits and B must get the file;
   - 16 concurrent long queries at handoff; an idle connection at handoff (assert zero open connections before the file is released: before `closeSync()` in the first build, before the worker is killed since D76);
   - a stale intent whose PID was reused; a writer blocked by a foreign holder, which withdraws its intent;
   - three direct app readers against one writer.

   Build: the suite lives in `tests/concurrency/` (runs, serve, direct) and uses real processes only: the CLI, `croft serve`, probe writers, foreign DuckDB holders and direct-mode apps. The timing budgets use a probe writer that follows croft's own intent protocol but retries the lock every 5 ms (a real `croft run` backs off up to 1 s, which would hide how fast serve lets go), measured from the writer's own intent `since`; real runs write in the same tests and must succeed. With the query worker (D76), `src/serve/instance.test.ts` adds a stuck query plus a writer (the writer's wait under `graceMs` + 1.5 s), deadlines and aborts of queries no interrupt stops (while executing and while planning), a worker crash, `kill -9` of croft serve leaving no lock, and the worker's peak memory for a 20M-row table read with `limit` 10.
5. **Crash tests.** `CROFT_FAULT=after_stage|before_commit|after_commit_before_sqlite|between_trash_and_drop|mid_chunk` makes the child `SIGKILL` itself (`mid_chunk`: halfway into filling the chunk after an incremental transform's first commit). The parent then asserts that data and state agree, the cursor is at most the committed maximum, and the next run succeeds.
6. **Scheduler tests** with a fake clock (`CROFT_NOW`) and a fake `HOME`. They check plist and crontab generation, registry pruning, heartbeat verification, the tick singleton, holds, stale-transform pickup, and DST golden days (2026-03-08 and 2026-11-01 in several zones). Real OS registration is exercised in a phase-3 spike and in manual release checks, because CI cannot install launchd jobs. Build: the registry lock has race tests (24 writers over a dead holder's lock, a pruning tick racing 12 writers, a holder killed inside the lock), and missing projects use a fake filesystem for mounted and unmounted disks. The e2e journeys turn scheduling on with `croft schedule on --no-os-job` under a temporary `HOME` and `CROFT_HOME`, and play the OS job by running `croft tick` at chosen `CROFT_NOW` times. The real LaunchAgent was checked once by hand [V] (§8).
7. **`@zabaca/croft/read` under Node** (current LTS) in CI, in both modes:
   - HTTP against `croft serve`: token, a wrong token (`SERVE_UNAUTHORIZED`), `503` with `Retry-After`, `SERVE_UNAVAILABLE`, and loopback with `HTTP_PROXY` set;
   - direct;
   - a golden test that the same query gives identical rows in both modes, and the Next.js `serverExternalPackages` setup.

   Build: `src/read/node-read.test.ts` builds the bundle with `scripts/build-read.ts` into a private folder and runs it under the real Node against a real `croft serve` process: the right and a wrong token, the `serve.json` route, `CROFT_URL` with `CROFT_SERVE_TOKEN`, a `503` retried until the same query succeeds after the write, `SERVE_UNAVAILABLE` once the client's timeout has passed, a recording `HTTP_PROXY` that sees nothing, direct mode, and identical rows from the server, Node direct and Bun direct. The Next.js setup is not covered yet.
8. **CI matrix.** macOS arm64, Linux x64 glibc and Linux arm64 are tier 1, each on the Bun floor (1.3.14) and `bun@latest`. Alpine and Windows get smoke tests.
9. **Agent evals** from phase 2 onward. Headless Claude Code sessions run fixture tasks:
   - "add Stripe charges and daily revenue, schedule hourly";
   - "the pipeline failed last night, fix it";
   - "rename a column used downstream";
   - "backfill 90 days";
   - "why is this number wrong";
   - "the API changed a field type".

   They are scored on success, number of commands, and whether the agent ever ran `croft confirm` without asking. Every stumble becomes a hint, a doc page or a template.

   The harness is `packages/croft/evals` (not shipped), run with `bun evals/run.ts [task…] --tag T`, with results in `evals/results/<date>-<tag>.json`. A fixture is a project as `croft init --no-install` and `bun install` leave it: this package linked in, a `croft` shim on `PATH`, a mock API with its secret in `.env`, and a git baseline commit so the agent's diff is recorded. Its `.claude/settings.json` allows croft, bun and the file tools, asks before `croft confirm`, and denies `Read(./.env*)`. Each session is told the user is away: do what it can without approval, and list what needs it. The scores are the verifier's pass (every warehouse, code, data and file check), the count of croft commands, `confirmWithoutAsking` (any `croft confirm` attempt), `readEnv` (any attempt to open `.env` or `.env.*`), turns, cost and duration. Phase 2 has two tasks, rename-column and wrong-number; `bun test` runs only the harness's self-test, never Claude Code.

---

## 11. v1 scope, cut list, and phased build order

### Cut from v1

Each item is marked with where it goes instead, if anywhere.

- **Incremental SQL** (`new.<table>`). It is designed and verified, and it is post-v1 #1.
- **`--to`/`--step` windowed backfills.** `--from` on merge ingests covers the need.
- **Schedules on transforms.** Transforms follow their inputs.
- **Native Windows** (use WSL) and Windows scheduler registration.
- **File reads inside SQL assets** (`SQL_READS_FILES`). Files come in through file ingests.
- **Named or virtual environments,** fingerprinted physical tables, plan/apply promotion, `copy` and `--database`.
- **A write daemon,** remote execution, multiple projects per database. (`croft serve` is in v1, but it only reads and schedules.)
- **Child tables, native STRUCT typing and flattening** of nested data. JSON columns are used instead.
- **SQL time windows and partitions** as concepts; view-kind SQL models; SQL macros and templating.
- **Standalone check files** (`checks/*.sql`). Row rules with subqueries cover most cases.
- **`query --write`.** `delete --where` and fixing the asset cover the need.
- **Exports:** `croft export`, and shipping data files to a hosting provider. (A hosted app can already query a `croft serve` the user runs, D53.)
- **`croft refs`** (column reference search). `rename` lists references, and `validate` plus the Proxy guard catch breakage.
- **Modeling features:** SCD2 history, delete propagation from sources, column lineage, SQL unit tests with fixtures, and quarantine of bad rows.
- **Source frameworks:** a declarative REST source DSL, and database sources as a feature. A Postgres ingest via `Bun.sql` is a doc recipe.
- **Scale and platform:** parallel SQL execution; OS keychain secrets; sensors and freshness policies; xlsx (needs a downloaded extension); a compiled single binary (works only with a dylib-embedding workaround [V]); tier-1 Windows.
- **Excluded by requirement:** a web UI, and dlt/SQLMesh/Dagster compatibility.

### Phases

Each phase is usable end to end, and each ships `--json`, error codes, docs pages and skill updates for what it adds. Estimates assume one engineer directing Claude Code. They were revised upward after the technical review, which judged the transform and scheduling estimates about 2× optimistic.

| Phase | Ships | Usable result | Effort |
|---|---|---|---|
| **1. Load and look** | launcher; `init` (empty folder and existing repo), relocation off synced folders; `doctor`; `docs`; skill and CLAUDE.md; `ingest()` for rows and files/URLs (`union_by_name`, encoding fallback, `map`); staging, classification, type rules, whitelisted casts, round-trip loss check, evolution (DDL before DML), JSON columns; replace (as a diff), append and merge with dedupe; typed cursors and lookback; the shrink guard with minimal trash and confirmation tokens; connection factory, sandbox and single-SELECT gate; `fromCache` instance registry; leases (with boot id) and lock diagnostics; `reconcile`; `run` (detach off a TTY, `wait`, signals), `query`, `status`, `describe`, `context`, `logs`, `secrets`; `@zabaca/croft/read` (built JS, direct mode with the write-intent handshake) | Claude pulls an API or a folder of CSVs into DuckDB incrementally, answers questions from it, and an app reads it | ~3.5 weeks |
| **2. Transform and trust** | SQL assets (single-statement check, temp-view wrapper, reserved columns, PIVOT, catalog and file-read errors, `VOLATILE_SQL`); dependencies from AST + unoptimized plan; graph, staleness and fingerprints; bind check (`INPUT_NOT_BUILT`, `NULL_ONLY_COLUMN`, `QUOTE_IDENTIFIER`); TS transforms (full and incremental, ordered Parquet snapshots, round-trip value types, Proxy rows, composite positions, chunked commits, cost guard); checks and warnings in the write transaction; `preview` (snapshots, partial diffs, `--rebuild`); `run --dry-run`; docs pages for its codes | raw → clean → report tables that cannot receive bad data, and per-row LLM transforms that survive failures without re-billing | ~4 weeks |
| **3. Keep it fresh** | gate: a spike on launchd and crontab registration; schedule phrases and the DST-defined matcher; per-user job, registry and heartbeats; `croft tick` (plan-and-spawn, singleton); holds, `pause`, stale-transform pickup; retries, no-progress timeouts, catch-up once, skip on overlap; desktop (default on) and webhook notifications; **`croft serve`** (HTTP read API with token auth, write-intent handoff, built-in scheduler loop) and the `@zabaca/croft/read` HTTP client; opt-in read copy | hands-off hourly pipeline that survives sleep, crashes and reboots, never runs half-finished edits, and serves apps (local or hosted) live data | ~3.5 weeks |
| **4. Grow safely** | monotone partial commits for cursor ingests (resumable first loads); full trash, `restore` and `delete` (whole table and `--where`); `--rebuild` rules; `--from` backfill matrix; `INGEST_CONFIG_CHANGED` and key conversion; `PIN_CHANGES_DATA`; `rename` and `ASSET_RENAMED`; drift warnings; `OUT_OF_BAND_CHANGE`; pre-upgrade backups; `EMPTY_EXTRACT` | long-lived sources and paid transforms change shape without refetching or losing data | ~2 weeks |
| **5. Agent-grade release** | all templates (every pagination style), a docs page per code, JSON Schemas and golden tests, generated input types (`.croft/types`, so `validate --types` catches renames in TS), agent evals in CI, CI matrix (Bun floor and latest), opt-in hook, npm 0.1 | Claude Code operates a project from a cold start, measured by evals | ~1.5 weeks |

**Phase 1 is complete** (2026-09-23). `core/phase.ts` records which command and flag ships in which phase (§4.1), and the agent texts are cut to match (§9, D59). Phase 1 had no `run --dry-run`, `validate` or `preview`: it backfilled with `croft run <asset> --from <when>`, checking the saved cursor first with `croft describe <asset>`. Its ingest templates are the docs page `croft docs ingest`, ahead of phase 5's `croft new` (D60).

**Phase 2 is complete** (2026-09-24), with about 2,230 tests. It ships SQL assets (§3c), the dependency graph, staleness and fingerprints, the bind check, TS transforms with snapshots, composite positions, chunked commits and the cost guard (§3e, §5), checks and warnings on every write (§3f), `validate`, `preview` with `query --preview` (§6), and `run --dry-run`, `--only` and `--upstream` (§4.1). The warehouse format is 3 (§5, D69). The build changed some decisions, recorded as D65–D75: a transform's duplicate key fails instead of being deduplicated, the preview keeps its own catalog, chunks are cut at a `newRows()` request, `ResolvedAsset` lives in `project/resolve.ts`, staleness compares a recorded input version (format 3), HUGEINT snapshots are text, SQL steps drop reserved names without regard to case, a position counts yielded outputs, header lines must come first, the SQL fingerprint keeps the case of column names, and `status` resolves the asset code. Phase 2 ships the `CLAUDE.md` block of §9 word for word, and SKILL.md with only phase 3–5 lines left out; its templates are the docs pages `ingest`, `sql` and `transforms`, with `checks` for the check language, ahead of phase 5's `croft new`. It also ships a docs page for each of 23 codes (the 17 codes phase 2 first raises, and six older ones that its SQL assets and bind check raise most), ahead of phase 5's "a docs page per code", and the agent eval harness with its first two tasks (§10). Not yet: schedules, `croft serve` and the read copy (phase 3), and `--rebuild`, `rename`, `delete` and `restore` (phase 4), so hints name what this build can do instead (§4.1).

**Phase 3 is complete** (2026-09-24), with about 2,985 tests. It ships schedules (§8): the phrase parser and the DST-defined matcher, `croft schedule on|off|pause|status`, the per-user OS job (a LaunchAgent on macOS, verified on a real Mac [V], and a crontab block on Linux), the project registry with its OS lock, the per-user tick script and heartbeats, the project tick (`croft tick`, hidden) that plans and spawns `croft run --due`, the due set with its holds, backoff, catch-up once and skip on overlap, and failure notifications on the desktop and to a webhook. It ships `croft serve` (§5): its query worker and watchdog, streamed results within `limit`, `maxRows` and `maxBytes`, a bounded queue, the serve gate's `SHOW` and range limits, the write-intent handoff, `GET /status` as the status envelope, and the scheduler loop; and the opt-in read copy, from which serve answers with `stale` and `asOf`. Scheduling shows in `status`, `doctor`, `context`, `describe` and `validate`. `runs.sqlite` gains its `settings` table (migration 2); the warehouse format stays 3. The build changed some decisions, recorded as D76–D85: croft serve holds the file in a worker process that it kills to release it, holds in a scheduled run are warnings, a phase has a completion flag, the scheduler caches what it knows of each asset by file hash, interval crons fire at both passes of a repeated hour, `GET /status` is the status envelope without asset code, the registry takes an OS lock and keeps missing projects for 30 days, the job's Bun is never older than croft needs, a generated serve token is new on every start, and a scheduled transform's failure backs off. Phase 3 ships the `CLAUDE.md` block of §9 word for word, and SKILL.md with its phase-3 lines restored and only phase 4–5 lines left out, plus a Schedule recipe; the docs topics `scheduling`, `serve` and `read-copy`; and pages for five more codes (§9). The e2e suite gains `j20`–`j23`, and the concurrency suite and the read client under Node now run against real processes (§10). Not yet: `--rebuild`, `rename`, `delete` and `restore` (phase 4), and `croft new` (phase 5).

The total is about 14.5 engineer-weeks and roughly 14–16k lines. The user chose to ship all five phases as v1.

**Post-v1 candidates, in order:**

1. Incremental SQL (`new.<table>`), with pre-images of updated and deleted rows.
2. `croft refs`.
3. `croft export`.
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
| The user's app or a SQL GUI holds the live file and blocks writes | apps query through `croft serve`, which steps aside for writes in 10–23 ms [V]; the direct `@zabaca/croft/read` fallback honors the write-intent handshake; GUIs use the opt-in read copy; lock errors name the program and PID; `doctor` shows the holder |
| `croft serve` exposes data beyond the machine, or to browser pages | token always required (generated into `serve.json`); Host and Origin checks against DNS rebinding and cross-origin requests; loopback by default, HTTPS proxy otherwise; tables only, no file access; query deadline, concurrency, queue, body, row and memory limits, and a query worker that can be killed |
| Apps get `503` during write steps longer than 10 s | most write steps take seconds; turn on `readCopy` for stale-but-available answers (`stale: true`); writers blocked by a foreign holder withdraw their intent |
| Server handoff bugs lock writers out | intents are per holder with boot-id liveness; every connection is closed, then the query worker is killed, so a writer waits at most `graceMs` + `killAfterMs` whatever a query does (D76); handoff tests cover two writers, long, stuck and idle queries, `kill -9` of the server, and reused PIDs [V] |
| A long write step blocks other commands | the lock is held per write step only; extraction and TS code run lock-free; `status`/`context`/`validate` and `run --dry-run` never open the warehouse; off a TTY, waits cap at 90 s and name the holder |
| The agent's shell timeout kills long runs | off a TTY, runs always detach and return exit 6 with a run id; `wait`; `status.running[]` |
| AI-edited code runs unattended on real data | the scheduler hold (only code a human has run); per-file import isolation; checks inside the transaction; trash |
| AI-written SQL or tools overwrite the database | sandboxed connections (external access locked, allowed directories only); single-SELECT gate; the asset import scan; out-of-band detection |
| Paid per-row transforms run up bills | incremental template by default; the cost guard (`LARGE_REPROCESS`); preview caps input rows; unchanged rows keep `_loaded_at` through diff writes; `TRANSFORM_MAKES_REQUESTS` |
| Wrong numbers from API semantics (records that change after creation, newest-first paging, epoch cursors) | pagination-specific templates; typed cursors with `unit` and `lookback`; `KEYSET_STUCK`; the skill's API rules; `SINCE_IGNORED`, `EMPTY_EXTRACT` |
| Silent corruption through DuckDB implicit behavior (rounding casts, dropped offsets, dropped struct fields, MERGE duplicates, sniffer date flips, union-by-name drops) [V] | whitelisted casts plus a round-trip loss check; JSON staging; dedupe before merge; own CSV typing with per-column formats; `union_by_name`; one scenario test per hazard |
| Strict type conflicts stop a scheduled pipeline | preview shows conflicts before the first real load; name-typed placeholders avoid most wrong first guesses; errors state the effect and give fixes in order; notifications |
| Scheduler silently not running (privacy protection, WSL idle, moved projects, version managers) | `schedule on` waits for a real heartbeat; `SCHEDULER_STALE` reads the tick log and names a cause; the registry prunes moved projects, but keeps a project on an unplugged disk or behind a privacy block; a stable Bun path that is never older than croft needs; the registry's OS lock, which a dead writer cannot leave behind |
| Bun or DuckDB behavior changes across versions (as `Bun.cron.parse` did) | enforced Bun floor; CI on the floor and on latest; DuckDB pinned exactly; the fingerprint ignores `query_location`; format check; backup before an engine upgrade |
| Inferred write behavior surprises (forgot `key`) | behavior stated in words everywhere; `INCREMENTAL_WITHOUT_KEY` is an error; a key implies uniqueness checks |
| Synced folders corrupt the database | automatic relocation to `~/.local/share/croft/…` at `init`; `doctor` flags an existing project on synced (`DB_ON_SYNCED_FOLDER`) or lock-unsafe (`SERVE_UNSAFE_FILESYSTEM`) storage |
| Agent runs destructive commands casually | trash for every destructive action; `croft confirm` tokens with recomputed impact; one `ask` rule gates all of them; destructive commands never in `next`; skill rules; evals |
| Missed dependencies make tables silently stale (`query_table`, `query()`, macros) [V] | dependencies are the union of the AST and the unoptimized bound plan; a golden corpus compares both |
| Long paid transforms never finish, or re-bill after a failure | chunked commits with composite positions; staged-chunk reuse on retry; no-progress timeouts |
| DST drops or doubles scheduled runs [V] | fire times defined as instants; golden DST tests |
| Estimates slip (the technical review judged the first plan ~2× optimistic) | re-estimated phases; phases 1–2 are a coherent first release; the phase-3 registration spike gates the rest of scheduling |
| Scope creep toward matching Dagster, dlt and SQLMesh | fixed 7-concept vocabulary; explicit cut list; each phase gated on agent evals |

---

## 13. Decision log

Each entry gives the options, the choice and the reason. **(rev)** marks decisions changed or extended after the adversarial reviews, or by the build. A **Build:** line records how the shipped code (phase 1 on 2026-09-23, phases 2 and 3 on 2026-09-24) refined a decision.

**D1. Daemon or per-step open. (extended by D53)**
- Options: a `Bun.serve` daemon owning the file; short-lived processes opening the file per step.
- Choice: per step for every write; there is no write daemon. (D53 adds `croft serve`, an optional read-only server that runs no user code and closes the file for every write.)
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
- Reason: there are only four keys (`description`, `key`, `check`, `warn`), and repeatable `check` lines read naturally.
- Build: any `-- word: value` line at the top is a header line, matched without regard to case, and header lines must come first (D73, §3c).

**D6. Write behavior. (rev)**
- Options: an explicit mode everywhere; inferred from key and incremental.
- Choice: inferred, with an optional `write` override. An incremental API ingest without a key is an error unless `write: "append"` is explicit.
- Reason: this is one fewer thing to learn, and the one inference that silently duplicates rows now has to be stated on purpose.
- Build: `INCREMENTAL_WITHOUT_KEY` also covers incremental TS transforms; incremental file ingests are exempt (they reload by `_file`). `write: "merge"` without a key, and `write: "replace"` with `incremental`, are `ASSET_INVALID` (§3a).

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
- Build (phase 3): a hold is a warning that skips the step, never a failure, so a held asset neither fails its scheduled run nor notifies (D77). A held step is skipped even when its code no longer loads.

**D10. Guarding destructive operations. (rev)**
- Options: a trailing `--yes`; a human-only `approve`; `croft confirm <token>`.
- Choice: tokens. Off a TTY, a destructive command exits 5 with its impact and a token, and `croft confirm` recomputes the impact before acting. On a TTY, a y/N prompt.
- Reason: consent is tied to the impact that was shown, stale impacts are refused, and one Claude Code prefix rule (`Bash(croft confirm:*)`) gates every destructive path. A trailing flag cannot be targeted reliably.
- Build: revised by D56. Only `croft confirm` carries a token: no command takes one as a flag, and a detached confirmed run gets it through a one-time grant.

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
- Build: `CSV_HEADER_AMBIGUOUS` is asked on the first load only. Later loads reuse the stored header decision (named columns, or `column0`, `column1`, …), so a header-only export or a new column name never asks again (§3b).

**D15. Type conflicts. (rev)**
- Options: widen to VARCHAR automatically; fail; quarantine.
- Choice: fail, with fixes ordered clean → pin with format → pin VARCHAR. Implicit casts are whitelisted to "same kind, other format" and verified by a round-trip loss check.
- Reason: DuckDB casts drop offsets and round fractions without producing NULLs [V], so a NULL-based loss check was not enough.
- Build: numbers are compared in an exact canonical form, not as `DECIMAL(38,18)`, which gave false losses for ordinary doubles [V]. Integer text with leading zeros counts as a loss, and a JS number at or beyond 2^53 into a DOUBLE column is a `TYPE_CONFLICT` (§7).

**D16. All-NULL columns. (rev)**
- Options: create later; a VARCHAR placeholder; a placeholder typed from the name.
- Choice: typed from the name (`*_at` → TIMESTAMPTZ, …), marked pending.
- Reason: VARCHAR placeholders break `date_diff`, comparisons and `COALESCE` [V]. Pending columns can be retyped freely.
- Build: camelCase names follow the same rules (`closedAt`, `isActive`).

**D17. Column names. (rev)**
- Options: snake_case everything; keep as written.
- Choice: keep, with minimal cleanup (collapsing `_` runs). Keywords are kept and quoted, with `QUOTE_IDENTIFIER` help.
- Reason: SQL matches the API docs the agent reads.
- Build: names are NFC-normalized and keep combining marks. Keys that clean to the same name merge case-insensitively (first spelling wins); only two such keys in one row split, to `<spelling>_2`, with `COLUMN_NAME_COLLISION` (§7).

**D18. Session time zone. (rev)**
- Options: UTC; the project time zone.
- Choice: the project time zone. JSON renders timestamps with the project offset.
- Reason: `::DATE` gives the user's days [V]. UTC JSON output made correct day buckets look wrong to an agent.
- Build: the zone is set with `SET GLOBAL TimeZone` before the sandbox locks the configuration. Offsets are always `±HH:MM` from one renderer (`core/time.ts`), and `doctor` warns `TZDATA_MISMATCH` when Bun's and DuckDB's zone data disagree (§7).

**D19. Cursor value. (rev)**
- Options: the JS maximum of strings; a typed maximum in DuckDB.
- Choice: the typed maximum, stored as the original text, never regressing. The cursor type (timestamp, date, integer with unit, string) is fixed on the first load, and `since`, lookback and `--from` are rendered in that type.
- Reason: this orders correctly across offsets, hands the API back exactly what it sent, and keeps epoch-second APIs from receiving ISO strings.
- Build: the type is fixed by the first load with a non-null cursor value, and may later change once, from date to timestamp, after a DATE widen. Integer cursors beyond 2^53 reach `since` as exact digit strings (§3a). A text cursor takes `--from` as is (D64).

**D20. Pagination. (rev)**
- Options: `http.paginate` presets; plain `get` plus templates.
- Choice: plain `get`, with `croft new api --pagination keyset|cursor|link|page` and `KEYSET_STUCK`.
- Reason: one obvious loop per API style. Keyset is safe only for ascending sorts [V].
- Build: `croft new` is phase 5. Phase 1's keyset, cursor and Link templates are on the docs page `croft docs ingest` (D60).

**D21. Big integers.**
- Options: exact strings; `JSON.rawJSON` objects; `bigint`.
- Choice: `bigint` in user code, raw digits in NDJSON [V].

**D22. Code-change policy. (rev)**
- Choice: SQL and full-refresh TS transforms rebuild; incremental TS transforms are forward-only, with an offered `--rebuild`; ingests never refetch. Now enforced by the cost guard (`LARGE_REPROCESS`) and diff writes that keep `_loaded_at` for unchanged rows.
- Reason: rebuild when it is free and deterministic; never spend the user's API money implicitly.
- Build: until `--rebuild` ships (phase 4), `EDITED_SINCE_LAST_RUN` for an incremental TS transform says the rows built earlier keep their values and names no command. The cost guard counts only the inputs the code reads with `newRows()` (§5).

**D23. TS fingerprint. (rev)**
- Choice: a `Bun.build` bundle hash with identifier minification off [V].
- Build: the version of `@zabaca/croft` itself is left out (`FINGERPRINT_IGNORED_PACKAGES`), so a croft upgrade does not mark every TS asset edited and hold it from the scheduler. Bun names a default export after its file, so that identifier is replaced with a fixed name, and a renamed file keeps its hash for `ASSET_RENAMED` (§8).

**D24. Cron evaluation. (rev)**
- Choice: croft's own matcher.
- Reason: `Bun.cron.parse` behaves differently on 1.3.14 and 1.4.2 [V].
- Build: the matcher reads Vixie cron (names in any case, 7 is Sunday, `a/n` to the field's end, `?` as `*`, either restricted day field matching) and refuses Quartz's `L`, `W` and `#` and crons that never fire. Interval crons fire at both passes of a repeated hour (D80). The phrase parser takes more than §8's list, and its suggestions always parse (§8).

**D25. Run concurrency.**
- Options: one project lock; per-asset leases.
- Choice: leases.
- Reason: a long scheduled load must not block unrelated work.

**D26. Secrets. (rev)**
- Options: OS keychain; `.env` via Bun's automatic loading; `.env` parsed by croft.
- Choice: `.env` parsed by croft, with Bun's loading off (`--no-env-file` [V]). Only declared names reach `ctx.secret()`; every `.env` value is redacted. "Edit `.env`" is the primary instruction, and `secrets set` (with `--stdin`) is a convenience.
- Reason: Bun's loading depends on the working directory (scheduled ticks saw no secrets) and silently prefers `.env.local`. `.env` works everywhere, including under Claude Code, where the user has no TTY.
- Build: redaction in command data is narrower (D54). Because Bun hands children the environment it started with [V], the launcher strips values Bun loaded from `.env`, and every child croft spawns gets an explicit environment (§2, §9.8).

**D27. Claude Code settings.**
- Options: `init` writes permission rules and hooks; `init` writes neither.
- Choice: neither. `croft docs claude-permissions` prints the suggested `ask` rule, and the hook is opt-in.
- Reason: settings that change what the agent may do belong to the user.

**D28. Validation naming.**
- Choice: `validate` for the project, after every edit; `doctor` for the environment plus a summary.

**D29. Check syntax. (rev)**
- Choice: one string language shared by TS and SQL, where each check is parsed as a single expression and executed through `prepare()`.
- Reason: interpolating check text into a multi-statement call executed an embedded `DROP TABLE` [V].
- Build: a check reads the project's tables only, by plain name; paths, other schemas, `_croft.*`, SQL given as text and side effects are `CHECK_INVALID`, and every rule is vetted again on the write connection (§3f).

**D30. Merge implementation.**
- Choice: always deduplicate first, and put no constraints on user tables.
- Reason: MERGE mishandles duplicate source keys both ways [V].
- Build: deduplication is for ingests only. A transform's duplicate key fails (D65).

**D31. Emptiness guard. (rev)**
- Choice: `SHRINK_GUARD` above 50% loss for ingests. Its override is a destructive operation (trash + confirmation), and its fix requires a human.
- Reason: the override was the one path that wiped irreplaceable data without the trash.
- Build: revised by D63. `allowShrink: true` in the asset is a standing override that asks nothing but still trashes first.

**D32. App access. (rev, superseded by D53)**
- Options: an open-per-query helper on the live file; a read copy.
- Choice (before D53): a read copy by default, and `@zabaca/croft/read` reads only the copy. It ships as built JS.
- Reason: readers on the live file delay writers [V]; GUIs left open block everything; Node cannot import TS from `node_modules` [V].

**D33. Long runs. (rev)**
- Options: rely on the agent to background runs; `--background` plus `wait`; auto-detach off a TTY.
- Choice: auto-detach off a TTY, with `--follow 100s`, then exit 6 with a run id.
- Reason: an agent cannot know in advance that a first load takes 30 minutes. A killed foreground run loses everything.

**D34. Launcher. (rev)**
- Choice: a global shim delegating to the project-pinned version; `bunx` still works.
- Build: the bin is `bin/croft.mjs`, plain JavaScript whose `sh` first line picks `bun` or `node`, so `NEEDS_BUN` is answered even under Node. The launcher installs only for commands that can change data and only when `node_modules` is missing entirely; a still-missing pinned copy is `INSTALL_FAILED` (§2).

**D35. Platforms. (rev)**
- Choice: tier 1 is macOS and Linux glibc; musl and Windows are tier 2. The Bun floor is 1.3.14, the verified version, with CI on the floor and on latest.
- Reason: `Bun.cron` did not exist before 1.3.11, and parse behavior changed after 1.3.14 [V], so "1.3 or newer" was false.

**D36. Standalone check files and notifications. (rev)**
- Choice: check files are cut (row rules with subqueries instead). Failure notifications are kept: desktop by default for scheduled runs, and an optional webhook.
- Reason: "something failed overnight" must reach a user who never reads logs.
- Build (phase 3): the webhook payload adds `text`, the notification in one line, because Slack's incoming webhooks (the §8 example) reject a post without it, and it leaves out any confirmation, which holds a token. Webhook delivery retries network errors, 429 and 5xx, 3 attempts of 10 s. Everything sent is redacted, and a failed notification is a line in `<state>/logs/notify.log`, never a failed run (§8).

**D37. Scheduler registration. (new)**
- Options: `Bun.cron` per project; one per-user job written by croft.
- Choice: one per-user job, a project registry and heartbeats.
- Reason: `Bun.cron` is new and version-dependent, orphans jobs when projects move, and logs where croft never looks. A heartbeat proves the job actually runs.
- Build (phase 3): a real LaunchAgent installed by `croft schedule on` ran a scheduled ingest from launchd, and `croft schedule off` removed it [V] (§8). The plist adds `AbandonProcessGroup` and a `PATH` with Homebrew's folders; the crontab line sits between marker lines. The per-user tick script is a versioned template that imports nothing from croft. The registry takes an OS lock and keeps a project whose disk is not mounted (D82), and the job's Bun is never older than croft needs (D83).

**D38. Replace semantics. (new, rev)**
- Options: DELETE + INSERT; a diff (MERGE with `NOT MATCHED BY SOURCE THEN DELETE`).
- Choice: a diff.
- Reason: restamping every row on every replace would wake, and bill, every downstream incremental transform [V].
- Build: a keyless diff pairs rows by exact equality plus an occurrence index instead of a stored row hash, so a hash collision cannot pair two different rows. File reloads are the same diff limited to the reloaded files' rows; with a key, a row is deleted only when no present file still has its key (D58). `last_loaded_at` moves only when rows changed (§5).

**D39. TypeScript transforms. (new)**
- Choice: the template is keyed and incremental; rows are Proxy-guarded; there is a cost guard.
- Reason: the audience's most common transform calls an LLM per row. Renamed columns must fail loudly instead of becoming NULL [V].
- Build: the request detection covers the common LLM SDKs (§3e). The guard fires only when an input no longer has the column; an ingest never drops one, so a renamed API field reads as NULL, and a `not_null` check catches it (§3e).

**D40. User SQL safety. (new, rev)**
- Options: trust READ_ONLY; parse-gate only; sandbox only; both.
- Choice: both: a single-SELECT gate plus sandboxed instances.
- Reason: READ_ONLY still allows `COPY TO` over the warehouse [V], and the sandbox alone still allows `DETACH`/`ATTACH` of permitted paths [V].
- Build: the gate also walks the AST. Every path must be a literal and is resolved as `open(2)` would; the connection's own database files and protected paths are refused, because the sandbox always lets a connection read its own file and a second descriptor drops the lock. Table functions are an allowlist, since `enable_logging` changed a locked READ_ONLY instance [V]. `croft serve` allows only user tables, CTEs and five harmless table functions (§5).

**D41. Command surface. (new)**
- Choice: 19 commands (20 once D53 added `serve`). `plan` became `run --dry-run`; `history` became `logs --runs`; `trash` became `restore` with no arguments; `drop` became `delete`. `copy`, `--database`, `query --write` and `--step` are cut; `confirm` and `rename` are added.
- Reason: fewer commands to learn, without losing any agent-facing capability.

**D42. `init` in an existing repo. (new)**
- Choice: a `data/` subproject; never overwrite app files; exclude `data` from the app's tsconfig.
- Reason: "add pipelines to my Next.js app" is a primary journey, and clobbering `package.json` or `tsconfig.json` is unacceptable.

**D43. Synced folders. (new, rev)**
- Options: warn; relocate automatically.
- Choice: relocate the database and `.croft/` to `~/.local/share/croft/…`.
- Reason: `~/Documents` and `~/Desktop` are commonly iCloud-synced, and asking a non-data-engineer to pick a path is not "just works".
- Build: `init` relocates; `doctor`, which promises no writes, reports an existing project's location with a manual fix, as the warning `DB_ON_SYNCED_FOLDER` for sync folders and the error `SERVE_UNSAFE_FILESYSTEM` for network and 9p mounts (§2).

**D44. Backfills. (new)**
- Choice: `--from` on merge ingests only, with a per-type matrix of explicit errors elsewhere; relative dates; conversion to the cursor type.
- Reason: `--from` on append or replace ingests duplicated or truncated data silently.
- Build (2026-09-23): revised by D57. A `--from` after the saved cursor jumped the cursor over the rows in between, so they were never fetched. Merge ingests now keep the saved cursor in that case, append ingests with a saved cursor refuse `--from` either way (`BACKFILL_WOULD_DUPLICATE`), and every `--from` refusal happens before the run starts.

**D45. Dependency extraction. (new, rev)**
- Options: AST `BASE_TABLE` nodes only; the optimized plan; AST plus the unoptimized bound plan.
- Choice: AST ∪ unoptimized plan scans. The AST also rejects catalog prefixes and file reads.
- Reason: the AST misses `query_table()`, `query()` and macros, and the optimizer prunes scans [V]. A missed dependency means silently stale tables.
- Build: the gate now refuses `query()` and `query_table()` in all user SQL (D40), so the plan scans matter for table macros and PIVOT.
- Build (phase 2): CTE scopes follow DuckDB 1.5.5 (a CTE's body sees only earlier CTEs), a table macro's table is an input, and `CATALOG_PREFIX` covers any qualifier other than `main.` (§3c).

**D46. Long incremental TS transforms. (new)**
- Options: one transaction per run; chunked commits.
- Choice: chunks of 500 rows or 60 s, each with its checks and a composite `(_loaded_at, key)` position; staged-chunk reuse on retry; no-progress timeouts.
- Reason: a per-row LLM first build takes hours. As one transaction it could never finish, and every retry would re-bill everything. A position based on the timestamp alone skipped rows [V].
- Build: revised by D67 (a chunk is cut at a `newRows()` request, and when a staged chunk is reused) and D72 (when an input row counts as processed).

**D47. What a tick does. (new)**
- Options: the tick runs the due work; the tick plans and spawns.
- Choice: plan and spawn, with a singleton row. `croft serve` spawns a fresh tick process each minute.
- Reason: launchd runs one process per job, so a busy tick drops fires [U]. Cron overlaps ticks. An in-process loop keeps stale `lib/` code [V].
- Build (phase 3): the tick records `last_fire_at` and `last_attempt_at` before it starts each child, so a child that dies early is not started again every minute, and notes the runs it started until they hold their leases. It imports no asset code unless an asset's file hash changed (D79), loads `reconcile()` only when there is something to reconcile, and notifies a scheduled run it finds crashed. croft serve's loop ticks once at start, then every minute.

**D48. JavaScript value types for TS code. (new)**
- Options: `Date` for timestamps; ISO strings.
- Choice: ISO strings (naive without offset, zoned with `Z`, microseconds kept); HUGEINT snapshotted as DECIMAL(38,0), arriving as `bigint`.
- Reason: pass-through rows must reload unchanged. `Date` turned naive timestamps into shifted TIMESTAMPTZ, and Parquet turned HUGEINT into DOUBLE [V].
- Build: revised by D70. HUGEINT is snapshotted as text, and still arrives as `bigint`.

**D49. Schedules. (new)**
- Options: schedules on any asset; ingests only.
- Choice: ingests only. The tick also refreshes any stale transform.
- Reason: transforms follow their inputs, and this removes the "scheduled transform inside a downstream set" special case.
- Build (phase 3): a stale transform whose input was never built is not due on its own; it follows that input's run. A transform whose last attempt failed backs off (D85).

**D50. Resumable first loads. (new)**
- Options: post-v1; monotone partial commits in v1.
- Choice: monotone partial commits for cursor ingests in phase 4. Commit every 50k rows or 5 minutes while cursor values are non-decreasing; otherwise use a single transaction.
- Reason: a long first load that dies late would otherwise refetch from zero, forever if it keeps dying. The chunked-commit machinery already exists for TS transforms.

**D51. Rejected: deferring incremental TS transforms.** The storage reviewer suggested deferring them, because three of its bugs lived on that path: `Date` precision, the naive-timestamp shift, and HUGEINT through Parquet. All three are fixed (D46, D48), and the path is the only protection for the audience's most expensive transform. It stays in v1.

**D52. Name. (new)**
- Options: `tsdb` (the working name); `croft`, `rowen`, `rowjar`, `bothy`, `quern` and others from a naming panel. The panel checked each against the npm registry, Homebrew and existing commands.
- Choice: **croft**, a small plot of land one household works itself. The command is `croft`, published on npm as **`@zabaca/croft`**.
- Reason: it matches one folder, one local project that you own and run. It is one syllable and five letters, and it reads cleanly as `croft run`, `croft.json`, `.croft/` and the skill name. The unscoped npm name `croft` was free, but npm refused to publish it: "Package name too similar to existing package cron". A registry lookup alone cannot detect that rule. The `@zabaca` scope follows `@zabaca/zbc` and keeps the command name. The placeholder `@zabaca/croft@0.0.1` was published on 2026-09-22 to hold the name. `tsdb` was taken on npm and read as "time-series database".

**D53. Server mode for app access. (new, 2026-09-22; rev)**
- Options: a read copy by default (D32); `croft serve` as one cooperative read server; a write daemon that owns the file.
- Choice: `croft serve`, an optional HTTP read server that steps aside for every write, and runs the scheduler loop. Writers announce themselves with per-holder intent files in `write-intent.d/`, with boot-id liveness; the server closes every connection before releasing the file. It requires a token, checks Host and Origin, and reads tables only. `@zabaca/croft/read` uses it when available and falls back to brief direct reads. The read copy becomes opt-in, for GUIs.
- Reason:
  - One cooperative reader removes the lock contention that many app readers cause. A writer got the file in 10–23 ms while the server answered 2,226 queries in 6 s (short queries, one writer) [V].
  - The review of this change found two handoff bugs, both fixed and verified: a single shared intent file, and connections left open at close.
  - Apps see live data with no doubled disk.
  - A hosted app gets a path: HTTP to a server the user runs.
  - Writes stay in fresh short-lived processes, so D1's reasons against a daemon still apply.
  - It costs about one more engineer-week, in phase 3.
- Build: the read client's loopback transport is its own decision (D55). A `401`/`403` is `SERVE_UNAUTHORIZED`, never retried. Direct mode is a lazily loaded chunk, so an app that only talks to a server never loads the native binding, and concurrent direct queries in one process share one reference-counted instance (§5).
- Build (phase 3): croft serve holds the file in a query worker process, which it kills to release the file (D76), and streams results inside the worker within `limit`, `serve.maxRows` and `serve.maxBytes`. `GET /status` is the status envelope without asset code (D81), and a generated token is new on every start (D84).

**D54. Redaction in command data. (new, 2026-09-23)**
- Options: redact every `.env` value everywhere (D26 as first written); redact declared secrets only; redact everything in free text, but in command data only declared secrets and values that look like credentials.
- Choice: the third. Every `.env` value of 4 or more characters is redacted from messages, hints and logs. In command data (query rows, samples), declared secrets are always redacted, and other `.env` values only when they have 8 or more characters and are not only letters or only digits. `data` then carries `redactedValues: true`.
- Reason: `.env` also holds ordinary settings (`PORT=5432`, `LOG_LEVEL=info`, `NODE_ENV=production`). Redacting them everywhere rewrote values in query rows that an agent reasons from, and silently. Free text can afford to over-redact, data cannot, and the flag says when data was altered.
- Build: extended by D61. A value is redacted in its escaped, encoded and multi-line renderings too.

**D55. Loopback HTTP in `@zabaca/croft/read`. (new, 2026-09-23)**
- Options: `fetch` or `node:http` with proxy settings turned off; a minimal HTTP/1.1 client over `node:net` for loopback hosts.
- Choice: `node:net` (`node:tls` for https) for loopback hosts, including `0.0.0.0` and `::`; `fetch` for every other host.
- Reason: D53 promises that `HTTP_PROXY` never sees the serve token. Under Bun 1.3.14 every `node:http` variant (the default agent, `agent: false`, a new `Agent`, `createConnection`) and `fetch` sent a `127.0.0.1` request through `HTTP_PROXY`/`http_proxy` [V]. A plain TCP socket cannot be proxied. Other hosts keep `fetch`, so a hosted app keeps the egress proxy its platform configures.

**D56. Who carries out a confirmation. (new, 2026-09-23; revises D10)**
- Options: `croft confirm` re-runs the stored command with a hidden `--confirm-token` flag (the first build); `croft confirm` hands the token to the command in its own process, and a detached run gets it through a one-time grant.
- Choice: the second. No command takes a token as a flag. `croft confirm` refuses an unknown token (`USAGE_ERROR`) or a used or expired one (`CONFIRMATION_STALE`) before anything runs, then runs the stored command in-process and passes the token there. When the run detaches, `confirm` writes a grant next to the run's logs (the token and the hash of a random secret) and passes the secret in `CROFT_CONFIRM_GRANT` to that `--detached` child only, which redeems it once. `data.outcome` (`used`, `not_needed`, `unused`, `running`) says what became of the token; a command that no longer needs its confirmation runs as a plain command and spends the token anyway (§6).
- Reason: with a token flag, `croft run x --allow-shrink --confirm-token c_…` carried out the destructive action without the `croft confirm` prefix, so the one `ask` rule that D10 relies on no longer gated every destructive path. An environment variable alone could be typed in the same way; a secret whose hash croft wrote for that run id cannot. Spending the token on `not_needed` keeps a token from ever running its command twice, and leaving it valid on `unused` keeps a transient failure from burning the user's consent.

**D57. `--from` later than the saved cursor. (new, 2026-09-23; revises D44)**
- Options: save `greatest(saved, loaded)` as for any run (the first build); refuse such a `--from` with a new `BACKFILL_GAP`; keep the saved cursor.
- Choice: keep the saved cursor for merge ingests, and say so in the step's reason. Refuse `--from` for append ingests once they have a saved cursor, whether it is before or after it (`BACKFILL_WOULD_DUPLICATE`, exit 2). Every `--from` refusal happens before the run starts: nothing is recorded and no step fails. An asset named exactly refuses the whole command, while a bare `croft run --from …` or a glob skips the assets it does not apply to, with the reason (§8).
- Reason: the first build jumped the schedule over `[saved, <when>)`, and nothing ever fetched those rows. `--from` needs no confirmation (§6), so `croft run x --from today` lost data silently. Refusing would turn a natural "re-read from here" into an error; holding the cursor does what was asked and costs one wider fetch on the next run, whose re-read rows the merge makes a no-op. An append ingest has no such way out: holding the cursor would store the rows after `<when>` twice, and moving it would skip the gap.

**D58. Overlapping file exports. (new, 2026-09-23)**
- Options: a reloaded file deletes the rows of every key it no longer has (the first build, `WHEN NOT MATCHED BY SOURCE AND _file IN (…) THEN DELETE`); latest-loaded ownership; "the export that sorts last wins".
- Choice: latest-loaded ownership. A key's row belongs to the latest file that provided it, and files loaded together provide their keys in read order. A changed file's reload also reads the asset's other present files, so a key it dropped falls back to the most recently loaded file that still has it, and only a key no present file has is deleted. New files take over the keys they contain, and re-exporting an older file makes it the latest provider of its keys again (§3b).
- Reason: the first build deleted a row that an unchanged, overlapping export still had, and no later run brought it back, which broke the "exports overlap; the key removes repeats" promise of the `sales.ts` example. Latest-loaded needs no naming convention for exports.
- Open: "the export that sorts last wins" is the alternative. It is rebuild-invariant (a full reload gives the same table as the incremental history, which latest-loaded does not promise), and it would keep a re-exported January file from overriding February's rows. It needs export names that sort by date.

**D59. Agent texts per phase. (new, 2026-09-23)**
- Options: ship the v1 texts of §9 from phase 1 (the first build, whose test compared the files with §9 verbatim); ship them cut to each phase's commands, checked against a phase manifest.
- Choice: the second. `core/phase.ts` records which command, `run`/`query`/`init` flag and later-phase `croft.json` key ships in which phase, and the registry must match it. Each phase ships §9 cut to its commands; SKILL.md's "This version" section renders from the manifest, and `agent/templates.test.ts` lists every cut line with its reason. `agent/contract.test.ts` scans CLAUDE.md, SKILL.md, every `croft docs` page and every hint, fix and `next[]` in the source, and fails on a command or flag the build lacks. `query --preview` is registered in phase 1 only so it can refuse. §9 keeps the full v1 texts as the target (§4.1, §9).
- Reason: the v1 texts told a phase-1 agent to run `croft validate` after every edit, `croft preview` before a run and `croft new` for a new asset, and hints pointed at `croft serve`, `croft restore`, `readCopy` and `--rebuild`. Each was a `USAGE_ERROR` at the step the agent was told to take. A test against the registry keeps later edits honest, and the cut list keeps every §9 rule in view until its phase lands.
- Build (phase 2): the scan reads every string and template literal in the source, not only hints, fixes, `next[]` entries and option descriptions; `query --preview` works; phase 2 ships the `CLAUDE.md` block whole and cuts from SKILL.md only phase 3–5 lines (§9).
- Build (phase 3): SKILL.md restores its phase-3 lines word for word and cuts only phase 4–5 lines, with 11 cut entries left; it adds a Schedule recipe. The registry marks `tick` and `run --due` hidden, and `PHASE_COMPLETE` tells the codes-raised gate whether the phase is still being built (D78).

**D60. Ingest templates before `croft new`. (new, 2026-09-23)**
- Options: build `croft new` in phase 1; ship the templates as a docs page until `croft new` lands with every template in phase 5.
- Choice: the docs page `croft docs ingest` (`src/agent/docs/ingest.md`), listed by `croft docs --list` as the topic `ingest`. It holds API templates for keyset, cursor and Link-header paging, and file ingests from a folder or a URL. A test type-checks every template against the public API and validates it as an asset.
- Reason: the skill's rule is "start from a template, don't invent APIs", and phase 1 builds only ingests. A page needs no command, and the test keeps it from drifting from the API.
- Build (phase 3): the templates carry the `schedule:` lines of §3 again (`every hour`, `monthly`).

**D61. Redacting every rendering of a value. (new, 2026-09-23; extends D54)**
- Options: match a value's raw text and its `encodeURIComponent` form (the first build); match every common rendering of it.
- Choice: every rendering listed in §9.6: escaped (JSON, `\/`, `util.inspect` quoting, `\xHH`/`\uHHHH`, up to three levels), `util.inspect`'s multi-line split, each line of 8+ characters of a multi-line value, URL and form encoding in either hex case, and base64/base64url for values of 8+ characters, inside a longer encoded credential too. Longer alternatives come first, escape runs are bounded so no text can make the pattern backtrack for long, and texts of 16 KB or more are prefiltered by literal anchors. Other encodings and a value split across two stream writes are not covered.
- Reason: asset code rarely prints a secret raw. It prints it inside an object (`console.log` escapes it), serializes it, or gets it echoed back by an API: escaped, URL-encoded, or base64-encoded in a Basic auth header quoted in an error. Raw-text matching missed all of those.

**D62. Capturing fds 1 and 2 while asset code runs. (new, 2026-09-23)**
- Options: route `console.*` and `process.stdout`/`process.stderr` writes only (the first build); also capture the file descriptors.
- Choice: capture them. While asset code runs, fds 1 and 2 point at an unlinked temporary file (`dup2` through `bun:ffi`), and croft writes its own output to close-on-exec duplicates of its real stdout and stderr. Captured lines go to the running step's log when exactly one step runs, and otherwise to stderr, redacted. The CLI and the detached child keep the capture on until exit (§5).
- Reason: a subprocess (Bun Shell `$` prints by default) and `Bun.write(Bun.stdout)` write to the descriptors directly, so their output corrupted the one `--json` envelope and landed unredacted in `_process.log`. A file rather than a pipe means a write never blocks. No capture on Windows, where there is no `dup2`.

**D63. `allowShrink: true` in an asset. (new, 2026-09-23; revises D31)**
- Options: the first build, where the key did not reach the write, so the guard still stopped the load; the key asks like `--allow-shrink`; a standing decision that asks nothing but still trashes first.
- Choice: the standing decision, for replace ingests. Loading the asset gives `SHRINK_GUARD_DISABLED`, so every run carries it. A shrink moves the current rows to the trash (reason `allowShrink: true (<run>)`, `StepResult.trashed` set), then writes without a token, and the write's own `SHRINK_GUARD_DISABLED` carries `details.trashPath`. It wins over `--allow-shrink`. On a merge or append ingest the key does nothing, and the warning says so (§6).
- Reason: the user made the decision in code, so asking again at each shrink adds nothing. The trash keeps D31's promise that no override wipes ingested data without it.

**D64. `--from` on a text cursor. (new, 2026-09-23; refines D19 and D44)**
- Options: pass any value through (the first build); convert dates and relative values to text; refuse what text cannot compare.
- Choice: pass a value written like the saved cursor through as is, and refuse the rest with `CURSOR_TYPE_MISMATCH` before the run (exit 2, the hint shows the saved value): a relative value or `today` always, and a date or timestamp unless the saved cursor is written the same way (§8).
- Reason: text compares as text, so croft cannot turn a date or a relative time into a cursor value. The first build handed `-90d` or `2026-09-01` to the API as a filter it could not use. So the skill's `--from -90d` recipe is for time cursors only.

**D65. Duplicate keys in a transform. (new, 2026-09-24; refines D30)**
- Options: deduplicate a transform's batch like an ingest's (highest cursor, then the last row yielded); fail.
- Choice: fail. In a SQL or TS transform, a duplicate key in the batch is `CHECK_FAILED unique(key)` before anything is written, with up to 20 sample rows in `details` and 3 example keys in the message. A NULL key stays `KEY_NULL`. Ingests still deduplicate (§7).
- Reason: an ingest's duplicates are one record fetched twice (overlapping pages, a lookback), and the latest copy is right. A transform's key is a claim about its own output, its implied `unique(key)` check. Two rows with one key mean the SQL or the code is wrong (a missing `GROUP BY`, a join that fans out), and keeping one of them would hide that and pick a row arbitrarily.

**D66. The preview's own catalog. (new, 2026-09-24)**
- Options: previews write their catalog entries into the live `runs.sqlite` with source `preview`; a preview keeps its state apart.
- Choice: apart. A preview builds each asset through the step a real run uses, against `.croft/preview.duckdb` and its own `.croft/preview/runs.sqlite` (source `preview`), next to the input snapshots and the copied `_croft` rows in `.croft/preview/`. The live `runs.sqlite` gets only the scheduler's `approveCode`. `validate` reads the preview catalog's columns for a table never built. Checks run on the preview table after the write, not inside the write transaction.
- Reason: a step writes its catalog mirror as part of the step. Pointed at the live catalog, a preview would overwrite what the real tables hold (rows, columns, cursor), and `status` and the planner would believe it. A separate file lets the same step code run unchanged. Checking after the write keeps a failing table to explore with `croft query --preview`, and the asset still reports `CHECK_FAILED`, as the real run would.

**D67. When a chunk commits. (new, 2026-09-24; revises D46)**
- Options: the moment a chunk reaches 500 rows or 60 s; the first `newRows()` request after that.
- Choice: the request. The code's next input row waits for the commit. The chunk waits in `<state>/staging/_chunks/<asset>/`, and a later attempt commits it without running the code again while the code hash, the blocking-check hash and the positions committed under it are unchanged; a chunk refused for its rows, only while every input is still at the version it was staged from. `min_rows` is checked at the run's last chunk only (§3e).
- Reason: only at a request are the outputs of every row up to the position known to be yielded, so the cut is exact for the usual `for await` loop. A cut at an arbitrary moment could commit a position past a row whose outputs are pending. The cost is that an input row with many outputs can grow a chunk past 500. Outside the run folder, a later run can find the chunk. Reusing a refused chunk after the user fixed the data would commit the bad rows again, and `min_rows` on a first chunk would refuse every large first build.

**D68. Where `ResolvedAsset` lives. (new, 2026-09-24)**
- Options: `core/types.ts`, as §10 first had it; `project/resolve.ts`.
- Choice: `project/resolve.ts`, with the selection and write-behavior helpers, which `run/plan.ts` re-exports. It carries `ts?: LoadedTsAsset` and `sql?: LoadedSqlAsset` instead of `definition` and `{body, headerLines}`, plus `path`, `loaded`, `ok`, `words`, `timeZoneChanged` and `problems` (§10).
- Reason: `core/types.ts` must not import the project modules. The declaration check of `src/read.ts` type-checks it without them, and a type-only import of the loaders broke that build test. Keeping the helpers in `resolve.ts` avoids an import cycle between the planner and the resolver.

**D69. What a transform saw of its input: format 3. (new, 2026-09-24)**
- Options: compare the input's `last_loaded_at` with `seen_loaded_at`, as §5 first had it; record the input's version at the last full read.
- Choice: record it, in `_croft.inputs.input_last_loaded_at` (format 3, added by an `ALTER` on the next write). It is the later of the input's `last_loaded_at` and `last_replaced_at` when the transform last read all of it, and NULL while an incremental transform has committed only part of a snapshot. Staleness compares with it; `(seen_loaded_at, seen_key)` stays `newRows()`'s position (§5).
- Reason: `seen_loaded_at` is a position, not a version. An incremental transform that stopped mid-snapshot has not seen all of its input, and a full-refresh transform keeps no position at all. The fact belongs in the warehouse, the source of truth, where it commits with the data. Taking the later of the two stamps lets `input_replaced` clear once the input is read again, even after an out-of-band change that no written row followed.

**D70. HUGEINT in snapshots. (new, 2026-09-24; revises D48)**
- Options: `DECIMAL(38,0)` (D48); text, cast back when read.
- Choice: text, for HUGEINT and UHUGEINT, cast back to the column's type in the snapshot's view. The snapshot is ordered by the table's own typed columns, and rows still arrive as `bigint`. Ingests' `ctx.query` snapshots do the same.
- Reason: `DECIMAL(38,0)` holds at most 10^38 − 1, so the `COPY` fails on HUGEINT's 39-digit values. Ordering by the text would put 10 before 9 and break positions.

**D71. Reserved names in an SQL step's output. (new, 2026-09-24)**
- Options: `COLUMNS(c -> c NOT IN ('_loaded_at', '_file'))` over the view, as §3c first had it; `DESCRIBE` the body first, then drop every reserved name and the view's renamed copies of them, without regard to case.
- Choice: the second, into `__croft_next`, with `_croft_seq` added in the same `CREATE`. Repeated reserved names are not `DUPLICATE_OUTPUT_COLUMN`, and a SELECT of only reserved columns is `ASSET_INVALID`. A changed shape recreates the table with `CREATE OR REPLACE … LIMIT 0` rather than through the ingest's `ALTER`s (§3c, §5).
- Reason: a view renames a repeated name, so `SELECT *` over a join of two assets gives `_loaded_at` and `_loaded_at_1` [V], and the case-sensitive filter copied `_loaded_at_1` and `_LOADED_AT` into the table as junk columns. `next` is a valid asset name that a TEMP table would shadow. `LIMIT 0` keeps STRUCT, MAP and ENUM types that the ingest's type whitelist refuses.

**D72. When an input row counts as processed. (new, 2026-09-24; refines D46)**
- Options: when the code asks for the next row; when it has asked for the next row and yielded enough outputs.
- Choice: the second. Row n counts once n ≤ min(rows asked past, outputs yielded while that iterator was the one asked last); every row asked past counts once the code has finished; the least advanced iterator decides (§3e).
- Reason: a loop that keeps calls in flight asks for rows before it yields earlier outputs, so counting asks alone could commit a position past a row whose output is not yet yielded, and a failure would skip that row for good. Counting outputs is exact for the usual loop and safe for in-order read-ahead with one output per row. Out-of-order or fan-out read-ahead stays a documented limit, which a `ctx.map(input, fn, {concurrency})` helper could close later.

**D73. SQL header lines below the header. (new, 2026-09-24; refines D5)**
- Options: also read a header below a leading `/* */` comment; refuse key, check and warn lines below the header.
- Choice: refuse. Such a line is `HEADER_UNKNOWN_KEY` at its line and is not applied. A late `-- description:` stays a plain comment.
- Reason: a `-- check:` line below the header was silently a plain comment, so an asset lost its key or its checks without a word. Naming the line fixes that without making "where the header ends" harder to explain. An agent may document a `description` column that way, so that line is left alone.

**D74. Case in the SQL fingerprint. (new, 2026-09-24)**
- Options: lowercase every identifier, as §8 first said; lowercase only the `*_name` keys of the AST.
- Choice: only `*_name` keys (table, schema, catalog, function and star-qualifier names). Column references and aliases keep their case (§8).
- Reason: DuckDB names an unaliased expression's column after its text, so `sum(AMOUNT)` and `sum(amount)` produce differently named columns. Lowercasing them could hide a column rename from the rebuild. A spurious rebuild is safe; a missed one is not.

**D75. What `status` reads. (new, 2026-09-24)**
- Options: only files and `runs.sqlite`, with modification times for edits (phase 1); resolve the asset files as `validate` does.
- Choice: resolve them: TS assets imported in isolation (5 s each), SQL parsed on a private in-memory DuckDB. `edited` compares code hashes, with the modification time only as a fallback. `status` still never opens the warehouse (§4.3, §5).
- Reason: kinds, inputs and code hashes need the code, and staleness needs the inputs. A modification time called a touched file or a comment-only edit "edited"; a hash does not. The cost is that an asset's top-level code runs on `croft status`.

**D76. croft serve's query worker. (new, 2026-09-24; refines D53)**
- Options: the read-only instance in croft serve's own process, closed with `closeSync()` after every query settles (§5 as first written, and the first build); the instance in a child process that croft serve kills to release the file.
- Choice: the child process (`serve/worker.ts`, spoken to over Bun's IPC channel). croft serve opens no DuckDB file. To give the file up it disconnects every connection, then kills the worker with `SIGKILL` and awaits its exit. A query not settled `killAfterMs` (500 ms) after its first interrupt is ended the same way, whatever stopped it: a writer, its deadline, its client leaving, or the server stopping. A spare worker started during the write keeps reopening at about 5 ms, a worker that dies while serving is replaced at once, and the read copy has a worker of its own. A worker exits by itself when croft serve goes away.
- Reason: DuckDB checks for interrupts only between tasks, and a SELECT can spend many seconds in one scalar or list expression, or fold a big constant while planning (`list_sort(range(1.5e8))` ran 25 s past every interrupt) [V]; and closing an instance whose query still runs keeps the lock. So D53's promise that a writer gets the file within the grace could not hold. A process's exit is the one release nothing inside DuckDB can delay: the kernel drops its locks. Now a writer waits at most `graceMs` + `killAfterMs` + the kill (about 2.6 s measured) [V], `queryTimeoutMs` always holds, and croft serve's own descriptors can never drop a lock.

**D77. Holds in a scheduled run are warnings. (new, 2026-09-24; refines D9)**
- Options: `SCHEDULE_HELD` as an error with exit 4, as the registry first had it; a warning that skips the step.
- Choice: a warning with exit 0. In a scheduled run, a step held by `SCHEDULE_HELD` or by the cost guard (`LARGE_REPROCESS`, whose own code stays an error elsewhere) is recorded as skipped with the hold as a warning, and the run succeeds. `status`, `context`, `schedule` and the tick report the hold as a warning, with the fix `croft run <asset>`.
- Reason: a hold is the scheduler doing its job, not a failure. As an error it would fail every scheduled run that touched an edited asset, and send a failure notification each hour for an edit the user already knows about. Every surface already reported it as a warning, while the registry and `croft docs SCHEDULE_HELD` said "error".

**D78. A phase's completion flag. (new, 2026-09-24)**
- Options: raise `PHASE` only when the whole phase is built; raise it at the phase's first contract, with a separate flag for "finished".
- Choice: `PHASE_COMPLETE` in `core/phase.ts`. While it is false, `core/codes-raised.test.ts` lets the codes listed for the current phase stay unraised; once it is true, every such code must be raised. A release requires it.
- Reason: a phase is built in parallel waves against the final contract, so its commands must be registered, and its texts name them, before every code they raise exists. The flag keeps the gate strict at the end without blocking the waves.

**D79. The scheduler's facts cache. (new, 2026-09-24)**
- Options: import every asset on every tick; cache only `schedule_state` (phrase and cron) by file hash, as §8 first had it; cache everything the tick needs, keyed by a hash that covers what the code hash depends on.
- Choice: the last. `schedule_state` keeps phrase, cron and file hash, and the setting `schedule.facts` each asset's kind, schedule, inputs and code hash. The file hash covers the asset file and the project time zone, and for TS assets the size and modification time of `lib/**`, `package.json` and the lockfile. Only an asset whose hash changed is imported again.
- Reason: the tick runs every minute for every project; importing asset code each time would run user code unattended every minute and cost seconds. Holds and staleness need the code hash and the inputs, which only an import gives. Covering `lib/` and the time zone makes a `lib/` edit or a zone change hold the asset at the next tick, as the code hash would. Measured: about 80 ms per tick with 40 unchanged assets, and no import [V].

**D80. Interval crons across a repeated hour. (new, 2026-09-24; refines §8's DST rule)**
- Options: every repeated local time fires once, at its first occurrence (§8 as first written); interval crons fire at both passes.
- Choice: a cron whose minute or hour field starts with `*` is an interval and fires at both passes of a fall-back hour; a fixed time fires once. A gap time still fires at the first valid minute after the gap.
- Reason: "every 15 minutes" means every 15 minutes of real time. Firing once in a repeated hour would leave an hour with no fire, which the golden test "no duplicates, no missing instants" catches. It is cron's own rule for its wildcard jobs.

**D81. What `GET /status` returns. (new, 2026-09-24)**
- Options: the CLI's `status` envelope, as §5 says; the server's own state only (the first build).
- Choice: the `status` envelope, built from `runs.sqlite`, the catalog mirror and the asset files read as text, without importing asset code, and with `data.serve` carrying the server and its engine state (`{url, pid, host, port, version, startedAt, engine}`).
- Reason: an app or a monitor asks the server what the CLI would say, and needs no second shape. croft serve runs no user code (D53), so staleness that only the code tells (`code_changed`) is left to `croft status`.

**D82. The registry's lock, and projects that are missing. (new, 2026-09-24)**
- Options: an `O_EXCL` pid file, broken when its holder looks dead or after 12 s (the first build); an OS lock the kernel releases. For pruning: drop a project whose `croft.json` cannot be found (the first build); tell a project that is gone from one on a disk that is not mounted.
- Choice: an exclusive `bun:sqlite` transaction on `projects.json.lock.db`, with the old pid file taken inside it for older crofts; a writer that cannot get both in 12 s fails with `DB_BUSY`, and nobody ever breaks the OS lock. A project whose disk is not mounted, or whose parent folder is gone too, is kept as missing and pruned after 30 days; only one whose folder is there without its `croft.json` is pruned at once.
- Reason: two writers could each judge a pid file abandoned, break it and both go in, so one writer's entry was lost, and the 12 s path broke even a live holder's lock. A `fcntl` lock is released by the kernel when its holder dies, so it needs no breaking; the race tests (24 writers over a dead holder's lock file) lose no entry. An unplugged external disk looked like a deleted project and silently unscheduled it.

**D83. The job's Bun. (new, 2026-09-24; refines D37)**
- Options: the first stable path that exists (the first build); a stable path whose Bun is new enough.
- Choice: each candidate's `bun --version` is asked, and the job takes the first stable Bun at least as new as the running one and croft's floor, then the running Bun on a stable path, then a stable Bun at the floor, then the running Bun marked unstable. The per-user tick does not start a pinned croft whose `engines.bun` is newer than the job's Bun, and the diagnosis names it (`bun_too_old`).
- Reason: a stable path can hold a Bun left behind (an old curl install at `~/.bun/bin/bun` while the user runs Homebrew's). The job then started every project's croft on a Bun older than croft needs, and nothing said why.

**D84. The serve token's life. (new, 2026-09-24)**
- Options: a token generated on first start and kept (§5 as first written); a token generated on every start.
- Choice: every start. `serve.json` is removed when the server stops, so apps fall back to reading the file, and a generated token goes with it. Local apps read `serve.json` again for each query; hosted apps use `CROFT_SERVE_TOKEN`, which the banner asks for when the server is not on loopback.
- Reason: `serve.json` is how apps and croft find a live server, so it must go when the server stops, and a generated token lives only there. A token that must stay the same across restarts, as a hosted app's does, is the user's explicit setting.

**D85. Backoff of scheduled transforms, and when a fire is spent. (new, 2026-09-24)**
- Options: retry a failed transform at the next tick; wait only for deterministic failures, as §8 first had it; back off every failure.
- Choice: a transform's deterministic failure waits for a change to its code or inputs (or a run by hand); a retryable failure, a crash or an interruption waits 15 minutes, or the server's longer `Retry-After`. An ingest is due again only at its next fire. The tick records `last_fire_at` and `last_attempt_at` before it starts the child, so a child that dies before its first step does not restart every minute.
- Reason: a stale transform is due at every tick, so without a backoff a crashing one would start, and notify, every minute. Recording the fire first trades a lost fire for a crash loop; the next fire, or a stale transform's own staleness, brings the asset back.

---

## Open questions for the user

Decided on 2026-09-22:

- **Name:** croft, published as `@zabaca/croft` (D52).
- **Desktop notifications** on scheduled failures: on by default.
- **Scope:** v1 is all 5 phases, about 14.5 engineer-weeks (13.5 before D53 added `croft serve`).
- **App access:** `croft serve` (server mode) instead of a default read copy; the read copy is opt-in, for GUIs (D53).

Open since the build (2026-09-23):

- **Overlapping file exports:** the latest-loaded file owns a key (D58, shipped), or the export that sorts last wins (rebuild-invariant, and a re-exported old file would not override newer rows).

Open since phase 2 (2026-09-24):

- **Paid rows lost on a failed attempt:** a chunked TS transform loses, and re-bills, the chunk it was filling each time its code fails (a 429 from an LLM after `http`'s retries, a timeout). In one test run, rows 501–699 were billed three times across three attempts (§3e, §8). The alternative is to commit the rows already yielded, with the position before the failing row, before retrying or failing: the code asked past each of those rows, so their outputs are complete.

---

## Appendix A: Changes after review

**From the non-data-engineer review:**

- `@zabaca/croft/read` now ships as built JavaScript, because it crashed under Node/Next.js. It locates the project explicitly, and `init` inside an app repo creates `data/` without touching the app's files.
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
- Cut: incremental SQL, `--step`/`--to`, `checks/` files, `copy`/`--database`, `query --write`, `initial`. Merged: `plan`, `history`, `trash` and `drop` into other commands. The result is 19 commands (20 after D53 added `serve`) and 7 concepts.
- Synced and WSL-drvfs folders get automatic database relocation.
- Secrets: "edit `.env`" is the primary instruction, `--stdin` is supported, and `.env` values are redacted from output (the build narrowed redaction inside command data, D54).
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
- TS values round-trip as ISO strings, and HUGEINT is snapshotted as DECIMAL(38,0) (D48; the build stores it as text, D70).
- Every open goes through `DuckDBInstance.fromCache` with one mode per process.
- The tick plans and spawns, with a singleton. `croft serve` spawns a fresh tick per minute (D47).
- DST fire rules are defined; the time zone is part of every fingerprint; one connection factory sets it.
- Leases carry process start time and boot id.
- Stale transforms are picked up by the tick. Deterministic failures wait for the next fire time.
- The DDL-before-DML invariant is enforced.
- Estimates are revised to about 13.5 weeks (14.5 after D53), and the phase-3 OS-registration spike gates scheduling.

**From the technical review (storage and ingestion):**

- **A second instance in the same process is invisible to the OS lock** (the blocker). A second read-write instance lost committed data, a second read-only one served stale data, and closing either, or closing any `fs` descriptor on the file, released the first instance's lock [V]. The fixes:
  - every open goes through `fromCache`;
  - `@zabaca/croft/read` reuses a loaded runtime's lease;
  - `validate` rejects imports of the binding or `@zabaca/croft/read` in assets and `lib/`;
  - ingests get `ctx.query()`;
  - the foreground scheduler loop (now part of `croft serve`) spawns subprocesses;
  - copies are made by a child process.
- **Casts** read JSON text, the loss check compares exact decimals, and `PIN_ROUNDED` and `DECIMAL_PRECISION_UNSUPPORTED` were added. The claim that JSON staging keeps fractional text exact was corrected: integers stay exact, fractions become doubles.
- **DDL before DML** is enforced by the Sql wrapper (`DDL_AFTER_DML`), and restore uses `CREATE OR REPLACE`.
- **Positions** come from SQL values, never `Date`, and naive timestamps round-trip as strings.
- **Names** are cleaned and resolved case-insensitively in the JS writer before `read_json`. Source `_loaded_at`/`_file` columns are renamed, every generated identifier is quoted, and `ROW_NOT_OBJECT`, `UNSERIALIZABLE_VALUE` and `DUPLICATE_OUTPUT_COLUMN` were added.
- **CSV:** header-less all-text files fail with `CSV_HEADER_AMBIGUOUS` instead of losing a row; `union_by_name` and encoding handling were confirmed.
- **Secrets** are parsed by croft with Bun's loading off, so `.env.local` and the working directory no longer matter.
- **Query sandbox:** extension autoinstall and autoload are off, allowed directories are narrowed to `files/` for `query`, and `QUERY_PATH_DENIED` was added.
- **Preview** snapshots its inputs to Parquet instead of attaching the live file.
- **Readers:** the write-intent handshake stops direct app readers from starving writers. D53 later extended it to `croft serve`.
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
| Runtime | node-api loads under Bun 1.3.0–1.4.2; `JSON.rawJSON` and reviver `context.source` exist on all of them; `Bun.cron` is absent before 1.3.11; `Bun.cron.parse` ignores tz on 1.3.14 and honors it on 1.4.2; the built `@zabaca/croft/read` works on Node 24.3/24.20, while a `.ts` export under `node_modules` fails on Node |
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
| TS positions and values | stream order of a merged input was not stamp order, and a max-stamp position skipped 3 of 5 rows; a naive TIMESTAMP passed through `Date` came back as TIMESTAMPTZ shifted 8 h without microseconds; HUGEINT became DOUBLE in Parquet and survived as DECIMAL(38,0) within 38 digits (the build stores text, D70); a cache-busted `import()` kept the old `lib/` module |
| Scheduling math | wall-clock matching skips 02:30 on 2026-03-08 and doubles 01:30 on 2026-11-01 in Los Angeles; `TimeZone` is per connection and changes `::DATE` keys |
| Staging precision | `read_json` into JSON columns re-rendered `3.14159265358979323846` as `3.141592653589793` and `1.50` as `1.5`; integers beyond int64 kept their digits; JSON→DECIMAL(18,2) gave `1.00` for `1.005` while text gave `1.01`; TRY_CAST of JSON `1.7` to BIGINT gave 2 |
| Staging names | `read_json` matched keys case-sensitively (`ID` loaded NULL into `Id`), failed with "Duplicate struct entry name" for `Id` + `id`, and rejected an empty key |
| CSV header | a header-less all-text CSV lost its first data row, with or without `all_varchar`; numeric files were detected correctly |
| Secrets | `bun --no-env-file` disables `.env` loading (default loading read `.env` from the working directory) |
| Server handoff | a read-only server that closed its instance on seeing `.croft/write-intent` let a writer in within 10–23 ms (5 writes) while answering 2,226 queries in 6 s |
| Serve handoff hazards | an instance closed with an idle connection kept the lock (20 s); disconnecting before an interrupted query settled kept it indefinitely, and the promise never settled; interrupt, then await, then disconnect, then close let a writer in within about 20 ms; one shared intent file locked out a second writer 3 of 3 times, and per-holder files let it in after 505–615 ms; macOS `fs.watch` missed short-lived files (0 of 100 seen at 0–1 ms hold); a reopened read-only instance saw commits, including WAL-only ones after a writer's kill -9 |
| Throughput | a 200k-row batch merged into a 2M-row, 20-column table in 327 ms including checks |
| Storage | 30 hourly full rewrites doubled a 9.8 MB file to 19.3 MB; 10% merges stayed at 9.5 MB; the sandbox blocks `read_text('.env')` and https; spilling works under the sandbox; Unicode identifiers work unquoted |
| Build findings (2026-09-23, recorded in the code's tests) | Bun's `realpathSync` and `realpathSync.native` open the file on macOS, and closing that descriptor released DuckDB's lock, while `lstat`, `readlink` and realpath of a directory did not; the sandbox always lets a connection read its own database file, WAL and `.tmp` folder; `enable_logging` changed a locked READ_ONLY instance; `lock_configuration` refuses a later per-session `SET TimeZone`; a TEMP table shadows `t` and `main.t`; inside a write transaction a TEMP table created by it scanned about 4.5× slower than a view (1,247 vs 417 ms, 1M × 5); the `DECIMAL(38,18)` loss formula gave 11,218 false losses among 40,011 random doubles; DuckDB refuses a zoned time without seconds, and `read_json` rejects unpaired surrogates; 30 of the 35 `type_function` keywords also break `FROM <name>`; under Bun, `node:http` and `fetch` sent `127.0.0.1` requests through `HTTP_PROXY`; Bun spawns children with the environment it started with, `.env` values included, unless given one |
| Build findings (2026-09-24, phase 2, recorded in the code's tests) | `PRAGMA disable_optimizer` works on a connection whose configuration is locked, while `SET enable_optimizer` is refused; the unoptimized plan's scan nodes carry `extra_info.Table` as `catalog.schema.table` with DuckDB's quoting, and an unused CTE's table is never scanned; a CTE's body sees only earlier CTEs, so a non-recursive `WITH orders AS (SELECT * FROM orders)` reads the table, and a recursive CTE sees itself only in its recursive part; `json_serialize_sql` writes `1e400` as a bare `Infinity`, which is not valid JSON; `PIVOT … IN (SELECT …)` also becomes two statements; `DESCRIBE`, `SUMMARIZE` and `SHOW` prepare with `statementType` SELECT, and `DESCRIBE`'s plan scans nothing; a view renames a repeated `_loaded_at` to `_loaded_at_1`; a prepared statement's column types drop the `JSON` alias inside nested types (`VARCHAR[]` for `JSON[]`), while a view's `duckdb_columns()` keeps it; the parse error of a bare keyword column points past it (`SELECT id, order FROM t` fails at `FROM`, `WHERE order > 1` at `order`); DuckDB's "Did you mean" can name a system view (`pg_constraint`); a missing column is "Referenced column "x" not found in FROM clause!", and `g.x` is "Table "g" does not have a column named "x"", both with candidate bindings; Parquet writes HUGEINT as DOUBLE (rounding 2^127 − 1), and `DECIMAL(38,0)` cannot hold its 39-digit values; DuckDB marks `current_localtime` and `current_localtimestamp` consistent within a query, not volatile |
| Build findings (2026-09-24, phase 3, recorded in the code's tests and a manual check) | a LaunchAgent with `StartInterval` 60 and `RunAtLoad` ran at load and 60 s later; `launchctl bootstrap gui/<uid>` loads it and `launchctl bootout gui/<uid>/<label>` removes it cleanly; the job's `PATH` is `/usr/bin:/bin:/usr/sbin:/sbin`, its working folder `/`, with `HOME` set and the user's uid; reading `~/Documents` from the job worked on that Mac; `croft schedule on` installed a real LaunchAgent whose first heartbeat came after 1 s, an every-minute ingest ran twice from launchd, and `croft schedule off` removed it; DuckDB checks interrupts only between tasks, so `list_sort(range(150000000))` ran 25 s past every interrupt and `list_reduce(range(10000000), …)` spent about 3.5 s constant-folding in `prepare`, where no interrupt is checked; killing croft serve's query worker let a writer in after 2.5–2.6 s with a 2 s grace; Bun 1.3.14 binds `localhost` to `::1` only; `Bun.serve` with `development: false` binds with `SO_REUSEPORT`, and a second server on the same port took over connections; Bun reports a foreign bind address as `EADDRINUSE`; Bun keeps a request's timeout on its keep-alive socket, and keeps the connection open after a handler has awaited even with `Connection: close`; `Bun.serve`'s idle timeout is capped at 255 s; under Bun, `os.userInfo().homedir` returns `$HOME` (Node returns the password database's); `process.resourceUsage().maxRSS` is bytes on macOS and KiB on Linux; a project tick with nothing changed took about 80 ms from start to exit and imported nothing (40 assets); an APFS clone held the write lease 2–3 ms for a 624 MB warehouse |

**Unverified [U]:**

- OS job registration on Linux (crontab), and macOS privacy-protection behavior for background jobs on other Macs. The macOS LaunchAgent itself was verified on 2026-09-24 (§8).
- WSL idle shutdown.
- Linux reflink.
- musl and Windows runtime behavior.
- Power-loss durability.
- Claude Code hook exit-code semantics, and permission-rule matching beyond a command prefix.
