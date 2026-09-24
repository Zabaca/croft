// Who may talk to croft serve (DESIGN.md §5 "Server mode", "Security").
//
// - A token is always required: CROFT_SERVE_TOKEN (the shell, then the project's .env) or 32 random bytes
//   generated at start. Tokens are compared in constant time: both sides are hashed to equal-length digests,
//   then compared with crypto.timingSafeEqual, so neither the content nor the length of the token leaks.
// - Host must name this server: the bound address, or localhost/127.0.0.1/[::1] when it listens on loopback
//   (every interface includes loopback). A browser page on a rebound name (DNS rebinding) sends its own name.
// - A request that carries an Origin comes from a browser page; it is refused unless serve.allowOrigins
//   (croft.json) lists that origin.
// - POST bodies must be application/json, which a plain HTML form cannot send without a CORS preflight.
// Each check returns null or a Refusal (the HTTP status and the problem); server.ts answers with it.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { CroftError, problem } from "../core/errors.ts";
import type { Problem } from "../core/types.ts";

export const TOKEN_ENV = "CROFT_SERVE_TOKEN";

export interface ServeToken {
  token: string;
  source: "CROFT_SERVE_TOKEN" | "generated";
  /** Where CROFT_SERVE_TOKEN came from: the shell ("env") or the project's .env. */
  from?: ".env" | "env";
}

/** A refused request: the status to answer with, the problem for the envelope, and extra headers. */
export interface Refusal {
  status: number;
  problem: Problem;
  headers?: Record<string, string>;
}

/** 32 random bytes, base64url (43 characters, no padding). */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The token croft serve requires: CROFT_SERVE_TOKEN (`lookup` is ProjectEnv.lookup: a non-empty shell value,
 * then .env), else a fresh one. A value that cannot travel in an Authorization header (whitespace, control or
 * non-ASCII characters) is USAGE_ERROR; the message never repeats it.
 */
export function resolveToken(lookup: (name: string) => { value: string; source: ".env" | "env" } | null): ServeToken {
  const found = lookup(TOKEN_ENV);
  if (!found) return { token: generateToken(), source: "generated" };
  const token = found.value.trim();
  if (!/^[\x21-\x7e]+$/.test(token)) {
    const where = found.source === ".env" ? "the project's .env" : "the environment";
    throw new CroftError("USAGE_ERROR", {
      message: `${TOKEN_ENV} in ${where} contains spaces, control characters or non-ASCII characters, so it cannot be sent as a bearer token`,
      hint: `set ${TOKEN_ENV} to printable ASCII without spaces, e.g. the output of: openssl rand -base64 32`,
      fix: { kind: "manual", description: `replace ${TOKEN_ENV} in ${where} with a token of printable ASCII characters`, requiresHuman: true },
      details: { name: TOKEN_ENV, source: found.source },
    });
  }
  return { token, source: "CROFT_SERVE_TOKEN", from: found.source };
}

/** The token of an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(header: string | null): string | null {
  const m = /^\s*bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return m ? m[1]! : null;
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Whether `given` is the expected token, in constant time whatever the lengths. An empty token never matches. */
export function tokenMatches(expected: string, given: string | null): boolean {
  if (!expected || given === null) return false;
  // Equal-length buffers for timingSafeEqual: SHA-256 digests of both sides.
  return timingSafeEqual(digest(expected), digest(given));
}

