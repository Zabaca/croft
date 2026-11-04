# EXTENSION_FETCH_FAILED: croft could not fetch a DuckDB extension file

A mode (server mode, lake mode) needs a DuckDB extension file this machine does not have, and fetching it from
DuckDB's extension servers (`https://extensions.duckdb.org`) did not finish: no network, a proxy or firewall in the
way, the server answering an error (details.status), or an answer that was not the file. Nothing was written (a file
is stored only after it passes its checksum), the mode did not start, and the project's data was not touched.
details.extension names the file and details.url where croft asked.

This is retryable: the same fetch works once the machine can reach the server.

What to do:
- Run the fix, `croft fetch-extensions <extension>`, where there is network. It fetches the file into croft's cache
  folder (croft docs extensions). If the machine goes through a proxy, `HTTPS_PROXY` must be set for it.
- On a machine that never has network when croft runs, fetch on one that does and copy the folder: set
  `$CROFT_EXTENSION_DIR` to the copy (croft docs extensions).
- If the server answers 404, this croft pins a DuckDB version whose file is no longer there; upgrade croft or report
  it.
- Do not fetch the file by hand from another source: croft refuses any file whose checksum differs from its pin
  (EXTENSION_CHECKSUM_MISMATCH).
