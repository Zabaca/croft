// The project tick (DESIGN.md §8 "Each tick only plans and spawns"): what `croft tick` does in the project folder,
// every minute, for the per-user OS job (schedule/user-tick.ts) and for croft serve's loop (serve/loop.ts).
//
//   1. exit at once unless scheduling is on for the project (off or paused: `schedule off|pause` stop serve's
//      ticks too);
//   2. take the singleton (runs.sqlite tick row: pid and process start); another live tick means exit, since cron
//      can start overlapping ticks;
//   3. record the heartbeat (status and doctor call it stale after 3 min: SCHEDULER_STALE);
//   4. reconcile(), as every writing command does: runs whose process died become crashed and their leases go.
//      The warehouse is opened read-only, and only when a crashed step must be checked against it; a scheduled run
//      found crashed notifies, as one that failed does. With nothing to reconcile (no running run, lease, lock
//      holder, waiter or write intent) reconcile is not even loaded: it brings the database engine along;
//   5. compute the due work from runs.sqlite (schedule/due.ts): no asset code is imported unless an asset file
//      changed since the last tick;
//   6. settle the runs earlier ticks started that have ended (schedule/due.ts): a fire such a run did not attempt
//      (it met another run's lease, a hold that appeared after the tick, or its child died or refused before it
//      recorded the run) gets its previous last_fire_at back, so it stays due. A run that failed to start its assets
//      is a problem of this tick, notified as a crashed scheduled run is when nothing else recorded it, and its
//      assets wait RETRY_BACKOFF_MS before the next try (settings `schedule.failedStarts`);
//   7. start one detached `croft run --due <assets…>` per group of due assets (run/detach.ts: absolute Bun, an
//      explicit environment); the children take the leases. Each group's ingests get last_fire_at (the fire they
//      handle) and last_attempt_at before the child starts, together with the run, the fires and the values they
//      replaced (settings `schedule.spawned`), so a child that is still starting is not started again, and one
//      that never starts its assets gives the fire back. A spawn that fails is a failed start at once;
//   8. release the singleton and exit, usually within a second. It never runs asset work itself: launchd runs one
//      process per job, and a tick busy with a 40-minute transform would drop every later fire.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { CroftError, problem } from "../core/errors.ts";
import { currentIdentity, type ProcessIdentity, recordAlive } from "../core/proc.ts";
import type { Problem, Warehouse } from "../core/types.ts";
import { intentDir } from "../db/intent.ts";
import type { DuckWarehouse } from "../db/warehouse.ts";
import { newRunId, RunsDb } from "../history/runs-db.ts";
import type { Project } from "../project/root.ts";
import { CONFIRM_GRANT_ENV } from "../safety/confirm.ts";
import {
  type Alive, clockWords, dueWork, type FactsResolver, FAILED_STARTS_SETTING, type FailedStart, type FireTimes, RETRY_BACKOFF_MS,
  SPAWNED_SETTING, type SpawnedRun,
} from "./due.ts";
import { notifyScheduledFailure, type ScheduledFailure } from "./notify.ts";
import type { TickResult } from "./os.ts";

/** How long the tick's reconcile waits for the database (a run holding it is checked by a later tick). */
export const TICK_DB_WAIT_MS = 1000;

export interface SpawnRequest {
  root: string;
  stateDir: string;
  runId: string;
  /** The due assets the run takes (it adds what reads them). */
  assets: string[];
  /** The child's whole environment. */
  env: Record<string, string | undefined>;
}

/** Starts one detached `croft run --due`; throws when it cannot. */
export type RunSpawner = (r: SpawnRequest) => Promise<void>;

/** run/detach.ts spawnDetachedRun, loaded only when there is something to start. */
export const spawnDueRun: RunSpawner = async (r) => {
  const { spawnDetachedRun } = await import("../run/detach.ts");
  spawnDetachedRun({
    root: r.root, stateDir: r.stateDir, runId: r.runId, env: r.env, execPath: process.execPath, args: ["--due", ...r.assets],
  });
};

export interface TickInput {
  project: Project;
  /** The environment of the runs it starts (the tick's own, given to them explicitly). */
  env: Record<string, string | undefined>;
  /** CROFT_NOW-aware. */
  now: Date;
  spawn?: RunSpawner;
  /** This tick's process (tests run two in one process). */
  identity?: ProcessIdentity;
  /** Whether a recorded process still runs (the tick singleton, leases, runs a tick started). */
  alive?: Alive;
  resolve?: FactsResolver;
  fires?: FireTimes;
  /** Called once the singleton is held (tests: another tick tries meanwhile). */
  onClaimed?: () => Promise<void> | void;
  /** A scheduled run found crashed (schedule/notify.ts by default). */
  notify?: (root: string, failure: ScheduledFailure) => Promise<void>;
}

