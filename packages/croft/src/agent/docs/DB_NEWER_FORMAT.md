# DB_NEWER_FORMAT: a newer croft or DuckDB wrote this database

The warehouse records the croft format it was written with, and DuckDB records its own storage version;
.croft/runs.sqlite records its schema too. This croft is older than what wrote one of them: another checkout of the
project, a global croft, or a teammate's machine ran a newer croft on the same files. An older version cannot read
a newer format safely, so croft refuses (retryable is false). The message names both versions (details.formatVersion,
details.croftVersion, details.duckdbVersion).

Nothing was opened for writing, and nothing was changed.

What to do: use the newer croft, never an older one, on these files. The project pins croft in package.json; ask
the user to upgrade it there (bun add @zabaca/croft@latest in the project), then croft doctor. croft keeps a backup
before a newer DuckDB first writes a warehouse (.croft/backups/), so going forward is safe; going back is not.
