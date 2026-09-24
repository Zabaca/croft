// croft serve's query worker: answer() in this process (streamed within limit, maxRows and maxBytes), and the
// child process through QueryWorker (open, query, interrupt, kill, what an exit does to waiting requests).
import { afterAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection } from "@duckdb/node-api";
import { CroftError } from "../core/errors.ts";
import { openMemory, serveResources } from "../db/connect.ts";
import { cleanup, makeProject, spawnHolder } from "../read/testkit.ts";
import { QueryWorker, WorkerConflict, WorkerGone, WorkerStopped } from "./query-worker.ts";
import { answer, type AnswerOptions, Stopped } from "./worker.ts";

const workers: QueryWorker[] = [];
afterAll(async () => {
  for (const w of workers) await w.kill();
  cleanup();
});

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
}

const opts = (o: Partial<AnswerOptions> = {}): AnswerOptions => ({
  params: [], limit: 10_000, maxRows: 100_000, maxBytes: 64 * 1024 * 1024, timezone: "UTC", protect: [], checkpoint: () => {}, ...o,
});

describe("answer()", () => {
  let db: Awaited<ReturnType<typeof openMemory>>;
  let conn: DuckDBConnection;

  test("rows as JSON text, in the json rendering, with columns and the count", async () => {
    db = await openMemory({ timezone: "UTC" });
    conn = await db.connect();
    await conn.run("CREATE TABLE t AS SELECT range AS n, -0.0::DOUBLE AS z, 170141183460469231731687303715884105727::HUGEINT AS h FROM range(3)");
    const a = await answer(conn, "SELECT n, z, h FROM t WHERE n < $1 ORDER BY n", opts({ params: [2] }));
    expect(a.columns).toEqual([{ name: "n", type: "BIGINT" }, { name: "z", type: "DOUBLE" }, { name: "h", type: "HUGEINT" }]);
    expect(a.rowCount).toBe(2);
    expect(JSON.parse(a.rowsJson)).toEqual([{ n: 0, z: 0, h: "170141183460469231731687303715884105727" }, { n: 1, z: 0, h: "170141183460469231731687303715884105727" }]);
    expect(a.rowsJson).not.toContain("-0");
    expect((await answer(conn, "SELECT n FROM t WHERE n > 5", opts())).rowsJson).toBe("[]");
  });

  test("more rows than limit, or than maxRows, is QUERY_TOO_MANY_ROWS; the connection runs the next query", async () => {
    const tooMany = await rejection(answer(conn, "SELECT range FROM range(100000000)", opts({ limit: 10 })));
    expect(tooMany).toBeInstanceOf(CroftError);
    expect((tooMany as CroftError).problem.details).toMatchObject({ limit: 10 });
    const capped = await rejection(answer(conn, "SELECT range FROM range(5000)", opts({ limit: 1_000_000, maxRows: 4096 })));
    expect((capped as CroftError).problem.details).toMatchObject({ limit: 1_000_000, maxRows: 4096 });
    expect((capped as CroftError).problem.hint).toContain("OFFSET");
    expect((await answer(conn, "SELECT count(*)::INTEGER AS c FROM t", opts())).rowsJson).toBe('[{"c":3}]');
  });

  test("maxBytes counts the JSON as it is rendered and stops there", async () => {
    const err = (await rejection(answer(conn, "SELECT repeat('x', 100) AS s FROM range(1000000)", opts({ maxBytes: 4096 })))) as CroftError;
    expect(err.code).toBe("QUERY_TOO_MANY_ROWS");
    expect(err.problem.details).toMatchObject({ maxBytes: 4096 });
    expect(err.problem.details?.rowsWithinMaxBytes).toBeLessThan(40);
    const fits = await answer(conn, "SELECT repeat('x', 100) AS s FROM range(30)", opts({ maxBytes: 4096 }));
    expect(fits.rowCount).toBe(30);
  });

  test("a stopped query ends at the next checkpoint; gate and SQL errors keep their codes", async () => {
    let stopped = false;
    const p = answer(conn, "SELECT range FROM range(3000000)", opts({ limit: 5_000_000, maxRows: 5_000_000, checkpoint: () => {
      if (stopped) throw new Stopped();
    } }));
    stopped = true;
    expect(await rejection(p)).toBeInstanceOf(Stopped);
    expect(((await rejection(answer(conn, "SELECT * FROM duckdb_settings()", opts()))) as CroftError).code).toBe("QUERY_PATH_DENIED");
    expect(((await rejection(answer(conn, "SELECT nope FROM t", opts()))) as CroftError).code).toBe("UNKNOWN_COLUMN");
    expect(((await rejection(answer(conn, "SELEC 1", opts()))) as CroftError).code).toBe("SQL_SYNTAX");
    db.close();
  });
});

