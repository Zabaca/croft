// The project registry, ~/.croft/projects.json (DESIGN.md §8 "Turning it on"): the projects whose scheduling
// the per-user OS job serves. `croft schedule on` adds a project and `off` removes it; the per-user tick
// (user-tick.ts) and pruneRegistry() drop projects that are gone, so a moved or deleted project cannot leave the
// job firing forever.
//
// Gone or missing (projectPresence): a project whose croft.json is not there is gone only when the folder around
// it is there, on a mounted disk. A project on an external or network disk that is not mounted right now
// (/Volumes/<disk>, /media/…, /run/media/<user>/<disk>, /mnt/<disk>), or whose parent folder is gone too, is
// missing: it may come back. A missing project stays registered with `missingSince`, and is dropped only after
// MISSING_PRUNE_DAYS days missing; seeing it again clears the mark. A permission error (EPERM from macOS privacy
// protection, EACCES) says nothing about the project and changes nothing.
//
// Writers are `croft schedule` in any project and the per-user tick, possibly at once. Every change is a
// read-modify-write under two locks, and the new file is written to a temp name and renamed into place, so a
// reader sees the whole old file or the whole new one:
// 1. the OS lock, an exclusive transaction on projects.json.lock.db. SQLite's lock is a POSIX fcntl lock, which
//    the kernel drops when its holder exits or dies, so nobody breaks it by hand and two writers never both
//    hold it;
// 2. holding the OS lock, the lock file older crofts use (projects.json.lock, created with O_EXCL and holding
//    the pid), so a croft from before the OS lock is kept out too. It is broken when its pid is dead or it is
//    older than LOCK_STALE_MS. Only the OS lock's holder can be breaking it, so two writers can no longer both
//    judge it abandoned, each break it, and both go in (review R31-03).
// The generated tick script implements the same protocol with these constants.
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CroftError } from "../core/errors.ts";
import { now as clock } from "../core/time.ts";
import { CONFIG_FILE } from "../project/root.ts";
import type { CroftHome, Env } from "./home.ts";
import type { RegistryEntry } from "./os.ts";

/** The lock file next to projects.json (the pid of its holder). */
export const LOCK_SUFFIX = ".lock";
/** The OS lock's database next to projects.json. It holds no data. */
export const LOCK_DB_SUFFIX = ".lock.db";
/** A lock file older than this is abandoned: holders keep it only while they rewrite a small file. */
export const LOCK_STALE_MS = 10_000;
/** How long a writer waits for both locks before it gives up with DB_BUSY. */
export const LOCK_WAIT_MS = LOCK_STALE_MS + 2_000;
/** A project missing this many days in a row (its disk unplugged, its folder gone with its parent) is dropped. */
export const MISSING_PRUNE_DAYS = 30;
export const MISSING_PRUNE_MS = MISSING_PRUNE_DAYS * 86_400_000;

/** An entry as stored: RegistryEntry, and since when the project has been missing. */
export interface RegistryRecord extends RegistryEntry {
  /** ISO-8601 UTC: the first tick (or prune) that found the project missing, while it still is. */
  missingSince?: string;
}

export interface RegistryOptions {
  /** addedAt for a new entry, and the clock for missingSince; defaults to now (CROFT_NOW). */
  now?: Date;
  env?: Env;
}

export interface LockOptions {
  sleep?: (ms: number) => void;
  /** How long to wait for the locks; LOCK_WAIT_MS. */
  waitMs?: number;
}

export function registryLockPath(home: CroftHome): string {
  return home.registry + LOCK_SUFFIX;
}

export function registryLockDbPath(home: CroftHome): string {
  return home.registry + LOCK_DB_SUFFIX;
}

/** The projects in the registry, in the order they were added. A missing file is an empty registry. */
export function listProjects(home: CroftHome): RegistryRecord[] {
  return readEntries(home);
}