/** The 401 for a request without the right bearer token. */
export function checkToken(expected: string, authorization: string | null): Refusal | null {
  const given = bearerToken(authorization);
  if (tokenMatches(expected, given)) return null;
  return {
    status: 401,
    headers: { "WWW-Authenticate": 'Bearer realm="croft"' },
    problem: problem("SERVE_UNAUTHORIZED", {
      message: given === null
        ? "croft serve requires a bearer token (Authorization: Bearer <token>), and this request has none"
        : "croft serve rejected the bearer token of this request",
      hint: "send Authorization: Bearer <token>, with the token in the project's .croft/serve.json or the server's CROFT_SERVE_TOKEN",
      fix: { kind: "manual", description: "give the client the server's token (query() reads it from { token } or CROFT_SERVE_TOKEN)" },
      retryable: false,
      details: { status: 401, reason: given === null ? "missing_token" : "wrong_token" },
    }),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Addresses

const bare = (host: string) => (host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host);

/** localhost, 127.0.0.0/8 and ::1 (brackets allowed). */
export function isLoopbackHost(host: string): boolean {
  const h = bare(host).toLowerCase();
  if (h === "localhost") return true;
  if (isIP(h) === 4) return h.startsWith("127.");
  return h === "::1";
}

/** 0.0.0.0 and ::: every interface, loopback included. */
export function isUnspecifiedHost(host: string): boolean {
  const h = bare(host);
  return h === "0.0.0.0" || h === "::";
}

/** A host as it appears in a URL or a Host header: IPv6 in brackets. */
export function urlHost(host: string): string {
  const h = bare(host);
  return isIP(h) === 6 ? `[${h}]` : h;
}

/** Canonical form of a host for comparison: lower case, IPv6 in brackets as WHATWG URL writes it. */
function canonicalHost(host: string): string | null {
  try {
    return new URL(`http://${urlHost(host)}`).hostname;
  } catch {
    return null;
  }
}

export interface Binding {
  /** The address the server listens on, as bound ("127.0.0.1", "0.0.0.0", "::", "192.168.1.5", "localhost"). */
  host: string;
  port: number;
}

/** The host names a request may use for this server. */
function allowedHostnames(b: Binding): Set<string> {
  const out = new Set<string>();
  const bound = canonicalHost(b.host);
  if (bound) out.add(bound);
  if (isLoopbackHost(b.host) || isUnspecifiedHost(b.host)) for (const h of ["localhost", "127.0.0.1", "[::1]"]) out.add(h);
  return out;
}

/** What a client (or a reverse proxy) should send as Host. */
function suggestedHost(b: Binding): string {
  const host = isUnspecifiedHost(b.host) || isLoopbackHost(b.host) ? "127.0.0.1" : urlHost(b.host);
  return `${host}:${b.port}`;
}

/**
 * The Host header must name this server: DNS rebinding makes a browser page's own name resolve to this machine,
 * and the page's requests then carry that name. The port, when given, must be the bound port. 403 otherwise.
 */
export function checkHost(header: string | null, b: Binding): Refusal | null {
  const value = (header ?? "").trim();
  const m = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(value);
  const name = m ? canonicalHost(m[1]!) : null;
  const port = m?.[2] !== undefined ? Number(m[2]) : null;
  if (name !== null && allowedHostnames(b).has(name) && !name.endsWith(".") && (port === null || port === b.port)) return null;
  const want = suggestedHost(b);
  return {
    status: 403,
    problem: problem("SERVE_UNAUTHORIZED", {
      message: value
        ? `croft serve refused a request for Host ${JSON.stringify(value.slice(0, 200))}: it answers only to ${want}${isLoopbackHost(b.host) || isUnspecifiedHost(b.host) ? ` (or localhost:${b.port})` : ""}`
        : "croft serve refused a request without a Host header",
      hint: `connect to http://${want} directly; a reverse proxy or tunnel in front must send Host: ${want} (nginx: proxy_set_header Host ${want}; Caddy: header_up Host ${want})`,
      fix: { kind: "manual", description: `send requests with Host: ${want}` },
      retryable: false,
      details: { status: 403, reason: "host", host: value.slice(0, 200) || null, expected: want },
    }),
  };
}

/** An origin in canonical form (scheme://host[:port], lower case, default port dropped), or null. */
export function canonicalOrigin(text: string): string | null {
  try {
    const u = new URL(text);
    return u.origin === "null" ? null : u.origin;
  } catch {
    return null;
  }
}

/**
 * A request with an Origin header comes from a browser page. It passes only when serve.allowOrigins lists the
 * origin; apps on a server, curl and the read client send none. 403 otherwise.
 */
export function checkOrigin(origin: string | null, allowOrigins: readonly string[]): Refusal | null {
  if (origin === null) return null;
  const canonical = canonicalOrigin(origin);
  if (canonical !== null && allowOrigins.some((o) => canonicalOrigin(o) === canonical)) return null;
  const shown = origin.slice(0, 200);
  return {
    status: 403,
    problem: problem("SERVE_UNAUTHORIZED", {
      message: `croft serve refused a request from the browser page at ${shown}: serve.allowOrigins in croft.json does not list it`,
      hint: canonical
        ? `if that page is yours, add "${canonical}" to serve.allowOrigins in croft.json and restart croft serve; better, query from the app's server side`
        : "browser pages must be listed in serve.allowOrigins in croft.json; query from the app's server side instead",
      fix: canonical
        ? { kind: "manual", description: `add "${canonical}" to "serve": {"allowOrigins": [...]} in croft.json, then restart croft serve`, requiresHuman: true }
        : { kind: "manual", description: "query from the app's server side, not from a browser page" },
      retryable: false,
      details: { status: 403, reason: "origin", origin: shown, allowOrigins: [...allowOrigins] },
    }),
  };
}

/** POST bodies must be JSON: `Content-Type: application/json` (parameters allowed). 415 otherwise. */
export function checkContentType(header: string | null): Refusal | null {
  const type = (header ?? "").split(";")[0]!.trim().toLowerCase();
  if (type === "application/json") return null;
  return {
    status: 415,
    problem: problem("USAGE_ERROR", {
      message: header ? `croft serve takes JSON bodies; this request is ${JSON.stringify(header.slice(0, 100))}` : "croft serve takes JSON bodies; this request has no Content-Type",
      hint: 'send the body as JSON with Content-Type: application/json, like {"sql": "SELECT 1"}',
      fix: { kind: "manual", description: "send the request with Content-Type: application/json" },
      retryable: false,
      details: { status: 415, contentType: header?.slice(0, 100) ?? null },
    }),
  };
}
