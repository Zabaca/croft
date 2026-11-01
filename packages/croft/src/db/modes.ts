// What a DuckDB instance loads, attaches and starts before its lockdown, per mode (DESIGN.md §5 "Pinned extensions and a
// lockdown per mode", D117, D118). Nothing here runs unless a SandboxSpec carries a `mode`; a project with no mode
// loads no extension and opens no connection beyond today's.
//
// The order, fixed, because DuckDB refuses to load an extension or attach a remote database once outside access is
// off, and Quack's server reads DuckDB's default secret folder (in the user's home) unless it is pointed elsewhere
// first [V: 2.0.0, option 06's spikes]:
//   1. check every pinned file; nothing loads unless all of them check
//   2. load the extensions, by absolute path
//   3. point DuckDB's secret folder into croft's state folder
//   4. create the named secrets and attach what the mode attaches
//   5. run the caller's `prepare` (register hooks, start the Quack listener)
//   6. lock (connect.ts)
import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdirSync } from "node:fs";
import { CroftError } from "../core/errors.ts";
import { type ExtensionName } from "./extension-names.ts";
import { verifyExtensions } from "./extension-files.ts";

/** The Postgres catalog a lake keeps its metadata in, with one login. Credentials live only in a named secret. */
export interface LakePostgres {
  kind: "postgres";
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/** Where a lake keeps its Parquet files: one folder of one bucket on an S3-compatible store, with one key. */
export interface LakeBucket {
  /** `s3://<bucket>/<folder>/`: the only remote path SQL may name once the instance is locked. */
  path: string;
  keyId: string;
  secretKey: string;
  sessionToken?: string;
  /** `host[:port]`; omit for AWS. */
  endpoint?: string;
  region?: string;
  urlStyle?: "path" | "vhost";
  useSsl?: boolean;
}

/** A lake attached read-write (the writing machine's login and key) or read-only (everything that only reads). */
export interface LakeSpec {
  catalog: LakePostgres;
  data: LakeBucket;
  access: "write" | "read";
}

/** The lake test profile: a SQLite catalog file and a local data folder in place of Postgres and the bucket. Test suite only. */
export interface LakeTestSpec {
  catalog: { kind: "sqlite"; path: string };
  /** A local folder, with a trailing slash. */
  dataPath: string;
  access: "write" | "read";
}

interface ModeBase {
  /** The folder holding the pinned extension files (extension-files.ts). */
  extensionDir: string;
  /** DuckDB's secret folder for this instance, inside croft's state folder. */
  secretDir: string;
  /** Runs after the mode's attaches and before the lock: register hooks, start the listener. */
  prepare?: (conn: DuckDBConnection) => Promise<void>;
}

/** Server mode's readers' process: quack and httpfs; the read copy attached read-only; afterwards its path allowed and no folder. */
export interface ReadersMode extends ModeBase { kind: "readers"; copy: string }
/** A lake on Postgres and a bucket: ducklake, httpfs and postgres. */
export interface LakeMode extends ModeBase { kind: "lake"; lake: LakeSpec }
/** Server mode over a lake: the lake attached read-only, plus quack for the listener. */
export interface LakeReadersMode extends ModeBase { kind: "lake-readers"; lake: LakeSpec & { access: "read" } }
/** croft's own lake tests: ducklake and sqlite over local files. */
export interface LakeTestMode extends ModeBase { kind: "lake-test"; lake: LakeTestSpec }

export type ModeSpec = ReadersMode | LakeMode | LakeReadersMode | LakeTestMode;
export type ModeKind = ModeSpec["kind"];

/** What each mode loads, in load order. The file profile loads nothing. */
export const MODE_EXTENSIONS: Readonly<Record<ModeKind, readonly ExtensionName[]>> = {
  readers: ["httpfs", "quack"],
  lake: ["httpfs", "postgres", "ducklake"],
  "lake-readers": ["httpfs", "postgres", "ducklake", "quack"],
  "lake-test": ["sqlite", "ducklake"],
};

/** The alias a mode's attached database gets: the read copy, or the lake. */
export const READ_COPY_ALIAS = "wh";
export const LAKE_ALIAS = "lake";
/** The named secrets (temporary, in memory) that carry the lake's credentials. */
export const LAKE_CATALOG_SECRET = "croft_lake_catalog";
export const LAKE_BUCKET_SECRET = "croft_lake_bucket";

const q = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** Every credential a mode holds; none may appear in any output, log, error or problem. */
export function modeSecrets(mode: ModeSpec): string[] {
  if (mode.kind === "readers" || mode.kind === "lake-test") return [];
  const { catalog, data } = mode.lake;
  return [catalog.password, data.keyId, data.secretKey, data.sessionToken].filter((s): s is string => !!s);
}

/** Text with every credential of `secrets` (and any `password=` or `secret=` assignment) replaced; for DuckDB's own messages. */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(s).join("[redacted]");
  return out.replace(/\b(password|passwd|pwd|secret|secret_key|key_id|session_token)\s*=\s*(?:'[^']*'|"[^"]*"|\S+)/gi, "$1=[redacted]");
}

/** The remote (and, for the test lake, local) folder a lake's SQL may reach once locked. */
export function modeDirectories(mode: ModeSpec | undefined): string[] {
  if (!mode) return [];
  if (mode.kind === "lake" || mode.kind === "lake-readers") return [mode.lake.data.path];
  if (mode.kind === "lake-test") return [mode.lake.dataPath];
  return [];
}

/** The single file paths (not folders) a mode's SQL may reach: the read copy, for the readers' process. */
export function modePaths(mode: ModeSpec | undefined): string[] {
  return mode?.kind === "readers" ? [mode.copy] : [];
}

/** Steps 1 to 5 above, on the instance's first connection. A failure leaves nothing half loaded for the caller to use. */
export async function prepareMode(conn: DuckDBConnection, mode: ModeSpec): Promise<void> {
  if (mode.kind === "lake-readers" && mode.lake.access !== "read") {
    throw new CroftError("INTERNAL_ERROR", { message: "a lake behind croft serve is attached read-only", hint: "report this croft bug" });
  }
  // 1. Every file checks before the first loads.
  const names = MODE_EXTENSIONS[mode.kind];
  const files = verifyExtensions(mode.extensionDir, names);
  const secrets = modeSecrets(mode);
  const run = async (sql: string, fail: (e: unknown) => CroftError) => {
    try { await conn.run(sql); } catch (e) { throw fail(e); }
  };
  // 2. Load by absolute path.
  for (const name of names) {
    await run(`LOAD ${q(files.get(name)!)}`, (e) => new CroftError("EXTENSION_LOAD_FAILED", {
      message: `DuckDB would not load the ${name} extension`,
      hint: "the file passed its checksum, so this is DuckDB refusing it; report this croft bug",
      retryable: false,
      details: { extension: name, duckdb: scrub(firstLine(e), secrets) },
    }));
  }
  // 3. The secret folder, in the state folder, before anything (Quack's listener) reads secrets.
  mkdirSync(mode.secretDir, { recursive: true, mode: 0o700 });
  await conn.run(`SET secret_directory = ${q(mode.secretDir)}`);
  // 4. What the mode attaches.
  if (mode.kind === "readers") {
    await run(`ATTACH ${q(mode.copy)} AS ${READ_COPY_ALIAS} (READ_ONLY)`, (e) => new CroftError("INTERNAL_ERROR", {
      message: `the readers' process could not attach the read copy ${mode.copy}`,
      hint: "report this croft bug",
      details: { duckdb: firstLine(e) },
    }));
  } else if (mode.kind === "lake-test") {
    const { catalog, dataPath, access } = mode.lake;
    await run(`ATTACH ${q(`ducklake:sqlite:${catalog.path}`)} AS ${LAKE_ALIAS} (DATA_PATH ${q(dataPath)}${access === "read" ? ", READ_ONLY" : ""})`, (e) => lakeFailure(e, secrets));
  } else {
    await attachLake(conn, mode.lake, secrets);
  }
  // 5. Hooks and the listener.
  if (mode.prepare) await mode.prepare(conn);
}

/** Create the lake's two named secrets and attach it; the password and keys are in the statements below and nowhere else. */
async function attachLake(conn: DuckDBConnection, lake: LakeSpec, secrets: string[]): Promise<void> {
  const { catalog, data, access } = lake;
  const fail = (e: unknown) => lakeFailure(e, secrets);
  await run1(conn, `CREATE OR REPLACE TEMPORARY SECRET ${LAKE_CATALOG_SECRET} (TYPE postgres, HOST ${q(catalog.host)}, PORT ${Math.trunc(catalog.port)}, DATABASE ${q(catalog.database)}, USER ${q(catalog.user)}, PASSWORD ${q(catalog.password)})`, fail);
  const opts = [
    "TYPE s3", `KEY_ID ${q(data.keyId)}`, `SECRET ${q(data.secretKey)}`, `SCOPE ${q(data.path)}`,
    ...(data.sessionToken ? [`SESSION_TOKEN ${q(data.sessionToken)}`] : []),
    ...(data.endpoint ? [`ENDPOINT ${q(data.endpoint)}`] : []),
    ...(data.region ? [`REGION ${q(data.region)}`] : []),
    `URL_STYLE ${q(data.urlStyle ?? "path")}`,
    `USE_SSL ${data.useSsl === false ? "false" : "true"}`,
  ];
  await run1(conn, `CREATE OR REPLACE TEMPORARY SECRET ${LAKE_BUCKET_SECRET} (${opts.join(", ")})`, fail);
  await run1(conn, `ATTACH 'ducklake:postgres:' AS ${LAKE_ALIAS} (DATA_PATH ${q(data.path)}, META_SECRET ${LAKE_CATALOG_SECRET}${access === "read" ? ", READ_ONLY" : ""})`, fail);
}

async function run1(conn: DuckDBConnection, sql: string, fail: (e: unknown) => CroftError): Promise<void> {
  try { await conn.run(sql); } catch (e) { throw fail(e); }
}

function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0]!;
}

