// croft serve's HTTP layer (DESIGN.md §5 "Server mode, apps and GUIs"). Bun.serve in front of a ServeEngine,
// which owns DuckDB (serve/instance.ts): this file only speaks HTTP.
//
//   POST /query   {sql, params?, limit?} → the `query` envelope of §4.3, exactly what read/server.ts expects
//   GET  /status  → the `status` envelope of §4.3, with this server and its engine under data.serve
//   GET  /health  → {ok, pid, version, database, writeIntent, queriesToday}
//
// Every request passes, in order: the Host check (DNS rebinding), the Origin check (serve.allowOrigins), then
// the bearer token (auth.ts). A CORS preflight is answered after the first two, since browsers send it
// without credentials. Errors are problem envelopes with a status the read client understands:
// - 503 + Retry-After (whole seconds, from details.retryAfterMs) when the engine did not admit the query in
//   time (a writer holds the file); the client waits and retries until its own timeoutMs;
// - 401 (token) and 403 (Host, Origin) are SERVE_UNAUTHORIZED, which the client never retries;
// - 422 QUERY_TOO_MANY_ROWS; 400 for usage and gate errors (exit-2 codes); 413/415 for the body; 500 otherwise.
// Rows are sent exactly as the engine rendered them (json mode, like direct mode), never truncated.
//
// Bounds (a burst of requests while a writer holds the file must not take croft serve down):
// - The bodies of /query requests that are being read or wait for the engine may add up to maxPendingBodyBytes
//   (64 MB). Past that a /query gets 503 + Retry-After at once, before its body is read (the engine itself refuses
//   more than 64 waiting queries the same way).
// - A connection's idle timeout applies while a body is read, so a body that never comes does not hold a socket.
//   While the query queues and runs the timeout is lifted to the query's own budget (queue wait + serve.
//   queryTimeoutMs + the kill of a stuck query), and set back to the idle timeout before the answer goes out: Bun
//   keeps a request's timeout on its keep-alive socket, so without that the socket would never be reaped.
//
// GET /status is `croft status --json` without importing asset code (croft serve runs none, §5): the status data
// from runs.sqlite, the catalog mirror and the asset files as text (cli/commands/status.ts collectStatus with no
// resolved assets). Staleness that only the asset code can tell (code_changed: its code hash) is therefore not
// reported here; `croft status` reports it.
//
// serve.json (<state>/serve.json, mode 0600) is how apps and croft itself find a running server; it is written
// here too, atomically, and never over a live server's record.
import { closeSync, fchmodSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CODES, CroftError, problem } from "../core/errors.ts";
import type { Problem } from "../core/types.ts";
import { buildEnvelope, redactProblem } from "../cli/render.ts";
import { collectStatus, type StatusData } from "../cli/commands/status.ts";
import { CROFT_VERSION } from "../cli/version.ts";
import { now } from "../core/time.ts";
import { didYouMean } from "../project/suggest.ts";
import { loadProject } from "../project/root.ts";
import { liveServer, type ServeRecord } from "../read/locate.ts";
import { DEFAULT_LIMIT, tooManyRows } from "../read/wire.ts";
import {
  type Binding, canonicalOrigin, checkContentType, checkHost, checkOrigin, checkToken, isLoopbackHost, isUnspecifiedHost,
  type Refusal, urlHost,
} from "./auth.ts";
import { SERVE_DEFAULTS } from "./instance.ts";
import type { ServeEngine, ServeHealth, ServeJson, ServeQueryData } from "./types.ts";

export const SERVE_FILE = "serve.json";
/** Largest request body accepted (SQL plus params). */
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
/** The bodies of /query requests being read or waiting for the engine, all together. */
export const DEFAULT_MAX_PENDING_BODY_BYTES = 64 * 1024 * 1024;
/** Seconds an idle connection stays open. /query requests are exempt while their query queues and runs. */
export const DEFAULT_IDLE_TIMEOUT_S = 30;
/** The longest socket timeout Bun.serve takes (idleTimeout's own cap). */
const MAX_SOCKET_TIMEOUT_S = 255;

