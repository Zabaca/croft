-- A file table function, with a glob.
-- @ast: none
-- @plan: null
-- @problems: SQL_READS_FILES
SELECT * FROM read_parquet('files/sales/*.parquet')
