// A real lake for croft's tests (option 07, slice 2): a Postgres and an S3-compatible store started as CHILD processes of the test
// run (db/mode-testkit.ts), each lake with a catalog database of its own, a folder of the bucket of its own, and the two logins and two
// bucket keys a project names in its `lake` block, as `croft.json` and `.env` text. Everything is killed in teardown; nothing is an OS
// service. A local lake (a SQLite catalog and a folder) needs none of it.
// Test support, left out of the published package (package.json "files").
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extensionsReady, IN_CI } from "./extension-dir-testkit.ts";
import type { CatalogSslMode } from "../project/lake-config.ts";
import type { LakeConnection } from "./lake.ts";
import type { ModeSpec } from "./modes.ts";
import type { DuckWarehouse } from "./warehouse.ts";
import { postgresBin, startPostgres, startS3, type TestPostgres, type TestS3 } from "./mode-testkit.ts";

export const WRITER_LOGIN = { user: "lakew", password: "test-writer-password" };
export const READER_LOGIN = { user: "laker", password: "test-reader-password" };
export const WRITER_KEY = { id: "WKEYID0123456789", secret: "wsecret-0123456789abcdef" };
export const READER_KEY = { id: "RKEYID0123456789", secret: "rsecret-0123456789abcdef" };

/** Every credential the rig hands out; a test that looks for a leak looks for each of them. */
export const RIG_SECRETS: readonly string[] = [WRITER_LOGIN.password, READER_LOGIN.password, WRITER_KEY.id, WRITER_KEY.secret, READER_KEY.id, READER_KEY.secret];

/** The names the secrets have in a project's `.env`. */
export const SECRET_NAMES = {
  writerPassword: "LAKE_WRITER_PASSWORD", readerPassword: "LAKE_READER_PASSWORD",
  writerKeyId: "LAKE_WRITER_KEY_ID", writerKey: "LAKE_WRITER_KEY", readerKeyId: "LAKE_READER_KEY_ID", readerKey: "LAKE_READER_KEY",
} as const;

export interface RigLake {
  /** The catalog database, and the folder of the bucket (`s3://lakeb/<folder>/`). */
  db: string;
  bucket: string;
  folder: string;
  /** The `lake` block of croft.json. */
  block: Record<string, unknown>;
  /** The secrets, as .env holds them. */
  env: Record<string, string>;
  /** Where the lake's files are on disk (the store's folder), for a test that looks at what is stored. */
  files: string;
}

export interface LakeRig {
  pg: TestPostgres;
  s3: TestS3;
  /** A new lake: its own catalog database and bucket folder. */
  lake(over?: { writerPassword?: string; writerKeyId?: string; host?: string; port?: number; bucket?: string }): Promise<RigLake>;
  stop(): Promise<void>;
}

/** Whether the real lake can run here: the extension files and Postgres. Locally a missing piece skips with a reason; in CI it throws. */
export function lakeRigReady(): { ready: boolean; dir: string; skipReason: string } {
  const ext = extensionsReady(["httpfs", "postgres", "ducklake", "sqlite"]);
  if (!ext.ready) return ext;
  if (postgresBin() === null) {
    const msg = "postgres (initdb, postgres, psql) is not installed";
    if (IN_CI) throw new Error(`CI must have Postgres for the lake tests: ${msg}`);
    return { ready: false, dir: ext.dir, skipReason: `${msg}; install Homebrew's postgresql@17 (it is run in the foreground, never as a service)` };
  }
  return ext;
}

let n = 0;

export async function startLakeRig(o: { tls?: { cert: string; key: string } } = {}): Promise<LakeRig> {
  const pg = await startPostgres(o);
  let s3: TestS3;
  try {
    s3 = await startS3({ buckets: ["lakeb", "other"], keys: { [WRITER_KEY.id]: "rw", [READER_KEY.id]: "ro" } });
  } catch (e) {
    await pg.stop();
    throw e;
  }
  return {
    pg, s3,
    async lake(over = {}) {
      const db = `lake${++n}`;
      const folder = `proj${n}`;
      await pg.createLakeDatabase(db, WRITER_LOGIN, READER_LOGIN);
      const bucket = over.bucket ?? "lakeb";
      const block = {
        catalog: {
          kind: "postgres", host: over.host ?? pg.host, port: over.port ?? pg.port, database: db,
          writer: { user: WRITER_LOGIN.user, passwordSecret: SECRET_NAMES.writerPassword },
          reader: { user: READER_LOGIN.user, passwordSecret: SECRET_NAMES.readerPassword },
        },
        bucket: {
          name: bucket, folder: `${folder}/`, endpoint: s3.endpoint, region: "us-east-1", urlStyle: "path", useSsl: false,
          writer: { keyIdSecret: SECRET_NAMES.writerKeyId, secretKeySecret: SECRET_NAMES.writerKey },
          reader: { keyIdSecret: SECRET_NAMES.readerKeyId, secretKeySecret: SECRET_NAMES.readerKey },
        },
      };
      const env = {
        [SECRET_NAMES.writerPassword]: over.writerPassword ?? WRITER_LOGIN.password, [SECRET_NAMES.readerPassword]: READER_LOGIN.password,
        [SECRET_NAMES.writerKeyId]: over.writerKeyId ?? WRITER_KEY.id, [SECRET_NAMES.writerKey]: WRITER_KEY.secret,
        [SECRET_NAMES.readerKeyId]: READER_KEY.id, [SECRET_NAMES.readerKey]: READER_KEY.secret,
      };
      return { db, bucket, folder, block, env, files: join(s3.root, bucket, folder) };
    },
    async stop() {
      await s3.stop();
      await pg.stop();
    },
  };
}

