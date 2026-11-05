# LAKE_BOOKKEEPING_IN_FILES: croft's own bookkeeping is in files of the store, and every command reads them (warning)

In lake mode croft keeps its own records (`_croft`: what each asset holds, its columns, the files it read, what each
write did) in the lake's catalog, a few rows at a time, where one read is one round trip to the catalog. A lake may
have them in Parquet files of the bucket instead: DuckLake writes an insert of more rows than its inlining limit (10
by default) as a file, and the maintenance pass of an older croft flushed every table's rows out of the catalog,
`_croft` included. croft cannot tell from the lake which of them put the files there. The copy of a move and of a
restore are written in inserts that stay in the catalog (up to 1,000 rows a table), but a rename or a change that
touches more than 10 of a table's rows in one statement can still write a file. Each read of such a table costs the
store a listing and a range read or two (200 to 700 ms each on R2), on every command, for ever: a run with nothing new
took 9 s on a lake whose store was far away, and nothing said why. This warning is croft saying why. `details.tables`
names the tables, with how many files and bytes each has.

Nothing is wrong with the data: the rows are the same in a file or in the catalog. The warning goes when
`croft maintain` has brought the rows back.

What to do:
- Run `croft maintain`. Its first step (prune) copies each of these tables out, deletes the rows and
  inserts them again in inserts small enough to stay in the catalog (DuckLake's inlining limit, 10 rows by default),
  all in one transaction with the removal of the rows nothing reads. The pass's rewrite step then drops the files,
  whose rows are all deleted, and its cleanup step deletes them from the store. croft's own pass does this too, once a
  day (`lake.maintenance`), so the warning goes by itself within a day of using this croft.
- A table with more than 1,000 rows in files comes back 1,000 rows a pass (that is a hundred inserts or more), so a
  large one takes several passes; `croft maintain` says how many tables are still partly in files, and the warning
  stays until the last pass has moved the last rows.
- `croft doctor` shows the warning until no `_croft` table has a file, and `croft run` is quicker the moment it does.
- Never move these rows by hand, and never run DuckLake's own `ducklake_flush_inlined_data` on the `_croft` schema:
  that is what put them in files.
