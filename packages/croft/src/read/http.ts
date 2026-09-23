// HTTP transport for @zabaca/croft/read (DESIGN.md §5 "Server mode, apps and GUIs").
//
// Loopback URLs must never go through an environment proxy, so HTTP_PROXY never sees the serve token.
// node:http is not enough for that: under Bun 1.3.14, http.request (default agent, `agent: false`, a fresh
// Agent and `createConnection` alike) and fetch all went through HTTP_PROXY/http_proxy for a 127.0.0.1
// target, and under Node 24 with NODE_USE_ENV_PROXY=1 so did the default agent and fetch. A plain TCP
// socket cannot be proxied, so loopback requests speak a minimal HTTP/1.1 over node:net (node:tls for
// https). Everything else uses fetch, so a hosted app keeps whatever egress proxy its platform configures.
// It uses no Bun-only APIs: this file ships in the Node build.
import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

export interface HttpReply {
  status: number;
  headers: Record<string, string>; // lower-case names; repeated headers joined with ", "
  body: string;
}

export interface HttpTimeouts {
  connectMs: number;   // until the TCP (and TLS) connection is up
  responseMs: number;  // until the whole response has arrived, counted from the start
}

/**
 * A request that never got an answer. `phase: "connect"` means the server was not reachable at all
 * (refused, unresolvable, connect timeout); "response" means it was reached but no complete reply arrived.
 */
export class TransportError extends Error {
  constructor(readonly phase: "connect" | "response", message: string, readonly cause?: unknown) {
    super(message);
    this.name = "TransportError";
  }
}

/** The host without IPv6 brackets: WHATWG URL keeps them in `hostname` ("[::1]"). */
export function bareHost(url: URL): string {
  return url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
}

/** localhost (and *.localhost, RFC 6761), 127.0.0.0/8, ::1 and IPv4-mapped 127/8, plus the unspecified
 *  addresses 0.0.0.0 and ::, which a serve.json records when croft serve binds every interface and which
 *  connect to this host. WHATWG URL already canonicalizes IP spellings in Bun and Node
 *  ("[0:0:0:0:0:0:0:1]" → "[::1]", "127.1" and "2130706433" → "127.0.0.1", "[::ffff:127.0.0.1]" →
 *  "[::ffff:7f00:1]"), so plain comparisons suffice. */
export function isLoopback(url: URL): boolean {
  const host = bareHost(url).toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host) === 4) return host.startsWith("127.") || host === "0.0.0.0";
  return host === "::1" || host === "::" || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host);
}

/** POST a body and read the whole reply. Loopback bypasses every proxy; other hosts use fetch. */
export function post(url: URL, body: string, headers: Record<string, string>, t: HttpTimeouts): Promise<HttpReply> {
  return isLoopback(url) ? postDirect(url, body, headers, t) : postFetch(url, body, headers, t);
}

export async function postFetch(url: URL, body: string, headers: Record<string, string>, t: HttpTimeouts): Promise<HttpReply> {
  let res: Response;
  const signal = AbortSignal.timeout(Math.max(1, t.responseMs));
  try {
    res = await fetch(url, { method: "POST", headers, body, signal, redirect: "error" });
  } catch (e) {
    // fetch does not tell a refused connection from a slow one; an aborted request is a timeout.
    const timedOut = signal.aborted;
    throw new TransportError(timedOut ? "response" : "connect",
      timedOut ? `no reply from ${url.origin} within ${t.responseMs} ms` : `cannot reach ${url.origin}: ${describe(e)}`, e);
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    throw new TransportError("response", `the reply from ${url.origin} broke off: ${describe(e)}`, e);
  }
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => (out[k.toLowerCase()] = v));
  return { status: res.status, headers: out, body: text };
}

function describe(e: unknown): string {
  const err = e as { message?: string; code?: string; cause?: { code?: string; message?: string } };
  return err?.cause?.code ?? err?.code ?? err?.cause?.message ?? err?.message ?? String(e);
}

