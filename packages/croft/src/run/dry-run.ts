// croft run --dry-run (DESIGN.md §4.1 "run flags", §4.2, §5 "How commands behave while a run is writing",
// §8 "Backfills"): what a run would do and why, without running anything.
//
// It plans exactly as the run does (run/plan.ts, the runner's checkRunFlags), then adds what the run line
// shows, from runs.sqlite alone. It never opens the warehouse, so it never waits on a run that is writing:
//
//   windows         a cursor ingest's `since`: the saved cursor in the catalog mirror minus the lookback, or
//                   --from converted to the cursor's type, echoed as an instant with the project offset
//   confirmations   --allow-shrink on a replace ingest (its current rows would go to the trash), and the cost
//                   guard of an incremental TS transform that makes requests (LARGE_REPROCESS), with the pending
//                   rows of the inputs it reads with newRows() estimated from the mirror and the steps
//                   runs.sqlite recorded for each input. An input never built that the run builds first has no
//                   rows to count yet: the step's reason says the run may ask, since they are unknown until then.
//                   --rebuild of an ingest or an incremental TS transform (run/rebuild.ts): the rows that would go to
//                   the trash, and for a paid transform every input row it would process again. A rebuild that
//                   trashes is destructive, so the run it describes is never in next.
//                   An ingest whose code changed how its rows are written or typed (§6 "Behavior changes", "Pin
//                   changes"; run/plan.ts pendingBehavior, pendingPins, from the mirror): a changed key, write mode
//                   or cursor field fails the step before it runs (INGEST_CONFIG_CHANGED, as the run's settleConfig);
//                   a key added to an append ingest (convert_key) or a pin that differs from the stored type
//                   (pin_change) is the question the run asks before it fetches when stored rows would go or change,
//                   with the rows at stake. `croft run <ingest>` only asks, so it stays in next
//   renamed         a file renamed outside croft (ASSET_RENAMED, run/plan.ts): named, it would fail before it runs;
//                   otherwise it is skipped with the problem. next leads with `croft rename <old> <new>`
//   skips           an asset downstream of one that would fail before it runs (a static error) is skipped, as
//                   the runner skips it; --from skips every transform, and in a bare run or a glob the ingests
//                   it does not apply to; and a transform whose input was never built and is not built by the
//                   run either is skipped with INPUT_NOT_BUILT, whose fix (the run that builds the input) leads
//                   next (run/plan.ts)
//   holds           an asset another run holds the lease of: the run would wait for it
//
// Nothing is created: without runs.sqlite the project has never run, and everything is "never built". A dry
// run never issues a confirmation token.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { formatInstant, now as clockNow, parseInstant } from "../core/time.ts";
import type { CursorType, DryRunConfirmation, DryRunData, DryRunStep, DryRunWindow, Impact, Problem } from "../core/types.ts";
import { allCatalog, type CatalogAsset } from "../history/catalog.ts";
import { listLeases } from "../history/leases.ts";
import { RUNS_DB_FILE, RunsDb } from "../history/runs-db.ts";
import { changeCommand } from "../load/config-change.ts";
import { effectiveLookbackMs, renderSince } from "../load/cursor.ts";
import { lookbackWords, selectorWords } from "../project/resolve.ts";
import type { Project } from "../project/root.ts";
import { cursorTypeOfPin } from "../project/ts-asset.ts";
import { plannedTrashPath } from "../safety/trash.ts";
import { croftError, fromSince, shrinkImpact } from "./ingest.ts";
import {
  type BehaviorSide, buildFirst, cursorTypesOf, FROM_ONLY_MERGE, loadErrors, pendingBehavior, pendingPins, type PlannedStep, planRun, rebuildCommand,
  type RunPlan, skipProblem,
} from "./plan.ts";
import { rebuildImpact, rebuildKindOf, rebuildTrashes, rebuildWords } from "./rebuild.ts";
import { checkRunFlags, shrinkCommand, withProjectChecks } from "./runner.ts";
import { DEFAULT_CONFIRM_ABOVE, REPROCESS_ACTION } from "./transform.ts";

