-- A catalog prefix: DuckDB would report the table as main.orders; croft cannot track another database.
-- @ast: none
-- @plan: null
-- @problems: CATALOG_PREFIX
SELECT * FROM other.main.orders
