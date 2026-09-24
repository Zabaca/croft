// croft serve's query engine against real DuckDB files and real writers in child processes (DESIGN.md §5
// "Server mode"). Timings are measured from the moment the writer's intent appeared (its `since`, stamped just
// before the file is written), so a slow start of a child never counts against the engine. CPU-starved CI runners
// get a margin (CROFT_CI=1); the budgets themselves are DESIGN's.
import { afterAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { bootId, currentIdentity, procStart } from "../core/proc.ts";
import { intentDir, intentFileName } from "../db/intent.ts";
import type { FsProbe } from "../db/fs-kind.ts";
import { directQuery } from "../read/direct.ts";
import { cleanup, makeProject, spawnHolder, spawnIdle, type TempProject, writeIntent } from "../read/testkit.ts";
import { openServeEngine, type ServeEngineHooks, type ServeEngineInternals } from "./instance.ts";
import type { ServeEngine, ServeEngineOptions } from "./types.ts";

const CI = process.env.CROFT_CI === "1";
/** Extra time CPU-starved CI runners get on every timing budget. */
const SLACK = CI ? 600 : 0;
/** The writer child's own share: its 5 ms lock retries and its scheduling, on top of the engine's budget. */
const WRITER_SHARE = 150;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// A query that runs for hours unless interrupted, and passes the serve gate (range() is allowed).
const SLOW = "SELECT sum(a.range * b.range) AS s FROM range(10000000) a, range(1000000) b";

// ---- engines ------------------------------------------------------------------------------------------

interface HookEvent { kind: "steppingAside" | "beforeClose" | "released" | "opened"; at: number; openConnections?: number; reason?: string; pid?: number | null; since?: string }

const engines: ServeEngine[] = [];
const children: ChildProcess[] = [];
const scratch: string[] = [];

afterAll(async () => {
  for (const e of engines) await e.close().catch(() => {});
  for (const c of children) c.kill("SIGKILL");
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  cleanup();
});

async function engine(p: TempProject, o: Partial<ServeEngineOptions & ServeEngineInternals> = {}) {
  const events: HookEvent[] = [];
  const hooks: ServeEngineHooks = {
    steppingAside: (e) => events.push({ kind: "steppingAside", at: e.at, pid: e.intent.pid, since: e.intent.since }),
    beforeClose: (e) => events.push({ kind: "beforeClose", at: e.at, openConnections: e.openConnections, reason: e.reason }),
    released: (e) => events.push({ kind: "released", at: e.at, reason: e.reason, pid: e.intent?.pid ?? null, since: e.intent?.since }),
    opened: (e) => events.push({ kind: "opened", at: e.at }),
  };
  const e = await openServeEngine({ root: p.root, resources: { threads: 2 }, hooks, ...o });
  engines.push(e);
  return { e, events };
}

async function until(what: string, cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** The CroftError `p` rejects with. Call it when the query starts: a handler attached only later would let an
 *  early rejection count as unhandled. */
async function rejection(p: Promise<unknown>): Promise<CroftError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
  throw new Error("expected a CroftError");
}

const q = (sql: string, o: { params?: unknown[]; limit?: number; signal?: AbortSignal } = {}) => ({ sql, params: o.params ?? [], limit: o.limit ?? 10_000, signal: o.signal });

// ---- writers in child processes ------------------------------------------------------------------------

interface Child { proc: ChildProcess; pid: number; events: { event: string; t: number; since?: string }[]; waitFor(event: string, timeoutMs?: number): Promise<{ t: number; since?: string }>; exited: Promise<number | null> }

function track(proc: ChildProcess): Child {
  children.push(proc);
  const events: Child["events"] = [];
  let buf = "";
  let err = "";
  proc.stdout!.on("data", (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        events.push(JSON.parse(line));
      } catch {}
    }
  });
  proc.stderr!.on("data", (d) => (err += String(d)));
  const exited = new Promise<number | null>((r) => proc.on("exit", (code) => r(code)));
  return {
    proc, pid: proc.pid!, events, exited,
    async waitFor(event, timeoutMs = 20_000) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const e = events.find((x) => x.event === event);
        if (e) return e;
        if (Date.now() > end || proc.exitCode !== null) throw new Error(`writer never reported ${event}: ${err}`);
        await sleep(2);
      }
    },
  };
}

