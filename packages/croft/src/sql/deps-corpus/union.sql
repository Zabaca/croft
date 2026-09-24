-- Set operations: every branch is an input.
-- @ast: orders, refunds, customers
-- @plan: customers, orders, refunds
-- @problems: none
SELECT id FROM orders
UNION
SELECT order_id FROM refunds
EXCEPT
SELECT id FROM customers
