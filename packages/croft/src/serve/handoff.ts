// How croft serve notices a writer and gets its queries out of the way (DESIGN.md §5 "Write intents",
// "Handing the file over").
//
// - The intent folder is polled every 50 ms. fs.watch on it only shortens the delay: on macOS it merges and
//   drops events [V], so nothing relies on it.
// - Two liveness checks. Stepping aside uses a quick one (the PID exists in this boot): it spawns nothing, so
//   the file is released within milliseconds of the intent appearing, and stepping aside for an intent whose
//   writer is gone costs only a brief close. Reopening uses the full check (boot id and process start time,
//   db/intent.ts isHolderAlive, which runs `ps` on macOS), and removes the intents of dead writers; a reused
//   PID therefore never keeps the server closed.
// - drain(): running queries may finish for graceMs (2 s); then each one still running is interrupted every
//   20 ms until it settles (queue.ts Flight.stop). Only after that may connections be disconnected: a connection
//   disconnected while its interrupted query had not settled kept the lock, and that query never settled [V].
import { type FSWatcher, mkdirSync, rmSync, watch } from "node:fs";
import { sameBoot } from "../core/proc.ts";
import { intentDir, type IntentEntry, isHolderAlive, listIntents, purgeDead } from "../db/intent.ts";
import type { Admission, StopReason } from "./queue.ts";

export interface IntentWatchOptions {
  stateDir: string;
  /** Poll interval (50 ms). */
  pollMs: number;
  /** Called on every poll and whenever the folder changes; it decides what to do. */
  onTick(): void;
  /** Watch the folder to wake before the next poll (default true). */
  watch?: boolean;
}

/** Whether a PID exists (EPERM: it does, owned by someone else). */
function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class IntentWatch {
  private timer: ReturnType<typeof setInterval> | null = null;
  private watcher: FSWatcher | null = null;
  private woken = false;

  constructor(private readonly o: IntentWatchOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.o.onTick(), this.o.pollMs);
    // The HTTP server keeps croft serve alive; the watch alone never should.
    (this.timer as { unref?: () => void }).unref?.();
    if (this.o.watch !== false) this.watchFolder();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      this.watcher?.close();
    } catch {}
    this.watcher = null;
  }

  /**
   * Intents that may be live: a readable intent whose PID exists in this boot. Spawns nothing. The rest are
   * certainly dead (no such process, another boot, an unreadable file) and are removed on the way.
   */
  candidates(): IntentEntry[] {
    const out: IntentEntry[] = [];
    for (const i of listIntents(this.o.stateDir)) {
      if (i.pid > 0 && sameBoot(i.bootId) && pidExists(i.pid)) out.push(i);
      else rmSync(i.file, { force: true });
    }
    return out;
  }

  /** Intents whose writer is proven alive (same boot, same start time). The others are removed. */
  live(): IntentEntry[] {
    const all = listIntents(this.o.stateDir);
    const live = all.filter((i) => i.pid > 0 && isHolderAlive(i));
    if (live.length < all.length) purgeDead(this.o.stateDir);
    return live;
  }

  private watchFolder(): void {
    const dir = intentDir(this.o.stateDir);
    try {
      mkdirSync(dir, { recursive: true }); // a writer creates it anyway; it must exist to be watched
      this.watcher = watch(dir, () => this.wake());
      this.watcher.on("error", () => {
        try {
          this.watcher?.close();
        } catch {}
        this.watcher = null; // polling carries on alone
      });
      (this.watcher as { unref?: () => void }).unref?.();
    } catch {
      this.watcher = null;
    }
  }

  /** One tick for a burst of events (a temp file, then its rename). */
  private wake(): void {
    if (this.woken || !this.timer) return;
    this.woken = true;
    setImmediate(() => {
      this.woken = false;
      if (this.timer) this.o.onTick();
    });
  }
}

/**
 * Let the flights in `a` finish for `graceMs`, then stop each one still running for `reason` (interrupted every
 * 20 ms until it settles), and resolve once none holds a slot. Admission must already be paused.
 */
export async function drain(a: Pick<Admission, "active" | "idle">, o: { graceMs: number; reason: StopReason }): Promise<{ interrupted: number }> {
  if (a.active.size === 0) return { interrupted: 0 };
  const idle = a.idle();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const graceOver = await Promise.race([
    idle.then(() => false),
    new Promise<boolean>((r) => (timer = setTimeout(() => r(true), o.graceMs))),
  ]);
  clearTimeout(timer);
  if (!graceOver) return { interrupted: 0 };
  const stopped = [...a.active];
  for (const f of stopped) f.stop(o.reason);
  await idle;
  return { interrupted: stopped.length };
}
