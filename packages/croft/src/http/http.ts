// ctx.http: fetch plus the few things an API ingest always needs (DESIGN.md §3a "ctx.http").
//
// - Retries network errors, timeouts, 429 and 5xx up to 3 times, honoring Retry-After (seconds or an
//   HTTP date). A Retry-After longer than croft is willing to wait inside a run is not slept through:
//   the request fails at once with retryAfterMs in the details, so the runner can schedule the retry.
// - A per-request timeout (30 s) linked to the run's AbortSignal. The timeout covers reading the body
//   too, because the combined signal is handed to fetch, which aborts the body stream [verified].
// - Aborting the run is never retried: the request rejects with the signal's reason, as fetch does, so
//   the runner can tell Ctrl-C and its own timeout apart from an HTTP failure.
// - HTTP_ERROR carries {method, url (redacted), status, attempts, retryAfterMs, requestIndex} and the
//   first 500 bytes of the body. Every URL, body and message that leaves this module is redacted.
// - res.next comes from the Link header; res.json() is lossless (unsafe integers become bigint).
import { CroftError } from "../core/errors.ts";
import type { Http, HttpInit, HttpResponse } from "../types.ts";

export interface HttpOptions {
  /** The run's signal: Ctrl-C/SIGTERM, the step's no-progress timeout, the preview row cap. */
  signal: AbortSignal;
  /** Hides secret values (ProjectEnv.redact). Applied to every URL, body excerpt and log line. */
  redact?: (text: string) => string;
  /** The step log. Receives one line per retry; never a secret. */
  log?: (message: string) => void;
  /** Default retries per request (default 3). HttpInit.retries overrides it per call. */
  retries?: number;
  /** Default per-request timeout (default 30 s). HttpInit.timeoutMs overrides it per call. */
  timeoutMs?: number;
  /** First backoff when the server gives no Retry-After (default 500 ms, doubling, with jitter). */
  retryBaseMs?: number;
  /** The longest Retry-After croft sleeps through inside a run (default 5 min, half the default
   *  no-progress timeout). Longer waits fail at once with retryAfterMs so the run can be retried later. */
  maxRetryAfterMs?: number;
}

/** Http plus counters the runner reports (StepResult.requests, run progress). */
export interface HttpClient extends Http {
  /** Logical requests made: one per get()/post() call, whatever its retries. */
  readonly requests: number;
  /** HTTP attempts sent, retries included. */
  readonly attempts: number;
}

export const HTTP_DEFAULTS = {
  retries: 3,
  timeoutMs: 30_000,
  retryBaseMs: 500,
  maxRetryAfterMs: 300_000,
  bodyExcerptBytes: 500,
} as const;

type Failure =
  | { reason: "status"; status: number; statusText: string; body: string; retryAfterMs: number | null }
  | { reason: "timeout"; timeoutMs: number }
  | { reason: "network"; message: string };

