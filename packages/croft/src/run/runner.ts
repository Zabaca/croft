// The run engine (DESIGN.md §5 "Processes", "Leases", "Transforms", "Crash recovery"; §6 confirmation; §8
// "Retries", "Timeout").
//
//   reconcile()     first, like every writing command: dead runs become crashed, their leases go
//   plan            discover, select, load, what each asset does and why (plan.ts)
//   createRun       runs.sqlite: the run, argv, and the process that does the work
//   asset leases    all or nothing, so two runs never touch one asset (history/leases.ts)
//   steps           in dependency order: a step starts once every planned step in its orderAfter has ended. Up to
//                   `concurrency` ingests and TS transforms extract at once; SQL steps run one at a time (DuckDB
//                   parallelizes inside each query); writes queue behind the warehouse's in-process write mutex,
//                   so one write step commits at a time
//   dispatch        by step.kind (step.ts): rows | file → runIngest, sql → runSqlStep, transform → runTransform
//   downstream      a failed, held or confirmation-waiting input skips the steps that read it (skippedBecause
//                   "input open_issues failed (r_…)"), transitively; a transform whose inputs did not change after
//                   all (staleness re-checked from the catalog mirror just before it) is skipped as up to date
//   checks          every write runs checks/run.ts checksHook(step.checks), ingests included, with the check
//                   sources of the asset's last ok step (a new or edited check covers the whole table once); the
//                   warnings run after the commit under a read lease (runSqlStep runs its own)
//   confirmations   one ConfirmDecider for --allow-shrink (SHRINK_GUARD) and the cost guard (LARGE_REPROCESS): a
//                   y/N question on a TTY, the token `croft confirm` carries, or a new token. One token per run: a
//                   second step that needs one is skipped, with a next hint to run it afterwards
//   retries         2 by default, after 30 s and 2 min (or the server's longer Retry-After, up to 5 min), for
//                   retryable errors only
//   no progress     no row yielded and no request completed for `timeout` (10 min) → TIMEOUT
//   signals         the caller's AbortSignal (SIGINT/SIGTERM): the step is interrupted, its transaction
//                   discarded, the run marked interrupted, exit 130
//   finishRun       the whole command result goes into runs.summary, so a detached run's parent and
//                   `croft wait` print exactly what an in-process run prints
//
// Every step writes <state>/logs/<run>/<asset>.log; the run writes <state>/logs/<run>/events.ndjson, which
// --events copies to stderr and `croft wait` reads for progress.
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { checksHook, runWarnings } from "../checks/run.ts";
import { CroftError, exitCodeFor } from "../core/errors.ts";
import type { Confirmation, CursorType, Hold, Problem, Reason, StepResult } from "../core/types.ts";
import type { ExampleResult } from "../project/init.ts";
import { Confirmations } from "../safety/confirm.ts";
import { openWarehouse, type DuckWarehouse } from "../db/warehouse.ts";
import { allCatalog, type CatalogAsset, getCatalog } from "../history/catalog.ts";
import { acquire, release } from "../history/leases.ts";
import { logDir, logPath, NOT_STARTED_RECORD, openLog, type LogWriter, writeRunRecord } from "../history/logs.ts";
import { reconcile } from "../history/reconcile.ts";
import { RunsDb, type RunStatus, type RunTrigger } from "../history/runs-db.ts";
import type { HttpOptions } from "../http/http.ts";
import { redactProblem } from "../cli/render.ts";
import { currentDatabase, isReservedColumn, quoteIdent, tableRef } from "../load/evolve.ts";
import type { CheckHookResult, WriteBatchInput } from "../load/write.ts";
import { outsideCapture, setOutputRedactor } from "../core/output.ts";
import { now as clockNow } from "../core/time.ts";
import { ProjectEnv } from "../project/env.ts";
import { loadProject, type Project } from "../project/root.ts";
import {
  croftError, fromSince, isRetryable, type ProgressSnapshot, runIngest, savedCursors, SHRINK_ACTION, shrinkCommand, StepProgress,
} from "./ingest.ts";
import { backfillUnsupported, isGlob, loadErrors, planRun, type PlannedStep, type RunPlan } from "./plan.ts";
import { runSqlStep } from "./sql.ts";
import { staleReasons } from "./staleness.ts";
import type { ConfirmDecider, ConfirmRequest, StepInput, StepOutcome } from "./step.ts";
import { pendingChunkDir, runTransform } from "./transform.ts";

export { shrinkCommand } from "./ingest.ts";

/** Delays before retries 1 and 2 (§8 "Retries"). */
export const RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000];
/** The longest a run waits for a server's Retry-After before the next attempt; a longer one ends the step with
 *  nextRetryAt (like ctx.http's maxRetryAfterMs inside one attempt). */
export const RETRY_WAIT_LIMIT_MS = 300_000;

