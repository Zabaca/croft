// Planning a run (DESIGN.md §4.1 `run` and its flags, §5 "One ingest step" step 1 and "Versions, staleness and
// atomicity", §8 "Backfills"): resolveProject (project/resolve.ts) → what the run takes → the bind check → one
// PlannedStep per asset, in run order. Staleness comes from the catalog mirror in runs.sqlite; nothing here
// opens the warehouse, so `croft run --dry-run` plans without waiting.
//
// What a run takes:
// - a bare `croft run`: every ingest, every transform that is stale (run/staleness.ts: never built, an input
//   changed or was replaced, its code changed), and every asset with a static error, so it fails visibly;
// - named assets (names or globs): those, stale or not;
// - --upstream: also what they need first, directly or not, that is stale (an ingest only when it was never
//   built): what they read, and the tables their blocking checks read (§3f); and the transforms among them whose
//   own input the run refreshes;
// - an SQL input of an SQL asset the run takes, when that input is stale and its new output differs from its
//   table (or it was never built): validate binds SQL against the new output of the SQL it reads (§6), so the run
//   rebuilds such an input first, and the reader reads what validate checked (an edit that adds a column upstream
//   and uses it downstream). One whose columns did not change, or whose new SQL does not bind, is left as it is;
// - then, unless --only, every transform downstream of an asset the run takes: its input may have new rows.
//   The runner checks staleness again just before each transform, so one whose inputs did not change is left
//   alone.
//
// Actions: fetch (an ingest), rebuild (an SQL or full-refresh TS transform), update (an incremental TS
// transform), skip (with --from, as the runner skips: every transform, and in a bare run or a glob the ingests
// it does not apply to; and a transform that reads an asset never built that the run does not build either, with
// INPUT_NOT_BUILT naming the run that builds it, rather than a failure with "no table named …"). Reasons say
// why. A code hash that changed only because croft.json's timezone did is "time zone changed", not an edit
// (project/resolve.ts timeZoneChanged).
//
// A static error (a load error, CHECK_INVALID, CYCLE, a bind error) is a problem of its own step: that step
// fails before it runs, and the rest of the run goes ahead. So is a blocking check that reads a table never built
// that the run does not build first (unbuiltCheckTables): it names the table. A warning never blocks and does not
// order the steps: one whose table will not exist when it runs (never built, or built later in this run) is left
// out of the step, with an info note. The bind check (project/resolve.ts bindProject) binds each SQL asset
// against the columns the catalog mirror has for what it reads, or against the output of an SQL input the run
// rebuilds first. When an input the run refreshes first (an ingest, a TS transform) could still change those
// columns, only the errors a new column cannot fix count (INPUT_INDEPENDENT); the step reports any other when it
// runs.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CroftError, problem } from "../core/errors.ts";
import type { Check, CursorType, Hold, Incremental, Problem, Reason, WriteMode } from "../core/types.ts";
import { allCatalog, type CatalogAsset } from "../history/catalog.ts";
import { RUNS_DB_FILE, RunsDb } from "../history/runs-db.ts";
import { isReservedColumn } from "../load/evolve.ts";
import type { Graph } from "../project/graph.ts";
import {
  behaviorHash, behaviorLabel, bindProject, isGlob, neededBy, type ProjectBind, type ResolvedAsset, resolveProject, stepKindOf,
} from "../project/resolve.ts";
import { loadProject } from "../project/root.ts";
import type { LoadedSqlAsset } from "../project/sql-asset.ts";
import type { LoadedTsAsset, TsAssetSpec } from "../project/ts-asset.ts";
import type { FileIngest } from "../types.ts";
import { editedProblem, type StaleView, staleReasons } from "./staleness.ts";

export type StepKind = "rows" | "file" | "transform" | "sql";

export interface PlannedStep {
  asset: string;
  file: string;                 // root-relative, "assets/github_issues.ts"
  path: string;                 // absolute
  kind: StepKind;
  /** fetch: an ingest runs. rebuild: an SQL or full-refresh TS transform is recomputed in full. update: an
   *  incremental TS transform processes its new input rows. skip: nothing runs (the reason says why). */
  action: "fetch" | "rebuild" | "update" | "skip";
  reasons: Reason[];
  /** Why the scheduler (or the cost guard) holds the step back; a held step does not run. A manual run holds
   *  nothing: it asks for confirmation instead (the planner never sets it before phase 3). */
  hold?: Hold;
  /** Why the step runs, or why it is skipped, in words: "requested", "requested; SQL changed (assets/x.sql)",
   *  "input github_issues may have new rows". Run output shows it under the step when it is not "requested". */
  reason: string;
  /** An SQL input the run takes only because these SQL assets of the run read its new output (its columns
   *  changed, or it was never built): it is rebuilt first, so they read what validate checked. */
  neededBy?: string[];
  /** Load problems. Any error makes the step fail without running (the other steps still run). */
  problems: Problem[];
  loaded?: LoadedTsAsset;
  spec?: TsAssetSpec;
  /** SQL assets: the loaded file (header, body, AST inputs, fingerprint). */
  sql?: LoadedSqlAsset;
  /** The assets it reads: an SQL asset's AST and plan dependencies, a TS transform's `inputs`. [] for ingests. */
  inputs: string[];
  /** What runs before it: its inputs plus the tables its blocking checks read in subqueries (they only order).
   *  A warning's tables are not here: it runs after the commit, against the tables as they are. */
  orderAfter: string[];
  /** The assets that read it (project/graph.ts readBy). */
  readBy: string[];
  /** Its checks and warnings, parsed (checks/parse.ts), a key's implied unique and not_null first. A warning whose
   *  table will not exist when it runs is left out (its INPUT_NOT_BUILT info note says so). */
  checks: Check[];
  /** TS transforms: the code makes requests (ctx.http, fetch, an HTTP or LLM package): the cost guard applies
   *  to incremental ones, TRANSFORM_MAKES_REQUESTS to full-refresh ones. */
  usesHttp?: boolean;
  /** Incremental TS transforms: LARGE_REPROCESS above this many pending input rows (default 1000, §5). */
  confirmAbove?: number;
  write: WriteMode;
  key: string[];
  incremental: Incremental;
  /** Short label for run output: "merge by id", "replace", "append". */
  behavior: string;
  /** The behavior in plain words (describe, the catalog mirror). */
  words: string;
  codeHash?: string;
  /** Hash of what decides how rows are written (write mode, key, incremental field): INGEST_CONFIG_CHANGED. */
  behaviorHash: string;
  retries: number;
  timeoutMs: number;
  /** What the asset's top-level code printed while it was imported (unredacted; the step log redacts it). */
  output?: string[];
  /** --due: the schedule fire this ingest's step handles (ISO-8601 UTC), recorded as its last_fire_at when the step
   *  starts (§8). */
  fire?: string;
}

