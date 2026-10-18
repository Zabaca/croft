// Per-host request budgets (DESIGN.md §3a "ctx.http", D104): croft.json's http.budgets caps the requests ctx.http
// sends to a host in any rolling minute, hour or day, across every run and preview of the project.
//
// - Counted per attempt (a retry is a request the API counts too), before it is sent, in runs.sqlite's
//   http_requests: one BEGIN IMMEDIATE transaction reads the host's recent requests and records this one, so two
//   steps, or a scheduled run and a run by hand, can never both take the last request of a window. Only hosts
//   with a budget are recorded, and a host's rows older than a day are dropped as it records.
// - Rolling windows: at most `limit` requests in any span of the window's length. That never sends more than a
//   fixed-window API (one that resets on the hour) allows either, so croft need not know which kind it is.
// - Spent: the request is not sent. freeAt is when the oldest request that counts leaves the window. ctx.http
//   waits that long when it is within maxRetryAfterMs, as for a server's Retry-After; past it the request fails
//   with HTTP_BUDGET_SPENT (http.ts), whose retryAfterMs the runner turns into nextRetryAt as it does a long
//   Retry-After (§8 "Retries").
// - The clock is runs.sqlite's (the project clock, CROFT_NOW), like every other instant croft records.
import type { RunsDb } from "../history/runs-db.ts";
import type { HostBudget } from "../project/root.ts";

export type BudgetWindow = "minute" | "hour" | "day";

/** The windows a budget can set, shortest first. */
export const BUDGET_WINDOWS: readonly { window: BudgetWindow; key: keyof HostBudget; ms: number }[] = [
  { window: "minute", key: "perMinute", ms: 60_000 },
  { window: "hour", key: "perHour", ms: 3_600_000 },
  { window: "day", key: "perDay", ms: 86_400_000 },
];

/** How long runs.sqlite keeps a host's requests: the longest window. */
const KEEP_MS = 86_400_000;

/** A budget with no room for one more request. */
export interface BudgetSpent {
  /** The host as croft.json names it. */
  host: string;
  /** The window that frees last, when more than one is spent. */
  window: BudgetWindow;
  limit: number;
  /** Requests recorded in that window (at least limit). */
  used: number;
  /** When the next request may go (ISO-8601 UTC): the oldest request that counts leaves the window. */
  freeAt: string;
  waitMs: number;
}

/** ctx.http's budget for one step (HttpOptions.budget). */
export interface RequestBudget {
  /** Before each attempt to `url`: null when its host has no budget, or when every window of it has room, and
   *  then the request is recorded; otherwise what is spent, with nothing recorded. */
  take(url: string): BudgetSpent | null;
}

/** The budget that applies to a URL: http.budgets names its host (with its port when it has one), or its
 *  hostname. null for a host without one, or a URL that does not parse. */
export function budgetFor(budgets: Readonly<Record<string, HostBudget>>, url: string): { host: string; budget: HostBudget } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  for (const host of [u.host, u.hostname]) {
    const budget = Object.hasOwn(budgets, host) ? budgets[host] : undefined;
    if (budget) return { host, budget };
  }
  return null;
}

/** Whether one more request fits, given when the recorded ones went (epoch ms, oldest first): null when it does,
 *  else the window that frees last. A request exactly a window ago no longer counts. */
export function spentOf(host: string, budget: HostBudget, times: readonly number[], now: number): BudgetSpent | null {
  let worst: BudgetSpent | null = null;
  for (const w of BUDGET_WINDOWS) {
    const limit = budget[w.key];
    if (limit === undefined) continue;
    const inside = times.filter((t) => t > now - w.ms);
    if (inside.length < limit) continue;
    const free = inside[inside.length - limit]! + w.ms;
    if (!worst || free > Date.parse(worst.freeAt)) {
      worst = { host, window: w.window, limit, used: inside.length, freeAt: new Date(free).toISOString(), waitMs: Math.max(0, free - now) };
    }
  }
  return worst;
}

/** What is spent of a host's budget now, without recording anything (the plan's hold, schedule/due.ts). */
export function budgetState(runs: RunsDb, host: string, budget: HostBudget): BudgetSpent | null {
  const now = runs.now().getTime();
  const times = runs.requestTimes(host, new Date(now - KEEP_MS).toISOString()).map((t) => Date.parse(t));
  return spentOf(host, budget, times, now);
}

/** A step's budget over the live runs.sqlite; undefined when croft.json sets none, so ctx.http checks nothing. */
export function requestBudget(runs: RunsDb, budgets: Readonly<Record<string, HostBudget>>, who: { runId: string; asset: string }): RequestBudget | undefined {
  if (Object.keys(budgets).length === 0) return undefined;
  return {
    take(url) {
      const hit = budgetFor(budgets, url);
      if (!hit) return null;
      // Read and record in one write transaction: no other process can take the same last request.
      return runs.transaction(() => {
        const spent = budgetState(runs, hit.host, hit.budget);
        if (spent) return spent;
        runs.recordRequest(hit.host, who, new Date(runs.now().getTime() - KEEP_MS).toISOString());
        return null;
      });
    },
  };
}
