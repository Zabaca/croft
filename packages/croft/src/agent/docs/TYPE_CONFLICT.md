# TYPE_CONFLICT: incoming values do not fit a column's stored type

Every column has a type, decided from its first values or pinned in columns. A later batch brought values that do
not fit it and cannot be widened to fit: text such as "n/a" in a BIGINT column, "2026-13-45" in a DATE column, an
object in a DOUBLE column. croft does not coerce silently (a failed cast would become NULL, a lost value), so the
whole load rolls back.

details: column, existingType, incomingKinds, badRows, samples (a few offending rows), readBy (the assets that read
the column), and fixes (every fix, in order; fix is the first).

Nothing was written, the cursor did not move, and downstream assets keep their current data.

What to do: fix it in this order (croft docs ingest shows each).
1. Clean the value where it enters: in rows() or map(), turn the placeholder into null or a real value
   (amount: row.amount === "n/a" ? null : row.amount). This is right when the source sends junk now and then.
2. Pin the type with its format, when the values are valid but written differently (a date in 03/04/2026 form:
   columns: { day: { type: "DATE", format: "%m/%d/%Y" } }).
3. Pin VARCHAR, when the column really holds text now. SQL that reads it as a number then needs a cast; the
   assets in readBy may need an edit.
Then croft preview <asset> to see the result without writing, and croft run <asset>. A pin that changes stored
values (a lossy retype) asks for a confirmation (PIN_CHANGES_DATA): ask the user first.
