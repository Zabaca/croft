// The per-user croft folder and the OS job's label (DESIGN.md §8 "Turning it on"): ~/.croft holds the
// registry (projects.json), the per-user tick script (tick.ts) and its log (logs/tick.log).
//
// Tests never touch the real ones: CROFT_HOME moves the folder, and CROFT_JOB_LABEL names the LaunchAgent or
// crontab entry (tests/preload.ts also sets CROFT_FORBID_OS_JOBS, so a missed override fails instead of
// registering a job). The label becomes a file name (~/Library/LaunchAgents/<label>.plist), a launchctl service
// target and a crontab marker line, so it must be a reverse-DNS name: anything else is USAGE_ERROR here, before
// a path or a line is built from it.
import { homedir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";

export type Env = Record<string, string | undefined>;

export const DEFAULT_JOB_LABEL = "dev.croft.tick";

/** A job label: letters, digits, dots, dashes and underscores, starting with a letter or digit. */
export const JOB_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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
    jobLabel: env.CROFT_JOB_LABEL && env.CROFT_JOB_LABEL !== "" ? jobLabel(env.CROFT_JOB_LABEL) : DEFAULT_JOB_LABEL,
    userHome,
  };
}

function jobLabel(value: string): string {
  if (JOB_LABEL_PATTERN.test(value)) return value;
  throw new CroftError("USAGE_ERROR", {
    message: `CROFT_JOB_LABEL ${JSON.stringify(value)} is not a job label: it names the scheduler's LaunchAgent file and crontab marker, `
      + "so it may hold only letters, digits, dots, dashes and underscores (at most 128, starting with a letter or digit)",
    hint: `unset CROFT_JOB_LABEL to use ${DEFAULT_JOB_LABEL}, or set it to a reverse-DNS name such as ${DEFAULT_JOB_LABEL}-test`,
    fix: { kind: "manual", description: `unset CROFT_JOB_LABEL, or set it to a name like ${DEFAULT_JOB_LABEL}-test` },
    details: { variable: "CROFT_JOB_LABEL", value },
  });
}
