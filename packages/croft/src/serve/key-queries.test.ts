// A key's queries over croft serve's HTTP API (DESIGN.md D122, D123, D128; option 06, slice 3), against the real engines. A key works
// only in server mode (D128): there it reads through the readers' process (the read copy, a view per shared table), and every
// query has two walls, the gate and the views. On the file engine (a query worker on the live file, which steps aside for
// writers) a valid key is refused with a 403 before its body is read, and the engine refuses a key's scope itself. The app
// token reads every table everywhere; a key reads the shared ones and nothing else. The attack list (sql/attack-testkit.ts) is sent
// with a key and every request must be refused, with nothing written. The readers' tests start real child processes that load
// DuckDB's quack and httpfs files (scripts/fetch-extensions.ts); locally a missing file skips them and says why, in CI it fails them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeProject, seed, spawnIdle, writeIntent } from "../read/testkit.ts";
import { absentFor, ALL_ATTACKS, ALLOWED, CTE_SHAPES, HIDDEN_NAMES, HIDDEN_TABLES, NOT_A_READ, REACHING_OUT, SHARED, WAREHOUSE_SQL } from "../sql/attack-testkit.ts";
import { openServeEngine } from "./instance.ts";
import { type Rig, Rigs, TOKEN, aside } from "./key-rig-testkit.ts";
import { extensionFiles, openEngine, project as readersProject, putCopy, replaceCopy, until } from "./readers-testkit.ts";

const { ext, withExt } = extensionFiles("key-queries.test");

const rigs = new Rigs();
afterAll(() => rigs.close());

const KINDS: { name: string; make: () => Promise<Rig>; run: typeof test }[] = [
  { name: "server mode (the readers' process)", make: () => rigs.readers(ext.dir), run: ext.ready ? test : test.skip },
];

