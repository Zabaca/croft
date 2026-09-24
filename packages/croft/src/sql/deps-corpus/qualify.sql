-- QUALIFY with a window.
-- @ast: orders
-- @plan: orders
-- @problems: none
-- key: customer_id
SELECT customer_id, id AS latest_order
FROM orders
QUALIFY row_number() OVER (PARTITION BY customer_id ORDER BY created_at DESC) = 1
