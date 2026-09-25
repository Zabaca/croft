// croft validate [asset…] [--types] (DESIGN.md §4.1, §4.2, §4.3 "validate", §6 "Ways to try a change" 1). It
// touches no data: it never opens the warehouse, so it never waits on it.
//
// 1. Static checks: project/resolve.ts resolveProject (headers, the one-SELECT gate, VOLATILE_SQL, config
//    shapes, ASSET_OPENS_DATABASE, TRANSFORM_MAKES_REQUESTS, SCHEDULE_INVALID, checks, CYCLE), plus what only
//    the whole project shows: a TS transform's input that is no asset (UNKNOWN_TABLE), an incremental
//    transform's newRows() input without a key (INPUT_NEEDS_KEY) and declared secrets that are not set
//    (SECRET_MISSING, a warning: nothing fails until the asset runs, as in doctor). An asset never built whose code
//    built an orphan table (a file renamed outside croft), or a croft rename that stopped, is ASSET_RENAMED, with
//    `croft rename <old> <new>` as the fix (project/rename.ts findRenamed; the catalog mirror and code hashes). An
//    ingest whose code now says another key, write mode or cursor field than its stored rows were written with is
//    INGEST_CONFIG_CHANGED with the run's fixes (run/plan.ts pendingBehavior, from the mirror): an error when the run
//    would fail before it fetches, a warning when it would ask to convert in place. Any error exits 2.
// 2. The bind check (sql/bind.ts ShadowCatalog), over empty tables in an in-memory DuckDB:
//    - every table the catalog mirror (runs.sqlite) knows is defined from its cached columns, _loaded_at and
//      _file included, and its pending columns (all NULL so far) are passed for NULL_ONLY_COLUMN; a table never
//      built but previewed, from the columns the preview gave it (.croft/preview/runs.sqlite: §6 "the column
//      cache is filled by runs, by previews and by `columns` pins");
//    - SQL assets are bound in graph order, and each one's output columns replace its table, so the next asset
//      binds against the code as it is now;
//    - an asset whose input has no columns yet (never built, or an SQL input whose columns are unknown in turn)
//      skips the bind with INPUT_NOT_BUILT (info), naming the assets to preview; only its readers skip;
//    - an asset whose only load error is SQL_SYNTAX is bound too: when quoting a keyword fixes the parse, the
//      bind's QUOTE_IDENTIFIER replaces the loader's SQL_SYNTAX;
//    - an SQL asset's checks are bound against its output columns, so a check naming a missing column is an
//      UNKNOWN_COLUMN on the check's header line;
//    - the unoptimized plan's scans join the AST inputs, and the graph (order, CYCLE) is built again with them.
// 3. --types: first .croft/types, the input row types of TS transforms (project/types-gen.ts), from the column
//    cache with each bound SQL asset's output columns as its code is now; then the project's own
//    node_modules/.bin/tsc --noEmit. A TS transform that reads a column its input does not have (renamed or
//    removed upstream, even in SQL not yet run) is a missing property of a generated row type, reported as
//    UNKNOWN_INPUT_COLUMN with the runtime's did-you-mean and edit fix; every other type error is ASSET_INVALID.
//    No tsc (or no tsconfig.json) is an info problem and a skip; croft never installs anything. A tsconfig.json
//    whose "include" leaves out .croft/types is an info problem with the edit.
// 4. --hook: what Claude Code's PostToolUse hook runs after an edit (agent/hook.ts, §9 item 7): the edited asset
//    and what it can break. Errors go to stderr with exit 2; warnings only, to Claude as additionalContext (JSON
//    on stdout, exit 0); croft's own failures exit 1, which never blocks Claude (validateHook, hookHuman).
//
// Data: ValidateData (core/types.ts). Every finding is a problem of the envelope, grouped by asset in run order.
// Human output is the §4.2 layout: "checked N assets in 0.6 s", each problem, then the counts.
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { hookContext, hookOutput, hookPaths, hookProblems, hookReport, hookSelection, hookTarget, parseHookInput, readHookStdin, showPaths } from "../../agent/hook.ts";
import { probeSql } from "../../checks/parse.ts";
import { type Code, CroftError, CODES, EXIT, isCode, problem } from "../../core/errors.ts";
import { formatInstant } from "../../core/time.ts";
import type { Check, Fix, Problem, ValidateAsset, ValidateData } from "../../core/types.ts";
import { allCatalog, type CatalogAsset } from "../../history/catalog.ts";
import { RUNS_DB_FILE, RunsDb } from "../../history/runs-db.ts";
import { quoteIdent } from "../../load/evolve.ts";
import { missingSecret, type ProjectEnv } from "../../project/env.ts";
import { discoverAssets } from "../../project/discover.ts";
import { buildGraph, type Graph } from "../../project/graph.ts";
import { type ResolvedAsset, type ResolvedProject, resolveProject, selectorWords } from "../../project/resolve.ts";
import { findRoot, type Project } from "../../project/root.ts";
import type { LoadedSqlAsset } from "../../project/sql-asset.ts";
import { didYouMean } from "../../project/suggest.ts";
import { parseJsonc, toValue } from "../../project/init-tsconfig.ts";
import { type GeneratedType, generateInputTypes, TYPES_DIR, type TypeSource, type TypesResult } from "../../project/types-gen.ts";
import { pendingBehavior, resolvedSide } from "../../run/plan.ts";
import { previewDirectory } from "../../run/preview.ts";
import { nextFires } from "../../schedule/types.ts";
import { ShadowCatalog, type ShadowColumn } from "../../sql/bind.ts";
import type { CommandImpl, CommandResult, Ctx, Next } from "../command.ts";
import { formatDuration, formatProblems, problemSummary } from "../render.ts";

/** How long the project's tsc may take before --types gives up. */
const TSC_TIMEOUT_MS = 180_000;
/** Type errors shown as problems; the rest are counted in one more. */
const TSC_SHOWN = 50;
/** Assets named in one `croft preview` next step. */
const PREVIEW_NEXT = 10;
/** Fire times shown for each schedule (§8). */
const NEXT_FIRES = 3;

export interface ValidateInput {
  project: Pick<Project, "root" | "timezone" | "paths">;
  /** The project's secrets (.env and the shell): SECRET_MISSING. */
  env: ProjectEnv;
  /** Asset names or globs; none checks every asset. */
  selectors?: readonly string[];
  /** Also run the project's tsc --noEmit. */
  types?: boolean;
  /** A TS asset whose top-level code has not finished after this long is ASSET_INVALID (default 30 s). */
  importTimeoutMs?: number;
  /** The shell environment tsc runs with (PATH, HOME); nothing from .env. */
  processEnv?: Readonly<Record<string, string | undefined>>;
  /** The current time, for each schedule's next fire times (default: the clock). */
  now?: Date;
  /** The assets to check, picked once the project is resolved (--hook: an edit and the assets it can break,
   *  agent/hook.ts hookSelection). Default: what the selectors pick. */
  select?: (resolved: ResolvedProject) => readonly string[];
}

