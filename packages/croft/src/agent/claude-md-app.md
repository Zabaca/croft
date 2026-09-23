<!-- croft:start (managed by `croft init --claude`) -->
## Data pipelines (croft)
This app's data pipelines live in data/, a croft project (TypeScript + DuckDB). Load the `croft` skill for any work in
data/ (its assets/, lib/ and warehouse.duckdb); paths in the skill are relative to data/. Start with `croft context --json`.
Loop: edit → `croft run <asset>` → check with `croft query "..."`, `croft describe <asset>` and `croft logs <asset>`.
App code reads croft data only with `import { query } from "@zabaca/croft/read"`; never open the .duckdb file directly.
Never modify data/warehouse*.duckdb or data/.croft/ except through croft. Never read .env or handle secret values.
Ask the user before any command in the skill's "Ask the user first" list, including every `croft confirm`.
<!-- croft:end -->
