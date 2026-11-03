# LAKE_ATTACH_FAILED: croft could not attach the project's lake

In lake mode the warehouse lives in a DuckLake: a catalog (a Postgres) plus Parquet
files in one bucket folder. croft attaches it when a command starts, with the catalog login and
the bucket key from the project's secrets (the writer's pair for a command that writes, the read-only pair for one that
only reads and for croft serve), and could not. details.duckdb holds DuckDB's first line of explanation with every
password and key taken out.

Which kind it is shows in details and in `retryable`:
- `retryable: true`: the catalog is down, restarting or not reachable from this machine, or the network dropped. croft
  already tried again a few times; running the command again once the catalog is reachable is the fix.
- `details.refused: true` (`retryable: false`): the catalog or the store answered and refused the login or the key (a
  wrong password, a login that does not exist, a key the store does not know). Trying again will not change it. The
  secret is the user's to fix: ask for the right one. Never print a secret to look at it, and never write one into a
  file the project commits.
- `details.tls: true` (`retryable: false`): the catalog's TLS check failed. Its certificate is not signed by a CA in
  the file `lake.catalog.sslRootCert` names (or this machine's CA bundle), was not issued for the name in
  `lake.catalog.host`, or the catalog offers no TLS and `lake.catalog.sslMode` requires it; the message names which. Fix
  the catalog's certificate or those two settings. Lowering `lake.catalog.sslMode` (to `require`, `prefer` or `disable`)
  means the catalog's password may be read on the network: it is the user's call, never yours to make to get past the
  error. `croft docs lake` says what each mode checks.
- `details.notCreated: true` (`retryable: false`): a reader (`croft query`, `croft serve`, `croft doctor`) found a lake
  nobody has written yet. The machine that writes creates it with its first `croft run`. The commands that read report
  this as DB_NOT_FOUND.

Other causes: the catalog is a different DuckLake format than this croft's (DuckDB's message says "catalog version
mismatch"; croft creates lakes at format 1.0, never migrates one by itself, and a lake made by another tool at another
version is not one croft opens), or the database the settings name is not a lake.

Nothing was written to the lake or to the project's files.

What to do:
- Check that the catalog is up and reachable from this machine, and that the settings and secrets name the right
  host, port, database, login, bucket and keys (`croft doctor` shows what it reads; `croft docs lake` has the setup).
- A wrong password or key is for the user to fix.
- Try the command again once the catalog is reachable.
