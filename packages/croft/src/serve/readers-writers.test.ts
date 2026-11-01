// Server mode and croft's writers (DESIGN.md D119; option 06, slice 2): croft serve never holds the live file, so a writer
// never waits for it and a query never waits for a writer; a query past its deadline ends with the readers' process, and
// a write in progress at that moment is untouched. Real readers' processes and real writer processes, all children of the
// test and killed in teardown.
import { afterAll, describe, expect } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { closeAllWarehouses } from "../db/warehouse.ts";
import { cleanup, seed, spawnWriter, type TempProject } from "../read/testkit.ts";
import { ask, count, extensionFiles, openEngine, project, rejection, replaceCopy, until } from "./readers-testkit.ts";
import { type RunningServer, startServer } from "./server.ts";
import type { ServeEngine, ServeQueryData } from "./types.ts";

const CI = process.env.CROFT_CI === "1";
const { ext, withExt } = extensionFiles("readers-writers.test");
const engines: ServeEngine[] = [];
const servers: RunningServer[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop(true).catch(() => {});
  for (const e of engines) await e.close().catch(() => {});
  await closeAllWarehouses();
  cleanup();
});
const engine = (p: TempProject, o: Parameters<typeof openEngine>[3] = {}) => openEngine(engines, ext.dir, p, o);
const intents = (p: TempProject) => (existsSync(join(p.stateDir, "write-intent.d")) ? readdirSync(join(p.stateDir, "write-intent.d")) : []);

/** Rows of the live warehouse through a private read-only instance, closed at once (no engine holds the file). */
async function liveRows(p: TempProject, sql: string): Promise<Record<string, unknown>[]> {
  const db = await DuckDBInstance.create(p.database, { access_mode: "READ_ONLY" });
  const c = await db.connect();
  try {
    return (await c.runAndReadAll(sql)).getRowObjectsJS() as Record<string, unknown>[];
  } finally {
    c.disconnectSync();
    db.closeSync();
  }
}

// A query that interrupts cannot stop for seconds (one list_reduce call over 20M values; p.n = 20000000).
const STUCK = "SELECT list_reduce(range(n), lambda a, b: a + b) AS x FROM p";

describe("the live file", () => {
  withExt("croft serve never holds it: a writer opens it at once, and no write intent is made for serve", async () => {
    const p = await project({ n: 10 });
    const e = await engine(p);
    expect(await count(e)).toBe(10);
    // A read-write open needs the lock: it succeeds only if nobody holds the file, the readers' process included.
    const t = performance.now();
    await seed(p.database, ["INSERT INTO orders VALUES (999, 0)"]);
    expect(performance.now() - t).toBeLessThan(2000);
    expect(intents(p)).toEqual([]);
    // The copy has not changed, and neither has what serve answers.
    expect(await count(e)).toBe(10);
  });

  withExt("a croft writer's lease does not step the server aside: 100 HTTP queries during a 10 s write step all answer from the copy at once", async () => {
    const p = await project({ n: 10, asOf: "2026-10-30T10:00:00Z" });
    const e = await engine(p);
    const server = startServer({ engine: e, host: "127.0.0.1", port: 0, token: "tok-for-tests", allowOrigins: [], root: p.root, database: "warehouse.duckdb", timezone: "America/Los_Angeles" });
    servers.push(server);
    const writer = spawnWriter(p, "w1", 10_000);
    await writer.waitFor("acquired");
    const statuses: number[] = [];
    let slowestMs = 0;
    const asked = async (i: number) => {
      const t = performance.now();
      const r = await fetch(`${server.url}/query`, {
        method: "POST", headers: { Authorization: "Bearer tok-for-tests", "Content-Type": "application/json" },
        body: JSON.stringify({ sql: `SELECT count(*) AS n, ${i} AS i FROM orders` }),
      });
      const body = (await r.json()) as { data: ServeQueryData };
      slowestMs = Math.max(slowestMs, performance.now() - t);
      statuses.push(r.status);
      expect(body.data.rows).toEqual([{ n: 10, i }]);
      expect(body.data.asOf).toBe("2026-10-30T03:00:00-07:00");
      expect((body.data as { stale?: true }).stale).toBeUndefined();
    };
    const started = performance.now();
    for (let i = 0; i < 100; i += 4) await Promise.all([i, i + 1, i + 2, i + 3].map(asked));
    expect(statuses).toHaveLength(100);
    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(slowestMs).toBeLessThan(CI ? 3000 : 1500);
    // All of them were answered while the writer still held the file.
    expect(performance.now() - started).toBeLessThan(9000);
    expect(intents(p)).toHaveLength(1);
    await writer.waitFor("released", 20_000);
    // The run ends with a refresh; the next query sees its rows.
    await replaceCopy(p, 11, "2026-10-30T11:00:00Z");
    await until("the new rows", async () => (await count(e)) === 11);
    expect(e.status().serverMode).toMatchObject({ restarts: 0 });
  }, 60_000);
});

