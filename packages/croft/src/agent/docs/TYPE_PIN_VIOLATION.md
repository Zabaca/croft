# TYPE_PIN_VIOLATION: values do not convert exactly to a column's pinned type

A column is pinned in the asset's columns (columns: { zip: "BIGINT" }, or { type: "DATE", format: "%d/%m/%Y" }),
and some incoming values do not cast to that type exactly: text that is not a number, a date in another format
than the pin's, a number with a fraction for an integer pin. A pin is a promise about the data, so croft stops
instead of storing a changed or empty value. The message gives sample values and how many rows are affected.

Nothing was written for the step, and its cursor did not move.

What to do: decide whether the pin or the data is wrong.
- The data: clean the values in rows() or map() before they reach croft (strip a currency sign, map "n/a" to
  null).
- The pin: change it to the type the values have, or give a date pin the format the source uses. A leading zero
  that matters (zip codes, account numbers) means the column is text: pin VARCHAR.
Then croft preview <asset>, and croft run <asset>. A pin change that would alter stored values asks for a
confirmation first (PIN_CHANGES_DATA): ask the user before you confirm it.
