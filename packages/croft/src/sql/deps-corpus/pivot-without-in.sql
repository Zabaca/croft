-- Without an IN list a PIVOT's columns depend on the data. DuckDB 2.0 counts it as one statement but cannot serialize it.
-- @ast: none
-- @plan: orders
-- @problems: PIVOT_NEEDS_VALUES
-- @why: the asset is refused (PIVOT_NEEDS_VALUES) before its AST is read; DuckDB 2.0 still plans the PIVOT as one statement
PIVOT orders ON product USING sum(amount)