export interface ServerOptions {
  engine: ServeEngine;
  /** The address to listen on; "localhost" binds 127.0.0.1 (Bun would bind ::1 only). */
  host: string;
  /** 0 picks a free port. */
  port: number;
  token: string;
  /** serve.allowOrigins from croft.json. */
  allowOrigins: readonly string[];
  /** The project folder. Its croft.json names the database and time zone unless given below. */
  root: string;
  /** The database label for envelopes and /health (Project.databaseLabel). */
  database?: string;
  timezone?: string;
  /** Applied to every problem's text before it is sent (the project's .env values). Rows are not redacted,
   *  so they equal direct mode's. */
  redact?: (text: string) => string;
  /** An unexpected failure while answering, for the server's own log. */
  onError?: (e: unknown) => void;
  /** When the server started, for /status (default now). */
  startedAt?: string;
  maxBodyBytes?: number;
  maxPendingBodyBytes?: number;
  idleTimeoutS?: number;
  /** How long one /query may take once its body is read (queue wait, the query, the kill of a stuck one). Default:
   *  from serve.queryTimeoutMs in croft.json. */
  requestTimeoutS?: number;
}

export interface RunningServer {
  /** http://<address actually bound>:<port> */
  url: string;
  /** The address actually bound. */
  host: string;
  port: number;
  /** Whether it listens on loopback only. */
  loopback: boolean;
  /** Stop listening. Without force, in-flight requests finish first. */
  stop(force?: boolean): Promise<void>;
}

/** The server's URL for an address and port, IPv6 in brackets. */
export function listenUrl(host: string, port: number): string {
  return `http://${urlHost(host)}:${port}`;
}

/** The HTTP status for a CroftError from the engine (or from the request itself). */
export function httpStatus(e: CroftError): number {
  switch (e.code) {
    case "SERVE_UNAVAILABLE":
    case "DB_BUSY":
    case "DB_HELD_BY_OTHER_PROGRAM":
      return 503;
    case "SERVE_UNAUTHORIZED":
      return typeof e.problem.details?.status === "number" && e.problem.details.status === 403 ? 403 : 401;
    case "QUERY_TOO_MANY_ROWS":
      return 422;
    default:
      return CODES[e.code].exit === 2 ? 400 : 500;
  }
}

/** Retry-After in whole seconds (at least 1) from details.retryAfterMs. */
export function retryAfterSeconds(p: Problem): number {
  const ms = p.details?.retryAfterMs;
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? Math.max(1, Math.ceil(ms / 1000)) : 1;
}

/** Start listening. Throws USAGE_ERROR when the address cannot be bound. */
export function startServer(o: ServerOptions): RunningServer {
  const bindHost = o.host.toLowerCase() === "localhost" ? "127.0.0.1" : o.host.replace(/^\[(.*)\]$/, "$1");
  let meta: { database: string; timezone: string } | undefined =
    o.database !== undefined && o.timezone !== undefined ? { database: o.database, timezone: o.timezone } : undefined;
  const envelopeMeta = () => {
    if (!meta) {
      const p = loadProject({ root: o.root });
      meta = { database: o.database ?? p.databaseLabel, timezone: o.timezone ?? p.timezone };
    }
    return meta;
  };
  const maxBody = o.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const redact = o.redact ?? ((t: string) => t);
  const startedAt = o.startedAt ?? new Date().toISOString();
  const idleTimeoutS = o.idleTimeoutS ?? DEFAULT_IDLE_TIMEOUT_S;
  let binding: Binding = { host: bindHost, port: o.port };
  let url = "";

  const handler = new Handler({
    engine: o.engine, token: o.token, allowOrigins: o.allowOrigins, maxBody, redact, envelopeMeta, root: o.root,
    maxPendingBody: Math.max(o.maxPendingBodyBytes ?? DEFAULT_MAX_PENDING_BODY_BYTES, maxBody), idleTimeoutS,
    requestTimeoutS: () => o.requestTimeoutS ?? requestBudgetS(o.root),
    binding: () => binding, url: () => url, startedAt, onError: o.onError ?? (() => {}),
  });

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: bindHost,
      port: o.port,
      idleTimeout: idleTimeoutS,
      development: false, // never Bun's own error pages: every answer is croft's envelope
      // Explicitly off: with development false, Bun 1.3.14 otherwise binds with SO_REUSEPORT, and a second server
      // on the same port took over its connections (verified). No other process may share the token's port.
      reusePort: false,
      // Bun would answer an oversized body with a bare 413; croft checks its own cap and answers with a problem.
      maxRequestBodySize: Math.max(maxBody * 4, 1024 * 1024),
      fetch: (req, srv) => handler.handle(req, srv),
      error: (e) => handler.internal("serve", e, performance.now()),
    });
  } catch (e) {
    throw bindError(e, bindHost, o.port);
  }
  const port = server.port ?? o.port;
  binding = { host: bindHost, port };
  url = listenUrl(bindHost, port);
  return {
    url, host: bindHost, port, loopback: isLoopbackHost(bindHost),
    stop: async (force = false) => {
      await server.stop(force);
    },
  };
}

