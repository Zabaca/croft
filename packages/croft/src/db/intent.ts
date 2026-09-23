// Write intents (DESIGN.md §5 "Server mode": "Write intents"). Before a process opens the warehouse
// read-write it announces itself with its own file, <state>/write-intent.d/<pid>-<procStart>.json.
// croft serve and direct @zabaca/croft/read readers stay closed while any *live* entry exists.
//
// One file per holder, not one shared file: with a shared file, the first of two overlapping writers
// deleted it on finishing, the server reopened within 14–38 ms and locked the second writer out [V].
// Liveness compares pid, process start time and boot id (core/proc.ts), because PIDs are reused.
// It uses no Bun-only APIs, so read.ts can import it.
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { bootId, currentIdentity, isAlive, type ProcessIdentity } from "../core/proc.ts";

export interface Intent extends ProcessIdentity {
  runId: string | null;
  since: string; // ISO instant
}
export interface IntentEntry extends Intent { file: string }

export const INTENT_DIR = "write-intent.d";

export function intentDir(stateDir: string): string {
  return join(stateDir, INTENT_DIR);
}

// procStart is digits today (epoch seconds on macOS, clock ticks on Linux), but an intent written by an
// older croft holds `ps -o lstart` text ("Tue Sep 23 07:11:00 2026"); keep file names portable.
const safe = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");

export function intentFileName(id: ProcessIdentity): string {
  return `${id.pid}-${safe(id.procStart)}.json`;
}

interface Held { count: number; intent: Intent; file: string; written: boolean }
const held = new Map<string, Held>(); // by intent directory

function writeAtomically(dir: string, file: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${file}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o644); // O_CREAT | O_EXCL: never clobber another writer's temp file
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, join(dir, file)); // readers see the whole file or nothing
}

/**
 * Announce this process as a writer. Reference counted in-process: the file is written on the first
 * acquire and removed on the matching last release. Returns the intent.
 */
export function acquire(stateDir: string, o: { runId?: string | null } = {}): Intent {
  const dir = intentDir(stateDir);
  const h = held.get(dir);
  if (h) {
    h.count++;
    if (!h.written) resume(stateDir);
    return h.intent;
  }
  const intent: Intent = { ...currentIdentity(), runId: o.runId ?? null, since: new Date().toISOString() };
  const file = intentFileName(intent);
  writeAtomically(dir, file, JSON.stringify(intent) + "\n");
  held.set(dir, { count: 1, intent, file, written: true });
  return intent;
}

/** Drop one reference; the last one removes the file. Call only after the instance's closeSync() returned. */
export function release(stateDir: string): void {
  const dir = intentDir(stateDir);
  const h = held.get(dir);
  if (!h) return;
  if (--h.count > 0) return;
  held.delete(dir);
  rmSync(join(dir, h.file), { force: true });
}

/**
 * Withdraw the intent file while keeping the references, for a writer blocked by a foreign program
 * (DuckDB UI, DBeaver): croft serve keeps serving meanwhile. resume() writes it back.
 */
export function withdraw(stateDir: string): void {
  const dir = intentDir(stateDir);
  const h = held.get(dir);
  if (!h || !h.written) return;
  rmSync(join(dir, h.file), { force: true });
  h.written = false;
}

export function resume(stateDir: string): void {
  const dir = intentDir(stateDir);
  const h = held.get(dir);
  if (!h || h.written) return;
  writeAtomically(dir, h.file, JSON.stringify(h.intent) + "\n");
  h.written = true;
}

/** This process's reference count for a state folder (0 when it holds no intent). */
export function heldCount(stateDir: string): number {
  return held.get(intentDir(stateDir))?.count ?? 0;
}

function parse(file: string, text: string): IntentEntry | null {
  try {
    const v = JSON.parse(text) as Partial<Intent>;
    if (typeof v.pid !== "number" || typeof v.procStart !== "string" || typeof v.bootId !== "string") return null;
    return { pid: v.pid, procStart: v.procStart, bootId: v.bootId, runId: v.runId ?? null, since: String(v.since ?? ""), file };
  } catch {
    return null;
  }
}

/** Every intent file in the folder, live or not. Unreadable files are reported with pid -1. */
export function listIntents(stateDir: string): IntentEntry[] {
  const dir = intentDir(stateDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: IntentEntry[] = [];
  for (const name of names) {
    if (name.startsWith(".") || !name.endsWith(".json")) continue;
    const file = join(dir, name);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // removed between readdir and read
    }
    out.push(parse(file, text) ?? { pid: -1, procStart: "", bootId: "", runId: null, since: "", file });
  }
  return out;
}

// Liveness is polled every 50 ms by the server, and on macOS isAlive() spawns `ps`. A signal-0 probe
// answers "no such process" without spawning; a confirmed start-time match is trusted for a second.
const confirmed = new Map<string, number>();

/**
 * The one liveness check for intent holders (server, doctor, @zabaca/croft/read): same boot and same
 * process start time, not only the PID, because PIDs are reused after a reboot.
 */
export function isHolderAlive(id: ProcessIdentity): boolean {
  if (id.pid <= 0 || id.bootId !== bootId()) return false;
  try {
    process.kill(id.pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false; // EPERM: alive, owned by someone else
  }
  const key = `${id.pid}\0${id.procStart}`;
  const at = confirmed.get(key);
  if (at !== undefined && Date.now() - at < 1000) return true;
  const alive = isAlive(id);
  if (alive) {
    if (confirmed.size > 1000) confirmed.clear();
    confirmed.set(key, Date.now());
  } else confirmed.delete(key);
  return alive;
}

/** Intents whose holder is still running (same boot, same process start time). */
export function liveIntents(stateDir: string, o: { excludeSelf?: boolean } = {}): IntentEntry[] {
  const me = currentIdentity();
  return listIntents(stateDir).filter((i) => {
    if (i.pid < 0) return false;
    if (o.excludeSelf && i.pid === me.pid && i.procStart === me.procStart) return false;
    return isHolderAlive(i);
  });
}

/** Remove intents whose holder is dead, and temp files older than a minute. Returns the removed intents. */
export function purgeDead(stateDir: string): IntentEntry[] {
  const removed: IntentEntry[] = [];
  for (const i of listIntents(stateDir)) {
    if (i.pid >= 0 && isHolderAlive(i)) continue;
    rmSync(i.file, { force: true });
    removed.push(i);
  }
  const dir = intentDir(stateDir);
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(".") || !name.endsWith(".tmp")) continue;
      const file = join(dir, name);
      try {
        if (Date.now() - statSync(file).mtimeMs > 60_000) rmSync(file, { force: true });
      } catch {}
    }
  } catch {}
  return removed;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Wait until no live intent (other than this process's) remains, polling every `pollMs` (50 ms default;
 * fs.watch is not relied on, because macOS merges and drops its events). Resolves true when clear,
 * false on timeout.
 */
export async function waitForNoIntents(stateDir: string, o: { timeoutMs: number; pollMs?: number; signal?: AbortSignal }): Promise<boolean> {
  const deadline = Date.now() + o.timeoutMs;
  for (;;) {
    if (liveIntents(stateDir, { excludeSelf: true }).length === 0) return true;
    if (Date.now() >= deadline || o.signal?.aborted) return false;
    await sleep(Math.min(o.pollMs ?? 50, Math.max(1, deadline - Date.now())));
  }
}
