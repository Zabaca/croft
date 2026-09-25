# SINCE_IGNORED: an incremental ingest seems to fetch everything, not what changed since (warning)

An incremental API ingest gets its saved position as ctx.since and is meant to ask the API only for what changed
after it. After a run, croft checks the batch: when more than half of the rows are older than since, the code most
likely never passed since to the API, and every run refetches the whole history. details: field, since, older and
rows.

The run succeeded and the table is right (the key merges the re-read rows), but each run costs as much as a first
load.

What to do: pass since to the API's filter in rows(), in the form the API wants: query: { since } for GitHub,
"created[gte]": since for Stripe, updated_after, and so on (croft docs ingest shows the templates). Then
croft run <asset> --dry-run shows the window the next run fetches, and croft preview <asset> how many rows it gets.
An API that has no such filter cannot be incremental: remove incremental, and croft replaces the table each run.
