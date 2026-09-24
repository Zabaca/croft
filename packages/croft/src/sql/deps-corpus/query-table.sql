-- query_table() names its table in a string: the AST cannot see it, the plan does. The gate refuses it.
-- @ast: none
-- @plan: orders
-- @why: the table name is a string argument; the plan binds it
-- @problems: SQL_NOT_SELECT
SELECT * FROM query_table('orders')
