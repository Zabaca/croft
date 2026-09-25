# DUPLICATE_ROWS_ACROSS_FILES: identical rows came from different files, and the asset has no key (warning)

A file ingest without a key stores every row of every file. croft found rows in the files it loaded that are
identical to rows of other files (in the same load, or already in the table): overlapping exports, a daily file
that repeats yesterday's rows, the same file saved twice under two names. Without a key, each copy is a row of its
own, so counts and sums double. details: rows, files (examples), inBatch, againstTable.

The rows were written.

What to do: add a key to the asset (key: "order_id", the column or columns that identify a row), so a repeated row
replaces its earlier copy. Adding a key to an ingest with data changes how it writes: croft run says what it would
do to the stored rows first, and asks for a confirmation before it removes any (croft docs INGEST_CONFIG_CHANGED):
ask the user before you confirm it. If the files have no column that identifies a row, ask the user whether the
repeats are real, and narrow the file glob if some files should not be loaded.
