<!-- croft:start (managed by `croft init --claude`) -->
## Data pipelines (croft)
This project loads and transforms data with croft (TypeScript + DuckDB). Load the `croft` skill for any work in
assets/, lib/ or on warehouse.duckdb. Start with `croft context --json`.
Loop: edit → `croft validate --json` → `croft preview <asset>` → `croft run <asset>` → `croft query "..."`.
Never modify warehouse*.duckdb or .croft/ except through croft. Never read .env or handle secret values.
Ask the user before any command in the skill's "Ask the user first" list, including every `croft confirm`.
<!-- croft:end -->
