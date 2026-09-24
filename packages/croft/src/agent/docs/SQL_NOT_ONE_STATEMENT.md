# SQL_NOT_ONE_STATEMENT: more than one statement, or none

croft runs exactly one statement, in an SQL asset's body and in croft query. "found 2 statements" means the
text holds a second statement after a `;`. One trailing `;` is fine, and so is a trailing comment.

What to do:
- Combine the queries into one: a CTE (WITH a AS (...), b AS (...) SELECT ...), a subquery, or UNION ALL.
- Two tables are two assets: one file in assets/ makes one table.
- "found no SQL statement": the file or query is empty, or only comments. Write the SELECT.
- In croft query, a PIVOT without an IN list also counts as 2 statements (DuckDB runs it as two); list the
  values: PIVOT t ON region IN ('East', 'West') USING sum(amount). An SQL asset reports that as
  PIVOT_NEEDS_VALUES.
