// The one connection factory (DESIGN.md §5 "One connection factory", "Sandboxing every DuckDB instance").
// Every DuckDB instance croft opens comes from here: the warehouse, preview.duckdb, a TS transform's
// private in-memory database and @zabaca/croft/read. It uses no Bun-only APIs, so read.ts can import it.
//
// Verified against DuckDB 1.5.5 (see db/connect.test.ts):
// - lock_configuration is instance-global and, once set, refuses every later SET, including a
//   per-session `SET TimeZone`. So the project zone is set with `SET GLOBAL TimeZone` *before* locking,
//   and every later connection inherits it.
// - TimeZone and allowed_directories cannot be instance options ("not recognized" / "Failed to set config").
// - fromCache shares one instance across realpath, `..` and case variants of a path and refuses a
//   different config for a cached path; ":memory:" is never shared.
// - A closed and reopened instance comes back unconfigured, so configuration is checked per connection.
import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { physicalPath } from "../project/root.ts";
import { basename, dirname, join, resolve } from "node:path";
import { CroftError } from "../core/errors.ts";

export type Profile = "warehouse" | "query" | "serve" | "memory";
export type AccessMode = "read_only" | "read_write";

export interface SandboxSpec {
  profile: Profile;
  timezone: string;         // croft.json timezone, e.g. "America/Los_Angeles"
  root?: string;            // project root; <root>/files is allowed for "warehouse" and "query"
  stateDir?: string;        // the state folder (.croft or relocated); allowed for "warehouse" and "memory"
  fileDirs?: string[];      // directories of declared file ingests ("warehouse" only)
  memoryLimit?: string;     // e.g. "4GB"; set before locking (serve)
  threads?: number;
}

/** Instance options every croft instance uses. Only access_mode varies, and only between processes. */
export const FIXED_CONFIG: Readonly<Record<string, string>> = Object.freeze({
  autoinstall_known_extensions: "false",
  autoload_known_extensions: "false",
  allow_community_extensions: "false",
});

export function instanceConfig(mode: AccessMode): Record<string, string> {
  return { ...FIXED_CONFIG, access_mode: mode === "read_only" ? "READ_ONLY" : "READ_WRITE" };
}

/**
 * Canonical path for a file that may not exist yet, found WITHOUT opening the file. Bun's realpath opens
 * its argument (open + F_GETPATH on macOS), and closing that descriptor releases this process's DuckDB
 * lock on the warehouse (DESIGN.md §5, hazard 3). So symlinks are resolved with lstat/readlink
 * (physicalPath), only the parent DIRECTORY goes through the native realpath (a directory descriptor holds
 * no lock on the file), and the final component's on-disk spelling comes from readdir, so case variants on
 * a case-insensitive file system (APFS) still map to one key, as they do in DuckDB's instance cache.
 */
export function canonicalPath(path: string): string {
  const { path: phys, exists } = physicalPath(resolve(path));
  const parent = dirname(phys);
  if (parent === phys) return phys;
  const base = basename(phys);
  const realParent = isDirectory(parent) ? realpathSync.native(parent) : canonicalPath(parent);
  if (!exists) return join(realParent, base);
  return join(realParent, onDiskName(realParent, base));
}

function isDirectory(p: string): boolean {
  try { return lstatSync(p).isDirectory(); } catch { return false; }
}

/** The directory entry's own spelling of `name` (exact match first, then case- and normalization-insensitive). */
function onDiskName(dir: string, name: string): string {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return name; }
  if (entries.includes(name)) return name;
  const key = (s: string) => s.normalize("NFC").toLowerCase();
  return entries.find((e) => key(e) === key(name)) ?? name;
}

/** The directories a profile may touch. DuckDB adds the database's own `<db>.tmp/` spill dir itself. */
export function allowedDirectories(spec: SandboxSpec): string[] {
  const need = (v: string | undefined, what: string): string => {
    if (!v) throw new CroftError("INTERNAL_ERROR", { message: `profile ${spec.profile} needs ${what}`, hint: "report this croft bug" });
    return v;
  };
  let dirs: string[];
  switch (spec.profile) {
    case "warehouse":
      dirs = [join(need(spec.root, "root"), "files"), need(spec.stateDir, "stateDir"), ...(spec.fileDirs ?? [])];
      break;
    case "query":
      dirs = [join(need(spec.root, "root"), "files")];
      break;
    case "serve":
      dirs = [];
      break;
    case "memory":
      // A TS transform streams its Parquet input snapshots from <state>/staging.
      dirs = spec.stateDir ? [spec.stateDir] : [];
      break;
  }
  return [...new Set(dirs.map(canonicalPath))];
}

const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;

// Which access mode each canonical path was first opened with in this process. A cached path cannot be
// reopened with another configuration, and mixing modes would hide bugs until a lock conflict.
const modeByPath = new Map<string, AccessMode>();

/**
 * Open (or reuse) the instance for a database file. The one place croft calls DuckDBInstance.fromCache.
 * Lock conflicts surface as DuckDB's IO Error; db/warehouse.ts retries them.
 */
export async function openInstance(path: string, mode: AccessMode): Promise<{ instance: DuckDBInstance; path: string }> {
  const real = canonicalPath(path);
  const prior = modeByPath.get(real);
  if (prior && prior !== mode) {
    throw new CroftError("INTERNAL_ERROR", {
      message: `${real} was opened ${prior} earlier in this process; a process uses one access mode for its whole life`,
      hint: "report this croft bug",
    });
  }
  const instance = await DuckDBInstance.fromCache(real, instanceConfig(mode));
  modeByPath.set(real, mode);
  return { instance, path: real };
}

