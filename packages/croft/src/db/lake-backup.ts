// `croft backup` of a lake (DESIGN.md §6 "Backups of the project's data", D151; option 07, slice 3): a lake is a catalog database and a
// bucket folder, so its backup is a dump of the one and a mirror of the other, taken as one moment, plus what lives on the writing
// machine (run history, schedules and the trash). It restores to an equal lake on a fresh catalog and a fresh bucket (`croft docs backup`).
//
// How, and why:
// - The catalog is dumped with Postgres's own tool (`pg_dump`, custom format), as the read-only login: a backup only reads, and the
//   read-only login can. A dump is complete (the inlined rows, the settings, whatever DuckLake adds in a later format), restores with the
//   standard tool, and is what whoever runs the Postgres expects. Writing a dump of croft's own would mean knowing every table DuckLake
//   makes, and it would be one more thing to keep right. If pg_dump is missing, that is LAKE_BACKUP_TOOL_MISSING before anything is
//   written. A local lake (a SQLite catalog, croft's own tests) is `VACUUM INTO`, a consistent copy by SQLite itself.
// - The bucket folder is mirrored with a signed read of the store (db/s3-mirror.ts), as the read-only key, file by file. A file of the lake
//   never changes once written (DuckLake names each by a new id), so a backup reuses, as a hard link, the same file of the newest earlier
//   backup of this lake when its size is the same, and downloads only what is new: a daily backup costs what the day wrote.
// - One moment: the dump, run history and trash are taken under croft's lock on the lake's writes (seconds), with the lake's snapshot
//   id noted. The mirror then runs with writes going on, as the file backup lets runs go on while it copies across disks: a write only
//   adds files, so every file the dump names is there, and a backup running keeps this machine's maintenance from deleting any (db/lake.ts
//   markBackupRunning). A file written after the dump is in the mirror and not in the catalog: restored, it is a file the lake does not
//   own, which `croft maintain --orphans` can list and delete.
// - The folder is built under a .croft-partial- name and renamed into place once whole; a name taken gets -2, -3; croft never deletes one.
import { spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { formatInstant, now as clockNow } from "../core/time.ts";
import { RUNS_DB_FILE } from "../history/runs-db.ts";
import type { ProjectEnv } from "../project/env.ts";
import { localLakePaths } from "../project/lake-config.ts";
import type { Project } from "../project/root.ts";
import {
  aborted, BACKUP_MANIFEST, type BackupManifest, backupsDir, cloneFile, destination, ensureDir, freeName, hasVersions, listFiles, nameSafe,
  notWritten, PARTIAL_PREFIX, type ProjectBackup, type ProjectBackupOptions, removePartials, TRASH_FOLDER, vacuumInto,
} from "./backup.ts";
import { lakeOption, markBackupRunning } from "./lake.ts";
import { lakeExists } from "./lake-pass.ts";
import { type ModeSpec, scrub, TLS_REFUSED } from "./modes.ts";
import { downloadObject, listObjects, type S3Access, S3Failure } from "./s3-mirror.ts";
import { CROFT_VERSION } from "./state.ts";

/** The files of a lake backup (relative to its folder). */
export const CATALOG_DUMP = "catalog.dump";
export const CATALOG_SQLITE = "catalog.sqlite";
export const LAKE_DATA_DIR = "lake-data";

/** What a lake backup holds besides what every project backup does. */
export interface LakeBackupInfo {
  kind: "postgres" | "local";
  /** The lake that was copied, with no credential. */
  source: string;
  /** The lake's snapshot the catalog dump holds. */
  snapshot: number;
  /** The catalog: `catalog.dump` (pg_dump, custom format) or `catalog.sqlite`; and the tool that made it. */
  catalog: { file: string; bytes: number; tool: string };
  /** The mirror of the lake's folder: where, how many files and bytes, and how many came from an earlier backup as hard links. */
  data: { dir: string; files: number; bytes: number; reused: number };
}

export interface LakeBackupOptions extends Pick<ProjectBackupOptions, "dir" | "now" | "isTTY" | "waits" | "onWait" | "lookupHolder" | "signal" | "platform" | "cp"> {
  /** The environment the child tools run with and `$CROFT_PG_DUMP` is read from (default: the process's). */
  processEnv?: Record<string, string | undefined>;
  /** Tests: a pg_dump to use, in place of the one found. */
  pgDump?: string;
  /** Tests: runs after the catalog is dumped and the lock is released, before the bucket is copied. */
  afterDump?: (e: { staging: string }) => void | Promise<void>;
}

export async function backupLake(project: Project, env: ProjectEnv, o: LakeBackupOptions = {}): Promise<ProjectBackup & { lake: LakeBackupInfo }> {
  const lake = project.config.lake!;
  const { stateDir, database } = project.paths;
  const at = o.now ?? clockNow;
  const processEnv = o.processEnv ?? process.env;
  const shared = lake.kind === "postgres";
  // Before anything is written: the tool, and a lake that exists.
  const pgDump = shared ? (o.pgDump ?? findPgDump(processEnv)) : null;
  if (shared && !pgDump) throw pgDumpMissing();
  if (!(await lakeExists(project, env))) {
    throw new CroftError("DB_NOT_FOUND", {
      message: `there is no lake to back up: nobody has written ${project.databaseLabel} yet`,
      hint: "croft run builds it; there is nothing to back up before that", effect: "nothing was written",
      fix: { kind: "command", description: "build the assets, which creates the lake", command: "croft run" },
      details: { database: project.databaseLabel, notCreated: true },
    });
  }
  const parent = destination(o.dir ?? backupsDir(stateDir), stateDir);
  ensureDir(parent);
  removePartials(parent);
  const name = `${nameSafe(basename(project.root))}-${at().toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "")}`;
  const staging = join(parent, `${PARTIAL_PREFIX}${process.pid}-${name}`);
  const connection = lakeOption(project, env).lake!;
  // The read-only login and key: a backup reads.
  const readMode = connection.mode("read");
  const secrets = readMode.kind === "lake" ? [readMode.lake.catalog.password, readMode.lake.data.keyId, readMode.lake.data.secretKey, ...(readMode.lake.data.sessionToken ? [readMode.lake.data.sessionToken] : [])] : [];
  let unmark: (() => void) | null = null;
  try {
    mkdirSync(staging);
    const warehouse = (await import("./warehouse.ts")).openWarehouse({
      path: database, mode: "read_write", timezone: project.timezone, root: project.root, stateDir, lake: connection,
      ...(o.isTTY !== undefined ? { isTTY: o.isTTY } : {}), ...(o.waits ? { waits: o.waits } : {}), ...(o.onWait ? { onWait: o.onWait } : {}),
      ...(o.lookupHolder ? { lookupHolder: o.lookupHolder } : {}), register: false,
    });
    let leased: { createdAt: Date; heldMs: number; snapshot: number; formatVersion: string | null; catalogTool: string; runs: boolean; trash: boolean };
    try {
      // The lease is the dump, run history and the trash: one moment. The bucket is copied after it.
      leased = await warehouse.write("lake backup", async (sql) => {
        const started = Date.now();
        unmark = markBackupRunning(stateDir);
        const [snap] = await sql.all<{ id: number | bigint }>("SELECT id FROM lake.current_snapshot()");
        const createdAt = at();
        let formatVersion: string | null = null;
        try {
          const row = (await sql.all<{ value: string }>("SELECT value FROM _croft.meta WHERE key = 'format_version'"))[0];
          formatVersion = row ? String(row.value) : null;
        } catch { /* a lake croft never wrote its state into */ }
        let catalogTool: string;
        if (readMode.kind === "lake") {
          catalogTool = await pgDumpTo(pgDump!, readMode.lake.catalog, join(staging, CATALOG_DUMP), { processEnv, secrets, ...(o.signal ? { signal: o.signal } : {}) });
        } else if (readMode.kind === "lake-local") {
          const { Database } = await import("bun:sqlite");
          const db = new Database(readMode.lake.catalog.path, { readonly: true });
          try {
            db.run("VACUUM INTO ?", [join(staging, CATALOG_SQLITE)]);
          } finally {
            db.close();
          }
          catalogTool = "sqlite VACUUM INTO";
        } else {
          throw new CroftError("INTERNAL_ERROR", { message: `a ${readMode.kind} mode is no lake backup's`, hint: "report this croft bug" });
        }
        const runsFile = join(stateDir, RUNS_DB_FILE);
        const runs = existsSync(runsFile);
        if (runs) vacuumInto(stateDir, join(staging, RUNS_DB_FILE));
        const trashSrc = join(stateDir, TRASH_FOLDER);
        const trash = hasVersions(trashSrc);
        if (trash) await cloneFile(trashSrc, join(staging, TRASH_FOLDER), o, true);
        return { createdAt, heldMs: Date.now() - started, snapshot: Number(snap?.id ?? 0), formatVersion, catalogTool, runs, trash };
      }, { runId: "", transaction: false, touchesLake: false, ...(o.signal ? { signal: o.signal } : {}) });
    } finally {
      await warehouse.close();
    }
    await o.afterDump?.({ staging });
    // The bucket (or the data folder), with writes going on.
    const data = await mirrorData(project, readMode, join(staging, LAKE_DATA_DIR), parent, { secrets, ...(o.signal ? { signal: o.signal } : {}), ...(o.cp ? { cp: o.cp } : {}), ...(o.platform ? { platform: o.platform } : {}) });
    const files = listFiles(staging);
    const size = (rel: string) => files.filter((f) => f.path === rel || f.path.startsWith(`${rel}/`)).reduce((n, f) => n + f.bytes, 0);
    const catalogFile = shared ? CATALOG_DUMP : CATALOG_SQLITE;
    const info: LakeBackupInfo = {
      kind: lake.kind === "postgres" ? "postgres" : "local", source: project.databaseLabel, snapshot: leased.snapshot,
      catalog: { file: catalogFile, bytes: size(catalogFile), tool: leased.catalogTool },
      data: { dir: LAKE_DATA_DIR, files: data.files, bytes: data.bytes, reused: data.reused },
    };
    const { version } = await import("@duckdb/node-api");
    const manifest: BackupManifest & { lake: LakeBackupInfo & { folder: string } } = {
      croftBackup: 1, createdAt: leased.createdAt.toISOString(), croftVersion: CROFT_VERSION, duckdb: version(), formatVersion: leased.formatVersion,
      project: { root: project.root, database, stateDir, timezone: project.timezone }, files,
      restore: "croft docs backup: restore the catalog into a new database, copy lake-data/ into the new bucket folder, and point the project at them",
      lake: { ...info, folder: shared ? `s3://${lake.bucket.name}/${lake.bucket.folder}` : localLakePaths(lake as never, project.root).data },
    };
    writeFileSync(join(staging, BACKUP_MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
    const path = freeName(parent, name);
    renameSync(staging, path);
    return {
      path, createdAt: formatInstant(leased.createdAt, project.timezone), bytes: files.reduce((n, f) => n + f.bytes, 0),
      warehouse: { file: catalogFile, bytes: size(catalogFile), method: "copy" },
      runs: leased.runs ? { file: RUNS_DB_FILE, bytes: size(RUNS_DB_FILE) } : null,
      trash: leased.trash ? { dir: TRASH_FOLDER, versions: files.filter((f) => f.path.startsWith(`${TRASH_FOLDER}/`) && f.path.endsWith(".duckdb")).length, bytes: size(TRASH_FOLDER) } : null,
      sameDisk: statSync(parent).dev === statSync(stateDir).dev, heldMs: leased.heldMs, duckdb: version(), formatVersion: leased.formatVersion, lake: info,
    };
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    if (e instanceof CroftError) throw e;
    if (o.signal?.aborted) throw aborted(o.signal, "backing up the lake");
    if (e instanceof S3Failure) {
      throw new CroftError("LAKE_BACKUP_FAILED", {
        message: `croft could not copy the lake's bucket: ${scrub(e.message, secrets)}`,
        hint: "check that the read-only bucket key can list and read the lake's folder and that the store is reachable, then run croft backup again; nothing was kept",
        retryable: true, effect: "nothing was written: no partial backup is left",
      });
    }
    throw notWritten(parent, e);
  } finally {
    (unmark as (() => void) | null)?.();
  }
}

// ---- The catalog ------------------------------------------------------------------------------------------------

/** Where pg_dump might be: PATH, `$CROFT_PG_DUMP`, and the places Homebrew, Postgres.app and the distributions put it. The newest wins. */
export function findPgDump(env: Record<string, string | undefined>): string | null {
  const named = env.CROFT_PG_DUMP;
  if (named) return existsSync(named) ? named : null;
  const dirs = (env.PATH ?? "").split(":").filter(Boolean);
  const found: { path: string; major: number }[] = [];
  const add = (path: string) => {
    if (!existsSync(path) || found.some((f) => f.path === path)) return;
    const r = Bun.spawnSync([path, "-V"], { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, stdout: "pipe", stderr: "ignore" });
    const major = Number(/\b(\d+)(?:\.\d+)*\b/.exec(r.stdout.toString())?.[1] ?? "0");
    if (r.exitCode === 0) found.push({ path, major });
  };
  for (const d of dirs) add(join(d, "pg_dump"));
  for (const base of ["/opt/homebrew/opt", "/usr/local/opt"]) {
    try {
      for (const n of readdirSync(base)) if (/^(libpq|postgresql(@\d+)?)$/.test(n)) add(join(base, n, "bin", "pg_dump"));
    } catch { /* no Homebrew */ }
  }
  try {
    for (const v of readdirSync("/usr/lib/postgresql")) add(join("/usr/lib/postgresql", v, "bin", "pg_dump"));
  } catch { /* no distribution Postgres */ }
  try {
    const app = join(homedir(), "Applications", "Postgres.app", "Contents", "Versions");
    for (const v of readdirSync(app)) add(join(app, v, "bin", "pg_dump"));
  } catch { /* no Postgres.app */ }
  return found.sort((a, b) => b.major - a.major)[0]?.path ?? null;
}

function pgDumpMissing(): CroftError {
  return new CroftError("LAKE_BACKUP_TOOL_MISSING", {
    message: "croft backup of a lake needs Postgres's pg_dump, and it was not found on this machine",
    hint: "install the Postgres client tools (macOS: brew install libpq; Debian and Ubuntu: apt install postgresql-client), at least as new as the catalog's server, or name the program in CROFT_PG_DUMP",
    fix: { kind: "manual", description: "install pg_dump (the Postgres client tools), or set CROFT_PG_DUMP to its path, then run croft backup again", requiresHuman: true },
    effect: "nothing was written",
  });
}

/** Dump the catalog database to `to`, as the read-only login, in a child process with a fixed environment (the password is in it, never in
 *  an argument). Returns the tool's own version line. */
export async function pgDumpTo(pgDump: string, catalog: { host: string; port: number; database: string; user: string; password: string; sslMode?: string; sslRootCert?: string }, to: string,
  o: { processEnv: Record<string, string | undefined>; secrets: string[]; signal?: AbortSignal }): Promise<string> {
  const env: Record<string, string> = { PATH: "/usr/bin:/bin", LC_ALL: "C", PGPASSWORD: catalog.password };
  for (const k of ["PGSSLMODE", "PGSSLROOTCERT", "PGSSLCERT", "PGSSLKEY", "PGCONNECT_TIMEOUT"]) if (o.processEnv[k]) env[k] = o.processEnv[k]!;
  // The catalog's own TLS, as the attach has it (D159): the project's setting wins over the user's environment, so a dump is checked as the lake is.
  // Without this a hosted catalog was dumped with libpq's `prefer`, which verifies nothing and goes on in plain text when TLS is not offered:
  // the read-only password and the whole catalog crossed the network unprotected.
  if (catalog.sslMode) env.PGSSLMODE = catalog.sslMode;
  if (catalog.sslRootCert) env.PGSSLROOTCERT = catalog.sslRootCert;
  // -Fc: the custom format; -O: no owners; -x: no privileges (the restore's setup grants them again). Short flags, as pg_dump has them.
  const args = ["-Fc", "-O", "-x", "-h", catalog.host, "-p", String(catalog.port), "-U", catalog.user, "-d", catalog.database, "-f", to];
  const version = (await run(pgDump, ["-V"], { PATH: "/usr/bin:/bin", LC_ALL: "C" })).stdout.trim() || "pg_dump";
  const r = await run(pgDump, args, env, o.signal);
  if (r.code !== 0) {
    if (o.signal?.aborted) throw aborted(o.signal, "dumping the lake's catalog");
    rmSync(to, { force: true });
    const text = scrub(r.stderr.trim(), o.secrets);
    const mismatch = /server version mismatch/i.test(text);
    throw new CroftError("LAKE_BACKUP_FAILED", {
      message: `pg_dump could not dump the lake's catalog: ${text.split("\n").slice(0, 3).join(" ").slice(0, 400)}`,
      hint: mismatch ? "this pg_dump is older than the catalog's Postgres: install the client tools of the server's version (or newer) and name it in CROFT_PG_DUMP"
        : TLS_REFUSED.test(text) ? `the catalog's certificate did not check out (or the catalog offers no TLS) with lake.catalog.sslMode "${catalog.sslMode ?? "prefer"}": check lake.catalog.sslMode and lake.catalog.sslRootCert (croft docs lake); trying again will not help`
        : /permission denied/i.test(text) ? "the read-only login must be able to SELECT every table of the catalog database (the setup in croft docs lake grants it)"
          : "check that the catalog is reachable from this machine and that the read-only login works (croft doctor), then run croft backup again",
      retryable: !mismatch && !TLS_REFUSED.test(text), effect: "nothing was written: no partial backup is left",
    });
  }
  return version;
}

function run(cmd: string, args: string[], env: Record<string, string>, signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const kill = () => child.kill("SIGKILL");
    if (signal?.aborted) kill();
    else signal?.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => {
      if (stderr.length < 8000) stderr += String(d);
    });
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: e.message }));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", kill);
      resolve({ code, stdout, stderr });
    });
  });
}

