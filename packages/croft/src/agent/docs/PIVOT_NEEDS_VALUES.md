# PIVOT_NEEDS_VALUES: a PIVOT that does not list its values

PIVOT example_sales ON region USING sum(amount) makes one column per distinct region, so its columns depend on
the data: DuckDB looks the values up first, and cannot describe the statement before it runs. croft could neither
check it, nor bind it, nor know the table's columns, so a PIVOT in an SQL asset lists its values. In croft query
the same PIVOT is QUERY_NOT_SELECT, with the same fix in its hint.

What to do, either way:
- List the values the pivot makes columns of:
    PIVOT example_sales ON region IN ('East', 'North', 'South', 'West') USING sum(amount) GROUP BY product
- Or write the columns out with FILTER:
    SELECT product,
           sum(amount) FILTER (WHERE region = 'East')  AS east,
           sum(amount) FILTER (WHERE region = 'North') AS north
    FROM example_sales
    GROUP BY product

A value that is not listed is left out, so a new value in the data adds no column by itself. croft query
"select distinct region from example_sales" shows the values there are now.
