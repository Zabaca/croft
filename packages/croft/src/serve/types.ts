// croft serve's record and wire types (DESIGN.md §5 "Server mode"). serve.json is what the read client
// (read/locate.ts readServeRecord) finds the server by; it is written 0600 because it holds the token.
import type { ServeRecord } from "../read/locate.ts";

/** <state>/serve.json, written by croft serve at start and removed when it stops. A superset of ServeRecord. */
export interface ServeJson extends ServeRecord {
  host: string;
  port: number;
  token: string;
  procStart: string | null;
  bootId: string | null;
  /** ISO-8601 UTC. */
  startedAt: string;
  version: string;
}

/** GET /health */
export interface ServeHealth {
  ok: true;
  pid: number;
  version: string;
  database: string;
  /** The live write intent the server stepped aside for, or null. */
  writeIntent: { pid: number; runId: string | null; since: string } | null;
  queriesToday: number;
}
