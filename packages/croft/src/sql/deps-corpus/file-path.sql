-- A quoted file path in FROM (a replacement scan): not a table, and an asset may not read files.
-- @ast: orders
-- @plan: null
-- @problems: SQL_READS_FILES
SELECT * FROM 'files/sales.csv' AS s JOIN orders ON orders.id = s.order_id
