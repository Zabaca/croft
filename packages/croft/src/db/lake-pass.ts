// The lake's maintenance for a project (DESIGN.md D149 to D152; option 07, slice 3): when a pass is due, running it under croft's lock on the
// lake's writes, and what croft remembers of it (runs.sqlite, setting `lake.maintenance`) for `croft status` and `croft doctor`.
//
// The steps and the promise they keep are db/lake-maintenance.ts. This module is the project around them:
// - a pass is due `lake.maintenance.everyHours` after the last one that worked (an hour after one that failed, so a store that was down
//   is tried again soon); a lake croft has not yet seen is stamped when first looked at, so a new lake is not maintained on its first
//   day, and a project whose tests run in minutes never runs a pass (the clock is CROFT_NOW-aware, so a test advances it);
// - it runs after a run (run/runner.ts), from the scheduler's tick (a detached `croft maintain --due`, schedule/tick.ts) and on demand
//   (`croft maintain`); each asks whether one is due, and a pass takes the lake's write lock for its whole body, so it never runs while a
//   write holds the lock and a write waits for it;
// - a pass that fails never fails the run or the tick that started it: the failure is kept (state.lastError) and shown by `croft status`
//   and `croft doctor`; the lake is as the failed step left it, which every step is safe to run again from;
// - a backup that is copying the bucket (db/lake.ts markBackupRunning) keeps passes from running meanwhile;
// - the trash is pruned first, then the snapshots its versions pin are asked for: the lake keeps what the trash keeps.
import { CroftError, problem } from "../core/errors.ts";
import { currentIdentity, type ProcessIdentity, recordAlive } from "../core/proc.ts";
import type { Problem } from "../core/types.ts";
import { RunsDb } from "../history/runs-db.ts";
import type { ProjectEnv } from "../project/env.ts";
import type { Project } from "../project/root.ts";
import { pinnedSnapshots, pruneTrash } from "../safety/trash.ts";
import { backupRunning, lakeOption, MAINTENANCE_LOCK_LABEL } from "./lake.ts";
import {
  ageBasedExpiryOptions, deleteOrphans, type ExpiryOption, lakeStats, type LakeStats, listOrphans, type PassReport, planExpiry, type RetryPolicy, readPlanInput, runPass,
  type StepName,
} from "./lake-maintenance.ts";
import { ensureState, maintenanceDue, type MaintenanceState, type PassSummary, writeState } from "./lake-maintenance-state.ts";
import { openWarehouse } from "./warehouse.ts";

// ---- Running a pass ------------------------------------------------------------------------------------------------

export type PassStatus =
  /** The pass ran, and every step worked. */
  | "ran"
  /** A step still failed after its retries: the report says which; the lake is usable. */
  | "failed"
  /** Nobody has written the lake yet: nothing to maintain. */
  | "no_lake"
  /** A write (or another pass) held the lake's lock for the whole wait: not an attempt; the next try goes on. */
  | "busy"
  /** A backup is copying the bucket: a pass would delete files it needs. */
  | "backup_running"
  /** Another pass is running, started by another process. */
  | "running";

export interface PassOutcome {
  status: PassStatus;
  report?: PassReport;
  /** The problem that ended a pass that failed, redacted. */
  problem?: Problem;
}

export interface MaintainInput {
  now: Date;
  /** The project's runs.sqlite, when the caller has it open; else it is opened here, and closed. */
  runs?: RunsDb;
  isTTY: boolean;
  /** How long to wait for the lake's lock (default: a write's own wait). */
  waitMs?: number;
  retry?: RetryPolicy;
  onStep?: (step: StepName) => void | Promise<void>;
  onWait?: (holder: import("../core/types.ts").LockHolder, waitedMs: number) => void;
}

/** A pass summary without the details only the report has. */
function summarize(r: PassReport): PassSummary {
  return {
    startedAt: r.startedAt, tookMs: r.tookMs, ok: r.ok, expired: r.plan.expired,
    steps: r.steps.map((s) => ({ step: s.step, status: s.status, tookMs: s.tookMs, attempts: s.attempts })), before: r.before, after: r.after,
  };
}