export interface TickOutcome {
  result: TickResult;
  /** Reconcile's warnings, facts that could not be read, runs that could not be started. */
  problems: Problem[];
}

/** One project tick (see the top of this file). Throws only for problems before it could start (runs.sqlite). */
export async function projectTick(i: TickInput): Promise<TickOutcome> {
  const t0 = performance.now();
  const { project, now } = i;
  const stateDir = project.paths.stateDir;
  const alive = i.alive ?? recordAlive;
  const result = (r: Partial<TickResult>): TickResult => ({
    exited: null, heartbeatAt: null, spawned: [], held: [], importedAssetCode: false, ...r, tookMs: Math.round(performance.now() - t0),
  });
  const runs = RunsDb.open(stateDir, { now: () => now });
  try {
    const scheduling = runs.getScheduling();
    if (scheduling.state !== "on") return { result: result({ exited: scheduling.state === "paused" ? "paused" : "scheduling_off" }), problems: [] };
    const id = i.identity ?? currentIdentity();
    if (!runs.claimTick((h) => alive({ pid: h.pid, procStart: h.procStart, bootId: null }), id)) {
      return { result: result({ exited: "another_tick" }), problems: [] };
    }
    try {
      await i.onClaimed?.();
      const heartbeatAt = now.toISOString();
      runs.heartbeat(heartbeatAt);
      const notify = i.notify ?? notifyScheduledFailure;
      const problems: Problem[] = [...await reconcileTick(project, runs, notify)];
      const work = await dueWork({
        project, runs, now, store: true, alive, ...(i.resolve ? { resolve: i.resolve } : {}), ...(i.fires ? { fires: i.fires } : {}),
      });
      problems.push(...work.problems);
      // The runs earlier ticks started that ended: the fires they did not attempt stay due, and a run whose child
      // never recorded it is notified here (nothing else knows of it).
      runs.transaction(() => {
        for (const r of work.rollbacks) if (runs.scheduleState(r.asset)?.lastFireAt === r.from) runs.putScheduleState(r.asset, { lastFireAt: r.to });
      });
      const failedStarts: FailedStart[] = work.failedStarts.map(({ fresh: _fresh, ...s }) => s);
      for (const s of work.failedStarts) if (s.fresh && s.unrecorded) await notifyFailedStart(notify, project.root, s);

      const spawn = i.spawn ?? spawnDueRun;
      // A confirmation grant is one run's; a scheduled run never carries one.
      const env = { ...i.env, [CONFIRM_GRANT_ENV]: undefined };
      const started: SpawnedRun[] = [];
      const noted: SpawnedRun[] = [...work.inFlight];
      for (const assets of work.groups) {
        const runId = newRunId(now, project.timezone);
        const fires: NonNullable<SpawnedRun["fires"]> = {};
        for (const a of assets) {
          const fire = work.fires.get(a);
          if (fire) fires[a] = { fire, before: runs.scheduleState(a)?.lastFireAt ?? null };
        }
        const entry: SpawnedRun = { runId, assets, at: heartbeatAt, ...(Object.keys(fires).length ? { fires } : {}) };
        // Recorded before the child starts, with the run: a child that is starting is not started again for the
        // same fire, and one that ends without attempting an asset gives its fire back (a later tick).
        runs.transaction(() => {
          for (const a of assets) runs.putScheduleState(a, { lastAttemptAt: heartbeatAt, ...(fires[a] ? { lastFireAt: fires[a].fire } : {}) });
          runs.setSetting(SPAWNED_SETTING, [...noted, entry]);
        });
        try {
          await spawn({ root: project.root, stateDir, runId, assets, env });
          noted.push(entry);
          started.push({ runId, assets });
        } catch (e) {
          const message = (e as Error)?.message ?? String(e);
          const retry = clockWords(new Date(now.getTime() + RETRY_BACKOFF_MS), project.timezone, now);
          problems.push(new CroftError("INTERNAL_ERROR", {
            message: `the scheduler could not start the run of ${assets.join(", ")}: ${message}`,
            hint: "check that Bun and the project's croft are installed (croft doctor), then look at .croft/logs/tick.log",
            effect: `${assets.length === 1 ? "it stays" : "they stay"} due; the scheduler tries again after ${retry}`,
          }).problem);
          // Never started: the fires stay due, and the assets wait before the next try.
          runs.transaction(() => {
            for (const [a, f] of Object.entries(fires)) if (runs.scheduleState(a)?.lastFireAt === f.fire) runs.putScheduleState(a, { lastFireAt: f.before });
            runs.setSetting(SPAWNED_SETTING, noted);
          });
          const failed: FailedStart = { runId, assets, at: heartbeatAt, reason: `it could not be started: ${message}`, unrecorded: true };
          failedStarts.push(failed);
          await notifyFailedStart(notify, project.root, failed);
        }
      }
      // Runs started earlier that still start or run, and these: a later tick treats their assets as taken, and
      // settles them once they end.
      runs.transaction(() => {
        runs.setSetting(SPAWNED_SETTING, noted);
        runs.setSetting(FAILED_STARTS_SETTING, failedStarts);
      });
      return {
        result: result({ heartbeatAt, spawned: started, held: work.held, importedAssetCode: work.imported }),
        problems,
      };
    } finally {
      runs.releaseTick(id.pid);
    }
  } finally {
    runs.close();
  }
}

