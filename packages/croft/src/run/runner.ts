// The run engine (DESIGN.md §5 "Processes", "Leases", "Crash recovery"; §8 "Retries", "Timeout").
//
//   reconcile()     first, like every writing command: dead runs become crashed, their leases go
//   plan            discover, select, load (plan.ts)
//   createRun       runs.sqlite: the run, argv, and the process that does the work
//   asset leases    all or nothing, so two runs never touch one asset (history/leases.ts)
//   steps           up to `concurrency` extractions at once; writes queue behind the warehouse's in-process
//                   write mutex, so one write step commits at a time
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
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CroftError, exitCodeFor } from "../core/errors.ts";
import type { Confirmation, CursorType, Problem, StepResult } from "../core/types.ts";
import type { ExampleResult } from "../project/init.ts";
import { Confirmations } from "../safety/confirm.ts";
import { openWarehouse, type DuckWarehouse } from "../db/warehouse.ts";
import { allCatalog, getCatalog } from "../history/catalog.ts";
import { acquire, release } from "../history/leases.ts";
import { logDir, logPath, NOT_STARTED_RECORD, openLog, writeRunRecord } from "../history/logs.ts";
import { reconcile } from "../history/reconcile.ts";
import { RunsDb, type RunStatus, type RunTrigger } from "../history/runs-db.ts";
import type { HttpOptions } from "../http/http.ts";
import { redactProblem } from "../cli/render.ts";
import { outsideCapture, setOutputRedactor } from "../core/output.ts";
import { now as clockNow } from "../core/time.ts";
import { ProjectEnv } from "../project/env.ts";
import { loadProject, type Project } from "../project/root.ts";
import {
  croftError, fromSince, isRetryable, type ProgressSnapshot, runIngest, savedCursors, type ShrinkDecider, SHRINK_ACTION, StepProgress,
} from "./ingest.ts";
import { backfillUnsupported, isGlob, loadErrors, planRun, type PlannedStep, type RunPlan } from "./plan.ts";

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
  /** Always false in phase 1 (core/phase.ts): the command adds it; runs.summary does not store it. */
  checksEnforced?: boolean;
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
  human?: boolean;
  from?: string;
  allowShrink?: boolean;
  confirmToken?: string;
  /** stdin and stdout are a terminal: longer waits, and --allow-shrink asks instead of issuing a token. */
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

/** The confirmation command for --allow-shrink on one asset; `croft confirm` re-runs exactly this. */
export function shrinkCommand(asset: string): string {
  return `croft run ${asset} --allow-shrink`;
}

/**
 * Flag rules that need the plan: destructive flags take exactly one exact name (§6 "Guards aimed at agents"),
 * and --from on an asset named exactly must apply to it (§8: BACKFILL_UNSUPPORTED). Called before the run
 * exists, by the detached parent too, so such a refusal is never a run or a failed step.
 */
