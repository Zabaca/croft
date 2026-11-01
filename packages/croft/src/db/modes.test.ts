// Pinned extensions loaded by path, and a lockdown per mode (DESIGN.md D117, D118; option 06 slice 1, shared with 07).
// These tests load DuckDB's real extension files, so they need them (scripts/fetch-extensions.ts fills the folder)
// and, for the lake profile, a Postgres. Locally a missing file or program skips the tests that need it and says why
// on stderr; in CI (CROFT_CI=1) it fails them instead, so a test never passes by skipping there. Every server a test
// starts (Postgres, the S3-compatible store, the Quack listener) is a child process of the test, killed in teardown.
import { afterAll, describe, expect, test } from "bun:test";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { connect, instanceConfig, type SandboxSpec } from "./connect.ts";
import { extensionsReady, IN_CI } from "./extension-dir-testkit.ts";
import { extensionPath, hostPlatform, verifyExtension } from "./extension-files.ts";
import { DUCKDB_VERSION, type ExtensionName } from "./extension-names.ts";
import { LAKE_ALIAS, type LakeSpec, MODE_EXTENSIONS, type ModeSpec, READ_COPY_ALIAS, scrub, scrubError, startQuackListener } from "./modes.ts";
import { freePort, postgresBin, readListening, startPostgres, startS3, track, type TestPostgres, type TestS3 } from "./mode-testkit.ts";

const ALL: ExtensionName[] = ["quack", "httpfs", "ducklake", "postgres", "sqlite"];
const ext = extensionsReady(ALL);
if (!ext.ready) console.warn(`[modes.test] SKIPPING the tests that load real extension files: ${ext.skipReason}`);
const pgMissing = postgresBin() === null;
if (pgMissing) {
  const msg = "postgres (initdb, postgres, psql) is not installed";
  if (IN_CI) throw new Error(`CI must have Postgres for the lake profile's tests: ${msg}`);
  console.warn(`[modes.test] SKIPPING the Postgres lake tests: ${msg}; install Homebrew's postgresql@17 (it is run in the foreground, never as a service)`);
}
const withExt = ext.ready ? test : test.skip;
const withPg = ext.ready && !pgMissing ? test : test.skip;

const cleanup: (() => void | Promise<void>)[] = [];
afterAll(async () => {
  for (const f of cleanup.reverse()) await f();
});

let seq = 0;
async function open(spec: SandboxSpec, config: Record<string, string> = {}): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(":memory:", { ...instanceConfig("read_write"), ...config });
  const conn = await connect(instance, spec, `:memory:modes${++seq}`);
  cleanup.push(() => {
    conn.disconnectSync();
    instance.closeSync();
  });
  return conn;
}

async function rows(c: DuckDBConnection, sql: string): Promise<unknown[][]> {
  return (await c.runAndReadAll(sql)).getRowsJS();
}

async function error(c: DuckDBConnection, sql: string): Promise<string> {
  try {
    await c.run(sql);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error(`expected a failure: ${sql}`);
}

/** An instance with no sandbox that never installs or autoloads, holding the pinned httpfs (secret types need it). */
async function plain(config: Record<string, string> = {}): Promise<{ instance: DuckDBInstance; conn: DuckDBConnection }> {
  const instance = await DuckDBInstance.create(":memory:", { ...instanceConfig("read_write"), ...config });
  const conn = await instance.connect();
  await conn.run(`LOAD '${verifyExtension(ext.dir, "httpfs")}'`);
  cleanup.push(() => {
    conn.disconnectSync();
    instance.closeSync();
  });
  return { instance, conn };
}

/** Whether nothing accepts TCP connections on `localhost:port`, on either address (Quack binds ::1 where it can). */
async function notListening(port: number): Promise<boolean> {
  for (const hostname of ["127.0.0.1", "::1"]) {
    try {
      const sock = await Bun.connect({ hostname, port, socket: { data() {}, open() {}, close() {}, error() {} } });
      sock.end();
      return false;
    } catch { /* refused on this address */ }
  }
  return true;
}

/** Which of the mode extensions an instance has loaded, by what each one adds (works after the lock). */
async function loaded(c: DuckDBConnection): Promise<ExtensionName[]> {
  const probes: [ExtensionName, string][] = [
    ["quack", "SELECT count(*) FROM duckdb_functions() WHERE function_name = 'quack_serve'"],
    ["httpfs", "SELECT count(*) FROM duckdb_settings() WHERE name = 'enable_server_cert_verification'"],
    ["postgres", "SELECT count(*) FROM duckdb_functions() WHERE function_name = 'postgres_query'"],
    ["sqlite", "SELECT count(*) FROM duckdb_functions() WHERE function_name = 'sqlite_scan'"],
    ["ducklake", "SELECT count(*) FROM duckdb_functions() WHERE function_name = 'ducklake_set_option'"],
  ];
  const out: ExtensionName[] = [];
  for (const [name, sql] of probes) if (Number((await rows(c, sql))[0]![0]) > 0) out.push(name);
  return out;
}

interface Project { root: string; state: string; secrets: string; live: string; copy: string }

/** A project folder with a live warehouse, its read copy, files/, a .env and a state folder holding a secret-looking file. */
async function project(): Promise<Project> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-modes-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, ".croft");
  mkdirSync(join(root, "files"));
  mkdirSync(join(state, "secrets"), { recursive: true });
  writeFileSync(join(root, ".env"), "SECRET=hunter2\n");
  writeFileSync(join(root, "files", "a.csv"), "x,y\n1,2\n");
  writeFileSync(join(state, "secrets", "probe.txt"), "in the state folder\n");
  writeFileSync(join(state, "runs.sqlite"), "not a database\n");
  const live = join(root, "warehouse.duckdb");
  const db = await DuckDBInstance.create(live);
  const c = await db.connect();
  await c.run("CREATE TABLE t AS SELECT range AS a FROM range(5)");
  c.disconnectSync();
  db.closeSync();
  const copy = join(root, "warehouse.read.duckdb");
  copyFileSync(live, copy);
  return { root, state, secrets: join(state, "secrets"), live, copy };
}

