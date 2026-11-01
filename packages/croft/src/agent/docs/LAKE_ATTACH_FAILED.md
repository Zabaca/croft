# LAKE_ATTACH_FAILED: croft could not attach the project's lake

In lake mode the warehouse lives in a DuckLake: a Postgres catalog plus Parquet files in one bucket folder. croft
attaches it when a command starts, with the catalog login and the bucket key from the project's secrets, and could
not. Typical causes are a wrong catalog password, a catalog host or port that is not reachable, a bucket key the
store refuses, or a catalog that is not a lake. details.duckdb holds DuckDB's first line of explanation with every
password and key taken out. retryable is true: a catalog that is restarting or a network that dropped is fixed by
trying again.

Nothing was written to the lake or to the project's files.

What to do:
- Check that the catalog is up and reachable from this machine, and that the settings and secrets name the right
  host, port, database, login and bucket.
- A wrong password or key is for the user to fix: ask them for the right secret. Never print a secret to look at it,
  and never write one into a file the project commits.
- Try the command again once the catalog is reachable.