describe("the deadline", () => {
  withExt("a query past it ends with the readers' process; a replacement serves the next query; a write in progress completes untouched", async () => {
    const p = await project({ n: 10, also: ["CREATE TABLE t AS SELECT range AS n FROM range(5)", "CREATE TABLE p AS SELECT 20000000::BIGINT AS n"] });
    const exits: number[] = [];
    const e = await engine(p, { queryTimeoutMs: 300, killAfterMs: 200, hooks: { exited: (x) => exits.push(x.pid) } });
    const first = e.status().serverMode!.workerPid!;
    const writer = spawnWriter(p, "w2", 4000);
    await writer.waitFor("acquired");
    const t = Date.now();
    const err = await rejection(ask(e, STUCK));
    expect(err.code).toBe("TIMEOUT");
    expect(Date.now() - t).toBeLessThan(300 + 1500 + (CI ? 600 : 0));
    // The process that held the stuck query is gone, and another serves.
    await until("the old process to exit", () => exits.includes(first));
    await until("the replacement to open", () => e.status().serverMode?.state === "open");
    expect(e.status().serverMode).toMatchObject({ restarts: 1 });
    expect(e.status().serverMode!.workerPid).not.toBe(first);
    expect(() => process.kill(first, 0)).toThrow();
    expect(await count(e, "t")).toBe(5);
    // The writer never noticed: it finishes its step and its row is in the live file.
    await writer.waitFor("released", 20_000);
    expect(await liveRows(p, "SELECT who FROM log")).toEqual([{ who: "w2" }]);
  }, 60_000);

  withExt("a query beside a killed one is told to retry (503, restarted), and the next ones run", async () => {
    const p = await project({ n: 10, also: ["CREATE TABLE t AS SELECT range AS n FROM range(5)", "CREATE TABLE p AS SELECT 20000000::BIGINT AS n"] });
    const e = await engine(p, { queryTimeoutMs: 300, killAfterMs: 200 });
    const stuck = rejection(ask(e, STUCK));
    const beside = rejection(ask(e, "SELECT sum(a.range * b.range) AS s FROM range(10000000) a, range(1000000) b"));
    expect((await stuck).code).toBe("TIMEOUT");
    const other = await beside;
    expect(["SERVE_UNAVAILABLE", "TIMEOUT"]).toContain(other.code);
    if (other.code === "SERVE_UNAVAILABLE") {
      expect(other.problem.retryable).toBe(true);
      expect(other.problem.details).toMatchObject({ reason: "restarted" });
    }
    await until("the replacement to open", () => e.status().serverMode?.state === "open");
    expect(await count(e, "t")).toBe(5);
  }, 60_000);

  withExt("stopping the engine ends the readers' process first, even with a query running", async () => {
    const p = await project({ n: 10, also: ["CREATE TABLE p AS SELECT 20000000::BIGINT AS n"] });
    const e = await engine(p);
    const pid = e.status().serverMode!.workerPid!;
    const running = rejection(ask(e, STUCK));
    await until("the query to run", () => e.status().inFlight === 1);
    const t = Date.now();
    await e.close();
    expect(Date.now() - t).toBeLessThan(3000);
    expect((await running).code).toBe("SERVE_UNAVAILABLE");
    expect(() => process.kill(pid, 0)).toThrow();
    expect(e.status().state).toBe("stopped");
  }, 60_000);
});