/** Add a project (or update its `via`, keeping addedAt). The root is stored as the real folder. Adding a project
 *  marked missing clears the mark: it is there. */
export function addProject(home: CroftHome, e: { root: string; via: RegistryEntry["via"] }, o: RegistryOptions = {}):
  { entry: RegistryEntry; added: boolean; entries: RegistryRecord[] } {
  const root = canonicalRoot(e.root);
  return withRegistryLock(home, () => {
    const entries = readEntries(home);
    const i = entries.findIndex((x) => x.root === root);
    if (i >= 0) {
      const old = entries[i]!;
      const entry: RegistryEntry = { root: old.root, addedAt: old.addedAt, via: e.via };
      if (old.via !== e.via || old.missingSince !== undefined) {
        entries[i] = entry;
        writeEntries(home, entries);
      }
      return { entry, added: false, entries };
    }
    const entry: RegistryEntry = { root, addedAt: (o.now ?? clock(o.env)).toISOString(), via: e.via };
    entries.push(entry);
    writeEntries(home, entries);
    return { entry, added: true, entries };
  });
}

/** Remove a project, found by its real folder or, when the folder is gone, by the path given. */
export function removeProject(home: CroftHome, root: string): { removed: RegistryRecord | null; entries: RegistryRecord[] } {
  const paths = new Set([resolve(root), canonicalRoot(root)]);
  return withRegistryLock(home, () => {
    const entries = readEntries(home);
    const i = entries.findIndex((x) => paths.has(x.root));
    if (i < 0) return { removed: null, entries };
    const [removed] = entries.splice(i, 1);
    writeEntries(home, entries);
    return { removed: removed!, entries };
  });
}

export interface PruneResult {
  /** Dropped: gone, or missing for MISSING_PRUNE_DAYS. */
  removed: RegistryRecord[];
  /** Kept, but missing (with missingSince). */
  missing: RegistryRecord[];
  entries: RegistryRecord[];
}

/** Drop projects that are gone, and projects missing for MISSING_PRUNE_DAYS; mark newly missing ones, and unmark
 *  ones that are back. A project that cannot be checked is kept as it is. Writes only when something changed. */
export function pruneRegistry(home: CroftHome, o: RegistryOptions & { fs?: PresenceFs } = {}): PruneResult {
  const now = (o.now ?? clock(o.env)).getTime();
  return withRegistryLock(home, () => {
    const removed: RegistryRecord[] = [];
    const missing: RegistryRecord[] = [];
    const entries: RegistryRecord[] = [];
    let changed = false;
    for (const e of readEntries(home)) {
      const p = projectPresence(e.root, o.fs);
      if (p === "gone") {
        removed.push(e);
        changed = true;
      } else if (p === "missing") {
        const since = e.missingSince !== undefined ? Date.parse(e.missingSince) : Number.NaN;
        if (Number.isFinite(since) && now - since >= MISSING_PRUNE_MS) {
          removed.push(e);
          changed = true;
          continue;
        }
        const kept = Number.isFinite(since) ? e : { ...e, missingSince: new Date(now).toISOString() };
        if (kept !== e) changed = true;
        missing.push(kept);
        entries.push(kept);
      } else if (p === "present" && e.missingSince !== undefined) {
        entries.push({ root: e.root, addedAt: e.addedAt, via: e.via });
        changed = true;
      } else {
        entries.push(e);
      }
    }
    if (changed) writeEntries(home, entries);
    return { removed, missing, entries };
  });
}

/** How projectPresence looks at the file system (tests describe mounts with it). */
export interface PresenceFs {
  /** Like statSync: throws with an errno code. */
  stat(path: string): { dev: number; isDirectory(): boolean };
}

const realFs: PresenceFs = { stat: (p) => statSync(p) };

