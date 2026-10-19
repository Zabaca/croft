# <img src="https://croft.zabaca.com/favicon.svg" alt="" width="34" height="34" align="top"> croft

**The whole data pipeline, in TypeScript.**

croft is one tool that pulls data from APIs and files, transforms it, keeps it fresh on a schedule, and serves it to your app. Pipelines are TypeScript, with SQL where you want it, and everything lives in one DuckDB file on your machine. No Python, no servers, no glue between tools.

[Website](https://croft.zabaca.com) · [Quickstart](https://croft.zabaca.com/docs/quickstart/) · [Docs](https://croft.zabaca.com/docs/) · [npm](https://www.npmjs.com/package/@zabaca/croft) · [For AI agents: llms.txt](https://croft.zabaca.com/llms.txt)

```sh
bun add -g @zabaca/croft
croft init my-data && cd my-data
croft query "from example_sales limit 5"
```

croft needs [Bun](https://bun.sh) 1.3.14 or newer, on macOS or Linux (WSL works).

## One tool, end to end

A croft project is a folder. Each file in `assets/` becomes one table, and `croft run` brings them up to date in order.

**Ingest.** Bring data in from any API or from files. Incremental, typed, and safe to rerun.

```ts
// assets/stripe_charges.ts
export default ingest({
  key: "id",
  schedule: "every hour",
  async *rows({ http }) { … },
});
```

**Transform.** One SQL query per table, or a TypeScript function per row, with checks that run before anything is saved.

```sql
-- assets/revenue_by_month.sql
-- check: revenue >= 0
SELECT month, sum(amount) AS revenue
FROM stripe_charges
GROUP BY month
```

**Schedule.** A schedule in plain words. Everything downstream updates after it.

**Serve.** Read the tables from any Bun or Node app, typed by table name.

```ts
import { query } from "@zabaca/croft/read";

const rows = await query<"revenue_by_month">("from revenue_by_month order by month");
```

## Typed across SQL and TypeScript

After every run, croft writes a TypeScript type for each table from its real columns. Rename a column in SQL, and `croft validate --types` flags the TypeScript that still reads the old name, before anything runs:

```text
error UNKNOWN_INPUT_COLUMN  assets/region_labels.ts:9:65
      revenue_by_region has no column "revenue"
      fix: revenue_by_region has these columns: region, orders, total, _loaded_at
```

## What it replaces

| Job | The usual stack | croft |
|---|---|---|
| Load from APIs and files | dlt, Airbyte or custom Python scripts | `ingest()` in a `.ts` file |
| Transform | dbt models (SQL and YAML) | a `.sql` file, or `transform()` in TypeScript |
| Test the data | dbt tests | checks that run before every save |
| Schedule and orchestrate | Dagster, Airflow or cron | `schedule: "every hour"` |
| Catch a broken column | when the warehouse runs the model | before anything runs, from SQL into the TypeScript that reads it |
| Store | a warehouse to host and pay for | one DuckDB file on your machine |
| Read from your app | a client and credentials per warehouse | `@zabaca/croft/read`, typed by table |

croft does these jobs; it does not read those tools' projects. It is built for one machine and one DuckDB file. If your team already runs a warehouse with dbt, keep it.

## Built for coding agents

Claude Code, or any coding agent, can run a croft project from a cold start:

- Every command takes `--json`, and every problem has a stable code, a hint with the next command, and often a fix the agent can apply as is.
- `croft validate` checks every change without running it; `croft preview` builds it in a sandbox and diffs it against the live table.
- Anything that could lose data stops and waits for a person: every destructive step ends in `croft confirm`, so one permission rule gates them all.
- `croft init` writes a skill and a `CLAUDE.md` block, pinned to the project's croft version. Without a project yet, the repository's Claude Code plugin teaches the start:

  ```text
  /plugin marketplace add Zabaca/croft
  /plugin install croft@croft
  ```

## Your data stays safe

Some data can't be fetched again, so croft never throws it away on its own. Every write is all-or-nothing, and a failed check keeps the old data. Anything replaced or deleted goes to a trash first, and `croft restore` brings it back. A crash, even `kill -9`, never leaves half a write. `croft backup` copies the warehouse, its history and the trash to another folder, even while croft is using them.

## This repository

| Path | What it is |
|---|---|
| [`packages/croft`](packages/croft) | the CLI and `@zabaca/croft/read`, published to npm as [`@zabaca/croft`](https://www.npmjs.com/package/@zabaca/croft) |
| [`packages/croft/src/agent/docs`](packages/croft/src/agent/docs) | the offline docs `croft docs` prints: a page per topic and per error code |
| [`packages/croft/plugin`](packages/croft/plugin) | the Claude Code plugin, listed by [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) |
| [`packages/site`](packages/site) | [croft.zabaca.com](https://croft.zabaca.com) (Astro and Starlight); its Guides and Reference are generated from `croft docs` |
| [`packages/infra`](packages/infra) | the site's deployment, with [zbc](https://github.com/Zabaca/zbc) |
| [`DESIGN.md`](DESIGN.md) | the design, and the decision log behind it |

### Develop

From the repository root:

```sh
bun install
bun --cwd packages/croft test             # the CLI's suite
bun --cwd packages/croft run typecheck
bun --cwd packages/site run dev           # the website, with hot reload
bun --cwd packages/site test              # the skill and docs agree with the CLI
```

## License

[MIT](packages/croft/LICENSE)
