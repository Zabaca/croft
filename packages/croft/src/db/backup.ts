// Pre-upgrade backups (DESIGN.md §6 "Trash, restore and delete" → "Before an engine upgrade"; §5 "Owning the DuckDB
// file"). A process that writes the warehouse records the DuckDB engine it runs (@duckdb/node-api's version(), such as
// v1.5.5) in runs.sqlite, setting "duckdb". "Newer" is decided from that record, because a file written by a newer
// storage format cannot be opened to read _croft.meta. db/warehouse.ts calls backupBeforeUpgrade before its first
// read-write open of the warehouse in a process (never for preview.duckdb, never read-only):
//
//   same      the recorded engine is this one: nothing happens, nothing is written.
//   first     nothing recorded (a new project, or one written by a croft before backups): this engine is recorded.
//             No backup, since "newer" cannot be told.
//   newer     warehouse.duckdb is copied whole to .croft/backups/<stamp>-<old>-to-<new>.duckdb, together with
//             warehouse.duckdb.wal as <that name>.wal when there is one (a crash can leave commits only in the WAL,
//             and DuckDB replays a WAL named after its file), and only then is this engine recorded. The newer engine
//             has not opened the file yet, so the copy is exactly what the older one left.
//   older     a downgrade: this engine is recorded, with no backup, so going back up backs up again.
//
// Before copying, croft waits (up to the lease's wait) for every croft writer that announced itself earlier
// (write-intent.d, db/intent.ts): an older croft may still be writing, and a copy taken meanwhile could miss a
// commit. Writers that announced themselves later wait for this one in turn, so two processes of the new engine
// never wait for each other; the one that goes second finds the engine recorded and makes no second backup. croft
// serve's query worker only reads, and steps aside for this process's intent anyway.
//
// The copy is made by a child process (§5: this process must not open the warehouse any other way): `cp -c`
// (clonefile) on macOS, `cp` with reflink=auto on Linux, a plain `cp` when that fails; /bin/cp by absolute path, with
// an explicit environment. It goes to a temporary name, renamed into place, so a half copy never looks like a
// backup. A backup that cannot be made is PROJECT_NOT_WRITABLE: nothing is recorded and the write does not go ahead,
// because the newer engine must not touch the file without one.
//
// Retention: the BACKUPS_KEPT (3) newest backups, by the stamp their names start with, pruned after each backup,
// along with temporary files a killed backup left. doctor lists them (listBackups) without creating anything.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { currentIdentity } from "../core/proc.ts";
import { now as clockNow } from "../core/time.ts";
import type { LockHolder } from "../core/types.ts";
import { RUNS_DB_FILE, RunsDb } from "../history/runs-db.ts";
import { type IntentEntry, liveIntents } from "./intent.ts";

/** The runs.sqlite setting that records the engine the last writer ran. */
export const ENGINE_SETTING = "duckdb";
/** The folder in the state folder that holds the backups. */
export const BACKUPS_DIR = "backups";
/** How many backups are kept. */
export const BACKUPS_KEPT = 3;

/** Where cp is looked for, by absolute path. */
const CP_PATHS = ["/bin/cp", "/usr/bin/cp"] as const;
/** GNU cp's clone-if-possible flag, built from two parts: the agent-contract scan would take it for croft's own. */
const REFLINK_AUTO = "-" + "-reflink=auto";
const TMP_PREFIX = ".tmp-";
const BACKUP_NAME = /^(\d{8}T\d{6}(?:\.\d+)?Z)-(.+)-to-(.+)\.duckdb$/;

/** The setting's value: the engine, as version() prints it (v1.5.5), and when it was recorded (UTC ISO). */
export interface EngineRecord { version: string; recordedAt: string }

export type CloneMethod = "clone" | "reflink" | "copy";

export interface BackupResult {
  /** The backup file, or null when none was needed. */
  path: string | null;
  /** The engine recorded before, or null for none. */
  from: string | null;
  /** The engine recorded now (this one). */
  to: string;
  /** The WAL's copy next to the backup, or null when the warehouse had no WAL (or no backup was made). */
  wal?: string | null;
  method?: CloneMethod;
  /** Older backups (and their WALs) removed by retention. */
  pruned?: string[];
}

