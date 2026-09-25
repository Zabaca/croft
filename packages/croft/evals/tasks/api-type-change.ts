// Task "the API changed a field type" (DESIGN.md §10 item 9). A shop project whose orders ingest is a merge (key id,
// cursor updated_at, ascending keyset pages). After its first runs the shop moved its API to a new version that
// sends total_cents as a string of digits ("2450") instead of a number, as some APIs do for int64 fields; new
// orders arrived and one pending order was paid. This morning's run failed: TYPE_CONFLICT on total_cents (BIGINT
// receiving text), nothing written, the cursor where it was.
//
// Done means the ingest turns the value back into a number in code (or pins total_cents to an integer type, which
// casts digit strings exactly), the run is green, total_cents is still an integer column, the new and updated orders
// are in with the right totals, daily_revenue is right, and the rows stored before the change were not rewritten
// (no --rebuild, no delete). Wrong: pinning VARCHAR (text totals; SQL sums break), dividing into dollars, skipping
// the orders that arrive with text, or fixing the code without running it.
import { type EvalTask, type Fixture, show } from "../harness.ts";
import { cents, check, composeSql, croftData, dayOf, healthy, needColumns, sameRows, type SelfTest, scriptedSession, verdict } from "../verify.ts";
import { ORDERS as SHOP_ORDERS, SHOP_TOKEN } from "./shop.ts";

interface Order { id: number; customer_id: string; status: "paid" | "refunded" | "pending"; total_cents: number; order_date: string; updated_at: string }
interface Shop {
  orders: Order[];
  /** Whether the API sends total_cents as text (its new version). */
  textTotals: boolean;
  /** _loaded_at of each order stored before the change, as croft returned it. */
  storedBefore: Map<number, string>;
}
const STATE = new WeakMap<Fixture, Shop>();

export const CHECKS = {
  orders: "shop_orders holds every order, old and new, with its current status and total",
  type: "total_cents is still an integer column",
  intact: "the orders stored before the API changed were not rewritten",
  revenue: "daily_revenue is right for every day",
  revenueCode: "daily_revenue's SQL computes the right numbers",
  ingestCode: "shop_orders's code loads the API's new format",
  green: "the pipeline is green: croft status is healthy",
} as const;

/** The shop's orders before the change, each updated at 18:00 UTC of its day (a few minutes apart). */
function startingOrders(): Order[] {
  return SHOP_ORDERS.map((o, i) => ({ ...o, updated_at: `${o.order_date}T18:${String(10 + i).padStart(2, "0")}:00Z` }));
}

/** What happened since: new orders, and pending order 105 paid. */
function afterChange(orders: Order[]): Order[] {
  const next = orders.map((o) => (o.id === 105 ? { ...o, status: "paid" as const, updated_at: "2026-09-20T16:05:00Z" } : o));
  const added: [number, string, Order["status"], number, string, string][] = [
    [118, "C-1003", "paid", 3650, "2026-09-20", "2026-09-20T17:12:00Z"],
    [119, "C-1006", "paid", 2400, "2026-09-20", "2026-09-20T19:40:00Z"],
    [120, "C-1001", "pending", 1500, "2026-09-21", "2026-09-21T15:02:00Z"],
    [121, "C-1004", "paid", 5400, "2026-09-21", "2026-09-21T16:30:00Z"],
    [122, "C-1002", "refunded", 1250, "2026-09-21", "2026-09-21T18:45:00Z"],
  ];
  for (const [id, customer_id, status, total_cents, order_date, updated_at] of added) next.push({ id, customer_id, status, total_cents, order_date, updated_at });
  return next.sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id - b.id);
}

/** Per day, over paid orders: orders and revenue in cents. */
function dailyRevenue(orders: readonly Order[]): { day: string; orders: number; cents: number }[] {
  const by = new Map<string, { day: string; orders: number; cents: number }>();
  for (const o of orders) {
    if (o.status !== "paid") continue;
    const d = by.get(o.order_date) ?? { day: o.order_date, orders: 0, cents: 0 };
    d.orders++;
    d.cents += o.total_cents;
    by.set(o.order_date, d);
  }
  return [...by.values()].sort((a, b) => a.day.localeCompare(b.day));
}

const INGEST = (base: string, rows = "yield page;", extra = "") => `// assets/shop_orders.ts: orders from the shop API, fetched from the saved cursor on
import { ingest, fail } from "@zabaca/croft";

type Order = { id: number; customer_id: string; status: "paid" | "refunded" | "pending"; total_cents: number; order_date: string; updated_at: string };

export default ingest({
  description: "Shop orders: status is paid, refunded or pending; total_cents is the order total in cents",
  secrets: ["SHOP_TOKEN"],
  key: "id",
  incremental: "updated_at",${extra}

  async *rows({ since, http, secret }) {
    let from = since;
    for (;;) {
      const res = await http.get("${base}/v2/orders", {
        headers: { Authorization: \`Bearer \${secret("SHOP_TOKEN")}\` },
        query: { updated_since: from, limit: 100 },
      });
      const page = res.json<Order[]>();
      ${rows}
      if (page.length < 100) return;
      const last = page.at(-1)!.updated_at;
      if (last === from) fail("KEYSET_STUCK", "100+ orders share one updated_at");
      from = last;
    }
  },
});
`;

