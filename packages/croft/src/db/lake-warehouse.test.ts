// A warehouse that is a lake (db/warehouse.ts with WarehouseOptions.lake; DESIGN.md D138 to D144; option 07, slice 2), against a real Postgres and
// an S3-compatible store started as children of this test and killed in teardown. What is under test is the warehouse itself, with no project
// and no CLI: writes and reads, the lock on writes, a catalog connection that drops (pg_terminate_backend) or a Postgres that restarts, a
// commit whose outcome is not known, and credentials that never leave in an error.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import type { Sql } from "../core/types.ts";
import { retypeColumns } from "../load/evolve.ts";
import { lakeRigReady, type LakeRig, RIG_SECRETS, rigConnection, startLakeRig, WRITER_KEY, WRITER_LOGIN } from "./lake-testkit.ts";
import { bookkeepingOf } from "./bookkeeping.ts";
import { columnNames } from "./bookkeeping-testkit.ts";
import { ensureState } from "./state.ts";
import { closeAllWarehouses, type DuckWarehouse, openWarehouse } from "./warehouse.ts";

const ready = lakeRigReady();
if (!ready.ready) console.warn(`[lake-warehouse.test] SKIPPING the lake warehouse tests: ${ready.skipReason}`);
const maybe = ready.ready ? test : test.skip;

