# LAKE_MAINTENANCE_FAILED: a pass of the lake's maintenance stopped at a step that kept failing (warning)

croft keeps a lake short by running its maintenance by itself (croft docs lake): after a run, and from the scheduler,
once the last pass is `lake.maintenance.everyHours` old (24 by default). A pass runs six steps one after the other,
under croft's lock on the lake's writes: prune, flush, expire, merge, rewrite, cleanup. A step that fails because the
store or the catalog answered with a server error, asked to slow down or dropped the connection is tried again up to
four times with a pause (R2 answered HTTP 500 to three bulk deletes in five days on one lake, and a second try
worked). This is what is left when it still failed: details.step names it and the message holds its error, with every
password and key taken out. The steps after it did not run.

Nothing is lost and the lake is usable. Each step can be run again from where the last one stopped: files that a failed
cleanup did not delete stay listed as waiting for deletion, and the next pass deletes them. Runs, reads and writes carry
on; a failed pass never fails a run. `croft status` and `croft doctor` show it as a warning until a pass works, and
croft tries again within the hour.

What to do:
- Usually nothing: look at `croft doctor` after an hour. A pass that worked clears the warning.
- A pass that keeps failing is almost always the store or the catalog (a bucket key that lost its right to delete, a
  full or unreachable Postgres): the message says which. `croft doctor` checks both. Ask the user to look at the
  bucket key (it needs to delete in the lake's folder) rather than changing croft's settings.
- `croft maintain` runs a pass now, and shows each step. `croft maintain --dry-run` shows what a pass would expire
  without changing anything.
- Never run CHECKPOINT on the lake or set an expiry option on it to "help": that can expire versions the trash promises.
