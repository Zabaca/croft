// The request shape and result limits of @zabaca/croft/read, shared by server and direct mode.
// Deliberately free of @duckdb/node-api: a hosted app that only talks to croft serve never loads the
// native binding (run.ts imports direct mode lazily). It uses no Bun-only APIs.
import { CroftError } from "../core/errors.ts";

export const DEFAULT_LIMIT = 10_000;

export interface SelectRequest {
  sql: string;
  params: unknown[];
  limit: number;
}

// JSON.rawJSON (Bun, Node 21+) writes bigints as exact digits; TypeScript's lib does not declare it yet.
const rawJSON = (JSON as unknown as { rawJSON?: (text: string) => unknown }).rawJSON;

/** JSON text with bigints as exact digits (request bodies, and plain-object params bound as JSON). */
export function stringifyLossless(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? (rawJSON ? rawJSON(x.toString()) : x.toString()) : x));
}

export function tooManyRows(limit: number, details: Record<string, unknown> = {}): CroftError {
  return new CroftError("QUERY_TOO_MANY_ROWS", {
    message: `the query returned more than ${limit.toLocaleString("en-US")} rows; croft never returns a partial result`,
    hint: "add a LIMIT, aggregate in SQL, or pass a larger { limit } to query()",
    retryable: false,
    details: { limit, ...details },
  });
}
