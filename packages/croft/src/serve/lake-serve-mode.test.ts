// Server mode over a lake, on croft serve's HTTP API (DESIGN.md D183; option 07, slice 5; option 06, slices 2 and 3 over a lake). The
// lake engine with "serverMode" on: the readers' process attaches the lake itself, read-only, and answers apps with the token and people
// with a key, from the lake's last snapshot, with no read copy. The suites of option 06 that are not about the copy run here, on a
// local lake (SQLite catalog, local folder) and on a Postgres catalog with an S3-compatible store (children of the test run).
// Locally a missing extension file or Postgres skips the tests and says why; in CI it fails them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli } from "../cli/commands/inspect-testkit.ts";
import { CroftError } from "../core/errors.ts";
import { lakeConnection } from "../db/lake.ts";
import { type LakeRig, startLakeRig } from "../db/lake-testkit.ts";
import { closeAllWarehouses, openWarehouse } from "../db/warehouse.ts";
import { STUCK_MS } from "../../tests/timing-gap.ts";
import { absentFor, ALL_ATTACKS, ALLOWED, CTE_SHAPES, HIDDEN_NAMES, lakeAttacks, lakeReaderAttacks, SHARED, variants } from "../sql/attack-testkit.ts";
import { Rigs, TOKEN } from "./key-rig-testkit.ts";
import { until } from "./readers-testkit.ts";
import { type LakeKind, type LakeServe, lakeReady, lakeSession, startLakeServe, written } from "./lake-serve-testkit.ts";

const ready = lakeReady();
if (!ready.ready) console.warn(`[lake-serve-mode.test] SKIPPING the server-mode-over-a-lake tests: ${ready.skipReason}`);
const maybe = ready.ready ? describe : describe.skip;

let lakeRig: LakeRig;
const rigs = new Rigs();
beforeAll(async () => {
  if (ready.ready) lakeRig = await startLakeRig();
}, 120_000);
afterAll(async () => {
  await rigs.close();
  await lakeRig?.stop();
});

const ORDERS = (n: number) => `-- description: orders\n-- key: id\nSELECT range AS id, range % 7 AS k, 'o' || range AS note FROM range(${n})\n`;

/** A croft run in the lake project: the next commit of the lake. */
async function run(s: LakeServe, asset = "orders"): Promise<void> {
  const r = await cli(["run", asset, "--foreground", "--json"], { cwd: s.l.p.root, env: s.l.env });
  expect(r.exit, r.stdout).toBe(0);
}

