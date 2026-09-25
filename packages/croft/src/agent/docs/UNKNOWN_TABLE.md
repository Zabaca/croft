# UNKNOWN_TABLE: no table or asset of that name

A table's name is its asset's file name without .ts or .sql: assets/github_issues.ts makes github_issues.

- croft query: no table and no asset has that name. The hint suggests the closest asset: for one that is built, the
  fix is the query with the name corrected; for one not built yet, croft run <asset>. An asset's own name whose table
  is missing is DB_NOT_FOUND instead (not built yet: croft run <asset> builds it). croft status lists the assets and
  their tables.
- croft validate: an SQL asset reads a table that is not an asset of this project, or a TypeScript transform's
  inputs name an asset that does not exist. The hint suggests the closest name, and the fix corrects a typo.
- An asset that exists but has never run is not UNKNOWN_TABLE in validate: it is INPUT_NOT_BUILT (info).
