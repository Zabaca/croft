-- A non-recursive CTE's body reads the table of its own name; the outer query reads the CTE.
-- @ast: orders
-- @plan: orders
-- @problems: none
WITH orders AS (SELECT * FROM orders WHERE amount > 0)
SELECT id, amount FROM orders