/**
 * --due (the scheduler's run, §8 "What counts as due"): what holds each step back, and the fire each due ingest
 * handles. schedule/due.ts duePlanning() reads both from runs.sqlite; the plan applies them to every step it takes,
 * downstream included, with the code hashes it just computed.
 */
export interface DuePlanning {
  /** Why the scheduler must not run this step now (SCHEDULE_HELD, LARGE_REPROCESS, paused, leased), or null.
   *  `reason` becomes the step's reason; `problem` (a warning) goes with the skipped step. */
  hold(step: { asset: string; file: string; kind: StepKind; codeHash?: string; ok: boolean }): { hold: Hold; reason: string; problem?: Problem } | null;
  /** The fire a due ingest handles (its schedule as written), or null. */
  fire(step: { asset: string; schedule?: string }): string | null;
}

export interface RunPlan {
  /** One step per asset the run takes, in run order (`order`). */
  steps: PlannedStep[];
  /** The steps' assets in the order they run: every asset after its orderAfter, ties broken by name
   *  (project/graph.ts order); assets on or after a cycle last, by name. */
  order: string[];
  /** Discovery problems (bad or clashing file names): all of them for a bare run, else those a glob matched.
   *  An asset's own problems (CYCLE included) are on its step. */
  problems: Problem[];
  /** Directories of declared file ingests. The run's warehouse sandbox no longer needs them (files are read from
   *  snapshots in the state folder); kept for tools that want to know where an ingest reads. */
  fileDirs: string[];
}

export interface PlanInput {
  root: string;
  timezone: string;
  selectors: readonly string[];
  /** Cursor types saved by earlier loads, for CURSOR_TYPE_MISMATCH at load time. Default: the catalog's. */
  cursorTypes?: Record<string, CursorType>;
  importTimeoutMs?: number;
  /** The catalog mirror (runs.sqlite): staleness, and the columns the bind check binds against. Default: read
   *  from the project's runs.sqlite (none when it does not exist; it is never created here). */
  catalog?: readonly CatalogAsset[];
  /** --only: not the transforms downstream of what the run takes. */
  only?: boolean;
  /** --upstream: also the stale assets the named ones need first: what they read, and the tables their checks
   *  read. */
  upstream?: boolean;
  /** --from: only fetches run. In a bare run or a glob, an ingest it does not apply to is planned as skip (one
   *  named exactly is refused by the runner's checkRunFlags instead), and so is every transform. */
  from?: string;
  /** The command that was typed, again with other selectors: the did-you-mean fix of a mistyped name
   *  (project/resolve.ts selectAssets). Default: `croft run <selectors>`. */
  retry?: (selectors: readonly string[]) => string;
  /** --due: the selectors are the due assets the tick found (ingests whose schedule fired, stale transforms). An
   *  ingest is taken as schedule_due, a transform only for its staleness (one that is up to date by now is
   *  skipped), and every step, downstream included, gets the scheduler's holds. */
  due?: DuePlanning;
}

/** TS assets get 2 retries after a retryable error (§8 "Retries"). */
export const DEFAULT_RETRIES = 2;
/** No row yielded and no request completed for this long fails the step with TIMEOUT (§8 "Timeout"). */
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** Why a bare or glob `--from` run skips an asset --from cannot apply to (§8). */
export const FROM_ONLY_MERGE = "--from applies to merge ingests";

/** Bind errors no column an input gains can fix: they count even when an input the run refreshes first could
 *  still change its columns. */
const INPUT_INDEPENDENT = new Set(["QUOTE_IDENTIFIER", "SQL_SYNTAX", "DUPLICATE_OUTPUT_COLUMN", "UNKNOWN_TABLE", "QUERY_PATH_DENIED"]);

// ---------------------------------------------------------------------------------------------------------
// Selection and behavior live in project/resolve.ts (resolving an asset decides them); re-exported here.

export { behaviorHash, behaviorLabel, behaviorWords, isGlob, problemsNamed, resolveWrite, selectAssets } from "../project/resolve.ts";

// ---------------------------------------------------------------------------------------------------------
// The catalog mirror

