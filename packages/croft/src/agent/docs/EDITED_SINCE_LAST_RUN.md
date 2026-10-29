# EDITED_SINCE_LAST_RUN: the asset's code changed since its table was built (warning)

croft status and croft context report an asset whose code changed since its last run: its file, the lib/ code
it imports, or croft.json's timezone. Whitespace and comments do not count. Its table still holds what the
older code made.

A new DuckDB alone is not an edit. An SQL asset's code hash is a hash of DuckDB's parse tree, so croft 0.4's
upgrade to DuckDB 2.0 gave every SQL asset a new one. When the file is the one that was built, the next run rebuilds
it once ("DuckDB upgraded (1.5.5 → 2.0.0)") and this warning does not appear. A build croft 0.3 recorded counts as
unedited only when the file is not newer than that build: one checked out again since (git sets the file's time)
reads as edited, and the next run rebuilds it all the same.

What the next run does depends on the kind of asset:

- An SQL asset or a full-refresh TypeScript transform: the next run rebuilds the whole table with the new code.
  croft run <asset>.
- An ingest: the next run fetches with the new code; rows already loaded are not fetched again.
- An incremental TypeScript transform: new code applies to new input rows only. The rows built earlier keep
  their values, so paid calls are never repeated implicitly. croft preview <asset> --rebuild builds it from
  scratch in the preview database, within its --rows cap, and shows how the results would differ. To redo the
  rows older code built: croft run <asset> --rebuild, which moves the table to the trash first and asks for a
  confirmation, since it may pay for every row again. Ask the user before running it.

Before running an edited asset: croft validate --json, then croft preview <asset>.
