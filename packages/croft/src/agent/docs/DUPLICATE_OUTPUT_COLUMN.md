# DUPLICATE_OUTPUT_COLUMN: an SQL asset's SELECT returns two columns with one name

A table cannot have two columns of the same name, and names are compared without regard to case. DuckDB would
quietly rename the second copy (amount_1), so croft stops instead: croft validate reports it, and a run refuses
to write.

Causes and fixes:
- Two tables' columns of one name in a join, or one expression selected twice: name each once with AS
  (o.amount AS order_amount, r.amount AS refund_amount).
- SELECT * over a join: list the columns you need (o.*, r.amount AS refund_amount), or join with USING (id) when
  the shared column is the join key.

croft's own columns (_loaded_at, _file) are dropped from every SQL asset's output, so they never count here.
