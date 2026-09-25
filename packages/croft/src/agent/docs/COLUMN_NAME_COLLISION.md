# COLUMN_NAME_COLLISION: two fields clean to the same column name (warning)

croft cleans field names into column names: lowercase, words joined by _ ("Order ID" and "orderId" both become
order_id). When two fields of the same rows clean to one name, the second is stored under a new name with a
suffix (order_id_2), so no value is lost. details: column, field (the second field's raw name), storedAs.

The rows were written, with both columns. But SQL that reads order_id may be reading the one you did not mean,
and the suffix depends on which field came first.

What to do: rename one of the fields in rows() or map() so each has a clear name of its own, for example
{ ...row, legacy_order_id: row["Order ID"] } and drop the original. Then croft preview <asset> shows the columns.
