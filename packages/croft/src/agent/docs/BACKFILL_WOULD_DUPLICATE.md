# BACKFILL_WOULD_DUPLICATE: --from on an append ingest would store rows twice, or skip some

An append ingest (incremental without a key) adds every fetched row as new: nothing identifies a row, so nothing
can replace an older copy. A backfill with --from therefore only works from the saved position on:
- --from before the saved position would fetch rows the table already has, and store each of them again;
- --from after it would never fetch the rows in between, and keeping the saved position would store the rows after
  --from twice on the next run.

Nothing ran (exit 2).

What to do:
- To continue normally: croft run <asset> without --from; it fetches from the saved position (shown by
  croft describe <asset>).
- To re-read a window: add a key to the asset (key: "id", the column that identifies a record), so re-read rows
  replace their old versions. Adding a key to an ingest with data is a key conversion that asks for a
  confirmation (croft docs INGEST_CONFIG_CHANGED): ask the user before you confirm it. Then
  croft run <asset> --dry-run --from <when> shows the window, and the same without --dry-run fetches it.
