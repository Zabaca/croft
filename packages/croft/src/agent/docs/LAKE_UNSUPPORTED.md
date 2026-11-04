# LAKE_UNSUPPORTED: a lake cannot make this change in one write

The project keeps its warehouse in a lake (a `lake` block in croft.json; croft docs lake). The write asked for something
a lake cannot do inside one transaction: changing the type of a column of a table that the same write has already
changed. A lake makes most type changes by rewriting the table, and DuckLake cannot read a table back in a transaction
that changed it, so a second change to the table in that write is refused instead of failing in the middle. Nothing was
written, and the table is as it was.

What to do:
- Make one change at a time: run once with the pin or the new data that retypes the column, then run again with the
  other change. The message names the table and the columns.
- Nothing needs repairing and no data is at risk: the run that was refused wrote nothing.
