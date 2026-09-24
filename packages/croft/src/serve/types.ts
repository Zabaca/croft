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

/**
 * The query engine behind croft serve (serve/instance.ts + handoff.ts + queue.ts implement it; server.ts only
 * speaks HTTP). It owns the read-only DuckDB instance, held in a query worker process (serve/worker.ts) that it
 * kills to release the file, admits at most maxConcurrent queries (at most maxQueued wait), steps aside for
 * every live write intent within graceMs + killAfterMs whatever the queries do, and reopens when the intents
 * are gone.
 */
export interface ServeEngine {
  /**
   * Run one SELECT (the serve gate: user tables, CTEs and a few harmless table functions), streamed within its
   * limits and rendered like direct mode (json mode, project offset). Throws CroftError:
   * - SERVE_UNAVAILABLE with details.retryAfterMs and details.reason "write" (a writer holds the file, or the
   *   query was stopped for one), "busy" (not admitted within queueMs, or maxQueued already wait), "restarted"
   *   (its worker was killed to end another query, or crashed), "unavailable" or "stopping": server.ts answers
   *   503 with Retry-After;
   * - QUERY_TOO_MANY_ROWS beyond `limit` rows (capped at maxRows) or serve.maxBytes;
   * - TIMEOUT at queryTimeoutMs, INTERRUPTED when the request went away, gate and SQL errors as `croft query`
   *   raises them.
   */
  query(q: ServeQuery): Promise<ServeQueryData>;
  status(): ServeEngineStatus;
  /** Stop admitting, interrupt what runs, close every connection and the instance. */
  close(): Promise<void>;
}

export interface ServeQuery {
  sql: string;
  params: unknown[];
  limit: number;
  /** The request went away: stop waiting or interrupt. */
  signal?: AbortSignal;
}

/** The `data` of the query envelope the read client expects (read/server.ts rowsFrom). */
export interface ServeQueryData {
  columns: { name: string; type: string }[];
  rows: Record<string, unknown>[];
  rowCount: number;
  tookMs: number;
  /** Answered from the read copy (readCopy on) while a writer held the live file. Absent for live answers. */
  stale?: true;
  /** With stale: the read copy's mtime (the checkpoint it was taken at), in the project offset. */
  asOf?: string;
}

export interface ServeEngineStatus {
  state: "open" | "stepping_aside" | "closed_for_write" | "reopening" | "stopped";
  writeIntent: ServeHealth["writeIntent"];
  inFlight: number;
  queued: number;
  /** DuckDB connections open right now (0 whenever the file is released). */
  openConnections: number;
  queriesToday: number;
}

export interface ServeEngineOptions {
  /** The project root (its croft.json gives the database, state folder, time zone and serve.* settings). */
  root: string;
  /** Default 4. */
  maxConcurrent?: number;
  /** How long a query waits for admission before SERVE_UNAVAILABLE (503). Default 10_000. */
  queueMs?: number;
  /** serve.queryTimeoutMs, default 30_000. */
  queryTimeoutMs?: number;
  /** write-intent.d poll interval. Default 50. */
  pollMs?: number;
  /** How long running queries may finish before they are interrupted for a writer. Default 2000. */
  graceMs?: number;
  /** Queries that may wait for a slot; more are refused at once (503). Default 64. */
  maxQueued?: number;
  /** The most rows one answer carries, whatever `limit` asks (serve.maxRows). Default 100_000. */
  maxRows?: number;
  /** A stopped query that has not settled this long after its first interrupt is ended by killing its worker. Default 500. */
  killAfterMs?: number;
}
