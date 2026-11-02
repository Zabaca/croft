# EXTENSION_CHECKSUM_MISMATCH: a DuckDB extension file is not the one croft pins

A croft mode loads only the extension files whose sha256 croft pins for this DuckDB version and platform. This file
is there but its checksum differs: it is damaged (a partial download, a disk error), it was replaced or edited, or it
is a different build of the same extension. Nothing was loaded, because croft checks every file before it loads the
first. details.extension names the extension, details.path the file, details.bytes and details.expectedBytes the size
found and the size pinned, and details.source where the file came from: "addon" (a package in node_modules, croft docs
addons), "dir" ($CROFT_EXTENSION_DIR) or "cache" (the folder croft's builders share).

The project's data was not touched.

What to do:
- From an add-on: install it again. The fix is the same command that installed it (`bun add
  @zabaca/croft-addon-server@<version>`, or `...-addon-lake`), which replaces the package's files with the published
  ones. Then run `croft validate`.
- From a folder: replace the file with the pinned one. The croft repository's scripts/fetch-extensions.ts fills the
  folder from DuckDB's official extension repository and checks each file against the pinned checksum before writing it.
- If the replacement also fails the check, stop and ask the user: either the pins in this croft are out of date for
  that file, or something between the machine and the registry changed it.
- Never edit the pins or skip the check to get past this.
