// croft serve's HTTP layer against the REAL read client (read/server.ts, and the public query() of read.ts),
// with a fake engine behind it: tokens, 503 + Retry-After, HTTP_PROXY, Host/Origin/Content-Type refusals,
// the envelopes, and serve.json.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CroftError } from "../core/errors.ts";
import { bootId, currentIdentity } from "../core/proc.ts";
import { query } from "../read.ts";
import { directQuery } from "../read/direct.ts";
import { type HttpReply, ResponseParser } from "../read/http.ts";
import { readServeRecord } from "../read/locate.ts";
import { DEFAULT_SERVER_TIMINGS, serverQuery, type ServerTarget } from "../read/server.ts";
import { cleanup, makeProject, spawnIdle, type TempProject } from "../read/testkit.ts";
import {
  httpStatus, listenUrl, removeServeJson, type RunningServer, SERVE_FILE, type ServerOptions, startServer, writeServeJson,
} from "./server.ts";
import type { ServeEngine, ServeEngineStatus, ServeJson, ServeQuery, ServeQueryData } from "./types.ts";

const servers: RunningServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop(true);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  cleanup();
});

const TOKEN = "s3cret-token-value";
/** Extra time CPU-starved CI runners get on timing budgets. */
const SLACK_MS = process.env.CROFT_CI === "1" ? 600 : 0;

interface FakeEngine extends ServeEngine {
  calls: ServeQuery[];
  closed: boolean;
}

const data = (rows: Record<string, unknown>[]): ServeQueryData =>
  ({ columns: [{ name: "a", type: "INTEGER" }], rows, rowCount: rows.length, tookMs: 1 });

function fakeEngine(answer: (q: ServeQuery, n: number) => Promise<ServeQueryData> = async () => data([{ a: 1 }])): FakeEngine {
  const e: FakeEngine = {
    calls: [],
    closed: false,
    async query(q) {
      e.calls.push(q);
      return answer(q, e.calls.length);
    },
    status(): ServeEngineStatus {
      return { state: "open", writeIntent: null, inFlight: 0, queued: 0, openConnections: 1, queriesToday: e.calls.length };
    },
    async close() {
      e.closed = true;
    },
  };
  return e;
}

function tempRoot(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "croft-serve-")));
  dirs.push(d);
  return d;
}

function serve(engine: ServeEngine, o: Partial<ServerOptions> = {}): RunningServer {
  const s = startServer({
    engine, host: "127.0.0.1", port: 0, token: TOKEN, allowOrigins: [], root: tempRoot(),
    database: "warehouse.duckdb", timezone: "America/Los_Angeles", ...o,
  });
  servers.push(s);
  return s;
}

const T = (timeoutMs = 3000) => ({ timeoutMs, ...DEFAULT_SERVER_TIMINGS });
const target = (url: string, token: string | null = TOKEN): ServerTarget =>
  ({ url: new URL(url), token, tokenSource: token ? "option" : null, local: false });

async function rejection(p: Promise<unknown>): Promise<CroftError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
  throw new Error("expected a CroftError");
}

