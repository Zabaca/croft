// Pinned extensions loaded by path, and a lockdown per mode (DESIGN.md D117, D118; option 06 slice 1, shared with 07).
// These tests load DuckDB's real extension files, so they need them (scripts/fetch-extensions.ts fills the folder)
// and, for the lake profile, a Postgres. Locally a missing file or program skips the tests that need it and says why
// on stderr; in CI (CROFT_CI=1) it fails them instead, so a test never passes by skipping there. Every server a test
// starts (Postgres, the S3-compatible store, the Quack listener) is a child process of the test, killed in teardown.
import { afterAll, describe, expect, test } from "bun:test";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CroftError } from "../core/errors.ts";
import type { CatalogSslMode } from "../project/lake-config.ts";
import { connect, instanceConfig, type SandboxSpec } from "./connect.ts";
import { extensionsReady, IN_CI } from "./extension-dir-testkit.ts";
import { fetchExtensions } from "./extension-fetch.ts";
import { extensionPath, hostPlatform, verifyExtension } from "./extension-files.ts";
import { repoPath, type StandInRepo, startStandInRepo } from "./extension-repo-testkit.ts";
import { DUCKDB_VERSION, type ExtensionName } from "./extension-names.ts";
import { MODE_FILES } from "./extension-status.ts";
import { LAKE_ALIAS, type LakeSpec, lakeReadersMode, MODE_EXTENSIONS, modeCredentialDigest, modeIdentity, type ModeSpec, READ_COPY_ALIAS, scrub, scrubError, scrubThrown, startQuackListener } from "./modes.ts";
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

/** The test lake: a SQLite catalog in the state folder and a local data folder. Under the serve profile, as the mode requires. */
function lakeTestSpec(p: Project, access: "write" | "read" = "write", prepare?: (c: DuckDBConnection) => Promise<void>, over: Record<string, string> = {}): SandboxSpec {
  mkdirSync(join(p.root, "lake-data"), { recursive: true });
  return {
    profile: "serve", timezone: "UTC",
    mode: {
      kind: "lake-local", extensionDir: ext.dir, secretDir: p.secrets, prepare,
      lake: { catalog: { kind: "sqlite", path: over.catalog ?? join(p.state, "meta.sqlite") }, dataPath: over.dataPath ?? join(p.root, "lake-data") + "/", access },
    },
  };
}

