// Journey 3: a Stripe-like ingest written from DESIGN §3a: newest-first pages with starting_after/has_more,
// an epoch-seconds cursor with a 30-day lookback ({ field: "created", unit: "s", lookback: "30 days" }).
// `since` must arrive as a number (saved − 30 days), and a charge refunded inside the window merges by id.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { stripeAsset } from "./fixtures.ts";
import { cleanupAll, initProject, json, type MockApi, mockApi, show } from "./harness.ts";

const KEY = "sk_test_e2eStripeKey987654";
let api: MockApi;
beforeAll(() => {
  api = mockApi();
});
afterAll(async () => {
  api.stop();
  await cleanupAll();
});

interface Charge { id: string; object: "charge"; created: number; amount: number; amount_refunded: number; currency: string; refunded: boolean; metadata: Record<string, string> }

test("journey 3: Stripe-like newest-first cursor pages, epoch cursor with a 30-day lookback", async () => {
  const now = Math.floor(Date.now() / 1000) - 3600;
  const DAY = 86_400;
  const charge = (n: number, created: number, extra: Partial<Charge> = {}): Charge => ({
    id: `ch_${String(n).padStart(4, "0")}`, object: "charge", created, amount: 1000 + n, amount_refunded: 0, currency: "usd", refunded: false,
    metadata: { order_id: `o${n}` }, ...extra,
  });
  const state = {
    charges: [
      ...Array.from({ length: 10 }, (_, i) => charge(i + 1, now - i * DAY)),   // the last 10 days
      charge(90, now - 60 * DAY), charge(91, now - 61 * DAY),                // two old ones
    ],
  };
  api.route("/v1/charges", (req, url) => {
    if (req.headers.get("authorization") !== `Bearer ${KEY}`) return json({ error: { message: "Invalid API Key" } }, { status: 401 });
    const limit = Number(url.searchParams.get("limit") ?? 10);
    const gte = url.searchParams.get("created[gte]");
    const after = url.searchParams.get("starting_after");
    let rows = [...state.charges].sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1));
    if (gte !== null) rows = rows.filter((c) => c.created >= Number(gte));
    if (after !== null) rows = rows.slice(rows.findIndex((c) => c.id === after) + 1);
    return json({ object: "list", data: rows.slice(0, limit), has_more: rows.length > limit, url: "/v1/charges" });
  });

  const { project: p } = await initProject();
  p.write("assets/stripe_charges.ts", stripeAsset(api.url));
  p.secret("STRIPE_KEY", KEY);

  const first = await p.json(["run", "stripe_charges"]);
  expect(first.code, show(first)).toBe(0);
  expect(first.json.data.steps[0]).toMatchObject({ status: "ok", rows: { added: 12, total: 12 }, requests: 3 });
  const r1 = api.requests("/v1/charges");
  expect(r1).toHaveLength(3);
  expect(r1[0]!.query["created[gte]"]).toBeUndefined();
  expect(r1.map((r) => r.query.starting_after ?? null)).toEqual([null, "ch_0004", "ch_0008"]);
  const d1 = await p.json(["describe", "stripe_charges"]);
  expect(d1.json.data.behavior).toMatchObject({ write: "merge", key: ["id"] });
  expect(d1.json.data.behavior.incremental).toMatchObject({ field: "created", cursorType: "integer", unit: "s", cursorValue: String(now) });
  const types = Object.fromEntries(d1.json.data.columns.map((c: { name: string; type: string }) => [c.name, c.type]));
  expect(types).toMatchObject({ id: "VARCHAR", created: "BIGINT", amount: "BIGINT", refunded: "BOOLEAN", metadata: "JSON" });

  // A refund lands on a 3-day-old charge, and a new charge arrives.
  state.charges[3] = { ...state.charges[3]!, amount_refunded: 1004, refunded: true };
  state.charges.push(charge(11, now + 60));
  const before = api.log.length;
  const second = await p.json(["run", "stripe_charges"]);
  expect(second.code, show(second)).toBe(0);
  const r2 = api.log.slice(before);
  // since = saved − 30 days, as epoch seconds.
  expect(r2[0]!.query["created[gte]"]).toBe(String(now - 30 * DAY));
  const s2 = second.json.data.steps[0];
  expect(s2.rows).toMatchObject({ added: 1, updated: 1, unchanged: 9, deleted: 0, total: 13 });
  expect(String(s2.cursor.after)).toBe(String(now + 60));
  const refunded = await p.rows("select id, refunded, amount_refunded from stripe_charges where refunded");
  expect(refunded).toEqual([{ id: "ch_0004", refunded: true, amount_refunded: 1004 }]);
  const all = await p.rows("select count(*) n, max(created) mx from stripe_charges");
  expect(all[0]).toEqual({ n: 13, mx: now + 60 });

  // The asset code saw since as a number, not a string (its ctx.log line is in the step log).
  const logs = await p.json(["logs", "stripe_charges"]);
  expect(logs.code, show(logs)).toBe(0);
  const lines: string[] = logs.json.data.steps.flatMap((s: { lines: string[] }) => s.lines);
  expect(lines.some((l) => l.includes(`since number ${now - 30 * DAY}`)), lines.join("\n")).toBe(true);
  const d2 = await p.json(["describe", "stripe_charges"]);
  expect(d2.json.data.behavior.incremental.cursorValue).toBe(String(now + 60));
}, 120_000);
