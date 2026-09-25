# QUERY_NOT_SELECT: croft query or ctx.query was given something other than one SELECT

croft query runs exactly one read-only statement: a SELECT (a FROM-first query, CTEs, UNION and window functions
included), or DESCRIBE, SUMMARIZE or SHOW. The same holds for ctx.query in asset code, which also needs its SQL
as a string. QUERY_NOT_SELECT means the text was something else:
- a statement that changes data or the database: INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, COPY, ATTACH,
  EXPORT, SET, INSTALL and the like;
- more than one statement (two SELECTs separated by ;);
- ctx.query called with something that is not a string.

Nothing ran. (An SQL asset that is not one SELECT is SQL_NOT_SELECT; SQL that does not parse is SQL_SYNTAX.)

What to do:
- To look at data: one SELECT per croft query. Run several queries for several questions.
- To change data: croft never writes through query. Tables change through their assets: edit the asset, then
  croft run <asset>. Removing rows is croft delete <asset> --where "<condition>", which moves them to the trash
  and asks for a confirmation first: ask the user before you run it.
- To keep a result as a table: make it an SQL asset (croft docs sql). To export, read the --json output.