export function createHttp(opts: HttpOptions): HttpClient {
  const redact = opts.redact ?? ((s: string) => s);
  const log = opts.log ?? (() => {});
  let requests = 0;
  let attempts = 0;

  async function request(method: "GET" | "POST", url: string, body: unknown, init: HttpInit = {}): Promise<HttpResponse> {
    const requestIndex = ++requests;
    const signal = opts.signal;
    if (signal.aborted) throw abortReason(signal);
    const target = buildUrl(url, init.query, (message) => httpError({
      message: `${method} ${redact(url)}: ${message}`,
      hint: "pass a full URL such as https://api.example.com/items",
      details: { method, url: redact(url), status: null, attempts: 0, retryAfterMs: null, requestIndex, reason: "invalid_url" },
      retryable: false,
    }));
    const headers = new Headers(init.headers ?? {});
    const payload = method === "POST" ? encodeBody(body, headers) : undefined;
    // A stream can be sent once only, so a request with a stream body is never retried.
    const retries = payload instanceof ReadableStream ? 0 : clampRetries(init.retries ?? opts.retries ?? HTTP_DEFAULTS.retries);
    const timeoutMs = positive(init.timeoutMs ?? opts.timeoutMs, HTTP_DEFAULTS.timeoutMs);
    const retryBaseMs = opts.retryBaseMs ?? HTTP_DEFAULTS.retryBaseMs;
    const maxRetryAfterMs = opts.maxRetryAfterMs ?? HTTP_DEFAULTS.maxRetryAfterMs;
    const shown = redact(displayUrl(target));

    for (let attempt = 1; ; attempt++) {
      if (signal.aborted) throw abortReason(signal);
      attempts++;
      const timeout = AbortSignal.timeout(timeoutMs);
      let failure: Failure;
      try {
        const res = await fetch(target, {
          method, headers, body: payload as BodyInit | undefined, redirect: "follow",
          signal: AbortSignal.any([signal, timeout]),
        });
        const text = await res.text();
        // Redirects are followed; a 304 only answers a conditional request the code made itself.
        if (res.status < 400) return response(res, text, target, { method, shown, attempts: attempt, requestIndex, redact });
        failure = {
          reason: "status", status: res.status, statusText: res.statusText, body: text,
          retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
        };
      } catch (e) {
        if (signal.aborted) throw abortReason(signal);
        failure = timeout.aborted ? { reason: "timeout", timeoutMs } : { reason: "network", message: errorMessage(e) };
      }

      const retryable = failure.reason !== "status" || failure.status === 429 || failure.status >= 500;
      const retryAfterMs = failure.reason === "status" ? failure.retryAfterMs : null;
      const tooLong = retryAfterMs !== null && retryAfterMs > maxRetryAfterMs;
      if (retryable && attempt <= retries && !tooLong) {
        const waitMs = retryAfterMs ?? backoffMs(retryBaseMs, attempt);
        // The whole line is redacted: a network error's own message can quote the request.
        log(redact(`${method} ${shown}: ${describe(failure)}; retrying in ${seconds(waitMs)} (attempt ${attempt + 1} of ${retries + 1})`));
        await sleep(waitMs, signal);
        continue;
      }
      throw failureError(failure, { method, shown, attempts: attempt, requestIndex, retryable, tooLong, maxRetryAfterMs, redact });
    }
  }

  return {
    get: (url, init) => request("GET", url, undefined, init),
    post: (url, body, init) => request("POST", url, body, init),
    get requests() { return requests; },
    get attempts() { return attempts; },
  };
}

interface Attempted {
  method: string;
  shown: string;           // the redacted request URL
  attempts: number;
  requestIndex: number;
  redact: (text: string) => string;
}

function response(res: Response, text: string, target: string, a: Attempted): HttpResponse {
  const url = res.url || target;
  const next = nextLink(res.headers.get("link"), url);
  const out: HttpResponse = {
    status: res.status,
    url,
    headers: res.headers,
    text,
    json<T = unknown>(): T {
      try {
        return parseJsonLossless(text) as T;
      } catch (e) {
        throw httpError({
          message: `${a.method} ${a.shown} answered ${res.status} but the body is not JSON (${errorMessage(e)}): ${excerpt(a.redact(text))}`,
          hint: "check the URL and the Accept header; use res.text for non-JSON bodies",
          details: { method: a.method, url: a.shown, status: res.status, attempts: a.attempts, retryAfterMs: null,
            requestIndex: a.requestIndex, reason: "invalid_json", body: excerpt(a.redact(text)) },
          retryable: false,
        });
      }
    },
  };
  if (next !== undefined) out.next = next;
  return out;
}