/** DuckDB's refusal to attach a lake, with every credential taken out of the text. */
function lakeFailure(e: unknown, secrets: readonly string[]): CroftError {
  const raw = e instanceof Error ? e.message : String(e);
  const detail = scrub(raw.split("\n")[0]!, secrets);
  return new CroftError("LAKE_ATTACH_FAILED", {
    message: `croft could not attach the lake: ${detail}`,
    hint: "check the catalog's host, port, database and login, and the bucket's endpoint and key, in the project's settings and secrets",
    retryable: true,
    details: { duckdb: detail },
  });
}

/** For callers that run a query on a lake instance: DuckDB's error with the mode's credentials taken out of its text. */
export function scrubError(e: unknown, mode: ModeSpec | undefined): Error {
  const secrets = mode ? modeSecrets(mode) : [];
  if (!secrets.length || !(e instanceof Error)) return e instanceof Error ? e : new Error(String(e));
  const clean = new Error(scrub(e.message, secrets));
  clean.name = e.name;
  return clean;
}

/**
 * Start Quack's listener on `uri` (`quack:localhost:9510`). Call it from `prepare`: the listener must start before the
 * lock, because DuckDB refuses `quack_serve` afterwards. Who may connect is the authentication hook's job; without
 * a `token`, the one the listener needs is a random placeholder no client is given, and no secret is created for it.
 */
export async function startQuackListener(conn: DuckDBConnection, uri: string, token?: string): Promise<void> {
  const t = token ?? `unused-${crypto.randomUUID()}`;
  await conn.run(`SELECT listen_uri FROM quack_serve(${q(uri)}, token = ${q(t)}, create_secret_if_not_exists = false)`);
}
