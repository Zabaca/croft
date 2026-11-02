// A person's DuckDB over Quack (DESIGN.md D125 to D127; option 06, slice 4), against the real thing: croft serve's readers' engine
// with its Quack listener, and a DuckDB 2.0 client in a process of its own (serve/quack-client-testkit.ts). Everything that starts is
// a child of the test, killed in teardown. The attack list (sql/attack-testkit.ts) is sent over Quack in quack-attacks.test.ts, and
// the pinned quack build's catalog texts are held in quack-catalog.test.ts.
import { afterAll, describe, expect } from "bun:test";
import { closeAllWarehouses } from "../db/warehouse.ts";
import { cleanup, spawnWriter } from "../read/testkit.ts";
import { ALLOWED, SHARED, WAREHOUSE_SQL } from "../sql/attack-testkit.ts";
import { KeyStore } from "./keys.ts";
import type { QuackEvent } from "./quack-access.ts";
import { freePort, QuackClients, raw } from "./quack-client-testkit.ts";
import { ask, count, extensionFiles, openEngine, project, rejection, replaceCopy, until } from "./readers-testkit.ts";
import type { ServeEngine } from "./types.ts";

const CI = process.env.CROFT_CI === "1";
const { ext, withExt } = extensionFiles("quack.test");
const engines: ServeEngine[] = [];
const clients = new QuackClients();
afterAll(async () => {
  clients.close();
  for (const e of engines) await e.close().catch(() => {});
  await closeAllWarehouses();
  cleanup();
});

/** A server-mode project with the attack list's warehouse (orders and customers shared; payments and secrets not), its engine, and a key store. */
async function rig(o: { engine?: Parameters<typeof openEngine>[3]; shared?: readonly string[]; asOf?: string; port?: number } = {}) {
  const p = await project({
    n: 20, also: WAREHOUSE_SQL.filter((s) => !s.startsWith("CREATE TABLE orders")), asOf: o.asOf ?? "2026-10-30T10:00:00Z",
    config: { serve: { sharedTables: [...(o.shared ?? SHARED)] } },
  });
  const events: QuackEvent[] = [];
  const e = await openEngine(engines, ext.dir, p, {
    onQuack: (x) => events.push(x),
    ...(o.port ? { quack: { host: "127.0.0.1", port: o.port } } : {}),
    ...o.engine,
  });
  const keys = new KeyStore(p.stateDir);
  /** The address the listener is bound to now (a replacement process after a kill may pick another when the port is 0). */
  const uri = () => e.status().serverMode!.quack!.uri;
  /** A key made now, which the readers' process has been told of (the engine reads the keys file every poll). */
  const key = async (name: string) => {
    const made = keys.add(name).key;
    await Bun.sleep(150);
    return made;
  };
  return { p, e, keys, uri, events, key };
}

/** The DuckDB 2.0 client of a person who attached `as` r with `key`. */
async function person(r: Awaited<ReturnType<typeof rig>>, key: string, as = "r") {
  const c = await clients.start(ext.dir);
  const a = await c.attach(r.uri(), key, as);
  if (!a.ok) throw new Error(`attach failed: ${a.error}`);
  return c;
}

