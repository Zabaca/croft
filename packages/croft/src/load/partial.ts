// Monotone partial commits (DESIGN.md §8 "Backfills", D50): a long first load of a cursor ingest commits in
// parts while every cursor value in the new rows is at least every value already committed, so a crash, a kill
// or a rate-limit failure late in the load resumes from the committed cursor instead of refetching from zero.
// Non-monotone sources (newest-first APIs) keep single-transaction behavior. Phase 4 contract stub (MP).
import { phaseStub } from "../core/phase.ts";
import type { CursorType } from "../core/types.ts";

export const PARTIAL_COMMIT_ROWS = 50_000;
export const PARTIAL_COMMIT_MS = 5 * 60_000;

/** Tracks whether a cursor ingest's rows arrive in non-decreasing cursor order, part by part. */
export interface MonotoneTracker {
  /** Record a part's cursor values; false once the order was broken (from then on: one transaction). */
  add(values: readonly unknown[]): boolean;
  readonly monotone: boolean;
  /** The typed maximum seen so far, as the cursor would store it. */
  readonly max: string | null;
}

export function monotoneTracker(type: CursorType, unit: "s" | "ms" | null): MonotoneTracker {
  return phaseStub(`monotoneTracker(${type}, ${unit ?? ""})`);
}
