# Where a command on a lake spends its start, and what a stamp on the format took out of a query (D199)

`packages/croft/scripts/bench-lake-latency.ts`, run on 2026-11-05 on macOS arm64 (bun 1.3.14, DuckDB 2.0.0, a Postgres 17 and an S3-compatible store started by the test rig, all on this machine), as in `2026-11-03-lake-latency.md`: the same project, the same proxy that holds every chunk back half of the round trip in each direction, the same counting of catalog round trips at the proxy. Each cell is the median of 3 runs of the real CLI. "Before" is main at 7e59c08; "after" is this branch.

| round trip to the catalog | command | before, s | after, s | before, catalog round trips | after, catalog round trips |
|---:|---|---:|---:|---:|---:|
| 0 ms | first run (4 assets built) | 1.3 | 1.2 | 690 | 697 |
| 0 ms | run, nothing new | 0.6 | 0.5 | 106 | 98 |
| 0 ms | run, one file changed (an ingest and the SQL asset over it) | 1.0 | 1.0 | 488 | 491 |
| 0 ms | query (count of a table) | 0.4 | 0.4 | 76 | 53 |
| 0 ms | status | 0.3 | 0.3 | 0 | 0 |
| 0 ms | describe (one table) | 0.5 | 0.5 | 130 | 122 |
| 0 ms | doctor | 0.7 | 0.7 | 100 | 96 |
| 0 ms | maintain | 0.8 | 0.7 | 590 | 582 |
| 40 ms | first run (4 assets built) | 31.4 | 31.5 | 683 | 682 |
| 40 ms | run, nothing new | 4.7 | 4.3 | 94 | 109 |
| 40 ms | run, one file changed (an ingest and the SQL asset over it) | 21.8 | 21.6 | 475 | 477 |
| 40 ms | query (count of a table) | 3.8 | 2.7 | 76 | 53 |
| 40 ms | status | 0.4 | 0.3 | 0 | 0 |
| 40 ms | describe (one table) | 5.6 | 5.8 | 115 | 122 |
| 40 ms | doctor | 5.2 | 4.9 | 100 | 96 |
| 40 ms | maintain | 26.7 | 26.2 | 590 | 582 |

Only the query moved: the other commands read croft's own tables whatever the format check does, so they pay the same loads at their first read of them. The run's and describe's counts differ by a few round trips from run to run because their leases overlap (two leases that start together both load the catalog; one that starts after another finds it loaded). 0.3 s of a command at 0 ms is the process itself; a lake adds about 0.1 s of attach and load there, and what a person feels at a distance is the round trips below.

Where a `croft query` on this project spent its 76 round trips at 40 ms, read from a statement-by-statement trace (a preload that timed every call to DuckDB, and the proxy's count for the pieces):

| step | round trips | seconds | whose |
|---|---:|---:|---|
| `LOAD` of httpfs, postgres and ducklake; the two temporary secrets | 0 | 0.04 | local |
| `ATTACH` | 17 | 0.8 | the `postgres` extension: the connection with a SCRAM login (4), the version and the schema of the metadata database, `SELECT 1` and `DISCARD ALL` around each use of a pooled connection (8 of the 17), DuckLake's own version and metadata reads |
| `USE lake` (the first statement of a transaction) | 20 | 0.9 | DuckLake loads the whole catalog: snapshot, schemas, tables, columns, views, macros, partitions, sorts |
| the format check, reading `_croft.meta` | 28 | 1.1 | 6 for the table and 22 because its inlined rows are of an older schema version than the lake's now, which DuckLake reads by loading the catalog at that version |
| the query | 8 | 0.3 | the table's stats, files, check for inlined deletes, schema versions |
| `ROLLBACK` | 2 | 0.1 | the pool's `SELECT 1` and `DISCARD ALL` |

A second connection of the same process then pays 4 round trips for `USE lake` and 3 for a table: DuckLake keeps what it loaded, so the first look is what is dear. Reading the stamp, a comment on `_croft.meta`, is in the catalog `USE lake` loaded and costs none (D199). With the pool's health check off (`pg_pool_health_check_query = ''`) the attach is 12 round trips and `USE lake` 19, but `db/lake-warehouse.test.ts` "a catalog connection that was ended between leases reconnects by itself" and "a Postgres that restarts between leases is reached again by the next one" fail, so it was not kept. `pg_query_mode` and the other settings of the `postgres` extension do not touch DuckLake's metadata queries (checked: the same counts).