/** The wait a failed request's server asked for (HTTP_ERROR details.retryAfterMs), or null. */
export function retryAfterOf(p: Problem): number | null {
  const v = p.code === "HTTP_ERROR" ? p.details?.retryAfterMs : undefined;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** Lease waits: off a TTY every wait is capped at 90 s (§5 "Default waits"); on a TTY a run waits 10 min. */
export const LEASE_WAIT_MS = { offTty: 90_000, tty: 600_000 } as const;

export interface Next { command: string; reason: string }

export interface RunData {
  runId: string;
  status: RunStatus;
  progress?: ProgressSnapshot;
  steps: StepResult[];
}

/** A run's whole command result: what `croft run` prints, stored in runs.summary for `croft wait`. */
export interface RunSummary {
  data: RunData;
  problems: Problem[];
  next: Next[];
  confirmation?: Confirmation;
  exit: number;
  ok: boolean;
}

export type RunOutcome = RunSummary;

export interface RunEvent {
  type: "run" | "step" | "progress" | "retry" | "waiting";
  [key: string]: unknown;
}

export interface RunnerOptions {
  project: Project;
  env: ProjectEnv;
  selectors: readonly string[];
  /** The command line for the run record, without hidden flags: ["run", "github_issues"]. */
  argv: readonly string[];
  /** A detached run's id, chosen by the parent. */
  runId?: string;
  trigger?: RunTrigger;
  /** A person started the run (a terminal, Claude Code), not the scheduler: a successful step approves its code
   *  (§6 scheduler hold), and the cost guard may ask for a confirmation. Default true. */
  human?: boolean;
  from?: string;
  allowShrink?: boolean;
  /** --only (skip downstream) and --upstream (refresh stale inputs first): handed to the planner. */
  only?: boolean;
  upstream?: boolean;
  confirmToken?: string;
  /** stdin and stdout are a terminal: longer waits, and a confirmation is a y/N question instead of a token. */
  interactive?: boolean;
  /** Asks a yes/no question on the terminal (interactive runs only). */
  prompt?: (question: string) => Promise<boolean>;
  noWait?: boolean;
  /** Called with every event (the line is what goes to events.ndjson). */
  onEvent?: (line: string, event: RunEvent) => void;
  /** Aborted by SIGINT/SIGTERM (the command wires them); its reason should be an INTERRUPTED CroftError. */
  signal?: AbortSignal;
  retryDelaysMs?: readonly number[];
  /** Overrides RETRY_WAIT_LIMIT_MS (tests). */
  retryWaitLimitMs?: number;
  concurrency?: number;
  /** Overrides every asset's no-progress timeout (tests). */
  timeoutMs?: number;
  http?: Partial<Omit<HttpOptions, "signal" | "redact" | "log">>;
  /** CROFT_FAULT (crash tests). */
  fault?: string;
  plan?: RunPlan;
  now?: () => Date;
}

/**
 * Flag rules that need the plan: destructive flags take exactly one exact name (§6 "Guards aimed at agents"),
 * and --from on an asset named exactly must apply to it (§8: BACKFILL_UNSUPPORTED). A confirmation carries out
 * --allow-shrink, or the cost guard (LARGE_REPROCESS) of the one transform named: its token is for
 * `croft run <transform>`. Called before the run exists, by the detached parent too, so such a refusal is never a
 * run or a failed step.
 */
export function checkRunFlags(plan: RunPlan, o: Pick<RunnerOptions, "selectors" | "from" | "allowShrink" | "confirmToken">): void {
  const usage = (message: string, hint: string) => new CroftError("USAGE_ERROR", { message, hint });
  const named = o.selectors.length === 1 && !isGlob(o.selectors[0]!) ? plan.steps.find((s) => s.asset === o.selectors[0]) : undefined;
  if (o.confirmToken !== undefined && !o.allowShrink && named?.kind !== "transform") {
    throw usage("a confirmation applies only to --allow-shrink or to the cost guard of one transform", "croft confirm <token> runs the confirmed command for you");
  }
  if (o.from !== undefined && !o.allowShrink) {
    for (const s of plan.steps) {
      // A broken asset fails its own step; its planned kind says nothing about --from.
      if (!o.selectors.includes(s.asset) || loadErrors(s).length > 0) continue;
      const unsupported = backfillUnsupported(s);
      if (unsupported) throw unsupported;
    }
  }
  if (!o.allowShrink) return;
  if (o.from !== undefined) throw usage("--allow-shrink and --from do not go together", "--from backfills merge ingests; the shrink guard applies to replace ingests");
  if (o.selectors.length !== 1 || isGlob(o.selectors[0]!)) {
    throw usage("--allow-shrink takes exactly one asset name", "name the asset: croft run <asset> --allow-shrink (no globs; destructive options name one asset)");
  }
  const step = plan.steps.find((s) => s.asset === o.selectors[0]);
  if (step && step.action === "fetch" && step.spec && step.write !== "replace") {
    throw usage(`${step.asset} ${step.write === "merge" ? "merges" : "appends"} rows; only replace ingests have a shrink guard`, `run it without --allow-shrink: croft run ${step.asset}`);
  }
  if (step && (step.kind === "sql" || step.kind === "transform")) {
    throw usage(`${step.asset} is a transform; only replace ingests have a shrink guard`, `run it without --allow-shrink: croft run ${step.asset}`);
  }
}

function isProblem(v: unknown): v is Problem {
  const p = v as Partial<Problem> | null;
  return !!p && typeof p === "object" && typeof p.code === "string" && typeof p.message === "string" && typeof p.severity === "string";
}

/**
 * Redact what a run keeps on disk (runs.sqlite, events.ndjson), the way the CLI redacts its envelope: problems
 * as free text (every .env value), everything else under the data policy (declared secrets and credential-like
 * values), so a .env value like MODE=replace cannot rewrite a step's `behavior`. Codes and statuses stay intact.
 */
export function redactValue<T>(value: T, env: ProjectEnv): T {
  const data = (t: string) => env.redactData(t);
  const text = (t: string) => env.redact(t);
  const walk = (v: unknown): unknown => {
    if (isProblem(v)) return redactProblem(v, text);
    if (typeof v === "string") return data(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) Object.defineProperty(o, k, { value: walk(x), enumerable: true, writable: true, configurable: true });
      return o;
    }
    return v;
  };
  return walk(value) as T;
}

/** Events for one run: appended to events.ndjson and handed to the caller. */
export class EventLog {
  readonly path: string;
  constructor(stateDir: string, runId: string, private readonly onEvent?: (line: string, event: RunEvent) => void,
    private readonly redact: <T>(v: T) => T = (v) => v) {
    const dir = logDir(stateDir, runId);
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, "events.ndjson");
  }

  emit(event: RunEvent): void {
    const full = this.redact({ ...event, at: new Date().toISOString() });
    const line = jsonLine(full);
    try {
      appendFileSync(this.path, `${line}\n`);
    } catch {
      // Progress must never fail a run.
    }
    // Progress is emitted from inside a step's console capture (a request completing in rows()); it is croft's own
    // output, so the caller writes it outside the capture (core/output.ts).
    const onEvent = this.onEvent;
    if (onEvent) outsideCapture(() => onEvent(line, full));
  }
}

export function eventsPath(stateDir: string, runId: string): string {
  return join(logDir(stateDir, runId), "events.ndjson");
}

function jsonLine(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? (x >= BigInt(Number.MIN_SAFE_INTEGER) && x <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(x) : x.toString()) : x));
}

/** A JSON-safe deep copy (bigint → number or text), so a summary can go into runs.sqlite. */
export function jsonSafe<T>(v: T): T {
  return JSON.parse(jsonLine(v)) as T;
}

function emptyRows(total = 0): StepResult["rows"] {
  return { in: 0, added: 0, updated: 0, unchanged: 0, deleted: 0, total };
}

function internal(e: unknown): CroftError {
  const err = e instanceof Error ? e : new Error(String(e));
  return new CroftError("INTERNAL_ERROR", {
    message: `${err.name}: ${err.message}`,
    hint: "this is a bug in croft, not in your project; report it with the command you ran and this output",
    details: { stack: (err.stack ?? "").split("\n").slice(0, 8) },
  });
}

function timeoutError(step: PlannedStep, ms: number, progress: StepProgress): CroftError {
  const mins = ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 100) / 10} s`;
  return new CroftError("TIMEOUT", {
    asset: step.asset, file: step.file,
    message: `${step.asset} made no progress for ${mins}: no row was yielded and no request completed`,
    hint: `check that the API answers; if it is just slow, raise the asset's timeout (e.g. timeout: "30m")`,
    effect: "nothing was written; the cursor did not move",
    retryable: false,
    details: { phase: progress.phase, rowsSoFar: progress.rows, lastRequest: progress.lastRequest ?? null, timeoutMs: ms },
  });
}

