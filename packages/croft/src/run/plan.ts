// Planning a run (DESIGN.md §4.1 `run`, §5 "One ingest step" step 1, §8 "Backfills").
//
// discover assets/ → select by name or glob → load the selected TS assets in isolation → one PlannedStep per
// selected asset, with its write behavior inferred from key and incremental (§1) and stated in plain words.
//
// Phase 1 builds ingests only. SQL and TS transforms are planned as `skip` steps with a note saying so, so a
// bare `croft run` still lists them. Staleness, downstream and --dry-run arrive with transforms (phase 2).
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CroftError, isCode } from "../core/errors.ts";
import type { CursorType, Incremental, Problem, Reason, WriteMode } from "../core/types.ts";
import type { FileIngest } from "../types.ts";
import { type DiscoveredAsset, discoverAssets } from "../project/discover.ts";
import { didYouMean } from "../project/suggest.ts";
import { type LoadedTsAsset, loadTsAsset, type TsAssetSpec } from "../project/ts-asset.ts";

export type StepKind = "rows" | "file" | "transform" | "sql";

export interface PlannedStep {
  asset: string;
  file: string;                 // root-relative, "assets/github_issues.ts"
  path: string;                 // absolute
  kind: StepKind;
  action: "fetch" | "skip";
  reasons: Reason[];
  /** Why the step runs, or why it is skipped, in words. */
  reason: string;
  /** Load problems. Any error makes the step fail without running (the other steps still run). */
  problems: Problem[];
  loaded?: LoadedTsAsset;
  spec?: TsAssetSpec;
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
}

export interface RunPlan {
  steps: PlannedStep[];
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
// Selection

const GLOB_CHARS = /[*?[\]{}]/;

export function isGlob(selector: string): boolean {
  return GLOB_CHARS.test(selector);
}

/** Discovery problems (NAME_RESERVED, NAME_INVALID, NAME_CONFLICT) about files a selector names, by exact name
 *  or glob: each carries the file's base name in details.name. */
export function problemsNamed(selector: string, problems: readonly Problem[]): Problem[] {
  const glob = isGlob(selector) ? new Bun.Glob(selector) : null;
  return problems.filter((p) => {
    const name = p.details?.name;
    return typeof name === "string" && (glob ? glob.match(name) : name === selector);
  });
}

/** A discovery problem as the error a selector that names that file fails with. */
function discoveryError(p: Problem): CroftError {
  const { severity: _s, docs: _d, code, ...init } = p;
  return new CroftError(isCode(code) ? code : "USAGE_ERROR", init);
}

/**
 * The asset names a list of selectors picks, in name order: exact names or globs ('github_*'). An empty list
 * selects every asset. An unknown name or a glob that matches nothing is USAGE_ERROR, with a did-you-mean,
 * unless it names a file discovery refused (`order.ts`: NAME_RESERVED): then that file's own problem.
 */
export function selectAssets(names: readonly string[], selectors: readonly string[], problems: readonly Problem[] = []): string[] {
  if (selectors.length === 0) return [...names].sort();
  const picked = new Set<string>();
  for (const sel of selectors) {
    const broken = problemsNamed(sel, problems);
    if (isGlob(sel)) {
      const glob = new Bun.Glob(sel);
      const hits = names.filter((n) => glob.match(n));
      if (hits.length === 0) {
        if (broken[0]) throw discoveryError(broken[0]);
        throw new CroftError("USAGE_ERROR", {
          message: `no asset matches ${JSON.stringify(sel)}`,
          hint: names.length ? `assets are named after their files in assets/: ${names.slice(0, 20).join(", ")}` : "assets/ has no assets yet; croft new --list shows templates",
          details: { selector: sel },
        });
      }
      for (const h of hits) picked.add(h);
      continue;
    }
    if (!names.includes(sel)) {
      if (broken[0]) throw discoveryError(broken[0]);
      const guess = didYouMean(sel, names);
      throw new CroftError("USAGE_ERROR", {
        message: `there is no asset named ${JSON.stringify(sel)}`,
        hint: guess ? `did you mean ${guess}?` : names.length ? `assets are named after their files in assets/: ${names.slice(0, 20).join(", ")}` : "assets/ has no assets yet; croft new --list shows templates",
        ...(guess ? { fix: { kind: "command" as const, description: `run ${guess}`, command: `croft run ${guess}` } } : {}),
        details: { selector: sel, ...(guess ? { suggestion: guess } : {}) },
      });
    }
    picked.add(sel);
  }
  return [...picked].sort();
}

// ---------------------------------------------------------------------------------------------------------
// Behavior

/** Write behavior from key and incremental (§1), unless `write` overrides it. */
export function resolveWrite(spec: Pick<TsAssetSpec, "write" | "key" | "incremental">): WriteMode {
  if (spec.write) return spec.write;
  const incremental = spec.incremental.kind !== "none";
  if (!incremental) return "replace";
  return spec.key.length > 0 ? "merge" : "append";
}

export function behaviorLabel(write: WriteMode, key: readonly string[]): string {
  const by = key.length ? ` by ${key.join(", ")}` : "";
  if (write === "merge") return `merge${by}`;
  if (write === "append") return "append";
  return key.length ? `replace; key ${key.join(", ")}` : "replace";
}

function lookbackWords(ms: number): string {
  const units: [number, string][] = [[86_400_000, "day"], [3_600_000, "hour"], [60_000, "minute"], [1000, "second"]];
  for (const [size, name] of units) {
    if (ms >= size && ms % size === 0) {
      const n = ms / size;
      return `${n} ${name}${n === 1 ? "" : "s"}`;
    }
  }
  return `${ms} ms`;
}

/** The behavior in plain words (§1 "Write behavior is inferred"). */
export function behaviorWords(write: WriteMode, key: readonly string[], incremental: Incremental): string {
  const keyText = key.join(", ");
  let what: string;
  if (incremental.kind === "cursor") {
    const unit = incremental.unit ? ` (${incremental.field} is epoch ${incremental.unit === "s" ? "seconds" : "milliseconds"})` : "";
    const lb = incremental.lookbackMs > 0 ? `, re-reading the last ${lookbackWords(incremental.lookbackMs)}` : "";
    what = `fetches ${incremental.field} newer than the saved position${lb}${unit}`;
  } else if (incremental.kind === "files") {
    what = "loads new and changed files only; rows of deleted files are kept";
  } else what = "";
  if (write === "merge") return `updates rows by ${keyText}${what ? `; ${what}` : ""}`;
  if (write === "append") return `adds the new rows${what ? `; ${what}` : ""}`;
  const base = key.length ? `replaces the table's contents (key ${keyText}, which must be unique)` : "replaces the table's contents";
  return `${base}; unchanged rows keep their _loaded_at${what ? `; ${what}` : ""}`;
}

export function behaviorHash(write: WriteMode, key: readonly string[], incremental: Incremental): string {
  const inc = incremental.kind === "cursor" ? { kind: "cursor", field: incremental.field } : { kind: incremental.kind };
  return createHash("sha256").update(JSON.stringify({ write, key, incremental: inc })).digest("hex").slice(0, 16);
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
    const firstGlob = parts.findIndex((p) => GLOB_CHARS.test(p));
    const fixed = firstGlob < 0 ? dirname(f) : parts.slice(0, firstGlob).join("/") || ".";
    out.push(isAbsolute(fixed) ? fixed : resolve(root, fixed));
  }
  return out;
}

