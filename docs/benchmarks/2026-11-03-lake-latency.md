# What a catalog far away cost croft's commands, and what a transaction for each read did to it (D176)

`packages/croft/scripts/bench-lake-latency.ts`, run on 2026-11-03 on macOS arm64 (bun 1.3.14, DuckDB 2.0.0, a Postgres 17 and an S3-compatible store started by the test rig, all on this machine). The project is the shape of the second real-lake trial's: two file ingests (200 and 120 rows) and a SQL asset over each. It has had three runs, one with a changed file, as a project in use would. Each cell is the median of 3 runs of the real CLI in a process of its own, as written to the table by the script.

The catalog is behind a TCP proxy that holds every chunk back half of the round trip in each direction (`src/db/delay-proxy-testkit.ts`); the store is not delayed (croft's bookkeeping is in the catalog, and the trial's slowness was the catalog's: 41 ms away, about 450 ms for a statement, a run with nothing new 27 s on 6 assets). It is a simulation of distance, not a measurement of a hosted catalog: it keeps the order of the bytes and nothing else (no loss, no jitter, no bandwidth limit), and a new connection costs one round trip, not the several of a TLS handshake. "Catalog round trips" are counted at the proxy, each time the client sends after the server has answered; they include the round trips of the connection's own start-up, which the commands share. "Before" is main at d578b41 (the first real-lake trial's fixes); "after" is this branch.

| round trip to the catalog | command | before, s | after, s | before, catalog round trips | after, catalog round trips |
|---:|---|---:|---:|---:|---:|
| 0 ms | first run (4 assets built) | 2.2 | 1.2 | 803 | 683 |
| 0 ms | run, nothing new | 0.6 | 0.5 | 519 | 107 |
| 0 ms | run, one file changed (an ingest and the SQL asset over it) | 0.9 | 1.0 | 895 | 485 |
| 0 ms | query (count of a table) | 0.4 | 0.4 | 164 | 76 |
| 0 ms | status | 0.3 | 0.3 | 0 | 0 |
| 0 ms | describe (one table) | 0.5 | 0.5 | 291 | 130 |
| 0 ms | doctor | 0.9 | 0.7 | 767 | 100 |
| 0 ms | maintain | 0.7 | 0.7 | 738 | 590 |
| 40 ms | first run (4 assets built) | 35.3 | 30.9 | 774 | 675 |
| 40 ms | run, nothing new | 18.3 | 4.6 | 407 | 94 |
| 40 ms | run, one file changed (an ingest and the SQL asset over it) | 35.7 | 21.5 | 784 | 470 |
| 40 ms | query (count of a table) | 7.7 | 3.7 | 164 | 76 |
| 40 ms | status | 0.3 | 0.3 | 0 | 0 |
| 40 ms | describe (one table) | 13.4 | 5.6 | 291 | 115 |
| 40 ms | doctor | 24.0 | 5.1 | 522 | 100 |
| 40 ms | maintain | 33.3 | 26.8 | 738 | 590 |

What it shows:

- With no distance nothing changes that a person would notice (0.3 to 2.2 s before, 0.3 to 1.2 s after). The cost at a distance is the distance multiplied by round trips, and the round trips were the problem: they fall in every command that reads the lake.
- A statement outside a transaction on a lake is 3 to 5 transactions of the catalog and 20 to 26 round trips for a read of one table (100 for five reads of it, measured with the same proxy at 20 ms each way), because each use of a pooled Postgres connection by the `postgres` extension is `SELECT 1`, `DISCARD ALL`, `SELECT 1` around a `BEGIN`, a snapshot lookup and the table's own reads. Inside a transaction the first read costs the same and each one after it 4 round trips (the table's files, the check for inlined deletes, the schema versions and the inlined rows). croft's reads were 11 statements for each ingest of a run with nothing new, one after another, so a read lease being one transaction is most of what the table shows; the ingest reading its state once, and not counting a table that is as its code says, is the rest of the run with nothing new (about 5.5 s with the transaction alone, 4.6 s with both).
- `croft doctor` fell from 24.0 to 5.1 s because it compares no table on a lake unless `--tables` is given (4 s of the 24.0 s: the comparison D166 had given 8 s to, which still compared 1 table of 4), reads the lake's counts in the one lease, and no longer asks the database about its encryption.
- What does not fall. A command costs at least 2.7 s at this distance whatever croft does: ATTACH 0.8 s, the first `USE lake` 0.9 s (DuckLake loads the catalog), and the first read of croft's own inlined tables 1.1 s (DuckLake reads them at the older schema version they were made in, which loads the catalog a second time). That is why `croft query` takes 3.7 s and not the 2 s asked for; skipping the format check of D144 for a query that never names `_croft` would make it 2.6 s, and was not done. A step that writes (the run with one file changed, the first run) takes about 7 s at this distance: a commit is 15 round trips, every scan of a table in the transaction at least 4, and a write reads about thirty of them, which this change does not touch. `croft maintain` is mostly DuckLake's own calls (a `CALL ducklake_*` takes 1.5 to 4 s, most of it in the prepare); the lake-exists probe and the prune were shortened.
- `pg_pool_health_check_query = ''` was tried: one `SELECT 1` of the three around each use of a pooled connection goes, 26 round trips for a read of one table become 22. It was not kept: a connection that died in the pool is then found by the statement that uses it, and a Postgres that restarted could take several in turn. `pg_pool_enable_thread_local_cache` made no difference.

## Bookkeeping an older pass moved into files, before and after `croft maintain` (D179)

`packages/croft/scripts/bench-lake-bookkeeping.ts` (D162's benchmark, with a fourth state), the same day and machine. The project is a file ingest and a SQL asset over it; the measured run is `croft run --foreground` with nothing new, the median of 3, with the *store* behind the proxy (the catalog is not delayed) and "store requests" counted at the proxy. "After a pass that flushes every schema" is what croft's pass did until D162, reproduced with DuckLake's own call; the last row is that lake after one `croft maintain` of this branch.

| round trip to the store | state | run with nothing new, s | store requests in it |
|---:|---|---:|---:|
| 0 ms | before any pass | 0.5 | 0 |
| 0 ms | after a pass that flushes every schema (until D162) | 0.5 | 6 |
| 0 ms | after croft's pass (assets only) | 0.5 | 0 |
| 0 ms | after that flush, then croft maintain (D179) | 0.5 | 0 |
| 100 ms | before any pass | 0.5 | 0 |
| 100 ms | after a pass that flushes every schema (until D162) | 1.2 | 6 |
| 100 ms | after croft's pass (assets only) | 0.5 | 0 |
| 100 ms | after that flush, then croft maintain (D179) | 0.5 | 0 |

A lake that an older croft maintained makes 6 requests of the store in a run with nothing new, 0.7 s at a 100 ms store and seconds at a far one (the trial's 9 s: R2, a continent away, a read of a Parquet file being more than one request). One `croft maintain` takes the rows back into the catalog and the next reads make none.
