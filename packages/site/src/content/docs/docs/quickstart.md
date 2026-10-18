---
title: Quickstart
description: A croft project, a SQL transform, an API ingest and a schedule, in about five minutes. Every output on this page is from a real run of croft 0.1.0.
---

This page builds a small project: the example table `croft init` creates, a SQL transform over it, and an ingest from a public API that needs no token. Every output shown is from a real run of croft 0.1.0.

You need croft [installed](/docs/install/).

## 1. Create a project

```sh
croft init my-data
cd my-data
```

```text
Created my-data/ (croft 0.1.0, timezone America/Los_Angeles)
Installed dependencies (bun install, 349 ms)
Ran example_sales: 120 rows · checks ok
Claude Code: CLAUDE.md and .claude/skills/croft/SKILL.md are ready. croft docs claude-permissions suggests permission rules.
next: cd my-data && croft query "from example_sales limit 5"  # look at the example table
```

`init` scaffolded the project, installed its pinned copy of croft, and ran the one asset it ships, `assets/example_sales.ts`, which loads `files/example_sales.csv`. No network was needed.

```sh
croft query "from example_sales limit 5"
```

```text
order_id   order_date   customer        region   product                    quantity   unit_price   amount   _file                     _loaded_at
1001       2026-01-02   Willow Yoga     East     Espresso cups (set of 4)   6          22           132      files/example_sales.csv   2026-10-18T00:45:09.816-07:00
1002       2026-01-02   Cedar Books     East     Tea sampler                2          14.25        28.5     files/example_sales.csv   2026-10-18T00:45:09.816-07:00
1003       2026-01-02   Maple Bakery    North    Tote bag                   6          7.5          45       files/example_sales.csv   2026-10-18T00:45:09.816-07:00
1004       2026-01-02   Riverbend Gym   South    Ceramic mug                1          9            9        files/example_sales.csv   2026-10-18T00:45:09.816-07:00
1005       2026-01-02   Riverbend Gym   South    Coffee beans 1kg           6          18.5         111      files/example_sales.csv   2026-10-18T00:45:09.816-07:00
(5 rows, 1.7 s)
```

Every table gets `_loaded_at`, the time each row last changed. File ingests also get `_file`.

## 2. Add a SQL transform

```sh
croft new sql revenue_by_region
```

`croft new` writes a commented template that already works. Replace `assets/revenue_by_region.sql` with:

```sql
-- description: Revenue and orders per region
-- key: region
-- check: min_rows(1)
-- check: revenue > 0
SELECT
  region,
  count(*)    AS orders,
  sum(amount) AS revenue
FROM example_sales
GROUP BY region
```

The `--` lines at the top are the header. `key` names what identifies a row and adds `unique` and `not_null` checks; each `check` is a rule every build must pass. croft finds that this asset reads `example_sales` from the SQL itself; there is nothing to declare.

## 3. Validate, preview, run

This is the loop for every change: validate, preview, run.

```sh
croft validate
```

```text
checked 2 assets in 98 ms
0 errors, 0 warnings
```

`validate` touches no data. It parses every asset, finds what each reads, and binds every SELECT against its inputs' columns, so a misspelled column is an error here and not in a run.

```sh
croft preview revenue_by_region
```

```text
Preview: your real tables are not changed.
revenue_by_region 4 rows (new table)   +4 added · 0 removed · 0 changed (by key region)
  columns     new table: region VARCHAR · orders BIGINT · revenue DOUBLE
  checks      ok unique(region) · ok not_null(region) · ok min_rows(1) · ok revenue > 0
  note        built in full; from live example_sales
  sample      region  orders  revenue
              East    50      2637.5
              North   17      885.5
              West    30      1333
Explore: croft query --preview "from revenue_by_region"
Apply:   croft run revenue_by_region
```

`preview` builds the asset in a sandbox from a snapshot of its inputs and diffs it against the live table.

```sh
croft run revenue_by_region
```

```text
run r_1018_0045_ecsl · 1 asset
ok       revenue_by_region  4 rows (57 ms) · new table, 3 columns
                            added 4 · updated 0 · unchanged 0 · 4 rows now · checks 4/4 ok
                            never built
done 57 ms · 1 updated · 0 failed
next: croft query "from revenue_by_region limit 5"  # look at revenue_by_region
```

