# croft

Local data pipelines in TypeScript, on one DuckDB file. croft pulls data from APIs and files, transforms it with SQL or TypeScript, keeps the tables fresh on a schedule, and lets an app read them. It is a single CLI, and Claude Code can drive it from a cold start.

- **Ingest:** APIs (keyset, cursor, Link-header and page pagination) and files (CSV, JSON, Parquet, globs and URLs). Loads are incremental, types are inferred, and schema changes are handled.
- **Transform:** one SQL `SELECT` per file, or a TypeScript transform (for example, one LLM call per row, which is incremental and never re-bills). Checks run inside the write transaction.
- **Keep it fresh:** schedules in plain words (`every hour`, `weekdays at 9am`). croft installs one per-user OS job. `croft serve` answers app queries over HTTP and steps aside for every write.
- **Grow safely:** changes never destroy data without asking. There is a trash, and `restore`, `delete`, `rename` and `--rebuild`, each gated by a single `croft confirm`.

## Install

croft needs [Bun](https://bun.sh) 1.3.14 or newer, on macOS or Linux (native Windows is not supported; WSL works).

```sh
bun add -g @zabaca/croft       # the `croft` launcher, in ~/.bun/bin
croft init my-data             # scaffolds a project, installs it, runs an offline example
cd my-data
croft query "from example_sales limit 5"
```

Every project pins its own croft version in `package.json`. The global `croft` only finds the project and runs that pinned copy.

## A first pipeline

```sh
croft new api stripe_charges --pagination cursor   # a commented, working template
croft secrets set STRIPE_KEY                        # stored in .env (never printed)
croft validate                                      # static checks and a bind check
croft preview stripe_charges                        # build in a sandbox and diff
croft run stripe_charges
croft new sql daily_revenue                         # SQL over what you loaded
croft run                                           # everything that is stale
croft schedule on                                   # hourly, via the OS job
```

`croft help` lists every command. `croft docs --list` shows the offline docs: topics, templates, and a page for every error code. Every command takes `--json` and prints one envelope, `{ok, data, problems[], next[]}`. The JSON Schemas for these envelopes ship in `schemas/`.

## With Claude Code

`croft init` writes a managed `CLAUDE.md` block and `.claude/skills/croft/SKILL.md`, so Claude Code knows the loop: `croft new` → `croft validate` → `croft preview` → `croft run`. Destructive actions only run through `croft confirm <token>`, and one permission rule gates them all (`croft docs claude-permissions`). `croft init --claude --with-hook` also adds a hook that validates each edit under `assets/`.

## Apps

```ts
import { query } from "@zabaca/croft/read";
const rows = await query("select * from daily_revenue order by day desc limit 7");
```

`@zabaca/croft/read` runs under Bun and Node. It talks to `croft serve` when one is running, and otherwise opens the database briefly.

## License

MIT