let rig: LakeRig;
const made: string[] = [];
beforeAll(async () => {
  if (ready.ready) rig = await startLakeRig();
}, 120_000);
afterAll(async () => {
  await closeAllWarehouses();
  await rig?.stop();
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

interface Rig { w: DuckWarehouse; r: DuckWarehouse; root: string; stateDir: string; db: string }

/** A writing warehouse and a read-only one on a new lake, in a new project folder. */
async function fresh(o: { afterLakeCommit?: () => void | Promise<void>; beforeLakeCommit?: (a: { attempt: number; tag: string }) => void | Promise<void>; waits?: Partial<{ offTtyMs: number }>; stateDir?: string; lake?: Awaited<ReturnType<LakeRig["lake"]>> } = {}): Promise<Rig> {
  const lake = o.lake ?? await rig.lake();
  const root = mkdtempSync(join(tmpdir(), "croft-lakewh-"));
  made.push(root);
  const stateDir = o.stateDir ?? join(root, ".croft");
  mkdirSync(stateDir, { recursive: true });
  const conn = rigConnection(rig, lake, { stateDir, extensionDir: ready.dir });
  const base = { path: join(root, `warehouse-${made.length}.duckdb`), timezone: "UTC", root, stateDir, lake: conn, isTTY: false, register: false };
  const w = openWarehouse({ ...base, mode: "read_write", ...(o.afterLakeCommit ? { afterLakeCommit: o.afterLakeCommit } : {}), ...(o.beforeLakeCommit ? { beforeLakeCommit: o.beforeLakeCommit } : {}), ...(o.waits ? { waits: o.waits } : {}) });
  // The read-only handle is another warehouse of its own, on another path, with the same lake.
  const r = openWarehouse({ ...base, path: join(root, `warehouse-r${made.length}.duckdb`), mode: "read_only", profile: "query" });
  return { w, r, root, stateDir, db: lake.db };
}

const count = (w: DuckWarehouse, where = "true") => w.read(async (db) => Number((await db.all<{ n: number | bigint }>(`SELECT count(*) AS n FROM t WHERE ${where}`))[0]!.n), { purpose: "test" });

describe("a warehouse that is a lake", () => {
  maybe("writes in a transaction, and a read-only handle sees the last commit and cannot write", async () => {
    const { w, r } = await fresh();
    await w.write("make t", async (tx) => {
      await tx.exec("CREATE TABLE t (a INTEGER, b VARCHAR)");
      await tx.exec("INSERT INTO t SELECT range, 'x' FROM range(10)");
    }, { runId: "r1" });
    expect(await count(w)).toBe(10);
    expect(await count(r)).toBe(10);
    // The current database is the lake, so `main.t`, `t` and `lake.main.t` are one table, as `warehouse.t` is in a file.
    expect(await r.read(async (db) => (await db.all<{ n: string }>("SELECT current_database() AS n"))[0]!.n, { purpose: "test" })).toBe("lake");
    await expect(r.read((db) => db.exec("INSERT INTO t VALUES (99, 'y')"), { purpose: "test" })).rejects.toThrow(/read-only/i);
    // A rolled-back write leaves nothing.
    await expect(w.write("fails", async (tx) => {
      await tx.exec("INSERT INTO t VALUES (100, 'z')");
      throw new Error("the body failed");
    }, { runId: "r2" })).rejects.toThrow("the body failed");
    expect(await count(r)).toBe(10);
  }, 60_000);

  maybe("a write that commits with no _croft state of its own is given it, and recorded like the rest", async () => {
    const { w, r } = await fresh();
    await w.write("make t", (tx) => tx.exec("CREATE TABLE t (a INTEGER)"), { runId: "r1" }); // a body that made no state
    const meta = await r.read((db) => db.all<{ key: string; value: string }>("SELECT key, value FROM _croft.meta ORDER BY key"), { purpose: "test" });
    expect(meta.map((m) => m.key).filter((k) => !k.startsWith("writer."))).toEqual(expect.arrayContaining(["bookkeeping", "format_version"]));
    const writers = meta.filter((m) => m.key.startsWith("writer."));
    expect(writers.length).toBe(1);
    expect(JSON.parse(writers[0]!.value)).toMatchObject({ run: "r1", n: 1, crossed: null });
  }, 60_000);

  maybe("a lake nobody has written is DB_NOT_FOUND for a reader, and the writer makes it", async () => {
    const { w, r } = await fresh();
    const err = await r.read(async () => 1, { purpose: "test" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CroftError);
    expect((err as CroftError).code).toBe("DB_NOT_FOUND");
    expect((err as CroftError).problem.details).toMatchObject({ notCreated: true });
    await w.write("make t", (tx) => tx.exec("CREATE TABLE t (a INTEGER)"), { runId: "r1" });
    // A new instance for the reader: the failed one is never reused.
    expect(await count(r)).toBe(0);
  }, 60_000);

  maybe("writes on this machine take turns by croft's own lock; the one that waits is told who holds it", async () => {
    const stateDir = join(mkdtempSync(join(tmpdir(), "croft-lakestate-")), ".croft");
    made.push(join(stateDir, ".."));
    const lake = await rig.lake();
    const a = await fresh({ stateDir, lake });
    const b = await fresh({ stateDir, lake, waits: { offTtyMs: 400 } });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let inside!: () => void;
    const entered = new Promise<void>((resolve) => (inside = resolve));
    const first = a.w.write("long write", async (tx) => {
      await tx.exec("CREATE TABLE t (a INTEGER)");
      inside();
      await held;
    }, { runId: "r_first", asset: "orders" });
    await entered;
    const busy = await b.w.write("second", (tx) => tx.exec("CREATE TABLE u (a INTEGER)"), { runId: "r_second", waitMs: 400 }).catch((e: unknown) => e);
    expect(busy).toBeInstanceOf(CroftError);
    expect((busy as CroftError).code).toBe("DB_BUSY");
    expect((busy as CroftError).problem.details?.holder).toMatchObject({ runId: "r_first", asset: "orders" });
    expect((busy as CroftError).message).toContain("the lake is busy: croft run r_first, writing orders");
    release();
    await first;
    // Once the lock is released the other writes.
    await b.w.write("third", (tx) => tx.exec("CREATE TABLE u (a INTEGER)"), { runId: "r_third", waitMs: 5000 });
    expect(await b.w.holder()).toBeNull();
  }, 60_000);

  maybe("a catalog connection that was ended between leases reconnects by itself", async () => {
    const { w } = await fresh();
    await w.write("make t", (tx) => tx.exec("CREATE TABLE t AS SELECT range a FROM range(5)"), { runId: "r1" });
    expect(await rig.pg.terminateConnections()).toBeGreaterThan(0);
    expect(await count(w)).toBe(5);
    expect(await rig.pg.terminateConnections()).toBeGreaterThan(0);
    await w.write("more", (tx) => tx.exec("INSERT INTO t VALUES (100)"), { runId: "r2" });
    expect(await count(w)).toBe(6);
  }, 60_000);

  maybe("a read whose connection dropped inside it is tried again, and the second try succeeds", async () => {
    const { w } = await fresh();
    await w.write("make t", (tx) => tx.exec("CREATE TABLE t AS SELECT range a FROM range(5)"), { runId: "r1" });
    let tries = 0;
    const n = await w.read(async (db) => {
      tries++;
      await db.exec("BEGIN TRANSACTION");
      await db.all("SELECT count(*) FROM t");
      if (tries === 1) await rig.pg.terminateConnections();
      const [row] = await db.all<{ n: number | bigint }>("SELECT count(*) AS n FROM t");
      await db.exec("COMMIT");
      return Number(row!.n);
    }, { purpose: "test" });
    expect(n).toBe(5);
    expect(tries).toBe(2);
  }, 60_000);

  maybe("a write whose connection dropped before its commit is run again once, in a new transaction: one row, not two", async () => {
    const { w } = await fresh();
    await w.write("make t", (tx) => tx.exec("CREATE TABLE t (a INTEGER)"), { runId: "r1" });
    let tries = 0;
    await w.write("insert", async (tx) => {
      tries++;
      await tx.exec("INSERT INTO t VALUES (7)");
      if (tries === 1) await rig.pg.terminateConnections();
    }, { runId: "r2" });
    expect(tries).toBe(2);
    expect(await count(w, "a = 7")).toBe(1);
  }, 60_000);

  maybe("a commit that landed and lost its answer is found by its tag, and the step is not run again", async () => {
    let lost = 0;
    const { w } = await fresh({
      afterLakeCommit: () => {
        if (++lost === 2) throw new Error('Failed to execute query "COMMIT": server closed the connection unexpectedly');
      },
    });
    await w.write("make t", (tx) => tx.exec("CREATE TABLE t (a INTEGER)"), { runId: "r1" }); // the first commit
    let tries = 0;
    const result = await w.write("insert", async (tx) => {
      tries++;
      await tx.exec("INSERT INTO t VALUES (7)");
      return "done";
    }, { runId: "r2" }); // the second commit lands, then its answer is lost
    expect(result).toBe("done");
    expect(tries).toBe(1);
    expect(await count(w, "a = 7")).toBe(1);
  }, 60_000);

  maybe("a commit whose outcome cannot be found out is LAKE_COMMIT_UNCERTAIN, and a lake that stays down is LAKE_CONNECTION_LOST", async () => {
    const { w } = await fresh();
    await w.write("make t", (tx) => tx.exec("CREATE TABLE t (a INTEGER)"), { runId: "r1" });
    // The catalog goes away for good in the middle of a write: both its tries lose the connection.
    const err = await w.write("insert", async (tx) => {
      await tx.exec("INSERT INTO t VALUES (1)");
      await rig.pg.restart(8000);
    }, { runId: "r2" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CroftError);
    expect(["LAKE_COMMIT_UNCERTAIN", "LAKE_CONNECTION_LOST"]).toContain((err as CroftError).code);
    // It is back: the lake is as it was, and works.
    await rig.pg.restart(50);
    expect(await count(w)).toBe(0);
    await w.write("insert", (tx) => tx.exec("INSERT INTO t VALUES (2)"), { runId: "r3" });
    expect(await count(w)).toBe(1);
  }, 120_000);

  maybe("a Postgres that restarts between leases is reached again by the next one", async () => {
    const { w, r } = await fresh();
    await w.write("make t", (tx) => tx.exec("CREATE TABLE t AS SELECT range a FROM range(3)"), { runId: "r1" });
    expect(await count(r)).toBe(3);
    await rig.pg.restart(200);
    expect(await count(r)).toBe(3);
    await w.write("more", (tx) => tx.exec("INSERT INTO t VALUES (9)"), { runId: "r2" });
    expect(await count(r)).toBe(4);
  }, 120_000);

  maybe("an error never carries the password or a key: a wrong password, a store that refuses the key, a host nobody listens on", async () => {
    const bad = async (over: Parameters<LakeRig["lake"]>[0] & { stateDir?: string }) => {
      const lake = await rig.lake();
      const root = mkdtempSync(join(tmpdir(), "croft-lakewh-"));
      made.push(root);
      const stateDir = join(root, ".croft");
      mkdirSync(stateDir, { recursive: true });
      const conn = rigConnection(rig, lake, { stateDir, extensionDir: ready.dir, override: { ...(over?.writerPassword ? { writerPassword: over.writerPassword } : {}), ...(over?.port ? { port: over.port } : {}) } });
      return openWarehouse({ path: join(root, "w.duckdb"), mode: "read_write", timezone: "UTC", root, stateDir, lake: conn, register: false, isTTY: false });
    };
    const texts: string[] = [];
    const wrongPassword = "test-wrong-password";
    const e1 = await (await bad({ writerPassword: wrongPassword })).write("w", (tx) => tx.exec("CREATE TABLE t (a INTEGER)"), { runId: "r1" }).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(CroftError);
    expect((e1 as CroftError).code).toBe("LAKE_ATTACH_FAILED");
    texts.push(JSON.stringify((e1 as CroftError).problem), String((e1 as Error).stack));
    const e2 = await (await bad({ port: 1 })).write("w", (tx) => tx.exec("CREATE TABLE t (a INTEGER)"), { runId: "r1" }).catch((e: unknown) => e);
    expect((e2 as CroftError).code).toBe("LAKE_ATTACH_FAILED");
    texts.push(JSON.stringify((e2 as CroftError).problem), String((e2 as Error).stack));
    // A writer key the store does not know: refused at the first write big enough to make a file (a few rows stay in the catalog), and the
    // store echoes the key id in its answer.
    const lake = await rig.lake({ writerKeyId: "UNKNOWNKEYID0123456" });
    const root = mkdtempSync(join(tmpdir(), "croft-lakewh-"));
    made.push(root);
    const conn = rigConnection(rig, lake, { stateDir: join(root, ".croft"), extensionDir: ready.dir });
    const base = conn.mode;
    const w3 = openWarehouse({
      path: join(root, "w.duckdb"), mode: "read_write", timezone: "UTC", root, stateDir: join(root, ".croft"), register: false, isTTY: false,
      lake: { ...conn, mode: (a) => { const m = base(a); return m.kind === "lake" ? { ...m, lake: { ...m.lake, data: { ...m.lake.data, keyId: "UNKNOWNKEYID0123456" } } } : m; } },
    });
    const e3 = await w3.write("w", (tx) => tx.exec("CREATE TABLE t AS SELECT range a FROM range(20000)"), { runId: "r1" }).catch((e: unknown) => e);
    expect(e3).toBeInstanceOf(Error);
    texts.push(JSON.stringify((e3 as CroftError).problem ?? {}), String((e3 as Error).message), String((e3 as Error).stack));
    for (const secret of [...RIG_SECRETS, wrongPassword, "UNKNOWNKEYID0123456", WRITER_KEY.id, WRITER_LOGIN.password]) {
      for (const t of texts) expect(t, `a secret in an error: ${secret.slice(0, 6)}...`).not.toContain(secret);
    }
  }, 120_000);

  maybe("an earlier attempt's commit that lands after a later attempt began is found before the retry: the step lands once, not twice", async () => {
    const lake = await rig.lake();
    const tags: string[] = [];
    let landLate: (() => Promise<void>) | undefined;
    let armed = false;
    // Attempt 0 reaches its commit and the connection dies there (the commit did not land, as far as anyone can tell). Attempt 1 begins, and
    // while it is about to commit, attempt 0's commit lands after all (another connection of the catalog, with attempt 0's tag).
    const a = await fresh({
      lake,
      beforeLakeCommit: async ({ attempt, tag }) => {
        if (!armed) return;
        tags[attempt] = tag;
        if (attempt === 0) throw new Error("server closed the connection unexpectedly");
        if (attempt === 1) await landLate!();
      },
    });
    const b = await fresh({ lake });
    await a.w.write("make t", async (tx) => {
      await ensureState(tx, { bookkeeping: "log" });
      await tx.exec("CREATE TABLE t (a INTEGER)");
    }, { runId: "r0" });
    landLate = () => b.w.write("attempt 0, late", (tx) => tx.exec("INSERT INTO t VALUES (1)"), { runId: "r1", commitTag: tags[0]! });
    armed = true;
    const result = await a.w.write("the step", async (tx) => {
      await tx.exec("INSERT INTO t VALUES (1)");
      return "done";
    }, { runId: "r1" });
    expect(result).toBe("done");
    expect(tags.length).toBe(2); // attempt 1 conflicted with the late commit, and no third attempt ran
    expect(await a.r.read(async (db) => Number((await db.all<{ n: number | bigint }>("SELECT count(*) AS n FROM t"))[0]!.n), { purpose: "test" })).toBe(1);
  }, 120_000);

  maybe("a write that runs its own transaction (delete, restore) is tagged and records its machine like any other; one that landed without its answer is said, not run again", async () => {
    let lose = false;
    const a = await fresh({
      afterLakeCommit: () => {
        if (lose) throw new Error("server closed the connection unexpectedly");
      },
    });
    await a.w.write("make t", async (tx) => {
      await ensureState(tx, { bookkeeping: "log" });
      await tx.exec("CREATE TABLE t (a INTEGER)");
    }, { runId: "r0" });
    const own = (v: number, run: string) => a.w.write("its own transaction", async (tx) => {
      await tx.exec("BEGIN TRANSACTION");
      await tx.exec(`INSERT INTO t VALUES (${v})`);
      // The log numbers are this transaction's, from the log, as in any write.
      await (await bookkeepingOf(tx)).upsert("assets", Object.fromEntries(columnNames("assets").map((c) => [c, c === "name" ? "'x'" : "NULL"])));
      await tx.exec("COMMIT");
      return "its result";
    }, { runId: run, transaction: false });
    expect(await own(7, "r_own")).toBe("its result");
    const last = await a.r.read(async (db) => ({
      tag: (await db.all<{ m: string }>("SELECT commit_message AS m FROM ducklake_snapshots('lake') ORDER BY snapshot_id DESC LIMIT 1"))[0]!.m,
      writer: (await db.all<{ value: string }>("SELECT value FROM _croft.meta WHERE key LIKE 'writer.%'")).map((r) => JSON.parse(r.value) as { run: string }),
    }), { purpose: "test" });
    expect(last.tag).toMatch(/^croft:\d+:[0-9a-f-]{36}$/);
    expect(last.writer.map((w) => w.run)).toEqual(["r_own"]);
    // The commit landed and the connection dropped before the answer: found by its tag, not run again, and said (the body's result is gone).
    lose = true;
    const err = await own(8, "r_lost").catch((e: unknown) => e);
    lose = false;
    expect(err).toBeInstanceOf(CroftError);
    expect((err as CroftError).code).toBe("LAKE_COMMIT_UNCERTAIN");
    expect((err as CroftError).problem.details).toMatchObject({ landed: true });
    expect(await a.r.read(async (db) => Number((await db.all<{ n: number | bigint }>("SELECT count(*) AS n FROM t WHERE a = 8"))[0]!.n), { purpose: "test" })).toBe(1);
  }, 120_000);

  maybe("a second change of a table in one write is refused by croft's own count, whether or not DuckLake would have read the table back (small tables, wrappers, an ALTER first)", async () => {
    const { w } = await fresh();
    const ref = { ref: "lake.main.u", table: "u", db: "lake" };
    // Three rows stay inlined in the catalog, where DuckLake itself reads a rewritten table back: the refusal must not depend on that.
    await w.write("make u", async (tx) => {
      await tx.exec("CREATE TABLE u (id INTEGER, s VARCHAR, n BIGINT)");
      await tx.exec("INSERT INTO u VALUES (1, '7', 10), (2, '8', 20), (3, '9', 30)");
    }, { runId: "r1" });
    const shape = async () => (await w.read((db) => db.all<{ column_name: string; column_type: string }>("SELECT column_name, column_type FROM (DESCRIBE u)"), { purpose: "test" })).map((c) => [c.column_name, c.column_type]);
    const refused = async (what: string, body: (tx: Parameters<Parameters<typeof w.write>[1]>[0]) => Promise<unknown>) => {
      const err = await w.write(what, body as never, { runId: "r2" }).catch((e: unknown) => e);
      expect(err, what).toBeInstanceOf(CroftError);
      expect((err as CroftError).code, what).toBe("LAKE_UNSUPPORTED");
      expect((err as CroftError).problem.effect, what).toBe("nothing was written");
      expect(await shape(), what).toEqual([["id", "INTEGER"], ["s", "VARCHAR"], ["n", "BIGINT"]]);
    };
    await refused("two rewrites", async (tx) => {
      await retypeColumns(tx, { ...ref, changes: [{ column: "s", from: "VARCHAR", to: "BIGINT" }] });
      await retypeColumns(tx, { ...ref, changes: [{ column: "n", from: "BIGINT", to: "VARCHAR" }] });
    });
    await refused("two rewrites through a wrapper of the transaction's Sql", async (tx) => {
      const wrapped: Sql = { all: <T,>(q: string, p?: unknown[]) => tx.all<T>(q, p), exec: (q: string, p?: unknown[]) => tx.exec(q, p) };
      await retypeColumns(tx, { ...ref, changes: [{ column: "s", from: "VARCHAR", to: "BIGINT" }] });
      await retypeColumns(wrapped, { ...ref, changes: [{ column: "n", from: "BIGINT", to: "VARCHAR" }] });
    });
    await refused("an ALTER, then a rewrite", async (tx) => {
      await retypeColumns(tx, { ...ref, changes: [{ column: "id", from: "INTEGER", to: "BIGINT" }] });
      await retypeColumns(tx, { ...ref, changes: [{ column: "s", from: "VARCHAR", to: "BIGINT" }] });
    });
    // A rewrite and then an ALTER is fine, and the next write may rewrite again: the count is of one transaction.
    await w.write("a rewrite, then an ALTER", async (tx) => {
      await retypeColumns(tx, { ...ref, changes: [{ column: "s", from: "VARCHAR", to: "BIGINT" }] });
      await retypeColumns(tx, { ...ref, changes: [{ column: "id", from: "INTEGER", to: "BIGINT" }] });
    }, { runId: "r3" });
    await w.write("another write, another rewrite", (tx) => retypeColumns(tx, { ...ref, changes: [{ column: "n", from: "BIGINT", to: "VARCHAR" }] }), { runId: "r4" });
    expect(await shape()).toEqual([["id", "BIGINT"], ["s", "BIGINT"], ["n", "VARCHAR"]]);
  }, 120_000);

  maybe("a column's type changes in a lake: a widening is an ALTER, anything else is one rewrite with the same columns, order and rows (retypeColumns)", async () => {
    const { w } = await fresh();
    const ref = { ref: "lake.main.t", table: "t", db: "lake" };
    await w.write("make t", async (tx) => {
      await tx.exec("CREATE TABLE t (id INTEGER, s VARCHAR, n BIGINT, d DATE)");
      await tx.exec("INSERT INTO t SELECT range, (range + 7)::VARCHAR, range * 10, DATE '2026-01-02' FROM range(60)");
    }, { runId: "r1" });
    const shape = async () => (await w.read((db) => db.all<{ column_name: string; column_type: string }>("SELECT column_name, column_type FROM (DESCRIBE t)"), { purpose: "test" })).map((c) => [c.column_name, c.column_type]);
    // A promotion DuckLake takes is an ALTER; one it does not, together with it, is one rewrite for both (a rewrite is not possible after an ALTER).
    await w.write("retype", (tx) => retypeColumns(tx, { ...ref, changes: [{ column: "n", from: "BIGINT", to: "DOUBLE" }, { column: "s", from: "VARCHAR", to: "BIGINT" }] }), { runId: "r2" });
    expect(await shape()).toEqual([["id", "INTEGER"], ["s", "BIGINT"], ["n", "DOUBLE"], ["d", "DATE"]]);
    const rows = await w.read((db) => db.all<{ id: number; s: number | bigint; n: number }>("SELECT id, s, n FROM t ORDER BY id"), { purpose: "test" });
    expect(rows.length).toBe(60);
    expect(rows.map((r) => [r.id, Number(r.s), r.n]).slice(0, 3)).toEqual([[0, 7, 0], [1, 8, 10], [2, 9, 20]]);
    // A rewrite, then an ALTER and a new column, in one write: a lake takes them after the rewrite.
    await w.write("then", async (tx) => {
      await retypeColumns(tx, { ...ref, changes: [{ column: "d", from: "DATE", to: "VARCHAR" }] });
      await retypeColumns(tx, { ...ref, changes: [{ column: "id", from: "INTEGER", to: "BIGINT" }] });
      await tx.exec("ALTER TABLE lake.main.t ADD COLUMN extra VARCHAR");
    }, { runId: "r3" });
    expect(await shape()).toEqual([["id", "BIGINT"], ["s", "BIGINT"], ["n", "DOUBLE"], ["d", "VARCHAR"], ["extra", "VARCHAR"]]);
    // A second rewrite in the write that already rewrote the table cannot be made: a croft code, and nothing written.
    const twice = await w.write("twice", async (tx) => {
      await retypeColumns(tx, { ...ref, changes: [{ column: "s", from: "BIGINT", to: "VARCHAR" }] });
      await retypeColumns(tx, { ...ref, changes: [{ column: "n", from: "DOUBLE", to: "VARCHAR" }] });
    }, { runId: "r4" }).catch((e: unknown) => e);
    expect(twice).toBeInstanceOf(CroftError);
    expect((twice as CroftError).code).toBe("LAKE_UNSUPPORTED");
    expect((twice as CroftError).problem.effect).toBe("nothing was written");
    expect(await shape()).toEqual([["id", "BIGINT"], ["s", "BIGINT"], ["n", "DOUBLE"], ["d", "VARCHAR"], ["extra", "VARCHAR"]]);
    // A change that loses data still fails (the cast refuses), and the write rolls back whole.
    await expect(w.write("bad", (tx) => retypeColumns(tx, { ...ref, changes: [{ column: "d", from: "VARCHAR", to: "BIGINT" }] }), { runId: "r5" })).rejects.toThrow();
    expect((await shape())[3]).toEqual(["d", "VARCHAR"]);
  }, 120_000);
});
