// Asset leases (DESIGN.md §5 "Leases"): only one run touches an asset at a time. A lease stores
// its holder's {pid, procStart, bootId}. It is dead when that exact process is gone (a PID alone
// is not enough, because PIDs are reused after a reboot), and the next acquire reclaims a dead
// lease, so a kill -9 can never leave an asset busy forever.
import { setTimeout as sleep } from "node:timers/promises";
import { CroftError } from "../core/errors.ts";
import { currentIdentity, recordAlive, type ProcessIdentity } from "../core/proc.ts";
import type { RunsDb } from "./runs-db.ts";

export interface Lease { asset: string; runId: string; pid: number; procStart: string; bootId: string; since: string }

export type TryAcquireResult =
  | { ok: true; leases: Lease[]; reclaimed: Lease[] }
  | { ok: false; busy: Lease[]; reclaimed: Lease[] };

export interface AcquireOptions {
  waitMs?: number;                     // how long to wait for a busy asset; default DEFAULT_WAIT_MS
  noWait?: boolean;                    // `--no-wait`: ASSET_BUSY at once
  signal?: AbortSignal;                // Ctrl-C while waiting → INTERRUPTED
  identity?: ProcessIdentity;          // defaults to this process
  onWait?: (busy: Lease[]) => void;    // called once, when waiting starts, so the CLI can name the holder
}

/** Off a TTY every wait is capped at 90 s (§5 "Default waits"); callers pass longer TTY/schedule waits. */
export const DEFAULT_WAIT_MS = 90_000;

interface LeaseRow { asset: string; run_id: string; pid: number; proc_start: string | null; boot_id: string | null; since: string }

function toLease(r: LeaseRow): Lease {
  return { asset: r.asset, runId: r.run_id, pid: r.pid, procStart: r.proc_start ?? "", bootId: r.boot_id ?? "", since: r.since };
}

function assetList(assets: string | string[]): string[] {
  // Sorted and de-duplicated: a stable order keeps the SQL (and any future per-asset locking) deadlock-free.
  return [...new Set(typeof assets === "string" ? [assets] : assets)].sort();
}

function sameProcess(l: Lease, id: ProcessIdentity): boolean {
  return l.pid === id.pid && l.procStart === id.procStart && l.bootId === id.bootId;
}

/** True while the process that took the lease is still running. A lease without a start time names no
 *  process croft recorded (dead); an empty boot id is unknown, not dead: the PID and start time decide. */
export function leaseAlive(l: Lease): boolean {
  if (!l.procStart) return false;
  if (sameProcess(l, currentIdentity())) return true;   // skip the `ps` spawn for our own leases
  return recordAlive(l);
}

function rowsFor(db: RunsDb, assets: string[]): Lease[] {
  const rows = db.sqlite
    .query(`SELECT * FROM leases WHERE asset IN (${assets.map(() => "?").join(", ")})`)
    .all(...assets) as LeaseRow[];
  return rows.map(toLease);
}

/** Delete a dead lease only if it is still the exact row we judged dead (NULL and "" read alike, as toLease
 *  reads them). */
function deleteIfUnchanged(db: RunsDb, l: Lease): boolean {
  return db.sqlite
    .query("DELETE FROM leases WHERE asset = ? AND run_id = ? AND pid = ? AND coalesce(proc_start, '') = ? AND coalesce(boot_id, '') = ?")
    .run(l.asset, l.runId, l.pid, l.procStart, l.bootId).changes === 1;
}

/**
 * Take every lease in `assets` for `runId`, or none of them. All-or-nothing means a run never
 * holds some assets while waiting for others, so two runs with overlapping selections cannot
 * deadlock. Leases this process already holds for the same run are kept (re-entrant).
 */
