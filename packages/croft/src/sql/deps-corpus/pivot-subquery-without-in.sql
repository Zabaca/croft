-- The same inside a subquery.
-- @ast: none
-- @plan: customers, orders
-- @problems: PIVOT_NEEDS_VALUES
-- @why: the asset is refused (PIVOT_NEEDS_VALUES) before its AST is read; DuckDB 2.0 still plans the PIVOT as one statement
SELECT p.*, c.name
FROM (PIVOT orders ON product USING sum(amount) GROUP BY customer_id) AS p
JOIN customers c ON c.id = p.customer_id
