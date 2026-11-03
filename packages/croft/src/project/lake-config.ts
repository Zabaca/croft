// croft.json's `lake` block (DESIGN.md D138; option 07, slice 2): where a project keeps its warehouse when it is a DuckLake instead of
// one DuckDB file. Hand-validated like every setting (root.ts), so each message names the key, what was expected and what was found.
//
// Two shapes, one per catalog:
// - a shared lake: a Postgres catalog and an S3-compatible bucket. Two logins for the catalog (the writer's, and a read-only one that
//   everything that only reads uses) and two keys for the bucket, each by the NAME of the project's secret that holds it (.env, the
//   shell or secretsFrom), never the value; and a folder in the bucket that holds nothing but this lake, because DuckLake's own cleanup
//   deletes files it does not recognise there;
// - a local lake: a SQLite catalog file and a local data folder, for croft's own suite and for local development on one machine.
//
// Nothing here reads a secret or touches the disk except the location check (lakeLocationIssues), which resolves paths without
// opening them.
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { Fix } from "../core/types.ts";
import { joinPath } from "./json-locate.ts";

/** A catalog login: the user, and the name of the secret that holds its password. */
export interface LakeLogin { user: string; passwordSecret: string }
/** A bucket key: the names of the secrets that hold its id and its secret (and a session token, when the key is temporary). */
export interface LakeKey { keyIdSecret: string; secretKeySecret: string; sessionTokenSecret?: string }

export interface LakeBucketConfig {
  name: string;
  /** The folder of the bucket that holds this lake and nothing else, with a trailing slash. */
  folder: string;
  /** `host[:port]` of the S3-compatible store; absent for AWS. */
  endpoint?: string;
  region?: string;
  urlStyle: "path" | "vhost";
  useSsl: boolean;
  /** A PEM file of the certificate authorities the store's certificate is signed by, as written (relative to the project folder, or `~/`);
   *  absent: this machine's CA bundle. Only with `useSsl`. */
  sslRootCert?: string;
  writer: LakeKey;
  reader: LakeKey;
}

/**
 * When croft runs the lake's maintenance by itself (D150; option 07, slice 3): after a run, and from the scheduler, once the last
 * pass is `everyHours` old. What a pass keeps is not a setting: it is the trash's promise, 30 days or 5 versions per asset (§6).
 */
export interface LakeMaintenanceConfig { enabled: boolean; everyHours: number }
export const DEFAULT_MAINTENANCE: LakeMaintenanceConfig = { enabled: true, everyHours: 24 };

/** How the catalog connection uses TLS (libpq's sslmode): `verify-full` checks the server's certificate and host name, `require`
 *  encrypts and does not check the host name, `prefer` encrypts when the server offers it (libpq's own default), `disable` never does (D159). */
export type CatalogSslMode = "verify-full" | "require" | "prefer" | "disable";
export const SSL_MODES: readonly CatalogSslMode[] = ["verify-full", "require", "prefer", "disable"];

/** A shared lake: a Postgres catalog and a bucket. `sslMode` is always set: what the project wrote, else the default for its host
 *  (isLoopbackHost). `sslRootCert` is as written (relative to the project folder, or absolute), present only with `verify-full`. */
export interface SharedLakeConfig {
  kind: "postgres";
  /** `lake.enabled` (default true). False: the block names a lake the project is not in (yet): the warehouse is still the file, and
   *  `croft move-to-lake` moves it into this lake (D155). */
  enabled: boolean;
  catalog: { host: string; port: number; database: string; sslMode: CatalogSslMode; sslRootCert?: string; writer: LakeLogin; reader: LakeLogin };
  bucket: LakeBucketConfig;
  maintenance: LakeMaintenanceConfig;
}
/** A local lake: a SQLite catalog file and a data folder, both as written (relative to the project folder, or absolute). */
export interface LocalLakeConfig {
  kind: "local";
  enabled: boolean;
  catalog: { path: string };
  dataPath: string;
  maintenance: LakeMaintenanceConfig;
}
export type LakeConfig = SharedLakeConfig | LocalLakeConfig;