/** Seconds one /query may take once its body is read: the longest queue wait, serve.queryTimeoutMs, the kill of a
 *  query interrupts cannot stop, and a margin. */
export function requestBudgetS(root: string): number {
  let queryTimeoutMs: number = SERVE_DEFAULTS.queryTimeoutMs;
  try {
    queryTimeoutMs = loadProject({ root }).config.serve.queryTimeoutMs;
  } catch {}
  return Math.ceil((SERVE_DEFAULTS.queueMs + queryTimeoutMs + SERVE_DEFAULTS.killAfterMs + SERVE_DEFAULTS.disconnectWaitMs) / 1000) + 10;
}

/** What Handler.handle needs from Bun's server: the per-request timeout. */
interface TimeoutControl {
  timeout(req: Request, seconds: number): void;
}

interface HandlerInit {
  engine: ServeEngine;
  token: string;
  allowOrigins: readonly string[];
  maxBody: number;
  maxPendingBody: number;
  idleTimeoutS: number;
  requestTimeoutS: () => number;
  redact: (text: string) => string;
  envelopeMeta: () => { database: string; timezone: string };
  root: string;
  binding: () => Binding;
  url: () => string;
  startedAt: string;
  onError: (e: unknown) => void;
}

type Route = "query" | "status" | "health";
const ROUTES: Record<string, { route: Route; method: "GET" | "POST" }> = {
  "/query": { route: "query", method: "POST" },
  "/status": { route: "status", method: "GET" },
  "/health": { route: "health", method: "GET" },
};
const QUERY_KEYS = ["sql", "params", "limit"];

class Handler {
  /** Bytes of /query bodies being read or waiting for the engine (Content-Length, or maxBody when unknown). */
  private pendingBody = 0;
  private budget: number | null = null;

  constructor(private readonly o: HandlerInit) {}

  async handle(req: Request, srv: TimeoutControl): Promise<Response> {
    const res = await this.route(req, srv);
    // Bun keeps answering a keep-alive connection after the handler awaited the body, whatever the client asked.
    if (asksToClose(req)) res.headers.set("Connection", "close");
    return res;
  }

