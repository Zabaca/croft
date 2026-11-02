# The merge benchmark: what a keyed write costs, before and after counting by classifying (2026-11-01)

Option 07, slice 1 (DESIGN.md D133). A keyed write used to count what it changed from the actions one `MERGE ... RETURNING`
gives back; a lake refuses `RETURNING` on `MERGE`, so croft now classifies the batch against the table first (added, updated,
unchanged; for a replace, the table rows no batch row has the key of), inserts the added rows, merges only the updated ones and
deletes the unmatched. The option let a file keep the old way if the new one made the whole write step more than 15% slower.

Reproduce: `bun packages/croft/scripts/bench-merge.ts --rows 100000 --runs 11 --big --lake` (`--only <text>` picks a scenario).
The script runs croft's own write path (`writeBatch`) on a warehouse file, one transaction per run: the batch staged as a TEMP
table, the write, the bookkeeping and the COMMIT. "Whole step" is that, staging to commit. "Merge statement" is the time of the
MERGE statement alone. Each run starts from a copy of the same file, the two ways alternate inside one process, and the
median is reported (the first pair is thrown away).

Machine: macOS arm64, Bun 1.3.14, DuckDB 2.0.0 (`@duckdb/node-api` 2.0.0-r.1), local SSD. The tables below were taken with a load average
of 5 to 7, while other work ran on the machine; at the 40 to 100 ms scale a figure is good to about 5 to 10%, which is why the
comparison that counts is between the two ways run alternately in one process.

## Before: `main` at bb492ce

`scripts/bench-merge.ts` does not exist at bb492ce. For this table it was copied into a clean checkout of bb492ce (a detached
worktree) and run there. The code there has no `counting` option, which the script passes and the old code ignores, so both rows
run the old `MERGE ... RETURNING`: the table shows the old whole-step times, and, between its two rows, the noise (within 1.3%).

croft merge benchmark: bun 1.3.14, darwin arm64, 11 runs per cell (median)

| scenario | counting | whole step ms | merge statement ms | classify ms | insert ms | delete ms | counts (added/updated/unchanged/deleted) |
|---|---|---:|---:|---:|---:|---:|---|
| merge, 100k table, 100k batch | returning | 88 | 24 | - | - | - | 50000/25000/25000/0 |
| merge, 100k table, 100k batch | classify | 88 | 24 | 0 | 0 | 0 | 50000/25000/25000/0 |
| replace, 100k table, 100k batch | returning | 102 | 37 | - | - | - | 50000/25000/25000/50000 |
| replace, 100k table, 100k batch | classify | 102 | 36 | 0 | 0 | 0 | 50000/25000/25000/50000 |
| merge, 100k table, nothing changed | returning | 64 | 9 | - | - | - | 0/0/100000/0 |
| merge, 100k table, nothing changed | classify | 64 | 9 | 0 | 0 | 0 | 0/0/100000/0 |
| merge, 100k table, 10k new rows | returning | 42 | 3 | - | - | - | 10000/0/0/0 |
| merge, 100k table, 10k new rows | classify | 42 | 4 | 0 | 0 | 0 | 10000/0/0/0 |
| merge, 1M table, 10k batch | returning | 41 | 4 | - | - | - | 5000/2500/2500/0 |
| merge, 1M table, 10k batch | classify | 41 | 4 | 0 | 0 | 0 | 5000/2500/2500/0 |

| scenario | classify vs returning, whole step | merge statement alone (classify path vs returning) |
|---|---:|---:|
| merge, 100k table, 100k batch | -0.3% (88 to 88 ms) | -1.2% (24 to 24 ms) |
| replace, 100k table, 100k batch | +0.7% (102 to 102 ms) | -1.1% (37 to 36 ms) |
| merge, 100k table, nothing changed | +0.8% (64 to 64 ms) | -0.8% (9 to 9 ms) |
| merge, 100k table, 10k new rows | -1.3% (42 to 42 ms) | +6.8% (3 to 4 ms) |
| merge, 1M table, 10k batch | +0.1% (41 to 41 ms) | -6.4% (4 to 4 ms) |

## After: this branch, file

"returning" is the old statement, kept for this benchmark and for the tests that hold the counts equal; "classify" is what every
write does now.

croft merge benchmark: bun 1.3.14, darwin arm64, 11 runs per cell (median)

| scenario | counting | whole step ms | merge statement ms | classify ms | insert ms | delete ms | counts (added/updated/unchanged/deleted) |
|---|---|---:|---:|---:|---:|---:|---|
| merge, 100k table, 100k batch | returning | 87 | 23 | - | - | - | 50000/25000/25000/0 |
| merge, 100k table, 100k batch | classify | 90 | 11 | 12 | 6 | 0 | 50000/25000/25000/0 |
| replace, 100k table, 100k batch | returning | 99 | 34 | - | - | - | 50000/25000/25000/50000 |
| replace, 100k table, 100k batch | classify | 90 | 11 | 12 | 6 | 3 | 50000/25000/25000/50000 |
| merge, 100k table, nothing changed | returning | 63 | 9 | - | - | - | 0/0/100000/0 |
| merge, 100k table, nothing changed | classify | 65 | 0 | 11 | 0 | 0 | 0/0/100000/0 |
| merge, 100k table, 10k new rows | returning | 42 | 3 | - | - | - | 10000/0/0/0 |
| merge, 100k table, 10k new rows | classify | 43 | 0 | 2 | 2 | 0 | 10000/0/0/0 |
| merge, 1M table, 10k batch | returning | 42 | 4 | - | - | - | 5000/2500/2500/0 |
| merge, 1M table, 10k batch | classify | 45 | 3 | 3 | 2 | 0 | 5000/2500/2500/0 |

