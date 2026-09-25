# BACKFILL_UNSUPPORTED: --from was given to an asset that cannot backfill a window

croft run <asset> --from <when> refetches a window (from a date, an ISO time, or -90d) for a merge ingest: an API
ingest with a key and an incremental cursor. Re-read rows replace their old versions by key, and nothing outside
the window changes. Other assets have no window to refetch, so croft refuses (exit 2) and says what does the job
instead:
- a replace ingest fetches everything on every run: croft run <asset>;
- a file ingest reloads new and changed files by itself: croft run <asset>; all files again is --rebuild;
- an SQL asset or a full-refresh TS transform is recomputed from its inputs: croft run <asset> --rebuild;
- an incremental TS transform redoes every input row with croft run <asset> --rebuild, which may pay again per row.

Nothing ran.

What to do: run what the fix names. --rebuild of an ingest or an incremental transform trashes the table first and
asks for a confirmation: show the user the printed impact, ask the user, and run croft confirm <token> only after
their explicit yes. To backfill the ingest behind a transform, backfill that ingest with --from; the transforms
downstream update from it. croft run <asset> --dry-run --from -90d shows the window first.
