# TABLE_MODIFIED_OUTSIDE_CROFT: a table's columns were changed by something other than croft (warning)

croft records the columns and types of every table it writes. Before the next write it compares them with the
table, and warns when they differ: a column was added, dropped or retyped by another program (a GUI, a notebook, a
script with its own DuckDB connection, an ALTER TABLE by hand). details lists the added, dropped and retyped
columns.

croft continues with the table as it is now and tracks the columns it finds; the write went ahead. A change to the
rows rather than the columns is OUT_OF_BAND_CHANGE.

What to do:
- Tell the user what changed outside croft, and find the program that did it. Tables change through their assets:
  pin a type in the asset's columns, or rename a field in rows(), instead of altering the table.
- GUIs should open the read copy (croft docs read-copy), and apps read through @zabaca/croft/read.
- croft describe <asset> shows the columns croft tracks now. If the change broke something, ask the user before
  undoing it: croft restore <asset> brings back a version croft trashed earlier, when there is one.
