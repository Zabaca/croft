# DB_UNREADABLE: the warehouse file exists but cannot be opened as a DuckDB database

croft found the database file ("database" in croft.json) but DuckDB cannot open it: it is not a DuckDB file (a
path that points at something else), it is damaged (a partial copy, a sync conflict, a disk error), or it cannot be
read with this user's permissions. croft doctor, croft context and croft serve report it; details.error holds
DuckDB's message.

Nothing was written to it.

What to do:
- croft doctor checks the file and says more.
- Check that "database" in croft.json points at this project's warehouse, and that the user can read it.
- A damaged file: ask the user before anything else. Restore it from their backup, or from .croft/backups/ when
  croft made one before a DuckDB upgrade. Rebuilding it from the sources means refetching everything, which the
  user decides.
Never delete or overwrite the file yourself.
