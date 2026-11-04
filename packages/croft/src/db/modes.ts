// What a DuckDB instance loads, attaches and starts before its lockdown, per mode (DESIGN.md §5 "Pinned extensions and a
// lockdown per mode", D117, D118). Nothing here runs unless a SandboxSpec carries a `mode`; a project with no mode
// loads no extension and opens no connection beyond today's.
//
// The order, fixed, because DuckDB refuses to load an extension or attach a remote database once outside access is
// off, and Quack's server reads DuckDB's default secret folder (in the user's home) unless it is pointed elsewhere
// first [V: 2.0.0, option 06's spikes]:
//   1. check the mode against its profile and check every pinned file; nothing loads unless all of them check
//      (checkMode: no effect on the instance, so a refusal here leaves it clean)
//   2. load the extensions, by absolute path
//   3. point DuckDB's secret folder into croft's state folder
//   4. create the named secrets and attach what the mode attaches
//   5. run the caller's `prepare` (register hooks, start the Quack listener)
//   6. lock (connect.ts)
import type { DuckDBConnection } from "@duckdb/node-api";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { CroftError } from "../core/errors.ts";
import type { Fix } from "../core/types.ts";
import type { CatalogSslMode } from "../project/lake-config.ts";
import type { Profile } from "./connect.ts";
import { type ExtensionName } from "./extension-names.ts";
import { addonFor } from "./addons.ts";
import { verifyModeExtensions } from "./extension-files.ts";

/** The Postgres catalog a lake keeps its metadata in, with one login. Credentials live only in a named secret. */
export interface LakePostgres {
  kind: "postgres";
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** libpq's `sslmode` and, for `verify-full`, the CA file (an absolute path); see db/catalog-tls.ts. Left out, libpq's own default
   *  applies (`prefer`, which is also what any ambient PGSSLMODE would change): lake.ts always sets it. */
  sslMode?: CatalogSslMode;
  sslRootCert?: string;
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
  /** The PEM file of certificate authorities the store's certificate is checked against, an absolute path (db/store-tls.ts finds it). DuckDB
   *  may read no file once locked, so the file is allowed by name and httpfs is pointed at it; without one, an https store fails with
   *  "Cannot read a CA certificate bundle". Absent when the store is not reached over TLS. */
  caFile?: string;
  /** The bucket's root is allowed too, not only the folder. DuckDB's listing of a folder of more than a page of objects (S3 and R2 send 1,000
   *  keys to a page) asks for the rest at the bucket's root, and a locked instance refuses it ("Cannot access s3://<bucket>/"). Set only for the
   *  two warehouses of `croft maintain --orphans`, which run nothing but croft's own CALL; never for a connection that runs a person's SQL. */
  listsBucket?: true;
}

/** A lake attached read-write (the writing machine's login and key) or read-only (everything that only reads). */
export interface LakeSpec {
  catalog: LakePostgres;
  data: LakeBucket;
  access: "write" | "read";
  /** Only the bucket: its secret and CA file are made and nothing is attached, so no catalog is reached. For croft doctor's probe of the
   *  bucket (db/lake-probe.ts), which must work before a lake exists. */
  storeOnly?: true;
}

/** A local lake: a SQLite catalog file and a local data folder in place of Postgres and the bucket. For croft's own suite and
 *  for local development on one machine (option 07, slice 2); a shared lake is Postgres and a bucket. */
export interface LakeLocalSpec {
  catalog: { kind: "sqlite"; path: string };
  /** A local folder, with a trailing slash. */
  dataPath: string;
  access: "write" | "read";
}

interface ModeBase {
  /** A folder holding the pinned extension files in DuckDB's layout (extension-files.ts): croft's tests and builders name
   *  one, or set $CROFT_EXTENSION_DIR. Without either, the files come from the mode's add-on package (addons.ts). */
  extensionDir?: string;
  /** The project's root, from which the add-on package is found in node_modules (D134). */
  projectRoot?: string;
  /** DuckDB's secret folder for this instance, inside croft's state folder. */
  secretDir: string;
  /** Runs after the mode's attaches and before the lock: register hooks, start the listener. */
  prepare?: (conn: DuckDBConnection) => Promise<unknown>;
}