  private async route(req: Request, srv: TimeoutControl): Promise<Response> {
    const started = performance.now();
    const path = pathOf(req);
    const known = ROUTES[path.replace(/\/+$/, "") || "/"];
    const command = known?.route ?? "serve";
    // CORS headers go on every answer to an allowed page, errors included, so the page can read them.
    const origin = req.headers.get("origin");
    const cors = origin !== null && this.allowed(origin) ? corsHeaders(origin) : {};
    try {
      const refused = checkHost(req.headers.get("host"), this.o.binding()) ?? checkOrigin(origin, this.o.allowOrigins);
      if (refused) return this.refusal(command, refused, started, cors);
      if (req.method === "OPTIONS") return preflight(req, cors);
      const auth = checkToken(this.o.token, req.headers.get("authorization"));
      if (auth) return this.refusal(command, auth, started, cors);
      if (!known) {
        return this.refusal(command, {
          status: 404,
          problem: problem("USAGE_ERROR", {
            message: `croft serve has no endpoint ${req.method} ${path.slice(0, 200)}`,
            hint: "croft serve answers POST /query, GET /status and GET /health",
            details: { status: 404, path: path.slice(0, 200) },
          }),
        }, started, cors);
      }
      if (req.method !== known.method) {
        return this.refusal(command, {
          status: 405,
          headers: { Allow: known.method },
          problem: problem("USAGE_ERROR", {
            message: `${path} takes ${known.method}, not ${req.method}`,
            hint: known.route === "query" ? 'POST /query with a JSON body like {"sql": "SELECT 1"}' : `use GET ${path}`,
            details: { status: 405, method: req.method },
          }),
        }, started, cors);
      }
      if (known.route === "health") return json(200, this.health(), cors);
      if (known.route === "status") return await this.status(started, cors);
      return await this.query(req, srv, started, cors);
    } catch (e) {
      return this.internal(command, e, started, cors);
    }
  }

  private allowed(origin: string): boolean {
    const c = canonicalOrigin(origin);
    return c !== null && this.o.allowOrigins.some((a) => canonicalOrigin(a) === c);
  }

  private async query(req: Request, srv: TimeoutControl, started: number, cors: Record<string, string>): Promise<Response> {
    const type = checkContentType(req.headers.get("content-type"));
    if (type) return this.refusal("query", type, started, cors);
    const length = req.headers.get("content-length");
    const declared = length === null ? NaN : Number(length);
    if (declared > this.o.maxBody) return this.tooLarge(started, cors);
    // Room for this body among the others still being read or waiting: otherwise 503 before reading it.
    const reserved = Number.isSafeInteger(declared) && declared >= 0 ? declared : this.o.maxBody;
    if (this.pendingBody > 0 && this.pendingBody + reserved > this.o.maxPendingBody) return this.bodiesFull(started, cors);
    this.pendingBody += reserved;
    try {
      // Read under the idle timeout: a body that never comes does not hold the connection.
      let text: string;
      try {
        text = await req.text();
      } catch (e) {
        // The client went away (or was timed out) before its body came: nobody reads an answer, and it is no bug.
        if (req.signal.aborted) return new Response(null, { status: 499 });
        throw e;
      }
      if (Buffer.byteLength(text, "utf8") > this.o.maxBody) return this.tooLarge(started, cors);
      const body = parseQueryBody(text);
      if ("status" in body) return this.refusal("query", body, started, cors);
      // The query may queue for a writer and then run up to serve.queryTimeoutMs: its own budget meanwhile, then the
      // idle timeout again, before the answer goes out (Bun keeps a request's timeout on its keep-alive socket).
      // Bun's socket timeouts go up to 255 s; a longer budget lifts the timeout while the query runs.
      this.budget ??= this.o.requestTimeoutS();
      srv.timeout(req, this.budget > MAX_SOCKET_TIMEOUT_S ? 0 : this.budget);
      try {
        return await this.answer(req, body, started, cors);
      } finally {
        srv.timeout(req, this.o.idleTimeoutS);
      }
    } finally {
      this.pendingBody -= reserved;
    }
  }

  private async answer(req: Request, body: { sql: string; params: unknown[]; limit: number }, started: number, cors: Record<string, string>): Promise<Response> {
    try {
      const data = await this.o.engine.query({ ...body, signal: req.signal });
      // Never pass on more rows than asked for: the client would refuse them anyway.
      if (data.rows.length > body.limit) throw tooManyRows(body.limit, { rowsReturned: data.rows.length, via: "croft serve" });
      const out: ServeQueryData & { truncatedRows: 0; truncatedValues: 0 } = { ...data, truncatedRows: 0, truncatedValues: 0 };
      return json(200, this.envelope("query", out, started), cors);
    } catch (e) {
      // The client went away and the engine gave up on its query: nobody reads this answer, and it is no bug.
      if (req.signal.aborted && !(e instanceof CroftError)) return new Response(null, { status: 499 });
      if (!(e instanceof CroftError)) throw e;
      return this.problemResponse("query", e, started, cors);
    }
  }

