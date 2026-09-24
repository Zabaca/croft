// One TS transform step (DESIGN.md §3e, §5 "Transforms"): inputs read from ordered Parquet snapshots (never the
// warehouse lock while user code runs), Proxy-guarded rows (UNKNOWN_INPUT_COLUMN), ctx.rows/newRows/query over
// the declared inputs (UNDECLARED_INPUT), composite positions, chunked commits for incremental transforms (500
// rows or 60 s, each with its checks and positions), the cost guard (LARGE_REPROCESS through StepInput.confirm),
// and the same load pipeline as an ingest.
//
// PHASE 2 STUB. The signature is final (the phase-2 contract): builder D (TS transforms) implements it; until
// then it throws INTERNAL_ERROR "PHASE_STUB".
import { phaseStub } from "../core/phase.ts";
import type { StepInput, StepOutcome } from "./step.ts";

/** Run one attempt of a TS transform step (step.kind "transform"). Throws the step's failure as a CroftError. */
export async function runTransform(i: StepInput): Promise<StepOutcome> {
  return phaseStub("runTransform (run/transform.ts)");
}
