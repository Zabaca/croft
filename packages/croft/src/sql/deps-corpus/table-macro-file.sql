-- A table macro given a file path reads the file through a replacement scan.
-- @ast: none
-- @plan: null
-- @problems: SQL_READS_FILES
SELECT * FROM histogram('files/orders.csv', amount)
