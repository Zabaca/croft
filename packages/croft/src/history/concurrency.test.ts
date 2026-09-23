// Multi-process tests: real child processes share one runs.sqlite (and, for the crash test, one
// DuckDB file) with this test process.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DuckDBInstance, type DuckDBValue } from "@duckdb/node-api";
import { CroftError } from "../core/errors.ts";
import type { Sql, Warehouse } from "../core/types.ts";
import { acquire, holderOf, listLeases, tryAcquire } from "./leases.ts";
import { reconcile } from "./reconcile.ts";
import { RunsDb } from "./runs-db.ts";

const RUNS_DB = JSON.stringify(join(import.meta.dir, "runs-db.ts"));
const LEASES = JSON.stringify(join(import.meta.dir, "leases.ts"));
const DUCKDB = JSON.stringify(Bun.resolveSync("@duckdb/node-api", import.meta.dir));

let scripts: string;
let dir: string;
let children: ChildProcess[] = [];

beforeAll(() => {
  scripts = mkdtempSync(join(tmpdir(), "croft-scripts-"));
});
afterAll(() => {
  rmSync(scripts, { recursive: true, force: true });
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "croft-conc-"));
});
afterEach(() => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  children = [];
  rmSync(dir, { recursive: true, force: true });
});

function script(name: string, body: string): string {
  const path = join(scripts, `${name}.ts`);
  writeFileSync(path, `import { RunsDb } from ${RUNS_DB};\nimport * as leases from ${LEASES};\n${body}`);
  return path;
}

interface Child { proc: ChildProcess; lines: AsyncIterator<string>; exited: Promise<{ code: number | null; signal: string | null }> }

function run(path: string, ...args: string[]): Child {
  const proc = spawn(process.execPath, [path, ...args], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(proc);
  const lines = createInterface({ input: proc.stdout! })[Symbol.asyncIterator]();
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) => proc.on("exit", (code, signal) => r({ code, signal })));
  return { proc, lines, exited };
}

async function nextJson<T>(c: Child): Promise<T> {
  const r = await c.lines.next();
  if (r.done) throw new Error("child exited without output");
  return JSON.parse(r.value) as T;
}

