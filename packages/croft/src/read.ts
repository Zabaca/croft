// @zabaca/croft/read: how apps read croft data (DESIGN.md §5 "Server mode, apps and GUIs").
//
//   import { query } from "@zabaca/croft/read";
//   const rows = await query<{ day: string; revenue: string }>("SELECT day, revenue FROM daily_revenue WHERE day >= $1", ["2026-09-01"]);
//
// It talks to croft serve when one is configured ({ url }, CROFT_URL) or running (.croft/serve.json), and
// otherwise opens the DuckDB file read-only for the one query, stepping aside for croft's writers. Rows use
// the same rendering in both modes: strings for HUGEINT, DECIMAL and integers beyond ±2^53, ISO strings with
// the project offset for timestamps. More rows than `limit` (10,000 by default) throw QUERY_TOO_MANY_ROWS;
// a result is never silently truncated. Errors are Error objects with a `code` (and a full `problem`).
//
// This module ships as prebuilt JavaScript (scripts/build-read.ts → dist/read.js + dist/read.d.ts) because
// Node refuses to strip types under node_modules, so it and everything it imports use no Bun-only APIs.
import type { ReadOptions } from "./read-types.ts";
import { runQuery } from "./read/run.ts";

export type { ReadOptions } from "./read-types.ts";

/** What query() throws: an Error with a stable `code` (e.g. SERVE_UNAVAILABLE, QUERY_TOO_MANY_ROWS, DB_BUSY). */
export interface ReadError extends Error {
  readonly code: string;
  readonly problem: {
    severity: "error" | "warning" | "info";
    code: string;
    message: string;
    hint: string;
    docs: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  };
}

/**
 * Run one SELECT (or DESCRIBE/SUMMARIZE/SHOW) against the croft project's warehouse and return its rows.
 * `params` bind to $1, $2, ... Throws a ReadError.
 */
export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string, params?: unknown[], options?: ReadOptions,
): Promise<T[]> {
  return (await runQuery(sql, params, options, { env: process.env, cwd: process.cwd() })) as T[];
}
