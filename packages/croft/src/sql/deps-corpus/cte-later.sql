-- A CTE is in scope in the CTEs after it only: the first one reads the table customers.
-- @ast: customers
-- @plan: customers
-- @problems: none
WITH recent AS (SELECT * FROM customers), customers AS (SELECT 1 AS id)
SELECT * FROM recent
