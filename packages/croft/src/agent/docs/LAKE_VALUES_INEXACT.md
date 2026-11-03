# LAKE_VALUES_INEXACT: a lake would store the values of a column differently from the file

DuckLake 1.0 stores some types exactly only while a table is small. Once its rows are in a Parquet file (a few rows
stay in the catalog, which hides it) it changes them: a HUGEINT or UHUGEINT is stored as a DOUBLE, so a value past
2^53 comes back changed (9007199254740993 as 9007199254740992) and one near the top of the range cannot be read at
all; an INTERVAL keeps its milliseconds and loses the microseconds under them (1.000003 seconds as 1 second); a TIMETZ
comes back as the same time at offset 0 (10:11:12+02 as 08:11:12+00). croft move-to-lake looked at the values of every
column of those types in the file: details.columns lists each table and column with how many values would change and
one example. Nothing was changed.

What to do: change what makes each column so that the table stores a type a lake keeps exactly, in the asset's SELECT
or in the pin that sets its type, run the asset (a SQL asset is rebuilt at no cost), and run croft move-to-lake again.
- HUGEINT: `CAST(x AS DECIMAL(38,0)) AS x` holds any whole number of up to 38 digits exactly; otherwise `AS VARCHAR`.
- UHUGEINT: `CAST(x AS VARCHAR) AS x`.
- INTERVAL: `CAST(x AS VARCHAR) AS x`, or the length as a whole number of milliseconds.
- TIMETZ: `CAST(x AS VARCHAR) AS x`, or `CAST(x AS TIME) AS x` when the offset does not matter.
A column of those types nested inside a STRUCT, LIST or MAP is not looked at by value; the comparison after the copy
finds it (MOVE_NOT_EQUAL) and takes the copy out again.

croft does not check these columns when a run writes a lake; keep their values to ones that survive, or cast them.
