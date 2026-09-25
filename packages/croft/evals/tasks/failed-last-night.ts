// Task "the pipeline failed last night, fix it" (DESIGN.md §10 item 9). A shop project whose orders ingest reads
// one page of the shop API's orders: it was written when the shop had fewer than 100 orders, and its Page type even
// names has_more, but rows() never follows it. Last night the shop passed 100 orders. The orders on page 2 never
// arrived, and shop_order_items (from an export endpoint that returns every item at once) failed its blocking check
// `order_id IN (SELECT id FROM shop_orders)`: CHECK_FAILED, nothing written, daily_revenue left stale. The failed
// run is dated last night (CROFT_NOW) and its logs are in place.
//
// Done means the root cause is fixed in code (shop_orders follows the pages), the check is intact, the pipeline
// runs green and every table holds the right rows. Wrong: raising per_page (the API caps it at 100), or removing or
// weakening the check, which turns the run green over missing orders.
import { type EvalTask, type Fixture, show } from "../harness.ts";
import { cents, check, composeSql, croftData, dayOf, healthy, localDay, localTime, needColumns, prng, sameRows, type SelfTest, scriptedSession, verdict } from "../verify.ts";
import { PRICES, SHOP_TOKEN } from "./shop.ts";

type Sku = keyof typeof PRICES;
interface Order { id: number; customer_id: string; status: "paid" | "refunded" | "pending"; total_cents: number; order_date: string }
interface Item { id: number; order_id: number; sku: Sku; quantity: number; price_cents: number }
interface Shop { orders: Order[]; items: Item[]; /** How many orders the API has now (the first ones). */ visible: number }

/** Orders before last night's, and the ones placed last night. */
const EARLIER = 97;
const LAST_NIGHT = 5;
const MAX_PER_PAGE = 100;
const STATE = new WeakMap<Fixture, Shop>();

export const CHECKS = {
  orders: "shop_orders holds every order the shop has",
  items: "shop_order_items holds every line item",
  revenue: "daily_revenue is right for every day",
  revenueCode: "daily_revenue's SQL computes the right numbers",
  pages: "shop_orders's code fetches every page of orders",
  guard: "shop_order_items still refuses items of unknown orders (its check is intact)",
  green: "the pipeline is green: croft status is healthy",
} as const;

/** "Last night" as the user means it: 23:40 of yesterday in the fixture's zone; `daysBefore` nights earlier. */
function lastNight(now = Date.now(), daysBefore = 0): { day: string; at: string } {
  const day = localDay(now - (1 + daysBefore) * 86_400_000);
  return { day, at: localTime(day, "23:40:00") };
}

/** The shop's orders and items, the newest `LAST_NIGHT` orders dated `day` and the rest over the 60 days before. */
function makeShop(day: string): Shop {
  const rand = prng(8675309);
  const skus = Object.keys(PRICES) as Sku[];
  const at = (daysBack: number) => localDay(Date.parse(localTime(day, "12:00:00")) - daysBack * 86_400_000);
  const orders: Order[] = [];
  const items: Item[] = [];
  const total = EARLIER + LAST_NIGHT;
  for (let n = 0; n < total; n++) {
    const id = 1001 + n;
    const r = rand();
    const status: Order["status"] = r < 0.8 ? "paid" : r < 0.9 ? "refunded" : "pending";
    const order_date = n < EARLIER ? at(60 - Math.floor((n * 60) / EARLIER)) : day;
    let total_cents = 0;
    const lines = 1 + Math.floor(rand() * 3);
    const used = new Set<Sku>();
    for (let l = 0; l < lines; l++) {
      const sku = skus[Math.floor(rand() * skus.length)]!;
      if (used.has(sku)) continue;
      used.add(sku);
      const quantity = 1 + Math.floor(rand() * 3);
      items.push({ id: 50_001 + items.length, order_id: id, sku, quantity, price_cents: PRICES[sku] });
      total_cents += PRICES[sku] * quantity;
    }
    orders.push({ id, customer_id: `C-${1001 + Math.floor(rand() * 40)}`, status, total_cents, order_date });
  }
  return { orders, items, visible: EARLIER };
}

