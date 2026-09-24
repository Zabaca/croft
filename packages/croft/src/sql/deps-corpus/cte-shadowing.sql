-- A CTE named like a table hides it; main.orders inside it still names the table.
-- @ast: orders
-- @plan: orders
-- @problems: none
WITH orders AS (SELECT * FROM main.orders WHERE amount > 0)
SELECT id, amount FROM orders
