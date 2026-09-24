# SERVE_UNAVAILABLE: croft serve did not answer, or stayed busy, for the whole timeout

An app's query() with a server URL (CROFT_URL or { url }) retries an unreachable or busy server (503 with
Retry-After) until timeoutMs (10 s by default), then throws this error. A URL never falls back to reading the
file.

- The server is not running: croft serve stopped, or runs on another port. Ask the user whether croft serve is
  running in their terminal (croft status shows a running croft serve and its address). In the project, an app
  without CROFT_URL reads the file directly when no server runs.
- A croft run is writing: croft serve steps aside while a run holds the file, and queries wait up to 10 s. For
  long writes, a larger { timeoutMs } in the app waits them out, and "readCopy": true in croft.json lets croft
  serve answer from the read copy meanwhile (stale: true, asOf; croft docs read-copy).
- Every query slot is taken: serve.maxConcurrent queries run at once (4 by default) and the rest queue. Slow
  queries hold their slot up to serve.queryTimeoutMs.

It is retryable: the same query can simply be tried again later.