describe("signing in and reading", () => {
  withExt("a DuckDB 2.0 attaches with a key and reads a shared table by its plain name, with filters and aggregates pushed down", async () => {
    const r = await rig();
    const c = await person(r, await r.key("alice"));
    expect(await c.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: "20" }]);
    expect(await c.rows("SELECT k, count(*) AS n FROM r.orders WHERE id > 12 GROUP BY k ORDER BY k")).toEqual(
      [0, 1, 2, 3, 4, 5, 6].map((k) => ({ k: String(k), n: "1" })));
    expect(await c.rows("SELECT count(*) AS n FROM r.orders o JOIN r.customers c ON o.id = c.id")).toEqual([{ n: "5" }]);
    // It joins with the client's own tables, which never reach the server.
    await c.run("CREATE TABLE mine AS SELECT 3 AS id");
    expect(await c.rows("SELECT o.k FROM r.orders o JOIN mine USING (id)")).toEqual([{ k: "3" }]);
    expect(await c.rows("DESCRIBE r.orders")).toMatchObject([{ column_name: "id" }, { column_name: "k" }]);
  }, 60_000);

  withExt("it works while a croft write is in progress, from a client that dials 127.0.0.1 or localhost", async () => {
    const r = await rig();
    const alice = await r.key("alice");
    const writer = spawnWriter(r.p, "w1", 5000);
    await writer.waitFor("acquired");
    const started = performance.now();
    for (const host of ["127.0.0.1", "localhost"]) {
      const c = await clients.start(ext.dir);
      const uri = r.uri().replace("127.0.0.1", host);
      expect((await c.attach(uri, alice)).ok, host).toBe(true);
      for (let i = 0; i < 10; i++) expect(await c.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: "20" }]);
    }
    expect(performance.now() - started).toBeLessThan(4000); // the writer still held the file
    await writer.waitFor("released", 20_000);
    expect(r.e.status().serverMode).toMatchObject({ restarts: 0 });
  }, 60_000);

  withExt("the queries a person needs all work", async () => {
    const r = await rig();
    const alice = await r.key("alice");
    const c = await clients.start(ext.dir);
    for (const q of ALLOWED) {
      const a = await raw(c, r.uri(), alice, q.sql);
      expect(a.ok, `${q.label}: ${q.sql} -> ${a.ok ? "" : a.error}`).toBe(true);
    }
  }, 60_000);

  withExt("the client's table list shows the main schema, the shared tables and the as-of view, all views; croft's schema never appears", async () => {
    const r = await rig();
    const c = await person(r, await r.key("alice"));
    expect(await c.rows("SELECT schema_name FROM duckdb_schemas() WHERE database_name = 'r' ORDER BY 1")).toEqual([{ schema_name: "main" }]);
    expect(await c.rows("SELECT view_name FROM duckdb_views() WHERE database_name = 'r' ORDER BY 1")).toEqual([{ view_name: "_croft_as_of" }, { view_name: "customers" }, { view_name: "orders" }]);
    expect(await c.rows("SELECT table_name FROM duckdb_tables() WHERE database_name = 'r'")).toEqual([]);
    expect(await c.rows("SHOW TABLES FROM r")).toEqual([{ name: "_croft_as_of" }, { name: "customers" }, { name: "orders" }]);
    // DuckDB's list of all tables comes back empty for them, because they are views (the docs say so).
    expect(await c.rows("SELECT name FROM (SHOW ALL TABLES) WHERE database = 'r'")).toEqual([]);
    for (const name of ["payments", "secrets", "_croft.assets"]) expect((await c.run(`SELECT * FROM r.${name}`)).ok, name).toBe(false);
    expect(JSON.stringify(await c.rows("SELECT * FROM duckdb_schemas() WHERE database_name = 'r'"))).not.toContain("_croft");
  }, 60_000);

  withExt("the as-of view holds the copy's as-of time, and after a refresh and a swap the new one, with the session kept", async () => {
    const r = await rig({ asOf: "2026-10-30T10:00:00Z" });
    const c = await person(r, await r.key("alice"));
    // The client shows the instant in its own time zone, so it is compared as an instant.
    expect(await c.rows("SELECT epoch_ms(as_of)::VARCHAR AS t, count(*) OVER () AS n FROM r._croft_as_of")).toEqual([{ t: String(Date.parse("2026-10-30T10:00:00Z")), n: "1" }]);
    expect(r.e.status().serverMode!.asOf).toBe("2026-10-30T03:00:00-07:00");
    await replaceCopy(r.p, 31, "2026-10-30T11:00:00Z");
    await until("the swap", () => (r.e.status().serverMode?.swaps ?? 0) === 1);
    expect(await c.rows("SELECT epoch_ms(as_of)::VARCHAR AS t FROM r._croft_as_of")).toEqual([{ t: String(Date.parse("2026-10-30T11:00:00Z")) }]);
    expect(await c.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: "31" }]);
    expect(r.e.status().serverMode).toMatchObject({ restarts: 0, swaps: 1 });
  }, 60_000);
});

