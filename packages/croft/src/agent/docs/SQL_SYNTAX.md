# SQL_SYNTAX: DuckDB could not parse the SQL

The message is DuckDB's, with the line and column; in an SQL asset the line is counted in the file, header
included.

Frequent causes:
- A column named like a keyword (order, group, limit): quote it, "order". croft validate reports these as
  QUOTE_IDENTIFIER, with a fix.
- Quotes: single quotes make a string ('open'), double quotes a name ("Order ID").
- An unbalanced parenthesis, or a clause in the wrong place (WHERE after GROUP BY).
- A header line written without its `--` (description: ...), which then reads as SQL.

What to do: fix the SQL near the reported position, then croft validate --json. croft query "<sql>" tries a
SELECT on its own.
