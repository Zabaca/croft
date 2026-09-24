// Planning a run (DESIGN.md §4.1 `run`, §5 "One ingest step" step 1, §8 "Backfills").
//
// discover assets/ → select by name or glob → load the selected TS assets in isolation → one PlannedStep per
// selected asset, with its write behavior inferred from key and incremental (§1) and stated in plain words.
//
// Phase 1 builds ingests only. SQL and TS transforms are planned as `skip` steps with a note saying so, so a
// bare `croft run` still lists them. Staleness, downstream and --dry-run arrive with transforms (phase 2).
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CroftError } from "../core/errors.ts";
import { captureImport, collectingSink, defaultOutputRedactor } from "../core/output.ts";
import type { Check, CursorType, Hold, Incremental, Problem, Reason, WriteMode } from "../core/types.ts";
import type { FileIngest } from "../types.ts";
import { type DiscoveredAsset, discoverAssets } from "../project/discover.ts";
import { ProjectEnv } from "../project/env.ts";
import { behaviorHash, behaviorLabel, behaviorWords, isGlob, problemsNamed, resolveWrite, selectAssets } from "../project/resolve.ts";
import type { LoadedSqlAsset } from "../project/sql-asset.ts";
import { type LoadedTsAsset, loadTsAsset, type TsAssetSpec } from "../project/ts-asset.ts";

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
  /** Why the scheduler (or the cost guard) holds the step back; a held step does not run. */
  hold?: Hold;
  /** Why the step runs, or why it is skipped, in words. */
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
  /** One step per selected asset, in name order. */
  steps: PlannedStep[];
  /** The selected assets in the order they run: every asset after its orderAfter, ties broken by name
   *  (project/graph.ts order). Phase 1 plans ingests only, so this is name order. */
  order: string[];
  /** Discovery problems (bad or clashing file names): all of them for a bare run, else those a glob matched. */
  problems: Problem[];
  /** Directories of declared file ingests. The run's warehouse sandbox no longer needs them (files are read from
   *  snapshots in the state folder); kept for tools that want to know where an ingest reads. */
  fileDirs: string[];
}

export interface PlanInput {
  root: string;
  timezone: string;
  selectors: readonly string[];
  /** Cursor types saved by earlier loads (the catalog mirror), for CURSOR_TYPE_MISMATCH at load time. */
  cursorTypes?: Record<string, CursorType>;
  importTimeoutMs?: number;
}

/** TS assets get 2 retries after a retryable error (§8 "Retries"). */
export const DEFAULT_RETRIES = 2;
/** No row yielded and no request completed for this long fails the step with TIMEOUT (§8 "Timeout"). */
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;

const TRANSFORM_NOTE = "transforms are built from croft's next phase; this version runs ingests only";

// ---------------------------------------------------------------------------------------------------------
// Selection and behavior live in project/resolve.ts (resolving an asset decides them); re-exported here.

export { behaviorHash, behaviorLabel, behaviorWords, isGlob, problemsNamed, resolveWrite, selectAssets } from "../project/resolve.ts";

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

function baseStep(a: DiscoveredAsset): Omit<PlannedStep, "kind" | "action" | "reasons" | "reason"> {
  return {
    asset: a.name, file: a.file, path: a.path, problems: [], write: "replace", key: [], incremental: { kind: "none" },
    behavior: "replace", words: "", behaviorHash: behaviorHash("replace", [], { kind: "none" }), retries: DEFAULT_RETRIES,
    timeoutMs: DEFAULT_TIMEOUT_MS, inputs: [], orderAfter: [], readBy: [], checks: [],
  };
}

/** Discover, select and load assets, and decide what each selected asset does in this run. */
export async function planRun(i: PlanInput): Promise<RunPlan> {
  const discovery = await discoverAssets(i.root);
  const names = discovery.assets.map((a) => a.name);
  const selected = selectAssets(names, i.selectors, discovery.problems);
  // Asset output that escapes its import (a timer started at top level) reaches stderr redacted (core/output.ts).
  defaultOutputRedactor(() => (t) => ProjectEnv.load(i.root, {}).redact(t));
  const steps: PlannedStep[] = [];
  const fileDirs = new Set<string>();
  for (const name of selected) {
    const a = discovery.assets.find((x) => x.name === name)!;
    if (a.kind === "sql") {
      steps.push({ ...baseStep(a), kind: "sql", action: "skip", reasons: ["requested"], reason: TRANSFORM_NOTE });
      continue;
    }
    const cursorType = i.cursorTypes?.[name];
    // Top-level console output of the asset is kept for its step log, never printed (core/output.ts).
    const sink = collectingSink();
    const loaded = await captureImport(sink, () => loadTsAsset(a, { root: i.root, timezone: i.timezone }, {
      ...(cursorType ? { cursorType } : {}),
      ...(i.importTimeoutMs !== undefined ? { importTimeoutMs: i.importTimeoutMs } : {}),
    }));
    const output = sink.lines.length ? { output: sink.lines } : {};
    const spec = loaded.spec;
    if (!loaded.ok || !spec) {
      // A broken asset fails its own step; the rest of the run goes ahead.
      steps.push({
        ...baseStep(a), kind: "rows", action: "fetch", reasons: ["requested"], reason: "requested",
        problems: loaded.problems, loaded, ...(loaded.codeHash ? { codeHash: loaded.codeHash } : {}), ...output,
      });
      continue;
    }
    const write = resolveWrite(spec);
    const common = {
      ...baseStep(a), loaded, spec, write, key: spec.key, incremental: spec.incremental,
      behavior: behaviorLabel(write, spec.key), words: behaviorWords(write, spec.key, spec.incremental),
      behaviorHash: behaviorHash(write, spec.key, spec.incremental),
      retries: spec.retries ?? DEFAULT_RETRIES, timeoutMs: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      problems: loaded.problems, ...(loaded.codeHash ? { codeHash: loaded.codeHash } : {}), ...output,
    };
    if (spec.role === "transform") {
      steps.push({ ...common, kind: "transform", action: "skip", reasons: ["requested"], reason: TRANSFORM_NOTE });
      continue;
    }
    if (spec.source === "file") {
      for (const d of fileDirsOf(i.root, loaded.definition!.config as FileIngest)) fileDirs.add(d);
    }
    steps.push({ ...common, kind: spec.source === "file" ? "file" : "rows", action: "fetch", reasons: ["requested"], reason: "requested" });
  }
  return {
    steps,
    order: steps.map((s) => s.asset),
    // Every discovery problem for a bare run; for selectors, those about files a glob also matched.
    problems: i.selectors.length === 0
      ? discovery.problems
      : discovery.problems.filter((p) => i.selectors.some((sel) => problemsNamed(sel, [p]).length > 0)),
    fileDirs: [...fileDirs].filter((d) => d !== join(i.root, "files")),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Backfills (§8): which assets `--from` applies to

/**
 * BACKFILL_UNSUPPORTED for everything but cursor ingests; append ingests are checked against the saved
 * cursor by the ingest step (BACKFILL_WOULD_DUPLICATE). null when `--from` applies.
 */
export function backfillUnsupported(step: PlannedStep): CroftError | null {
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
export function loadErrors(step: PlannedStep): Problem[] {
  return step.problems.filter((p) => p.severity === "error");
}
