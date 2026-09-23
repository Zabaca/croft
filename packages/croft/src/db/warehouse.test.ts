import { afterAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import type { LockHolder } from "../core/types.ts";
import { connect, openInstance } from "./connect.ts";
import { heldCount, listIntents, liveIntents } from "./intent.ts";
import { backoffMs, closeAllWarehouses, DuckWarehouse, openWarehouse, type WarehouseOptions, warehouseFor } from "./warehouse.ts";

const children: ChildProcess[] = [];
afterAll(async () => {
  children.forEach((c) => c.kill("SIGKILL"));
  await closeAllWarehouses();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-wh-")));
  const stateDir = join(root, ".croft");
  mkdirSync(join(root, "files"));
  mkdirSync(stateDir);
  return { root, stateDir, path: join(root, "warehouse.duckdb") };
}

function wh(p: ReturnType<typeof project>, o: Partial<WarehouseOptions> = {}): DuckWarehouse {
  return openWarehouse({ path: p.path, mode: "read_write", timezone: "UTC", root: p.root, stateDir: p.stateDir, isTTY: false, register: false, ...o });
}

async function rejection(p: Promise<unknown>): Promise<CroftError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
  throw new Error("expected a CroftError");
}

// A croft writer in another process: opens the warehouse through warehouse.ts, holds a write lease.
const WRITER = `
const { openWarehouse } = await import(process.env.CROFT_WAREHOUSE_TS);
const { existsSync } = await import("node:fs");
const [mode, path, root, stateDir, label, holdMs, untilFile] = process.argv.slice(2);
const say = (event) => console.log(JSON.stringify({ event, t: Date.now() }));
const w = openWarehouse({ path, mode, timezone: "UTC", root, stateDir, isTTY: false, waits: { offTtyMs: 20000 }, runId: label });
say("start");
await w.write(label, async (tx) => {
  say("acquired");
  await tx.exec("CREATE TABLE IF NOT EXISTS log (who VARCHAR, t BIGINT)");
  await tx.exec("INSERT INTO log VALUES ($1, $2)", [label, Date.now()]);
  const until = Date.now() + Number(holdMs);
  while (Date.now() < until || (untilFile && !existsSync(untilFile))) await new Promise((r) => setTimeout(r, 10));
}, { runId: label });
await w.close();
say("released");
`;

// A program that is not croft (think DuckDB UI): opens the file read-write directly and holds it.
// Its command line must not mention croft, so everything it needs comes through the environment.
const FOREIGN = `const { DuckDBInstance } = require(process.env.DUCKDB_API);
(async () => {
  const db = await DuckDBInstance.create(process.env.DB_PATH);
  const c = await db.connect();
  await c.run("CREATE TABLE IF NOT EXISTS foreign_t AS SELECT 1 a");
  console.log(JSON.stringify({ event: "acquired", t: Date.now() }));
  setInterval(() => {}, 1000);
})();`;

interface Child { proc: ChildProcess; events: { event: string; t: number }[]; waitFor(event: string, timeoutMs?: number): Promise<number>; exited: Promise<number | null> }

function track(proc: ChildProcess): Child {
  children.push(proc);
  const events: { event: string; t: number }[] = [];
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
    proc, events, exited,
    async waitFor(event, timeoutMs = 15000) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const e = events.find((x) => x.event === event);
        if (e) return e.t;
        if (Date.now() > until || proc.exitCode !== null) throw new Error(`child never reported ${event}: ${err}`);
        await sleep(5);
      }
    },
  };
}

let scriptDir: string | undefined;
function writerScript(): string {
  scriptDir ??= realpathSync(mkdtempSync(join(tmpdir(), "wh-child-")));
  const file = join(scriptDir, "writer.mjs");
  writeFileSync(file, WRITER);
  return file;
}

function spawnWriter(p: ReturnType<typeof project>, label: string, holdMs: number, untilFile = ""): Child {
  return track(spawn(process.execPath, [writerScript(), "read_write", p.path, p.root, p.stateDir, label, String(holdMs), untilFile], {
    env: { ...process.env, CROFT_WAREHOUSE_TS: join(import.meta.dir, "warehouse.ts") },
    stdio: ["ignore", "pipe", "pipe"],
  }));
}