  /** A CroftError as an answer, with the status (and Retry-After) the read client expects. */
  private problemResponse(command: string, e: CroftError, started: number, cors: Record<string, string>): Response {
    const status = httpStatus(e);
    const headers: Record<string, string> = status === 503 ? { "Retry-After": String(retryAfterSeconds(e.problem)) } : {};
    return this.refusal(command, { status, problem: e.problem, headers }, started, cors);
  }

  private tooLarge(started: number, cors: Record<string, string>): Response {
    return this.refusal("query", {
      status: 413,
      problem: problem("USAGE_ERROR", {
        message: `the request body is larger than croft serve accepts (${this.o.maxBody.toLocaleString("en-US")} bytes)`,
        hint: "send shorter SQL, or fewer or smaller params",
        details: { status: 413, maxBytes: this.o.maxBody },
      }),
    }, started, cors);
  }

  /** Too many request bodies are being read or wait for the engine already. */
  private bodiesFull(started: number, cors: Record<string, string>): Response {
    const mb = (n: number) => `${Math.max(1, Math.round(n / 1024 / 1024))} MB`;
    return this.problemResponse("query", new CroftError("SERVE_UNAVAILABLE", {
      message: `croft serve is holding ${mb(this.pendingBody)} of queries that wait for an answer (at most ${mb(this.o.maxPendingBody)}); this one was not read`,
      hint: "retry after Retry-After; send fewer queries at once, or smaller ones (large IN lists belong in a table)",
      retryable: true,
      details: { reason: "busy", retryAfterMs: SERVE_DEFAULTS.retryAfterMs, pendingBytes: this.pendingBody, maxPendingBytes: this.o.maxPendingBody },
    }), started, cors);
  }

  private health(): ServeHealth {
    const s = this.o.engine.status();
    return { ok: true, pid: process.pid, version: CROFT_VERSION, database: this.o.envelopeMeta().database, writeIntent: s.writeIntent, queriesToday: s.queriesToday };
  }

  /** This server and its engine: data.serve of GET /status. */
  private serveInfo() {
    const b = this.o.binding();
    return { url: this.o.url(), pid: process.pid, host: b.host, port: b.port, version: CROFT_VERSION, startedAt: this.o.startedAt, engine: this.o.engine.status() };
  }

  /** GET /status: `croft status --json`'s envelope, built from files and runs.sqlite without importing asset code. */
  private async status(started: number, cors: Record<string, string>): Promise<Response> {
    let state: Awaited<ReturnType<typeof collectStatus>>;
    try {
      state = await collectStatus(loadProject({ root: this.o.root }), now(), { resolved: null });
    } catch (e) {
      if (!(e instanceof CroftError)) throw e;
      return this.problemResponse("status", e, started, cors);
    }
    const data: StatusData & { serve: ReturnType<Handler["serveInfo"]> } = { ...state.data, serve: this.serveInfo() };
    const problems = [...state.problems, ...state.edited, ...state.scheduling].map((p) => redactProblem(p, this.o.redact));
    return json(200, this.envelope("status", data, started, problems), cors);
  }

  private envelope<T>(command: string, data: T, started: number, problems: Problem[] = []) {
    return buildEnvelope({ command, data, problems, next: [], ...this.o.envelopeMeta(), durationMs: performance.now() - started });
  }

  private refusal(command: string, r: Refusal, started: number, cors: Record<string, string>): Response {
    const p = redactProblem(r.problem, this.o.redact);
    return json(r.status, { ...this.envelope(command, null, started, [p]), ok: false }, { ...cors, ...r.headers });
  }

  /** An unexpected failure: croft's bug. The message goes out (redacted); the stack stays in the server's log. */
  internal(command: string, e: unknown, started: number, cors: Record<string, string> = {}): Response {
    this.o.onError(e);
    const err = e instanceof Error ? e : new Error(String(e));
    const p = problem("INTERNAL_ERROR", {
      message: `croft serve failed while answering: ${err.name}: ${err.message.split("\n")[0]!.slice(0, 300)}`,
      hint: "this is a bug in croft, not in the query; the server's terminal shows the details; report it with the query that failed",
      fix: { kind: "manual", description: "report the bug with the query that failed" },
      retryable: false,
    });
    try {
      return this.refusal(command, { status: 500, problem: p }, started, cors);
    } catch {
      return new Response('{"ok":false}', { status: 500, headers: { "Content-Type": "application/json" } });
    }
  }
}