const readers = (p: Project, extra: Partial<Extract<ModeSpec, { kind: "readers" }>> = {}): SandboxSpec => ({
  profile: "serve",
  timezone: "UTC",
  mode: { kind: "readers", extensionDir: ext.dir, secretDir: p.secrets, copy: p.copy, ...extra },
});

/** What the lockdown refuses on every profile, once locked. `have`: the mode's extensions, so one it lacks can be tried. */
async function expectLocked(c: DuckDBConnection, have: readonly ExtensionName[]): Promise<void> {
  expect(await error(c, "SET threads = 1")).toContain("the configuration has been locked");
  expect(await error(c, "SET GLOBAL enable_external_access = true")).toContain("the configuration has been locked");
  expect(await error(c, "SET allowed_directories = ['/']")).toContain("the configuration has been locked");
  expect(await error(c, "RESET allowed_directories")).toContain("the configuration has been locked");
  expect(await error(c, "INSTALL httpfs")).toContain("disabled by configuration");
  // An extension this profile did not load cannot be loaded by name or by path.
  const absent = (["quack", "sqlite", "postgres", "ducklake"] as const).find((n) => !have.includes(n))!;
  expect(await error(c, `LOAD ${absent}`)).toMatch(/disabled (by|through) configuration|Loading external extensions is disabled/);
  expect(await error(c, `LOAD '${extensionPath(ext.dir, absent, hostPlatform()!)}'`)).toContain("Loading external extensions is disabled");
}

describe("the pinned list", () => {
  test("every mode loads only what it needs, in a fixed order, and no mode loads sqlite but the test lake", () => {
    expect(MODE_EXTENSIONS.readers).toEqual(["httpfs", "quack"]);
    expect(MODE_EXTENSIONS.lake).toEqual(["httpfs", "postgres", "ducklake"]);
    expect(MODE_EXTENSIONS["lake-readers"]).toEqual(["httpfs", "postgres", "ducklake", "quack"]);
    expect(MODE_EXTENSIONS["lake-test"]).toEqual(["sqlite", "ducklake"]);
    for (const [kind, names] of Object.entries(MODE_EXTENSIONS)) if (kind !== "lake-test") expect(names, kind).not.toContain("sqlite");
  });

  withExt("with no mode, no extension is loaded (acceptance 1)", async () => {
    const p = await project();
    const c = await open({ profile: "warehouse", timezone: "UTC", root: p.root, stateDir: p.state });
    expect(await loaded(c)).toEqual([]);
    expect(await error(c, "LOAD httpfs")).toContain("disabled");
  });
});