export interface DryRunInput {
  project: Project;
  selectors: readonly string[];
  only?: boolean;
  upstream?: boolean;
  /** --from, as typed. */
  from?: string;
  allowShrink?: boolean;
  /** --rebuild: the named assets from scratch (run/plan.ts, run/rebuild.ts). */
  rebuild?: boolean;
  /** The clock --from's relative values and `today` are read with (CROFT_NOW). */
  now?: Date;
  importTimeoutMs?: number;
}

export interface Next { command: string; reason: string }

/** The command result of a dry run: its data, the problems the run would report, and what to do next. */
export interface DryRunOutcome {
  data: DryRunData;
  /** Discovery problems (as the run reports them), then each step's own: the errors that would fail it before
   *  it runs, and its warnings. */
  problems: Problem[];
  next: Next[];
  /** 0 unless the run itself would be refused for a project problem (exit 2, as the run). A step that would fail
   *  is the plan's news, not the dry run's failure. */
  exit: number;
}

/** What runs.sqlite knows, read once and closed again. */
interface History {
  catalog: CatalogAsset[];
  /** Live leases by asset: the run holding each. */
  leased: Map<string, string>;
  /** Rows each asset's committed steps wrote (added + updated), with when they finished: pending-row estimates. */
  writes: Map<string, { finishedAt: string; rows: number }[]>;
}

function readHistory(stateDir: string): History {
  const empty: History = { catalog: [], leased: new Map(), writes: new Map() };
  if (!existsSync(join(stateDir, RUNS_DB_FILE))) return empty;
  const db = RunsDb.open(stateDir);
  try {
    const leased = new Map<string, string>();
    for (const l of listLeases(db)) if (l.alive) leased.set(l.asset, l.runId);
    const writes = new Map<string, { finishedAt: string; rows: number }[]>();
    const rows = db.sqlite.query(
      "SELECT asset, finished_at, coalesce(added, 0) + coalesce(updated, 0) AS n FROM steps WHERE status = 'ok' AND finished_at IS NOT NULL",
    ).all() as { asset: string; finished_at: string; n: number }[];
    for (const r of rows) {
      const list = writes.get(r.asset) ?? [];
      list.push({ finishedAt: r.finished_at, rows: Number(r.n) });
      writes.set(r.asset, list);
    }
    return { catalog: allCatalog(db), leased, writes };
  } finally {
    db.close();
  }
}

/** Plan the run as `croft run` would, and describe it. Throws what the run would refuse with before it starts
 *  (USAGE_ERROR, BACKFILL_UNSUPPORTED, BACKFILL_WOULD_DUPLICATE, CURSOR_TYPE_MISMATCH for an asset named exactly). */