function baseStep(a: DiscoveredAsset): Omit<PlannedStep, "kind" | "action" | "reasons" | "reason"> {
  return {
    asset: a.name, file: a.file, path: a.path, problems: [], write: "replace", key: [], incremental: { kind: "none" },
    behavior: "replace", words: "", behaviorHash: behaviorHash("replace", [], { kind: "none" }), retries: DEFAULT_RETRIES,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

/** Discover, select and load assets, and decide what each selected asset does in this run. */
export async function planRun(i: PlanInput): Promise<RunPlan> {
  const discovery = await discoverAssets(i.root);
  const names = discovery.assets.map((a) => a.name);
  const selected = selectAssets(names, i.selectors, discovery.problems);
  const steps: PlannedStep[] = [];
  const fileDirs = new Set<string>();
  for (const name of selected) {
    const a = discovery.assets.find((x) => x.name === name)!;
    if (a.kind === "sql") {
      steps.push({ ...baseStep(a), kind: "sql", action: "skip", reasons: ["requested"], reason: TRANSFORM_NOTE });
      continue;
    }
    const cursorType = i.cursorTypes?.[name];
    const loaded = await loadTsAsset(a, { root: i.root, timezone: i.timezone }, {
      ...(cursorType ? { cursorType } : {}),
      ...(i.importTimeoutMs !== undefined ? { importTimeoutMs: i.importTimeoutMs } : {}),
    });
    const spec = loaded.spec;
    if (!loaded.ok || !spec) {
      // A broken asset fails its own step; the rest of the run goes ahead.
      steps.push({
        ...baseStep(a), kind: "rows", action: "fetch", reasons: ["requested"], reason: "requested",
        problems: loaded.problems, loaded, ...(loaded.codeHash ? { codeHash: loaded.codeHash } : {}),
      });
      continue;
    }
    const write = resolveWrite(spec);
    const common = {
      ...baseStep(a), loaded, spec, write, key: spec.key, incremental: spec.incremental,
      behavior: behaviorLabel(write, spec.key), words: behaviorWords(write, spec.key, spec.incremental),
      behaviorHash: behaviorHash(write, spec.key, spec.incremental),
      retries: spec.retries ?? DEFAULT_RETRIES, timeoutMs: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      problems: loaded.problems, ...(loaded.codeHash ? { codeHash: loaded.codeHash } : {}),
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
      hint: `transforms rebuild from their inputs: croft run ${step.asset} --rebuild`,
      fix: { kind: "command", description: "rebuild the transform", command: `croft run ${step.asset} --rebuild` },
    });
  }
  if (step.kind === "file") {
    return new CroftError("BACKFILL_UNSUPPORTED", {
      ...at, message: `${step.asset} is a file ingest; --from applies to merge ingests`,
      hint: `changed files reload automatically; croft run ${step.asset} --rebuild reloads all files`,
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
