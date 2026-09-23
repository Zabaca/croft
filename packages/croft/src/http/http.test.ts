import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { CroftError } from "../core/errors.ts";
import { fail } from "../index.ts";
import { ProjectEnv } from "../project/env.ts";
import {
  buildUrl, createHttp, displayUrl, encodeBody, excerpt, nextLink, parseJsonLossless, parseLinkHeader, parseRetryAfter,
  type HttpOptions,
} from "./http.ts";

// ---------------------------------------------------------------------------------------------------
// The mock API. Each route keeps its own hit counter so tests can script flaky behavior.

const hits = new Map<string, number>();
const seen: { path: string; search: string; method: string; headers: Headers; body: string }[] = [];
const hit = (key: string) => {
  const n = (hits.get(key) ?? 0) + 1;
  hits.set(key, n);
  return n;
};

type Issue = { id: number; updated_at: string };
const ISSUES: Issue[] = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, updated_at: `2026-09-2${i}T00:00:00Z` }));

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    seen.push({ path: u.pathname, search: u.search, method: req.method, headers: req.headers, body: await req.text() });
    switch (u.pathname) {
      case "/echo":
        return Response.json({ query: Object.fromEntries(u.searchParams), auth: req.headers.get("authorization") });
      case "/big":
        return new Response('{"id":12345678901234567890,"small":42,"neg":-9007199254740993,"f":1.5,"e":1e21,"list":[18446744073709551615]}');
      case "/html":
        return new Response("<html>oops</html>", { headers: { "content-type": "text/html" } });
      case "/link": {
        // Link pagination: pages 1..3 of 3 items; relative next links, and a `last` rel for good measure.
        const page = Number(u.searchParams.get("page") ?? "1");
        const items = ISSUES.slice((page - 1) * 3, page * 3);
        const links = [`</link?page=3>; rel="last"`];
        if (page * 3 < ISSUES.length) links.unshift(`</link?page=${page + 1}>; rel="next"`);
        return Response.json(items, { headers: { link: links.join(", ") } });
      }
      case "/keyset": {
        // Ascending keyset API with a page size of 2 whose newest value never moves: KEYSET_STUCK.
        return Response.json([{ id: 1, updated_at: "2026-01-01T00:00:00Z" }, { id: 2, updated_at: "2026-01-01T00:00:00Z" }]);
      }
      case "/rate-limited":
        if (hit("rate-limited") === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
        return Response.json({ ok: true });
      case "/rate-limited-date": {
        if (hit("rate-limited-date") === 1) {
          const at = new Date(Date.now() + 1500).toUTCString();
          return new Response("slow down", { status: 503, headers: { "retry-after": at } });
        }
        return Response.json({ ok: true });
      }
      case "/rate-limited-long":
        return new Response("come back in an hour", { status: 429, headers: { "retry-after": "3600" } });
      case "/flaky":
        if (hit("flaky") <= 2) return new Response("boom", { status: 500 });
        return Response.json({ ok: true });
      case "/down":
        hit("down");
        return new Response(`{"error":"database on fire","token":"${u.searchParams.get("token")}","pad":"${"x".repeat(900)}"}`, {
          status: 502, statusText: "Bad Gateway",
        });
      case "/not-found":
        hit("not-found");
        return new Response('{"message":"Not Found"}', { status: 404 });
      case "/slow":
        hit("slow");
        await Bun.sleep(Number(u.searchParams.get("ms") ?? "2000"));
        return Response.json({ late: true });
      case "/slow-body": {
        hit("slow-body");
        const stream = new ReadableStream({
          async start(c) {
            c.enqueue(new TextEncoder().encode('{"partial":'));
            await Bun.sleep(1500);
            c.enqueue(new TextEncoder().encode("true}"));
            c.close();
          },
        });
        return new Response(stream);
      }
      case "/post":
        return new Response(`{"got":${seen.at(-1)!.body},"type":"${req.headers.get("content-type")}"}`);
      default:
        return new Response("no route", { status: 404 });
    }
  },
});
const BASE = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(() => {
  hits.clear();
  seen.length = 0;
});

function client(o: Partial<HttpOptions> = {}) {
  const lines: string[] = [];
  const http = createHttp({ signal: new AbortController().signal, retryBaseMs: 5, log: (m) => lines.push(m), ...o });
  return { http, lines };
}

