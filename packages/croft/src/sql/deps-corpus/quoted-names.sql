-- Quoted and mixed-case table names are ASCII-lowercased.
-- @ast: orders, customers
-- @plan: customers, orders
-- @problems: none
SELECT * FROM "Orders" JOIN Customers ON Customers.id = "Orders".customer_id