describe("leases across processes", () => {
  const holder = () => script("holder", `
    const [stateDir, asset] = process.argv.slice(2);
    const db = RunsDb.open(stateDir);
    const run = db.createRun({ trigger: "schedule", human: false, argv: ["run", "--due"] });
    await leases.acquire(db, asset, run.id, { noWait: true });
    console.log(JSON.stringify({ runId: run.id, pid: process.pid }));
    setInterval(() => {}, 1000);   // hold until killed
  `);

  test("a live child's lease blocks us, naming its run; after kill -9 it is reclaimed", async () => {
    const child = run(holder(), dir, "orders");
    const { runId, pid } = await nextJson<{ runId: string; pid: number }>(child);
    const db = RunsDb.open(dir);
    try {
      let err: unknown;
      try {
        await acquire(db, "orders", "r_me", { noWait: true });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CroftError);
      expect((err as CroftError).problem).toMatchObject({ code: "ASSET_BUSY", runId, details: { heldBy: { runId, pid, trigger: "schedule" } } });
      expect((err as CroftError).message).toContain(`a scheduled run ${runId} (pid ${pid})`);

      // reconcile leaves a live run alone
      const idle: Warehouse = { read: async () => { throw new Error("no crashed steps, no read"); }, write: async () => { throw new Error(); }, holder: async () => null };
      expect((await reconcile({ db, warehouse: idle })).crashed).toEqual([]);
      expect(holderOf(db, "orders")?.runId).toBe(runId);

      child.proc.kill("SIGKILL");
      expect((await child.exited).signal).toBe("SIGKILL");
      const [l] = await acquire(db, "orders", "r_me", { noWait: true });
      expect(l).toMatchObject({ runId: "r_me", pid: process.pid });
      expect((await reconcile({ db, warehouse: idle })).crashed).toEqual([runId]);
    } finally {
      db.close();
    }
  }, 20_000);

  test("a waiting acquire gets the asset as soon as the child dies", async () => {
    const child = run(holder(), dir, "orders");
    await nextJson(child);
    const db = RunsDb.open(dir);
    try {
      setTimeout(() => child.proc.kill("SIGKILL"), 300);
      const t0 = Date.now();
      const [l] = await acquire(db, "orders", "r_me", { waitMs: 10_000 });
      expect(l?.runId).toBe("r_me");
      expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
      expect(Date.now() - t0).toBeLessThan(5000);
    } finally {
      db.close();
    }
  }, 20_000);

  test("concurrent tryAcquire from several processes on a fresh database: exactly one wins", async () => {
    const racer = script("racer", `
      const [stateDir, openAt, startAt] = process.argv.slice(2);
      // All open (switch to WAL, migrate) a fresh file at the same instant: before enableWal
      // retried, this failed with SQLITE_BUSY in most rounds despite busy_timeout.
      while (Date.now() < Number(openAt)) {}
      const db = RunsDb.open(stateDir);
      const run = db.createRun({ trigger: "manual", human: true, argv: ["run", "orders"] });
      while (Date.now() < Number(startAt)) await Bun.sleep(1);
      const r = leases.tryAcquire(db, ["orders", "customers"], run.id);
      console.log(JSON.stringify({ runId: run.id, ok: r.ok, busy: r.ok ? [] : r.busy.map((l) => l.runId) }));
      await Bun.sleep(1500);            // keep a winner alive while the others look
    `);
    const openAt = Date.now() + 600;
    const kids = Array.from({ length: 8 }, () => run(racer, dir, String(openAt), String(openAt + 400)));
    const results = await Promise.all(kids.map((k) => nextJson<{ runId: string; ok: boolean; busy: string[] }>(k)));
    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    for (const loser of results.filter((r) => !r.ok)) expect(loser.busy).toEqual([winners[0]!.runId, winners[0]!.runId]);
    const db = RunsDb.open(dir);
    try {
      expect(listLeases(db).map((l) => [l.asset, l.runId])).toEqual([["customers", winners[0]!.runId], ["orders", winners[0]!.runId]]);
      expect(db.listRuns({ limit: 100 })).toHaveLength(8);
    } finally {
      db.close();
    }
    await Promise.all(kids.map((k) => k.exited));
  }, 20_000);

  test("waiting acquirers in several processes take turns: no two ever hold the asset at once", async () => {
    const turn = script("turn", `
      const [stateDir] = process.argv.slice(2);
      const db = RunsDb.open(stateDir);
      const run = db.createRun({ trigger: "manual", human: true, argv: ["run", "orders"] });
      await leases.acquire(db, "orders", run.id, { waitMs: 15_000 });
      const from = Date.now();
      await Bun.sleep(80);
      const to = Date.now();
      leases.release(db, run.id);
      console.log(JSON.stringify({ from, to }));
    `);
    const kids = Array.from({ length: 5 }, () => run(turn, dir));
    const spans = (await Promise.all(kids.map((k) => nextJson<{ from: number; to: number }>(k)))).sort((a, b) => a.from - b.from);
    for (let i = 1; i < spans.length; i++) expect(spans[i]!.from).toBeGreaterThanOrEqual(spans[i - 1]!.to);
    await Promise.all(kids.map((k) => k.exited));
  }, 30_000);
});

