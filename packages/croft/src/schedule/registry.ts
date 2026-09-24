// The project registry, ~/.croft/projects.json (DESIGN.md §8 "Turning it on"): the projects whose scheduling
// the per-user OS job serves. `croft schedule on` adds a project and `off` removes it; the per-user tick
// (user-tick.ts) and pruneRegistry() drop projects whose folder or croft.json is gone, so a moved or deleted
// project cannot leave the job firing forever.
//
// Writers are `croft schedule` in any project and the per-user tick, possibly at once. Every change is a
// read-modify-write under a lock file (projects.json.lock, created with O_EXCL and holding the pid), and the
// new file is written to a temp name and renamed into place, so a reader sees the whole old file or the whole
// new one. A lock whose pid is dead, or that is older than LOCK_STALE_MS (a holder keeps it for milliseconds),
// is broken. The generated tick script implements the same protocol with these constants.
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { CroftError } from "../core/errors.ts";
import { now as clock } from "../core/time.ts";
import { CONFIG_FILE } from "../project/root.ts";
import type { CroftHome, Env } from "./home.ts";
import type { RegistryEntry } from "./os.ts";

/** The lock file next to projects.json. */
export const LOCK_SUFFIX = ".lock";
/** A lock older than this is abandoned: holders keep it only while they rewrite a small file. */
export const LOCK_STALE_MS = 10_000;
/** How long a writer polls a live lock before it breaks it anyway (a holder stuck past LOCK_STALE_MS). */
const LOCK_WAIT_MS = LOCK_STALE_MS + 2_000;

export interface RegistryOptions {
  /** addedAt for a new entry; defaults to now (CROFT_NOW). */
  now?: Date;
  env?: Env;
}

export function registryLockPath(home: CroftHome): string {
  return home.registry + LOCK_SUFFIX;
}

/** The projects in the registry, in the order they were added. A missing file is an empty registry. */
export function listProjects(home: CroftHome): RegistryEntry[] {
  return readEntries(home);
}

/** Add a project (or update its `via`, keeping addedAt). The root is stored as the real folder. */
export function addProject(home: CroftHome, e: { root: string; via: RegistryEntry["via"] }, o: RegistryOptions = {}):
  { entry: RegistryEntry; added: boolean; entries: RegistryEntry[] } {
  const root = canonicalRoot(e.root);
  return withRegistryLock(home, () => {
    const entries = readEntries(home);
    const i = entries.findIndex((x) => x.root === root);
    if (i >= 0) {
      const entry = { ...entries[i]!, via: e.via };
      if (entries[i]!.via !== e.via) {
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
export function removeProject(home: CroftHome, root: string): { removed: RegistryEntry | null; entries: RegistryEntry[] } {
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

/** Drop projects whose folder or croft.json is gone. A folder that cannot be checked (EPERM from macOS
 *  privacy protection, EACCES) is kept: only a definite ENOENT or ENOTDIR removes a project. */
export function pruneRegistry(home: CroftHome): { removed: RegistryEntry[]; entries: RegistryEntry[] } {
  return withRegistryLock(home, () => {
    const all = readEntries(home);
    const removed = all.filter((e) => projectPresence(e.root) === "gone");
    if (removed.length === 0) return { removed, entries: all };
    const entries = all.filter((e) => !removed.includes(e));
    writeEntries(home, entries);
    return { removed, entries };
  });
}

/** Whether a registered project still exists: its croft.json is there, definitely gone, or cannot be
 *  checked (a permission error, which says nothing about whether it exists). */
export function projectPresence(root: string): "present" | "gone" | "unknown" {
  try {
    statSync(join(root, CONFIG_FILE));
    return "present";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "gone" : "unknown";
  }
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

/** Run `fn` holding projects.json.lock. Synchronous: the critical section is a small file rewrite. */
export function withRegistryLock<T>(home: CroftHome, fn: () => T, o: { sleep?: (ms: number) => void } = {}): T {
  const lock = registryLockPath(home);
  mkdirSync(home.dir, { recursive: true, mode: 0o700 });
  const sleep = o.sleep ?? ((ms: number) => Bun.sleepSync(ms));
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      try {
        writeSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (lockAbandoned(lock) || Date.now() > deadline) {
        try { unlinkSync(lock); } catch { /* another writer broke it first */ }
        continue;
      }
      sleep(5 + Math.random() * 20);
    }
  }
  try {
    return fn();
  } finally {
    try { unlinkSync(lock); } catch { /* broken by a writer that thought it abandoned */ }
  }
}

/** A lock whose holder is dead, or that is older than LOCK_STALE_MS. Unreadable or vanished: not abandoned
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

function readEntries(home: CroftHome): RegistryEntry[] {
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
  return raw.filter(isEntry).map((e) => ({ root: e.root, addedAt: e.addedAt, via: e.via }));
}

function isEntry(v: unknown): v is RegistryEntry {
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

function writeEntries(home: CroftHome, entries: RegistryEntry[]): void {
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
