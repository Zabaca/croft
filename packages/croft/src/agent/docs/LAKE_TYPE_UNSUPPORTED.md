# LAKE_TYPE_UNSUPPORTED: a column's type cannot be stored in a lake

A lake (croft docs lake) is a DuckLake, and DuckLake stores no ENUM, UNION, VARINT, BIT or fixed-size ARRAY
(`INTEGER[3]`; a list, `INTEGER[]`, is fine) column, also not inside a STRUCT, a LIST or a MAP. The result of the
asset has one, so croft stopped before it wrote anything: details.columns lists each column with its type, and
details.kind the first kind found. A file warehouse stores these types; only a project with a `lake` block refuses
them.

Nothing was written, no row, no table and no bookkeeping.

`croft move-to-lake` finds these in the tables of a file warehouse before it starts (details.tables names each table
and its columns), and changes nothing until they are fixed.

What to do: cast the column in the SELECT, or in the code that makes it, to a type a lake stores.
- ENUM: `CAST(status AS VARCHAR) AS status`.
- UNION: `CAST(value AS VARCHAR) AS value`, or `to_json(value) AS value` to keep its structure as JSON.
- VARINT: `CAST(big AS HUGEINT) AS big`, or `AS VARCHAR` when it can be larger than a HUGEINT holds.
- BIT: `CAST(flags AS VARCHAR) AS flags` (the bits as text).
- A fixed-size ARRAY: `CAST(pair AS DOUBLE[]) AS pair`, the same element type as a list.
- Inside a STRUCT, LIST or MAP, cast the inner value, or turn the whole column into JSON with `to_json(col)`.

Then run the asset again. `croft validate` does not know the types a SELECT will make until it is bound; the first run
tells.
