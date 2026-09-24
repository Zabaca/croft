# EDITED_SINCE_LAST_RUN: the asset's code changed since its table was built (warning)

croft status and croft context report an asset whose code changed since its last run: its file, the lib/ code
it imports, or croft.json's timezone. Whitespace and comments do not count. Its table still holds what the
older code made. What the next run does depends on the kind of asset:

- An SQL asset or a full-refresh TypeScript transform: the next run rebuilds the whole table with the new code.
  croft run <asset>.
- An ingest: the next run fetches with the new code; rows already loaded are not fetched again.
- An incremental TypeScript transform: new code applies to new input rows only. The rows built earlier keep
  their values, so paid calls are never repeated implicitly. This version has no rebuild from scratch.
  croft preview <asset> --rebuild builds it from scratch in the preview database, within its --rows cap, and
  shows how the results would differ.

Before running an edited asset: croft validate --json, then croft preview <asset>.
