// A person's DuckDB over Quack on server mode over a lake (DESIGN.md D183; option 07, slice 5; option 06, slice 4 over a lake), against the
// real thing: croft serve's lake engine with its Quack listener, and a DuckDB 2.0 client in a process of its own
// (serve/quack-client-testkit.ts), on a local lake and on a Postgres catalog with an S3-compatible store. Everything that starts is a
// child of the test, killed in teardown. The attack list is sent over Quack here too, with the lake's own.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TIMING_GAP } from "../../tests/timing-gap.ts";
import { cli } from "../cli/commands/inspect-testkit.ts";
import { connect, openMemoryInstance } from "../db/connect.ts";
import { lakeConnection } from "../db/lake.ts";
import { type LakeRig, startLakeRig } from "../db/lake-testkit.ts";
import {
  absentFor, ALL_ATTACKS, ALLOWED, type Attack, CTE_SHAPES, HIDDEN_NAMES, HIDDEN_TABLES, lakeAttacks, lakeReaderAttacks, NOT_A_READ, REACHING_OUT, SHARED, variants,
} from "../sql/attack-testkit.ts";
import { Rigs } from "./key-rig-testkit.ts";
import { type LakeKind, type LakeServe, lakeReady, startLakeServe, written } from "./lake-serve-testkit.ts";
import type { QuackEvent } from "./quack-access.ts";
import { SCHEMA_QUERY, TABLES_QUERY, TRANSACTION_TEXTS } from "./quack-catalog.ts";
import { type QuackClient, QuackClients, freePort, raw } from "./quack-client-testkit.ts";
import { until } from "./readers-testkit.ts";

const ready = lakeReady();
if (!ready.ready) console.warn(`[lake-quack.test] SKIPPING the Quack-over-a-lake tests: ${ready.skipReason}`);
const maybe = ready.ready ? describe : describe.skip;

let lakeRig: LakeRig;
const rigs = new Rigs();
const clients = new QuackClients();
beforeAll(async () => {
  if (ready.ready) lakeRig = await startLakeRig();
}, 120_000);
afterAll(async () => {
  await clients.close();
  await rigs.close();
  await lakeRig?.stop();
});

/** A key made now, which the engine has told the process of. */
const key = (s: LakeServe, name: string): Promise<string> => s.key(name);

/** The DuckDB 2.0 client of a person who attached `as` r with `k`. */
async function person(s: LakeServe, k: string, as = "r"): Promise<QuackClient> {
  const c = await clients.start(ready.dir);
  // The process takes the key from a message of its own, which can come a moment after the engine sent it.
  let last = "";
  await until("the key to sign in", async () => {
    const a = await c.attach(s.uri(), k, as);
    if (!a.ok) last = a.error;
    return a.ok;
  }, 15_000).catch((e) => { throw new Error(`attach failed: ${last}: ${e}`); });
  return c;
}

async function accepted(c: QuackClient, uri: string, k: string): Promise<void> {
  await until("the key to be accepted", async () => (await raw(c, uri, k, "SELECT count(*) AS n FROM orders")).ok, 15_000);
}

/** A croft run in the lake project: the next commit of the lake. */
async function run(s: LakeServe, asset = "orders"): Promise<void> {
  const r = await cli(["run", asset, "--foreground", "--json"], { cwd: s.l.p.root, env: s.l.env });
  expect(r.exit, r.stdout).toBe(0);
}

const ORDERS = (n: number) => `-- description: orders\n-- key: id\nSELECT range AS id, range % 7 AS k, 'o' || range AS note FROM range(${n})\n`;

/** The project's own writer, to commit to the lake without croft's help (a transaction held open, or many small commits). */
async function writer(s: LakeServe) {
  const lake = lakeConnection(s.l.project, s.env(), { extensionDir: ready.dir })!;
  const instance = await openMemoryInstance();
  const conn = await connect(instance, {
    profile: "warehouse", timezone: "UTC", root: s.l.p.root, stateDir: s.l.project.paths.stateDir, mode: lake.mode("write"),
  }, `:memory:quack-writer-${Math.random().toString(36).slice(2)}`);
  await conn.run("USE lake");
  return {
    // A SQLite catalog (a local lake) lets one writer commit between its readers' reads: "database is locked" is the answer to wait out, which croft's
    // own writer does (db/lake.ts isConflict); a Postgres catalog never says it.
    run: async (sql: string) => {
      for (let attempt = 0; ; attempt++) {
        try {
          await conn.run(sql);
          return;
        } catch (e) {
          if (attempt >= 50 || !/database is locked/i.test((e as Error).message)) throw e;
          await Bun.sleep(20);
        }
      }
    },
    close() {
      conn.disconnectSync();
      instance.closeSync();
    },
  };
}