/** At most `limit` holders at once; waiters are served in the order they asked. */
class Semaphore {
  #free: number;
  readonly #queue: (() => void)[] = [];

  constructor(limit: number) {
    this.#free = Math.max(1, limit);
  }

  async acquire(): Promise<() => void> {
    if (this.#free > 0) this.#free--;
    else await new Promise<void>((resolve) => this.#queue.push(resolve));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#queue.shift();
      if (next) next();
      else this.#free++;
    };
  }
}

/**
 * The order steps start in: every step after the planned steps in its orderAfter, ties broken by the plan's own
 * order (project/graph.ts order), then by name. A cycle, which the plan reports as CYCLE, cannot stall the run: its
 * first step in the plan's order goes first.
 */
export function runOrder(plan: Pick<RunPlan, "steps" | "order">): string[] {
  const rank = new Map<string, number>();
  plan.order.forEach((n, i) => rank.has(n) || rank.set(n, i));
  const names = plan.steps.map((s) => s.asset)
    .sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || (a < b ? -1 : a > b ? 1 : 0));
  const planned = plannedNames(plan.steps);
  const deps = new Map(plan.steps.map((s) => [s.asset, new Set(planned(s.orderAfter).filter((d) => d !== s.asset))]));
  const out: string[] = [];
  const placed = new Set<string>();
  while (out.length < names.length) {
    const left = names.filter((n) => !placed.has(n));
    const next = left.find((n) => [...deps.get(n)!].every((d) => placed.has(d))) ?? left[0]!;
    placed.add(next);
    out.push(next);
  }
  return out;
}

/** Maps asset names as a step lists them (an SQL body may spell them in another case) to the planned steps'. */
function plannedNames(steps: readonly PlannedStep[]): (names: readonly string[]) => string[] {
  const byLower = new Map(steps.map((s) => [s.asset.toLowerCase(), s.asset]));
  return (names) => [...new Set(names.flatMap((n) => {
    const hit = byLower.get(n.toLowerCase());
    return hit ? [hit] : [];
  }))];
}

/** The assets a step reads (PlannedStep.inputs; an SQL file's AST inputs or a transform's declared ones if the
 *  plan left them out). */
function inputsOf(step: PlannedStep): string[] {
  if (step.inputs.length) return step.inputs;
  return step.sql?.astInputs ?? step.spec?.inputs ?? [];
}

function cursorTypes(runs: RunsDb): Record<string, CursorType> {
  const out: Record<string, CursorType> = {};
  for (const c of allCatalog(runs)) if (c.cursor?.type) out[c.asset] = c.cursor.type;
  return out;
}

/**
 * --from against the saved cursors, before the run exists (§8). An asset named exactly that --from cannot
 * apply to refuses the whole command (BACKFILL_WOULD_DUPLICATE, or USAGE_ERROR for a --from that does not
 * parse); in a bare run or a glob such an asset is skipped instead. Returns why each skipped asset is skipped.
 */
async function checkFrom(plan: RunPlan, o: RunnerOptions, warehouse: DuckWarehouse): Promise<Map<string, string>> {
  const skips = new Map<string, string>();
  if (o.from === undefined) return skips;
  const candidates = plan.steps.filter((s) => s.action === "fetch" && loadErrors(s).length === 0);
  const saved = await savedCursors(warehouse, candidates.filter((s) => !backfillUnsupported(s)).map((s) => s.asset), o.signal);
  const now = (o.now ?? clockNow)();
  for (const s of candidates) {
    try {
      fromSince(s, o.from, saved.get(s.asset) ?? { value: null, type: null }, { timezone: o.project.timezone, now });
    } catch (e) {
      const err = croftError(e);
      if (!err || !err.code.startsWith("BACKFILL_") || o.selectors.includes(s.asset)) throw e;
      skips.set(s.asset, err.code === "BACKFILL_UNSUPPORTED" ? FROM_ONLY_MERGE : err.problem.message);
    }
  }
  return skips;
}

const FROM_ONLY_MERGE = "--from applies to merge ingests";

/** A detached child that fails before it records its run leaves the problem for its parent and `croft wait`. */
function recordNotStarted(o: RunnerOptions, e: unknown): void {
  if (!o.runId) return;
  try {
    const p = (croftError(e) ?? internal(e)).problem;
    writeRunRecord(o.project.paths.stateDir, o.runId, NOT_STARTED_RECORD, redactValue(jsonSafe({ ...p, runId: o.runId }), o.env));
  } catch {
    // The parent still reports the child's exit and output.
  }
}

function interruptedError(message = "the run was interrupted"): CroftError {
  return new CroftError("INTERRUPTED", { message, hint: "steps that had not committed saved nothing; run again to finish" });
}

/** What each confirmation action is, in the words of a skipped step. */
const ACTION_WORDS: Record<ConfirmRequest["action"], string> = {
  allow_shrink: "--allow-shrink would shrink it",
  large_reprocess: "LARGE_REPROCESS: it would process many input rows and make requests for them",
};

function nextSteps(steps: StepResult[], problems: Problem[], deferred: ReadonlyMap<string, ConfirmRequest>): Next[] {
  const next: Next[] = [];
  const busy = problems.find((p) => p.code === "ASSET_BUSY");
  if (busy?.runId) next.push({ command: `croft wait ${busy.runId} --timeout 100s`, reason: `${busy.asset ?? "an asset"} is held by that run` });
  for (const s of steps) {
    if (s.status !== "failed" || !s.error) continue;
    if (s.error.code === "INTERRUPTED") continue;
    next.push({ command: `croft logs ${s.asset} --failed`, reason: `see why ${s.asset} failed` });
    if (isRetryable(s.error)) {
      next.push({
        command: `croft run ${s.asset}`,
        reason: s.nextRetryAt ? `the API asks to wait; run it again after ${s.nextRetryAt}` : "the error is temporary; run it again later",
      });
    }
  }
  // A step that needs a confirmation of its own, after the one this run asked for. Destructive commands never go
  // in next (§4.3): `croft run <transform>` only asks again, while `--allow-shrink` is named in skippedBecause.
  for (const [asset, req] of deferred) {
    if (req.action !== "large_reprocess") continue;
    next.push({ command: req.command, reason: `${asset} needs its own confirmation; run it after the pending one is settled` });
  }
  const ok = steps.find((s) => s.status === "ok" && s.rows.total > 0);
  if (ok && next.length === 0) next.push({ command: `croft query "from ${ok.asset} limit 5"`, reason: `look at ${ok.asset}` });
  if (steps.length === 0 && problems.length === 0) next.push({ command: "croft docs ingest", reason: "assets/ has no assets yet; start from a template" });
  return next;
}

/** Why a held step does not run (PlannedStep.hold). */
const HOLD_WORDS: Record<Hold, string> = {
  code_not_run_by_hand: "held: its code has not been run by hand yet",
  large_reprocess: "held: it would process too many input rows without a person's yes (LARGE_REPROCESS)",
  paused: "held: scheduling is paused",
  leased: "held: another run holds it",
};

