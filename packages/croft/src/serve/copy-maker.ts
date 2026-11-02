// Making the read copy for croft serve in server mode (DESIGN.md D119). croft serve never opens the live file, so it
// cannot refresh the copy itself; a run does, at its end. But a project that turns server mode on with its data already
// built, whose next runs change nothing, would have no copy (every query DB_NOT_FOUND), and a refresh that failed or
// never followed a run would leave the copy behind. So when the copy is missing, behind or failed, croft serve starts a
// short-lived child process that refreshes it (serve/refresh-child.ts, the scheduler's tick pattern) and carries on
// answering meanwhile: a retryable 503 until there is a copy, the old copy while it is behind.
//
// It is checked when croft serve starts and then every few seconds. A refresh already under way (a run's, or another
// maker's) is left alone: db/readcopy.ts coalesces them. A failed one is tried again after a wait that doubles, so a full
// disk is not hammered.
//
// Ending a child (D124): never SIGKILL first. A refresh may be checkpointing the live warehouse, so the child is sent SIGTERM,
// which it catches (serve/refresh-child.ts): it finishes the refresh in hand and exits. Only a child still running after a
// short grace period is killed. A child whose croft serve was killed (no signal can be caught) bounds itself.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readCopyStatus } from "../db/readcopy.ts";
import type { Project } from "../project/root.ts";
import { tickEnv } from "./loop.ts";

/** The child's entry: the same croft this server runs. */
export const REFRESH_CHILD_FILE = fileURLToPath(new URL("./refresh-child.ts", import.meta.url));

/** How often the engine asks whether a copy is needed. */
export const COPY_CHECK_MS = 5000;
/** A refresh child that runs longer is ended (db/readcopy.ts's own clone timeout is 10 minutes). */
const CHILD_TIMEOUT_MS = 12 * 60_000;
/** How long a child that was asked to end (SIGTERM) may take to finish the refresh in hand before it is killed. */
export const STOP_GRACE_MS = 5000;

export type CopyNeed = "missing" | "behind" | "failed";

export interface CopyMakerOptions {
  project: Project;
  /** The child's command (tests); `bun --no-env-file refresh-child.ts <root>` by default. */
  argv?: string[];
  /** The wait after a failed refresh, doubling with each failure in a row (30 s, 1 min, ... 10 min). */
  failureWaitMs?: number;
  /** The wait after a refresh that succeeded (or found nothing to do), before the next check can start another. */
  settleMs?: number;
  /** Called when a child ends, with what it printed (or null). */
  onDone?(r: { need: CopyNeed; ok: boolean; message: string | null }): void;
  /** STOP_GRACE_MS. */
  stopGraceMs?: number;
}

export class CopyMaker {
  private child: ReturnType<typeof Bun.spawn> | null = null;
  private failures = 0;
  private nextAt = 0;
  private stopped = false;
  private done: Promise<void> = Promise.resolve();
  /** Why the last child failed, for the 503 queries get meanwhile; null after a success. */
  lastFailure: string | null = null;
  /** Children started since croft serve started. */
  started = 0;

  constructor(private readonly o: CopyMakerOptions) {}

  /** A child is running now. */
  get running(): boolean {
    return this.child !== null;
  }

  /**
   * Whether the copy needs making: there is a warehouse and the copy is missing, behind the last run that wrote data, or
   * its last refresh failed, and no refresh is under way. A stat and runs.sqlite; opens neither DuckDB file.
   */
  need(): CopyNeed | null {
    const p = this.o.project;
    if (!existsSync(p.paths.database)) return null; // nothing to copy until a run creates it
    const h = readCopyStatus(p).health;
    return h === "missing" || h === "behind" || h === "failed" ? h : null;
  }

  /** Start a child if a copy is needed, none runs, and the wait after the last failure is over. Never throws. */
  check(): void {
    if (this.stopped || this.child || Date.now() < this.nextAt) return;
    let need: CopyNeed | null;
    try {
      need = this.need();
    } catch {
      return;
    }
    if (!need) return;
    this.start(need);
  }

  private start(need: CopyNeed): void {
    const argv = this.o.argv ?? [process.execPath, "--no-env-file", REFRESH_CHILD_FILE, this.o.project.root];
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(argv, { cwd: this.o.project.root, env: tickEnv(process.env), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (e) {
      this.finish(need, false, `could not start the refresh: ${(e as Error).message}`);
      return;
    }
    this.child = proc;
    this.started++;
    const timer = setTimeout(() => this.end(proc), CHILD_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
    this.done = (async () => {
      const [out, err] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()]);
      const code = await proc.exited;
      clearTimeout(timer);
      this.child = null;
      let message: string | null = null;
      let ok = code === 0;
      try {
        const line = JSON.parse(out.trim().split("\n").at(-1) ?? "null") as { status?: string; error?: { message?: string }; reason?: string } | null;
        // "coalesced": another process is refreshing; "skipped": nothing to copy yet. Neither made a copy, so wait a little.
        if (line?.status === "failed") message = line.error?.message ?? "the refresh failed";
        else if (line?.status === "skipped" || line?.status === "coalesced") ok = false, message = line.reason ?? line.status;
      } catch {
        if (code !== 0) message = err.trim().split("\n").at(-1) ?? `exit ${code}`;
      }
      this.finish(need, ok, ok ? null : message ?? `exit ${code}`);
    })();
  }

  private finish(need: CopyNeed, ok: boolean, message: string | null): void {
    if (ok) {
      this.failures = 0;
      this.lastFailure = null;
      this.nextAt = Date.now() + (this.o.settleMs ?? 2000);
    } else {
      this.failures++;
      this.lastFailure = message;
      this.nextAt = Date.now() + Math.min(10 * 60_000, (this.o.failureWaitMs ?? 30_000) * 2 ** (this.failures - 1));
    }
    try {
      this.o.onDone?.({ need, ok, message });
    } catch {
      // A hook never breaks the maker.
    }
  }

  /** Ask a child to end: SIGTERM, which lets it finish the refresh in hand, and SIGKILL once the grace period has passed. */
  private end(proc: ReturnType<typeof Bun.spawn>): void {
    try {
      proc.kill("SIGTERM");
    } catch {
      return; // gone
    }
    const kill = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // gone
      }
    }, this.o.stopGraceMs ?? STOP_GRACE_MS);
    (kill as { unref?: () => void }).unref?.();
    void proc.exited.then(() => clearTimeout(kill));
  }

  /** Stop: no more children, and the one running is asked to end (it finishes its refresh, or is killed after the grace). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.child) this.end(this.child);
    await this.done.catch(() => {});
  }
}