/** Server mode's readers' process: quack and httpfs; the read copy attached read-only; afterwards its path allowed and no folder. */
export interface ReadersMode extends ModeBase { kind: "readers"; copy: string }
/** A lake on Postgres and a bucket: ducklake, httpfs and postgres. */
export interface LakeMode extends ModeBase { kind: "lake"; lake: LakeSpec }
/** Server mode over a lake: the lake attached read-only, plus quack for the listener. */
export interface LakeReadersMode extends ModeBase { kind: "lake-readers"; lake: LakeSpec & { access: "read" } }
/** A local lake: ducklake and sqlite over local files. */
export interface LakeLocalMode extends ModeBase { kind: "lake-local"; lake: LakeLocalSpec }
/** Server mode over a local lake: the local lake attached read-only, plus quack for the listener. */
export interface LakeLocalReadersMode extends ModeBase { kind: "lake-local-readers"; lake: LakeLocalSpec & { access: "read" } }

export type ModeSpec = ReadersMode | LakeMode | LakeReadersMode | LakeLocalMode | LakeLocalReadersMode;
export type ModeKind = ModeSpec["kind"];

/**
 * A lake's read-only mode as the readers' process of server mode over a lake attaches it (option 07, slice 5; DESIGN.md D183): the same lake,
 * the same login and key, and quack loaded besides, with `prepare` to register the hooks and start the listener before the lock.
 */
export function lakeReadersMode(mode: LakeMode | LakeLocalMode, prepare?: ModeBase["prepare"]): LakeReadersMode | LakeLocalReadersMode {
  if (mode.lake.access !== "read") {
    throw new CroftError("INTERNAL_ERROR", { message: "a lake behind croft serve is attached read-only", hint: "report this croft bug" });
  }
  const base = { ...(mode.extensionDir ? { extensionDir: mode.extensionDir } : {}), ...(mode.projectRoot ? { projectRoot: mode.projectRoot } : {}), secretDir: mode.secretDir, ...(prepare ? { prepare } : {}) };
  return mode.kind === "lake"
    ? { ...base, kind: "lake-readers", lake: { ...mode.lake, access: "read" } }
    : { ...base, kind: "lake-local-readers", lake: { ...mode.lake, access: "read" } };
}

/** What each mode loads, in load order. The file profile loads nothing. */
export const MODE_EXTENSIONS: Readonly<Record<ModeKind, readonly ExtensionName[]>> = {
  readers: ["httpfs", "quack"],
  lake: ["httpfs", "postgres", "ducklake"],
  "lake-readers": ["httpfs", "postgres", "ducklake", "quack"],
  "lake-local": ["sqlite", "ducklake"],
  "lake-local-readers": ["httpfs", "sqlite", "ducklake", "quack"],
};

/** The alias a mode's attached database gets: the read copy, or the lake. */
export const READ_COPY_ALIAS = "wh";
/** The readers' process's own in-memory database (an in-memory instance's default catalog): it holds one view per shared
 *  table, reading the copy, and nothing else. A key's connection works in it, so a name it can type is one of those
 *  views (D122); a Quack session always starts here too, and no setting changes that (slice 4). */
export const READERS_VIEWS_DB = "memory";
export const LAKE_ALIAS = "lake";
/** The DuckLake format croft creates a lake at and attaches with (D137). DuckDB 2.0 creates 1.1 by default, which DuckDB 1.5.x
 *  cannot read; 1.0 can be read by both (the lake spike, 2026-11-01). Passed on every attach, so a catalog at another version is
 *  refused with DuckDB's own words instead of being migrated, and AUTOMATIC_MIGRATION is never given. */
export const DUCKLAKE_FORMAT = "1.0";
/** The named secrets (temporary, in memory) that carry the lake's credentials. */
export const LAKE_CATALOG_SECRET = "croft_lake_catalog";
export const LAKE_BUCKET_SECRET = "croft_lake_bucket";

const q = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** Every credential a mode holds; none may appear in any output, log, error or problem. */
export function modeSecrets(mode: ModeSpec): string[] {
  if (mode.kind === "readers" || mode.kind === "lake-local" || mode.kind === "lake-local-readers") return [];
  const { catalog, data } = mode.lake;
  return [catalog.password, data.keyId, data.secretKey, data.sessionToken].filter((s): s is string => !!s);
}

