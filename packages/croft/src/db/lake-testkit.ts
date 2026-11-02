// A real lake for croft's tests (option 07, slice 2): a Postgres and an S3-compatible store started as CHILD processes of the test
// run (db/mode-testkit.ts), each lake with a catalog database of its own, a folder of the bucket of its own, and the two logins and two
// bucket keys a project names in its `lake` block, as `croft.json` and `.env` text. Everything is killed in teardown; nothing is an OS
// service. A local lake (a SQLite catalog and a folder) needs none of it.
// Test support, left out of the published package (package.json "files").
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extensionsReady, IN_CI } from "./extension-dir-testkit.ts";
import type { LakeConnection } from "./lake.ts";
import type { ModeSpec } from "./modes.ts";
import { postgresBin, startPostgres, startS3, type TestPostgres, type TestS3 } from "./mode-testkit.ts";

export const WRITER_LOGIN = { user: "lakew", password: "Wr1ter-pw-Zx81" };
export const READER_LOGIN = { user: "laker", password: "R3ader-pw-Qj42" };
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

export async function startLakeRig(): Promise<LakeRig> {
  const pg = await startPostgres();
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
export function rigConnection(rig: LakeRig, lake: RigLake, o: { stateDir: string; extensionDir: string; override?: { writerPassword?: string; port?: number } }): LakeConnection {
  const mode = (access: "write" | "read"): ModeSpec => ({
    kind: "lake", extensionDir: o.extensionDir, secretDir: join(o.stateDir, "lake-secrets"),
    lake: {
      catalog: {
        kind: "postgres", host: rig.pg.host, port: o.override?.port ?? rig.pg.port, database: lake.db,
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
