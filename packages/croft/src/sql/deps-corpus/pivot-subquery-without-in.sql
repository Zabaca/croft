-- The same inside a subquery.
-- @ast: none
-- @plan: null
-- @problems: PIVOT_NEEDS_VALUES
SELECT p.*, c.name
FROM (PIVOT orders ON product USING sum(amount) GROUP BY customer_id) AS p
JOIN customers c ON c.id = p.customer_id