// ---- The data -----------------------------------------------------------------------------------------------------

/** The newest earlier lake backup in `parent` of the same folder: its mirror's folder, to link files from. */
function previousMirror(parent: string, folder: string): string | null {
  let best: { at: string; dir: string } | null = null;
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return null;
  }
  for (const n of names) {
    if (n.startsWith(".")) continue;
    try {
      const m = JSON.parse(readFileSync(join(parent, n, BACKUP_MANIFEST), "utf8")) as { createdAt?: string; lake?: { folder?: string; data?: { dir?: string } } };
      if (m.lake?.folder !== folder || !m.lake.data?.dir || typeof m.createdAt !== "string") continue;
      if (!best || m.createdAt > best.at) best = { at: m.createdAt, dir: join(parent, n, m.lake.data.dir) };
    } catch { /* not a lake backup */ }
  }
  return best && existsSync(best.dir) ? best.dir : null;
}

async function mirrorData(project: Project, mode: ModeSpec, to: string, parent: string,
  o: { secrets: string[]; signal?: AbortSignal; cp?: readonly string[]; platform?: NodeJS.Platform }): Promise<{ files: number; bytes: number; reused: number }> {
  const lake = project.config.lake!;
  if (lake.kind === "local" && mode.kind === "lake-local") {
    const dir = mode.lake.dataPath;
    if (existsSync(dir)) await cloneFile(dir.replace(/\/+$/, ""), to, o, true);
    else mkdirSync(to);
    const files = listFiles(to);
    return { files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), reused: 0 };
  }
  if (lake.kind !== "postgres" || mode.kind !== "lake") throw new CroftError("INTERNAL_ERROR", { message: "a lake backup's mode does not fit its lake", hint: "report this croft bug" });
  const b = mode.lake.data;
  const access: S3Access = {
    ...(lake.bucket.endpoint ? { endpoint: lake.bucket.endpoint } : {}), region: lake.bucket.region ?? "us-east-1", useSsl: lake.bucket.useSsl, urlStyle: lake.bucket.urlStyle,
    bucket: lake.bucket.name, keyId: b.keyId, secretKey: b.secretKey, ...(b.sessionToken ? { sessionToken: b.sessionToken } : {}),
    ...(b.caFile ? { caFile: b.caFile } : {}),
  };
  const folder = `s3://${lake.bucket.name}/${lake.bucket.folder}`;
  const earlier = previousMirror(parent, folder);
  mkdirSync(to, { recursive: true });
  const objects: { key: string; size: number }[] = [];
  for await (const obj of listObjects(access, lake.bucket.folder)) objects.push(obj);
  let reused = 0;
  let bytes = 0;
  const queue = [...objects];
  const worker = async (): Promise<void> => {
    for (let obj = queue.shift(); obj; obj = queue.shift()) {
      if (o.signal?.aborted) throw aborted(o.signal, "copying the lake's bucket");
      const rel = obj.key.slice(lake.bucket.folder.length);
      // A key that climbs out of the folder, or is empty, is not the lake's.
      if (!rel || rel.split("/").some((p) => p === ".." || p === "") ) continue;
      const dest = join(to, ...rel.split("/"));
      const before = earlier ? join(earlier, ...rel.split("/")) : null;
      mkdirSync(dirname(dest), { recursive: true });
      if (before && existsSync(before) && statSync(before).size === obj.size) {
        try {
          linkSync(before, dest);
          reused++;
          bytes += obj.size;
          continue;
        } catch { /* another filesystem: downloaded instead */ }
      }
      await downloadObject(access, obj.key, dest, obj.size);
      bytes += obj.size;
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, Math.max(1, objects.length)) }, worker));
  return { files: objects.length, bytes, reused };
}

