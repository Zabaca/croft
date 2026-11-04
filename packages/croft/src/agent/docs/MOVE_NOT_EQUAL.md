# MOVE_NOT_EQUAL: the lake did not equal the file after the copy, so the project was not switched

After copying a file warehouse into a lake, `croft move-to-lake` reads the lake with the read-only login and compares
it with the backup of the file it copied: every table's columns, types, row count and rows, and every `_croft` table.
Something differed (details.differences, and details.columns for the columns that came back different), so the project
was not switched. It still keeps its warehouse in the file, which was not touched, and the copy was taken out of the
lake again (details.undone; when it is false the lake still holds the copy and says so in the hint).

The cause is almost always a type DuckLake 1.0 changes on the way in (croft docs LAKE_VALUES_INEXACT): HUGEINT and
UHUGEINT stored as DOUBLE, an INTERVAL kept to the millisecond, a TIMETZ moved to offset 0, also inside a STRUCT, a
LIST or a MAP. The move refuses such columns by their type before it starts, so this comparison is the second line: it
would catch a type the first missed, or a difference of another kind.

What to do:
- Cast each column the message names to a type a lake keeps exactly, in the asset's SELECT (HUGEINT to DECIMAL(38,0),
  the others to VARCHAR), run the asset, and run croft move-to-lake again.
- Any other difference is croft's bug: report it with details.differences. The file and the project are safe.
