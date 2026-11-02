// A lake's maintenance steps against a real lake (db/lake-maintenance.ts; DESIGN.md D149 to D152; option 07, slice 3): a local lake (a SQLite
// catalog and a folder) and a Postgres catalog with an S3-compatible store, the latter started as children of this test and killed in
// teardown. What is under test is the warehouse and the steps, with no project and no CLI: what a pass expires and keeps, a server error from
// the store, another tool's expiry option, files that are not the lake's own, and the lock.
//
// DuckLake stamps a snapshot with the time of its commit, so a test that needs weeks says after each write when it was made (the lake clock
// of lake-testkit.ts), and gives the pass a `now`; croft's own code is unchanged.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CroftError } from "../core/errors.ts";
import { lakeRigReady, type LakeRig, openTestLake, startLakeRig, type TestLake, type TestLakeKind } from "./lake-testkit.ts";
import { ageBasedExpiryOptions, deleteOrphans, listOrphans, type PassReport, runPass, type RetryPolicy } from "./lake-maintenance.ts";
import { MAINTENANCE_LOCK_LABEL } from "./lake.ts";
import { closeAllWarehouses, openWarehouse, refuseOnLake } from "./warehouse.ts";

const ready = lakeRigReady();
if (!ready.ready) console.warn(`[lake-steps.test] SKIPPING the real-lake tests: ${ready.skipReason}`);

const DAY = 86_400_000;
const NOW = new Date("2026-11-02T12:00:00Z");
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY);
/** A retry policy that does not wait. */
const QUICK: RetryPolicy = { attempts: 3, baseMs: 1, sleep: async () => {} };

let rig: LakeRig | undefined;
const opened: TestLake[] = [];
const root = { dirs: [] as string[] };
beforeAll(async () => {
  if (ready.ready) rig = await startLakeRig();
}, 120_000);
afterAll(async () => {
  for (const l of opened) await l.close();
  await closeAllWarehouses();
  await rig?.stop();
  for (const d of root.dirs) rmSync(d, { recursive: true, force: true });
});

async function fresh(kind: TestLakeKind, waits?: Partial<{ offTtyMs: number }>): Promise<TestLake> {
  const l = await openTestLake(kind, { extensionDir: ready.dir, ...(rig ? { rig } : {}), ...(waits ? { waits } : {}) });
  opened.push(l);
  root.dirs.push(l.root);
  return l;
}

/** One write, and the snapshot it made, said to have been made `daysAgo` days before NOW. */
async function version(l: TestLake, label: string, fn: (tx: { exec(sql: string): Promise<void> }) => Promise<void>, daysAgo: number): Promise<number> {
  await l.w.write(label, (tx) => fn(tx), { runId: "r_test", asset: label });
  return l.clock.mark(ago(daysAgo));
}

const pass = (l: TestLake, o: { pins?: number[]; retry?: RetryPolicy; now?: Date } = {}): Promise<PassReport> =>
  l.w.write(MAINTENANCE_LOCK_LABEL, (sql) => runPass(sql, { now: o.now ?? NOW, pins: o.pins ?? [], retry: o.retry ?? QUICK }), { runId: "maintenance", transaction: false, touchesLake: false });

const rowsAt = async (l: TestLake, table: string, v?: number): Promise<number> =>
  Number((await l.w.read((db) => db.all<{ n: number | bigint }>(`SELECT count(*) AS n FROM ${table}${v === undefined ? "" : ` AT (VERSION => ${v})`}`), { purpose: "test" }))[0]!.n);
const readable = (l: TestLake, table: string, v: number): Promise<boolean> => rowsAt(l, table, v).then(() => true, () => false);

