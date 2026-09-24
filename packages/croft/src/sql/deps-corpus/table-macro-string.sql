-- A table macro's table as a string, or as source :=.
-- @ast: orders, customers
-- @plan: customers, orders
-- @problems: none
SELECT * FROM histogram_values('orders', amount)
UNION ALL
SELECT * FROM histogram_values(col_name := id, source := 'customers')
