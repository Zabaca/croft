# EXTENSION_CHECKSUM_MISMATCH: a DuckDB extension file is not the one croft pins

A croft mode loads only the extension files whose sha256 croft pins for this DuckDB version and platform. details.kind
says where the mismatch was found:

- "checksum": the file is on the machine, but its checksum differs: it is damaged (a partial copy, a disk error), it
  was replaced or edited, or it is a different build of the same extension. Nothing was loaded, because croft checks
  every file before it loads the first. details.extension names the extension, details.path the file, and
  details.bytes and details.expectedBytes the size found and the size pinned. The fix,
  `croft fetch-extensions <extension>`, fetches DuckDB's file and replaces it.
- "download": croft fetched the file from DuckDB's extension servers and what came back is not the pinned file. Nothing
  was written. Either DuckDB re-released the file under the same version, so the pins in this croft are out of date, or
  something between the machine and the server (a proxy, a mirror in $CROFT_EXTENSION_REPO) changed it. details.url is
  where croft asked.

The project's data was not touched.

What to do:
- For kind "checksum", run the fix and then `croft validate`.
- For kind "download", or if the replacement also fails the check, stop and ask the user: either the pins are out of
  date (a newer croft pins the new file) or the path to the server cannot be trusted.
- Never edit the pins or skip the check to get past this.
