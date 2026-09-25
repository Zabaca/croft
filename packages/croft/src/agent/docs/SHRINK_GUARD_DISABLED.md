# SHRINK_GUARD_DISABLED: an ingest turns its shrink guard off (warning)

A replace ingest may not lose more than half of its rows in one run (SHRINK_GUARD): a source that suddenly returns
few rows is usually broken, not smaller. allowShrink: true in the asset turns that guard off for good: every run
may then empty the table without asking (its current rows still go to the trash first). croft warns when the asset
loads, and again after a run that did shrink the table that much.

On a merge or append ingest, allowShrink does nothing (only replace ingests have the guard), and the warning says
so.

What to do: remove allowShrink from the asset unless the user decided that this source really shrinks by more than
half from run to run. For a one-off shrink, croft run <asset> --allow-shrink asks for a confirmation instead: ask
the user, and confirm only after their explicit yes. A table that shrank by mistake can come back with
croft restore <asset>: ask the user first.
