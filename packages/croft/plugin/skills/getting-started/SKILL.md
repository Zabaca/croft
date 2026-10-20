---
name: getting-started
description: Start a local data pipeline with croft (TypeScript + one DuckDB file) when there is no croft project yet. Use when the user wants to pull data from an API or files into tables, combine or aggregate it with SQL, keep it fresh on a schedule, or replace a dlt, SQLMesh, Dagster or cron-script setup with something local. Inside an existing croft project (a croft.json is present), use that project's own croft skill instead.
---

croft is one CLI for local data pipelines: ingests pull from APIs and files, transforms are one SQL SELECT
(or TypeScript per row), and everything lives in one DuckDB file. Each file in `assets/` makes one table with
the file's name. Docs: https://croft.zabaca.com/llms.txt (every page as Markdown).

## Is there a project already?

If a `croft.json` exists in this folder or above it, stop here: that project has its own skill at
`.claude/skills/croft/SKILL.md`, written for the croft version it pins. Load it, and run `croft context --json`.

## Install and create a project

croft needs Bun 1.3.14 or newer, on macOS or Linux.

```sh
bun --version                    # 1.3.14 or newer
bun add -g @zabaca/croft         # the croft launcher, in ~/.bun/bin
croft init my-data
cd my-data
```

`croft init` installs the project's pinned croft, runs an offline example, and writes the project skill, a
`croft` subagent that preloads it (`.claude/agents/croft.md`) and a `CLAUDE.md` block. From then on, follow the
project skill, or hand the project's data work to that agent. Inside an existing app (a `package.json` is there),
`croft init` puts the project in `data/` and never overwrites the app's files.

## The loop, in short

```sh
croft validate
croft preview duckdb_releases
croft run duckdb_releases
```

1. New asset: `croft new api|file|sql|transform <name>` writes a working, commented template (`croft new --list`).
2. `croft validate --json` after every edit; apply each problem's `fix`.
3. `croft preview <name>` builds it in a sandbox and diffs it; nothing real changes.
4. `croft run <name>`, then check with `croft query "<select>"`.

## Ask the user first

- Any `croft confirm <token>`: every destructive step ends there. Show the printed impact and wait for an
  explicit yes in this conversation.
- `croft schedule on` (it runs ingests unattended) and `croft serve` (ask them to start it in their terminal).
- Secrets: ask the user to add `NAME=...` to `.env`, or to run `croft secrets set NAME` themselves. Never read
  `.env`.

`croft docs --list` lists every topic and error code, offline, for the installed version.
