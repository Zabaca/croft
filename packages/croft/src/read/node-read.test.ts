// @zabaca/croft/read under real Node (DESIGN.md §10 test strategy, item 7; §5 "@zabaca/croft/read"), against real
// processes: the built bundle (scripts/build-read.ts → read.js + its direct-mode chunk, as build.test.ts builds it)
// runs in a Node app script, and croft serve runs in its own process (`croft serve --port 0 --json`).
//   - HTTP: the right token, a wrong one (SERVE_UNAUTHORIZED, never retried), the serve.json route, a 503 with
//     Retry-After retried until it succeeds, SERVE_UNAVAILABLE once the client's timeout has passed, and loopback
//     requests that never reach HTTP_PROXY;
//   - direct mode, with no server;
//   - a golden test: the same queries give identical rows in both modes, in Node and in Bun.
// Skipped when no real Node is installed (src/node-testkit.ts). Slow suite (real processes, ~5 s): it runs in the
// whole `bun test`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { realNode } from "../node-testkit.ts";
import { query } from "../read.ts";
import { cleanup, makeProject, type TempProject } from "./testkit.ts";
import { GRACE_MS, killChildren, probeWriter, type Serve, SLACK, startServe, stopServes, until, writerTimes } from "../../tests/concurrency/cc-testkit.ts";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Inside the package, so the direct-mode chunk resolves @duckdb/node-api from the package's node_modules, as an
// app's copy resolves it from its own. A private folder: build.test.ts builds dist/ itself.
const OUT = join(PKG, "dist", `.node-read-${process.pid}`);
const NODE = realNode();

// Rich values: integers past 2^53, DECIMAL, a timestamp on a DST day, JSON, text past the BMP, lists, a HUGEINT in a
// struct, -0, NULL and a naive timestamp.
const GOLDEN = `CREATE TABLE golden AS SELECT 9007199254740993::BIGINT AS big, 12.50::DECIMAL(10,2) AS dec,
  TIMESTAMPTZ '2026-03-08 10:00:00.123456Z' AS at_dst, DATE '2026-01-02' AS d, '{"a": [1, 2]}'::JSON AS doc, 'é🌍' AS txt,
  [1, 2]::INTEGER[] AS xs, {'k': 170141183460469231731687303715884105727::HUGEINT} AS st, -0.0::DOUBLE AS negz,
  NULL::VARCHAR AS nothing, TIMESTAMP '2026-11-01 01:30:00' AS naive, 1.5::DOUBLE AS dbl, true AS flag`;
const BIG = "CREATE TABLE big AS SELECT range AS n FROM range(5000)";
// A table the long queries cross-join three times (1.25e11 rows: hours, unless interrupted). The writer replaces it
// with one row, so the same query is instant once it is retried after the write.
const SHRINKS = "CREATE TABLE shrinks AS SELECT range AS n FROM range(5000)";
const LONG = "SELECT count(*) AS c, sum(a.n + b.n + c.n) AS s FROM shrinks a, shrinks b, shrinks c";

const GOLDEN_STEPS = [
  { name: "golden", sql: "SELECT * FROM golden" },
  { name: "params", sql: "SELECT $1::BIGINT + 1 AS n, $2::DATE AS d, $3::HUGEINT + 1 AS h", params: [41, "2026-09-23", { $bigint: "170141183460469231731687303715884105726" }] },
  { name: "agg", sql: "SELECT count(*) AS n, min(n) AS lo, max(n) AS hi FROM big" },
];

// The app: one plan of query() calls, sequential or in parallel; each result is its rows or its error's code.
const APP = `import { query } from "./read.js";
const plan = JSON.parse(process.argv[2]);
const revive = (v) => (v && typeof v === "object" && "$bigint" in v ? BigInt(v.$bigint) : v);
const run = async (s) => {
  const t0 = Date.now();
  try {
    const rows = await query(s.sql, (s.params ?? []).map(revive), s.options ?? {});
    return { rows, ms: Date.now() - t0 };
  } catch (e) {
    return { code: e?.code ?? String(e), message: e?.message, retryable: e?.problem?.retryable ?? null, details: e?.problem?.details ?? null, ms: Date.now() - t0 };
  }
};
const out = {};
if (plan.parallel) {
  const results = await Promise.all(plan.steps.map(run));
  plan.steps.forEach((s, i) => (out[s.name] = results[i]));
} else {
  for (const s of plan.steps) out[s.name] = await run(s);
}
console.log(JSON.stringify(out));
`;

