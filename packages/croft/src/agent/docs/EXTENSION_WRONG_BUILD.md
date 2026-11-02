# EXTENSION_WRONG_BUILD: a DuckDB extension file was built for another DuckDB version or platform

A croft mode loads only the extension file pinned for this DuckDB version and this platform. The file found carries a
footer that says it was built for something else, for example for another DuckDB release (extensions are built per
release) or for another operating system or CPU. Nothing was loaded. details.built holds what the file's footer says,
details.platform and details.duckdb what croft needs, and details.source where the file came from ("addon", "dir" or
"cache").

The project's data was not touched.

What to do:
- From an add-on: this croft needs a different version of the add-on than the one installed (a croft upgrade that moved
  to another DuckDB leaves the old add-on behind). The fix is the install command with the version this croft was tested
  with: `bun add @zabaca/croft-addon-server@<version>` (or `...-addon-lake`) in the project's folder. Then run
  `croft validate`.
- From a folder: replace the file with the one pinned for this DuckDB version and platform. The croft repository's
  scripts/fetch-extensions.ts fills the folder from DuckDB's official extension repository and checks each file against
  the pinned checksum. A folder shared between machines of different kinds needs one file per platform: croft looks
  under v<DuckDB version>/<platform>/ in the folder, so a copy made on another machine usually landed in the wrong
  place.