/** A scheduled run that never recorded itself failed as a crashed one does: the notification says which assets it
 *  did not run. A notification never stops the tick. */
async function notifyFailedStart(notify: NonNullable<TickInput["notify"]>, root: string, s: FailedStart): Promise<void> {
  const error = s.problem ?? problem("RUN_CRASHED", {
    message: `the scheduled run ${s.runId} did not start: ${s.reason}`,
    hint: `croft tick starts it again after a wait; .croft/logs/${s.runId}/ has what it printed`,
  });
  try {
    await notify(root, { project: root, runId: s.runId, failed: s.assets.map((asset) => ({ asset, error })) });
  } catch {
    // The tick's problems still say so.
  }
}

/**
 * reconcile() as the writing commands run it, without their write intent: the warehouse is opened read-only, and
 * only when a step of a crashed run must be checked against it (history/reconcile.ts reads it for nothing else). A
 * busy database leaves those steps for a later tick, as a warning.
 */
async function reconcileTick(project: Project, runs: RunsDb, notify: NonNullable<TickInput["notify"]>): Promise<Problem[]> {
  if (!needsReconcile(runs, project.paths.stateDir)) return [];
  const { reconcile } = await import("../history/reconcile.ts");
  let opened: DuckWarehouse | undefined;
  const warehouse: Warehouse = {
    async read(fn, o) {
      if (!existsSync(project.paths.database)) {
        throw new CroftError("DB_NOT_FOUND", { message: `${project.databaseLabel} does not exist yet`, hint: "croft run builds it" });
      }
      const { openWarehouse } = await import("../db/warehouse.ts");
      opened ??= openWarehouse({
        path: project.paths.database, mode: "read_only", timezone: project.timezone, root: project.root,
        stateDir: project.paths.stateDir, register: false, isTTY: false,
      });
      return opened.read(fn, { purpose: o?.purpose ?? "reconcile", waitMs: Math.min(o?.waitMs ?? TICK_DB_WAIT_MS, TICK_DB_WAIT_MS) });
    },
    async write() {
      throw new CroftError("INTERNAL_ERROR", { message: "croft tick never writes the warehouse", hint: "report this croft bug" });
    },
    async holder() {
      return null;
    },
  };
  try {
    const rec = await reconcile({ db: runs, warehouse, waitMs: TICK_DB_WAIT_MS });
    // A crashed run's staging is deleted, as by the writing commands.
    for (const dir of rec.stagingDirs) rmSync(dir, { recursive: true, force: true });
    // A scheduled run that died never reached its own notification (run/runner.ts): the tick that finds it sends it.
    for (const id of rec.crashed) {
      const run = runs.getRun(id);
      if (run?.trigger !== "schedule") continue;
      const failed = runs.stepsFor(id).filter((s) => s.status === "crashed" || s.status === "failed" || s.status === "interrupted")
        .map((s) => ({ asset: s.asset, error: s.error }));
      try {
        await notify(project.root, { project: project.root, runId: id, failed });
      } catch {
        // A notification never stops the tick.
      }
    }
    return rec.problems;
  } finally {
    await opened?.close();
  }
}

/** Whether reconcile() has anything to look at: a run still marked running, a step of an ended run left unchecked,
 *  a lease, the lock holder or a waiter, or a write intent. */
function needsReconcile(runs: RunsDb, stateDir: string): boolean {
  if (runs.runningRuns().length > 0 || runs.danglingSteps().length > 0) return true;
  if (runs.sqlite.query("SELECT 1 FROM leases LIMIT 1").get() !== null) return true;
  if (runs.getLockHolder() !== null || runs.listWaiters().length > 0) return true;
  try {
    return readdirSync(intentDir(stateDir)).length > 0;
  } catch {
    return false;
  }
}