/** Text with every credential of `secrets` (and any `password=` or `secret=` assignment) replaced; for DuckDB's own messages. */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(s).join("[redacted]");
  return out.replace(/\b(password|passwd|pwd|secret|secret_key|key_id|session_token)\s*=\s*(?:'[^']*'|"[^"]*"|\S+)/gi, "$1=[redacted]");
}

/** `s3://<bucket>/` of a lake folder's `s3://<bucket>/<folder>/`. */
const bucketRoot = (path: string): string => `${/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i.exec(path)![0]}/`;

/** The remote (and, for the test lake, local) folder a lake's SQL may reach once locked. */
export function modeDirectories(mode: ModeSpec | undefined): string[] {
  if (!mode) return [];
  if (mode.kind === "lake" || mode.kind === "lake-readers") return [mode.lake.data.path, ...(mode.lake.data.listsBucket ? [bucketRoot(mode.lake.data.path)] : [])];
  if (mode.kind === "lake-local" || mode.kind === "lake-local-readers") return [mode.lake.dataPath];
  return [];
}

/** The single file paths (not folders) a mode's SQL may reach: the read copy, for the readers' process. */
export function modePaths(mode: ModeSpec | undefined): string[] {
  if (mode?.kind === "readers") return [mode.copy];
  // A store over TLS: the one CA file httpfs reads to check its certificate (D160). Nothing else of the machine's files.
  if ((mode?.kind === "lake" || mode?.kind === "lake-readers") && mode.lake.data.caFile) return [mode.lake.data.caFile];
  return [];
}

/** The local-folder profiles each mode may run under: the readers' processes reach no folder but their own. A lake behind a
 *  project's commands (Postgres and a bucket, or a local one) runs under any of the four, so a writing command keeps files/ and
 *  the state folder. */
export const MODE_PROFILES: Readonly<Record<ModeKind, readonly Profile[]>> = {
  readers: ["serve"],
  "lake-readers": ["serve"],
  "lake-local": ["warehouse", "query", "serve", "memory"],
  "lake-local-readers": ["serve"],
  lake: ["warehouse", "query", "serve", "memory"],
};

/** Everything about a mode that is not a secret, as the sandbox fingerprint holds it: two requests that differ in any of it must not share an instance. */
export function modeIdentity(mode: ModeSpec): unknown {
  const base = { kind: mode.kind, extensionDir: mode.extensionDir ?? null, projectRoot: mode.projectRoot ?? null, secretDir: mode.secretDir };
  if (mode.kind === "readers") return { ...base, copy: mode.copy };
  if (mode.kind === "lake-local" || mode.kind === "lake-local-readers") return { ...base, catalog: mode.lake.catalog.path, dataPath: mode.lake.dataPath, access: mode.lake.access };
  const { catalog, data, access } = mode.lake;
  return { ...base, catalog: [catalog.host, catalog.port, catalog.database, catalog.user, catalog.sslMode ?? null, catalog.sslRootCert ?? null], data: [data.path, data.endpoint ?? null, data.region ?? null, data.urlStyle ?? null, data.useSsl ?? null, data.caFile ?? null, data.listsBucket ?? null], access, storeOnly: mode.lake.storeOnly ?? null };
}

/** A digest of the mode's credentials, compared but never printed: a different password or key is a different instance. */
export function modeCredentialDigest(mode: ModeSpec): string {
  return createHash("sha256").update(JSON.stringify(modeSecrets(mode))).digest("hex");
}

/**
 * Steps 0 and 1: the mode fits its profile and every file checks. Touches nothing, so a refusal leaves the instance as it
 * was and a retry can succeed. Returns the verified files.
 */
export function checkMode(mode: ModeSpec, profile: Profile): Map<ExtensionName, string> {
  if (!MODE_PROFILES[mode.kind].includes(profile)) {
    throw new CroftError("INTERNAL_ERROR", {
      message: `the ${mode.kind} mode runs under the ${MODE_PROFILES[mode.kind].join(" or ")} profile, not ${profile}`,
      hint: "report this croft bug",
    });
  }
  if ((mode.kind === "lake-readers" || mode.kind === "lake-local-readers") && mode.lake.access !== "read") {
    throw new CroftError("INTERNAL_ERROR", { message: "a lake behind croft serve is attached read-only", hint: "report this croft bug" });
  }
  return verifyModeExtensions(MODE_EXTENSIONS[mode.kind], (n) => addonFor(mode.kind, n), {
    ...(mode.extensionDir ? { dir: mode.extensionDir } : {}),
    ...(mode.projectRoot ? { from: mode.projectRoot } : {}),
  });
}