describe("a file that is not the pinned file loads nothing (acceptance 3)", () => {
  /** An extension folder of links to the real files, with `name` replaced by `make`'s file. */
  function folderWith(name: ExtensionName, make: (real: string, to: string) => void): string {
    const platform = hostPlatform()!;
    const dir = mkdtempSync(join(tmpdir(), "croft-extdir-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    for (const n of ALL) {
      const to = extensionPath(dir, n, platform);
      mkdirSync(dirname(to), { recursive: true });
      if (n === name) make(extensionPath(ext.dir, n, platform), to);
      else symlinkSync(extensionPath(ext.dir, n, platform), to);
    }
    return dir;
  }

  /** Build a file that ends in DuckDB's extension footer for `platform` and `duckdb`. */
  function fakeBuild(to: string, platform: string, duckdb: string): void {
    const footer = Buffer.alloc(512);
    const put = (i: number, s: string) => footer.write(s, i * 32, "latin1");
    put(3, "CPP");
    put(4, "deadbeef00");
    put(5, duckdb);
    put(6, platform);
    put(7, "4");
    writeFileSync(to, Buffer.concat([Buffer.alloc(2048, 1), footer]));
  }

  async function failure(dir: string, kind: "readers" | "lake-test"): Promise<{ error: CroftError; conn: DuckDBConnection }> {
    const p = await project();
    const instance = await DuckDBInstance.create(":memory:", instanceConfig("read_write"));
    cleanup.push(() => instance.closeSync());
    const spec: SandboxSpec = kind === "readers"
      ? readers(p, { extensionDir: dir })
      : { profile: "serve", timezone: "UTC", mode: { kind: "lake-test", extensionDir: dir, secretDir: p.secrets, lake: { catalog: { kind: "sqlite", path: join(p.state, "meta.sqlite") }, dataPath: join(p.state, "lake") + "/", access: "write" } } };
    try {
      await connect(instance, spec, `:memory:bad${++seq}`);
    } catch (e) {
      // The instance is unlocked, so DuckDB can still say what it has loaded: nothing.
      const probe = await instance.connect();
      cleanup.push(() => probe.disconnectSync());
      return { error: e as CroftError, conn: probe };
    }
    throw new Error("expected the mode to refuse");
  }

  const loadedNames = async (c: DuckDBConnection) => (await loaded(c)).sort();

  test("a missing folder or file: EXTENSION_MISSING, with a hint and a fix, and nothing loaded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "croft-extdir-empty-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { error: e, conn } = await failure(dir, "readers");
    expect(e).toBeInstanceOf(CroftError);
    expect(e.code).toBe("EXTENSION_MISSING");
    expect(e.problem.hint.length).toBeGreaterThan(10);
    expect(e.problem.fix).toMatchObject({ kind: "command" });
    expect(e.problem.details).toMatchObject({ kind: "file", extension: "httpfs" });
    expect(await loadedNames(conn)).toEqual([]);
  });

  withExt("a checksum mismatch: EXTENSION_CHECKSUM_MISMATCH, and the files before it are not loaded either", async () => {
    // lake-test loads sqlite first, then ducklake: damage ducklake, the second, and prove sqlite did not load.
    const dir = folderWith("ducklake", (real, to) => {
      const bytes = readFileSync(real);
      bytes[Math.floor(bytes.length / 2)]! ^= 0xff; // one flipped byte, same size, same footer
      writeFileSync(to, bytes);
    });
    const { error: e, conn } = await failure(dir, "lake-test");
    expect(e.code).toBe("EXTENSION_CHECKSUM_MISMATCH");
    expect(e.problem.details).toMatchObject({ extension: "ducklake" });
    expect(e.problem.fix).toBeDefined();
    expect(await loadedNames(conn)).toEqual([]);
  });

  withExt("a truncated file: EXTENSION_CHECKSUM_MISMATCH", async () => {
    const dir = folderWith("httpfs", (real, to) => writeFileSync(to, readFileSync(real).subarray(0, 100_000)));
    const { error: e } = await failure(dir, "readers");
    expect(e.code).toBe("EXTENSION_CHECKSUM_MISMATCH");
  });

  test("a file built for another DuckDB version: EXTENSION_WRONG_BUILD, naming what it was built for", async () => {
    const dir = folderWith("httpfs", (_real, to) => fakeBuild(to, hostPlatform()!, "v1.5.5"));
    const { error: e, conn } = await failure(dir, "readers");
    expect(e.code).toBe("EXTENSION_WRONG_BUILD");
    expect(e.message).toContain("v1.5.5");
    expect(e.problem.details).toMatchObject({ built: { duckdb: "v1.5.5", platform: hostPlatform() } });
    expect(await loadedNames(conn)).toEqual([]);
  });

  test("a file built for another platform: EXTENSION_WRONG_BUILD", async () => {
    const other = hostPlatform() === "linux_amd64" ? "osx_arm64" : "linux_amd64";
    const dir = folderWith("httpfs", (_real, to) => fakeBuild(to, other, `v${DUCKDB_VERSION}`));
    const { error: e } = await failure(dir, "readers");
    expect(e.code).toBe("EXTENSION_WRONG_BUILD");
    expect(e.message).toContain(other);
  });

  test("a file with no DuckDB footer at all is a checksum mismatch, never loaded", async () => {
    const dir = folderWith("httpfs", (_real, to) => writeFileSync(to, "not an extension"));
    const { error: e } = await failure(dir, "readers");
    expect(e.code).toBe("EXTENSION_CHECKSUM_MISMATCH");
  });

  test("a platform croft pins nothing for is EXTENSION_MISSING with kind platform", () => {
    expect(() => verifyExtension("/nowhere", "quack", null)).toThrow(CroftError);
    try {
      verifyExtension("/nowhere", "quack", null);
    } catch (e) {
      expect((e as CroftError).code).toBe("EXTENSION_MISSING");
      expect((e as CroftError).problem.details).toMatchObject({ kind: "platform" });
    }
    expect(hostPlatform("win32", "x64")).toBeNull();
    expect(hostPlatform("linux", "ia32")).toBeNull();
  });
});

