// Resolving a project (DESIGN.md §3 "Layout and naming", §3c "Dependencies", §3f, §10 ResolvedAsset): every
// asset discovered, loaded and checked statically, and the graph over them. No warehouse is opened: SQL is
// parsed on a private in-memory DuckDB, and TS assets are imported in isolation (project/ts-asset.ts). The
// planner, validate, status, describe and context all start from here.
//
// resolveProject, in order:
// 1. discover assets/ (project/discover.ts) and pick the selection (selectAssets: names or globs; an unknown
//    name is USAGE_ERROR with a did-you-mean, a file discovery refused is that file's own problem);
// 2. load each asset: an SQL file through loadSqlAsset (header, one-SELECT gate, AST inputs, fingerprint), a TS
//    file through loadTsAsset (import scan, bundle, isolated import, config validation);
// 3. parse its checks and warnings (checks/parse.ts parseChecks) and vet them with DuckDB's parser
//    (analyzeChecks), which also gives the tables a check reads;
// 4. orderAfter = inputs ∪ the tables its checks read, and buildGraph (project/graph.ts): the run order, reads,
//    readBy, downstream, upstream and CYCLE.
//
// With selectors, a TS file whose text calls ingest() only (sniffKind) is imported when it is selected or
// upstream of the selection, and left unimported otherwise (`loaded: false`): an ingest reads no asset, so the
// graph does not need its code, and `croft run x` never runs the top-level code of unrelated ingests. Every
// SQL asset and every TS file that may be a transform is always loaded, since the graph needs their inputs.
//
// Also here, because resolving an asset decides them: selection (selectAssets) and write behavior (resolveWrite,
// behaviorLabel, behaviorWords, behaviorHash). run/plan.ts re-exports them.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { DuckDBConnection } from "@duckdb/node-api";
import { analyzeChecks, parseChecks } from "../checks/parse.ts";
import { CroftError, isCode } from "../core/errors.ts";
import { captureImport, collectingSink, defaultOutputRedactor } from "../core/output.ts";
import type { AssetKind, Check, CursorType, Incremental, Problem, WriteMode } from "../core/types.ts";
import { openMemory } from "../db/connect.ts";
import type { StepKind } from "../run/plan.ts";
import { type DiscoveredAsset, discoverAssets } from "./discover.ts";
import { ProjectEnv } from "./env.ts";
import { buildGraph, type Graph } from "./graph.ts";
import { type LoadedSqlAsset, loadSqlAsset } from "./sql-asset.ts";
import { didYouMean } from "./suggest.ts";
import { type LoadedTsAsset, loadTsAsset, type TsAssetSpec } from "./ts-asset.ts";

export interface ResolveInput {
  root: string;
  /** The project time zone: part of every code hash. */
  timezone: string;
  /** Asset names or globs ('github_*'); omitted or empty selects every asset. */
  selectors?: readonly string[];
  /** A TS asset whose top-level code has not finished after this long is ASSET_INVALID (default 30 s). */
  importTimeoutMs?: number;
  /** Cursor types saved by earlier loads (the catalog mirror), for CURSOR_TYPE_MISMATCH at load time. */
  cursorTypes?: Readonly<Record<string, CursorType>>;
  /** Keep each TS asset's top-level console output in ResolvedAsset.output (a run's step log) instead of
   *  printing it on stderr, prefixed with the file and redacted (every other command). */
  keepOutput?: boolean;
}

export interface ResolvedProject {
  /** Every discovered asset, in name order, selected or not. */
  assets: ResolvedAsset[];
  /** The names the selectors pick, in name order: every asset without selectors. */
  selected: string[];
  /** Over every asset: order, reads, readBy, downstream, upstream, cycles. SQL inputs are the AST's; the
   *  unoptimized plan's scans come from the bind check (sql/bind.ts BindResult.planInputs), which needs the
   *  inputs' columns, so a caller that binds adds them and builds the graph again. */
  graph: Graph;
  /** Project-level problems: discovery's (NAME_INVALID, NAME_RESERVED, NAME_CONFLICT; all of them without
   *  selectors, else those about files a selector names), then one CYCLE per cycle. Each asset's own problems
   *  are on the asset. */
  problems: Problem[];
}

