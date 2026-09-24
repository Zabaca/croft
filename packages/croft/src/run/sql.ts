// One SQL transform step (DESIGN.md §3c "How the body is executed", §5 "Transforms"): inside one write
// transaction, `CREATE TEMP VIEW __body AS <body>`, then `CREATE TEMP TABLE next AS SELECT COLUMNS(c -> c NOT IN
// ('_loaded_at', '_file')) FROM __body`, then a diff write like a replace ingest (unchanged rows keep their
// stamps; a changed output shape recreates the table), the checks, and _croft.inputs, all committed together.
// DuckDB errors are located in the asset's file through sql/bind.ts mapAssetError.
//
// PHASE 2 STUB. The signature is final (the phase-2 contract): builder E (SQL step and write) implements it;
// until then it throws INTERNAL_ERROR "PHASE_STUB".
import { phaseStub } from "../core/phase.ts";
import type { StepInput, StepOutcome } from "./step.ts";

/** Run one attempt of an SQL transform step (step.kind "sql", step.sql loaded). Throws the step's failure as a
 *  CroftError. */
export async function runSqlStep(i: StepInput): Promise<StepOutcome> {
  return phaseStub("runSqlStep (run/sql.ts)");
}