/**
 * Whether a registered project is there:
 * - "present": its croft.json is there;
 * - "gone": its folder or croft.json is definitely gone: the folder around it is there, on a mounted disk;
 * - "missing": its disk is not mounted, or the folder around it is gone too, so it may come back;
 * - "unknown": it cannot be checked (a permission error, which says nothing about whether it exists).
 */
export function projectPresence(root: string, fs: PresenceFs = realFs): "present" | "gone" | "missing" | "unknown" {
  try {
    fs.stat(join(root, CONFIG_FILE));
    return "present";
  } catch (e) {
    if (!isNotFound(e)) return "unknown";
  }
  const volumes = volumeRoots(root);
  if (volumes.length > 0 && !volumes.some((v) => isMountPoint(v, fs))) return "missing";
  try {
    return fs.stat(dirname(root)).isDirectory() ? "gone" : "missing";
  } catch (e) {
    return isNotFound(e) ? "missing" : "unknown";
  }
}

/** Where removable and network disks are mounted, the candidates for the disk a path is on: /Volumes/<disk>
 *  (macOS), /media/<disk> and /media/<user>/<disk>, /run/media/<user>/<disk>, /mnt/<disk> (Linux). */
export function volumeRoots(path: string): string[] {
  const s = path.split("/").filter((x) => x !== "");
  const at = (n: number) => `/${s.slice(0, n).join("/")}`;
  if ((s[0] === "Volumes" || s[0] === "mnt") && s.length >= 2) return [at(2)];
  if (s[0] === "media" && s.length >= 2) return s.length >= 3 ? [at(2), at(3)] : [at(2)];
  if (s[0] === "run" && s[1] === "media" && s.length >= 4) return [at(4)];
  return [];
}

/** A mount point: a folder on another device than the folder it is in. A folder that is not there is none. */
function isMountPoint(dir: string, fs: PresenceFs): boolean {
  try {
    return fs.stat(dir).dev !== fs.stat(dirname(dir)).dev;
  } catch {
    return false;
  }
}

function isNotFound(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The real folder, so a project reached through a symlink is one entry; the resolved path when it cannot be
 *  resolved (gone). */
export function canonicalRoot(root: string): string {
  const abs = resolve(root);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** Run `fn` holding the registry's locks (the header says which). Synchronous: the critical section is a small
 *  file rewrite. DB_BUSY when another writer holds them past `waitMs`. */
export function withRegistryLock<T>(home: CroftHome, fn: () => T, o: LockOptions = {}): T {
  mkdirSync(home.dir, { recursive: true, mode: 0o700 });
  const sleep = o.sleep ?? ((ms: number) => Bun.sleepSync(ms));
  const ms = o.waitMs ?? LOCK_WAIT_MS;
  const wait: Wait = { ms, deadline: Date.now() + ms };
  const db = takeOsLock(home, wait, sleep);
  try {
    takeLockFile(home, wait, sleep);
    try {
      return fn();
    } finally {
      releaseLockFile(home);
    }
  } finally {
    try { db.exec("ROLLBACK"); } catch { /* closing ends the transaction anyway */ }
    db.close();
  }
}

/** How long a writer waits for the locks, and until when. */
interface Wait { ms: number; deadline: number }

/** The OS lock: BEGIN EXCLUSIVE on the lock database, retried until the deadline. */
function takeOsLock(home: CroftHome, wait: Wait, sleep: (ms: number) => void): Database {
  const file = registryLockDbPath(home);
  const db = new Database(file, { create: true });
  for (;;) {
    try {
      db.exec("PRAGMA busy_timeout = 0");
      db.exec("BEGIN EXCLUSIVE");
      return db;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "SQLITE_BUSY" && Date.now() <= wait.deadline) {
        sleep(5 + Math.random() * 20);
        continue;
      }
      db.close();
      if (code === "SQLITE_BUSY") throw busy(home, file, wait.ms);
      if (code === "SQLITE_NOTADB" || code === "SQLITE_CORRUPT") throw notALockDb(home, file);
      throw e;
    }
  }
}

/** The lock file of older crofts, taken while the OS lock is held. */
function takeLockFile(home: CroftHome, wait: Wait, sleep: (ms: number) => void): void {
  const lock = registryLockPath(home);
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      try {
        writeSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (lockAbandoned(lock)) {
        try { unlinkSync(lock); } catch { /* an older croft broke it first */ }
        continue;
      }
      if (Date.now() > wait.deadline) throw busy(home, lock, wait.ms);
      sleep(5 + Math.random() * 20);
    }
  }
}