export function checkRunFlags(plan: RunPlan, o: Pick<RunnerOptions, "selectors" | "from" | "allowShrink" | "confirmToken">): void {
  const usage = (message: string, hint: string) => new CroftError("USAGE_ERROR", { message, hint });
  if (o.confirmToken !== undefined && !o.allowShrink) {
    throw usage("a confirmation applies only to --allow-shrink", "croft confirm <token> runs the confirmed command for you");
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

/** Run up to `limit` tasks at once. */
async function pool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

/** Record the code a human ran, which releases the scheduler hold (§6 "The scheduler only runs code a human has run"). */
function approveCode(runs: RunsDb, asset: string, codeHash: string): void {
  runs.sqlite.query(
    `INSERT INTO schedule_state (asset, approved_code_hash) VALUES (?, ?)
     ON CONFLICT (asset) DO UPDATE SET approved_code_hash = excluded.approved_code_hash`,
  ).run(asset, codeHash);
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

function nextSteps(steps: StepResult[], problems: Problem[]): Next[] {
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
  const ok = steps.find((s) => s.status === "ok" && s.rows.total > 0);
  if (ok && next.length === 0) next.push({ command: `croft query "from ${ok.asset} limit 5"`, reason: `look at ${ok.asset}` });
  if (steps.length === 0 && problems.length === 0) next.push({ command: "croft docs ingest", reason: "assets/ has no assets yet; start from a template" });
  return next;
}

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
      plan = o.plan ?? await planRun({ root: project.root, timezone: project.timezone, selectors: o.selectors, cursorTypes: cursorTypes(runs) });
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
    let confirmation: Confirmation | undefined;
    const runnable = plan.steps.filter((s) => s.action === "fetch" && loadErrors(s).length === 0 && !fromSkips.has(s.asset));
    const finish = (): RunOutcome => {
      const steps = plan.steps.map((s) => results.get(s.asset)).filter((r): r is StepResult => r !== undefined);
      const interrupted = runSignal.aborted && (croftError(runSignal.reason)?.code ?? "INTERRUPTED") === "INTERRUPTED";
      if (interrupted && !problems.some((p) => p.code === "INTERRUPTED")) problems.push({ ...(croftError(runSignal.reason) ?? interruptedError()).problem, runId });
      const failed = steps.some((s) => s.status === "failed") || problems.some((p) => p.severity === "error" && p.code !== "CONFIRMATION_REQUIRED");
      const status: RunStatus = interrupted ? "interrupted" : failed ? "failed" : "succeeded";
      const clean = dedupe(problems);
      const summary: RunSummary = jsonSafe({
        data: { runId, status, steps },
        problems: clean,
        next: nextSteps(steps, clean),
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

    events.emit({ type: "run", runId, status: "running", assets: plan.steps.map((s) => s.asset) });

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
          for (const s of plan.steps) {
            results.set(s.asset, {
              asset: s.asset, status: "skipped", reason: s.reason, skippedBecause: why, behavior: s.behavior, attempt: 0,
              maxAttempts: s.retries + 1, rows: emptyRows(getCatalog(runs, s.asset)?.rows ?? 0), schemaChanges: [], checks: [],
              logsCommand: `croft logs ${s.asset}`, durationMs: 0,
            });
          }
          return finish();
        }
      }

      const delays = o.retryDelaysMs ?? RETRY_DELAYS_MS;
      const shrink = o.allowShrink ? shrinkDecider(o, runs) : undefined;

      const attemptStep = async (step: PlannedStep, attempt: number, maxAttempts: number) => {
        const asset = step.asset;
        const log = openLog(paths.stateDir, runId, asset, { redact: (t) => env.redact(t) });
        runs.startStep({ runId, asset, attempt, reason: step.reason, ...(step.codeHash ? { codeHash: step.codeHash } : {}), logPath: logPath(paths.stateDir, runId, asset) });
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
        try {
          const out = await runIngest({
            step, project, env, warehouse: warehouse!, runs, runId, attempt, maxAttempts, signal, progress, log,
            ...(o.from !== undefined ? { from: o.from } : {}), ...(shrink ? { shrink } : {}), ...(o.http ? { http: o.http } : {}),
            ...(o.fault ? { fault: o.fault } : {}), ...(o.now ? { now: o.now } : {}),
          });
          runs.finishStep(runId, asset, attempt, { status: out.result.status, reason: out.result.reason, rows: out.result.rows });
          if (out.result.status === "ok" && (o.human ?? true) && step.codeHash) approveCode(runs, asset, step.codeHash);
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
            rows: emptyRows(getCatalog(runs, asset)?.rows ?? 0), schemaChanges: [], requests: progress.requests, checks: [],
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

      const runStep = async (step: PlannedStep) => {
        const maxAttempts = step.retries + 1;
        for (let attempt = 1; ; attempt++) {
          const a = await attemptStep(step, attempt, maxAttempts);
          if (a.ok) {
            results.set(step.asset, a.out.result);
            problems.push(...a.out.warnings.map((w) => ({ ...w, asset: w.asset ?? step.asset, runId })), ...a.out.problems.map((p) => ({ ...p, runId })));
            if (a.out.confirmation) confirmation = a.out.confirmation;
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

      await pool(plan.steps.filter((s) => s.action === "fetch" && !fromSkips.has(s.asset)), Math.max(1, o.concurrency ?? project.config.concurrency), async (step) => {
        const errors = loadErrors(step);
        if (errors.length > 0) {
          const first = errors[0]!;
          // An asset that printed while it failed to load keeps that output, with the error, in its step log.
          const loadLog = step.output?.length ? openLog(paths.stateDir, runId, step.asset, { redact: (t) => env.redact(t) }) : null;
          if (loadLog) {
            for (const line of step.output!) loadLog.write(line);
            loadLog.write(`${first.code}: ${first.message}${first.hint ? `\nhint: ${first.hint}` : ""}`);
            loadLog.close();
          }
          runs.startStep({
            runId, asset: step.asset, attempt: 1, reason: step.reason, ...(step.codeHash ? { codeHash: step.codeHash } : {}),
            ...(loadLog ? { logPath: loadLog.path } : {}),
          });
          runs.finishStep(runId, step.asset, 1, { status: "failed", error: redactValue(jsonSafe(first), env) });
          results.set(step.asset, {
            asset: step.asset, status: "failed", reason: step.reason, behavior: step.behavior, attempt: 1, maxAttempts: 1,
            rows: emptyRows(getCatalog(runs, step.asset)?.rows ?? 0), schemaChanges: [], checks: [], logsCommand: `croft logs ${step.asset} --failed`,
            durationMs: 0, error: { ...first, runId },
          });
          problems.push(...step.problems.map((p) => ({ ...p, runId })));
          return;
        }
        if (runSignal.aborted) {
          results.set(step.asset, {
            asset: step.asset, status: "skipped", reason: step.reason, skippedBecause: "the run was interrupted before this step started",
            behavior: step.behavior, attempt: 0, maxAttempts: step.retries + 1, rows: emptyRows(getCatalog(runs, step.asset)?.rows ?? 0),
            schemaChanges: [], checks: [], logsCommand: `croft logs ${step.asset}`, durationMs: 0,
          });
          return;
        }
        problems.push(...step.problems.filter((p) => p.severity !== "error").map((p) => ({ ...p, runId })));
        await runStep(step);
      });
      // Transforms (phase 1), and with --from the assets it does not apply to in a bare run or a glob (an asset
      // named exactly was refused before the run started).
      for (const s of plan.steps) {
        const fromSkip = fromSkips.get(s.asset);
        if (s.action !== "skip" && fromSkip === undefined) continue;
        const skippedBecause = fromSkip ?? (o.from !== undefined ? FROM_ONLY_MERGE : s.reason);
        results.set(s.asset, {
          asset: s.asset, status: "skipped", reason: s.reason, skippedBecause, behavior: s.behavior, attempt: 0, maxAttempts: 0,
          rows: emptyRows(getCatalog(runs, s.asset)?.rows ?? 0), schemaChanges: [], checks: [], logsCommand: `croft logs ${s.asset}`, durationMs: 0,
        });
      }
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

/** Staging of a failed run is kept for inspection for this long (§5 step 4). */
export const STAGING_KEEP_MS = 3 * 86_400_000;

/** Delete staging folders of runs that ended more than 3 days ago (and of runs runs.sqlite never knew). */
export function pruneStaging(stateDir: string, runs: RunsDb, now: number = Date.now()): string[] {
  const root = join(stateDir, "staging");
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const dir = join(root, name);
    try {
      const run = runs.getRun(name);
      if (run?.status === "running") continue;
      const ended = run?.finishedAt ? Date.parse(run.finishedAt) : statSync(dir).mtimeMs;
      if (now - ended < STAGING_KEEP_MS) continue;
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // A folder that cannot be read or removed is left for the next run.
    }
  }
  return removed;
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

/** --allow-shrink: a token off a TTY, a y/N question on one, or the confirmed token from `croft confirm`. */
function shrinkDecider(o: RunnerOptions, runs: RunsDb): ShrinkDecider {
  // A grant holds for the whole run: a retry after a busy database must not spend the token twice or ask twice.
  // The asset lease keeps other croft runs off the table meanwhile.
  const granted = new Map<string, number>();
  return async (req) => {
    if (granted.get(req.asset) === req.rowsBefore) return { kind: "granted" };
    const command = shrinkCommand(req.asset);
    const confirmations = new Confirmations(runs);
    const grant = () => {
      granted.set(req.asset, req.rowsBefore);
      return { kind: "granted" as const };
    };
    if (o.confirmToken !== undefined) {
      await confirmations.consume(o.confirmToken, (stored) => {
        if (stored.command !== command) {
          throw new CroftError("USAGE_ERROR", {
            message: `confirmation ${o.confirmToken} is for \`${stored.command}\`, not \`${command}\``,
            hint: "croft confirm <token> runs the command the token was made for",
          });
        }
        return req.impact;
      });
      return grant();
    }
    if (o.interactive && o.prompt) {
      const question = [
        `${req.asset} would go from ${req.rowsBefore} rows to ${req.rowsAfter} (${SHRINK_ACTION})`,
        `  first: the current ${req.rowsBefore} rows go to the trash (.croft/trash/${req.asset}/)`,
        "Proceed? [y/N] ",
      ].join("\n");
      return (await o.prompt(question)) ? grant() : { kind: "declined" };
    }
    return { kind: "pending", confirmation: confirmations.create({ command, impact: req.impact }) };
  };
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

