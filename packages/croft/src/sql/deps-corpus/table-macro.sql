-- A table macro (histogram expands to query_table over its first argument): only the plan sees orders.
-- @ast: none
-- @plan: orders
-- @why: the macro's table is a column reference in the AST; the plan expands the macro
-- @problems: none
SELECT * FROM histogram(orders, amount)
