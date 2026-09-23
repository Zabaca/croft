// Process identity: a PID is not enough to tell whether a process is alive, because PIDs are
// reused after a reboot. Leases, write intents and run records store {pid, procStart, bootId}
// and compare all three (DESIGN.md §5 "Asset leases" and "Write intents").
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export interface ProcessIdentity {
  pid: number;
  procStart: string; // opaque, stable for the life of the process
  bootId: string; // changes on every reboot
}

let cachedBootId: string | undefined;

export function bootId(): string {
  if (cachedBootId) return cachedBootId;
  if (process.platform === "linux") {
    cachedBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } else {
    // macOS: "{ sec = 1758600000, usec = 123 } Tue Sep 23 ..." — the seconds identify the boot.
    const out = spawnSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" }).stdout ?? "";
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
  const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  const text = (out.stdout ?? "").trim();
  if (out.status === 0 && text) return text;
  // ps exits 1 with no output for a missing PID; anything else (spawn failure) is inconclusive.
  if (!out.error && out.status === 1 && !pidExists(pid)) return null;
  return pidExists(pid) ? UNKNOWN_START : null;
}

let self: ProcessIdentity | undefined;

export function currentIdentity(): ProcessIdentity {
  self ??= { pid: process.pid, procStart: procStart(process.pid) ?? UNKNOWN_START, bootId: bootId() };
  return self;
}

/**
 * True only when the same process (same boot, same start time) is still running. When either
 * start time is unknown, falls back to "the PID exists in this boot" and errs on the side of alive.
 */
export function isAlive(id: ProcessIdentity): boolean {
  if (id.bootId !== bootId()) return false;
  const start = procStart(id.pid);
  if (start === null) return false;
  if (start === UNKNOWN_START || id.procStart === UNKNOWN_START) return true;
  return start === id.procStart;
}
