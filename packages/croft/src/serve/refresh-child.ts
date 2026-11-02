// One refresh of the read copy, in a process of its own (DESIGN.md D119): `bun --no-env-file refresh-child.ts <project root>`.
// croft serve in server mode never opens the live file, so when it finds the copy missing, behind or failed (serve/copy-maker.ts)
// it starts this, as the scheduler's ticks start `croft tick`. It runs db/readcopy.ts's refreshReadCopy: the same
// write intent, lease, checkpoint, clone and rename as a run's, coalesced with a run's refresh through runs.sqlite, so
// the two cannot race. It prints one JSON line (the outcome) and exits 0, or 1 when the refresh failed.
//
// How it ends (D124): croft serve decides, and never by SIGKILL first, since the refresh may be checkpointing the live warehouse.
// - SIGTERM, SIGINT and SIGHUP (croft serve stopping, or Ctrl-C reaching the whole process group) are caught: the refresh in hand
//   is finished, its outcome printed, and the process exits. croft serve sends SIGKILL only after a grace period.
// - If croft serve itself is killed (SIGKILL cannot be caught), this process finds out within half a second, from its parent
//   changing, and bounds itself: it finishes the refresh if it can within `orphanGraceMs` (a minute), and is killed by itself
//   after that, so a refresh never outlives its server by more than that.
import type { ReadCopyOptions, ReadCopyOutcome } from "../db/readcopy.ts";
import { refreshReadCopy } from "../db/readcopy.ts";

/** How long a refresh whose croft serve is gone may go on. */
export const ORPHAN_GRACE_MS = 60_000;
/** How often the child looks at its parent. */
const PARENT_POLL_MS = 500;

export interface RefreshChildOptions {
  /** ORPHAN_GRACE_MS. */
  orphanGraceMs?: number;
  /** The refresh's own options (tests pause it with hooks). */
  refresh?: ReadCopyOptions;
}

/** Run the refresh and return the outcome the process prints. Installs the signal handlers and the parent watch. */
export async function runRefreshChild(root: string, o: RefreshChildOptions = {}): Promise<ReadCopyOutcome> {
  let asked = false;
  const ask = () => {
    asked = true;
  };
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(s, ask);
  const parent = process.ppid;
  const watch = setInterval(() => {
    if (process.ppid === parent) return;
    clearInterval(watch);
    ask();
    const bound = setTimeout(() => process.kill(process.pid, "SIGKILL"), o.orphanGraceMs ?? ORPHAN_GRACE_MS);
    (bound as { unref?: () => void }).unref?.();
  }, PARENT_POLL_MS);
  (watch as { unref?: () => void }).unref?.();
  try {
    // Asked to stop before it began: there is nothing to finish.
    if (asked) return { status: "skipped", reason: "croft serve is stopping" };
    return await refreshReadCopy(root, o.refresh);
  } finally {
    clearInterval(watch);
  }
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) {
    console.error("refresh-child.ts takes the project root");
    process.exit(2);
  }
  const out = await runRefreshChild(root);
  try {
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch {
    // croft serve is gone: nobody reads the outcome.
  }
  process.exit(out.status === "failed" ? 1 : 0);
}