/**
 * A rig lake as a warehouse opens it, with no project: the modes for each access, built from the rig's own values. For tests of the
 * warehouse itself (db/lake-warehouse.test.ts). `extensionDir` is the folder of pinned extension files.
 */
export function rigConnection(rig: LakeRig, lake: RigLake, o: { stateDir: string; extensionDir: string; override?: { writerPassword?: string; port?: number }; catalog?: { host?: string; sslMode?: CatalogSslMode; sslRootCert?: string } }): LakeConnection {
  const mode = (access: "write" | "read"): ModeSpec => ({
    kind: "lake", extensionDir: o.extensionDir, secretDir: join(o.stateDir, "lake-secrets"),
    lake: {
      catalog: {
        kind: "postgres", host: o.catalog?.host ?? rig.pg.host, port: o.override?.port ?? rig.pg.port, database: lake.db,
        ...(o.catalog?.sslMode ? { sslMode: o.catalog.sslMode } : {}), ...(o.catalog?.sslRootCert ? { sslRootCert: o.catalog.sslRootCert } : {}),
        user: access === "write" ? WRITER_LOGIN.user : READER_LOGIN.user,
        password: access === "write" ? o.override?.writerPassword ?? WRITER_LOGIN.password : READER_LOGIN.password,
      },
      data: {
        path: `s3://${lake.bucket}/${lake.folder}/`, keyId: access === "write" ? WRITER_KEY.id : READER_KEY.id,
        secretKey: access === "write" ? WRITER_KEY.secret : READER_KEY.secret, endpoint: rig.s3.endpoint, region: "us-east-1", urlStyle: "path", useSsl: false,
      },
      access,
    },
  });
  return { label: `lake s3://${lake.bucket}/${lake.folder}/`, kind: "postgres", secretDir: join(o.stateDir, "lake-secrets"), secretNames: [], mode };
}

/** A local lake (a SQLite catalog and a folder in `dir`) as a warehouse opens it, with no project. For tests of the warehouse itself. */
export function localLakeConnection(o: { dir: string; stateDir: string; extensionDir: string }): LakeConnection {
  const secretDir = join(o.stateDir, "lake-secrets");
  mkdirSync(join(o.dir, "data"), { recursive: true });
  const mode = (access: "write" | "read"): ModeSpec => ({
    kind: "lake-local", extensionDir: o.extensionDir, secretDir,
    lake: { catalog: { kind: "sqlite", path: join(o.dir, "catalog.sqlite") }, dataPath: `${join(o.dir, "data")}/`, access },
  });
  return { label: `lake ${o.dir}`, kind: "local", secretDir, secretNames: [], mode };
}

/**
 * The clock of a lake's snapshots, for tests that need weeks to pass. DuckLake stamps a snapshot with the time of its commit, which a test
 * cannot move, and the promise of the lake's maintenance is about their age (30 days); so a test says, after each step, "the snapshots made
 * since I last said were made at this time", and the catalog's own record is changed to match (a test of croft's maintenance with a
 * CROFT_NOW as the project's clock). Nothing here is croft's own code path.
 */
export interface LakeClock {
  /** The id of the newest snapshot. */
  newest(): Promise<number>;
  /** The snapshots made since the last call (or all of them, the first time) were made at `at`. Returns the newest snapshot's id. */
  mark(at: Date): Promise<number>;
  /** Snapshot `id` was made at `at`, whatever was said before. */
  setTime(id: number, at: Date): Promise<void>;
  /** Another tool set an option on the lake (its own set_option call, which croft's code never runs): written into the catalog. */
  setOption(name: string, value: string): Promise<void>;
}

const stamp = (at: Date): string => at.toISOString().replace("T", " ").replace("Z", "+00");

function clockOver(run: (sql: string) => Promise<string>): LakeClock {
  let watermark = -1;
  const newest = async (): Promise<number> => Number(await run("SELECT max(snapshot_id) FROM ducklake_snapshot"));
  return {
    newest,
    async mark(at) {
      const top = await newest();
      await run(`UPDATE ducklake_snapshot SET snapshot_time = '${stamp(at)}' WHERE snapshot_id > ${watermark} AND snapshot_id <= ${top}`);
      watermark = top;
      return top;
    },
    async setTime(id, at) {
      await run(`UPDATE ducklake_snapshot SET snapshot_time = '${stamp(at)}' WHERE snapshot_id = ${id}`);
    },
    async setOption(name, value) {
      await run(`INSERT INTO ducklake_metadata (key, value) VALUES ('${name}', '${value}')`);
    },
  };
}

