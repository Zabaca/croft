# ORPHAN_TABLE: a table whose asset file is gone (warning)

Every table croft built belongs to an asset file in assets/. When the file is removed (or moved out of assets/)
but its table stays, the table is an orphan: it keeps its rows, and queries still read it, but no run updates it
any more and its data slowly goes out of date. croft describe <name> and croft status show it. The assets that
read it still bind against it.

Nothing is deleted: croft never removes a table because its file went away.

What to do: ask the user what the table should become.
- It is still wanted: put the file back (git restore assets/<name>.ts, or undo the move), then run
  croft validate --json. A renamed file is adopted with croft rename <old> <new>, which keeps the table and its
  history.
- It should go: only with the user's yes, croft delete <name> moves it to the trash after a confirmation, and
  croft restore <name> can bring it back.