/** The fix: the API now sends total_cents as a string of digits; turn it back into a number. */
const CLEANED = (base: string) => INGEST(base, `// The API sends total_cents as a string of digits since its new version ("2450"): keep it a number.
      yield page.map((o) => ({ ...o, total_cents: Number(o.total_cents) }));`);

const DAILY_REVENUE = `-- description: Paid orders and revenue (dollars) per day
-- key: day
SELECT
  order_date AS day,
  count(*) AS orders,
  sum(total_cents) / 100.0 AS revenue
FROM shop_orders
WHERE status = 'paid'
GROUP BY order_date
`;

function shopRoute(f: Fixture, shop: Shop): void {
  f.api.route("/v2/orders", (req, url) => {
    if (req.headers.get("authorization") !== `Bearer ${SHOP_TOKEN}`) return Response.json({ error: "invalid token" }, { status: 401 });
    const since = url.searchParams.get("updated_since");
    const limitText = url.searchParams.get("limit") ?? "50";
    if (!/^\d+$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > 250) return Response.json({ error: `limit must be 1 to 250, got ${limitText}` }, { status: 400 });
    const from = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
    if (Number.isNaN(from)) return Response.json({ error: `updated_since is not a time: ${since}` }, { status: 400 });
    const page = shop.orders.filter((o) => Date.parse(o.updated_at) >= from).slice(0, Number(limitText));
    return Response.json(page.map((o) => (shop.textTotals ? { ...o, total_cents: String(o.total_cents) } : o)));
  });
}

async function daily(f: Fixture, sql: string, label: string, shop: Shop): Promise<string> {
  const { columns, rows } = await f.query(sql);
  needColumns(label, columns, ["day", "orders", "revenue"]);
  const got = rows.map((r) => [dayOf(r.day), Number(r.orders), cents(r.revenue)] as const).sort((a, b) => a[0].localeCompare(b[0]));
  return sameRows(label, got, dailyRevenue(shop.orders).map((d) => [d.day, d.orders, d.cents] as const));
}

export const apiTypeChange: EvalTask = {
  name: "api-type-change",
  summary: "the shop API started sending total_cents as text (TYPE_CONFLICT); fix the ingest without losing rows",
  project: "shop",
  prompt: [
    "The shop moved its API to a new version this week, and since then our orders pipeline fails.",
    "Can you fix it so it runs again? Don't lose any of the orders we already have.",
  ].join(" "),
  transforms: ["daily_revenue"],

  setup(f) {
    const shop: Shop = { orders: startingOrders(), textTotals: false, storedBefore: new Map() };
    STATE.set(f, shop);
    shopRoute(f, shop);
    f.secret("SHOP_TOKEN", SHOP_TOKEN);
    f.write("assets/shop_orders.ts", INGEST(f.api.url));
    f.write("assets/daily_revenue.sql", DAILY_REVENUE);
    f.clock = new Date(Date.now() - 3 * 86_400_000).toISOString();
  },

  async after(f) {
    const shop = STATE.get(f)!;
    const { rows } = await f.query("SELECT id, _loaded_at FROM shop_orders");
    for (const r of rows) shop.storedBefore.set(Number(r.id), String(r._loaded_at));
    // The new API version, and what the shop did since.
    shop.textTotals = true;
    shop.orders = afterChange(shop.orders);
    f.clock = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const run = await f.croft(["run", "--json"]);
    const step = (run.json?.data?.steps ?? []).find((s: { asset: string }) => s.asset === "shop_orders");
    if (step?.status !== "failed" || step.error?.code !== "TYPE_CONFLICT") throw new Error(`this morning's run did not fail as the task's story says\n${show(run)}`);
  },

  async verify(f) {
    const shop = STATE.get(f);
    if (!shop) throw new Error("api-type-change: verify needs the fixture its setup made");
    const byId = [...shop.orders].sort((a, b) => a.id - b.id);
    return verdict([
      await check(CHECKS.orders, "warehouse", async () => {
        const { rows } = await f.query("SELECT id, status, total_cents FROM shop_orders ORDER BY id");
        const got = rows.map((r) => [Number(r.id), String(r.status), Number(r.total_cents)] as const);
        return sameRows("shop_orders", got, byId.map((o) => [o.id, o.status, o.total_cents] as const));
      }),
      await check(CHECKS.type, "data", async () => {
        const col = ((await croftData(f, ["describe", "shop_orders"])).columns ?? []).find((c: { name: string }) => c.name === "total_cents");
        if (!col) throw new Error("shop_orders has no column total_cents");
        if (!/^(BIGINT|INTEGER|HUGEINT|UBIGINT|DECIMAL\(\d+,\s*0\))$/i.test(col.type)) throw new Error(`total_cents is ${col.type}${col.pinned ? " (pinned)" : ""}: amounts are no longer whole cents`);
        return `${col.type}${col.pinned ? " (pinned)" : ""}`;
      }),
      await check(CHECKS.intact, "data", async () => {
        const { rows } = await f.query("SELECT id, _loaded_at FROM shop_orders");
        const now = new Map(rows.map((r) => [Number(r.id), String(r._loaded_at)]));
        const untouched = [...shop.storedBefore.keys()].filter((id) => id !== 105);
        const lost = untouched.filter((id) => !now.has(id));
        if (lost.length) throw new Error(`orders ${lost.join(", ")} are gone`);
        const rewritten = untouched.filter((id) => now.get(id) !== shop.storedBefore.get(id));
        if (rewritten.length) throw new Error(`${rewritten.length} of the ${untouched.length} orders stored before the change were written again (_loaded_at changed), e.g. ${rewritten[0]}`);
        return `${untouched.length} orders as they were`;
      }),
      await check(CHECKS.revenue, "warehouse", () => daily(f, "SELECT * FROM daily_revenue", "daily_revenue", shop)),
      await check(CHECKS.revenueCode, "code", () => daily(f, composeSql(f, ["daily_revenue"], "SELECT * FROM daily_revenue"), "daily_revenue (its SQL now)", shop)),
      await check(CHECKS.ingestCode, "code", async () => {
        const a = ((await croftData(f, ["preview", "shop_orders"])).assets ?? []).find((x: { asset: string }) => x.asset === "shop_orders");
        if (a?.status !== "ok") throw new Error(`croft preview shop_orders: ${a?.status ?? "no result"}: ${a?.error ? `${a.error.code}: ${a.error.message}` : a?.reason ?? ""}`.slice(0, 600));
        if (!a.rows) throw new Error("a preview of shop_orders fetched nothing to try the new format on");
        return `preview ok, ${a.rows} rows`;
      }),
      await check(CHECKS.green, "warehouse", () => healthy(f)),
    ]);
  },

  async solve(f) {
    f.write("assets/shop_orders.ts", CLEANED(f.api.url));
    return f.croft(["run", "--json"]);
  },
};