const LOAD_FIX: Fix = {
  kind: "manual",
  description: "run croft doctor to check that the DuckDB library is the version croft pins, and reinstall the project's dependencies if it is not; if DuckDB still refuses, report it with details.duckdb",
};

async function attempt(conn: DuckDBConnection, sql: string, fail: (e: unknown) => unknown): Promise<void> {
  try { await conn.run(sql); } catch (e) { throw fail(e); }
}

/**
 * Steps 2 to 5, on the instance's first connection, after checkMode. A failure here leaves the instance part set up
 * (extensions loaded, secrets in memory, a database attached, a listener running); the caller must not use it again.
 * connect.ts marks the instance failed, so every later connect on it is a CroftError (a new instance, on the same key, works).
 */
export async function startMode(conn: DuckDBConnection, mode: ModeSpec, files: Map<ExtensionName, string>): Promise<void> {
  const secrets = modeSecrets(mode);
  // 2. Load by absolute path.
  for (const name of MODE_EXTENSIONS[mode.kind]) {
    await attempt(conn, `LOAD ${q(files.get(name)!)}`, (e) => new CroftError("EXTENSION_LOAD_FAILED", {
      message: `DuckDB would not load the ${name} extension`,
      hint: "the file passed its checksum, so this is DuckDB refusing it",
      fix: LOAD_FIX,
      retryable: false,
      details: { extension: name, duckdb: scrub(firstLine(e), secrets) },
    }));
  }
  // 3. The secret folder, in the state folder, before anything (Quack's listener) reads secrets. mkdir leaves an existing
  // folder's mode as it was, so set it. A lake's secrets are all temporary (nothing is written to the folder), so it is only pointed at, and a
  // command that merely reads (doctor, status) leaves no folder behind; DuckDB makes one if a persistent secret is ever created there.
  if (mode.kind !== "lake" && mode.kind !== "lake-local") {
    mkdirSync(mode.secretDir, { recursive: true, mode: 0o700 });
    chmodSync(mode.secretDir, 0o700);
  }
  await conn.run(`SET secret_directory = ${q(mode.secretDir)}`);
  // 4. What the mode attaches.
  if (mode.kind === "readers") {
    await attempt(conn, `ATTACH ${q(mode.copy)} AS ${READ_COPY_ALIAS} (READ_ONLY)`, (e) => new CroftError("INTERNAL_ERROR", {
      message: `the readers' process could not attach the read copy ${mode.copy}`,
      hint: "report this croft bug",
      details: { duckdb: firstLine(e) },
    }));
  } else if (mode.kind === "lake-local" || mode.kind === "lake-local-readers") {
    const { catalog, dataPath, access } = mode.lake;
    await attempt(conn, `ATTACH ${q(`ducklake:sqlite:${catalog.path}`)} AS ${LAKE_ALIAS} (DATA_PATH ${q(dataPath)}, DUCKLAKE_VERSION ${q(DUCKLAKE_FORMAT)}${access === "read" ? ", READ_ONLY" : ""})`, (e) => lakeFailure(e, secrets, access));
  } else {
    await attachLake(conn, mode.lake, secrets);
  }
  // 5. Hooks and the listener. What the caller's code throws is scrubbed of the mode's credentials like everything else.
  if (mode.prepare) {
    try { await mode.prepare(conn); } catch (e) { throw scrubThrown(e, secrets); }
  }
}