describe("keys", () => {
  withExt("a wrong key, a removed key, a key that was never made and the app token are refused at sign-in: Authentication failed", async () => {
    const r = await rig();
    const alice = await r.key("alice");
    const bob = await r.key("bob");
    r.keys.remove("bob");
    await Bun.sleep(150);
    const c = await clients.start(ext.dir);
    for (const token of [`croftkey_${"A".repeat(43)}`, bob, "app-token-for-tests", "abcd", `${alice}x`, alice.toUpperCase()]) {
      const a = await c.attach(r.uri(), token, "x");
      expect(a.ok, token).toBe(false);
      expect(a.ok ? "" : a.error, token).toContain("Authentication failed");
    }
    expect((await c.attach(r.uri(), alice, "ok")).ok).toBe(true);
  }, 60_000);

  withExt("a key removed while its session is open is refused on that session's next query, within a second; other people's sessions are not affected", async () => {
    const r = await rig();
    const a = await person(r, await r.key("alice"));
    const b = await person(r, await r.key("bob"));
    const carols = await person(r, await r.key("carol"));
    for (const c of [a, b, carols]) expect(await c.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: "20" }]);
    const removedAt = performance.now();
    r.keys.remove("alice");
    let refused = "";
    while (!refused) {
      const x = await a.run("SELECT count(*) AS n FROM r.orders");
      if (!x.ok) refused = x.error;
      else if (performance.now() - removedAt > 5000) throw new Error("the removed key still reads");
      else await Bun.sleep(25);
    }
    expect(performance.now() - removedAt).toBeLessThan(1000);
    expect(refused).toContain("alice was removed");
    // It stays refused, for everything, and it cannot sign in again.
    for (const sql of ["SELECT count(*) FROM r.orders", "SELECT * FROM r._croft_as_of", "SELECT * FROM r.customers"]) expect((await a.run(sql)).ok, sql).toBe(false);
    // The other sessions read on.
    expect(await b.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: "20" }]);
    expect(await carols.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: "20" }]);
  }, 60_000);

  withExt("a key made after croft serve started signs in within a poll, and each sign-in and query is told to the command", async () => {
    const r = await rig();
    const alice = await r.key("alice");
    const c = await person(r, alice);
    await c.rows("SELECT o.id FROM r.orders o JOIN r.customers c ON o.id = c.id WHERE o.id < 3");
    await c.run("SELECT * FROM quack_query('" + r.uri() + "', 'SELECT * FROM payments', token = '" + alice + "')");
    expect(r.events[0]).toMatchObject({ kind: "signin", key: "alice" });
    const queries = r.events.filter((e): e is Extract<QuackEvent, { kind: "query" }> => e.kind === "query");
    expect(queries.some((q) => q.outcome === "ok" && q.tables.join() === "orders,customers")).toBe(true);
    expect(queries.some((q) => q.outcome === "QUERY_PATH_DENIED" && q.tables.length === 0)).toBe(true);
    for (const e of r.events) {
      expect(JSON.stringify(e)).not.toContain(alice);
      expect(e).toMatchObject({ key: "alice" });
    }
  }, 60_000);

  withExt("when the project shares no table, a key attaches to nothing: the refusal names the setting", async () => {
    const r = await rig({ shared: [] });
    const c = await clients.start(ext.dir);
    const a = await c.attach(r.uri(), await r.key("erin"));
    expect(a.ok).toBe(false);
    expect(a.ok ? "" : a.error).toContain("sharedTables");
    expect(a.ok ? "" : a.error).toContain("SERVE_NO_SHARED_TABLES");
  }, 60_000);
});

describe("the listener", () => {
  withExt("every sign-in and query is attributed to the key's name in the events, and none carries the SQL", async () => {
    const r = await rig();
    const alice = await r.key("alice");
    const c = await clients.start(ext.dir);
    await raw(c, r.uri(), alice, "SELECT 'a-secret-literal' AS s FROM orders LIMIT 1");
    const text = JSON.stringify(r.events);
    expect(text).toContain("alice");
    expect(text).not.toContain("a-secret-literal");
    expect(text).not.toContain(alice);
  }, 60_000);

  withExt("an address that is not this machine's or a port in use is QUACK_LISTEN_FAILED, and croft serve does not start", async () => {
    const p = await project({ n: 5 });
    const taken = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      const e = await rejection(openEngine(engines, ext.dir, p, { quack: { host: "127.0.0.1", port: taken.port } }));
      expect(e.code).toBe("QUACK_LISTEN_FAILED");
      expect(e.problem.message).toContain(`127.0.0.1:${taken.port}`);
      expect(e.problem.hint).toContain("quackPort");
    } finally {
      taken.stop(true);
    }
  }, 60_000);

  withExt("an address other than loopback is allowed to listen (Quack's override), and a client dials it", async () => {
    const r = await rig({ engine: { quack: { host: "0.0.0.0", port: 0 } } });
    expect(r.uri()).toMatch(/^quack:0\.0\.0\.0:\d+$/);
    const alice = await r.key("alice");
    const c = await clients.start(ext.dir);
    expect((await c.attach(r.uri().replace("0.0.0.0", "127.0.0.1"), alice)).ok).toBe(true);
    expect(await c.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: "20" }]);
  }, 60_000);

  withExt("the HTTP API goes on beside it: the app token reads every table, and a key reads the shared ones", async () => {
    const r = await rig();
    expect(await count(r.e, "payments")).toBe(8);
    const a = await r.e.query({ sql: "SELECT count(*) AS n FROM orders", params: [], limit: 10, scope: { key: "alice", tables: [...SHARED] } });
    expect(a.rows).toEqual([{ n: 20 }]);
  }, 60_000);
});

