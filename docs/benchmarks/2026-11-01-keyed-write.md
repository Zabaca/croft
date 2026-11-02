# The merge benchmark: what a keyed write costs, before and after counting by classifying (2026-11-01)

Option 07, slice 1 (DESIGN.md D-L2). A keyed write used to count what it changed from the actions one `MERGE ... RETURNING`
gives back; a lake refuses `RETURNING` on `MERGE`, so croft now classifies the batch against the table first (added, updated,
unchanged; for a replace, the table rows no batch row has the key of), inserts the added rows, merges only the updated ones and
deletes the unmatched. The option let a file keep the old way if the new one made the whole write step more than 15% slower.

Reproduce: `bun packages/croft/scripts/bench-merge.ts --rows 100000 --runs 9 --big --lake` (add `--only <text>` to pick a scenario).
The script runs croft's own write path (`writeBatch`) on a warehouse file, one transaction per run: the batch staged as a TEMP
table, the write, the bookkeeping and the COMMIT. "Whole step" is that, staging to commit. "Merge statement" is the time of the
MERGE statement alone. Each run starts from a copy of the same file, the two ways alternate inside one process, and the
median is reported (the first pair is thrown away).

Machine: macOS arm64, Bun 1.3.14, DuckDB 2.0.0 (`@duckdb/node-api` 2.0.0-r.1), local SSD. **The machine was busy** (load average 9 to
17: other builders' test suites were running), so a figure is good to about 10% at the 50 ms scale; the comparisons below are
between two ways run alternately in one process, which is the fair one.

## Before: `main` at bb492ce

Both rows run the old code (the `counting` option does not exist there), so they show the noise between two runs of the same
statements: within 1.5% in this table.

croft merge benchmark: bun 1.3.14, darwin arm64, 9 runs per cell (median)

| scenario | counting | whole step ms | merge statement ms | classify ms | insert ms | delete ms | counts (added/updated/unchanged/deleted) |
|---|---|---:|---:|---:|---:|---:|---|
| merge, 100k table, 100k batch | returning | 97 | 26 | - | - | - | 50000/25000/25000/0 |
| merge, 100k table, 100k batch | classify | 96 | 25 | 0 | 0 | 0 | 50000/25000/25000/0 |
| replace, 100k table, 100k batch | returning | 115 | 39 | - | - | - | 50000/25000/25000/50000 |
| replace, 100k table, 100k batch | classify | 115 | 39 | 0 | 0 | 0 | 50000/25000/25000/50000 |
| merge, 100k table, nothing changed | returning | 71 | 9 | - | - | - | 0/0/100000/0 |
| merge, 100k table, nothing changed | classify | 71 | 10 | 0 | 0 | 0 | 0/0/100000/0 |
| merge, 100k table, 10k new rows | returning | 51 | 4 | - | - | - | 10000/0/0/0 |
| merge, 100k table, 10k new rows | classify | 50 | 4 | 0 | 0 | 0 | 10000/0/0/0 |
| merge, 1M table, 10k batch | returning | 45 | 4 | - | - | - | 5000/2500/2500/0 |
| merge, 1M table, 10k batch | classify | 45 | 4 | 0 | 0 | 0 | 5000/2500/2500/0 |

| scenario | classify vs returning, whole step | merge statement alone (classify path vs returning) |
|---|---:|---:|
| merge, 100k table, 100k batch | -1.0% (97 to 96 ms) | -4.5% (26 to 25 ms) |
| replace, 100k table, 100k batch | +0.3% (115 to 115 ms) | +0.9% (39 to 39 ms) |
| merge, 100k table, nothing changed | +0.1% (71 to 71 ms) | +0.3% (9 to 10 ms) |
| merge, 100k table, 10k new rows | -1.5% (51 to 50 ms) | -0.2% (4 to 4 ms) |
| merge, 1M table, 10k batch | +0.1% (45 to 45 ms) | -2.4% (4 to 4 ms) |

## After: this branch, file

"returning" is the old statement, kept for this benchmark and for the tests that hold the counts equal; "classify" is what every
write does now.

croft merge benchmark: bun 1.3.14, darwin arm64, 9 runs per cell (median)

| scenario | counting | whole step ms | merge statement ms | classify ms | insert ms | delete ms | counts (added/updated/unchanged/deleted) |
|---|---|---:|---:|---:|---:|---:|---|
| merge, 100k table, 100k batch | returning | 94 | 24 | - | - | - | 50000/25000/25000/0 |
| merge, 100k table, 100k batch | classify | 92 | 10 | 13 | 5 | 0 | 50000/25000/25000/0 |
| replace, 100k table, 100k batch | returning | 113 | 37 | - | - | - | 50000/25000/25000/50000 |
| replace, 100k table, 100k batch | classify | 98 | 10 | 13 | 5 | 3 | 50000/25000/25000/50000 |
| merge, 100k table, nothing changed | returning | 69 | 9 | - | - | - | 0/0/100000/0 |
| merge, 100k table, nothing changed | classify | 71 | 0 | 12 | 0 | 0 | 0/0/100000/0 |
| merge, 100k table, 10k new rows | returning | 47 | 4 | - | - | - | 10000/0/0/0 |
| merge, 100k table, 10k new rows | classify | 49 | 0 | 3 | 2 | 0 | 10000/0/0/0 |
| merge, 1M table, 10k batch | returning | 51 | 5 | - | - | - | 5000/2500/2500/0 |
| merge, 1M table, 10k batch | classify | 56 | 3 | 4 | 2 | 0 | 5000/2500/2500/0 |

| scenario | classify vs returning, whole step | merge statement alone (classify path vs returning) |
|---|---:|---:|
| merge, 100k table, 100k batch | -1.7% (94 to 92 ms) | -57.2% (24 to 10 ms) |
| replace, 100k table, 100k batch | -13.5% (113 to 98 ms) | -73.3% (37 to 10 ms) |
| merge, 100k table, nothing changed | +3.2% (69 to 71 ms) | -100.0% (9 to 0 ms) |
| merge, 100k table, 10k new rows | +4.3% (47 to 49 ms) | -100.0% (4 to 0 ms) |
| merge, 1M table, 10k batch | +10.0% (51 to 56 ms) | -34.3% (5 to 3 ms) |

In a local lake (SQLite catalog, local folder), 9 runs per cell (median), the table seeded through croft's own write path:

| scenario | step | whole step ms | classify ms | insert ms | merge statement ms | delete ms |
|---|---|---:|---:|---:|---:|---:|
| merge, 100k table, 100k batch | croft: classify, insert, merge, delete | 181 | 15 | 7 | 31 | 0 |
| merge, 100k table, 100k batch | one plain MERGE, nothing counted | 50 | - | - | 24 | - |
| replace, 100k table, 100k batch | croft: classify, insert, merge, delete | 224 | 15 | 8 | 33 | 23 |
| replace, 100k table, 100k batch | one plain MERGE, nothing counted | 76 | - | - | 25 | - |
| merge, 100k table, nothing changed | croft: classify, insert, merge, delete | 142 | 15 | 0 | 0 | 0 |
| merge, 100k table, nothing changed | one plain MERGE, nothing counted | 37 | - | - | 16 | - |
| merge, 100k table, 10k new rows | croft: classify, insert, merge, delete | 127 | 3 | 3 | 0 | 0 |
| merge, 100k table, 10k new rows | one plain MERGE, nothing counted | 27 | - | - | 5 | - |

Reading it:

- **Whole step, classify against returning:** between -13.5% and +10.0% in this run. Over every run made while building (five to
  fifteen runs each, 1k to 1M rows) the slowest scenarios were "100k table, nothing changed" (+3.2% to +14.5%: +9.1% to +14.5% with
  the first classification table, which copied every column of the batch, and +9.6% and +3.2% with the narrow one that keeps
  only each row's sequence number and verdict) and "1M table, 10k batch" (+3.0% and +10.0% in the two runs of 7 and 9 runs, +8.3% and
  +9.7% in two runs of 15). Two 15-run runs on `main`, where both rows are the same code, gave +0.9% and -4.6%, so the noise is
  about 5%. The 15% ceiling holds, with little room in those two. A replace is faster (its single MERGE with
  `WHEN NOT MATCHED BY SOURCE` was the slow statement), and a batch of new rows or a merge of 100k rows is within noise.
- **The merge statement alone** is 57% to 77% faster where rows changed (over all the runs), because it merges only the changed rows; the classifying
  (about 12 to 13 ms for 100k rows) and the insert are what the whole step pays instead.
- **Before and after across processes** (main's first table against this branch's old statement) agree to within that noise:
  97 and 94 ms, 115 and 113 ms, 71 and 69 ms, 51 and 47 ms; the 1M-row scenario measured 45 to 56 ms on main and 51 to 56 ms
  here. Nothing in the bookkeeping adapter's indirection shows at this scale.

## In a lake

The same write against a local lake (a SQLite catalog and a local folder, the suite's lake profile; the table seeded through croft's
own write path, bookkeeping as a log). No network, so these are the statements' own times, not R2's latency. The lake takes
a MERGE with one UPDATE or DELETE action ("MERGE INTO with DuckLake only supports a single UPDATE/DELETE action currently"),
so the plain statement of the second row is a MERGE with an UPDATE and an INSERT, followed by a DELETE for a replace.

- **What counting costs there:** with a 100k-row table and a 100k-row batch the classifying is 15 ms, the insert 7 ms and the
  MERGE of the changed rows 31 ms, 53 ms together, against 24 ms for one plain MERGE that counts nothing and cannot say what it changed
  (the lake spike measured 33 ms to classify and 41 ms to merge, 74 ms, on a Postgres catalog). A re-run that finds nothing new costs 15 ms of classifying and no
  MERGE, against 16 ms for a plain MERGE that finds nothing to change.
- **The whole croft step in a lake** (181 ms for the first row against 50 ms for the plain statement and its staging) is everything
  else the write does there: reading the table's shape and stats and appending the bookkeeping rows, each a statement to the
  catalog. That is not counting's cost; slice 2 looks at it with the real catalog.