function script(name: string, text: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "croft-serve-child-")));
  scratch.push(dir);
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}

// A writer that measures when the file is really free: it announces itself with db/intent.ts (as warehouse.ts
// does), then tries the lock every 5 ms through connect.ts, writes a row, holds, closes, and withdraws.
const PROBE_WRITER = `
const { acquire, release } = await import(process.env.CROFT_INTENT_TS);
const { openInstance, lockConflict } = await import(process.env.CROFT_CONNECT_TS);
const [path, stateDir, label, holdMs] = process.argv.slice(2);
const say = (event, extra = {}) => console.log(JSON.stringify({ event, t: Date.now(), ...extra }));
const intent = acquire(stateDir, { runId: label });
say("intent", { since: intent.since });
let instance;
for (;;) {
  try { instance = (await openInstance(path, "read_write")).instance; break; }
  catch (e) { if (!lockConflict(e)) throw e; await new Promise((r) => setTimeout(r, 5)); }
}
say("acquired");
const c = await instance.connect();
await c.run("CREATE TABLE IF NOT EXISTS log (who VARCHAR)");
await c.run("INSERT INTO log VALUES ('" + label + "')");
await new Promise((r) => setTimeout(r, Number(holdMs)));
c.disconnectSync();
instance.closeSync();
release(stateDir);
say("released");
`;

// A croft writer: warehouse.ts's write lease, with its intent, lock retries and linger.
const WAREHOUSE_WRITER = `
const { openWarehouse } = await import(process.env.CROFT_WAREHOUSE_TS);
const [path, root, stateDir, label, holdMs] = process.argv.slice(2);
const say = (event, extra = {}) => console.log(JSON.stringify({ event, t: Date.now(), ...extra }));
const w = openWarehouse({ path, mode: "read_write", timezone: "UTC", root, stateDir, isTTY: false, waits: { offTtyMs: 20000 }, runId: label });
say("start");
await w.write(label, async (tx) => {
  say("acquired");
  await tx.exec("CREATE TABLE IF NOT EXISTS log (who VARCHAR)");
  await tx.exec("INSERT INTO log VALUES ($1)", [label]);
  await new Promise((r) => setTimeout(r, Number(holdMs)));
}, { runId: label });
await w.close();
say("released");
`;

let probeScript: string | undefined;
let warehouseScript: string | undefined;
const childEnv = () => ({
  ...process.env,
  CROFT_INTENT_TS: join(import.meta.dir, "..", "db", "intent.ts"),
  CROFT_CONNECT_TS: join(import.meta.dir, "..", "db", "connect.ts"),
  CROFT_WAREHOUSE_TS: join(import.meta.dir, "..", "db", "warehouse.ts"),
});

function probeWriter(p: TempProject, label: string, holdMs = 100): Child {
  probeScript ??= script("probe-writer.mjs", PROBE_WRITER);
  return track(spawn(process.execPath, [probeScript, p.database, p.stateDir, label, String(holdMs)], { env: childEnv(), stdio: ["ignore", "pipe", "pipe"] }));
}

function warehouseWriter(p: TempProject, label: string, holdMs = 0): Child {
  warehouseScript ??= script("warehouse-writer.mjs", WAREHOUSE_WRITER);
  return track(spawn(process.execPath, [warehouseScript, p.database, p.root, p.stateDir, label, String(holdMs)], { env: childEnv(), stdio: ["ignore", "pipe", "pipe"] }));
}

const seeded = (o: Parameters<typeof makeProject>[0] = {}) => makeProject({ seed: ["CREATE TABLE t AS SELECT range AS n FROM range(5)"], ...o });

// ---- queries --------------------------------------------------------------------------------------------

