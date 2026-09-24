-- Tables in IN, EXISTS, scalar, derived and LATERAL subqueries (the AST lists the select list's first).
-- @ast: refunds, products, orders, customers
-- @plan: customers, orders, products, refunds
-- @problems: none
SELECT
  o.id,
  (SELECT count(*) FROM refunds r WHERE r.order_id = o.id) AS refund_count,
  EXISTS (SELECT 1 FROM products p WHERE p.name = o.product) AS known_product,
  c.name
FROM (SELECT * FROM orders WHERE amount > 0) AS o
JOIN LATERAL (SELECT name FROM customers WHERE customers.id = o.customer_id) AS c ON true
WHERE o.id IN (SELECT order_id FROM refunds)
