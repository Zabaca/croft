import { afterAll, describe, expect, test } from "bun:test";
import { CroftError, problem } from "../core/errors.ts";
import type { SelectRequest } from "./wire.ts";
import { ABSENT, DEFAULT_SERVER_TIMINGS, fromProblem, queryEndpoint, retryAfterMs, serverQuery, type ServerTarget, type ServerTimings } from "./server.ts";
import { deadPort, envelope, type MockServe, mockServe } from "./testkit.ts";

const mocks: MockServe[] = [];
afterAll(async () => {
  for (const m of mocks) await m.stop();
});
function mock(o: Parameters<typeof mockServe>[0]): MockServe {
  const m = mockServe(o);
  mocks.push(m);
  return m;
}

const T = (timeoutMs = 2000): ServerTimings => ({ timeoutMs, ...DEFAULT_SERVER_TIMINGS });
const req = (sql = "SELECT 1 AS x", params: unknown[] = [], limit = 10_000): SelectRequest => ({ sql, params, limit });
const target = (url: string, token: string | null = "s3cret", local = false): ServerTarget =>
  ({ url: new URL(url), token, tokenSource: token ? "option" : null, local });

async function rejection(p: Promise<unknown>): Promise<CroftError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
  throw new Error("expected a CroftError");
}

describe("the /query request", () => {
  test("POST /query with a bearer token, JSON content type and {sql, params, limit}", async () => {
    const m = mock({ token: "s3cret", run: async () => [{ x: 1 }] });
    const rows = await serverQuery(target(m.url), req("SELECT $1::INT AS x", [1n, "a", null, { k: true }], 50), T());
    expect(rows).toEqual([{ x: 1 }]);
    expect(m.seen).toHaveLength(1);
    const s = m.seen[0]!;
    expect(s.method).toBe("POST");
    expect(s.path).toBe("/query");
    expect(s.headers.authorization).toBe("Bearer s3cret");
    expect(s.headers["content-type"]).toBe("application/json");
    expect(s.headers["user-agent"]).toStartWith("croft-read/");
    expect(s.headers.origin).toBeUndefined();
    expect(s.body).toEqual({ sql: "SELECT $1::INT AS x", params: [1, "a", null, { k: true }], limit: 50 });
  });

  test("bigint params travel as exact digits; no params key when there are none", async () => {
    const m = mock({ answer: () => Response.json(envelope([])) });
    await serverQuery(target(m.url), req("SELECT $1", [9007199254740993n, new Date("2026-01-01T00:00:00Z")]), T());
    expect(m.seen[0]!.raw).toBe('{"sql":"SELECT $1","params":[9007199254740993,"2026-01-01T00:00:00.000Z"],"limit":10000}');
    await serverQuery(target(m.url), req("SELECT 1"), T());
    expect(m.seen[1]!.body).toEqual({ sql: "SELECT 1", limit: 10_000 });
  });

  test("a base URL with a path keeps it; one ending in /query is used as is", () => {
    expect(queryEndpoint(new URL("http://127.0.0.1:7447")).href).toBe("http://127.0.0.1:7447/query");
    expect(queryEndpoint(new URL("https://h.example/croft/")).href).toBe("https://h.example/croft/query");
    expect(queryEndpoint(new URL("https://h.example/croft?x=1#y")).href).toBe("https://h.example/croft/query");
    expect(queryEndpoint(new URL("http://127.0.0.1:7447/query")).href).toBe("http://127.0.0.1:7447/query");
  });

  test("a token with a control character is refused before anything is sent", async () => {
    const m = mock({ run: async () => [] });
    const e = await rejection(serverQuery(target(m.url, "abc\r\nX-Evil: 1"), req(), T()));
    expect(e.code).toBe("USAGE_ERROR");
    expect(e.message).not.toContain("abc");
    expect(m.seen).toHaveLength(0);
  });
});

