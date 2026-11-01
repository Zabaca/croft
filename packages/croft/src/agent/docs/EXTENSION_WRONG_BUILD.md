# EXTENSION_WRONG_BUILD: a DuckDB extension file was built for another DuckDB version or platform

A croft mode loads only the extension file pinned for this DuckDB version and this platform. The file in the
extensions folder carries a footer that says it was built for something else, for example for another DuckDB
release (extensions are built per release) or for another operating system or CPU. Nothing was loaded.
details.built holds what the file's footer says, and details.platform and details.duckdb what croft needs.

The project's data was not touched.

What to do:
- Replace the file with the one pinned for this DuckDB version and platform. The fix says how: the croft repository's
  scripts/fetch-extensions.ts fills the extensions folder from DuckDB's official extension repository and checks
  each file against the pinned checksum. (How a user gets the files without the repository is not built yet.)
- A folder shared between machines of different kinds needs one file per platform: croft looks under
  v<DuckDB version>/<platform>/ in the folder, so a copy made on another machine usually landed in the wrong place.