/** The checks croft.json's validator hands this module: its own closures, so a message here reads like every other. */
export interface LakeChecks {
  add(path: string, message: string, hint: string, fix?: Fix): void;
  unknownKeys(obj: Record<string, unknown>, known: string[], parent: string): void;
  str(obj: Record<string, unknown>, path: string, key: string, fallback: string): string;
  bool(obj: Record<string, unknown>, path: string, key: string, fallback: boolean): boolean;
  int(obj: Record<string, unknown>, path: string, key: string, fallback: number, min: number, max: number): number;
  show(v: unknown): string;
  /** How many issues have been added so far, by anyone: a lake is whole only if this did not grow while it was read. */
  count(): number;
}

export const LAKE_KEYS = ["enabled", "catalog", "bucket", "dataPath", "maintenance"];
const MAINTENANCE_KEYS = ["enabled", "everyHours"];
const CATALOG_KEYS = ["kind", "host", "port", "database", "sslMode", "sslRootCert", "writer", "reader", "path"];
const LOGIN_KEYS = ["user", "passwordSecret"];
const BUCKET_KEYS = ["name", "folder", "endpoint", "region", "urlStyle", "useSsl", "sslRootCert", "writer", "reader"];
const KEY_KEYS = ["keyIdSecret", "secretKeySecret", "sessionTokenSecret"];

/** The name of an environment variable, which is what a secret is. */
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])$/;
const DATABASE = /^[A-Za-z_][A-Za-z0-9_$-]*$/;
const LOGIN_NAME = /^[A-Za-z_][A-Za-z0-9_$.-]*$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const FOLDER_SEGMENT = /^[A-Za-z0-9._-]+$/;
const ENDPOINT = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;
const REGION = /^[A-Za-z0-9-]{1,30}$/;

/** A catalog on this machine: nothing crosses a network, so TLS is not what keeps its password from anyone (D159). `127.x.x.x` is
 *  four octets, each 0 to 255: anything else is a name to look up, and a name is not known to be this machine. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === "localhost") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Validate the `lake` value of croft.json. `raw` is it as parsed (undefined: no lake, the file as ever). Every problem is added
 * through `c`; the result is the lake when it is whole, else null (the caller fails the config on the issues anyway).
 */
export function validateLake(raw: unknown, c: LakeChecks): LakeConfig | null {
  if (raw === undefined) return null;
  const { add, show } = c;
  if (!isObject(raw)) {
    add("lake", `"lake" must be an object; found ${show(raw)}`, `write "lake" as {"catalog": {…}, "bucket": {…}} (croft docs lake lists its keys)`);
    return null;
  }
  c.unknownKeys(raw, LAKE_KEYS, "lake");
  const before = issueCount(c);
  const cat = raw.catalog;
  if (cat === undefined) {
    add("lake.catalog", `"lake" needs "catalog": where the lake keeps its table list`,
      `add "catalog": {"kind": "postgres", "host": …, "database": …, …} for a shared lake, or {"kind": "sqlite", "path": "lake/catalog.sqlite"} for a local one`);
    return null;
  }
  if (!isObject(cat)) {
    add("lake.catalog", `"lake.catalog" must be an object; found ${show(cat)}`, `write it as {"kind": "postgres", …} or {"kind": "sqlite", "path": …}`);
    return null;
  }
  c.unknownKeys(cat, CATALOG_KEYS, "lake.catalog");
  const kind = cat.kind;
  if (kind !== "postgres" && kind !== "sqlite") {
    add("lake.catalog.kind", `"lake.catalog.kind" must be "postgres" (a shared lake) or "sqlite" (a local one); found ${show(kind)}`,
      kind === undefined ? `add "kind": "postgres"` : `set "lake.catalog.kind" to "postgres" or "sqlite"`);
    return null;
  }
  if (kind === "sqlite" && process.env.CROFT_TEST_HARNESS !== "1") {
    // A lake on one machine goes past what option 07 settled for slice 2: its gate is the only wall (no key stands between SQL and the
    // folder), and the sqlite extension ships in no add-on. It is for croft's own tests, switched on as the log adapter is (D137).
    add("lake.catalog.kind", `"lake.catalog.kind": "sqlite" (a lake on one machine) is for croft's own tests, and is not offered yet`,
      `use a Postgres catalog: "kind": "postgres" with a bucket (croft docs lake)`);
    return null;
  }
  const maintenance = maintenanceConfig(raw.maintenance, c);
  const enabled = c.bool(raw, "lake.enabled", "enabled", true);
  const result = kind === "postgres" ? sharedLake(raw, cat, c, maintenance, enabled) : localLake(raw, cat, c, maintenance, enabled);
  return issueCount(c) > before ? null : result;
}

