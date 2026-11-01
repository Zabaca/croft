# EXTENSION_MISSING: a DuckDB extension file croft's mode needs is not there

A croft mode (server mode, lake mode) loads exactly the DuckDB extensions it needs, from files croft pins by
checksum. It never runs INSTALL and never downloads anything while it runs. The file for this mode, this DuckDB
version and this platform is not in the extensions folder, so the mode did not start and nothing was loaded.
details.extension names the extension, details.path where croft looked, and details.kind says why: "file" is a
missing file, "platform" means croft pins no extension for this operating system and CPU (the modes run on macOS
and on Linux with glibc, on x64 and arm64; Alpine and other musl systems and Windows are not covered).

The extensions folder is $CROFT_EXTENSION_DIR, else ~/.cache/croft/test-extensions (details.path is the file looked
for). Server mode (croft docs server-mode) reads the same folder, so with "serverMode" on, croft serve does not start
until the files are there.

The project's data was not touched.

What to do:
- Fill the extensions folder with DuckDB's pinned files. The fix says how: the croft repository's
  scripts/fetch-extensions.ts downloads each file and checks it against the pinned checksum before writing it. (How
  a user gets the files without the repository is not built yet.)
- For details.kind "platform", this machine cannot run the mode; ask the user.
- Do not copy an extension file from another DuckDB install or download one by hand: croft refuses a file whose
  checksum differs (EXTENSION_CHECKSUM_MISMATCH).
