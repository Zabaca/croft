// Heartbeats (DESIGN.md §8 "Turning it on"): every project tick records tick.heartbeat_at in runs.sqlite, which
// proves the OS job really runs. `croft schedule on` waits for the first one (up to 70 s), and `status` and
// `doctor` call a heartbeat older than 3 minutes stale (SCHEDULER_STALE).
//
// When none comes, diagnose() reads the tail of ~/.croft/logs/tick.log (where the job and the ticks it starts
// write) and names the likely cause:
// - macOS privacy protection: "Operation not permitted" (EPERM) for a project in ~/Documents, ~/Desktop or
//   ~/Downloads, which a background job may not read without Full Disk Access [U];
// - Bun missing: the job's absolute Bun path is gone (a version manager's, removed on upgrade), or the shell
//   could not find it;
// - Bun too old: the job's Bun is older than a project's pinned croft needs (the per-user tick logs it and does
//   not start that croft; a croft that started anyway said BUN_TOO_OLD);
// - the project's own croft not installed (the per-user tick logs it);
// - WSL, from /proc/version: the VM sleeps when no terminal is open, and cron often is not running [U];
// - otherwise a generic cause, pointing at the log.
import { Database } from "bun:sqlite";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import type { Fix } from "../core/types.ts";
import { now as clock } from "../core/time.ts";
import { BUSY_TIMEOUT_MS, RUNS_DB_FILE } from "../history/runs-db.ts";
import { loadProject } from "../project/root.ts";
import type { CroftHome } from "./home.ts";
import { croftHome } from "./home.ts";
import type { OsRunner } from "./os.ts";
import { installedBunPath } from "./register.ts";

/** How long `schedule on` waits for the first heartbeat: the job's first run (RunAtLoad) plus one interval. */
export const HEARTBEAT_WAIT_MS = 70_000;
/** A heartbeat older than this means the scheduler is not ticking. */
export const STALE_AFTER_MS = 3 * 60_000;
/** Lines of tick.log shown with a diagnosis. */
export const LOG_TAIL_LINES = 20;

export interface HeartbeatOptions {
  /** The project's state folder; from its croft.json when omitted. */
  stateDir?: string;
}

/** The project's last heartbeat, or null before its first tick. Reads runs.sqlite without creating it. */
export function lastHeartbeat(root: string, o: HeartbeatOptions = {}): Date | null {
  const file = join(o.stateDir ?? loadProject({ root }).paths.stateDir, RUNS_DB_FILE);
  if (!existsSync(file)) return null;
  const db = new Database(file, { readonly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const row = db.query("SELECT heartbeat_at FROM tick WHERE id = 1").get() as { heartbeat_at: string | null } | null;
    const t = row?.heartbeat_at ? Date.parse(row.heartbeat_at) : Number.NaN;
    return Number.isFinite(t) ? new Date(t) : null;
  } catch (e) {
    if (/no such table/.test((e as Error).message)) return null;   // a runs.sqlite from before any tick table
    throw e;
  } finally {
    db.close();
  }
}

/** Whether the scheduler stopped ticking: no heartbeat, or one more than STALE_AFTER_MS old. */
export function isStale(now: Date, heartbeat: Date | null): boolean {
  return heartbeat === null || now.getTime() - heartbeat.getTime() > STALE_AFTER_MS;
}

export interface WaitOptions extends HeartbeatOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** Only a heartbeat at or after this counts; now (CROFT_NOW) by default. */
  since?: Date;
  /** For the diagnosis; croftHome() by default. */
  home?: CroftHome;
  diagnose?: DiagnoseOptions;
  sleep?: (ms: number) => Promise<void>;
}

export type HeartbeatWait =
  | { ok: true; heartbeatAt: Date; waitedMs: number }
  | { ok: false; waitedMs: number; diagnosis: Diagnosis };