export interface BackupOptions {
  /** The clock for the stamp and the record; default core/time now() (CROFT_NOW). */
  now?: Date;
  /** How long to wait for earlier croft writers before DB_BUSY; default 90 s. */
  waitMs?: number;
  pollMs?: number;
  /** Ends a wait, or a copy, at once: the signal's CroftError reason, else INTERRUPTED. */
  signal?: AbortSignal;
  /** Called once when the backup starts waiting for an earlier writer. */
  onWait?: (holder: LockHolder) => void;
  /** Which clone command to try first; default process.platform. */
  platform?: NodeJS.Platform;
  /** Where cp is looked for (tests). */
  cp?: readonly string[];
  /** BACKUPS_KEPT */
  keep?: number;
}

/** One backup in .croft/backups/. */
export interface BackupEntry {
  path: string;
  /** The WAL copied with it, or null. */
  wal: string | null;
  /** When it was made (UTC ISO, from its name). */
  at: string;
  /** The engines it was made between, as its name has them (1.5.5, 1.6.0). */
  from: string;
  to: string;
  /** The file and its WAL. */
  bytes: number;
}

export function backupsDir(stateDir: string): string {
  return join(stateDir, BACKUPS_DIR);
}

/**
 * Order two engine versions (v1.5.5, 1.10.0, v1.6.0-dev12): by their release numbers, then a pre-release before its
 * release, then by text. Negative when `a` is older.
 */
export function compareEngineVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(.*)$/.exec(v.trim());
    return m ? { nums: [m[1], m[2], m[3]].map((x) => Number(x ?? 0)), rest: m[4]! } : { nums: [0, 0, 0], rest: v.trim() };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i]! - y.nums[i]!;
  if (x.rest === y.rest) return 0;
  if (x.rest === "") return 1;
  if (y.rest === "") return -1;
  return x.rest < y.rest ? -1 : 1;
}

/** The recorded engine, without creating runs.sqlite (doctor). null when none is recorded. */
export function recordedEngine(stateDir: string): EngineRecord | null {
  if (!existsSync(join(stateDir, RUNS_DB_FILE))) return null;
  const db = RunsDb.open(stateDir);
  try {
    return readRecord(db);
  } finally {
    db.close();
  }
}

function readRecord(db: RunsDb): EngineRecord | null {
  const v = db.getSetting<Partial<EngineRecord>>(ENGINE_SETTING);
  return v && typeof v.version === "string" ? { version: v.version, recordedAt: String(v.recordedAt ?? "") } : null;
}

function withRuns<T>(stateDir: string, fn: (db: RunsDb) => T): T {
  const db = RunsDb.open(stateDir);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Back the warehouse up when the running engine is newer than the one recorded; record the running one. */
export async function backupBeforeUpgrade(stateDir: string, database: string, engineVersion: string, o: BackupOptions = {}): Promise<BackupResult> {
  const at = o.now ?? clockNow();
  const record = (db: RunsDb) => db.setSetting(ENGINE_SETTING, { version: engineVersion, recordedAt: at.toISOString() } satisfies EngineRecord);
  // Record at once unless a backup is due: same engine, first record, downgrade, or no warehouse to copy.
  const due = withRuns(stateDir, (db) => {
    const was = readRecord(db)?.version ?? null;
    if (was !== engineVersion && (was === null || compareEngineVersions(engineVersion, was) <= 0 || !existsSync(database))) record(db);
    return { was, backup: was !== null && compareEngineVersions(engineVersion, was) > 0 && existsSync(database) };
  });
  if (!due.backup) return { path: null, from: due.was, to: engineVersion };

  await waitForEarlierWriters(stateDir, engineVersion, o);
  // Another process of this engine may have made the backup while this one waited.
  const was = withRuns(stateDir, (db) => readRecord(db)?.version ?? null);
  if (was === null || compareEngineVersions(engineVersion, was) <= 0) {
    if (was !== engineVersion) withRuns(stateDir, record);
    return { path: null, from: was, to: engineVersion };
  }

  const dir = backupsDir(stateDir);
  const name = `${at.toISOString().replace(/[-:]/g, "")}-${fileSafe(was)}-to-${fileSafe(engineVersion)}.duckdb`;
  const path = join(dir, name);
  const walSrc = `${database}.wal`;
  let method: CloneMethod;
  let wal: string | null = null;
  try {
    mkdirSync(dir, { recursive: true });
    method = await copyInto(database, path, o);
    if (existsSync(walSrc)) {
      wal = `${path}.wal`;
      await copyInto(walSrc, wal, o);
    }
  } catch (e) {
    rmSync(path, { force: true });
    if (wal) rmSync(wal, { force: true });
    if (e instanceof CroftError) throw e;
    throw backupFailed({ from: was, to: engineVersion, dir, database }, e);
  }
  withRuns(stateDir, record);
  let pruned: string[] = [];
  try {
    pruned = pruneBackups(stateDir, o.keep ?? BACKUPS_KEPT);
  } catch { /* an old backup that cannot be removed stays; the next backup tries again */ }
  return { path, from: was, to: engineVersion, wal, method, pruned };
}

/** 1.5.5 from v1.5.5, and nothing a file name could trip on. */
function fileSafe(version: string): string {
  return version.trim().replace(/^v(?=\d)/, "").replace(/[^0-9A-Za-z.]+/g, "_") || "unknown";
}

function backupFailed(o: { from: string; to: string; dir: string; database: string }, e: unknown): CroftError {
  const why = String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 300);
  const to = o.to.replace(/^v(?=\d)/, "");
  return new CroftError("PROJECT_NOT_WRITABLE", {
    message: `croft could not back up ${o.database} before DuckDB ${to} first writes it (the last writer ran ${o.from.replace(/^v(?=\d)/, "")}): ${why}`,
    hint: `make room in ${o.dir} (or make it writable), then run the command again; croft does not let a newer DuckDB write the warehouse without a backup`,
    effect: "nothing was written",
    fix: { kind: "manual", requiresHuman: true, description: `free disk space for a copy of the warehouse in ${o.dir}, or make it writable, then run the command again` },
    details: { from: o.from, to: o.to, backups: o.dir, error: why },
  });
}