/** The files directly in a folder with their sizes: where a relative path in an attack would land if the server's lockdown let it write. */
function topLevel(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((name) => {
    const st = statSync(join(dir, name));
    return st.isFile() ? [`${name} ${st.size}`] : [];
  });
}

/** Attacks with absolute paths into the project, which a relative path in the list cannot reach from another folder. */
function pathAttacks(root: string, stateDir: string): Attack[] {
  const a = (label: string, sql: string): Attack => ({ label, sql });
  return [
    a("COPY a shared table into the project", `COPY orders TO '${root}/pwn-abs.csv'`),
    a("COPY a query into the project", `COPY (SELECT 1) TO '${root}/pwn-abs2.csv' (FORMAT CSV)`),
    a("COPY inside a WITH, into the project", `WITH x AS (COPY (SELECT 1) TO '${root}/pwn-abs3.csv') SELECT 1`),
    a("EXPORT DATABASE into the project", `EXPORT DATABASE '${root}/exp-abs'`),
    a("read_text of the record file", `SELECT content FROM read_text('${stateDir}/serve.json')`),
    a("read_text of the keys file", `SELECT content FROM read_text('${stateDir}/serve-keys.json')`),
    a("read_text of the project's .env", `SELECT content FROM read_text('${root}/.env')`),
    a("glob of the project", `SELECT * FROM glob('${root}/*')`),
    a("glob of the state folder", `SELECT * FROM glob('${stateDir}/*')`),
    a("read_csv of a file in the project", `SELECT * FROM read_csv('${root}/files/x.csv')`),
    a("quack_stop of this server", "SELECT * FROM quack_stop('quack:127.0.0.1:1')"),
    a("quack_serve for another listener", "SELECT * FROM quack_serve('quack:127.0.0.1:0', token = 'abcdef')"),
  ];
}

