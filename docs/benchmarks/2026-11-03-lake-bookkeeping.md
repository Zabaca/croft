# What the first maintenance pass did to croft's own speed against a distant store (D162)

`packages/croft/scripts/bench-lake-bookkeeping.ts`, run on 2026-11-03 on macOS arm64 (bun 1.3.14, DuckDB 2.0.0, a Postgres 17 and an S3-compatible store started by the test rig, all on this machine). The project is a file ingest (120 rows) and a SQL asset over it; it has had three runs, the second with a changed file, as a project in use would. The measured run is `croft run --foreground` with nothing new to do (the file is unchanged, so every step is read, compared and skipped), the real CLI in a process of its own; each cell is the median of 3.

The store is behind a TCP proxy that holds every chunk back half of the round trip in each direction. It is a simulation of distance, not a measurement of R2: it keeps the order of the bytes and nothing else (no loss, no jitter, no bandwidth limit), and a new connection costs one round trip, not the several of a TLS handshake. The catalog is not delayed (the trial's was a few milliseconds away). "Store requests" are HTTP requests counted at the proxy.

The first real-lake trial (2026-11-02, R2) saw a run with nothing new go from 3.8 s before the first pass to 8.7 to 9.1 s after it, because the pass's flush moved croft's own bookkeeping (`_croft`, a few rows at a time, kept inside the catalog) into tiny Parquet files, and each read of it then cost 2 to 3 requests of 200 to 700 ms instead of 50 to 90 ms. "Flushes every schema" is the flush as it was, reproduced with DuckLake's own call; "assets only" is `croft maintain` as it is now (`schema_name => 'main'`).

| round trip to the store | state | run with nothing new, s | store requests in it |
|---:|---|---:|---:|
| 0 ms | before any pass | 0.5 | 0 |
| 0 ms | after a pass that flushes every schema (until D162) | 0.6 | 6 |
| 0 ms | after croft's pass (assets only) | 0.6 | 0 |
| 100 ms | before any pass | 0.6 | 0 |
| 100 ms | after a pass that flushes every schema (until D162) | 1.1 | 6 |
| 100 ms | after croft's pass (assets only) | 0.5 | 0 |
| 250 ms | before any pass | 0.5 | 0 |
| 250 ms | after a pass that flushes every schema (until D162) | 2.1 | 6 |
| 250 ms | after croft's pass (assets only) | 0.6 | 0 |

What it shows:

- Flushing every schema adds 6 requests to a run with nothing new (one `_croft` table each), which costs 0.5 s at a 100 ms round trip and 1.6 s at 250 ms. The trial's project had more bookkeeping (6 assets, 25 writes), and a read of a Parquet file takes more than one request, which is how it reached 5 s.
- With the assets' schema alone flushed, the run is the same before and after the pass, at every distance, and makes no request of the store at all: everything it reads is in the catalog.
- A lake that a pass of the old kind has already flushed keeps its `_croft` files; they are read as before. A new lake (or one that has not had a pass) never gets them.
