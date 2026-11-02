# LAKE_DIRECT_READ: an app cannot open a lake directly; it reads through croft serve

`@zabaca/croft/read` has two ways to answer a query. With croft serve running it asks the server. With none, it opens
the project's warehouse file for the query and closes it again ("direct mode"). A project in lake mode has no
warehouse file: its tables are a catalog and Parquet files in a bucket. Opening that takes the lake's extensions,
its read-only login and bucket key and croft's lockdown, which belong to croft and not to every app that reads. So
direct mode refuses in a lake project, and nothing was opened.

What to do:
- Start croft serve in the project (`croft serve`). `@zabaca/croft/read` finds it by itself and reads the lake's last
  snapshot through it. In a lake project croft serve never steps aside for a run and never answers "busy, retry"
  because of one (croft docs lake).
- An app that cannot depend on a running server needs another way to read; this is not a thing to work around by
  opening the lake from the app: that would put the catalog password and the bucket key in the app.
- A person who wants to read the lake from their own DuckDB, without croft, is given a read-only catalog login and a
  read-only bucket key by whoever runs the Postgres and the bucket; croft docs lake has the recipe.