describe("QueryWorker", () => {
  const spec = (p: Awaited<ReturnType<typeof makeProject>>) => ({
    path: p.database, protect: [p.stateDir],
    spec: { profile: "serve" as const, timezone: "UTC", root: p.root, stateDir: p.stateDir, ...serveResources(), threads: 2 },
  });

  test("opens the file read-only in a child process and answers; kill() frees the file at once", async () => {
    const p = await makeProject({ seed: ["CREATE TABLE t AS SELECT range AS n FROM range(4)"] });
    const w = QueryWorker.spawn();
    workers.push(w);
    expect(w.pid).not.toBe(process.pid);
    await w.open(spec(p));
    expect(w.conns).toBe(1);
    const a = await w.query(1, { sql: "SELECT sum(n)::INTEGER AS s FROM t", params: [], limit: 10, maxRows: 100, maxBytes: 1 << 20 });
    expect(JSON.parse(a.rowsJson)).toEqual([{ s: 6 }]);
    expect(w.peakRss).toBeGreaterThan(0);
    const e = await rejection(w.query(2, { sql: "SELECT * FROM nope", params: [], limit: 10, maxRows: 100, maxBytes: 1 << 20 }));
    expect(e).toBeInstanceOf(CroftError);
    expect((e as CroftError).code).toBe("QUERY_PATH_DENIED");
    expect(await w.disconnect(1000)).toBe(0);
    await w.kill();
    expect(w.alive).toBe(false);
    // Nothing holds the file: a writer gets it.
    const holder = spawnHolder(p.database, 0);
    await holder.waitFor("held", 5000);
  });

  test("an interrupted query reports that it was stopped; a query that interrupts cannot stop fails with WorkerGone when the worker is killed", async () => {
    const p = await makeProject({ seed: ["CREATE TABLE p AS SELECT 20000000::BIGINT AS n"] });
    const w = QueryWorker.spawn();
    workers.push(w);
    await w.open(spec(p));
    const slow = w.query(1, { sql: "SELECT count(*) FROM range(10000000) a, range(1000000) b", params: [], limit: 10, maxRows: 100, maxBytes: 1 << 20 });
    await Bun.sleep(100);
    w.interrupt(1);
    expect(await rejection(slow)).toBeInstanceOf(WorkerStopped);
    const stuck = w.query(2, { sql: "SELECT list_reduce(range(n), (a, b) -> a + b) AS x FROM p", params: [], limit: 10, maxRows: 100, maxBytes: 1 << 20 });
    await Bun.sleep(100);
    const start = Date.now();
    await w.kill();
    const err = await rejection(stuck);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(err).toBeInstanceOf(WorkerGone);
    expect(err.message).toContain("stopped by croft serve");
    expect(await rejection(w.query(3, { sql: "SELECT 1", params: [], limit: 10, maxRows: 100, maxBytes: 1 << 20 }))).toBeInstanceOf(WorkerGone);
  }, 30_000);

  test("a file another process holds is WorkerConflict naming it; a newer format is DB_NEWER_FORMAT", async () => {
    const p = await makeProject({ seed: ["CREATE TABLE t AS SELECT 1 AS n"] });
    const holder = spawnHolder(p.database, 3000);
    await holder.waitFor("held", 5000);
    const w = QueryWorker.spawn();
    workers.push(w);
    const conflict = await rejection(w.open(spec(p)));
    expect(conflict).toBeInstanceOf(WorkerConflict);
    expect((conflict as WorkerConflict).pid).toBe(holder.pid);
    holder.proc.kill("SIGKILL");
    const newer = await makeProject({ seed: ["CREATE SCHEMA _croft", "CREATE TABLE _croft.meta (key VARCHAR PRIMARY KEY, value VARCHAR)", "INSERT INTO _croft.meta VALUES ('format_version', '99')"] });
    const w2 = QueryWorker.spawn();
    workers.push(w2);
    expect(((await rejection(w2.open(spec(newer)))) as CroftError).code).toBe("DB_NEWER_FORMAT");
  });

  test("a worker that cannot start fails ready() and every request with WorkerGone, and calls onExit once", async () => {
    const exits: number[] = [];
    const w = QueryWorker.spawn({ argv: [process.execPath, "-e", "console.error('boom: cannot start'); process.exit(3)"], onExit: (x) => exits.push(x.pid) });
    workers.push(w);
    const err = await rejection(w.ready);
    expect(err).toBeInstanceOf(WorkerGone);
    await w.exited;
    expect(err.message).toContain("exited with code 3");
    expect(exits).toEqual([w.pid]);
    expect(await rejection(w.query(1, { sql: "SELECT 1", params: [], limit: 1, maxRows: 1, maxBytes: 1 }))).toBeInstanceOf(WorkerGone);
  });
});