/** HTTP/1.1 over a plain socket: one request per connection (`Connection: close`). */
export function postDirect(url: URL, body: string, headers: Record<string, string>, t: HttpTimeouts): Promise<HttpReply> {
  const host = bareHost(url);
  const tls = url.protocol === "https:";
  const port = Number(url.port) || (tls ? 443 : 80);
  const payload = Buffer.from(body, "utf8");
  const lines = [`POST ${url.pathname}${url.search} HTTP/1.1`, `Host: ${url.host}`];
  for (const [k, v] of Object.entries(headers)) {
    // Never let a value inject headers; callers validate first, this is the last line of defense.
    if (/[\r\n]/.test(k) || /[\r\n]/.test(v)) throw new Error(`header ${k} contains a line break`);
    lines.push(`${k}: ${v}`);
  }
  lines.push(`Content-Length: ${payload.length}`, "Connection: close", "", "");
  const head = Buffer.from(lines.join("\r\n"), "utf8");

  return new Promise<HttpReply>((resolve, reject) => {
    const started = Date.now();
    let connected = false;
    let settled = false;
    const parser = new ResponseParser();
    const socket: Socket = tls
      ? tlsConnect({ host, port, ...(isIP(host) ? {} : { servername: host }) })
      : netConnect({ host, port });
    const finish = (err: TransportError | null, reply?: HttpReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);
      socket.destroy();
      if (err) reject(err);
      else resolve(reply!);
    };
    const connectTimer = setTimeout(() => {
      if (!connected) finish(new TransportError("connect", `cannot reach ${url.origin}: no connection within ${t.connectMs} ms`));
    }, Math.max(1, t.connectMs));
    const responseTimer = setTimeout(() => {
      finish(new TransportError("response", `no reply from ${url.origin} within ${Date.now() - started} ms`));
    }, Math.max(1, t.responseMs));
    socket.once(tls ? "secureConnect" : "connect", () => {
      connected = true;
      clearTimeout(connectTimer);
      // Write, never end(): a half-closed socket made Bun's HTTP server drop the reply (verified).
      socket.write(Buffer.concat([head, payload]));
    });
    socket.on("data", (chunk: Buffer) => {
      try {
        const reply = parser.push(chunk);
        if (reply) finish(null, reply);
      } catch (e) {
        finish(new TransportError("response", `malformed reply from ${url.origin}: ${(e as Error).message}`, e));
      }
    });
    socket.on("end", () => {
      try {
        const reply = parser.end();
        if (reply) finish(null, reply);
        else finish(new TransportError("response", `${url.origin} closed the connection before replying`));
      } catch (e) {
        finish(new TransportError("response", `the reply from ${url.origin} broke off: ${(e as Error).message}`, e));
      }
    });
    socket.on("close", () => finish(new TransportError(connected ? "response" : "connect", `${url.origin} closed the connection`)));
    socket.on("error", (e: NodeJS.ErrnoException) => {
      finish(new TransportError(connected ? "response" : "connect", `${connected ? "lost" : "cannot reach"} ${url.origin}: ${e.code ?? e.message}`, e));
    });
  });
}

/**
 * Incremental HTTP/1.1 response parser for one response per connection. Handles Content-Length,
 * chunked transfer encoding and close-delimited bodies. `push` returns the reply once complete.
 */
export class ResponseParser {
  private buf: Buffer = Buffer.alloc(0);
  private status = 0;
  private headers: Record<string, string> | null = null;

  push(chunk: Buffer): HttpReply | null {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (!this.headers && !this.parseHead()) return null;
    return this.complete(false);
  }

  /** The connection ended: a close-delimited body is complete now; anything else is truncated. */
  end(): HttpReply | null {
    if (!this.headers) return null;
    return this.complete(true);
  }

  private parseHead(): boolean {
    for (;;) {
      const at = this.buf.indexOf("\r\n\r\n");
      if (at < 0) {
        if (this.buf.length > 64 * 1024) throw new Error("response headers exceed 64 KB");
        return false;
      }
      const lines = this.buf.subarray(0, at).toString("latin1").split("\r\n");
      const m = lines[0]!.match(/^HTTP\/1\.[01] (\d{3})/);
      if (!m) throw new Error(`not an HTTP/1.x status line: ${JSON.stringify(lines[0]!.slice(0, 40))}`);
      const status = Number(m[1]);
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(":");
        if (colon <= 0) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
      }
      this.buf = this.buf.subarray(at + 4);
      if (status >= 100 && status < 200) continue; // interim (100 Continue): the real status follows
      this.status = status;
      this.headers = headers;
      return true;
    }
  }

  private complete(ended: boolean): HttpReply | null {
    const headers = this.headers!;
    const done = (body: Buffer): HttpReply => ({ status: this.status, headers, body: body.toString("utf8") });
    if (this.status === 204 || this.status === 304) return done(Buffer.alloc(0));
    if (/\bchunked\b/i.test(headers["transfer-encoding"] ?? "")) {
      const body = decodeChunked(this.buf);
      if (body) return done(body);
      if (ended) throw new Error("connection closed inside a chunked body");
      return null;
    }
    const lengthHeader = headers["content-length"];
    if (lengthHeader !== undefined) {
      const length = Number(lengthHeader.split(",")[0]);
      if (!Number.isInteger(length) || length < 0) throw new Error(`bad Content-Length ${lengthHeader}`);
      if (this.buf.length >= length) return done(this.buf.subarray(0, length));
      if (ended) throw new Error(`connection closed after ${this.buf.length} of ${length} body bytes`);
      return null;
    }
    return ended ? done(this.buf) : null;
  }
}

/** The decoded body once the terminating zero-size chunk has arrived, else null. */
export function decodeChunked(data: Buffer): Buffer | null {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const eol = data.indexOf("\r\n", at);
    if (eol < 0) return null;
    const sizeText = data.subarray(at, eol).toString("latin1").split(";")[0]!.trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeText)) throw new Error(`bad chunk size ${JSON.stringify(sizeText.slice(0, 20))}`);
    const size = parseInt(sizeText, 16);
    at = eol + 2;
    if (size === 0) {
      // Trailers (rare) end with an empty line; the body is complete either way once it is there.
      return data.indexOf("\r\n", at) >= 0 ? Buffer.concat(parts) : null;
    }
    if (data.length < at + size + 2) return null;
    parts.push(data.subarray(at, at + size));
    at += size + 2;
  }
}