function spawnForeign(dbPath: string): Child {
  return track(spawn(process.execPath, ["-e", FOREIGN], {
    env: { ...process.env, DUCKDB_API: require.resolve("@duckdb/node-api"), DB_PATH: dbPath },
    stdio: ["ignore", "pipe", "pipe"],
  }));
}

/** A read-only holder that behaves like croft serve: it closes while any live intent exists. */
class IntentHonoringReader {
  instance: DuckDBInstance | null = null;
  conn: DuckDBConnection | null = null;
  readonly log: { kind: "open" | "close"; t: number }[] = [];
  private stopped = false;
  private loop: Promise<void> | undefined;
  /** asServe: record this PID in serve.json, as croft serve does; otherwise it is an unrecognized app reader. */
  constructor(private readonly p: ReturnType<typeof project>, private readonly asServe: boolean) {}

  start(): void {
    if (this.asServe) writeFileSync(join(this.p.stateDir, "serve.json"), JSON.stringify({ pid: process.pid }));
    this.loop = (async () => {
      while (!this.stopped) {
        const busy = liveIntents(this.p.stateDir, { excludeSelf: true }).length > 0;
        if (busy && this.instance) this.close();
        else if (!busy && !this.instance) await this.tryOpen();
        await sleep(10);
      }
    })();
  }

  private async tryOpen(): Promise<void> {
    try {
      const { instance, path } = await openInstance(this.p.path, "read_only");
      this.instance = instance;
      this.conn = await connect(instance, { profile: "serve", timezone: "UTC" }, path);
      this.log.push({ kind: "open", t: Date.now() });
    } catch {
      if (this.instance) this.close(); // a writer took the file between checks; try again later
    }
  }

  private close(): void {
    this.conn?.disconnectSync(); // every connection first: an idle one keeps the lock
    this.conn = null;
    this.instance?.closeSync();
    this.instance = null;
    this.log.push({ kind: "close", t: Date.now() });
  }

  async count(): Promise<number> {
    for (let i = 0; i < 500 && !this.conn; i++) await sleep(10);
    const r = await this.conn!.runAndReadAll("SELECT count(*)::INTEGER FROM log");
    return r.getRowsJS()[0]![0] as number;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
    if (this.instance) this.close();
  }
}

describe("leases", () => {
  test("read and write; write commits, a throwing write rolls back", async () => {
    const w = wh(project());
    await w.write("setup", async (tx) => {
      await tx.exec("CREATE TABLE t (id INTEGER, v VARCHAR)");
      await tx.exec("INSERT INTO t VALUES (1, 'a')");
    }, { runId: "r_t" });
    const boom = new Error("boom");
    await expect(w.write("fails", async (tx) => {
      await tx.exec("INSERT INTO t VALUES (2, 'b')");
      throw boom;
    }, { runId: "r_t" })).rejects.toBe(boom);
    expect(await w.read((db) => db.all("SELECT * FROM t"), { purpose: "test" })).toEqual([{ id: 1, v: "a" }]);
  });

  test("the file closes 100 ms after the last lease; the intent goes only after closeSync", async () => {
    const p = project();
    const w = wh(p);
    await w.write("x", async () => {
      expect(liveIntents(p.stateDir)).toHaveLength(1);
    }, { runId: "r_linger" });
    expect(w.isOpen).toBe(true); // lingering
    expect(listIntents(p.stateDir).map((i) => i.runId)).toEqual(["r_linger"]);
    await sleep(40);
    // A lease inside the linger window reuses the open instance and the same intent.
    await w.read(async () => {}, { purpose: "reuse" });
    expect(w.isOpen).toBe(true);
    await sleep(200);
    expect(w.isOpen).toBe(false);
    expect(listIntents(p.stateDir)).toHaveLength(0);
    expect(heldCount(p.stateDir)).toBe(0);
    // Closed means closed: another process can take the file now.
    const child = spawnWriter(p, "after", 0);
    await child.waitFor("released");
  });

  test("read-only processes never create an intent", async () => {
    const p = project();
    await wh(p).write("init", (tx) => tx.exec("CREATE TABLE t AS SELECT 1 a"), { runId: "r" });
    await warehouseFor(p.path)!.close();
    // Same process cannot switch this path to read-only; use a fresh path created by a child.
    const q = project();
    await spawnWriter(q, "seed", 0).waitFor("released");
    const ro = wh(q, { mode: "read_only", profile: "query" });
    expect(await ro.read((db) => db.all("SELECT who FROM log"), { purpose: "q" })).toEqual([{ who: "seed" }]);
    expect(listIntents(q.stateDir)).toHaveLength(0);
    await expect(ro.write("nope", async () => {}, { runId: "r" })).rejects.toThrow(/read-only process/);
  });

  test("writes in one process are serialized", async () => {
    const w = wh(project());
    const order: string[] = [];
    await Promise.all(["a", "b", "c"].map((name) =>
      w.write(name, async () => {
        order.push(`${name}+`);
        await sleep(20);
        order.push(`${name}-`);
      }, { runId: "r" })));
    expect(order).toEqual(["a+", "a-", "b+", "b-", "c+", "c-"]);
  });
});

