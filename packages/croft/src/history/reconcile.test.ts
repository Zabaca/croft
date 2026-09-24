import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { CroftError } from "../core/errors.ts";
import { bootId, currentIdentity, procStart, type ProcessIdentity } from "../core/proc.ts";
import type { Sql, Warehouse } from "../core/types.ts";
import { acquire as acquireIntent, intentDir, intentFileName, listIntents, release as releaseIntent } from "../db/intent.ts";
import { ensureState } from "../db/state.ts";
import { closeAllWarehouses, openWarehouse } from "../db/warehouse.ts";
import { cleanupProjects, cli, cliEnv, makeProject, mockApi } from "../run/testkit.ts";
import { getCatalog } from "./catalog.ts";
import { acquire, holderOf, listLeases } from "./leases.ts";
import { reconcile } from "./reconcile.ts";
import { RunsDb } from "./runs-db.ts";

afterAll(() => closeAllWarehouses());

interface WriteRow {
  run_id: string; asset: string; rows_in: number; added: number; updated: number;
  attempt?: number | null;   // null: a row from before format 2
  loaded_at?: string;        // default: when the query runs, after every step started
}

/** A Warehouse over an in-memory _croft.writes. `writes: null` means the _croft schema does not exist. */
function fakeWarehouse(init: { writes: WriteRow[] | null; fail?: () => Error }) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  let reads = 0;
  const sql: Sql = {
    async all<T>(text: string, params?: unknown[]): Promise<T[]> {
      calls.push({ sql: text, params });
      if (text.includes("duckdb_columns()")) return [{ n: init.writes ? 16 : 0, attempt: init.writes ? 1 : 0 }] as T[];
      if (text.includes("FROM _croft.writes")) {
        if (!init.writes) throw new Error("Catalog Error: Table with name writes does not exist!");
        // BIGINTs come back as bigint, as from DuckDB.
        return init.writes.filter((w) => params?.includes(w.run_id)).map((w) => ({
          run_id: w.run_id, asset: w.asset, attempt: w.attempt ?? null,
          loaded_us: BigInt(Date.parse(w.loaded_at ?? new Date().toISOString())) * 1000n,
          rows_in: BigInt(w.rows_in), added: BigInt(w.added), updated: BigInt(w.updated),
        })) as T[];
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
    expect(r).toEqual({ crashed: [], recovered: [], lost: [], unresolved: [], releasedLeases: [], stagingDirs: [], purgedIntents: [], problems: [] });
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

  // A run recorded where the boot id could not be read (sysctl not on PATH) is alive while its process is:
  // reconcile must not mark it crashed, release its leases or hand its staging back for deletion.
  for (const boot of ["", "unknown"]) {
    test(`a live run recorded with boot id ${JSON.stringify(boot)} is left alone`, async () => {
      const identity = { ...me(), bootId: boot };
      const run = db.createRun({ trigger: "manual", human: true, argv: ["run"], identity });
      await acquire(db, "orders", run.id, { identity });
      db.startStep({ runId: run.id, asset: "orders", attempt: 1, reason: "requested" });
      mkdirSync(join(dir, "staging", run.id, "orders"), { recursive: true });
      const r = await reconcile({ db, warehouse: fakeWarehouse({ writes: [] }) });
      expect(r.crashed).toEqual([]);
      expect(r.releasedLeases).toEqual([]);
      expect(r.stagingDirs).toEqual([]);
      expect(db.getRun(run.id)?.status).toBe("running");
      expect(listLeases(db).map((l) => [l.asset, l.alive])).toEqual([["orders", true]]);
    });
  }

  test("a dead run recorded with an empty boot id is still crashed (the start time decides)", async () => {
    const run = await crashedRun({ ...deadIdentity(), bootId: "" });
    const r = await reconcile({ db, warehouse: fakeWarehouse({ writes: [] }) });
    expect(r.crashed).toEqual([run.id]);
    expect(r.releasedLeases).toEqual(["customers", "orders", "refs"]);
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
    expect(again).toEqual({ crashed: [], recovered: [], lost: [], unresolved: [], releasedLeases: [], stagingDirs: [], purgedIntents: [], problems: [] });
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

  // croft run's detached parent, and croft wait, mark a run crashed (steps included) the moment they see its
  // process die. DuckDB still decides: the next reconcile checks those steps like any other.
  test("a run already marked crashed by croft run's parent or croft wait still has its steps checked", async () => {
    const run = await crashedRun();
    expect(db.markCrashed(run.id)).toBe(true);
    expect(db.getStep(run.id, "orders", 1)?.status).toBe("crashed");
    const r = await reconcile({ db, warehouse: fakeWarehouse({ writes: [
      { run_id: run.id, asset: "orders", rows_in: 120, added: 100, updated: 20 },
    ] }) });
    expect(r.crashed).toEqual([]);
    expect(r.recovered).toEqual([{ runId: run.id, asset: "orders", attempt: 1, commits: 1 }]);
    expect(r.lost).toEqual([{ runId: run.id, asset: "customers", attempt: 2 }]);
    expect(r.releasedLeases).toEqual(["customers", "orders", "refs"]);
    expect(db.getStep(run.id, "orders", 1)).toMatchObject({ status: "ok", reason: "schedule_due (recovered)", added: 100, error: null });
    const lost = db.getStep(run.id, "customers", 2)!;
    expect(lost).toMatchObject({ status: "crashed", error: { code: "RUN_CRASHED" } });
    expect(lost.finishedAt).not.toBeNull();
    expect(lost.error?.message).toContain("nothing from this step was saved");
    expect(db.danglingSteps()).toEqual([]);
  });

  test("a step an older croft left running in a crashed run is crashed and checked too", async () => {
    const run = await crashedRun();
    db.sqlite.query("UPDATE runs SET status = 'crashed' WHERE id = ?").run(run.id);
    const busy = fakeWarehouse({ writes: null, fail: () => new CroftError("DB_BUSY", { message: "locked", hint: "wait" }) });
    const r1 = await reconcile({ db, warehouse: busy, waitMs: 10 });
    expect(r1.unresolved.map((s) => s.asset).sort()).toEqual(["customers", "orders"]);
    expect(db.getStep(run.id, "orders", 1)).toMatchObject({ status: "crashed", finishedAt: null });
    const r2 = await reconcile({ db, warehouse: fakeWarehouse({ writes: [] }) });
    expect(r2.lost.map((s) => s.asset).sort()).toEqual(["customers", "orders"]);
  });

  test("chunked commits of one step are summed", async () => {
    const run = await crashedRun();
    const r = await reconcile({ db, warehouse: fakeWarehouse({ writes: [
      { run_id: run.id, asset: "orders", rows_in: 500, added: 500, updated: 0 },
      { run_id: run.id, asset: "orders", rows_in: 200, added: 150, updated: 50 },
    ] }) });
    expect(r.recovered).toEqual([{ runId: run.id, asset: "orders", attempt: 1, commits: 2 }]);
    expect(db.getStep(run.id, "orders", 1)).toMatchObject({ status: "ok", reason: "schedule_due (recovered: 2 commits)", rowsIn: 700, added: 650, updated: 50 });
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
    // The run is crashed, and so are its steps (status must not show them running), unchecked until r2.
    expect(db.getStep(run.id, "orders", 1)).toMatchObject({ status: "crashed", finishedAt: null, error: { code: "RUN_CRASHED" } });
    expect(db.getStep(run.id, "customers", 2)).toMatchObject({ status: "crashed", finishedAt: null });

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

  test("a retry that died before committing is lost, even though an earlier attempt committed chunks", async () => {
    const run = db.createRun({ trigger: "schedule", human: false, argv: [], identity: deadIdentity() });
    db.startStep({ runId: run.id, asset: "orders", attempt: 1, reason: "schedule_due" });
    db.finishStep(run.id, "orders", 1, { status: "failed", reason: "schedule_due" });
    db.startStep({ runId: run.id, asset: "orders", attempt: 2, reason: "schedule_due" });
    const r = await reconcile({ db, warehouse: fakeWarehouse({ writes: [
      { run_id: run.id, asset: "orders", attempt: 1, rows_in: 500, added: 500, updated: 0 },
    ] }) });
    expect(r.recovered).toEqual([]);
    expect(r.lost).toEqual([{ runId: run.id, asset: "orders", attempt: 2 }]);
    expect(db.getStep(run.id, "orders", 2)?.status).toBe("crashed");
    expect(db.getStep(run.id, "orders", 1)?.status).toBe("failed");
  });

  test("a retry's own chunks are recovered without the earlier attempt's rows", async () => {
    const run = db.createRun({ trigger: "schedule", human: false, argv: [], identity: deadIdentity() });
    db.startStep({ runId: run.id, asset: "orders", attempt: 1, reason: "schedule_due" });
    db.finishStep(run.id, "orders", 1, { status: "failed", reason: "schedule_due" });
    db.startStep({ runId: run.id, asset: "orders", attempt: 2, reason: "schedule_due" });
    const r = await reconcile({ db, warehouse: fakeWarehouse({ writes: [
      { run_id: run.id, asset: "orders", attempt: 1, rows_in: 500, added: 500, updated: 0 },
      { run_id: run.id, asset: "orders", attempt: 2, rows_in: 200, added: 150, updated: 50 },
      { run_id: run.id, asset: "orders", attempt: 2, rows_in: 10, added: 10, updated: 0 },
    ] }) });
    expect(r.recovered).toEqual([{ runId: run.id, asset: "orders", attempt: 2, commits: 2 }]);
    expect(db.getStep(run.id, "orders", 2)).toMatchObject({ status: "ok", rowsIn: 210, added: 160, updated: 50 });
  });

  test("rows without an attempt (format 1) count only from the dangling step's start", async () => {
    db.close();
    let clock = new Date("2026-09-22T10:00:00.000Z");
    db = RunsDb.open(dir, { now: () => clock });
    const run = db.createRun({ trigger: "schedule", human: false, argv: [], identity: deadIdentity() });
    db.startStep({ runId: run.id, asset: "orders", attempt: 1, reason: "schedule_due" });
    clock = new Date("2026-09-22T10:01:00.000Z");
    db.finishStep(run.id, "orders", 1, { status: "failed", reason: "schedule_due" });
    clock = new Date("2026-09-22T10:02:00.000Z");
    db.startStep({ runId: run.id, asset: "orders", attempt: 2, reason: "schedule_due" });
    db.startStep({ runId: run.id, asset: "customers", attempt: 1, reason: "schedule_due" });
    const r = await reconcile({ db, warehouse: fakeWarehouse({ writes: [
      { run_id: run.id, asset: "orders", attempt: null, loaded_at: "2026-09-22T10:00:30.000Z", rows_in: 500, added: 500, updated: 0 },
      { run_id: run.id, asset: "orders", attempt: null, loaded_at: "2026-09-22T10:02:00.000Z", rows_in: 7, added: 7, updated: 0 },
      { run_id: run.id, asset: "customers", attempt: null, loaded_at: "2026-09-22T10:01:59.999Z", rows_in: 3, added: 3, updated: 0 },
    ] }) });
    expect(r.recovered).toEqual([{ runId: run.id, asset: "orders", attempt: 2, commits: 1 }]);
    expect(db.getStep(run.id, "orders", 2)).toMatchObject({ status: "ok", rowsIn: 7, added: 7 });
    expect(r.lost).toEqual([{ runId: run.id, asset: "customers", attempt: 1 }]);
  });

  test("dead write intents are deleted; live ones stay", async () => {
    acquireIntent(dir, { runId: "r_live" });
    try {
      const child = spawn("sleep", ["0.05"]);
      const exited = { pid: child.pid!, procStart: procStart(child.pid!)!, bootId: bootId() };
      await new Promise((r) => child.on("exit", r));
      // A reused PID, an exited process, and a live PID from before a reboot.
      const rebooted = { pid: 1, procStart: procStart(1) ?? "unknown", bootId: "boot-before-restart" };
      const planted = [deadIdentity(), exited, rebooted].map((id) => plantIntent(id));
      const r = await reconcile({ db, warehouse: fakeWarehouse({ writes: [] }) });
      expect([...r.purgedIntents].sort()).toEqual([...planted].sort());
      for (const f of planted) expect(existsSync(f)).toBe(false);
      expect(listIntents(dir).map((i) => [i.pid, i.runId])).toEqual([[process.pid, "r_live"]]);
    } finally {
      releaseIntent(dir);
    }
  });

  test.skipIf(process.platform === "linux")("a live holder's intent in the old start-time format, from another locale and zone, stays", async () => {
    // What an older croft wrote from a German terminal: `ps -o lstart` text in that locale and zone.
    const text = spawnSync("ps", ["-o", "lstart=", "-p", String(process.pid)], {
      encoding: "utf8", env: { PATH: process.env.PATH ?? "/bin:/usr/bin", LC_ALL: "de_DE.UTF-8", TZ: "Europe/Berlin" },
    }).stdout.trim();
    const file = plantIntent({ ...me(), procStart: text });
    const r = await reconcile({ db, warehouse: fakeWarehouse({ writes: [] }) });
    expect(r.purgedIntents).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });
});

function plantIntent(id: ProcessIdentity): string {
  mkdirSync(intentDir(dir), { recursive: true });
  const file = join(intentDir(dir), intentFileName(id));
  writeFileSync(file, JSON.stringify({ ...id, runId: "r_old", since: new Date().toISOString() }));
  return file;
}

describe("reconcile across processes", () => {
  const RUNS_DB = JSON.stringify(join(import.meta.dir, "runs-db.ts"));

  test("a live run recorded under another locale and time zone is not marked crashed", async () => {
    const child = spawn(process.execPath, ["-e", `
      import { RunsDb } from ${RUNS_DB};
      const db = RunsDb.open(${JSON.stringify(dir)});
      const run = db.createRun({ trigger: "manual", human: true, argv: ["run", "orders"] });
      db.startStep({ runId: run.id, asset: "orders", attempt: 1, reason: "requested" });
      console.log(JSON.stringify({ runId: run.id }));
      setInterval(() => {}, 1000);
    `], { env: { ...process.env, LC_ALL: "de_DE.UTF-8", LANG: "de_DE.UTF-8", TZ: "Europe/Berlin" }, stdio: ["ignore", "pipe", "inherit"] });
    try {
      const line = await createInterface({ input: child.stdout! })[Symbol.asyncIterator]().next();
      const { runId } = JSON.parse(String(line.value)) as { runId: string };
      const r = await reconcile({ db, warehouse: fakeWarehouse({ writes: [] }) });
      expect(r.crashed).toEqual([]);
      expect(db.getRun(runId)?.status).toBe("running");
      child.kill("SIGKILL");
      await new Promise((res) => child.on("exit", res));
      expect((await reconcile({ db, warehouse: fakeWarehouse({ writes: [] }) })).crashed).toEqual([runId]);
    } finally {
      child.kill("SIGKILL");
    }
  }, 20_000);
});

describe("reconcile refreshes the catalog mirror of a recovered step", () => {
  const api = mockApi();
  afterAll(() => {
    api.stop();
    cleanupProjects();
  });

  // A crash between the DuckDB commit and runs.sqlite: the step is recovered as ok, and status/context (which
  // read the mirror) must see the committed rows and cursor, not the previous load's.
  test("rows and cursor come from the warehouse after a crash after the commit", async () => {
    const at = (d: number) => `2026-09-${String(d).padStart(2, "0")}T00:00:00Z`;
    api.state.raw = JSON.stringify([1, 2, 3].map((id) => ({ id, ts: at(id) })));
    const root = makeProject({ "assets/events.ts": `import { ingest } from "@zabaca/croft";
export default ingest({
  key: "id",
  incremental: "ts",
  async *rows({ http }) { yield (await http.get("${api.url}/raw")).json<Record<string, unknown>[]>(); },
});
` });
    const stateDir = join(root, ".croft");
    expect((await cli(root, ["run", "events", "--foreground", "--json"])).code).toBe(0);
    api.state.raw = JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ id: i + 1, ts: at(i + 1) })));
    const killed = await cli(root, ["run", "events", "--foreground", "--json"], cliEnv({ CROFT_FAULT: "after_commit_before_sqlite" }));
    expect(killed.signal).toBe("SIGKILL");

    const runs = RunsDb.open(stateDir);
    const w = openWarehouse({ path: join(root, "warehouse.duckdb"), mode: "read_write", timezone: "UTC", root, stateDir, register: false, isTTY: false });
    try {
      const crashedId = runs.listRuns()[0]!.id;
      expect(getCatalog(runs, "events")).toMatchObject({ rows: 3, cursor: { field: "ts", value: at(3) } });
      const r = await reconcile({ db: runs, warehouse: w });
      expect(r.recovered).toEqual([{ runId: crashedId, asset: "events", attempt: 1, commits: 1 }]);
      expect(getCatalog(runs, "events")).toMatchObject({
        asset: "events", kind: "ingest", write: "merge", key: ["id"], rows: 10, lastRunId: crashedId,
        cursor: { field: "ts", value: at(10), type: "timestamp" },
      });
      expect(getCatalog(runs, "events")!.behavior).toContain("updates rows by id");
    } finally {
      await w.close();
      runs.close();
    }
  }, 60_000);
});

describe("reconcile against a real warehouse", () => {
  function warehouse() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-reconcile-wh-")));
    mkdirSync(join(root, ".croft"));
    return openWarehouse({ path: join(root, "warehouse.duckdb"), mode: "read_write", timezone: "UTC", root, stateDir: join(root, ".croft"), register: false, isTTY: false });
  }
  const legacyRow = `INSERT INTO _croft.writes (asset, loaded_at, run_id, rows_in, added, updated) VALUES ($1, $2::TIMESTAMPTZ, $3, $4, $4, 0)`;
  const row = `INSERT INTO _croft.writes (asset, loaded_at, run_id, rows_in, added, updated, attempt) VALUES ($1, $2::TIMESTAMPTZ, $3, $4, $4, 0, $5)`;

  test("commits are matched by attempt; rows without one by the step's start", async () => {
    const w = warehouse();
    const run = db.createRun({ trigger: "schedule", human: false, argv: [], identity: deadIdentity() });
    db.startStep({ runId: run.id, asset: "orders", attempt: 1, reason: "schedule_due" });
    db.finishStep(run.id, "orders", 1, { status: "failed", reason: "schedule_due" });
    db.startStep({ runId: run.id, asset: "orders", attempt: 2, reason: "schedule_due" });
    db.startStep({ runId: run.id, asset: "customers", attempt: 1, reason: "schedule_due" });
    db.startStep({ runId: run.id, asset: "refs", attempt: 1, reason: "schedule_due" });
    const later = new Date(Date.now() + 3_600_000).toISOString();
    await w.write("seed", async (tx) => {
      await ensureState(tx);
      await tx.exec(row, ["orders", "2001-01-01T00:00:00Z", run.id, 500, 1]);
      await tx.exec(row, ["orders", later, run.id, 20, 2]);
      await tx.exec(legacyRow, ["customers", "2001-01-01T00:00:00Z", run.id, 9]);   // before its step started
      await tx.exec(legacyRow, ["refs", later, run.id, 4]);
    }, { runId: "seed" });
    const r = await reconcile({ db, warehouse: w });
    expect(r.problems).toEqual([]);
    expect(r.recovered.sort((a, b) => a.asset.localeCompare(b.asset))).toEqual([
      { runId: run.id, asset: "orders", attempt: 2, commits: 1 }, { runId: run.id, asset: "refs", attempt: 1, commits: 1 },
    ]);
    expect(r.lost).toEqual([{ runId: run.id, asset: "customers", attempt: 1 }]);
    expect(db.getStep(run.id, "orders", 2)).toMatchObject({ status: "ok", rowsIn: 20 });
  });

  test("a format-1 warehouse, whose _croft.writes has no attempt column, is matched by time alone", async () => {
    const w = warehouse();
    const run = db.createRun({ trigger: "schedule", human: false, argv: [], identity: deadIdentity() });
    db.startStep({ runId: run.id, asset: "orders", attempt: 1, reason: "schedule_due" });
    await w.write("seed", async (tx) => {
      await tx.exec(`CREATE SCHEMA _croft`);
      await tx.exec(`CREATE TABLE _croft.writes (asset VARCHAR, loaded_at TIMESTAMPTZ, run_id VARCHAR, mode VARCHAR,
        rows_in BIGINT, added BIGINT, updated BIGINT, unchanged BIGINT, deleted BIGINT, cursor_before VARCHAR,
        cursor_after VARCHAR, since_used VARCHAR, inputs JSON, schema_changes JSON, code_hash VARCHAR, PRIMARY KEY (asset, loaded_at))`);
      await tx.exec(legacyRow, ["orders", new Date(Date.now() + 60_000).toISOString(), run.id, 3]);
    }, { runId: "seed" });
    const r = await reconcile({ db, warehouse: w });
    expect(r.problems).toEqual([]);
    expect(r.recovered).toEqual([{ runId: run.id, asset: "orders", attempt: 1, commits: 1 }]);
  });
});
