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

/** Start time of a process, or null when no such process exists. */
export function procStart(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // Field 22 (starttime) comes after the parenthesized command name, which may contain spaces.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[19] ?? null;
    } catch {
      return null;
    }
  }
  const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  const text = (out.stdout ?? "").trim();
  return out.status === 0 && text ? text : null;
}

let self: ProcessIdentity | undefined;

export function currentIdentity(): ProcessIdentity {
  self ??= { pid: process.pid, procStart: procStart(process.pid) ?? "unknown", bootId: bootId() };
  return self;
}

/** True only when the same process (same boot, same start time) is still running. */
export function isAlive(id: ProcessIdentity): boolean {
  if (id.bootId !== bootId()) return false;
  const start = procStart(id.pid);
  return start !== null && start === id.procStart;
}
