// A Stripe account for the stripe-hourly task: a mock of Stripe's GET /v1/charges and the charges behind it, fixed
// and generated from a seed, so a verifier's expected numbers are computed here, never read back from what the
// agent built.
//
// The endpoint behaves as Stripe's list API does: newest first (created, then id, descending); `limit` 1-100,
// default 10; `starting_after` / `ending_before` object ids; `created` as a number or created[gte|gt|lte|lt];
// {object: "list", data, has_more, url}; Bearer or Basic auth with the secret key; 400 for an unknown parameter or
// id. Charges change after creation: the verifier refunds old ones between runs (refundOld).
//
// The traps for plausible wrong solutions: many charges are made in the evening, Los Angeles time, which is the
// next day in UTC (days bucketed in UTC are wrong); some succeeded charges were refunded (revenue counting them is
// wrong); some charges failed or are pending; there are more charges than one page of 100 holds.
import type { Fixture } from "../harness.ts";
import { localDay, localTime, prng } from "../verify.ts";

export const STRIPE_KEY = "sk_test_51PqEvalsCroftStripeKey7d4e2b9a1c";

export interface Charge {
  id: string;
  object: "charge";
  amount: number;
  amount_captured: number;
  amount_refunded: number;
  balance_transaction: string | null;
  captured: boolean;
  created: number;
  currency: "usd";
  customer: string | null;
  description: string | null;
  disputed: boolean;
  failure_code: string | null;
  failure_message: string | null;
  livemode: false;
  metadata: Record<string, string>;
  paid: boolean;
  payment_method_details: { type: "card"; card: { brand: string; last4: string; exp_month: number; exp_year: number } };
  receipt_email: string | null;
  refunded: boolean;
  status: "succeeded" | "failed" | "pending";
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Epoch seconds of a wall time in the fixture's zone. */
function wall(day: string, hour: number, minute: number, second: number): number {
  const t = [hour, minute, second].map((n) => String(n).padStart(2, "0")).join(":");
  return Date.parse(localTime(day, t)) / 1000;
}

const FIRST_DAY = "2026-08-03";
const DAYS = 50; // through 2026-09-21
const BRANDS = ["visa", "mastercard", "amex", "visa", "visa", "discover"];
const PRODUCTS = ["Starter plan", "Pro plan", "Team plan", "Add-on seats", "Annual Pro plan"];

/** The charges the account starts with, newest first as Stripe lists them. */
export function makeCharges(): Charge[] {
  const rand = prng(20260924);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const token = (n: number) => Array.from({ length: n }, () => ALNUM[Math.floor(rand() * ALNUM.length)]).join("");
  const customers = Array.from({ length: 24 }, () => `cus_${token(14)}`);
  const out: Charge[] = [];
  const start = Date.parse(`${FIRST_DAY}T12:00:00Z`);
  for (let d = 0; d < DAYS; d++) {
    const day = new Date(start + d * 86_400_000).toISOString().slice(0, 10);
    const n = 3 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      // About half in the evening (17:00-23:59 here: already the next day in UTC).
      const hour = rand() < 0.5 ? 17 + Math.floor(rand() * 7) : 8 + Math.floor(rand() * 9);
      const created = wall(day, hour, Math.floor(rand() * 60), Math.floor(rand() * 60));
      const amount = 500 + Math.floor(rand() * 240) * 100 + (rand() < 0.3 ? 99 : 0);
      const r = rand();
      const status: Charge["status"] = r < 0.1 ? "failed" : r < 0.13 ? "pending" : "succeeded";
      const refunded = status === "succeeded" && rand() < 0.12;
      out.push(charge({ id: `ch_3${token(23)}`, created, amount, status, refunded, customer: rand() < 0.9 ? pick(customers) : null, brand: pick(BRANDS), last4: String(1000 + Math.floor(rand() * 9000)), product: pick(PRODUCTS), txn: `txn_3${token(23)}` }));
    }
  }
  return sortNewestFirst(out);
}

function charge(o: { id: string; created: number; amount: number; status: Charge["status"]; refunded: boolean; customer: string | null; brand: string; last4: string; product: string; txn: string }): Charge {
  const ok = o.status === "succeeded";
  return {
    id: o.id, object: "charge", amount: o.amount, amount_captured: ok ? o.amount : 0, amount_refunded: o.refunded ? o.amount : 0,
    balance_transaction: ok ? o.txn : null, captured: o.status !== "failed", created: o.created, currency: "usd", customer: o.customer,
    description: o.product, disputed: false,
    failure_code: o.status === "failed" ? "card_declined" : null, failure_message: o.status === "failed" ? "Your card was declined." : null,
    livemode: false, metadata: { plan: o.product.toLowerCase().replaceAll(" ", "_") }, paid: ok,
    payment_method_details: { type: "card", card: { brand: o.brand, last4: o.last4, exp_month: 1 + (Number(o.last4) % 12), exp_year: 2027 + (Number(o.last4) % 4) } },
    receipt_email: o.customer ? `${o.customer.slice(4, 10).toLowerCase()}@example.com` : null, refunded: o.refunded, status: o.status,
  };
}