export function tryAcquire(db: RunsDb, assets: string | string[], runId: string,
  identity: ProcessIdentity = currentIdentity()): TryAcquireResult {
  const wanted = assetList(assets);
  if (wanted.length === 0) return { ok: true, leases: [], reclaimed: [] };
  return db.transaction(() => {
    const busy: Lease[] = [];
    const reclaimed: Lease[] = [];
    const held = new Set<string>();
    for (const l of rowsFor(db, wanted)) {
      if (l.runId === runId && sameProcess(l, identity)) held.add(l.asset);
      else if (leaseAlive(l)) busy.push(l);
      else if (deleteIfUnchanged(db, l)) reclaimed.push(l);
    }
    if (busy.length > 0) return { ok: false, busy, reclaimed };
    const insert = db.sqlite.query(
      "INSERT INTO leases (asset, run_id, pid, proc_start, boot_id, since) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const since = db.nowIso();
    for (const asset of wanted) {
      if (!held.has(asset)) insert.run(asset, runId, identity.pid, identity.procStart, identity.bootId, since);
    }
    return { ok: true, leases: rowsFor(db, wanted), reclaimed };
  });
}

function interrupted(assets: string[]): CroftError {
  return new CroftError("INTERRUPTED", {
    message: `stopped while waiting for ${assets.join(", ")}`, hint: "nothing was changed; run the command again",
  });
}

async function pause(ms: number, signal: AbortSignal | undefined, assets: string[]): Promise<void> {
  try {
    await sleep(ms, undefined, signal ? { signal } : undefined);
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") throw interrupted(assets);
    throw e;
  }
}

/**
 * Acquire leases, waiting up to `waitMs` (0 with `noWait`) for busy assets. Dead holders are
 * reclaimed on the way. Throws ASSET_BUSY naming the holding run when the wait runs out.
 */
export async function acquire(db: RunsDb, assets: string | string[], runId: string,
  o: AcquireOptions = {}): Promise<Lease[]> {
  const wanted = assetList(assets);
  const waitMs = o.noWait ? 0 : (o.waitMs ?? DEFAULT_WAIT_MS);
  const started = Date.now();
  let delay = 25;
  let told = false;
  for (;;) {
    if (o.signal?.aborted) throw interrupted(wanted);
    const r = tryAcquire(db, wanted, runId, o.identity);
    if (r.ok) return r.leases;
    const waited = Date.now() - started;
    if (waited >= waitMs) throw busyError(db, r.busy[0]!, waited);
    if (!told) {
      o.onWait?.(r.busy);
      told = true;
    }
    // Jittered backoff from 25 ms up to 1 s, as for DuckDB lock conflicts (§5).
    await pause(Math.min(delay * (0.5 + Math.random()), waitMs - waited), o.signal, wanted);
    delay = Math.min(delay * 2, 1000);
  }
}

/** Release this run's leases (all of them, or just `assets`). Returns the released asset names. */
export function release(db: RunsDb, runId: string, assets?: string | string[]): string[] {
  return db.transaction(() => {
    const names = assets === undefined
      ? (db.sqlite.query("SELECT asset FROM leases WHERE run_id = ? ORDER BY asset").all(runId) as { asset: string }[]).map((r) => r.asset)
      : assetList(assets);
    const del = db.sqlite.query("DELETE FROM leases WHERE asset = ? AND run_id = ?");
    return names.filter((a) => del.run(a, runId).changes === 1);
  });
}

/** The live holder of an asset, or null. A dead holder's lease is reclaimed on the way. */
export function holderOf(db: RunsDb, asset: string): Lease | null {
  const [l] = rowsFor(db, [asset]);
  if (!l) return null;
  if (leaseAlive(l)) return l;
  deleteIfUnchanged(db, l);
  return null;
}

export function listLeases(db: RunsDb): (Lease & { alive: boolean })[] {
  return (db.sqlite.query("SELECT * FROM leases ORDER BY asset").all() as LeaseRow[])
    .map(toLease)
    .map((l) => ({ ...l, alive: leaseAlive(l) }));
}

/** Delete every lease whose holder is gone. Returns what was reclaimed. */
export function reclaimDead(db: RunsDb): Lease[] {
  return listLeases(db)
    .filter((l) => !l.alive && deleteIfUnchanged(db, l))
    .map(({ alive: _alive, ...l }) => l);
}

/**
 * Wait until nobody live holds `asset`, without taking it. Resolves null once it is free, or
 * with the holder when `timeoutMs` runs out.
 */
export async function waitFor(db: RunsDb, asset: string,
  o: { timeoutMs?: number; signal?: AbortSignal; pollMs?: number } = {}): Promise<Lease | null> {
  const timeoutMs = o.timeoutMs ?? DEFAULT_WAIT_MS;
  const started = Date.now();
  for (;;) {
    if (o.signal?.aborted) throw interrupted([asset]);
    const h = holderOf(db, asset);
    const left = timeoutMs - (Date.now() - started);
    if (!h || left <= 0) return h;
    await pause(Math.min(o.pollMs ?? 100, left), o.signal, [asset]);
  }
}

function ago(fromIso: string, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - Date.parse(fromIso)) / 1000));
  if (s < 90) return `${s} s`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

/** ASSET_BUSY for `holder`, naming its run the way `status` does. */
export function busyError(db: RunsDb, holder: Lease, waitedMs = 0): CroftError {
  const run = db.getRun(holder.runId);
  const kind = run?.trigger === "schedule" ? "a scheduled run" : "run";
  const command = run && run.argv.length > 0 ? `croft ${run.argv.join(" ")}` : undefined;
  const secs = waitedMs / 1000;
  const waited = waitedMs > 0 ? ` (waited ${secs < 10 ? secs.toFixed(1) : Math.round(secs)} s)` : "";
  return new CroftError("ASSET_BUSY", {
    message: `${holder.asset} is busy: ${kind} ${holder.runId} (pid ${holder.pid}) has held it for ${ago(holder.since, db.now())}${waited}`,
    hint: `wait for that run to finish (croft wait ${holder.runId}), then run again; nothing was changed`,
    asset: holder.asset,
    runId: holder.runId,
    retryable: true,
    fix: { kind: "command", description: "wait for the run that holds the asset", command: `croft wait ${holder.runId}` },
    details: {
      asset: holder.asset, waitedMs,
      heldBy: { runId: holder.runId, pid: holder.pid, since: holder.since, trigger: run?.trigger ?? null, command: command ?? null },
    },
  });
}