function maintenanceConfig(raw: unknown, c: LakeChecks): LakeMaintenanceConfig {
  if (raw === undefined) return { ...DEFAULT_MAINTENANCE };
  if (!isObject(raw)) {
    c.add("lake.maintenance", `"lake.maintenance" must be an object like {"enabled": true, "everyHours": 24}; found ${c.show(raw)}`, `write it as {"enabled": …, "everyHours": …}, or leave it out`);
    return { ...DEFAULT_MAINTENANCE };
  }
  c.unknownKeys(raw, MAINTENANCE_KEYS, "lake.maintenance");
  return {
    enabled: c.bool(raw, "lake.maintenance.enabled", "enabled", DEFAULT_MAINTENANCE.enabled),
    everyHours: c.int(raw, "lake.maintenance.everyHours", "everyHours", DEFAULT_MAINTENANCE.everyHours, 1, 24 * 30),
  };
}

const issueCount = (c: LakeChecks): number => c.count();

function secretName(c: LakeChecks, obj: Record<string, unknown>, path: string, key: string, optional = false): string | undefined {
  const v = obj[key];
  if (v === undefined) {
    if (!optional) c.add(path, `"${path}" is required: the name of the secret (in .env or the shell) that holds it`, `add "${key}": "<NAME>", then put <NAME>=… in .env`);
    return undefined;
  }
  if (typeof v === "string" && SECRET_NAME.test(v)) return v;
  c.add(path, `"${path}" must be the NAME of a secret (letters, digits and underscores, not starting with a digit), never its value; found ${c.show(v)}`,
    `put the value in .env under a name such as LAKE_${key.replace(/Secret$/, "").replace(/([A-Z])/g, "_$1").toUpperCase()}, and give that name here`);
  return undefined;
}

function login(c: LakeChecks, parent: Record<string, unknown>, path: string, role: string): LakeLogin | null {
  const raw = parent[role];
  const p = joinPath(path, role);
  if (raw === undefined) {
    c.add(p, `"${p}" is required: the ${role === "writer" ? "login croft writes with" : "read-only login every command that only reads uses, and croft serve"}`,
      `add "${role}": {"user": "…", "passwordSecret": "…"}`);
    return null;
  }
  if (!isObject(raw)) {
    c.add(p, `"${p}" must be an object like {"user": "croft_${role}", "passwordSecret": "LAKE_${role.toUpperCase()}_PASSWORD"}; found ${c.show(raw)}`, `write it as {"user": …, "passwordSecret": …}`);
    return null;
  }
  c.unknownKeys(raw, LOGIN_KEYS, p);
  const user = raw.user;
  let okUser: string | undefined;
  if (user === undefined) c.add(joinPath(p, "user"), `"${joinPath(p, "user")}" is required: the Postgres login`, `add "user": "croft_${role}"`);
  else if (typeof user === "string" && LOGIN_NAME.test(user)) okUser = user;
  else c.add(joinPath(p, "user"), `"${joinPath(p, "user")}" must be a Postgres login name; found ${c.show(user)}`, `use letters, digits and underscores, e.g. "croft_${role}"`);
  const pw = secretName(c, raw, joinPath(p, "passwordSecret"), "passwordSecret");
  return okUser && pw ? { user: okUser, passwordSecret: pw } : null;
}

function bucketKey(c: LakeChecks, parent: Record<string, unknown>, path: string, role: string): LakeKey | null {
  const raw = parent[role];
  const p = joinPath(path, role);
  if (raw === undefined) {
    c.add(p, `"${p}" is required: the bucket key ${role === "writer" ? "croft writes with" : "that can only read, which every command that only reads uses, and croft serve"}`,
      `add "${role}": {"keyIdSecret": "…", "secretKeySecret": "…"}`);
    return null;
  }
  if (!isObject(raw)) {
    c.add(p, `"${p}" must be an object like {"keyIdSecret": "LAKE_${role.toUpperCase()}_KEY_ID", "secretKeySecret": "LAKE_${role.toUpperCase()}_KEY"}; found ${c.show(raw)}`,
      `write it as {"keyIdSecret": …, "secretKeySecret": …}`);
    return null;
  }
  c.unknownKeys(raw, KEY_KEYS, p);
  const id = secretName(c, raw, joinPath(p, "keyIdSecret"), "keyIdSecret");
  const key = secretName(c, raw, joinPath(p, "secretKeySecret"), "secretKeySecret");
  const token = secretName(c, raw, joinPath(p, "sessionTokenSecret"), "sessionTokenSecret", true);
  return id && key ? { keyIdSecret: id, secretKeySecret: key, ...(token ? { sessionTokenSecret: token } : {}) } : null;
}

