# LAKE_VALUES_INEXACT: a lake would store a column's values differently from the ones written

DuckLake 1.0 stores some types exactly only while a table is small. Once its rows are in a Parquet file (a few rows stay
in the catalog, which hides it, and the lake's maintenance then moves them into files) it changes them: a HUGEINT or
UHUGEINT is stored as a DOUBLE, so a value past 2^53 comes back changed (9007199254740993 as 9007199254740992) and one
near the top of the range cannot be read at all; an INTERVAL keeps its milliseconds and loses the microseconds under
them (1.000003 seconds as 1 second); a TIMETZ comes back as the same time at offset 0 (10:11:12+02 as 08:11:12+00). The
same holds inside a STRUCT, a LIST or a MAP.

So croft refuses a column of those types by its type, whatever its values are, because where its rows are kept changes
under a table: either when a run would write the lake (the asset's result has such a column), or before croft
move-to-lake starts (the file has one). details.columns lists each column with its type and the cast that fixes it.
Nothing was written, and the file and the lake are as they were.

What to do: store the column in a type a lake keeps exactly, in the asset's SELECT or in the pin that sets its type, run
the asset (a SQL asset is rebuilt at no cost), and run the command again.
- HUGEINT: `CAST(x AS DECIMAL(38,0)) AS x` holds any whole number of up to 38 digits exactly; otherwise `AS VARCHAR`.
  A SQL or TypeScript transform that returns a HUGEINT column (`sum()` of integers does) does not need this: croft
  stores it as DECIMAL(38,0) itself, and refuses only when a value has more than 38 digits.
- UHUGEINT: `CAST(x AS VARCHAR) AS x`.
- INTERVAL: `CAST(x AS VARCHAR) AS x`, or the length as a whole number of milliseconds.
- TIMETZ: `CAST(x AS VARCHAR) AS x`, or `CAST(x AS TIME) AS x` when the offset does not matter.
- Inside a STRUCT, LIST or MAP: cast the inner value, or turn the whole column into JSON with `to_json(x) AS x`.
- A pin to HUGEINT (`columns: { x: "HUGEINT" }`): pin it to DECIMAL(38,0) instead.

You do not need this for integers past 64 bits that arrive from an API, a CSV file or a Parquet file, or for a HUGEINT
that a SQL or TypeScript transform returns: in a lake croft stores them as DECIMAL(38,0) by itself, with every digit.
A table restored from the trash of the file's days that has such a column is refused the same way, before anything is
replaced; restore it on the file before the move.

When croft move-to-lake reports it, details.columns also says how many of the file's values would change now (none, for
a column whose values happen to be exact: it is refused anyway, because a later write would be).