/** One asset as resolveProject() gives it (DESIGN.md §10 ResolvedAsset): discovered, loaded and checked statically
 *  (no warehouse). The planner, validate, status, describe and context start from it. A broken asset keeps the
 *  defaults (write "replace", no key, no inputs, no checks) and says why in `problems`. It lives here, not in
 *  core/types.ts, because it carries the loaded modules (LoadedTsAsset, LoadedSqlAsset). */
export interface ResolvedAsset {
  name: string;
  file: string;                                              // root-relative, "assets/open_issues.sql"
  path: string;                                              // absolute
  /** null: a TS file that did not load and whose text names neither ingest( nor transform( (sniffKind). */
  kind: AssetKind | null;
  /** false only for a TS ingest resolveProject did not import: selectors were given, it is neither selected
   *  nor upstream of the selection, and its text calls ingest() only. Nothing about it was checked. */
  loaded: boolean;
  /** Loaded, with no error-severity problem (its own or its checks'). */
  ok: boolean;
  /** The assets it reads: an SQL asset's AST relations (LoadedSqlAsset.astInputs; the bind check adds the
   *  unoptimized plan's scans), a TS transform's declared `inputs`, [] for an ingest. Names that are not assets
   *  stay (the bind check reports UNKNOWN_TABLE); the graph ignores them. */
  inputs: string[];
  /** inputs + the tables its checks read in subqueries (they only order the steps, §3f). */
  orderAfter: string[];
  write: WriteMode; key: string[]; incremental: Incremental;
  /** Short label: "merge by id", "replace; key id", "append". */
  behavior: string;
  /** The behavior in plain words (describe, the catalog mirror). */
  words: string;
  /** Hash of write mode, key and cursor field: INGEST_CONFIG_CHANGED. */
  behaviorHash: string;
  schedule?: { text: string; cron: string };                 // ingests only; set from phase 3 (the phrase parser)
  /** Its checks and warnings, parsed and vetted (checks/parse.ts), a key's implied unique and not_null first.
   *  An invalid one is left out and reported as CHECK_INVALID. */
  checks: Check[];
  pins: Record<string, { type: string; format?: string }>;
  /** Includes the project time zone. Absent when the code does not parse or bundle. */
  codeHash?: string;
  description?: string;
  /** TS: calls ctx.http, fetch or an HTTP package (TRANSFORM_MAKES_REQUESTS, the cost guard). */
  usesHttp?: boolean;
  /** Incremental TS transforms: LARGE_REPROCESS above this many pending input rows (the planner's default: 1000). */
  confirmAbove?: number;
  /** TS assets: the loaded module (definition and spec when it loaded without errors). */
  ts?: LoadedTsAsset;
  /** SQL assets: the loaded file (header, body, AST inputs, fingerprint). */
  sql?: LoadedSqlAsset;
  /** Load and check problems about this asset (discovery and CYCLE problems are the project's). */
  problems: Problem[];
  /** What its top-level code printed while it was imported (resolveProject keepOutput; unredacted). */
  output?: string[];
}

/**
 * Discover, select, load and check every asset of a project, and build the graph. Throws USAGE_ERROR (or the
 * named file's discovery problem) for a selector that names nothing; never throws for a problem with an asset,
 * which lands in that asset's `problems`.
 */
