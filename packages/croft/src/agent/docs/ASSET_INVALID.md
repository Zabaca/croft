# ASSET_INVALID: an asset file that does not load, or whose definition croft cannot use

croft loads every file in assets/ before it runs anything. ASSET_INVALID means one of them cannot be used as
written. The message says which part, and file and line point at it. The common causes:
- the TypeScript does not compile, an import does not resolve, or top-level code threw or kept running (network
  calls and other slow work belong inside rows(), which runs only when the asset runs);
- the default export is not ingest({...}) or transform({...}) from @zabaca/croft;
- a key the definition does not have (with a did-you-mean), or a value of the wrong shape: key, write, columns
  (a pin must be a plain SQL type, or { type, format }), secrets, retries, timeout, checks, confirmAbove;
- an ingest with both rows() and file, or neither; write: "merge" without a key; write: "replace" with incremental;
- a file ingest whose files have no format croft can tell, or files of two formats in one asset;
- an SQL asset whose SELECT returns only columns croft keeps for itself (_loaded_at);
- croft validate --types: a type error the project's own tsc reports.

Nothing ran for that asset; the other assets are not affected unless they read it.

What to do: run croft validate --json. Each problem has file, line and a fix (usually an edit); make it, then run
croft validate --json again until it is clean. The templates in croft docs ingest, croft docs transforms and
croft docs sql show every valid shape, and croft new <kind> <name> writes one.