describe("Sql wrapper", () => {
  test("one statement per call, parameters bound through prepare()", async () => {
    const w = wh(project());
    await w.write("sql", async (tx) => {
      await tx.exec("CREATE TABLE p (i BIGINT, h HUGEINT, l INTEGER[], j JSON, s VARCHAR, ts TIMESTAMPTZ)");
      await tx.exec("INSERT INTO p VALUES ($1, $2, $3, $4, $5, $6)", [
        9007199254740993n, 170141183460469231731687303715884105727n, [1, 2], { a: 1, big: 9007199254740993n }, "x'; DROP TABLE p; --",
        new Date("2024-01-02T03:04:05.678Z"),
      ]);
      const e = await rejection(tx.exec("INSERT INTO p (i) VALUES (1); DROP TABLE p"));
      expect(e.code).toBe("SQL_NOT_ONE_STATEMENT");
    }, { runId: "r" }).catch((e) => {
      throw e;
    });
    const rows = await w.read((db) => db.all("SELECT * FROM p"), { purpose: "t" });
    expect(rows).toEqual([{
      i: 9007199254740993n, h: 170141183460469231731687303715884105727n, l: [1, 2], j: { a: 1, big: 9007199254740993n },
      s: "x'; DROP TABLE p; --", ts: "2024-01-02T03:04:05.678000Z",
    }]);
  });

  test("json rendering and column types for croft query", async () => {
    const p = project();
    const w = wh(p, { render: "json", timezone: "America/Los_Angeles" });
    const out = await w.read((db) => db.query("SELECT TIMESTAMPTZ '2024-07-01T10:00:00Z' t, 9007199254740993::BIGINT n"), { purpose: "q" });
    expect(out).toEqual({ columns: [{ name: "t", type: "TIMESTAMPTZ" }, { name: "n", type: "BIGINT" }],
      rows: [{ t: "2024-07-01T03:00:00-07:00", n: "9007199254740993" }] });
  });

  test("write() owns the transaction", async () => {
    const w = wh(project());
    const e = await rejection(w.write("x", (tx) => tx.exec("COMMIT"), { runId: "r" }));
    expect(e.code).toBe("INTERNAL_ERROR");
  });

  test("transaction: false runs statements in autocommit (CHECKPOINT)", async () => {
    const w = wh(project());
    await w.write("ckpt", async (tx) => {
      await tx.exec("CREATE TABLE c AS SELECT 1 a");
      await tx.exec("CHECKPOINT");
    }, { runId: "r", transaction: false });
  });
});