function sharedLake(raw: Record<string, unknown>, cat: Record<string, unknown>, c: LakeChecks, maintenance: LakeMaintenanceConfig, enabled: boolean): SharedLakeConfig | null {
  const { add, show } = c;
  if (cat.path !== undefined) add("lake.catalog.path", `"lake.catalog.path" is for a SQLite catalog; a Postgres catalog is found by "host" and "database"`, `remove "path", or set "kind" to "sqlite"`);
  if (raw.dataPath !== undefined) add("lake.dataPath", `"lake.dataPath" is for a local lake; a Postgres catalog keeps its files in a bucket`, `remove "dataPath" and describe the bucket in "lake.bucket"`);
  let host = "";
  if (cat.host === undefined) add("lake.catalog.host", `"lake.catalog.host" is required: the Postgres server's address`, `add "host": "db.example.com"`);
  else if (typeof cat.host !== "string" || !HOST.test(cat.host.trim())) {
    add("lake.catalog.host", `"lake.catalog.host" must be a host name or address like "db.example.com" or "127.0.0.1" (no scheme, no port, no spaces); found ${show(cat.host)}`,
      `give the host alone, and the port in "lake.catalog.port"`);
  } else host = cat.host.trim();
  const port = c.int(cat, "lake.catalog.port", "port", 5432, 1, 65535);
  let database = "";
  if (cat.database === undefined) add("lake.catalog.database", `"lake.catalog.database" is required: the Postgres database that holds the lake's catalog and nothing else`, `add "database": "croft_lake"`);
  else if (typeof cat.database !== "string" || !DATABASE.test(cat.database)) {
    add("lake.catalog.database", `"lake.catalog.database" must be a Postgres database name (letters, digits and underscores); found ${show(cat.database)}`, `use a name like "croft_lake"`);
  } else database = cat.database;
  const tls = validateCatalogTls(cat, host, c);
  const writer = login(c, cat, "lake.catalog", "writer");
  const reader = login(c, cat, "lake.catalog", "reader");
  if (writer && reader) {
    if (writer.user === reader.user) {
      add("lake.catalog.reader.user", `"lake.catalog.reader.user" is the writer's login ("${writer.user}"); a reader with the writer's login could write`,
        `make a login that can only read the catalog (GRANT SELECT only), and give its name here (croft docs lake)`);
    }
    if (writer.passwordSecret === reader.passwordSecret) {
      add("lake.catalog.reader.passwordSecret", `"lake.catalog.reader.passwordSecret" names the same secret as the writer's (${writer.passwordSecret}); the two logins have separate passwords`,
        `give each login its own secret`);
    }
  }
  const bucket = bucketConfig(raw.bucket, c);
  return host && database && writer && reader && bucket && tls
    ? { kind: "postgres", enabled, catalog: { host, port, database, sslMode: tls.sslMode, ...(tls.sslRootCert ? { sslRootCert: tls.sslRootCert } : {}), writer, reader }, bucket, maintenance } : null;
}

/** `sslMode` and `sslRootCert` (D159). Without `sslMode` a catalog on this machine keeps libpq's `prefer` (what croft did before the
 *  setting existed) and any other host is `verify-full`: the password and every catalog row cross a network, and an unchecked
 *  certificate lets whoever is in the path read them. The root certificate file is not opened here (db/catalog-tls.ts does, at attach). */
