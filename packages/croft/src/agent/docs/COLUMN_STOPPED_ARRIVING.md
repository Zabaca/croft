# COLUMN_STOPPED_ARRIVING: a column that was almost always set is missing from a whole batch (warning)

croft compares each batch with the table. A column that was set in at least 95% of earlier rows and is missing
from every row of this batch usually means the source changed: the API renamed or removed the field, or moved it
into a nested object. details: column, nonNullShare (its earlier share), batchRows, readBy (the assets that read
it).

The write went ahead: the new rows have NULL in that column. Readers of it now see NULLs for new rows. croft status
and croft context show it among the asset's drift warnings for 7 days.

What to do:
- Look at a raw response: croft preview <asset> shows sample rows, and croft logs <asset> what the code logged.
- The field was renamed: map it back in rows() so the column keeps its name
  ({ ...row, login: row.login ?? row.user_login }).
- The field is gone for good: tell the user, and update the assets in readBy that depend on it.
- Rows already written with NULL fill in when they are fetched again; for a merge ingest, ask the user before a
  backfill (croft run <asset> --dry-run --from <when> shows the window).
