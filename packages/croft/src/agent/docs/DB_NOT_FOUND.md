# DB_NOT_FOUND: the database a command needs does not exist

croft creates the warehouse (warehouse.duckdb, or the "database" path in croft.json) on the first run that
writes a table. DB_NOT_FOUND means a command needed it, or another database, and it is not there. The message says
which case it is:
- nothing was run yet: there is no warehouse to read; croft run builds it;
- croft built tables before (runs.sqlite records them) and the file is gone: it was deleted, moved, or "database"
  in croft.json points somewhere else. croft status and croft context report it with healthy false, and show those
  assets as unknown;
- croft query --preview, but no croft preview has built a preview database yet;
- an app reading through @zabaca/croft/read before the first run.

Nothing was written.

What to do:
- Never built: croft run (or croft run <asset>).
- Built before and now missing: ask the user where the file went, and put it back or point "database" at it.
  Running an asset instead starts an empty warehouse and fetches everything again from the sources, which can
  cost time and API calls: only do that after the user agrees.
- No preview: croft preview <asset> first, then croft query --preview "from <asset>".
