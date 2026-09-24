-- DESCRIBE reads the catalog, not the table: the AST names orders, the plan scans nothing. Not an asset.
-- @ast: orders
-- @plan: none
-- @why: DESCRIBE's plan is a column data scan of the catalog
-- @problems: SQL_NOT_SELECT
DESCRIBE orders
