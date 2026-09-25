# PIN_ROUNDED: values would be rounded to fit a column's DECIMAL pin

A column is pinned to a DECIMAL (columns: { amount: "DECIMAL(18,2)" }) and some incoming values have more decimal
places than the pin keeps: 12.345 into DECIMAL(18,2) would be stored as 12.35. croft never rounds silently, so the
load stops. The message shows sample values and how many rows would change.

Nothing was written for the step, and its cursor did not move.

What to do: decide what the values are, then pick one:
- they really have more places: widen the pin's scale (DECIMAL(18,4)); lossless retypes of stored values are
  applied directly;
- rounding is intended (cents from a float API field): round the values yourself in rows() or map()
  (Math.round(x * 100) / 100, or a string with the exact digits), so the rounding is visible in code;
- the pin was a guess: remove it, and croft types the column from the values (croft docs ingest).
Then croft preview <asset> to see the stored values, and croft run <asset>.