/** The clock of a local lake: its SQLite catalog. */
export function sqliteLakeClock(catalogPath: string): LakeClock {
  return clockOver(async (sql) => {
    const { Database } = await import("bun:sqlite");
    const db = new Database(catalogPath);
    try {
      db.exec("PRAGMA busy_timeout = 10000");
      if (/^\s*select/i.test(sql)) return String(Object.values((db.query(sql).get() as Record<string, unknown> | null) ?? {})[0] ?? "");
      db.exec(sql);
      return "";
    } finally {
      db.close();
    }
  });
}

/** The clock of a Postgres lake: its catalog database, as the test's superuser. */
export function postgresLakeClock(rig: Pick<LakeRig, "pg">, db: string): LakeClock {
  return clockOver((sql) => rig.pg.sql(sql, db));
}

export type TestLakeKind = "local" | "postgres";

/** A lake with a writing warehouse, a read-only one, and the clock of its snapshots, with no project around it. */
export interface TestLake {
  kind: TestLakeKind;
  w: DuckWarehouse;
  r: DuckWarehouse;
  clock: LakeClock;
  conn: LakeConnection;
  root: string;
  stateDir: string;
  /** The folder on disk that holds the lake's data files (the local lake's, or the store's folder for the lake's bucket folder). */
  dataDir: string;
  /** Postgres: the catalog's database. */
  db?: string;
  /** Postgres: the store, for faults. */
  s3?: TestS3;
  /** Postgres: the rig the lake is in (its superuser reads the catalog's size, and more). */
  rig?: LakeRig;
  close(): Promise<void>;
}

/**
 * A new lake of `kind` in a new folder. A Postgres lake needs the rig (`startLakeRig`); a local one only the extension files. Its warehouses are
 * registered under paths of their own, so one process holds many lakes.
 */
export async function openTestLake(kind: TestLakeKind, o: { extensionDir: string; rig?: LakeRig; waits?: Partial<{ offTtyMs: number }>; stateDir?: string }): Promise<TestLake> {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { openWarehouse } = await import("./warehouse.ts");
  const root = mkdtempSync(join(tmpdir(), "croft-testlake-"));
  const stateDir = o.stateDir ?? join(root, ".croft");
  mkdirSync(stateDir, { recursive: true });
  let conn: LakeConnection;
  let clock: LakeClock;
  let dataDir: string;
  let db: string | undefined;
  if (kind === "local") {
    conn = localLakeConnection({ dir: join(root, "lake"), stateDir, extensionDir: o.extensionDir });
    clock = sqliteLakeClock(join(root, "lake", "catalog.sqlite"));
    dataDir = join(root, "lake", "data");
  } else {
    if (!o.rig) throw new Error("a Postgres test lake needs the rig");
    const lake = await o.rig.lake();
    conn = rigConnection(o.rig, lake, { stateDir, extensionDir: o.extensionDir });
    clock = postgresLakeClock(o.rig, lake.db);
    dataDir = lake.files;
    db = lake.db;
  }
  const base = { path: join(root, "w.duckdb"), timezone: "UTC", root, stateDir, lake: conn, isTTY: false, register: false };
  const w = openWarehouse({ ...base, mode: "read_write", ...(o.waits ? { waits: o.waits } : {}) });
  const r = openWarehouse({ ...base, path: join(root, "r.duckdb"), mode: "read_only", profile: "query" });
  return {
    kind, w, r, clock, conn, root, stateDir, dataDir, ...(db ? { db } : {}), ...(o.rig ? { s3: o.rig.s3, rig: o.rig } : {}),
    async close() {
      await w.close();
      await r.close();
    },
  };
}

/** The `lake` block of a local lake (a SQLite catalog and a folder), both under `lake/` in the project. */
export function localLakeBlock(): Record<string, unknown> {
  return { catalog: { kind: "sqlite", path: "lake/catalog.sqlite" }, dataPath: "lake/data" };
}

/** Put a lake into a project folder: its block in croft.json, its secrets in .env. */
export function useLake(root: string, lake: { block: Record<string, unknown>; env?: Record<string, string> }): void {
  const file = join(root, "croft.json");
  const config = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, `${JSON.stringify({ ...config, lake: lake.block }, null, 2)}\n`);
  if (lake.env && Object.keys(lake.env).length) {
    const envFile = join(root, ".env");
    const before = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
    mkdirSync(root, { recursive: true });
    writeFileSync(envFile, `${before}${before === "" || before.endsWith("\n") ? "" : "\n"}${Object.entries(lake.env).map(([k, v]) => `${k}=${v}`).join("\n")}\n`);
  }
}
