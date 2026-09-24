-- query() runs SQL given as a string: the AST cannot see its tables, the plan does. The gate refuses it.
-- @ast: none
-- @plan: customers
-- @why: the SQL is a string argument; the plan binds it
-- @problems: SQL_NOT_SELECT
SELECT * FROM query('SELECT * FROM customers')
