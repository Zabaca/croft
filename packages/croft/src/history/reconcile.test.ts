import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { currentIdentity, type ProcessIdentity } from "../core/proc.ts";
import type { Sql, Warehouse } from "../core/types.ts";
import { acquire, holderOf, listLeases } from "./leases.ts";
import { reconcile } from "./reconcile.ts";
import { RunsDb } from "./runs-db.ts";

interface WriteRow { run_id: string; asset: string; rows_in: number; added: number; updated: number }

/** A Warehouse over an in-memory _croft.writes. `writes: null` means the _croft schema does not exist. */
function fakeWarehouse(init: { writes: WriteRow[] | null; fail?: () => Error }) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  let reads = 0;
  const sql: Sql = {
    async all<T>(text: string, params?: unknown[]): Promise<T[]> {
      calls.push({ sql: text, params });
      if (text.includes("duckdb_tables()")) return [{ n: init.writes ? 1 : 0 }] as T[];
      if (text.includes("FROM _croft.writes")) {
        if (!init.writes) throw new Error("Catalog Error: Table with name writes does not exist!");
        const groups = new Map<string, { run_id: string; asset: string; commits: bigint; rows_in: bigint; added: bigint; updated: bigint }>();
        for (const w of init.writes.filter((w) => params?.includes(w.run_id))) {
          const k = `${w.run_id}/${w.asset}`;
          const g = groups.get(k) ?? { run_id: w.run_id, asset: w.asset, commits: 0n, rows_in: 0n, added: 0n, updated: 0n };
          g.commits += 1n; g.rows_in += BigInt(w.rows_in); g.added += BigInt(w.added); g.updated += BigInt(w.updated);
          groups.set(k, g);
        }
        return [...groups.values()] as T[];   // BIGINTs come back as bigint, as from DuckDB
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
    async exec() {
      throw new Error("reconcile must not write");
    },
  };
  const wh: Warehouse & { readonly reads: number; calls: typeof calls; purposes: string[] } = {
    calls,
    purposes: [],
    get reads() { return reads; },
    async read(fn, o) {
      reads++;
      wh.purposes.push(o?.purpose ?? "");
      if (init.fail) throw init.fail();
      return fn(sql);
    },
    async write() {
      throw new Error("reconcile must not write");
    },
    async holder() {
      return null;
    },
  };
  return wh;
}

let dir: string;
let db: RunsDb;
const me = () => currentIdentity();
const deadIdentity = (): ProcessIdentity => ({ ...me(), procStart: "Mon Jan  1 00:00:00 2001" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "croft-reconcile-"));
  db = RunsDb.open(dir);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A run whose process died mid-way: `orders` committed, `customers` was in flight, `refs` finished. */
async function crashedRun(identity = deadIdentity()) {
  const run = db.createRun({ trigger: "schedule", human: false, argv: ["run", "--due"], identity });
  await acquire(db, ["customers", "orders", "refs"], run.id, { identity });
  db.startStep({ runId: run.id, asset: "refs", attempt: 1, reason: "schedule_due" });
  db.finishStep(run.id, "refs", 1, { status: "unchanged", reason: "schedule_due" });
  db.startStep({ runId: run.id, asset: "orders", attempt: 1, reason: "schedule_due" });
  db.startStep({ runId: run.id, asset: "customers", attempt: 2, reason: "input_changed" });
  return run;
}

describe("reconcile", () => {
  test("with nothing running it does not touch the warehouse", async () => {
    const wh = fakeWarehouse({ writes: [] });
    const r = await reconcile({ db, warehouse: wh });
    expect(r).toEqual({ crashed: [], recovered: [], lost: [], unresolved: [], releasedLeases: [], stagingDirs: [], problems: [] });
    expect(wh.reads).toBe(0);
  });

  test("a run whose process is alive is left alone", async () => {
    const run = db.createRun({ trigger: "manual", human: true, argv: ["run"] });
    await acquire(db, "orders", run.id);
    db.startStep({ runId: run.id, asset: "orders", attempt: 1, reason: "requested" });
    const wh = fakeWarehouse({ writes: [] });
    const r = await reconcile({ db, warehouse: wh });
    expect(r.crashed).toEqual([]);
    expect(wh.reads).toBe(0);
    expect(db.getRun(run.id)?.status).toBe("running");
    expect(holderOf(db, "orders")?.runId).toBe(run.id);
  });

  test("a dead run becomes crashed; a landed commit becomes ok (recovered); the rest crashed", async () => {
    const run = await crashedRun();
    const other = db.createRun({ trigger: "manual", human: true, argv: ["run"] });   // live, untouched
    const staging = join(dir, "staging", run.id);
    mkdirSync(join(staging, "orders"), { recursive: true });
    db.setLockHolder({ pid: run.pid!, runId: run.id, asset: "orders", action: "write" });
    const wh = fakeWarehouse({ writes: [
      { run_id: run.id, asset: "orders", rows_in: 120, added: 100, updated: 20 },
      { run_id: "r_someone_else", asset: "customers", rows_in: 5, added: 5, updated: 0 },
    ] });

    const r = await reconcile({ db, warehouse: wh });
    expect(r.crashed).toEqual([run.id]);
    expect(r.recovered).toEqual([{ runId: run.id, asset: "orders", attempt: 1, commits: 1 }]);
    expect(r.lost).toEqual([{ runId: run.id, asset: "customers", attempt: 2 }]);
    expect(r.unresolved).toEqual([]);
    expect(r.releasedLeases).toEqual(["customers", "orders", "refs"]);
    expect(r.stagingDirs).toEqual([staging]);
    expect(r.problems).toEqual([]);
    expect(wh.reads).toBe(1);
    expect(wh.purposes).toEqual(["reconcile"]);
    expect(wh.calls[1]?.params).toEqual([run.id]);

    expect(db.getRun(run.id)?.status).toBe("crashed");
    expect(db.getRun(other.id)?.status).toBe("running");
    expect(db.getStep(run.id, "orders", 1)).toMatchObject({ status: "ok", reason: "schedule_due (recovered)",
      rowsIn: 120, added: 100, updated: 20, error: null });
    const lost = db.getStep(run.id, "customers", 2)!;
    expect(lost).toMatchObject({ status: "crashed", reason: "input_changed" });
    expect(lost.error).toMatchObject({ code: "RUN_CRASHED", asset: "customers", runId: run.id, retryable: true,
      fix: { kind: "command", command: "croft run customers" } });
    expect(db.getStep(run.id, "refs", 1)?.status).toBe("unchanged");
    expect(listLeases(db)).toEqual([]);
    expect(db.getLockHolder()).toBeNull();
    expect(db.listRuns({ failed: true }).map((x) => x.id)).toEqual([run.id]);
  });

  test("reconcile is idempotent", async () => {
    await crashedRun();
    const wh = fakeWarehouse({ writes: [] });
    await reconcile({ db, warehouse: wh });
    const again = await reconcile({ db, warehouse: wh });
    expect(again).toEqual({ crashed: [], recovered: [], lost: [], unresolved: [], releasedLeases: [], stagingDirs: [], problems: [] });
    expect(wh.reads).toBe(1);
  });

  test("a rebooted machine means every old run crashed, even with a matching pid", async () => {
    const run = await crashedRun({ ...me(), bootId: "boot-before-restart" });
    const r = await reconcile({ db, warehouse: fakeWarehouse({ writes: [] }) });
    expect(r.crashed).toEqual([run.id]);
    expect(r.lost).toHaveLength(2);
  });

  test("a warehouse with no _croft schema yet means nothing committed", async () => {
    const run = await crashedRun();
    const wh = fakeWarehouse({ writes: null });
    const r = await reconcile({ db, warehouse: wh });
    expect(r.lost.map((s) => s.asset).sort()).toEqual(["customers", "orders"]);
    expect(wh.calls).toHaveLength(1);   // only the existence check
    expect(db.getStep(run.id, "orders", 1)?.status).toBe("crashed");
  });

  test("chunked commits of one step are summed", async () => {
    const run = await crashedRun();
    const r = await reconcile({ db, warehouse: fakeWarehouse({ writes: [
      { run_id: run.id, asset: "orders", rows_in: 500, added: 500, updated: 0 },
      { run_id: run.id, asset: "orders", rows_in: 200, added: 150, updated: 50 },
    ] }) });
    expect(r.recovered).toEqual([{ runId: run.id, asset: "orders", attempt: 1, commits: 2 }]);
    expect(db.getStep(run.id, "orders", 1)).toMatchObject({ rowsIn: 700, added: 650, updated: 50 });
  });

  test("a busy warehouse leaves steps unresolved, still releases leases, and a later call resolves them", async () => {
    const run = await crashedRun();
    const busy = fakeWarehouse({
      writes: null,
      fail: () => new CroftError("DB_BUSY", { message: "warehouse.duckdb is locked by croft run r_x", hint: "wait" }),
    });
    const r1 = await reconcile({ db, warehouse: busy, waitMs: 10 });
    expect(r1.crashed).toEqual([run.id]);
    expect(r1.releasedLeases).toEqual(["customers", "orders", "refs"]);
    expect(r1.unresolved.map((s) => s.asset).sort()).toEqual(["customers", "orders"]);
    expect(r1.problems).toHaveLength(1);
    expect(r1.problems[0]).toMatchObject({ code: "DB_BUSY", severity: "warning" });
    expect(r1.problems[0]?.message).toContain("could not check which steps of crashed runs committed");
    expect(db.getStep(run.id, "orders", 1)?.status).toBe("running");

    const r2 = await reconcile({ db, warehouse: fakeWarehouse({ writes: [
      { run_id: run.id, asset: "orders", rows_in: 1, added: 1, updated: 0 },
    ] }) });
    expect(r2.crashed).toEqual([]);
    expect(r2.recovered.map((s) => s.asset)).toEqual(["orders"]);
    expect(r2.lost.map((s) => s.asset)).toEqual(["customers"]);
  });

  test("an unexpected warehouse error becomes an INTERNAL_ERROR warning", async () => {
    await crashedRun();
    const r = await reconcile({ db, warehouse: fakeWarehouse({ writes: [], fail: () => new Error("boom") }) });
    expect(r.problems[0]).toMatchObject({ code: "INTERNAL_ERROR", severity: "warning" });
    expect(r.unresolved).toHaveLength(2);
  });

  test("dead leases of finished runs and dead waiters are swept too", async () => {
    const done = db.createRun({ trigger: "manual", human: true, argv: [] });
    db.finishRun(done.id, "succeeded");
    await acquire(db, "stale", done.id, { identity: deadIdentity() });
    db.registerWaiter("query", 2 ** 22 + 12345);   // above macOS and default Linux pid_max
    db.registerWaiter("run");
    const r = await reconcile({ db, warehouse: fakeWarehouse({ writes: [] }) });
    expect(r.releasedLeases).toEqual(["stale"]);
    expect(db.listWaiters().map((w) => w.pid)).toEqual([process.pid]);
  });

  test("a lock holder whose process is gone is cleared; a live one stays", async () => {
    db.setLockHolder({ pid: 2 ** 22 + 12345, action: "write" });
    await reconcile({ db, warehouse: fakeWarehouse({ writes: [] }) });
    expect(db.getLockHolder()).toBeNull();
    db.setLockHolder({ action: "write" });
    await reconcile({ db, warehouse: fakeWarehouse({ writes: [] }) });
    expect(db.getLockHolder()?.pid).toBe(process.pid);
  });
});