/** orders: 8 versions of 12 rows each, 60 to 53 days ago; users: 2 versions of 3 rows, 45 and 44 days ago; then bookkeeping, a day ago. */
async function history(l: TestLake): Promise<{ orders: number[]; users: number[]; last: number }> {
  const orders: number[] = [];
  for (let k = 1; k <= 8; k++) {
    orders.push(await version(l, "orders", async (tx) => {
      if (k === 1) await tx.exec("CREATE TABLE orders (id INTEGER, v INTEGER)");
      await tx.exec(`INSERT INTO orders SELECT range, ${k} FROM range(12)`);
    }, 61 - k));
  }
  const users: number[] = [];
  for (let k = 1; k <= 2; k++) {
    users.push(await version(l, "users", async (tx) => {
      if (k === 1) await tx.exec("CREATE TABLE users (id INTEGER)");
      await tx.exec(`INSERT INTO users SELECT range FROM range(3)`);
    }, 46 - k));
  }
  const last = await version(l, "note", (tx) => tx.exec("CREATE TABLE note AS SELECT 1 AS x"), 1);
  return { orders, users, last };
}

for (const kind of ["local", "postgres"] as const) {
  const maybe = ready.ready ? test : test.skip;

  describe(`a pass on a ${kind} lake`, () => {
    maybe("expires the snapshots outside the promise, keeps the rest, and what is kept reads back exactly", async () => {
      const l = await fresh(kind);
      const h = await history(l);
      const report = await pass(l);
      expect(report.ok, JSON.stringify(report.steps)).toBe(true);
      expect(report.steps.map((s) => [s.step, s.status])).toEqual([["flush", "ok"], ["expire", "ok"], ["merge", "ok"], ["rewrite", "ok"], ["cleanup", "ok"]]);
      // Fewer snapshots, and the promise's own count of what stays.
      expect(report.after.snapshots).toBeLessThan(report.before.snapshots);
      expect(report.plan.expired).toBeGreaterThan(0);
      // orders' 5 newest versions (4..8) read back with exactly the rows they had; the 3 oldest are gone; so are users' none (2 versions).
      for (let k = 4; k <= 8; k++) expect(await rowsAt(l, "orders", h.orders[k - 1]), `orders v${k}`).toBe(12 * k);
      for (let k = 1; k <= 3; k++) expect(await readable(l, "orders", h.orders[k - 1]!), `orders v${k} is gone`).toBe(false);
      for (let k = 1; k <= 2; k++) expect(await rowsAt(l, "users", h.users[k - 1]), `users v${k}`).toBe(3 * k);
      expect(await rowsAt(l, "orders")).toBe(96);
      expect(await rowsAt(l, "note", h.last)).toBe(1);
      // A second pass has nothing left to expire.
      const again = await pass(l);
      expect(again.ok).toBe(true);
      expect(again.plan.expired).toBe(0);
    }, 120_000);

    maybe("a snapshot the trash pins stays, and the pass leaves the lake to a reader and a second pass", async () => {
      const l = await fresh(kind);
      const h = await history(l);
      const report = await pass(l, { pins: [h.orders[1]!] });
      expect(report.ok).toBe(true);
      expect(report.plan.because.pinned).toBe(1);
      expect(await rowsAt(l, "orders", h.orders[1]!)).toBe(24); // v2, 59 days old, restorable
      expect(await readable(l, "orders", h.orders[2]!)).toBe(false); // v3, not pinned, gone
      // A reader (the read-only login) sees the same.
      expect(Number((await l.r.read((db) => db.all<{ n: number | bigint }>(`SELECT count(*) AS n FROM orders AT (VERSION => ${h.orders[1]})`), { purpose: "test" }))[0]!.n)).toBe(24);
    }, 120_000);

    maybe("small files are merged and the rows the catalog held are flushed into files, with every version still readable", async () => {
      const l = await fresh(kind);
      const ids: number[] = [];
      for (let i = 1; i <= 6; i++) {
        ids.push(await version(l, "ticks", async (tx) => {
          if (i === 1) await tx.exec("CREATE TABLE ticks (n INTEGER)");
          await tx.exec(`INSERT INTO ticks SELECT range FROM range(${i % 2 ? 4 : 20})`); // odd: inlined in the catalog; even: a file
        }, 6 - i));
      }
      const report = await pass(l);
      expect(report.ok).toBe(true);
      expect(report.after.dataFiles).toBeLessThan(report.before.dataFiles);
      expect(report.steps.find((s) => s.step === "flush")!.did.rows).toBeGreaterThan(0);
      expect(report.steps.find((s) => s.step === "merge")!.did.merged).toBeGreaterThan(1);
      // Everything is within 30 days, so every version is still there, with the rows it had.
      expect(report.plan.expired).toBe(0);
      let rows = 0;
      for (let i = 1; i <= 6; i++) {
        rows += i % 2 ? 4 : 20;
        expect(await rowsAt(l, "ticks", ids[i - 1]), `ticks v${i}`).toBe(rows);
      }
    }, 120_000);

    maybe("another tool's age-based expiry on the lake expires nothing the promise keeps: not the pass, and not closing croft's instance (acceptance 3)", async () => {
      const l = await fresh(kind);
      const h = await history(l);
      await l.clock.setOption("expire_older_than", "2 days");
      expect((await l.r.read((db) => ageBasedExpiryOptions(db), { purpose: "test" })).map((o) => [o.name, o.value])).toEqual([["expire_older_than", "2 days"]]);
      await pass(l);
      // Closing croft's instance on the lake (as every command ends) runs nothing of DuckLake's: the next instance finds what the plan left.
      await l.close();
      for (let k = 4; k <= 8; k++) expect(await rowsAt(l, "orders", h.orders[k - 1]), `orders v${k}`).toBe(12 * k);
      for (let k = 1; k <= 2; k++) expect(await rowsAt(l, "users", h.users[k - 1]), `users v${k}`).toBe(3 * k);
    }, 120_000);
  });
}