/** The reasons a planner gives only because the asset looked stale; the runner re-checks them. */
const STALENESS: ReadonlySet<Reason> = new Set<Reason>(["never_built", "code_changed", "input_changed", "input_replaced"]);

/** A stamp no row carries: warnings of a write that changed no row look at no rows (only whole-table ones run). */
const NO_ROWS_STAMP = "1970-01-01T00:00:00.000000Z";

/**
 * Execute a run in this process and return its whole result. Never throws for a step's failure; throws only
 * for problems before the run exists (a broken croft.json, an unknown selector).
 */
export async function executeRun(o: RunnerOptions): Promise<RunOutcome> {
  const { project, env } = o;
  const paths = project.paths;
  // Asset output that escapes its step's scope reaches stderr redacted with this project's .env (core/output.ts).
  setOutputRedactor((t) => env.redact(t));
  mkdirSync(paths.stateDir, { recursive: true });
  const runs = RunsDb.open(paths.stateDir);
  let warehouse: DuckWarehouse | undefined;
  try {
    const interactive = o.interactive === true;
    // Everything that can refuse the command happens before the run exists: a refusal is never a run or a
    // failed step. A detached child records it for its parent and `croft wait` (recordNotStarted).
    let plan: RunPlan;
    let rec: Awaited<ReturnType<typeof reconcile>>;
    let fromSkips: Map<string, string>;
    try {
      // --only and --upstream are the planner's; they go through as they are (plan.ts PlanInput).
      const narrowing = { ...(o.only ? { only: true } : {}), ...(o.upstream ? { upstream: true } : {}) };
      plan = o.plan ?? await planRun({ root: project.root, timezone: project.timezone, selectors: o.selectors, cursorTypes: cursorTypes(runs), ...narrowing });
      checkRunFlags(plan, o);
      // Every declared secret is hidden in data, not only the ones this run reads.
      for (const s of plan.steps) if (s.spec) env.declare(s.spec.secrets);
      // No file-ingest directories in the sandbox: extractFiles snapshots every file into the state folder, and
      // the write reads only those snapshots (a `file: "*.csv"` ingest would otherwise open the whole root).
      warehouse = openWarehouse({
        path: paths.database, mode: "read_write", timezone: project.timezone, root: project.root, stateDir: paths.stateDir,
        isTTY: interactive, ...(o.runId ? { runId: o.runId } : {}),
        // --no-wait: a held database file is exit 4 at once, like a held asset.
        ...(o.noWait ? { waits: { offTtyMs: 0, ttyReadMs: 0, ttyWriteMs: 0 } } : {}),
        lookupHolder: (pid) => {
          const h = runs.getLockHolder();
          return h && h.pid === pid ? h : null;
        },
        // Fairness (§5 "Leases"): a writer that sees waiters yields between its write steps (ingest.ts).
        onWait: () => runs.registerWaiter(`croft run${o.runId ? ` ${o.runId}` : ""}`),
      });
      rec = await reconcile({ db: runs, warehouse });
      for (const dir of rec.stagingDirs) rmSync(dir, { recursive: true, force: true });
      pruneStaging(paths.stateDir, runs);
      fromSkips = await checkFrom(plan, o, warehouse);
    } catch (e) {
      recordNotStarted(o, e);
      throw e;
    }

    const run = runs.createRun({
      ...(o.runId ? { id: o.runId } : {}), trigger: o.trigger ?? "manual", human: o.human ?? true, argv: [...o.argv], timeZone: project.timezone,
    });
    const runId = run.id;
    const events = new EventLog(paths.stateDir, runId, o.onEvent, (v) => redactValue(v, env));
    const runAc = new AbortController();
    const onOuterAbort = () => runAc.abort(croftError(o.signal?.reason) ?? interruptedError());
    if (o.signal?.aborted) onOuterAbort();
    else o.signal?.addEventListener("abort", onOuterAbort, { once: true });
    const runSignal = runAc.signal;

    const problems: Problem[] = [...rec.problems, ...plan.problems];
    const results = new Map<string, StepResult>();
    const confirms = new ConfirmState();
    const order = runOrder(plan);
    const byName = new Map(plan.steps.map((s) => [s.asset, s]));
    // Under --from only the ingests it applies to run; everything else is skipped with the reason (§8).
    const fromSkip = (s: PlannedStep) => fromSkips.get(s.asset) ?? (o.from !== undefined && s.action !== "fetch" ? FROM_ONLY_MERGE : undefined);
    const mayRun = (s: PlannedStep) => s.action !== "skip" && !s.hold && loadErrors(s).length === 0 && fromSkip(s) === undefined;
    const runnable = order.map((n) => byName.get(n)!).filter(mayRun);
    const finish = (): RunOutcome => {
      const steps = order.map((n) => results.get(n)).filter((r): r is StepResult => r !== undefined);
      const interrupted = runSignal.aborted && (croftError(runSignal.reason)?.code ?? "INTERRUPTED") === "INTERRUPTED";
      if (interrupted && !problems.some((p) => p.code === "INTERRUPTED")) problems.push({ ...(croftError(runSignal.reason) ?? interruptedError()).problem, runId });
      const failed = steps.some((s) => s.status === "failed") || problems.some((p) => p.severity === "error" && p.code !== "CONFIRMATION_REQUIRED");
      const status: RunStatus = interrupted ? "interrupted" : failed ? "failed" : "succeeded";
      const clean = dedupe(problems);
      const confirmation = confirms.pending;
      const summary: RunSummary = jsonSafe({
        data: { runId, status, steps },
        problems: clean,
        next: nextSteps(steps, clean, confirms.deferred),
        ...(confirmation ? { confirmation } : {}),
        exit: exitCodeFor(clean, { pendingConfirmation: confirmation !== undefined }),
        ok: !clean.some((p) => p.severity === "error"),
      });
      release(runs, runId);
      const stored = redactValue(summary, env);
      runs.finishRun(runId, status, stored);
      if (status === "succeeded") rmSync(join(paths.stateDir, "staging", runId), { recursive: true, force: true });
      events.emit({ type: "run", runId, status, exit: summary.exit });
      return stored;
    };

    events.emit({ type: "run", runId, status: "running", assets: order });

    /** A step that did not run: its result, with the table's rows as the mirror has them. */
    const skipped = (step: PlannedStep, skippedBecause: string, o2: { record?: boolean } = {}): StepResult => {
      const result: StepResult = {
        asset: step.asset, status: "skipped", reason: step.reason, skippedBecause, behavior: step.behavior, attempt: 0,
        maxAttempts: step.retries + 1, rows: emptyRows(getCatalog(runs, step.asset)?.rows ?? 0), schemaChanges: [], checks: [],
        logsCommand: `croft logs ${step.asset}`, durationMs: 0,
      };
      results.set(step.asset, result);
      // A step skipped for its input is this run's news about the asset (status shows it); a step with nothing to
      // do is not, and leaves the asset's last run as it was.
      if (o2.record) {
        runs.startStep({ runId, asset: step.asset, attempt: 0, reason: step.reason, ...(codeHashOf(step) ? { codeHash: codeHashOf(step) } : {}) });
        runs.finishStep(runId, step.asset, 0, { status: "skipped", reason: step.reason });
        events.emit({ type: "step", runId, asset: step.asset, attempt: 0, status: "skipped", result });
      }
      return result;
    };

    try {
      // Leases: all or nothing.
      if (runnable.length > 0) {
        try {
          await acquire(runs, runnable.map((s) => s.asset), runId, {
            waitMs: interactive ? LEASE_WAIT_MS.tty : LEASE_WAIT_MS.offTty, noWait: o.noWait === true, signal: runSignal,
            onWait: (busy) => events.emit({ type: "waiting", runId, assets: busy.map((b) => b.asset), heldBy: busy.map((b) => b.runId) }),
          });
        } catch (e) {
          const err = croftError(e) ?? internal(e);
          problems.push({ ...err.problem, runId: err.problem.runId ?? runId });
          const why = err.code === "ASSET_BUSY" ? `${err.problem.asset} is busy (run ${err.problem.runId})` : err.problem.message;
          for (const s of plan.steps) skipped(s, why);
          return finish();
        }
      }

      const delays = o.retryDelaysMs ?? RETRY_DELAYS_MS;
      const decider = confirmDecider(o, runs, confirms);

      const attemptStep = async (step: PlannedStep, attempt: number, maxAttempts: number) => {
        const asset = step.asset;
        const codeHash = codeHashOf(step);
        const log = openLog(paths.stateDir, runId, asset, { redact: (t) => env.redact(t) });
        runs.startStep({ runId, asset, attempt, reason: step.reason, ...(codeHash ? { codeHash } : {}), logPath: logPath(paths.stateDir, runId, asset) });
        // What the asset's top-level code printed when the plan imported it (core/output.ts).
        if (attempt === 1) for (const line of step.output ?? []) log.write(line);
        log.write(`${new Date().toISOString()} ${asset} attempt ${attempt} of ${maxAttempts} (run ${runId}): ${step.behavior}`);
        events.emit({ type: "step", runId, asset, attempt, status: "running" });
        const progress = new StepProgress(asset, (p) => {
          events.emit({ type: "progress", runId, ...p });
          // status and context read a live run's {asset, phase, rowsFetched, requests, elapsedMs} from
          // runs.summary.progress; StepProgress reports at most every 500 ms, and a change inside a window at its end.
          try {
            runs.setRunProgress(runId, p);
          } catch {
            // Progress must never fail a run (a busy runs.sqlite, say).
          }
        });
        const stepAc = new AbortController();
        const signal = AbortSignal.any([runSignal, stepAc.signal]);
        const timeoutMs = o.timeoutMs ?? step.timeoutMs;
        const watchdog = setInterval(() => {
          if (progress.paused || stepAc.signal.aborted) return;
          if (Date.now() - progress.lastAt >= timeoutMs) stepAc.abort(timeoutError(step, timeoutMs, progress));
        }, Math.max(10, Math.min(1000, Math.floor(timeoutMs / 4))));
        const started = Date.now();
        // The check sources of the asset's last ok step: a check not among them is new or edited (§3f).
        const previous = runs.lastCheckSources(asset);
        try {
          const input: StepInput = {
            step, project, env, warehouse: warehouse!, runs, runId, attempt, maxAttempts, signal, progress, log,
            ...withChecks(step, previous), ...withReadBy(step, getCatalog(runs, asset)),
            ...(o.http ? { http: o.http } : {}), ...(o.fault ? { fault: o.fault } : {}), ...(o.now ? { now: o.now } : {}),
          };
          let out: StepOutcome;
          if (step.kind === "sql") {
            out = await runSqlStep(input);
          } else if (step.kind === "transform") {
            // The cost guard asks a person; a scheduled run has nobody to ask, so the guard fails the step.
            out = await runTransform({ ...input, ...(o.human ?? true ? { confirm: decider } : {}) });
          } else {
            out = await runIngest({ ...input, ...(o.from !== undefined ? { from: o.from } : {}), ...(o.allowShrink ? { confirm: decider } : {}) });
          }
          out = confirms.settle(step, out, log);
          // Warnings after the commit (§3f). runSqlStep runs its own.
          if (step.kind !== "sql" && out.result.status === "ok") {
            const late = await lateWarnings({ step, warehouse: warehouse!, log, progress, signal }, out, previous);
            out.result.checks.push(...late.results);
            out.warnings.push(...late.problems.map((w) => ({ ...w, asset: w.asset ?? asset, runId })));
          }
          runs.finishStep(runId, asset, attempt, { status: out.result.status, reason: out.result.reason, rows: out.result.rows });
          const ran = out.result.status === "ok" || out.result.status === "unchanged";
          if (ran && (o.human ?? true) && codeHash) runs.approveCode(asset, codeHash);
          events.emit({ type: "step", runId, asset, attempt, status: out.result.status, result: out.result });
          return { ok: true as const, out };
        } catch (e) {
          const err = croftError(e) ?? internal(e);
          const p: Problem = { ...err.problem, asset: err.problem.asset ?? asset, runId };
          const interrupted = p.code === "INTERRUPTED";
          runs.finishStep(runId, asset, attempt, { status: interrupted ? "interrupted" : "failed", error: redactValue(jsonSafe(p), env) });
          log.write(`${p.code}: ${p.message}${p.hint ? `\nhint: ${p.hint}` : ""}`);
          const result: StepResult = {
            asset, status: "failed", reason: step.reason, behavior: step.behavior, attempt, maxAttempts,
            rows: emptyRows(getCatalog(runs, asset)?.rows ?? 0), schemaChanges: [], requests: progress.requests, checks: failedChecks(p),
            logsCommand: `croft logs ${asset} --failed`, durationMs: Date.now() - started, error: p,
          };
          events.emit({ type: "step", runId, asset, attempt, status: "failed", result });
          return { ok: false as const, result, error: p };
        } finally {
          clearInterval(watchdog);
          progress.close();
          log.close();
        }
      };

      const runStep = async (step: PlannedStep): Promise<void> => {
        const maxAttempts = step.retries + 1;
        for (let attempt = 1; ; attempt++) {
          const a = await attemptStep(step, attempt, maxAttempts);
          if (a.ok) {
            results.set(step.asset, a.out.result);
            problems.push(...a.out.warnings.map((w) => ({ ...w, asset: w.asset ?? step.asset, runId })), ...a.out.problems.map((p) => ({ ...p, runId })));
            return;
          }
          const lockBusy = a.error.code === "DB_BUSY" || a.error.code === "DB_HELD_BY_OTHER_PROGRAM";
          const retry = attempt < maxAttempts && isRetryable(a.error) && !runSignal.aborted && !(lockBusy && o.noWait);
          if (!retry) {
            results.set(step.asset, a.result);
            problems.push(a.error);
            return;
          }
          // A server's Retry-After (HTTP_ERROR details.retryAfterMs, §3a) is honored: never retry inside its window.
          // A wait longer than a run holds on for ends the step now, saying when the server allows the next try.
          const asked = retryAfterOf(a.error);
          if (asked !== null && asked > (o.retryWaitLimitMs ?? RETRY_WAIT_LIMIT_MS)) {
            a.result.nextRetryAt = new Date(Date.now() + asked).toISOString();
            results.set(step.asset, a.result);
            problems.push(a.error);
            return;
          }
          const delay = Math.max(delays[Math.min(attempt - 1, delays.length - 1)] ?? 0, asked ?? 0);
          const nextRetryAt = new Date(Date.now() + delay).toISOString();
          a.result.nextRetryAt = nextRetryAt;
          results.set(step.asset, a.result);
          events.emit({ type: "retry", runId, asset: step.asset, attempt, nextRetryAt, code: a.error.code, message: a.error.message });
          try {
            await sleep(delay, undefined, { signal: runSignal });
          } catch {
            problems.push(a.error);
            return;
          }
        }
      };

      /** A step whose load failed: it fails without running (the rest of the run goes ahead). */
      const failLoad = (step: PlannedStep, errors: Problem[]): void => {
        const first = errors[0]!;
        // An asset that printed while it failed to load keeps that output, with the error, in its step log.
        const loadLog = step.output?.length ? openLog(paths.stateDir, runId, step.asset, { redact: (t) => env.redact(t) }) : null;
        if (loadLog) {
          for (const line of step.output!) loadLog.write(line);
          loadLog.write(`${first.code}: ${first.message}${first.hint ? `\nhint: ${first.hint}` : ""}`);
          loadLog.close();
        }
        const codeHash = codeHashOf(step);
        runs.startStep({ runId, asset: step.asset, attempt: 1, reason: step.reason, ...(codeHash ? { codeHash } : {}), ...(loadLog ? { logPath: loadLog.path } : {}) });
        runs.finishStep(runId, step.asset, 1, { status: "failed", error: redactValue(jsonSafe(first), env) });
        results.set(step.asset, {
          asset: step.asset, status: "failed", reason: step.reason, behavior: step.behavior, attempt: 1, maxAttempts: 1,
          rows: emptyRows(getCatalog(runs, step.asset)?.rows ?? 0), schemaChanges: [], checks: [], logsCommand: `croft logs ${step.asset} --failed`,
          durationMs: 0, error: { ...first, runId },
        });
        problems.push(...step.problems.map((p) => ({ ...p, runId })));
      };

      // Why the steps that read an asset are skipped (null: they may run), once its own step has ended.
      const blockers = new Map<string, string | null>();
      const planned = plannedNames(plan.steps);
      const slots = new Semaphore(Math.max(1, o.concurrency ?? project.config.concurrency));
      const sqlLock = new Semaphore(1);

      /** Decide and run one step, once the steps it comes after have ended; returns its blocker. */
      const settle = async (step: PlannedStep): Promise<string | null> => {
        const asset = step.asset;
        // Nothing to do: the steps that read it go ahead.
        const idle = fromSkip(step) ?? (step.action === "skip" ? step.reason : undefined);
        if (idle !== undefined) {
          skipped(step, idle);
          return null;
        }
        const errors = loadErrors(step);
        if (errors.length > 0) {
          failLoad(step, errors);
          return `input ${asset} failed (${runId})`;
        }
        if (step.hold) {
          const held = HOLD_WORDS[step.hold] ?? `held: ${step.hold}`;
          skipped(step, held);
          return `input ${asset} is ${held}`;
        }
        const interrupted = () => {
          skipped(step, "the run was interrupted before this step started");
          return null;
        };
        if (runSignal.aborted) return interrupted();
        const blocked = planned(inputsOf(step)).map((n) => blockers.get(n)).find((b) => typeof b === "string");
        if (blocked) {
          skipped(step, blocked, { record: true });
          return `input ${asset} was not built: ${blocked}`;
        }
        const free = await (step.kind === "sql" ? sqlLock : slots).acquire();
        try {
          if (runSignal.aborted) return interrupted();
          const fresh = upToDate(step, runs);
          if (fresh) {
            skipped(step, fresh);
            return null;
          }
          problems.push(...step.problems.filter((p) => p.severity !== "error").map((p) => ({ ...p, runId })));
          await runStep(step);
        } finally {
          free();
        }
        const r = results.get(asset);
        if (!r || r.status === "failed") return `input ${asset} failed (${runId})`;
        if (r.status === "skipped") {
          const pending = confirms.pending?.impact.asset === asset && !confirms.deferred.has(asset) ? confirms.pending : undefined;
          return pending ? `input ${asset} is waiting for confirmation ${pending.token}` : `input ${asset} needs a confirmation first`;
        }
        return null;
      };

      const index = new Map(order.map((n, i) => [n, i]));
      const ended = new Map(order.map((n) => [n, Promise.withResolvers<void>()]));
      await Promise.all(order.map(async (name) => {
        const step = byName.get(name)!;
        const own = ended.get(name)!;
        try {
          const after = planned(step.orderAfter).filter((d) => d !== name && index.get(d)! < index.get(name)!);
          await Promise.all(after.map((d) => ended.get(d)!.promise));
          blockers.set(name, await settle(step));
        } catch (e) {
          // A croft bug around one step (runs.sqlite, the catalog mirror): it fails that step, not the run.
          const p = { ...(croftError(e) ?? internal(e)).problem, asset: name, runId };
          problems.push(p);
          if (!results.has(name) || results.get(name)!.status !== "failed") {
            results.set(name, {
              asset: name, status: "failed", reason: step.reason, behavior: step.behavior, attempt: 0, maxAttempts: step.retries + 1,
              rows: emptyRows(), schemaChanges: [], checks: [], logsCommand: `croft logs ${name} --failed`, durationMs: 0, error: p,
            });
          }
          blockers.set(name, `input ${name} failed (${runId})`);
        } finally {
          own.resolve();
        }
      }));
      return finish();
    } catch (e) {
      // A croft bug outside any step: record it and end the run, rather than leave it "running" until reconcile.
      problems.push({ ...(croftError(e) ?? internal(e)).problem, runId });
      return finish();
    } finally {
      o.signal?.removeEventListener("abort", onOuterAbort);
      release(runs, runId);
      runs.unregisterWaiter();
    }
  } finally {
    runs.close();
    await warehouse?.close();
  }
}