for (const kind of ["local", "postgres"] as LakeKind[]) {
  maybe(`a person's DuckDB over Quack on a ${kind} lake`, () => {
    let s: LakeServe;
    let events: QuackEvent[];
    beforeAll(async () => {
      s = await startLakeServe(kind, { extensionDir: ready.dir, lakeRig, rigs });
      events = s.events;
    }, 180_000);

    test("a DuckDB 2.0 attaches with a key and reads a shared table by its plain name, with filters and aggregates pushed down", async () => {
      const c = await person(s, await key(s, "alice"));
      expect(await c.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: "20" }]);
      expect(await c.rows("SELECT k, count(*) AS n FROM r.orders WHERE id > 12 GROUP BY k ORDER BY k")).toEqual(
        [0, 1, 2, 3, 4, 5, 6].map((k) => ({ k: String(k), n: "1" })));
      expect(await c.rows("SELECT count(*) AS n FROM r.orders o JOIN r.customers c ON o.id = c.id")).toEqual([{ n: "5" }]);
      await c.run("CREATE TABLE mine AS SELECT 3 AS id");
      expect(await c.rows("SELECT o.k FROM r.orders o JOIN mine USING (id)")).toEqual([{ k: "3" }]);
      expect(await c.rows("DESCRIBE r.orders")).toMatchObject([{ column_name: "id" }, { column_name: "k" }, { column_name: "note" }, { column_name: "_loaded_at" }]);
    });

    test("it works while a write to the lake is in progress: the reader sees the last commit, and the commit when it lands", async () => {
      const alice = await key(s, "alice2");
      const w = await writer(s);
      try {
        const c = await person(s, alice);
        const before = Number((await c.rows("SELECT count(*) AS n FROM r.orders"))[0]!.n);
        await w.run("BEGIN");
        await w.run("INSERT INTO main.orders (id, k, note) SELECT 1000 + range, 0, 'held' FROM range(7)");
        for (let i = 0; i < 10; i++) expect(await c.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: String(before) }]);
        await w.run("COMMIT");
        // Its next query: the commit is in it, with no copy and no swap.
        expect(await c.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: String(before + 7) }]);
        await w.run("DELETE FROM main.orders WHERE note = 'held'");
        expect(await c.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: String(before) }]);
      } finally {
        w.close();
      }
      expect(s.engine.status().serverMode).toMatchObject({ restarts: 0, swaps: 0, copy: null });
    });

    test("the queries a person needs all work", async () => {
      const alice = await key(s, "alice3");
      const c = await clients.start(ready.dir);
      await accepted(c, s.uri(), alice);
      for (const q of ALLOWED) {
        const a = await raw(c, s.uri(), alice, q.sql);
        expect(a.ok, `${q.label}: ${q.sql} -> ${a.ok ? "" : a.error}`).toBe(true);
      }
    });

    test("the client's table list shows the main schema, the shared tables and the as-of view, all views; croft's schema and the lake's names never appear", async () => {
      const c = await person(s, await key(s, "alice4"));
      expect(await c.rows("SELECT schema_name FROM duckdb_schemas() WHERE database_name = 'r' ORDER BY 1")).toEqual([{ schema_name: "main" }]);
      expect(await c.rows("SELECT view_name FROM duckdb_views() WHERE database_name = 'r' ORDER BY 1")).toEqual([{ view_name: "_croft_as_of" }, { view_name: "customers" }, { view_name: "orders" }]);
      expect(await c.rows("SELECT table_name FROM duckdb_tables() WHERE database_name = 'r'")).toEqual([]);
      expect(await c.rows("SHOW TABLES FROM r")).toEqual([{ name: "_croft_as_of" }, { name: "customers" }, { name: "orders" }]);
      for (const name of ["payments", "secrets", "_croft.assets_log"]) expect((await c.run(`SELECT * FROM r.${name}`)).ok, name).toBe(false);
      expect(JSON.stringify(await c.rows("SELECT * FROM duckdb_schemas() WHERE database_name = 'r'"))).not.toMatch(/_croft|lake/);
    });

    test("the as-of view holds the time of the newest snapshot; after a commit it is the new one within a poll, and the data is there at once", async () => {
      const c = await person(s, await key(s, "alice5"));
      const asOf = async () => Number((await c.rows("SELECT epoch_ms(as_of)::VARCHAR AS t, count(*) OVER () AS n FROM r._croft_as_of"))[0]!.t);
      const first = await asOf();
      expect(Math.abs(first - Date.parse(s.engine.status().serverMode!.asOf!))).toBeLessThan(5000);
      const n = Number((await c.rows("SELECT count(*) AS n FROM r.orders"))[0]!.n);
      writeFileSync(join(s.l.p.root, "assets/orders.sql"), ORDERS(n + 3));
      await run(s);
      // The rows are in the very next query: a view reads the lake's last snapshot whenever it is read.
      expect(await c.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: String(n + 3) }]);
      // The as-of time follows within a look of the lake (250 ms while a session is signed in); it is never newer than the data.
      let seen = first;
      await until("the as-of time to move on after the commit", async () => (seen = await asOf()) > first, 15_000);
      expect(s.engine.status().serverMode).toMatchObject({ restarts: 0 });
      // ... and the HTTP answers carry the same snapshot's time.
      const http = await s.rig.call(s.rig.key("via-http"), "SELECT 1");
      expect(Math.abs(Date.parse(http.json.data.asOf) - seen)).toBeLessThan(2000);
    }, 60_000);

    test("a shared table a run makes is served within a look of the lake; a session lists it when it attaches again, and the session in use is kept", async () => {
      const second = await startLakeServe(kind, { extensionDir: ready.dir, lakeRig, rigs, shared: [...SHARED, "extras"] });
      const k = await key(second, "alice");
      const c = await person(second, k);
      expect(await c.rows("SHOW TABLES FROM r")).toEqual([{ name: "_croft_as_of" }, { name: "customers" }, { name: "orders" }]);
      expect((await c.run("SELECT * FROM r.extras")).ok).toBe(false);
      writeFileSync(join(second.l.p.root, "assets/extras.sql"), "-- description: extras\n-- key: id\nSELECT range AS id FROM range(4)\n");
      await run(second, "extras");
      // The server serves it within a look of the lake (a query it is sent as written finds it) ...
      await until("the new table to be served", async () => (await raw(c, second.uri(), k, "SELECT count(*) AS n FROM extras")).ok, 15_000);
      // ... a DuckDB client reads the list of a server's tables when it attaches, so the session in use keeps its list and reads on,
      expect(await c.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: "20" }]);
      // and an ATTACH made now lists the new table.
      const fresh = await person(second, k, "again");
      expect(await fresh.rows("SELECT count(*) AS n FROM again.extras")).toEqual([{ n: "4" }]);
      expect(await fresh.rows("SHOW TABLES FROM again")).toEqual([{ name: "_croft_as_of" }, { name: "customers" }, { name: "extras" }, { name: "orders" }]);
      expect(second.engine.status().serverMode).toMatchObject({ restarts: 0 });
    }, 120_000);

    test("a wrong key, a removed key, a key that was never made and the app token are refused at sign-in: Authentication failed", async () => {
      const alice = await key(s, "alice6");
      const bob = await key(s, "bob");
      s.rig.keys.remove("bob");
      const c = await clients.start(ready.dir);
      await until("bob to be refused", async () => !(await c.attach(s.uri(), bob, "x")).ok, 10_000);
      for (const token of [`croftkey_${"A".repeat(43)}`, bob, "app-token-for-key-tests", "abcd", `${alice}x`, alice.toUpperCase()]) {
        const a = await c.attach(s.uri(), token, "x");
        expect(a.ok, token).toBe(false);
        expect(a.ok ? "" : a.error, token).toContain("Authentication failed");
      }
      expect((await c.attach(s.uri(), alice, "ok")).ok).toBe(true);
    });

    test("an open DuckDB session whose key is removed is refused on its next query, within a second; other people's sessions are not affected (acceptance 6)", async () => {
      const a = await person(s, await key(s, "carol"));
      const b = await person(s, await key(s, "dave"));
      for (const c of [a, b]) expect(await c.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: expect.any(String) }]);
      s.rig.keys.remove("carol");
      // The removal is told to the readers' process on the engine's next poll, and the session is refused from then on.
      await until("the removed key to be refused", async () => !(await a.run("SELECT count(*) AS n FROM r.orders")).ok, 15_000);
      const refused = await a.error("SELECT count(*) AS n FROM r.orders");
      expect(refused).toContain("carol was removed");
      for (const sql of ["SELECT count(*) FROM r.orders", "SELECT * FROM r._croft_as_of", "SELECT * FROM r.customers"]) expect((await a.run(sql)).ok, sql).toBe(false);
      expect(await b.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: expect.any(String) }]);
    }, 60_000);

    test("each sign-in and query is told to the command with the key's name, and none carries the SQL or the key", async () => {
      const k = await key(s, "erin");
      const c = await person(s, k);
      await c.rows("SELECT 'a-secret-literal' AS s FROM r.orders LIMIT 1");
      await c.run(`SELECT * FROM quack_query('${s.uri()}', 'SELECT * FROM payments', token = '${k}')`);
      expect(events.find((e) => e.kind === "signin" && e.key === "erin")).toBeDefined();
      const mine = events.filter((e) => e.key === "erin");
      expect(mine.some((q) => q.kind === "query" && q.outcome === "ok" && q.tables.join() === "orders")).toBe(true);
      expect(mine.some((q) => q.kind === "query" && q.outcome === "QUERY_PATH_DENIED" && q.tables.length === 0)).toBe(true);
      const text = JSON.stringify(events);
      expect(text).not.toContain("a-secret-literal");
      expect(text).not.toContain(k);
    });

    test("every attack is refused over Quack, written plainly and with a catalog function in a comment, a string and after a line comment, with the lake's own; nothing is written and the server stands (acceptance 4)", async () => {
      const alice = await key(s, "attacker");
      const c = await clients.start(ready.dir);
      await accepted(c, s.uri(), alice);
      const before = { ...written(s.l), cwd: topLevel(process.cwd()) };
      const pid = s.engine.status().serverMode!.workerPid;
      const bucket = s.l.bucket;
      const attacks = [...ALL_ATTACKS, ...[...lakeAttacks(bucket), ...lakeReaderAttacks(bucket), ...pathAttacks(s.l.p.root, s.l.project.paths.stateDir)].flatMap(variants)];
      const wrong: string[] = [];
      for (const q of attacks) {
        // The client's own transaction control is let through by its exact text, on purpose; everything near it is an attack.
        const control = TRANSACTION_TEXTS.has(q.sql);
        const a = await raw(c, s.uri(), alice, q.sql);
        if (!a.ok && !a.error.includes("Authorization callback failed")) wrong.push(`${q.label}: ${q.sql.slice(0, 120)} -> NOT THE HOOK: ${a.error.split("\n")[0]}`);
        if (a.ok !== control) wrong.push(`${q.label}: ${q.sql.slice(0, 120)} -> ${a.ok ? "ALLOWED" : a.error.split("\n")[0]}`);
      }
      expect(wrong).toEqual([]);
      expect(attacks.length).toBeGreaterThan(600);
      expect([HIDDEN_TABLES.length, NOT_A_READ.length, REACHING_OUT.length].every((n) => n > 20)).toBe(true);
      const after = { ...written(s.l), cwd: topLevel(process.cwd()) };
      expect(after).toEqual(before);
      expect(s.engine.status().serverMode).toMatchObject({ state: "open", workerPid: pid, restarts: 0 });
      expect((await raw(c, s.uri(), alice, "SELECT count(*) AS n FROM orders")).ok).toBe(true);
      expect((await s.rig.call("app-token-for-key-tests", "SELECT count(*) AS n FROM payments")).json.data.rows).toEqual([{ n: 8 }]);
    }, 400_000);

    test("the catalog queries are allowed as their exact bytes only: with a trailing space, a comment or a second statement added they are refused", async () => {
      const alice = await key(s, "bytes");
      const c = await clients.start(ready.dir);
      await accepted(c, s.uri(), alice);
      const schemas = await raw(c, s.uri(), alice, SCHEMA_QUERY);
      expect(schemas.ok && schemas.rows.map((r) => [r.database_name, JSON.stringify(r.schema_path)])).toEqual([["memory", '["main"]']]);
      const tables = await raw(c, s.uri(), alice, TABLES_QUERY);
      expect(tables.ok && tables.rows.map((r) => r.view_name ?? Object.values(r)[1]).sort()).toEqual(["_croft_as_of", "customers", "orders"]);
      expect(JSON.stringify(tables)).not.toMatch(/_croft\b(?!_)|payments|secrets/);
      for (const q of [SCHEMA_QUERY, TABLES_QUERY]) {
        for (const text of [`${q} `, `${q}/* x */`, `${q} -- duckdb_tables(`, `${q}; DROP VIEW orders`, `${q}; SELECT * FROM lake.main.payments`, `${q};`, q.trim(), `/* duckdb_schemas( */${q}`]) {
          expect((await raw(c, s.uri(), alice, text)).ok, JSON.stringify(text.slice(-40))).toBe(false);
        }
      }
      expect((await raw(c, s.uri(), alice, "SELECT count(*) AS n FROM orders")).ok).toBe(true);
    }, 120_000);

    test("a CTE named after a hidden table gets the same answer as one named after nothing, over Quack too", async () => {
      const alice = await key(s, "ctes");
      const c = await clients.start(ready.dir);
      await accepted(c, s.uri(), alice);
      let ok = 0;
      let refused = 0;
      for (const hidden of HIDDEN_NAMES) {
        const absent = absentFor(hidden);
        for (const shape of CTE_SHAPES) {
          const a = await raw(c, s.uri(), alice, shape.sql(hidden));
          const b = await raw(c, s.uri(), alice, shape.sql(absent));
          const norm = (x: typeof a, name: string) => JSON.stringify(x.ok ? { rows: x.rows } : { error: x.error }).replace(new RegExp(name, "gi"), "<name>").replace(/\d+\.\d+/g, "<ms>");
          expect(a.ok, `${shape.label}: ${shape.sql(hidden)}`).toBe(b.ok);
          expect(norm(a, hidden), shape.label).toBe(norm(b, absent));
          if (a.ok) ok++;
          else refused++;
        }
      }
      expect(ok).toBeGreaterThan(10);
      expect(refused).toBeGreaterThan(5);
    }, 120_000);

    // With a SQLite catalog a writer cannot commit between readers that read without a pause (it waits for a moment with no reader), so the
    // steady load is a Postgres catalog's case.
    (kind === "postgres" ? test : test.skip)("across many commits under steady load from two DuckDB clients and the HTTP API, no query fails and each answer is one whole snapshot's [Postgres catalog]", async () => {
      const alice = await key(s, "steady");
      const readers = [await person(s, alice), await person(s, alice)];
      const httpKey = s.rig.key("steady-http");
      const w = await writer(s);
      const start = Number((await readers[0]!.rows("SELECT count(*) AS n FROM r.orders"))[0]!.n);
      const failures: string[] = [];
      const seen: Set<number>[] = [new Set(), new Set(), new Set()];
      let stop = false;
      const loop = async (i: number) => {
        while (!stop) {
          try {
            if (i < 2) {
              const a = await readers[i]!.run("SELECT count(*) AS n FROM r.orders");
              if (!a.ok) failures.push(a.error);
              else seen[i]!.add(Number(a.rows[0]!.n));
            } else {
              const a = await s.rig.call(httpKey, "SELECT count(*) AS n FROM orders");
              if (a.status !== 200) failures.push(JSON.stringify(a.json.problems));
              else seen[2]!.add(a.json.data.rows[0].n);
            }
          } catch (e) {
            failures.push(String(e));
          }
          await Bun.sleep(2);
        }
      };
      const loops = [loop(0), loop(1), loop(2)];
      const pid = s.engine.status().serverMode!.workerPid;
      try {
        for (let n = 1; n <= 20; n++) {
          // Each commit is one whole step: a reader sees `start + 3 * n` rows or the one before, never a half.
          await w.run("INSERT INTO main.orders (id, k, note) SELECT 10000 * " + n + " + range, 0, 'steady' FROM range(3)");
          await Bun.sleep(20);
        }
        await until("every reader to see the last commit", () => seen.every((set) => set.has(start + 60)), 15_000);
      } finally {
        stop = true;
        await Promise.all(loops);
        w.close();
      }
      expect(failures).toEqual([]);
      for (const set of seen) {
        expect([...set].every((n) => (n - start) % 3 === 0 && n >= start && n <= start + 60), JSON.stringify([...set])).toBe(true);
        expect(set.has(start + 60)).toBe(true);
      }
      expect(s.engine.status().serverMode).toMatchObject({ workerPid: pid, restarts: 0 });
    }, 120_000);

    // A SQLite catalog (a local lake) lets a writer commit only when no reader has a transaction open, so a client that holds one there makes a
    // run wait (croft docs lake: a local lake is for one machine and development); a Postgres catalog does not.
    (kind === "postgres" ? test : test.skip)("a client with an open transaction does not stop the views from following the lake for the others [Postgres catalog]", async () => {
      const second = await startLakeServe(kind, { extensionDir: ready.dir, lakeRig, rigs, shared: [...SHARED, "extras"] });
      const k = await key(second, "txn");
      const open = await person(second, k);
      const other = await person(second, k);
      await open.run("BEGIN");
      expect(await open.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: "20" }]);
      writeFileSync(join(second.l.p.root, "assets/extras.sql"), "-- description: extras\n-- key: id\nSELECT range AS id FROM range(2)\n");
      await run(second, "extras");
      await until("the new table to be served", async () => (await raw(other, second.uri(), k, "SELECT count(*) AS n FROM extras")).ok, 15_000);
      expect(await open.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: "20" }]);
      await open.run("COMMIT");
      expect(await open.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: "20" }]);
      expect(second.engine.status().serverMode).toMatchObject({ restarts: 0 });
    }, 120_000);
  });
}

