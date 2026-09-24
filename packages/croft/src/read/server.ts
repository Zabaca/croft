// Server mode of @zabaca/croft/read: POST /query to croft serve (DESIGN.md §5 "Server mode, apps and GUIs").
//
// - `POST <url>/query` with {sql, params?, limit}, a bearer token and Content-Type: application/json.
// - The reply is the `query` envelope (§4.3). Rows come back already rendered in json mode, exactly as
//   direct mode renders them; any reported truncation, or more rows than the limit, is QUERY_TOO_MANY_ROWS.
// - While a run writes, the server answers 503 with Retry-After. The client honors it until `timeoutMs`
//   (default 10 s) has passed, then throws SERVE_UNAVAILABLE; an unreachable explicit URL is retried the
//   same way. An explicit URL never falls back to the file.
// - A 401/403 is SERVE_UNAUTHORIZED (a missing or wrong token), never retried.
// - A server found only through serve.json that does not answer counts as absent: the caller reads directly.
// It uses no Bun-only APIs: this file ships in the Node build.
import { CroftError, isCode, type ProblemInit } from "../core/errors.ts";
import type { Row } from "../types.ts";
import { CROFT_VERSION } from "../db/state.ts";
import { post, TransportError, type HttpReply } from "./http.ts";
import { type SelectRequest, stringifyLossless, tooManyRows } from "./wire.ts";

export const DEFAULT_TIMEOUT_MS = 10_000;

export interface ServerTarget {
  url: URL;                   // croft serve's base URL
  token: string | null;
  tokenSource: "option" | "CROFT_SERVE_TOKEN" | "serve.json" | null;
  local: boolean;             // found through serve.json: a server that does not answer counts as absent
}

export interface ServerTimings {
  timeoutMs: number;          // how long to keep retrying 503s and unreachable servers
  responseGraceMs: number;    // extra wait for a reply beyond timeoutMs: the query itself may take a while
  localConnectMs: number;     // a serve.json server that does not accept a connection this fast is absent
}

// croft serve admits a query within 10 s and interrupts it at serve.queryTimeoutMs (30 s by default), so a
// healthy server always answers well within timeoutMs plus a minute.
export const DEFAULT_SERVER_TIMINGS: Omit<ServerTimings, "timeoutMs"> = { responseGraceMs: 60_000, localConnectMs: 1000 };

/** Returned instead of rows when a serve.json server does not answer. */
export const ABSENT: unique symbol = Symbol("read server absent");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function backoffMs(attempt: number): number {
  const base = Math.min(1000, 50 * 2 ** Math.min(attempt, 5));
  return Math.round(base / 2 + Math.random() * (base / 2));
}

/** `<base>/query`; a base that already ends in /query is used as is. */
export function queryEndpoint(base: URL): URL {
  if (/\/query\/?$/.test(base.pathname)) return new URL(base.href);
  const u = new URL(base.href);
  u.pathname = u.pathname.endsWith("/") ? `${u.pathname}query` : `${u.pathname}/query`;
  u.search = "";
  u.hash = "";
  return u;
}

/** Retry-After in ms: delay-seconds (fractions tolerated) or an HTTP date. null when absent or unparsable. */
export function retryAfterMs(value: string | undefined, now = Date.now()): number | null {
  if (value === undefined) return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export async function serverQuery(target: ServerTarget, req: SelectRequest, t: ServerTimings): Promise<Row[] | typeof ABSENT> {
  const endpoint = queryEndpoint(target.url);
  const body = stringifyLossless(req.params.length ? { sql: req.sql, params: req.params, limit: req.limit } : { sql: req.sql, limit: req.limit });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": `croft-read/${CROFT_VERSION}`,
  };
  if (target.token) {
    // The token travels in a header line; a control character there could inject headers.
    if (/[\x00-\x1f\x7f]/.test(target.token)) {
      throw new CroftError("USAGE_ERROR", {
        message: `the read server token from ${target.tokenSource} contains a control character`,
        hint: "use the token exactly as written in .croft/serve.json",
      });
    }
    headers.Authorization = `Bearer ${target.token}`;
  }
  const start = Date.now();
  const deadline = start + Math.max(0, t.timeoutMs);
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - Date.now();
    let reply: HttpReply;
    try {
      reply = await post(endpoint, body, headers, {
        connectMs: target.local ? t.localConnectMs : Math.max(250, remaining),
        responseMs: Math.max(0, remaining) + t.responseGraceMs,
      });
    } catch (e) {
      if (!(e instanceof TransportError)) throw e;
      if (target.local) return ABSENT;
      if (Date.now() >= deadline) throw unavailable(target, `cannot reach croft's read server at ${target.url.origin}: ${e.message}`, start, { reason: "unreachable", phase: e.phase });
      await sleep(Math.min(backoffMs(attempt), Math.max(1, deadline - Date.now())));
      continue;
    }
    const envelope = parseJson(reply.body);
    if (reply.status === 503 || reply.status === 502 || reply.status === 504) {
      // 503: croft serve stepped aside for a writer. 502/504: a reverse proxy in front of a restarting server.
      const now = Date.now();
      if (now >= deadline) {
        const problem = errorProblem(envelope);
        throw unavailable(target, `croft's read server at ${target.url.origin} still answered ${reply.status} after ${secs(now - start)} s${problem?.message ? ` (${String(problem.message)})` : ""}`, start,
          { reason: "busy", status: reply.status, retryAfter: reply.headers["retry-after"] ?? null });
      }
      const wait = retryAfterMs(reply.headers["retry-after"], now) ?? backoffMs(attempt);
      await sleep(Math.max(1, Math.min(wait, deadline - now)));
      continue;
    }
    return rowsFrom(target, reply, envelope, req.limit);
  }
}