// ---- Files that are not the lake's own ---------------------------------------------------------------------------

/** A file in the lake's data folder that the catalog does not name, `days` days old. */
function stray(l: TestLake, name: string, days: number): string {
  const dir = join(l.dataDir, "main", "orders");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, "not a parquet file");
  const when = new Date(Date.now() - days * DAY);
  utimesSync(file, when, when);
  return file;
}

for (const kind of ["local", "postgres"] as const) {
  const maybe = ready.ready ? test : test.skip;

  describe(`files that are not the lake's own, on a ${kind} lake`, () => {
    maybe("are listed without being deleted when they are a day old, and deleted only when the list the person saw is exactly what is found (acceptance 5)", async () => {
      const l = await fresh(kind);
      await history(l);
      const old = stray(l, "left-by-a-crashed-write.parquet", 3);
      const young = stray(l, "written-a-minute-ago.parquet", 0);
      const asked = { runId: "m", transaction: false, touchesLake: false } as const;
      const found = (await l.w.write(MAINTENANCE_LOCK_LABEL, (sql) => listOrphans(sql, QUICK), asked)).files;
      expect(found.length).toBe(1);
      expect(found[0]).toContain("left-by-a-crashed-write.parquet");
      // The dry run touched nothing, and a pass leaves the file alone.
      expect(existsSync(old)).toBe(true);
      await pass(l);
      expect(existsSync(old)).toBe(true);
      // A list that is not what is found now deletes nothing.
      expect(await l.w.write(MAINTENANCE_LOCK_LABEL, (sql) => deleteOrphans(sql, ["somewhere/else.parquet"], QUICK), asked)).toBeNull();
      expect(existsSync(old)).toBe(true);
      const done = await l.w.write(MAINTENANCE_LOCK_LABEL, (sql) => deleteOrphans(sql, found, QUICK), asked);
      expect(done?.files).toEqual(found);
      expect(existsSync(old)).toBe(false);
      expect(existsSync(young)).toBe(true);
      // The lake's own files are all still there.
      expect(await rowsAt(l, "orders")).toBe(96);
    }, 120_000);
  });

  describe(`the lock, on a ${kind} lake`, () => {
    maybe("a pass does not run while a write holds the lock, and a write waits for a pass in progress (acceptance 8)", async () => {
      const a = await fresh(kind, { offTtyMs: 400 });
      await version(a, "orders", (tx) => tx.exec("CREATE TABLE orders AS SELECT range id FROM range(20)"), 3);
      // A second warehouse on the same lake and the same state folder: another process of the machine.
      const b = openWarehouse({ path: join(a.root, "b.duckdb"), mode: "read_write", timezone: "UTC", root: a.root, stateDir: a.stateDir, lake: a.conn, isTTY: false, register: false, waits: { offTtyMs: 400 } });
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let inside!: () => void;
      const entered = new Promise<void>((r) => (inside = r));
      const write = a.w.write("long write", async (tx) => {
        await tx.exec("INSERT INTO orders VALUES (100)");
        inside();
        await held;
      }, { runId: "r_write", asset: "orders" });
      await entered;
      // The pass waits for the write's lock and, after its short wait, is told who holds it; nothing was expired meanwhile.
      const busy = await b.write(MAINTENANCE_LOCK_LABEL, (sql) => runPass(sql, { now: NOW, pins: [], retry: QUICK }), { runId: "maintenance", transaction: false, touchesLake: false, waitMs: 300 }).catch((e: unknown) => e);
      expect(busy).toBeInstanceOf(CroftError);
      expect((busy as CroftError).code).toBe("DB_BUSY");
      expect((busy as CroftError).problem.details?.holder).toMatchObject({ runId: "r_write", asset: "orders", action: "write" });
      release();
      await write;
      // Now a pass holds the lock while a write asks: the write is told it is the maintenance.
      let atStep!: () => void;
      const started = new Promise<void>((r) => (atStep = r));
      let go!: () => void;
      const proceed = new Promise<void>((r) => (go = r));
      const running = a.w.write(MAINTENANCE_LOCK_LABEL, (sql) => runPass(sql, {
        now: NOW, pins: [], retry: QUICK, onStep: async (step) => { if (step === "expire") { atStep(); await proceed; } },
      }), { runId: "maintenance", transaction: false, touchesLake: false });
      await started;
      const waiting = await b.write("a run's step", (tx) => tx.exec("INSERT INTO orders VALUES (101)"), { runId: "r_next", waitMs: 300 }).catch((e: unknown) => e);
      expect(waiting).toBeInstanceOf(CroftError);
      expect((waiting as CroftError).code).toBe("DB_BUSY");
      expect((waiting as CroftError).message).toContain("croft is running the lake's maintenance");
      expect((waiting as CroftError).problem.details?.holder).toMatchObject({ action: "maintenance" });
      go();
      expect((await running).ok).toBe(true);
      // Once the pass is over the write goes through.
      await b.write("a run's step", (tx) => tx.exec("INSERT INTO orders VALUES (101)"), { runId: "r_next", waitMs: 5000 });
      expect(await rowsAt(a, "orders")).toBe(22);
      await b.close();
    }, 120_000);
  });
}