/** The catalog mirror of runs.sqlite in `stateDir`: [] when the project has never run (the file is not created). */
export function readMirror(stateDir: string): CatalogAsset[] {
  if (!existsSync(join(stateDir, RUNS_DB_FILE))) return [];
  const db = RunsDb.open(stateDir);
  try {
    return allCatalog(db);
  } finally {
    db.close();
  }
}

/** The mirror of the project at `root`, for callers that pass none. */
function mirrorOf(root: string): CatalogAsset[] {
  let stateDir: string;
  try {
    stateDir = loadProject({ root }).paths.stateDir;
  } catch {
    return [];
  }
  return readMirror(stateDir);
}

/** Saved cursor types by asset (CURSOR_TYPE_MISMATCH at load time). */
export function cursorTypesOf(catalog: readonly CatalogAsset[]): Record<string, CursorType> {
  const out: Record<string, CursorType> = {};
  for (const c of catalog) if (c.cursor?.type) out[c.asset] = c.cursor.type;
  return out;
}

/** What run/staleness.ts needs of a planned step: the runner checks staleness again with it just before a
 *  transform runs, with the catalog as it is then. */
export function staleViewOf(step: Pick<PlannedStep, "asset" | "file" | "kind" | "incremental" | "inputs" | "codeHash">,
  entry: (asset: string) => CatalogAsset | null): StaleView {
  const kind = step.kind === "sql" ? "sql" : step.kind === "transform" ? "ts" : "ingest";
  return {
    asset: step.asset, file: step.file, kind, incremental: step.incremental.kind === "new-rows", inputs: step.inputs,
    ...(step.codeHash ? { codeHash: step.codeHash } : {}), entry: entry(step.asset),
    inputEntries: Object.fromEntries(step.inputs.map((x) => [x, entry(x)])),
  };
}

// ---------------------------------------------------------------------------------------------------------
// The plan

