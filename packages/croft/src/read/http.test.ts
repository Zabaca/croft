import { afterAll, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { decodeChunked, isLoopback, post, postDirect, postFetch, ResponseParser, TransportError } from "./http.ts";
import { deadPort } from "./testkit.ts";

const servers: { stop(): unknown }[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
});

const T = { connectMs: 1000, responseMs: 3000 };

/** A raw TCP server that answers every connection with `reply` (bytes written in the given pieces). */
async function rawServer(pieces: string[], o: { closeAfter?: boolean; gapMs?: number } = {}): Promise<{ url: URL; requests: string[] }> {
  const requests: string[] = [];
  const server: Server = createServer((sock: Socket) => {
    let got = "";
    sock.on("data", async (d) => {
      got += String(d);
      if (!got.includes("\r\n\r\n")) return;
      const len = Number(got.match(/content-length: (\d+)/i)?.[1] ?? 0);
      if (Buffer.byteLength(got.split("\r\n\r\n").slice(1).join("\r\n\r\n")) < len) return;
      requests.push(got);
      for (const p of pieces) {
        sock.write(p);
        if (o.gapMs) await new Promise((r) => setTimeout(r, o.gapMs));
      }
      if (o.closeAfter) sock.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push({ stop: () => new Promise((r) => server.close(r)) });
  const port = (server.address() as { port: number }).port;
  return { url: new URL(`http://127.0.0.1:${port}/query`), requests };
}

describe("ResponseParser", () => {
  test("Content-Length body split across packets", () => {
    const p = new ResponseParser();
    expect(p.push(Buffer.from("HTTP/1.1 200 OK\r\nContent-Le"))).toBeNull();
    expect(p.push(Buffer.from("ngth: 11\r\nX-A: 1\r\nX-A: 2\r\n\r\nhello"))).toBeNull();
    expect(p.push(Buffer.from(" world"))).toEqual({ status: 200, headers: { "content-length": "11", "x-a": "1, 2" }, body: "hello world" });
  });

  test("chunked bodies, including multi-byte UTF-8 split between chunks", () => {
    const euro = Buffer.from("€"); // 3 bytes
    const body = Buffer.concat([
      Buffer.from("HTTP/1.1 503 Service Unavailable\r\nTransfer-Encoding: chunked\r\nRetry-After: 1\r\n\r\n"),
      Buffer.from("4;ext=1\r\nab"), euro.subarray(0, 2), Buffer.from("\r\n"),
      Buffer.from("1\r\n"), euro.subarray(2), Buffer.from("\r\n0\r\n\r\n"),
    ]);
    const p = new ResponseParser();
    let reply = null;
    for (let i = 0; i < body.length && !reply; i += 5) reply = p.push(body.subarray(i, i + 5));
    expect(reply).toEqual({ status: 503, headers: { "transfer-encoding": "chunked", "retry-after": "1" }, body: "ab€" });
  });

  test("close-delimited bodies complete at end(); truncated ones throw", () => {
    const p = new ResponseParser();
    expect(p.push(Buffer.from("HTTP/1.0 200 OK\r\n\r\n{\"a\":"))).toBeNull();
    expect(p.push(Buffer.from("1}"))).toBeNull();
    expect(p.end()).toEqual({ status: 200, headers: {}, body: "{\"a\":1}" });
    const q = new ResponseParser();
    q.push(Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc"));
    expect(() => q.end()).toThrow("3 of 10");
  });

  test("skips an interim 100 Continue; rejects garbage", () => {
    const p = new ResponseParser();
    expect(p.push(Buffer.from("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n"))).toEqual({ status: 204, headers: {}, body: "" });
    expect(() => new ResponseParser().push(Buffer.from("SSH-2.0-OpenSSH\r\n\r\n"))).toThrow("status line");
    expect(() => new ResponseParser().push(Buffer.from("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n"))).toThrow("chunk size");
  });

  test("decodeChunked waits for the terminating chunk", () => {
    expect(decodeChunked(Buffer.from("3\r\nabc\r\n"))).toBeNull();
    expect(decodeChunked(Buffer.from("3\r\nabc\r\n0\r\n"))).toBeNull();
    expect(decodeChunked(Buffer.from("3\r\nabc\r\n0\r\n\r\n"))!.toString()).toBe("abc");
  });
});

describe("isLoopback", () => {
  test.each([
    ["http://127.0.0.1:7447", true], ["http://127.9.9.9", true], ["http://localhost:1", true], ["http://LOCALHOST.:1", true],
    ["http://app.localhost", true], ["http://[::1]:7447", true], ["http://[0:0:0:0:0:0:0:1]", true], ["http://127.1", true],
    ["http://[::ffff:127.0.0.1]", true], ["http://0.0.0.0:7447", true], ["http://[::]:7447", true],
    ["http://10.0.0.5:7447", false], ["https://croft.example.com", false], ["http://128.0.0.1", false], ["http://[::2]", false],
    ["http://localhost.example.com", false],
  ])("%s → %p", (url, want) => {
    expect(isLoopback(new URL(url))).toBe(want);
  });
});

describe("postDirect (raw HTTP/1.1 over node:net)", () => {
  test("sends method, path, Host, headers and body; reads a Bun.serve reply", async () => {
    let seen: { method: string; url: string; host: string | null; auth: string | null; type: string | null; body: string } | null = null;
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(r) {
      seen = { method: r.method, url: r.url, host: r.headers.get("host"), auth: r.headers.get("authorization"), type: r.headers.get("content-type"), body: await r.text() };
      return Response.json({ ok: true, echo: "ünïcödé" }, { headers: { "Retry-After": "2" } });
    } });
    servers.push(s);
    const reply = await postDirect(new URL(`http://127.0.0.1:${s.port}/base/query?x=1`), JSON.stringify({ sql: "SELECT 'é'" }),
      { "Content-Type": "application/json", Authorization: "Bearer t0k" }, T);
    expect(reply.status).toBe(200);
    expect(reply.headers["retry-after"]).toBe("2");
    expect(JSON.parse(reply.body)).toEqual({ ok: true, echo: "ünïcödé" });
    expect(seen!).toEqual({ method: "POST", url: `http://127.0.0.1:${s.port}/base/query?x=1`, host: `127.0.0.1:${s.port}`,
      auth: "Bearer t0k", type: "application/json", body: JSON.stringify({ sql: "SELECT 'é'" }) });
  });

  test("streamed (chunked) replies from Bun.serve", async () => {
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(new ReadableStream({
      async start(c) {
        c.enqueue(new TextEncoder().encode('{"rows":['));
        await new Promise((r) => setTimeout(r, 20));
        c.enqueue(new TextEncoder().encode("1,2]}"));
        c.close();
      },
    })) });
    servers.push(s);
    const reply = await postDirect(new URL(`http://127.0.0.1:${s.port}/query`), "{}", {}, T);
    expect(reply.headers["transfer-encoding"]).toBe("chunked");
    expect(JSON.parse(reply.body)).toEqual({ rows: [1, 2] });
  });

  test("keep-alive servers that do not close: completes on Content-Length", async () => {
    const srv = await rawServer(["HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\n", "{}"], { gapMs: 10 });
    const t0 = Date.now();
    expect((await postDirect(srv.url, "{}", {}, T)).body).toBe("{}");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(srv.requests[0]).toContain("Connection: close\r\n");
    expect(srv.requests[0]).toContain("Content-Length: 2\r\n");
  });

  test("close-delimited replies", async () => {
    const srv = await rawServer(["HTTP/1.0 200 OK\r\n\r\n", "partial ", "body"], { closeAfter: true, gapMs: 5 });
    expect((await postDirect(srv.url, "{}", {}, T)).body).toBe("partial body");
  });

  test("refused connection → TransportError(connect); silent server → TransportError(response)", async () => {
    const port = await deadPort();
    const e1 = await postDirect(new URL(`http://127.0.0.1:${port}/query`), "{}", {}, T).catch((e) => e);
    expect(e1).toBeInstanceOf(TransportError);
    expect(e1.phase).toBe("connect");
    const silent = await rawServer([]);
    const t0 = Date.now();
    const e2 = await postDirect(silent.url, "{}", {}, { connectMs: 1000, responseMs: 150 }).catch((e) => e);
    expect(e2.phase).toBe("response");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
  });

  test("a reply cut short is a response error, not a success", async () => {
    const srv = await rawServer(["HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{\"rows\":["], { closeAfter: true });
    const e = await postDirect(srv.url, "{}", {}, T).catch((x) => x);
    expect(e).toBeInstanceOf(TransportError);
    expect(e.phase).toBe("response");
    expect(e.message).toContain("of 100");
  });

  test("header values cannot inject lines", () => {
    expect(() => postDirect(new URL("http://127.0.0.1:1/query"), "{}", { Authorization: "Bearer x\r\nX-Evil: 1" }, T)).toThrow("line break");
  });

  test("post() routes loopback URLs through postDirect", async () => {
    const srv = await rawServer(["HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"]);
    expect((await post(srv.url, "{}", { "User-Agent": "croft-read/test" }, T)).body).toBe("ok");
    // Only the raw client writes this exact header block (fetch adds its own headers).
    expect(srv.requests[0]!.startsWith("POST /query HTTP/1.1\r\nHost: 127.0.0.1:")).toBe(true);
  });
});

describe("postFetch (non-loopback hosts)", () => {
  test("reads status, headers and body", async () => {
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("nope", { status: 503, headers: { "Retry-After": "3" } }) });
    servers.push(s);
    const reply = await postFetch(new URL(`http://127.0.0.1:${s.port}/query`), "{}", {}, T);
    expect(reply).toMatchObject({ status: 503, body: "nope" });
    expect(reply.headers["retry-after"]).toBe("3");
  });

  test("a refused connection is TransportError(connect)", async () => {
    const port = await deadPort();
    const e = await postFetch(new URL(`http://127.0.0.1:${port}/query`), "{}", {}, T).catch((x) => x);
    expect(e).toBeInstanceOf(TransportError);
    expect(e.phase).toBe("connect");
  });
});