export function sortNewestFirst(cs: Charge[]): Charge[] {
  return cs.sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** Revenue kept per local day, in cents: succeeded charges less refunds (no partial refunds here). Days with none
 *  are left out. */
export function dailyRevenue(cs: readonly Charge[]): { day: string; cents: number }[] {
  const by = new Map<string, number>();
  for (const c of cs) {
    if (c.status !== "succeeded" || c.refunded) continue;
    const day = localDay(c.created * 1000);
    by.set(day, (by.get(day) ?? 0) + c.amount - c.amount_refunded);
  }
  return [...by.entries()].map(([day, cents]) => ({ day, cents })).sort((a, b) => a.day.localeCompare(b.day));
}

/** What the account holds, and what the verifier did to it. */
export interface StripeState {
  charges: Charge[];
  /** Ids the verifier refunded after the session, in order. */
  refundedLater: string[];
  /** Charges the verifier added after the session. */
  addedLater: string[];
}

const ALLOWED = new Set(["limit", "starting_after", "ending_before", "created", "created[gte]", "created[gt]", "created[lte]", "created[lt]", "customer", "payment_intent", "transfer_group", "expand[]"]);

function stripeError(status: number, type: string, message: string, extra: Record<string, string> = {}): Response {
  return Response.json({ error: { type, message, ...extra } }, { status });
}

function authorized(req: Request): boolean {
  const h = req.headers.get("authorization") ?? "";
  if (h === `Bearer ${STRIPE_KEY}`) return true;
  if (h.startsWith("Basic ")) {
    try {
      return atob(h.slice(6)).split(":")[0] === STRIPE_KEY;
    } catch {
      return false;
    }
  }
  return false;
}

/** GET /v1/charges over `state`, on the fixture's mock API. */
export function stripeRoute(f: Fixture, state: StripeState): void {
  f.api.route("/v1/charges", (req, url) => {
    if (!authorized(req)) {
      return stripeError(401, "invalid_request_error", req.headers.get("authorization")
        ? "Invalid API Key provided. You can find your API keys in the Stripe Dashboard."
        : "You did not provide an API key. Provide it in the Authorization header, using Bearer auth (e.g. 'Authorization: Bearer YOUR_SECRET_KEY').");
    }
    if (req.method !== "GET") return stripeError(405, "invalid_request_error", "This example account only lists charges (GET /v1/charges).");
    const q = url.searchParams;
    for (const k of q.keys()) {
      if (!ALLOWED.has(k)) return stripeError(400, "invalid_request_error", `Received unknown parameter: ${k}`, { param: k });
    }
    const limitText = q.get("limit") ?? "10";
    const limit = Number(limitText);
    if (!/^\d+$/.test(limitText) || limit < 1 || limit > 100) {
      return stripeError(400, "invalid_request_error", `Invalid limit: must be an integer between 1 and 100, got ${limitText}`, { param: "limit" });
    }
    let rows = sortNewestFirst([...state.charges]);
    for (const [k, test] of [
      ["created", (c: number, v: number) => c === v],
      ["created[gte]", (c: number, v: number) => c >= v],
      ["created[gt]", (c: number, v: number) => c > v],
      ["created[lte]", (c: number, v: number) => c <= v],
      ["created[lt]", (c: number, v: number) => c < v],
    ] as const) {
      const v = q.get(k);
      if (v === null) continue;
      if (!/^\d+$/.test(v)) return stripeError(400, "invalid_request_error", `Invalid integer: ${v}`, { param: k });
      rows = rows.filter((c) => test(c.created, Number(v)));
    }
    const customer = q.get("customer");
    if (customer !== null) rows = rows.filter((c) => c.customer === customer);
    const after = q.get("starting_after");
    const before = q.get("ending_before");
    let page: Charge[];
    let hasMore: boolean;
    if (after !== null) {
      const i = rows.findIndex((c) => c.id === after);
      if (i < 0 && !state.charges.some((c) => c.id === after)) return stripeError(400, "invalid_request_error", `No such charge: '${after}'`, { param: "starting_after", code: "resource_missing" });
      const rest = i < 0 ? [] : rows.slice(i + 1);
      page = rest.slice(0, limit);
      hasMore = rest.length > limit;
    } else if (before !== null) {
      const i = rows.findIndex((c) => c.id === before);
      if (i < 0 && !state.charges.some((c) => c.id === before)) return stripeError(400, "invalid_request_error", `No such charge: '${before}'`, { param: "ending_before", code: "resource_missing" });
      const rest = i < 0 ? [] : rows.slice(0, i);
      page = rest.slice(Math.max(0, rest.length - limit));
      hasMore = rest.length > limit;
    } else {
      page = rows.slice(0, limit);
      hasMore = rows.length > limit;
    }
    return Response.json({ object: "list", data: page, has_more: hasMore, url: "/v1/charges" });
  });
}

/**
 * After the session: refund the newest succeeded, unrefunded charge at least `daysOld` days older than the newest
 * charge, and add a new succeeded charge an hour after the newest. Returns the two ids.
 */
export function refundOld(state: StripeState, daysOld: number, n: number): { refunded: Charge; added: Charge } {
  const newest = Math.max(...state.charges.map((c) => c.created));
  const target = sortNewestFirst([...state.charges]).find((c) => c.status === "succeeded" && !c.refunded && c.created <= newest - daysOld * 86_400);
  if (!target) throw new Error(`no succeeded charge ${daysOld} days old to refund`);
  target.refunded = true;
  target.amount_refunded = target.amount;
  const added = charge({
    id: `ch_3Later${String(n).padStart(3, "0")}Evals${"x".repeat(10)}`, created: newest + 3600, amount: 4200 + n, status: "succeeded", refunded: false,
    customer: target.customer, brand: "visa", last4: "4242", product: "Pro plan", txn: `txn_3Later${String(n).padStart(3, "0")}Evals${"x".repeat(10)}`,
  });
  state.charges.push(added);
  state.refundedLater.push(target.id);
  state.addedLater.push(added.id);
  return { refunded: target, added };
}
