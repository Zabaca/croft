-- A CTE's name hides a table only in its own query; the second branch reads the table customers.
-- @ast: customers
-- @plan: customers
-- @problems: none
SELECT id FROM (WITH customers AS (SELECT 1 AS id) SELECT id FROM customers)
UNION ALL
SELECT id FROM customers
