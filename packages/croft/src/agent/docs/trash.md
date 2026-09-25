# The trash: what croft keeps before anything destructive, and how to delete or restore

Nothing destructive happens without a copy first. Before croft replaces or removes ingested rows, it moves them
to the trash, .croft/trash/<table>/<time>.duckdb, and only then makes the change. That covers run --allow-shrink,
run --rebuild, croft delete, croft restore (the table it replaces), lossy pin changes and key conversions. A
crash between the two steps leaves an extra copy in the trash, never a loss.

.croft/ holds the trash and the backups: never delete it, and never run git clean -X in the project.

## What the trash holds

  croft restore                      lists it, newest first: table, when, rows, size and why
  croft restore --json               the same as data.versions[] (times carry the project offset)

A version is either a whole table (with croft's state for it: its cursor, columns and history) or the rows a
croft delete --where removed. Versions are kept 30 days, and the 5 newest of each table are kept however old;
so a version goes only when it is older than 30 days and its table has 5 newer ones. Each new version clears
what is past that for its table, and croft doctor for every table.

## Deleting

  croft delete <table>                         the whole table and croft's state for it
  croft delete <table> --where "<condition>"   only the rows the condition matches

- Exact names only: no patterns, one table per command.
- --where is one SQL condition over the table's columns, as in a WHERE clause: --where "created_at < '2024-01-01'".
  It may read other tables of the project in a subquery; it may not call random(), sample rows (USING SAMPLE,
  TABLESAMPLE), read files or run a second statement. A condition that matches no rows deletes nothing and asks
  nothing. The rows deleted are exactly the rows that went to the trash, even if the condition would pick others
  by then.
- The asset file stays. After deleting a whole table, croft status shows it as deleted (croft restore <table>
  brings it back), and the scheduler leaves it alone: only croft run <table>, run by hand, builds it from scratch
  (an ingest fetches everything again, which may cost money: ask the user first). Assets that read it have no input
  until then.
- After deleting rows, what reads the table goes stale and rebuilds on the next croft run. An incremental TS
  transform keeps what it made from the deleted rows until croft run <transform> --rebuild (it asks first).

## Restoring

  croft restore <table>                   brings back its newest version
  croft restore <table> --at "<time>"     another one: the time as croft restore lists it, in the project zone

--at takes the list's minute ("2026-09-22 11:40"), a second or millisecond when two versions share a minute
("2026-09-22 11:40:05"), a full time with an offset, or the version's file name (20260922T184000.123Z).

- A whole-table version replaces the table, with its cursor and state: the table is as it was then. The table
  it replaces goes to the trash first, so a restore can be undone the same way.
- A version holding the rows of a delete --where puts those rows back into the table as it is now. With a key,
  rows whose key is in the table again (fetched since) are left out and counted.
- A delete --where that stopped halfway (a crash, or the table changed under it) leaves a copy of rows that were
  never deleted: croft restore lists it as "not applied: the delete did not finish", croft restore <table> skips
  it, and naming it with --at is refused while the table still has those rows.
- What reads the table goes stale: SQL transforms rebuild on the next croft run. An incremental TS transform
  processes new rows only, so rows it built before the restore keep their values; croft run <transform> --rebuild
  redoes them (it asks first).

## Asking first

croft delete and croft restore change nothing until a person agrees. On a terminal they print what would happen
and ask Proceed? [y/N]. Anywhere else (an agent's shell, --json) they exit 5 with the impact (rows, the trash
path, the assets that read the table) and a token:

  needs confirmation: delete orders, the whole table: 1,130 rows
    first: the 1,130 rows go to the trash (croft restore orders brings them back)
    then:  daily_orders read it: they keep their tables, and croft run skips them until orders is built again
           the scheduler leaves orders alone from now on: only croft run orders, by hand, builds it again, fetching its whole history from the source
    ask the user; if they agree: croft confirm c_7f3a9e    (valid 15 min)

Show the user the impact and run croft confirm <token> only after their explicit yes in this conversation. confirm
counts the impact again first: when it changed meanwhile (the scheduler added rows, say) it stops with
CONFIRMATION_STALE and changes nothing; run the command again for a new token. A token works once, for 15 minutes,
and consent is for one action: once one token carries a command out, every other token for the same command is
spent too, and a token minted before the table was written, rebuilt or restored is stale.

## Backups before an engine upgrade

When a croft upgrade brings a newer DuckDB, croft copies warehouse.duckdb (and warehouse.duckdb.wal, when there is
one) whole to .croft/backups/ before the newer engine opens it for the first time. A backup is a plain DuckDB file
of the warehouse as it was; ask the user before deleting one.