describe("readers profile (server mode)", () => {
  withExt("loads quack and httpfs and nothing else; the copy is attached read-only (acceptance 4)", async () => {
    const p = await project();
    const c = await open(readers(p));
    expect((await loaded(c)).sort()).toEqual(["httpfs", "quack"]);
    expect(await rows(c, `SELECT count(*) FROM ${READ_COPY_ALIAS}.main.t`)).toEqual([[5n]]);
    expect(await error(c, `CREATE TABLE ${READ_COPY_ALIAS}.main.z (a INTEGER)`)).toMatch(/read-only/i);
    expect(await rows(c, "SELECT current_setting('autoinstall_known_extensions'), current_setting('autoload_known_extensions')")).toEqual([[false, false]]);
  });

  withExt("after the lock SET, INSTALL, LOAD and remote attaches are refused, and local ones inside the allowed path work (acceptance 2)", async () => {
    const p = await project();
    const c = await open(readers(p));
    await expectLocked(c, ["quack", "httpfs"]);
    // LOAD of an extension already loaded is a no-op, not a refusal (DESIGN.md §5). Secrets cannot be made here: the
    // instance never used them before the lock, so the first use would read the secret folder, which is out of reach.
    await c.run("LOAD httpfs");
    expect(await error(c, "CREATE TEMPORARY SECRET late_secret (TYPE s3, KEY_ID 'a', SECRET 'b')")).toContain("Permission Error");
    const late = freePort();
    await error(c, `SELECT * FROM quack_serve('quack:localhost:${late}', token = 'x', create_secret_if_not_exists = false)`);
    expect(await notListening(late)).toBe(true);
    await c.run("ATTACH ':memory:' AS scratch");
    // The swap the readers' process does after a refresh: detach the old copy, attach the new file.
    await c.run(`DETACH ${READ_COPY_ALIAS}`);
    await c.run(`ATTACH '${p.copy}' AS ${READ_COPY_ALIAS} (READ_ONLY)`);
    expect(await rows(c, `SELECT count(*) FROM ${READ_COPY_ALIAS}.main.t`)).toEqual([[5n]]);
  });

  withExt("the live warehouse, files/, the state folder and the secret folder are out of reach, with the gate bypassed (acceptance 4)", async () => {
    const p = await project();
    const c = await open(readers(p));
    for (const sql of [
      `ATTACH '${p.live}' AS live`,
      `ATTACH '${p.live}' AS live (READ_ONLY)`,
      `SELECT * FROM read_csv('${p.root}/files/a.csv')`,
      `SELECT * FROM read_text('${p.root}/.env')`,
      `SELECT * FROM read_text('${p.state}/runs.sqlite')`,
      `SELECT * FROM read_text('${p.secrets}/probe.txt')`,
      `COPY (SELECT 1) TO '${p.root}/files/out.csv'`,
      `COPY (SELECT 1) TO '${p.live}'`,
      `ATTACH '${p.root}/other.duckdb' AS other`,
      "SELECT * FROM read_text('/etc/hosts')",
      "SELECT * FROM read_text('https://example.com/')",
    ]) expect(await error(c, sql), sql).toContain("Permission Error");
    expect(existsSync(join(p.root, "files", "out.csv"))).toBe(false);
  });

  withExt("nothing is read from the user's home secret folder (acceptance 4)", async () => {
    const home = mkdtempSync(join(tmpdir(), "croft-home-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const stored = join(home, ".duckdb", "stored_secrets");
    mkdirSync(stored, { recursive: true });
    // A persistent secret a user keeps in their DuckDB home, made by a plain instance that points there.
    const maker = await plain({ home_directory: home });
    await maker.conn.run(`SET secret_directory = '${stored}'`);
    await maker.conn.run("CREATE PERSISTENT SECRET home_secret (TYPE s3, KEY_ID 'HOMEKEYID', SECRET 'homesecretvalue')");
    expect(readdirSync(stored).length).toBeGreaterThan(0);

    const prior = process.env.HOME;
    process.env.HOME = home;
    try {
      // Control: an instance left on the default folder does see it, so the test can tell.
      const control = await plain({ home_directory: home });
      expect(await rows(control.conn, "SELECT count(*) FROM duckdb_secrets()")).toEqual([[1n]]);

      const p = await project();
      // What the instance can see in the window before the lock, where a listener would read secrets.
      const seen: unknown[][][] = [];
      const c = await open(readers(p, {
        prepare: async (conn) => {
          seen.push(await rows(conn, "SELECT count(*) FROM duckdb_secrets()"), await rows(conn, "SELECT current_setting('secret_directory')"));
        },
      }), { home_directory: home });
      expect(seen).toEqual([[[0n]], [[p.secrets]]]);
      expect(await error(c, `SELECT * FROM read_text('${p.secrets}/probe.txt')`)).toContain("Permission Error");
    } finally {
      if (prior === undefined) delete process.env.HOME;
      else process.env.HOME = prior;
    }
  });

  withExt("the listener starts before the lock, a client reads the copy over Quack, and the lock then refuses a second listener (acceptance 2)", async () => {
    const p = await project();
    const port = freePort();
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "quack-listener-testkit.ts"), "--ext", ext.dir, "--state", p.state, "--copy", p.copy, "--port", String(port), "--token", "tok-modes-1", "--tables", "t"], {
      stdout: "pipe", stderr: "inherit", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });
    const stopChild = track(child);
    cleanup.push(stopChild);
    await readListening(child);

    const client = await DuckDBInstance.create(":memory:", instanceConfig("read_write"));
    const cc = await client.connect();
    cleanup.push(() => {
      cc.disconnectSync();
      client.closeSync();
    });
    for (const n of ["httpfs", "quack"] as const) await cc.run(`LOAD '${verifyExtension(ext.dir, n)}'`);
    expect(await error(cc, `ATTACH 'quack:localhost:${port}' AS bad (TOKEN 'wrong-token')`)).toMatch(/Authentication failed|authentication/i);
    await cc.run(`ATTACH 'quack:localhost:${port}' AS r (TOKEN 'tok-modes-1')`);
    expect(await rows(cc, "SELECT count(*), sum(a) FROM r.t")).toEqual([[5n, 10n]]);

    // In this process, the same profile locks with the listener already started; a second one is refused afterwards.
    const c = await open(readers(p));
    const late = freePort();
    await error(c, `SELECT * FROM quack_serve('quack:localhost:${late}', token = 'x', create_secret_if_not_exists = false)`);
    expect(await notListening(late)).toBe(true);
    await stopChild();
  });

  withExt("startQuackListener before the lock works from prepare, and not after it", async () => {
    const p = await project();
    const port = freePort();
    let started = false;
    const c = await open(readers(p, { prepare: async (conn) => { await startQuackListener(conn, `quack:localhost:${port}`); started = true; } }));
    expect(started).toBe(true);
    const late = freePort();
    await error(c, `SELECT * FROM quack_serve('quack:localhost:${late}', token = 'x', create_secret_if_not_exists = false)`);
    expect(await notListening(late)).toBe(true);
    expect(await notListening(port)).toBe(false);
    await c.run(`SELECT * FROM quack_stop('quack:localhost:${port}')`).catch(() => {});
  });
});

