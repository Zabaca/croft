import { afterAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import {
  allowedDirectories, canonicalPath, connect, instanceConfig, isSandboxDenial, lockConflict, mapSandboxError,
  openInstance, openMemory, type SandboxSpec, serveResources,
} from "./connect.ts";

const cleanup: (() => void)[] = [];
afterAll(() => cleanup.reverse().forEach((f) => f()));

function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-connect-")));
  const state = join(root, ".croft");
  mkdirSync(join(root, "files"));
  mkdirSync(state);
  writeFileSync(join(root, ".env"), "SECRET=hunter2\n");
  writeFileSync(join(root, "files", "a.csv"), "x,y\n1,2\n");
  return { root, state, db: join(root, "warehouse.duckdb") };
}

async function open(path: string, spec: SandboxSpec, mode: "read_only" | "read_write" = "read_write") {
  const { instance, path: real } = await openInstance(path, mode);
  const conns: DuckDBConnection[] = [];
  const c = async () => {
    const conn = await connect(instance, spec, real);
    conns.push(conn);
    return conn;
  };
  cleanup.push(() => {
    conns.forEach((x) => x.disconnectSync());
    instance.closeSync();
  });
  return { instance, real, connect: c };
}

async function run(c: DuckDBConnection, sql: string): Promise<unknown[][]> {
  return (await c.runAndReadAll(sql)).getRowsJS();
}

async function error(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a failure");
}

describe("sandbox (warehouse profile)", () => {
  test("refuses COPY TO the warehouse, secrets, other paths, URLs and extensions", async () => {
    const p = project();
    const db = await open(p.db, { profile: "warehouse", timezone: "UTC", root: p.root, stateDir: p.state });
    const c = await db.connect();
    await c.run("CREATE TABLE t AS SELECT 1 a");
    // Overwriting the warehouse through COPY is the hazard a READ_ONLY connection alone does not stop.
    expect(await error(c.run(`COPY (SELECT 1) TO '${p.db}'`))).toContain("Permission Error");
    expect(await error(c.run(`SELECT * FROM read_text('${p.root}/.env')`))).toContain("Permission Error");
    expect(await error(c.run(`SELECT * FROM read_text('/etc/hosts')`))).toContain("Permission Error");
    expect(await error(c.run(`SELECT * FROM read_csv('https://example.com/x.csv')`))).toContain("Permission Error");
    expect(await error(c.run(`ATTACH '${p.root}/other.duckdb' AS o`))).toContain("Permission Error");
    expect(await error(c.run(`LOAD httpfs`))).toContain("disabled");
    // Tables, files/ and the state folder keep working.
    expect(await run(c, "SELECT a FROM t")).toEqual([[1]]);
    expect(await run(c, `SELECT x FROM read_csv('${p.root}/files/a.csv')`)).toEqual([[1n]]);
    await c.run(`COPY (SELECT 1 a) TO '${p.state}/snap.parquet' (FORMAT parquet)`);
    await c.run(`ATTACH '${p.state}/trash.duckdb' AS trash`);
    await c.run(`CREATE TABLE trash.t AS SELECT 1 a`);
    await c.run(`DETACH trash`);
    expect(readFileSync(p.db).length).toBeGreaterThan(4); // still a database, not a 4-byte CSV
  });

  test("read_text('.env') relative to the project root is refused", async () => {
    const p = project();
    const db = await open(p.db, { profile: "warehouse", timezone: "UTC", root: p.root, stateDir: p.state });
    const c = await db.connect();
    const cwd = process.cwd();
    process.chdir(p.root);
    try {
      expect(await error(c.run(`SELECT * FROM read_text('.env')`))).toContain("Permission Error");
    } finally {
      process.chdir(cwd);
    }
  });

  test("settings cannot be re-enabled once locked, on this or any later connection", async () => {
    const p = project();
    const db = await open(p.db, { profile: "warehouse", timezone: "UTC", root: p.root, stateDir: p.state });
    for (const c of [await db.connect(), await db.connect()]) {
      for (const sql of [
        "SET enable_external_access = true",
        "SET GLOBAL enable_external_access = true",
        "RESET enable_external_access",
        "SET allowed_directories = ['/']",
        "SET lock_configuration = false",
        "SET autoload_known_extensions = true",
        "SET TimeZone = 'Asia/Tokyo'",
      ]) {
        expect(await error(c.run(sql))).toContain("the configuration has been locked");
      }
    }
  });

  test("allowed directories per profile", () => {
    const p = project();
    const base = { timezone: "UTC", root: p.root, stateDir: p.state };
    expect(allowedDirectories({ ...base, profile: "warehouse", fileDirs: [join(p.root, "files", "..", "files")] })).toEqual([join(p.root, "files"), p.state]);
    expect(allowedDirectories({ ...base, profile: "query" })).toEqual([join(p.root, "files")]);
    expect(allowedDirectories({ ...base, profile: "serve" })).toEqual([]);
    expect(allowedDirectories({ ...base, profile: "memory" })).toEqual([p.state]);
    expect(() => allowedDirectories({ profile: "query", timezone: "UTC" })).toThrow(CroftError);
  });

  test("query profile reads files/ only; a refusal maps to QUERY_PATH_DENIED", async () => {
    const p = project();
    const db = await open(p.db, { profile: "query", timezone: "UTC", root: p.root }, "read_write");
    const c = await db.connect();
    expect(await run(c, `SELECT y FROM read_csv('${p.root}/files/a.csv')`)).toEqual([[2n]]);
    let caught: unknown;
    try {
      await c.run(`SELECT * FROM read_text('${p.state}/runs.sqlite')`);
    } catch (e) {
      caught = e;
    }
    expect(isSandboxDenial(caught)).toBe(true);
    const mapped = mapSandboxError(caught, "query");
    expect(mapped).toBeInstanceOf(CroftError);
    expect((mapped as CroftError).code).toBe("QUERY_PATH_DENIED");
    expect(mapSandboxError(new Error("Binder Error: x"), "query")).toBeInstanceOf(Error);
  });

  test("serve resources: memory_limit is 25% of RAM, threads one per core; the instance takes them", async () => {
    expect(serveResources({ totalBytes: 16 * 1024 ** 3, cpus: 8 })).toEqual({ memoryLimit: "4096MiB", threads: 8 });
    expect(serveResources({ totalBytes: 100 * 1024 ** 2, cpus: 0 })).toEqual({ memoryLimit: "64MiB", threads: 1 });
    const real = serveResources();
    expect(real.threads).toBeGreaterThanOrEqual(1);
    const p = project();
    const db = await open(join(p.root, "serve-limits.duckdb"), { profile: "serve", timezone: "UTC", ...serveResources({ totalBytes: 8 * 1024 ** 3, cpus: 3 }) });
    const c = await db.connect();
    expect(await run(c, "SELECT current_setting('memory_limit'), current_setting('threads')")).toEqual([["2.0 GiB", 3n]]);
  });

  test("serve profile reads tables but no files", async () => {
    const p = project();
    const setup = await open(join(p.root, "serve.duckdb"), { profile: "serve", timezone: "UTC" });
    const c = await setup.connect();
    await c.run("CREATE TABLE t AS SELECT 42 a");
    expect(await run(c, "SELECT a FROM t")).toEqual([[42]]);
    expect(await error(c.run(`SELECT * FROM read_csv('${p.root}/files/a.csv')`))).toContain("Permission Error");
  });
});

