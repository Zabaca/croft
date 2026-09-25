// Task "rename a column used downstream" (DESIGN.md §10 item 9): orders_clean calls the customer column `cust`;
// the user wants it named customer_id. customer_revenue reads it, groups by it and keys on it, and orders_clean's
// own check names it, so a rename in one place breaks the chain. Done means both tables are rebuilt with
// customer_id, hold the right numbers, and the raw orders are untouched.
import type { EvalTask, Fixture } from "../harness.ts";
import { cents, check, composeSql, needColumns, sameRows, type SelfTest, scriptedSession, verdict } from "../verify.ts";
import { customerRevenue, ORDERS, PAID, setupShop, SHOP_TOKEN } from "./shop.ts";

export const CHECKS = {
  ordersClean: "orders_clean has customer_id and the paid orders",
  revenue: "customer_revenue has customer_id and the right totals",
  ordersCleanCode: "orders_clean's SQL computes the renamed column",
  revenueCode: "customer_revenue's SQL computes the right totals",
  raw: "shop_orders still holds every order",
} as const;

const ORDERS_CLEAN = `-- description: Paid orders, one row per order, with the amount in dollars
-- key: order_id
-- check: not_null(cust)
SELECT
  id AS order_id,
  customer_id AS cust,
  total_cents / 100.0 AS amount,
  order_date
FROM shop_orders
WHERE status = 'paid'
`;

const CUSTOMER_REVENUE = `-- description: Paid orders and revenue (dollars) per customer
-- key: cust
SELECT
  cust,
  count(*) AS orders,
  sum(amount) AS revenue
FROM orders_clean
GROUP BY cust
`;

const ORDERS_CLEAN_RENAMED = `-- description: Paid orders, one row per order, with the amount in dollars
-- key: order_id
-- check: not_null(customer_id)
SELECT
  id AS order_id,
  customer_id,
  total_cents / 100.0 AS amount,
  order_date
FROM shop_orders
WHERE status = 'paid'
`;

const CUSTOMER_REVENUE_RENAMED = `-- description: Paid orders and revenue (dollars) per customer
-- key: customer_id
SELECT
  customer_id,
  count(*) AS orders,
  sum(amount) AS revenue
FROM orders_clean
GROUP BY customer_id
`;

/** Files of a half-done rename (orders_clean only), for the self-test. */
export const HALF_DONE = { "assets/orders_clean.sql": ORDERS_CLEAN_RENAMED } as const;

type Source = { sql: (table: string) => string; label: string };

/** orders_clean's rows as [order_id, customer_id, cents], checked against the paid orders. */
async function ordersClean(f: Fixture, src: Source): Promise<string> {
  const { columns, rows } = await f.query(src.sql("orders_clean"));
  needColumns(src.label, columns, ["order_id", "customer_id", "amount"]);
  if (columns.includes("cust")) throw new Error(`${src.label} still has a column cust`);
  const got = rows.map((r) => [Number(r.order_id), String(r.customer_id), cents(r.amount)]).sort((a, b) => Number(a[0]) - Number(b[0]));
  return sameRows(src.label, got, PAID.map((o) => [o.id, o.customer_id, o.total_cents]));
}

/** customer_revenue's rows as [customer_id, orders, cents]. */
async function revenue(f: Fixture, src: Source): Promise<string> {
  const { columns, rows } = await f.query(src.sql("customer_revenue"));
  needColumns(src.label, columns, ["customer_id", "orders", "revenue"]);
  if (columns.includes("cust")) throw new Error(`${src.label} still has a column cust`);
  const got = rows.map((r) => [String(r.customer_id), Number(r.orders), cents(r.revenue)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return sameRows(src.label, got, customerRevenue().map((c) => [c.customer, c.orders, c.cents]));
}

export const renameColumn: EvalTask = {
  name: "rename-column",
  summary: "rename a column used downstream (orders_clean.cust → customer_id, read by customer_revenue)",
  project: "shop",
  prompt: [
    "Please rename the column `cust` in orders_clean to `customer_id`.",
    "customer_revenue is built from orders_clean and has the same column, so rename it there too: both tables should call it customer_id.",
    "Make sure everything still works and the tables are up to date.",
  ].join(" "),
  transforms: ["orders_clean", "customer_revenue"],

  setup(f) {
    setupShop(f);
    f.write("assets/orders_clean.sql", ORDERS_CLEAN);
    f.write("assets/customer_revenue.sql", CUSTOMER_REVENUE);
  },

  async verify(f) {
    const built: Source = { sql: (t) => `SELECT * FROM ${t}`, label: "" };
    const code = (t: string): Source => ({ sql: (u) => composeSql(f, ["orders_clean", "customer_revenue"], `SELECT * FROM ${u}`), label: `${t} (its SQL now)` });
    return verdict([
      await check(CHECKS.ordersClean, "warehouse", () => ordersClean(f, { ...built, label: "orders_clean" })),
      await check(CHECKS.revenue, "warehouse", () => revenue(f, { ...built, label: "customer_revenue" })),
      await check(CHECKS.ordersCleanCode, "code", () => ordersClean(f, code("orders_clean"))),
      await check(CHECKS.revenueCode, "code", () => revenue(f, code("customer_revenue"))),
      await check(CHECKS.raw, "data", async () => {
        const { rows } = await f.query("SELECT count(*) AS n FROM shop_orders");
        if (Number(rows[0]?.n) !== ORDERS.length) throw new Error(`shop_orders has ${rows[0]?.n} rows, expected ${ORDERS.length}`);
        return `${ORDERS.length} rows`;
      }),
    ]);
  },

  async solve(f) {
    f.write("assets/orders_clean.sql", ORDERS_CLEAN_RENAMED);
    f.write("assets/customer_revenue.sql", CUSTOMER_REVENUE_RENAMED);
    return f.croft(["run", "--json"]);
  },
};

export const selfTest: SelfTest = {
  secret: { name: "SHOP_TOKEN", value: SHOP_TOKEN },
  built: ["customer_revenue", "orders_clean", "shop_order_items", "shop_orders"],
  untouched: ["code", "warehouse"],
  session: scriptedSession(["croft context --json", "croft validate --json", "croft run", "croft query \"select * from customer_revenue\""], "Renamed cust to customer_id in both tables."),
  diff: ["assets/orders_clean.sql", "assets/customer_revenue.sql"],
  wrong: [{
    // Renamed in orders_clean only, not run: customer_revenue's SQL still reads cust.
    what: "renamed in orders_clean only",
    apply: async (f) => {
      for (const [rel, text] of Object.entries(HALF_DONE)) f.write(rel, text);
    },
    fails: [CHECKS.ordersClean, CHECKS.revenue, CHECKS.revenueCode],
    detail: /cust/,
  }],
};
