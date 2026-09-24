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
//   built): what they read, and the tables their checks read (§3f); and the transforms among them whose own
//   input the run refreshes;
// - then, unless --only, every transform downstream of an asset the run takes: its input may have new rows.
//   The runner checks staleness again just before each transform, so one whose inputs did not change is left
//   alone.
//
// Actions: fetch (an ingest), rebuild (an SQL or full-refresh TS transform), update (an incremental TS
// transform), skip (with --from, as the runner skips: every transform, and in a bare run or a glob the ingests
// it does not apply to). Reasons say why. A code hash that changed only because croft.json's timezone did is
// "time zone changed", not an edit (project/resolve.ts timeZoneChanged).
//
// A static error (a load error, CHECK_INVALID, CYCLE, a bind error) is a problem of its own step: that step
// fails before it runs, and the rest of the run goes ahead. So is a check that reads a table never built that
// the run does not build first (unbuiltCheckTables): it names the table. The bind check (project/resolve.ts
// bindProject) binds each SQL asset against the columns the catalog mirror has for what it reads, or against the
// output of an SQL input the run rebuilds first. When an input the run refreshes first (an ingest, a TS
// transform) could still change those columns, only the errors a new column cannot fix count
// (INPUT_INDEPENDENT); the step reports any other when it runs.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CroftError, problem } from "../core/errors.ts";
import type { Check, CursorType, Hold, Incremental, Problem, Reason, WriteMode } from "../core/types.ts";
import { allCatalog, type CatalogAsset } from "../history/catalog.ts";
import { RUNS_DB_FILE, RunsDb } from "../history/runs-db.ts";
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
  /** Load problems. Any error makes the step fail without running (the other steps still run). */
  problems: Problem[];
  loaded?: LoadedTsAsset;
  spec?: TsAssetSpec;
  /** SQL assets: the loaded file (header, body, AST inputs, fingerprint). */
  sql?: LoadedSqlAsset;
  /** The assets it reads: an SQL asset's AST and plan dependencies, a TS transform's `inputs`. [] for ingests. */
  inputs: string[];
  /** What runs before it: its inputs plus the tables its checks read in subqueries (they only order). */
  orderAfter: string[];
  /** The assets that read it (project/graph.ts readBy). */
  readBy: string[];
  /** Its checks and warnings, parsed (checks/parse.ts), a key's implied unique and not_null first. */
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

/** Why the run takes an asset: the Reason codes, and the inputs that run before it in the same run. */
interface Taken { reasons: Set<Reason>; feeding: string[] }

/** What choose() needs to know about the project. */
interface Scope {
  byName: ReadonlyMap<string, ResolvedAsset>;
  graph: Graph;
  inputs: ReadonlyMap<string, readonly string[]>;
  stale: (name: string) => Reason[];
  /** On a cycle: a static error that no load problem shows. */
  onCycle: ReadonlySet<string>;
}

const isTransform = (a: ResolvedAsset) => a.kind === "sql" || a.kind === "ts";
const hasErrors = (a: ResolvedAsset) => a.problems.some((p) => p.severity === "error");

