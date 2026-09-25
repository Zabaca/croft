# SHRINK_GUARD: a replace ingest would lose more than half of its rows

A replace ingest (no incremental) swaps its whole table for what the source returned this run. When that is less
than half of the rows it has now, croft stops: an expired token, a changed filter or a paging bug often returns few
or no rows, and replacing the table would throw data away. The same guard covers the refetch of
croft run <asset> --rebuild. croft preview <asset> reports the same shrink as a warning, before any real run.

Nothing was written: the table keeps its rows (details.rowsBefore, details.rowsAfter).

What to do:
1. Find out why the source returned fewer rows. croft logs <asset> --failed shows the requests and what came back;
   croft preview <asset> fetches again without writing. A token problem is fixed in .env by the user; a filter or
   paging problem in the asset's code.
2. Only when the source really shrank (records were deleted on purpose, a smaller export): ask the user. With their
   yes, croft run <asset> --allow-shrink prints the impact and a token; the current rows go to the trash first
   (croft restore <asset> brings them back), and only croft confirm <token> carries it out, after the user's
   explicit yes in this conversation.

allowShrink: true in the asset turns the guard off for good (SHRINK_GUARD_DISABLED); that is the user's decision,
not a fix for one run.