function failureError(f: Failure, a: Attempted & { retryable: boolean; tooLong: boolean; maxRetryAfterMs: number }): CroftError {
  const tries = `after ${a.attempts} attempt${a.attempts === 1 ? "" : "s"}`;
  const base = { method: a.method, url: a.shown, attempts: a.attempts, requestIndex: a.requestIndex };
  if (f.reason === "timeout") {
    return httpError({
      message: `${a.method} ${a.shown} timed out: no answer within ${seconds(f.timeoutMs)} ${tries}`,
      hint: "the server is slow or unreachable; try again later, or raise timeoutMs for this request",
      details: { ...base, status: null, retryAfterMs: null, reason: "timeout" },
      retryable: true,
    });
  }
  if (f.reason === "network") {
    return httpError({
      message: `${a.method} ${a.shown} failed ${tries}: ${a.redact(f.message)}`,
      hint: "check the host name and the network connection, then run again",
      details: { ...base, status: null, retryAfterMs: null, reason: "network" },
      retryable: true,
    });
  }
  const body = excerpt(a.redact(f.body));
  const status = `${f.status}${f.statusText ? ` ${f.statusText}` : ""}`;
  const waited = a.tooLong ? `; the server asks to wait ${seconds(f.retryAfterMs!)}, longer than croft waits inside a run (${seconds(a.maxRetryAfterMs)})` : "";
  return httpError({
    message: `${a.method} ${a.shown} failed with ${status} ${tries}${waited}${body ? `: ${body}` : ""}`,
    hint: statusHint(f.status),
    details: { ...base, status: f.status, retryAfterMs: f.retryAfterMs, reason: "status", body },
    retryable: a.retryable,
  });
}

function statusHint(status: number): string {
  if (status === 401) return "the API rejected the credentials: check the secret in .env";
  if (status === 403) return "the API refused access: check the token's permissions, or a rate limit named in the body";
  if (status === 404) return "check the URL and its path parameters";
  if (status === 429) return "the API is rate limiting; run again later or fetch fewer pages per run";
  if (status >= 500) return "the API is failing on its side; run again later";
  return "read the response body above for the API's reason";
}

function httpError(init: { message: string; hint: string; details: Record<string, unknown>; retryable: boolean }): CroftError {
  return new CroftError("HTTP_ERROR", init);
}

function describe(f: Failure): string {
  if (f.reason === "timeout") return `no answer within ${seconds(f.timeoutMs)}`;
  if (f.reason === "network") return f.message;
  return `${f.status}${f.statusText ? ` ${f.statusText}` : ""}`;
}

// ---------------------------------------------------------------------------------------------------
// Request building

/** The URL with `query` appended; null and undefined values are dropped so `since` can always be passed. */
export function buildUrl(url: string, query: HttpInit["query"], invalid: (message: string) => Error = (m) => new Error(m)): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw invalid("not a valid absolute URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw invalid(`only http and https URLs are supported, not ${u.protocol}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === null || v === undefined) continue;
    u.searchParams.append(k, String(v));
  }
  return u.href;
}

/** A URL for logs and errors, with the query and credentials decoded. Redaction matches a secret's raw
 *  text (and its encodeURIComponent form), but URLSearchParams encodes differently ("!" becomes %21,
 *  " " becomes +), so redacting the encoded href alone could miss a secret passed in `query`. */
export function displayUrl(href: string): string {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return href;
  }
  const auth = u.username ? `${decode(u.username)}${u.password ? `:${decode(u.password)}` : ""}@` : "";
  const query = [...u.searchParams].map(([k, v]) => `${k}=${v}`).join("&");
  return `${u.protocol}//${auth}${u.host}${decode(u.pathname)}${query ? `?${query}` : ""}`;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** A POST body: strings and binary/form bodies pass through; anything else is sent as JSON, with
 *  bigint written as exact digits so ids beyond 2^53 survive the round trip. */
export function encodeBody(body: unknown, headers: Headers): BodyInit | undefined {
  if (body === undefined) return undefined;
  if (typeof body === "string" || body instanceof URLSearchParams || body instanceof FormData || body instanceof Blob
    || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof ReadableStream) {
    return body as BodyInit;
  }
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? rawJson(v.toString()) : v));
}

