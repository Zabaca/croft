// scripts/build-read.ts and the built @zabaca/croft/read: it builds, its declarations match the source's
// public surface, and dist/read.js runs under Node in direct and server mode (DESIGN.md §2, §10 test 7).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { directQuery } from "./direct.ts";
import { cleanup, makeProject, type MockServe, mockServe, type TempProject } from "./testkit.ts";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = join(PKG, "dist");
// Inside the package (dist/ is git-ignored), so Node resolves "@zabaca/croft/read" by self-reference
// through package.json "exports", exactly as an app resolves it from node_modules.
const CHECK = join(DIST, `.check-${process.pid}`);
const NODE = Bun.which("node");

const mocks: MockServe[] = [];
let built: { code: number | null; out: string };

beforeAll(() => {
  const r = spawnSync(process.execPath, [join(PKG, "scripts", "build-read.ts")], { cwd: PKG, encoding: "utf8" });
  built = { code: r.status, out: `${r.stdout}${r.stderr}` };
  mkdirSync(CHECK, { recursive: true });
});

afterAll(async () => {
  for (const m of mocks) await m.stop();
  rmSync(CHECK, { recursive: true, force: true });
  cleanup();
});

describe("scripts/build-read.ts", () => {
  test("builds dist/read.js and dist/read.d.ts", () => {
    expect(built.out).toContain("built ");
    expect(built.code).toBe(0);
    expect(existsSync(join(DIST, "read.js"))).toBe(true);
    expect(existsSync(join(DIST, "read.d.ts"))).toBe(true);
  });

  test("package.json exports ./read to the built files and has a build:read script", () => {
    const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
    expect(pkg.exports["./read"]).toEqual({ types: "./dist/read.d.ts", default: "./dist/read.js" });
    expect(pkg.scripts["build:read"]).toContain("scripts/build-read.ts");
    expect(readFileSync(join(PKG, ".gitignore"), "utf8").split("\n")).toContain("dist/");
  });

  test("the bundle uses node: modules and @duckdb/node-api only, no Bun APIs", () => {
    const files = readdirSync(DIST).filter((f) => f === "read.js" || /^read-[a-z0-9]+\.js$/.test(f));
    expect(files.length).toBeGreaterThan(1); // the entry plus the lazily loaded direct-mode chunk
    const packages = new Set<string>();
    for (const f of files) {
      const js = readFileSync(join(DIST, f), "utf8");
      expect(js).not.toMatch(/\bBun\.[A-Za-z]/);
      expect(js).not.toMatch(/["']bun:/);
      for (const m of js.matchAll(/^import\b[^;]*?from\s*["']([^"']+)["']/gm)) {
        const s = m[1]!;
        if (s.startsWith("./")) expect(files).toContain(s.slice(2));
        else if (!s.startsWith("node:")) packages.add(s);
      }
    }
    expect([...packages]).toEqual(["@duckdb/node-api"]);
    const entry = readFileSync(join(DIST, "read.js"), "utf8");
    expect(entry).toMatch(/export\s*\{\s*query\s*\}/);
    // The entry never loads the native binding: server-only apps must not need it.
    expect(entry).not.toContain("@duckdb/node-api");
    expect(entry).toMatch(/await import\("\.\/read-[a-z0-9]+\.js"\)/);
  });

  // The same consumer must compile against dist/read.d.ts (by package name) and against src/read.ts.
  const CONSUMER = (from: string) => `import { query, type ReadError, type ReadOptions } from "${from}";
const options: ReadOptions = { project: "/p", url: "http://127.0.0.1:7447", token: "t", limit: 10, timeoutMs: 5000 };
export async function demo(): Promise<string> {
  const typed: { day: string; revenue: string }[] = await query<{ day: string; revenue: string }>("SELECT 1", ["x"], options);
  const loose = await query("SELECT 1");
  const cell: unknown = loose[0]?.anything;
  try {
    await query("SELECT 1", undefined, {});
  } catch (e) {
    const err = e as ReadError;
    const code: string = err.code;
    const retry: boolean | undefined = err.problem.retryable;
    return code + String(retry) + String(cell) + typed.length;
  }
  // @ts-expect-error params must be an array
  await query("SELECT 1", "x");
  // @ts-expect-error unknown option
  await query("SELECT 1", [], { limt: 5 });
  return "";
}
`;

  function tsc(file: string, extra: string[]): { code: number | null; out: string } {
    const bin = join(PKG, "node_modules", ".bin", "tsc");
    const r = spawnSync(bin, ["--noEmit", "--strict", "--target", "es2022", "--skipLibCheck", ...extra, file], { cwd: CHECK, encoding: "utf8" });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  }

  test("a consumer typechecks against dist/read.d.ts through the package's exports", () => {
    const file = join(CHECK, "consumer.ts");
    writeFileSync(file, CONSUMER("@zabaca/croft/read"));
    // No ambient types at all (an empty typeRoots, ES lib only): the declarations must stand on their own,
    // as in an app that has neither Bun's nor Node's types installed.
    const noTypes = join(CHECK, "no-types");
    mkdirSync(noTypes, { recursive: true });
    const r = tsc(file, ["--module", "nodenext", "--moduleResolution", "nodenext", "--lib", "es2022", "--typeRoots", noTypes]);
    expect(r.out).toBe("");
    expect(r.code).toBe(0);
  }, 60_000);

  test("the same consumer typechecks against src/read.ts (the declarations match the source)", () => {
    const file = join(CHECK, "consumer-src.ts");
    writeFileSync(file, CONSUMER("../../src/read.ts"));
    const r = tsc(file, ["--module", "esnext", "--moduleResolution", "bundler", "--allowImportingTsExtensions", "--resolveJsonModule", "--types", "bun"]);
    expect(r.out).toBe("");
    expect(r.code).toBe(0);
  }, 60_000);
});

// ---- Node ------------------------------------------------------------------------------------------------

const FIXTURE = `import { query } from "@zabaca/croft/read";
const out = {};
const code = async (p) => p.then(() => "no error", (e) => (e instanceof Error ? e.code : "not an Error"));
out.direct = await query("SELECT * FROM golden");
out.server = await query("SELECT * FROM golden", [], { url: process.env.SERVE_URL, token: process.env.SERVE_TOKEN });
out.params = await query("SELECT $1::BIGINT + 1 AS n, $2::DATE AS d", [41, "2026-09-23"]);
out.tooManyDirect = await code(query("SELECT * FROM range(3)", [], { limit: 2 }));
out.tooManyServer = await code(query("SELECT * FROM range(3)", [], { limit: 2, url: process.env.SERVE_URL, token: process.env.SERVE_TOKEN }));
out.unavailable = await code(query("SELECT 1", [], { url: "http://127.0.0.1:" + process.env.DEAD_PORT, timeoutMs: 200 }));
out.notSelect = await code(query("DROP TABLE golden"));
console.log(JSON.stringify(out));
`;

/** Run a script under Node without blocking this process (the mock croft serve answers from here). */
function runNode(script: string, env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(NODE!, [script], { cwd: CHECK, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  return new Promise((resolve) => child.on("exit", (status) => resolve({ status, stdout, stderr })));
}

const GOLDEN = [`CREATE TABLE golden AS SELECT 9007199254740993::BIGINT AS big, 12.50::DECIMAL(10,2) AS dec,
  TIMESTAMPTZ '2026-03-08 10:00:00Z' AS at_dst, DATE '2026-01-02' AS d, '{"a": [1, 2]}'::JSON AS doc, 'é🌍' AS txt,
  [1, 2]::INTEGER[] AS xs, {'k': 170141183460469231731687303715884105727::HUGEINT} AS st`];

describe.skipIf(!NODE)(`dist/read.js under Node (${NODE ?? "node not installed: skipped"})`, () => {
  let p: TempProject;
  let serve: MockServe;
  let proxy: Server;
  const proxied: string[] = [];

  beforeAll(async () => {
    p = await makeProject({ seed: GOLDEN });
    serve = mockServe({ token: "node-token", run: (b) => directQuery(p.project, { sql: b.sql, params: b.params ?? [], limit: b.limit ?? 10_000 }) });
    mocks.push(serve);
    proxy = createServer((r, res) => {
      proxied.push(`${r.method} ${r.url}`);
      res.writeHead(502).end();
    });
    proxy.on("connect", (r, sock) => {
      proxied.push(`CONNECT ${r.url}`);
      sock.end("HTTP/1.1 502 no\r\n\r\n");
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  });

  afterAll(async () => {
    await new Promise((r) => proxy.close(r));
  });

  test("direct and server mode, errors with codes, and HTTP_PROXY bypassed for loopback", async () => {
    const script = join(CHECK, "fixture.mjs");
    writeFileSync(script, FIXTURE);
    const deadPort = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const port = (s.address() as { port: number }).port;
        s.close(() => resolve(port));
      });
    });
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(no_proxy|http_proxy|https_proxy|all_proxy|CROFT_.*)$/i.test(k)) env[k] = v;
    Object.assign(env, {
      CROFT_PROJECT: p.root, SERVE_URL: serve.url, SERVE_TOKEN: "node-token", DEAD_PORT: String(deadPort),
      HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, NODE_USE_ENV_PROXY: "1",
    });
    const r = await runNode(script, env);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout.trim());

    // Node renders exactly what Bun renders in-process, in both modes.
    const expected = await directQuery(p.project, { sql: "SELECT * FROM golden", params: [], limit: 10_000 });
    expect(result.direct).toEqual(expected);
    expect(result.server).toEqual(expected);
    expect(result.direct[0]).toMatchObject({ big: "9007199254740993", dec: "12.50", at_dst: "2026-03-08T03:00:00-07:00", st: { k: "170141183460469231731687303715884105727" } });
    expect(result.params).toEqual([{ n: 42, d: "2026-09-23" }]);
    expect(result.tooManyDirect).toBe("QUERY_TOO_MANY_ROWS");
    expect(result.tooManyServer).toBe("QUERY_TOO_MANY_ROWS");
    expect(result.unavailable).toBe("SERVE_UNAVAILABLE");
    expect(result.notSelect).toBe("QUERY_NOT_SELECT");
    // Two server-mode queries reached the mock directly; the proxy saw nothing at all.
    expect(serve.seen.map((s) => s.headers.authorization)).toEqual(["Bearer node-token", "Bearer node-token"]);
    expect(proxied).toEqual([]);
  }, 60_000);

  test("a server-only app never loads @duckdb/node-api", async () => {
    // Node's module hooks make the binding unloadable, as on a host where it is missing or broken.
    const script = join(CHECK, "server-only.mjs");
    writeFileSync(script, `import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@duckdb/node-api") throw new Error("the DuckDB binding must not load here");
    return next(specifier, context);
  },
});
const { query } = await import("@zabaca/croft/read");
const rows = await query("SELECT * FROM golden", [], { url: process.env.SERVE_URL, token: process.env.SERVE_TOKEN });
const direct = await query("SELECT 1").then(() => "loaded", (e) => e.message);
console.log(JSON.stringify({ rows: rows.length, direct }));
`);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^CROFT_/.test(k)) env[k] = v;
    Object.assign(env, { CROFT_PROJECT: p.root, SERVE_URL: serve.url, SERVE_TOKEN: "node-token" });
    // Asynchronously: the mock croft serve lives in this process and must keep answering.
    const r = await runNode(script, env);
    if (/does not provide an export named 'registerHooks'/.test(r.stderr)) {
      console.warn(`skipped: ${NODE} has no module.registerHooks (needs Node >= 22.15 or 23.5)`);
      return;
    }
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    // Server mode worked without the binding; direct mode tried to load it only when asked.
    expect(JSON.parse(r.stdout.trim())).toEqual({ rows: 1, direct: "the DuckDB binding must not load here" });
  }, 60_000);
});
