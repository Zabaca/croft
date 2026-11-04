# EXTENSION_WRONG_BUILD: a DuckDB extension file was built for another DuckDB version or platform

A croft mode loads only the extension file pinned for this DuckDB version and this platform. The file found carries
a footer that says it was built for something else, for example for another DuckDB release (extensions are built per
release) or for another operating system or CPU. Nothing was loaded. details.built holds what the file's footer
says, details.platform and details.duckdb what croft needs.

The project's data was not touched.

What to do:
- Run the fix, `croft fetch-extensions <extension>`: it fetches the file for this DuckDB version and platform from
  DuckDB's extension servers and replaces the one found. Then run `croft validate`.
- A folder shared between machines of different kinds (`$CROFT_EXTENSION_DIR`) needs one file per platform: croft
  looks under v<DuckDB version>/<platform>/ in the folder, so a copy made on another machine usually landed in the
  wrong place.