describe("queries", () => {
  test("a SELECT on a user table: columns, rows, rowCount and tookMs; an idle connection is kept", async () => {
    const p = await seeded();
    const { e } = await engine(p);
    expect(e.status()).toMatchObject({ state: "open", writeIntent: null, inFlight: 0, queued: 0 });
    const r = await e.query(q("SELECT n, n * 2 AS twice FROM t WHERE n < $1 ORDER BY n", { params: [3] }));
    expect(r.columns).toEqual([{ name: "n", type: "BIGINT" }, { name: "twice", type: "BIGINT" }]);
    expect(r.rows).toEqual([{ n: 0, twice: 0 }, { n: 1, twice: 2 }, { n: 2, twice: 4 }]);
    expect(r.rowCount).toBe(3);
    expect(r.tookMs).toBeGreaterThanOrEqual(0);
    expect((await e.query(q("WITH x AS (SELECT count(*) AS c FROM t) SELECT c FROM x"))).rows).toEqual([{ c: 5 }]);
    // sum() of a BIGINT is a HUGEINT, which JSON carries as a string (§4.3).
    expect((await e.query(q("SELECT sum(range) AS s FROM range(10)"))).rows).toEqual([{ s: "45" }]);
    expect(e.status().openConnections).toBeGreaterThan(0);
  });

  test("queriesToday counts the queries run since midnight in the project's zone", async () => {
    const p = await seeded({ timezone: "America/Los_Angeles" });
    const before = process.env.CROFT_NOW;
    try {
      process.env.CROFT_NOW = "2026-09-24T06:58:00Z"; // 23:58 in Los Angeles
      const { e } = await engine(p);
      expect(e.status().queriesToday).toBe(0);
      await e.query(q("SELECT 1 AS x"));
      await rejection(e.query(q("SELECT * FROM nope"))); // answered with an error: still a query run
      expect(e.status().queriesToday).toBe(2);
      process.env.CROFT_NOW = "2026-09-24T07:01:00Z"; // 00:01, the next day there
      expect(e.status().queriesToday).toBe(0);
      await e.query(q("SELECT 1 AS x"));
      expect(e.status().queriesToday).toBe(1);
    } finally {
      if (before === undefined) delete process.env.CROFT_NOW;
      else process.env.CROFT_NOW = before;
    }
  });

  test("the time zone and offsets render exactly like direct mode", async () => {
    const p = await makeProject({
      timezone: "America/Los_Angeles",
      seed: [`CREATE TABLE ev AS SELECT * FROM (VALUES
        (1, TIMESTAMPTZ '2026-01-15 18:00:00+00', TIMESTAMP '2026-01-15 10:00:00', DATE '2026-01-15', 170141183460469231731687303715884105727::HUGEINT, 12345678901234567.89::DECIMAL(38,2), 9007199254740993::BIGINT, -0.0::DOUBLE, '{"a":1}'::JSON),
        (2, TIMESTAMPTZ '2026-07-15 18:00:00.123456+00', TIMESTAMP '2026-07-15 10:00:00', DATE '2026-07-15', 1::HUGEINT, 1.5::DECIMAL(38,2), 42::BIGINT, 1.25::DOUBLE, '[1,2]'::JSON)
      ) v(id, ts, naive, d, big, dec, i64, dbl, j)`],
    });
    const sql = "SELECT id, ts, naive, d, big, dec, i64, dbl, j, ts::DATE AS local_day, hour(ts) AS local_hour FROM ev ORDER BY id";
    const { e } = await engine(p);
    const served = await e.query(q(sql));
    await e.close();
    const direct = await directQuery(p.project, { sql, params: [], limit: 100 });
    expect(served.rows).toEqual(direct);
    expect(JSON.parse(JSON.stringify(served.rows))).toEqual(served.rows);
    expect(served.rows[0]).toMatchObject({ ts: "2026-01-15T10:00:00-08:00", big: "170141183460469231731687303715884105727", dec: "12345678901234567.89", i64: "9007199254740993", dbl: 0, local_day: "2026-01-15", local_hour: 10 });
    expect(served.rows[1]).toMatchObject({ ts: "2026-07-15T11:00:00.123456-07:00", local_hour: 11 });
  });

  test("more rows than the limit is QUERY_TOO_MANY_ROWS, never a partial result; exactly the limit is fine", async () => {
    const p = await seeded();
    const { e } = await engine(p);
    const err = await rejection(e.query(q("SELECT range FROM range(25)", { limit: 20 })));
    expect(err.code).toBe("QUERY_TOO_MANY_ROWS");
    expect(err.problem.details).toMatchObject({ limit: 20 });
    expect(err.problem.hint).toBeString();
    expect((await e.query(q("SELECT range FROM range(20)", { limit: 20 }))).rowCount).toBe(20);
    expect((await e.query(q("SELECT range FROM range(0)", { limit: 0 }))).rows).toEqual([]);
  });

  test("a result larger than serve.maxBytes is QUERY_TOO_MANY_ROWS", async () => {
    const p = await seeded();
    const { e } = await engine(p, { maxBytes: 2048 });
    const err = await rejection(e.query(q("SELECT repeat('x', 100) AS s FROM range(50)")));
    expect(err.code).toBe("QUERY_TOO_MANY_ROWS");
    expect(err.problem.details).toMatchObject({ maxBytes: 2048 });
    expect(err.message).toContain("bytes");
    expect((await e.query(q("SELECT repeat('x', 100) AS s FROM range(5)"))).rowCount).toBe(5);
  });

  test("the serve gate: tables, CTEs and range() only; no files, settings, catalog views or second statements", async () => {
    const p = await seeded();
    writeFileSync(join(p.root, "files", "x.csv"), "a\n1\n");
    const { e } = await engine(p);
    for (const sql of [
      "SELECT * FROM duckdb_settings()",
      "SELECT * FROM pg_settings",
      "SELECT current_setting('memory_limit') AS m",
      `SELECT * FROM read_csv('${join(p.root, "files", "x.csv")}')`,
      "SELECT * FROM 'files/x.csv'",
      "SELECT * FROM nope",
    ]) {
      expect({ sql, code: (await rejection(e.query(q(sql)))).code }).toEqual({ sql, code: "QUERY_PATH_DENIED" });
    }
    expect((await rejection(e.query(q("SELECT 1; SELECT 2")))).code).toBe("SQL_NOT_ONE_STATEMENT");
    expect((await rejection(e.query(q("CREATE TABLE z AS SELECT 1")))).code).toBe("QUERY_NOT_SELECT");
    expect((await rejection(e.query(q("SELEC 1")))).code).toBe("SQL_SYNTAX");
    expect((await rejection(e.query(q("SELECT nope FROM t")))).code).toBe("UNKNOWN_COLUMN");
    expect((await e.query(q("SELECT $1::INTEGER + 1 AS x", { params: [41] }))).rows).toEqual([{ x: 42 }]);
    expect(e.status()).toMatchObject({ state: "open", inFlight: 0 });
  });

  test("a query past queryTimeoutMs is interrupted: TIMEOUT", async () => {
    const p = await seeded();
    const { e } = await engine(p, { queryTimeoutMs: 200 });
    const start = Date.now();
    const err = await rejection(e.query(q(SLOW)));
    expect(err.code).toBe("TIMEOUT");
    expect(err.problem.details).toMatchObject({ phase: "query", timeoutMs: 200 });
    expect(err.problem.hint).toContain("serve.queryTimeoutMs");
    expect(Date.now() - start).toBeLessThan(200 + 1000 + SLACK);
    // The connection is fine afterwards.
    expect((await e.query(q("SELECT count(*) AS c FROM t"))).rows).toEqual([{ c: 5 }]);
  });

  test("a request that goes away interrupts its query (INTERRUPTED), and leaves the queue when it waits", async () => {
    const p = await seeded();
    const { e } = await engine(p, { maxConcurrent: 1 });
    const running = new AbortController();
    const slow = rejection(e.query(q(SLOW, { signal: running.signal })));
    await until("the slow query to run", () => e.status().inFlight === 1);
    const waiting = new AbortController();
    const queued = rejection(e.query(q("SELECT 1 AS x", { signal: waiting.signal })));
    await until("the second query to queue", () => e.status().queued === 1);
    waiting.abort();
    expect((await queued).code).toBe("INTERRUPTED");
    expect(e.status().queued).toBe(0);
    await sleep(50);
    running.abort();
    expect((await slow).code).toBe("INTERRUPTED");
    expect(e.status().inFlight).toBe(0);
  });

  test("at most maxConcurrent queries run; one not admitted within queueMs gets SERVE_UNAVAILABLE with retryAfterMs", async () => {
    const p = await seeded();
    const { e } = await engine(p, { maxConcurrent: 2, queueMs: 250 });
    const stop = new AbortController();
    const slow = [rejection(e.query(q(SLOW, { signal: stop.signal }))), rejection(e.query(q(SLOW, { signal: stop.signal })))];
    await until("two slow queries", () => e.status().inFlight === 2);
    const start = Date.now();
    const err = await rejection(e.query(q("SELECT 1 AS x")));
    expect(err.code).toBe("SERVE_UNAVAILABLE");
    expect(Date.now() - start).toBeGreaterThanOrEqual(240);
    expect(err.problem.details?.retryAfterMs).toBeGreaterThan(0);
    expect(err.problem.details).toMatchObject({ reason: "busy", maxConcurrent: 2 });
    expect(err.problem.retryable).toBe(true);
    stop.abort();
    for (const s of await Promise.all(slow)) expect(s.code).toBe("INTERRUPTED");
  });

  test("a database written by a newer croft is refused at open: DB_NEWER_FORMAT", async () => {
    const p = await makeProject({ seed: ["CREATE SCHEMA _croft", "CREATE TABLE _croft.meta (key VARCHAR PRIMARY KEY, value VARCHAR)", "INSERT INTO _croft.meta VALUES ('format_version', '99')"] });
    expect((await rejection(openServeEngine({ root: p.root }))).code).toBe("DB_NEWER_FORMAT");
    // It released the file on the way out.
    const w = probeWriter(p, "after");
    await w.waitFor("released");
  });
});