/** Per day, over the paid orders the shop has now: orders, revenue in cents, items sold. */
function dailyRevenue(shop: Shop): { day: string; orders: number; cents: number; items: number }[] {
  const by = new Map<string, { day: string; orders: number; cents: number; items: number }>();
  for (const o of shop.orders.slice(0, shop.visible)) {
    if (o.status !== "paid") continue;
    const d = by.get(o.order_date) ?? { day: o.order_date, orders: 0, cents: 0, items: 0 };
    d.orders++;
    d.cents += o.total_cents;
    d.items += shop.items.filter((i) => i.order_id === o.id).reduce((s, i) => s + i.quantity, 0);
    by.set(o.order_date, d);
  }
  return [...by.values()].sort((a, b) => a.day.localeCompare(b.day));
}

const ordersAsset = (base: string, perPage = 100) => `// assets/shop_orders.ts: one row per order from the shop API
import { ingest } from "@zabaca/croft";

type Order = { id: number; customer_id: string; status: "paid" | "refunded" | "pending"; total_cents: number; order_date: string };
type Page = { orders: Order[]; page: number; per_page: number; has_more: boolean };

export default ingest({
  description: "Shop orders: status is paid, refunded or pending; total_cents is the order total in cents",
  secrets: ["SHOP_TOKEN"],
  key: "id",

  async *rows({ http, secret }) {
    const res = await http.get("${base}/v1/orders", {
      headers: { Authorization: \`Bearer \${secret("SHOP_TOKEN")}\` },
      query: { per_page: ${perPage} },
    });
    yield res.json<Page>().orders;
  },
});
`;

const pagedOrdersAsset = (base: string) => `// assets/shop_orders.ts: one row per order from the shop API
import { ingest } from "@zabaca/croft";

type Order = { id: number; customer_id: string; status: "paid" | "refunded" | "pending"; total_cents: number; order_date: string };
type Page = { orders: Order[]; page: number; per_page: number; has_more: boolean };

export default ingest({
  description: "Shop orders: status is paid, refunded or pending; total_cents is the order total in cents",
  secrets: ["SHOP_TOKEN"],
  key: "id",

  async *rows({ http, secret }) {
    // The API pages its orders, at most 100 per page, and says has_more while more pages follow.
    for (let page = 1; ; page++) {
      const res = await http.get("${base}/v1/orders", {
        headers: { Authorization: \`Bearer \${secret("SHOP_TOKEN")}\` },
        query: { per_page: 100, page },
      });
      const body = res.json<Page>();
      yield body.orders;
      if (!body.has_more || body.orders.length === 0) return;
    }
  },
});
`;

const ITEM_CHECK = "order_id IN (SELECT id FROM shop_orders)";
const itemsAsset = (base: string, checks = `checks: ["${ITEM_CHECK}", "quantity > 0"],`) => `// assets/shop_order_items.ts: the line items of every order (several per order)
import { ingest } from "@zabaca/croft";

type Item = { id: number; order_id: number; sku: string; quantity: number; price_cents: number };

export default ingest({
  description: "Shop order line items: one row per product in an order; price_cents is the unit price",
  secrets: ["SHOP_TOKEN"],
  key: "id",
  ${checks}

  async *rows({ http, secret }) {
    // The export endpoint returns every line item in one response.
    const res = await http.get("${base}/v1/exports/order_items", {
      headers: { Authorization: \`Bearer \${secret("SHOP_TOKEN")}\` },
    });
    yield res.json<Item[]>();
  },
});
`;

const DAILY_REVENUE = `-- description: Paid orders, revenue (dollars) and items sold per day
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
GROUP BY o.order_date
`;

