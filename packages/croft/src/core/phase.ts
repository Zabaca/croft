// Phase-1 honesty notes (DESIGN.md §11). Checks are declared, listed by describe and context, and passed
// through to the write, but nothing evaluates them until phase 2. So the output says so, rather than let
// "Checks unique(id) · not_null(id)" read as a promise.
//
// To remove when phase 2 runs checks: delete this file and every use of it (grep CHECKS_ENFORCED): the
// `checksEnforced` field of run, wait, describe and context data, and the human lines in run.ts,
// describe.ts and context.ts.

/** Whether checks run. `checksEnforced` in run, describe and context JSON. */
export const CHECKS_ENFORCED = false as const;

/** The human line that says it. */
export const CHECKS_NOT_ENFORCED = "checks: not enforced until phase 2";
