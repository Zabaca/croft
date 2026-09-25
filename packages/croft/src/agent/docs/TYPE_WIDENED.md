# TYPE_WIDENED: a column's type was widened to fit new values (warning)

A later batch brought values that the column's type could not hold but a wider type can, with every stored value
kept exactly: BIGINT to DOUBLE when a fraction arrives, BIGINT to HUGEINT when an integer beyond 64 bits arrives,
DATE to TIMESTAMPTZ (or TIMESTAMP) when a time arrives (stored dates then read as midnight in the project time
zone). croft widened the column in the same write and warns once. A pin that retypes a column losslessly reports
the same code. details: column, from, to.

The write succeeded. croft status and croft context show it among the asset's drift warnings for 7 days.

What to do: check the SQL and code that read the column (croft describe <asset> lists readBy): a comparison with
the old type still works, but integer division, date arithmetic or a JSON consumer can behave differently.
If the column must keep its type, pin it in the asset's columns: values that do not fit then stop the load
(TYPE_CONFLICT) instead of widening it.