describe("time zone", () => {
  test("every connection, including ones made after locking, uses the project zone", async () => {
    const p = project();
    // A zone that is not this machine's, so inheritance from the process cannot pass by accident.
    const db = await open(p.db, { profile: "warehouse", timezone: "Asia/Tokyo", root: p.root, stateDir: p.state });
    const first = await db.connect();
    const later = await db.connect();
    for (const c of [first, later]) {
      expect(await run(c, "SELECT current_setting('TimeZone')")).toEqual([["Asia/Tokyo"]]);
      // 20:00Z is already the next day in Tokyo.
      expect(await run(c, "SELECT (TIMESTAMPTZ '2024-01-02T20:00:00Z')::DATE::VARCHAR")).toEqual([["2024-01-03"]]);
    }
  });

  test("an unknown zone is CONFIG_INVALID", async () => {
    const p = project();
    const { instance, path } = await openInstance(p.db, "read_write");
    cleanup.push(() => instance.closeSync());
    let caught: unknown;
    try {
      await connect(instance, { profile: "warehouse", timezone: "Mars/Olympus", root: p.root, stateDir: p.state }, path);
    } catch (e) {
      caught = e;
    }
    expect((caught as CroftError).code).toBe("CONFIG_INVALID");
  });
});

describe("instance cache", () => {
  test("fromCache returns one instance for realpath, symlink, `..` and case variants", async () => {
    const p = project();
    const spec: SandboxSpec = { profile: "warehouse", timezone: "UTC", root: p.root, stateDir: p.state };
    const db = await open(p.db, spec);
    const c = await db.connect();
    await c.run("CREATE TABLE marker AS SELECT 7 v");
    symlinkSync(p.root, p.root + "-link");
    const variants = [p.root + "-link/warehouse.duckdb", join(p.root, "files", "..", "warehouse.duckdb")];
    const upper = join(p.root, "WAREHOUSE.DUCKDB");
    if (existsSync(upper)) variants.push(upper); // case-insensitive file system (APFS default)
    for (const v of variants) {
      expect(canonicalPath(v)).toBe(db.real);
      const other = await DuckDBInstanceFromCache(v);
      const oc = await connect(other, spec, db.real); // already configured and locked: verified, not redone
      // Same instance: it sees the uncheckpointed table and the locked sandbox.
      expect(await run(oc, "SELECT v FROM marker")).toEqual([[7]]);
      expect(await run(oc, "SELECT current_setting('lock_configuration')")).toEqual([[true]]);
      oc.disconnectSync();
    }
  });

  test("one access mode per path per process", async () => {
    const p = project();
    await open(p.db, { profile: "warehouse", timezone: "UTC", root: p.root, stateDir: p.state });
    let caught: unknown;
    try {
      await openInstance(p.db, "read_only");
    } catch (e) {
      caught = e;
    }
    expect((caught as CroftError).code).toBe("INTERNAL_ERROR");
  });

  test("a locked instance refuses a second, different sandbox", async () => {
    const p = project();
    const db = await open(p.db, { profile: "warehouse", timezone: "UTC", root: p.root, stateDir: p.state });
    await db.connect();
    let caught: unknown;
    try {
      await connect(db.instance, { profile: "query", timezone: "UTC", root: p.root }, db.real);
    } catch (e) {
      caught = e;
    }
    expect((caught as CroftError).code).toBe("INTERNAL_ERROR");
  });

  test("concurrent first connections configure the instance once", async () => {
    const p = project();
    const db = await open(p.db, { profile: "warehouse", timezone: "UTC", root: p.root, stateDir: p.state });
    const conns = await Promise.all(Array.from({ length: 8 }, () => db.connect()));
    for (const c of conns) expect(await run(c, "SELECT current_setting('lock_configuration')")).toEqual([[true]]);
  });

  test("the fixed instance options", () => {
    expect(instanceConfig("read_only")).toEqual({
      autoinstall_known_extensions: "false", autoload_known_extensions: "false", allow_community_extensions: "false",
      access_mode: "READ_ONLY",
    });
    expect(instanceConfig("read_write").access_mode).toBe("READ_WRITE");
  });
});