/** Whether the request asked to close the connection after the answer. */
function asksToClose(req: Request): boolean {
  return (req.headers.get("connection") ?? "").toLowerCase().split(",").some((t) => t.trim() === "close");
}

function pathOf(req: Request): string {
  try {
    return new URL(req.url).pathname;
  } catch {
    // Bun builds req.url from the Host header; a Host that is not a host (refused next) can break it.
    const m = /^[a-z]+:\/\/[^/]*(\/[^?#]*)?/i.exec(req.url) ?? /^(\/[^?#]*)/.exec(req.url);
    return m?.[1] ?? "/";
  }
}

function corsHeaders(origin: string): Record<string, string> {
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
}

/** A CORS preflight (OPTIONS) from an allowed page, or a plain OPTIONS. Preflights carry no credentials. */
function preflight(req: Request, cors: Record<string, string>): Response {
  const headers: Record<string, string> = { Allow: "GET, POST, OPTIONS", ...cors };
  if (cors["Access-Control-Allow-Origin"]) {
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
    headers["Access-Control-Max-Age"] = "600";
    // Chrome's Private Network Access: a public page calling a loopback server asks first.
    if (req.headers.get("access-control-request-private-network") === "true") headers["Access-Control-Allow-Private-Network"] = "true";
  }
  return new Response(null, { status: 204, headers });
}

/** JSON with bigints as digit strings (the renderer produces none; direct mode does the same, read/select.ts). */
function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const text = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return new Response(text, {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers },
  });
}

// JSON.parse with the reviver's source text (Bun, Node 21+); TypeScript's lib does not declare the third argument.
type Reviver = (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown;

/** Integers beyond ±2^53 come back as bigints: the read client sends bigint params as exact digits. */
function parseLossless(text: string): unknown {
  const reviver: Reviver = (_k, v, ctx) =>
    typeof v === "number" && !Number.isSafeInteger(v) && typeof ctx?.source === "string" && /^-?\d+$/.test(ctx.source) ? BigInt(ctx.source) : v;
  return JSON.parse(text, reviver as Parameters<typeof JSON.parse>[1]);
}

/** {sql, params?, limit?} from a request body, or the 400 that says what is wrong with it. */
export function parseQueryBody(text: string): { sql: string; params: unknown[]; limit: number } | Refusal {
  const bad = (message: string, hint: string, details: Record<string, unknown> = {}): Refusal => ({
    status: 400,
    problem: problem("USAGE_ERROR", {
      message, hint, details: { status: 400, ...details },
      fix: { kind: "manual", description: 'send a JSON object with "sql" and, optionally, "params" and "limit"' },
    }),
  });
  const shape = 'POST /query takes a JSON object like {"sql": "SELECT * FROM t WHERE id = $1", "params": [42], "limit": 1000}';
  let body: unknown;
  try {
    body = parseLossless(text);
  } catch (e) {
    return bad(`the request body is not JSON: ${(e as Error).message.slice(0, 200)}`, shape);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("the request body must be a JSON object", shape);
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (QUERY_KEYS.includes(key)) continue;
    const guess = didYouMean(key, QUERY_KEYS);
    return bad(`the request body has an unknown key ${JSON.stringify(key.slice(0, 100))}`,
      guess ? `did you mean "${guess}"? ${shape}` : `POST /query takes sql, params and limit; ${shape}`, { key: key.slice(0, 100) });
  }
  if (typeof b.sql !== "string" || b.sql.trim() === "") return bad('"sql" must be one SELECT as a non-empty string', shape);
  if (b.params !== undefined && b.params !== null && !Array.isArray(b.params)) {
    return bad('"params" must be an array bound to $1, $2, ...', shape);
  }
  let limit = DEFAULT_LIMIT;
  if (b.limit !== undefined && b.limit !== null) {
    if (typeof b.limit !== "number" || !Number.isSafeInteger(b.limit) || b.limit < 1) {
      return bad(`"limit" must be a whole number of rows, 1 or more; found ${JSON.stringify(typeof b.limit === "bigint" ? String(b.limit) : b.limit)}`,
        `omit it for the default of ${DEFAULT_LIMIT.toLocaleString("en-US")}`);
    }
    limit = b.limit;
  }
  return { sql: b.sql, params: (b.params as unknown[] | null | undefined) ?? [], limit };
}

/** Why Bun.serve could not listen, as a USAGE_ERROR with the fix. Bun reports every failure as EADDRINUSE,
 *  an address that is not this machine's included, so the address is checked here. */
function bindError(e: unknown, host: string, port: number): CroftError {
  const code = (e as { code?: string }).code ?? "";
  const shown = `${urlHost(host)}:${port}`;
  const local = isLoopbackHost(host) || isUnspecifiedHost(host) || localAddresses().has(host.toLowerCase());
  const next = port === 0 || port >= 65535 ? 7448 : port + 1;
  if (!local) {
    return new CroftError("USAGE_ERROR", {
      message: `croft serve cannot listen on ${shown}: ${host} is not ${isIP(host) ? "an address of this machine" : "a name this machine listens on"}`,
      hint: "leave --host out to listen on 127.0.0.1 (this machine only); use an address of this machine otherwise",
      fix: { kind: "command", description: "listen on this machine only", command: "croft serve", requiresHuman: true },
      details: { host, port, error: code || String(e) },
    });
  }
  return new CroftError("USAGE_ERROR", {
    message: `croft serve cannot listen on ${shown}: the port is in use by another program`,
    hint: `stop what uses port ${port}, or pick another port with --port (or serve.port in croft.json)`,
    fix: { kind: "command", description: `listen on port ${next} instead`, command: `croft serve --port ${next}`, requiresHuman: true },
    details: { host, port, error: code || String(e) },
  });
}

function localAddresses(): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) out.add(a.address.toLowerCase());
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// serve.json

