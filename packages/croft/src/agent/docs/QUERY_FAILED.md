# QUERY_FAILED: DuckDB could not bind or run a query

The SQL parsed and passed croft's checks, but DuckDB failed while binding or running it: a type that does not
convert (Conversion Error), a function called with the wrong arguments (Binder Error), a value out of range,
text that is not valid JSON read as JSON, and the like. details.duckdb is DuckDB's
message and details.duckdbErrorType its kind. A missing table or column is UNKNOWN_TABLE or UNKNOWN_COLUMN, and
SQL that does not parse is SQL_SYNTAX.

It comes from croft query, from the read server and @zabaca/croft/read, and from ctx.query in asset code, where
it also covers a query run before the asset's table exists (its first load) or after its step ended. A preview that
built an asset but could not compare it with the live table reports it as a warning.

Nothing was written.

What to do: fix the SQL. DuckDB's message names what failed, though not always why. Look at the columns and their
types first: croft describe <asset> shows them, and croft query "DESCRIBE <asset>" too. Cast explicitly
(TRY_CAST(x AS BIGINT) gives NULL instead of failing). In asset code, handle the first run, when there is nothing
saved to read yet, and await every ctx.query inside rows().

"Failed to cast value" quoting a whole JSON value ({...} or [...]), or json_extract called with a BOOLEAN, is
usually not about the data: DuckDB's -> takes everything to its left as the JSON it reads, and what follows up to a
comparison as the path, binding more loosely than AND, OR, NOT, = and ||. `j->'k' = 2` runs as `j->('k' = 2)`, and
`a AND j->'k'` as `(a AND j)->'k'`. Put it in parentheses, `(j->'k') = 2`, or write json_extract(j, 'k'); the hint
says so when the message has that shape (croft docs sql). ->> compares as written.

A lambda written with an arrow (x -> x + 1) is LAMBDA_ARROW, not this code: DuckDB 2.0 reads lambda x: x + 1.