function secs(ms: number): number {
  return Math.round(ms / 100) / 10;
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function errorProblem(envelope: Record<string, unknown> | null): Record<string, unknown> | null {
  const problems = envelope?.problems;
  if (!Array.isArray(problems)) return null;
  const p = problems.find((x) => x && typeof x === "object" && (x as { severity?: unknown }).severity === "error");
  return (p as Record<string, unknown> | undefined) ?? null;
}

function rowsFrom(target: ServerTarget, reply: HttpReply, envelope: Record<string, unknown> | null, limit: number): Row[] {
  const problem = errorProblem(envelope);
  // A rejected token gets token advice, unless the server named a code this croft knows.
  if ((reply.status === 401 || reply.status === 403) && !(problem && isCode(String(problem.code)))) throw unauthorized(target, reply.status);
  if (problem) throw fromProblem(problem, reply.status);
  if (reply.status < 200 || reply.status >= 300 || !envelope) {
    throw new CroftError("SERVE_UNAVAILABLE", {
      message: `croft's read server at ${target.url.origin} answered ${reply.status} without a query envelope`,
      hint: "check that { url } / CROFT_URL points at a croft read server",
      retryable: reply.status >= 500,
      details: { url: target.url.origin, status: reply.status, body: reply.body.slice(0, 200) },
    });
  }
  const data = envelope.data as Record<string, unknown> | undefined;
  if (envelope.ok === false || !data || !Array.isArray(data.rows)) {
    throw new CroftError("INTERNAL_ERROR", {
      message: `croft's read server at ${target.url.origin} sent a query envelope without rows`,
      hint: "use the same croft version for the app and the server",
      details: { url: target.url.origin, status: reply.status, ok: envelope.ok ?? null, croftVersion: envelope.croftVersion ?? null },
    });
  }
  // Never hand an app a partial result: croft serve's own caps (limit, serve.maxBytes) must not leak through.
  const truncatedRows = data.truncatedRows;
  const truncatedValues = data.truncatedValues;
  if (reported(truncatedRows) || data.rows.length > limit) {
    throw tooManyRows(limit, { truncatedRows: truncatedRows ?? null, rowsReturned: data.rows.length, via: "read server" });
  }
  if (reported(truncatedValues)) {
    throw new CroftError("QUERY_TOO_MANY_ROWS", {
      message: "croft's read server shortened some values in this result; croft never returns a partial result",
      hint: "select fewer or smaller columns, or raise serve.maxBytes in croft.json",
      retryable: false,
      details: { truncatedValues, via: "read server" },
    });
  }
  return data.rows as Row[];
}

/** A truncation field that reports truncation: a positive count or true. */
function reported(v: unknown): boolean {
  return v === true || (typeof v === "number" && v > 0) || (Array.isArray(v) && v.length > 0);
}

/** Rebuild the server's problem as a CroftError, so an app sees the same code in both modes. */
export function fromProblem(p: Record<string, unknown>, status: number): CroftError {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const init: ProblemInit = {
    message: str(p.message) ?? `croft's read server answered ${status}`,
    hint: str(p.hint) ?? "",
  };
  if (str(p.asset)) init.asset = str(p.asset);
  if (str(p.file)) init.file = str(p.file);
  if (num(p.line) !== undefined) init.line = num(p.line);
  if (num(p.column) !== undefined) init.column = num(p.column);
  if (str(p.runId)) init.runId = str(p.runId);
  if (str(p.effect)) init.effect = str(p.effect);
  if (typeof p.retryable === "boolean") init.retryable = p.retryable;
  if (p.fix && typeof p.fix === "object") init.fix = p.fix as ProblemInit["fix"];
  if (p.details && typeof p.details === "object") init.details = p.details as Record<string, unknown>;
  const code = str(p.code) ?? "";
  if (isCode(code)) return new CroftError(code, init);
  // A code this croft does not know means the app and the server run different croft versions.
  return new CroftError("INTERNAL_ERROR", {
    ...init,
    message: `${code || "error"} from croft's read server: ${init.message}`,
    hint: init.hint || "use the same croft version for the app and the server",
    details: { ...init.details, remoteCode: code || null, status },
  });
}

function unavailable(target: ServerTarget, message: string, start: number, details: Record<string, unknown>): CroftError {
  const explicit = target.local ? "" : " (an explicit URL never falls back to reading the file)";
  return new CroftError("SERVE_UNAVAILABLE", {
    message: message + explicit,
    hint: details.reason === "busy"
      ? "a run is writing; retry shortly, or pass a larger { timeoutMs } to query()"
      : "check { url } / CROFT_URL and that the server is running",
    retryable: true,
    details: { url: target.url.origin, waitedMs: Date.now() - start, ...details },
  });
}

function unauthorized(target: ServerTarget, status: number): CroftError {
  const message = target.token
    ? `croft's read server at ${target.url.origin} rejected the token from ${target.tokenSource} (${status})`
    : `croft's read server at ${target.url.origin} requires a token (${status}), and none was found`;
  return new CroftError("SERVE_UNAUTHORIZED", {
    message,
    hint: "pass { token }, or set CROFT_SERVE_TOKEN to the token in the project's .croft/serve.json (or the server's CROFT_SERVE_TOKEN)",
    fix: { kind: "manual", description: "give query() the server's token" },
    retryable: false,
    details: { url: target.url.origin, status, tokenSource: target.tokenSource },
  });
}