/** The code hash a step runs: the loaded TS module's, or the SQL file's fingerprint. */
function codeHashOf(step: PlannedStep): string | undefined {
  return step.codeHash ?? step.sql?.codeHash;
}

/**
 * The blocking checks for the step's writes (checks/run.ts checksHook). `previous` is what the asset's last ok
 * step ran; once this step's first write has committed its checks, a chunked transform's later chunks count them
 * as run, so a new check covers the whole table once, not in every chunk.
 */
function withChecks(step: PlannedStep, previous: string[] | null): { checks?: NonNullable<WriteBatchInput["checks"]> } {
  if (!step.checks.some((c) => c.blocking)) return {};
  let seen = previous;
  return {
    checks: async (tx, ctx) => {
      const out = await checksHook(step.checks, { file: step.file, previous: seen })(tx, ctx);
      seen = [...new Set([...(seen ?? []), ...step.checks.filter((c) => c.blocking).map((c) => c.source)])];
      return out;
    },
  };
}

/** Downstream readers per column (COLUMN_STOPPED_ARRIVING): every column the table has is read by every asset
 *  that reads the table. */
function withReadBy(step: PlannedStep, entry: CatalogAsset | null): { readBy?: Record<string, string[]> } {
  if (!step.readBy.length || !entry) return {};
  const readBy: Record<string, string[]> = {};
  for (const c of entry.columns) if (!isReservedColumn(c.name)) readBy[c.name] = [...step.readBy];
  return { readBy };
}

