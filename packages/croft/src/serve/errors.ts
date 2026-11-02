// The errors both of croft serve's engines raise the same way (DESIGN.md §5 "Server mode, apps and GUIs"): the file
// engine (serve/instance.ts) and server mode's readers' engine (serve/readers.ts). Each says what stopped a query and
// what the client may do; the ones that depend on an engine's own state (a writer, a copy) stay in that engine.
import { CroftError } from "../core/errors.ts";
import type { WorkerGone } from "./query-worker.ts";
import type { StopReason } from "./queue.ts";

/** What a 503 tells the client to wait: a write step, or a restart, usually takes seconds. */
export const RETRY_AFTER_MS = 1000;

/** Milliseconds as seconds with one decimal: 2500 is 2.5. */
export const secs = (ms: number) => Math.round(ms / 100) / 10;

/** What a query that ran in a worker which went away under it reports (killed to end another, stuck query, or crashed). */
export function restartedError(e: WorkerGone | null, what: "query worker" | "readers' process" | "lake process" = "query worker"): CroftError {
  return new CroftError("SERVE_UNAVAILABLE", {
    message: `croft's read server restarted its ${what} while this query ran (to end another query that interrupts could not stop, or after a crash); it returned nothing`,
    hint: "retry after Retry-After; if it keeps failing, the query itself may be too heavy: filter or aggregate in SQL",
    retryable: true,
    details: { reason: "restarted", retryAfterMs: RETRY_AFTER_MS, worker: e?.message ?? null },
  });
}

/**
 * Why a query was not admitted within queueMs: the engine has no process yet (`what` names it, "the readers' process for the read copy"),
 * or every slot stayed busy. Shared by the engines that run one process of their own (server mode's and a lake's).
 */
export function notAdmittedError(o: { what: string; waitedMs: number; state: string; attempts: number; maxConcurrent: number }): CroftError {
  if (o.state !== "open") {
    return new CroftError("SERVE_UNAVAILABLE", {
      message: `croft's read server has no ${o.what} yet (waited ${secs(o.waitedMs)} s); the query was not run`,
      hint: "retry after Retry-After: croft serve starts the process again after a kill or a crash; croft doctor shows what is wrong if it keeps failing",
      retryable: true,
      details: { reason: "unavailable", retryAfterMs: RETRY_AFTER_MS, waitedMs: o.waitedMs, state: o.state, attempts: o.attempts },
    });
  }
  return new CroftError("SERVE_UNAVAILABLE", {
    message: `all ${o.maxConcurrent} query slots of croft's read server stayed busy for ${secs(o.waitedMs)} s; the query was not run`,
    hint: "retry after Retry-After; slow queries hold the slots, so filter or aggregate them in SQL, or raise serve.maxConcurrent in croft.json",
    retryable: true,
    details: { reason: "busy", retryAfterMs: RETRY_AFTER_MS, waitedMs: o.waitedMs, maxConcurrent: o.maxConcurrent },
  });
}

/** A query refused because maxQueued already wait. */
export function queueFullError(maxQueued: number, maxConcurrent: number): CroftError {
  return new CroftError("SERVE_UNAVAILABLE", {
    message: `${maxQueued} queries are already waiting for croft's read server; this one was not queued`,
    hint: "retry after Retry-After; send fewer queries at once, or make them cheaper (filter or aggregate in SQL) so the slots free up sooner",
    retryable: true,
    details: { reason: "busy", retryAfterMs: RETRY_AFTER_MS, maxQueued, maxConcurrent },
  });
}

/** A key's query when the project shares no table: every key query is refused, so turning keys on never exposes a table by
 *  accident (D122). The server answers it before the engine is asked (403), and each engine refuses it too. */
export function noSharedTables(): CroftError {
  return new CroftError("SERVE_NO_SHARED_TABLES", {
    message: "the project shares no table with keys, so this key can read nothing",
    hint: 'name the tables keys may read in croft.json, like "serve": {"sharedTables": ["orders"]}, and restart croft serve',
    fix: { kind: "manual", description: 'add "serve": {"sharedTables": [...]} to croft.json with the tables to share, then restart croft serve', requiresHuman: true },
    retryable: false,
    details: { status: 403 },
  });
}

/** A key's query when croft serve does not run in server mode (D128): a person's key works only there, where every query has two
 *  walls, the gate and the readers' views database. The server answers it before the body is read (403), and the file engine
 *  refuses it too, so no path lets a key through a single wall. The app token is not affected. */
export function keyNeedsServerMode(): CroftError {
  return new CroftError("SERVE_KEY_NEEDS_SERVER_MODE", {
    message: "a key reads only when croft serve runs in server mode, and this croft serve does not",
    hint: 'turn server mode on in croft.json ("serverMode": {"enabled": true}) and restart croft serve; the app token is not affected',
    fix: { kind: "manual", description: 'ask the user to set "serverMode": {"enabled": true} in croft.json (apps then read the read copy, as of the last run), then restart croft serve', requiresHuman: true },
    retryable: false,
    details: { status: 403 },
  });
}

/** A Quack address other than loopback, which the project has not accepted (D131): Quack's own TLS is off there, so keys and queries
 *  cross the network in plaintext unless an HTTPS reverse proxy of the user's own sits in front. croft serve does not start. */
export function plaintextNotAccepted(uri: string): CroftError {
  return new CroftError("QUACK_PLAINTEXT_NOT_ACCEPTED", {
    message: `serverMode.quackHost makes croft serve listen for DuckDB clients on ${uri.replace(/^quack:/, "")}, which is not this machine only; Quack there carries keys and queries in plaintext`,
    hint: 'keep quackHost on 127.0.0.1 (a reverse proxy on this machine needs nothing else), or, behind an HTTPS reverse proxy of your own, set "serverMode": {"quackPlaintextOnNetwork": true}',
    fix: { kind: "manual", description: 'ask the user: remove "serverMode.quackHost" from croft.json to listen on this machine only, or set "serverMode.quackPlaintextOnNetwork" to true if an HTTPS reverse proxy is in front', requiresHuman: true },
    retryable: false,
    details: { uri },
  });
}

/** What a query stopped for its deadline, because its request went away, or because the server is stopping reports.
 *  A query stopped for a writer is the file engine's alone. */
export function stopError(reason: Exclude<StopReason, "write">, o: { queryTimeoutMs: number }): CroftError {
  switch (reason) {
    case "timeout":
      return new CroftError("TIMEOUT", {
        message: `the query ran longer than serve.queryTimeoutMs (${secs(o.queryTimeoutMs)} s) and was stopped`,
        hint: "make it cheaper (filter or aggregate in SQL, add a LIMIT), or raise serve.queryTimeoutMs in croft.json",
        retryable: false,
        details: { phase: "query", timeoutMs: o.queryTimeoutMs },
      });
    case "abort":
      return new CroftError("INTERRUPTED", {
        message: "the request went away, so its query was stopped",
        hint: "nothing to do: the client disconnected or cancelled the request",
        details: { reason: "abort" },
      });
    case "stop":
      return new CroftError("SERVE_UNAVAILABLE", {
        message: "croft's read server is stopping; the query was not answered",
        hint: "retry once croft serve runs again; without it, @zabaca/croft/read reads the file directly",
        retryable: true,
        details: { reason: "stopping", retryAfterMs: RETRY_AFTER_MS },
      });
  }
}