/** Create the lake's two named secrets and attach it; the password and keys are in the statements below and nowhere else. */
async function attachLake(conn: DuckDBConnection, lake: LakeSpec, secrets: string[]): Promise<void> {
  const { catalog, data, access } = lake;
  const fail = (e: unknown) => lakeFailure(e, secrets, access, catalog.sslMode, { host: catalog.host, port: catalog.port, database: catalog.database });
  // sslmode and sslrootcert are libpq connection parameters, which the postgres extension reads from the secret [V: 2.0.0, a Postgres with
  // TLS]. libpq reads the CA file itself, outside DuckDB's file system, so the lock's allowed_directories neither needs nor gets it.
  const tls = [...(catalog.sslMode ? [`SSLMODE ${q(catalog.sslMode)}`] : []), ...(catalog.sslRootCert ? [`SSLROOTCERT ${q(catalog.sslRootCert)}`] : [])];
  await attempt(conn, `CREATE OR REPLACE TEMPORARY SECRET ${LAKE_CATALOG_SECRET} (TYPE postgres, HOST ${q(catalog.host)}, PORT ${Math.trunc(catalog.port)}, DATABASE ${q(catalog.database)}, USER ${q(catalog.user)}, PASSWORD ${q(catalog.password)}${tls.map((t) => `, ${t}`).join("")})`, fail);
  const opts = [
    "TYPE s3", `KEY_ID ${q(data.keyId)}`, `SECRET ${q(data.secretKey)}`, `SCOPE ${q(data.path)}`,
    ...(data.sessionToken ? [`SESSION_TOKEN ${q(data.sessionToken)}`] : []),
    ...(data.endpoint ? [`ENDPOINT ${q(data.endpoint)}`] : []),
    ...(data.region ? [`REGION ${q(data.region)}`] : []),
    `URL_STYLE ${q(data.urlStyle ?? "path")}`,
    `USE_SSL ${data.useSsl === false ? "false" : "true"}`,
  ];
  await attempt(conn, `CREATE OR REPLACE TEMPORARY SECRET ${LAKE_BUCKET_SECRET} (${opts.join(", ")})`, fail);
  // A store over TLS is checked, always (D160). DuckDB 2.0's `enable_server_cert_verification` defaults to false, and its httplib client then
  // read a self-signed store with no CA or the wrong one, verifying nothing [V: 2.0.0]; the curl client checks regardless. Both are pinned
  // here, before the lock, so neither a default nor a setting of the machine's changes it.
  if (data.useSsl !== false) {
    await attempt(conn, `SET GLOBAL enable_server_cert_verification = true`, fail);
    await attempt(conn, `SET GLOBAL httpfs_client_implementation = 'curl'`, fail);
  }
  // httpfs checks the store's certificate against this file, and may read it only because modePaths allows it (D160).
  if (data.caFile)await attempt(conn, `SET GLOBAL ca_cert_file = ${q(data.caFile)}`, fail);
  if (lake.storeOnly) return; // croft doctor's probe of the bucket (D165): the store's secret and CA, no catalog is reached
  await attempt(conn, `ATTACH 'ducklake:postgres:' AS ${LAKE_ALIAS} (DATA_PATH ${q(data.path)}, META_SECRET ${LAKE_CATALOG_SECRET}, DUCKLAKE_VERSION ${q(DUCKLAKE_FORMAT)}${access === "read" ? ", READ_ONLY" : ""})`, fail);
}

function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0]!;
}

/** A read-only attach to a lake nobody has created yet: DuckLake will not create one for a reader (`does not exist - and creating a
 *  new DuckLake is explicitly disabled`), and SQLite cannot open a catalog file that is not there. */
const NOT_CREATED = /Existing DuckLake .* does not exist|creating a new DuckLake is explicitly disabled|unable to open database file/i;

/** A refusal that trying again will not change: the login or the key is wrong, or the database or role it names is not there. A catalog that
 *  is down or unreachable is not one of these: that is mended by waiting. */