export interface ValidateReport {
  data: ValidateData;
  /** Project-level problems first (discovery, CYCLE), then each checked asset's in run order, then tsc's. */
  problems: Problem[];
}

/** croft validate. Its spec (usage, options) is in commands/index.ts. */
export const validate: CommandImpl<ValidateData> = {
  async run(ctx) {
    if (ctx.values.hook === true) return validateHook(ctx);
    const project = ctx.project;
    const report = await validateProject({
      project, env: ctx.env, selectors: ctx.positionals, types: ctx.values.types === true, processEnv: ctx.processEnv,
      now: ctx.now(),
    });
    // Every error validate finds is in the project as it is now (§4 "Exit codes": 2), a run's code among them: a
    // pending INGEST_CONFIG_CHANGED means the run would fail, not that it did.
    const invalid = report.problems.some((p) => p.severity === "error");
    return { data: report.data, problems: report.problems, next: nextSteps(report), exit: invalid ? EXIT.INVALID : EXIT.OK };
  },

  human(result, ctx) {
    if (ctx.values?.hook === true) return hookHuman(result, ctx);
    const d = result.data;
    const n = d.assets.length;
    const lines = [`checked ${n} asset${n === 1 ? "" : "s"} in ${formatDuration(performance.now() - ctx.startedAt)}`];
    if (d.types) {
      lines.push(d.types.status === "ok" ? "types ok (tsc --noEmit)"
        : d.types.status === "skipped" ? "types not checked"
          : `types: ${d.types.errors} error${d.types.errors === 1 ? "" : "s"} (tsc --noEmit)`);
    }
    for (const a of d.assets) {
      if (a.schedule) lines.push(`${a.name}: ${a.schedule.text} (cron ${a.schedule.cron}); next ${fireTimes(a.schedule.next)}`);
    }
    if (result.problems.length) lines.push(formatProblems(result.problems, ctx.render.color));
    lines.push(problemSummary(result.problems));
    return lines.join("\n");
  },
};

/** "2026-09-24 11:00, 12:00, 13:00": fire times in the project time zone, each date written once. */
function fireTimes(next: readonly string[]): string {
  let day = "";
  return next.map((t) => {
    const [date, time] = [t.slice(0, 10), t.slice(11, 16)];
    const s = date === day ? time : `${date} ${time}`;
    day = date;
    return s;
  }).join(", ");
}

/** What to do after validate: re-check after fixing an error or warning; with none, preview the assets whose
 *  code changed since their last build; in an empty project, a template. */
export function nextSteps(r: ValidateReport): Next[] {
  const fixable = r.problems.some((p) => p.severity === "error" || (p.severity === "warning" && !(p.fix && "requiresHuman" in p.fix && p.fix.requiresHuman)));
  // A check with --types is re-checked with it: only tsc confirms a type error's fix.
  if (fixable) return [{ command: r.data.types ? "croft validate --types" : "croft validate", reason: "re-check after the edit" }];
  if (r.data.order.length === 0) return [{ command: "croft new --list", reason: "assets/ has no assets yet; start from a template" }];
  const changed = r.data.assets.filter((a) => a.codeChanged).map((a) => a.name).slice(0, PREVIEW_NEXT);
  if (changed.length) return [{ command: `croft preview ${changed.join(" ")}`, reason: "see what the changed code builds before running it" }];
  return [];
}

/**
 * Validate a project (or the named assets) without touching the warehouse: static checks, the bind check, and
 * with `types` the project's tsc. Throws USAGE_ERROR for a selector that names no asset; every problem with an
 * asset is a problem of the report.
 */
export async function validateProject(i: ValidateInput): Promise<ValidateReport> {
  const { root, timezone } = i.project;
  const now = i.now ?? new Date();
  const catalog = readCatalog(i.project.paths.stateDir);
  const live = new Map(catalog.map((c) => [c.asset, c]));
  // The column cache holds previews too (§6): an input never built but previewed binds against the columns the
  // preview gave it (.croft/preview/runs.sqlite, source "preview"). A live entry always wins, and only the bind
  // reads previews: a preview is no build (codeChanged, cursor types).
  const columns = [...catalog, ...readCatalog(previewDirectory(i.project.paths.stateDir)).filter((c) => !live.has(c.asset))];
  const cursorTypes = Object.fromEntries(catalog.flatMap((c) => (c.cursor?.type ? [[c.asset, c.cursor.type]] : [])));
  const resolved = await resolveProject({
    root, timezone, cursorTypes, builtHashes: (name) => live.get(name)?.codeHash ?? null,
    // A mistyped name's fix is validate again: it touches no data, and neither does its fix.
    retry: (selectors) => ["croft validate", ...selectorWords(selectors), ...(i.types ? ["--types"] : [])].join(" "),
    ...(i.selectors?.length ? { selectors: i.selectors } : {}),
    ...(i.importTimeoutMs !== undefined ? { importTimeoutMs: i.importTimeoutMs } : {}),
  });
  const byName = new Map(resolved.assets.map((a) => [a.name, a]));
  const selected = new Set(i.select ? i.select(resolved) : resolved.selected);
  // What the bind needs: the selection and everything it reads (their output columns are its inputs).
  const scope = new Set([...selected, ...resolved.graph.upstream([...selected])]);
  // Declared secrets set in the shell are redacted from the output like .env values.
  i.env.declare(resolved.assets.flatMap((a) => a.ts?.spec?.secrets ?? []));

  const bound = await bindProject(resolved.assets, runOrder(resolved.graph, resolved.assets), scope, columns, timezone);

  // The graph again, with the plan's scans: they can add inputs (and so edges and cycles) the AST did not show.
  const inputsOf = (a: ResolvedAsset): string[] => {
    const plan = (bound.planInputs.get(a.name) ?? []).filter((x) => byName.has(x) && x !== a.name);
    return [...new Set([...a.inputs, ...plan])];
  };
  const { graph, problems: cycles } = buildGraph(resolved.assets.map((a) => ({
    name: a.name, inputs: inputsOf(a), orderAfter: [...new Set([...a.orderAfter, ...inputsOf(a)])], file: a.file,
  })));
  const order = runOrder(graph, resolved.assets);

  const renamed = await renamedAssets(i.project, catalog, byName);
  const problems: Problem[] = [
    ...resolved.problems.filter((p) => p.code !== "CYCLE"),
    ...cycles.filter((p) => selected.size === byName.size || cycleNames(p).some((n) => selected.has(n))),
    // A rename that stopped before its new file exists belongs to no asset: the whole project reports it.
    ...(selected.size === byName.size ? renamed.filter((p) => !byName.has(p.asset!)) : []),
  ];
  const assets: ValidateAsset[] = [];
  for (const name of order) {
    const a = byName.get(name);
    if (!a || !selected.has(name)) continue;
    const own = a.problems.filter((p) => !(bound.quoted.has(name) && p.code === "SQL_SYNTAX"));
    const built = live.get(name);
    problems.push(...[...own, ...renamed.filter((p) => p.asset === name), ...staticProblems(a, byName, root, i.env), ...(bound.problems.get(name) ?? []),
      ...behaviorProblems(a, built ?? null)]
      .map((p) => (p.asset ? p : { ...p, asset: name })));
    assets.push({
      name, kind: a.kind, inputs: inputsOf(a),
      outputColumns: a.kind === "sql" ? bound.outputs.get(name)?.map((c) => ({ name: c.name, type: c.type })) ?? null : null,
      behavior: a.behavior,
      // A time zone change alone is no code change (project/resolve.ts timeZoneChanged).
      codeChanged: !!(a.codeHash && built?.codeHash && a.codeHash !== built.codeHash && !a.timeZoneChanged),
      // §8: the cron form and the next fire times, in the project time zone.
      ...(a.schedule ? {
        schedule: { ...a.schedule, next: nextFires(a.schedule.cron, timezone, now, NEXT_FIRES).map((t) => formatInstant(t, timezone)) },
      } : {}),
    });
  }

  const data: ValidateData = { order: graph.order.slice(), assets };
  if (i.types) {
    // The input row types first, with each bound SQL asset's output as its code is now, so tsc checks the TS
    // transforms against the code that the next run will build.
    const generated = writeInputTypes(i.project, [...bound.outputs].flatMap(([name, columns]) => {
      const a = byName.get(name);
      return a ? [{ asset: name, from: "code" as const, file: a.file, key: a.key, columns }] : [];
    }));
    problems.push(...generated.problems);
    const t = await typecheck(root, i.processEnv ?? {}, generated.types ? { inputTypes: generated.types } : {});
    data.types = t.types;
    problems.push(...t.problems);
  }
  return { data, problems: dedupe(problems) };
}