function validateCatalogTls(cat: Record<string, unknown>, host: string, c: LakeChecks): { sslMode: CatalogSslMode; sslRootCert?: string } | null {
  const { add, show } = c;
  let sslMode: CatalogSslMode | undefined;
  let bad = false;
  if (cat.sslMode !== undefined) {
    if (typeof cat.sslMode === "string" && (SSL_MODES as readonly string[]).includes(cat.sslMode)) sslMode = cat.sslMode as CatalogSslMode;
    else {
      bad = true;
      add("lake.catalog.sslMode", `"lake.catalog.sslMode" must be ${SSL_MODES.map((m) => `"${m}"`).join(", ")}; found ${show(cat.sslMode)}`,
        `use "verify-full" for a catalog on another machine (it checks the server's certificate and host name)`);
    }
  }
  const effective = sslMode ?? (isLoopbackHost(host) ? "prefer" : "verify-full");
  let sslRootCert: string | undefined;
  if (cat.sslRootCert !== undefined) {
    if (typeof cat.sslRootCert !== "string" || cat.sslRootCert.trim() === "") {
      bad = true;
      add("lake.catalog.sslRootCert", `"lake.catalog.sslRootCert" must be the path of a PEM file of certificate authorities; found ${show(cat.sslRootCert)}`,
        `give a path such as "certs/neon-root.pem", or leave it out to use this machine's CA bundle`);
    } else if (!bad && effective !== "verify-full") {
      bad = true;
      add("lake.catalog.sslRootCert", `"lake.catalog.sslRootCert" is used only by "sslMode": "verify-full"; this catalog's sslMode is "${effective}"${sslMode ? "" : " (the default for a catalog on this machine)"}`,
        `set "lake.catalog.sslMode" to "verify-full", or remove "sslRootCert"`);
    } else sslRootCert = cat.sslRootCert;
  }
  return bad ? null : { sslMode: effective, ...(sslRootCert ? { sslRootCert } : {}) };
}

function bucketConfig(raw: unknown, c: LakeChecks): LakeBucketConfig | null {
  const { add, show } = c;
  if (raw === undefined) {
    add("lake.bucket", `a lake with a Postgres catalog needs "bucket": where its Parquet files live`, `add "bucket": {"name": "my-bucket", "folder": "croft/orders/", "writer": {…}, "reader": {…}}`);
    return null;
  }
  if (!isObject(raw)) {
    add("lake.bucket", `"lake.bucket" must be an object; found ${show(raw)}`, `write it as {"name": …, "folder": …, "writer": {…}, "reader": {…}}`);
    return null;
  }
  c.unknownKeys(raw, BUCKET_KEYS, "lake.bucket");
  let name = "";
  if (raw.name === undefined) add("lake.bucket.name", `"lake.bucket.name" is required: the bucket`, `add "name": "my-bucket"`);
  else if (typeof raw.name !== "string" || !BUCKET.test(raw.name)) {
    add("lake.bucket.name", `"lake.bucket.name" must be a bucket name (3 to 63 lower-case letters, digits, dots and hyphens); found ${show(raw.name)}`, `give the bucket's name alone, without s3:// or a folder`);
  } else name = raw.name;
  let folder = "";
  if (raw.folder === undefined) {
    add("lake.bucket.folder", `"lake.bucket.folder" is required: a folder of the bucket that holds nothing but this lake (DuckLake's cleanup deletes files in it that it does not recognise)`,
      `add "folder": "croft/<project>/"`);
  } else if (typeof raw.folder !== "string") {
    add("lake.bucket.folder", `"lake.bucket.folder" must be a folder path like "croft/orders/"; found ${show(raw.folder)}`, `give a folder inside the bucket`);
  } else {
    // Trailing slashes are the folder's own ("trial-1", "trial-1/" and "trial-1//" are one folder: `s3://bucket/trial-1/`, never `trial-1//`,
    // which names another place); an empty part inside it is not (D163).
    const parts = raw.folder.replace(/\/+$/, "").split("/");
    if (!parts.length || parts.some((s) => !FOLDER_SEGMENT.test(s) || s === "." || s === "..")) {
      add("lake.bucket.folder", `"lake.bucket.folder" must be a folder inside the bucket, like "croft/orders/" (not the bucket's top, no leading slash, no ".." and no empty parts); found ${show(raw.folder)}`,
        `name a folder that holds only this lake`);
    } else folder = `${parts.join("/")}/`;
  }
  let endpoint: string | undefined;
  if (raw.endpoint !== undefined) {
    if (typeof raw.endpoint !== "string" || !ENDPOINT.test(raw.endpoint)) {
      const hint = typeof raw.endpoint === "string" && /^[a-z]+:\/\//i.test(raw.endpoint)
        ? `give the host[:port] alone (${raw.endpoint.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "")}), and set "useSsl" to ${raw.endpoint.startsWith("http://") ? "false" : "true"}`
        : `give host[:port], like "abc123.r2.cloudflarestorage.com" or "127.0.0.1:9000", or leave it out for AWS`;
      add("lake.bucket.endpoint", `"lake.bucket.endpoint" must be host[:port] of the S3-compatible store, without a scheme or a path; found ${show(raw.endpoint)}`, hint);
    } else endpoint = raw.endpoint;
  }
  let region: string | undefined;
  if (raw.region !== undefined) {
    if (typeof raw.region !== "string" || !REGION.test(raw.region)) add("lake.bucket.region", `"lake.bucket.region" must be a region name like "us-east-1" or "auto"; found ${show(raw.region)}`, `use the store's region name`);
    else region = raw.region;
  }
  let urlStyle: "path" | "vhost" = "path";
  if (raw.urlStyle !== undefined) {
    if (raw.urlStyle === "path" || raw.urlStyle === "vhost") urlStyle = raw.urlStyle;
    else add("lake.bucket.urlStyle", `"lake.bucket.urlStyle" must be "path" or "vhost"; found ${show(raw.urlStyle)}`, `use "path" unless the store needs "vhost"`);
  }
  const useSsl = c.bool(raw, "lake.bucket.useSsl", "useSsl", true);
  let sslRootCert: string | undefined;
  if (raw.sslRootCert !== undefined) {
    if (typeof raw.sslRootCert !== "string" || raw.sslRootCert.trim() === "") {
      add("lake.bucket.sslRootCert", `"lake.bucket.sslRootCert" must be the path of a PEM file of certificate authorities; found ${show(raw.sslRootCert)}`,
        `use a path such as "certs/store-ca.pem" (relative to the project folder), or remove the setting to use this machine's CA bundle`);
    } else if (!useSsl) {
      add("lake.bucket.sslRootCert", `"lake.bucket.sslRootCert" names the authorities the store's certificate is checked against, and "lake.bucket.useSsl" is false: nothing is checked`,
        `remove "sslRootCert", or set "useSsl" to true`);
    } else sslRootCert = raw.sslRootCert.trim();
  }
  const writer = bucketKey(c, raw, "lake.bucket", "writer");
  const reader = bucketKey(c, raw, "lake.bucket", "reader");
  if (writer && reader) {
    if (writer.keyIdSecret === reader.keyIdSecret || writer.secretKeySecret === reader.secretKeySecret) {
      add("lake.bucket.reader", `"lake.bucket.reader" names a secret the writer's key uses; the two keys are separate, and the reader's can only read`,
        `make a key that can only read the lake's folder, and give each key its own secrets (croft docs lake)`);
    }
  }
  return name && folder && writer && reader ? { name, folder, ...(endpoint ? { endpoint } : {}), ...(region ? { region } : {}), urlStyle, useSsl, ...(sslRootCert ? { sslRootCert } : {}), writer, reader } : null;
}

