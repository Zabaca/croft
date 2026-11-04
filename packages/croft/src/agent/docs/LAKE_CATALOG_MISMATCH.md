# LAKE_CATALOG_MISMATCH: the catalog database holds a different lake than croft's settings describe

In lake mode the warehouse lives in a DuckLake: a catalog in a Postgres database, and Parquet files in one bucket
folder. croft attached the catalog database `lake.catalog.database` names and found a lake that is not the one these
settings describe, so it stopped. It is permanent: the database will not change by itself, and croft never changes a
lake to make it fit. `details.kind` says which:

- `format`: the database holds a DuckLake of another format than the one croft opens (`details.catalogFormat`, against
  `details.croftFormat`), older or newer. It is another lake, made by another tool or by another version of DuckDB, and
  it is still that tool's. DuckDB's own message offers `AUTOMATIC_MIGRATION`; croft never sets it, because the migrated
  lake could no longer be read by whatever made it, and croft has no setting that turns it on.
- `data_path`: the database holds a lake whose files are in another bucket folder (`details.catalogDataPath`) than the
  one `lake.bucket` names (`details.settingsDataPath`). Either the settings point at the wrong folder, or the database
  holds another lake. croft never overrides a lake's data path: files already in the first folder would be left behind.

Nothing was written to the lake, the bucket or the project's files, and trying again will not help: croft does not
retry it (each step that needs the lake says it once, with this code, and the steps that read their output are
skipped).

What to do (the choice is the user's; ask them):
- Decide which database is croft's lake. A lake of its own needs a database of its own: point `lake.catalog.database`
  at an empty one, and the first `croft run` fills it.
- For `data_path`: if the lake in the database is this project's, set `lake.bucket.name` and `lake.bucket.folder` to
  the folder `details.catalogDataPath` names. If it is another lake, use another database.
- Never run the migration DuckDB's message suggests, and never copy a lake's tables into the project's database by
  hand. A lake made by another tool is read with that tool.
- `croft doctor` shows the same code, and `croft docs lake` describes the setup.
