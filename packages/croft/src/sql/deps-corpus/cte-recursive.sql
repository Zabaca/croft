-- A recursive CTE reads itself; only orders is a table.
-- @ast: orders
-- @plan: orders
-- @problems: none
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3)
SELECT n.i, orders.id FROM n, orders