export async function dryRun(i: DryRunInput): Promise<DryRunOutcome> {
  const { project } = i;
  const history = readHistory(project.paths.stateDir);
  const entries = new Map(history.catalog.map((c) => [c.asset, c]));
  const planned = await planRun({
    root: project.root, timezone: project.timezone, selectors: i.selectors, catalog: history.catalog,
    cursorTypes: cursorTypesOf(history.catalog), only: i.only === true, upstream: i.upstream === true,
    ...(i.from !== undefined ? { from: i.from } : {}), ...(i.importTimeoutMs !== undefined ? { importTimeoutMs: i.importTimeoutMs } : {}),
    ...(i.rebuild ? { rebuild: true } : {}),
    // A mistyped name's fix is this dry run again, never a real run.
    retry: (selectors) => [...runWords({ ...i, selectors }), "--dry-run"].join(" "),
  });
  checkRunFlags(planned, {
    selectors: i.selectors, ...(i.from !== undefined ? { from: i.from } : {}), allowShrink: i.allowShrink === true, rebuild: i.rebuild === true,
  });
  // As a run does (runner.ts withProjectChecks): a TS transform whose inputs name no asset fails before it runs
  // (UNKNOWN_TABLE with a did-you-mean edit fix).
  const plan = await withProjectChecks(planned, project);
  const now = i.now ?? clockNow();
  const steps: DryRunStep[] = [];
  const problems: Problem[] = [...plan.problems];
  /** Steps that would fail before they run, or are skipped because an input would: the runner skips what reads
   *  them. (A step skipped for --from does not block its readers: they read its table as it is.) */
  const blocked = new Map<string, string>();
  /** Steps that would run, so far: their tables exist for the steps after them. */
  const running = new Set<string>();
  /** The runs that build a never-built input first (INPUT_NOT_BUILT fixes), and the steps that may stop to ask. */
  const builds: Next[] = [];
  const mayAsk: { asset: string; until: string[] }[] = [];

  for (const step of plan.steps) {
    const entry = entries.get(step.asset) ?? null;
    // A step the plan skips (--from) never gets to its problems, in the run either.
    const errors = step.action === "skip" ? [] : loadErrors(step);
    const out: DryRunStep = {
      asset: step.asset, file: step.file, kind: step.kind, action: step.action, reasons: [...step.reasons],
      // As the run output shows it: "requested" goes without saying once there is more to say.
      reason: step.reason.replace(/^requested; /, ""), behavior: step.behavior, problems: errors,
    };
    if (step.action !== "skip") problems.push(...step.problems.map((p) => ({ ...p, asset: p.asset ?? step.asset })));
    // Skipped for an input that will not exist, or as a file renamed outside croft: that is the news, with the run
    // that builds the input, or the rename that adopts the table (nextOf).
    const why = skipProblem(step);
    if (why) {
      problems.push({ ...why, asset: why.asset ?? step.asset });
      const build = why.code === "INPUT_NOT_BUILT" ? buildFirst(why) : null;
      if (build && !builds.some((b) => b.command === build.command)) builds.push(build);
    }
    const ingest = step.kind === "rows" || step.kind === "file";
    // A changed key, write mode or cursor field (§6 "Behavior changes"), as the catalog mirror shows it: the run
    // settles it before it fetches, so it comes before the window. It fails the step, or the run asks to convert in
    // place (confirmationOf); a rebuild has none to settle.
    const behavior = ingest && step.action !== "skip" && errors.length === 0 && !step.rebuild ? pendingBehavior(sideOf(step), entry) : null;
    if (behavior) {
      problems.push(behavior.problem);
      if (!behavior.convertible) out.problems = [behavior.problem];
    }

    // An input that would fail or be skipped: the runner skips this step too.
    const stopped = step.inputs.find((x) => blocked.has(x));
    if (step.action !== "skip" && stopped !== undefined && errors.length === 0) {
      out.action = "skip";
      out.skippedBecause = `input ${stopped} ${blocked.get(stopped)}`;
    }
    if (step.action === "skip") out.skippedBecause = step.reason;

    if (out.action !== "skip" && out.problems.length === 0 && ingest) {
      try {
        // A rebuild fetches from scratch: no saved position, so no window.
        const window = step.rebuild ? null : windowOf(step, entry, { timezone: project.timezone, now, ...(i.from !== undefined ? { from: i.from } : {}) });
        if (window) out.window = window;
        out.reason = ingestWords(step, window, i.from);
      } catch (e) {
        const err = croftError(e);
        if (!err) throw e;
        // As the runner's --from check: refuse the whole command for an asset named exactly, or for anything
        // but a backfill refusal; skip the asset in a bare run or a glob.
        if (i.from !== undefined && (!err.code.startsWith("BACKFILL_") || i.selectors.includes(step.asset))) throw err;
        if (i.from !== undefined) {
          out.action = "skip";
          out.skippedBecause = err.code === "BACKFILL_UNSUPPORTED" ? FROM_ONLY_MERGE : err.problem.message;
        } else {
          // The saved cursor cannot become `since` (CURSOR_TYPE_MISMATCH): the step would fail with it.
          out.problems = [...errors, err.problem];
          problems.push({ ...err.problem, asset: step.asset });
        }
      }
    }

    if (out.action !== "skip" && out.problems.length === 0) {
      const ask = confirmationOf(step, entry, {
        plan, entries, history, project, allowShrink: i.allowShrink === true, selectors: i.selectors, builtFirst: (x) => running.has(x),
      });
      if (ask?.confirmation) out.confirmation = ask.confirmation;
      else if (ask?.until) {
        out.reason = `${out.reason}; ${mayAskWords(ask.until, ask.rows, ask.limit)}`;
        mayAsk.push({ asset: step.asset, until: ask.until });
      }
      const holder = history.leased.get(step.asset);
      if (holder) {
        out.hold = "leased";
        out.reason = `${out.reason}; run ${holder} holds it now, so the run would wait for it`;
      }
    }
    if (out.problems.length > 0) blocked.set(step.asset, `would fail (${out.problems[0]!.code})`);
    else if (out.action === "skip" && stopped !== undefined) blocked.set(step.asset, `is skipped (${out.skippedBecause})`);
    else if (out.action !== "skip") running.add(step.asset);
    steps.push(out);
  }

  // A file renamed outside croft: the rename that adopts its table (§6: it needs no confirmation) comes first.
  const renames: Next[] = [];
  for (const p of problems) {
    const fix = p.code === "ASSET_RENAMED" && p.fix?.kind === "command" ? p.fix : null;
    if (fix && !renames.some((n) => n.command === fix.command)) renames.push({ command: fix.command, reason: fix.description });
  }
  return {
    data: { dryRun: true, order: [...plan.order], steps },
    problems: dedupe(problems),
    next: [...renames, ...nextOf(steps, i, { builds, mayAsk })],
    exit: plan.problems.some((p) => p.severity === "error") ? 2 : 0,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Windows (§8 "echoes the conversion")

/** The window of a cursor ingest; null for a full fetch (no cursor, or no saved position yet and no --from). */
export function windowOf(step: PlannedStep, entry: CatalogAsset | null, o: { timezone: string; now: Date; from?: string }): DryRunWindow | null {
  const inc = step.incremental;
  if (inc.kind !== "cursor") return null;
  const saved = entry?.cursor?.value ?? null;
  const savedType = entry?.cursor?.type ?? null;
  if (o.from !== undefined) {
    const since = fromSince(step, o.from, { value: saved, type: savedType }, { timezone: o.timezone, now: o.now });
    if (since.value === undefined) return null;
    const type = savedType ?? guessedType(step, inc.field, inc.unit);
    const at = instantOf(since.value, type, inc.unit, o.timezone);
    return { sinceValue: since.value, sinceType: type, ...(at ? { sinceAt: at } : {}), source: "from", ...(saved !== null ? { saved } : {}) };
  }
  if (saved === null || savedType === null) return null;
  const keyed = step.key.length > 0;
  const lookbackMs = effectiveLookbackMs({ type: savedType, lookbackMs: inc.lookbackMs, keyed });
  const value = renderSince(saved, {
    type: savedType, ...(inc.unit ? { unit: inc.unit } : {}), lookbackMs: inc.lookbackMs, keyed, asset: step.asset, field: inc.field,
  });
  const at = instantOf(value, savedType, inc.unit, o.timezone);
  return {
    sinceValue: value, sinceType: savedType, ...(at ? { sinceAt: at } : {}), source: "saved", saved,
    ...(lookbackMs > 0 ? { lookback: lookbackWords(lookbackMs) } : {}),
  };
}

/** The cursor type before the first load fixed it, as the ingest step guesses it: a pin, else the unit, else a
 *  timestamp. */
function guessedType(step: PlannedStep, field: string, unit: "s" | "ms" | undefined): CursorType {
  const pin = step.spec?.pins[field];
  const pinned = pin ? cursorTypeOfPin(pin.type) : undefined;
  return pinned ?? (unit ? "integer" : "timestamp");
}

/** The instant a `since` stands for, with the project offset: an epoch cursor (unit s or ms), or a timestamp
 *  that carries its offset. Undefined for plain integers, dates, text and naive timestamps (already readable). */
function instantOf(v: string | number, type: CursorType, unit: "s" | "ms" | undefined, timezone: string): string | undefined {
  try {
    if (type === "integer" && unit) return formatInstant({ micros: BigInt(v) * (unit === "s" ? 1_000_000n : 1000n) }, timezone);
    if (type === "timestamp" && typeof v === "string") return formatInstant({ micros: parseInstant(v) }, timezone);
  } catch {
    // Not an instant croft can read: the value is shown as it is.
  }
  return undefined;
}

/** The run line of an ingest: its behavior, and what it fetches (§4.2). */
function ingestWords(step: PlannedStep, w: DryRunWindow | null, from: string | undefined): string {
  if (step.rebuild) return `${step.behavior}, from scratch (--rebuild): ${step.kind === "file" ? "loads every file" : "fetches everything"}`;
  if (step.kind === "file") {
    return step.incremental.kind === "files" ? `${step.behavior}, new and changed files only` : `${step.behavior} (nothing is written when no file changed)`;
  }
  if (step.incremental.kind !== "cursor") return step.behavior;
  if (!w) return `${step.behavior}, first load: fetches everything`;
  const at = w.sinceAt && w.sinceAt !== String(w.sinceValue) ? ` (${w.sinceAt})` : "";
  if (w.source === "from") return `${step.behavior}, since ${w.sinceValue}${at} from --from ${from ?? ""}`.trimEnd();
  return `${step.behavior}, since ${w.sinceValue}${at}${w.lookback ? ` = saved − ${w.lookback}` : ""}`;
}

// ---------------------------------------------------------------------------------------------------------
// Confirmations (§6): what a real run would stop for. A dry run issues no token.

interface ConfirmContext {
  plan: RunPlan;
  entries: ReadonlyMap<string, CatalogAsset>;
  history: History;
  project: Project;
  allowShrink: boolean;
  selectors: readonly string[];
  /** The run builds this asset before the step (an earlier step that would run). */
  builtFirst: (asset: string) => boolean;
}

/** What a step would stop for: a confirmation; or, for the cost guard, the inputs whose rows are unknown until
 *  the run has built them (it may stop then), with the rows known so far and the limit. */
interface Ask { confirmation?: DryRunConfirmation; until?: string[]; rows?: number; limit?: number }

function confirmationOf(step: PlannedStep, entry: CatalogAsset | null, c: ConfirmContext): Ask | null {
  // --rebuild of an ingest or an incremental TS transform (run/rebuild.ts): asks when the table has rows, or when a
  // paid transform would process more input rows than its confirmAbove; one confirmation covers both.
  if (step.rebuild && rebuildTrashes(step)) {
    const rows = entry?.rows ?? 0;
    const limit = step.confirmAbove ?? DEFAULT_CONFIRM_ABOVE;
    // From scratch every input row is pending: the estimate with no saved position.
    const paid = step.kind === "transform" && step.usesHttp === true ? pendingEstimate(step, null, c) : null;
    if (rows > 0 || (paid !== null && paid.rows > limit)) {
      const impact = rebuildImpact(c.project.paths.stateDir, step, rows, paid?.rows);
      return { confirmation: { action: "rebuild", command: rebuildCommand(step.asset), impact } };
    }
    if (paid?.unknown.length) return { until: paid.unknown, rows: paid.rows, limit };
    return null;
  }
  // A key added to an append ingest, or a pin that differs from the stored type (§6): the run counts the stored rows
  // first, and asks (the table to the trash first) only when some would go or change. It asks before anything else.
  const change = changeConfirmation(step, entry, c.project.paths.stateDir);
  if (change) return { confirmation: change };
  // --allow-shrink names exactly one replace ingest (checkRunFlags); allowShrink: true in its code needs no token.
  if (c.allowShrink && c.selectors[0] === step.asset && (step.kind === "rows" || step.kind === "file") && step.write === "replace"
    && step.spec?.allowShrink !== true && entry && entry.rows > 0) {
    return { confirmation: { action: "allow_shrink", command: shrinkCommand(step.asset), impact: shrinkImpact(c.project.paths.stateDir, step.asset, entry.rows) } };
  }
  if (step.kind === "transform" && step.action === "update" && step.usesHttp === true) {
    const pending = pendingEstimate(step, entry, c);
    const limit = step.confirmAbove ?? DEFAULT_CONFIRM_ABOVE;
    if (pending.rows > limit) {
      const impact: Impact = { asset: step.asset, action: REPROCESS_ACTION, rows: pending.rows, downstream: [...step.readBy], estimatedRequests: pending.rows };
      return { confirmation: { action: "large_reprocess", command: `croft run ${step.asset}`, impact } };
    }
    if (pending.unknown.length) return { until: pending.unknown, rows: pending.rows, limit };
  }
  return null;
}

/** A planned ingest as the mirror-side checks of a code change take it (plan.ts pendingBehavior, pendingPins). */
function sideOf(step: PlannedStep): BehaviorSide {
  return { ...step, ...(step.spec?.pins ? { pins: step.spec.pins } : {}) };
}

/**
 * The convert_key or pin_change question a run of this ingest would ask before it fetches (load/config-change.ts
 * settleConfig), from the catalog mirror: a key added to an append ingest, or a pin that differs from the stored
 * type. The mirror cannot count the rows that repeat a key or the values a pin changes, so this says what is at stake
 * (the table goes to the trash first) and the run asks only when some would go or change. One question for both,
 * as the run asks one. The impact's action is the run's.
 */
function changeConfirmation(step: PlannedStep, entry: CatalogAsset | null, stateDir: string): DryRunConfirmation | null {
  if ((step.kind !== "rows" && step.kind !== "file") || step.rebuild || !entry) return null;
  const side = sideOf(step);
  const behavior = pendingBehavior(side, entry);
  const convert = behavior?.convertible ? behavior.change.to.key : null;
  const pins = pendingPins(side, entry);
  if (!convert && pins.length === 0) return null;
  const actions = [...(convert ? [`append ingest gains key ${convert.join(", ")}; duplicates removed in place`] : []),
    ...pins.map((p) => `pin change: ${p.column} ${p.from} → ${p.to}`)];
  const impact: Impact = { asset: step.asset, action: actions.join("; "), rows: entry.rows, trashPath: plannedTrashPath(stateDir, step.asset), downstream: [...step.readBy] };
  return { action: convert ? "convert_key" : "pin_change", command: changeCommand(step.asset), impact };
}

/**
 * The input rows an incremental transform would process, from runs.sqlite: all of an input's rows when it has
 * not read that input yet; otherwise the rows the input's steps added or updated since the position it saved,
 * at most the input's rows. As the run's cost guard (run/transform.ts), only the inputs the code reads with
 * newRows() count (LoadedTsAsset.readsNewRows; every input when the scan cannot tell): a lookup read with rows()
 * never gets a position, and is no work to process. Inputs without a key are not counted (the transform's own
 * count skips them too). An input never built has no rows to count: when the run builds it first (`builtFirst`),
 * all its rows will be pending, and how many is unknown until then (`unknown`, for the dry run to say so).
 */
export function pendingEstimate(step: PlannedStep, entry: CatalogAsset | null,
  c: Pick<ConfirmContext, "entries" | "history" | "plan"> & { builtFirst?: (asset: string) => boolean }): { rows: number; unknown: string[] } {
  const reads = step.loaded?.readsNewRows;
  let total = 0;
  const unknown: string[] = [];
  for (const input of step.inputs) {
    if (reads && !reads.includes(input)) continue;
    const e = c.entries.get(input);
    if (!e) {
      const keyed = (c.plan.steps.find((s) => s.asset === input)?.key.length ?? 0) > 0;
      if (keyed && c.builtFirst?.(input)) unknown.push(input);
      continue;
    }
    if (e.key.length === 0 || e.rows === 0) continue;
    const seen = entry?.inputsSeen?.[input];
    if (!seen?.seenLoadedAt) {
      total += e.rows;
      continue;
    }
    if (!e.lastLoadedAt || !later(e.lastLoadedAt, seen.seenLoadedAt)) continue;
    const written = (c.history.writes.get(input) ?? []).filter((w) => later(w.finishedAt, seen.seenLoadedAt!)).reduce((n, w) => n + w.rows, 0);
    total += Math.min(e.rows, Math.max(1, written));
  }
  return { rows: total, unknown };
}

/** The reason's note for a transform the cost guard may stop: the inputs built first in this run, whose rows are
 *  unknown until then. */
function mayAskWords(until: readonly string[], rows = 0, limit = DEFAULT_CONFIRM_ABOVE): string {
  const inputs = listed(until);
  const known = rows > 0 ? `about ${rows.toLocaleString("en-US")} input rows, and the rows of ${inputs} are` : "the rows it would process are";
  return `may need confirmation: ${known} unknown until ${inputs} ${until.length === 1 ? "is" : "are"} built, first in this run `
    + `(LARGE_REPROCESS above ${limit.toLocaleString("en-US")})`;
}

function later(a: string, b: string): boolean {
  try {
    return parseInstant(a) > parseInstant(b);
  } catch {
    return a > b;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Next steps and output

function dedupe(problems: Problem[]): Problem[] {
  const seen = new Set<string>();
  return problems.filter((p) => {
    const key = `${p.code}\u0000${p.asset ?? ""}\u0000${p.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function nextOf(steps: readonly DryRunStep[], i: DryRunInput, o: { builds: readonly Next[]; mayAsk: readonly { asset: string; until: string[] }[] }): Next[] {
  const next: Next[] = [];
  if (steps.some((s) => s.problems.length > 0)) next.push({ command: "croft validate", reason: "see every problem of the project with its fix" });
  // A step skipped for an input never built: the run that builds that input (and then what reads it).
  next.push(...o.builds);
  // --allow-shrink is destructive: it never appears in next (§4.3); the user runs it themselves. So is a --rebuild that
  // would move a table to the trash; one that trashes nothing (SQL, a table never built) is a run like any other.
  const runnable = steps.some((s) => s.action !== "skip" && s.problems.length === 0);
  const trashes = steps.some((s) => s.confirmation?.action === "rebuild" && s.confirmation.impact.rows > 0);
  if (runnable && !i.allowShrink && !trashes) {
    const waits = steps.some((s) => s.confirmation);
    const until = [...new Set(o.mayAsk.flatMap((m) => m.until))];
    const reason = waits ? "run it; it stops to ask before the steps that need confirmation"
      : until.length ? `run it; it may stop to ask before ${listed(o.mayAsk.map((m) => m.asset))}, whose input rows are unknown until ${listed(until)} ${until.length === 1 ? "is" : "are"} built`
        : "run it";
    next.push({ command: runWords(i).join(" "), reason });
  }
  return next;
}

/** "a", "a and b", "a, b and c". */
function listed(list: readonly string[]): string {
  return list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

/** `croft run` with the dry run's selectors and flags, less --dry-run (and --allow-shrink, which is destructive:
 *  it never appears in next or a fix, §4.3; nextOf leaves out a --rebuild that would trash). */
function runWords(i: Pick<DryRunInput, "selectors" | "only" | "upstream" | "from" | "rebuild">): string[] {
  return [
    "croft run", ...selectorWords(i.selectors), ...(i.only ? ["--only"] : []), ...(i.upstream ? ["--upstream"] : []),
    ...(i.from !== undefined ? [`--from ${i.from}`] : []), ...(i.rebuild ? ["--rebuild"] : []),
  ];
}

/** Words for a confirmation, as the dry run shows it under its step. */
export function confirmationWords(c: DryRunConfirmation): string {
  const n = c.impact.rows.toLocaleString("en-US");
  if (c.action === "allow_shrink") {
    return `needs confirmation if the source returns less than half: the current ${n} rows go to the trash first`;
  }
  if (c.action === "rebuild") {
    const then = rebuildWords(rebuildKindOf(c.impact), c.impact.estimatedRequests !== undefined ? { estimatedRequests: c.impact.estimatedRequests } : {});
    return `needs confirmation: ${c.impact.rows > 0 ? `its ${n} rows go to the trash first, then ${then}` : then}`;
  }
  if (c.action === "convert_key") return `needs confirmation if stored rows repeat a key: its ${n} rows go to the trash first (${c.impact.action})`;
  if (c.action === "pin_change") return `needs confirmation if the pin would change stored values: its ${n} rows go to the trash first (${c.impact.action})`;
  return `needs confirmation: about ${n} input rows to process, and its code makes requests for them (LARGE_REPROCESS)`;
}

/** Human output (§4.2): one line per step, `action  asset  why`, with what would stop it underneath. */
export function formatDryRun(d: DryRunData): string {
  if (d.steps.length === 0) return "dry run: nothing would run (no ingests, and no transform is stale)";
  const width = Math.max(16, ...d.steps.map((s) => s.asset.length));
  const pad = " ".repeat(9 + width + 1);
  const lines: string[] = [];
  for (const s of d.steps) {
    lines.push(`${s.action.padEnd(8)} ${s.asset.padEnd(width)} ${s.skippedBecause ?? s.reason}`);
    for (const p of s.problems) lines.push(`${pad}fails before it runs: ${p.code} ${p.message}`);
    if (s.confirmation) lines.push(`${pad}${confirmationWords(s.confirmation)}`);
  }
  const running = d.steps.filter((s) => s.action !== "skip" && s.problems.length === 0).length;
  lines.push(`dry run: ${running} of ${d.steps.length} step${d.steps.length === 1 ? "" : "s"} would run; nothing ran`);
  return lines.join("\n");
}

/** A dry run refuses a confirmation token: it carries nothing out. */
export function refuseToken(): never {
  throw new CroftError("USAGE_ERROR", {
    message: "a dry run carries nothing out, so it takes no confirmation",
    hint: "croft confirm <token> runs the confirmed command itself",
  });
}
