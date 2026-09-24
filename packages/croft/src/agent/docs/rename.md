# Renaming an asset: croft rename moves the file, the table and its state together

An asset's name is its file's name and its table's name, so renaming a file by hand leaves the table behind under
the old name. Rename with croft instead:

  croft rename <old> <new>          e.g. croft rename github_issues gh_issues

It moves everything that belongs to the asset, together:
- the asset file, in its folder, keeping its extension (assets/github_issues.ts → assets/gh_issues.ts);
- the table, with croft's state for it: its cursor, columns, write history, what it read and what reads it;
- its run history, its schedule and the scheduler's approval (a renamed asset is not held again);
- its versions in the trash (croft restore lists them under the new name; ask the user before restoring one);
- the last preview, which is cleared if it built or read the old name.

Nothing is fetched, rebuilt or deleted, so it needs no confirmation. It refuses a new name that is taken, by a file
or a table (NAME_CONFLICT), or that is not a valid asset name (NAME_INVALID, NAME_RESERVED, with a suggestion). While
a run is writing either name it stops with ASSET_BUSY: croft wait <runId>, then the same croft rename again.

## References to update

croft never edits your code. The rename lists every reference to the old name in assets/ and lib/, as file:line:
SQL FROM and JOIN, a TypeScript transform's inputs and rows("old") / newRows("old"), checks that read it, and
imports. Update each one, then the loop: croft validate --json → croft preview <asset> → croft run <asset>. Until
they are updated, croft validate reports each one as UNKNOWN_TABLE.

## A file already renamed by hand

A file renamed outside croft makes a new asset that was never built, with the same code as the table left behind.
croft validate, croft status and croft describe report ASSET_RENAMED with the fix croft rename <old> <new>: it
adopts the old table, cursor and history under the new name, fetching nothing. Do not run the new name first: croft
run would fetch everything again into a new table. The kinds must match (an SQL file cannot adopt an ingest's table).

## A rename that stopped

croft rename writes .croft/rename.json before it moves anything and removes it last. If it is killed or fails on
the way, croft validate and croft status report ASSET_RENAMED ("did not finish"), and the same command,
croft rename <old> <new>, finishes it from where it stopped. Run neither name, and no other rename, until then.
