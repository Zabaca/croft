# QUOTE_IDENTIFIER: a column named like an SQL keyword

A column called order, group, limit, from or another SQL keyword cannot be written bare: the parser reads the
keyword, and the SQL fails with a syntax error. croft validate finds the words that need quotes, and the fix
adds them.

    SELECT id, order FROM shop_orders          -- a syntax error
    SELECT id, "order" FROM shop_orders        -- works

What to do: apply the fix, or put double quotes around the name wherever it names the column, in the SELECT and
in checks: "order". Single quotes make a string, not a name.