/** CHECK_FAILED's results as the failed step's checks: every blocking check's (checks/run.ts details.results), or
 *  the one check a write refused (a duplicate key). */
function failedChecks(p: Problem): StepResult["checks"] {
  if (p.code !== "CHECK_FAILED") return [];
  const results = p.details?.results;
  if (Array.isArray(results)) return results as StepResult["checks"];
  const check = p.details?.check;
  if (typeof check !== "string") return [];
  const failing = p.details?.failing;
  const sample = p.details?.sample;
  return [{ check, ok: false, ...(typeof failing === "number" ? { failing } : {}), ...(Array.isArray(sample) ? { sample: sample as StepResult["checks"][number]["sample"] } : {}) }];
}

/**
 * A transform planned only because it looked stale, which is not stale now that the steps before it ran (its
 * input's fetch brought nothing new, say): why it is skipped. null when it runs: it is stale, or was asked for
 * by name (a reason other than staleness).
 */
function upToDate(step: PlannedStep, runs: RunsDb): string | null {
  if (step.kind !== "sql" && step.kind !== "transform") return null;
  if (step.reasons.length === 0 || step.reasons.some((r) => !STALENESS.has(r))) return null;
  const catalog = new Map(allCatalog(runs).map((c) => [c.asset.toLowerCase(), c]));
  const inputs = inputsOf(step);
  const inputEntries = Object.fromEntries(inputs.map((n) => [n, catalog.get(n.toLowerCase()) ?? null]));
  const codeHash = codeHashOf(step);
  const reasons = staleReasons({
    asset: step.asset, file: step.file, kind: step.kind === "sql" ? "sql" : "ts", incremental: step.incremental.kind === "new-rows",
    inputs, ...(codeHash ? { codeHash } : {}), entry: catalog.get(step.asset.toLowerCase()) ?? null, inputEntries,
  });
  if (reasons.length > 0) return null;
  return inputs.length ? `up to date: ${inputs.join(", ")} did not change` : "up to date";
}