/** Everything in a folder that was not there before: a file an attack wrote would show here. */
function listing(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const here = rel ? `${rel}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, here);
      else if (!/^(\.|serve-keys|runs\.sqlite|readers-secrets)/.test(name) && !here.startsWith(".croft/readers-secrets")) out.push(here);
    }
  };
  walk(dir, "");
  return out;
}

for (const kind of KINDS) {
  describe(`keys over HTTP on ${kind.name}`, () => {
    let r: Rig;
    let alice: string;
    beforeAll(async () => {
      r = await kind.make();
      alice = r.key("alice");
    }, 60_000);

    kind.run("a key reads a shared table, and the answer is the table's rows", async () => {
      const a = await r.call(alice, "SELECT count(*) AS n FROM orders");
      expect(a.status).toBe(200);
      expect(a.json.data.rows).toEqual([{ n: 20 }]);
      const b = await r.call(alice, "SELECT id, name FROM customers ORDER BY id LIMIT 2");
      expect(b.json.data.rows).toEqual([{ id: 0, name: "c0" }, { id: 1, name: "c1" }]);
      // The engine's bookkeeping never reaches a client.
      expect(Object.keys(a.json.data)).not.toContain("tables");
    }, 60_000);

    kind.run("the queries a person needs all work", async () => {
      for (const q of ALLOWED) {
        const a = await r.call(alice, q.sql);
        expect(a.status, `${q.label}: ${q.sql} -> ${JSON.stringify(a.json.problems)}`).toBe(200);
      }
    }, 60_000);

    kind.run("SHOW TABLES lists the shared tables and nothing else", async () => {
      const a = await r.call(alice, "SHOW TABLES");
      expect(a.status).toBe(200);
      expect(a.json.data.rows).toEqual([{ name: "customers" }, { name: "orders" }]);
      const token = await r.call(TOKEN, "SHOW TABLES");
      expect(token.json.data.rows.map((x: { name: string }) => x.name)).toEqual(expect.arrayContaining(["orders", "customers", "payments", "secrets"]));
    }, 60_000);

    kind.run("the app token reads every table, as it always did", async () => {
      for (const sql of ["SELECT count(*) AS n FROM payments", "SELECT value FROM secrets", "SELECT count(*) AS n FROM orders o JOIN payments p ON o.id = p.id"]) {
        const a = await r.call(TOKEN, sql);
        expect(a.status, sql).toBe(200);
      }
      // ...and croft's own schema and the rest of the gate still hold for it.
      expect((await r.call(TOKEN, "SELECT * FROM _croft.assets")).status).toBe(400);
      expect((await r.call(TOKEN, "SHOW TABLES FROM _croft")).status).toBe(400);
    }, 60_000);

    kind.run("a table that is not shared is refused with 400 as if it did not exist: the same words for a table that does and one that does not", async () => {
      const real = await r.call(alice, "SELECT * FROM payments");
      const absent = await r.call(alice, "SELECT * FROM no_such_table");
      expect(real.status).toBe(400);
      expect(absent.status).toBe(400);
      const words = (x: typeof real, name: string) => ({ ...x.json.problems[0], message: x.json.problems[0].message.replaceAll(name, "<name>") });
      expect(words(real, "payments")).toEqual(words(absent, "no_such_table"));
      expect(JSON.stringify(real.json)).not.toMatch(/secrets|_croft|Did you mean/);
    }, 60_000);

    kind.run("a CTE named after a hidden table gets the same answer as one named after nothing: status, words, position and rows", async () => {
      const same = (v: unknown, name: string) => JSON.stringify(v).replace(new RegExp(name, "gi"), "<name>");
      const strip = (j: any) => ({ ...j, durationMs: 0, data: j.data && { ...j.data, tookMs: 0 } });
      let ok = 0;
      let refused = 0;
      for (const hidden of HIDDEN_NAMES) {
        const absent = absentFor(hidden);
        for (const shape of CTE_SHAPES) {
          const a = await r.call(alice, shape.sql(hidden));
          const b = await r.call(alice, shape.sql(absent));
          const what = `${shape.label}: ${shape.sql(hidden)}`;
          expect(a.status, what).toBe(b.status);
          expect(same(strip(a.json), hidden), what).toBe(same(strip(b.json), absent));
          if (a.status === 200) ok++;
          else refused++;
        }
      }
      expect(ok).toBeGreaterThan(10);
      expect(refused).toBeGreaterThan(5);
    }, 120_000);

    kind.run("the whole attack list is refused with a key, written plainly and with a catalog function in a comment, a string and a line comment; nothing is written", async () => {
      const before = listing(r.p.root);
      const dbBefore = readFileSync(r.p.database).length;
      const copyBefore = existsSync(r.p.project.paths.readCopy) ? readFileSync(r.p.project.paths.readCopy).length : 0;
      const wrong: string[] = [];
      for (const q of ALL_ATTACKS) {
        const a = await r.call(alice, q.sql);
        if (a.status === 200) wrong.push(`${q.label}: ${q.sql}`);
        else if (a.status !== 400) wrong.push(`${q.label}: status ${a.status} ${JSON.stringify(a.json.problems?.[0]?.code)}`);
      }
      expect(wrong).toEqual([]);
      expect(listing(r.p.root)).toEqual(before);
      expect(readFileSync(r.p.database).length).toBe(dbBefore);
      if (existsSync(r.p.project.paths.readCopy)) expect(readFileSync(r.p.project.paths.readCopy).length).toBe(copyBefore);
      // Still the same rows afterwards.
      expect((await r.call(alice, "SELECT count(*) AS n FROM orders")).json.data.rows).toEqual([{ n: 20 }]);
      expect((await r.call(TOKEN, "SELECT count(*) AS n FROM payments")).json.data.rows).toEqual([{ n: 8 }]);
      expect(ALL_ATTACKS.length).toBeGreaterThan(250);
      expect([HIDDEN_TABLES.length, NOT_A_READ.length, REACHING_OUT.length].every((n) => n > 20)).toBe(true);
    }, 120_000);

    kind.run("a removed key is refused on its next request; other keys and the app token are unaffected", async () => {
      const bob = r.key("bob");
      const carol = r.key("carol");
      for (const k of [bob, carol, alice]) expect((await r.call(k, "SELECT 1")).status).toBe(200);
      r.keys.remove("bob");
      const refused = await r.call(bob, "SELECT 1");
      expect(refused.status).toBe(401);
      expect(refused.json.problems[0].code).toBe("SERVE_UNAUTHORIZED");
      expect((await r.call(carol, "SELECT 1")).status).toBe(200);
      expect((await r.call(alice, "SELECT 1")).status).toBe(200);
      expect((await r.call(TOKEN, "SELECT 1")).status).toBe(200);
      // A key added after the server started works at once, and a made-up one does not.
      expect((await r.call(r.key("dave"), "SELECT 1")).status).toBe(200);
      expect((await r.call("croftkey_" + "A".repeat(43), "SELECT 1")).status).toBe(401);
      r.keys.remove("carol");
      r.keys.remove("dave");
    }, 60_000);

    kind.run("a key is for /query only: /status and /health need the app token", async () => {
      for (const path of ["/status", "/health"]) {
        const a = await r.call(alice, "", {}, path);
        expect(a.status, path).toBe(403);
        expect(a.json.problems[0].code).toBe("SERVE_UNAUTHORIZED");
        expect((await r.call(TOKEN, "", {}, path)).status, path).toBe(200);
      }
    }, 60_000);

    kind.run("one log line per key query: the key's name, the tables it read, rows and time, and a refusal's code; never the SQL or the key", async () => {
      r.log.length = 0;
      await r.call(alice, "SELECT o.id FROM orders o JOIN customers c ON o.id = c.id WHERE o.id < 3");
      await r.call(alice, "SELECT * FROM payments");
      await r.call(alice, "SELECT 'a-secret-literal' AS s FROM orders LIMIT 1");
      await r.call(TOKEN, "SELECT count(*) FROM orders"); // the app token is not a key query
      expect(r.log.map((e) => ({ key: e.key, tables: e.tables, rows: e.rows, outcome: e.outcome }))).toEqual([
        { key: "alice", tables: ["orders", "customers"], rows: 3, outcome: "ok" },
        { key: "alice", tables: [], rows: 0, outcome: "QUERY_PATH_DENIED" },
        { key: "alice", tables: ["orders"], rows: 1, outcome: "ok" },
      ]);
      for (const e of r.log) {
        expect(e.at).toBeInstanceOf(Date);
        expect(e.ms).toBeGreaterThanOrEqual(0);
        expect(JSON.stringify(e)).not.toContain(alice);
        expect(JSON.stringify(e)).not.toContain("a-secret-literal");
      }
    }, 60_000);

    kind.run("with no table shared every key query is refused with the hint, and the app token is not affected", async () => {
      const none = await rigs.rig(r.p, r.engine, { sharedTables: [] });
      const k = none.key("erin");
      for (const sql of ["SELECT 1", "SELECT * FROM orders", "SHOW TABLES"]) {
        const a = await none.call(k, sql);
        expect(a.status, sql).toBe(403);
        expect(a.json.problems[0].code).toBe("SERVE_NO_SHARED_TABLES");
        expect(a.json.problems[0].hint).toContain("sharedTables");
      }
      expect((await none.call(TOKEN, "SELECT count(*) AS n FROM orders")).status).toBe(200);
      expect(none.log.map((e) => e.outcome)).toEqual(["SERVE_NO_SHARED_TABLES", "SERVE_NO_SHARED_TABLES", "SERVE_NO_SHARED_TABLES"]);
    }, 60_000);

    kind.run("the engine itself refuses a key's query when the project shares nothing", async () => {
      const e = await r.engine.query({ sql: "SELECT 1", params: [], limit: 10, scope: { key: "alice", tables: [] } }).catch((x: Error) => x);
      expect((e as { code?: string }).code).toBe("SERVE_NO_SHARED_TABLES");
    }, 60_000);
  });
}

describe("a key without server mode is refused (D128)", () => {
  /** The file engine over the attack list's warehouse, with a key made and the project sharing orders and customers. */
  let r: Rig;
  let alice: string;
  beforeAll(async () => {
    r = await rigs.file();
    alice = r.key("alice");
  }, 60_000);

  test("a valid key is refused with a 403 and a code of its own, the words say what to turn on, and the usual log line is written", async () => {
    const a = await r.call(alice, "SELECT count(*) AS n FROM orders");
    expect(a.status).toBe(403);
    expect(a.json.ok).toBe(false);
    expect(a.json.problems[0]).toMatchObject({ code: "SERVE_KEY_NEEDS_SERVER_MODE", retryable: false });
    expect(a.json.problems[0].message).toContain("server mode");
    expect(a.json.problems[0].hint).toContain('"serverMode"');
    expect(a.json.problems[0].fix).toMatchObject({ kind: "manual", requiresHuman: true });
    expect(r.log.at(-1)).toMatchObject({ key: "alice", tables: [], rows: 0, outcome: "SERVE_KEY_NEEDS_SERVER_MODE" });
    expect(JSON.stringify(r.log)).not.toContain(alice);
  }, 60_000);

  test("it is refused before the body is read: a body that is not JSON, and one that is not even the right type, get the same answer", async () => {
    for (const [type, body] of [["application/json", "this is not json"], ["application/json", '{"sql": "SELECT 1", "nonsense": true}'], ["application/json", ""]] as const) {
      const res = await fetch(`${r.url}/query`, { method: "POST", headers: { authorization: `Bearer ${alice}`, "content-type": type }, body });
      expect(res.status, body).toBe(403);
      expect(((await res.json()) as { problems: { code: string }[] }).problems[0]!.code).toBe("SERVE_KEY_NEEDS_SERVER_MODE");
    }
    // The content-type check still comes first, as for every request.
    const wrongType = await fetch(`${r.url}/query`, { method: "POST", headers: { authorization: `Bearer ${alice}`, "content-type": "text/plain" }, body: "SELECT 1" });
    expect(wrongType.status).toBe(415);
  }, 60_000);

  test("every query a key could send is refused the same way, the attack list included, and nothing is written", async () => {
    const before = listing(r.p.root);
    const dbBefore = readFileSync(r.p.database).length;
    const wrong: string[] = [];
    for (const q of ALL_ATTACKS) {
      const a = await r.call(alice, q.sql);
      if (a.status !== 403 || a.json.problems?.[0]?.code !== "SERVE_KEY_NEEDS_SERVER_MODE") wrong.push(`${q.label}: ${q.sql} -> ${a.status}`);
    }
    expect(wrong).toEqual([]);
    expect(listing(r.p.root)).toEqual(before);
    expect(readFileSync(r.p.database).length).toBe(dbBefore);
  }, 120_000);

  test("it is not a 401: the key is valid, and a removed or made-up key still is one; the app token reads every table as it always did", async () => {
    const bob = r.key("bob");
    r.keys.remove("bob");
    for (const bearer of [bob, "croftkey_" + "A".repeat(43), "not-a-token"]) {
      const a = await r.call(bearer, "SELECT 1");
      expect(a.status).toBe(401);
      expect(a.json.problems[0].code).toBe("SERVE_UNAUTHORIZED");
    }
    for (const sql of ["SELECT count(*) AS n FROM orders", "SELECT count(*) AS n FROM payments", "SELECT value FROM secrets"]) expect((await r.call(TOKEN, sql)).status, sql).toBe(200);
    // A key is for /query only, so /status and /health stay the app token's, as they always were.
    for (const path of ["/status", "/health"]) expect((await r.call(alice, "", {}, path)).status, path).toBe(403);
  }, 60_000);

  test("the engine refuses a query that carries a key's scope itself, whatever the HTTP layer did: the second guard", async () => {
    for (const tables of [[...SHARED], []]) {
      const e = await r.engine.query({ sql: "SELECT 1", params: [], limit: 10, scope: { key: "alice", tables } }).catch((x: Error) => x);
      expect((e as { code?: string }).code).toBe("SERVE_KEY_NEEDS_SERVER_MODE");
    }
    expect((await r.engine.query({ sql: "SELECT count(*) AS n FROM orders", params: [], limit: 10 })).rows).toEqual([{ n: 20 }]);
  }, 60_000);

  test("it is refused at once, not queued behind a writer: the app token waits for the write and is told to retry, the key is told what to turn on", async () => {
    const p = await makeProject({ config: { serve: { sharedTables: [...SHARED] } }, seed: WAREHOUSE_SQL });
    const engine = await openServeEngine({ root: p.root, resources: { threads: 2 }, queueMs: 400, graceMs: 100 });
    rigs.engines.push(engine);
    const w = await rigs.rig(p, engine);
    const key = w.key("alice");
    const idle = spawnIdle();
    writeIntent(p.stateDir, idle.proc.pid!);
    try {
      await until("the engine steps aside", () => engine.status().state !== "open", 10_000);
      const refused = await w.call(key, "SELECT count(*) AS n FROM orders");
      expect(refused.status).toBe(403); // refused at once, not queued: a queued key query would come back 503 after the engine's queueMs
      const waited = await w.call(TOKEN, "SELECT count(*) AS n FROM orders");
      expect(waited.status).toBe(503);
      expect(waited.json.problems[0].code).toBe("SERVE_UNAVAILABLE");
    } finally {
      idle.proc.kill("SIGKILL");
    }
  }, 60_000);
});

describe("server mode: the shared tables' views follow the copy", () => {
  withExt("a refreshed copy is swapped in under a key's connection: new rows, and a shared table the first copy lacked", async () => {
    // The first copy has orders only; customers is shared but not built yet.
    const p = await readersProject({ n: 10, config: { serve: { sharedTables: [...SHARED] } } });
    const engine = await openEngine(rigs.engines, ext.dir, p);
    const r = await rigs.rig(p, engine);
    const key = r.key("alice");
    expect((await r.call(key, "SELECT count(*) AS n FROM orders")).json.data.rows).toEqual([{ n: 10 }]);
    const missing = await r.call(key, "SELECT * FROM customers");
    expect(missing.status).toBe(400); // refused like any table that is not there
    expect((await r.call(key, "SHOW TABLES")).json.data.rows).toEqual([{ name: "orders" }]);
    // A run builds customers and adds orders; the refresh renames the new copy into place.
    const next = aside(p, "next-copy");
    await seed(next, ["INSERT INTO orders SELECT range + 100, 1 FROM range(5)", "CREATE TABLE customers AS SELECT range AS id, 'c' || range AS name FROM range(3)", "CREATE TABLE payments AS SELECT 1 AS id", "CHECKPOINT"]);
    putCopy(p, next, "2026-10-30T11:00:00Z");
    await until("the swap", () => (engine.status().serverMode?.swaps ?? 0) === 1);
    expect((await r.call(key, "SELECT count(*) AS n FROM orders")).json.data.rows).toEqual([{ n: 15 }]);
    expect((await r.call(key, "SELECT count(*) AS n FROM customers")).json.data.rows).toEqual([{ n: 3 }]);
    expect((await r.call(key, "SHOW TABLES")).json.data.rows).toEqual([{ name: "customers" }, { name: "orders" }]);
    expect((await r.call(key, "SELECT * FROM payments")).status).toBe(400);
    expect((await r.call(TOKEN, "SELECT count(*) AS n FROM payments")).json.data.rows).toEqual([{ n: 1 }]);
    // The key's answers carry the copy's as-of time, like the token's.
    expect((await r.call(key, "SELECT 1")).json.data.asOf).toBe("2026-10-30T04:00:00-07:00");
  }, 90_000);
});

describe("server mode: keys across refreshes", () => {
  withExt("across three refreshes under steady key queries from two clients, no query fails and each answer is one whole copy's", async () => {
    const p = await readersProject({ n: 10, asOf: "2026-10-30T10:00:00Z", config: { serve: { sharedTables: [...SHARED] } } });
    const engine = await openEngine(rigs.engines, ext.dir, p);
    const scope = { key: "alice", tables: [...SHARED] };
    const ask = (sql: string) => engine.query({ sql, params: [], limit: 1000, scope });
    let stop = false;
    const failures: unknown[] = [];
    const seen = [new Set<number>(), new Set<number>()];
    const client = async (i: number) => {
      while (!stop) {
        try {
          const a = await ask(i === 0 ? "SELECT count(*) AS n FROM orders" : "SELECT count(*) AS n FROM orders o JOIN orders p ON o.id = p.id");
          seen[i]!.add(Number(a.rows[0]!.n));
          // The listing is never torn by a swap: the shared table that exists, and nothing else.
          const t = await ask("SHOW TABLES");
          if (JSON.stringify(t.rows) !== JSON.stringify([{ name: "orders" }])) failures.push(t.rows);
        } catch (err) {
          failures.push(err);
        }
        await Bun.sleep(2);
      }
    };
    const clients = [client(0), client(1)];
    await Bun.sleep(100);
    const pid = engine.status().serverMode!.workerPid;
    for (const [step, n] of [20, 30, 40].entries()) {
      await replaceCopy(p, n, `2026-10-30T1${step + 1}:00:00Z`);
      await until(`swap ${step + 1}`, () => (engine.status().serverMode?.swaps ?? 0) === step + 1);
      await Bun.sleep(100);
    }
    stop = true;
    await Promise.all(clients);
    expect(failures).toEqual([]);
    expect(engine.status().serverMode).toMatchObject({ workerPid: pid, swaps: 3, restarts: 0 });
    for (const s of seen) {
      expect([...s].every((n) => [10, 20, 30, 40].includes(n))).toBe(true);
      expect(s.has(40)).toBe(true);
    }
  }, 120_000);
});
