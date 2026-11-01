# EXTENSION_CHECKSUM_MISMATCH: a DuckDB extension file is not the one croft pins

A croft mode loads only the extension files whose sha256 croft pins for this DuckDB version and platform. This file
is there but its checksum differs: it is damaged (a partial download, a disk error), it was replaced, or it is a
different build of the same extension. Nothing was loaded, because croft checks every file before it loads the
first. details.extension names the extension, details.path the file, and details.bytes and details.expectedBytes
the size found and the size pinned.

The project's data was not touched.

What to do:
- Replace the file with the pinned one. The fix says how: the croft repository's scripts/fetch-extensions.ts fills
  the extensions folder from DuckDB's official extension repository and checks each file against the pinned
  checksum before writing it. (How a user gets the files without the repository is not built yet.)
- If the replacement also fails the check, stop and ask the user: either the pins in this croft are out of date for
  that file, or something between the machine and the repository changed it.
- Never edit the pins or skip the check to get past this.