describe("lake test profile (a SQLite catalog and a local folder)", () => {
  function lakeTest(p: Project, access: "write" | "read" = "write"): SandboxSpec {
    mkdirSync(join(p.root, "lake-data"), { recursive: true });
    return {
      profile: "warehouse", timezone: "UTC", root: p.root, stateDir: p.state,
      mode: { kind: "lake-test", extensionDir: ext.dir, secretDir: p.secrets, lake: { catalog: { kind: "sqlite", path: join(p.state, "meta.sqlite") }, dataPath: join(p.root, "lake-data") + "/", access } },
    };
  }

  withExt("loads ducklake and sqlite only; the lake's folder works, everything else is refused (acceptance 5)", async () => {
    const p = await project();
    const c = await open(lakeTest(p));
    expect((await loaded(c)).sort()).toEqual(["ducklake", "sqlite"]);
    await c.run(`CREATE TABLE ${LAKE_ALIAS}.t AS SELECT range AS a FROM range(10)`);
    await c.run(`INSERT INTO ${LAKE_ALIAS}.t VALUES (100)`);
    expect(await rows(c, `SELECT count(*), max(a) FROM ${LAKE_ALIAS}.t`)).toEqual([[11n, 100n]]);
    expect(readdirSync(join(p.root, "lake-data")).length).toBeGreaterThan(0);
    await expectLocked(c, ["sqlite", "ducklake"]);
    // Another folder (a sibling whose name starts the same), a URL, /etc/hosts, the project's .env, the live file.
    mkdirSync(join(p.root, "lake-data-2"), { recursive: true });
    for (const sql of [
      `COPY (SELECT 1 a) TO '${p.root}/lake-data-2/x.parquet'`,
      `COPY (SELECT 1 a) TO '${p.root}/lake-data/../lake-data-2/y.parquet'`,
      "SELECT * FROM read_text('https://example.com/')",
      "SELECT * FROM read_text('s3://lake/proj/x')",
      "SELECT * FROM read_text('/etc/hosts')",
      `SELECT * FROM read_text('${p.root}/.env')`,
      `ATTACH '${p.live}' AS live`,
      `ATTACH 'ducklake:sqlite:${p.root}/other-meta.sqlite' AS second (DATA_PATH '${p.root}/lake-data-2/')`,
      "ATTACH 'dbname=x host=127.0.0.1' AS pg (TYPE postgres)",
    ]) expect(await error(c, sql), sql).toMatch(/Permission Error|Loading external extensions is disabled/);
    expect(existsSync(join(p.root, "lake-data-2", "x.parquet"))).toBe(false);
    // A local attach inside what the profile allows still works (the trash does this, §5).
    await c.run(`ATTACH '${p.state}/trash.duckdb' AS trash`);
    await c.run("CREATE TABLE trash.z AS SELECT 1 a");
    await c.run("DETACH trash");
  });

  withExt("attached read-only, a write is refused", async () => {
    const p = await project();
    const w = await open(lakeTest(p));
    await w.run(`CREATE TABLE ${LAKE_ALIAS}.t AS SELECT 1 a`);
    const r = await open(lakeTest(p, "read"));
    expect(await rows(r, `SELECT count(*) FROM ${LAKE_ALIAS}.t`)).toEqual([[1n]]);
    expect(await error(r, `INSERT INTO ${LAKE_ALIAS}.t VALUES (2)`)).toMatch(/read-only|read only/i);
  });
});

