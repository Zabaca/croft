# ASSET_RENAMED: an asset file was renamed outside croft; croft rename adopts its table

A table is named after its asset file. Renaming assets/tickets.ts to assets/support_tickets.ts by hand leaves the
table tickets behind, with its cursor and history but no asset file, and makes support_tickets a new asset that was
never built. croft recognizes the pair because the code is the same (a file's name is not part of its code hash),
and reports ASSET_RENAMED on the new name in croft validate, croft status, croft context and croft describe.
details.from and details.to name both, and details.rows the rows in the old table.

What to do: the fix, croft rename <old> <new> (here: croft rename tickets support_tickets). It adopts the old
table, cursor, history and scheduler approval under the new name and fetches nothing; it needs no confirmation.
Then update the references it lists (file:line) and run croft validate.

- Do not run the new asset first: croft run support_tickets would fetch everything again into a new table, and the
  old table would stay behind as an orphan.
- The kinds must match: an SQL file cannot adopt an ingest's table. If the new file is really a different asset,
  ask the user what should happen to the old table.
- If the rename was a mistake, put the file back under its old name instead; the problem goes away.

With details.unfinished true, a croft rename stopped before it finished (it was killed, or failed on the way): the
same command finishes it from where it stopped. Run neither name before that. croft docs rename has the details.
