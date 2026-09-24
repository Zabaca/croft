// Task "why is this number wrong" (DESIGN.md §10 item 9): daily_revenue joins orders to their line items to count
// items, and so counts and sums every order once per line item. The user reports one day's numbers against the
// payment dashboard. Done means daily_revenue is right for every day, rebuilt, with the raw data and the ingests
// untouched. sum(DISTINCT total_cents) is a wrong fix: two paid orders on 2026-09-17 have the same total.
import type { EvalTask, Fixture } from "../harness.ts";
import { cents, check, composeSql, needColumns, sameRows, unchanged, verdict } from "../verify.ts";
import { dailyRevenue, dollars, fannedOut, ITEMS, ORDERS, setupShop } from "./shop.ts";

const DAILY_REVENUE = `-- description: Paid orders, revenue (dollars) and items sold per day
-- key: day
SELECT
  o.order_date AS day,
  count(*) AS orders,
  sum(o.total_cents) / 100.0 AS revenue,
  sum(i.quantity) AS items
FROM shop_orders o
JOIN shop_order_items i ON i.order_id = o.id
WHERE o.status = 'paid'
GROUP BY o.order_date
`;

const FIXED = `-- description: Paid orders, revenue (dollars) and items sold per day
-- key: day
WITH order_items AS (
  SELECT order_id, sum(quantity) AS quantity
  FROM shop_order_items
  GROUP BY order_id
)
SELECT
  o.order_date AS day,
  count(*) AS orders,
  sum(o.total_cents) / 100.0 AS revenue,
  sum(i.quantity) AS items
FROM shop_orders o
JOIN order_items i ON i.order_id = o.id
WHERE o.status = 'paid'
GROUP BY o.order_date;
`;

/** A plausible wrong fix, for the self-test: count(DISTINCT o.id) is right, but sum(DISTINCT o.total_cents) drops
 *  one of the two paid orders with the same total on 2026-09-17. */
export const DISTINCT_FIX = DAILY_REVENUE.replace("count(*)", "count(DISTINCT o.id)").replace("sum(o.total_cents)", "sum(DISTINCT o.total_cents)");

const DAY = "2026-09-18";
const INGESTS = ["assets/shop_orders.ts", "assets/shop_order_items.ts"];

/** daily_revenue's rows as [day, orders, cents, items], by day. */
async function daily(f: Fixture, sql: string, label: string): Promise<string> {
  const { columns, rows } = await f.query(sql);
  needColumns(label, columns, ["day", "orders", "revenue", "items"]);
  const got = rows.map((r) => [String(r.day), Number(r.orders), cents(r.revenue), Number(r.items)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return sameRows(label, got, dailyRevenue().map((d) => [d.day, d.orders, d.cents, d.items]));
}

function prompt(): string {
  const wrong = fannedOut(DAY);
  const right = dailyRevenue().find((d) => d.day === DAY)!;
  return [
    `Something is off with daily_revenue. On ${DAY} it says we made ${dollars(wrong.cents)} from ${wrong.orders} orders,`,
    `but our payment dashboard shows ${dollars(right.cents)} from ${right.orders} paid orders that day.`,
    "The raw data in shop_orders and shop_order_items is correct.",
    "Please find out why daily_revenue is wrong and fix it, for every day.",
  ].join(" ");
}

export const wrongNumber: EvalTask = {
  name: "wrong-number",
  summary: "find and fix a fan-out join that inflates a daily revenue transform",
  project: "shop",
  prompt: prompt(),
  transforms: ["daily_revenue"],

  setup(f) {
    setupShop(f);
    f.write("assets/daily_revenue.sql", DAILY_REVENUE);
  },

  async verify(f) {
    return verdict([
      await check("daily_revenue is right for every day", "warehouse", () => daily(f, "SELECT * FROM daily_revenue", "daily_revenue")),
      await check("daily_revenue's SQL computes the right numbers", "code", () =>
        daily(f, composeSql(f, ["daily_revenue"], "SELECT * FROM daily_revenue"), "daily_revenue (its SQL now)")),
      await check("the raw orders and items are intact", "data", async () => {
        const { rows } = await f.query("SELECT (SELECT count(*) FROM shop_orders) AS orders, (SELECT count(*) FROM shop_order_items) AS items");
        const r = rows[0] ?? {};
        if (Number(r.orders) !== ORDERS.length || Number(r.items) !== ITEMS.length) {
          throw new Error(`shop_orders has ${r.orders} rows and shop_order_items ${r.items}; expected ${ORDERS.length} and ${ITEMS.length}`);
        }
        return `${ORDERS.length} orders, ${ITEMS.length} items`;
      }),
      await check("the ingests are unchanged", "files", () => unchanged(f, INGESTS)),
    ]);
  },

  async solve(f) {
    f.write("assets/daily_revenue.sql", FIXED);
    return f.croft(["run", "--json"]);
  },
};