describe("tokens", () => {
  test("a wrong token is SERVE_UNAUTHORIZED, not retried, and never echoed", async () => {
    const m = mock({ token: "right" });
    const e = await rejection(serverQuery(target(m.url, "wrong-token-value"), req(), T()));
    expect(e.code).toBe("SERVE_UNAUTHORIZED");
    expect(e.problem.details).toMatchObject({ status: 401, tokenSource: "option" });
    expect(e.problem.retryable).toBe(false);
    expect(JSON.stringify(e.problem)).not.toContain("wrong-token-value");
    expect(m.seen).toHaveLength(1);
  });

  test("no token at all says so", async () => {
    const m = mock({ token: "right" });
    const e = await rejection(serverQuery(target(m.url, null), req(), T()));
    expect(e.code).toBe("SERVE_UNAUTHORIZED");
    expect(e.message).toContain("requires a token");
    expect(m.seen[0]!.headers.authorization).toBeUndefined();
  });

  test("a 401 envelope with a known code keeps that code", async () => {
    const p = problem("SERVE_UNSAFE_FILESYSTEM", { message: "nope", hint: "h" });
    const m = mock({ answer: () => Response.json(envelope([], { ok: false, problems: [p] }), { status: 401 }) });
    expect((await rejection(serverQuery(target(m.url), req(), T()))).code).toBe("SERVE_UNSAFE_FILESYSTEM");
    // Including the server's own SERVE_UNAUTHORIZED.
    const u = problem("SERVE_UNAUTHORIZED", { message: "croft serve rejected the token", hint: "h" });
    const m2 = mock({ answer: () => Response.json(envelope([], { ok: false, problems: [u] }), { status: 401 }) });
    expect((await rejection(serverQuery(target(m2.url), req(), T()))).problem).toMatchObject({ code: "SERVE_UNAUTHORIZED", message: "croft serve rejected the token" });
  });
});

