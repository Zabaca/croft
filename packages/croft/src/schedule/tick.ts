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
//   6. start one detached `croft run --due <assets…>` per group of due assets (run/detach.ts: absolute Bun, an
//      explicit environment); the children take the leases. Each group's ingests get last_fire_at (the fire they
//      handle) and last_attempt_at before the child starts, so a child that dies early is not started again every
//      minute, and the run is noted (settings `schedule.spawned`) until it holds its leases or ends;
//   7. release the singleton and exit, usually within a second. It never runs asset work itself: launchd runs one
//      process per job, and a tick busy with a 40-minute transform would drop every later fire.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { CroftError } from "../core/errors.ts";
import { currentIdentity, type ProcessIdentity, recordAlive } from "../core/proc.ts";
import type { Problem, Warehouse } from "../core/types.ts";
import { intentDir } from "../db/intent.ts";
import type { DuckWarehouse } from "../db/warehouse.ts";
import { newRunId, RunsDb } from "../history/runs-db.ts";
import type { Project } from "../project/root.ts";
import { CONFIRM_GRANT_ENV } from "../safety/confirm.ts";
import { type Alive, dueWork, type FactsResolver, type FireTimes, SPAWNED_SETTING, type SpawnedRun } from "./due.ts";
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
      const problems: Problem[] = [...await reconcileTick(project, runs, i.notify ?? notifyScheduledFailure)];
      const work = await dueWork({
        project, runs, now, store: true, alive, ...(i.resolve ? { resolve: i.resolve } : {}), ...(i.fires ? { fires: i.fires } : {}),
      });
      problems.push(...work.problems);
      const spawn = i.spawn ?? spawnDueRun;
      // A confirmation grant is one run's; a scheduled run never carries one.
      const env = { ...i.env, [CONFIRM_GRANT_ENV]: undefined };
      const started: SpawnedRun[] = [];
      for (const assets of work.groups) {
        const runId = newRunId(now, project.timezone);
        // Recorded before the child starts: a child that dies before its first step must not be started again
        // for the same fire.
        runs.transaction(() => {
          for (const a of assets) {
            const fire = work.fires.get(a);
            runs.putScheduleState(a, { lastAttemptAt: heartbeatAt, ...(fire ? { lastFireAt: fire } : {}) });
          }
        });
        try {
          await spawn({ root: project.root, stateDir, runId, assets, env });
          started.push({ runId, assets });
        } catch (e) {
          problems.push(new CroftError("INTERNAL_ERROR", {
            message: `the scheduler could not start the run of ${assets.join(", ")}: ${(e as Error)?.message ?? String(e)}`,
            hint: "check that Bun and the project's croft are installed (croft doctor), then look at .croft/logs/tick.log",
            effect: "those assets were not run this minute; the next tick tries again at their next fire",
          }).problem);
        }
      }
      // Runs started earlier that still start or run, and these: a later tick treats their assets as taken.
      runs.setSetting(SPAWNED_SETTING, [...work.inFlight, ...started]);
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