function localLake(raw: Record<string, unknown>, cat: Record<string, unknown>, c: LakeChecks, maintenance: LakeMaintenanceConfig, enabled: boolean): LocalLakeConfig | null {
  const { add, show } = c;
  for (const k of ["host", "port", "database", "sslMode", "sslRootCert", "writer", "reader"]) {
    if (cat[k] !== undefined) add(joinPath("lake.catalog", k), `"lake.catalog.${k}" is for a Postgres catalog; a SQLite catalog is one file, "path"`, `remove "${k}", or set "kind" to "postgres"`);
  }
  if (raw.bucket !== undefined) add("lake.bucket", `"lake.bucket" is for a lake with a Postgres catalog; a local lake keeps its files in "dataPath"`, `remove "bucket", or set the catalog's "kind" to "postgres"`);
  let path = "";
  if (cat.path === undefined) add("lake.catalog.path", `"lake.catalog.path" is required: the SQLite catalog file`, `add "path": "lake/catalog.sqlite"`);
  else if (typeof cat.path !== "string" || cat.path.trim() === "") add("lake.catalog.path", `"lake.catalog.path" must be a file path; found ${show(cat.path)}`, `use a path such as "lake/catalog.sqlite"`);
  else path = cat.path;
  let dataPath = "";
  if (raw.dataPath === undefined) add("lake.dataPath", `a local lake needs "dataPath": the folder that holds its Parquet files and nothing else`, `add "dataPath": "lake/data"`);
  else if (typeof raw.dataPath !== "string" || raw.dataPath.trim() === "") add("lake.dataPath", `"lake.dataPath" must be a folder path; found ${show(raw.dataPath)}`, `use a path such as "lake/data"`);
  else dataPath = raw.dataPath;
  return path && dataPath ? { kind: "local", enabled, catalog: { path }, dataPath, maintenance } : null;
}

