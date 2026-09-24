-- A table macro over a CTE of a table's name reads the CTE.
-- @ast: none
-- @plan: none
-- @problems: none
WITH orders AS (SELECT 5 AS amount)
SELECT * FROM histogram(orders, amount)
