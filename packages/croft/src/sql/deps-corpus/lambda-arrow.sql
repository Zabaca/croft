-- A lambda written with an arrow, which DuckDB 2.0 no longer reads: LAMBDA_ARROW, and the plan cannot bind it.
-- @ast: orders
-- @plan: null
-- @problems: LAMBDA_ARROW
SELECT id, list_transform(tags, t -> upper(t)) AS upper_tags
FROM orders