describe("the time limit", () => {
  withExt("a Quack query past serve.queryTimeoutMs ends the readers' process; the client attaches again and reads; HTTP carries on", async () => {
    const port = freePort();
    const overdue: number[] = [];
    const r = await rig({ port, engine: { queryTimeoutMs: 1500, hooks: { quackOverdue: (x) => overdue.push(x.ms) } } });
    const alice = await r.key("alice");
    const c = await person(r, alice);
    const first = r.e.status().serverMode!.workerPid!;
    expect(await c.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: "20" }]);
    const started = performance.now();
    const long = await c.run("SELECT count(*) FROM r.orders a, r.orders b, range(300000000) c WHERE (a.id + b.id + c.range) % 7 = 3");
    expect(long.ok).toBe(false); // an error, never a wrong answer
    expect(performance.now() - started).toBeLessThan(1500 + 1500 + (CI ? 2000 : 0));
    expect(overdue).toHaveLength(1);
    expect(overdue[0]).toBeGreaterThanOrEqual(1500);
    await until("the old process to exit", () => r.e.status().serverMode?.workerPid !== first);
    await until("the replacement to open", () => r.e.status().serverMode?.state === "open", 20_000);
    expect(r.e.status().serverMode).toMatchObject({ restarts: 1 });
    expect(r.uri()).toBe(`quack:127.0.0.1:${port}`); // the same address
    // Every session on the old process is gone: queries fail until the client attaches again, and then it reads.
    const stale = await c.run("SELECT count(*) AS n FROM r.orders");
    expect(stale.ok).toBe(false);
    expect((await c.run("DETACH r")).ok).toBe(true);
    const reattached = performance.now();
    expect((await c.attach(r.uri(), alice)).ok).toBe(true);
    expect(await c.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: "20" }]);
    expect(performance.now() - reattached).toBeLessThan(1000);
    expect(await count(r.e)).toBe(20);
  }, 90_000);

  withExt("a readers' process killed from outside drops every session: each query fails (never a wrong answer) until the client attaches again", async () => {
    const port = freePort();
    const r = await rig({ port });
    const alice = await r.key("alice");
    const a = await person(r, alice);
    const b = await person(r, alice);
    for (const c of [a, b]) expect(await c.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: "20" }]);
    process.kill(r.e.status().serverMode!.workerPid!, "SIGKILL");
    // While the replacement starts, and after it is up, the old sessions get an error on every query.
    for (let i = 0; i < 5; i++) for (const c of [a, b]) expect((await c.run("SELECT count(*) AS n FROM r.orders")).ok).toBe(false);
    await until("the replacement to open", () => r.e.status().serverMode?.state === "open", 20_000);
    for (const c of [a, b]) {
      const x = await c.run("SELECT count(*) AS n FROM r.orders");
      expect(x.ok).toBe(false);
      expect(x.ok ? "" : x.error).toMatch(/Invalid connection id|Could not connect/);
    }
    const t = performance.now();
    for (const c of [a, b]) {
      await c.run("DETACH r");
      expect((await c.attach(r.uri(), alice)).ok).toBe(true);
      expect(await c.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: "20" }]);
    }
    expect(performance.now() - t).toBeLessThan(1000);
  }, 90_000);
});

