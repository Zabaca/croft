-- A CTE's name hides a table only in its own query; the second branch reads the table customers.
-- @ast: none
-- @plan: customers
-- @why: the AST walk keeps no scopes, so a CTE name hides the table everywhere; the plan respects scopes
-- @problems: none
SELECT id FROM (WITH customers AS (SELECT 1 AS id) SELECT id FROM customers)
UNION ALL
SELECT id FROM customers