function shopRoutes(f: Fixture, shop: Shop): void {
  const auth = (req: Request) => req.headers.get("authorization") === `Bearer ${SHOP_TOKEN}`;
  const unauthorized = () => Response.json({ error: "invalid token" }, { status: 401 });
  f.api.route("/v1/orders", (req, url) => {
    if (!auth(req)) return unauthorized();
    const pageText = url.searchParams.get("page") ?? "1";
    const perText = url.searchParams.get("per_page") ?? "50";
    if (!/^\d+$/.test(pageText) || Number(pageText) < 1) return Response.json({ error: `page must be a whole number from 1, got ${pageText}` }, { status: 400 });
    if (!/^\d+$/.test(perText) || Number(perText) < 1) return Response.json({ error: `per_page must be a whole number from 1, got ${perText}` }, { status: 400 });
    const page = Number(pageText);
    const per = Math.min(Number(perText), MAX_PER_PAGE); // larger values are capped, as most APIs do
    const all = shop.orders.slice(0, shop.visible);
    const orders = all.slice((page - 1) * per, page * per);
    return Response.json({ orders, page, per_page: per, has_more: page * per < all.length });
  });
  f.api.route("/v1/exports/order_items", (req) => {
    if (!auth(req)) return unauthorized();
    const ids = new Set(shop.orders.slice(0, shop.visible).map((o) => o.id));
    return Response.json(shop.items.filter((i) => ids.has(i.order_id)));
  });
}

async function daily(f: Fixture, sql: string, label: string, shop: Shop): Promise<string> {
  const { columns, rows } = await f.query(sql);
  needColumns(label, columns, ["day", "orders", "revenue", "items"]);
  const got = rows.map((r) => [dayOf(r.day), Number(r.orders), cents(r.revenue), Number(r.items)] as const).sort((a, b) => a[0].localeCompare(b[0]));
  return sameRows(label, got, dailyRevenue(shop).map((d) => [d.day, d.orders, d.cents, d.items] as const));
}

function prompt(): string {
  return [
    "The shop pipeline failed last night, and daily_revenue hasn't updated since.",
    "Can you find out what went wrong and fix it properly? I need the numbers to be right again, for every day.",
  ].join(" ");
}

export const failedLastNight: EvalTask = {
  name: "failed-last-night",
  summary: "a run failed last night (a check caught orders the one-page ingest never fetched); fix the cause",
  project: "shop",
  prompt: prompt(),
  transforms: ["daily_revenue"],

  setup(f) {
    const night = lastNight();
    const shop = makeShop(night.day);
    STATE.set(f, shop);
    shopRoutes(f, shop);
    f.secret("SHOP_TOKEN", SHOP_TOKEN);
    f.write("assets/shop_orders.ts", ordersAsset(f.api.url));
    f.write("assets/shop_order_items.ts", itemsAsset(f.api.url));
    f.write("assets/daily_revenue.sql", DAILY_REVENUE);
    // The night before: the last run that went through, with 97 orders.
    f.clock = lastNight(Date.now(), 1).at;
  },

  async after(f) {
    // Last night: five more orders, the shop's 101st and 102nd among them, and the run that failed.
    const shop = STATE.get(f)!;
    shop.visible = shop.orders.length;
    f.clock = lastNight().at;
    const run = await f.croft(["run", "--json"]);
    const step = (run.json?.data?.steps ?? []).find((s: { asset: string }) => s.asset === "shop_order_items");
    if (step?.status !== "failed" || step.error?.code !== "CHECK_FAILED") throw new Error(`last night's run did not fail as the task's story says\n${show(run)}`);
  },

  async verify(f) {
    const shop = STATE.get(f);
    if (!shop) throw new Error("failed-last-night: verify needs the fixture its setup made");
    return verdict([
      await check(CHECKS.orders, "warehouse", async () => {
        const { rows } = await f.query("SELECT id, status, total_cents, order_date FROM shop_orders ORDER BY id");
        const got = rows.map((r) => [Number(r.id), String(r.status), Number(r.total_cents), dayOf(r.order_date)] as const);
        return sameRows("shop_orders", got, shop.orders.map((o) => [o.id, o.status, o.total_cents, o.order_date] as const));
      }),
      await check(CHECKS.items, "warehouse", async () => {
        const { rows } = await f.query("SELECT id, order_id, quantity FROM shop_order_items ORDER BY id");
        const got = rows.map((r) => [Number(r.id), Number(r.order_id), Number(r.quantity)] as const);
        return sameRows("shop_order_items", got, shop.items.map((i) => [i.id, i.order_id, i.quantity] as const));
      }),
      await check(CHECKS.revenue, "warehouse", () => daily(f, "SELECT * FROM daily_revenue", "daily_revenue", shop)),
      await check(CHECKS.revenueCode, "code", () => daily(f, composeSql(f, ["daily_revenue"], "SELECT * FROM daily_revenue"), "daily_revenue (its SQL now)", shop)),
      await check(CHECKS.pages, "code", async () => {
        const a = ((await croftData(f, ["preview", "shop_orders"])).assets ?? []).find((x: { asset: string }) => x.asset === "shop_orders");
        if (a?.status !== "ok") throw new Error(`croft preview shop_orders: ${a?.status ?? "no result"} ${a?.reason ?? ""}`);
        if (a.rows !== shop.orders.length) throw new Error(`a preview of shop_orders fetches ${a.rows} of the shop's ${shop.orders.length} orders`);
        return `${a.rows} orders in ${a.requests} requests`;
      }),
      await check(CHECKS.guard, "code", async () => {
        const checks: { check: string; blocking: boolean }[] = (await croftData(f, ["describe", "shop_order_items"])).checks ?? [];
        const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/"/g, "").trim();
        const kept = checks.find((c) => c.blocking && norm(c.check) === norm(ITEM_CHECK));
        if (!kept) throw new Error(`shop_order_items no longer blocks on ${ITEM_CHECK} (its checks: ${checks.map((c) => `${c.check}${c.blocking ? "" : " (warning)"}`).join(", ") || "none"})`);
        return kept.check;
      }),
      await check(CHECKS.green, "warehouse", () => healthy(f)),
    ]);
  },

  async solve(f) {
    f.write("assets/shop_orders.ts", pagedOrdersAsset(f.api.url));
    return f.croft(["run", "--json"]);
  },
};

