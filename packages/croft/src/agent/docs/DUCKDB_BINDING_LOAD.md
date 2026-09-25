# DUCKDB_BINDING_LOAD: the DuckDB driver is installed but does not load here

The binding of @duckdb/node-api for this platform is present, but loading it fails. The common cause on Linux is a
glibc older than the binding needs (the message names the version it wants; croft needs glibc 2.25 at least).
Otherwise the file is damaged or was built for another system.

Commands that need the database fail; croft help, docs, doctor and init still work.

What to do: run croft doctor, which loads the binding in a separate process and says why it fails.
- An old glibc: croft cannot run on this system; ask the user to use a newer distribution (or a container with
  one).
- A damaged install: reinstall the dependencies, cd <project> && rm -rf node_modules && bun install. It deletes and
  reinstalls node_modules: ask the user first. Then croft doctor again.
