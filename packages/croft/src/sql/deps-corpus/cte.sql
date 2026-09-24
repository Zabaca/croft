-- A CTE over a table, read twice by the outer query: the CTE's name is not an input.
-- @ast: orders
-- @plan: orders
-- @problems: none
-- key: id
WITH recent AS (SELECT * FROM orders WHERE amount > 0)
SELECT r.id, r.amount FROM recent AS r JOIN recent AS r2 USING (id)
