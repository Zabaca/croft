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
import type { Profile } from "./connect.ts";
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
  prepare?: (conn: DuckDBConnection) => Promise<unknown>;
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
/** The readers' process's own in-memory database (an in-memory instance's default catalog): it holds one view per shared
 *  table, reading the copy, and nothing else. A key's connection works in it, so a name it can type is one of those
 *  views (D122); a Quack session always starts here too, and no setting changes that (slice 4). */
export const READERS_VIEWS_DB = "memory";
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

/** The local-folder profiles each mode may run under: the readers' processes and the test lake reach no folder but their own. */
export const MODE_PROFILES: Readonly<Record<ModeKind, readonly Profile[]>> = {
  readers: ["serve"],
  "lake-readers": ["serve"],
  "lake-test": ["serve"],
  lake: ["warehouse", "query", "serve", "memory"],
};

/** Everything about a mode that is not a secret, as the sandbox fingerprint holds it: two requests that differ in any of it must not share an instance. */
export function modeIdentity(mode: ModeSpec): unknown {
  const base = { kind: mode.kind, extensionDir: mode.extensionDir, secretDir: mode.secretDir };
  if (mode.kind === "readers") return { ...base, copy: mode.copy };
  if (mode.kind === "lake-test") return { ...base, catalog: mode.lake.catalog.path, dataPath: mode.lake.dataPath, access: mode.lake.access };
  const { catalog, data, access } = mode.lake;
  return { ...base, catalog: [catalog.host, catalog.port, catalog.database, catalog.user], data: [data.path, data.endpoint ?? null, data.region ?? null, data.urlStyle ?? null, data.useSsl ?? null], access };
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
  if (mode.kind === "lake-readers" && mode.lake.access !== "read") {
    throw new CroftError("INTERNAL_ERROR", { message: "a lake behind croft serve is attached read-only", hint: "report this croft bug" });
  }
  return verifyExtensions(mode.extensionDir, MODE_EXTENSIONS[mode.kind]);
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
  // folder's mode as it was, so set it.
  mkdirSync(mode.secretDir, { recursive: true, mode: 0o700 });
  chmodSync(mode.secretDir, 0o700);
  await conn.run(`SET secret_directory = ${q(mode.secretDir)}`);
  // 4. What the mode attaches.
  if (mode.kind === "readers") {
    await attempt(conn, `ATTACH ${q(mode.copy)} AS ${READ_COPY_ALIAS} (READ_ONLY)`, (e) => new CroftError("INTERNAL_ERROR", {
      message: `the readers' process could not attach the read copy ${mode.copy}`,
      hint: "report this croft bug",
      details: { duckdb: firstLine(e) },
    }));
  } else if (mode.kind === "lake-test") {
    const { catalog, dataPath, access } = mode.lake;
    await attempt(conn, `ATTACH ${q(`ducklake:sqlite:${catalog.path}`)} AS ${LAKE_ALIAS} (DATA_PATH ${q(dataPath)}${access === "read" ? ", READ_ONLY" : ""})`, (e) => lakeFailure(e, secrets));
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
  const fail = (e: unknown) => lakeFailure(e, secrets);
  await attempt(conn, `CREATE OR REPLACE TEMPORARY SECRET ${LAKE_CATALOG_SECRET} (TYPE postgres, HOST ${q(catalog.host)}, PORT ${Math.trunc(catalog.port)}, DATABASE ${q(catalog.database)}, USER ${q(catalog.user)}, PASSWORD ${q(catalog.password)})`, fail);
  const opts = [
    "TYPE s3", `KEY_ID ${q(data.keyId)}`, `SECRET ${q(data.secretKey)}`, `SCOPE ${q(data.path)}`,
    ...(data.sessionToken ? [`SESSION_TOKEN ${q(data.sessionToken)}`] : []),
    ...(data.endpoint ? [`ENDPOINT ${q(data.endpoint)}`] : []),
    ...(data.region ? [`REGION ${q(data.region)}`] : []),
    `URL_STYLE ${q(data.urlStyle ?? "path")}`,
    `USE_SSL ${data.useSsl === false ? "false" : "true"}`,
  ];
  await attempt(conn, `CREATE OR REPLACE TEMPORARY SECRET ${LAKE_BUCKET_SECRET} (${opts.join(", ")})`, fail);
  await attempt(conn, `ATTACH 'ducklake:postgres:' AS ${LAKE_ALIAS} (DATA_PATH ${q(data.path)}, META_SECRET ${LAKE_CATALOG_SECRET}${access === "read" ? ", READ_ONLY" : ""})`, fail);
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
export async function startQuackListener(conn: DuckDBConnection, uri: string, o: { token?: string; allowOtherHostname?: boolean; disableSsl?: boolean } | string = {}): Promise<string> {
  const opts = typeof o === "string" ? { token: o } : o;
  const t = opts.token ?? `unused-${crypto.randomUUID()}`;
  // Quack accepts only localhost as its host unless told otherwise [V: 2.0.0]; croft says so for anything else (D125).
  // Past localhost Quack serves TLS with a certificate of its own [V: 2.0.0: a client got "Unsupported protocol" over plain HTTP];
  // croft's design is a reverse proxy that holds the real certificate and speaks plain HTTP to Quack, as for its HTTP API (D125).
  const other = `${opts.allowOtherHostname ? ", allow_other_hostname = true" : ""}${opts.disableSsl ? ", disable_ssl = true" : ""}`;
  const reader = await conn.runAndReadAll(`SELECT listen_uri FROM quack_serve(${q(uri)}, token = ${q(t)}, create_secret_if_not_exists = false${other})`);
  // The address actually bound: a port of 0 is replaced by the one the system picked.
  return String(reader.getRowsJS()[0]?.[0] ?? uri);
}
