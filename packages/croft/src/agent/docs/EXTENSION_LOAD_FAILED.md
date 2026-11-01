# EXTENSION_LOAD_FAILED: DuckDB refused to load an extension file that passed croft's checksum

A croft mode checked every extension file against the checksum it pins, and then DuckDB itself refused to load one.
The file is the right one, so this is not a damaged or replaced file: it is a mismatch between the file and the
DuckDB library croft runs on, or a problem in the machine that loading cannot get past. details.extension names the
extension and details.duckdb holds DuckDB's first line of explanation. The DuckDB instance that was being set up may
hold extensions loaded before this one, so croft does not use it again: every later attempt on it fails, and the
mode starts again only on a new instance.

The project's data was not touched.

What to do:
- Run croft doctor and check that the DuckDB library croft uses is the version croft pins; reinstall the project's
  dependencies if it is not.
- If it still fails, this is a croft bug: report it with details.duckdb. Do not point croft at a different file.
