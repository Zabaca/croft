// What croft remembers of a lake's maintenance, and when the next pass is due (DESIGN.md D150; option 07, slice 3). It lives in runs.sqlite
// (setting `lake.maintenance`), so `croft status`, the scheduler's tick and the run that has just ended can ask without opening the lake or
// the DuckDB library. The pass itself is db/lake-pass.ts.
import { problem } from "../core/errors.ts";
import { type ProcessIdentity, recordAlive } from "../core/proc.ts";
import type { Problem } from "../core/types.ts";
import type { RunsDb } from "../history/runs-db.ts";
import type { LakeMaintenanceConfig } from "../project/lake-config.ts";
import type { LakeStats, StepName } from "./lake-maintenance.ts";
import { storeTlsProblem } from "./store-tls.ts";

export const MAINTENANCE_SETTING = "lake.maintenance";

/** A failed pass is tried again after this long (or the interval, when that is shorter). */
export const RETRY_AFTER_FAILURE_MS = 60 * 60_000;
/** How long a pass the tick started is waited for before the tick starts another. */
export const SPAWN_GRACE_MS = 10 * 60_000;
const HOUR_MS = 3_600_000;

/** What a pass did, kept in runs.sqlite and shown by `croft status` (the full report is the command's output). */
export interface PassSummary {
  startedAt: string;
  tookMs: number;
  ok: boolean;
  expired: number;
  steps: { step: StepName; status: "ok" | "failed" | "skipped"; tookMs: number; attempts: number }[];
  before: LakeStats;
  after: LakeStats;
}

export interface MaintenanceState {
  /** When croft first looked at this lake: the interval counts from here until a pass has worked. */
  baselineAt: string;
  lastAttemptAt: string | null;
  lastOkAt: string | null;
  last: PassSummary | null;
  /** The last pass's failure, until a pass works. */
  lastError: { at: string; step: StepName | null; code: string; message: string } | null;
  /** A pass that is running now (its process), so another that finds it due too does not start a second. */
  running: (ProcessIdentity & { at: string }) | null;
  /** When the scheduler's tick started a pass that has not yet claimed the lake: the next tick leaves it be for a few minutes. */
  spawnedAt: string | null;
}

export function readState(runs: Pick<RunsDb, "getSetting">): MaintenanceState | null {
  const v = runs.getSetting<Partial<MaintenanceState>>(MAINTENANCE_SETTING);
  if (!v || typeof v.baselineAt !== "string") return null;
  return {
    baselineAt: v.baselineAt, lastAttemptAt: v.lastAttemptAt ?? null, lastOkAt: v.lastOkAt ?? null, last: v.last ?? null, lastError: v.lastError ?? null,
    running: v.running ?? null, spawnedAt: v.spawnedAt ?? null,
  };
}

export function writeState(runs: Pick<RunsDb, "setSetting">, s: MaintenanceState): void {
  runs.setSetting(MAINTENANCE_SETTING, s);
}

export interface Due {
  due: boolean;
  /** Why: `off` (the setting), `waiting` (the interval has not passed), `interval`, `retry` (the last pass failed), `running`. */
  why: "off" | "waiting" | "interval" | "retry" | "running";
  /** When the next pass is due (ISO), if it is not now. */
  at: string | null;
}

/** Whether a pass is due: `everyHours` after the last that worked (or after croft first looked), an hour after one that failed. */
export function maintenanceDue(state: MaintenanceState | null, cfg: LakeMaintenanceConfig, now: Date, alive: (p: ProcessIdentity) => boolean = recordAlive): Due {
  if (!cfg.enabled) return { due: false, why: "off", at: null };
  if (!state) return { due: false, why: "waiting", at: new Date(now.getTime() + cfg.everyHours * HOUR_MS).toISOString() };
  if (state.running && alive(state.running)) return { due: false, why: "running", at: null };
  if (state.spawnedAt && now.getTime() - Date.parse(state.spawnedAt) < SPAWN_GRACE_MS) return { due: false, why: "running", at: null };
  const interval = cfg.everyHours * HOUR_MS;
  const failedLast = state.lastError !== null && state.lastAttemptAt !== null && (state.lastOkAt === null || state.lastAttemptAt > state.lastOkAt);
  if (failedLast) {
    const at = Date.parse(state.lastAttemptAt!) + Math.min(interval, RETRY_AFTER_FAILURE_MS);
    return now.getTime() >= at ? { due: true, why: "retry", at: null } : { due: false, why: "waiting", at: new Date(at).toISOString() };
  }
  const at = Date.parse(state.lastOkAt ?? state.baselineAt) + interval;
  return now.getTime() >= at ? { due: true, why: "interval", at: null } : { due: false, why: "waiting", at: new Date(at).toISOString() };
}