/** runs.sqlite's catalog mirror; empty before the first run (a read-only command creates nothing), or when it
 *  cannot be read: the bind then treats every input as not built, and status and doctor report the file. */
function readCatalog(stateDir: string): CatalogAsset[] {
  if (!existsSync(join(stateDir, RUNS_DB_FILE))) return [];
  let db: RunsDb | undefined;
  try {
    db = RunsDb.open(stateDir);
    return allCatalog(db);
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/**
 * ASSET_RENAMED (§6 "Nothing implicit destroys ingested data"): an asset never built whose code hash is an orphan
 * table's (its file was renamed outside croft), or a croft rename that stopped (project/rename.ts findRenamed, from
 * the mirror and the hashes resolveProject already has). Each problem's asset is the new name; its fix adopts the
 * table (`croft rename <old> <new>`), where running the new asset would fetch everything again.
 */
async function renamedAssets(project: ValidateInput["project"], catalog: readonly CatalogAsset[], byName: ReadonlyMap<string, ResolvedAsset>): Promise<Problem[]> {
  const { findRenamed, renamedProblem } = await import("../../project/rename.ts");
  const codeHash = (n: string) => {
    const a = byName.get(n);
    return a && a.loaded ? a.codeHash ?? null : undefined;
  };
  try {
    return (await findRenamed(project.root, { project, catalog, codeHash })).map(renamedProblem);
  } catch {
    return [];   // a detection that cannot read the project reports nothing; the checks above still stand
  }
}

/**
 * INGEST_CONFIG_CHANGED (§6 "Behavior changes"), from the catalog mirror (run/plan.ts pendingBehavior): an ingest whose
 * code now says another key, write mode or cursor field than the one its stored rows were written with. An error when
 * the run would fail before it fetches; a warning when the run asks to convert in place (an append ingest gaining a
 * key). The fixes are the run's. Only an ingest whose definition loaded: a broken one keeps default settings.
 */
function behaviorProblems(a: ResolvedAsset, built: CatalogAsset | null): Problem[] {
  const side = resolvedSide(a);
  const pending = side ? pendingBehavior(side, built) : null;
  return pending ? [pending.problem] : [];
}

/** The graph's order, then the assets it leaves out (on or after a cycle) by name. */
function runOrder(graph: Graph, assets: readonly ResolvedAsset[]): string[] {
  const inOrder = new Set(graph.order);
  return [...graph.order, ...assets.map((a) => a.name).filter((n) => !inOrder.has(n)).sort()];
}

function cycleNames(p: Problem): string[] {
  const c = p.details?.cycle;
  return Array.isArray(c) ? c.map(String) : [];
}

function dedupe(problems: readonly Problem[]): Problem[] {
  const seen = new Set<string>();
  return problems.filter((p) => {
    const id = JSON.stringify([p.code, p.asset, p.file, p.line, p.column, p.message]);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------------------
// Static checks that need the whole project

function staticProblems(a: ResolvedAsset, byName: ReadonlyMap<string, ResolvedAsset>, root: string, env: ProjectEnv): Problem[] {
  const out: Problem[] = [];
  const spec = a.ts?.spec;
  if (spec?.role === "transform") {
    out.push(...unknownInputs(a, spec.inputs, byName));
    out.push(...inputsNeedingKeys(a, byName, root));
  }
  for (const s of env.listSecrets({ [a.name]: spec?.secrets ?? [] })) {
    if (s.status !== "missing") continue;
    // A warning, as in doctor: nothing fails until the asset runs (where it is an error), and only the user
    // can set it.
    out.push({ ...missingSecret(s.name, a.name).problem, severity: "warning", file: a.file });
  }
  return out;
}

/** UNKNOWN_TABLE for each declared input of a TS transform that is no asset, with a did-you-mean edit fix. */
function unknownInputs(a: ResolvedAsset, inputs: readonly string[], byName: ReadonlyMap<string, ResolvedAsset>): Problem[] {
  const names = [...byName.keys()].filter((n) => n !== a.name);
  const text = readText(a.path);
  return inputs.filter((x) => !byName.has(x)).map((x) => {
    const guess = didYouMean(x, names);
    const line = lineOfString(text, x);
    return problem("UNKNOWN_TABLE", {
      message: `${a.name} declares the input ${x}, but there is no asset named ${x}`,
      hint: guess ? `did you mean ${guess}?` : `inputs name assets (files in assets/): ${names.slice(0, 20).join(", ") || "there are none yet"}`,
      asset: a.name, file: a.file, ...(line ? { line } : {}),
      ...(guess ? { fix: { kind: "edit" as const, description: `fix the input name`, file: a.file, ...(line ? { line } : {}), replace: { from: x, to: guess } } } : {}),
      details: { table: x, ...(guess ? { suggestion: guess } : {}) },
    });
  });
}

/**
 * INPUT_NEEDS_KEY (§3e): an incremental transform remembers its place in each input it reads with newRows() by
 * (_loaded_at, key), so each such input needs a key. The inputs are found in the code: newRows("name") with a
 * literal name, in the asset and the project files it imports (comments ignored). A name computed at run time
 * is left to the run, which reports the same code.
 */
function inputsNeedingKeys(a: ResolvedAsset, byName: ReadonlyMap<string, ResolvedAsset>, root: string): Problem[] {
  if (a.incremental.kind !== "new-rows") return [];
  const out: Problem[] = [];
  const done = new Set<string>();
  for (const file of a.ts?.localFiles ?? [a.file]) {
    for (const call of newRowsCalls(readText(join(root, file)))) {
      const input = byName.get(call.input);
      if (done.has(call.input) || !a.inputs.includes(call.input) || !input) continue;
      // An input whose own definition did not load has no key we can trust; its errors are reported with it.
      const known = input.kind === "sql" ? !!input.sql : !!input.ts?.spec;
      if (!known || input.key.length > 0) continue;
      done.add(call.input);
      const how = input.kind === "sql" ? `-- key: <column> to the header of ${input.file}` : `key: "<column>" to the config in ${input.file}`;
      out.push(problem("INPUT_NEEDS_KEY", {
        message: `${a.name} reads ${input.name} with newRows(), and ${input.name} has no key; newRows() remembers its place by (_loaded_at, key)`,
        hint: `give ${input.name} a key (-- key: in its SQL header, or key: in its TS config), or read it with rows()`,
        asset: a.name, file, line: call.line,
        fix: { kind: "manual", description: `add ${how} (the column that identifies a row), or read ${input.name} with rows() in ${file}` },
        details: { input: input.name, inputFile: input.file },
      }));
    }
  }
  return out;
}

/** Literal newRows("x") calls in TS source: the name and its line. */
export function newRowsCalls(source: string): { input: string; line: number }[] {
  const code = blankComments(source);
  const out: { input: string; line: number }[] = [];
  const re = /(?<![\w$])newRows\s*(?:<[^<>()]*>)?\s*\(\s*(["'`])([A-Za-z_][A-Za-z0-9_]*)\1\s*[,)]/g;
  for (const m of code.matchAll(re)) {
    out.push({ input: m[2]!, line: code.slice(0, m.index).split("\n").length });
  }
  return out;
}

/** Comments replaced by spaces (newlines kept), string and template literals left as they are. */
function blankComments(code: string): string {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const c = code[i]!;
    const d = code[i + 1];
    if (c === "/" && d === "/") {
      while (i < code.length && code[i] !== "\n") { out += " "; i++; }
    } else if (c === "/" && d === "*") {
      const end = code.indexOf("*/", i + 2);
      const stop = end < 0 ? code.length : end + 2;
      out += code.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== c && (c === "`" || code[j] !== "\n")) j += code[j] === "\\" ? 2 : 1;
      out += code.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** The 1-based line where `"name"` (or 'name', `name`) first appears, if it does. */
function lineOfString(text: string, name: string): number | undefined {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => [`"${name}"`, `'${name}'`, `\`${name}\``].some((q) => l.includes(q)));
  return at < 0 ? undefined : at + 1;
}

// ---------------------------------------------------------------------------------------------------------
// The bind check

export interface BoundProject {
  /** SQL assets that bound: their output columns (reserved columns left out). */
  outputs: Map<string, ShadowColumn[]>;
  /** SQL assets that bound: the tables their unoptimized plan scans. */
  planInputs: Map<string, string[]>;
  /** Problems of the bind, per asset: the bind's own, INPUT_NOT_BUILT, and those of the asset's checks. */
  problems: Map<string, Problem[]>;
  /** SQL assets whose loader SQL_SYNTAX the bind's QUOTE_IDENTIFIER replaces. */
  quoted: Set<string>;
}

/** Why an SQL asset's output columns are unknown: inputs never built (the roots to preview), or SQL assets
 *  whose errors stop the bind. */
interface Unknown { roots: Set<string>; broken: Set<string> }

/**
 * Bind every SQL asset in `scope`, in `order`, against empty tables: the catalog's cached columns, then each
 * bound asset's output columns. Never the warehouse. Exported so the planner and preview can share it.
 */
export async function bindProject(assets: readonly ResolvedAsset[], order: readonly string[], scope: ReadonlySet<string>,
  catalog: readonly CatalogAsset[], timezone: string): Promise<BoundProject> {
  const out: BoundProject = { outputs: new Map(), planInputs: new Map(), problems: new Map(), quoted: new Set() };
  const byName = new Map(assets.map((a) => [a.name, a]));
  const sqlAssets = order.map((n) => byName.get(n)).filter((a): a is ResolvedAsset & { sql: LoadedSqlAsset } =>
    !!a && a.kind === "sql" && !!a.sql && scope.has(a.name));
  if (!sqlAssets.length) return out;

  const shadow = await ShadowCatalog.open(timezone);
  try {
    const defined = new Set<string>();
    const pending: Record<string, string[]> = {};
    for (const c of catalog) {
      if (!c.columns.length) continue;
      try {
        await shadow.define(c.asset, c.columns.map((x) => ({ name: x.name, type: x.type })));
      } catch (e) {
        if (e instanceof CroftError) continue;          // a type the shadow cannot create: treated as unknown
        throw e;
      }
      defined.add(c.asset);
      const p = c.columns.filter((x) => x.pending).map((x) => x.name);
      if (p.length) pending[c.asset] = p;
    }
    const assetFiles = Object.fromEntries(assets.map((a) => [a.name, a.file]));
    const unknown = new Map<string, Unknown>();
    const markUnknown = (name: string, u: Unknown) => { if (!defined.has(name)) unknown.set(name, u); };

    for (const a of sqlAssets) {
      const problems: Problem[] = [];
      out.problems.set(a.name, problems);
      const loadErrors = a.sql.problems.filter((p) => p.severity === "error");
      const syntaxOnly = loadErrors.length > 0 && loadErrors.every((p) => p.code === "SQL_SYNTAX");
      if (loadErrors.length && !syntaxOnly) {
        markUnknown(a.name, { roots: new Set(), broken: new Set([a.name]) });
        continue;
      }
      const missing = a.inputs.filter((x) => x !== a.name && byName.has(x) && !defined.has(x));
      if (missing.length) {
        const why = unknownOf(missing, unknown, byName);
        const p = notBuilt(a, missing, why, byName);
        if (p) problems.push(p);
        markUnknown(a.name, why);
        continue;
      }
      const r = await shadow.bind(a.sql, { pending, assetFiles });
      let found = r.problems.map((p) => (p.code === "INPUT_NOT_BUILT" && !p.fix ? withPreviewFix(p, unknown, byName) : p));
      if (syntaxOnly) {
        if (found.some((p) => p.code === "QUOTE_IDENTIFIER")) out.quoted.add(a.name);
        else found = found.filter((p) => p.code !== "SQL_SYNTAX");     // the loader reported it already
      }
      problems.push(...found);
      if (r.outputColumns) {
        await shadow.define(a.name, r.outputColumns);
        defined.add(a.name);
        unknown.delete(a.name);
        out.outputs.set(a.name, r.outputColumns);
        if (r.planInputs) out.planInputs.set(a.name, r.planInputs);
        problems.push(...await bindChecks(shadow, a, a.sql, assetFiles));
      } else {
        const input = found.find((p) => p.code === "INPUT_NOT_BUILT")?.details?.input;
        markUnknown(a.name, typeof input === "string" ? unknownOf([input], unknown, byName) : { roots: new Set(), broken: new Set([a.name]) });
      }
    }
  } finally {
    shadow.close();
  }
  return out;
}

/** Why these inputs have no columns: the never-built assets at the root of each, and SQL inputs whose errors
 *  stop their own bind. Every SQL asset bound before is defined or in `unknown`; one that is neither comes later
 *  in the order, which only an asset on a cycle reads (its CYCLE problem says why), so it adds no reason. */
function unknownOf(inputs: readonly string[], unknown: ReadonlyMap<string, Unknown>, byName: ReadonlyMap<string, ResolvedAsset>): Unknown {
  const u: Unknown = { roots: new Set(), broken: new Set() };
  for (const x of inputs) {
    const w = unknown.get(x);
    if (w) {
      w.roots.forEach((r) => u.roots.add(r));
      w.broken.forEach((b) => u.broken.add(b));
    } else if (byName.get(x)?.kind !== "sql") u.roots.add(x);
  }
  return u;
}

const listed = (names: Iterable<string>): string => {
  const l = [...names].sort();
  return l.length <= 1 ? l.join("") : `${l.slice(0, -1).join(", ")} and ${l.at(-1)}`;
};

/** INPUT_NOT_BUILT for an asset that skips the bind (DESIGN §4.2's wording), with `croft preview` of the roots;
 *  null when its inputs are unknown only because of a cycle. */
function notBuilt(a: ResolvedAsset, missing: readonly string[], why: Unknown, byName: ReadonlyMap<string, ResolvedAsset>): Problem | null {
  const roots = [...why.roots].sort();
  const broken = [...why.broken].sort();
  if (!roots.length && !broken.length) return null;
  const direct = roots.length > 0 && roots.length === missing.length && missing.every((m) => why.roots.has(m));
  const until: string[] = [];
  if (roots.length) until.push(direct ? `${roots.length === 1 ? "it has" : "they have"} run or been previewed` : `${listed(roots)} ${roots.length === 1 ? "has" : "have"} run or been previewed`);
  if (broken.length) until.push(`the errors in ${listed(broken.map((b) => byName.get(b)?.file ?? b))} are fixed`);
  const once = [roots.length ? `${listed(roots)} ${roots.length === 1 ? "has" : "have"} run or been previewed` : "", broken.length ? `the errors in ${listed(broken.map((b) => byName.get(b)?.file ?? b))} are fixed` : ""]
    .filter(Boolean).join(" and ");
  return problem("INPUT_NOT_BUILT", {
    message: `columns of ${listed(missing)} are unknown until ${until.join(" and ")}; bind check skipped`,
    hint: `${a.name} is checked once ${once}${roots.length ? ` (croft preview ${roots.join(" ")})` : ""}`,
    asset: a.name, file: a.file,
    ...(roots.length ? { fix: previewFix(roots) } : {}),
    details: { input: [...missing].sort()[0], inputs: [...missing].sort(), notBuilt: roots, ...(broken.length ? { broken } : {}) },
  });
}

function previewFix(roots: readonly string[]) {
  return {
    kind: "command" as const,
    description: `preview ${listed(roots)} to learn ${roots.length === 1 ? "its" : "their"} columns`,
    command: `croft preview ${roots.join(" ")}`,
  };
}

/** The bind's own INPUT_NOT_BUILT (an input the AST did not show): the same preview fix. */
function withPreviewFix(p: Problem, unknown: ReadonlyMap<string, Unknown>, byName: ReadonlyMap<string, ResolvedAsset>): Problem {
  const input = p.details?.input;
  if (typeof input !== "string") return p;
  const roots = [...unknownOf([input], unknown, byName).roots].sort();
  return roots.length ? { ...p, fix: previewFix(roots), details: { ...p.details, notBuilt: roots } } : p;
}

/** Codes a check's bind keeps; any other failure of a check is CHECK_INVALID. */
const CHECK_KEEPS = new Set(["UNKNOWN_COLUMN", "UNKNOWN_TABLE", "QUOTE_IDENTIFIER"]);

/**
 * Bind each check of an SQL asset against its output columns (its table is defined from them now), so a check
 * naming a column the SELECT does not produce fails here rather than in the run's write transaction. The
 * problem sits on the check's header line (the key line for the checks a key implies).
 */
async function bindChecks(shadow: ShadowCatalog, a: ResolvedAsset, sql: LoadedSqlAsset, assetFiles: Record<string, string>): Promise<Problem[]> {
  const out: Problem[] = [];
  const header = readText(a.path).split("\n").slice(0, sql.headerLines);
  // The checks a key implies (unique and not_null of the same columns) fail the same way once.
  const seen = new Set<string>();
  for (const c of a.checks) {
    if (c.kind === "min_rows") continue;
    const body = c.kind === "rule" ? probeSql(a.name, c.sql) : `SELECT ${c.sql} FROM ${quoteIdent(a.name)}`;
    const probe: LoadedSqlAsset = { ...sql, ok: true, body, headerLines: 0, astInputs: [a.name, ...c.reads], problems: [] };
    const r = await shadow.bind(probe, { assetFiles });
    const at = checkLine(header, c, sql.header.key);
    for (const p of r.problems) {
      if (p.code === "INPUT_NOT_BUILT" || p.code === "DUPLICATE_OUTPUT_COLUMN") continue;
      const id = JSON.stringify([p.code, at?.line, p.message]);
      if (seen.has(id)) continue;
      seen.add(id);
      const code: Code = CHECK_KEEPS.has(p.code) && isCode(p.code) ? p.code : "CHECK_INVALID";
      // A rule's expression is line 2 of its probe; its column there is its column in the check text.
      const column = at && c.kind === "rule" && p.line === 2 && p.column !== undefined ? at.column + p.column - 1 : undefined;
      const fix = p.fix?.kind === "edit"
        ? { ...p.fix, file: a.file, ...(at ? { line: at.line } : {}) }
        : p.fix;
      const { line: _l, column: _c, fix: _f, ...rest } = p;
      out.push({
        ...rest, code, severity: CODES[code].severity, docs: `croft docs ${code}`,
        message: `${c.blocking ? "check" : "warning"} ${c.source}: ${p.message}`,
        asset: a.name, file: a.file,
        ...(at ? { line: at.line } : {}), ...(column !== undefined ? { column } : {}),
        ...(fix ? { fix } : {}),
        details: { ...p.details, check: c.source },
      });
    }
  }
  return out;
}

/** Where a check is written in an SQL header: its `-- check:`/`-- warn:` line (the text's column), or for a
 *  check the key implies, the `-- key:` line. */
function checkLine(header: readonly string[], c: Check, key: readonly string[]): { line: number; column: number } | undefined {
  const find = (re: RegExp, text?: string) => {
    for (let i = 0; i < header.length; i++) {
      const line = header[i]!;
      if (!re.test(line)) continue;
      if (text === undefined) return { line: i + 1, column: 1 };
      const at = line.indexOf(text);
      if (at >= 0) return { line: i + 1, column: Array.from(line.slice(0, at)).length + 1 };
    }
    return undefined;
  };
  const declared = find(c.blocking ? /^\s*--\s*check\s*:/i : /^\s*--\s*warn\s*:/i, c.kind === "rule" ? c.sql : c.source);
  if (declared) return declared;
  return key.length && (c.kind === "unique" || c.kind === "not_null") ? find(/^\s*--\s*key\s*:/i) : undefined;
}

// ---------------------------------------------------------------------------------------------------------
// --types

/**
 * .croft/types before tsc (project/types-gen.ts): the column cache, with `code` (each bound SQL asset's output
 * columns as its code is now) in place of the cache for those assets. A folder croft cannot write is a warning:
 * tsc then checks against the types already there, or none.
 */
function writeInputTypes(project: ValidateInput["project"], code: readonly TypeSource[]): { types: TypesResult | null; problems: Problem[] } {
  try {
    return { types: generateInputTypes(project.root, { stateDir: project.paths.stateDir, code }), problems: [] };
  } catch (e) {
    const p = problem("PROJECT_NOT_WRITABLE", {
      message: `could not write ${TYPES_DIR}: ${(e as Error).message}`,
      hint: `tsc checked the TS transforms without their current input row types; make ${TYPES_DIR} writable (or delete it), then run croft validate --types again`,
      file: TYPES_DIR,
      fix: { kind: "manual", description: `make ${TYPES_DIR} writable, or delete the folder` },
      details: { phase: "types" },
    });
    return { types: null, problems: [{ ...p, severity: "warning" }] };
  }
}

/** Whether tsconfig.json's "include" reaches .croft/types; null when that cannot be told (no "include" but an
 *  "extends", a file that does not parse). TypeScript's wildcards never enter a folder whose name starts with a
 *  dot, so only a pattern that names .croft does. */
export function includesInputTypes(tsconfigText: string): boolean | null {
  let config: unknown;
  try {
    config = toValue(parseJsonc(tsconfigText));
  } catch {
    return null;
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const c = config as { include?: unknown; files?: unknown; extends?: unknown };
  if (c.include === undefined) return c.extends === undefined ? false : null;
  if (!Array.isArray(c.include)) return null;
  return c.include.some((p) => {
    if (typeof p !== "string") return false;
    const n = p.replace(/^\.\//, "").replace(/\/+$/, "");
    // ".croft/*" names the files directly in .croft/ only: "*" never crosses a "/".
    return n === ".croft" || n === TYPES_DIR || n.startsWith(".croft/**") || n.startsWith(`${TYPES_DIR}/`);
  });
}

/** An info problem when there are input types and tsconfig.json leaves them out (a project made before them). */
function typesNotIncluded(root: string, generated: TypesResult | undefined): Problem[] {
  if (!generated?.assets.length || includesInputTypes(readText(join(root, "tsconfig.json"))) !== false) return [];
  const p = problem("INSTALL_FAILED", {
    message: `tsconfig.json does not include ${TYPES_DIR}, so TS transforms read every input row as a Row: tsc cannot catch a column renamed upstream`,
    hint: `add "${TYPES_DIR}" to "include" in tsconfig.json (croft init writes it that way)`,
    file: "tsconfig.json",
    fix: { kind: "edit", description: `add "${TYPES_DIR}" to the "include" list`, file: "tsconfig.json" },
    details: { phase: "types" },
  });
  return [{ ...p, severity: "info" }];
}

/** The project's tsc --noEmit: each type error a problem (ASSET_INVALID, at its file and line). With the input
 *  types it ran against, a missing property of a generated row type is UNKNOWN_INPUT_COLUMN instead. */
export async function typecheck(root: string, shell: Readonly<Record<string, string | undefined>>,
  o: { timeoutMs?: number; inputTypes?: TypesResult } = {}): Promise<{ types: NonNullable<ValidateData["types"]>; problems: Problem[] }> {
  const skipped = (message: string, hint: string) => {
    const p = problem("INSTALL_FAILED", { message, hint, fix: { kind: "manual", description: hint } });
    return { types: { status: "skipped" as const, errors: 0 }, problems: [{ ...p, severity: "info" as const }] };
  };
  const bin = join(root, "node_modules", ".bin", "tsc");
  if (!existsSync(bin)) {
    return skipped("--types skipped: this project has no TypeScript compiler (node_modules/.bin/tsc)",
      "run bun install in the project folder (package.json lists typescript); croft never installs it itself");
  }
  if (!existsSync(join(root, "tsconfig.json"))) {
    return skipped("--types skipped: this project has no tsconfig.json",
      "add a tsconfig.json that includes assets and lib (croft init writes one for a new project)");
  }
  // A JavaScript entry (Bun's .bin links to typescript/bin/tsc) runs with this Bun, so no Node is needed; a
  // shell shim (other package managers) runs as it is. Its output is a pipe, so tsc prints plain
  // `file(line,col): error TSnnnn: text` lines.
  const shim = /^#!\s*\/(usr\/)?bin\/(env\s+)?(ba|z)?sh\b/.test(readText(bin).slice(0, 64));
  const cmd = shim ? [bin, "--noEmit"] : [process.execPath, bin, "--noEmit"];
  const env: Record<string, string> = { NO_COLOR: "1" };
  for (const k of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT"]) {
    const v = shell[k];
    if (v !== undefined) env[k] = v;
  }
  const proc = Bun.spawn(cmd, { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timeoutMs = o.timeoutMs ?? TSC_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, timeoutMs);
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (timedOut) {
    return {
      types: { status: "failed", errors: 0 },
      problems: [problem("TIMEOUT", {
        message: `tsc --noEmit did not finish within ${formatDuration(timeoutMs)}`,
        hint: "run node_modules/.bin/tsc --noEmit in the project folder to see what it is doing",
        details: { phase: "types" },
      })],
    };
  }
  const diagnostics = parseTsc(stdout);
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (exit !== 0 && errors.length === 0) {
    const tail = `${stdout}\n${stderr}`.trim().split("\n").slice(-5).join("\n");
    return {
      types: { status: "failed", errors: 0 },
      problems: [problem("ASSET_INVALID", {
        message: `tsc --noEmit failed (exit ${exit})${tail ? `:\n${tail}` : ""}`,
        hint: "run node_modules/.bin/tsc --noEmit in the project folder and fix what it reports",
        details: { exit },
      })],
    };
  }
  const problems = errors.slice(0, TSC_SHOWN).map((d) => tscProblem(d, root, o.inputTypes));
  if (errors.length > TSC_SHOWN) {
    problems.push(problem("ASSET_INVALID", {
      message: `${errors.length - TSC_SHOWN} more type errors`,
      hint: "fix the errors above, or run node_modules/.bin/tsc --noEmit in the project folder to see them all",
      details: { hidden: errors.length - TSC_SHOWN },
    }));
  }
  problems.push(...typesNotIncluded(root, o.inputTypes));
  return { types: { status: errors.length ? "failed" : "ok", errors: errors.length }, problems };
}

export interface TscDiagnostic { file?: string; line?: number; column?: number; severity: "error" | "warning" | "message"; code: string; message: string }

/** tsc --pretty false output: `file(line,col): error TS2322: text`, continuation lines indented, and
 *  project-wide diagnostics without a location (`error TS5083: text`). */
export function parseTsc(output: string): TscDiagnostic[] {
  const out: TscDiagnostic[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const at = /^(.+?)\((\d+),(\d+)\): (error|warning|message) (TS\d+): (.*)$/.exec(line);
    const bare = at ? null : /^(error|warning|message) (TS\d+): (.*)$/.exec(line);
    if (at) {
      out.push({ file: at[1]!, line: Number(at[2]), column: Number(at[3]), severity: at[4] as TscDiagnostic["severity"], code: at[5]!, message: at[6]! });
    } else if (bare) {
      out.push({ severity: bare[1] as TscDiagnostic["severity"], code: bare[2]!, message: bare[3]! });
    } else if (/^\s/.test(line) && line.trim() && out.length) {
      out.at(-1)!.message += `\n${line.trim()}`;
    }
  }
  return out;
}

/** tsc names a generated row type when code reads a column the input lacks (TS2339, TS2551, and TS7053 for a
 *  literal index); TS7053 with a string index is a column name computed at run time. */
const MISSING_PROPERTY = /Property '([^']+)' does not exist on type '([A-Za-z_$][A-Za-z0-9_$]*)'/;
const COMPUTED_INDEX = /expression of type 'string' can't be used to index type '([A-Za-z_$][A-Za-z0-9_$]*)'/;

function tscProblem(d: TscDiagnostic, root: string, inputTypes?: TypesResult): Problem {
  const file = d.file?.split("\\").join("/");
  const asset = file && /^assets\//.test(file) ? basename(file, extname(file)) : undefined;
  const at = {
    ...(asset ? { asset } : {}), ...(file ? { file } : {}),
    ...(d.line !== undefined ? { line: d.line } : {}), ...(d.column !== undefined ? { column: d.column } : {}),
  };
  const missing = MISSING_PROPERTY.exec(d.message);
  const input = missing && inputTypes && Object.hasOwn(inputTypes.types, missing[2]!) ? inputTypes.types[missing[2]!]! : null;
  if (missing && input && file) return unknownInputColumn(d, root, { ...at, file }, input, missing[1]!);
  const computed = COMPUTED_INDEX.exec(d.message);
  const indexed = computed && inputTypes && Object.hasOwn(inputTypes.types, computed[1]!) ? inputTypes.types[computed[1]!]! : null;
  if (indexed && file) {
    const name = JSON.stringify(indexed.asset);
    return problem("ASSET_INVALID", {
      message: `${d.code}: ${d.message}`,
      hint: `${indexed.asset}'s generated row type names its columns; for a column name computed at run time, read the input as a Row: rows<Row>(${name}), or (row as Row)[name]`,
      ...at,
      fix: { kind: "edit", description: `read ${indexed.asset} with rows<Row>(${name}) (import type { Row } from "@zabaca/croft")`, file, ...(d.line !== undefined ? { line: d.line } : {}) },
      details: { tsc: d.code, input: indexed.asset, types: indexed.file },
    });
  }
  return problem("ASSET_INVALID", {
    message: `${d.code}: ${d.message}`,
    hint: "fix the type error; the project's own tsc --noEmit reports it",
    ...at,
    ...(file ? { fix: { kind: "edit" as const, description: `fix the type error${d.line !== undefined ? ` on line ${d.line}` : ""}`, file, ...(d.line !== undefined ? { line: d.line } : {}) } } : {}),
    details: { tsc: d.code },
  });
}

// ---------------------------------------------------------------------------------------------------------
// --hook

/** What a --hook run checked, for its human output (the edit, the edited asset's name, what was selected, how to
 *  name files for Claude), and whether croft itself failed (not a finding about the edit). */
interface HookRun { target: string; asset: string | null; selected: string[]; show?: (file: string) => string; failed?: boolean }
const hookRuns = new WeakMap<object, HookRun>();

/**
 * croft validate --hook (DESIGN.md §9 item 7; agent/hook.ts): the edit Claude Code just made, from its PostToolUse
 * JSON on stdin. An edit that is not an asset file in assets/ or a file in lib/ of this project checks nothing.
 * Otherwise the edited asset is validated, with the assets that read it when it is SQL (a lib/ file: the TS
 * assets that import it), and only their errors and warnings count: exit 2 when there is an error, which shows
 * stderr to Claude; 0 otherwise, with the warnings handed to Claude as context (hookHuman). Files are named from
 * the folder Claude works in (the input's cwd). Never the warehouse, never the network.
 *
 * Exit 2 is only for findings about the edited assets. croft's own failures (a usage error, stdin that is not the
 * hook's JSON, anything else croft raises that is not a problem in the project) exit 1, which Claude Code shows
 * the user as a non-blocking hook error: exit 2 would feed them to Claude after every edit it makes.
 */
async function validateHook(ctx: Ctx): Promise<CommandResult<ValidateData>> {
  try {
    return await checkEdit(ctx);
  } catch (e) {
    if (!(e instanceof CroftError)) throw e;
    hookRuns.set(ctx, { target: "the edited file", asset: null, selected: [], ...hookRuns.get(ctx), failed: true });
    return { data: { order: [], assets: [] }, problems: [e.problem], next: [], exit: EXIT.FAILED };
  }
}

async function checkEdit(ctx: Ctx): Promise<CommandResult<ValidateData>> {
  hookUsage(ctx);
  const none: CommandResult<ValidateData> = { data: { order: [], assets: [] }, problems: [], next: [], exit: EXIT.OK };
  const stdin = await readHookStdin();
  const root = findRoot(ctx.cwd);
  if (!root) {
    parseHookInput(stdin);                          // stdin that is not hook JSON is still a usage error
    return none;
  }
  const target = hookTarget(stdin, root);
  if (!target) return none;
  // Files are named for Claude from where it works (an app's data/ project: data/assets/x.sql).
  const run: HookRun = { target, asset: null, selected: [], show: hookPaths(root, parseHookInput(stdin).cwd) };
  hookRuns.set(ctx, run);
  const found = (problems: Problem[]): CommandResult<ValidateData> => ({
    ...none, problems, exit: problems.some((p) => p.severity === "error") ? EXIT.INVALID : EXIT.OK,
  });
  try {
    const project = ctx.project;
    if (target.startsWith("assets/")) {
      // A file discovery refuses (its name, or a twin with the same name) is its own problem; one it skips is
      // no asset.
      const discovery = await discoverAssets(project.root);
      const refused = discovery.problems.filter((p) => p.file === target || (Array.isArray(p.details?.files) && p.details.files.includes(target)));
      if (refused.length) return found(refused);
      run.asset = discovery.assets.find((a) => a.file === target)?.name ?? null;
      if (!run.asset) return none;
    }
    const report = await validateProject({
      project, env: ctx.env, processEnv: ctx.processEnv, now: ctx.now(),
      ...(run.asset ? { selectors: [run.asset] } : {}),
      select: (resolved) => hookSelection(resolved, target),
    });
    run.selected = report.data.assets.map((a) => a.name);
    return { ...found(hookProblems(report.problems, new Set(run.selected), target)), data: report.data };
  } catch (e) {
    // A problem Claude can fix in the project (a croft.json that does not load, say) is reported like the
    // others; anything else is croft's own failure (validateHook: exit 1).
    if (e instanceof CroftError && CODES[e.code].category === "project") return found([e.problem]);
    throw e;
  }
}

/** --hook takes its file from stdin: asset names, --types and a terminal on stdin are usage errors. */
function hookUsage(ctx: Ctx): void {
  const usage = (message: string, hint: string, command: string) =>
    new CroftError("USAGE_ERROR", { message, hint, fix: { kind: "command", description: "check it yourself", command } });
  if (ctx.positionals.length) {
    const command = ["croft validate", ...selectorWords(ctx.positionals)].join(" ");
    throw usage("croft validate --hook takes the edited file from the hook's JSON on stdin, not asset names",
      `to check them yourself, run ${command}`, command);
  }
  if (ctx.values.types === true) {
    throw usage("croft validate --hook checks one edit and stays fast, so it does not run tsc",
      "run croft validate --types on its own", "croft validate --types");
  }
  if (ctx.isTTY.stdin) {
    throw usage("croft validate --hook is what Claude Code's PostToolUse hook runs: it reads the hook's JSON on stdin, and stdin is a terminal",
      "to check the project yourself, run croft validate; croft init --claude --with-hook adds the hook", "croft validate");
  }
}

/**
 * --hook's human output, per Claude Code's PostToolUse contract (agent/hook.ts):
 * - errors: the report on stderr, which Claude Code shows Claude on exit 2; stdout stays empty;
 * - warnings only: one line of JSON on stdout whose additionalContext Claude reads next to the edit, exit 0;
 * - a clean check, or nothing to check: nothing at all;
 * - croft's own failure (exit 1): its problem block on stderr, whose first line Claude Code shows the user.
 */
function hookHuman(result: CommandResult<ValidateData>, ctx: Ctx): undefined {
  const run = hookRuns.get(ctx) ?? { target: "the edited file", asset: null, selected: [] };
  if (run.failed) {
    ctx.render.errRaw(formatProblems(result.problems, ctx.render.errColor));
    return undefined;
  }
  if (!result.problems.length) return undefined;
  const show = run.show ?? ((file: string) => file);
  const problems = showPaths(result.problems, show);
  const findings = { ...run, shown: show(run.target), problems };
  if (problems.some((p) => p.severity === "error")) {
    ctx.render.errRaw(hookReport({ ...findings, formatted: formatProblems(problems, false) }));
  } else {
    ctx.render.outRaw(hookOutput(hookContext({ ...findings, formatted: problems.map((p) => formatProblems([p], false)) })));
  }
  return undefined;
}

/**
 * A column the input does not have, read in TS code, found by tsc against the generated row type: the problem
 * a run would raise when the code reached that line (run/inputs.ts, UNKNOWN_INPUT_COLUMN), with the same
 * did-you-mean. The fix replaces the name when it stands once on the line, as a property read; a shorthand
 * destructuring (`const { author } = row`) keeps its variable with `{ author_login: author }`.
 */
function unknownInputColumn(d: TscDiagnostic, root: string, at: Pick<Problem, "asset" | "line" | "column"> & { file: string },
  input: GeneratedType, column: string): Problem {
  const guess = didYouMean(column, input.columns.filter((c) => c !== column));
  const q = JSON.stringify;
  let fix: Fix;
  if (guess) {
    const text = at.line !== undefined ? readText(join(root, at.file)).split("\n")[at.line - 1] ?? "" : "";
    const shorthand = at.column !== undefined && isShorthand(text, at.column - 1, column);
    fix = {
      kind: "edit", file: at.file, ...(at.line !== undefined ? { line: at.line } : {}),
      description: shorthand
        ? `read ${q(guess)} instead of ${q(column)}: { ${guess}: ${column} } keeps the name ${column}`
        : `read ${q(guess)} instead of ${q(column)}`,
      ...(!shorthand && standsOnce(text, column) ? { replace: { from: column, to: guess } } : {}),
    };
  } else {
    fix = {
      kind: "edit", file: at.file, ...(at.line !== undefined ? { line: at.line } : {}),
      description: `read one of the columns of ${input.asset} (${input.file} lists them)`,
    };
  }
  return problem("UNKNOWN_INPUT_COLUMN", {
    ...at,
    message: `${input.asset} has no column ${q(column)}${guess ? `; did you mean ${q(guess)}?` : ""}`,
    hint: guess ? `the column may have been renamed upstream; read ${q(guess)} instead` : `${input.asset} has these columns: ${input.columns.join(", ")}`,
    fix,
    details: { tsc: d.code, input: input.asset, column, ...(guess ? { suggestion: guess } : {}), columns: input.columns, types: input.file },
  });
}

/** Whether `word` stands exactly once, as a whole name, on the line: a replace fix that is safe to apply as is. */
function standsOnce(text: string, word: string): boolean {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (text.match(new RegExp(`(?<![\\w$])${esc}(?![\\w$])`, "g")) ?? []).length === 1;
}

/** Whether the name at `index` is a shorthand property of a destructuring pattern (`{ author }`, `{ a, author = x }`),
 *  which binds a variable of the same name. */
function isShorthand(text: string, index: number, name: string): boolean {
  if (text.slice(index, index + name.length) !== name) return false;
  const before = text.slice(0, index).trimEnd().at(-1);
  const after = text.slice(index + name.length).trimStart()[0];
  return (before === "{" || before === ",") && (after === undefined || after === "," || after === "}" || after === "=");
}
