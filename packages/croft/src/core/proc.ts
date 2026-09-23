// Process identity: a PID is not enough to tell whether a process is alive, because PIDs are
// reused after a reboot. Leases, write intents and run records store {pid, procStart, bootId}
// and compare all three (DESIGN.md §5 "Asset leases" and "Write intents").
//
// A holder records its start time in its own environment and a checker compares it from another
// (a German terminal against the C-locale scheduler, a different TZ), so the value may depend on
// neither: Linux uses /proc starttime (clock ticks since boot); macOS reads `ps -o lstart` under
// LC_ALL=C TZ=UTC and stores epoch seconds.
//
// ps and sysctl are called by absolute path (/bin/ps, /usr/sbin/sysctl), so a PATH without /usr/sbin (an
// agent's trimmed shell, a launchd job) cannot hide them. A boot id that still cannot be read is UNKNOWN_BOOT,
// and an empty or unknown boot id on either side means "unknown", never "dead": the PID and the start time
// decide. Reading it as dead made every writing command mark live runs crashed and take their leases.
import { readFileSync } from "node:fs";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export interface ProcessIdentity {
  pid: number;
  procStart: string; // opaque, stable for the life of the process
  bootId: string; // changes on every reboot; UNKNOWN_BOOT when it could not be read
}

/** Where ps and sysctl are looked up by name when their absolute paths are missing. */
const FALLBACK_PATH = "/usr/sbin:/sbin:/usr/bin:/bin";
const SYSCTL = ["/usr/sbin/sysctl", "/sbin/sysctl"] as const;
const PS = ["/bin/ps", "/usr/bin/ps"] as const;

/** A fixed environment for ps and sysctl, so their text never depends on the caller's locale or zone. */
function fixedEnv(): NodeJS.ProcessEnv {
  return { PATH: [process.env.PATH, FALLBACK_PATH].filter((p) => p).join(":"), LC_ALL: "C", TZ: "UTC" };
}

/** Run a system tool by its absolute paths, then by its bare name (the fallback). null when it could not be
 *  started at all. */
function runTool(paths: readonly string[], args: string[]): SpawnSyncReturns<string> | null {
  const bare = paths[0]!.slice(paths[0]!.lastIndexOf("/") + 1);
  for (const cmd of [...paths, bare]) {
    const out = spawnSync(cmd, args, { encoding: "utf8", env: fixedEnv() });
    if (!out.error) return out;
  }
  return null;
}

/** A boot id that could not be read. Liveness then rests on the PID and the start time. */
export const UNKNOWN_BOOT = "unknown";

let cachedBootId: string | undefined;

function readBootId(): string {
  if (process.platform === "linux") {
    try {
      return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch {
      return "";
    }
  }
  // macOS: "{ sec = 1758600000, usec = 123 } Tue Sep 23 ..." — the seconds identify the boot.
  const res = runTool(SYSCTL, ["-n", "kern.boottime"]);
  const out = res && res.status === 0 ? res.stdout ?? "" : "";
  return out.match(/sec = (\d+)/)?.[1] ?? out.trim();
}

/** This machine's boot id, or UNKNOWN_BOOT when it cannot be read; never "". */
export function bootId(): string {
  cachedBootId ??= readBootId() || UNKNOWN_BOOT;
  return cachedBootId;
}

/** Whether a boot id was actually read: an empty, missing or UNKNOWN_BOOT id was not. */
export function knownBoot(id: string | null | undefined): boolean {
  return typeof id === "string" && id !== "" && id !== UNKNOWN_BOOT;
}

/**
 * Whether a recorded boot id names this boot. Unknown on either side is no evidence of a reboot, so it
 * counts as the same boot and the PID and start time decide.
 */
export function sameBoot(recorded: string | null | undefined, current: string = bootId()): boolean {
  if (!knownBoot(recorded) || !knownBoot(current)) return true;
  return recorded === current;
}

/** Start time recorded when it could not be read even though the process exists. */
export const UNKNOWN_START = "unknown";

/** Whether a PID exists at all (EPERM means it exists but belongs to someone else). */
function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// `ps -o lstart` under LC_ALL=C: "Wed Aug 26 08:33:17 2026".
const C_LSTART = /^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})$/;