const runAll = async (f: Fixture) => {
  const r = await f.croft(["run", "--json"]);
  if (r.code === null) throw new Error(`croft run did not finish\n${show(r)}`);
};

export const selfTest: SelfTest = {
  secret: { name: "SHOP_TOKEN", value: SHOP_TOKEN },
  built: ["daily_revenue", "shop_order_items", "shop_orders"],
  untouched: ["code", "warehouse"],
  session: scriptedSession(
    ["croft status --json", "croft logs shop_order_items --failed", "croft query \"select count(*), max(id) from shop_orders\"", "croft validate --json", "croft preview shop_orders", "croft run", "croft status"],
    "Last night's run failed because shop_orders only read the first page of orders; it now follows every page. The run is green again.",
  ),
  diff: ["assets/shop_orders.ts"],
  wrong: [
    {
      what: "raised per_page (the API caps it at 100)",
      apply: async (f) => {
        f.write("assets/shop_orders.ts", ordersAsset(f.api.url, 500));
        await runAll(f);
      },
      fails: [CHECKS.orders, CHECKS.items, CHECKS.revenue, CHECKS.revenueCode, CHECKS.pages, CHECKS.green],
      detail: /fetches 100 of the shop's 102 orders/,
    },
    {
      what: "made the check a warning",
      apply: async (f) => {
        f.write("assets/shop_order_items.ts", itemsAsset(f.api.url, `warnings: ["${ITEM_CHECK}"],\n  checks: ["quantity > 0"],`));
        await runAll(f);
      },
      fails: [CHECKS.orders, CHECKS.revenue, CHECKS.revenueCode, CHECKS.pages, CHECKS.guard],
      detail: /no longer blocks on order_id IN \(SELECT id FROM shop_orders\)/,
    },
    {
      what: "deleted the check",
      apply: async (f) => {
        f.write("assets/shop_order_items.ts", itemsAsset(f.api.url, `checks: ["quantity > 0"],`));
        await runAll(f);
      },
      fails: [CHECKS.orders, CHECKS.revenue, CHECKS.revenueCode, CHECKS.pages, CHECKS.guard],
      detail: /its checks: unique\(id\), not_null\(id\), quantity > 0/,
    },
  ],
};