/**
 * Run one pass now, whether or not one is due: the trash pruned, the pins asked for, then the steps under croft's lock on the lake's
 * writes. The outcome is recorded in runs.sqlite, except for a pass that never started (busy, a backup copying, nothing to maintain).
 */
export async function maintainProject(project: Project, env: ProjectEnv, o: MaintainInput): Promise<PassOutcome> {
  const stateDir = project.paths.stateDir;
  if (backupRunning(stateDir)) return { status: "backup_running" };
  const ownRuns = o.runs === undefined;
  const runs = o.runs ?? RunsDb.open(stateDir);
  try {
    // A lake nobody has written is not made by a pass.
    if (!(await lakeExists(project, env))) return { status: "no_lake" };
    const id = currentIdentity();
    const claimed = claim(runs, o.now, id);
    if (!claimed) return { status: "running" };
    let outcome: PassOutcome = { status: "failed" };
    let attempted = true;
    const warehouse = openWarehouse({
      path: project.paths.database, mode: "read_write", timezone: project.timezone, root: project.root, stateDir, ...lakeOption(project, env),
      isTTY: o.isTTY, register: false, ...(o.onWait ? { onWait: o.onWait } : {}),
    });
    try {
      // Pruned first, and the pins asked for after: a version the trash lets go no longer holds a snapshot.
      try {
        pruneTrash(stateDir, { now: o.now });
      } catch {
        // Housekeeping; the next trash or croft doctor tries again.
      }
      const pins = pinnedSnapshots(stateDir);
      const report = await warehouse.write(MAINTENANCE_LOCK_LABEL, (sql) => runPass(sql, {
        now: o.now, pins, ...(o.retry ? { retry: o.retry } : {}), ...(o.onStep ? { onStep: o.onStep } : {}),
      }), { runId: "maintenance", transaction: false, touchesLake: false, ...(o.waitMs !== undefined ? { waitMs: o.waitMs } : {}) });
      // A step's error reached us as text the lake's own code produced: the credentials are taken out before it is kept or shown.
      for (const s of report.steps) if (s.error) s.error = warehouse.redact(s.error);
      outcome = { status: report.ok ? "ran" : "failed", report };
      if (!report.ok) {
        const bad = report.steps.find((s) => s.status === "failed");
        outcome.problem = problem("LAKE_MAINTENANCE_FAILED", {
          message: `the lake's maintenance pass failed at the ${bad?.step ?? "first"} step after ${bad?.attempts ?? 1} ${bad?.attempts === 1 ? "try" : "tries"}: ${bad?.error ?? "unknown"}`,
          hint: "the lake is usable and nothing was lost; croft tries again within the hour, or croft maintain now (croft docs LAKE_MAINTENANCE_FAILED)",
          retryable: true,
          details: { step: bad?.step ?? null, attempts: bad?.attempts ?? null, steps: report.steps.map((s) => ({ step: s.step, status: s.status })) },
        });
      }
    } catch (e) {
      if (e instanceof CroftError && (e.code === "DB_BUSY" || e.code === "DB_HELD_BY_OTHER_PROGRAM")) {
        attempted = false;
        outcome = { status: "busy", problem: e.problem };
      } else {
        const p = e instanceof CroftError ? e.problem : problem("LAKE_MAINTENANCE_FAILED", {
          message: `the lake's maintenance pass could not run: ${warehouse.redact(String((e as Error)?.message ?? e).split("\n")[0]!).slice(0, 300)}`,
          hint: "croft tries again within the hour, or croft maintain now", retryable: true,
        });
        outcome = { status: "failed", problem: p };
      }
    } finally {
      await warehouse.close();
      finish(runs, o.now, outcome, attempted);
    }
    return outcome;
  } finally {
    if (ownRuns) runs.close();
  }
}

