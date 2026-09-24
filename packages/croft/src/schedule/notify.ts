// Failure notifications of scheduled runs (DESIGN.md §8 "What the user experiences"): a desktop notification
// by default (osascript on macOS, notify-send on Linux) and an optional webhook that receives the redacted
// failure envelope. `notify` in croft.json configures both. CROFT_NOTIFY_DRY=1 (tests/preload.ts) records
// what would be shown instead of showing it.
import type { Problem } from "../core/types.ts";

export interface ScheduledFailure {
  project: string;
  runId: string;
  /** Assets whose step failed, crashed or was interrupted. */
  failed: { asset: string; error: Problem | null }[];
}

/** Called by the runner when a run with trigger "schedule" ends with failed steps. Never throws. */
export async function notifyScheduledFailure(_root: string, _failure: ScheduledFailure): Promise<void> {
  // Built in phase 3 wave 2 (NT); a no-op until then.
}
