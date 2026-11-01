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
export function restartedError(e: WorkerGone | null, what: "query worker" | "readers' process" = "query worker"): CroftError {
  return new CroftError("SERVE_UNAVAILABLE", {
    message: `croft's read server restarted its ${what} while this query ran (to end another query that interrupts could not stop, or after a crash); it returned nothing`,
    hint: "retry after Retry-After; if it keeps failing, the query itself may be too heavy: filter or aggregate in SQL",
    retryable: true,
    details: { reason: "restarted", retryAfterMs: RETRY_AFTER_MS, worker: e?.message ?? null },
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
