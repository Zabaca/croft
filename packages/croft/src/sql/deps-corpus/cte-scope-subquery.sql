-- A CTE named like a table, inside a subquery: the outer query still reads the table orders.
-- @ast: orders
-- @plan: orders
-- @problems: none
SELECT * FROM orders WHERE id IN (WITH orders AS (SELECT 1 AS id) SELECT id FROM orders)
