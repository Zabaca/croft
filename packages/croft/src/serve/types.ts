// croft serve's record and wire types (DESIGN.md §5 "Server mode"). serve.json is what the read client
// (read/locate.ts readServeRecord) finds the server by; it is written 0600 because it holds the token.
import type { ProjectEnv } from "../project/env.ts";
import type { ServeRecord } from "../read/locate.ts";
import type { QuackEvent } from "./quack-access.ts";

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
  /** Present (true) when this server runs in server mode (D119): it holds the read copy and never the live file, so
   *  croft doctor does not name it as a holder of the warehouse. Absent for the file engine. */
  serverMode?: true;
  /** Server mode (D125): where DuckDB clients attach over Quack, as it was bound when croft serve started. A port of 0
   *  becomes the one picked; the readers' process keeps the port while it lives, but a replacement started after a kill
   *  picks again when the setting is 0. */
  quack?: { uri: string };
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
  /** Server mode only: answers come from the read copy as of this time (null until the readers' process has one). */
  serverMode?: { state: string; asOf: string | null; quack?: string };
  /** Set (server mode) when the server answers but something the user should fix makes it a problem: the copy limit. */
  degraded?: { code: string; message: string };
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
  /** A key's query (D122): who asks, and the only tables the query may name. Absent for the app token, which reads every
   *  table. An empty `tables` shares nothing, and the engine refuses the query (SERVE_NO_SHARED_TABLES). A key works only in
   *  server mode (D128): the file engine refuses any query that carries a scope (SERVE_KEY_NEEDS_SERVER_MODE). */
  scope?: KeyScope;
  /** The request went away: stop waiting or interrupt. */
  signal?: AbortSignal;
}

/** What a key may read: its name, for the log, and the tables the project shares with keys. */
export interface KeyScope {
  key: string;
  tables: readonly string[];
}

/** The `data` of the query envelope the read client expects (read/server.ts rowsFrom). */
export interface ServeQueryData {
  columns: { name: string; type: string }[];
  rows: Record<string, unknown>[];
  rowCount: number;
  tookMs: number;
  /** Answered from the read copy (readCopy on) while a writer held the live file. Absent for live answers, and in
   *  server mode, where every answer is from the copy and none is "stale". */
  stale?: true;
  /** The read copy's mtime (the checkpoint it was taken at), in the project offset: with stale, the copy that answered
   *  in place of the live file; in server mode (D119) on every answer. */
  asOf?: string;
  /** The project's tables the query read, ASCII-lowercased. For the log line of a key query: server.ts takes it out before
   *  the envelope is made, so it never reaches a client. */
  tables?: string[];
}

export interface ServeEngineStatus {
  state: "open" | "stepping_aside" | "closed_for_write" | "reopening" | "stopped";
  writeIntent: ServeHealth["writeIntent"];
  inFlight: number;
  queued: number;
  /** DuckDB connections open right now (0 whenever the file is released). */
  openConnections: number;
  queriesToday: number;
  /** A lake project's engine (D143, serve/lake-engine.ts): the lake it reads, the process that reads it and how often that was started
   *  again. It never steps aside, so `state` is "open" whenever the process is. */
  lake?: { label: string; workerPid: number | null; restarts: number };
  /** Server mode only (D119): the readers' engine (serve/readers.ts). `state` is the engine's own: "waiting" for the
   *  first copy, "starting", "open", "restarting" after a kill, a crash or a failed start, or "stopped". */
  serverMode?: {
    state: "waiting" | "starting" | "open" | "restarting" | "stopped";
    /** The read copy, and its as-of time (in the project offset) as the readers' process has it; null before it opens. */
    copy: string;
    asOf: string | null;
    workerPid: number | null;
    /** Refreshed copies taken in, and times the readers' process was started again, since croft serve started. */
    swaps: number;
    restarts: number;
    /** Set when each refresh is a full copy the project has not accepted (the warehouse grew past 1 GB where the
     *  filesystem cannot clone, D121); null otherwise. The server keeps answering, from a copy that keeps being refreshed. */
    copyCost: { code: string; message: string } | null;
    /** A child process is making the read copy now (it was missing, behind or failed; serve/copy-maker.ts). */
    makingCopy: boolean;
    /** Where DuckDB clients attach over Quack (`quack:127.0.0.1:9494`), once the readers' process listens; null otherwise
     *  (before it opens, or with the listener turned off for a test). */
    quack: { uri: string } | null;
  };
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
  /** Server mode (D125): told of every Quack sign-in and every Quack query, answered or refused, for croft serve's log line
   *  and a key's last-used time. */
  onQuack?: (e: QuackEvent) => void;
  /** The project's secrets, for the read-only login and bucket key of a lake project (D143); .env and the shell by default. */
  env?: ProjectEnv;
}
