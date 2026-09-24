# UNKNOWN_COLUMN: SQL names a column the table does not have

DuckDB could not find a column the SQL names: a typo, a column renamed upstream, or a column of another table.
It comes from croft validate's bind check of an SQL asset (at the line and column in the file), from a check
that names a missing column (on the check's header line), and from croft query. The closest of DuckDB's
candidate columns becomes the hint, and in an asset an edit fix:

    error UNKNOWN_COLUMN  assets/open_issues.sql:9:3
          Referenced column "creatd_at" not found in FROM clause.
          fix: replace creatd_at with created_at on line 9

What to do:
- Apply the fix, or correct the name. croft describe <table> lists a table's columns, and croft validate --json
  lists every SQL asset's output columns (data.assets[].outputColumns): what an asset reading it can use.
- A field inside a JSON column is not a column: read it with col->>'field' (croft describe lists the keys).
- An ingest whose incremental field is missing from every row also fails with UNKNOWN_COLUMN: correct the
  field name in incremental.