/** Wait for a heartbeat newer than the start: the proof that the OS job runs this project's ticks. */
export async function waitForHeartbeat(root: string, o: WaitOptions = {}): Promise<HeartbeatWait> {
  const stateDir = o.stateDir ?? loadProject({ root }).paths.stateDir;
  const since = o.since ?? clock();
  const timeoutMs = o.timeoutMs ?? HEARTBEAT_WAIT_MS;
  const pollMs = o.pollMs ?? 1000;
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  const t0 = Date.now();
  for (;;) {
    const at = lastHeartbeat(root, { stateDir });
    if (at !== null && at.getTime() >= since.getTime()) return { ok: true, heartbeatAt: at, waitedMs: Date.now() - t0 };
    const left = timeoutMs - (Date.now() - t0);
    if (left <= 0) return { ok: false, waitedMs: Date.now() - t0, diagnosis: diagnose(o.home ?? croftHome(), o.diagnose) };
    await sleep(Math.min(pollMs, left));
  }
}

// ---- diagnosis ----

export type DiagnosisCause = "privacy" | "bun_missing" | "bun_too_old" | "croft_missing" | "wsl" | "unknown";

export interface Diagnosis {
  cause: DiagnosisCause;
  message: string;
  hint: string;
  fix?: Fix;
  /** The last LOG_TAIL_LINES lines of tick.log; "" when it is empty or missing. */
  logTail: string;
  logFile: string;
}

export interface DiagnoseOptions {
  platform?: NodeJS.Platform;
  /** /proc/version's text; read on Linux when omitted, null for none. */
  procVersion?: string | null;
  /** The Bun the job runs; read from the installed job when omitted (on Linux only with `runner`). */
  bunPath?: string | null;
  runner?: OsRunner;
  exists?: (path: string) => boolean;
}

const PROTECTED = ["Documents", "Desktop", "Downloads"] as const;

