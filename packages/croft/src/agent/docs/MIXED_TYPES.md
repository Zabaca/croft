# MIXED_TYPES: a new column's values mix kinds, so it was stored as text (warning)

croft types a new column from its values (croft docs ingest). When the values of one field mix kinds that no
single type holds exactly (numbers and words, dates and free text, true/false and numbers), croft stores the
column as VARCHAR rather than drop or change values. details.kinds lists what it saw.

Nothing was lost: every value is kept as text. But SQL that treats the column as a number or a date needs a cast,
and sums or comparisons on text give wrong answers.

What to do:
- Decide what the column is, then clean the odd values where they enter, in rows() or map() (turn "n/a" into null,
  parse "1,200" into 1200).
- Or pin the type in the asset: columns: { amount: "BIGINT" }. A pin applies to the next load; values that do not
  cast then stop the load (TYPE_PIN_VIOLATION) instead of being stored wrong.
- Before the first real run, croft preview <asset> shows the types croft would choose. For a column already
  stored as text, a pin that changes stored values asks for a confirmation (PIN_CHANGES_DATA): ask the user first.
