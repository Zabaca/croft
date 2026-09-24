// croft serve's scheduler loop (DESIGN.md §5 "Processes" 4, §8 "Turning it on"). While scheduling is on for the
// project, it starts a fresh `croft tick` subprocess every minute; the tick plans and spawns the due runs itself.
//
// - Never in-process: a cache-busted import() does not re-import lib/ dependencies, so an in-process tick would
//   run stale code, and it would risk a second DuckDB instance on the file this process holds.
// - Off or paused means no spawn at all. `croft tick` checks again itself (a pause that just began, a race with
//   `croft schedule off`), and exits at once if another tick for the project is alive.
// - One at a time from here: while the previous tick is still running, the next one is skipped.
// - The child is croft's own bin run by the absolute Bun path (process.execPath: a PATH without ~/.bun/bin
//   must not matter), with `--no-env-file` (croft reads .env itself), an explicit environment, the project as
//   its working folder, detached in its own session, and its output appended to <state>/logs/tick.log.
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, renameSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { now } from "../core/time.ts";
import { RunsDb } from "../history/runs-db.ts";
import type { SchedulingSetting } from "../schedule/os.ts";
import { CONFIRM_GRANT_ENV } from "../safety/confirm.ts";
import { TOKEN_ENV } from "./auth.ts";

export const TICK_INTERVAL_MS = 60_000;
/** tick.log is moved to tick.log.1 before a tick once it is this big. */
export const TICK_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** The package's bin: the same croft this server runs. */
export const CROFT_BIN = fileURLToPath(new URL("../../bin/croft.mjs", import.meta.url));

export function tickLogPath(stateDir: string): string {
  return join(stateDir, "logs", "tick.log");
}

/** `croft tick` as a subprocess: absolute Bun, no Bun .env loading, this package's bin. */
export function tickCommand(): string[] {
  return [process.execPath, "--no-env-file", CROFT_BIN, "tick"];
}

/** The tick's whole environment: the server's, minus the serve token (the tick and the runs it starts do not
 *  need it) and any confirmation grant. */
export function tickEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && k !== TOKEN_ENV && k !== CONFIRM_GRANT_ENV) out[k] = v;
  return out;
}

export interface TickProcess {
  pid: number;
  /** Whether it is still running. */
  alive(): boolean;
}

export interface TickSpawnInput {
  root: string;
  stateDir: string;
  env: Record<string, string>;
}

export type TickSpawner = (o: TickSpawnInput) => TickProcess;

/** Start one `croft tick` (or `argv`, for tests), detached, output appended to tick.log. Throws when it cannot start. */
export function spawnTick(o: TickSpawnInput & { argv?: string[]; maxLogBytes?: number }): TickProcess {
  const log = tickLogPath(o.stateDir);
  mkdirSync(dirname(log), { recursive: true });
  rotate(log, o.maxLogBytes ?? TICK_LOG_MAX_BYTES);
  const argv = o.argv ?? tickCommand();
  const fd = openSync(log, "a", 0o600);
  let child: ChildProcess;
  try {
    writeSync(fd, `── ${new Date().toISOString()} croft serve (pid ${process.pid}) starts croft tick\n`);
    child = spawn(argv[0]!, argv.slice(1), { cwd: o.root, env: o.env, detached: true, stdio: ["ignore", fd, fd] });
  } finally {
    closeSync(fd);
  }
  let exited = false;
  child.once("exit", () => (exited = true));
  child.once("error", () => (exited = true)); // handled: an unhandled "error" event would crash the server
  const pid = child.pid;
  // A program that cannot start (ENOENT, EACCES) gets no pid; its error event comes later.
  if (pid === undefined) throw new Error(`${argv[0]} could not be started`);
  child.unref();
  return {
    pid,
    alive: () => {
      if (exited) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
      }
    },
  };
}

function rotate(log: string, max: number): void {
  try {
    if (statSync(log).size > max) renameSync(log, `${log}.1`);
  } catch {
    // No log yet, or it cannot be moved: append to it as it is.
  }
}

export type LoopEvent =
  | { kind: "spawned"; pid: number }
  | { kind: "skipped"; reason: "off" | "paused" | "previous_alive" | "stopped"; pid?: number }
  | { kind: "error"; error: unknown };

export interface LoopOptions {
  root: string;
  stateDir: string;
  /** The tick's whole environment (tickEnv). */
  env: Record<string, string>;
  /** Default TICK_INTERVAL_MS. */
  intervalMs?: number;
  /** Default spawnTick. */
  spawn?: TickSpawner;
  /** The project's scheduling setting; default RunsDb.getScheduling() from <state>/runs.sqlite. */
  scheduling?: () => SchedulingSetting;
  /** Every tick's outcome (the command logs errors). */
  onEvent?: (e: LoopEvent) => void;
}

export interface SchedulerLoop {
  /** Check the setting and spawn a tick now, as the timer does. */
  tick(): LoopEvent;
  stop(): void;
}

/** Start the loop: a tick at once, then one every interval. The timer never keeps the process alive by itself. */
export function startLoop(o: LoopOptions): SchedulerLoop {
  const spawner = o.spawn ?? spawnTick;
  const scheduling = o.scheduling ?? (() => readScheduling(o.stateDir, o.env));
  let previous: TickProcess | null = null;
  let stopped = false;

  const tick = (): LoopEvent => {
    let e: LoopEvent;
    if (stopped) e = { kind: "skipped", reason: "stopped" };
    else {
      try {
        const s = scheduling();
        if (s.state !== "on") e = { kind: "skipped", reason: s.state === "paused" ? "paused" : "off" };
        else if (previous?.alive()) e = { kind: "skipped", reason: "previous_alive", pid: previous.pid };
        else {
          previous = spawner({ root: o.root, stateDir: o.stateDir, env: o.env });
          e = { kind: "spawned", pid: previous.pid };
        }
      } catch (error) {
        e = { kind: "error", error };
      }
    }
    o.onEvent?.(e);
    return e;
  };

  tick();
  const timer = setInterval(tick, o.intervalMs ?? TICK_INTERVAL_MS);
  timer.unref();
  return {
    tick,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/** Scheduling as `croft tick` will read it (a pause whose end has passed reads as on; CROFT_NOW honored). */
function readScheduling(stateDir: string, env: Record<string, string | undefined>): SchedulingSetting {
  const db = RunsDb.open(stateDir, { now: () => now(env) });
  try {
    return db.getScheduling();
  } finally {
    db.close();
  }
}
