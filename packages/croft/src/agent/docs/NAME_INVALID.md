# NAME_INVALID: a file name in assets/ that cannot be a table name

An asset's name is its file name without .ts or .sql, and that name is its table's name in SQL. So it must be
lowercase letters, digits and _, starting with a letter: assets/daily_revenue.sql is fine; Daily-Revenue.sql,
2024_orders.ts and orders.test.ts are not. croft suggests a cleaned-up name in details.suggestion.

A file with a dot in its name is often a test or a helper. Every file in assets/ becomes a table, so shared code
and tests belong in lib/ (asset code imports them from there).

The file is not loaded as an asset; nothing else changes.

What to do:
- A file that was never run: rename it to the suggested name (git mv, or your editor), then croft validate --json.
  Update the SQL or inputs of any asset that reads it by its old name.
- A file whose asset has a table already: croft rename <old> <new> moves the file, the table and croft's state
  together, and lists the references to update.
- croft new and croft rename refuse such a name up front, with the same suggestion.