describe("DDL before DML", () => {
  async function seeded() {
    const w = wh(project());
    await w.write("seed", async (tx) => {
      await tx.exec("CREATE TABLE t (id INTEGER, v VARCHAR)");
      await tx.exec("INSERT INTO t VALUES (1, 'a'), (2, 'b')");
    }, { runId: "r" });
    return w;
  }

  test("DuckDB itself only fails at COMMIT (why the guard exists)", async () => {
    const w = await seeded();
    const err = await w.write("raw", async (tx) => {
      // Bypass the Sql wrapper to show the late failure.
      await tx.connection.run("UPDATE t SET v = 'x' WHERE id = 1");
      await tx.connection.run("ALTER TABLE t ADD COLUMN c INTEGER");
    }, { runId: "r" }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain("another transaction has altered this table");
  });

  test("the wrapper throws DDL_AFTER_DML at the ALTER and nothing is committed", async () => {
    const w = await seeded();
    let reachedAlter = false;
    const e = await rejection(w.write("bad", async (tx) => {
      await tx.exec("UPDATE t SET v = 'x' WHERE id = 1");
      reachedAlter = true;
      await tx.exec("ALTER TABLE t ADD COLUMN c INTEGER");
      throw new Error("not reached");
    }, { runId: "r" }));
    expect(reachedAlter).toBe(true);
    expect(e.code).toBe("DDL_AFTER_DML");
    expect(e.problem.details).toMatchObject({ table: "main.t" });
    const rows = await w.read((db) => db.all("SELECT * FROM t ORDER BY id"), { purpose: "t" });
    expect(rows).toEqual([{ id: 1, v: "a" }, { id: 2, v: "b" }]);
  });

  test("ALTER first, then DELETE and INSERT (a file reload with a widen) commits", async () => {
    const w = await seeded();
    await w.write("reload", async (tx) => {
      await tx.exec("ALTER TABLE t ALTER COLUMN id TYPE BIGINT");
      await tx.exec("ALTER TABLE t ADD COLUMN c INTEGER");
      await tx.exec("DELETE FROM t WHERE id = 1");
      await tx.exec("INSERT INTO t BY NAME SELECT 3 id, 'c' v, 9 c");
      expect(tx.touched()).toEqual(["main.t"]);
    }, { runId: "r" });
    const rows = await w.read((db) => db.all("SELECT * FROM t ORDER BY id"), { purpose: "t" });
    expect(rows).toEqual([{ id: 2, v: "b", c: null }, { id: 3, v: "c", c: 9 }]);
  });

  test("tracking is per transaction", async () => {
    const w = await seeded();
    await w.write("one", (tx) => tx.exec("UPDATE t SET v = 'z'"), { runId: "r" });
    await w.write("two", (tx) => tx.exec("ALTER TABLE t ADD COLUMN c INTEGER"), { runId: "r" });
  });
});

describe("one warehouse per path and mode", () => {
  test("path variants give the same warehouse; another mode is refused", async () => {
    const p = project();
    const a = wh(p);
    await a.write("create", async () => {}, { runId: "r" }); // case variants resolve once the file exists
    symlinkSync(p.root, p.root + "-alias");
    const b = wh({ ...p, path: p.root + "-alias/warehouse.duckdb" });
    expect(b).toBe(a);
    const upper = wh({ ...p, path: join(p.root, "WAREHOUSE.duckdb") });
    expect(upper).toBe(a);
    expect(() => wh(p, { mode: "read_only" })).toThrow(/one access mode/);
  });

  test("the same path with a different time zone or state folder is refused", () => {
    const p = project();
    wh(p);
    expect(() => wh(p, { timezone: "Asia/Tokyo" })).toThrow(/different timezone/);
    expect(() => wh(p, { stateDir: p.root })).toThrow(/different stateDir/);
  });

  test("a read-only open of a missing warehouse says so", async () => {
    const e = await rejection(wh(project(), { mode: "read_only" }).read(async () => {}, { purpose: "q" }));
    expect(e.code).toBe("DB_NOT_FOUND");
    expect(e.message).toContain("does not exist yet");
  });

  test("a database from a newer croft is refused on first open (DB_NEWER_FORMAT)", async () => {
    const p = project();
    const { instance, path } = await openInstance(p.path, "read_write");
    const c = await connect(instance, { profile: "warehouse", timezone: "UTC", root: p.root, stateDir: p.stateDir }, path);
    await c.run("CREATE SCHEMA _croft");
    await c.run("CREATE TABLE _croft.meta (key VARCHAR PRIMARY KEY, value VARCHAR)");
    await c.run("INSERT INTO _croft.meta VALUES ('format_version', '99'), ('croft_version', '9.0.0')");
    c.disconnectSync();
    instance.closeSync();
    const e = await rejection(wh(p).read(async () => {}, { purpose: "q" }));
    expect(e.code).toBe("DB_NEWER_FORMAT");
    expect(e.message).toContain("croft 9.0.0");
  });

  test("registers globalThis[Symbol.for('croft.warehouse')]", () => {
    const w = wh(project(), { register: true });
    expect((globalThis as Record<symbol, unknown>)[Symbol.for("croft.warehouse")]).toBe(w);
    expect(((globalThis as Record<symbol, unknown>)[Symbol.for("croft.warehouses")] as Map<string, unknown>).get(w.path)).toBe(w);
  });
});

describe("lock conflicts", () => {
  test("backoff is jittered, starts near 25 ms and caps at 1 s", () => {
    for (let i = 0; i < 50; i++) {
      expect(backoffMs(0)).toBeGreaterThanOrEqual(12);
      expect(backoffMs(0)).toBeLessThanOrEqual(25);
      expect(backoffMs(20)).toBeLessThanOrEqual(1000);
      expect(backoffMs(20)).toBeGreaterThanOrEqual(500);
    }
  });

  test("a croft holder is DB_BUSY naming its run; onWait fires with the holder", async () => {
    const p = project();
    const release = join(p.root, "release");
    const child = spawnWriter(p, "r_child", 0, release);
    await child.waitFor("acquired");
    const seen: LockHolder[] = [];
    const w = wh(p, { waits: { offTtyMs: 400 }, noticeAfterMs: 100, onWait: (h) => seen.push(h) });
    const started = Date.now();
    const e = await rejection(w.write("blocked", async () => {}, { runId: "r_parent" }));
    expect(Date.now() - started).toBeGreaterThanOrEqual(380);
    expect(e.code).toBe("DB_BUSY");
    expect(e.message).toContain("croft run r_child");
    expect(e.problem.retryable).toBe(true);
    expect(e.problem.details!.holder).toMatchObject({ pid: child.proc.pid, program: "croft", runId: "r_child" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.pid).toBe(child.proc.pid!);
    // Our intent is gone after giving up; the child's remains.
    expect(heldCount(p.stateDir)).toBe(0);
    expect(liveIntents(p.stateDir).map((i) => i.runId)).toEqual(["r_child"]);
    writeFileSync(release, "");
    await child.waitFor("released");
    // With the holder gone, the same warehouse gets in.
    await w.write("after", (tx) => tx.exec("INSERT INTO log VALUES ('parent', 0)"), { runId: "r_parent", waitMs: 5000 });
  });

  test("a foreign holder is DB_HELD_BY_OTHER_PROGRAM, and the intent is withdrawn while waiting", async () => {
    const p = project();
    const foreign = spawnForeign(p.path);
    await foreign.waitFor("acquired");
    const w = wh(p, { waits: { offTtyMs: 600 }, foreignWithdrawMs: 100, foreignReannounceMs: 60_000 });
    const pending = rejection(w.write("blocked", async () => {}, { runId: "r_parent" }));
    await sleep(40);
    expect(listIntents(p.stateDir)).toHaveLength(1); // announced at first: the holder might honor it
    await sleep(260);
    expect(heldCount(p.stateDir)).toBe(1); // still wants the file...
    expect(listIntents(p.stateDir)).toHaveLength(0); // ...but croft serve is not asked to step aside
    const e = await pending;
    expect(e.code).toBe("DB_HELD_BY_OTHER_PROGRAM");
    expect(e.message).toContain(`(PID ${foreign.proc.pid})`);
    expect(e.problem.hint).toContain("croft serve");
    expect(heldCount(p.stateDir)).toBe(0);
    foreign.proc.kill("SIGKILL");
    await foreign.exited;
    expect(await w.write("after", (tx) => tx.all("SELECT a FROM foreign_t"), { runId: "r", waitMs: 5000 })).toEqual([{ a: 1 }]);
  });

  test("against a lasting foreign holder the intent is withdrawn and periodically announced again", async () => {
    const p = project();
    const foreign = spawnForeign(p.path);
    await foreign.waitFor("acquired");
    const w = wh(p, { waits: { offTtyMs: 1500 }, foreignWithdrawMs: 50, foreignReannounceMs: 300 });
    const pending = rejection(w.write("blocked", async () => {}, { runId: "r" }));
    const states: number[] = [];
    while (states.length < 60) {
      states.push(listIntents(p.stateDir).length);
      await sleep(20);
    }
    expect((await pending).code).toBe("DB_HELD_BY_OTHER_PROGRAM");
    const flips = states.filter((v, i) => i > 0 && v !== states[i - 1]).length;
    expect(flips).toBeGreaterThanOrEqual(3); // announced, withdrawn, announced again, withdrawn...
    foreign.proc.kill("SIGKILL");
  });

  test("wait caps: off a TTY, and reads on a TTY", async () => {
    const p = project();
    const release = join(p.root, "release");
    const child = spawnWriter(p, "r_hold", 0, release);
    await child.waitFor("acquired");
    const ro = wh(p, { mode: "read_only", isTTY: true, waits: { ttyReadMs: 150, ttyWriteMs: 60_000, offTtyMs: 60_000 } });
    const started = Date.now();
    const e = await rejection(ro.read(async () => {}, { purpose: "query" }));
    const waited = Date.now() - started;
    expect(e.code).toBe("DB_BUSY");
    expect(waited).toBeGreaterThanOrEqual(140);
    expect(waited).toBeLessThan(2000);
    // An explicit waitMs (--no-wait) overrides the cap.
    const now = Date.now();
    expect((await rejection(ro.read(async () => {}, { purpose: "q", waitMs: 0 }))).code).toBe("DB_BUSY");
    expect(Date.now() - now).toBeLessThan(500);
    // holder() names the writer from its intent.
    expect(await ro.holder()).toMatchObject({ pid: child.proc.pid, runId: "r_hold", action: "write" });
    writeFileSync(release, "");
    await child.waitFor("released");
    expect(await ro.holder()).toBeNull();
  });
});

describe("aborting a wait (Ctrl-C)", () => {
  test("a signal ends a lock wait at once with its CroftError reason (INTERRUPTED), and the intent goes", async () => {
    const p = project();
    const release = join(p.root, "release");
    const child = spawnWriter(p, "r_hold", 0, release);
    await child.waitFor("acquired");
    const w = wh(p, { waits: { offTtyMs: 60_000 } });
    const ac = new AbortController();
    const reason = new CroftError("INTERRUPTED", { message: "the run was stopped by SIGINT", hint: "run again" });
    const pending = rejection(w.write("blocked", async () => {
      throw new Error("the body must not run");
    }, { runId: "r_parent", signal: ac.signal }));
    await sleep(150);
    expect(heldCount(p.stateDir)).toBe(1); // waiting, with its intent announced
    const aborted = Date.now();
    ac.abort(reason);
    expect(await pending).toBe(reason);
    expect(Date.now() - aborted).toBeLessThan(500);
    expect(heldCount(p.stateDir)).toBe(0);
    expect(liveIntents(p.stateDir).map((i) => i.runId)).toEqual(["r_hold"]);

    // A read's wait ends the same way; a reason that is not a CroftError becomes INTERRUPTED.
    const ac2 = new AbortController();
    const read = rejection(w.read(async () => {}, { purpose: "state", signal: ac2.signal }));
    await sleep(100);
    ac2.abort();
    const e = await read;
    expect(e.code).toBe("INTERRUPTED");
    expect(e.message).toBe("interrupted while waiting for the warehouse");

    // An already-aborted signal never waits; without one, the same warehouse still gets in later.
    expect(await rejection(w.read(async () => {}, { purpose: "x", signal: ac.signal }))).toBe(reason);
    writeFileSync(release, "");
    await child.waitFor("released");
    expect(await w.read((db) => db.all("SELECT who FROM log"), { purpose: "after" })).toEqual([{ who: "r_hold" }]);
  });

  test("a lease sharing another's open is not failed by that lease's abort", async () => {
    const p = project();
    const release = join(p.root, "release");
    const child = spawnWriter(p, "r_hold", 0, release);
    await child.waitFor("acquired");
    const w = wh(p, { waits: { offTtyMs: 60_000 } });
    const ac = new AbortController();
    const first = rejection(w.read(async () => {}, { purpose: "aborted", signal: ac.signal }));
    await sleep(50);
    const second = w.read((db) => db.all("SELECT count(*)::INT AS n FROM log"), { purpose: "patient", waitMs: 20_000 });
    await sleep(50);
    ac.abort();
    expect((await first).code).toBe("INTERRUPTED");
    writeFileSync(release, "");
    expect(await second).toEqual([{ n: 1 }]);
  });

  test("a write queued behind this process's own write gives up at once and never runs", async () => {
    const w = wh(project());
    const ac = new AbortController();
    let ran = false;
    let finish!: () => void;
    const holding = w.write("first", () => new Promise<void>((r) => (finish = r)), { runId: "r" });
    await sleep(50);
    const queued = rejection(w.write("second", async () => {
      ran = true;
    }, { runId: "r", signal: ac.signal }));
    ac.abort();
    expect((await queued).code).toBe("INTERRUPTED");
    finish();
    await holding;
    await w.write("third", async () => {}, { runId: "r" });
    expect(ran).toBe(false);
  });

  test("an abort after the lease has the file does not cut it: the body decides", async () => {
    const w = wh(project());
    const ac = new AbortController();
    const out = await w.write("running", async (tx) => {
      ac.abort();
      await tx.exec("CREATE TABLE t AS SELECT 1 AS a");
      return "committed";
    }, { runId: "r", signal: ac.signal });
    expect(out).toBe("committed");
    expect(await w.read((db) => db.all("SELECT a FROM t"), { purpose: "check" })).toEqual([{ a: 1 }]);
  });
});

describe("handoff with an intent-honoring reader", () => {
  test("a child-process writer takes the file from a read-only holder", async () => {
    const p = project();
    await spawnWriter(p, "seed", 0).waitFor("released");
    const reader = new IntentHonoringReader(p, true);
    reader.start();
    expect(await reader.count()).toBe(1);
    const opened = reader.log.length;
    const writer = spawnWriter(p, "w1", 200);
    const acquired = await writer.waitFor("acquired");
    const released = await writer.waitFor("released");
    await writer.exited;
    const stepAside = reader.log.find((e, i) => i >= opened && e.kind === "close");
    expect(stepAside).toBeDefined();
    expect(stepAside!.t).toBeLessThanOrEqual(acquired);
    // Reopened after the writer left, and it sees the committed row.
    expect(await reader.count()).toBe(2);
    expect(reader.log.filter((e) => e.kind === "open" && e.t > stepAside!.t && e.t < acquired)).toEqual([]);
    expect(released).toBeGreaterThan(acquired);
    await reader.stop();
  });

  test("two writers with separate intents: A finishing does not let the reader in while B waits", async () => {
    const p = project();
    await spawnWriter(p, "seed", 0).waitFor("released");
    // Not recognizable as croft (like an app using @zabaca/croft/read): the writers must keep their
    // intents anyway, because the reader honors them.
    const reader = new IntentHonoringReader(p, false);
    reader.start();
    await reader.count();
    const releaseA = join(p.root, "release-a");
    const a = spawnWriter(p, "A", 0, releaseA);
    const aAcquired = await a.waitFor("acquired");
    const b = spawnWriter(p, "B", 150);
    // B has announced itself and is retrying the lock behind A.
    for (let i = 0; liveIntents(p.stateDir).length < 2; i++) {
      if (i > 1500) throw new Error("B never created its intent");
      await sleep(10);
    }
    const aDone = Date.now();
    writeFileSync(releaseA, "");
    const aReleased = await a.waitFor("released");
    const bAcquired = await b.waitFor("acquired");
    const bReleased = await b.waitFor("released");
    expect(bAcquired).toBeGreaterThanOrEqual(aDone);
    // The reader stayed closed from A's lease until B was done: no open between them.
    const reopened = reader.log.filter((e) => e.kind === "open" && e.t >= aAcquired);
    expect(reopened.every((e) => e.t >= bAcquired)).toBe(true);
    expect(aReleased).toBeGreaterThan(aAcquired);
    expect(bReleased).toBeGreaterThan(bAcquired);
    expect(await reader.count()).toBe(3);
    await reader.stop();
  });
});

describe("DDL_AFTER_DML with a catalog-qualified name", () => {
  test("DELETE on warehouse.t then ALTER t is caught at the ALTER", async () => {
    const dir = mkdtempSync(join(tmpdir(), "croft-catalog-"));
    const stateDir = join(dir, ".croft");
    const w = openWarehouse({ path: join(dir, "warehouse.duckdb"), mode: "read_write", timezone: "UTC", root: dir, stateDir, isTTY: false, register: false });
    try {
      await w.write("setup", async (tx) => { await tx.exec("CREATE TABLE t (a INTEGER)"); await tx.exec("INSERT INTO t VALUES (1)"); }, { runId: "r_setup" });
      const err = await w.write("x", async (tx) => {
        await tx.exec("DELETE FROM warehouse.t WHERE a = 1");
        await tx.exec("ALTER TABLE t ADD COLUMN b VARCHAR");
      }, { runId: "r_x" }).then(() => null, (e) => e);
      expect(err?.code).toBe("DDL_AFTER_DML");
    } finally {
      await w.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