interface Step { name: string; sql: string; params?: unknown[]; options?: Record<string, unknown> }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Outcome = { rows?: any[]; code?: string; message?: string; retryable?: boolean | null; details?: any; ms: number };

let built: { code: number | null; out: string };
let p: TempProject;
let s: Serve;
let proxy: Server;
const proxied: string[] = [];

beforeAll(async () => {
  if (!NODE) return;
  mkdirSync(OUT, { recursive: true });
  const r = spawnSync(process.execPath, [join(PKG, "scripts", "build-read.ts"), "--outdir", OUT], { cwd: PKG, encoding: "utf8" });
  built = { code: r.status, out: `${r.stdout}${r.stderr}` };
  writeFileSync(join(OUT, "app.mjs"), APP);
  p = await makeProject({ seed: [GOLDEN, BIG, SHRINKS] });
  s = await startServe(p);
  // A proxy that records whatever reaches it and answers 502: a loopback request must never get here.
  proxy = createServer((req, res) => {
    proxied.push(`${req.method} ${req.url}`);
    res.writeHead(502).end();
  });
  proxy.on("connect", (req, sock) => {
    proxied.push(`CONNECT ${req.url}`);
    sock.end("HTTP/1.1 502 no\r\n\r\n");
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
}, 60_000);

afterAll(async () => {
  await stopServes();
  killChildren();
  if (proxy) await new Promise((r) => proxy.close(r));
  rmSync(OUT, { recursive: true, force: true });
  cleanup();
});

/** Run the app under Node without blocking this process. `env` adds to a clean environment (no CROFT_*, no proxy). */
function node(plan: { steps: Step[]; parallel?: boolean }, env: Record<string, string> = {}): Promise<Record<string, Outcome>> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(no_proxy|http_proxy|https_proxy|all_proxy|CROFT_.*|NODE_USE_ENV_PROXY)$/i.test(k)) base[k] = v;
  }
  const child = spawn(NODE!, [join(OUT, "app.mjs"), JSON.stringify(plan)], { cwd: OUT, env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  return new Promise((resolve, reject) => child.on("exit", (code) => {
    if (code !== 0 || stderr.trim() !== "") reject(new Error(`node exited ${code}\nstdout: ${stdout}\nstderr: ${stderr}`));
    else resolve(JSON.parse(stdout.trim()) as Record<string, Outcome>);
  }));
}

const proxyEnv = (): Record<string, string> => {
  const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  return { HTTP_PROXY: url, http_proxy: url, HTTPS_PROXY: url, https_proxy: url, ALL_PROXY: url, NODE_USE_ENV_PROXY: "1" };
};

describe.skipIf(!NODE)(`@zabaca/croft/read under Node (${NODE ?? "no node: skipped"}) against a real croft serve (slow: real processes)`, () => {
  test("the bundle builds", () => {
    expect(built.out).toContain("built ");
    expect(built.code).toBe(0);
  });

  test("the right token answers, a wrong one is SERVE_UNAUTHORIZED at once, serve.json is found; HTTP_PROXY never sees a request", async () => {
    const before = (await s.engine()).queriesToday;
    const out = await node({
      steps: [
        { name: "explicit", sql: "SELECT count(*) AS n FROM big", options: { url: s.url, token: s.token } },
        { name: "wrong", sql: "SELECT count(*) AS n FROM big", options: { url: s.url, token: "not-the-token" } },
        { name: "viaServeJson", sql: "SELECT count(*) AS n FROM big" },
      ],
    }, { CROFT_PROJECT: p.root, ...proxyEnv() });
    // CROFT_URL and CROFT_SERVE_TOKEN from the environment, as a hosted app sets them.
    const hosted = await node({ steps: [{ name: "env", sql: "SELECT count(*) AS n FROM big" }] },
      { CROFT_URL: s.url, CROFT_SERVE_TOKEN: s.token, ...proxyEnv() });
    expect(out.explicit).toMatchObject({ rows: [{ n: 5000 }] });
    expect(out.wrong).toMatchObject({ code: "SERVE_UNAUTHORIZED", retryable: false, details: { status: 401 } });
    expect(out.wrong!.ms).toBeLessThan(2000); // never retried
    expect(out.viaServeJson).toMatchObject({ rows: [{ n: 5000 }] });
    expect(hosted.env).toMatchObject({ rows: [{ n: 5000 }] });
    // Three queries reached the server (the rejected one never ran), none went through the proxy.
    expect((await s.engine()).queriesToday - before).toBe(3);
    expect(proxied).toEqual([]);
  }, 30_000);

  test("a 503 with Retry-After is retried until the query succeeds; a client whose timeout passed gets SERVE_UNAVAILABLE", async () => {
    const answer = node({
      parallel: true,
      steps: [
        { name: "patient", sql: LONG, options: { url: s.url, token: s.token, timeoutMs: 15_000 } },
        { name: "hasty", sql: LONG, options: { url: s.url, token: s.token, timeoutMs: 1000 } },
      ],
    }, proxyEnv());
    await until(async () => (await s.engine()).inFlight === 2, 10_000, 10);
    // The writer: both queries run for the 2 s grace, then are interrupted with 503 + Retry-After. It shrinks the
    // table they read to one row.
    const w = probeWriter({ database: p.database, stateDir: p.stateDir }, "r_node", 300, {
      sql: ["CREATE OR REPLACE TABLE shrinks AS SELECT 7 AS n"],
    });
    const t = await writerTimes(w);
    expect(t.latency).toBeLessThanOrEqual(GRACE_MS + 250 + SLACK);
    const out = await answer;
    // The patient client waited out the write (Retry-After) and got the answer of the same query after it: the
    // first attempt could not have seen the shrunk table.
    expect(out.patient).toMatchObject({ rows: [{ c: 1, s: "21" }] });
    expect(out.patient!.ms).toBeGreaterThanOrEqual(GRACE_MS - 100);
    // The hasty one was past its 1 s when the 503 came: SERVE_UNAVAILABLE, busy, retryable, never a fallback.
    expect(out.hasty).toMatchObject({ code: "SERVE_UNAVAILABLE", retryable: true, details: { reason: "busy", status: 503, retryAfter: "1" } });
    expect(out.hasty!.message).toContain("never falls back");
    expect(out.hasty!.ms).toBeLessThan(out.patient!.ms);
    expect(proxied).toEqual([]);
  }, 60_000);

  test("golden: the same queries give identical rows through croft serve and in direct mode, in Node and in Bun", async () => {
    const server = await node({ steps: GOLDEN_STEPS.map((x) => ({ ...x, options: { url: s.url, token: s.token } })) }, proxyEnv());
    // Direct mode: no croft serve any more (stopping it removes serve.json).
    await s.stop();
    const direct = await node({ steps: GOLDEN_STEPS }, { CROFT_PROJECT: p.root });
    const bun: Record<string, unknown[]> = {};
    for (const x of GOLDEN_STEPS) {
      const params = (x.params ?? []).map((v) => (v && typeof v === "object" && "$bigint" in v ? BigInt((v as { $bigint: string }).$bigint) : v));
      bun[x.name] = await query(x.sql, params, { project: p.root });
    }
    for (const x of GOLDEN_STEPS) {
      expect(server[x.name]!.code, JSON.stringify(server[x.name])).toBeUndefined();
      expect(direct[x.name]!.code, JSON.stringify(direct[x.name])).toBeUndefined();
      expect(direct[x.name]!.rows, x.name).toEqual(server[x.name]!.rows!);
      expect(bun[x.name], x.name).toEqual(server[x.name]!.rows!);
    }
    // The §4.3 rendering, pinned: strings past ±2^53, DECIMAL and HUGEINT; the project offset; -0 as 0.
    expect(server.golden!.rows).toEqual([{
      big: "9007199254740993", dec: "12.50", at_dst: "2026-03-08T03:00:00.123456-07:00", d: "2026-01-02", doc: { a: [1, 2] }, txt: "é🌍",
      xs: [1, 2], st: { k: "170141183460469231731687303715884105727" }, negz: 0, nothing: null, naive: "2026-11-01T01:30:00", dbl: 1.5, flag: true,
    }]);
    expect(server.params!.rows).toEqual([{ n: 42, d: "2026-09-23", h: "170141183460469231731687303715884105727" }]);
    expect(server.agg!.rows).toEqual([{ n: 5000, lo: 0, hi: 4999 }]);
    // Direct mode turns -0 into 0 itself, so its rows equal their JSON round trip.
    expect(Object.is((bun.golden![0] as { negz: number }).negz, 0)).toBe(true);
  }, 60_000);
});