maybe("the listener on a lake", () => {
  test("an address that is not this machine's or a port in use is QUACK_LISTEN_FAILED, and croft serve does not start", async () => {
    const taken = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      const e = await startLakeServe("local", { extensionDir: ready.dir, rigs, engine: { quack: { host: "127.0.0.1", port: taken.port } } }).catch((x: Error) => x);
      expect((e as { code?: string }).code).toBe("QUACK_LISTEN_FAILED");
      expect((e as Error).message).toContain(`127.0.0.1:${taken.port}`);
    } finally {
      taken.stop(true);
    }
  }, 120_000);

  test("an address other than loopback is refused to start with, QUACK_PLAINTEXT_NOT_ACCEPTED, unless the project accepts plaintext on the network (D131)", async () => {
    for (const host of ["0.0.0.0", "10.1.2.3"]) {
      const e = await startLakeServe("local", { extensionDir: ready.dir, rigs, engine: { quack: { host, port: 0 } } }).catch((x: Error) => x);
      expect((e as { code?: string }).code, host).toBe("QUACK_PLAINTEXT_NOT_ACCEPTED");
    }
    const ok = await startLakeServe("local", { extensionDir: ready.dir, rigs, serverMode: { quackPlaintextOnNetwork: true }, engine: { quack: { host: "0.0.0.0", port: 0 } } });
    expect(ok.uri()).toMatch(/^quack:0\.0\.0\.0:\d+$/);
  }, 180_000);

  test("a Quack query past serve.queryTimeoutMs ends the readers' process; the client attaches again and reads; HTTP carries on", async () => {
    const port = freePort();
    const overdue: number[] = [];
    const s = await startLakeServe("local", { extensionDir: ready.dir, rigs, engine: { queryTimeoutMs: 1500, quack: { host: "127.0.0.1", port }, hooks: { quackOverdue: (x) => overdue.push(x.ms) } } });
    const alice = await key(s, "alice");
    const c = await person(s, alice);
    const first = s.engine.status().serverMode!.workerPid!;
    expect(await c.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: "20" }]);
    const started = performance.now();
    const long = await c.run("SELECT count(*) FROM r.orders a, r.orders b, range(300000000) c WHERE (a.id + b.id + c.range) % 7 = 3");
    expect(long.ok).toBe(false); // an error, never a wrong answer
    expect(performance.now() - started).toBeLessThan(1500 + TIMING_GAP); // timing-gap: the query runs for minutes; the 1.5 s limit ends it
    expect(overdue).toHaveLength(1);
    await until("the old process to exit", () => s.engine.status().serverMode?.workerPid !== first);
    await until("the replacement to open", () => s.engine.status().serverMode?.state === "open", 30_000);
    expect(s.engine.status().serverMode).toMatchObject({ restarts: 1 });
    expect(s.uri()).toBe(`quack:127.0.0.1:${port}`);
    expect((await c.run("SELECT count(*) AS n FROM r.orders")).ok).toBe(false);
    expect((await c.run("DETACH r")).ok).toBe(true);
    expect((await c.attach(s.uri(), alice)).ok).toBe(true);
    expect(await c.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: "20" }]);
    expect((await s.rig.call("app-token-for-key-tests", "SELECT count(*) AS n FROM orders")).json.data.rows).toEqual([{ n: 20 }]);
  }, 120_000);

  test("a readers' process killed from outside drops every session: each query fails (never a wrong answer) until the client attaches again", async () => {
    const port = freePort();
    const s = await startLakeServe("local", { extensionDir: ready.dir, rigs, engine: { quack: { host: "127.0.0.1", port } } });
    const alice = await key(s, "alice");
    const a = await person(s, alice);
    const b = await person(s, alice);
    for (const c of [a, b]) expect(await c.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: "20" }]);
    process.kill(s.engine.status().serverMode!.workerPid!, "SIGKILL");
    for (let i = 0; i < 5; i++) for (const c of [a, b]) expect((await c.run("SELECT count(*) AS n FROM r.orders")).ok).toBe(false);
    await until("the replacement to open", () => s.engine.status().serverMode?.state === "open", 30_000);
    for (const c of [a, b]) {
      const x = await c.run("SELECT count(*) AS n FROM r.orders");
      expect(x.ok).toBe(false);
      expect(x.ok ? "" : x.error).toMatch(/Invalid connection id|Could not connect/);
    }
    for (const c of [a, b]) {
      await c.run("DETACH r");
      expect((await c.attach(s.uri(), alice)).ok).toBe(true);
      expect(await c.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: "20" }]);
    }
  }, 120_000);
});

maybe("the engine's own poll", () => {
  test("at the engine's own poll, a removed key is told to the process within a quarter of a second, so its open session is refused within the second option 06 promises", async () => {
    const told: number[] = [];
    const fast = await startLakeServe("local", { extensionDir: ready.dir, rigs, engine: { pollMs: undefined, hooks: { keysSent: (e) => told.push(e.at) } } });
    await fast.key("timed");
    const added = told.at(-1)!;
    // The list that adds the key was sent on a look, and the removal follows at once: the next look is one poll later.
    fast.rig.keys.remove("timed");
    await until("the removal to be told to the process", () => told.at(-1)! > added, 15_000);
    expect(told.at(-1)! - added).toBeLessThan(1000); // timing-gap: a poll of 250 ms; the engine looked once a second before, and cannot look sooner than its poll, so it is at least 1000 ms when wrong
  }, 120_000);
});