/** C-locale lstart text read as UTC wall time, in epoch seconds, or null when it is not that shape. */
function cLstartSeconds(text: string): number | null {
  const m = C_LSTART.exec(text.trim());
  const month = m ? MONTHS.indexOf(m[1]!) : -1;
  if (!m || month < 0) return null;
  return Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) / 1000;
}

/**
 * Start time of a process, or null when no such process exists. When the start time cannot be
 * read but the PID exists (ps missing or sandboxed), returns UNKNOWN_START instead of null, so a
 * live holder is never mistaken for a dead one.
 */
export function procStart(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // Field 22 (starttime) comes after the parenthesized command name, which may contain spaces.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[19] ?? (pidExists(pid) ? UNKNOWN_START : null);
    } catch {
      return pidExists(pid) ? UNKNOWN_START : null;
    }
  }
  const out = runTool(PS, ["-o", "lstart=", "-p", String(pid)]);
  const text = (out?.stdout ?? "").trim();
  if (out && out.status === 0 && text) {
    const seconds = cLstartSeconds(text);
    // Text of an unexpected shape is still stable under the fixed environment, so it is kept as is.
    return seconds === null ? text : String(seconds);
  }
  // ps exits 1 with no output for a missing PID; anything else (spawn failure) is inconclusive.
  if (out && out.status === 1 && !pidExists(pid)) return null;
  return pidExists(pid) ? UNKNOWN_START : null;
}

let self: ProcessIdentity | undefined;

export function currentIdentity(): ProcessIdentity {
  self ??= { pid: process.pid, procStart: procStart(process.pid) ?? UNKNOWN_START, bootId: bootId() };
  return self;
}

const EPOCH = /^\d+$/;

/**
 * A record written before macOS start times were normalized holds `ps -o lstart` text in the writer's
 * locale and zone ("Wed Aug 26 01:33:17 2026", "Mi. 26 Aug. 01:33:17 2026", "水  8/26 01:33:17 2026").
 * Zones differ from UTC by whole quarter hours, so the seconds past the quarter hour must match the
 * real start. C-locale text also pins the date to within a zone offset (UTC-12 to UTC+14); other
 * locales pin at least the year. Text without a time of day never matches.
 */
function legacyStartMatches(text: string, epoch: number): boolean {
  const t = /(\d{1,2}):(\d{2}):(\d{2})/.exec(text);
  if (!t) return false;
  if ((Number(t[2]) * 60 + Number(t[3])) % 900 !== epoch % 900) return false;
  const local = cLstartSeconds(text);
  if (local !== null) return local - epoch >= -12 * 3600 && local - epoch <= 14 * 3600;
  const year = /(?:^|\D)(\d{4})(?:\D|$)/.exec(text);
  return year !== null && Math.abs(Number(year[1]) - new Date(epoch * 1000).getUTCFullYear()) <= 1;
}

/**
 * Whether a recorded start time names the process whose start time now reads `current`. Unknown on
 * either side errs on the side of alive; an old-format macOS record is compared leniently.
 */
export function sameStart(recorded: string, current: string): boolean {
  if (recorded === UNKNOWN_START || current === UNKNOWN_START) return true;
  if (recorded === current) return true;
  if (process.platform === "linux" || EPOCH.test(recorded) || !EPOCH.test(current)) return false;
  return legacyStartMatches(recorded, Number(current));
}

/**
 * True only when the same process (same boot, same start time) is still running. When either
 * start time is unknown, falls back to "the PID exists in this boot" and errs on the side of alive.
 * An empty or unknown boot id (on either side) skips the boot comparison; it never means dead.
 */
export function isAlive(id: ProcessIdentity): boolean {
  if (!sameBoot(id.bootId)) return false;
  const start = procStart(id.pid);
  if (start === null) return false;
  return sameStart(id.procStart, start);
}

/**
 * isAlive for a stored record (a run, a lease), whose columns may be NULL or empty. Without a PID or a start
 * time it names no process croft recorded, so it is dead; a missing boot id is unknown, not dead.
 */
export function recordAlive(r: { pid: number | null; procStart: string | null; bootId: string | null }): boolean {
  if (r.pid === null || !r.procStart) return false;
  return isAlive({ pid: r.pid, procStart: r.procStart, bootId: r.bootId ?? "" });
}
