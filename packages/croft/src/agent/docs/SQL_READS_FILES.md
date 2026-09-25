# SQL_READS_FILES: an SQL asset reads a file directly

FROM 'files/sales.csv', read_csv(...), read_parquet(...) and the like read the file again on every rebuild,
but croft cannot tell when the file changed, so the table would go stale without anyone noticing. Files come in
through file ingests, which load new and changed files and record what they loaded.

What to do:
1. Make a file ingest for it: croft new file sales writes assets/sales.ts, reading "files/sales/*.csv"; point
   its file: at the file (file: "files/sales.csv"), or put the files in files/sales/.
2. Run it: croft run sales.
3. Read its table by name in the SQL asset: FROM sales. When an asset is already named like the file, the fix
   points at that table.

croft query can read files directly, which is the quick way to look at one before making the ingest:
croft query "from 'files/sales.csv' limit 5".
