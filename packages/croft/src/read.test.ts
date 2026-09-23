// @zabaca/croft/read end to end: routing between croft serve and the file, identical rows in both modes,
// QUERY_TOO_MANY_ROWS, and a loopback server reached past an HTTP proxy.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { CroftError } from "./core/errors.ts";
import { query } from "./read.ts";
import { directQuery } from "./read/direct.ts";
import { type ReadContext, type Route, runQuery } from "./read/run.ts";
import { cleanup, deadPort, makeProject, type MockServe, mockServe, spawnIdle, type TempProject, writeServeJson } from "./read/testkit.ts";

const mocks: MockServe[] = [];
afterAll(async () => {
  for (const m of mocks) await m.stop();
  cleanup();
});

const FAST_DIRECT = { intentWaitMs: 300, lockRetryMs: 500, pollMs: 20 };

/** A croft-serve-like mock that answers /query from the project's file, the way croft serve does. */
function serveFor(p: TempProject, token = "s3cret"): MockServe {
  const m = mockServe({
    token,
    run: (b) => directQuery(p.project, { sql: b.sql, params: b.params ?? [], limit: b.limit ?? 10_000 }, FAST_DIRECT),
  });
  mocks.push(m);
  return m;
}

async function run(sql: string, params: unknown[] | undefined, options: Record<string, unknown> | undefined, ctx: Partial<ReadContext>) {
  let route: Route | undefined;
  const rows = await runQuery(sql, params, options, { env: {}, cwd: "/", direct: FAST_DIRECT, ...ctx }, (r) => (route = r));
  return { rows, route };
}

async function rejection(p: Promise<unknown>): Promise<CroftError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
  throw new Error("expected a CroftError");
}