// ---- Where a local lake's files may be ----------------------------------------------------------------------

export interface LakePlace {
  root: string;
  home: string;
  /** Resolved without opening anything (root.ts physicalPath). */
  real: (p: string) => string;
  filesDir: string;
  assetsDir: string;
  libDir: string;
  stateDir: string;
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** The paths of a local lake as the project folder resolves them. */
export function localLakePaths(lake: LocalLakeConfig, root: string, home = homedir()): { catalog: string; data: string } {
  const at = (p: string) => resolve(root, p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p);
  return { catalog: at(lake.catalog.path), data: at(lake.dataPath) };
}

/**
 * A local lake's folder and catalog are SQL's to reach (the data folder goes into allowed_directories), so neither may be or hold the
 * project folder, the home folder, files/, assets/, lib/ or the state folder; the catalog may not sit inside the data folder.
 */
export function lakeLocationIssues(lake: LakeConfig, place: LakePlace): { path: string; message: string; hint: string }[] {
  if (lake.kind !== "local") return [];
  const { catalog, data } = localLakePaths(lake, place.root, place.home);
  const rc = place.real(catalog);
  const rd = place.real(data);
  const out: { path: string; message: string; hint: string }[] = [];
  const keep = [["the project folder", place.real(place.root)], ["your home folder", place.real(place.home)], ["files/", place.real(place.filesDir)], ["assets/", place.real(place.assetsDir)],
    ["lib/", place.real(place.libDir)], ["the state folder", place.real(place.stateDir)]] as const;
  for (const [what, dir] of keep) {
    if (rd === dir || inside(dir, rd)) {
      out.push({ path: "lake.dataPath", message: `"lake.dataPath" is or holds ${what}; SQL could then read files that are not the lake's`, hint: `name a folder of its own, such as "lake/data"` });
      break;
    }
  }
  for (const [what, dir] of keep.slice(2)) {
    if (inside(rd, dir) || inside(rc, dir)) {
      out.push({ path: inside(rd, dir) ? "lake.dataPath" : "lake.catalog.path", message: `a local lake's files are inside ${what}, which croft reads or keeps for itself`, hint: `put the lake in a folder of its own, such as "lake/"` });
      break;
    }
  }
  if (inside(rc, rd)) out.push({ path: "lake.catalog.path", message: `"lake.catalog.path" is inside "lake.dataPath"; the catalog and the data files are separate, so SQL over the data folder never reaches the catalog`, hint: `keep the catalog beside the data folder, not in it` });
  if (dirname(rc) === rc || rc === rd) out.push({ path: "lake.catalog.path", message: `"lake.catalog.path" must be a file`, hint: `use a path such as "lake/catalog.sqlite"` });
  return out;
}

// ---- What the rest of croft asks of a lake ----------------------------------------------------------------------

/** The names of every secret the lake uses, writer and reader. */
export function lakeSecretNames(lake: LakeConfig): string[] {
  if (lake.kind !== "postgres") return [];
  const keys = (k: LakeKey) => [k.keyIdSecret, k.secretKeySecret, ...(k.sessionTokenSecret ? [k.sessionTokenSecret] : [])];
  return [lake.catalog.writer.passwordSecret, lake.catalog.reader.passwordSecret, ...keys(lake.bucket.writer), ...keys(lake.bucket.reader)];
}

/** `s3://<bucket>/<folder>/`: the one remote path SQL may name. */
export function bucketPath(b: LakeBucketConfig): string {
  return `s3://${b.name}/${b.folder}`;
}

/** The warehouse as the envelope names it (`database`): where the lake is, with no credential. */
export function lakeLabel(lake: LakeConfig, root: string, home = homedir()): string {
  if (lake.kind === "postgres") return `lake ${bucketPath(lake.bucket)} (catalog ${lake.catalog.host}:${lake.catalog.port}/${lake.catalog.database})`;
  const { catalog } = localLakePaths(lake, root, home);
  const rel = catalog.startsWith(root + sep) ? catalog.slice(root.length + 1) : catalog;
  return `lake ${rel}`;
}
