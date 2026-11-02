# LAKE_TYPE_UNSUPPORTED: a column's type cannot be stored in a lake

A lake (croft docs lake) is a DuckLake, and DuckLake stores neither an ENUM, a UNION nor a VARINT column, also not
inside a STRUCT, a LIST or a MAP. The result of the asset has one, so croft stopped before it wrote anything:
details.columns lists each column with its type, and details.kind the first kind found. A file warehouse stores these
types; only a project with a `lake` block refuses them.

Nothing was written, no row, no table and no bookkeeping.

What to do: cast the column in the SELECT, or in the code that makes it, to a type a lake stores.
- ENUM: `CAST(status AS VARCHAR) AS status`.
- UNION: `CAST(value AS VARCHAR) AS value`, or `to_json(value) AS value` to keep its structure as JSON.
- VARINT: `CAST(big AS HUGEINT) AS big`, or `AS VARCHAR` when it can be larger than a HUGEINT holds.
- Inside a STRUCT, LIST or MAP, cast the inner value, or turn the whole column into JSON with `to_json(col)`.

Then run the asset again. `croft validate` does not know the types a SELECT will make until it is bound; the first run
tells.