export async function resolveProject(i: ResolveInput): Promise<ResolvedProject> {
  const discovery = await discoverAssets(i.root);
  const names = discovery.assets.map((a) => a.name);
  const selectors = i.selectors ?? [];
  const selected = selectAssets(names, selectors, discovery.problems);
  // Asset output that escapes its import (a timer started at top level) reaches stderr redacted (core/output.ts).
  if (i.keepOutput) defaultOutputRedactor(() => (t) => ProjectEnv.load(i.root, {}).redact(t));

  let memory: Awaited<ReturnType<typeof openMemory>> | undefined;
  let conn: DuckDBConnection | undefined;
  const connection = async (): Promise<DuckDBConnection> => {
    memory ??= await openMemory({ timezone: i.timezone });
    conn ??= await memory.connect();
    return conn;
  };
  try {
    const byName = new Map<string, ResolvedAsset>();
    const load = async (a: DiscoveredAsset) => void byName.set(a.name, await resolveAsset(a, i, names, connection));
    const everything = selectors.length === 0;
    const chosen = new Set(selected);
    for (const a of discovery.assets) {
      if (everything || chosen.has(a.name) || sniffKind(a) !== "ingest") await load(a);
      else byName.set(a.name, notLoaded(a));
    }
    // What the selection reads, through other assets, is loaded too (--upstream runs it). A file sniffed as an
    // ingest that turns out to read assets brings its own inputs in on the next round.
    while (!everything) {
      const graph = buildGraph(nodesOf(discovery.assets.map((a) => byName.get(a.name)!))).graph;
      const missing = graph.upstream(selected).filter((n) => byName.get(n)?.loaded === false);
      if (missing.length === 0) break;
      for (const n of missing) await load(discovery.assets.find((a) => a.name === n)!);
    }
    const assets = discovery.assets.map((a) => byName.get(a.name)!);
    const { graph, problems: cycles } = buildGraph(nodesOf(assets));
    return {
      assets,
      selected,
      graph,
      problems: [
        ...(everything ? discovery.problems : discovery.problems.filter((p) => selectors.some((sel) => problemsNamed(sel, [p]).length > 0))),
        ...cycles,
      ],
    };
  } finally {
    memory?.close();
  }
}

function nodesOf(assets: readonly ResolvedAsset[]) {
  return assets.map((a) => ({ name: a.name, inputs: a.inputs, orderAfter: a.orderAfter, file: a.file }));
}

/** The planner's step kind for an asset: sql, transform (a TS transform), file or rows (an ingest). A TS
 *  file that did not load is a transform when its text says so (sniffKind), else rows. */
export function stepKindOf(a: Pick<ResolvedAsset, "kind" | "ts">): StepKind {
  if (a.kind === "sql") return "sql";
  if (a.kind === "ts") return "transform";
  return a.ts?.spec?.source === "file" ? "file" : "rows";
}

/** An asset's kind from its file alone, without importing its code: a .sql file is an SQL transform; a .ts
 *  file that calls transform( is a TS transform, one that calls ingest( an ingest. null when the text says
 *  neither or both, or cannot be read. */
