-- A CTE nothing reads: its table is in the AST, but the binder drops the CTE, so the plan never scans it.
-- @ast: refunds, orders
-- @plan: orders
-- @why: the binder drops an unused CTE; the union keeps refunds as an input, which only costs a rebuild
-- @problems: none
WITH unused AS (SELECT * FROM refunds)
SELECT * FROM orders
