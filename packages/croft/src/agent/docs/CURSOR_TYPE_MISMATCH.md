# CURSOR_TYPE_MISMATCH: an incremental cursor whose settings do not fit its column's type

An API ingest's cursor (incremental: { field, unit, lookback }) is typed by its column: a timestamp, a date, an
integer, or text. Some settings only make sense for some types, and croft checks them when the asset loads and
before each run:
- a lookback on an integer cursor needs unit: "s" or "ms", so croft knows the integers are epoch time;
- a text cursor has no lookback: "30 days" cannot be subtracted from a string;
- unit is only for integer cursors;
- the field's column must be a timestamp, a date, an integer or text (not JSON, a boolean or a double);
- the column's stored type no longer matches the saved cursor (it was retyped, or pinned to another type).

The run does not start for that asset, and its cursor does not move.

What to do: follow the hint in the asset file: add or remove unit, remove lookback, pin the column to TIMESTAMPTZ
or BIGINT, or choose another field. Then croft validate --json, and croft run <asset> --dry-run to see the window
the next run would fetch.

When the saved cursor itself cannot be read with the column's new type, the hint also names a refetch from
scratch, croft run <asset> --rebuild. It trashes the table first and asks for a confirmation: ask the user
before you run it, and never run croft confirm without their explicit yes.