export function sniffKind(a: Pick<DiscoveredAsset, "kind" | "path">): AssetKind | null {
  if (a.kind === "sql") return "sql";
  let text: string;
  try {
    text = readFileSync(a.path, "utf8");
  } catch {
    return null;
  }
  const t = /\btransform\s*\(/.test(text);
  const i = /\bingest\s*\(/.test(text);
  if (t && !i) return "ts";
  if (i && !t) return "ingest";
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// One asset

const NONE: Incremental = { kind: "none" };

/** The fields every ResolvedAsset has, at their defaults (a broken or unloaded asset keeps them). */
function base(a: DiscoveredAsset, kind: AssetKind | null): ResolvedAsset {
  return {
    name: a.name, file: a.file, path: a.path, kind, loaded: true, ok: false, inputs: [], orderAfter: [],
    write: "replace", key: [], incremental: NONE, behavior: "", words: "", behaviorHash: behaviorHash("replace", [], NONE),
    checks: [], pins: {}, problems: [],
  };
}

function notLoaded(a: DiscoveredAsset): ResolvedAsset {
  return { ...base(a, "ingest"), loaded: false };
}

async function resolveAsset(a: DiscoveredAsset, i: ResolveInput, names: readonly string[], connection: () => Promise<DuckDBConnection>): Promise<ResolvedAsset> {
  if (a.kind === "sql") {
    const sql = await loadSqlAsset(a, { root: i.root, timezone: i.timezone, conn: await connection(), assetNames: names });
    const key = sql.header.key;
    const out: ResolvedAsset = {
      ...base(a, "sql"), sql, inputs: [...sql.astInputs], key,
      behavior: behaviorLabel("replace", key), words: behaviorWords("replace", key, NONE), behaviorHash: behaviorHash("replace", key, NONE),
      ...(sql.codeHash ? { codeHash: sql.codeHash } : {}),
      ...(sql.header.description ? { description: sql.header.description } : {}),
      problems: [...sql.problems],
    };
    return withChecks(out, sql.header, connection);
  }

  const cursorType = i.cursorTypes?.[a.name];
  const options = {
    ...(cursorType ? { cursorType } : {}),
    ...(i.importTimeoutMs !== undefined ? { importTimeoutMs: i.importTimeoutMs } : {}),
  };
  const project = { root: i.root, timezone: i.timezone };
  let output: string[] | undefined;
  let ts: LoadedTsAsset;
  if (i.keepOutput) {
    // Top-level console output is kept for the step log, never printed (core/output.ts).
    const sink = collectingSink();
    ts = await captureImport(sink, () => loadTsAsset(a, project, options));
    if (sink.lines.length) output = sink.lines;
  } else {
    ts = await loadTsAsset(a, project, options);
  }
  const spec = ts.spec;
  const common = {
    ts, usesHttp: ts.usesHttp, problems: [...ts.problems],
    ...(ts.codeHash ? { codeHash: ts.codeHash } : {}), ...(output ? { output } : {}),
  };
  if (!ts.ok || !spec) return { ...base(a, sniffKind(a)), ...common };
  const write = resolveWrite(spec);
  const description = ts.definition?.config.description;
  const out: ResolvedAsset = {
    ...base(a, spec.role === "transform" ? "ts" : "ingest"), ...common,
    inputs: spec.role === "transform" ? [...spec.inputs] : [], write, key: spec.key, incremental: spec.incremental,
    behavior: behaviorLabel(write, spec.key), words: behaviorWords(write, spec.key, spec.incremental),
    behaviorHash: behaviorHash(write, spec.key, spec.incremental), pins: spec.pins,
    ...(typeof description === "string" && description ? { description } : {}),
    ...(spec.confirmAbove !== undefined ? { confirmAbove: spec.confirmAbove } : {}),
  };
  return withChecks(out, { key: spec.key, checks: spec.checks, warnings: spec.warnings }, connection);
}

/** Parse and vet the asset's checks and warnings; orderAfter becomes its inputs plus the tables they read. */
async function withChecks(out: ResolvedAsset, c: { key: readonly string[]; checks: readonly string[]; warnings: readonly string[] },
  connection: () => Promise<DuckDBConnection>): Promise<ResolvedAsset> {
  const parsed = parseChecks({ asset: out.name, file: out.file, key: c.key, checks: c.checks, warnings: c.warnings });
  const vetted = parsed.checks.length
    ? await analyzeChecks(await connection(), out.name, parsed.checks, { file: out.file })
    : { checks: [] as Check[], problems: [] as Problem[] };
  out.checks = vetted.checks;
  out.problems.push(...parsed.problems, ...vetted.problems);
  out.orderAfter = [...new Set([...out.inputs, ...vetted.checks.flatMap((x) => x.reads)])];
  out.ok = !out.problems.some((p) => p.severity === "error");
  return out;
}

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
          hint: names.length ? `assets are named after their files in assets/: ${names.slice(0, 20).join(", ")}` : "assets/ has no assets yet; croft docs ingest shows templates",
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
        hint: guess ? `did you mean ${guess}?` : names.length ? `assets are named after their files in assets/: ${names.slice(0, 20).join(", ")}` : "assets/ has no assets yet; croft docs ingest shows templates",
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
