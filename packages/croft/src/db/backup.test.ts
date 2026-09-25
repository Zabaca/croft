// Pre-upgrade backups (db/backup.ts, DESIGN.md §6 "Before an engine upgrade"): the engine a writer runs is recorded in
// runs.sqlite; before the first read-write open with a newer one, warehouse.duckdb and its WAL are copied whole to
// .croft/backups/<stamp>-<old>-to-<new>.duckdb, by a child process, and the 3 newest backups are kept. The engine
// version is injected throughout: these tests never depend on the DuckDB this machine has.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { RunsDb } from "../history/runs-db.ts";
import { cleanup as cleanupChildren, spawnIdle, writeIntent } from "../read/testkit.ts";
import {
  BACKUPS_DIR, BACKUPS_KEPT, backupBeforeUpgrade, backupsDir, compareEngineVersions, ENGINE_SETTING, type EngineRecord, listBackups, recordedEngine,
} from "./backup.ts";
import { closeAllWarehouses, openWarehouse } from "./warehouse.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "croft-backup-")));
afterEach(async () => {
  await closeAllWarehouses();
});
afterAll(() => {
  cleanupChildren();
  rmSync(base, { recursive: true, force: true });
});

let n = 0;
/** A project folder with its state folder; `rows` seeds warehouse.duckdb, and `wal` leaves those rows in its WAL. */
async function project(o: { rows?: number; wal?: boolean } = {}): Promise<{ root: string; stateDir: string; database: string }> {
  const root = join(base, `p${n++}`);
  const stateDir = join(root, ".croft");
  mkdirSync(stateDir, { recursive: true });
  const database = join(root, "warehouse.duckdb");
  if (o.rows !== undefined) await seed(database, o.rows, o.wal === true);
  return { root, stateDir, database };
}

/** A warehouse file with `rows` rows in t. With `wal`, the rows are committed but left in the WAL (a child process
 *  is killed before it checkpoints), as a crash can leave them. */
async function seed(database: string, rows: number, wal: boolean): Promise<void> {
  if (!wal) {
    const db = await DuckDBInstance.create(database);
    const c = await db.connect();
    await c.run(`CREATE TABLE t AS SELECT range AS n FROM range(${rows})`);
    c.disconnectSync();
    db.closeSync();
    return;
  }
  const script = `const { DuckDBInstance } = require(${JSON.stringify(Bun.resolveSync("@duckdb/node-api", import.meta.dir))});
(async () => {
  const db = await DuckDBInstance.create(process.env.DB, { checkpoint_threshold: "1TB" });
  const c = await db.connect();
  await c.run("CREATE TABLE t (n BIGINT)");
  await c.run("CHECKPOINT");
  await c.run("INSERT INTO t SELECT range FROM range(" + process.env.ROWS + ")");
  process.kill(process.pid, "SIGKILL");
})();`;
  const r = Bun.spawnSync([process.execPath, "-e", script], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", DB: database, ROWS: String(rows) } });
  expect(r.signalCode).toBe("SIGKILL");
  expect(existsSync(`${database}.wal`)).toBe(true);
}

/** Rows of t in a DuckDB file (its WAL replayed), through a private instance on a scratch copy. */
async function count(file: string): Promise<number> {
  const db = await DuckDBInstance.create(file);
  const c = await db.connect();
  try {
    return Number((await c.runAndReadAll("SELECT count(*) AS n FROM t")).getRowObjectsJS()[0]!.n);
  } finally {
    c.disconnectSync();
    db.closeSync();
  }
}

function recorded(stateDir: string): EngineRecord | null {
  const db = RunsDb.open(stateDir);
  try {
    return db.getSetting<EngineRecord>(ENGINE_SETTING);
  } finally {
    db.close();
  }
}

function record(stateDir: string, version: string): void {
  const db = RunsDb.open(stateDir);
  try {
    db.setSetting(ENGINE_SETTING, { version, recordedAt: "2026-09-01T00:00:00.000Z" });
  } finally {
    db.close();
  }
}

const AT = new Date("2026-09-24T14:02:03.456Z");
const files = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);