/** The directory part of a file ingest's path or glob, resolved against the root; URLs have none. */
export function fileDirsOf(root: string, config: Pick<FileIngest, "file">): string[] {
  const list = Array.isArray(config.file) ? config.file : [config.file];
  const out: string[] = [];
  for (const f of list) {
    if (typeof f !== "string" || /^[a-z][a-z0-9+.-]*:\/\//i.test(f)) continue;
    const parts = f.split(/[\\/]/);
    const firstGlob = parts.findIndex((p) => isGlob(p));
    const fixed = firstGlob < 0 ? dirname(f) : parts.slice(0, firstGlob).join("/") || ".";
    out.push(isAbsolute(fixed) ? fixed : resolve(root, fixed));
  }
  return out;
}

/** Why the run takes an asset: the Reason codes, the inputs that run before it in the same run, and the SQL
 *  assets that read its new output (it was taken for them: see reshaped). */
interface Taken { reasons: Set<Reason>; feeding: string[]; readers: string[] }

/** What choose() needs to know about the project. */
interface Scope {
  byName: ReadonlyMap<string, ResolvedAsset>;
  graph: Graph;
  inputs: ReadonlyMap<string, readonly string[]>;
  stale: (name: string) => Reason[];
  /** On a cycle: a static error that no load problem shows. */
  onCycle: ReadonlySet<string>;
  /** An SQL asset that is stale, and whose new output (bound as validate binds it) differs from the columns of its
   *  table, or that was never built: what reads it must read its new output. */
  reshaped: (name: string) => boolean;
}

const isTransform = (a: ResolvedAsset) => a.kind === "sql" || a.kind === "ts";
const hasErrors = (a: ResolvedAsset) => a.problems.some((p) => p.severity === "error");

/** Which assets the run takes, and why (see the top of this file). Keys in no particular order. */
function choose(s: Scope, selected: readonly string[], o: { bare: boolean; only: boolean; upstream: boolean; from: boolean; due: boolean }): Map<string, Taken> {
  const taken = new Map<string, Taken>();
  const take = (name: string, reasons: readonly Reason[], feeding: readonly string[] = []) => {
    const t = taken.get(name) ?? { reasons: new Set<Reason>(), feeding: [], readers: [] };
    for (const r of reasons) t.reasons.add(r);
    for (const f of feeding) if (!t.feeding.includes(f)) t.feeding.push(f);
    taken.set(name, t);
    return t;
  };
  const feedingOf = (name: string) => (s.inputs.get(name) ?? []).filter((x) => taken.has(x) && x !== name);

  if (o.bare) {
    for (const a of s.byName.values()) {
      if (!a.loaded) continue;
      if (!isTransform(a)) take(a.name, ["requested", ...s.stale(a.name)]);
      else if (s.stale(a.name).length) take(a.name, s.stale(a.name));
      else if (hasErrors(a) || s.onCycle.has(a.name)) take(a.name, ["requested"]);
    }
  } else if (o.due) {
    // The scheduler asks for what it found due, not for a rebuild: a transform runs only while it is stale.
    for (const name of selected) {
      const a = s.byName.get(name);
      take(name, a && isTransform(a) ? s.stale(name) : ["schedule_due", ...s.stale(name)]);
    }
  } else {
    for (const name of selected) take(name, ["requested", ...s.stale(name)]);
    if (o.upstream) {
      for (const name of upstreamOf(s, selected)) {
        const a = s.byName.get(name);
        if (!a?.loaded) continue;
        const stale = s.stale(name);
        const feeding = isTransform(a) ? feedingOf(name) : [];
        if (stale.length || feeding.length) take(name, [...stale, ...(feeding.length ? ["input_changed" as const] : [])], feeding);
      }
    }
  }
  // The SQL inputs whose new output an SQL asset the run takes must read (reshaped), then, unless --only, what
  // reads anything taken; again until nothing more is taken, since an asset taken downstream may read another
  // such input. A bare run takes every stale transform already, and under --from no transform runs.
  for (let size = -1; size !== taken.size;) {
    size = taken.size;
    if (!o.bare && !o.from) pullReshaped(s, taken, take);
    if (!o.only) {
      for (const name of s.graph.downstream([...taken.keys()])) {
        const feeding = feedingOf(name);
        if (feeding.length && s.byName.get(name)?.loaded) take(name, [...s.stale(name), "input_changed"], feeding);
      }
    }
  }
  // Every asset taken knows which of its inputs run before it (the --from rule, the reason's words); one that
  // was built before may get new input rows from them (a never-built one reads everything anyway).
  for (const [name, t] of taken) {
    for (const f of feedingOf(name)) if (!t.feeding.includes(f)) t.feeding.push(f);
    if (t.feeding.length && !t.reasons.has("never_built")) t.reasons.add("input_changed");
  }
  return taken;
}

/** Take the reshaped SQL inputs of every SQL asset taken, directly or through SQL taken for this reason, and note
 *  which assets read their new output (the reason's words). */
function pullReshaped(s: Scope, taken: Map<string, Taken>, take: (name: string, reasons: readonly Reason[]) => Taken): void {
  const queue = [...taken.keys()];
  while (queue.length) {
    const reader = queue.pop()!;
    if (s.byName.get(reader)?.kind !== "sql") continue;
    for (const x of s.inputs.get(reader) ?? []) {
      if (x === reader || !s.reshaped(x)) continue;
      const had = taken.get(x);
      if (had) {
        if (had.readers.length && !had.readers.includes(reader)) had.readers.push(reader);
        continue;
      }
      take(x, s.stale(x)).readers.push(reader);
      queue.push(x);
    }
  }
}

/** What --upstream looks at: every asset the named ones need first, directly or not (what they read, and the
 *  tables their blocking checks read, §3f: a check cannot run on a table never built), in run order. */
function upstreamOf(s: Scope, selected: readonly string[]): string[] {
  const at = new Map(s.graph.order.map((n, i) => [n, i]));
  return neededBy(selected, (n) => [...(s.inputs.get(n) ?? []), ...(s.byName.get(n)?.orderAfter ?? [])].filter((x) => x !== n && s.byName.has(x)))
    .sort((a, b) => (at.get(a) ?? Infinity) - (at.get(b) ?? Infinity) || (a < b ? -1 : a > b ? 1 : 0));
}

function sameKeys(a: ReadonlyMap<string, unknown>, b: ReadonlyMap<string, unknown>): boolean {
  return a.size === b.size && [...a.keys()].every((k) => b.has(k));
}

/** The same columns, in the same order, with the same types. */
function sameColumns(a: readonly { name: string; type: string }[], b: readonly { name: string; type: string }[]): boolean {
  return a.length === b.length && a.every((c, n) => c.name === b[n]!.name && c.type.toUpperCase() === b[n]!.type.toUpperCase());
}

/** Discover, resolve and bind the project, and decide what each asset the run takes does (see the top). Throws
 *  USAGE_ERROR (or the named file's discovery problem) for a selector that names nothing. */
export async function planRun(i: PlanInput): Promise<RunPlan> {
  const catalog = i.catalog ?? mirrorOf(i.root);
  const entries = new Map(catalog.map((c) => [c.asset, c]));
  const entry = (name: string) => entries.get(name) ?? null;
  const project = await resolveProject({
    root: i.root, timezone: i.timezone, selectors: i.selectors, keepOutput: true, cursorTypes: i.cursorTypes ?? cursorTypesOf(catalog),
    builtHashes: (name) => entry(name)?.codeHash ?? null,
    ...(i.importTimeoutMs !== undefined ? { importTimeoutMs: i.importTimeoutMs } : {}), ...(i.retry ? { retry: i.retry } : {}),
  });
  const byName = new Map(project.assets.map((a) => [a.name, a]));
  const flags = { bare: i.selectors.length === 0, only: i.only === true, upstream: i.upstream === true, from: i.from !== undefined, due: i.due !== undefined };
  const columns = (name: string) => entry(name)?.columns ?? null;
  const bind = (taken: ReadonlyMap<string, Taken>) => bindProject(project, { timezone: i.timezone, columns, rebuilt: (n) => taken.has(n) });
  // Every SQL asset bound as validate binds it, each against the new output of the SQL it reads: the columns an
  // SQL input the run rebuilds will have (reshaped). A bare run takes every stale transform anyway.
  const fresh = flags.bare || flags.from ? null : await bindProject(project, { timezone: i.timezone, columns });

  const scopeOf = (graph: Graph, inputs: ReadonlyMap<string, readonly string[]>): Scope => {
    const stale = new Map<string, Reason[]>();
    const staleOf = (name: string) => {
      let r = stale.get(name);
      if (!r) {
        const a = byName.get(name)!;
        r = a.loaded ? staleReasons(viewOf(a, inputs.get(name) ?? a.inputs, entry)) : [];
        stale.set(name, r);
      }
      return r;
    };
    return {
      byName, graph, inputs, onCycle: new Set(graph.cycles.flat()), stale: staleOf,
      reshaped: (name) => {
        const a = byName.get(name);
        const out = fresh?.results.get(name)?.outputColumns;
        if (a?.kind !== "sql" || !a.loaded || !out || staleOf(name).length === 0) return false;
        const built = entry(name)?.columns.filter((c) => !isReservedColumn(c.name));
        return !built || !sameColumns(out, built);
      },
    };
  };

  // Choose over the resolved graph, bind (which adds the unoptimized plans' scans to the inputs), and choose
  // again over the graph with them; bind once more only when that changed what the run takes.
  let taken = choose(scopeOf(project.graph, new Map(project.assets.map((a) => [a.name, a.inputs]))), project.selected, flags);
  let bound: ProjectBind = await bind(taken);
  const scope = scopeOf(bound.graph, bound.inputs);
  const again = choose(scope, project.selected, flags);
  if (!sameKeys(again, taken)) {
    taken = again;
    bound = await bind(taken);
  }
  const graph = bound.graph;

  const order = [
    ...graph.order.filter((n) => taken.has(n)),
    ...[...taken.keys()].filter((n) => !graph.order.includes(n)).sort(),
  ];
  const uncertain = uncertainty(byName, bound.inputs, taken);
  const exact = new Set(i.selectors.filter((sel) => !isGlob(sel)));
  /** Steps skipped because an input will not exist (INPUT_NOT_BUILT), with the never-built assets at the root of
   *  it: running those builds the rest. */
  const notBuilding = new Map<string, string[]>();
  // This run builds it: taken, with nothing that fails it before it runs, and not skipped for a missing input.
  const builds = (n: string) => taken.has(n) && !hasErrors(byName.get(n)!) && !notBuilding.has(n);
  // A table a blocking check reads exists when the step runs: it was built, or this run builds it first (it is in
  // the step's orderAfter). A warning does not wait for the tables it reads: one this run builds exists for it
  // only when it is built before the asset anyway, through what the asset must run after.
  const exists = (n: string) => entry(n) !== null || builds(n);
  const before = (name: string) => new Set(neededBy([name], (n) => [...(bound.inputs.get(n) ?? []), ...(byName.get(n)?.orderAfter ?? [])]));
  // The never-built assets at the root of a missing input: itself, unless it reads never-built assets in turn.
  // `croft run <roots>` builds them and then, downstream, the input and the step.
  const rootsOf = (x: string, seen: Set<string> = new Set()): string[] => {
    const known = notBuilding.get(x);
    if (known) return known;
    seen.add(x);
    const deeper = (bound.inputs.get(x) ?? []).filter((y) => !seen.has(y) && byName.has(y) && entry(y) === null);
    return deeper.length ? [...new Set(deeper.flatMap((y) => rootsOf(y, seen)))] : [x];
  };
  const steps: PlannedStep[] = [];
  const fileDirs = new Set<string>();
  for (const name of order) {
    const a = byName.get(name)!;
    const t = taken.get(name)!;
    let first: Set<string> | undefined;
    const checkTables = unbuiltCheckTables(a, byName, {
      exists, existsForWarning: (n) => entry(n) !== null || (builds(n) && (first ??= before(name)).has(n)), builtLater: builds,
    });
    const step = stepOf(a, t, {
      inputs: bound.inputs.get(name) ?? a.inputs, readBy: graph.readBy(name), entry,
      bind: bound, uncertain: uncertain(name),
      cycle: graph.cycles.findIndex((c) => c.includes(name)),
      checkTables,
    });
    // --from: only fetches run (the runner skips every other step). A transform is skipped, whatever reads a
    // backfilled ingest included; in a bare run or a glob, so is an ingest --from cannot apply to (one named
    // exactly is refused by the runner's checkRunFlags instead).
    if (i.from !== undefined) {
      const ingest = step.kind === "rows" || step.kind === "file";
      if (!ingest || (!exact.has(name) && loadErrors(step).length === 0 && backfillUnsupported(step) !== null)) {
        step.action = "skip";
        step.reason = FROM_ONLY_MERGE;
      }
    }
    // An input that will not exist when the step runs: never built, and not built by this run (not taken, or
    // skipped for the same reason). The step would fail with "no table named ..."; it is skipped instead, naming
    // the run that builds the input. An input the run takes that fails is the runner's news: it skips the step.
    if (step.action !== "skip" && loadErrors(step).length === 0) {
      const missing = step.inputs.filter((x) => x !== name && byName.has(x) && entry(x) === null && (!taken.has(x) || notBuilding.has(x)));
      if (missing.length) {
        const roots = [...new Set(missing.flatMap((x) => rootsOf(x)))];
        notBuilding.set(name, roots);
        skipForInputs(step, missing, roots);
      }
    }
    if (i.due) applyDue(step, i.due);
    if (step.kind === "file" && step.action !== "skip" && a.ts?.definition) {
      for (const d of fileDirsOf(i.root, a.ts.definition.config as FileIngest)) fileDirs.add(d);
    }
    steps.push(step);
  }
  return {
    steps,
    order,
    problems: project.problems.filter((p) => p.code !== "CYCLE"),
    fileDirs: [...fileDirs].filter((d) => d !== join(i.root, "files")),
  };
}

/**
 * --due on one step: a transform the tick found stale that is up to date by now is skipped (another run built it
 * meanwhile); a step the scheduler must not run is held, with its reason and problem, and runs nothing, even when
 * its code does not load (an edit in progress); a due ingest notes the fire it handles.
 */
function applyDue(step: PlannedStep, due: DuePlanning): void {
  if (step.action === "skip") return;
  const transform = step.kind === "sql" || step.kind === "transform";
  if (transform && step.reasons.length === 0) {
    step.action = "skip";
    step.reason = "up to date: nothing it reads changed since the scheduler found it due";
    return;
  }
  const h = due.hold({ asset: step.asset, file: step.file, kind: step.kind, ...(step.codeHash ? { codeHash: step.codeHash } : {}), ok: loadErrors(step).length === 0 });
  if (h) {
    step.hold = h.hold;
    step.reason = h.reason;
    if (h.problem) step.problems.push({ ...h.problem, asset: h.problem.asset ?? step.asset });
    return;
  }
  const fire = transform ? null : due.fire({ asset: step.asset, ...(step.spec?.schedule !== undefined ? { schedule: step.spec.schedule } : {}) });
  if (fire) step.fire = fire;
}

function viewOf(a: ResolvedAsset, inputs: readonly string[], entry: (name: string) => CatalogAsset | null): StaleView {
  return {
    asset: a.name, file: a.file, kind: a.kind ?? "ingest", incremental: a.incremental.kind === "new-rows", inputs,
    ...(a.codeHash ? { codeHash: a.codeHash } : {}), entry: entry(a.name),
    inputEntries: Object.fromEntries(inputs.map((x) => [x, entry(x)])),
    ...(a.timeZoneChanged ? { builtInZone: a.timeZoneChanged.from } : {}),
  };
}

/**
 * Whether an SQL asset's bind could still change before it runs: it reads, directly or through SQL the run
 * rebuilds, an ingest or TS transform the run refreshes first, whose columns may grow or change type then.
 */
function uncertainty(byName: ReadonlyMap<string, ResolvedAsset>, inputs: ReadonlyMap<string, readonly string[]>,
  taken: ReadonlyMap<string, unknown>): (name: string) => boolean {
  const memo = new Map<string, boolean>();
  const shapeMayChange = (name: string): boolean => {
    if (!taken.has(name)) return false;                      // not run: its readers read the table as it is
    if (byName.get(name)?.kind !== "sql") return true;
    return bindMayChange(name);
  };
  const bindMayChange = (name: string): boolean => {
    const known = memo.get(name);
    if (known !== undefined) return known;
    memo.set(name, true);                                    // a cycle: unknown
    const out = (inputs.get(name) ?? []).some((x) => x !== name && byName.has(x) && shapeMayChange(x));
    memo.set(name, out);
    return out;
  };
  return bindMayChange;
}

interface StepContext {
  inputs: string[];
  readBy: string[];
  entry: (name: string) => CatalogAsset | null;
  bind: ProjectBind;
  /** The bind could still change before the step runs (uncertainty()). */
  uncertain: boolean;
  /** Index of the cycle it is on in graph.cycles (and bind.problems), or -1. */
  cycle: number;
  /** Its checks and warnings that read a table that will not exist when they run (unbuiltCheckTables). */
  checkTables: CheckTables;
}

function stepOf(a: ResolvedAsset, t: Taken, c: StepContext): PlannedStep {
  const kind = stepKindOf(a);
  const spec = a.ts?.spec;
  const action: PlannedStep["action"] = kind === "rows" || kind === "file" ? "fetch"
    : kind === "transform" && a.incremental.kind === "new-rows" ? "update" : "rebuild";
  let problems = [...a.problems];
  const r = c.bind.results.get(a.name);
  if (r) {
    const found = r.problems.filter((p) => p.code !== "INPUT_NOT_BUILT" && (!c.uncertain || INPUT_INDEPENDENT.has(p.code)));
    // The loader's SQL_SYNTAX, or the QUOTE_IDENTIFIER that replaces it (quoting a keyword fixes the parse).
    if (found.some((p) => p.code === "QUOTE_IDENTIFIER")) problems = problems.filter((p) => p.code !== "SQL_SYNTAX");
    const syntax = problems.some((p) => p.code === "SQL_SYNTAX");
    problems.push(...found.filter((p) => !(syntax && p.code === "SQL_SYNTAX")).map((p) => ({ ...p, asset: p.asset ?? a.name })));
  }
  if (c.cycle >= 0) {
    const cycle = c.bind.problems[c.cycle];
    if (cycle) problems.push({ ...cycle, asset: a.name, file: a.file });
  }
  problems.push(...c.checkTables.problems);
  const view = viewOf(a, c.inputs, c.entry);
  if (kind === "transform" && a.incremental.kind === "new-rows") {
    const edited = editedProblem(view);
    if (edited) problems.push(edited);
  }
  const reasons = [...t.reasons];
  return {
    asset: a.name, file: a.file, path: a.path, kind, action, reasons, reason: reasonText(a, t, view), problems,
    ...(t.readers.length ? { neededBy: [...t.readers] } : {}),
    ...(a.ts ? { loaded: a.ts } : {}), ...(spec ? { spec } : {}), ...(a.sql ? { sql: a.sql } : {}),
    inputs: [...c.inputs], orderAfter: [...new Set([...a.orderAfter, ...c.inputs])], readBy: c.readBy,
    checks: a.checks.filter((x) => !c.checkTables.skipped.has(x)),
    ...(a.usesHttp !== undefined ? { usesHttp: a.usesHttp } : {}), ...(a.confirmAbove !== undefined ? { confirmAbove: a.confirmAbove } : {}),
    write: a.write, key: a.key, incremental: a.incremental,
    behavior: a.behavior || behaviorLabel(a.write, a.key), words: a.words,
    ...(a.codeHash ? { codeHash: a.codeHash } : {}),
    behaviorHash: a.behaviorHash || behaviorHash(a.write, a.key, a.incremental),
    retries: spec?.retries ?? DEFAULT_RETRIES, timeoutMs: spec?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(a.output ? { output: a.output } : {}),
  };
}

/** What unbuiltCheckTables finds: the step's problems, and the warnings left out of it. */
interface CheckTables { problems: Problem[]; skipped: Set<Check> }

/**
 * Checks and warnings reading a table that will not exist when they run. The check could only fail with
 * "Table ... does not exist" and a hint to correct a check that is right, so the step names the table instead:
 * - a blocking check (its table is ordered first): an asset never built that this run does not build either.
 *   It fails the step before it runs (CHECK_INVALID); `--upstream` builds such a table first;
 * - a warning (its table is not ordered first, §3f): also a table this run builds that is not built before the
 *   asset anyway (downstream of it, say). A warning never blocks, so it is left out of this run, with an info
 *   note (INPUT_NOT_BUILT); once its table is built it reads it as it is.
 */
function unbuiltCheckTables(a: ResolvedAsset, byName: ReadonlyMap<string, ResolvedAsset>,
  o: { exists: (name: string) => boolean; existsForWarning: (name: string) => boolean; builtLater: (name: string) => boolean }): CheckTables {
  const out: CheckTables = { problems: [], skipped: new Set() };
  let text: string | undefined;
  const lineOf = (c: Check) => {
    text ??= readText(a.path);
    const at = text.split("\n").findIndex((l) => l.includes(c.source));
    return at >= 0 ? { line: at + 1 } : {};
  };
  for (const c of a.checks) {
    for (const read of new Set(c.reads)) {
      const table = assetNamed(byName, read);
      if (!table || table === a.name) continue;
      if (c.blocking) {
        if (o.exists(table)) continue;
        out.problems.push(problem("CHECK_INVALID", {
          asset: a.name, file: a.file, ...lineOf(c),
          message: `${a.name}: the check ${JSON.stringify(c.source)} reads ${table}, which has never been built`,
          hint: `build ${table} first (croft run ${table}), or both in one run: croft run ${a.name} --upstream`,
          fix: { kind: "command", description: `build ${table}, then ${a.name}`, command: `croft run ${a.name} --upstream` },
          details: { check: c.source, blocking: true, table },
        }));
        continue;
      }
      if (o.existsForWarning(table) || out.skipped.has(c)) continue;
      out.skipped.add(c);
      out.problems.push(problem("INPUT_NOT_BUILT", {
        asset: a.name, file: a.file, ...lineOf(c),
        message: `${a.name}: the warning ${JSON.stringify(c.source)} reads ${table}, which has not been built yet, so it is skipped in this run`,
        hint: o.builtLater(table)
          ? `this run builds ${table}, but a warning does not wait for the tables it reads; it runs from the next run on`
          : `a warning never blocks; it runs once ${table} has been built (croft run ${table})`,
        details: { check: c.source, table },
      }));
    }
  }
  return out;
}

/** Skip a step whose inputs will not exist when it runs (planRun): INPUT_NOT_BUILT, with the run that builds
 *  `roots` (the never-built assets at the root of the missing inputs), and so the missing inputs and the step. */
function skipForInputs(step: PlannedStep, missing: readonly string[], roots: readonly string[]): void {
  const one = missing.length === 1;
  const them = listed(missing);
  const build = `croft run ${roots.join(" ")}`;
  step.action = "skip";
  // The runner shows the reason as the step's skippedBecause, so it carries the command that builds the input.
  step.reason = `input ${them} ${one ? "has" : "have"} never been built, and this run does not build ${one ? "it" : "them"} (${build} does)`;
  step.problems.push({
    ...problem("INPUT_NOT_BUILT", {
      asset: step.asset, file: step.file,
      message: `${step.asset} reads ${them}, which ${one ? "has" : "have"} never been built, and this run does not build ${one ? "it" : "them"}`,
      hint: `build ${listed(roots)} first (${build}), or both in one run: croft run ${step.asset} --upstream`,
      fix: { kind: "command", description: `build ${listed(roots)}, then what reads ${roots.length === 1 ? "it" : "them"}`, command: build },
      details: { input: missing[0]!, inputs: [...missing], notBuilt: [...roots] },
    }),
    // The asset the run was asked for is not built: more than a note.
    severity: "warning",
  });
}

/** The INPUT_NOT_BUILT a step was skipped with (skipForInputs), if it was. */
export function inputNotBuilt(step: Pick<PlannedStep, "action" | "problems">): Problem | undefined {
  return step.action === "skip" ? step.problems.find((p) => p.code === "INPUT_NOT_BUILT" && Array.isArray(p.details?.inputs)) : undefined;
}

/** The next step for a step skipped with INPUT_NOT_BUILT: its fix, the run that builds the never-built input. */
export function buildFirst(p: Problem): { command: string; reason: string } | null {
  if (p.fix?.kind !== "command") return null;
  const inputs = Array.isArray(p.details?.inputs) ? p.details.inputs.map(String) : [];
  const roots = Array.isArray(p.details?.notBuilt) ? p.details.notBuilt.map(String) : inputs;
  const one = roots.length === 1;
  const direct = roots.length === inputs.length && roots.every((r) => inputs.includes(r));
  const what = direct ? (one ? "it" : "them") : `${listed(inputs)}, which ${inputs.length === 1 ? "needs" : "need"} ${one ? "it" : "them"}`;
  return { command: p.fix.command, reason: `build ${listed(roots)} first: ${p.asset ?? "a step"} reads ${what}, and ${one ? "it has" : "they have"} never been built` };
}

/** "a", "a and b", "a, b and c". */
function listed(list: readonly string[]): string {
  return list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

/** The asset a check's table names: exactly, else the one that matches without regard to case. */
function assetNamed(byName: ReadonlyMap<string, ResolvedAsset>, name: string): string | undefined {
  if (byName.has(name)) return name;
  const hits = [...byName.keys()].filter((n) => n.toLowerCase() === name.toLowerCase());
  return hits.length === 1 ? hits[0] : undefined;
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** A few names, then how many more. */
function names(list: readonly string[], max = 3): string {
  return list.length <= max ? list.join(", ") : `${list.slice(0, max).join(", ")} and ${list.length - max} more`;
}

/** The step's reason in words (PlannedStep.reason). An ingest's is "requested": the run output and the dry run
 *  describe its window and behavior instead. */
function reasonText(a: ResolvedAsset, t: Taken, view: StaleView): string {
  const parts: string[] = [];
  if (t.reasons.has("requested")) parts.push("requested");
  if (t.reasons.has("schedule_due")) parts.push("scheduled");
  if (!isTransform(a)) return parts.join("; ") || "requested";
  if (t.reasons.has("never_built")) parts.push("never built");
  const zone = a.timeZoneChanged;
  if (t.reasons.has("code_changed")) {
    parts.push(zone ? `time zone changed (${zone.from} → ${zone.to})` : `${a.kind === "sql" ? "SQL" : "code"} changed (${a.file})`);
  }
  const entry = view.entry;
  const changed: string[] = [];
  const replaced: string[] = [];
  if (entry) {
    for (const input of view.inputs) {
      if (!view.inputEntries[input]) continue;
      const alone = staleReasons({ ...view, inputs: [input] });
      if (alone.includes("input_changed")) changed.push(input);
      if (alone.includes("input_replaced")) replaced.push(input);
    }
  }
  const are = (list: readonly string[], one: string, many: string) =>
    `${list.length === 1 ? "input" : "inputs"} ${names(list)} ${list.length === 1 ? one : many}`;
  if (changed.length) parts.push(are(changed, "has new rows", "have new rows"));
  if (replaced.length) parts.push(`${are(replaced, "was replaced", "were replaced")} (restored, or changed outside croft)`);
  // What an input the run refreshes first may bring (a transform never built reads all of it anyway).
  const fresh = t.feeding.filter((x) => !changed.includes(x));
  if (fresh.length && !t.reasons.has("never_built")) parts.push(are(fresh, "may have new rows", "may have new rows"));
  // Taken for the SQL that reads its new output (pullReshaped): why a run that did not name it rebuilds it.
  if (t.readers.length) {
    parts.push(`${names(t.readers)} ${t.readers.length === 1 ? "reads" : "read"} ${t.reasons.has("never_built") ? "it" : "its new columns"}`);
  }
  if (a.kind === "ts" && a.incremental.kind === "new-rows" && entry?.codeHash && a.codeHash) {
    parts.push(entry.codeHash === a.codeHash ? "(TS code unchanged)"
      : zone ? `(time zone changed from ${zone.from}: the new zone applies to new input rows only)`
        : "(code edited: the new code applies to new input rows only)");
  }
  return parts.join("; ").replace(/; \(/g, " (") || "requested";
}

// ---------------------------------------------------------------------------------------------------------
// Backfills (§8): which assets `--from` applies to

/**
 * BACKFILL_UNSUPPORTED for everything but cursor ingests; append ingests are checked against the saved
 * cursor by the ingest step (BACKFILL_WOULD_DUPLICATE). null when `--from` applies.
 */
export function backfillUnsupported(step: Pick<PlannedStep, "asset" | "file" | "kind" | "incremental" | "write">): CroftError | null {
  const at = { asset: step.asset, file: step.file };
  if (step.kind === "sql" || step.kind === "transform") {
    return new CroftError("BACKFILL_UNSUPPORTED", {
      ...at, message: `${step.asset} is a transform; --from applies to merge ingests`,
      hint: `transforms are rebuilt from their inputs; there is nothing to backfill: croft run ${step.asset}`,
      fix: { kind: "command", description: "run the transform", command: `croft run ${step.asset}` },
    });
  }
  if (step.kind === "file") {
    return new CroftError("BACKFILL_UNSUPPORTED", {
      ...at, message: `${step.asset} is a file ingest; --from applies to merge ingests`,
      hint: `changed files reload automatically on the next run; there is nothing to backfill: croft run ${step.asset}`,
    });
  }
  if (step.incremental.kind !== "cursor" || step.write === "replace") {
    return new CroftError("BACKFILL_UNSUPPORTED", {
      ...at, message: `${step.asset} is a replace ingest; --from applies to merge ingests`,
      hint: `replace ingests always fetch everything: croft run ${step.asset}`,
      fix: { kind: "command", description: "fetch everything", command: `croft run ${step.asset}` },
    });
  }
  return null;
}

/** BACKFILL_WOULD_DUPLICATE: an append ingest re-reading rows it already has. */
export function backfillWouldDuplicate(step: PlannedStep, since: string | number, saved: string): CroftError {
  return new CroftError("BACKFILL_WOULD_DUPLICATE", {
    asset: step.asset, file: step.file,
    message: `${step.asset} appends rows; --from ${since} is before its saved position ${saved}, so the rows in between would be stored twice`,
    hint: "add a key so re-read rows replace their old versions, or pass a --from after the saved position",
    fix: { kind: "edit", description: 'add key: "<the column that identifies a row>" to the asset', file: step.file },
    details: { since, saved },
  });
}

/** Problems a step's loaded asset carries, with error severity first. */
export function loadErrors(step: Pick<PlannedStep, "problems">): Problem[] {
  return step.problems.filter((p) => p.severity === "error");
}