for (const kind of ["local", "postgres"] as LakeKind[]) {
  maybe(`keys over HTTP on server mode over a ${kind} lake`, () => {
    let s: LakeServe;
    let alice: string;
    beforeAll(async () => {
      s = await startLakeServe(kind, { extensionDir: ready.dir, lakeRig, rigs });
      alice = s.rig.key("alice");
    }, 180_000);

    test("a key reads a shared table, and the answer says which snapshot it could have read; no copy is made", async () => {
      const a = await s.rig.call(alice, "SELECT count(*) AS n FROM orders");
      expect(a.status).toBe(200);
      expect(a.json.data.rows).toEqual([{ n: 20 }]);
      const b = await s.rig.call(alice, "SELECT id, name FROM customers ORDER BY id LIMIT 2");
      expect(b.json.data.rows).toEqual([{ id: 0, name: "c0" }, { id: 1, name: "c1" }]);
      expect(Object.keys(a.json.data)).not.toContain("tables");
      // The newest snapshot's time, in the project offset, on every answer, and the app token's too.
      expect(a.json.data.asOf).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?-0[78]:00$/);
      const t = await s.rig.call(TOKEN, "SELECT count(*) AS n FROM payments");
      expect(t.json.data.rows).toEqual([{ n: 8 }]);
      expect(t.json.data.asOf).toBe(a.json.data.asOf);
      expect(t.json.data.stale).toBeUndefined();
      // No copy: no file for it, and the status says so.
      expect(readdirSync(s.l.p.root).filter((f) => /\.read\.duckdb/.test(f))).toEqual([]);
      expect(s.l.project.config.readCopy).toBe(false);
      expect(s.engine.status().serverMode).toMatchObject({ state: "open", copy: null, swaps: 0, makingCopy: false, copyCost: null, restarts: 0 });
      expect(s.engine.status().writeIntent).toBeNull();
    });

    test("the queries a person needs all work", async () => {
      for (const q of ALLOWED) {
        const a = await s.rig.call(alice, q.sql);
        expect(a.status, `${q.label}: ${q.sql} -> ${JSON.stringify(a.json.problems)}`).toBe(200);
      }
    });

    test("SHOW TABLES lists the shared tables and nothing else; the app token sees every table of the lake", async () => {
      expect((await s.rig.call(alice, "SHOW TABLES")).json.data.rows).toEqual([{ name: "customers" }, { name: "orders" }]);
      const token = await s.rig.call(TOKEN, "SHOW TABLES");
      expect(token.json.data.rows.map((x: { name: string }) => x.name)).toEqual(expect.arrayContaining(["orders", "customers", "payments", "secrets"]));
      for (const sql of ["SELECT value FROM secrets", "SELECT count(*) AS n FROM orders o JOIN payments p ON o.id = p.id"]) {
        expect((await s.rig.call(TOKEN, sql)).status, sql).toBe(200);
      }
      // croft's own records stay out of reach of the token's gate, as on a file.
      expect((await s.rig.call(TOKEN, "SELECT * FROM _croft.assets_log")).status).toBe(400);
    });

    test("a table that is not shared is refused as if it did not exist, in the same words as one that does not", async () => {
      const real = await s.rig.call(alice, "SELECT * FROM payments");
      const absent = await s.rig.call(alice, "SELECT * FROM no_such_table");
      expect(real.status).toBe(400);
      expect(absent.status).toBe(400);
      const words = (x: typeof real, name: string) => ({ ...x.json.problems[0], message: x.json.problems[0].message.replaceAll(name, "<name>") });
      expect(words(real, "payments")).toEqual(words(absent, "no_such_table"));
      expect(JSON.stringify(real.json)).not.toMatch(/secrets|_croft|Did you mean/);
    });

    test("a CTE named after a hidden table gets the same answer as one named after nothing: status, words, position and rows", async () => {
      const same = (v: unknown, name: string) => JSON.stringify(v).replace(new RegExp(name, "gi"), "<name>");
      const strip = (j: any) => ({ ...j, durationMs: 0, data: j.data && { ...j.data, tookMs: 0 } });
      let ok = 0;
      let refused = 0;
      for (const hidden of HIDDEN_NAMES) {
        const absent = absentFor(hidden);
        for (const shape of CTE_SHAPES) {
          const a = await s.rig.call(alice, shape.sql(hidden));
          const b = await s.rig.call(alice, shape.sql(absent));
          const what = `${shape.label}: ${shape.sql(hidden)}`;
          expect(a.status, what).toBe(b.status);
          expect(same(strip(a.json), hidden), what).toBe(same(strip(b.json), absent));
          if (a.status === 200) ok++;
          else refused++;
        }
      }
      expect(ok).toBeGreaterThan(10);
      expect(refused).toBeGreaterThan(5);
    });

    test("the whole attack list is refused with a key, with the lake's own, and nothing is written to the project or the lake's folder (acceptance 4)", async () => {
      const bucket = s.l.bucket;
      const attacks = [...ALL_ATTACKS, ...[...lakeAttacks(bucket), ...lakeReaderAttacks(bucket)].flatMap(variants)];
      const before = written(s.l);
      const snapshots = await lakeSession(s, { extensionDir: ready.dir });
      const snapshotsBefore = await snapshots.run("SELECT count(*) FROM lake.snapshots()");
      const wrong: string[] = [];
      for (const q of attacks) {
        const a = await s.rig.call(alice, q.sql);
        if (a.status === 200) wrong.push(`${q.label}: ${q.sql}`);
        else if (a.status !== 400) wrong.push(`${q.label}: status ${a.status} ${JSON.stringify(a.json.problems?.[0]?.code)}`);
      }
      expect(wrong).toEqual([]);
      expect(attacks.length).toBeGreaterThan(450);
      expect(written(s.l)).toEqual(before);
      expect(await snapshots.run("SELECT count(*) FROM lake.snapshots()")).toEqual(snapshotsBefore);
      snapshots.close();
      // Still the same rows afterwards, for the key and for the token.
      expect((await s.rig.call(alice, "SELECT count(*) AS n FROM orders")).json.data.rows).toEqual([{ n: 20 }]);
      expect((await s.rig.call(TOKEN, "SELECT count(*) AS n FROM payments")).json.data.rows).toEqual([{ n: 8 }]);
      expect(s.engine.status().serverMode).toMatchObject({ state: "open", restarts: 0 });
    }, 240_000);

    test("the lake's own attacks are refused for the app token too, as on a lake without server mode", async () => {
      const wrong: string[] = [];
      for (const q of lakeAttacks(s.l.bucket).flatMap(variants)) {
        const a = await s.rig.call(TOKEN, q.sql);
        if (a.status !== 400) wrong.push(`${q.label}: ${q.sql} -> ${a.status}`);
      }
      expect(wrong).toEqual([]);
    }, 120_000);

    test("a removed key is refused on its next request; other keys and the app token are unaffected", async () => {
      const bob = s.rig.key("bob");
      const carol = s.rig.key("carol");
      for (const k of [bob, carol, alice]) expect((await s.rig.call(k, "SELECT 1")).status).toBe(200);
      s.rig.keys.remove("bob");
      const refused = await s.rig.call(bob, "SELECT 1");
      expect(refused.status).toBe(401);
      expect(refused.json.problems[0].code).toBe("SERVE_UNAUTHORIZED");
      expect((await s.rig.call(carol, "SELECT 1")).status).toBe(200);
      expect((await s.rig.call(alice, "SELECT 1")).status).toBe(200);
      expect((await s.rig.call(TOKEN, "SELECT 1")).status).toBe(200);
      s.rig.keys.remove("carol");
    });

    test("a key is for /query only: /status and /health need the app token, and /health says it is server mode over a lake", async () => {
      for (const path of ["/status", "/health"]) {
        const a = await s.rig.call(alice, "", {}, path);
        expect(a.status, path).toBe(403);
        expect((await s.rig.call(TOKEN, "", {}, path)).status, path).toBe(200);
      }
      const health = (await s.rig.call(TOKEN, "", {}, "/health")).json;
      expect(health).toMatchObject({ ok: true, writeIntent: null, serverMode: { state: "open", quack: expect.stringMatching(/^quack:127\.0\.0\.1:\d+$/) } });
      expect(health.serverMode.asOf).toBeString();
      expect(health.degraded).toBeUndefined();
    });

    test("one log line per key query: the key's name, the tables it read, rows and time; never the SQL or the key", async () => {
      s.rig.log.length = 0;
      await s.rig.call(alice, "SELECT o.id FROM orders o JOIN customers c ON o.id = c.id WHERE o.id < 3");
      await s.rig.call(alice, "SELECT * FROM payments");
      await s.rig.call(TOKEN, "SELECT count(*) FROM orders"); // the app token is not a key query
      expect(s.rig.log.map((e) => ({ key: e.key, tables: e.tables, rows: e.rows, outcome: e.outcome }))).toEqual([
        { key: "alice", tables: ["orders", "customers"], rows: 3, outcome: "ok" },
        { key: "alice", tables: [], rows: 0, outcome: "QUERY_PATH_DENIED" },
      ]);
      for (const e of s.rig.log) expect(JSON.stringify(e)).not.toContain(alice);
    });

    test("the engine itself refuses a key's query when the project shares nothing, and the HTTP layer refuses it before the body is read", async () => {
      const e = await s.engine.query({ sql: "SELECT 1", params: [], limit: 10, scope: { key: "alice", tables: [] } }).catch((x: Error) => x);
      expect((e as CroftError).code).toBe("SERVE_NO_SHARED_TABLES");
      const none = await rigs.rig({ ...s.l.p, database: s.l.project.paths.database } as never, s.engine, { sharedTables: [] });
      const k = none.key("erin");
      for (const sql of ["SELECT 1", "SELECT * FROM orders", "SHOW TABLES"]) {
        const a = await none.call(k, sql);
        expect(a.status, sql).toBe(403);
        expect(a.json.problems[0].code).toBe("SERVE_NO_SHARED_TABLES");
      }
      expect((await none.call(TOKEN, "SELECT count(*) AS n FROM orders")).status).toBe(200);
    });
  });
}

