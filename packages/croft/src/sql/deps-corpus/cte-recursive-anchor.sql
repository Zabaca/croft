-- A recursive CTE reads itself in its recursive part only; its anchor reads the table orders.
-- @ast: orders
-- @plan: orders
-- @problems: none
WITH RECURSIVE orders AS (SELECT id FROM orders WHERE id = 1 UNION ALL SELECT id + 1 FROM orders WHERE id < 3)
SELECT * FROM orders