/** Why the OS job is likely not ticking, from the tail of tick.log and the machine. */
export function diagnose(home: CroftHome, o: DiagnoseOptions = {}): Diagnosis {
  const platform = o.platform ?? process.platform;
  const exists = o.exists ?? existsSync;
  const logTail = tickLogTail(home);
  const bun = o.bunPath !== undefined ? o.bunPath : installedBunPath(home, { platform, ...(o.runner ? { runner: o.runner } : {}) });
  const base = { logTail, logFile: home.tickLog };
  const allowBun = bun ?? "the Bun that runs croft (which bun)";

  const denied = logTail.split("\n").filter((l) => /operation not permitted|\bEPERM\b/i.test(l));
  if (platform === "darwin" && denied.length > 0) {
    const folder = PROTECTED.find((f) => denied.some((l) => l.includes(`/${f}/`) || l.endsWith(`/${f}`)));
    return {
      ...base, cause: "privacy",
      message: `macOS privacy protection stops the scheduler job from reading ${folder ? `a project in ~/${folder}` : "a project folder"} (tick.log: "Operation not permitted")`,
      hint: `give Bun Full Disk Access (System Settings > Privacy & Security > Full Disk Access, click +, press Cmd+Shift+G and enter ${allowBun}), then run croft schedule on again; or move the project out of ~/Documents, ~/Desktop and ~/Downloads`,
      fix: { kind: "manual", description: `give ${allowBun} Full Disk Access in System Settings, then run croft schedule on again`, requiresHuman: true },
    };
  }

  const bunGone = bun !== null && !exists(bun);
  const shellMissed = logTail.split("\n").some((l) => /bun\b.*(not found|No such file or directory)|(not found|No such file or directory).*\bbun\b/i.test(l)
    && !/croft is not installed/.test(l));
  if (bunGone || shellMissed) {
    return {
      ...base, cause: "bun_missing",
      message: bunGone
        ? `the scheduler job cannot start Bun: ${bun} is gone (an upgrade or a version manager removed it)`
        : "the scheduler job cannot start Bun: its path no longer exists (tick.log: not found)",
      hint: "run croft schedule on again: it points the job at the Bun installed now, preferring a path that survives upgrades (~/.bun/bin/bun from curl -fsSL https://bun.sh/install | bash)",
      fix: { kind: "command", description: "point the scheduler job at the Bun installed now", command: "croft schedule on" },
    };
  }

  // The per-user tick does not start a pinned croft whose engines.bun is newer than the job's Bun, and says so;
  // a croft that started anyway refuses with BUN_TOO_OLD's message.
  const tooOld = /^(?:\S+ )?(\/.*): its croft needs Bun (\S+) or newer, and the scheduler job runs Bun (\S+) \((.*)\);/m.exec(lastLines(logTail));
  const refused = tooOld ? null : /croft needs Bun (\S+) or newer; this is Bun (\S+)/.exec(lastLines(logTail));
  if (tooOld || refused) {
    const [need, have] = tooOld ? [tooOld[2]!, tooOld[3]!] : [refused![1]!, refused![2]!];
    const jobBun = tooOld ? tooOld[4]! : bun;
    const root = tooOld ? tooOld[1]! : null;
    const command = root ? `cd ${shellQuote(root)} && croft schedule on` : "croft schedule on";
    return {
      ...base, cause: "bun_too_old",
      message: `the scheduler job runs Bun ${have}${jobBun ? ` (${jobBun})` : ""}, older than the Bun ${need} ${root ? `${root}'s` : "the project's"} croft needs, so its ticks do not run`,
      hint: `run ${command}: it points the job at a Bun at least as new as the one running croft; or upgrade that Bun (bun upgrade, or brew upgrade bun for Homebrew's)`,
      fix: { kind: "command", description: "point the scheduler job at a newer Bun", command },
    };
  }

  const notInstalled = /^(?:\S+ )?(\/.*): its croft is not installed/m.exec(lastLines(logTail));
  if (notInstalled) {
    const root = notInstalled[1]!;
    return {
      ...base, cause: "croft_missing",
      message: `the scheduler job cannot tick ${root}: its croft is not installed (no node_modules/@zabaca/croft)`,
      hint: `install the project's dependencies: cd ${shellQuote(root)} && bun install`,
      fix: { kind: "command", description: "install the project's dependencies", command: `cd ${shellQuote(root)} && bun install` },
    };
  }

  const procVersion = o.procVersion !== undefined ? o.procVersion : platform === "linux" ? readProcVersion() : null;
  if (procVersion !== null && /microsoft/i.test(procVersion)) {
    return {
      ...base, cause: "wsl",
      message: "on WSL the Linux VM sleeps when no terminal is open, and cron is often not running, so the per-user scheduler job does not tick",
      hint: "keep croft serve running in a WSL terminal instead: croft schedule on --no-os-job, then croft serve (it ticks every minute); or start cron (sudo service cron start) and keep a WSL terminal open",
      fix: { kind: "manual", description: "run croft schedule on --no-os-job, then keep croft serve running in a WSL terminal" },
    };
  }

  const check = platform === "darwin"
    ? `check the job with launchctl print gui/${process.getuid?.() ?? "<uid>"}/${home.jobLabel}`
    : "check that cron is running (systemctl status cron, or service cron status)";
  return {
    ...base, cause: "unknown",
    message: logTail === ""
      ? `the scheduler job has not ticked, and ${home.tickLog} is empty: the job may never have run`
      : `the scheduler job has not ticked; the end of ${home.tickLog} may say why`,
    hint: `${check}, and read the tick log (${home.tickLog}); croft schedule on reinstalls the job; to schedule without it, run croft schedule on --no-os-job and keep croft serve running`,
    fix: { kind: "command", description: "reinstall the scheduler job", command: "croft schedule on" },
  };
}

/** The last `lines` lines of tick.log (at most its last 64 KB), without the final newline; "" when missing. */
export function tickLogTail(home: CroftHome, lines = LOG_TAIL_LINES): string {
  let fd: number;
  try {
    fd = openSync(home.tickLog, "r");
  } catch {
    return "";
  }
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const all = buf.toString("utf8").replace(/\n+$/, "").split("\n");
    if (len < size) all.shift();                              // a partial first line
    return all.slice(-lines).join("\n");
  } finally {
    closeSync(fd);
  }
}

/** The tail's lines, most recent first, so a pattern matches the latest occurrence. */
function lastLines(tail: string): string {
  return tail.split("\n").reverse().join("\n");
}

function readProcVersion(): string | null {
  try {
    return readFileSync("/proc/version", "utf8");
  } catch {
    return null;
  }
}

function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}
