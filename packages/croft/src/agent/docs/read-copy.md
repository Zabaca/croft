# The read copy: warehouse.read.duckdb for GUIs and notebooks

A program that keeps warehouse.duckdb open (the DuckDB UI, DBeaver, a notebook) blocks every croft run:
DB_HELD_BY_OTHER_PROGRAM. Apps read with @zabaca/croft/read (croft docs serve); tools that need a file get the
read copy.

Turn it on in croft.json:

  "readCopy": true

After every run that wrote data, croft refreshes warehouse.read.duckdb next to the database: it checkpoints the
warehouse, clones it (a copy-on-write clone on macOS and on Linux filesystems that support one, else a full
copy) and renames the clone over the old copy in one step. The first copy appears after the next run that
writes (croft run <asset>).

- Open warehouse.read.duckdb in the GUI, never warehouse.duckdb. A GUI holding the copy never blocks a run.
- A GUI keeps seeing the copy it opened; reopen it (or reconnect) to see the newest data.
- The copy is replaced at every refresh: anything written into it is lost, so treat it as read-only.
- A relocated project (a synced folder) keeps the copy next to its database, at the path croft.json's database
  names with .read.duckdb.
- croft serve answers from it while a run writes, marked stale: true with asOf, the time of the copy.
- A refresh that fails never fails the run: the reason is in .croft/readcopy.log, and the copy keeps its older
  data until the next run refreshes it.