export function serveJsonPath(stateDir: string): string {
  return join(stateDir, SERVE_FILE);
}

/** The refusal to start a second croft serve for one project. */
export function alreadyServing(r: ServeRecord): CroftError {
  return new CroftError("USAGE_ERROR", {
    message: `croft serve is already running for this project (pid ${r.pid}, ${r.url})`,
    hint: `apps already reach it through .croft/serve.json; to restart it, stop that one first (Ctrl-C in its terminal, or kill ${r.pid})`,
    fix: { kind: "manual", description: `stop the running croft serve (pid ${r.pid}) before starting another`, requiresHuman: true },
    details: { pid: r.pid, url: r.url },
  });
}

/**
 * Write <state>/serve.json: mode 0600 (it holds the token), atomically (a reader sees the whole file or none).
 * Hard-linking the temporary file into place fails when a record exists, so two servers starting at once cannot
 * both claim the project: a live server's record is refused (USAGE_ERROR), a dead one's is replaced.
 */
export function writeServeJson(stateDir: string, rec: ServeJson): void {
  const file = serveJsonPath(stateDir);
  const tmp = join(stateDir, `.${SERVE_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    fchmodSync(fd, 0o600); // whatever the umask
    writeSync(fd, `${JSON.stringify(rec, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    try {
      linkSync(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOSYS" && code !== "EXDEV") throw e;
    }
    // A record exists (or the filesystem has no hard links): only a dead server's, or our own, may be replaced.
    const live = liveServer(stateDir);
    if (live && live.pid !== rec.pid) throw alreadyServing(live);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Remove serve.json if it is this process's record (never another server's). Returns whether it did. */
export function removeServeJson(stateDir: string, pid: number = process.pid): boolean {
  const file = serveJsonPath(stateDir);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
  if (!raw || typeof raw !== "object" || (raw as { pid?: unknown }).pid !== pid) return false;
  rmSync(file, { force: true });
  return true;
}