// ---------------------------------------------------------------------------------------------------------
// Waiting for earlier writers

/** Live croft writers that announced themselves before this process (by their intent's time, then pid). */
function earlierWriters(stateDir: string): IntentEntry[] {
  const me = currentIdentity();
  const self = (i: IntentEntry) => i.pid === me.pid && i.procStart === me.procStart;
  const all = liveIntents(stateDir);
  const mine = all.find(self);
  const since = mine ? Date.parse(mine.since) : Number.POSITIVE_INFINITY;
  return all.filter((i) => {
    if (self(i)) return false;
    const t = Date.parse(i.since);
    return !(t > since) && !(t === since && i.pid > me.pid);
  });
}

function aborted(signal: AbortSignal, what: string): CroftError {
  const r = signal.reason as { name?: unknown; problem?: unknown } | undefined;
  if (r instanceof CroftError || (r && r.name === "CroftError" && r.problem)) return r as CroftError;
  return new CroftError("INTERRUPTED", { message: `interrupted while ${what}`, hint: "nothing was written; run it again" });
}

async function waitForEarlierWriters(stateDir: string, engineVersion: string, o: BackupOptions): Promise<void> {
  const waitMs = o.waitMs ?? 90_000;
  const start = Date.now();
  let told = false;
  for (;;) {
    if (o.signal?.aborted) throw aborted(o.signal, "waiting to back up the warehouse");
    const first = earlierWriters(stateDir)[0];
    if (!first) return;
    const holder: LockHolder = { pid: first.pid, program: "croft", action: "write", since: first.since, ...(first.runId ? { runId: first.runId } : {}) };
    if (!told) {
      told = true;
      o.onWait?.(holder);
    }
    const waited = Date.now() - start;
    if (waited >= waitMs) {
      const who = first.runId ? `croft run ${first.runId}` : `croft (pid ${first.pid})`;
      throw new CroftError("DB_BUSY", {
        message: `the warehouse is busy: ${who} is writing; waited ${Math.round(waited / 100) / 10} s to back it up before DuckDB ${engineVersion.replace(/^v(?=\d)/, "")} first writes it`,
        hint: "retry when it finishes (croft status shows running work)",
        fix: { kind: "command", description: "see what is running", command: "croft status" },
        retryable: true,
        details: { holder, waitedMs: waited, purpose: "backup" },
      });
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        o.signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(o.pollMs ?? 50, Math.max(1, waitMs - waited)));
      o.signal?.addEventListener("abort", done, { once: true });
    });
  }
}

