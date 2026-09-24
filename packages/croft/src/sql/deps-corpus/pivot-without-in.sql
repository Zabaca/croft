-- Without an IN list DuckDB rewrites a PIVOT into two statements whose columns depend on the data.
-- @ast: none
-- @plan: null
-- @problems: PIVOT_NEEDS_VALUES
PIVOT orders ON product USING sum(amount)
