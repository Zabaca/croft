# AMBIGUOUS_DATE_FORMAT: dates that read both day-first and month-first (warning)

A new CSV column holds dates like 03/04/2026, where no day is above 12, so they read either way: March 4 or April 3.
croft chose one order from the project's time zone (month-first for zones in the Americas, day-first elsewhere)
and typed the column as DATE with that format. details: column, format, order, timezone.

The file was loaded with that order. If it is the wrong one, every date is wrong without any error.

What to do: ask the user which order the file uses, or find a value that settles it (a day above 12, or the source
system's documentation). If croft's choice is wrong, pin the format in the asset:
columns: { order_date: { type: "DATE", format: "%d/%m/%Y" } } (or "%m/%d/%Y"). The pin applies to the next load;
the dates already stored are retyped with it, which asks for a confirmation when stored values change
(PIN_CHANGES_DATA): ask the user first. Pinning before the first run avoids that; croft preview <asset> shows the
dates croft would store.