describe("a store that answers HTTP 500 to a bulk delete (R2 did, three times in five days)", () => {
  const maybe = ready.ready ? test : test.skip;

  maybe("the delete is tried again; a pass that still fails is reported, leaves the lake usable, and the next pass finishes the cleanup (acceptance 6)", async () => {
    const l = await fresh("postgres");
    await history(l);
    const store = l.s3!;
    // Two refusals, then success: the third try of the cleanup step does it.
    await store.failDeletes(2, 500);
    const ok = await pass(l);
    expect(ok.ok, JSON.stringify(ok.steps)).toBe(true);
    expect(ok.steps.find((s) => s.step === "cleanup")!.attempts).toBe(3);
    expect((await store.stats()).failedDeletes).toBe(2);
    expect(ok.after.pendingDeletion).toBe(0);
    // A store that is down for the whole pass.
    const l2 = await fresh("postgres");
    const h2 = await history(l2);
    await store.failDeletes(1000, 500);
    const failed = await pass(l2);
    expect(failed.ok).toBe(false);
    expect(failed.steps.map((s) => s.status)).toEqual(["ok", "ok", "ok", "ok", "failed"]);
    expect(failed.steps[4]!.attempts).toBe(3);
    expect(failed.steps[4]!.error).toContain("HTTP 500");
    expect(failed.after.pendingDeletion).toBeGreaterThan(0);
    // The lake is usable: reads, a write, and the kept versions.
    expect(await rowsAt(l2, "orders")).toBe(96);
    expect(await rowsAt(l2, "orders", h2.orders[7])).toBe(96);
    await l2.w.write("another", (tx) => tx.exec("INSERT INTO orders VALUES (1000, 9)"), { runId: "r_more" });
    expect(await rowsAt(l2, "orders")).toBe(97);
    // The store is back: the next pass deletes the files the last one could not.
    await store.failDeletes(0, 500);
    const next = await pass(l2);
    expect(next.ok, JSON.stringify(next.steps)).toBe(true);
    expect(next.after.pendingDeletion).toBe(0);
  }, 180_000);
});

