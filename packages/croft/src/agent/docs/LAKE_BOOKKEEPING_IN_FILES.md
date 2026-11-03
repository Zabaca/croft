# LAKE_BOOKKEEPING_IN_FILES: croft's own bookkeeping is in files of the store, and every command reads them (warning)

In lake mode croft keeps its own records (`_croft`: what each asset holds, its columns, the files it read, what each
write did) in the lake's catalog, a few rows at a time, where one read is one round trip to the catalog. A lake that
an older croft maintained may have them in Parquet files of the bucket instead: that croft's maintenance pass moved
every table's rows out of the catalog, `_croft` included, and one large insert can do the same. Each read of such a
table then costs the store a listing and a range read or two (200 to 700 ms each on R2), on every command, for ever:
a run with nothing new took 9 s on a lake whose store was far away, and nothing said why. This warning is croft saying
why. `details.tables` names the tables, with how many files and bytes each has.

Nothing is wrong with the data: the rows are the same in a file or in the catalog, and a new lake never has this.

What to do:
- Run `croft maintain`. Its first step (prune) copies each of these tables out, deletes the rows and
  inserts them again in inserts small enough to stay in the catalog (DuckLake's inlining limit, 10 rows by default),
  all in one transaction with the removal of the rows nothing reads. The pass's rewrite step then drops the files,
  whose rows are all deleted, and its cleanup step deletes them from the store. croft's own pass does this too, once a
  day (`lake.maintenance`), so the warning goes by itself within a day of using this croft.
- A table of more than 1,000 rows is left as it is, and `croft maintain` says so: that is a hundred inserts or more.
  Its reads stay slow; the way out is to have less recorded in it (the files an ingest read, say).
- `croft doctor` shows the warning until no `_croft` table has a file, and `croft run` is quicker the moment it does.
- Never move these rows by hand, and never run DuckLake's own `ducklake_flush_inlined_data` on the `_croft` schema:
  that is what put them in files.
