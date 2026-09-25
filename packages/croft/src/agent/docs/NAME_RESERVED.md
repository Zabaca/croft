# NAME_RESERVED: an asset name croft keeps for itself, or an SQL keyword

Three kinds of names cannot be assets, although they are well formed:
- names that start with _ (croft keeps those for its own tables, such as _croft and _loaded_at);
- new and croft (new is kept for incremental SQL, which will read new.<table>; croft is croft's own);
- SQL keywords such as order, select or group: FROM order would be a syntax error in every asset that reads it.

details.reason says which (underscore, reserved or keyword) and details.suggestion gives a name that works
(orders_data, order_data, ...).

The file is not loaded as an asset; nothing else changes.

What to do:
- Rename the file to the suggested name, or another name of your choice, then croft validate --json. Update the SQL
  or inputs of any asset that referred to the old name.
- If a table was already built under the old name, use croft rename <old> <new> instead: it moves the file, the
  table and croft's state together and lists the references to update.
