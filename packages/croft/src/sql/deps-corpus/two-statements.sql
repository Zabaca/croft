-- Two statements: prepare() refuses them, and so does the gate.
-- @ast: none
-- @plan: null
-- @problems: SQL_NOT_ONE_STATEMENT
SELECT * FROM orders; SELECT * FROM customers
