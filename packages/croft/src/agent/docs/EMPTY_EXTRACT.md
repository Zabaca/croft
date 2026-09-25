# EMPTY_EXTRACT: an ingest with a lookback got no rows, though its window held rows last time (warning)

An ingest with a lookback (incremental: { field: "created", unit: "s", lookback: "30 days" }) fetches that window
again on every run, so it should at least see the rows it saw last time. When rows() returns nothing although the
table has rows in the window, croft warns. The run still succeeds and nothing is removed, but the source has most
likely stopped answering properly.

Common causes:
- a revoked or expired token: some APIs answer with an empty list rather than an error;
- a filter in rows() that changed (a status, an account, a date parameter);
- the source really lost those records.

What to do: read croft logs <asset> (the fix), which shows this run's requests and what the API answered.
details.requests, details.lastStatus and details.bodyPreview summarize them; details.windowRows is how many stored
rows are in the window, and details.lastRows the last write that brought rows. If the token is the cause, ask the
user to replace it in .env (never read .env yourself); if it is the filter, fix rows(), then croft preview <asset>.

It is only raised for an ingest with a lookback, on a normal run (not with --from).
