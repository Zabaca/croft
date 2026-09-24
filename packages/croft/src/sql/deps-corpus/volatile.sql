-- Volatile functions are a warning; the dependencies are unaffected.
-- @ast: orders
-- @plan: orders
-- @problems: VOLATILE_SQL
SELECT id, now() AS seen_at FROM orders WHERE created_at < current_date
