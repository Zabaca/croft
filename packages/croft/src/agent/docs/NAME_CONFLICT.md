# NAME_CONFLICT: two things want the same asset name

Asset names are unique across assets/, whatever the folder and the extension, because each one is a table name.
NAME_CONFLICT comes from:
- discovery: two files define one asset (assets/orders.ts and assets/orders.sql, or assets/a/orders.ts and
  assets/b/orders.ts). Neither is loaded until one is renamed or removed; details.files lists them.
- croft rename <old> <new>: the new name is taken by another asset's file, by a table in the warehouse (a rename
  never replaces a table), or the old name itself is in conflict.
- croft new <kind> <name>: an asset of that name exists already; croft new never overwrites a file.

Nothing was changed.

What to do:
- Two files for one name: keep the one that is meant (compare them), and rename the other to a name of its own, or
  remove it if it is a leftover. Ask the user when both look intended.
- A taken name in rename or new: choose another name. croft status lists the assets and their tables.
- A table whose asset file is gone blocks its name too: ask the user what should become of it before reusing the
  name (croft describe <name> shows it).