describe("runs.sqlite WAL", () => {
  test("a reader keeps reading while another process writes continuously", async () => {
    const writer = script("writer", `
      const [stateDir] = process.argv.slice(2);
      const db = RunsDb.open(stateDir);
      console.log(JSON.stringify({ started: true }));
      for (let i = 0; i < 300; i++) {
        const run = db.createRun({ trigger: "manual", human: true, argv: ["run", "a" + i] });
        db.startStep({ runId: run.id, asset: "a" + i, attempt: 1, reason: "requested" });
        db.finishStep(run.id, "a" + i, 1, { status: "ok", rows: { in: i, added: i, updated: 0 } });
        db.finishRun(run.id, "succeeded");
      }
      console.log(JSON.stringify({ done: true }));
    `);
    const db = RunsDb.open(dir);   // created first so the writer does not race the reader's open
    try {
      const child = run(writer, dir);
      await nextJson(child);
      let reads = 0;
      let last = 0;
      let finished = false;
      child.exited.then(() => { finished = true; });
      while (!finished) {
        const runs = db.listRuns({ limit: 1000 });
        expect(runs.length).toBeGreaterThanOrEqual(last);   // never goes backwards, never errors
        for (const r of runs.slice(0, 3)) db.stepsFor(r.id);
        last = runs.length;
        reads++;
        await Bun.sleep(1);
      }
      expect((await child.exited).code).toBe(0);
      expect(db.listRuns({ limit: 1000 })).toHaveLength(300);
      expect(reads).toBeGreaterThan(5);
    } finally {
      db.close();
    }
  }, 30_000);

  test("an open write transaction blocks neither readers nor (beyond busy_timeout) writers", async () => {
    const holdTx = script("holdtx", `
      const [stateDir] = process.argv.slice(2);
      const db = RunsDb.open(stateDir);
      db.sqlite.exec("BEGIN IMMEDIATE");
      db.createRun({ id: "r_0922_1000_hold", trigger: "manual", human: true, argv: [] });
      console.log(JSON.stringify({ holding: true }));
      Bun.sleepSync(1200);
      db.sqlite.exec("COMMIT");
    `);
    const db = RunsDb.open(dir);
    try {
      const child = run(holdTx, dir);
      await nextJson(child);
      const t0 = performance.now();
      expect(db.listRuns()).toEqual([]);            // uncommitted: invisible, and no waiting
      expect(db.getRun("r_0922_1000_hold")).toBeNull();
      expect(performance.now() - t0).toBeLessThan(250);
      const t1 = performance.now();
      db.createRun({ id: "r_0922_1000_mine", trigger: "manual", human: true, argv: [] });   // waits for COMMIT
      expect(performance.now() - t1).toBeGreaterThan(500);
      expect(db.listRuns().map((r) => r.id).sort()).toEqual(["r_0922_1000_hold", "r_0922_1000_mine"]);
      expect((await child.exited).code).toBe(0);
    } finally {
      db.close();
    }
  }, 20_000);
});

/** A minimal Warehouse over a DuckDB file, opened per read like db/warehouse.ts does. */
function duckWarehouse(path: string, mode: "READ_ONLY" | "READ_WRITE"): Warehouse {
  return {
    async read(fn) {
      const inst = await DuckDBInstance.create(path, { access_mode: mode });
      const conn = await inst.connect();
      const sql: Sql = {
        async all<T>(text: string, params?: unknown[]) {
          return (await conn.runAndReadAll(text, params as DuckDBValue[] | undefined)).getRowObjectsJS() as T[];
        },
        async exec(text: string, params?: unknown[]) {
          await conn.run(text, params as DuckDBValue[] | undefined);
        },
      };
      try {
        return await fn(sql);
      } finally {
        conn.closeSync();
        inst.closeSync();
      }
    },
    async write() {
      throw new Error("not used");
    },
    async holder() {
      return null;
    },
  };
}