describe("503 and unreachable servers", () => {
  test("retries 503 with Retry-After until the server answers", async () => {
    const m = mock({
      token: "s3cret",
      answer: (_r, n) => (n <= 2 ? new Response("writing", { status: 503, headers: { "Retry-After": "0" } }) : undefined),
      run: async () => [{ x: 1 }],
    });
    expect(await serverQuery(target(m.url), req(), T())).toEqual([{ x: 1 }]);
    expect(m.seen).toHaveLength(3);
  });

  test("honors a Retry-After of one second", async () => {
    const m = mock({
      answer: (_r, n) => (n === 1 ? new Response("writing", { status: 503, headers: { "Retry-After": "1" } }) : Response.json(envelope([{ ok: 1 }]))),
    });
    const t0 = Date.now();
    expect(await serverQuery(target(m.url), req(), T(5000))).toEqual([{ ok: 1 }]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
  });

  test("still 503 after timeoutMs → SERVE_UNAVAILABLE (busy)", async () => {
    const m = mock({ answer: () => new Response("writing", { status: 503, headers: { "Retry-After": "0.05" } }) });
    const t0 = Date.now();
    const e = await rejection(serverQuery(target(m.url), req(), T(400)));
    const waited = Date.now() - t0;
    expect(e.code).toBe("SERVE_UNAVAILABLE");
    expect(e.problem.details).toMatchObject({ reason: "busy", status: 503 });
    expect(e.message).toContain("never falls back");
    expect(waited).toBeGreaterThanOrEqual(380);
    expect(waited).toBeLessThan(2000);
    expect(m.seen.length).toBeGreaterThan(2);
  });

  test("502/504 from a proxy in front of the server are retried like 503", async () => {
    const m = mock({ answer: (_r, n) => (n === 1 ? new Response("bad gateway", { status: 502 }) : Response.json(envelope([{ a: 1 }]))) });
    expect(await serverQuery(target(m.url), req(), T())).toEqual([{ a: 1 }]);
  });

  test("an unreachable explicit URL is retried until timeoutMs, then SERVE_UNAVAILABLE", async () => {
    const port = await deadPort();
    const t0 = Date.now();
    const e = await rejection(serverQuery(target(`http://127.0.0.1:${port}`), req(), T(300)));
    const waited = Date.now() - t0;
    expect(e.code).toBe("SERVE_UNAVAILABLE");
    expect(e.problem.details).toMatchObject({ reason: "unreachable", phase: "connect" });
    expect(waited).toBeGreaterThanOrEqual(290);
    expect(waited).toBeLessThan(2000);
  });

  test("an explicit URL whose server comes up during the wait succeeds", async () => {
    const port = await deadPort();
    setTimeout(() => {
      const s = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => Response.json(envelope([{ late: true }])) });
      mocks.push({ url: "", port, seen: [], stop: () => s.stop(true) });
    }, 150);
    expect(await serverQuery(target(`http://127.0.0.1:${port}`), req(), T(3000))).toEqual([{ late: true }]);
  });

  test("a serve.json server that refuses the connection is ABSENT at once", async () => {
    const port = await deadPort();
    const t0 = Date.now();
    expect(await serverQuery(target(`http://127.0.0.1:${port}`, "t", true), req(), T(5000))).toBe(ABSENT);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  test("a serve.json server that answers 503 is waited for, not bypassed", async () => {
    const m = mock({ answer: (_r, n) => (n === 1 ? new Response("", { status: 503, headers: { "Retry-After": "0" } }) : Response.json(envelope([{ a: 2 }]))) });
    expect(await serverQuery(target(m.url, "t", true), req(), T())).toEqual([{ a: 2 }]);
  });
});

describe("replies", () => {
  test("an error envelope becomes a CroftError with the server's code, message, hint and details", async () => {
    const p = problem("QUERY_NOT_SELECT", { message: "query runs exactly one SELECT", hint: "use SELECT", details: { duckdb: "x" } });
    const m = mock({ answer: () => Response.json(envelope([], { ok: false, problems: [p] }), { status: 400 }) });
    const e = await rejection(serverQuery(target(m.url), req("DELETE FROM t"), T()));
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("QUERY_NOT_SELECT");
    expect(e.problem).toMatchObject({ message: "query runs exactly one SELECT", hint: "use SELECT", details: { duckdb: "x" }, docs: "croft docs QUERY_NOT_SELECT" });
  });

  test("a code this croft does not know (version skew) is INTERNAL_ERROR naming it", () => {
    const e = fromProblem({ severity: "error", code: "FUTURE_CODE", message: "m", hint: "h" }, 400);
    expect(e.code).toBe("INTERNAL_ERROR");
    expect(e.problem.details).toMatchObject({ remoteCode: "FUTURE_CODE", status: 400 });
    expect(e.message).toContain("FUTURE_CODE");
  });

  test("any reported truncation, or more rows than the limit, is QUERY_TOO_MANY_ROWS", async () => {
    const rows = [{ i: 1 }, { i: 2 }, { i: 3 }];
    const truncated = mock({ answer: () => Response.json(envelope(rows.slice(0, 2), { truncatedRows: 1 })) });
    const e1 = await rejection(serverQuery(target(truncated.url), req("SELECT i FROM t", [], 2), T()));
    expect(e1.code).toBe("QUERY_TOO_MANY_ROWS");
    expect(e1.problem.details).toMatchObject({ limit: 2, truncatedRows: 1 });
    const ignoresLimit = mock({ answer: () => Response.json(envelope(rows)) });
    expect((await rejection(serverQuery(target(ignoresLimit.url), req("SELECT i FROM t", [], 2), T()))).code).toBe("QUERY_TOO_MANY_ROWS");
    expect(await serverQuery(target(ignoresLimit.url), req("SELECT i FROM t", [], 3), T())).toEqual(rows);
    const values = mock({ answer: () => Response.json(envelope(rows, { truncatedValues: true })) });
    const e3 = await rejection(serverQuery(target(values.url), req(), T()));
    expect(e3.code).toBe("QUERY_TOO_MANY_ROWS");
    expect(e3.message).toContain("shortened");
    const booleanFalse = mock({ answer: () => Response.json(envelope(rows, { truncatedRows: false, truncatedValues: 0 })) });
    expect(await serverQuery(target(booleanFalse.url), req(), T())).toEqual(rows);
  });

  test("a read-copy answer (stale: true) still returns its rows", async () => {
    const m = mock({ answer: () => Response.json({ ...envelope([{ a: 1 }]), stale: true, asOf: "2026-09-23T10:00:00-07:00" }) });
    expect(await serverQuery(target(m.url), req(), T())).toEqual([{ a: 1 }]);
  });

  test("something that is not croft serve", async () => {
    const html = mock({ answer: () => new Response("<html>hello</html>", { status: 200, headers: { "Content-Type": "text/html" } }) });
    const e1 = await rejection(serverQuery(target(html.url), req(), T()));
    expect(e1.code).toBe("SERVE_UNAVAILABLE");
    expect(e1.message).toContain("without a query envelope");
    const notFound = mock({ answer: () => new Response("nope", { status: 404 }) });
    expect((await rejection(serverQuery(target(notFound.url), req(), T()))).problem.details).toMatchObject({ status: 404 });
    const noRows = mock({ answer: () => Response.json({ ...envelope([]), data: { columns: [] } }) });
    expect((await rejection(serverQuery(target(noRows.url), req(), T()))).code).toBe("INTERNAL_ERROR");
  });
});

describe("retryAfterMs", () => {
  test("seconds, fractions and HTTP dates", () => {
    expect(retryAfterMs(undefined)).toBeNull();
    expect(retryAfterMs("2")).toBe(2000);
    expect(retryAfterMs(" 0.25 ")).toBe(250);
    expect(retryAfterMs("soon")).toBeNull();
    const now = Date.parse("2026-09-23T10:00:00Z");
    expect(retryAfterMs("Wed, 23 Sep 2026 10:00:03 GMT", now)).toBe(3000);
    expect(retryAfterMs("Wed, 23 Sep 2026 09:00:00 GMT", now)).toBe(0);
  });
});