const writeAndRun = (ingest: (base: string) => string) => async (f: Fixture) => {
  f.write("assets/shop_orders.ts", ingest(f.api.url));
  const r = await f.croft(["run", "--json"]);
  if (r.code === null) throw new Error(`croft run did not finish\n${show(r)}`);
};

export const selfTest: SelfTest = {
  secret: { name: "SHOP_TOKEN", value: SHOP_TOKEN },
  built: ["daily_revenue", "shop_orders"],
  untouched: ["code", "warehouse"],
  session: scriptedSession(
    ["croft status --json", "croft logs shop_orders --failed", "croft describe shop_orders --json", "croft validate --json", "croft preview shop_orders", "croft run", "croft status"],
    "The shop's new API sends total_cents as text; shop_orders now turns it back into a number. The run is green and no stored order was touched.",
  ),
  diff: ["assets/shop_orders.ts"],
  wrong: [
    {
      what: "fixed the code, never ran it",
      apply: async (f) => f.write("assets/shop_orders.ts", CLEANED(f.api.url)),
      fails: [CHECKS.orders, CHECKS.revenue, CHECKS.revenueCode, CHECKS.green],
      detail: /row 5 is \[105,"pending",[\s\S]*TYPE_CONFLICT/,
    },
    {
      what: "skipped the orders that arrive with a text total",
      apply: writeAndRun((base) => INGEST(base, `yield page.filter((o) => typeof o.total_cents === "number");`)),
      fails: [CHECKS.orders, CHECKS.revenue, CHECKS.revenueCode, CHECKS.ingestCode],
      detail: /row 5 is \[105,"pending"[\s\S]*fetched nothing/,
    },
    {
      // A lossless retype, applied without asking; daily_revenue's sum() then fails on text.
      what: "pinned total_cents to VARCHAR",
      fresh: true,
      apply: writeAndRun((base) => INGEST(base, "yield page;", `\n  columns: { total_cents: "VARCHAR" },`)),
      fails: [CHECKS.type, CHECKS.revenue, CHECKS.revenueCode, CHECKS.green],
      detail: /total_cents is VARCHAR[\s\S]*sum\(VARCHAR\)/,
    },
    {
      // total_cents widens to DOUBLE; the newest old order, re-read at the cursor's boundary, is rewritten too.
      what: "turned the text into dollars",
      fresh: true,
      apply: writeAndRun((base) => INGEST(base, "yield page.map((o) => ({ ...o, total_cents: Number(o.total_cents) / 100 }));")),
      fails: [CHECKS.orders, CHECKS.type, CHECKS.intact, CHECKS.revenue, CHECKS.revenueCode],
      detail: /total_cents is DOUBLE/,
    },
    {
      what: "(right too) pinned total_cents to BIGINT, which casts digit strings exactly",
      fresh: true,
      apply: writeAndRun((base) => INGEST(base, "yield page;", `\n  columns: { total_cents: "BIGINT" },`)),
      fails: [],
      detail: /^$/,
    },
  ],
};
