# OUT_OF_BAND_CHANGE: a table was changed by something other than croft (warning)

At every commit croft records each table's row count and newest _loaded_at. Before it next writes the table, and in
croft doctor, it compares them with the table. When they differ, something else wrote it: a GUI holding
warehouse.duckdb read-write, a notebook, or a script with its own DuckDB connection.

What croft does: it keeps the table as it is now and continues from it. It records the new numbers, so the change
is reported once, and marks the table replaced, so the assets that read it are rebuilt on their next run (croft
status shows them stale).

What to do:
- Tell the user what changed: details.expected and details.actual give the rows and newest _loaded_at croft left
  and what the table has now.
- Find the program that wrote it. A GUI should open warehouse.read.duckdb, never warehouse.duckdb ("readCopy":
  true in croft.json; croft docs read-copy), and apps read through @zabaca/croft/read.
- If the change was a mistake: ask the user first. croft restore <asset> brings back a version croft trashed
  earlier, when there is one (croft restore lists them); an ingest can be fetched again from scratch with
  croft run <asset> --rebuild, which asks for a confirmation.
- An edit that keeps the row count and the newest _loaded_at is not seen this way: croft preview <asset> --rebuild
  compares the table with a build from scratch.

A change to the table's columns is TABLE_MODIFIED_OUTSIDE_CROFT.
