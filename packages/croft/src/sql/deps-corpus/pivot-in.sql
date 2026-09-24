-- A PIVOT with an IN list is one SELECT.
-- @ast: orders
-- @plan: orders
-- @problems: none
-- key: customer_id
PIVOT orders ON product IN ('pro', 'basic') USING sum(amount) GROUP BY customer_id
