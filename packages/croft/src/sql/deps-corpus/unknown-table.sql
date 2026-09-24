-- A table that does not exist: the AST still names it; the plan does not bind (the bind check reports it).
-- @ast: orders, missing
-- @plan: null
-- @problems: none
SELECT * FROM orders JOIN missing USING (id)
