# KEY_NULL: rows without a value for the asset's key

An asset's key (key: "id", or -- key: day, region in SQL) identifies each row: merges update by it, and unique
checks and incremental processing rely on it. A key column is never empty. KEY_NULL means:
- some rows have NULL (or no field at all) for the key; the message counts them;
- the key names a field that is missing from every row of the batch (a typo, or the API renamed it);
- in an SQL asset, the key is not a column the SELECT returns.

Nothing was written, and the cursor did not move.

What to do:
- Rows that really have no key: drop or fix them where they enter. In rows() or map(), skip them (if (!row.id)
  continue); in SQL, add WHERE id IS NOT NULL.
- The key names the wrong column: correct key in the asset (croft describe <asset> lists the columns it has).
- The source renamed the field: map it back in rows() so the key column keeps its name.
Then croft validate --json, croft preview <asset>, and croft run <asset>. Changing the key of an asset with data is
INGEST_CONFIG_CHANGED (croft docs INGEST_CONFIG_CHANGED).
