// Running checks (DESIGN.md §3f): blocking ones inside the write transaction, after the write and before
// commit, where a failure rolls back data, schema changes and cursor together [V]; warnings after commit,
// recorded. Scope: `not_null` and row rules cover the rows this write changed (the batch), `unique` and
// `min_rows` the whole table; a check whose text changed since the last run covers the whole table once.
// CHECK_FAILED details are {check, failing, sample}: 20 sample rows collected, 3 rendered.
//
// PHASE 2 STUB. The signatures are final (the phase-2 contract): builder C (checks and staleness) implements
// them; until then each throws INTERNAL_ERROR "PHASE_STUB".
import { phaseStub } from "../core/phase.ts";
import type { Check, Sql } from "../core/types.ts";
import type { CheckContext, CheckHookResult, WriteBatchInput } from "../load/write.ts";

export interface ChecksHookOptions {
  /** Root-relative, for CHECK_FAILED's location and fix. */
  file: string;
  /** Sources of the checks the asset's last successful write ran. A check not among them is new or edited, and
   *  covers the whole table this time. Omitted or null: every check covers the whole table. */
  previous?: readonly string[] | null;
}

/** The writeBatch hook (WriteBatchInput.checks, StepInput.checks) for an asset's blocking checks. It throws
 *  CHECK_FAILED, rolling the write back, when one fails, and otherwise returns one result per check. Non-blocking
 *  checks in `checks` are skipped here (runWarnings runs them). */
export function checksHook(checks: readonly Check[], o: ChecksHookOptions): NonNullable<WriteBatchInput["checks"]> {
  return phaseStub("checksHook (checks/run.ts)");
}

/** A write that has committed: CheckContext without its batch table, which is gone. The rows it changed are
 *  those stamped `loadedAt`. */
export type WarningContext = Omit<CheckContext, "batch">;

/** Run the non-blocking checks in `checks` after a commit, on `sql` (a read lease); blocking ones are skipped.
 *  A failing warning is a problem and a result, never an error. */
export async function runWarnings(sql: Sql, ctx: WarningContext, checks: readonly Check[]): Promise<CheckHookResult> {
  return phaseStub("runWarnings (checks/run.ts)");
}
