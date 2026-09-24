-- main. is the one prefix an asset may write.
-- @ast: orders, customers
-- @plan: customers, orders
-- @problems: none
SELECT * FROM main.orders JOIN MAIN.customers ON customers.id = orders.customer_id
