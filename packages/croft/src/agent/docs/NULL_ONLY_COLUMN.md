# NULL_ONLY_COLUMN: a column that has held only NULLs so far (warning)

A column that arrives with no values yet shows no type, so croft types it from its name and marks it pending:
closed_at or updatedAt as TIMESTAMPTZ, due_date as DATE, is_draft or hasLabels as BOOLEAN, anything else as
VARCHAR. The first real values settle the type later. It is reported in two places:

- A load: "column closed_at holds only NULLs so far; it is typed TIMESTAMPTZ from its name until values
  arrive".
- croft validate: an SQL asset does not bind while a column it reads is still NULL-only, because it uses the
  column as another type (sum(discount) over a VARCHAR placeholder). The fix pins the type in the input asset.

What to do:
- The name-based type is right: nothing; the column settles when values arrive.
- Otherwise pin the type in the asset that loads it: columns: { discount: "DOUBLE" }. The fix inserts the pin
  when croft knows the file. Or wait until the column has values.