/** Mark a pass as running in runs.sqlite, unless a live process already has; true when this process now holds the claim. */
function claim(runs: RunsDb, now: Date, id: ProcessIdentity): boolean {
  return runs.transaction(() => {
    const s = ensureState(runs, now);
    if (s.running && s.running.pid !== id.pid && recordAlive(s.running)) return false;
    writeState(runs, { ...s, running: { ...id, at: now.toISOString() } });
    return true;
  });
}

/** Record how the pass ended, and release the claim. A pass that never got to run (busy) is not an attempt. */
function finish(runs: RunsDb, now: Date, outcome: PassOutcome, attempted: boolean): void {
  try {
    runs.transaction(() => {
      const s = ensureState(runs, now);
      const next: MaintenanceState = { ...s, running: null, spawnedAt: null };
      if (attempted) {
        next.lastAttemptAt = now.toISOString();
        if (outcome.status === "ran" && outcome.report) {
          next.lastOkAt = now.toISOString();
          next.last = summarize(outcome.report);
          next.lastError = null;
        } else {
          const bad = outcome.report?.steps.find((x) => x.status === "failed");
          if (outcome.report) next.last = summarize(outcome.report);
          next.lastError = {
            at: now.toISOString(), step: bad?.step ?? null, code: outcome.problem?.code ?? "LAKE_MAINTENANCE_FAILED",
            message: (outcome.problem?.message ?? bad?.error ?? "the pass failed").slice(0, 500),
          };
        }
      }
      writeState(runs, next);
    });
  } catch {
    // The pass is done; its record is housekeeping.
  }
}

/** Whether the lake has been written: a read-only attach finds it (a lake nobody has written is DB_NOT_FOUND with `notCreated`). */
export async function lakeExists(project: Project, env: ProjectEnv): Promise<boolean> {
  const { join } = await import("node:path");
  const probe = openWarehouse({
    path: join(project.paths.stateDir, "lake-maintenance.probe"), mode: "read_only", profile: "query", timezone: project.timezone, root: project.root,
    stateDir: project.paths.stateDir, ...lakeOption(project, env), isTTY: false, register: false, noticeAfterMs: Number.MAX_SAFE_INTEGER,
  });
  try {
    await probe.read(async () => undefined, { purpose: "lake maintenance", waitMs: 30_000 });
    return true;
  } catch (e) {
    if (e instanceof CroftError && e.code === "DB_NOT_FOUND" && e.problem.details?.notCreated === true) return false;
    throw e;
  } finally {
    await probe.close();
  }
}

/**
 * The hook after a run and from the scheduler: run a pass if one is due. Returns null when none was due (or maintenance is off, or this
 * is no lake). Never throws: a pass that fails is recorded, and a failure to even look is the caller's no concern.
 */
export async function maintainIfDue(project: Project, env: ProjectEnv, o: MaintainInput): Promise<PassOutcome | null> {
  const lake = project.config.lake;
  if (!lake || !lake.maintenance.enabled) return null;
  const ownRuns = o.runs === undefined;
  let runs: RunsDb | undefined;
  try {
    runs = o.runs ?? RunsDb.open(project.paths.stateDir);
    const state = ensureState(runs, o.now);
    if (!maintenanceDue(state, lake.maintenance, o.now).due) return null;
    return await maintainProject(project, env, { ...o, runs });
  } catch (e) {
    const p = e instanceof CroftError ? e.problem : problem("LAKE_MAINTENANCE_FAILED", {
      message: `the lake's maintenance could not start: ${String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 300)}`,
      hint: "croft tries again within the hour, or croft maintain now", retryable: true,
    });
    return { status: "failed", problem: p };
  } finally {
    if (ownRuns) runs?.close();
  }
}

// ---- What a pass would do, without doing it ---------------------------------------------------------------------------