| scenario | classify vs returning, whole step | merge statement alone (classify path vs returning) |
|---|---:|---:|
| merge, 100k table, 100k batch | +2.9% (87 to 90 ms) | -52.7% (23 to 11 ms) |
| replace, 100k table, 100k batch | -9.5% (99 to 90 ms) | -68.6% (34 to 11 ms) |
| merge, 100k table, nothing changed | +4.3% (63 to 65 ms) | -100.0% (9 to 0 ms) |
| merge, 100k table, 10k new rows | +1.2% (42 to 43 ms) | -100.0% (3 to 0 ms) |
| merge, 1M table, 10k batch | +7.2% (42 to 45 ms) | -15.4% (4 to 3 ms) |


Reading it:

- **Whole step, classify against returning:** this table gives +2.9%, -9.5%, +4.3%, +1.2% and +7.2% (in the order of its rows); the pass
  just before it gave +0.5%, -8.9%, +4.5%, +2.5% and +9.6%. The two slowest are "100k table, nothing changed" (+3.2% to +14.5% over
  every run made while building, the larger figures from a busier machine and from the first classification table, which copied
  every column of the batch) and "1M table, 10k batch" (+3.0% to +10.0%). The reviewer's rerun at load 4 to 5 gave a worst case
  of +9.7%, +5% to +9% for the 1M table and +3.5% to +4.5% for the unchanged 100k. The 15% ceiling holds, with little room in those
  two. A replace is faster (its single MERGE with `WHEN NOT MATCHED BY SOURCE` was the slow statement), and a batch of new rows or a
  merge of 100k rows is within noise.
- **The merge statement alone** is 15% to 71% faster where rows changed, because it merges only the changed rows: 53% and 55% for
  the 100k merge, 69% to 71% for the 100k replace, and 15% to 19% for 10k rows against a 1M-row table (where the MERGE was
  4 ms to begin with); where nothing changed it does not run. The classifying (about 12 ms for 100k rows) and the insert
  are what the whole step pays instead.
- **Before and after across processes** (main's first table against this branch's old statement) agree to within that noise:
  88 and 87 ms, 102 and 99 ms, 64 and 63 ms, 42 and 42 ms, 41 and 42 ms. Nothing in the bookkeeping adapter's indirection shows
  at this scale.

## In a lake

The same write against a local lake (a SQLite catalog and a local folder, the suite's lake profile; the table seeded through croft's
own write path, bookkeeping as a log). No network, so these are the statements' own times, not R2's latency. The lake takes a MERGE
with one UPDATE or DELETE action ("MERGE INTO with DuckLake only supports a single UPDATE/DELETE action currently"), so the plain
statement of the second row is a MERGE with an UPDATE and an INSERT, followed by a DELETE for a replace.

- **What counting costs there, statement against statement:** with a 100k-row table and a 100k-row batch croft's statements take
  14 ms to classify, 8 ms to insert the added rows and 36 ms to merge the changed ones, 58 ms together, against 22 ms for one plain
  MERGE that counts nothing and cannot say what it changed. For a replace they are 14 + 8 + 35 + 21 against 22 + 21 ms (a
  lake has to delete the unmatched rows in either case). A re-run that finds nothing new costs 13 ms of classifying and no MERGE,
  against 13 ms for a plain MERGE that finds nothing to change; 10k new rows cost 5 ms against 4 ms. (The lake spike measured 33 ms to
  classify and 41 ms to merge, 74 ms, on a Postgres catalog.)
- **The whole croft step in a lake** (172 ms for the first row against 45 ms for the plain statement and its staging) is not a like
  for like comparison: croft's step also reads the table's shape and stats and appends the bookkeeping rows, each a statement to the
  catalog, and the plain figure does none of that. Slice 2 looks at it with the real catalog.

In a local lake (SQLite catalog, local folder), 11 runs per cell (median), the table seeded through croft's own write path:

| scenario | step | whole step ms | classify ms | insert ms | merge statement ms | delete ms |
|---|---|---:|---:|---:|---:|---:|
| merge, 100k table, 100k batch | croft: classify, insert, merge, delete | 172 | 14 | 8 | 36 | 0 |
| merge, 100k table, 100k batch | one plain MERGE, nothing counted | 45 | - | - | 22 | 0 |
| replace, 100k table, 100k batch | croft: classify, insert, merge, delete | 190 | 14 | 8 | 35 | 21 |
| replace, 100k table, 100k batch | one plain MERGE, nothing counted | 65 | - | - | 22 | 21 |
| merge, 100k table, nothing changed | croft: classify, insert, merge, delete | 120 | 13 | 0 | 0 | 0 |
| merge, 100k table, nothing changed | one plain MERGE, nothing counted | 31 | - | - | 13 | 0 |
| merge, 100k table, 10k new rows | croft: classify, insert, merge, delete | 98 | 2 | 3 | 0 | 0 |
| merge, 100k table, 10k new rows | one plain MERGE, nothing counted | 21 | - | - | 4 | 0 |