async function httpError(p: Promise<unknown>): Promise<CroftError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(CroftError);
    expect((e as CroftError).code).toBe("HTTP_ERROR");
    return e as CroftError;
  }
  throw new Error("expected HTTP_ERROR");
}

// ---------------------------------------------------------------------------------------------------

describe("requests", () => {
  test("query building drops null and undefined, keeps false and 0, and appends to an existing query", async () => {
    const { http } = client();
    const res = await http.get(`${BASE}/echo?state=all`, {
      headers: { Authorization: "Bearer abc" },
      query: { since: undefined, cursor: null, per_page: 100, draft: false, zero: 0, q: "a b&c" },
    });
    expect(res.status).toBe(200);
    expect(res.json<object>()).toEqual({
      query: { state: "all", per_page: "100", draft: "false", zero: "0", q: "a b&c" },
      auth: "Bearer abc",
    });
    expect(seen[0]!.search).not.toContain("since");
    expect(seen[0]!.search).not.toContain("cursor");
    expect(http.requests).toBe(1);
    expect(http.attempts).toBe(1);
  });

  test("POST sends JSON with bigint as exact digits and sets content-type", async () => {
    const { http } = client();
    const res = await http.post(`${BASE}/post`, { id: 12345678901234567890n, name: "x" });
    const body = res.json<{ got: { id: bigint; name: string }; type: string }>();
    expect(seen[0]!.body).toBe('{"id":12345678901234567890,"name":"x"}');
    expect(body.got.id).toBe(12345678901234567890n);
    expect(body.type).toBe("application/json");
  });

  test("POST passes strings and form bodies through and keeps an explicit content-type", async () => {
    const { http } = client();
    await http.post(`${BASE}/post`, JSON.stringify({ a: 1 }), { headers: { "Content-Type": "application/vnd.api+json" } });
    expect(seen[0]!.headers.get("content-type")).toBe("application/vnd.api+json");
    await http.post(`${BASE}/post`, new URLSearchParams({ a: "1" }));
    expect(seen[1]!.body).toBe("a=1");
    expect(seen[1]!.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
  });

  test("an invalid URL is an HTTP_ERROR that is not retried", async () => {
    const { http } = client();
    const e = await httpError(http.get("api.example.com/items"));
    expect(e.message).toContain("not a valid absolute URL");
    expect(e.problem.details).toMatchObject({ reason: "invalid_url", attempts: 0, requestIndex: 1 });
    const e2 = await httpError(http.get("file:///etc/passwd"));
    expect(e2.message).toContain("only http and https");
  });

  test("counts logical requests and attempts separately", async () => {
    const { http } = client();
    await http.get(`${BASE}/echo`);
    await http.get(`${BASE}/flaky`);
    expect(http.requests).toBe(2);
    expect(http.attempts).toBe(4);
  });
});

describe("responses", () => {
  test("json() is lossless: unsafe integers become bigint, floats stay numbers", async () => {
    const { http } = client();
    const res = await http.get(`${BASE}/big`);
    expect(res.json<object>()).toEqual({ id: 12345678901234567890n, small: 42, neg: -9007199254740993n, f: 1.5, e: 1e21, list: [18446744073709551615n] });
    // Plain JSON.parse loses the digits; this is why res.json() exists.
    expect(String((JSON.parse(res.text) as { id: number }).id)).toBe("12345678901234567000");
  });

  test("json() on a non-JSON body is an HTTP_ERROR with the body excerpt", async () => {
    const { http } = client();
    const res = await http.get(`${BASE}/html`);
    expect(res.text).toBe("<html>oops</html>");
    const e = await httpError(Promise.resolve().then(() => res.json()));
    expect(e.message).toContain("is not JSON");
    expect(e.problem.details).toMatchObject({ reason: "invalid_json", status: 200, body: "<html>oops</html>" });
  });

  test("Link pagination follows res.next until it is absent", async () => {
    const { http } = client();
    const all: Issue[] = [];
    const urls: string[] = [];
    let url: string | undefined = `${BASE}/link`;
    while (url) {
      const res = await http.get(url);
      urls.push(res.url);
      all.push(...res.json<Issue[]>());
      url = res.next;
    }
    expect(all.map((i) => i.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(urls).toEqual([`${BASE}/link`, `${BASE}/link?page=2`, `${BASE}/link?page=3`]);
    expect(http.requests).toBe(3);
  });

  test("keyset paging that stops moving ends with fail('KEYSET_STUCK')", async () => {
    const { http } = client();
    const run = async () => {
      let from: string | undefined;
      for (;;) {
        const res = await http.get(`${BASE}/keyset`, { query: { since: from, per_page: 2 } });
        const page = res.json<Issue[]>();
        if (page.length < 2) return;
        const last = page.at(-1)!.updated_at;
        if (last === from) fail("KEYSET_STUCK", "2+ issues share one updated_at");
        from = last;
      }
    };
    const e = await run().then(() => null, (x: unknown) => x as CroftError);
    expect(e).toBeInstanceOf(CroftError);
    expect(e!.code).toBe("KEYSET_STUCK");
    expect(e!.message).toBe("2+ issues share one updated_at");
    expect(http.requests).toBe(2);
    expect(seen[0]!.search).toBe("?per_page=2");          // since: undefined on the first request is dropped
  });
});

describe("retries", () => {
  test("429 with Retry-After in seconds waits that long, then succeeds", async () => {
    const { http, lines } = client();
    const t0 = performance.now();
    const res = await http.get(`${BASE}/rate-limited`);
    const elapsed = performance.now() - t0;
    expect(res.json<object>()).toEqual({ ok: true });
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(http.attempts).toBe(2);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("429");
    expect(lines[0]).toContain("retrying in 1 s (attempt 2 of 4)");
  });

  test("503 with Retry-After as an HTTP date waits until that date", async () => {
    const { http } = client();
    const t0 = performance.now();
    await http.get(`${BASE}/rate-limited-date`);
    // HTTP dates have whole-second resolution, so the wait is between 0.5 s and 1.5 s.
    expect(performance.now() - t0).toBeGreaterThanOrEqual(400);
    expect(http.attempts).toBe(2);
  });

  test("a Retry-After longer than croft waits in a run fails at once with retryAfterMs", async () => {
    const { http, lines } = client();
    const t0 = performance.now();
    const e = await httpError(http.get(`${BASE}/rate-limited-long`));
    expect(performance.now() - t0).toBeLessThan(500);
    expect(e.problem.details).toMatchObject({ status: 429, attempts: 1, retryAfterMs: 3_600_000 });
    expect(e.problem.retryable).toBe(true);
    expect(e.message).toContain("asks to wait 3600 s");
    expect(lines).toHaveLength(0);
  });

  test("flaky 500s are retried until they pass", async () => {
    const { http, lines } = client();
    const res = await http.get(`${BASE}/flaky`);
    expect(res.json<object>()).toEqual({ ok: true });
    expect(hits.get("flaky")).toBe(3);
    expect(lines.map((l) => l.replace(/in \d+ ms/, "in N ms"))).toEqual([
      `GET ${BASE}/flaky: 500 Internal Server Error; retrying in N ms (attempt 2 of 4)`,
      `GET ${BASE}/flaky: 500 Internal Server Error; retrying in N ms (attempt 3 of 4)`,
    ]);
  });

  test("a persistent 5xx fails after 3 retries with redacted details and the first 500 bytes of the body", async () => {
    const env = new ProjectEnv({ root: null, fileValues: new Map([["API_TOKEN", "sekrit-token!42"]]) });
    const { http, lines } = client({ redact: (s) => env.redact(s) });
    const e = await httpError(http.get(`${BASE}/down`, { query: { token: "sekrit-token!42", page: 3 } }));
    expect(hits.get("down")).toBe(4);
    const d = e.problem.details!;
    expect(d).toMatchObject({ method: "GET", status: 502, attempts: 4, retryAfterMs: null, requestIndex: 1, reason: "status" });
    expect(d.url).toBe(`${BASE}/down?token=[redacted:API_TOKEN]&page=3`);
    expect(Buffer.byteLength(String(d.body).replace(/…$/, ""))).toBeLessThanOrEqual(500);
    expect(String(d.body)).toStartWith('{"error":"database on fire","token":"[redacted:API_TOKEN]"');
    expect(e.message).toContain("failed with 502 Bad Gateway after 4 attempts");
    expect(e.problem.retryable).toBe(true);
    for (const text of [e.message, JSON.stringify(d), ...lines]) expect(text).not.toContain("sekrit");
  });

  test("4xx other than 429 is not retried", async () => {
    const { http } = client();
    const e = await httpError(http.get(`${BASE}/not-found`));
    expect(hits.get("not-found")).toBe(1);
    expect(e.problem.details).toMatchObject({ status: 404, attempts: 1 });
    expect(e.problem.retryable).toBe(false);
    expect(e.problem.hint).toContain("check the URL");
  });

  test("retries: 0 in HttpInit turns retries off for one call", async () => {
    const { http } = client();
    const e = await httpError(http.get(`${BASE}/flaky`, { retries: 0 }));
    expect(e.problem.details).toMatchObject({ status: 500, attempts: 1 });
  });

  test("the requestIndex names which request of the run failed", async () => {
    const { http } = client();
    await http.get(`${BASE}/echo`);
    await http.get(`${BASE}/echo`);
    const e = await httpError(http.get(`${BASE}/not-found`));
    expect(e.problem.details!.requestIndex).toBe(3);
  });

  test("network errors are retried, then reported", async () => {
    const { http, lines } = client();
    // Port 1 on localhost refuses connections.
    const e = await httpError(http.get("http://127.0.0.1:1/items"));
    expect(e.problem.details).toMatchObject({ status: null, attempts: 4, reason: "network" });
    expect(lines).toHaveLength(3);
    expect(e.problem.hint).toContain("network");
  });
});

describe("timeouts and abort", () => {
  test("a request that gets no answer times out, is retried, then fails", async () => {
    const { http } = client();
    const t0 = performance.now();
    const e = await httpError(http.get(`${BASE}/slow`, { timeoutMs: 100, retries: 1, query: { ms: 1000 } }));
    expect(performance.now() - t0).toBeLessThan(900);
    expect(hits.get("slow")).toBe(2);
    expect(e.problem.details).toMatchObject({ reason: "timeout", attempts: 2, status: null });
    expect(e.message).toContain("no answer within 100 ms");
  });

  test("the timeout covers a body that stalls after the headers", async () => {
    const { http } = client();
    const t0 = performance.now();
    const e = await httpError(http.get(`${BASE}/slow-body`, { timeoutMs: 150, retries: 0 }));
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(e.problem.details).toMatchObject({ reason: "timeout" });
  });

  test("the default per-request timeout is 30 s", async () => {
    const { HTTP_DEFAULTS } = await import("./http.ts");
    expect(HTTP_DEFAULTS.timeoutMs).toBe(30_000);
    expect(HTTP_DEFAULTS.retries).toBe(3);
  });

  test("aborting the run rejects with the signal's reason and is never retried", async () => {
    const ac = new AbortController();
    const { http } = client({ signal: ac.signal });
    const reason = new Error("interrupted by Ctrl-C");
    setTimeout(() => ac.abort(reason), 50);
    const t0 = performance.now();
    const err = await http.get(`${BASE}/slow`, { query: { ms: 2000 } }).then(() => null, (x: unknown) => x);
    expect(err).toBe(reason);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(hits.get("slow")).toBe(1);
  });

  test("aborting during a Retry-After wait stops the wait", async () => {
    const ac = new AbortController();
    const { http } = client({ signal: ac.signal });
    setTimeout(() => ac.abort(new Error("stop")), 100);
    const t0 = performance.now();
    const err = await http.get(`${BASE}/rate-limited`).then(() => null, (x: unknown) => x as Error);
    expect(err?.message).toBe("stop");
    expect(performance.now() - t0).toBeLessThan(700);
    expect(hits.get("rate-limited")).toBe(1);
  });

  test("an already-aborted run makes no request", async () => {
    const ac = new AbortController();
    ac.abort();
    const { http } = client({ signal: ac.signal });
    const err = await http.get(`${BASE}/echo`).then(() => null, (x: unknown) => x as Error);
    expect(err?.name).toBe("AbortError");
    expect(seen).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------
// Pure helpers

describe("parseJsonLossless", () => {
  test("the 2^53 edges, int64 and uint64", () => {
    expect(parseJsonLossless("9007199254740991")).toBe(9007199254740991);
    expect(parseJsonLossless("9007199254740992")).toBe(9007199254740992n);
    expect(parseJsonLossless("-9007199254740991")).toBe(-9007199254740991);
    expect(parseJsonLossless("-9007199254740992")).toBe(-9007199254740992n);
    expect(parseJsonLossless("9223372036854775807")).toBe(9223372036854775807n);
    expect(parseJsonLossless("-9223372036854775808")).toBe(-9223372036854775808n);
    expect(parseJsonLossless("18446744073709551615")).toBe(18446744073709551615n);
  });

  test("floats, exponents and strings are untouched", () => {
    expect(parseJsonLossless('[1.5, 1e21, 12345678901234567890.5, "12345678901234567890", -0, 0]')).toEqual([
      1.5, 1e21, 12345678901234567000, "12345678901234567890", -0, 0,
    ]);
  });
});

describe("parseLinkHeader / nextLink", () => {
  test("GitHub style", () => {
    const h = '<https://api.github.com/repos/o/r/issues?page=2>; rel="next", <https://api.github.com/repos/o/r/issues?page=5>; rel="last"';
    expect(nextLink(h)).toBe("https://api.github.com/repos/o/r/issues?page=2");
    expect(parseLinkHeader(h).map((l) => l.rel)).toEqual([["next"], ["last"]]);
  });

  test("relative targets resolve against the response URL", () => {
    expect(nextLink("</items?cursor=abc>; rel=next", "https://api.example.com/v1/items")).toBe("https://api.example.com/items?cursor=abc");
    expect(nextLink("<page2>; rel=next", "https://api.example.com/v1/items")).toBe("https://api.example.com/v1/page2");
  });

  test("commas and semicolons inside <...> and quoted values do not split", () => {
    const h = '<https://x.test/a?ids=1,2;3>; title="a, b; c"; rel="prev", <https://x.test/b?ids=4,5>; rel="Next Last"';
    const links = parseLinkHeader(h);
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ url: "https://x.test/a?ids=1,2;3", rel: ["prev"], params: { title: "a, b; c" } });
    expect(links[1]!.rel).toEqual(["next", "last"]);
    expect(nextLink(h)).toBe("https://x.test/b?ids=4,5");
  });

  test("no header, no next", () => {
    expect(nextLink(null)).toBeUndefined();
    expect(nextLink('<https://x.test/a>; rel="prev"')).toBeUndefined();
    expect(parseLinkHeader("garbage")).toEqual([]);
  });
});

describe("parseRetryAfter", () => {
  test("seconds, fractional seconds and HTTP dates", () => {
    const now = Date.parse("2026-09-23T12:00:00Z");
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter("1.5", now)).toBe(1500);
    expect(parseRetryAfter("0", now)).toBe(0);
    expect(parseRetryAfter("Wed, 23 Sep 2026 12:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("Wed, 23 Sep 2026 11:00:00 GMT", now)).toBe(0);
  });

  test("absent or unreadable is null", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter("-5")).toBeNull();
  });
});

describe("helpers", () => {
  test("buildUrl", () => {
    expect(buildUrl("https://x.test/a?b=1", { c: 2, d: null, e: undefined, f: true })).toBe("https://x.test/a?b=1&c=2&f=true");
    expect(buildUrl("https://x.test/a", { "created[gte]": 1750748400 })).toBe("https://x.test/a?created%5Bgte%5D=1750748400");
  });

  test("displayUrl decodes the query so redaction sees raw secret text", () => {
    const href = buildUrl("https://user:p%40ss@x.test/a%20b", { token: "sekrit!~ x" });
    expect(href).not.toContain("sekrit!~ x");
    expect(displayUrl(href)).toBe("https://user:p@ss@x.test/a b?token=sekrit!~ x");
    const env = new ProjectEnv({ root: null, fileValues: new Map([["T", "sekrit!~ x"]]) });
    expect(env.redact(displayUrl(href))).toBe("https://user:p@ss@x.test/a b?token=[redacted:T]");
  });

  test("excerpt cuts at 500 bytes without splitting a character", () => {
    expect(excerpt("short")).toBe("short");
    const long = "é".repeat(400);                     // 800 bytes
    const cut = excerpt(long);
    expect(cut.endsWith("…")).toBe(true);
    expect(Buffer.byteLength(cut.slice(0, -1))).toBe(500);
    expect(cut).not.toContain("�");
  });

  test("encodeBody leaves binary bodies alone", () => {
    const h = new Headers();
    const bytes = new Uint8Array([1, 2]);
    expect(encodeBody(bytes, h)).toBe(bytes);
    expect(h.has("content-type")).toBe(false);
    expect(encodeBody(undefined, h)).toBeUndefined();
  });
});