for (const kind of ["local", "postgres"] as LakeKind[]) {
  maybe(`what a commit does to server mode over a ${kind} lake (option 07, slice 5, acceptance 2 and 3)`, () => {
    let s: LakeServe;
    let alice: string;
    beforeAll(async () => {
      s = await startLakeServe(kind, { extensionDir: ready.dir, lakeRig, rigs });
      alice = s.rig.key("alice");
    }, 180_000);

    test("a person sees each commit on the next query, with no copy made, and the answer's as-of time follows the snapshot", async () => {
      const asOf = async () => (await s.rig.call(alice, "SELECT 1")).json.data.asOf as string;
      const before = await asOf();
      expect((await s.rig.call(alice, "SELECT count(*) AS n FROM orders")).json.data.rows).toEqual([{ n: 20 }]);
      let last = before;
      for (const n of [25, 31, 40]) {
        writeFileSync(join(s.l.p.root, "assets/orders.sql"), ORDERS(n));
        await run(s);
        // The very next queries, from the token and from the key: the commit is in them.
        expect((await s.rig.call(alice, "SELECT count(*) AS n FROM orders")).json.data.rows, `${n} rows for the key`).toEqual([{ n }]);
        expect((await s.rig.call(TOKEN, "SELECT count(*) AS n FROM orders")).json.data.rows, `${n} rows for the token`).toEqual([{ n }]);
        const now = await asOf();
        expect(Date.parse(now), "the as-of time moved on").toBeGreaterThan(Date.parse(last));
        last = now;
      }
      expect(readdirSync(s.l.p.root).filter((f) => /\.read\.duckdb/.test(f))).toEqual([]);
      expect(s.engine.status().serverMode).toMatchObject({ swaps: 0, restarts: 0, copy: null });
    }, 120_000);

    test("a shared table a run makes appears for a key on its next query, and one a run drops is gone; a new column is read at once", async () => {
      const second = await startLakeServe(kind, { extensionDir: ready.dir, lakeRig, rigs, shared: [...SHARED, "extras"] });
      const key = second.rig.key("alice");
      expect((await second.rig.call(key, "SELECT * FROM extras")).status).toBe(400); // shared, and not built yet: a table that is not there
      expect((await second.rig.call(key, "SHOW TABLES")).json.data.rows).toEqual([{ name: "customers" }, { name: "orders" }]);
      writeFileSync(join(second.l.p.root, "assets/extras.sql"), "-- description: extras\n-- key: id\nSELECT range AS id FROM range(4)\n");
      await run(second, "extras");
      expect((await second.rig.call(key, "SELECT count(*) AS n FROM extras")).json.data.rows).toEqual([{ n: 4 }]);
      expect((await second.rig.call(key, "SHOW TABLES")).json.data.rows).toEqual([{ name: "customers" }, { name: "extras" }, { name: "orders" }]);
      // A column the next run adds is read by the view at once.
      writeFileSync(join(second.l.p.root, "assets/extras.sql"), "-- description: extras\n-- key: id\nSELECT range AS id, 'x' || range AS label FROM range(4)\n");
      await run(second, "extras");
      expect((await second.rig.call(key, "SELECT label FROM extras WHERE id = 2")).json.data.rows).toEqual([{ label: "x2" }]);
      // A table dropped from the lake (croft delete is a person's word; this is a writer of the lake without croft's help) is gone for the key.
      const lakeWriter = await lakeWriterSession(second);
      await lakeWriter.run("DROP TABLE main.extras");
      await lakeWriter.close();
      expect((await second.rig.call(key, "SELECT count(*) AS n FROM extras")).status).toBe(400);
      expect((await second.rig.call(key, "SHOW TABLES")).json.data.rows).toEqual([{ name: "customers" }, { name: "orders" }]);
    }, 180_000);

    test("the readers' process's attach refuses a write, and a write by the project's own writer does not wait for it (acceptance 2)", async () => {
      const g = await lakeSession(s, { readers: true, extensionDir: ready.dir });
      try {
        for (const sql of ["INSERT INTO main.orders (id, k, note) VALUES (1, 1, 'x')", "UPDATE main.orders SET k = 0", "DELETE FROM main.orders", "CREATE TABLE main.evil AS SELECT 1 AS a", "DROP TABLE main.orders", "ALTER TABLE main.orders ADD COLUMN z INT"]) {
          expect(await g.error(sql), sql).toMatch(/read-only|read only/i);
        }
        expect(Number((await g.run("SELECT count(*) FROM main.orders"))[0]![0])).toBeGreaterThan(0);
      } finally {
        g.close();
      }
      // A run writes on, and the readers' process does not stand in its way (a hang would end at this test's timeout).
      writeFileSync(join(s.l.p.root, "assets/orders.sql"), ORDERS(50));
      await run(s);
      expect((await s.rig.call(alice, "SELECT count(*) AS n FROM orders")).json.data.rows).toEqual([{ n: 50 }]);
    }, 120_000);

    test("a key reads only the shared tables, while a reader holding the catalog login and bucket key still attaches the lake directly and reads every table (acceptance 3)", async () => {
      const direct = await lakeSession(s, { extensionDir: ready.dir });
      try {
        expect(Number((await direct.run("SELECT count(*) FROM payments"))[0]![0])).toBe(8);
        expect(await direct.run("SELECT name, value FROM secrets")).toEqual([["token", "hunter2"]]);
        expect(Number((await direct.run("SELECT count(*) FROM orders"))[0]![0])).toBeGreaterThan(0);
      } finally {
        direct.close();
      }
      expect((await s.rig.call(alice, "SELECT * FROM payments")).status).toBe(400);
      expect((await s.rig.call(alice, "SELECT * FROM secrets")).status).toBe(400);
    });

    test("the engine answers a key's query itself with the snapshot's time and the tables it read", async () => {
      const e = await s.engine.query({ sql: "SELECT count(*) AS n FROM orders", params: [], limit: 10, scope: { key: "alice", tables: [...SHARED] } });
      expect(e.rows[0]!.n).toBeGreaterThan(0);
      expect(e.asOf).toBeString();
      expect(e.tables).toEqual(["orders"]);
    });
  });
}

