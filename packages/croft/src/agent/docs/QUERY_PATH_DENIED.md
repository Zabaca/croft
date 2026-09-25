# QUERY_PATH_DENIED: SQL tried to read a file or folder croft does not open for it

croft runs every SQL it is given in a sandbox. Where SQL may read files:
- croft query: only files under the project's files/ folder, named by a quoted path (read_csv('files/orders.csv')).
  A path built at run time (a column, a concatenation, a parameter) is refused, because croft checks each path
  before DuckDB opens it.
- croft serve and @zabaca/croft/read: tables only; no file at all.
- ctx.query in asset code: the tables it may read, never a file. SQL assets and checks never read files either
  (SQL_READS_FILES, CHECK_INVALID).
The warehouse file, the preview database, .croft/ (runs.sqlite, serve.json) and .env are never readable from SQL.

Nothing ran and nothing was written.

What to do:
- To look at a file once: put it under files/ and name it with a quoted path in croft query.
- To keep its data: load it with a file ingest (croft docs ingest shows file: "files/sales/*.csv"), then query the
  table. An app should query tables, not files.
- Never copy .env or croft's own state into files/ to get around this.
