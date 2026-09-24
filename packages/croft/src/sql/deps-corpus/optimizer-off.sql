-- WHERE false and LIMIT 0: the optimizer would prune both scans; with it off the plan keeps them.
-- @ast: orders, refunds
-- @plan: orders, refunds
-- @problems: none
SELECT id FROM orders WHERE false
UNION ALL
(SELECT order_id FROM refunds LIMIT 0)