/** Remove the lock file if it is still this process's (an older croft may have broken it and made its own). */
function releaseLockFile(home: CroftHome): void {
  const lock = registryLockPath(home);
  try {
    if (readFileSync(lock, "utf8").trim() === String(process.pid)) unlinkSync(lock);
  } catch { /* already gone */ }
}

/** A lock file whose holder is dead, or that is older than LOCK_STALE_MS. Unreadable or vanished: not abandoned
 *  (the next attempt sees what happened). */
function lockAbandoned(lock: string): boolean {
  let text: string;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(lock).mtimeMs;
    text = readFileSync(lock, "utf8");
  } catch {
    return false;
  }
  if (Date.now() - mtimeMs > LOCK_STALE_MS) return true;
  const pid = Number(text.trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;    // being written: give it until LOCK_STALE_MS
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";  // EPERM: alive, someone else's process
  }
}

function busy(home: CroftHome, file: string, waitedMs: number): CroftError {
  const who = file === registryLockDbPath(home) ? `lsof ${file} names it` : `${file} holds its pid`;
  const waited = waitedMs >= 1000 ? `${Math.round(waitedMs / 1000)} s` : `${waitedMs} ms`;
  return new CroftError("DB_BUSY", {
    message: `another croft has been changing ${home.registry} for more than ${waited} (it holds ${file})`,
    hint: `try again in a minute; if it stays busy, a croft may be stuck holding the lock: ${who}`,
    file: home.registry,
    fix: { kind: "manual", description: "run the command again in a minute" },
    details: { lock: file },
  });
}

function notALockDb(home: CroftHome, file: string): CroftError {
  return new CroftError("CONFIG_INVALID", {
    message: `${file}, the lock of croft's project registry, is not a SQLite database`,
    hint: `with no croft schedule command running, delete ${file} (it holds no data); croft makes a new one`,
    file,
    fix: { kind: "manual", description: `delete ${file}, then run the command again` },
    details: { registry: home.registry },
  });
}

function readEntries(home: CroftHome): RegistryRecord[] {
  let text: string;
  try {
    text = readFileSync(home.registry, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw invalid(home, `is not valid JSON (${(e as Error).message})`);
  }
  if (!Array.isArray(raw)) throw invalid(home, "does not hold a JSON array of projects");
  return raw.filter(isEntry).map((e) => ({
    root: e.root, addedAt: e.addedAt, via: e.via, ...(typeof e.missingSince === "string" ? { missingSince: e.missingSince } : {}),
  }));
}

function isEntry(v: unknown): v is RegistryRecord {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Partial<RegistryEntry>;
  return typeof e.root === "string" && isAbsolute(e.root) && typeof e.addedAt === "string"
    && (e.via === "os-job" || e.via === "serve");
}

function invalid(home: CroftHome, what: string): CroftError {
  return new CroftError("CONFIG_INVALID", {
    message: `${home.registry} ${what}`,
    hint: "this file lists the projects the scheduler serves; delete it, then run croft schedule on again in each project that should run on a schedule",
    file: home.registry,
    fix: { kind: "manual", description: `delete ${home.registry}, then run croft schedule on in each scheduled project` },
  });
}

function writeEntries(home: CroftHome, entries: RegistryRecord[]): void {
  const tmp = `${home.registry}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(entries, null, 2) + "\n");
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  renameSync(tmp, home.registry);
}
