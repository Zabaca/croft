-- A table macro (histogram expands to query_table over its first argument): its table is an input.
-- @ast: orders
-- @plan: orders
-- @problems: none
SELECT * FROM histogram(orders, amount)