// JSON.rawJSON is not in TypeScript's lib yet; Bun has it (verified on 1.3.14).
const rawJson = (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON;

// ---------------------------------------------------------------------------------------------------
// Response helpers

type Reviver = (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown;

const losslessReviver: Reviver = (_key, value, context) => {
  // context.source is the literal text of a primitive. Only integer literals become bigint: 1e20 and
  // 1.5 are floats by the source's own choice and stay numbers.
  if (typeof value === "number" && !Number.isSafeInteger(value) && context?.source !== undefined && /^-?\d+$/.test(context.source)) {
    return BigInt(context.source);
  }
  return value;
};

/** JSON.parse that keeps integers outside ±(2^53 − 1) exact, as bigint. Plain JSON.parse would turn
 *  12345678901234567890 into 12345678901234567000 [verified]. */
export function parseJsonLossless(text: string): unknown {
  return JSON.parse(text, losslessReviver as (key: string, value: unknown) => unknown);
}

export interface LinkEntry { url: string; rel: string[]; params: Record<string, string> }

/** Parse an RFC 8288 Link header. Relative URLs are resolved against `base`. Commas and semicolons
 *  inside <...> and inside quoted parameter values do not split entries. */
export function parseLinkHeader(header: string | null | undefined, base?: string): LinkEntry[] {
  if (!header) return [];
  const out: LinkEntry[] = [];
  let i = 0;
  const n = header.length;
  while (i < n) {
    const open = header.indexOf("<", i);
    if (open < 0) break;
    const close = header.indexOf(">", open + 1);
    if (close < 0) break;
    const raw = header.slice(open + 1, close).trim();
    i = close + 1;
    const params: Record<string, string> = {};
    // Parameters run until a comma outside quotes.
    while (i < n) {
      while (i < n && /\s/.test(header[i]!)) i++;
      if (header[i] === ",") { i++; break; }
      if (header[i] !== ";") { i++; continue; }
      i++;
      while (i < n && /\s/.test(header[i]!)) i++;
      let name = "";
      while (i < n && !/[=;,\s]/.test(header[i]!)) name += header[i++];
      while (i < n && /\s/.test(header[i]!)) i++;
      let value = "";
      if (header[i] === "=") {
        i++;
        while (i < n && /\s/.test(header[i]!)) i++;
        if (header[i] === '"') {
          i++;
          while (i < n && header[i] !== '"') {
            if (header[i] === "\\" && i + 1 < n) i++;
            value += header[i++];
          }
          i++;
        } else {
          while (i < n && !/[;,]/.test(header[i]!)) value += header[i++];
          value = value.trim();
        }
      }
      if (name) {
        const key = name.toLowerCase();
        if (!(key in params)) params[key] = value;
      }
    }
    let url = raw;
    try {
      url = base ? new URL(raw, base).href : raw;
    } catch { /* keep the raw text; the caller sees what the server sent */ }
    const rel = (params.rel ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    out.push({ url, rel, params });
  }
  return out;
}

/** The rel="next" target of a Link header, resolved against the response URL. */
export function nextLink(header: string | null | undefined, base?: string): string | undefined {
  return parseLinkHeader(header, base).find((l) => l.rel.includes("next"))?.url;
}

/** Retry-After as milliseconds from now: delta-seconds ("120", "1.5") or an HTTP date. Null when absent
 *  or unreadable. Seconds are checked first: Date.parse("120") is a valid date in the year 120. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  if (value === null || value === undefined) return null;
  const v = value.trim();
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.ceil(Number(v) * 1000);
  // An HTTP date always names its month; this keeps "-5" and "2" from parsing as ancient years.
  if (!/[a-z]/i.test(v)) return null;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/** The first `bytes` bytes of a body as text. A multi-byte character cut at the edge is dropped. */
export function excerpt(text: string, bytes: number = HTTP_DEFAULTS.bodyExcerptBytes): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= bytes) return text;
  return new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, bytes)).replace(/\uFFFD+$/, "") + "…";
}

// ---------------------------------------------------------------------------------------------------
// Small helpers

function backoffMs(baseMs: number, attempt: number): number {
  const exp = baseMs * 2 ** (attempt - 1);
  return Math.round(exp * (0.75 + Math.random() * 0.5));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The run was aborted", "AbortError");
}

function clampRetries(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(10, Math.floor(n))) : HTTP_DEFAULTS.retries;
}

function positive(n: number | undefined, fallback: number): number {
  return n !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;
}

function seconds(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${Number((ms / 1000).toFixed(1))} s`;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return typeof code === "string" && !e.message.includes(code) ? `${e.message} (${code})` : e.message;
  }
  return String(e);
}
