---
title: What croft is
description: croft is one command-line tool for local data pipelines in TypeScript, on one DuckDB file, built to be driven by an agent.
---

croft is one command-line tool for data pipelines that live on your machine. It pulls data from APIs and files, transforms it with SQL or TypeScript, keeps the tables fresh on a schedule, and lets an app read them. Everything lives in one DuckDB file.

It does the jobs dlt, SQLMesh and Dagster do together, for people who are not data engineers and who build with Claude Code or another coding agent. It is not compatible with any of them, and does not try to be.

## A project is a folder

Each file in `assets/` defines one table, and the table has the file's name.

```text
my-data/
  croft.json            database file and timezone
  assets/
    stripe_charges.ts   an ingest: pulls charges from Stripe's API
    sales.ts            an ingest: loads CSV exports dropped into files/sales/
    daily_revenue.sql   a transform: one SELECT over the two above
  files/sales/*.csv
  warehouse.duckdb      every table, in one file
```

`croft run` brings the tables up to date. A table that reads an updated table is updated after it, in the same run.

## What it promises

- **Every write is all-or-nothing.** Checks run on the rows before they are saved. If a check fails, nothing is written and the table keeps its previous data.
- **Ingested data is never refetched or deleted on its own**, because it may be impossible to fetch again. Anything destructive goes to the trash first and runs only after `croft confirm`.
- **Nothing to set up.** croft needs Bun and nothing else: no Python, no Docker, no server, no system DuckDB.
- **Two users at once.** The person gets few concepts and plain-language output. The agent gets `--json` on every command, stable error codes with fixes it can apply, a fast validation loop that touches no data, and a skill.

## Where to go next

- [Install](/docs/install/) croft, then follow the [Quickstart](/docs/quickstart/): a project, an API ingest and a SQL transform in about five minutes.
- [With Claude Code and other agents](/docs/agents/) covers what croft gives an agent, and the one permission rule that gates every destructive step.
- [The seven concepts](/docs/concepts/) are all there is to learn.
- The [Guides](/docs/guides/ingest/) and [Reference](/docs/reference/cli/) are the same pages `croft docs` prints offline, for the version you have installed.
