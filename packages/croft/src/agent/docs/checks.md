# Checks: rules every write must pass, the same in TypeScript and SQL

A check is a rule about an asset's rows. Blocking checks run inside the write, after the rows are in place and
before the commit: when one fails, nothing is written, the table keeps its previous rows, and the run exits 3
(when checks were all that failed). Warnings run after the write and only report. Every kind of asset has them,
ingests included.

  TypeScript (ingest or transform)   checks: ["unique(email)", "amount >= 0"], warnings: ["min_rows(100)"]
  SQL asset header                   -- check: amount >= 0   and   -- warn: min_rows(100), one per line

## The language

- unique(a, b): no two rows share these values (rows with a NULL in them are left out). Looks at the whole
  table after the write.
- not_null(a, b): none of these columns is NULL. Looks at the rows this write added or changed.
- min_rows(n): the table has at least n rows after the write.
- Any boolean SQL expression over the asset's columns, such as amount >= 0, state IN ('open', 'closed') or
  closed_at >= created_at: every row makes it true. Looks at the rows this write added or changed.

- A key implies unique(key) and not_null(key); there is no need to write them.
- NULL passes a rule: `amount >= 0` lets a NULL amount through. Add not_null(amount) when NULL is wrong too.
- One check is one condition. Join conditions with AND, or write two checks.
- A new or edited check looks at the whole table the first time it runs, not only the new rows.
- A rule may read other tables in a subquery: `customer_id IN (SELECT id FROM customers)`. croft builds the
  tables it names before this asset.
- A check may not read files, call table functions that read files or run SQL text, use parameters ($1, ?) or
  contain a `;`: those are CHECK_INVALID, and so is a check that names a column the asset does not have.
- In an incremental TypeScript transform, which commits in chunks (croft docs transforms), each chunk runs the
  checks on its own rows, and min_rows is judged on the finished table at the end of the run.

## Examples

```ts
// assets/orders.ts
import { ingest } from "@zabaca/croft";

export default ingest({
  description: "Shop orders, from the daily exports",
  file: "files/orders/*.csv",
  incremental: true,
  key: "order_id",                                  // also checks unique(order_id) and not_null(order_id)
  checks: ["not_null(order_date, customer)", "quantity > 0", "amount >= 0"],
  warnings: ["min_rows(100)", "order_date >= DATE '2020-01-01'"],
});
```

```sql
-- assets/customer_revenue.sql
-- description: Revenue per customer
-- key: customer
-- check: orders > 0
-- check: revenue >= 0
-- warn: revenue < 1000000
SELECT customer, count(*) AS orders, sum(amount) AS revenue
FROM example_sales
GROUP BY customer
```

## When a blocking check fails

    error CHECK_FAILED  assets/open_issues.sql
          not_null(author): 3 of 4,211 rows
            id=2291  title="Crash on Windows when …"  author=NULL
            id=2307  title="bun test hangs with …"  author=NULL
          fix: correct assets/open_issues.sql or the data, then: croft run open_issues
          effect: nothing was written; open_issues keeps its previous 4,208 rows

The message shows 3 sample rows. In --json, the problem's details have check, failing (how many rows fail),
checked (how many were looked at), scope ("batch" or "table") and sample (up to 20 rows). Every blocking check
runs, and the others that failed are listed as "also failing".

1. Read the sample rows (croft logs <asset> --failed shows them too).
2. Decide which is wrong: the asset's code or SQL (fix the file), the source data (fix it upstream, or filter or
   clean those rows in the asset), or the check itself. Weakening or deleting a failing check changes what the
   table promises: ask the user first.
3. Run it again: croft run <asset>. croft preview <asset> shows the check results without writing anything.

A failing warning is a CHECK_FAILED with severity warning: the write stands, and the rows are reported. A check
that cannot run at all is CHECK_INVALID; croft validate --json finds most of those before a run, binding each
check of an SQL asset against the columns its SELECT returns.
