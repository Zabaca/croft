# UNSAFE_INTEGER: integers beyond 2^53 reached croft as JavaScript numbers (warning)

A JavaScript number holds integers exactly only up to ±2^53 (9,007,199,254,740,991). Larger ones, such as 64-bit
ids from Twitter-like APIs or big account numbers, lose their last digits when parsed into a number. croft saw
such values in a column (details.column, details.count, details.sample); their digits may already be wrong in
what rows() yielded.

The rows were written as they came. Values that lost digits cannot be recovered from the table.

What to do: keep the digits from the start, in rows():
- parse responses with ctx.http's res.json(): it is lossless and gives big integers as bigint;
- if the code uses fetch or JSON.parse, switch to ctx.http, or yield such fields as strings or bigint.
Then croft preview <asset> to check the values. Rows already stored with wrong digits come right when they are
fetched again: for a merge ingest, ask the user before a backfill (croft run <asset> --dry-run --from <when>
shows the window first).
