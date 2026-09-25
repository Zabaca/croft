# MIXED_DATE_FORMATS: a column mixes day-first and month-first dates, so it was stored as text (warning)

A new CSV column holds dates in both orders (13/04/2026 and 04/13/2026 in one file), or with different separators
(2026-04-13 and 13.04.2026). No single format reads them all, so croft stores the column as VARCHAR rather than
read half of them wrong. details: column, separators.

Every value is kept as text. SQL that needs dates must parse them.

What to do: find out where the mix comes from (two exports from systems with different settings, hand-typed
rows), then either
- normalize them in map(), for example by the file each row came from (row._file), into ISO dates (2026-04-13); or
- pin the format that most rows use: columns: { order_date: { type: "DATE", format: "%d/%m/%Y" } }; rows in the
  other format then stop the load (TYPE_PIN_VIOLATION) instead of being stored wrong, so clean those in map() too.
croft preview <asset> shows the result before a real run.