/** The state, stamping the baseline the first time a lake is looked at. */
export function ensureState(runs: Pick<RunsDb, "getSetting" | "setSetting">, now: Date): MaintenanceState {
  const s = readState(runs);
  if (s) return s;
  const fresh: MaintenanceState = { baselineAt: now.toISOString(), lastAttemptAt: null, lastOkAt: null, last: null, lastError: null, running: null, spawnedAt: null };
  writeState(runs, fresh);
  return fresh;
}

/** The scheduler's tick has started a pass (a detached `croft maintain --due`). */
export function noteSpawned(runs: Pick<RunsDb, "getSetting" | "setSetting">, now: Date): void {
  writeState(runs, { ...ensureState(runs, now), spawnedAt: now.toISOString() });
}

/** What `croft status` and `croft doctor` show of the maintenance: the setting, the last pass, the next. Times are ISO (UTC). */
export interface MaintenanceView {
  enabled: boolean;
  everyHours: number;
  /** When the last pass that worked ended, and the last attempt (they differ when the last failed). */
  lastOkAt: string | null;
  lastAttemptAt: string | null;
  /** When the next pass is due; now or past when one is due; null when maintenance is off. */
  nextDueAt: string | null;
  /** The last pass: how long it took, how many snapshots it expired, and the lake's counts before and after. Null before the first. */
  lastPass: Pick<PassSummary, "tookMs" | "expired" | "before" | "after" | "ok"> | null;
  /** The failure of the last pass, until one works. */
  lastError: MaintenanceState["lastError"];
}

export function maintenanceView(state: MaintenanceState | null, cfg: LakeMaintenanceConfig, now: Date): MaintenanceView {
  const due = maintenanceDue(state, cfg, now);
  return {
    enabled: cfg.enabled, everyHours: cfg.everyHours, lastOkAt: state?.lastOkAt ?? null, lastAttemptAt: state?.lastAttemptAt ?? null,
    nextDueAt: !cfg.enabled ? null : due.due ? now.toISOString() : due.at,
    lastPass: state?.last ? { tookMs: state.last.tookMs, expired: state.last.expired, before: state.last.before, after: state.last.after, ok: state.last.ok } : null,
    lastError: state?.lastError ?? null,
  };
}

/** What a failed pass promises about trying again, said so that it is true: nothing runs by itself unless a croft command or the scheduler does
 *  (D-R5). A pass is due an hour after one that failed (RETRY_AFTER_FAILURE_MS). */
export const MAINTENANCE_RETRY = "a pass is due again an hour after one that failed, and the next croft run (or the scheduler's next tick, when croft schedule is on) makes it; croft maintain now makes it at once";

/**
 * The problem for the last pass's failure, as `croft status` and `croft doctor` show it (a warning: the data is as the last run left it).
 * A pass that stopped because the store's certificate did not check out is LAKE_STORE_TLS, with its fix, like every other command that meets it.
 */
export function failedPassProblem(e: NonNullable<MaintenanceState["lastError"]>, when: string): Problem {
  const parts = [e.step ? `at the ${e.step} step` : "", when].filter(Boolean).join(" ");
  const where = parts ? ` ${parts}` : "";
  const tls = e.code === "LAKE_STORE_TLS" ? storeTlsProblem(new Error(e.message)) : null;
  if (tls) return { ...tls, message: `the last maintenance pass failed${where}: ${e.message}`, severity: "warning" };
  return {
    ...problem("LAKE_MAINTENANCE_FAILED", {
      message: `the last maintenance pass failed${where}: ${e.message}`,
      hint: `the lake is usable and nothing was lost; ${MAINTENANCE_RETRY} (croft docs LAKE_MAINTENANCE_FAILED)`, retryable: true,
    }),
    severity: "warning",
  };
}