for (const kind of ["local", "postgres"] as LakeKind[]) {
  maybe(`the readers' process over a ${kind} lake: a write, the deadline and a stop (option 06, slice 2 over a lake)`, () => {
    test("100 HTTP queries, the token's and a key's, during a 10 s write step all answer from the last snapshot at once: no step-aside, no 503", async () => {
      const s = await startLakeServe(kind, { extensionDir: ready.dir, lakeRig, rigs });
      const alice = s.rig.key("alice");
      const lake = lakeConnection(s.l.project, s.env(), { extensionDir: ready.dir })!;
      const w = openWarehouse({
        path: s.l.project.paths.database, mode: "read_write", timezone: s.l.project.timezone, root: s.l.p.root, stateDir: s.l.project.paths.stateDir, lake,
        register: false, isTTY: false,
      });
      let inside!: () => void;
      const entered = new Promise<void>((resolve) => (inside = resolve));
      const held = w.write("a long write", async (tx) => {
        await tx.exec("INSERT INTO orders (id, k, note) SELECT 1000 + range, 0, 'new' FROM range(5)");
        inside();
        await Bun.sleep(10_000);
      }, { runId: "r_long", asset: "orders" });
      await entered;
      let settled = false;
      void held.finally(() => { settled = true; });
      const statuses: number[] = [];
      const counts = new Set<number>();
      for (let i = 0; i < 100; i += 4) {
        const batch = await Promise.all(Array.from({ length: 4 }, (_, j) => s.rig.call(j % 2 === 0 ? TOKEN : alice, "SELECT count(*) AS n FROM orders")));
        for (const x of batch) {
          statuses.push(x.status);
          if (x.status === 200) counts.add(Number(x.json.data.rows[0].n));
        }
      }
      expect(statuses).toHaveLength(100);
      expect(statuses.every((x) => x === 200), `statuses: ${[...new Set(statuses)].join(", ")}`).toBe(true);
      expect([...counts]).toEqual([20]); // the last snapshot, whole: the uncommitted five rows are never seen
      expect(settled, "all 100 were answered while the write step was still running").toBe(false);
      expect(s.engine.status()).toMatchObject({ state: "open", writeIntent: null, serverMode: { state: "open", restarts: 0 } });
      await held;
      expect((await s.rig.call(alice, "SELECT count(*) AS n FROM orders")).json.data.rows).toEqual([{ n: 25 }]); // the commit is in the next query
      await w.close();
      await closeAllWarehouses();
    }, 120_000);

    test("a query past the deadline ends with the readers' process; a replacement serves the next query; a write in progress completes untouched", async () => {
      const exits: number[] = [];
      const s = await startLakeServe(kind, { extensionDir: ready.dir, lakeRig, rigs, engine: { queryTimeoutMs: 300, killAfterMs: 200, hooks: { exited: (x) => exits.push(x.pid) } } });
      const alice = s.rig.key("alice");
      const first = s.engine.status().serverMode!.workerPid!;
      const lake = lakeConnection(s.l.project, s.env(), { extensionDir: ready.dir })!;
      const w = openWarehouse({
        path: s.l.project.paths.database, mode: "read_write", timezone: s.l.project.timezone, root: s.l.p.root, stateDir: s.l.project.paths.stateDir, lake,
        register: false, isTTY: false,
      });
      const held = w.write("a write beside the deadline", async (tx) => {
        await tx.exec("INSERT INTO orders (id, k, note) SELECT 2000 + range, 0, 'late' FROM range(3)");
        await Bun.sleep(3000);
      }, { runId: "r_beside", asset: "orders" });
      const t = Date.now();
      const stuck = await s.rig.call(alice, STUCK);
      expect(stuck.status).toBe(500);
      expect(stuck.json.problems[0].code).toBe("TIMEOUT");
      expect(Date.now() - t).toBeLessThan(STUCK_MS / 2); // timing-gap: the stuck query runs STUCK_MS or more; the deadline ends it with its process
      await until("the old process to exit", () => exits.includes(first));
      await until("the replacement to open", () => s.engine.status().serverMode?.state === "open", 30_000);
      expect(s.engine.status().serverMode).toMatchObject({ restarts: 1 });
      expect(s.engine.status().serverMode!.workerPid).not.toBe(first);
      expect(() => process.kill(first, 0)).toThrow();
      expect((await s.rig.call(alice, "SELECT count(*) AS n FROM orders")).json.data.rows).toEqual([{ n: 20 }]);
      // The writer never noticed: it commits its step, and the next query has its rows.
      await held;
      expect((await s.rig.call(alice, "SELECT count(*) AS n FROM orders")).json.data.rows).toEqual([{ n: 23 }]);
      await w.close();
      await closeAllWarehouses();
    }, 120_000);

    test("stopping the engine ends the readers' process first, even with a query running", async () => {
      const s = await startLakeServe(kind, { extensionDir: ready.dir, lakeRig, rigs });
      const alice = s.rig.key("alice");
      const pid = s.engine.status().serverMode!.workerPid!;
      const running = s.rig.call(alice, STUCK);
      await until("the query to run", () => s.engine.status().inFlight === 1);
      const t = Date.now();
      await s.engine.close();
      expect(Date.now() - t).toBeLessThan(STUCK_MS / 2); // timing-gap: the stuck query runs STUCK_MS or more; stopping ends its process first
      expect((await running).status).toBe(503);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(s.engine.status().state).toBe("stopped");
    }, 120_000);
  });
}

/** One `list_reduce` over 20M values: an interrupt cannot stop it, so only the end of its process does (tests/timing-gap.ts STUCK_MS). */
const STUCK = "SELECT list_reduce(range(n), lambda a, b: a + b) AS x FROM (SELECT 20000000::BIGINT AS n)";

/** The project's own writer, to change the lake behind croft's back (a table dropped, which no croft command does). */
async function lakeWriterSession(s: LakeServe) {
  const { lakeConnection } = await import("../db/lake.ts");
  const { connect, openMemoryInstance } = await import("../db/connect.ts");
  const lake = lakeConnection(s.l.project, s.env(), { extensionDir: ready.dir })!;
  const instance = await openMemoryInstance();
  const conn = await connect(instance, {
    profile: "warehouse", timezone: "UTC", root: s.l.p.root, stateDir: s.l.project.paths.stateDir, mode: lake.mode("write"),
  }, `:memory:writer-${Math.random().toString(36).slice(2)}`);
  await conn.run("USE lake");
  return {
    async run(sql: string) {
      await conn.run(sql);
    },
    async close() {
      conn.disconnectSync();
      instance.closeSync();
    },
  };
}
