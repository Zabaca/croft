# DB_NOT_FOUND: the database a command needs does not exist

croft creates the warehouse (warehouse.duckdb, or the "database" path in croft.json) on the first run that
writes a table. DB_NOT_FOUND means a command needed it, or another database, and it is not there. The message says
which case it is:
- nothing was run yet: there is no warehouse to read; croft run builds it;
- croft built tables before (runs.sqlite records them) and the file is gone: it was deleted, moved, or "database"
  in croft.json points somewhere else. croft status and croft context report it with healthy false, and show those
  assets as unknown;
- croft query of an asset whose table is not there although the warehouse is: the asset has not been built yet (it
  never ran, or its runs failed), croft delete removed its table, or croft built it and something outside croft
  dropped it (the message says which);
- croft query --preview, but no croft preview has built a preview database yet;
- an app reading through @zabaca/croft/read before the first run.

Nothing was written.

What to do:
- Never built: croft run (or croft run <asset>). When its last run failed, croft logs <asset> --failed says why first.
- Deleted with croft delete: croft restore <asset> brings the table back from the trash.
- Built, then dropped outside croft: croft doctor compares every table with what croft last wrote; ask the user
  before rebuilding it.
- Built before and now missing: ask the user where the file went, and put it back or point "database" at it.
  Running an asset instead starts an empty warehouse and fetches everything again from the sources, which can
  cost time and API calls: only do that after the user agrees.
- No preview: croft preview <asset> first, then croft query --preview "from <asset>".