/** A private in-memory database (TS transforms). ":memory:" is never shared by the instance cache. */
export async function openMemory(spec: Omit<SandboxSpec, "profile">): Promise<{ instance: DuckDBInstance; connect(): Promise<DuckDBConnection>; close(): void }> {
  const instance = await DuckDBInstance.fromCache(":memory:", instanceConfig("read_write"));
  const key = `:memory:${++memorySeq}`;
  const full: SandboxSpec = { ...spec, profile: "memory" };
  const open = new Set<DuckDBConnection>();
  return {
    instance,
    async connect() {
      const conn = await connect(instance, full, key);
      open.add(conn);
      return conn;
    },
    close() {
      for (const c of open) c.disconnectSync();
      open.clear();
      instance.closeSync();
      configured.delete(key);
    },
  };
}
let memorySeq = 0;

// Fingerprint of the sandbox applied to each instance (by canonical path), to catch a second profile
// being applied to an already-locked instance in the same process.
const configured = new Map<string, string>();
const configuring = new Map<string, Promise<unknown>>();

/**
 * Connect to an instance with the project time zone and the sandbox applied. The first connection to a
 * fresh instance configures and locks it; later connections verify it carries the same sandbox.
 */
export async function connect(instance: DuckDBInstance, spec: SandboxSpec, key: string): Promise<DuckDBConnection> {
  const conn = await instance.connect();
  try {
    // Serialize per instance: two first connections must not both try to configure it.
    const prev = configuring.get(key) ?? Promise.resolve();
    const mine = prev.catch(() => {}).then(() => applySandbox(conn, spec, key));
    configuring.set(key, mine);
    try {
      await mine;
    } finally {
      if (configuring.get(key) === mine) configuring.delete(key);
    }
    return conn;
  } catch (e) {
    conn.disconnectSync();
    throw e;
  }
}

async function scalar(conn: DuckDBConnection, sql: string): Promise<unknown> {
  const reader = await conn.runAndReadAll(sql);
  return reader.getRowsJS()[0]?.[0];
}

async function applySandbox(conn: DuckDBConnection, spec: SandboxSpec, key: string): Promise<void> {
  const dirs = allowedDirectories(spec);
  const fingerprint = JSON.stringify([spec.profile, spec.timezone, dirs, spec.memoryLimit ?? null, spec.threads ?? null]);
  const locked = (await scalar(conn, "SELECT current_setting('lock_configuration')")) === true;
  if (locked) {
    if (configured.get(key) !== fingerprint) {
      throw new CroftError("INTERNAL_ERROR", {
        message: `the database ${key} is already open in this process with a different sandbox`,
        hint: "report this croft bug",
        details: { expected: fingerprint, actual: configured.get(key) ?? null },
      });
    }
    return;
  }
  try {
    await conn.run(`SET GLOBAL TimeZone = ${sqlString(spec.timezone)}`);
  } catch (e) {
    throw new CroftError("CONFIG_INVALID", {
      message: `unknown time zone ${JSON.stringify(spec.timezone)} in croft.json`,
      hint: "use an IANA name such as America/Los_Angeles or UTC",
      details: { duckdb: (e as Error).message },
    });
  }
  if (spec.memoryLimit) await conn.run(`SET GLOBAL memory_limit = ${sqlString(spec.memoryLimit)}`);
  if (spec.threads) await conn.run(`SET GLOBAL threads = ${Math.max(1, Math.floor(spec.threads))}`);
  await conn.run(`SET allowed_directories = [${dirs.map(sqlString).join(", ")}]`);
  await conn.run("SET enable_external_access = false");
  await conn.run("SET lock_configuration = true");
  configured.set(key, fingerprint);
}

/** The sandbox fingerprint recorded for an instance key; for tests and diagnostics. */
export function sandboxOf(key: string): string | undefined {
  return configured.get(key);
}

export interface LockConflict { path: string | null; program: string | null; pid: number | null }

/** Parse DuckDB's lock error: `Could not set lock on file "<db>": Conflicting lock is held in <program> (PID n)`. */
export function lockConflict(err: unknown): LockConflict | null {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/Could not set lock on file|Conflicting lock is held/.test(msg)) return null;
  const file = msg.match(/Could not set lock on file "([^"]+)"/)?.[1] ?? null;
  const held = msg.match(/Conflicting lock is held in (.+?) \(PID (\d+)\)/);
  return { path: file, program: held?.[1] ?? null, pid: held ? Number(held[2]) : null };
}

/** True for DuckDB's sandbox refusal ("file system operations are disabled by configuration"). */
export function isSandboxDenial(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("Permission Error") && /disabled (by|through) configuration/.test(msg);
}

/** Map a sandbox refusal to QUERY_PATH_DENIED; other errors are returned unchanged. */
export function mapSandboxError(err: unknown, profile: Profile): unknown {
  if (!isSandboxDenial(err)) return err;
  const msg = (err as Error).message;
  const path = msg.match(/Cannot access (?:file|directory) "([^"]+)"/)?.[1];
  const where = profile === "serve" ? "croft serve reads tables only" : profile === "query" ? "croft query reads files only under files/" : "croft can only reach the project's files/ and state folders";
  return new CroftError("QUERY_PATH_DENIED", {
    message: path ? `cannot read ${path}: ${where}` : where,
    hint: profile === "serve" ? "query tables, not files" : "move the file under files/, or load it with a file ingest",
    details: { duckdb: msg.split("\n")[0] },
  });
}