/** One raw HTTP/1.1 request over a plain socket, with exactly the headers given (no Host unless listed). */
function raw(port: number, method: string, path: string, headers: Record<string, string>, body = ""): Promise<HttpReply & { json: any }> {
  const payload = Buffer.from(body, "utf8");
  const lines = [`${method} ${path} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
  if (body || method === "POST") lines.push(`Content-Length: ${payload.length}`);
  lines.push("Connection: close", "", "");
  return rawLines(port, Buffer.concat([Buffer.from(lines.join("\r\n")), payload]));
}

/** Send bytes as they are and read one reply. */
function rawLines(port: number, request: string | Buffer): Promise<HttpReply & { json: any }> {
  return new Promise((resolve, reject) => {
    const parser = new ResponseParser();
    const socket = connect({ host: "127.0.0.1", port }, () => socket.write(request));
    const done = (r: HttpReply | null) => {
      if (!r) return;
      socket.destroy();
      let json: unknown = null;
      try {
        json = JSON.parse(r.body);
      } catch {}
      resolve({ ...r, json });
    };
    socket.on("data", (c: Buffer) => done(parser.push(c)));
    socket.on("end", () => done(parser.end()));
    socket.on("error", reject);
  });
}

const authed = (port: number, extra: Record<string, string> = {}) =>
  ({ Host: `127.0.0.1:${port}`, Authorization: `Bearer ${TOKEN}`, ...extra });
const postQuery = (s: RunningServer, body: unknown, extra: Record<string, string> = {}) =>
  raw(s.port, "POST", "/query", authed(s.port, { "Content-Type": "application/json", ...extra }), typeof body === "string" ? body : JSON.stringify(body));

describe("the read client against the real server", () => {
  test("the right token: rows, and the engine gets {sql, params, limit}", async () => {
    const engine = fakeEngine(async () => data([{ a: 1 }, { a: 2 }]));
    const s = serve(engine);
    expect(s.url).toBe(`http://127.0.0.1:${s.port}`);
    const rows = await serverQuery(target(s.url), { sql: "SELECT a FROM t WHERE a > $1", params: [0], limit: 50 }, T());
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]).toMatchObject({ sql: "SELECT a FROM t WHERE a > $1", params: [0], limit: 50 });
    expect(engine.calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  test("the public query() with { url, token }", async () => {
    const s = serve(fakeEngine(async (q) => data([{ a: Number(q.params[0]) }])));
    expect(await query("SELECT $1 AS a", [7], { url: s.url, token: TOKEN })).toEqual([{ a: 7 }]);
  });

  test("a wrong or missing token is SERVE_UNAUTHORIZED (401), not retried, and the engine never runs", async () => {
    const engine = fakeEngine();
    const s = serve(engine);
    const wrong = await rejection(serverQuery(target(s.url, "wrong-token"), { sql: "SELECT 1", params: [], limit: 10 }, T()));
    expect(wrong.code).toBe("SERVE_UNAUTHORIZED");
    expect(wrong.problem.retryable).toBe(false);
    expect(JSON.stringify(wrong.problem)).not.toContain("wrong-token");
    const none = await rejection(serverQuery(target(s.url, null), { sql: "SELECT 1", params: [], limit: 10 }, T()));
    expect(none.code).toBe("SERVE_UNAUTHORIZED");
    const e = await rejection(query("SELECT 1", [], { url: s.url, token: "also-wrong" }));
    expect(e.code).toBe("SERVE_UNAUTHORIZED");
    expect(engine.calls).toHaveLength(0);
    const r = await postQuery(s, { sql: "SELECT 1" }, { Authorization: "Bearer nope" });
    expect(r.status).toBe(401);
    expect(r.headers["www-authenticate"]).toContain("Bearer");
    expect(r.json.problems[0].code).toBe("SERVE_UNAUTHORIZED");
  });

  test("503 with Retry-After is honored, then the query succeeds", async () => {
    const engine = fakeEngine(async (_q, n) => {
      if (n === 1) {
        throw new CroftError("SERVE_UNAVAILABLE", {
          message: "a run is writing", hint: "retry shortly", retryable: true, details: { retryAfterMs: 300 },
        });
      }
      return data([{ a: 42 }]);
    });
    const s = serve(engine);
    const r = await postQuery(s, { sql: "SELECT 1" });
    expect(r.status).toBe(503);
    expect(r.headers["retry-after"]).toBe("1");
    expect(r.json.problems[0].code).toBe("SERVE_UNAVAILABLE");
    // The read client, from a fresh first attempt: waits the Retry-After second, then succeeds.
    engine.calls.length = 0;
    const t0 = Date.now();
    const rows = await serverQuery(target(s.url), { sql: "SELECT 1", params: [], limit: 10 }, T(5000));
    expect(rows).toEqual([{ a: 42 }]);
    expect(engine.calls).toHaveLength(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });

  test("a server that stays busy is SERVE_UNAVAILABLE once the client's timeout passes", async () => {
    const s = serve(fakeEngine(async () => {
      throw new CroftError("SERVE_UNAVAILABLE", { message: "a run is writing", hint: "retry", retryable: true, details: { retryAfterMs: 2500 } });
    }));
    const r = await postQuery(s, { sql: "SELECT 1" });
    expect(r.headers["retry-after"]).toBe("3");
    const e = await rejection(serverQuery(target(s.url), { sql: "SELECT 1", params: [], limit: 10 }, T(400)));
    expect(e.code).toBe("SERVE_UNAVAILABLE");
    expect(e.message).toContain("a run is writing");
  });

  test("a live croft serve found through serve.json answers query(), with the serve.json token", async () => {
    const p = await makeProject();
    const engine = fakeEngine(async () => data([{ a: 9 }]));
    const s = serve(engine, { root: p.root });
    const me = currentIdentity();
    writeServeJson(p.stateDir, record(s, me));
    try {
      expect(await query("SELECT 9 AS a", [], { project: p.root })).toEqual([{ a: 9 }]);
      expect(engine.calls).toHaveLength(1);
    } finally {
      removeServeJson(p.stateDir);
    }
  });

  test("gate and usage errors keep their code and message (400); too many rows is 422 QUERY_TOO_MANY_ROWS", async () => {
    const s = serve(fakeEngine(async (q) => {
      if (q.sql.startsWith("DELETE")) throw new CroftError("QUERY_NOT_SELECT", { message: "only one SELECT may run", hint: "use SELECT" });
      if (q.sql.includes("big")) throw new CroftError("QUERY_TOO_MANY_ROWS", { message: "more than 10 rows", hint: "add a LIMIT", details: { limit: 10 } });
      return data([{ a: 1 }]);
    }));
    const notSelect = await rejection(serverQuery(target(s.url), { sql: "DELETE FROM t", params: [], limit: 10 }, T()));
    expect(notSelect.code).toBe("QUERY_NOT_SELECT");
    expect(notSelect.message).toBe("only one SELECT may run");
    expect((await postQuery(s, { sql: "DELETE FROM t" })).status).toBe(400);
    const big = await rejection(serverQuery(target(s.url), { sql: "SELECT * FROM big", params: [], limit: 10 }, T()));
    expect(big.code).toBe("QUERY_TOO_MANY_ROWS");
    const r = await postQuery(s, { sql: "SELECT * FROM big", limit: 10 });
    expect(r.status).toBe(422);
    expect(r.json.ok).toBe(false);
  });

  test("an engine that returns more rows than the limit is refused, never passed on", async () => {
    const s = serve(fakeEngine(async () => data([{ a: 1 }, { a: 2 }, { a: 3 }])));
    const e = await rejection(serverQuery(target(s.url), { sql: "SELECT a FROM t", params: [], limit: 2 }, T()));
    expect(e.code).toBe("QUERY_TOO_MANY_ROWS");
    expect((await postQuery(s, { sql: "SELECT a FROM t", limit: 2 })).status).toBe(422);
  });

  test("HTTP_PROXY set in the app's environment still reaches loopback directly; the proxy sees nothing", async () => {
    const s = serve(fakeEngine(async () => data([{ a: 8 }])));
    const proxied: string[] = [];
    const proxy: Server = createServer((r: IncomingMessage, res) => {
      proxied.push(`${r.method} ${r.url} ${r.headers.authorization ?? ""}`);
      res.writeHead(502).end("proxy");
    });
    proxy.on("connect", (r: IncomingMessage, sock) => {
      proxied.push(`CONNECT ${r.url}`);
      sock.end("HTTP/1.1 502 no\r\n\r\n");
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    try {
      const readTs = fileURLToPath(new URL("../read.ts", import.meta.url));
      const script = `
        const { query } = await import(${JSON.stringify(readTs)});
        const rows = await query("SELECT 8 AS a");
        console.log(JSON.stringify({ rows }));`;
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(no_proxy|http_proxy|https_proxy|all_proxy)$/i.test(k)) env[k] = v;
      Object.assign(env, { HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, CROFT_URL: s.url, CROFT_SERVE_TOKEN: TOKEN });
      const child = spawn(process.execPath, ["-e", script], { env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      const code = await new Promise((r) => child.on("exit", r));
      expect(err).toBe("");
      expect(code).toBe(0);
      expect(JSON.parse(out.trim()).rows).toEqual([{ a: 8 }]);
      expect(proxied).toEqual([]);
    } finally {
      await new Promise((r) => proxy.close(r));
    }
  });

  test("rows through the real server equal direct mode's for every rendered type, bigint params exact", async () => {
    const p: TempProject = await makeProject({ seed: [
      `CREATE TABLE golden AS SELECT 9007199254740993::BIGINT AS unsafe_big, 1234.50::DECIMAL(10,2) AS dec,
         TIMESTAMPTZ '2026-03-08 10:00:00Z' AS after_dst, (-0.0)::DOUBLE AS neg_zero, '{"n": 12345678901234567890}'::JSON AS doc,
         [1, 2, NULL]::INTEGER[] AS ints, 'héllo 🌍' AS txt`,
    ] });
    const fast = { intentWaitMs: 300, lockRetryMs: 500, pollMs: 20 };
    const engine = fakeEngine(async (q) => {
      const rows = await directQuery(p.project, { sql: q.sql, params: q.params, limit: q.limit }, fast);
      return { columns: [], rows, rowCount: rows.length, tookMs: 0 };
    });
    const s = serve(engine, { root: p.root });
    const direct = await directQuery(p.project, { sql: "SELECT * FROM golden", params: [], limit: 10 }, fast);
    const served = await serverQuery(target(s.url), { sql: "SELECT * FROM golden", params: [], limit: 10 }, T());
    expect(served).toStrictEqual(direct);
    // A bigint param beyond 2^53 reaches the engine as a bigint, so DuckDB compares the exact value.
    const hit = await serverQuery(target(s.url), { sql: "SELECT count(*)::INTEGER AS n FROM golden WHERE unsafe_big = $1", params: [9007199254740993n], limit: 10 }, T());
    expect(hit).toEqual([{ n: 1 }]);
    expect(engine.calls.at(-1)!.params).toEqual([9007199254740993n]);
  });
});

describe("request checks", () => {
  test("a Host that is not this server (DNS rebinding) is 403 SERVE_UNAUTHORIZED, before the token is even looked at", async () => {
    const engine = fakeEngine();
    const s = serve(engine);
    const r = await raw(s.port, "POST", "/query", { Host: `evil.example:${s.port}`, Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, '{"sql":"SELECT 1"}');
    expect(r.status).toBe(403);
    expect(r.json.problems[0].code).toBe("SERVE_UNAUTHORIZED");
    expect(r.json.problems[0].message).toContain("evil.example");
    expect((await raw(s.port, "GET", "/health", { Host: "rebind.test", Authorization: `Bearer ${TOKEN}` })).status).toBe(403);
    // No Host at all: Bun itself answers 400 to HTTP/1.1 without one; croft refuses an HTTP/1.0 request without one.
    expect((await raw(s.port, "GET", "/health", { Authorization: `Bearer ${TOKEN}` })).status).toBe(400);
    expect((await rawLines(s.port, `GET /health HTTP/1.0\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`)).status).toBe(403);
    expect((await raw(s.port, "GET", "/health", authed(s.port, { Host: `localhost:${s.port}` }))).status).toBe(200);
    expect(engine.calls).toHaveLength(0);
  });

  test("an Origin outside serve.allowOrigins is 403; a listed one gets CORS headers and a preflight answer", async () => {
    const engine = fakeEngine();
    const s = serve(engine, { allowOrigins: ["http://localhost:3000"] });
    const bad = await postQuery(s, { sql: "SELECT 1" }, { Origin: "https://evil.example" });
    expect(bad.status).toBe(403);
    expect(bad.json.problems[0]).toMatchObject({ code: "SERVE_UNAUTHORIZED" });
    expect(bad.json.problems[0].hint).toContain("serve.allowOrigins");
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
    expect(engine.calls).toHaveLength(0);

    const good = await postQuery(s, { sql: "SELECT 1" }, { Origin: "http://localhost:3000" });
    expect(good.status).toBe(200);
    expect(good.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(good.headers.vary).toContain("Origin");

    const pre = await raw(s.port, "OPTIONS", "/query", {
      Host: `127.0.0.1:${s.port}`, Origin: "http://localhost:3000", "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, content-type",
    });
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(pre.headers["access-control-allow-headers"]).toContain("Authorization");
    expect(pre.headers["access-control-allow-methods"]).toContain("POST");
    const badPre = await raw(s.port, "OPTIONS", "/query", { Host: `127.0.0.1:${s.port}`, Origin: "https://evil.example", "Access-Control-Request-Method": "POST" });
    expect(badPre.status).toBe(403);
  });

  test("POST /query without Content-Type: application/json is 415", async () => {
    const engine = fakeEngine();
    const s = serve(engine);
    for (const type of ["text/plain", "application/x-www-form-urlencoded"]) {
      const r = await postQuery(s, '{"sql":"SELECT 1"}', { "Content-Type": type });
      expect(r.status).toBe(415);
      expect(r.json.problems[0].code).toBe("USAGE_ERROR");
    }
    expect(engine.calls).toHaveLength(0);
  });

  test("malformed bodies are 400 USAGE_ERROR with a hint", async () => {
    const engine = fakeEngine();
    const s = serve(engine);
    for (const body of ["not json", "[]", "{}", '{"sql": 42}', '{"sql": ""}', '{"sql":"SELECT 1","params":"x"}',
      '{"sql":"SELECT 1","limit":0}', '{"sql":"SELECT 1","limit":1.5}', '{"sql":"SELECT 1","param":[1]}']) {
      const r = await postQuery(s, body);
      expect(r.status).toBe(400);
      expect(r.json.problems[0].code).toBe("USAGE_ERROR");
      expect(r.json.problems[0].hint).not.toBe("");
    }
    expect(engine.calls).toHaveLength(0);
    // limit defaults to 10,000 and params to [].
    await postQuery(s, { sql: "SELECT 1" });
    expect(engine.calls[0]).toMatchObject({ sql: "SELECT 1", params: [], limit: 10_000 });
  });

  test("a body over the size cap is 413", async () => {
    const s = serve(fakeEngine(), { maxBodyBytes: 1024 });
    const r = await postQuery(s, { sql: `SELECT '${"x".repeat(2000)}'` });
    expect(r.status).toBe(413);
    expect(r.json.problems[0].code).toBe("USAGE_ERROR");
  });

  test("unknown paths are 404 and wrong methods 405, both after the token check", async () => {
    const s = serve(fakeEngine());
    expect((await raw(s.port, "GET", "/nope", { Host: `127.0.0.1:${s.port}` })).status).toBe(401);
    const r = await raw(s.port, "GET", "/nope", authed(s.port));
    expect(r.status).toBe(404);
    expect(r.json.problems[0].hint).toContain("/query");
    const m = await raw(s.port, "GET", "/query", authed(s.port));
    expect(m.status).toBe(405);
    expect(m.headers.allow).toContain("POST");
  });
});

describe("envelopes", () => {
  test("POST /query returns the query envelope of §4.3", async () => {
    const s = serve(fakeEngine(async () => data([{ a: 1 }])));
    const r = await postQuery(s, { sql: "SELECT 1 AS a" });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("application/json");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.json).toMatchObject({
      schemaVersion: 1, ok: true, command: "query", database: "warehouse.duckdb", timezone: "America/Los_Angeles",
      data: { columns: [{ name: "a", type: "INTEGER" }], rows: [{ a: 1 }], rowCount: 1, truncatedRows: 0, truncatedValues: 0 },
      problems: [], next: [],
    });
    expect(typeof r.json.croftVersion).toBe("string");
    expect(typeof r.json.durationMs).toBe("number");
  });

  test("GET /health: pid, version, database, the write intent and today's queries; it needs the token", async () => {
    const engine = fakeEngine();
    engine.status = () => ({ state: "closed_for_write", writeIntent: { pid: 4121, runId: "r_x", since: "2026-09-24T10:00:00Z" }, inFlight: 0, queued: 2, openConnections: 0, queriesToday: 1204 });
    const s = serve(engine);
    const r = await raw(s.port, "GET", "/health", authed(s.port));
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      ok: true, pid: process.pid, version: expect.any(String), database: "warehouse.duckdb",
      writeIntent: { pid: 4121, runId: "r_x", since: "2026-09-24T10:00:00Z" }, queriesToday: 1204,
    });
    expect((await raw(s.port, "GET", "/health", { Host: `127.0.0.1:${s.port}` })).status).toBe(401);
  });

  test("GET /status: the status envelope of §4.3 (never importing asset code), with the server and engine under data.serve", async () => {
    const p = await makeProject({ seed: ["CREATE TABLE t AS SELECT 1 AS n"] });
    // An asset whose top-level code would announce itself if croft serve ever imported it.
    const marker = join(p.root, "imported.txt");
    mkdirSync(join(p.root, "assets"), { recursive: true });
    writeFileSync(join(p.root, "assets", "orders.ts"), `import { writeFileSync } from "node:fs";\nimport { ingest } from "@zabaca/croft";\n`
      + `writeFileSync(${JSON.stringify(marker)}, "imported");\nexport default ingest({ async *rows() { yield []; } });\n`);
    const s = serve(fakeEngine(), { root: p.root });
    const r = await raw(s.port, "GET", "/status", authed(s.port));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      ok: true, command: "status",
      data: {
        healthy: expect.any(Boolean), running: [], scheduling: { state: "off" },
        serve: { url: s.url, pid: process.pid, engine: { state: "open", inFlight: 0, queued: 0, openConnections: 1 } },
      },
    });
    expect(r.json.data.assets.map((a: { asset: string }) => a.asset)).toEqual(["orders"]);
    expect(r.json.data.assets[0]).toMatchObject({ asset: "orders", status: "never_run", stale: true });
    expect(existsSync(marker)).toBe(false);
    // A folder that is no project: the problem, not a crash.
    const bare = serve(fakeEngine());
    const b = await raw(bare.port, "GET", "/status", authed(bare.port));
    expect(b.json.ok).toBe(false);
    expect(b.json.problems[0].hint).not.toBe("");
  });

  test("a keep-alive connection is closed after the idle timeout once its query is answered; so is one whose body never comes", async () => {
    const errors: unknown[] = [];
    const s = serve(fakeEngine(async () => {
      await Bun.sleep(1200);
      return data([{ a: 1 }]);
    }), { idleTimeoutS: 1, onError: (e) => errors.push(e) });
    const hold = (request: string) => new Promise<{ answeredAt: number; closedAt: number | null }>((resolve) => {
      const t0 = Date.now();
      let answeredAt = -1;
      const socket = connect({ host: "127.0.0.1", port: s.port }, () => socket.write(request));
      socket.on("data", () => {
        if (answeredAt < 0) answeredAt = Date.now() - t0;
      });
      socket.on("error", () => {});
      const timer = setTimeout(() => {
        socket.destroy();
        resolve({ answeredAt, closedAt: null });
      }, 9000 + SLACK_MS);
      socket.on("close", () => {
        clearTimeout(timer);
        resolve({ answeredAt, closedAt: Date.now() - t0 });
      });
    });
    const body = '{"sql":"SELECT 1"}';
    const head = (length: number) => `POST /query HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\n\r\n`;
    const [answered, stalled] = await Promise.all([hold(head(body.length) + body), hold(`${head(1000)}{"sql":`)]);
    // Answered after the idle timeout had passed (the query is exempt), then closed once idle.
    expect(answered.answeredAt).toBeGreaterThanOrEqual(1100);
    expect(answered.closedAt).not.toBeNull();
    expect(answered.closedAt! - answered.answeredAt).toBeLessThan(6000 + SLACK_MS);
    expect(stalled.closedAt).not.toBeNull();
    // A client that went away before its body came is no bug of croft's: nothing for the server's log.
    await Bun.sleep(50);
    expect(errors).toEqual([]);
  }, 30_000);

  test("Connection: close on the request is answered with Connection: close", async () => {
    const s = serve(fakeEngine());
    const r = await postQuery(s, { sql: "SELECT 1" });
    expect(r.status).toBe(200);
    expect(r.headers.connection).toBe("close");
  });

  test("bodies waiting for the engine are bounded: past maxPendingBodyBytes a /query is 503 at once, before its body is read", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const engine = fakeEngine(async () => {
      await gate;
      return data([{ a: 1 }]);
    });
    const s = serve(engine, { maxBodyBytes: 512 * 1024, maxPendingBodyBytes: 1024 * 1024 });
    const big = JSON.stringify({ sql: `SELECT 1 -- ${"x".repeat(400 * 1024)}` });
    const first = [postQuery(s, big), postQuery(s, big)];
    const end = Date.now() + 5000;
    while (engine.calls.length < 2 && Date.now() < end) await Bun.sleep(5);
    expect(engine.calls).toHaveLength(2);
    // The third sends its headers and only part of its body: the answer comes anyway, at once.
    const start = Date.now();
    const third = await rawLines(s.port, `POST /query HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${big.length}\r\n\r\n${big.slice(0, 1000)}`);
    expect(Date.now() - start).toBeLessThan(1000 + SLACK_MS);
    expect(third.status).toBe(503);
    expect(third.headers["retry-after"]).toBe("1");
    expect(third.json.problems[0]).toMatchObject({ code: "SERVE_UNAVAILABLE", retryable: true });
    expect(third.json.problems[0].hint).not.toBe("");
    expect(engine.calls).toHaveLength(2);
    release();
    for (const r of await Promise.all(first)) expect(r.status).toBe(200);
    expect((await postQuery(s, big)).status).toBe(200);
  });

  test("an unexpected engine failure is 500 INTERNAL_ERROR without a stack; problem text is redacted", async () => {
    const s = serve(fakeEngine(async () => {
      throw new Error("kaboom with hunter2-secret inside");
    }), { redact: (t) => t.replaceAll("hunter2-secret", "[redacted:API_KEY]") });
    const r = await postQuery(s, { sql: "SELECT 1" });
    expect(r.status).toBe(500);
    const p = r.json.problems[0];
    expect(p.code).toBe("INTERNAL_ERROR");
    expect(r.body).not.toContain("hunter2-secret");
    expect(r.body).not.toContain("server.ts");
    expect(p.hint).not.toBe("");
  });

  test("a client that goes away aborts the engine's query, quietly", async () => {
    let aborted = false;
    const errors: unknown[] = [];
    const s = serve(fakeEngine(async (q) => {
      await new Promise<void>((resolve) => q.signal!.addEventListener("abort", () => resolve(), { once: true }));
      aborted = true;
      throw new Error("the query was interrupted");
    }), { onError: (e) => errors.push(e) });
    const body = '{"sql":"SELECT 1"}';
    const socket = connect({ host: "127.0.0.1", port: s.port }, () => socket.write(
      `POST /query HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
    ));
    await Bun.sleep(100);
    socket.destroy();
    const end = Date.now() + 3000;
    while (!aborted && Date.now() < end) await Bun.sleep(10);
    expect(aborted).toBe(true);
    await Bun.sleep(50);
    expect(errors).toEqual([]);
  });

  test("a query longer than the idle timeout still gets its answer", async () => {
    const s = serve(fakeEngine(async () => {
      await Bun.sleep(1600);
      return data([{ a: 1 }]);
    }), { idleTimeoutS: 1 });
    expect(await serverQuery(target(s.url), { sql: "SELECT 1", params: [], limit: 10 }, T())).toEqual([{ a: 1 }]);
  });

  test("HTTP status by code", () => {
    const e = (code: ConstructorParameters<typeof CroftError>[0]) => new CroftError(code, { message: "m", hint: "h" });
    expect(httpStatus(e("SERVE_UNAVAILABLE"))).toBe(503);
    expect(httpStatus(e("DB_BUSY"))).toBe(503);
    expect(httpStatus(e("DB_HELD_BY_OTHER_PROGRAM"))).toBe(503);
    expect(httpStatus(e("SERVE_UNAUTHORIZED"))).toBe(401);
    expect(httpStatus(e("QUERY_TOO_MANY_ROWS"))).toBe(422);
    for (const c of ["USAGE_ERROR", "QUERY_NOT_SELECT", "QUERY_PATH_DENIED", "SQL_SYNTAX", "UNKNOWN_TABLE", "QUERY_FAILED"] as const) {
      expect(httpStatus(e(c))).toBe(400);
    }
    expect(httpStatus(e("INTERNAL_ERROR"))).toBe(500);
    expect(httpStatus(e("TIMEOUT"))).toBe(500);
  });
});

function record(s: RunningServer, me = currentIdentity()): ServeJson {
  return {
    url: s.url, host: s.host, port: s.port, token: TOKEN, pid: me.pid, procStart: me.procStart, bootId: me.bootId,
    startedAt: new Date().toISOString(), version: "0.1.0-test",
  };
}

describe("serve.json", () => {
  const rec = (o: Partial<ServeJson> = {}): ServeJson => {
    const me = currentIdentity();
    return {
      url: "http://127.0.0.1:7447", host: "127.0.0.1", port: 7447, token: TOKEN, pid: me.pid, procStart: me.procStart,
      bootId: me.bootId, startedAt: "2026-09-24T10:00:00.000Z", version: "0.1.0-test", ...o,
    };
  };

  test("written atomically with mode 0600, read back by the read client, and removed", () => {
    const state = tempRoot();
    writeServeJson(state, rec());
    const file = join(state, SERVE_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(rec());
    expect(readServeRecord(state)).toMatchObject({ url: "http://127.0.0.1:7447", token: TOKEN, pid: process.pid });
    expect(removeServeJson(state)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(removeServeJson(state)).toBe(false);
  });

  test("never removes another server's record", () => {
    const state = tempRoot();
    writeFileSync(join(state, SERVE_FILE), JSON.stringify(rec({ pid: 999_999 })), { mode: 0o600 });
    expect(removeServeJson(state)).toBe(false);
    expect(existsSync(join(state, SERVE_FILE))).toBe(true);
  });

  test("a live server already recorded is refused, naming it; a dead one's record is replaced", async () => {
    const state = tempRoot();
    const other = spawnIdle();
    await other.waitFor("up");
    writeFileSync(join(state, SERVE_FILE), JSON.stringify(rec({ pid: other.pid, procStart: null, bootId: bootId(), url: "http://127.0.0.1:7999" })));
    const e = (() => {
      try {
        writeServeJson(state, rec());
      } catch (x) {
        return x as CroftError;
      }
      throw new Error("expected a refusal");
    })();
    expect(e.code).toBe("USAGE_ERROR");
    expect(e.message).toContain(String(other.pid));
    expect(e.message).toContain("http://127.0.0.1:7999");
    expect(JSON.parse(readFileSync(join(state, SERVE_FILE), "utf8")).pid).toBe(other.pid);
    other.proc.kill("SIGKILL");
    await other.exited;
    writeServeJson(state, rec());
    expect(JSON.parse(readFileSync(join(state, SERVE_FILE), "utf8")).pid).toBe(process.pid);
    expect(statSync(join(state, SERVE_FILE)).mode & 0o777).toBe(0o600);
  });
});

describe("binding", () => {
  // Also the guard against SO_REUSEPORT: with it, the second server bound the same port and took connections.
  test("a port in use is USAGE_ERROR with another port as the fix", () => {
    const first = serve(fakeEngine());
    let err: CroftError | undefined;
    try {
      serve(fakeEngine(), { port: first.port });
    } catch (e) {
      err = e as CroftError;
    }
    expect(err?.code).toBe("USAGE_ERROR");
    expect(err?.message).toContain(String(first.port));
    expect(err?.problem.fix).toMatchObject({ kind: "command" });
    expect((err?.problem.fix as { command: string }).command).toContain("croft serve --port");
  });

  test("an address that is not this machine's is USAGE_ERROR", () => {
    let err: CroftError | undefined;
    try {
      serve(fakeEngine(), { host: "203.0.113.7" });
    } catch (e) {
      err = e as CroftError;
    }
    expect(err?.code).toBe("USAGE_ERROR");
    expect(err?.message).toContain("203.0.113.7");
  });

  // Tests never bind every interface (that would expose a port, and may raise the OS firewall's prompt).
  test("the URL uses the address actually bound, with IPv6 in brackets", () => {
    expect(listenUrl("0.0.0.0", 7447)).toBe("http://0.0.0.0:7447");
    expect(listenUrl("::", 7447)).toBe("http://[::]:7447");
    expect(listenUrl("::1", 8080)).toBe("http://[::1]:8080");
    const s = serve(fakeEngine());
    expect(s.loopback).toBe(true);
    expect(s.host).toBe("127.0.0.1");
  });
});
