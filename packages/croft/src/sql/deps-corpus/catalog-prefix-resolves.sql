-- A prefix naming the database itself resolves (memory is the shadow catalog's name, as warehouse would be
-- the project's), so the plan scans orders while the AST leaves it out: CATALOG_PREFIX makes the author drop it.
-- @ast: none
-- @plan: orders
-- @why: relationNames skips catalog-qualified names; the plan resolves them
-- @problems: CATALOG_PREFIX
SELECT * FROM memory.main.orders