From now on, whenever `example_sales` changes, the next `croft run` rebuilds `revenue_by_region` after it.

## 4. Ingest from an API

Create `assets/duckdb_releases.ts`. It reads DuckDB's releases from GitHub's public API, which needs no token, following the `Link` header from page to page:

```ts
import { ingest } from "@zabaca/croft";

export default ingest({
  description: "DuckDB releases on GitHub",
  key: "id",

  async *rows({ http }) {
    let res = await http.get("https://api.github.com/repos/duckdb/duckdb/releases", {
      query: { per_page: 100 },
    });
    for (;;) {
      yield res.json<{ id: number }[]>();
      if (!res.next) return;
      res = await http.get(res.next);
    }
  },
});
```

An ingest yields batches of rows. croft infers the column types, turns nested objects into JSON columns, and writes the batch. With a `key`, a record fetched again replaces its old row instead of adding a duplicate.

```sh
croft validate
croft preview duckdb_releases
croft run duckdb_releases
```

```text
run r_1018_0045_287x · 1 asset
ok       duckdb_releases    1 request, 64 rows (1.1 s) · new table, 22 columns (3 JSON)
                            added 64 · updated 0 · unchanged 0 · 64 rows now · checks 2/2 ok
done 1.1 s · 1 updated · 0 failed
```

Nested fields are JSON, read with `->>`:

```sh
croft query "select tag_name, published_at::date as published, author->>'login' as author from duckdb_releases order by published_at desc limit 5"
```

```text
tag_name   published    author
v1.5.6     2026-09-28   Maxxen
v1.5.5     2026-07-22   lnkuiper
v1.5.4     2026-06-17   lnkuiper
v1.4.5     2026-06-17   lnkuiper
v1.5.3     2026-05-20   lnkuiper
(5 rows, 66 ms)
```

For your own APIs, start from a template rather than a blank file: `croft new --list` shows one for each kind of pagination (cursor, keyset, `Link` header, page numbers), plus file ingests and TypeScript transforms. An API that needs a key reads it with `secret("NAME")` from `.env`; see [Secrets](/docs/guides/secrets/).

## 5. Keep it fresh

Add a schedule to the ingest, in plain words:

```ts
  key: "id",
  schedule: "daily at 6am",
```

```sh
croft validate
```

```text
checked 3 assets in 106 ms
duckdb_releases: daily at 6am (cron 0 6 * * *); next 2026-10-18 06:00, 2026-10-19 06:00, 2026-10-20 06:00
0 errors, 0 warnings
next: croft preview duckdb_releases  # see what the changed code builds before running it
```

Only ingests have schedules. Transforms follow their inputs: when an ingest brings new rows, what reads it is rebuilt in the same run.

The scheduler only runs code a person has run. An edited asset is held until you run it by hand once, so it never runs a half-finished edit unattended:

```sh
croft schedule status
```

```text
Scheduling off · never ticked
ASSET               SCHEDULE       CRON        NEXT    LAST FIRE   STATUS
duckdb_releases     daily at 6am   0 6 * * *   06:00   —           held: code edited 0 s ago, not run by hand yet; croft run duckdb_releases releases it
example_sales       manual         —           —       —           —
revenue_by_region   after inputs   —           —       —           —
next: croft schedule on  # ask the user first: it runs the scheduled ingests on their schedules, unattended
```

`croft run duckdb_releases` releases it, and `croft schedule on` installs one per-user OS job (launchd on macOS, cron on Linux) that ticks every minute and runs whatever is due. See [Scheduling](/docs/guides/scheduling/).

## Where things are

```sh
croft status                 # every asset: rows, last run, next run, and anything failed, stale or held
croft describe duckdb_releases   # one asset in words: behavior, columns, JSON keys, checks, recent writes
croft docs --list            # every topic and error code, offline, for this version
```

Next:

- [With Claude Code and other agents](/docs/agents/): let an agent do all of the above.
- [The seven concepts](/docs/concepts/) behind what you just did.
- [Ingests: APIs and files](/docs/guides/ingest/) for incremental loads, lookbacks and file folders.
