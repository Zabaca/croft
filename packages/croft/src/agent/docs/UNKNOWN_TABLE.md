# UNKNOWN_TABLE: no table or asset of that name

A table's name is its asset's file name without .ts or .sql: assets/github_issues.ts makes github_issues.

- croft query: no table has that name. An asset that has not run yet has no table: croft run <asset> builds it.
  croft status lists the assets and their tables.
- croft validate: an SQL asset reads a table that is not an asset of this project, or a TypeScript transform's
  inputs name an asset that does not exist. The hint suggests the closest name, and the fix corrects a typo.
- An asset that exists but has never run is not UNKNOWN_TABLE in validate: it is INPUT_NOT_BUILT (info).