describe("compareEngineVersions", () => {
  test("compares release numbers, with or without the v; a pre-release is older than its release", () => {
    expect(compareEngineVersions("v1.5.5", "v1.6.0")).toBeLessThan(0);
    expect(compareEngineVersions("v1.6.0", "1.5.5")).toBeGreaterThan(0);
    expect(compareEngineVersions("1.10.0", "v1.9.9")).toBeGreaterThan(0);
    expect(compareEngineVersions("v1.5.5", "1.5.5")).toBe(0);
    expect(compareEngineVersions("v1.6.0-dev12", "v1.6.0")).toBeLessThan(0);
    expect(compareEngineVersions("v1.6.0", "v1.5.5-dev3")).toBeGreaterThan(0);
    expect(compareEngineVersions("v1.6.0-dev12", "v1.6.0-dev9")).not.toBe(0);
  });
});

describe("backupBeforeUpgrade", () => {
  test("the first write of a project records the engine and backs nothing up", async () => {
    const p = await project({ rows: 10 });
    const r = await backupBeforeUpgrade(p.stateDir, p.database, "v1.5.5", { now: AT });
    expect(r).toMatchObject({ path: null, from: null, to: "v1.5.5" });
    expect(recorded(p.stateDir)).toEqual({ version: "v1.5.5", recordedAt: AT.toISOString() });
    expect(files(backupsDir(p.stateDir))).toEqual([]);
    expect(recordedEngine(p.stateDir)).toMatchObject({ version: "v1.5.5" });
  });

  test("the same engine as recorded changes nothing", async () => {
    const p = await project({ rows: 10 });
    record(p.stateDir, "v1.5.5");
    const r = await backupBeforeUpgrade(p.stateDir, p.database, "v1.5.5", { now: AT });
    expect(r).toMatchObject({ path: null, from: "v1.5.5", to: "v1.5.5" });
    expect(recorded(p.stateDir)?.recordedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(files(backupsDir(p.stateDir))).toEqual([]);
  });

  test("a newer engine copies the warehouse and its WAL first, then records itself", async () => {
    const p = await project({ rows: 1500, wal: true });
    record(p.stateDir, "v1.5.5");
    const walBefore = readFileSync(`${p.database}.wal`);
    const mainBefore = readFileSync(p.database);
    const r = await backupBeforeUpgrade(p.stateDir, p.database, "v1.6.0", { now: AT });
    const name = "20260924T140203.456Z-1.5.5-to-1.6.0.duckdb";
    expect(r).toMatchObject({ path: join(backupsDir(p.stateDir), name), from: "v1.5.5", to: "v1.6.0", wal: join(backupsDir(p.stateDir), `${name}.wal`) });
    expect(["clone", "reflink", "copy"]).toContain(r.method!);
    expect(files(backupsDir(p.stateDir))).toEqual([name, `${name}.wal`]);
    // Byte for byte what the older engine left, the WAL included (the rows are only there).
    expect(Buffer.compare(readFileSync(r.path!), mainBefore)).toBe(0);
    expect(Buffer.compare(readFileSync(r.wal!), walBefore)).toBe(0);
    expect(recorded(p.stateDir)).toEqual({ version: "v1.6.0", recordedAt: AT.toISOString() });
    // The backup opens, with the rows the WAL held (on a scratch copy, so the backup itself stays untouched).
    const scratch = join(p.root, "scratch.duckdb");
    writeFileSync(scratch, readFileSync(r.path!));
    writeFileSync(`${scratch}.wal`, readFileSync(r.wal!));
    expect(await count(scratch)).toBe(1500);
  });

  test("without a WAL only the database file is copied", async () => {
    const p = await project({ rows: 10 });
    record(p.stateDir, "v1.5.5");
    const r = await backupBeforeUpgrade(p.stateDir, p.database, "v1.5.6", { now: AT });
    expect(r.wal).toBeNull();
    expect(files(backupsDir(p.stateDir))).toEqual(["20260924T140203.456Z-1.5.5-to-1.5.6.duckdb"]);
    expect(await count(r.path!)).toBe(10);
  });

  test("a newer engine before the warehouse exists records itself with no backup", async () => {
    const p = await project();
    record(p.stateDir, "v1.5.5");
    const r = await backupBeforeUpgrade(p.stateDir, p.database, "v1.6.0", { now: AT });
    expect(r).toMatchObject({ path: null, from: "v1.5.5", to: "v1.6.0" });
    expect(recorded(p.stateDir)?.version).toBe("v1.6.0");
    expect(files(backupsDir(p.stateDir))).toEqual([]);
  });

  test("an older engine (a downgrade) records itself, so the next upgrade backs up again", async () => {
    const p = await project({ rows: 10 });
    record(p.stateDir, "v1.6.0");
    const down = await backupBeforeUpgrade(p.stateDir, p.database, "v1.5.5", { now: AT });
    expect(down).toMatchObject({ path: null, from: "v1.6.0", to: "v1.5.5" });
    expect(recorded(p.stateDir)?.version).toBe("v1.5.5");
    const up = await backupBeforeUpgrade(p.stateDir, p.database, "v1.6.0", { now: new Date(AT.getTime() + 1000) });
    expect(up.path).not.toBeNull();
  });

  test(`only the ${BACKUPS_KEPT} newest backups are kept, with their WALs`, async () => {
    const p = await project({ rows: 10 });
    record(p.stateDir, "v1.1.0");
    const dir = backupsDir(p.stateDir);
    // An old backup that has a WAL, and a temporary file a killed backup left.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "20250101T000000.000Z-1.0.0-to-1.1.0.duckdb"), "old");
    writeFileSync(join(dir, "20250101T000000.000Z-1.0.0-to-1.1.0.duckdb.wal"), "old wal");
    writeFileSync(join(dir, ".tmp-999999999-20250101T000000.000Z-1.0.0-to-1.1.0.duckdb"), "half");
    writeFileSync(join(dir, "notes.txt"), "not a backup: left alone");
    const made: string[] = [];
    for (const [i, v] of ["v1.2.0", "v1.3.0", "v1.4.0"].entries()) {
      const r = await backupBeforeUpgrade(p.stateDir, p.database, v, { now: new Date(AT.getTime() + i * 60_000) });
      made.push(r.path!);
      if (i === 2) expect(r.pruned).toEqual([join(dir, "20250101T000000.000Z-1.0.0-to-1.1.0.duckdb")]);
    }
    expect(files(dir)).toEqual([
      "20260924T140203.456Z-1.1.0-to-1.2.0.duckdb",
      "20260924T140303.456Z-1.2.0-to-1.3.0.duckdb",
      "20260924T140403.456Z-1.3.0-to-1.4.0.duckdb",
      "notes.txt",
    ]);
    expect(listBackups(p.stateDir).map((b) => [b.from, b.to, b.at])).toEqual([
      ["1.3.0", "1.4.0", "2026-09-24T14:04:03.456Z"],
      ["1.2.0", "1.3.0", "2026-09-24T14:03:03.456Z"],
      ["1.1.0", "1.2.0", "2026-09-24T14:02:03.456Z"],
    ]);
    expect(listBackups(p.stateDir)[0]).toMatchObject({ path: made[2], wal: null, bytes: expect.any(Number) });
  });

  test("a backup that cannot be made refuses the write, records nothing and leaves no partial file", async () => {
    const p = await project({ rows: 10 });
    record(p.stateDir, "v1.5.5");
    const e = await backupBeforeUpgrade(p.stateDir, p.database, "v1.6.0", { now: AT, cp: [join(p.root, "no-cp-here")] })
      .then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(CroftError);
    expect((e as CroftError).problem).toMatchObject({
      code: "PROJECT_NOT_WRITABLE", fix: { kind: "manual", requiresHuman: true },
      details: { from: "v1.5.5", to: "v1.6.0", backups: backupsDir(p.stateDir) },
    });
    expect((e as CroftError).problem.message).toContain("DuckDB 1.6.0");
    expect((e as CroftError).problem.hint).toBeTruthy();
    expect(recorded(p.stateDir)?.version).toBe("v1.5.5");
    expect(files(backupsDir(p.stateDir))).toEqual([]);
  });

  test("a backups folder croft cannot write to is PROJECT_NOT_WRITABLE too", async () => {
    if (process.getuid?.() === 0) return; // root writes anywhere
    const p = await project({ rows: 10 });
    record(p.stateDir, "v1.5.5");
    mkdirSync(backupsDir(p.stateDir));
    chmodSync(backupsDir(p.stateDir), 0o500);
    try {
      const e = await backupBeforeUpgrade(p.stateDir, p.database, "v1.6.0", { now: AT }).then(() => null, (x: unknown) => x);
      expect((e as CroftError).code).toBe("PROJECT_NOT_WRITABLE");
      expect(recorded(p.stateDir)?.version).toBe("v1.5.5");
    } finally {
      chmodSync(backupsDir(p.stateDir), 0o700);
    }
  });

  test("it waits for a croft writer that announced itself earlier, then backs up", async () => {
    const p = await project({ rows: 10 });
    record(p.stateDir, "v1.5.5");
    const other = spawnIdle();
    await other.waitFor("up");
    const intent = writeIntent(p.stateDir, other.pid, "r_0924_1400_oldx");
    let waited = false;
    const pending = backupBeforeUpgrade(p.stateDir, p.database, "v1.6.0", { now: AT, waitMs: 10_000, pollMs: 10, onWait: () => (waited = true) });
    await Bun.sleep(150);
    expect(files(backupsDir(p.stateDir))).toEqual([]);
    rmSync(intent);
    const r = await pending;
    expect(waited).toBe(true);
    expect(r.path).not.toBeNull();
  });

  test("while it waited, another process made the backup: none is made twice", async () => {
    const p = await project({ rows: 10 });
    record(p.stateDir, "v1.5.5");
    const other = spawnIdle();
    await other.waitFor("up");
    const intent = writeIntent(p.stateDir, other.pid);
    const pending = backupBeforeUpgrade(p.stateDir, p.database, "v1.6.0", { now: AT, waitMs: 10_000, pollMs: 10 });
    await Bun.sleep(100);
    record(p.stateDir, "v1.6.0");
    rmSync(intent);
    expect(await pending).toMatchObject({ path: null, from: "v1.6.0", to: "v1.6.0" });
    expect(files(backupsDir(p.stateDir))).toEqual([]);
  });

  test("a writer that stays past the wait is DB_BUSY, naming it, and nothing is recorded", async () => {
    const p = await project({ rows: 10 });
    record(p.stateDir, "v1.5.5");
    const other = spawnIdle();
    await other.waitFor("up");
    writeIntent(p.stateDir, other.pid, "r_0924_1400_oldx");
    const e = await backupBeforeUpgrade(p.stateDir, p.database, "v1.6.0", { now: AT, waitMs: 100, pollMs: 10 }).then(() => null, (x: unknown) => x);
    expect((e as CroftError).problem).toMatchObject({ code: "DB_BUSY", retryable: true, details: { holder: { pid: other.pid, runId: "r_0924_1400_oldx" } } });
    expect((e as CroftError).problem.fix).toBeDefined();
    expect(recorded(p.stateDir)?.version).toBe("v1.5.5");
  });

  test("an aborted wait ends at once with the signal's reason", async () => {
    const p = await project({ rows: 10 });
    record(p.stateDir, "v1.5.5");
    const other = spawnIdle();
    await other.waitFor("up");
    writeIntent(p.stateDir, other.pid);
    const ac = new AbortController();
    const pending = backupBeforeUpgrade(p.stateDir, p.database, "v1.6.0", { now: AT, waitMs: 10_000, pollMs: 10, signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    const e = await pending.then(() => null, (x: unknown) => x);
    expect((e as CroftError).code).toBe("INTERRUPTED");
  });
});

describe("the warehouse's first read-write open", () => {
  test("backs up before a newer engine opens the file, once per process; the next open with that engine does not", async () => {
    const p = await project();
    const open = (engineVersion: string) => openWarehouse({
      path: p.database, mode: "read_write", timezone: "UTC", root: p.root, stateDir: p.stateDir, isTTY: false, register: false, engineVersion,
    });
    const old = open("v1.5.5");
    await old.write("seed", (tx) => tx.exec(`CREATE TABLE t AS SELECT range AS n FROM range(7)`), { runId: "r1" });
    expect(recorded(p.stateDir)?.version).toBe("v1.5.5");
    await closeAllWarehouses();

    const newer = open("v1.6.0");
    await newer.write("more", (tx) => tx.exec(`INSERT INTO t VALUES (100)`), { runId: "r2" });
    await newer.write("more", (tx) => tx.exec(`INSERT INTO t VALUES (101)`), { runId: "r3" });
    await closeAllWarehouses();
    const made = listBackups(p.stateDir);
    expect(made.map((b) => [b.from, b.to])).toEqual([["1.5.5", "1.6.0"]]);
    expect(await count(made[0]!.path)).toBe(7);  // what the older engine left, before the newer one wrote
    expect(recorded(p.stateDir)?.version).toBe("v1.6.0");

    await open("v1.6.0").write("again", (tx) => tx.exec(`INSERT INTO t VALUES (102)`), { runId: "r4" });
    await closeAllWarehouses();
    expect(listBackups(p.stateDir)).toHaveLength(1);
  });

  test("a warehouse whose backup fails is not opened, and its write intent is withdrawn", async () => {
    const p = await project({ rows: 3 });
    record(p.stateDir, "v1.5.5");
    mkdirSync(backupsDir(p.stateDir));
    writeFileSync(join(backupsDir(p.stateDir), "x"), "");
    chmodSync(backupsDir(p.stateDir), 0o500);
    try {
      if (process.getuid?.() === 0) return;
      const w = openWarehouse({
        path: p.database, mode: "read_write", timezone: "UTC", root: p.root, stateDir: p.stateDir, isTTY: false, register: false, engineVersion: "v1.6.0",
      });
      const e = await w.write("x", (tx) => tx.exec(`INSERT INTO t VALUES (1)`), { runId: "r" }).then(() => null, (x: unknown) => x);
      expect((e as CroftError).code).toBe("PROJECT_NOT_WRITABLE");
      expect(w.isOpen).toBe(false);
      expect(files(join(p.stateDir, "write-intent.d")).filter((f) => f.endsWith(".json"))).toEqual([]);
      expect(await count(p.database)).toBe(3);
    } finally {
      chmodSync(backupsDir(p.stateDir), 0o700);
    }
  });

  test("the preview database (no write intent) and read-only opens never check or record the engine", async () => {
    const p = await project({ rows: 3 });
    const preview = openWarehouse({
      path: join(p.stateDir, "preview.duckdb"), mode: "read_write", writeIntent: false, timezone: "UTC", root: p.root, stateDir: p.stateDir,
      isTTY: false, register: false, engineVersion: "v9.9.9", label: "the preview database",
    });
    await preview.write("x", (tx) => tx.exec(`CREATE TABLE x AS SELECT 1 AS a`), { runId: "p" });
    expect(existsSync(join(p.stateDir, "runs.sqlite"))).toBe(false);
    expect(files(join(p.stateDir, BACKUPS_DIR))).toEqual([]);
  });
});
