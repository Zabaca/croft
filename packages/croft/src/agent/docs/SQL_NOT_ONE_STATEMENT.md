# SQL_NOT_ONE_STATEMENT: more than one statement, or none

croft runs exactly one statement, in an SQL asset's body and in croft query. "found 2 statements" means the
text holds a second statement after a `;`. One trailing `;` is fine, and so is a trailing comment.

What to do:
- Combine the queries into one: a CTE (WITH a AS (...), b AS (...) SELECT ...), a subquery, or UNION ALL.
- Two tables are two assets: one file in assets/ makes one table.
- "found no SQL statement": the file or query is empty, or only comments. Write the SELECT.
- A PIVOT without an IN list is one statement whose columns depend on the data: croft query refuses it as
  QUERY_NOT_SELECT, and an SQL asset reports PIVOT_NEEDS_VALUES. List the values:
  PIVOT t ON region IN ('East', 'West') USING sum(amount).