/** A readers' process with a Quack listener, as a child of the test (quack-listener-testkit.ts), killed in teardown. */
async function listenerChild(p: Project, token = "tok-modes-1"): Promise<{ port: number; token: string; stop: () => Promise<void> }> {
  const port = freePort();
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "quack-listener-testkit.ts"), "--ext", ext.dir, "--state", p.state, "--copy", p.copy, "--port", String(port), "--token", token, "--tables", "t"], {
    stdout: "pipe", stderr: "inherit", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  });
  const stop = track(child);
  cleanup.push(stop);
  await readListening(child);
  return { port, token, stop };
}

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
    expect(MODE_EXTENSIONS["lake-local"]).toEqual(["sqlite", "ducklake"]);
    expect(MODE_EXTENSIONS["lake-local-readers"]).toEqual(["httpfs", "sqlite", "ducklake", "quack"]);
    for (const [kind, names] of Object.entries(MODE_EXTENSIONS)) if (kind !== "lake-local" && kind !== "lake-local-readers") expect(names, kind).not.toContain("sqlite");
  });

  test("the files validate, doctor and status look for are the files the modes load", () => {
    expect(MODE_FILES.server.extensions).toEqual(MODE_EXTENSIONS.readers);
    expect(MODE_FILES.lake.extensions).toEqual(MODE_EXTENSIONS.lake);
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

  async function failure(dir: string, kind: "readers" | "lake-local"): Promise<{ error: CroftError; conn: DuckDBConnection }> {
    const p = await project();
    const instance = await DuckDBInstance.create(":memory:", instanceConfig("read_write"));
    cleanup.push(() => instance.closeSync());
    const spec: SandboxSpec = kind === "readers"
      ? readers(p, { extensionDir: dir })
      : { profile: "serve", timezone: "UTC", mode: { kind: "lake-local", extensionDir: dir, secretDir: p.secrets, lake: { catalog: { kind: "sqlite", path: join(p.state, "meta.sqlite") }, dataPath: join(p.state, "lake") + "/", access: "write" } } };
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
    // Fetching is off in the suite (tests/preload.ts), so the mode says what to run instead of downloading.
    expect(e.problem.fix).toMatchObject({ kind: "command", command: "croft fetch-extensions httpfs quack" });
    expect(e.problem.details).toMatchObject({ kind: "file", extension: "httpfs", missing: ["httpfs", "quack"] });
    expect(await loadedNames(conn)).toEqual([]);
  });

  withExt("a checksum mismatch: EXTENSION_CHECKSUM_MISMATCH, and the files before it are not loaded either", async () => {
    // lake-local loads sqlite first, then ducklake: damage ducklake, the second, and prove sqlite did not load.
    const dir = folderWith("ducklake", (real, to) => {
      const bytes = readFileSync(real);
      bytes[Math.floor(bytes.length / 2)]! ^= 0xff; // one flipped byte, same size, same footer
      writeFileSync(to, bytes);
    });
    const { error: e, conn } = await failure(dir, "lake-local");
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

  withExt("the listener starts before the lock, a client reads the copy over Quack, and the lock then refuses a second listener and a remote attach (acceptance 2)", async () => {
    const p = await project();
    const { port, token, stop } = await listenerChild(p);

    const client = await DuckDBInstance.create(":memory:", instanceConfig("read_write"));
    const cc = await client.connect();
    cleanup.push(() => {
      cc.disconnectSync();
      client.closeSync();
    });
    for (const n of ["httpfs", "quack"] as const) await cc.run(`LOAD '${verifyExtension(ext.dir, n)}'`);
    expect(await error(cc, `ATTACH 'quack:localhost:${port}' AS bad (TOKEN 'wrong-token')`)).toMatch(/Authentication failed|authentication/i);
    await cc.run(`ATTACH 'quack:localhost:${port}' AS r (TOKEN '${token}')`);
    expect(await rows(cc, "SELECT count(*), sum(a) FROM r.t")).toEqual([[5n, 10n]]);

    // In this process, the same profile locks with the listener already started; a second one is refused afterwards,
    // and so is attaching a remote Quack server, with a valid token, even though quack is loaded.
    const c = await open(readers(p));
    const late = freePort();
    await error(c, `SELECT * FROM quack_serve('quack:localhost:${late}', token = 'x', create_secret_if_not_exists = false)`);
    expect(await notListening(late)).toBe(true);
    await error(c, `ATTACH 'quack:localhost:${port}' AS remote (TOKEN '${token}')`);
    await error(c, `ATTACH 'quack:localhost:${port}' AS remote2 (TYPE quack, TOKEN '${token}')`);
    // Refused, not merely failed late: the plain client above attached the same server with the same token.
    expect(await rows(c, "SELECT database_name FROM duckdb_databases() WHERE database_name LIKE 'remote%'")).toEqual([]);
    await stop();
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
    // The listener used secrets before the lock, so unlike a readers' instance without one, a temporary secret can still
    // be made afterwards (DESIGN.md §5); the gate, not the lock, keeps user SQL from it.
    await c.run("CREATE TEMPORARY SECRET after_lock (TYPE s3, KEY_ID 'a', SECRET 'b')");
    await c.run(`SELECT * FROM quack_stop('quack:localhost:${port}')`).catch(() => {});
  });
});

describe("a mode that does not fit its profile, differs from the instance, or fails to start", () => {
  withExt("readers under a profile with local folders is refused, and the instance stays clean (should-fix 1)", async () => {
    const p = await project();
    const instance = await DuckDBInstance.create(":memory:", instanceConfig("read_write"));
    cleanup.push(() => instance.closeSync());
    const bad: SandboxSpec = { profile: "warehouse", timezone: "UTC", root: p.root, stateDir: p.state, mode: readers(p).mode! };
    let caught: unknown;
    try {
      await connect(instance, bad, `:memory:fit${seq}`);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CroftError);
    expect((caught as CroftError).message).toContain("serve profile");
    // Nothing was loaded or attached, so the right profile still works on the same instance and key.
    const c = await connect(instance, readers(p), `:memory:fit${seq}`);
    cleanup.push(() => c.disconnectSync());
    expect(await error(c, `SELECT * FROM read_text('${p.secrets}/probe.txt')`)).toContain("Permission Error");
    // lake-readers runs under the serve profile only; a lake behind a project's commands (Postgres and a bucket, or a local one) runs under any.
    const other = await DuckDBInstance.create(":memory:", instanceConfig("read_write"));
    cleanup.push(() => other.closeSync());
    await expect(connect(other, { ...lakeTestSpec(p), profile: "warehouse", root: p.root, stateDir: p.state }, `:memory:fit2${seq}`)).resolves.toBeDefined();
    const third = await DuckDBInstance.create(":memory:", instanceConfig("read_write"));
    cleanup.push(() => third.closeSync());
    const readersOnAFile = { profile: "warehouse" as const, timezone: "UTC", root: p.root, stateDir: p.state, mode: { kind: "lake-readers" as const, extensionDir: ext.dir, secretDir: p.secrets,
      lake: { catalog: { kind: "postgres" as const, host: "127.0.0.1", port: 1, database: "d", user: "u", password: "p" }, data: { path: "s3://lake/x/", keyId: "k", secretKey: "s" }, access: "read" as const } } };
    await expect(connect(third, readersOnAFile, `:memory:fit3${seq}`)).rejects.toBeInstanceOf(CroftError);
  });

  withExt("the lake test profile reaches its own folder only: not the state folder, files/, or the project", async () => {
    const p = await project();
    const c = await open(lakeTestSpec(p));
    for (const sql of [
      `SELECT * FROM read_text('${p.secrets}/probe.txt')`,
      `SELECT * FROM read_csv('${p.root}/files/a.csv')`,
      `SELECT * FROM read_text('${p.root}/.env')`,
      `ATTACH '${p.state}/other.duckdb' AS other`,
    ]) expect(await error(c, sql), sql).toContain("Permission Error");
  });

  withExt("one key, a different access or catalog or credentials: a CroftError, never the first request's connection (must-fix 1)", async () => {
    const p = await project();
    const instance = await DuckDBInstance.create(":memory:", instanceConfig("read_write"));
    cleanup.push(() => instance.closeSync());
    const key = `:memory:fp${++seq}`;
    const w = await connect(instance, lakeTestSpec(p, "write"), key);
    cleanup.push(() => w.disconnectSync());
    await w.run(`CREATE TABLE ${LAKE_ALIAS}.t AS SELECT 1 a`);
    // The same spec again is fine; a read-only request on the writer's instance is not.
    const again = await connect(instance, lakeTestSpec(p, "write"), key);
    again.disconnectSync();
    await expect(connect(instance, lakeTestSpec(p, "read"), key)).rejects.toBeInstanceOf(CroftError);
    await expect(connect(instance, lakeTestSpec(p, "write", undefined, { catalog: join(p.state, "other.sqlite") }), key)).rejects.toBeInstanceOf(CroftError);
    await expect(connect(instance, lakeTestSpec(p, "write", undefined, { dataPath: join(p.root, "elsewhere") + "/" }), key)).rejects.toBeInstanceOf(CroftError);
  });

  test("the identity and credential digest tell two lakes apart without printing a secret", () => {
    const lake = (o: { access?: "write" | "read"; host?: string; port?: number; database?: string; user?: string; password?: string; keyId?: string; sslMode?: CatalogSslMode; sslRootCert?: string }): ModeSpec => ({
      kind: "lake", extensionDir: "/e", secretDir: "/s",
      lake: { catalog: { kind: "postgres", host: o.host ?? "h", port: o.port ?? 5432, database: o.database ?? "d", user: o.user ?? "u", password: o.password ?? "pw-one-1234", ...(o.sslMode ? { sslMode: o.sslMode } : {}), ...(o.sslRootCert ? { sslRootCert: o.sslRootCert } : {}) }, data: { path: "s3://b/f/", keyId: o.keyId ?? "KEYID1234", secretKey: "sk-one-5678" }, access: o.access ?? "write" },
    });
    const id = (m: ModeSpec) => JSON.stringify(modeIdentity(m));
    const base = lake({});
    for (const other of [lake({ access: "read" }), lake({ host: "h2" }), lake({ port: 5433 }), lake({ database: "d2" }), lake({ user: "u2" }), lake({ sslMode: "disable" }), lake({ sslMode: "verify-full", sslRootCert: "/ca.pem" }), lake({ sslMode: "verify-full", sslRootCert: "/other.pem" })]) expect(id(other)).not.toBe(id(base));
    expect(id(lake({ password: "pw-two-9999" }))).toBe(id(base));
    expect(modeCredentialDigest(lake({ password: "pw-two-9999" }))).not.toBe(modeCredentialDigest(base));
    expect(modeCredentialDigest(lake({ keyId: "KEYID9999" }))).not.toBe(modeCredentialDigest(base));
    expect(id(base) + modeCredentialDigest(base)).not.toContain("pw-one-1234");
    expect(id(base)).not.toContain("sk-one-5678");
    expect(id(base)).not.toContain("KEYID1234");
  });

  withExt("a mode that fails after it started marks its instance failed: a retry and a no-mode connect on it are CroftErrors, a new instance on the same key works", async () => {
    const p = await project();
    const instance = await DuckDBInstance.create(":memory:", instanceConfig("read_write"));
    cleanup.push(() => instance.closeSync());
    const key = `:memory:half${++seq}`;
    const boom = async () => { throw new Error("listener port busy"); };
    await expect(connect(instance, lakeTestSpec(p, "write", boom), key)).rejects.toThrow("listener port busy");
    // The instance now has extensions loaded and the lake attached, unlocked. A retry must not run on it.
    for (const spec of [lakeTestSpec(p, "write"), { profile: "warehouse" as const, timezone: "UTC", root: p.root, stateDir: p.state }]) {
      let caught: unknown;
      try {
        await connect(instance, spec, key);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(CroftError);
      expect((caught as CroftError).message).toContain("part set up");
    }
    // The failed instance stays refused, and a new instance on the same key (callers key by the warehouse path) works
    // once what failed is fixed, as after a catalog that was unreachable for a moment.
    await expect(connect(instance, lakeTestSpec(p, "write"), key)).rejects.toBeInstanceOf(CroftError);
    instance.closeSync();
    const second = await DuckDBInstance.create(":memory:", instanceConfig("read_write"));
    cleanup.push(() => second.closeSync());
    const c = await connect(second, lakeTestSpec(p, "write"), key);
    cleanup.push(() => c.disconnectSync());
    expect(await rows(c, `SELECT count(*) FROM duckdb_databases() WHERE database_name = '${LAKE_ALIAS}'`)).toEqual([[1n]]);
    // And a real attach failure (a catalog folder that is missing), retried on a new instance with the folder back.
    const key2 = `:memory:blip${++seq}`;
    const first = await DuckDBInstance.create(":memory:", instanceConfig("read_write"));
    cleanup.push(() => first.closeSync());
    const gone = join(p.root, "no-such-folder", "meta.sqlite");
    await expect(connect(first, lakeTestSpec(p, "write", undefined, { catalog: gone }), key2)).rejects.toMatchObject({ problem: { code: "LAKE_ATTACH_FAILED", retryable: true } });
    await expect(connect(first, lakeTestSpec(p, "write"), key2)).rejects.toBeInstanceOf(CroftError);
    first.closeSync();
    const retry = await DuckDBInstance.create(":memory:", instanceConfig("read_write"));
    cleanup.push(() => retry.closeSync());
    const rc = await connect(retry, lakeTestSpec(p, "write"), key2);
    cleanup.push(() => rc.disconnectSync());
    expect(await rows(rc, `SELECT count(*) FROM duckdb_databases() WHERE database_name = '${LAKE_ALIAS}'`)).toEqual([[1n]]);
  });

  withExt("a file problem is found before anything starts, so it leaves the instance clean and a retry works", async () => {
    const p = await project();
    const instance = await DuckDBInstance.create(":memory:", instanceConfig("read_write"));
    cleanup.push(() => instance.closeSync());
    const key = `:memory:clean${++seq}`;
    const empty = mkdtempSync(join(tmpdir(), "croft-extdir-empty-"));
    cleanup.push(() => rmSync(empty, { recursive: true, force: true }));
    const spec = lakeTestSpec(p);
    await expect(connect(instance, { ...spec, mode: { ...spec.mode!, extensionDir: empty } }, key)).rejects.toMatchObject({ problem: { code: "EXTENSION_MISSING" } });
    const c = await connect(instance, lakeTestSpec(p), key);
    cleanup.push(() => c.disconnectSync());
    await c.run(`CREATE TABLE ${LAKE_ALIAS}.t AS SELECT 1 a`);
  });

  withExt("the secret folder is 0700 even when it already existed with another mode", async () => {
    const p = await project();
    chmodSync(p.secrets, 0o755);
    await open(readers(p));
    expect(statSync(p.secrets).mode & 0o777).toBe(0o700);
  });

  test("scrubThrown takes credentials out of a CroftError's every string and keeps its code and fix", () => {
    const e = new CroftError("LAKE_ATTACH_FAILED", {
      message: "failed with hunter2-secret", hint: "try key KEYID-9876", retryable: true,
      fix: { kind: "manual", description: "use hunter2-secret" }, details: { nested: { text: "password=hunter2-secret" }, list: ["KEYID-9876"] },
    });
    const clean = scrubThrown(e, ["hunter2-secret", "KEYID-9876"]) as CroftError;
    expect(clean).toBeInstanceOf(CroftError);
    expect(clean.code).toBe("LAKE_ATTACH_FAILED");
    expect(clean.problem.retryable).toBe(true);
    expect(JSON.stringify(clean.problem) + clean.message).not.toMatch(/hunter2-secret|KEYID-9876/);
    const plain = scrubThrown(new TypeError("boom hunter2-secret"), ["hunter2-secret"]);
    expect(plain.message).toBe("boom [redacted]");
    expect(plain.name).toBe("TypeError");
  });
});

describe("lake test profile (a SQLite catalog and a local folder)", () => {
  const lakeTest = lakeTestSpec;

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
    // A local attach inside what the profile allows (here its own folder) still works (the trash does this, §5).
    await c.run(`ATTACH '${p.root}/lake-data/trash.duckdb' AS trash`);
    await c.run("CREATE TABLE trash.z AS SELECT 1 a");
    await c.run("DETACH trash");
  });

  withExt("lake-local-readers (server mode over a local lake): sqlite, ducklake, httpfs and quack; read-only; the listener starts before the lock (D183)", async () => {
    const p = await project();
    const w = await open(lakeTestSpec(p));
    await w.run(`CREATE TABLE ${LAKE_ALIAS}.t AS SELECT range AS a FROM range(100)`);
    const port = freePort();
    const base = lakeTestSpec(p, "read");
    const c = await open({
      profile: "serve", timezone: "UTC",
      mode: { ...(base.mode as Extract<ModeSpec, { kind: "lake-local" }>), kind: "lake-local-readers", lake: { ...(base.mode as Extract<ModeSpec, { kind: "lake-local" }>).lake, access: "read" }, prepare: (conn) => startQuackListener(conn, `quack:localhost:${port}`) },
    });
    expect((await loaded(c)).sort()).toEqual(["ducklake", "httpfs", "quack", "sqlite"]);
    expect(await notListening(port)).toBe(false);
    expect(await rows(c, `SELECT count(*) FROM ${LAKE_ALIAS}.t`)).toEqual([[100n]]);
    expect(await error(c, `INSERT INTO ${LAKE_ALIAS}.t VALUES (1)`)).toMatch(/read-only|read only/i);
    await expectLocked(c, ["sqlite", "ducklake", "httpfs", "quack"]);
    for (const sql of ["SELECT * FROM read_text('/etc/hosts')", `SELECT * FROM read_text('${p.root}/.env')`, `ATTACH '${p.live}' AS live`, "ATTACH 'dbname=x host=127.0.0.1' AS pg (TYPE postgres)"]) {
      expect(await error(c, sql), sql).toMatch(/Permission Error|Loading external extensions is disabled/);
    }
    await c.run(`SELECT * FROM quack_stop('quack:localhost:${port}')`).catch(() => {});
  });

  test("lake-local-readers refuses a read-write lake, and lakeReadersMode turns a lake's read mode into the readers' one and nothing else", async () => {
    const p = await project();
    const rw = lakeTestSpec(p, "write").mode as Extract<ModeSpec, { kind: "lake-local" }>;
    expect(() => lakeReadersMode(rw)).toThrow(/read-only/);
    const instance = await DuckDBInstance.create(":memory:", instanceConfig("read_write"));
    cleanup.push(() => instance.closeSync());
    const err = await connect(instance, { profile: "serve", timezone: "UTC", mode: { ...rw, kind: "lake-local-readers" } as never }, `:memory:llr${++seq}`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CroftError);
    const ro = lakeTestSpec(p, "read").mode as Extract<ModeSpec, { kind: "lake-local" }>;
    expect(lakeReadersMode(ro)).toMatchObject({ kind: "lake-local-readers", extensionDir: ext.dir, secretDir: p.secrets, lake: { access: "read", dataPath: ro.lake.dataPath } });
    const hooks = async () => {};
    expect(lakeReadersMode(ro, hooks).prepare).toBe(hooks);
    expect(modeIdentity(lakeReadersMode(ro))).not.toEqual(modeIdentity(ro)); // a readers' instance is never shared with a lake's
  });

  withExt("the format is pinned: a new lake is made at 1.0, and a catalog of another format is LAKE_CATALOG_MISMATCH, never migrated (D137, D178)", async () => {
    const { Database } = await import("bun:sqlite");
    const versionOf = (catalog: string): string => {
      const db = new Database(catalog, { readonly: true });
      try {
        return (db.query("SELECT value FROM ducklake_metadata WHERE key = 'version'").get() as { value: string }).value;
      } finally {
        db.close();
      }
    };
    // A lake croft makes is at 1.0 ...
    const p = await project();
    const c = await open(lakeTest(p));
    await c.run(`CREATE TABLE ${LAKE_ALIAS}.t AS SELECT 1 a`);
    expect(versionOf(join(p.state, "meta.sqlite"))).toBe("1.0");
    // ... and a catalog DuckDB 2.0 made at its own default (1.1) is not attached by a croft that asks for 1.0, writer or reader, and stays 1.1.
    const q = await project();
    mkdirSync(join(q.root, "lake-data"), { recursive: true });
    const raw = await DuckDBInstance.create(":memory:");
    const rc = await raw.connect();
    await rc.run(`LOAD '${extensionPath(ext.dir, "sqlite", hostPlatform()!)}'`);
    await rc.run(`LOAD '${extensionPath(ext.dir, "ducklake", hostPlatform()!)}'`);
    await rc.run(`ATTACH 'ducklake:sqlite:${join(q.state, "meta.sqlite")}' AS other (DATA_PATH '${join(q.root, "lake-data")}/')`);
    await rc.run("CREATE TABLE other.t AS SELECT 1 a");
    rc.disconnectSync();
    raw.closeSync();
    expect(versionOf(join(q.state, "meta.sqlite"))).toBe("1.1");
    for (const access of ["write", "read"] as const) {
      const err = await open(lakeTest(q, access)).catch((e: unknown) => e);
      expect(err, access).toBeInstanceOf(CroftError);
      expect((err as CroftError).code).toBe("LAKE_CATALOG_MISMATCH"); // not LAKE_ATTACH_FAILED, which says "check the host": the second real-lake trial
      expect((err as CroftError).problem, access).toMatchObject({ retryable: false, details: { kind: "format", catalogFormat: "1.1", croftFormat: "1.0" } });
      expect(JSON.stringify((err as CroftError).problem), access).toMatch(/another format \(1\.1\)/);
    }
    expect(versionOf(join(q.state, "meta.sqlite"))).toBe("1.1");
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
  const WRITER = { user: "lakew", password: "test-writer-password" };
  const READER = { user: "laker", password: "test-reader-password" };
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
    const remote = await listenerChild(p);
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
    // A remote Quack server, with a valid token, cannot be attached once locked, though quack is loaded (acceptance 2).
    await error(c, `ATTACH 'quack:localhost:${remote.port}' AS remote (TOKEN '${remote.token}')`);
    expect(await rows(c, "SELECT database_name FROM duckdb_databases() WHERE database_name LIKE 'remote%'")).toEqual([]);
    for (const sql of [
      `COPY (SELECT 1 a) TO 's3://lake/elsewhere/x.parquet'`,
      "SELECT * FROM read_text('/etc/hosts')",
      `SELECT * FROM read_text('${p.root}/.env')`,
      `ATTACH '${p.live}' AS live`,
    ]) expect(await error(c, sql), sql).toMatch(/Permission Error/);
    await c.run(`SELECT * FROM quack_stop('quack:localhost:${port}')`).catch(() => {});
    await remote.stop();
  });

  withPg("an error from the caller's prepare is scrubbed of the lake's credentials (should-fix 6)", async () => {
    const p = await project();
    const l = await lake();
    const w = await open(spec(p, l.spec()));
    await w.run(`CREATE TABLE ${LAKE_ALIAS}.t AS SELECT 1 a`);
    const lk = l.spec({ access: "read", reader: true });
    const instance = await DuckDBInstance.create(":memory:", instanceConfig("read_write"));
    cleanup.push(() => instance.closeSync());
    let caught: unknown;
    try {
      await connect(instance, {
        profile: "serve", timezone: "UTC",
        mode: { kind: "lake-readers", extensionDir: ext.dir, secretDir: p.secrets, lake: { ...lk, access: "read" }, prepare: async () => { throw new Error(`listener failed for ${READER.password} and ${KEYS.ro.id}`); } },
      }, `:memory:ps${++seq}`);
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toContain("listener failed");
    expect((caught as Error).message).not.toContain(READER.password);
    expect((caught as Error).message).not.toContain(KEYS.ro.id);
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
    const never = ["test-writer-password", "KEYIDWRITER01", "sekrit-writer-0123456789", "test-reader-password", "KEYIDREADER02", "sekrit-reader-9876543210", "host=127.0.0.1"];

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

describe("no code path installs an extension, turns off the signature check, or reaches DuckDB's repository but the fetch module (acceptance 7, D195)", () => {
  test("no source issues INSTALL, allows unsigned extensions, names an extension repository outside extension-fetch.ts, or turns auto-install on", async () => {
    const { sourceFiles, SRC, sourceStrings } = await import("../agent/contract-testkit.ts");
    const ts = (await import("typescript")).default;
    const offenders: string[] = [];
    // The SQL statement anywhere in a string (also after a `;`), upper or lower case; a lower-case template that is only
    // `install ${name}`. Not the English verb in a hint ("install X, or write its absolute path").
    // At the start of a string only upper case is the SQL statement (lower case is the English verb in a hint); after a `;` either case is.
    const startsWithStatement = /^\s*(FORCE\s+)?INSTALL\b/;
    const statementOnly = /^\s*(force\s+)?install\s+X\s*(from\s+X)?\s*;?\s*$/i;
    const knownName = /\binstall\s+(httpfs|quack|ducklake|postgres|sqlite|parquet|json|icu)\b/i;
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const s of sourceStrings(file, text)) {
        if (startsWithStatement.test(s.text) || /;\s*(FORCE\s+)?INSTALL\b/i.test(s.text) || statementOnly.test(s.text) || knownName.test(s.text) || /install_extension|\bFROM\s+community\b/i.test(s.text)) offenders.push(`${file}:${s.line}: ${s.text.slice(0, 80)}`);
        if (/custom_extension_repository|allow_unsigned_extensions|autoinstall_known_extensions\s*=\s*true|autoload_known_extensions\s*=\s*true/i.test(s.text)) offenders.push(`${file}:${s.line}: ${s.text.slice(0, 80)}`);
        // DuckDB's own extension servers are named in one file: the one that downloads from them, before any lock (D195).
        if (/extensions\.duckdb\.org/i.test(s.text) && !file.endsWith("/db/extension-fetch.ts")) offenders.push(`${file}:${s.line}: ${s.text.slice(0, 80)}`);
      }
      // The options as object properties or assignments: { autoinstall_known_extensions: "true" } and friends.
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const visit = (n: import("typescript").Node): void => {
        if (ts.isPropertyAssignment(n) && /^(autoinstall_known_extensions|autoload_known_extensions|allow_community_extensions|allow_unsigned_extensions)$/.test(n.name.getText(sf).replace(/["'`]/g, ""))) {
          const v = n.initializer;
          const on = v.kind === ts.SyntaxKind.TrueKeyword || ((ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) && /^(true|1|on)$/i.test(v.text));
          if (on) offenders.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${n.getText(sf)}`);
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
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

describe("a mode fetches what the folder lacks from DuckDB, before it locks (D195)", () => {
  /** A stand-in for DuckDB's repository that serves the real pinned files, and the environment that points croft at it. */
  async function realRepo(): Promise<{ repo: StandInRepo; restore: () => void }> {
    const repo = startStandInRepo();
    const platform = hostPlatform()!;
    for (const n of ["httpfs", "quack"] as const) repo.files.set(repoPath(n, platform), readFileSync(extensionPath(ext.dir, n, platform)));
    const saved = { off: process.env.CROFT_NO_FETCH, repo: process.env.CROFT_EXTENSION_REPO };
    process.env.CROFT_NO_FETCH = "";
    process.env.CROFT_EXTENSION_REPO = repo.url;
    return {
      repo,
      restore: () => {
        repo.stop();
        process.env.CROFT_NO_FETCH = saved.off;
        process.env.CROFT_EXTENSION_REPO = saved.repo;
      },
    };
  }

  withExt("opening a readers' mode on an empty folder fetches its files, loads them with DuckDB's signature check on, and works", async () => {
    const { repo, restore } = await realRepo();
    try {
      const empty = mkdtempSync(join(tmpdir(), "croft-extdir-fetch-"));
      cleanup.push(() => rmSync(empty, { recursive: true, force: true }));
      const p = await project();
      const c = await open(readers(p, { extensionDir: empty }));
      expect(repo.requests.sort()).toEqual([repoPath("httpfs", hostPlatform()!), repoPath("quack", hostPlatform()!)]);
      expect(await loaded(c)).toEqual(expect.arrayContaining(["quack", "httpfs"]));
      expect(await rows(c, `SELECT count(*) FROM ${READ_COPY_ALIAS}.main.t`)).toEqual([[5n]]);
    } finally {
      restore();
    }
  });

  withExt("after croft's fetch, a fresh instance works with fetching off and the repository unreachable", async () => {
    const { repo, restore } = await realRepo();
    try {
      const dir = mkdtempSync(join(tmpdir(), "croft-extdir-fetch-"));
      cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
      const fetched = await fetchExtensions(["httpfs", "quack"], { dir, log: () => {} });
      expect(fetched.map((f) => f.downloaded)).toEqual([true, true]);
      expect(repo.requests).toHaveLength(2);
      // The network goes away: fetching is off, and the repository is a port nothing listens on.
      process.env.CROFT_NO_FETCH = "1";
      process.env.CROFT_EXTENSION_REPO = `http://127.0.0.1:${freePort()}`;
      repo.stop();
      const p = await project();
      const c = await open(readers(p, { extensionDir: dir }));
      expect(await loaded(c)).toEqual(expect.arrayContaining(["quack", "httpfs"]));
      expect(await rows(c, `SELECT count(*) FROM ${READ_COPY_ALIAS}.main.t`)).toEqual([[5n]]);
      expect(repo.requests).toHaveLength(2);
    } finally {
      restore();
    }
  });

  withExt("a locked instance never fetches: reopening it asks the repository for nothing, even with its files gone", async () => {
    const { repo, restore } = await realRepo();
    try {
      const dir = mkdtempSync(join(tmpdir(), "croft-extdir-fetch-"));
      cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
      const p = await project();
      const instance = await DuckDBInstance.create(":memory:", instanceConfig("read_write"));
      cleanup.push(() => instance.closeSync());
      const spec = readers(p, { extensionDir: dir });
      const key = `:memory:locked${++seq}`;
      const first = await connect(instance, spec, key);
      cleanup.push(() => first.disconnectSync());
      expect(repo.requests).toHaveLength(2);
      rmSync(dir, { recursive: true, force: true });
      const again = await connect(instance, spec, key);
      cleanup.push(() => again.disconnectSync());
      expect(await rows(again, "SELECT 1")).toEqual([[1]]);
      expect(repo.requests).toHaveLength(2);
    } finally {
      restore();
    }
  });

  withExt("a mode that does not fit its profile is refused before anything is downloaded", async () => {
    const { repo, restore } = await realRepo();
    try {
      const dir = mkdtempSync(join(tmpdir(), "croft-extdir-fetch-"));
      cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
      const p = await project();
      const instance = await DuckDBInstance.create(":memory:", instanceConfig("read_write"));
      cleanup.push(() => instance.closeSync());
      const spec: SandboxSpec = { ...readers(p, { extensionDir: dir }), profile: "warehouse" };
      await expect(connect(instance, spec, `:memory:badfit${++seq}`)).rejects.toThrow(/profile/);
      expect(repo.requests).toEqual([]);
    } finally {
      restore();
    }
  });

  withExt("a file that is there but wrong is refused, not replaced behind the user's back", async () => {
    const { repo, restore } = await realRepo();
    try {
      const dir = mkdtempSync(join(tmpdir(), "croft-extdir-fetch-"));
      cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
      const bad = extensionPath(dir, "httpfs", hostPlatform()!);
      mkdirSync(dirname(bad), { recursive: true });
      writeFileSync(bad, "tampered");
      const p = await project();
      const instance = await DuckDBInstance.create(":memory:", instanceConfig("read_write"));
      cleanup.push(() => instance.closeSync());
      const err = await connect(instance, readers(p, { extensionDir: dir }), `:memory:wrong${++seq}`).catch((e: unknown) => e);
      expect((err as CroftError).code).toBe("EXTENSION_CHECKSUM_MISMATCH");
      expect(readFileSync(extensionPath(dir, "httpfs", hostPlatform()!), "utf8")).toBe("tampered");
      // Only the file that was absent was asked for.
      expect(repo.requests).toEqual([repoPath("quack", hostPlatform()!)]);
    } finally {
      restore();
    }
  });
});
