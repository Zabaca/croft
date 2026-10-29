-- Lambda parameters are not tables, even one named like a table.
-- @ast: orders
-- @plan: orders
-- @problems: none
SELECT
  id,
  list_transform(tags, lambda t: upper(t)) AS upper_tags,
  list_filter(tags, lambda customers: customers <> '') AS kept
FROM orders