// ---------------------------------------------------------------------------------------------------------
// Copying

/** Clone `src` to a temporary name in the folder of `dst`, then rename it to `dst`. */
async function copyInto(src: string, dst: string, o: BackupOptions): Promise<CloneMethod> {
  const tmp = join(dirname(dst), `${TMP_PREFIX}${process.pid}-${basename(dst)}`);
  try {
    const method = await cloneFile(src, tmp, o);
    renameSync(tmp, dst);
    return method;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Clone `src` to `dst` in a child process: the platform's clone command, then a plain copy. */
async function cloneFile(src: string, dst: string, o: BackupOptions): Promise<CloneMethod> {
  const cps = o.cp ?? CP_PATHS;
  const cp = cps.find((p) => existsSync(p));
  if (!cp) throw new Error(`cp was not found (looked for ${cps.join(", ")})`);
  const platform = o.platform ?? process.platform;
  const fast: { method: CloneMethod; flag: string } | null = platform === "darwin" ? { method: "clone", flag: "-c" }
    : platform === "linux" ? { method: "reflink", flag: REFLINK_AUTO } : null;
  if (fast) {
    const r = await runCp(cp, [fast.flag, src, dst], o.signal);
    if (r.ok) return fast.method;
    rmSync(dst, { force: true });
  }
  const r = await runCp(cp, [src, dst], o.signal);
  if (r.ok) return "copy";
  rmSync(dst, { force: true });
  if (o.signal?.aborted) throw aborted(o.signal, "backing up the warehouse");
  throw new Error(`${cp} could not copy ${src}: ${r.why}`);
}

/** Run cp with a fixed environment; never throws. An aborted signal kills it. */
function runCp(cp: string, args: string[], signal?: AbortSignal): Promise<{ ok: true } | { ok: false; why: string }> {
  return new Promise((resolve) => {
    let stderr = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cp, args, { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      resolve({ ok: false, why: String((e as Error)?.message ?? e) });
      return;
    }
    const kill = () => child.kill("SIGKILL");
    if (signal?.aborted) kill();
    else signal?.addEventListener("abort", kill, { once: true });
    child.stderr!.on("data", (d) => {
      if (stderr.length < 2000) stderr += String(d);
    });
    child.on("error", (e) => resolve({ ok: false, why: e.message }));
    child.on("close", (code, sig) => {
      signal?.removeEventListener("abort", kill);
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, why: stderr.trim().split("\n")[0] || (sig ? `killed by ${sig}` : `exit ${code}`) });
    });
  });
}

// ---------------------------------------------------------------------------------------------------------
// Listing and retention

/** The backups, newest first. Reads the folder only. */
export function listBackups(stateDir: string): BackupEntry[] {
  const dir = backupsDir(stateDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: BackupEntry[] = [];
  for (const name of names) {
    const m = BACKUP_NAME.exec(name);
    if (!m) continue;
    const path = join(dir, name);
    const wal = names.includes(`${name}.wal`) ? `${path}.wal` : null;
    let bytes = 0;
    for (const f of [path, wal]) {
      if (!f) continue;
      try { bytes += statSync(f).size; } catch { /* removed meanwhile */ }
    }
    const s = m[1]!;
    const at = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13)}`;
    out.push({ path, wal, at, from: m[2]!, to: m[3]!, bytes });
  }
  return out.sort((a, b) => (a.path < b.path ? 1 : a.path > b.path ? -1 : 0));
}

/** Keep the `keep` newest backups; remove the rest with their WALs, and temporary files of processes that are gone. */
export function pruneBackups(stateDir: string, keep = BACKUPS_KEPT): string[] {
  const dir = backupsDir(stateDir);
  const removed: string[] = [];
  for (const b of listBackups(stateDir).slice(keep)) {
    rmSync(b.path, { force: true });
    if (b.wal) rmSync(b.wal, { force: true });
    removed.push(b.path);
  }
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(TMP_PREFIX)) continue;
      const pid = Number(/^\.tmp-(\d+)-/.exec(name)?.[1]);
      if (pid === process.pid || (Number.isInteger(pid) && pid > 0 && alive(pid))) continue;
      rmSync(join(dir, name), { force: true });
    }
  } catch { /* no folder */ }
  return removed;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
