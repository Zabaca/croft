// The shop every current task starts from: a small web shop's API (orders and their line items, behind a bearer
// token), two API ingests over it, and the numbers a correct pipeline must produce. Fixed data, so a verifier's
// expected rows are computed here, never read back from what the agent built.
//
// The data has traps for plausible wrong fixes: every day has at least one paid order with several line items (a
// join fans out), and 2026-09-17 has two paid orders with the same total (sum(DISTINCT total) is wrong there).
import type { Fixture } from "../harness.ts";

export const SHOP_TOKEN = "shop_test_4f8a2c9e1b7d5a63";

export const PRICES = { mug: 1250, tee: 2400, sticker: 300, cap: 1800, poster: 1500 } as const;
type Sku = keyof typeof PRICES;

export interface ShopOrder { id: number; customer_id: string; status: "paid" | "refunded" | "pending"; total_cents: number; order_date: string }
export interface ShopItem { id: number; order_id: number; sku: Sku; quantity: number; price_cents: number }

type Line = [Sku, number];
const RAW: [number, string, ShopOrder["status"], string, Line[]][] = [
  [101, "C-1001", "paid", "2026-09-15", [["mug", 2], ["sticker", 3]]],
  [102, "C-1002", "paid", "2026-09-15", [["tee", 1]]],
  [103, "C-1003", "refunded", "2026-09-15", [["cap", 1], ["mug", 1]]],
  [104, "C-1001", "paid", "2026-09-16", [["poster", 1], ["sticker", 1]]],
  [105, "C-1004", "pending", "2026-09-16", [["tee", 2]]],
  [106, "C-1005", "paid", "2026-09-16", [["cap", 1], ["tee", 1], ["mug", 1]]],
  [107, "C-1002", "paid", "2026-09-17", [["mug", 1], ["sticker", 2]]],
  [108, "C-1003", "paid", "2026-09-17", [["mug", 1], ["sticker", 2]]],
  [109, "C-1004", "paid", "2026-09-17", [["tee", 1], ["cap", 1]]],
  [110, "C-1001", "refunded", "2026-09-17", [["poster", 2]]],
  [111, "C-1005", "paid", "2026-09-18", [["sticker", 5]]],
  [112, "C-1002", "paid", "2026-09-18", [["cap", 2], ["poster", 1]]],
  [113, "C-1003", "pending", "2026-09-18", [["mug", 1]]],
  [114, "C-1004", "paid", "2026-09-18", [["tee", 1], ["mug", 2], ["sticker", 1]]],
  [115, "C-1001", "paid", "2026-09-19", [["mug", 1]]],
  [116, "C-1005", "refunded", "2026-09-19", [["tee", 1], ["sticker", 1]]],
  [117, "C-1002", "paid", "2026-09-19", [["poster", 1], ["cap", 1]]],
];

export const ITEMS: ShopItem[] = [];
export const ORDERS: ShopOrder[] = RAW.map(([id, customer_id, status, order_date, lines]) => {
  let total = 0;
  for (const [sku, quantity] of lines) {
    const price_cents = PRICES[sku];
    total += price_cents * quantity;
    ITEMS.push({ id: 5000 + ITEMS.length + 1, order_id: id, sku, quantity, price_cents });
  }
  return { id, customer_id, status, total_cents: total, order_date };
});

export const PAID = ORDERS.filter((o) => o.status === "paid");

/** Per day, over paid orders: orders, revenue in cents, items (sum of quantities). The correct daily_revenue. */
export function dailyRevenue(): { day: string; orders: number; cents: number; items: number }[] {
  const by = new Map<string, { day: string; orders: number; cents: number; items: number }>();
  for (const o of PAID) {
    const d = by.get(o.order_date) ?? { day: o.order_date, orders: 0, cents: 0, items: 0 };
    d.orders++;
    d.cents += o.total_cents;
    d.items += ITEMS.filter((i) => i.order_id === o.id).reduce((n, i) => n + i.quantity, 0);
    by.set(o.order_date, d);
  }
  return [...by.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** What the fan-out join reports for a day: every order counted and summed once per line item. */
export function fannedOut(day: string): { orders: number; cents: number } {
  let orders = 0;
  let cents = 0;
  for (const o of PAID.filter((p) => p.order_date === day)) {
    const n = ITEMS.filter((i) => i.order_id === o.id).length;
    orders += n;
    cents += o.total_cents * n;
  }
  return { orders, cents };
}

/** Per customer, over paid orders: orders and revenue in cents. The correct customer_revenue. */
export function customerRevenue(): { customer: string; orders: number; cents: number }[] {
  const by = new Map<string, { customer: string; orders: number; cents: number }>();
  for (const o of PAID) {
    const c = by.get(o.customer_id) ?? { customer: o.customer_id, orders: 0, cents: 0 };
    c.orders++;
    c.cents += o.total_cents;
    by.set(o.customer_id, c);
  }
  return [...by.values()].sort((a, b) => a.customer.localeCompare(b.customer));
}

export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const ordersAsset = (base: string) => `// assets/shop_orders.ts: one row per order from the shop API
import { ingest } from "@zabaca/croft";

type Order = { id: number; customer_id: string; status: "paid" | "refunded" | "pending"; total_cents: number; order_date: string };

export default ingest({
  description: "Shop orders: status is paid, refunded or pending; total_cents is the order total in cents",
  secrets: ["SHOP_TOKEN"],
  key: "id",

  async *rows({ http, secret }) {
    const res = await http.get("${base}/v1/orders", {
      headers: { Authorization: \`Bearer \${secret("SHOP_TOKEN")}\` },
    });
    yield res.json<Order[]>();
  },
});
`;

const itemsAsset = (base: string) => `// assets/shop_order_items.ts: the line items of every order (several per order)
import { ingest } from "@zabaca/croft";

type Item = { id: number; order_id: number; sku: string; quantity: number; price_cents: number };

export default ingest({
  description: "Shop order line items: one row per product in an order; price_cents is the unit price",
  secrets: ["SHOP_TOKEN"],
  key: "id",

  async *rows({ http, secret }) {
    const res = await http.get("${base}/v1/order_items", {
      headers: { Authorization: \`Bearer \${secret("SHOP_TOKEN")}\` },
    });
    yield res.json<Item[]>();
  },
});
`;

/** The shop's routes on the fixture's mock API, its secret in .env, and its two ingests. */
export function setupShop(f: Fixture): void {
  const auth = (req: Request) => req.headers.get("authorization") === `Bearer ${SHOP_TOKEN}`;
  const unauthorized = () => Response.json({ error: "invalid token" }, { status: 401 });
  f.api.route("/v1/orders", (req) => (auth(req) ? Response.json(ORDERS) : unauthorized()));
  f.api.route("/v1/order_items", (req) => (auth(req) ? Response.json(ITEMS) : unauthorized()));
  f.secret("SHOP_TOKEN", SHOP_TOKEN);
  f.write("assets/shop_orders.ts", ordersAsset(f.api.url));
  f.write("assets/shop_order_items.ts", itemsAsset(f.api.url));
}
