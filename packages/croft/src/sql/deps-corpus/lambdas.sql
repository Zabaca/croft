-- Lambda parameters are not tables, even one named like a table.
-- @ast: orders
-- @plan: orders
-- @problems: none
SELECT
  id,
  list_transform(tags, t -> upper(t)) AS upper_tags,
  list_filter(tags, customers -> customers <> '') AS kept
FROM orders