describe("crash recovery with a real DuckDB file", () => {
  const crasher = () => script("crasher", `
    import { DuckDBInstance } from ${DUCKDB};
    import { mkdirSync } from "node:fs";
    import { join } from "node:path";
    const [stateDir, warehouse] = process.argv.slice(2);
    const db = RunsDb.open(stateDir);
    const run = db.createRun({ trigger: "manual", human: true, argv: ["run", "orders", "customers"] });
    await leases.acquire(db, ["orders", "customers"], run.id, { noWait: true });
    mkdirSync(join(stateDir, "staging", run.id, "orders"), { recursive: true });
    const inst = await DuckDBInstance.create(warehouse);
    const conn = await inst.connect();
    await conn.run("CREATE SCHEMA _croft");
    await conn.run(\`CREATE TABLE _croft.writes (asset VARCHAR, loaded_at TIMESTAMPTZ, run_id VARCHAR, mode VARCHAR,
      rows_in BIGINT, added BIGINT, updated BIGINT, unchanged BIGINT, deleted BIGINT, cursor_before VARCHAR,
      cursor_after VARCHAR, since_used VARCHAR, inputs JSON, schema_changes JSON, code_hash VARCHAR,
      PRIMARY KEY (asset, loaded_at))\`);
    await conn.run("CREATE TABLE orders (id BIGINT)");
    const write = "INSERT INTO _croft.writes (asset, loaded_at, run_id, mode, rows_in, added, updated) VALUES (?, now(), ?, 'append', ?, ?, 0)";

    // orders: commits, but the process dies before runs.sqlite hears about it
    db.startStep({ runId: run.id, asset: "orders", attempt: 1, reason: "requested" });
    await conn.run("BEGIN TRANSACTION");
    await conn.run("INSERT INTO orders SELECT range FROM range(1000)");
    await conn.run(write, ["orders", run.id, 1000, 1000]);
    await conn.run("COMMIT");

    // customers: dies inside its transaction
    db.startStep({ runId: run.id, asset: "customers", attempt: 1, reason: "requested" });
    await conn.run("BEGIN TRANSACTION");
    await conn.run("CREATE TABLE customers AS SELECT range AS id FROM range(10)");
    await conn.run(write, ["customers", run.id, 10, 10]);
    console.log(JSON.stringify({ runId: run.id }));
    process.kill(process.pid, "SIGKILL");
  `);

  for (const mode of ["READ_WRITE", "READ_ONLY"] as const) {
    test(`a process that commits and then dies: the commit is recovered (${mode} reconcile)`, async () => {
      const whPath = join(dir, "warehouse.duckdb");
      const child = run(crasher(), dir, whPath);
      const { runId } = await nextJson<{ runId: string }>(child);
      expect((await child.exited).signal).toBe("SIGKILL");
      expect(existsSync(`${whPath}.wal`)).toBe(true);   // killed before any checkpoint

      const db = RunsDb.open(dir);
      try {
        expect(db.getRun(runId)?.status).toBe("running");
        const warehouse = duckWarehouse(whPath, mode);
        const r = await reconcile({ db, warehouse });
        expect(r.crashed).toEqual([runId]);
        expect(r.recovered).toEqual([{ runId, asset: "orders", attempt: 1, commits: 1 }]);
        expect(r.lost).toEqual([{ runId, asset: "customers", attempt: 1 }]);
        expect(r.releasedLeases).toEqual(["customers", "orders"]);
        expect(r.stagingDirs).toEqual([join(dir, "staging", runId)]);
        expect(r.problems).toEqual([]);
        expect(db.getStep(runId, "orders", 1)).toMatchObject({ status: "ok", reason: "requested (recovered)", rowsIn: 1000, added: 1000 });
        expect(db.getStep(runId, "customers", 1)?.error?.code).toBe("RUN_CRASHED");
        expect(tryAcquire(db, ["orders", "customers"], "r_next").ok).toBe(true);

        // DuckDB agrees: the committed rows are there, the uncommitted table is not.
        const facts = await warehouse.read(async (sql) => ({
          orders: await sql.all<{ n: bigint }>("SELECT count(*) AS n FROM orders"),
          customers: await sql.all<{ n: bigint }>("SELECT count(*) AS n FROM duckdb_tables() WHERE table_name = 'customers'"),
          writes: await sql.all<{ asset: string }>("SELECT asset FROM _croft.writes"),
        }), { purpose: "test" });
        expect(Number(facts.orders[0]!.n)).toBe(1000);
        expect(Number(facts.customers[0]!.n)).toBe(0);
        expect(facts.writes.map((w) => w.asset)).toEqual(["orders"]);
      } finally {
        db.close();
      }
    }, 30_000);
  }

  test("a crash before the warehouse ever existed loses the step cleanly", async () => {
    const whPath = join(dir, "warehouse.duckdb");
    // an empty warehouse: no _croft schema yet
    const inst = await DuckDBInstance.create(whPath);
    inst.closeSync();
    const db = RunsDb.open(dir);
    try {
      const deadId = { pid: process.pid, procStart: "Mon Jan  1 00:00:00 2001", bootId: "x" };
      const run1 = db.createRun({ trigger: "manual", human: true, argv: [], identity: deadId });
      db.startStep({ runId: run1.id, asset: "orders", attempt: 1, reason: "requested" });
      const r = await reconcile({ db, warehouse: duckWarehouse(whPath, "READ_ONLY") });
      expect(r.lost).toEqual([{ runId: run1.id, asset: "orders", attempt: 1 }]);
      expect(r.problems).toEqual([]);
    } finally {
      db.close();
    }
  });
});