describe("what croft never runs on a lake", () => {
  test("CHECKPOINT, an option set on the lake and an expiry that is not by an explicit list are refused (acceptance 4)", () => {
    for (const sql of ["CHECKPOINT", "checkpoint lake", "FORCE CHECKPOINT", "CALL lake.set_option('expire_older_than', '3 days')",
      "CALL ducklake_expire_snapshots('lake', older_than => now() - INTERVAL 3 DAY)", "CALL ducklake_expire_snapshots('lake')"]) {
      expect(() => refuseOnLake(sql), sql).toThrow(/does not run CHECKPOINT on a lake/);
    }
    for (const sql of ["CALL ducklake_expire_snapshots('lake', versions => [1, 2, 3])", "CALL ducklake_expire_snapshots('lake', versions => [1], dry_run => true)", "SELECT 1",
      "SELECT 'a checkpoint' AS t FROM x"]) {
      expect(() => refuseOnLake(sql), sql).not.toThrow();
    }
  });

  (ready.ready ? test : test.skip)("a lake warehouse refuses them, and no source file of croft issues one", async () => {
    const l = await fresh("local");
    await l.w.write("t", (tx) => tx.exec("CREATE TABLE t (a INTEGER)"), { runId: "r" });
    await expect(l.w.write("x", (tx) => tx.exec("CHECKPOINT"), { runId: "r", transaction: false, touchesLake: false })).rejects.toThrow(/does not run CHECKPOINT on a lake/);
    await expect(l.w.read((db) => db.exec("CALL lake.set_option('expire_older_than', '1 day')"), { purpose: "test" })).rejects.toThrow(/does not run CHECKPOINT on a lake/);
    // The source: croft's code has no set_option call and no age-based expiry, and CHECKPOINT is the file warehouse's alone (the backup of
    // a file and the read copy, which a lake project never reaches).
    const src = join(import.meta.dir, "..");
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.ts$/.test(e.name) && !/\.test\.ts$|testkit\.ts$/.test(e.name)) {
          for (const m of readFileSync(p, "utf8").matchAll(/(["'`])[^"'`\n]*\b(CHECKPOINT|set_option|expire_older_than)\b[^"'`\n]*\1/g)) hits.push(`${relative(src, p)}: ${m[0].slice(0, 90)}`);
        }
      }
    };
    walk(src);
    const surprising = hits.filter((h) => !/^db\/(backup|readcopy)\.ts: /.test(h) && !/^db\/warehouse\.ts: /.test(h) && !/^db\/lake-maintenance\.ts: /.test(h));
    expect(surprising).toEqual([]);
  }, 60_000);
});