describe("a refreshed copy", () => {
  withExt("is swapped in under open sessions: they keep reading, and across three refreshes each answer is one whole copy's", async () => {
    const r = await rig();
    const alice = await r.key("alice");
    const readers = [await person(r, alice), await person(r, alice)];
    let stop = false;
    const failures: string[] = [];
    const seen = [new Set<string>(), new Set<string>()];
    const loop = async (i: number) => {
      while (!stop) {
        const a = await readers[i]!.run(i === 0 ? "SELECT count(*) AS n FROM r.orders" : "SELECT count(*) AS n FROM r.orders o JOIN r.orders p ON o.id = p.id");
        if (a.ok) seen[i]!.add(String(a.rows[0]!.n));
        else failures.push(a.error.split("\n")[0]!);
        await Bun.sleep(3);
      }
    };
    const running = [loop(0), loop(1)];
    await Bun.sleep(200);
    const pid = r.e.status().serverMode!.workerPid;
    for (const [step, n] of [30, 40, 50].entries()) {
      await replaceCopy(r.p, n, `2026-10-30T1${step + 1}:00:00Z`);
      await until(`swap ${step + 1}`, () => (r.e.status().serverMode?.swaps ?? 0) === step + 1);
      await Bun.sleep(150);
    }
    stop = true;
    await Promise.all(running);
    expect(r.e.status().serverMode).toMatchObject({ workerPid: pid, swaps: 3, restarts: 0 });
    for (const s of seen) {
      expect([...s].every((n) => ["20", "30", "40", "50"].includes(n))).toBe(true);
      expect(s.has("50")).toBe(true);
    }
    // A query that arrives in the few milliseconds between the old copy being detached and the new one attached can fail with a
    // catalog error (the docs say to run it again); none returns another answer, and no session is dropped.
    expect(failures.filter((f) => !/^Catalog Error: Table with name "wh\.main\.\w+" does not exist/.test(f))).toEqual([]);
    for (const c of readers) expect(await c.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: "50" }]);
  }, 120_000);
});

describe("behind a reverse proxy", () => {
  withExt("a client attaches through a proxy with the port written out, and an HTTP secret with extra headers sends a service token on every request", async () => {
    const r = await rig();
    const alice = await r.key("alice");
    const upstream = r.uri().replace("quack:", "http://");
    const seen: { path: string; id: string | null; secret: string | null }[] = [];
    const proxy = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        seen.push({ path: url.pathname, id: req.headers.get("cf-access-client-id"), secret: req.headers.get("cf-access-client-secret") });
        const headers = new Headers(req.headers);
        for (const h of ["host", "content-length", "connection"]) headers.delete(h);
        const body = await req.arrayBuffer();
        const res = await fetch(upstream + url.pathname, { method: req.method, headers, ...(body.byteLength ? { body } : {}) });
        return new Response(await res.arrayBuffer(), { status: res.status, headers: res.headers });
      },
    });
    try {
      const c = await clients.start(ext.dir);
      const at = `127.0.0.1:${proxy.port}`;
      await c.rows(`CREATE SECRET access (TYPE http, EXTRA_HTTP_HEADERS MAP {'CF-Access-Client-Id': 'svc-123.access', 'CF-Access-Client-Secret': 'shh'}, SCOPE 'http://${at}')`);
      expect((await c.attach(`quack:${at}`, alice)).ok).toBe(true);
      expect(await c.rows("SELECT count(*) AS n FROM r.orders WHERE k = 3")).toEqual([{ n: "3" }]);
      expect(seen.length).toBeGreaterThan(3);
      expect(seen.every((s) => s.path === "/quack" && s.id === "svc-123.access" && s.secret === "shh")).toBe(true);
    } finally {
      proxy.stop(true);
    }
  }, 60_000);
});

describe("a client with an open transaction", () => {
  withExt("does not stop a refreshed copy from being swapped in", async () => {
    const r = await rig();
    const c = await person(r, await r.key("alice"));
    await c.run("BEGIN");
    expect(await c.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: "20" }]);
    await replaceCopy(r.p, 33, "2026-10-30T11:00:00Z");
    await until("the swap", () => (r.e.status().serverMode?.swaps ?? 0) === 1);
    expect(r.e.status().serverMode).toMatchObject({ state: "open", restarts: 0 });
    await c.run("COMMIT");
    expect(await c.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: "33" }]);
    expect(await count(r.e)).toBe(33);
    await ask(r.e, "SELECT 1");
  }, 60_000);
});