interface WarningInput { step: PlannedStep; warehouse: DuckWarehouse; log: LogWriter; progress: StepProgress; signal: AbortSignal }

/**
 * The step's warnings (non-blocking checks) after its commit, on a read lease (§3f): a failing one is a warning
 * and a result, never the step's failure; one that cannot run is a warning too. The rows "this write changed" are
 * those stamped with the write's _loaded_at (IngestOutcome.loadedAt). A transform may commit in chunks and does
 * not say its stamps: its newest stamp covers its rows when it carries all of them, else every warning covers
 * the whole table.
 */
async function lateWarnings(i: WarningInput, out: StepOutcome, previous: string[] | null): Promise<CheckHookResult> {
  const list = i.step.checks.filter((c) => !c.blocking);
  if (list.length === 0) return { problems: [], results: [] };
  i.progress.setPhase("checks");
  const asset = i.step.asset;
  try {
    return await i.warehouse.read(async (db) => {
      const table = tableRef(await currentDatabase(db), asset);
      let loadedAt = out.loadedAt;
      let prev = previous;
      if (loadedAt === undefined) {
        const changed = out.result.rows.added + out.result.rows.updated;
        const stamp = out.catalog?.lastLoadedAt ?? null;
        if (changed === 0 || !stamp) loadedAt = NO_ROWS_STAMP;
        else {
          loadedAt = stamp;
          const [r] = await db.all<{ n: unknown }>(`SELECT count(*) AS n FROM ${table} WHERE ${quoteIdent("_loaded_at")} = $1::TIMESTAMPTZ`, [stamp]);
          if (Number(r?.n ?? 0) !== changed) prev = null;
        }
      }
      return runWarnings(db, { asset, table, loadedAt, rows: out.result.rows }, list, { file: i.step.file, previous: prev });
    }, { purpose: `check the warnings of ${asset}`, signal: i.signal });
  } catch (e) {
    const p = (croftError(e) ?? internal(e)).problem;
    i.log.write(`the warnings of ${asset} did not run: ${p.code}: ${p.message}`);
    return {
      problems: [{ ...p, severity: "warning", asset, file: p.file ?? i.step.file, message: `the warnings of ${asset} did not run (its rows are written): ${p.message}` }],
      results: [],
    };
  }
}

/** Staging of a failed run is kept for inspection for this long (§5 step 4). */
export const STAGING_KEEP_MS = 3 * 86_400_000;

/** <state>/staging/_chunks: incremental transforms' chunks staged and not yet committed (transform.ts). */
const CHUNKS_DIR = basename(dirname(pendingChunkDir("", "x")));

/**
 * Delete staging folders of runs that ended more than 3 days ago (and of runs runs.sqlite never knew). The
 * chunks incremental transforms staged and could not commit (staging/_chunks/<asset>/) are no run's: each is kept
 * until nothing in it has changed for 3 days, since the next attempt commits it without running the code again.
 */
export function pruneStaging(stateDir: string, runs: RunsDb, now: number = Date.now()): string[] {
  const root = join(stateDir, "staging");
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  const drop = (dir: string) => {
    rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  };
  for (const name of names) {
    const dir = join(root, name);
    try {
      if (name === CHUNKS_DIR) {
        for (const asset of readdirSync(dir)) {
          const chunk = join(dir, asset);
          if (now - newestMtime(chunk) >= STAGING_KEEP_MS) drop(chunk);
        }
        continue;
      }
      const run = runs.getRun(name);
      if (run?.status === "running") continue;
      const ended = run?.finishedAt ? Date.parse(run.finishedAt) : statSync(dir).mtimeMs;
      if (now - ended < STAGING_KEEP_MS) continue;
      drop(dir);
    } catch {
      // A folder that cannot be read or removed is left for the next run.
    }
  }
  return removed;
}