describe("routing", () => {
  test("{ url }: HTTP only, no project needed", async () => {
    const p = await makeProject({ seed: ["CREATE TABLE t AS SELECT 1 AS a"] });
    const m = serveFor(p);
    const { rows, route } = await run("SELECT a FROM t", [], { url: m.url, token: "s3cret" }, { cwd: "/" });
    expect(rows).toEqual([{ a: 1 }]);
    expect(route).toBe("url");
  });

  test("CROFT_URL + CROFT_SERVE_TOKEN (a hosted app)", async () => {
    const p = await makeProject({ seed: ["CREATE TABLE t AS SELECT 2 AS a"] });
    const m = serveFor(p);
    const { rows, route } = await run("SELECT a FROM t", [], undefined, { env: { CROFT_URL: m.url, CROFT_SERVE_TOKEN: "s3cret" } });
    expect(rows).toEqual([{ a: 2 }]);
    expect(route).toBe("url");
    expect(m.seen[0]!.headers.authorization).toBe("Bearer s3cret");
  });

  test("an explicit URL takes the token from the local serve.json when it names the same server", async () => {
    const p = await makeProject({ seed: ["CREATE TABLE t AS SELECT 3 AS a"] });
    const m = serveFor(p, "from-serve-json");
    writeServeJson(p.stateDir, { url: m.url, token: "from-serve-json", pid: process.pid });
    expect((await run("SELECT a FROM t", [], undefined, { env: { CROFT_URL: m.url }, cwd: p.root })).rows).toEqual([{ a: 3 }]);
  });

  test("an unreachable explicit URL is SERVE_UNAVAILABLE and never falls back to the file", async () => {
    const p = await makeProject({ seed: ["CREATE TABLE t AS SELECT 1 AS a"] });
    const port = await deadPort();
    const e = await rejection(run("SELECT a FROM t", [], { url: `http://127.0.0.1:${port}`, timeoutMs: 200 }, { cwd: p.root }));
    expect(e.code).toBe("SERVE_UNAVAILABLE");
  });

  test("a live croft serve in serve.json answers, with its token", async () => {
    const p = await makeProject({ seed: ["CREATE TABLE t AS SELECT 4 AS a"] });
    const m = serveFor(p, "tok-json");
    writeServeJson(p.stateDir, { url: m.url, token: "tok-json", pid: process.pid });
    const { rows, route } = await run("SELECT a FROM t", [], undefined, { cwd: p.root });
    expect(rows).toEqual([{ a: 4 }]);
    expect(route).toBe("serve.json");
    expect(m.seen).toHaveLength(1);
  });

  test("a serve.json server that is gone, or does not answer, means direct mode", async () => {
    const p = await makeProject({ seed: ["CREATE TABLE t AS SELECT 5 AS a"] });
    const ghost = spawnIdle();
    await ghost.waitFor("up");
    const m = serveFor(p);
    writeServeJson(p.stateDir, { url: m.url, token: "s3cret", pid: ghost.pid });
    ghost.proc.kill("SIGKILL");
    await ghost.exited;
    let r = await run("SELECT a FROM t", [], undefined, { cwd: p.root });
    expect(r).toEqual({ rows: [{ a: 5 }], route: "direct" });
    expect(m.seen).toHaveLength(0);
    // Alive (this process) but nothing listens on the recorded port.
    writeServeJson(p.stateDir, { url: `http://127.0.0.1:${await deadPort()}`, token: "x", pid: process.pid });
    const t0 = Date.now();
    r = await run("SELECT a FROM t", [], undefined, { cwd: p.root });
    expect(r).toEqual({ rows: [{ a: 5 }], route: "direct" });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test("no server anywhere: direct mode via CROFT_PROJECT", async () => {
    const p = await makeProject({ seed: ["CREATE TABLE t AS SELECT 6 AS a"] });
    expect(await run("SELECT a FROM t", [], undefined, { env: { CROFT_PROJECT: p.root } })).toEqual({ rows: [{ a: 6 }], route: "direct" });
  });

  test("argument checks are USAGE_ERROR", async () => {
    const p = await makeProject({ seed: ["CREATE TABLE t AS SELECT 1 AS a"] });
    const ctx = { cwd: p.root };
    for (const [sql, params, options] of [
      [42, [], undefined], ["SELECT 1", "x", undefined], ["SELECT 1", [], "opts"], ["SELECT 1", [], { limit: 0 }],
      ["SELECT 1", [], { limit: 1.5 }], ["SELECT 1", [], { timeoutMs: -1 }], ["SELECT 1", [], { url: 7 }],
    ] as const) {
      const e = await rejection(runQuery(sql, params, options, { env: {}, direct: FAST_DIRECT, ...ctx }));
      expect(e.code).toBe("USAGE_ERROR");
    }
  });
});

// Every type family croft renders specially (§4.3), plus JSON edge cases.
const GOLDEN_SEED = [
  "CREATE TYPE mood AS ENUM ('ok', 'sad')",
  `CREATE TABLE golden AS SELECT
    42::INTEGER AS i, 9007199254740991::BIGINT AS safe_big, 9007199254740993::BIGINT AS unsafe_big, -9007199254740993::BIGINT AS neg_big,
    170141183460469231731687303715884105727::HUGEINT AS huge, 18446744073709551615::UBIGINT AS ubig,
    1234.50::DECIMAL(10,2) AS dec, 2.5::DOUBLE AS dbl, 'NaN'::DOUBLE AS nan, '-inf'::DOUBLE AS neg_inf, (-0.0)::DOUBLE AS neg_zero,
    0.1::FLOAT AS flt, true AS flag, 'héllo 🌍 "q" \\ ' AS txt, NULL::VARCHAR AS nothing,
    DATE '2026-03-08' AS d, TIMESTAMP '2026-03-08 02:30:00.123456' AS naive,
    TIMESTAMPTZ '2026-03-08 09:59:59Z' AS before_dst, TIMESTAMPTZ '2026-03-08 10:00:00Z' AS after_dst,
    TIMESTAMPTZ '2026-11-01 08:30:00.5Z' AS fall_back, TIME '13:45:00' AS tm, INTERVAL '1 day 2 hours' AS iv,
    '6f1b2c3d-0000-4000-8000-000000000001'::UUID AS id, '\\xAA\\x00'::BLOB AS bytes,
    '{"n": 12345678901234567890, "nested": {"a": [1, null, "x"]}, "__proto__": {"polluted": true}}'::JSON AS doc,
    [1, 2, NULL]::INTEGER[] AS ints, [TIMESTAMPTZ '2026-01-01 00:00:00Z'] AS stamps,
    {'k': 1, 'big': 9007199254740993::BIGINT, 'when': DATE '2026-01-02'} AS st, MAP {'a': 1, 'b': 2} AS mp,
    'sad'::mood AS feeling, TIMESTAMP_NS '2026-01-01 00:00:00.123456789' AS ns`,
];

describe("identical rows in both modes (golden)", () => {
  test("direct and server mode return the same rows for every rendered type", async () => {
    const p = await makeProject({ seed: GOLDEN_SEED });
    const m = serveFor(p);
    const direct = await run("SELECT * FROM golden", [], undefined, { cwd: p.root });
    const served = await run("SELECT * FROM golden", [], { url: m.url, token: "s3cret" }, { cwd: "/" });
    expect(direct.route).toBe("direct");
    expect(served.route).toBe("url");
    expect(served.rows).toStrictEqual(direct.rows);
    expect(JSON.stringify(served.rows)).toBe(JSON.stringify(direct.rows));
    const row = direct.rows[0]!;
    expect(row).toMatchObject({
      i: 42, safe_big: 9007199254740991, unsafe_big: "9007199254740993", neg_big: "-9007199254740993",
      huge: "170141183460469231731687303715884105727", ubig: "18446744073709551615", dec: "1234.50",
      dbl: 2.5, nan: "NaN", neg_inf: "-Infinity", flag: true, txt: 'héllo 🌍 "q" \\ ', nothing: null,
      d: "2026-03-08", naive: "2026-03-08T02:30:00.123456",
      before_dst: "2026-03-08T01:59:59-08:00", after_dst: "2026-03-08T03:00:00-07:00", fall_back: "2026-11-01T01:30:00.500-07:00",
      tm: "13:45:00", id: "6f1b2c3d-0000-4000-8000-000000000001",
      ints: [1, 2, null], stamps: ["2025-12-31T16:00:00-08:00"], st: { k: 1, big: "9007199254740993", when: "2026-01-02" },
      feeling: "sad", ns: "2026-01-01T00:00:00.123456789",
    });
    // -0 is 0 in both modes, as JSON has no negative zero.
    expect(Object.is(row.neg_zero, 0)).toBe(true);
    // JSON columns are parsed; a "__proto__" key stays an own property in both modes.
    const doc = row.doc as Record<string, unknown>;
    expect(Object.hasOwn(doc, "__proto__")).toBe(true);
    expect(Object.hasOwn(served.rows[0]!.doc as object, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(doc.nested).toEqual({ a: [1, null, "x"] });
  });

  test("params and errors look the same in both modes", async () => {
    const p = await makeProject({ seed: GOLDEN_SEED });
    const m = serveFor(p);
    const sql = "SELECT $1::BIGINT AS a, $2::DATE AS b, $3::VARCHAR AS c";
    const params = [123, "2026-09-23", "x"];
    const direct = await run(sql, params, undefined, { cwd: p.root });
    const served = await run(sql, params, { url: m.url, token: "s3cret" }, {});
    expect(served.rows).toStrictEqual(direct.rows);
    for (const bad of ["DELETE FROM golden", "SELECT * FROM missing_table", "SELECT 1; SELECT 2"]) {
      const e1 = await rejection(run(bad, [], undefined, { cwd: p.root }));
      const e2 = await rejection(run(bad, [], { url: m.url, token: "s3cret" }, {}));
      expect(e2.code).toBe(e1.code);
      expect(e2.message).toBe(e1.message);
    }
  });
});

describe("QUERY_TOO_MANY_ROWS", () => {
  test("more than 10,000 rows by default, or more than { limit }, in both modes", async () => {
    const p = await makeProject({ seed: ["CREATE TABLE t AS SELECT range AS i FROM range(10001)"] });
    const m = serveFor(p);
    for (const via of [{ cwd: p.root, options: {} }, { cwd: "/", options: { url: m.url, token: "s3cret" } }]) {
      const e = await rejection(run("SELECT i FROM t", [], via.options, { cwd: via.cwd }));
      expect(e.code).toBe("QUERY_TOO_MANY_ROWS");
      expect(e.problem.details?.limit).toBe(10_000);
      const small = await rejection(run("SELECT i FROM t WHERE i < 11", [], { ...via.options, limit: 10 }, { cwd: via.cwd }));
      expect(small.code).toBe("QUERY_TOO_MANY_ROWS");
      expect((await run("SELECT i FROM t", [], { ...via.options, limit: 10_001 }, { cwd: via.cwd })).rows).toHaveLength(10_001);
      expect((await run("SELECT i FROM t WHERE i < 10", [], { ...via.options, limit: 10 }, { cwd: via.cwd })).rows).toHaveLength(10);
    }
  });
});

describe("the public query()", () => {
  test("reads process.env and process.cwd(); errors are Errors with a code", async () => {
    const p = await makeProject({ seed: ["CREATE TABLE t AS SELECT 7 AS a, 'x' AS b"] });
    const saved = { CROFT_PROJECT: process.env.CROFT_PROJECT, CROFT_URL: process.env.CROFT_URL };
    try {
      delete process.env.CROFT_URL;
      process.env.CROFT_PROJECT = p.root;
      const rows = await query<{ a: number; b: string }>("SELECT a, b FROM t WHERE a = $1", [7]);
      expect(rows).toEqual([{ a: 7, b: "x" }]);
      const e = await query("SELECT nope FROM t").catch((x: unknown) => x);
      expect(e).toBeInstanceOf(Error);
      expect((e as { code: string }).code).toBe("UNKNOWN_COLUMN");
      expect((e as { problem: { docs: string } }).problem.docs).toBe("croft docs UNKNOWN_COLUMN");
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
});

describe("loopback servers bypass HTTP_PROXY", () => {
  test("a child with HTTP_PROXY set reaches croft serve directly; the proxy sees nothing", async () => {
    const p = await makeProject({ seed: ["CREATE TABLE t AS SELECT 8 AS a"] });
    const m = serveFor(p, "never-for-the-proxy");
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
      const readTs = fileURLToPath(new URL("./read.ts", import.meta.url));
      const script = `
        const { query } = await import(${JSON.stringify(readTs)});
        const rows = await query("SELECT a FROM t");
        // Control: plain fetch in this same environment does go through the proxy.
        const control = await fetch(process.env.CROFT_URL + "/query", { method: "POST", body: "{}" }).then((r) => r.text(), (e) => "error " + e.message);
        console.log(JSON.stringify({ rows, control }));`;
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(no_proxy|http_proxy|https_proxy|all_proxy)$/i.test(k)) env[k] = v;
      Object.assign(env, { HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, CROFT_URL: m.url, CROFT_SERVE_TOKEN: "never-for-the-proxy" });
      const child = spawn(process.execPath, ["-e", script], { env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      const code = await new Promise((r) => child.on("exit", r));
      expect(err).toBe("");
      expect(code).toBe(0);
      const result = JSON.parse(out.trim());
      expect(result.rows).toEqual([{ a: 8 }]);
      expect(m.seen).toHaveLength(1);
      // The control request went to the proxy, and it is the only thing the proxy ever saw.
      expect(result.control).toBe("proxy");
      expect(proxied).toHaveLength(1);
      expect(proxied.join("\n")).not.toContain("never-for-the-proxy");
    } finally {
      await new Promise((r) => proxy.close(r));
    }
  });
});