export const REFUSED = /password authentication failed|authentication failed|no pg_hba|role "[^"]*" does not exist|database "[^"]*" does not exist|InvalidAccessKeyId|SignatureDoesNotMatch|AccessDenied|HTTP 40[13]/i;

/** libpq's and OpenSSL's words for a TLS check that failed (an unverifiable certificate, a name it was not issued for, a server with no
 *  TLS when TLS is required) [V: 2.0.0, a Postgres with TLS and one without]. Waiting does not change the answer, so it is not a
 *  connection that dropped (isConnectionError) and is not retried. */
export const TLS_REFUSED = /certificate verify failed|does not match host name|server does not support SSL|SSL error: (?:sslv3|tlsv1|wrong version|no protocols|ca md too weak)|root certificate file|invalid sslmode/i;

const TLS_SETTINGS = "lake.catalog.sslMode, lake.catalog.sslRootCert (croft docs lake)";

/** The catalog database holds a lake of another format than croft's. DuckLake says "catalog version is 0.3, but the extension requires version 1.0. To
 *  automatically migrate, set AUTOMATIC_MIGRATION to TRUE when attaching" for an older one, and "catalog version is '1.1', which is newer than the
 *  requested version '1.0'. Cannot downgrade a DuckLake catalog" for a newer one [V: 2.0.0]. The second real-lake trial pointed croft at a database
 *  that held another tool's lake, retried it three times over 154 s as if the catalog were down, and quoted the advice to migrate it. */
const FORMAT_MISMATCH = [
  /DuckLake catalog version mismatch: catalog version is '?([\w.]+?)'?, but the extension requires version '?([\w.]+?)'?(?:\.\s|\.$|,|\s|$)/i,
  /DuckLake catalog version is '?([\w.]+?)'?, which is newer than the requested version '?([\w.]+?)'?(?:\.\s|\.$|,|\s|$)/i,
];
/** The catalog's lake keeps its files in another folder than the settings name: `DATA_PATH parameter "s3://b/x/" does not match existing data path in the
 *  catalog "s3://b/y/". You can override the DATA_PATH by setting OVERRIDE_DATA_PATH to True` [V: 2.0.0]. */
const FOLDER_MISMATCH = /DATA_PATH parameter "([^"]*)" does not match existing data path in the catalog "([^"]*)"/i;

/** The catalog database holds a different lake than the settings describe: its format, or the folder its files are in. Permanent, and croft's to
 *  report, never to mend (it migrates no lake and overrides no data path; DESIGN.md D178). Null for any other refusal. */
export function catalogMismatch(raw: string, secrets: readonly string[], catalog?: { host: string; port: number; database: string }): CroftError | null {
  const where = catalog ? `${catalog.host}:${catalog.port}/${catalog.database}` : "the catalog database";
  const format = FORMAT_MISMATCH.map((re) => re.exec(raw)).find((m) => m !== null);
  if (format) {
    const [, has, wants] = format;
    return new CroftError("LAKE_CATALOG_MISMATCH", {
      message: `the catalog database ${where} holds a DuckLake of another format (${has}) than the one croft opens (${wants}): it is another lake, made by another tool or version, and croft never migrates a lake`,
      hint: "lake.catalog.database must name a database that holds only croft's lake (an empty one the first run fills); a lake of another format belongs to the tool that made it. Do not ask DuckDB to migrate it: that would change a lake something else still reads, and croft has no setting for it; trying again will not help",
      retryable: false,
      fix: { kind: "manual", description: "ask the user which database is croft's lake: point lake.catalog.database at an empty database of its own, or use the croft or DuckDB version that made this one", requiresHuman: true },
      details: { kind: "format", catalogFormat: has, croftFormat: wants },
    });
  }
  const folder = FOLDER_MISMATCH.exec(raw);
  if (folder) {
    const [, wanted, held] = folder;
    return new CroftError("LAKE_CATALOG_MISMATCH", {
      message: scrub(`the catalog database ${where} holds a lake whose files are in ${held}, and the settings name ${wanted}: it is another lake, or this one under another folder, and croft never overrides a lake's data path`,
        secrets),
      hint: `lake.bucket.name and lake.bucket.folder must name ${held} for this catalog database, or lake.catalog.database must name a database of its own for ${wanted}; files already in ${held} would be left behind by a lake that looked in ${wanted}; trying again will not help`,
      retryable: false,
      fix: { kind: "manual", description: "ask the user which folder is this lake's: set lake.bucket.name and lake.bucket.folder to it, or use another catalog database", requiresHuman: true },
      details: { kind: "data_path", catalogDataPath: held, settingsDataPath: wanted },
    });
  }
  return null;
}

/** DuckDB's refusal to attach a lake, with every credential taken out of the text. `sslMode` is the catalog's, for the hint of a TLS refusal;
 *  `catalog` names the database, for the mismatch of a lake that is not this one's. */
function lakeFailure(e: unknown, secrets: readonly string[], access?: "write" | "read", sslMode?: string, catalog?: { host: string; port: number; database: string }): CroftError {
  const raw = e instanceof Error ? e.message : String(e);
  const mismatch = catalogMismatch(raw, secrets, catalog);
  if (mismatch) return mismatch;
  const tls = TLS_REFUSED.test(raw);
  // With several addresses for one host name (localhost: ::1 and 127.0.0.1) libpq lists each failure on a line of its own, and DuckDB's
  // first line can be the one about an address nobody listens on; the line about the TLS check is the one that says what to fix.
  const detail = scrub((tls ? raw.split("\n").find((l) => TLS_REFUSED.test(l)) : undefined) ?? raw.split("\n")[0]!, secrets);
  const notCreated = access === "read" && NOT_CREATED.test(raw);
  const refused = !tls && REFUSED.test(raw);
  return new CroftError("LAKE_ATTACH_FAILED", {
    message: `croft could not attach the lake: ${detail}`,
    hint: notCreated
      ? "the lake does not exist yet: the machine that writes creates it with its first run (croft run), then readers can attach"
      : tls
        ? sslMode === "verify-full"
          ? `croft checks the catalog's certificate and it did not check out: it must be signed by a CA in the file lake.catalog.sslRootCert names (default: this machine's CA bundle) and issued for the name in lake.catalog.host. A catalog with no TLS fails here too. Fix the catalog's certificate or ${TLS_SETTINGS}; trying again will not help. Do not weaken lake.catalog.sslMode without asking the user`
          : `the catalog's TLS handshake failed with lake.catalog.sslMode "${sslMode ?? "prefer"}": check that setting against what the catalog offers (${TLS_SETTINGS}); trying again will not help`
      : refused
        ? "the catalog or the store refused the login or the key: ask the user to check the secrets the lake block names (croft docs LAKE_ATTACH_FAILED); trying again will not help"
        : "check the catalog's host, port, database and login, and the bucket's endpoint and key, in the project's settings and secrets",
    retryable: !notCreated && !refused && !tls,
    details: { duckdb: detail, ...(notCreated ? { notCreated: true } : {}), ...(refused ? { refused: true } : {}), ...(tls ? { tls: true } : {}) },
  });
}

/**
 * An error with the credentials taken out of every string in it. A CroftError keeps its code and fix; a plain Error keeps
 * its name. Wiring this into the query paths that run on a lake instance is option 07, slice 2.
 */
export function scrubThrown(e: unknown, secrets: readonly string[]): Error {
  if (!(e instanceof Error)) return new Error(scrub(String(e), secrets));
  if (!secrets.length) return e;
  if (e instanceof CroftError) {
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") return scrub(v, secrets);
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      return v;
    };
    const { severity: _s, code: _c, docs: _d, ...init } = walk(e.problem) as CroftError["problem"];
    return new CroftError(e.code, init);
  }
  const clean = new Error(scrub(e.message, secrets));
  clean.name = e.name;
  return clean;
}

/** For callers that run a query on a lake instance: DuckDB's error with the mode's credentials taken out of its text. */
export function scrubError(e: unknown, mode: ModeSpec | undefined): Error {
  return scrubThrown(e, mode ? modeSecrets(mode) : []);
}

/**
 * Start Quack's listener on `uri` (`quack:localhost:9510`). Call it from `prepare`: the listener must start before the
 * lock, because DuckDB refuses `quack_serve` afterwards. Who may connect is the authentication hook's job; without
 * a `token`, the one the listener needs is a random placeholder no client is given, and no secret is created for it.
 */
export async function startQuackListener(conn: DuckDBConnection, uri: string, opts: { token?: string; allowOtherHostname?: boolean; disableSsl?: boolean } = {}): Promise<string> {
  const t = opts.token ?? `unused-${crypto.randomUUID()}`;
  // Quack accepts only localhost as its host unless told otherwise [V: 2.0.0]; croft says so for anything else (D125).
  // Past localhost Quack serves TLS with a certificate of its own [V: 2.0.0: a client got "Unsupported protocol" over plain HTTP];
  // croft's design is a reverse proxy that holds the real certificate and speaks plain HTTP to Quack, as for its HTTP API (D125).
  const other = `${opts.allowOtherHostname ? ", allow_other_hostname = true" : ""}${opts.disableSsl ? ", disable_ssl = true" : ""}`;
  const reader = await conn.runAndReadAll(`SELECT listen_uri FROM quack_serve(${q(uri)}, token = ${q(t)}, create_secret_if_not_exists = false${other})`);
  // The address actually bound: a port of 0 is replaced by the one the system picked.
  return String(reader.getRowsJS()[0]?.[0] ?? uri);
}
