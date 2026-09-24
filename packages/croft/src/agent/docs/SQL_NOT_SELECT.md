# SQL_NOT_SELECT: an SQL asset whose body is not a SELECT

An SQL asset is exactly one SELECT; CTEs (WITH ...), subqueries and UNION are fine. croft creates the table,
writes it and records it, so the body never creates, inserts, updates, deletes, copies or attaches anything.
DESCRIBE, SUMMARIZE and SHOW are refused as well: they describe the catalog rather than build a table.

What to do:
- Keep only the SELECT that computes the table's rows; the table takes the file's name.
- To look at a table's columns or statistics, use croft describe <asset>, or croft query with DESCRIBE,
  SUMMARIZE or SHOW (croft query "summarize example_sales").
- To make rows with code, write a TypeScript transform (croft docs transforms) or an ingest (croft docs ingest).