/** Which assets the run takes, and why (see the top of this file). Keys in no particular order. */
function choose(s: Scope, selected: readonly string[], o: { bare: boolean; only: boolean; upstream: boolean }): Map<string, Taken> {
  const taken = new Map<string, Taken>();
  const take = (name: string, reasons: readonly Reason[], feeding: readonly string[] = []) => {
    const t = taken.get(name) ?? { reasons: new Set<Reason>(), feeding: [] };
    for (const r of reasons) t.reasons.add(r);
    for (const f of feeding) if (!t.feeding.includes(f)) t.feeding.push(f);
    taken.set(name, t);
  };
  const feedingOf = (name: string) => (s.inputs.get(name) ?? []).filter((x) => taken.has(x) && x !== name);

  if (o.bare) {
    for (const a of s.byName.values()) {
      if (!a.loaded) continue;
      if (!isTransform(a)) take(a.name, ["requested", ...s.stale(a.name)]);
      else if (s.stale(a.name).length) take(a.name, s.stale(a.name));
      else if (hasErrors(a) || s.onCycle.has(a.name)) take(a.name, ["requested"]);
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
  if (!o.only) {
    for (const name of s.graph.downstream([...taken.keys()])) {
      const feeding = feedingOf(name);
      if (feeding.length && s.byName.get(name)?.loaded) take(name, [...s.stale(name), "input_changed"], feeding);
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

/** What --upstream looks at: every asset the named ones need first, directly or not (what they read, and the
 *  tables their checks read, §3f: a check cannot run on a table never built), in run order. */
function upstreamOf(s: Scope, selected: readonly string[]): string[] {
  const at = new Map(s.graph.order.map((n, i) => [n, i]));
  return neededBy(selected, (n) => [...(s.inputs.get(n) ?? []), ...(s.byName.get(n)?.orderAfter ?? [])].filter((x) => x !== n && s.byName.has(x)))
    .sort((a, b) => (at.get(a) ?? Infinity) - (at.get(b) ?? Infinity) || (a < b ? -1 : a > b ? 1 : 0));
}

function sameKeys(a: ReadonlyMap<string, unknown>, b: ReadonlyMap<string, unknown>): boolean {
  return a.size === b.size && [...a.keys()].every((k) => b.has(k));
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
  const flags = { bare: i.selectors.length === 0, only: i.only === true, upstream: i.upstream === true };

  const scopeOf = (graph: Graph, inputs: ReadonlyMap<string, readonly string[]>): Scope => {
    const stale = new Map<string, Reason[]>();
    return {
      byName, graph, inputs, onCycle: new Set(graph.cycles.flat()),
      stale: (name) => {
        let r = stale.get(name);
        if (!r) {
          const a = byName.get(name)!;
          r = a.loaded ? staleReasons(viewOf(a, inputs.get(name) ?? a.inputs, entry)) : [];
          stale.set(name, r);
        }
        return r;
      },
    };
  };
  const columns = (name: string) => entry(name)?.columns ?? null;
  const bind = (taken: ReadonlyMap<string, Taken>) => bindProject(project, { timezone: i.timezone, columns, rebuilt: (n) => taken.has(n) });

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
  // A table exists when the step runs: it was built, or this run builds it first.
  const exists = (n: string) => entry(n) !== null || (taken.has(n) && !hasErrors(byName.get(n)!));
  const steps: PlannedStep[] = [];
  const fileDirs = new Set<string>();
  for (const name of order) {
    const a = byName.get(name)!;
    const t = taken.get(name)!;
    const step = stepOf(a, t, {
      inputs: bound.inputs.get(name) ?? a.inputs, readBy: graph.readBy(name), entry,
      bind: bound, uncertain: uncertain(name),
      cycle: graph.cycles.findIndex((c) => c.includes(name)),
      checkTables: unbuiltCheckTables(a, byName, exists),
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
  /** Its checks that read a table no build has made yet (unbuiltCheckTables). */
  checkTables: Problem[];
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
  problems.push(...c.checkTables);
  const view = viewOf(a, c.inputs, c.entry);
  if (kind === "transform" && a.incremental.kind === "new-rows") {
    const edited = editedProblem(view);
    if (edited) problems.push(edited);
  }
  const reasons = [...t.reasons];
  return {
    asset: a.name, file: a.file, path: a.path, kind, action, reasons, reason: reasonText(a, t, view), problems,
    ...(a.ts ? { loaded: a.ts } : {}), ...(spec ? { spec } : {}), ...(a.sql ? { sql: a.sql } : {}),
    inputs: [...c.inputs], orderAfter: [...new Set([...a.orderAfter, ...c.inputs])], readBy: c.readBy, checks: a.checks,
    ...(a.usesHttp !== undefined ? { usesHttp: a.usesHttp } : {}), ...(a.confirmAbove !== undefined ? { confirmAbove: a.confirmAbove } : {}),
    write: a.write, key: a.key, incremental: a.incremental,
    behavior: a.behavior || behaviorLabel(a.write, a.key), words: a.words,
    ...(a.codeHash ? { codeHash: a.codeHash } : {}),
    behaviorHash: a.behaviorHash || behaviorHash(a.write, a.key, a.incremental),
    retries: spec?.retries ?? DEFAULT_RETRIES, timeoutMs: spec?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(a.output ? { output: a.output } : {}),
  };
}

/**
 * A check (or warning) reading a table that will not exist when the step runs: an asset never built that this
 * run does not build first. The check could only fail with "Table … does not exist" and a hint to correct a
 * check that is right, so the step names the table instead: a blocking check fails it before it runs
 * (CHECK_INVALID), a warning warns (as it would when it cannot run). `--upstream` builds such a table first.
 */
function unbuiltCheckTables(a: ResolvedAsset, byName: ReadonlyMap<string, ResolvedAsset>, exists: (name: string) => boolean): Problem[] {
  const out: Problem[] = [];
  let text: string | undefined;
  for (const c of a.checks) {
    for (const read of new Set(c.reads)) {
      const table = assetNamed(byName, read);
      if (!table || table === a.name || exists(table)) continue;
      text ??= readText(a.path);
      const at = text.split("\n").findIndex((l) => l.includes(c.source));
      const label = c.blocking ? "check" : "warning";
      const p = problem("CHECK_INVALID", {
        asset: a.name, file: a.file, ...(at >= 0 ? { line: at + 1 } : {}),
        message: `${a.name}: the ${label} ${JSON.stringify(c.source)} reads ${table}, which has never been built`,
        hint: `build ${table} first (croft run ${table}), or both in one run: croft run ${a.name} --upstream`,
        fix: { kind: "command", description: `build ${table}, then ${a.name}`, command: `croft run ${a.name} --upstream` },
        details: { check: c.source, blocking: c.blocking, table },
      });
      out.push(c.blocking ? p : { ...p, severity: "warning" });
    }
  }
  return out;
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