/** The latest change to a folder or anything in it. */
function newestMtime(path: string): number {
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = st.mtimeMs;
  for (const name of readdirSync(path)) newest = Math.max(newest, newestMtime(join(path, name)));
  return newest;
}

function dedupe(problems: Problem[]): Problem[] {
  const seen = new Set<string>();
  const out: Problem[] = [];
  for (const p of problems) {
    const key = `${p.code}\u0000${p.asset ?? ""}\u0000${p.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Confirmations: --allow-shrink and the cost guard

/** What a run's ConfirmDecider has decided so far. */
class ConfirmState {
  /** The one token this run issued: the result's `confirmation`. */
  pending?: Confirmation;
  /** Steps that asked after it: skipped, each with a next hint to run it once the pending one is settled. */
  readonly deferred = new Map<string, ConfirmRequest>();
  /** Grants that hold for the rest of the run, by action and asset: the rows granted. */
  readonly granted = new Map<string, number>();
  /** Steps run side by side; the terminal asks one question at a time. */
  readonly asking = new Semaphore(1);

  /** A stand-in for a step that asked after the run's token was issued: the step skips itself as for any pending
   *  confirmation, and settle() then rewrites its result. It is never stored, shown or valid. */
  standIn(req: ConfirmRequest): Confirmation {
    this.deferred.set(req.asset, req);
    return { token: `(after ${this.pending!.token})`, expiresAt: this.pending!.expiresAt, command: req.command, impact: req.impact };
  }

  /** A step's outcome with a stand-in confirmation replaced by a skip that says why. */
  settle(step: PlannedStep, out: StepOutcome, log: LogWriter): StepOutcome {
    const req = this.deferred.get(step.asset);
    if (!req || !out.confirmation || out.confirmation === this.pending) return out;
    const why = `${step.asset} needs a confirmation too (${ACTION_WORDS[req.action]}); croft asks for one at a time, so run it after confirmation ${this.pending!.token} is settled${req.action === "allow_shrink" ? `: ${req.command}` : ""}`;
    log.write(`skipped: ${why}`);
    const { confirmation: _c, ...rest } = out;
    return {
      ...rest,
      result: { ...out.result, status: "skipped", reason: "needs confirmation", skippedBecause: why },
      problems: out.problems.filter((p) => p.code !== "CONFIRMATION_REQUIRED"),
    };
  }
}

/**
 * The run's ConfirmDecider (step.ts) for both guarded actions: --allow-shrink's SHRINK_GUARD override and an
 * incremental transform's LARGE_REPROCESS. In order:
 * - a grant already made in this run holds (a retry after a busy database must not spend a token or ask twice;
 *   a cost-guard grant covers fewer rows too, as chunks commit);
 * - the token `croft confirm` carries, when it is for this request's command: spent here, and CONFIRMATION_STALE
 *   when the impact changed;
 * - on a TTY, a y/N question;
 * - otherwise a new token (exit 5), once per run: a later request is deferred (ConfirmState.standIn).
 */
function confirmDecider(o: RunnerOptions, runs: RunsDb, state: ConfirmState): ConfirmDecider {
  return async (req) => {
    const key = `${req.action}\u0000${req.asset}`;
    const had = state.granted.get(key);
    if (had !== undefined && (req.action === "large_reprocess" ? req.impact.rows <= had : req.impact.rows === had)) return { kind: "granted" };
    const grant = () => {
      state.granted.set(key, req.impact.rows);
      return { kind: "granted" as const };
    };
    const confirmations = new Confirmations(runs);
    if (o.confirmToken !== undefined) {
      const stored = confirmations.get(o.confirmToken);
      if (!stored || stored.command === req.command) {
        await confirmations.consume(o.confirmToken, () => req.impact);
        return grant();
      }
    }
    if (o.interactive && o.prompt) {
      const done = await state.asking.acquire();
      try {
        return (await o.prompt(question(req))) ? grant() : { kind: "declined" };
      } finally {
        done();
      }
    }
    if (state.pending) return { kind: "pending", confirmation: state.standIn(req) };
    state.pending = confirmations.create({ command: req.command, impact: req.impact });
    return { kind: "pending", confirmation: state.pending };
  };
}

/** The y/N question on a TTY: the impact, then "Proceed? [y/N] ". */
function question(req: ConfirmRequest): string {
  const { asset, impact } = req;
  const down = impact.downstream.length ? [`  then: ${impact.downstream.join(", ")} update`] : [];
  if (req.action === "allow_shrink") {
    const after = Number(req.problem.details?.rowsAfter ?? 0);
    return [
      `${asset} would go from ${impact.rows} rows to ${after} (${SHRINK_ACTION})`,
      `  first: the current ${impact.rows} rows go to the trash (.croft/trash/${asset}/)`,
      ...down,
      "Proceed? [y/N] ",
    ].join("\n");
  }
  return [req.problem.message, ...down, "Proceed? [y/N] "].join("\n");
}

// ---------------------------------------------------------------------------------------------------------
// croft init: HOOK(example)

/**
 * Run a new project's example ingest through the engine (croft init, after bun install). Read-write, behind
 * a write intent, like every writer. Never throws: a failure is reported in the result.
 */
export async function runExample(root: string, o: { env?: Record<string, string | undefined>; asset?: string } = {}): Promise<ExampleResult> {
  const asset = o.asset ?? "example_sales";
  try {
    const project = loadProject({ root });
    const env = ProjectEnv.load(project.root, o.env ?? process.env);
    const out = await executeRun({ project, env, selectors: [asset], argv: ["run", asset], trigger: "manual", human: true, interactive: false });
    const step = out.data.steps.find((s) => s.asset === asset);
    const ok = step !== undefined && (step.status === "ok" || step.status === "unchanged");
    const checksFailed = step?.checks.some((c) => !c.ok) === true || step?.error?.code === "CHECK_FAILED";
    const problems = out.problems.filter((p) => p.severity === "error");
    return { ran: true, ok, asset, rows: step?.rows.total ?? 0, checks: checksFailed ? "failed" : "ok", ...(problems.length ? { problems } : {}) };
  } catch (e) {
    const err = croftError(e) ?? internal(e);
    return { ran: true, ok: false, asset, rows: 0, checks: "ok", problems: [err.problem] };
  }
}

/** A run that could not start at all, in the run's result shape (for the detached parent). */
export function failedToStart(runId: string, p: Problem): RunSummary {
  return { data: { runId, status: "failed", steps: [] }, problems: [p], next: [], exit: exitCodeFor([p]), ok: false };
}
