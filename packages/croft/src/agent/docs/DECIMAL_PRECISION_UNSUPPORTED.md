# DECIMAL_PRECISION_UNSUPPORTED: a DECIMAL pin with more digits than a JavaScript number carries

A column is pinned to a DECIMAL with a precision above 15 (columns: { amount: "DECIMAL(38,10)" }), but its values
reach croft as JavaScript numbers: yielded from rows() as numbers, parsed from JSON as numbers, or returned from
map() as numbers. A JS number (a double) keeps only about 15 significant digits, so the digits the pin asks for are
already gone before croft sees the value. Storing it would look exact and not be, so the load stops and nothing is
written.

What to do: pick one, in the asset file the problem names.
- Keep every digit: hand croft the value as a string with all its digits, as the source wrote it (for example
  amount: String(row.amount_text), or the API's string field). croft casts the text to the pinned DECIMAL exactly.
  ctx.http's res.json() keeps big integers exact, but a decimal fraction still becomes a double.
- Or accept double precision: pin DECIMAL with a precision of 15 or less (DECIMAL(15,2)), or DOUBLE.

details.column, details.type and details.precision name the pin. Then croft validate --json, and
croft preview <asset> to see the stored values before a real run.