async function DuckDBInstanceFromCache(path: string): Promise<DuckDBInstance> {
  return (await openInstance(path, "read_write")).instance;
}

describe("memory profile", () => {
  test("private, sandboxed, in the project zone", async () => {
    const p = project();
    const a = await openMemory({ timezone: "America/Los_Angeles", stateDir: p.state });
    const b = await openMemory({ timezone: "America/Los_Angeles", stateDir: p.state });
    cleanup.push(() => { a.close(); b.close(); });
    const ca = await a.connect();
    const cb = await b.connect();
    await ca.run("CREATE TABLE only_a AS SELECT 1");
    expect(await error(cb.run("SELECT * FROM only_a"))).toContain("only_a");
    expect(await run(cb, "SELECT current_setting('TimeZone')")).toEqual([["America/Los_Angeles"]]);
    expect(await error(ca.run(`SELECT * FROM read_text('${p.root}/.env')`))).toContain("Permission Error");
    await ca.run(`COPY (SELECT 1 a) TO '${p.state}/in-x.parquet' (FORMAT parquet)`);
    expect(await run(cb, `SELECT a FROM read_parquet('${p.state}/in-x.parquet')`)).toEqual([[1]]);
  });
});

test("lockConflict parses DuckDB's lock error", () => {
  const msg = 'IO Error: Could not set lock on file "/p/warehouse.duckdb": Conflicting lock is held in /Users/u/.bun/bin/bun (PID 23221) by user u. See also https://duckdb.org/docs/stable/connect/concurrency';
  expect(lockConflict(new Error(msg))).toEqual({ path: "/p/warehouse.duckdb", program: "/Users/u/.bun/bin/bun", pid: 23221 });
  expect(lockConflict(new Error('Conflicting lock is held in /opt/homebrew/bin/duckdb (PID 812)'))).toEqual({ path: null, program: "/opt/homebrew/bin/duckdb", pid: 812 });
  expect(lockConflict(new Error("Catalog Error: nope"))).toBeNull();
});

// Regression (phase-1 fix wave): Bun's realpath opens its argument, and closing that descriptor released
// this process's DuckDB lock, letting another process open the warehouse read-write mid-transaction.
describe("canonicalPath never opens the warehouse file", () => {
  test("a held write lease stays exclusive after canonicalPath(db)", async () => {
    const { closeAllWarehouses, openWarehouse } = await import("./warehouse.ts");
    const { cleanup, makeProject, seed, spawnHolder } = await import("../read/testkit.ts");
    try {
      const p = await makeProject({ seed: ["CREATE TABLE t AS SELECT 1 AS a"] });
      await seed(p.database, ["CHECKPOINT"]);
      const w = openWarehouse({ path: p.database, mode: "read_write", timezone: "UTC", root: p.root, stateDir: p.stateDir, isTTY: false, register: false });
      let other = "";
      try {
        await w.write("t", async (tx) => {
          await tx.exec("INSERT INTO t VALUES (5)");
          canonicalPath(p.database);
          canonicalPath(p.database.toUpperCase());
          const holder = spawnHolder(p.database, 0, "INSERT INTO t VALUES (999)");
          other = await Promise.race([
            holder.exited.then((c: unknown) => `blocked (exit ${c})`),
            holder.waitFor("held", 15_000).then(() => "OPENED"),
          ]);
          holder.proc.kill("SIGKILL");
        }, { runId: "r_0101_0000_aaaa" });
      } finally {
        await w.close();
      }
      expect(other).toStartWith("blocked");
    } finally {
      await closeAllWarehouses();
      cleanup();
    }
  }, 30_000);
});
