# DUCKDB_BINDING_MISSING: the DuckDB driver for this machine is not installed

croft reads and writes the warehouse through @duckdb/node-api, whose native binding is installed per platform
(macOS arm64, Linux x64, Linux arm64). DUCKDB_BINDING_MISSING means the binding for this platform is not in the
project's node_modules: node_modules was copied from another machine, installed under another architecture (an x64
Bun under Rosetta on an Apple silicon Mac), or the install was cut short.

Commands that need the database fail; croft help, docs, doctor and init still work.

What to do: run croft doctor. It names the binding it expected and what it found, and gives the command that
reinstalls the dependencies for this machine, usually cd <project> && rm -rf node_modules && bun install. That
deletes and reinstalls node_modules: ask the user first, and only then run it. Under Rosetta, the user needs the
arm64 build of Bun first. Then croft doctor again.