// ---- the handoff ----------------------------------------------------------------------------------------

describe("handing the file to a writer", () => {
  test("an idle engine releases the file to a writer within 100 ms of the intent appearing", async () => {
    const p = await seeded();
    const { e, events } = await engine(p);
    // A query first, so an idle pooled connection exists: it must be closed too.
    await e.query(q("SELECT count(*) AS c FROM t"));
    expect(e.status().openConnections).toBeGreaterThan(0);
    const w = probeWriter(p, "r_probe", 300);
    const { since } = await w.waitFor("intent");
    const appeared = Date.parse(since!);
    const acquired = (await w.waitFor("acquired")).t;
    const released = events.find((x) => x.kind === "released" && x.pid === w.pid);
    expect(released).toBeDefined();
    expect(released!.since).toBe(since);
    expect(released!.at - appeared).toBeLessThanOrEqual(100 + SLACK);
    expect(acquired - appeared).toBeLessThanOrEqual(100 + WRITER_SHARE + SLACK);
    expect(acquired).toBeGreaterThanOrEqual(released!.at - 5);
    // Every connection, the idle one included, was closed before closeSync().
    const before = events.filter((x) => x.kind === "beforeClose");
    expect(before.map((x) => x.openConnections)).toEqual([0]);
    expect(e.status()).toMatchObject({ state: "closed_for_write", openConnections: 0, writeIntent: { pid: w.pid, runId: "r_probe", since } });
    await w.waitFor("released");
    // Reopened after the writer left, seeing its commit.
    await until("reopen", () => e.status().state === "open");
    expect((await e.query(q("SELECT who FROM log"))).rows).toEqual([{ who: "r_probe" }]);
    expect(e.status().writeIntent).toBeNull();
  });

  test("a croft write lease (warehouse.ts) gets the file, commits, and the engine reopens to see it", async () => {
    const p = await seeded();
    const { e, events } = await engine(p);
    await e.query(q("SELECT 1 AS x"));
    const w = warehouseWriter(p, "r_run", 50);
    const acquired = (await w.waitFor("acquired")).t;
    const released = events.find((x) => x.kind === "released" && x.pid === w.pid);
    expect(released).toBeDefined();
    expect(released!.at - Date.parse(released!.since!)).toBeLessThanOrEqual(100 + SLACK);
    expect(acquired).toBeGreaterThanOrEqual(released!.at - 5);
    await w.waitFor("released");
    expect(await w.exited).toBe(0);
    await until("reopen", () => e.status().state === "open");
    expect((await e.query(q("SELECT who FROM log"))).rows).toEqual([{ who: "r_run" }]);
  });

  test("a long query runs for graceMs, then is interrupted: the writer gets the file within graceMs + 100 ms", async () => {
    const p = await seeded();
    const graceMs = 2000;
    const { e, events } = await engine(p);
    const slow = rejection(e.query(q(SLOW)));
    await until("the slow query to run", () => e.status().inFlight === 1);
    await sleep(50);
    const w = probeWriter(p, "r_grace", 50);
    const appeared = Date.parse((await w.waitFor("intent")).since!);
    await until("stepping aside", () => e.status().state === "stepping_aside");
    // A query arriving now waits in the queue; it does not start in DuckDB.
    const late = e.query(q("SELECT count(*) AS c FROM t"));
    await until("the late query to queue", () => e.status().queued === 1);
    expect(e.status().inFlight).toBe(1);

    const err = await slow;
    const acquired = (await w.waitFor("acquired")).t;
    const released = events.find((x) => x.kind === "released" && x.pid === w.pid)!;
    expect(released.at - appeared).toBeGreaterThanOrEqual(graceMs - 20);
    expect(released.at - appeared).toBeLessThanOrEqual(graceMs + 100 + SLACK);
    expect(acquired - appeared).toBeLessThanOrEqual(graceMs + 100 + WRITER_SHARE + SLACK);
    expect(events.filter((x) => x.kind === "beforeClose").map((x) => x.openConnections)).toEqual([0]);
    // The interrupted query says why, and when to retry.
    expect(err.code).toBe("SERVE_UNAVAILABLE");
    expect(err.message).toContain("interrupted");
    expect(err.message).toContain("r_grace");
    expect(err.problem.details).toMatchObject({ reason: "write", writeIntent: { pid: w.pid, runId: "r_grace" } });
    expect(err.problem.details?.retryAfterMs).toBeGreaterThan(0);
    // The queued query waited through the handoff and ran after the reopen.
    expect((await late).rows).toEqual([{ c: 5 }]);
  });

  test("queries queued during the handoff succeed after the reopen and see the writer's commit", async () => {
    const p = await seeded();
    const { e } = await engine(p);
    const w = warehouseWriter(p, "r_hold", 400);
    await w.waitFor("acquired");
    expect(e.status().state).toBe("closed_for_write");
    const queued = [1, 2, 3].map(() => e.query(q("SELECT count(*) AS c FROM log")));
    await until("three queued", () => e.status().queued === 3);
    expect(e.status()).toMatchObject({ inFlight: 0, openConnections: 0 });
    for (const r of await Promise.all(queued)) expect(r.rows).toEqual([{ c: 1 }]);
    expect(e.status()).toMatchObject({ state: "open", queued: 0, writeIntent: null });
  });

  test("a query not admitted within queueMs while a writer holds the file: SERVE_UNAVAILABLE with retryAfterMs", async () => {
    const p = await seeded();
    const { e } = await engine(p, { queueMs: 300 });
    const idle = spawnIdle();
    await idle.waitFor("up");
    const file = writeIntent(p.stateDir, idle.pid, "r_long");
    await until("closed for the writer", () => e.status().state === "closed_for_write");
    const start = Date.now();
    const err = await rejection(e.query(q("SELECT 1 AS x")));
    expect(Date.now() - start).toBeGreaterThanOrEqual(290);
    expect(err.code).toBe("SERVE_UNAVAILABLE");
    expect(err.problem.retryable).toBe(true);
    expect(err.problem.hint).toBeString();
    expect(err.problem.details).toMatchObject({ reason: "write", writeIntent: { pid: idle.pid, runId: "r_long" } });
    expect(err.problem.details?.retryAfterMs).toBeGreaterThan(0);
    expect(err.message).toContain("r_long");
    rmSync(file);
    await until("reopen", () => e.status().state === "open");
    expect((await e.query(q("SELECT 1 AS x"))).rows).toEqual([{ x: 1 }]);
  });

  test("dead intents are purged and never keep the engine closed", async () => {
    const p = await seeded();
    const child = spawn("sleep", ["0.01"]);
    const gone = { pid: child.pid!, procStart: procStart(child.pid!) ?? "gone", bootId: bootId() };
    await new Promise((r) => child.on("exit", r));
    const me = currentIdentity();
    const reused = { pid: me.pid, procStart: "1000000000", bootId: bootId() };
    mkdirSync(intentDir(p.stateDir), { recursive: true });
    const files = [gone, reused].map((id) => {
      const f = join(intentDir(p.stateDir), intentFileName(id));
      writeFileSync(f, JSON.stringify({ ...id, runId: "r_dead", since: new Date().toISOString() }));
      return f;
    });
    const { e } = await engine(p);
    await until("the dead intents to go", () => files.every((f) => !existsSync(f)));
    await until("open", () => e.status().state === "open");
    expect((await e.query(q("SELECT count(*) AS c FROM t"))).rows).toEqual([{ c: 5 }]);
  });

  test("close() interrupts running queries, releases the file at once and refuses new queries", async () => {
    const p = await seeded();
    const { e, events } = await engine(p);
    const slow = rejection(e.query(q(SLOW)));
    await until("the slow query to run", () => e.status().inFlight === 1);
    const start = Date.now();
    await e.close();
    expect(Date.now() - start).toBeLessThan(1000 + SLACK);
    const err = await slow;
    expect(err.code).toBe("SERVE_UNAVAILABLE");
    expect(err.problem.details).toMatchObject({ reason: "stopping" });
    expect(events.filter((x) => x.kind === "beforeClose")).toMatchObject([{ openConnections: 0, reason: "stop" }]);
    expect(e.status()).toMatchObject({ state: "stopped", openConnections: 0, inFlight: 0 });
    expect((await rejection(e.query(q("SELECT 1 AS x")))).code).toBe("SERVE_UNAVAILABLE");
    await e.close(); // twice is fine
    const w = probeWriter(p, "after_close", 0);
    const { since } = await w.waitFor("intent");
    expect((await w.waitFor("acquired")).t - Date.parse(since!)).toBeLessThanOrEqual(WRITER_SHARE + SLACK);
  });

  test("no database yet: DB_NOT_FOUND at once; the first run creates it and the engine opens it", async () => {
    const p = await makeProject();
    const { e } = await engine(p);
    expect(e.status().state).toBe("reopening");
    const err = await rejection(e.query(q("SELECT 1 AS x")));
    expect(err.code).toBe("DB_NOT_FOUND");
    expect(err.problem.fix).toBeDefined();
    const w = warehouseWriter(p, "r_first", 100);
    await w.waitFor("released");
    await until("open", () => e.status().state === "open");
    expect((await e.query(q("SELECT who FROM log"))).rows).toEqual([{ who: "r_first" }]);
  });

  test("a program holding the file without an intent (a GUI): queries wait, then SERVE_UNAVAILABLE naming it; served once it lets go", async () => {
    const p = await seeded();
    const gui = spawnHolder(p.database, 1500);
    await gui.waitFor("held");
    const { e } = await engine(p, { queueMs: 300 });
    expect(e.status()).toMatchObject({ state: "reopening", openConnections: 0 });
    const err = await rejection(e.query(q("SELECT count(*) AS c FROM t")));
    expect(err.code).toBe("SERVE_UNAVAILABLE");
    expect(err.message).toContain("holds it");
    expect(err.problem.details).toMatchObject({ reason: "unavailable", holder: { pid: gui.pid } });
    expect(err.problem.details?.retryAfterMs).toBeGreaterThan(0);
    await gui.waitFor("released");
    await until("open", () => e.status().state === "open");
    expect((await e.query(q("SELECT count(*) AS c FROM t"))).rows).toEqual([{ c: 5 }]);
  });

  test("a hook that throws never breaks the handoff", async () => {
    const p = await seeded();
    const boom = () => {
      throw new Error("hook failed");
    };
    const e = await openServeEngine({ root: p.root, resources: { threads: 2 }, hooks: { steppingAside: boom, beforeClose: boom, released: boom, opened: boom } });
    engines.push(e);
    const w = probeWriter(p, "r_hooks", 0);
    await w.waitFor("released");
    await until("reopen", () => e.status().state === "open");
    expect((await e.query(q("SELECT who FROM log"))).rows).toEqual([{ who: "r_hooks" }]);
  });

  test("an unsafe filesystem refuses to start: SERVE_UNSAFE_FILESYSTEM", async () => {
    const p = await seeded();
    const probe: FsProbe = {
      platform: "linux",
      procMounts: () => `overlay / overlay rw 0 0\ngrpcfuse ${p.root} fuse.grpcfuse rw 0 0\n`,
      statfsType: () => null, mountTable: () => null, mountPointOf: () => null,
    };
    const err = await rejection(openServeEngine({ root: p.root, fs: probe }));
    expect(err.code).toBe("SERVE_UNSAFE_FILESYSTEM");
    expect(err.problem.fix).toMatchObject({ kind: "manual" });
    // Nothing was opened: a writer gets the file at once.
    const w = probeWriter(p, "r_after", 0);
    await w.waitFor("released");
  });
});
