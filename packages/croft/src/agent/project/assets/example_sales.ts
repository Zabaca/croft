// An example file ingest: this file makes the table example_sales from files/example_sales.csv, so the
// first run needs no network. Try: croft run example_sales, then croft query "from example_sales limit 5".
// To bring in your own data, start from a template: croft new --list. Delete this file when you no longer need it.
import { ingest } from "@zabaca/croft";

export default ingest({
  description: "Example sales orders (sample data from croft init)",
  file: "files/example_sales.csv",
  key: "order_id",                          // one row per order; a changed order replaces its old row
  checks: ["not_null(order_date, customer)", "quantity > 0", "amount >= 0", "min_rows(100)"],
});