export interface MaintenancePlan {
  stats: LakeStats;
  /** The snapshots the promise lets go, how many stay, and why. */
  expire: number;
  total: number;
  kept: number;
  because: { window: number; windowStart: number; versions: number; pinned: number; latest: number };
  assets: Record<string, number>;
  /** The snapshots the trash pins. */
  pins: number[];
  /** Expiry options another tool stored on the lake: a CHECKPOINT by anyone would expire by them. */
  expiryOptions: ExpiryOption[];
}

/** Read the lake with the read-only login and say what a pass would expire; nothing is written. Null when nobody has written the lake. */
export async function planProject(project: Project, env: ProjectEnv, o: { now: Date }): Promise<MaintenancePlan | null> {
  const { join } = await import("node:path");
  const stateDir = project.paths.stateDir;
  const w = openWarehouse({
    path: join(stateDir, "lake-maintenance.probe"), mode: "read_only", profile: "query", timezone: project.timezone, root: project.root, stateDir,
    ...lakeOption(project, env), isTTY: false, register: false, noticeAfterMs: Number.MAX_SAFE_INTEGER,
  });
  try {
    // The trash as the pass would find it: its expired versions do not pin anything.
    const pins = pinnedSnapshots(stateDir);
    return await w.read(async (db) => {
      const stats = await lakeStats(db);
      const { snapshots, tables } = await readPlanInput(db);
      const plan = planExpiry(snapshots, tables, { now: o.now, pins });
      const expiryOptions = await ageBasedExpiryOptions(db);
      return { stats, expire: plan.expire.length, total: plan.total, kept: plan.kept, because: plan.because, assets: plan.assets, pins, expiryOptions };
    }, { purpose: "lake maintenance", waitMs: 60_000 });
  } catch (e) {
    if (e instanceof CroftError && e.code === "DB_NOT_FOUND" && e.problem.details?.notCreated === true) return null;
    throw e;
  } finally {
    await w.close();
  }
}

// ---- Files that are not the lake's own ---------------------------------------------------------------------------------

/** The files in the lake's folder that the catalog does not name and that are a day old, listed and not touched. The read-only login lists. */
export async function listOrphansOf(project: Project, env: ProjectEnv, o: { retry?: RetryPolicy } = {}): Promise<string[] | null> {
  const { join } = await import("node:path");
  const stateDir = project.paths.stateDir;
  const w = openWarehouse({
    path: join(stateDir, "lake-maintenance.probe"), mode: "read_only", profile: "query", timezone: project.timezone, root: project.root, stateDir,
    ...lakeOption(project, env), isTTY: false, register: false, noticeAfterMs: Number.MAX_SAFE_INTEGER,
  });
  try {
    return await w.read((db) => listOrphans(db, o.retry).then((r) => r.files), { purpose: "lake orphans", waitMs: 60_000 });
  } catch (e) {
    if (e instanceof CroftError && e.code === "DB_NOT_FOUND" && e.problem.details?.notCreated === true) return null;
    throw e;
  } finally {
    await w.close();
  }
}

/** Delete the orphans the person was shown, under croft's lock on the lake's writes; null when the files found now are not exactly those. */
export async function deleteOrphansOf(project: Project, env: ProjectEnv, shown: readonly string[], o: { isTTY: boolean; waitMs?: number; retry?: RetryPolicy }): Promise<string[] | null> {
  const stateDir = project.paths.stateDir;
  if (backupRunning(stateDir)) {
    throw new CroftError("DB_BUSY", { message: "a backup of the lake is copying its bucket now", hint: "run croft maintain --orphans again when it has finished", retryable: true });
  }
  const warehouse = openWarehouse({
    path: project.paths.database, mode: "read_write", timezone: project.timezone, root: project.root, stateDir, ...lakeOption(project, env), isTTY: o.isTTY, register: false,
  });
  try {
    const done = await warehouse.write(MAINTENANCE_LOCK_LABEL, (sql) => deleteOrphans(sql, shown, o.retry), {
      runId: "maintenance", transaction: false, touchesLake: false, ...(o.waitMs !== undefined ? { waitMs: o.waitMs } : {}),
    });
    return done ? done.files : null;
  } finally {
    await warehouse.close();
  }
}
