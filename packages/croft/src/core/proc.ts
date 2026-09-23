// Process identity: a PID is not enough to tell whether a process is alive, because PIDs are
// reused after a reboot. Leases, write intents and run records store {pid, procStart, bootId}
// and compare all three (DESIGN.md §5 "Asset leases" and "Write intents").
//
// A holder records its start time in its own environment and a checker compares it from another
// (a German terminal against the C-locale scheduler, a different TZ), so the value may depend on
// neither: Linux uses /proc starttime (clock ticks since boot); macOS reads `ps -o lstart` under
// LC_ALL=C TZ=UTC and stores epoch seconds.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export interface ProcessIdentity {
  pid: number;
  procStart: string; // opaque, stable for the life of the process
  bootId: string; // changes on every reboot
}

/** A fixed environment for ps and sysctl, so their text never depends on the caller's locale or zone. */
function fixedEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH || "/bin:/usr/bin:/usr/sbin:/sbin", LC_ALL: "C", TZ: "UTC" };
}

let cachedBootId: string | undefined;

export function bootId(): string {
  if (cachedBootId) return cachedBootId;
  if (process.platform === "linux") {
    cachedBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } else {
    // macOS: "{ sec = 1758600000, usec = 123 } Tue Sep 23 ..." — the seconds identify the boot.
    const out = spawnSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8", env: fixedEnv() }).stdout ?? "";
    cachedBootId = out.match(/sec = (\d+)/)?.[1] ?? out.trim();
  }
  return cachedBootId;
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
  const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: fixedEnv() });
  const text = (out.stdout ?? "").trim();
  if (out.status === 0 && text) {
    const seconds = cLstartSeconds(text);
    // Text of an unexpected shape is still stable under the fixed environment, so it is kept as is.
    return seconds === null ? text : String(seconds);
  }
  // ps exits 1 with no output for a missing PID; anything else (spawn failure) is inconclusive.
  if (!out.error && out.status === 1 && !pidExists(pid)) return null;
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
 */
export function isAlive(id: ProcessIdentity): boolean {
  if (id.bootId !== bootId()) return false;
  const start = procStart(id.pid);
  if (start === null) return false;
  return sameStart(id.procStart, start);
}
