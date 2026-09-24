# Writing an SQL asset: the header, one SELECT, and how it is rebuilt

An SQL asset is one file in assets/ that makes one table with the file's name (assets/open_issues.sql makes
open_issues). It reads other assets by their plain names. croft finds what it reads in the SQL itself, builds
those first, and rebuilds this table whenever one of them changes: there is no list of inputs to keep up to
date. Use SQL for filters, joins and aggregates; use a TypeScript transform for per-row code such as an API or
LLM call (croft docs transforms).

## The file

```sql
-- assets/open_issues.sql
-- description: Open issues (not pull requests) with author and label names
-- key: id
-- check: not_null(author)
-- warn: comments >= 0
SELECT
  id,
  number,
  title,
  user->>'login'        AS author,        -- nested objects are JSON columns
  labels->>'$[*].name'  AS label_names,   -- the names of every label, as a list
  comments,
  created_at
FROM github_issues
WHERE state = 'open' AND pull_request IS NULL
```

The header is the run of `-- name: value` lines at the top of the file, before any SQL. It takes four names:

  description   what the table holds; croft describe shows it
  key           the column or columns that identify a row, comma-separated: -- key: day, region
  check         a blocking check, one per line, as many as needed (croft docs checks)
  warn          a warning: the same language, but it only reports

Plain `--` comments may sit between header lines. Any other name before a colon is HEADER_UNKNOWN_KEY (a
misspelled -- chek: gets a did-you-mean). A -- key: or -- check: line below the first line of SQL is not part of
the header: keep the header at the very top.

The body is exactly ONE SELECT. CTEs (WITH ...), subqueries, UNION and window functions are fine, and so is a
trailing `;` or comment. croft creates and writes the table itself, so there is no CREATE, INSERT or COPY.

## An aggregate, and an asset that reads another SQL asset

These two read example_sales, the example ingest of a new project (assets/example_sales.ts).

```sql
-- assets/daily_sales.sql
-- description: Orders and revenue per day and region
-- key: day, region
-- check: orders > 0
-- check: amount >= 0
SELECT
  order_date   AS day,
  region,
  count(*)     AS orders,
  sum(amount)  AS amount
FROM example_sales
GROUP BY ALL
```

```sql
-- assets/region_share.sql
-- description: Each region's share of all revenue
-- key: region
-- check: share BETWEEN 0 AND 1
SELECT
  region,
  sum(amount)                                                  AS amount,
  round(sum(amount) / (SELECT sum(amount) FROM daily_sales), 4) AS share
FROM daily_sales
GROUP BY region
```

## How it is built

- A run rebuilds the table in full when it was never built, when an input's rows changed, when its SQL changed,
  or when croft.json's timezone changed (::DATE depends on it). Whitespace, comments and keyword case do not
  count as a change. When nothing changed, the run skips it as up to date. There is no incremental SQL.
- The result is written as a diff against the current table: rows that did not change keep their _loaded_at.
  So an incremental TypeScript transform that reads this table only sees rows whose values changed. With a key,
  rows are matched by key; without one, by their whole content.
- When the output's columns change (one added, removed or retyped), the table is recreated and every row gets
  a new _loaded_at.
- Blocking checks run inside the same transaction: when one fails, nothing is written and the table keeps its
  previous rows (croft docs CHECK_FAILED).
- `croft run <name>` builds it and the stale assets downstream of it; `--upstream` refreshes stale inputs first,
  `--only` leaves out downstream. A bare `croft run` updates every stale transform.

## What the SQL may read

- The project's tables, by plain name: FROM github_issues. main.github_issues is the same table; any other
  prefix (other.main.orders, memory.orders) is CATALOG_PREFIX.
- Not files: FROM 'files/x.csv' or read_csv(...) is SQL_READS_FILES, because croft cannot tell when a file
  changed. Make a file ingest (croft docs ingest) and read its table. `croft query` can read files directly, to
  look at one first.
- Not DESCRIBE, SUMMARIZE or SHOW (SQL_NOT_SELECT); use them in `croft query`.
- Tables named in a -- check: or -- warn: subquery are built first too.

## Writing it well

- Set a key whenever rows have an identity: it adds unique(key) and not_null(key) checks, and an incremental
  TypeScript transform that reads this table with newRows() needs it (INPUT_NEEDS_KEY).
- Reserved columns: croft adds _loaded_at to every table, and file ingests have _file. Both are dropped from an
  SQL asset's output, so SELECT * over an asset is fine. Two output columns with one name (case does not count)
  are DUPLICATE_OUTPUT_COLUMN: name each once with AS.
- PIVOT needs its values listed: PIVOT t ON cat IN ('a', 'b') USING sum(x), or sum(x) FILTER (WHERE cat = 'a')
  (PIVOT_NEEDS_VALUES).
- now(), current_date, random() and the like freeze at the last rebuild (VOLATILE_SQL): compute ages at query
  time instead.
- Columns named like SQL keywords must be quoted: "order", "group" (QUOTE_IDENTIFIER).
- Nested fields are JSON columns: col->>'field', col->>'$[*].name', json_each(col). croft describe <input> lists
  the keys.
- TIMESTAMPTZ values cast to DATE in croft.json's timezone; epoch seconds become a timestamp with
  to_timestamp(created).

## Try it

  croft validate --json      checks the header and the SELECT, and binds it against the columns of what it
                             reads; data.assets[].outputColumns lists what an asset reading this one can use.
                             An input that never ran is INPUT_NOT_BUILT (info): run or preview it first.
  croft preview <name>       builds it from snapshots of its inputs and diffs it against the live table;
                             nothing real changes. croft query --preview "..." looks at the result.
  croft run <name>           builds it for real, with its checks.
  croft query "from <name> limit 5"
