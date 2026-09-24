// The seam between the scheduler and the operating system (DESIGN.md §8 "Turning it on"): launchctl,
// crontab and notifications go through an OsRunner, so tests inject a fake one and never register a real job.
// realRunner refuses outright when CROFT_FORBID_OS_JOBS=1 (tests/preload.ts sets it), so a test that forgets
// the fake fails loudly instead of touching the machine.
import { spawnSync } from "node:child_process";
import { CroftError } from "../core/errors.ts";
import type { Env } from "./home.ts";

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** Written to the child's stdin (crontab -). */
  input?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface OsRunner {
  exec(argv: readonly string[], o?: ExecOptions): ExecResult;
}

/** The commands the scheduler may run on the real machine. */
const OS_COMMANDS = new Set(["launchctl", "crontab", "osascript", "notify-send", "id", "plutil"]);

/** Runs real commands; refuses when CROFT_FORBID_OS_JOBS=1, and anything outside OS_COMMANDS. */
export function realRunner(env: Env = process.env): OsRunner {
  return {
    exec(argv, o = {}) {
      const cmd = argv[0] ?? "";
      const base = cmd.split("/").pop() ?? cmd;
      if (env.CROFT_FORBID_OS_JOBS === "1") {
        throw new CroftError("INTERNAL_ERROR", {
          message: `refusing to run ${base}: CROFT_FORBID_OS_JOBS=1 (tests must inject a fake OsRunner)`,
          hint: "report this croft bug",
        });
      }
      if (!OS_COMMANDS.has(base)) {
        throw new CroftError("INTERNAL_ERROR", { message: `refusing to run ${base}: not a scheduler command`, hint: "report this croft bug" });
      }
      const r = spawnSync(cmd, argv.slice(1), {
        encoding: "utf8", input: o.input, timeout: o.timeoutMs ?? 30_000,
        env: o.env ?? { PATH: env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin", HOME: env.HOME ?? "", LC_ALL: "C" },
      });
      return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error) : "") };
    },
  };
}

/** One project in ~/.croft/projects.json. */
export interface RegistryEntry {
  /** The project folder (canonical path). */
  root: string;
  /** ISO-8601 UTC. */
  addedAt: string;
  /** Who ticks it: the per-user OS job, or `croft serve` only (`schedule on --no-os-job`). */
  via: "os-job" | "serve";
}

/** Scheduling for one project, stored in its runs.sqlite settings table (RunsDb.getScheduling). */
export interface SchedulingSetting {
  state: "on" | "off" | "paused";
  via: "os-job" | "serve" | null;
  /** While paused: ISO-8601 UTC when it resumes on its own (pause --for), or null (until `schedule on`). */
  pausedUntil?: string | null;
}

/** What one project tick did (croft tick --json). */
export interface TickResult {
  /** Why it did nothing, when it did nothing. */
  exited: null | "scheduling_off" | "paused" | "another_tick";
  heartbeatAt: string | null;
  /** Assets due this tick, by group; each group is one detached `croft run --due`. */
  spawned: { runId: string; assets: string[] }[];
  /** Due assets skipped, and why (SCHEDULE_HELD, LARGE_REPROCESS, leased, backoff). */
  held: { asset: string; code: string; reason: string }[];
  /** Whether asset code was imported (it is not when nothing is due and no file changed). */
  importedAssetCode: boolean;
  tookMs: number;
}