describe("lake profile (a Postgres catalog and a bucket folder)", () => {
  const WRITER = { user: "lakew", password: "Wr1ter-pw-Zx81" };
  const READER = { user: "laker", password: "R3ader-pw-Qj42" };
  const KEYS = { rw: { id: "KEYIDWRITER01", secret: "sekrit-writer-0123456789" }, ro: { id: "KEYIDREADER02", secret: "sekrit-reader-9876543210" } };
  let pg: TestPostgres;
  let s3: TestS3;
  let n = 0;

  if (ext.ready && !pgMissing) {
    cleanup.push(async () => {
      await s3?.stop();
      await pg?.stop();
    });
  }

  async function infra(): Promise<void> {
    if (pg) return;
    pg = await startPostgres();
    s3 = await startS3({ buckets: ["lake", "other"], keys: { [KEYS.rw.id]: "rw", [KEYS.ro.id]: "ro" } });
  }

  /** A fresh lake database and folder, and the specs that reach it. */
  async function lake(): Promise<{ db: string; folder: string; spec: (o?: Partial<{ access: "write" | "read"; password: string; keyId: string; secretKey: string; host: string; port: number; reader: boolean }>) => LakeSpec }> {
    await infra();
    const db = `lake${++n}`;
    const folder = `s3://lake/proj${n}/`;
    await pg.createLakeDatabase(db, WRITER, { user: `${READER.user}${n}`, password: READER.password });
    return {
      db, folder,
      spec: (o = {}) => {
        const who = o.reader ? { user: `${READER.user}${n}`, password: READER.password } : WRITER;
        const key = o.reader ? KEYS.ro : KEYS.rw;
        return {
          catalog: { kind: "postgres", host: pg.host, port: o.port ?? pg.port, database: db, user: who.user, password: o.password ?? who.password },
          data: { path: folder, keyId: o.keyId ?? key.id, secretKey: o.secretKey ?? key.secret, endpoint: s3.endpoint, urlStyle: "path", useSsl: false, region: "us-east-1" },
          access: o.access ?? "write",
        };
      },
    };
  }

  const spec = (p: Project, lk: LakeSpec): SandboxSpec => ({
    profile: "warehouse", timezone: "UTC", root: p.root, stateDir: p.state,
    mode: { kind: "lake", extensionDir: ext.dir, secretDir: p.secrets, lake: lk },
  });

  withPg("loads ducklake, httpfs and postgres; the named catalog, bucket and folder work; everything else is refused (acceptance 5)", async () => {
    const p = await project();
    const l = await lake();
    const c = await open(spec(p, l.spec()));
    expect((await loaded(c)).sort()).toEqual(["ducklake", "httpfs", "postgres"]);
    await c.run(`CREATE TABLE ${LAKE_ALIAS}.t AS SELECT range AS a FROM range(1000)`);
    await c.run(`INSERT INTO ${LAKE_ALIAS}.t SELECT range FROM range(1000)`);
    expect(await rows(c, `SELECT count(*) FROM ${LAKE_ALIAS}.t`)).toEqual([[2000n]]);
    const written = readdirSync(join(s3.root, "lake")).filter((d) => d.startsWith(`proj${n}`));
    expect(written.length).toBe(1);

    await expectLocked(c, ["postgres", "ducklake", "httpfs"]);
    mkdirSync(join(p.root, "files-out"), { recursive: true });
    for (const sql of [
      // another folder (one whose name starts the same), another bucket, a URL, /etc/hosts, the project's .env
      `COPY (SELECT 1 a) TO 's3://lake/proj${n}-sibling/x.parquet'`,
      `COPY (SELECT 1 a) TO 's3://lake/elsewhere/x.parquet'`,
      `COPY (SELECT 1 a) TO 's3://other/proj${n}/x.parquet'`,
      `SELECT * FROM read_text('s3://other/proj${n}/x.parquet')`,
      "SELECT * FROM read_text('https://example.com/')",
      "SELECT * FROM read_text('http://127.0.0.1:1/')",
      "SELECT * FROM read_text('/etc/hosts')",
      `SELECT * FROM read_text('${p.root}/.env')`,
      // a second Postgres attach, plain and as a lake, with the credentials written out in the statement
      `ATTACH 'dbname=${l.db} host=${pg.host} port=${pg.port} user=${WRITER.user} password=${WRITER.password}' AS second (TYPE postgres)`,
      `ATTACH 'ducklake:postgres:dbname=${l.db} host=${pg.host} port=${pg.port} user=${WRITER.user} password=${WRITER.password}' AS third (DATA_PATH '${l.folder}')`,
    ]) expect(await error(c, sql), sql).toMatch(/Permission Error/);
    expect(existsSync(join(s3.root, "lake", `proj${n}-sibling`))).toBe(false);
    expect(existsSync(join(s3.root, "lake", "elsewhere"))).toBe(false);
    expect(existsSync(join(s3.root, "other", `proj${n}`))).toBe(false);
    // A local attach inside what the profile allows still works (the trash does this, §5)...
    await c.run(`ATTACH '${p.state}/trash.duckdb' AS trash`);
    await c.run("CREATE TABLE trash.z AS SELECT 1 a");
    await c.run("DETACH trash");
    // ...and the credentials are in a named secret, not in the list of attached databases or the redacted secrets.
    const seen = JSON.stringify([await rows(c, "SELECT * FROM duckdb_databases()"), await rows(c, "SELECT * FROM duckdb_secrets()")], (_k, v) => (typeof v === "bigint" ? Number(v) : v));
    for (const secret of [WRITER.password, KEYS.rw.secret]) expect(seen, secret).not.toContain(secret);
  });

  withPg("lake-readers (server mode over a lake): ducklake, httpfs, postgres and quack; read-only; the listener starts before the lock", async () => {
    const p = await project();
    const l = await lake();
    const w = await open(spec(p, l.spec()));
    await w.run(`CREATE TABLE ${LAKE_ALIAS}.t AS SELECT range AS a FROM range(100)`);
    const port = freePort();
    const rd = l.spec({ access: "read", reader: true });
    const c = await open({
      profile: "serve", timezone: "UTC",
      mode: { kind: "lake-readers", extensionDir: ext.dir, secretDir: p.secrets, lake: { ...rd, access: "read" }, prepare: (conn) => startQuackListener(conn, `quack:localhost:${port}`) },
    });
    expect((await loaded(c)).sort()).toEqual(["ducklake", "httpfs", "postgres", "quack"]);
    expect(await notListening(port)).toBe(false);
    expect(await rows(c, `SELECT count(*) FROM ${LAKE_ALIAS}.t`)).toEqual([[100n]]);
    expect(await error(c, `INSERT INTO ${LAKE_ALIAS}.t VALUES (1)`)).toMatch(/read-only|read only/i);
    await expectLocked(c, ["postgres", "ducklake", "httpfs", "quack"]);
    for (const sql of [
      `COPY (SELECT 1 a) TO 's3://lake/elsewhere/x.parquet'`,
      "SELECT * FROM read_text('/etc/hosts')",
      `SELECT * FROM read_text('${p.root}/.env')`,
      `ATTACH '${p.live}' AS live`,
    ]) expect(await error(c, sql), sql).toMatch(/Permission Error/);
    await c.run(`SELECT * FROM quack_stop('quack:localhost:${port}')`).catch(() => {});
  });

  test("lake-readers refuses a read-write lake: a reader never attaches with the writer's login", async () => {
    const lk = { catalog: { kind: "postgres" as const, host: "127.0.0.1", port: 1, database: "d", user: "u", password: "p" }, data: { path: "s3://lake/x/", keyId: "k", secretKey: "s" }, access: "write" as const };
    const instance = await DuckDBInstance.create(":memory:", instanceConfig("read_write"));
    cleanup.push(() => instance.closeSync());
    let caught: unknown;
    try {
      await connect(instance, { profile: "serve", timezone: "UTC", mode: { kind: "lake-readers", extensionDir: ext.dir, secretDir: join(tmpdir(), "croft-nope"), lake: lk as never } }, `:memory:lr${++seq}`);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CroftError);
  });

  withPg("a reader attaches read-only with the read-only login and bucket key: writes to a table and to the folder are refused", async () => {
    const p = await project();
    const l = await lake();
    const w = await open(spec(p, l.spec()));
    await w.run(`CREATE TABLE ${LAKE_ALIAS}.t AS SELECT range AS a FROM range(100)`);
    const r = await open(spec(p, l.spec({ access: "read", reader: true })));
    expect(await rows(r, `SELECT count(*) FROM ${LAKE_ALIAS}.t`)).toEqual([[100n]]);
    // The attach is read-only, so a table write is refused; the key is read-only too, so a COPY into the allowed
    // folder, which a read-only attach does not stop (D112), is refused by the store.
    expect(await error(r, `INSERT INTO ${LAKE_ALIAS}.t VALUES (1)`)).toMatch(/read-only|read only/i);
    expect(await error(r, `COPY (SELECT 1 a) TO '${l.folder}stray.parquet'`)).toMatch(/403|Access ?Denied|HTTP/i);
    expect(existsSync(join(s3.root, "lake", `proj${n}`, "stray.parquet"))).toBe(false);
  });

  describe("no credential in any error (acceptance 6)", () => {
    /** Every text an error can reach a person or a log through. */
    const surfaces = (e: unknown): string =>
      [String(e), (e as Error).message, (e as Error).stack ?? "", JSON.stringify((e as CroftError).problem ?? null), JSON.stringify(e, Object.getOwnPropertyNames(e as object))].join("\n");
    const never = ["Wr1ter-pw-Zx81", "KEYIDWRITER01", "sekrit-writer-0123456789", "R3ader-pw-Qj42", "KEYIDREADER02", "sekrit-reader-9876543210", "host=127.0.0.1"];

    async function attachFails(lk: LakeSpec, p: Project): Promise<CroftError> {
      const instance = await DuckDBInstance.create(":memory:", instanceConfig("read_write"));
      cleanup.push(() => instance.closeSync());
      try {
        await connect(instance, spec(p, lk), `:memory:cred${++seq}`);
      } catch (e) {
        return e as CroftError;
      }
      throw new Error("expected the attach to fail");
    }

    withPg("a wrong password", async () => {
      const p = await project();
      const l = await lake();
      const e = await attachFails(l.spec({ password: "Wr0ng-pw-Never-Print-1" }), p);
      expect(e.code).toBe("LAKE_ATTACH_FAILED");
      const text = surfaces(e);
      for (const s of [...never, "Wr0ng-pw-Never-Print-1"]) expect(text, s).not.toContain(s);
      expect(e.problem.hint.length).toBeGreaterThan(10);
    });

    withPg("an unreachable host", async () => {
      const p = await project();
      const l = await lake();
      const e = await attachFails(l.spec({ port: freePort() }), p);
      expect(e.code).toBe("LAKE_ATTACH_FAILED");
      for (const s of never) expect(surfaces(e), s).not.toContain(s);
    });

    withPg("a refused bucket key: the store's refusal echoes the key id, and scrubbing removes it", async () => {
      const p = await project();
      const l = await lake();
      const bad = l.spec({ keyId: "KEYIDREFUSED03", secretKey: "sekrit-refused-0000" });
      const mode = spec(p, bad).mode!;
      let raw: unknown;
      let attached = true;
      try {
        const c = await open(spec(p, bad));
        await c.run(`CREATE TABLE ${LAKE_ALIAS}.t AS SELECT range AS a FROM range(5000)`);
      } catch (e) {
        raw = e;
        attached = !(e instanceof CroftError);
      }
      expect(raw, "the store should refuse the key").toBeDefined();
      const text = surfaces(raw);
      if (attached) {
        // The attach worked and the first write was refused: DuckDB's own error echoes the key id (the reason for scrubbing).
        expect(text).toContain("KEYIDREFUSED03");
        const clean = scrubError(raw, mode);
        expect(surfaces(clean)).not.toContain("KEYIDREFUSED03");
        expect(surfaces(clean)).not.toContain("sekrit-refused-0000");
      } else {
        expect(text).not.toContain("KEYIDREFUSED03");
        expect(text).not.toContain("sekrit-refused-0000");
      }
    });

    test("scrub removes each secret, longest first, and password= assignments", () => {
      expect(scrub("failed for user x password=abc123 and key KEY12345 and KEY1", ["KEY1", "KEY12345"])).toBe("failed for user x password=[redacted] and key [redacted] and [redacted]");
      expect(scrub("host=h secret = 'a b'", [])).toBe("host=h secret=[redacted]");
    });
  });
});

