# What a lake's maintenance costs and leaves (D149 to D152)

`scripts/simulate-lake-maintenance.ts`, run on 2026-11-02 on macOS arm64 (bun 1.3.14, DuckDB 2.0.0, a Postgres 17 and an S3-compatible store started by the test rig, all on this machine, and a local lake: a SQLite catalog and a folder). The lake is the lake spike's: five assets written hourly, each a commit of its own with the bookkeeping rows of a step (`db/lake-simulation-testkit.ts`): two assets get 5 rows an hour (kept inside the catalog), two get a merge of 50 rows, and one is a full refresh of 2,000 rows. Each snapshot is said to have been made at the hour of its run (the catalog's own record is changed to match), and a pass is made by croft's code (`runPass`, under its lock) with `now` the simulated time. No R2, no remote Postgres, no network distance: the figures are the statements' own.

"replace" writes the full refresh as the spike did (`CREATE OR REPLACE TABLE`: a new lake table every hour, which is where its inlined-data tables came from); "in place" is how croft writes a full refresh whose shape does not change (D146).

## A week, then a pass (acceptance 1)

168 hourly runs, 840 commits, full refresh as the spike wrote it. The spike's simulated week had 849 snapshots, 841 files, 176 inlined-data tables and a 12 MB catalog.

| lake | when | snapshots | data files | read now | inlined tables | waiting for deletion | catalog | data |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| local | before the pass | 842 | 839 | 339 | 181 | 0 | 1.9 MB | 2.2 MB |
| local | pass at the end of the week, nothing older than 30 days (347 ms, 0 expired) | 845 | 511 | 10 | 181 | 0 | 1.9 MB | 2.1 MB |
| postgres | before the pass | 842 | 839 | 339 | 181 | 0 | 13.1 MB | 2.2 MB |
| postgres | pass at the end of the week, nothing older than 30 days (323 ms, 0 expired) | 845 | 511 | 10 | 181 | 0 | 13.2 MB | 2.1 MB |
| local | pass 40 days later (656 ms, 817 expired) | 28 | 26 | 10 | 18 | 0 | 1.9 MB | 0.3 MB |
| postgres | pass 40 days later (895 ms, 817 expired) | 28 | 26 | 10 | 18 | 0 | 11.9 MB | 0.3 MB |

With croft's own full refresh (in place), the same week and the pass 40 days later: 842 snapshots, 839 files, 13 inlined tables before; 28 snapshots, 26 files (10 read now), 13 inlined tables after; 457 ms (local) and 491 ms (Postgres).

- While every snapshot is inside the window, a pass expires nothing; it flushes the 4,205 rows the catalog held into files (5 tables), merges 336 small files into 2 and deletes the 336 it replaced. That is what takes the files read now from 339 to 10. The 501 files still tracked are what the older snapshots of the window read.
- Once the week is older than 30 days, what stays is each asset's 5 newest versions, the state when the window began and the newest snapshot, and the lake is 28 snapshots.
- The Postgres catalog's size on disk does not fall with its rows (13.1 to 11.9 MB): the space is Postgres's to give back.

## A month and a half of hourly runs, a pass every 24 hours

45 days, 5,400 commits, full refresh in place. A pass costs, in milliseconds:

| lake | days 1 to 30 (nothing expires) | days 31 to 45 (each pass expires the oldest day) | snapshots held | files tracked / read now |
|---|---|---|---:|---|
| local | 217 to 424, median 313 | 481 to 678, median 493 | 3,699, flat from day 31 | 2,263 / 99 |
| postgres | 254 to 381, median 314 | 448 to 521, median 459 | 3,699, flat from day 31 | 2,263 / 99 |

From day 31 each pass expires 116 to 124 snapshots, the day that has left the window and the 3 the last pass made, and the lake stays at 3,699 snapshots: 30 days of hourly runs over five assets, 123 a day. A 30-day run of the same (3,600 commits) gave 0.22 to 0.42 s a pass (median 0.34 s local, 0.31 s Postgres) and the same 3,693 snapshots; with the full refresh written as the spike did (a new table each hour) the 30-day lake held 733 inlined-data tables and a 24.8 MB Postgres catalog (5.7 MB in SQLite), and a pass cost 0.33 to 0.56 s.

Reads of the last snapshot through a read-only handle during three passes on a lake of 3 days of runs: about 100 on each kind of lake, none failed (a probe, not a test).
