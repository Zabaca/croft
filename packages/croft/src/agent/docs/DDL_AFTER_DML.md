# DDL_AFTER_DML: croft tried to change a table's columns after writing it in the same transaction

An internal invariant, not a problem in the project. DuckDB fails a transaction at COMMIT when a table is altered
(a column added or retyped) after rows were written to it in that same transaction. croft plans every column
change of a write before its first INSERT, UPDATE, DELETE or MERGE; this guard stops the write before DuckDB would,
so nothing half-written is committed.

Nothing was written for the step: the transaction rolled back, and the cursor did not move.

What to do: this is a bug in croft. Report it with the command you ran and the full --json output (details.table,
details.alter and details.firstWrite say which statements collided). Until it is fixed, running the asset again
may succeed when the data no longer needs the column change; croft preview <asset> shows which columns a run would
add or retype.
