# INCREMENTAL_WITHOUT_KEY: an incremental asset without a key would store re-read rows twice

An incremental API ingest (incremental: "updated_at") fetches from its saved position on each run, and a lookback
or the boundary row makes it read some rows again on purpose. An incremental TS transform processes input rows
that changed, which it may have seen before. With a key, a re-read row replaces its old version (merge). Without
one, every re-read row would be stored a second time, so croft refuses the definition.

The asset does not load until this is fixed; nothing is written.

What to do: in the asset file, either
- add key: "id" (or key: ["day", "currency"]): the column or columns that identify a record. Most APIs have an id.
  This is the usual fix; or
- add write: "append" when the source really is append-only (an event log whose records never change), so every
  fetched row is new by construction.

Then croft validate --json. The templates in croft docs ingest and croft docs transforms show both.
