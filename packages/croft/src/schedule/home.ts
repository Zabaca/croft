// The per-user croft folder and the OS job's label (DESIGN.md §8 "Turning it on"): ~/.croft holds the
// registry (projects.json), the per-user tick script (tick.ts) and its log (logs/tick.log).
//
// Tests never touch the real ones: CROFT_HOME moves the folder, and CROFT_JOB_LABEL names the LaunchAgent or
// crontab entry (tests/preload.ts also sets CROFT_FORBID_OS_JOBS, so a missed override fails instead of
// registering a job).
import { homedir } from "node:os";
import { join } from "node:path";

export type Env = Record<string, string | undefined>;

export const DEFAULT_JOB_LABEL = "dev.croft.tick";

export interface CroftHome {
  /** ~/.croft, or CROFT_HOME. */
  dir: string;
  /** <dir>/projects.json: the projects with scheduling on (RegistryEntry[]). */
  registry: string;
  /** <dir>/tick.ts: what the OS job runs every minute. */
  tickScript: string;
  /** <dir>/logs */
  logDir: string;
  /** <dir>/logs/tick.log: the OS job's stdout and stderr. */
  tickLog: string;
  /** The LaunchAgent label and crontab marker: dev.croft.tick, or CROFT_JOB_LABEL. */
  jobLabel: string;
  /** The user's home (HOME, else os.homedir()): where ~/Library/LaunchAgents is. */
  userHome: string;
}

export function croftHome(env: Env = process.env): CroftHome {
  const userHome = env.HOME && env.HOME !== "" ? env.HOME : homedir();
  const dir = env.CROFT_HOME && env.CROFT_HOME !== "" ? env.CROFT_HOME : join(userHome, ".croft");
  const logDir = join(dir, "logs");
  return {
    dir, registry: join(dir, "projects.json"), tickScript: join(dir, "tick.ts"), logDir, tickLog: join(logDir, "tick.log"),
    jobLabel: env.CROFT_JOB_LABEL && env.CROFT_JOB_LABEL !== "" ? env.CROFT_JOB_LABEL : DEFAULT_JOB_LABEL,
    userHome,
  };
}
