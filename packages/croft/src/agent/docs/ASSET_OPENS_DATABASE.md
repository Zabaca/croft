# ASSET_OPENS_DATABASE: asset code imports a database driver or @zabaca/croft/read

croft owns the warehouse while it runs an asset. Asset code (or a lib/ file it imports) that imports a DuckDB
driver such as @duckdb/node-api, or @zabaca/croft/read, would open the database a second time from inside croft's
own process: it can break croft's file lock and corrupt a write. croft finds the import before it runs any of the
code, so the asset does not load.

The message names the file and line of the import (details.importedBy, details.specifier).

What to do: remove the import, and read what the asset needs through croft instead:
- an ingest reads its own table with ctx.query("select max(id) as id from <asset>") (one SELECT);
- a transform reads its inputs with rows("<input>") and newRows("<input>"), and runs one SELECT over them with
  query(...); list the inputs in inputs: [...].

@zabaca/croft/read is for apps and scripts outside croft. Then croft validate --json.
