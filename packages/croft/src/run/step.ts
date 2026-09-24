// The step contract (DESIGN.md §5 "One ingest step", "Transforms"): what the runner hands every kind of step,
// and what each gives back. runIngest (ingest.ts), runSqlStep (sql.ts) and runTransform (transform.ts) all
// take a StepInput and return a StepOutcome, so the runner dispatches on PlannedStep.kind alone:
//
//   rows | file   runIngest(i: IngestInput)     IngestInput adds --from and the --allow-shrink decider
//   sql           runSqlStep(i: StepInput)
//   transform     runTransform(i: StepInput)
//
// A step throws its failure as a CroftError; the runner records it and decides about retries (§8). It returns
// a StepOutcome otherwise, including when it skipped itself for a confirmation (result.status "skipped",
// `confirmation` set). Only the orchestrator edits this file (the phase-2 execution spec).
import type { Confirmation, Impact, Problem } from "../core/types.ts";
import type { DuckWarehouse } from "../db/warehouse.ts";
import type { LogWriter } from "../history/logs.ts";
import type { RunsDb } from "../history/runs-db.ts";
import type { HttpOptions } from "../http/http.ts";
import type { WriteBatchInput } from "../load/write.ts";
import type { ProjectEnv } from "../project/env.ts";
import type { Project } from "../project/root.ts";
import type { IngestOutcome, StepProgress } from "./ingest.ts";
import type { PlannedStep } from "./plan.ts";

export interface StepInput {
  step: PlannedStep;
  project: Project;
  env: ProjectEnv;
  /** The live warehouse, or the preview database under `croft preview`. */
  warehouse: DuckWarehouse;
  runs: RunsDb;
  runId: string;
  /** This attempt (1-based) and how many the step gets (retries + 1), for StepResult and _croft.writes.attempt. */
  attempt: number;
  maxAttempts: number;
  /** The run's signal combined with the step's no-progress timeout (and, in a preview, the row cap). */
  signal: AbortSignal;
  progress: StepProgress;
  log: LogWriter;
  /** Blocking checks inside the write transaction: checks/run.ts checksHook(step.checks, ...). Absent: none. */
  checks?: WriteBatchInput["checks"];
  /** Downstream assets per column of this asset (column → readers), for COLUMN_STOPPED_ARRIVING. */
  readBy?: Record<string, string[]>;
  /** Asks whether a guarded action may go ahead (LARGE_REPROCESS in a TS transform). Absent: the step fails
   *  with the guard's error instead of asking. */
  confirm?: ConfirmDecider;
  /** Present under `croft preview`: ctx.preview is true, and a TS transform receives at most `rows` input rows
   *  (an ingest stops its generator after `rows` rows). */
  preview?: { rows: number };
  /** HTTP settings for ctx.http (tests shorten retries); the signal, redaction and log are the step's own. */
  http?: Partial<Omit<HttpOptions, "signal" | "redact" | "log">>;
  /** CROFT_FAULT: kill the process at this named point (crash tests). */
  fault?: string;
  /** The clock for stamps; default core/time now() (CROFT_NOW freezes it). */
  now?: () => Date;
}

/** What a step returns: its StepResult, warnings, other problems (CONFIRMATION_REQUIRED), a pending
 *  confirmation, and the catalog entry it mirrored into runs.sqlite. */
export type StepOutcome = IngestOutcome;

/** A guarded action that needs a human's yes, as a step asks its ConfirmDecider. */
export interface ConfirmRequest {
  asset: string;
  /** allow_shrink: a replace ingest's --allow-shrink (SHRINK_GUARD); large_reprocess: the cost guard (§5). */
  action: "allow_shrink" | "large_reprocess";
  /** The command `croft confirm <token>` runs, e.g. "croft run issue_triage". */
  command: string;
  /** What the action does, as shown to the human and hashed into the token (safety/confirm.ts). */
  impact: Impact;
  /** The guard's own problem (SHRINK_GUARD, LARGE_REPROCESS), which the step throws when declined. */
  problem: Problem;
}

/** granted: go ahead in this run. pending: a token was made; skip the step with CONFIRMATION_REQUIRED and
 *  change nothing. declined: fail the step with the guard's problem. */
export type ConfirmDecision = { kind: "granted" } | { kind: "pending"; confirmation: Confirmation } | { kind: "declined" };

export type ConfirmDecider = (r: ConfirmRequest) => Promise<ConfirmDecision>;