describe("no code path installs an extension or reaches DuckDB's repository (acceptance 7)", () => {
  test("no source string issues INSTALL or names an extension repository", async () => {
    const { sourceFiles, SRC, sourceStrings } = await import("../agent/contract-testkit.ts");
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      for (const s of sourceStrings(file, readFileSync(file, "utf8"))) {
        // The SQL statement, upper case, or lower case followed by something DuckDB can install; not the English verb.
        if (/^\s*(FORCE\s+)?INSTALL\b/.test(s.text) || /^\s*(force\s+)?install\s+(httpfs|quack|ducklake|postgres|sqlite|parquet|json|icu|'|")/i.test(s.text) || /install_extension|\bFROM\s+community\b/i.test(s.text)) offenders.push(`${file}:${s.line}: ${s.text.slice(0, 80)}`);
        if (/extensions\.duckdb\.org|custom_extension_repository|autoinstall_known_extensions\s*=\s*true|autoload_known_extensions\s*=\s*true/i.test(s.text)) offenders.push(`${file}:${s.line}: ${s.text.slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  withExt("a mode's instance cannot install either: INSTALL is refused and the auto settings stay off", async () => {
    const p = await project();
    const c = await open(readers(p));
    expect(await error(c, "INSTALL httpfs FROM 'https://extensions.duckdb.org'")).toMatch(/disabled|Permission/);
    expect(await rows(c, "SELECT current_setting('autoinstall_known_extensions'), current_setting('autoload_known_extensions'), current_setting('allow_community_extensions')")).toEqual([[false, false, false]]);
  });
});
