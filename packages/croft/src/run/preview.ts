// croft preview (DESIGN.md §6 "Ways to try a change" 2, §4.2): build assets in .croft/preview.duckdb and diff
// them against the live tables. Nothing real changes: the live warehouse is only ever read, under one short read
// lease with no write intent, and never ATTACHed.
//
//   plan       run/plan.ts, as `croft run <assets>` would plan it: the named assets, then the transforms
//              downstream of them (the bind check's problems are on each step). A file renamed outside croft
//              (ASSET_RENAMED) is never fetched from scratch: named exactly it fails before it runs, taken by a glob
//              it is skipped with the problem, and so is what needs it; next names the rename that adopts its table
//   hold       .croft/preview.duckdb is opened read-write (no write intent) for the whole preview, so two previews,
//              or a preview and `croft query --preview`, take turns; the last preview's file and .croft/preview/
//              are emptied first
//   snapshot   ONE read lease on the live warehouse: every live table the preview reads or compares with is copied
//              to .croft/preview/<name>.parquet (run/snapshot.ts snapshotTable), and the _croft rows of those
//              assets to .croft/preview/_croft/
//   views      the preview database sees each snapshot as a view, with the live column types: main.<input> for an
//              input the preview does not build, live.<asset> for the live version of every asset it builds. So
//              everything in a preview, and every later `croft query --preview`, reads one consistent snapshot
//   build      in run order, each through the step a run uses, against the preview database and a preview
//              runs.sqlite (.croft/preview/runs.sqlite: its catalog entries have source "preview"), so the live
//              catalog is never overwritten:
//                sql         runSqlStep (run/sql.ts); SQL downstream of a built transform is built too, unless an
//                            input of it is partial or an ingest (a diff against a partial input would suggest that
//                            correct SQL is wrong); it is then listed as downstream, not built
//                transform   runTransform with StepInput.preview: ctx.preview is true, and each input gives the code
//                            at most --rows rows (a per-row LLM transform costs at most that many calls). The cost
//                            guard (§5) holds too: an incremental transform that makes requests gets at most its
//                            confirmAbove input rows. Without --rows its cap is lowered to fit, and its reason says
//                            so; an explicit --rows over it is LARGE_REPROCESS, with the --rows that fits
//                ingest      runIngest from the saved position, with ctx.preview true and the generator stopped after
//                            --rows rows; the position moves only in the preview database. File ingests read their
//                            new and changed files (no requests are made, so no cap applies). Downstream assets are
//                            listed, not built
//   compare    how a build starts decides what the diff means:
//                fresh   no table yet in the preview database (SQL, full-refresh TS, replace ingests, --rebuild, a
//                        table never built): the whole table is built, then compared with live.<asset> by key (or by
//                        whole rows without one): added, removed, changed, unchanged. When an input or a fetch was
//                        capped, only the keys the preview produced count, and none is ever "removed"
//                copy    the live table and its _croft state copied in first (merge and append ingests, incremental
//                        TS): the step runs exactly as a real run would (the saved cursor, positions, known columns),
//                        and the write's own counts are the diff: "212 would update, 788 would add"
//              Checks and warnings run on the preview table after the write, all of them, with the scope a real
//              run would give them (a new or edited check covers the whole table), so a failing blocking check
//              still leaves the table to explore; the asset then fails with CHECK_FAILED, as the real run would.
//   approve    a successful preview is human-initiated, so it approves the asset's code for the scheduler
//              (RunsDb.approveCode in the live runs.sqlite, DESIGN.md §6 "The scheduler only runs code a human
//              has run")
//
// The step logs of a preview go to .croft/preview/logs/<asset>.log; the preview's run id starts with "p_".
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { checksHook, runWarnings } from "../checks/run.ts";
import { CroftError, problem } from "../core/errors.ts";
import { setOutputRedactor } from "../core/output.ts";
import { formatInstant, now as clockNow } from "../core/time.ts";
import type { LockHolder, PreviewAsset, PreviewColumnChange, PreviewData, Problem, Sql, StepResult } from "../core/types.ts";
import type { IngestContext, Row, RowsIngest } from "../types.ts";
import { canonicalPath } from "../db/connect.ts";
import { ensureState, hasState } from "../db/state.ts";
import { type DuckWarehouse, type LeaseSql, openWarehouse, type WarehouseOptions } from "../db/warehouse.ts";
import type { CatalogAsset } from "../history/catalog.ts";
import { putCatalog } from "../history/catalog.ts";
import { LogWriter } from "../history/logs.ts";
import { newRunId, RunsDb } from "../history/runs-db.ts";
import { isReservedColumn, normalizeType, quoteIdent, quoteLiteral } from "../load/evolve.ts";
import type { ProjectEnv } from "../project/env.ts";
import type { Project } from "../project/root.ts";
import { isoMicros, wouldShrink } from "../safety/guards.ts";
import { windowOf } from "./dry-run.ts";
import { croftError, runIngest, StepProgress } from "./ingest.ts";
import { cursorTypesOf, loadErrors, type PlannedStep, planRun, readMirror, type RunPlan, skipProblem } from "./plan.ts";
import { withProjectChecks } from "./runner.ts";
import { snapshotTable } from "./snapshot.ts";
import { runSqlStep } from "./sql.ts";
import type { StepInput, StepOutcome } from "./step.ts";
import { previewGuard, previewReprocess, runTransform } from "./transform.ts";

/** --rows when it is not given: the input rows a TS transform receives, the rows an ingest fetches (§6). */
export const DEFAULT_PREVIEW_ROWS = 1000;
/** The most --rows may be: a preview is a sample; a real run processes everything. */
export const MAX_PREVIEW_ROWS = 100_000;
/** The preview database, in the state folder. */
export const PREVIEW_DATABASE = "preview.duckdb";
/** The preview's snapshots, logs and runs.sqlite, in the state folder. */
export const PREVIEW_DIR = "preview";
/** The schema of the preview database that holds the live version of every asset a preview built. */
export const LIVE_SCHEMA = "live";
/** Sample rows of each asset in a preview's result. */
export const PREVIEW_SAMPLE_ROWS = 3;

export function previewDatabasePath(stateDir: string): string {
  return join(stateDir, PREVIEW_DATABASE);
}

export function previewDirectory(stateDir: string): string {
  return join(stateDir, PREVIEW_DIR);
}

export interface PreviewInput {
  project: Project;
  env: ProjectEnv;
  /** The assets named (names or globs); at least one. */
  selectors: readonly string[];
  /** --rows (default 1,000; at most 100,000). Left out, a TS transform that makes requests gets at most its
   *  confirmAbove input rows (the cost guard, §5); given, a preview over confirmAbove is LARGE_REPROCESS. */
  rows?: number;
  /** --rebuild: every named asset is built from scratch and compared with its live table. */
  rebuild?: boolean;
  /** stdin and stdout are a terminal: lock waits of 60 s instead of 90 s (§5 "Default waits"). */
  interactive?: boolean;
  /** Ctrl-C/SIGTERM: the step that runs is interrupted, and the preview ends. */
  signal?: AbortSignal;
  /** The clock (CROFT_NOW). */
  now?: () => Date;
  http?: StepInput["http"];
  /** Overrides every asset's no-progress timeout (tests). */
  timeoutMs?: number;
  importTimeoutMs?: number;
  /** A lock wait has lasted a while: `what` is "the warehouse" or "the preview database". */
  onWait?: (holder: LockHolder, waitedMs: number, what: string) => void;
  /** Who a PID that holds the warehouse is (runs.sqlite). */
  lookupHolder?: WarehouseOptions["lookupHolder"];
  /** Progress for a terminal: "github_issues: fetching…". */
  onProgress?: (line: string) => void;
}

export interface PreviewOutcome {
  data: PreviewData;
  problems: Problem[];
  /** Assets the preview holds a table for (query --preview reads them), in run order. */
  built: string[];
  /** The named assets, when every one of them built without an error (`croft run` applies them); else []. */
  apply: string[];
  /** What else to do: re-check after a fix, preview an input first. */
  next: { command: string; reason: string }[];
}

type Mode = "fresh" | "copy";

/** A live table the snapshot copied: its columns with DuckDB's own type names, and its Parquet file. */
interface LiveTable { name: string; columns: RawColumn[]; path: string }
interface RawColumn { name: string; type: string }

interface LiveSnapshot {
  at: Date | null;
  tables: Map<string, LiveTable>;
  /** Parquet copies of the _croft rows of the snapshotted assets, by _croft table. */
  state: Partial<Record<StateTable, string>>;
}

/** The _croft tables a preview copies rows of, and the column that names the asset. */
const STATE_COPIES = { assets: "name", columns: "asset", inputs: "asset", files: "asset" } as const;
type StateTable = keyof typeof STATE_COPIES;

/** What happened to one asset the preview looked at. */
interface Entry {
  step: PlannedStep;
  named: boolean;
  mode: Mode;
  /** built: a table in the preview database (ok, or failed after its write: checks); listed: downstream, not
   *  built; skipped: an input is missing or failed; failed: no table. */
  state: "built" | "failed" | "skipped" | "listed";
  partial: boolean;
  asset: PreviewAsset;
}

// ---------------------------------------------------------------------------------------------------------

/** Build the named assets (and SQL downstream of them) in the preview database and diff them against live. */
export async function runPreview(i: PreviewInput): Promise<PreviewOutcome> {
  const { project, env } = i;
  const cap = previewRows(i.rows);
  const clock = i.now ?? (() => clockNow());
  const tz = project.timezone;
  if (i.selectors.length === 0) {
    throw new CroftError("USAGE_ERROR", {
      message: "croft preview needs the assets to preview",
      hint: "name one or more assets: croft preview open_issues",
      fix: { kind: "manual", description: "name the asset to preview after croft preview" },
    });
  }
  // Asset output that escapes its step's scope reaches stderr redacted with this project's .env (core/output.ts).
  setOutputRedactor((t) => env.redact(t));
  const stateDir = project.paths.stateDir;
  const mirror = readMirror(stateDir);
  // Every asset's secrets are hidden in samples, and a transform input that names no asset fails its step, as in
  // a run (runner.ts withProjectChecks).
  const plan = await withProjectChecks(await planFor(i, mirror), project, env);
  const byName = new Map(plan.steps.map((s) => [s.asset, s]));
  const named = new Set(plan.steps.filter((s) => s.reasons.includes("requested")).map((s) => s.asset));
  // What the preview may build: the named assets, and the SQL downstream of them.
  const candidates = plan.order.filter((n) => named.has(n) || byName.get(n)?.kind === "sql");
  const needs = new Set<string>(candidates);
  // A warning's tables no longer order the steps (plan.ts: only blocking checks' reads are in orderAfter), but a
  // warning the plan kept reads its table as it is: snapshot that table too.
  for (const n of candidates) {
    const s = byName.get(n)!;
    for (const x of [...readsOf(s), ...s.checks.flatMap((c) => c.reads)]) if (x !== n) needs.add(x);
  }

  mkdirSync(stateDir, { recursive: true });
  const dir = previewDirectory(stateDir);
  const pdb = openWarehouse({
    path: previewDatabasePath(stateDir), mode: "read_write", writeIntent: false, register: false, label: "the preview database",
    timezone: tz, root: project.root, stateDir, isTTY: i.interactive === true,
    // Lock waits: 60 s on a terminal, 90 s off it (§5 "Default waits"), for writes too.
    waits: { ttyWriteMs: 60_000 },
    ...(i.onWait ? { onWait: (h: LockHolder, ms: number) => i.onWait!(h, ms, "the preview database") } : {}),
  });
  const live = existsSync(project.paths.database)
    ? openWarehouse({
      path: project.paths.database, mode: "read_only", timezone: tz, root: project.root, stateDir, isTTY: i.interactive === true,
      ...(i.onWait ? { onWait: (h: LockHolder, ms: number) => i.onWait!(h, ms, "the warehouse") } : {}),
      ...(i.lookupHolder ? { lookupHolder: i.lookupHolder } : {}),
    })
    : null;
  const runId = `p${newRunId(clock(), tz).slice(1)}`;
  try {
    // The whole preview holds the preview database, so no other preview (or query --preview) sees it half made.
    return await pdb.read(async () => {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(join(dir, "logs"), { recursive: true });
      await emptyPreview(pdb, runId, i.signal);
      const runs = RunsDb.open(dir);
      try {
        const snap = await snapshotLive(live, [...needs], dir, clock, i.signal);
        const pureInputs = [...needs].filter((n) => !candidates.includes(n));
        await prepare(pdb, snap, pureInputs, runId, i.signal);
        const engine = new Engine(i, { plan, byName, named, snap, pdb, runs, runId, dir, cap, mirror });
        for (const name of candidates) await engine.visit(name);
        return engine.finish(snap.at ? formatInstant(snap.at, tz) : null);
      } finally {
        runs.close();
      }
    }, { purpose: "croft preview", ...(i.signal ? { signal: i.signal } : {}) });
  } finally {
    rmSync(join(stateDir, "staging", runId), { recursive: true, force: true });
    await pdb.close();
    await live?.close();
  }
}

/** --rows as a preview takes it: a whole number from 1 to MAX_PREVIEW_ROWS; DEFAULT_PREVIEW_ROWS when not
 *  given. `typed`: the flag's text, for the message. */
export function previewRows(rows: number | undefined, typed = String(rows)): number {
  if (rows === undefined) return DEFAULT_PREVIEW_ROWS;
  if (!Number.isInteger(rows) || rows < 1) {
    throw new CroftError("USAGE_ERROR", {
      message: `--rows needs a whole number of rows, 1 or more; got ${JSON.stringify(typed)}`,
      hint: "for example --rows 200",
      fix: { kind: "manual", description: "pass --rows with a whole number, such as --rows 200" },
    });
  }
  if (rows > MAX_PREVIEW_ROWS) {
    throw new CroftError("USAGE_ERROR", {
      message: `--rows is at most ${MAX_PREVIEW_ROWS.toLocaleString("en-US")}; got ${JSON.stringify(typed)}`,
      hint: `a preview is a sample: pass --rows ${DEFAULT_PREVIEW_ROWS} or leave it out; a real run (croft run) processes everything`,
      fix: { kind: "manual", description: `pass --rows ${MAX_PREVIEW_ROWS} or fewer` },
    });
  }
  return rows;
}

/** The plan `croft run <assets>` would make, from the catalog mirror. A name that is not an asset gets its
 *  did-you-mean fix for preview, not run. */
async function planFor(i: PreviewInput, mirror: readonly CatalogAsset[]): Promise<RunPlan> {
  try {
    return await planRun({
      root: i.project.root, timezone: i.project.timezone, selectors: i.selectors, catalog: mirror, cursorTypes: cursorTypesOf(mirror),
      ...(i.importTimeoutMs !== undefined ? { importTimeoutMs: i.importTimeoutMs } : {}),
    });
  } catch (e) {
    const err = croftError(e);
    const fix = err?.problem.fix;
    if (err && fix?.kind === "command" && fix.command.startsWith("croft run ")) {
      const guess = fix.command.slice("croft run ".length);
      err.problem.fix = { ...fix, description: `preview ${guess}`, command: `croft preview ${guess}` };
    }
    throw e;
  }
}

/** What a step reads: its inputs and the tables its checks read, itself aside. */
function readsOf(step: PlannedStep): string[] {
  return [...new Set([...step.inputs, ...step.orderAfter])].filter((x) => x !== step.asset);
}

// ---------------------------------------------------------------------------------------------------------
// The preview database and the snapshot

/** Drop everything the last preview left in the preview database. */
async function emptyPreview(pdb: DuckWarehouse, runId: string, signal?: AbortSignal): Promise<void> {
  await pdb.write("empty the preview", async (tx) => {
    const objects = await tx.all<{ name: string; kind: string }>(
      `SELECT view_name AS name, 'VIEW' AS kind FROM duckdb_views() WHERE database_name = current_database() AND schema_name = 'main' AND NOT internal
       UNION ALL
       SELECT table_name, 'TABLE' FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = 'main' AND NOT internal`);
    for (const o of objects) await tx.exec(`DROP ${o.kind} IF EXISTS main.${quoteIdent(o.name)}`);
    await tx.exec(`DROP SCHEMA IF EXISTS ${quoteIdent(LIVE_SCHEMA)} CASCADE`);
    await tx.exec(`DROP SCHEMA IF EXISTS _croft CASCADE`);
  }, { runId, transaction: false, ...(signal ? { signal } : {}) });
}

/** A table's columns with DuckDB's own type names (verbatim: STRUCT field names and ENUM values keep their case). */
async function rawColumns(db: Sql, table: string, schema = "main"): Promise<RawColumn[] | null> {
  const rows = await db.all<RawColumn>(
    `SELECT column_name AS name, data_type AS type FROM duckdb_columns()
     WHERE database_name = current_database() AND schema_name = $1 AND table_name = $2 ORDER BY column_index`, [schema, table]);
  return rows.length ? rows : null;
}

/**
 * Copy every live table in `names` (the ones that exist) to <dir>/<name>.parquet, and their _croft rows to
 * <dir>/_croft/<table>.parquet, under ONE read lease: the snapshotTable leases nest inside it, so the file stays
 * open throughout and no run can write between two copies.
 */
async function snapshotLive(live: DuckWarehouse | null, names: readonly string[], dir: string, now: () => Date, signal?: AbortSignal): Promise<LiveSnapshot> {
  const out: LiveSnapshot = { at: null, tables: new Map(), state: {} };
  if (!live || names.length === 0) return out;
  const base = canonicalPath(dir);
  return live.read(async (db) => {
    out.at = now();
    const tmp = join(base, "_tmp");
    for (const name of [...names].sort()) {
      const columns = await rawColumns(db, name);
      if (!columns) continue;
      const snap = await snapshotTable(live, name, join(tmp, name), signal);
      if (!snap.path) continue;
      const path = join(base, `${name}.parquet`);
      renameSync(snap.path, path);
      out.tables.set(name, { name, columns, path });
    }
    rmSync(tmp, { recursive: true, force: true });
    if (await hasState(db)) {
      mkdirSync(join(base, "_croft"), { recursive: true });
      const list = names.map(quoteLiteral).join(", ");
      for (const [table, column] of Object.entries(STATE_COPIES) as [StateTable, string][]) {
        const path = join(base, "_croft", `${table}.parquet`);
        await db.exec(`COPY (SELECT * FROM _croft.${table} WHERE ${column} IN (${list})) TO ${quoteLiteral(path)} (FORMAT parquet)`);
        out.state[table] = path;
      }
    }
    return out;
  }, { purpose: "snapshot the tables a preview reads", ...(signal ? { signal } : {}) });
}

/** A view that reads a snapshot back with the live column types (HUGEINT was stored as text, ENUM and BIT as
 *  VARCHAR, fixed-size arrays as lists: every column is cast back to what the live table has). */
function viewSql(schema: string, t: LiveTable): string {
  const cols = t.columns.map((c) => `CAST(${quoteIdent(c.name)} AS ${c.type}) AS ${quoteIdent(c.name)}`).join(", ");
  return `CREATE OR REPLACE VIEW ${quoteIdent(schema)}.${quoteIdent(t.name)} AS SELECT ${cols} FROM read_parquet(${quoteLiteral(t.path)})`;
}

/** Insert a snapshot's _croft rows for `assets` into the preview's _croft (by name: a live database at an older
 *  format lacks a column or two). */
async function copyState(tx: Sql, snap: LiveSnapshot, table: StateTable, assets: readonly string[]): Promise<void> {
  const path = snap.state[table];
  if (!path || assets.length === 0) return;
  await tx.exec(`INSERT INTO _croft.${table} BY NAME SELECT * FROM read_parquet(${quoteLiteral(path)})
    WHERE ${STATE_COPIES[table]} IN (${assets.map(quoteLiteral).join(", ")})`);
}

/** The preview database's starting point: croft's state, live.<asset> for every live table snapshotted, and
 *  main.<input> (with its _croft.assets row) for each input the preview does not build. */
async function prepare(pdb: DuckWarehouse, snap: LiveSnapshot, pureInputs: readonly string[], runId: string, signal?: AbortSignal): Promise<void> {
  await pdb.write("prepare the preview", async (tx) => {
    await ensureState(tx);
    await tx.exec(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(LIVE_SCHEMA)}`);
    const inputs = pureInputs.filter((n) => snap.tables.has(n));
    for (const t of snap.tables.values()) {
      await tx.exec(viewSql(LIVE_SCHEMA, t));
      if (inputs.includes(t.name)) await tx.exec(viewSql("main", t));
    }
    await copyState(tx, snap, "assets", inputs);
  }, { runId, ...(signal ? { signal } : {}) });
}

// ---------------------------------------------------------------------------------------------------------
// Building

interface EngineContext {
  plan: RunPlan;
  byName: Map<string, PlannedStep>;
  named: Set<string>;
  snap: LiveSnapshot;
  pdb: DuckWarehouse;
  runs: RunsDb;
  runId: string;
  dir: string;
  cap: number;
  mirror: readonly CatalogAsset[];
}

class Engine {
  readonly entries = new Map<string, Entry>();
  readonly problems: Problem[] = [];

  constructor(private readonly i: PreviewInput, private readonly c: EngineContext) {
    this.problems.push(...c.plan.problems);
  }

  private get project(): Project {
    return this.i.project;
  }

  /** Decide what to do with one candidate (in run order), and do it. */
  async visit(name: string): Promise<void> {
    const { byName, named, snap } = this.c;
    const step = byName.get(name)!;
    const isNamed = named.has(name);
    const liveTable = snap.tables.get(name) ?? null;
    const mode = modeOf(step, liveTable !== null, this.i.rebuild === true && isNamed);
    const entry: Entry = { step, named: isNamed, mode, state: "skipped", partial: false, asset: emptyAsset(step) };
    this.entries.set(name, entry);
    if (this.i.signal?.aborted) return this.skip(entry, "the preview was interrupted before it reached this asset");
    // A file renamed outside croft, or what needs it, taken by a glob: never built from scratch, as in a run (plan.ts).
    // Named exactly, its ASSET_RENAMED fails it below, like any static error.
    if (step.renamed && step.action === "skip") {
      const why = skipProblem(step);
      if (why) this.problems.push(why);
      return this.skip(entry, step.reason);
    }

    // Inputs: built here, or read from the live snapshot (so is a downstream asset the preview only listed).
    const reads = readsOf(step);
    const builtInputs = reads.filter((x) => usable(this.entries.get(x)));
    // An SQL input the plan rebuilds first because an asset of the preview reads its new output
    // (PlannedStep.neededBy) is built from the snapshots, as a named one is, so its reader previews against its new columns.
    if (!isNamed && !step.neededBy?.length) {
      // SQL downstream of what the preview built: only from complete, non-ingest previews that passed their checks.
      const why = this.downstreamBlock(reads, builtInputs);
      if (why) return this.list(entry, why);
    }
    // A static error (a load error, a bind error, CHECK_INVALID, CYCLE) fails the asset before it runs, as in a run.
    const errors = loadErrors(step);
    if (errors.length) return this.fail(entry, errors[0]!, []);
    for (const x of reads) {
      const e = this.entries.get(x);
      if (usable(e)) continue;
      if (e && e.state !== "listed") return this.skip(entry, `input ${x} ${e.state === "skipped" ? "was not built" : "failed"} in this preview`);
      if (!snap.tables.has(x)) return this.notBuilt(entry, x);
    }
    this.problems.push(...step.problems.filter((p) => p.severity !== "error"));
    await this.build(entry, builtInputs);
  }

  /** Why SQL downstream is not built: an input of it failed here, or one it reads from this preview is partial or
   *  an ingest. */
  private downstreamBlock(reads: readonly string[], builtInputs: readonly string[]): string | null {
    const failed = reads.find((x) => {
      const e = this.entries.get(x);
      return e !== undefined && (e.state === "failed" || e.state === "skipped" || (e.state === "built" && e.asset.status === "failed"));
    });
    if (failed) return `input ${failed} failed or was not built in this preview`;
    if (builtInputs.length === 0) return "none of its inputs was built in this preview";
    for (const x of builtInputs) {
      const e = this.entries.get(x)!;
      if (e.step.kind === "rows" || e.step.kind === "file") return `downstream of the ingest ${x}: not built from a partial sample`;
      if (e.partial) return `downstream of ${x}, whose preview is partial: not built from a partial sample`;
    }
    return null;
  }

  /** A downstream asset the preview lists but does not build: its readers read its live table. */
  private async list(entry: Entry, why: string): Promise<void> {
    entry.state = "listed";
    entry.asset = { ...entry.asset, status: "skipped", reason: why };
    const t = this.c.snap.tables.get(entry.step.asset);
    if (!t) return;
    try {
      await this.c.pdb.write(`read ${t.name} from live`, async (tx) => {
        await tx.exec(viewSql("main", t));
        await copyState(tx, this.c.snap, "assets", [t.name]);
      }, { runId: this.c.runId, ...(this.i.signal ? { signal: this.i.signal } : {}) });
    } catch {
      // Interrupted: an asset that reads it is skipped as not built.
      this.c.snap.tables.delete(t.name);
    }
  }

  private skip(entry: Entry, why: string): void {
    entry.state = "skipped";
    entry.asset = { ...entry.asset, status: "skipped", reason: why };
  }

  /** An input with no live table and no build in this preview: INPUT_NOT_BUILT, with the preview that builds it. */
  private notBuilt(entry: Entry, input: string): void {
    const asset = entry.step.asset;
    this.skip(entry, `input ${input} is not built yet`);
    const both = `croft preview ${input} ${asset}`;
    this.problems.push(problem("INPUT_NOT_BUILT", {
      asset, file: entry.step.file,
      message: `${asset} reads ${input}, which has no table yet, so it was not built`,
      hint: `preview ${input} along with it (${both}), or build ${input} first (croft run ${input})`,
      fix: { kind: "command", description: `preview ${input} and ${asset} together`, command: both },
      details: { input },
    }));
  }

  private fail(entry: Entry, p: Problem, checks: StepResult["checks"]): void {
    entry.state = "failed";
    const error = { ...p, asset: p.asset ?? entry.step.asset };
    entry.asset = { ...entry.asset, status: "failed", reason: `${error.code}: ${error.message.split("\n")[0]}`, checks, error };
    this.problems.push(error);
  }

  private async build(entry: Entry, builtInputs: readonly string[]): Promise<void> {
    const { step } = entry;
    const asset = step.asset;
    const { pdb, runs, runId, cap, snap } = this.c;
    const liveTable = snap.tables.get(asset) ?? null;
    const signal = this.i.signal;
    const at = { runId, ...(signal ? { signal } : {}) };
    // The starting point: the live table and its state (copy), or only its column record, for typing (fresh).
    try {
      await pdb.write(`prepare ${asset}`, async (tx) => {
        if (entry.mode === "copy" && liveTable) {
          await tx.exec(`CREATE TABLE main.${quoteIdent(asset)} (${liveTable.columns.map((c) => `${quoteIdent(c.name)} ${c.type}`).join(", ")})`);
          await tx.exec(`INSERT INTO main.${quoteIdent(asset)} SELECT * FROM ${quoteIdent(LIVE_SCHEMA)}.${quoteIdent(asset)}`);
          for (const t of Object.keys(STATE_COPIES) as StateTable[]) await copyState(tx, snap, t, [asset]);
        } else if (step.kind !== "sql" && liveTable) {
          await copyState(tx, snap, "columns", [asset]);
        }
      }, at);
    } catch (e) {
      return this.fail(entry, (croftError(e) ?? internal(e)).problem, []);
    }

    this.i.onProgress?.(`${asset}: ${DOING[step.kind]}…`);
    const started = Date.now();
    const log = new LogWriter(join(this.c.dir, "logs", `${asset}.log`), { redact: (t) => this.i.env.redact(t) });
    for (const line of step.output ?? []) log.write(line);
    log.write(`${new Date().toISOString()} preview of ${asset} (${runId}): ${step.behavior}`);
    const progress = new StepProgress(asset);
    const stepAc = new AbortController();
    const stepSignal = signal ? AbortSignal.any([signal, stepAc.signal]) : stepAc.signal;
    const timeoutMs = this.i.timeoutMs ?? step.timeoutMs;
    const watchdog = setInterval(() => {
      if (progress.paused || stepAc.signal.aborted) return;
      if (Date.now() - progress.lastAt >= timeoutMs) stepAc.abort(timeoutError(step, timeoutMs, progress));
    }, Math.max(10, Math.min(1000, Math.floor(timeoutMs / 4))));
    const fetch = { capped: false };
    let out: StepOutcome;
    // The rows of each input a transform gets, and the confirmAbove that lowered them below --rows.
    let rows = cap;
    let fitted: number | undefined;
    try {
      // The cost guard (§5): a transform that makes requests is handed at most its confirmAbove input rows. Without
      // --rows the cap is lowered to fit; an explicit --rows over it is refused before any of its code runs.
      const g = step.kind === "transform" ? await previewGuard(step, pdb, cap, stepSignal) : null;
      if (g && g.pending > g.limit) {
        if (this.i.rows !== undefined || g.fits < 1) throw previewReprocess(step, g, cap, { rebuild: this.i.rebuild === true });
        rows = g.fits;
        fitted = g.limit;
        log.write(`at most ${rows} rows of each input: ${asset} makes requests, and ${cap} rows of each would be ${g.pending} input rows, more than its confirmAbove of ${g.limit}`);
      }
      const input: StepInput = {
        step: previewStep(step, rows, fetch), project: this.project, env: this.i.env, warehouse: pdb, runs, runId, attempt: 1, maxAttempts: 1,
        signal: stepSignal, progress, log, preview: { rows },
        ...readByOf(step, this.c.mirror.find((m) => m.asset === asset) ?? null),
        ...(this.i.http ? { http: this.i.http } : {}), ...(this.i.now ? { now: this.i.now } : {}),
      };
      out = step.kind === "sql" ? await runSqlStep(input) : step.kind === "transform" ? await runTransform(input) : await runIngest(input);
    } catch (e) {
      const err = croftError(e) ?? internal(e);
      log.write(`${err.code}: ${err.message}${err.problem.hint ? `\nhint: ${err.problem.hint}` : ""}`);
      this.fail(entry, { ...err.problem, asset: err.problem.asset ?? asset }, []);
      if (progress.requests > 0) entry.asset.requests = progress.requests;
      entry.asset.durationMs = Date.now() - started;
      // No table of a failed build: the live copy it started from would read as the preview's.
      if (!stepSignal.aborted) {
        await pdb.write(`drop ${asset}`, (tx) => tx.exec(`DROP TABLE IF EXISTS main.${quoteIdent(asset)}`), { runId }).catch(() => {});
      }
      return;
    } finally {
      clearInterval(watchdog);
      progress.close();
      log.close();
    }
    if (out.catalog) putCatalog(runs, out.catalog, "preview");
    const r = out.result;
    entry.state = "built";
    const ingest = step.kind === "rows" || step.kind === "file";
    const capped = ingest ? fetch.capped : step.kind === "transform" && /inputs capped at/.test(r.reason);
    const fromPartial = builtInputs.some((x) => this.entries.get(x)!.partial);
    entry.partial = capped || fromPartial || (step.kind === "transform" && entry.mode === "copy");
    const warnings = out.warnings.filter((w) => !(entry.mode === "fresh" && w.asset === asset && FRESH_NOISE.has(w.code)));
    this.problems.push(...warnings.map((w) => ({ ...w, asset: w.asset ?? asset })), ...out.problems);

    let d: Described;
    try {
      d = await pdb.read((db) => this.describe(db, entry, out, { capped, liveTable }), { purpose: `compare ${asset} with live`, ...(signal ? { signal } : {}) });
    } catch (e) {
      // Its table is there to explore, but what it means is unknown: the asset fails (its readers are skipped).
      this.fail(entry, { ...(croftError(e) ?? internal(e)).problem, asset }, []);
      entry.asset.durationMs = Date.now() - started;
      return;
    }
    // A fetch from the saved position (copy); one from scratch (--rebuild, a replace ingest, a first load) has none.
    const since = ingest && entry.mode === "copy" ? sinceOf(step, r, this.c.mirror, this.project.timezone, (this.i.now ?? clockNow)()) : undefined;
    const requests = r.requests !== undefined && (ingest || r.requests > 0) ? r.requests : undefined;
    entry.asset = {
      ...entry.asset, status: d.failed ? "failed" : "ok", reason: reasonOf(entry, { capped, cap: rows, ...(fitted !== undefined ? { fitted } : {}), builtInputs, rebuild: this.i.rebuild === true, result: r, since }),
      rows: d.rows, liveRows: d.liveRows, partial: entry.partial, capped, ...(requests !== undefined ? { requests } : {}),
      ...(since !== undefined ? { since } : {}), diff: d.diff, columns: d.columns, checks: d.checks, sample: d.sample,
      durationMs: Date.now() - started,
      ...(d.failed ? { error: d.failed } : {}),
    };
    this.problems.push(...d.problems);
    if (d.failed) this.problems.push(d.failed);
    // A replace ingest that fetched everything and would lose more than half its rows: the real run stops.
    if (ingest && step.write === "replace" && !capped && d.liveRows !== null && d.rows !== null && wouldShrink(d.liveRows, d.rows)) {
      this.problems.push({
        ...problem("SHRINK_GUARD", {
          asset, file: step.file,
          message: `a real run of ${asset} would stop: it would go from ${d.liveRows} rows to ${d.rows}, and croft does not let a replace ingest remove more than half of its rows`,
          hint: "an expired token or a changed filter often returns few or no rows; check what the source returned before running it",
          details: { rowsBefore: d.liveRows, rowsAfter: d.rows },
        }),
        severity: "warning",
      });
    }
  }

  /** Rows, the diff with live, column changes, checks and a sample, on a read lease of the preview database. */
  private async describe(db: LeaseSql, entry: Entry, out: StepOutcome, o: { capped: boolean; liveTable: LiveTable | null }): Promise<Described> {
    const { step } = entry;
    const asset = step.asset;
    const t = `main.${quoteIdent(asset)}`;
    const pCols = await rawColumns(db, asset);
    const lCols = o.liveTable ? o.liveTable.columns : null;
    const liveRows = o.liveTable ? await countOf(db, `${quoteIdent(LIVE_SCHEMA)}.${quoteIdent(asset)}`) : null;
    const r = out.result;
    if (!pCols) {
      // Nothing was written (a file ingest whose files did not change).
      return { rows: 0, liveRows, diff: { by: [...step.key], added: 0, removed: 0, changed: 0, unchanged: 0 }, columns: [], checks: [], sample: [], problems: [], failed: null };
    }
    const problems: Problem[] = [];
    const stored = await storedPending(db, asset);
    const columns = columnChanges(pCols, lCols, stored, step.kind === "sql" && entry.mode === "fresh");
    const cmp = comparison(asset, step.key, pCols, lCols);
    let diff: PreviewAsset["diff"];
    if (entry.mode === "copy") {
      diff = { by: [...step.key], added: r.rows.added, removed: r.rows.deleted, changed: r.rows.updated, unchanged: r.rows.unchanged };
    } else {
      try {
        diff = await freshDiff(db, cmp, { live: o.liveTable !== null, complete: !entry.partial });
      } catch (e) {
        // A column type DuckDB cannot compare, say: the build stands, only the diff is missing.
        diff = null;
        problems.push({
          ...problem("QUERY_FAILED", {
            asset, file: step.file,
            message: `${asset} was built, but could not be compared with its live table: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`,
            hint: `compare them yourself: croft query --preview "from ${asset}" and "from ${LIVE_SCHEMA}.${asset}"`,
          }),
          severity: "warning",
        });
      }
    }
    const rows = entry.mode === "copy" ? r.rows.in : await countOf(db, t);
    const stamp = await writeStamp(db, asset, this.c.runId);
    const checks = stamp ? await this.checks(db, entry, { stamp, rows: r.rows }) : { results: [], problems: [], failed: null };
    const sample = await sampleRows(db, cmp, { stamp: entry.mode === "copy" ? stamp : null, live: o.liveTable !== null && diff !== null });
    return { rows, liveRows, diff, columns, checks: checks.results, sample, problems: [...problems, ...checks.problems], failed: checks.failed };
  }

  /**
   * Every check and warning on the preview table, with the scope a real run would give it (checks/run.ts): the
   * blocking ones through checksHook, whose CHECK_FAILED is the asset's failure (worded for a preview), the rest
   * through runWarnings. min_rows says nothing about a partial table built from scratch, so it is left out there.
   */
  private async checks(db: LeaseSql, entry: Entry, o: { stamp: string; rows: StepResult["rows"] }): Promise<{ results: StepResult["checks"]; problems: Problem[]; failed: Problem | null }> {
    const { step } = entry;
    const asset = step.asset;
    const list = step.checks.filter((c) => !(entry.partial && entry.mode === "fresh" && c.kind === "min_rows"));
    const previous = this.previousChecks(asset);
    const ctx = { asset, table: `main.${quoteIdent(asset)}`, loadedAt: o.stamp, rows: o.rows };
    const results: StepResult["checks"] = [];
    const problems: Problem[] = [];
    let failed: Problem | null = null;
    const blocking = list.filter((c) => c.blocking);
    if (blocking.length) {
      try {
        const r = await checksHook(blocking, { file: step.file, previous })(db, { ...ctx, batch: "" });
        if (r && !Array.isArray(r)) results.push(...r.results);
      } catch (e) {
        const err = croftError(e);
        if (!err || (err.code !== "CHECK_FAILED" && err.code !== "CHECK_INVALID")) throw e;
        const got = err.problem.details?.results;
        results.push(...(Array.isArray(got) ? got as StepResult["checks"] : [{ check: String(err.problem.details?.check ?? "?"), ok: false }]));
        failed = forPreview(err.problem, step);
      }
    }
    const w = await runWarnings(db, ctx, list, { file: step.file, previous });
    results.push(...w.results);
    problems.push(...w.problems.map((p) => ({ ...p, asset: p.asset ?? asset })));
    return { results, problems, failed };
  }

  /** The check sources of the asset's last ok step in the live runs.sqlite (a new or edited check covers the whole
   *  table), or null when it never ran. runs.sqlite is only read; it is not created. */
  private previousChecks(asset: string): string[] | null {
    const stateDir = this.project.paths.stateDir;
    if (!existsSync(join(stateDir, "runs.sqlite"))) return null;
    const db = RunsDb.open(stateDir);
    try {
      return db.lastCheckSources(asset);
    } finally {
      db.close();
    }
  }

  /** The result: every asset looked at, in order; approveCode for the ones that built without an error. */
  finish(inputsSnapshotAt: string | null): PreviewOutcome {
    const assets: PreviewAsset[] = [];
    const order = this.c.plan.order.filter((n) => this.entries.has(n));
    for (const name of order) {
      const e = this.entries.get(name)!;
      if (e.state === "listed") continue;
      e.asset.downstream = this.downstreamOf(name);
      assets.push(e.asset);
    }
    const built = order.filter((n) => this.entries.get(n)!.state === "built");
    const namedEntries = order.map((n) => this.entries.get(n)!).filter((e) => e.named);
    const ok = namedEntries.filter((e) => e.state === "built" && e.asset.status === "ok");
    this.approve([...this.entries.values()].filter((e) => e.state === "built" && e.asset.status === "ok"));
    const apply = ok.length === namedEntries.length && ok.length > 0 ? ok.map((e) => e.step.asset) : [];
    const next: PreviewOutcome["next"] = [];
    // A file renamed outside croft: the rename adopts its table (§6: no confirmation), then it previews from there.
    for (const p of this.problems) {
      const fix = p.code === "ASSET_RENAMED" && p.fix?.kind === "command" ? p.fix : null;
      if (fix && !next.some((n) => n.command === fix.command)) next.push({ command: fix.command, reason: fix.description });
    }
    const retry = namedEntries.filter((e) => e.state === "failed" || (e.state === "built" && e.asset.status === "failed"));
    if (retry.length) {
      next.push({ command: `croft preview ${namedEntries.map((e) => e.step.asset).join(" ")}${this.i.rebuild ? " --rebuild" : ""}`, reason: "preview again after the fix" });
    }
    return {
      data: {
        assets, partial: assets.some((a) => a.partial), inputsSnapshotAt, rebuild: this.i.rebuild === true, rowCap: this.c.cap,
      },
      problems: dedupe(this.problems),
      built,
      apply,
      next,
    };
  }

  /** The assets downstream of `name` that this preview did not build (they would update in a real run). */
  private downstreamOf(name: string): string[] {
    const seen = new Set<string>();
    const queue = [...(this.c.byName.get(name)?.readBy ?? [])];
    while (queue.length) {
      const x = queue.shift()!;
      if (seen.has(x) || x === name) continue;
      seen.add(x);
      queue.push(...(this.c.byName.get(x)?.readBy ?? []));
    }
    const order = this.c.plan.order;
    return [...seen].filter((x) => (this.entries.get(x)?.state ?? "listed") === "listed")
      .sort((a, b) => (order.indexOf(a) + 1 || Infinity) - (order.indexOf(b) + 1 || Infinity) || a.localeCompare(b));
  }

  /** A human-initiated preview that built an asset without an error approves its code for the scheduler (§6). */
  private approve(entries: readonly Entry[]): void {
    const hashed = entries.map((e) => [e.step.asset, e.step.codeHash ?? e.step.sql?.codeHash] as const).filter((x): x is readonly [string, string] => !!x[1]);
    if (hashed.length === 0) return;
    const db = RunsDb.open(this.project.paths.stateDir);
    try {
      for (const [asset, hash] of hashed) db.approveCode(asset, hash);
    } finally {
      db.close();
    }
  }
}

/** Warnings a build from scratch raises only because the preview has no table yet where live has one. */
const FRESH_NOISE = new Set(["TABLE_MODIFIED_OUTSIDE_CROFT", "OUT_OF_BAND_CHANGE"]);

/** An entry the preview built a table for that passed its checks: its readers may build from it. */
function usable(e: Entry | undefined): boolean {
  return e?.state === "built" && e.asset.status === "ok";
}

const DOING: Record<PlannedStep["kind"], string> = { rows: "fetching", file: "loading files", sql: "building", transform: "running" };

/**
 * How a build starts (see the top of the file): copy for the steps whose real run adds to the live table (merge
 * and append ingests, incremental TS), unless --rebuild or there is no live table; fresh for everything else.
 */
function modeOf(step: PlannedStep, liveExists: boolean, rebuild: boolean): Mode {
  if (!liveExists || rebuild || step.kind === "sql") return "fresh";
  if (step.kind === "transform") return step.incremental.kind === "new-rows" ? "copy" : "fresh";
  return step.write === "replace" ? "fresh" : "copy";
}

/** The step as the preview runs it: no checks (the preview runs them on its table afterwards), and a rows ingest
 *  whose generator sees ctx.preview and stops after `cap` rows. */
function previewStep(step: PlannedStep, cap: number, fetch: { capped: boolean }): PlannedStep {
  const out: PlannedStep = { ...step, checks: [] };
  const def = step.loaded?.definition;
  const config = def?.config as RowsIngest | undefined;
  if (step.kind !== "rows" || !def || !config || typeof config.rows !== "function") return out;
  const rows = (ctx: IngestContext) => {
    const stop = new AbortController();
    const signal = AbortSignal.any([ctx.signal, stop.signal]);
    const source = config.rows.call(config, Object.freeze({ ...ctx, preview: true, signal }) as IngestContext);
    return capRows(source, cap, () => {
      fetch.capped = true;
      stop.abort(new CroftError("INTERRUPTED", { message: `the preview stopped after --rows ${cap} rows`, hint: "this is not an error: a preview fetches at most --rows rows" }));
    });
  };
  const wrapped = { ...config, rows } as RowsIngest;
  return { ...out, loaded: { ...step.loaded!, definition: { ...def, config: wrapped } } };
}

/**
 * At most `cap` rows of a RowSource (a row or an array of rows per step); `onCap` is called when the source had
 * rows left (or may have: its generator is stopped once `cap` rows are out, without asking for more). Anything
 * that is not a source is passed through, for writeStage to report.
 */
export function capRows(source: unknown, cap: number, onCap: () => void): unknown {
  const isThenable = source !== null && typeof source === "object" && typeof (source as PromiseLike<unknown>).then === "function";
  const iterable = source !== null && typeof source === "object"
    && (typeof (source as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function" || typeof (source as Iterable<unknown>)[Symbol.iterator] === "function");
  if (!isThenable && !iterable) return source;
  return (async function* () {
    if (isThenable) {
      const v = await (source as PromiseLike<unknown>);
      if (Array.isArray(v) && v.length > cap) {
        onCap();
        yield v.slice(0, cap);
      } else yield v;
      return;
    }
    const it = typeof (source as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
      ? (source as AsyncIterable<unknown>)[Symbol.asyncIterator]()
      : (source as Iterable<unknown>)[Symbol.iterator]() as unknown as AsyncIterator<unknown>;
    let n = 0;
    let finished = false;
    try {
      while (n < cap) {
        const step = await it.next();
        if (step.done) {
          finished = true;
          return;
        }
        const v = step.value;
        if (Array.isArray(v)) {
          if (n + v.length > cap) {
            yield v.slice(0, cap - n);
            n = cap;
            onCap();
            return;
          }
          n += v.length;
        } else n += 1;
        yield v;
      }
      onCap();
    } finally {
      if (!finished) await Promise.resolve(it.return?.()).catch(() => {});
    }
  })();
}

/** Downstream readers per column (COLUMN_STOPPED_ARRIVING), from the live catalog entry. */
function readByOf(step: PlannedStep, entry: CatalogAsset | null): { readBy?: Record<string, string[]> } {
  if (!step.readBy.length || !entry) return {};
  const readBy: Record<string, string[]> = {};
  for (const c of entry.columns) if (!isReservedColumn(c.name)) readBy[c.name] = [...step.readBy];
  return { readBy };
}

/** The saved position an ingest fetched from: what the write recorded, else what the catalog mirror says. */
function sinceOf(step: PlannedStep, r: StepResult, mirror: readonly CatalogAsset[], timezone: string, now: Date): string | undefined {
  if (r.cursor?.sinceUsed !== undefined) return r.cursor.sinceUsed;
  try {
    const w = windowOf(step, mirror.find((m) => m.asset === step.asset) ?? null, { timezone, now });
    return w ? String(w.sinceValue) : undefined;
  } catch {
    return undefined;
  }
}

/** How the asset was built, in words. `cap`: the rows of each input it got; `fitted`: the confirmAbove that
 *  lowered them below the default --rows. */
function reasonOf(e: Entry, o: { capped: boolean; cap: number; fitted?: number; builtInputs: readonly string[]; rebuild: boolean; result: StepResult; since?: string }): string {
  const { step } = e;
  const parts: string[] = [];
  if (step.kind === "rows" || step.kind === "file") {
    if (o.result.status === "unchanged") parts.push("files unchanged: a run would load nothing");
    else if (step.kind === "file") parts.push(e.mode === "copy" ? "new and changed files" : "every file");
    else if (o.rebuild && e.named) parts.push("fetched from scratch (--rebuild)");
    else parts.push(o.since !== undefined ? `fetched from the saved position (since ${o.since}), which does not move` : "fetched from the start");
    if (o.capped) parts.push(`stopped at --rows ${o.cap}`);
    const h = o.result.csvHeader;
    if (h) {
      const how = { declared: "as declared", sniffed: "detected", known: "matches the stored columns" }[h.from];
      parts.push(h.header ? `CSV header: first line (${how}): ${h.columns.join(", ")}` : `CSV header: none (${how}); the first line is data, columns named ${h.columns.join(", ")}`);
    }
    return parts.join("; ");
  }
  if (step.kind === "transform" && e.mode === "copy") {
    const n = o.result.inputs?.reduce((a, x) => a + x.rows, 0) ?? 0;
    parts.push(`processed ${n} new input row${n === 1 ? "" : "s"} after the saved positions, which do not move`);
  } else parts.push(o.rebuild && e.named ? "rebuilt from scratch" : "built in full");
  const live = readsOf(step).filter((x) => !o.builtInputs.includes(x));
  const from = [...o.builtInputs.map((x) => `the preview of ${x}`), ...(live.length ? [`live ${live.join(", ")}`] : [])];
  if (from.length) parts.push(`from ${from.join(" and ")}`);
  if (o.capped) {
    parts.push(o.fitted !== undefined
      ? `inputs capped at ${o.cap} rows to stay within its confirmAbove of ${o.fitted} (its code makes requests for each row)`
      : `inputs capped at ${o.cap} rows`);
  }
  if (!e.named) parts.push("downstream of the named assets");
  return parts.join("; ");
}

// ---------------------------------------------------------------------------------------------------------
// Comparing with live

interface Described {
  rows: number | null;
  liveRows: number | null;
  diff: PreviewAsset["diff"];
  columns: PreviewColumnChange[];
  checks: StepResult["checks"];
  sample: Row[];
  problems: Problem[];
  failed: Problem | null;
}

/** How the preview table and its live version line up: the key (when both have it) and the data columns both
 *  have, with how to read the live value in the preview's type. */
interface Comparison {
  asset: string;
  key: string[];
  keyed: boolean;
  /** The asset's key as declared (what a table live does not have yet is compared by). */
  declared: string[];
  /** Data columns in both, the key aside: [preview name, SQL for the live value]. */
  columns: { name: string; live: string }[];
  /** Every data column of the preview table, in order. */
  preview: string[];
  /** The key join: preview p, live l. */
  join: string;
}

function comparison(asset: string, key: readonly string[], p: readonly RawColumn[], l: readonly RawColumn[] | null): Comparison {
  const lower = (s: string) => s.toLowerCase();
  const data = p.filter((c) => !isReservedColumn(c.name));
  const liveOf = (c: RawColumn) => l?.find((x) => lower(x.name) === lower(c.name));
  const expr = (c: RawColumn) => {
    const x = liveOf(c)!;
    return x.type === c.type ? `l.${quoteIdent(x.name)}` : `TRY_CAST(l.${quoteIdent(x.name)} AS ${c.type})`;
  };
  const keyCols = key.map((k) => data.find((c) => lower(c.name) === lower(k)));
  const keyed = key.length > 0 && keyCols.every((c) => c && liveOf(c));
  const columns = data.filter((c) => liveOf(c) && !(keyed && key.some((k) => lower(k) === lower(c.name))))
    .map((c) => ({ name: c.name, live: expr(c) }));
  const join = keyed ? keyCols.map((c) => `p.${quoteIdent(c!.name)} = ${expr(c!)}`).join(" AND ") : "false";
  return { asset, key: keyed ? keyCols.map((c) => c!.name) : [], keyed, declared: [...key], columns, preview: data.map((c) => c.name), join };
}

/** Whether the preview row p differs from its live row l in any column both have. */
function differs(c: Comparison): string {
  return c.columns.length ? c.columns.map((x) => `p.${quoteIdent(x.name)} IS DISTINCT FROM ${x.live}`).join(" OR ") : "false";
}

const liveRef = (asset: string) => `${quoteIdent(LIVE_SCHEMA)}.${quoteIdent(asset)}`;
const mainRef = (asset: string) => `main.${quoteIdent(asset)}`;
const LIVE_MARK = "__croft_live";

/**
 * A fresh build against live: by key, the preview's keys that are new (added), differ in a column both tables
 * have (changed) or not (unchanged), and, for a complete build only, the live keys it no longer has (removed).
 * Without a key, whole rows as multisets. A partial build never reports a removal.
 */
async function freshDiff(db: Sql, c: Comparison, o: { live: boolean; complete: boolean }): Promise<NonNullable<PreviewAsset["diff"]>> {
  const by = c.keyed ? c.key : [];
  const total = await countOf(db, mainRef(c.asset));
  if (!o.live) return { by: c.declared, added: total, removed: 0, changed: 0, unchanged: 0 };
  if (c.keyed) {
    const [r] = await db.all<{ added: unknown; changed: unknown; unchanged: unknown }>(
      `SELECT count(*) FILTER (WHERE l.${LIVE_MARK} IS NULL) AS added,
         count(*) FILTER (WHERE l.${LIVE_MARK} AND (${differs(c)})) AS changed,
         count(*) FILTER (WHERE l.${LIVE_MARK} AND NOT (${differs(c)})) AS unchanged
       FROM ${mainRef(c.asset)} AS p LEFT JOIN (SELECT *, true AS ${LIVE_MARK} FROM ${liveRef(c.asset)}) AS l ON ${c.join}`);
    let removed = 0;
    if (o.complete) {
      const [x] = await db.all<{ n: unknown }>(
        `SELECT count(*) AS n FROM ${liveRef(c.asset)} AS l WHERE NOT EXISTS (SELECT 1 FROM ${mainRef(c.asset)} AS p WHERE ${c.join})`);
      removed = Number(x?.n ?? 0);
    }
    return { by, added: Number(r?.added ?? 0), removed, changed: Number(r?.changed ?? 0), unchanged: Number(r?.unchanged ?? 0) };
  }
  const liveCount = await countOf(db, liveRef(c.asset));
  let same = 0;
  if (c.columns.length) {
    const [x] = await db.all<{ n: unknown }>(
      `SELECT count(*) AS n FROM (SELECT ${c.columns.map((x) => `p.${quoteIdent(x.name)}`).join(", ")} FROM ${mainRef(c.asset)} AS p
       INTERSECT ALL SELECT ${c.columns.map((x) => `${x.live} AS ${quoteIdent(x.name)}`).join(", ")} FROM ${liveRef(c.asset)} AS l)`);
    same = Number(x?.n ?? 0);
  }
  return { by, added: total - same, removed: o.complete ? liveCount - same : 0, changed: 0, unchanged: same };
}

/** A few rows of the preview table, rendered as `croft query` renders them: rows this preview wrote (copy), rows
 *  that differ from live (fresh), else the first rows; by key. */
async function sampleRows(db: LeaseSql, c: Comparison, o: { stamp: string | null; live: boolean }): Promise<Row[]> {
  const cols = c.preview.map((n) => `p.${quoteIdent(n)}`).join(", ");
  if (!cols) return [];
  const order = c.keyed ? ` ORDER BY ${c.key.map((k) => `p.${quoteIdent(k)}`).join(", ")}` : "";
  let where = "";
  let from = `${mainRef(c.asset)} AS p`;
  if (o.stamp) where = ` WHERE p.${quoteIdent("_loaded_at")} = ${quoteLiteral(o.stamp)}::TIMESTAMPTZ`;
  else if (o.live && c.keyed) {
    const [n] = await db.all<{ n: unknown }>(
      `SELECT count(*) AS n FROM ${mainRef(c.asset)} AS p LEFT JOIN (SELECT *, true AS ${LIVE_MARK} FROM ${liveRef(c.asset)}) AS l ON ${c.join}
       WHERE l.${LIVE_MARK} IS NULL OR (${differs(c)})`);
    if (Number(n?.n ?? 0) > 0) {
      from = `${mainRef(c.asset)} AS p LEFT JOIN (SELECT *, true AS ${LIVE_MARK} FROM ${liveRef(c.asset)}) AS l ON ${c.join}`;
      where = ` WHERE l.${LIVE_MARK} IS NULL OR (${differs(c)})`;
    }
  }
  return (await db.query(`SELECT ${cols} FROM ${from}${where}${order} LIMIT ${PREVIEW_SAMPLE_ROWS}`, [], "json")).rows;
}

/** Columns that differ between the preview table and live: added (with a note), retyped, and, for SQL built in
 *  full (its SELECT defines the table), removed. A table live does not have lists every column as added. */
function columnChanges(p: readonly RawColumn[], l: readonly RawColumn[] | null, pending: ReadonlySet<string>, removals: boolean): PreviewColumnChange[] {
  const lower = (s: string) => s.toLowerCase();
  const own = (cols: readonly RawColumn[]) => cols.filter((c) => !isReservedColumn(c.name));
  const out: PreviewColumnChange[] = [];
  const live = l ? own(l) : [];
  for (const c of own(p)) {
    const had = live.find((x) => lower(x.name) === lower(c.name));
    if (!had) {
      out.push({ column: c.name, change: "added", type: normalizeType(c.type), ...(pending.has(lower(c.name)) ? { note: "no values yet; typed from its name" } : l ? { note: "new" } : {}) });
    } else if (normalizeType(had.type) !== normalizeType(c.type)) {
      out.push({ column: c.name, change: "retyped", type: normalizeType(c.type), from: normalizeType(had.type) });
    }
  }
  if (removals) {
    for (const c of live) if (!p.some((x) => lower(x.name) === lower(c.name))) out.push({ column: c.name, change: "removed", type: normalizeType(c.type) });
  }
  return out;
}

/** The asset's pending columns (all NULL so far, typed from their names) in the preview's _croft.columns. */
async function storedPending(db: Sql, asset: string): Promise<Set<string>> {
  const rows = await db.all<{ name: string }>(`SELECT name FROM _croft.columns WHERE asset = $1 AND pending`, [asset]);
  return new Set(rows.map((r) => r.name.toLowerCase()));
}

async function countOf(db: Sql, ref: string): Promise<number> {
  const [r] = await db.all<{ n: unknown }>(`SELECT count(*) AS n FROM ${ref}`);
  return Number(r?.n ?? 0);
}

/** The stamp of this preview's write of `asset` (ISO-8601 UTC, microseconds), or null when it wrote nothing. */
async function writeStamp(db: Sql, asset: string, runId: string): Promise<string | null> {
  const [r] = await db.all<{ us: number | bigint | null }>(
    `SELECT epoch_us(max(loaded_at)) AS us FROM _croft.writes WHERE asset = $1 AND run_id = $2`, [asset, runId]);
  return r?.us === null || r?.us === undefined ? null : isoMicros(BigInt(r.us));
}

// ---------------------------------------------------------------------------------------------------------
// Problems

/** A failed check as a preview reports it: a real run would write nothing; the preview table keeps the rows. */
function forPreview(p: Problem, step: PlannedStep): Problem {
  const fix = `correct ${step.file} or the data, then: croft preview ${step.asset}`;
  return {
    ...p, asset: p.asset ?? step.asset, file: p.file ?? step.file,
    hint: `${fix} (croft query --preview shows the failing rows)`,
    fix: p.fix?.kind === "edit" ? p.fix : { kind: "manual", description: fix },
    effect: `a real run would write nothing and ${step.asset} would keep its rows; the preview table keeps the rows it built`,
  };
}

function timeoutError(step: PlannedStep, ms: number, progress: StepProgress): CroftError {
  const mins = ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 100) / 10} s`;
  return new CroftError("TIMEOUT", {
    asset: step.asset, file: step.file,
    message: `${step.asset} made no progress for ${mins}: no row was yielded and no request completed`,
    hint: `check that the API answers; if it is just slow, raise the asset's timeout (e.g. timeout: "30m")`,
    effect: "the preview of this asset stopped; nothing real changed",
    details: { phase: progress.phase, rowsSoFar: progress.rows, lastRequest: progress.lastRequest ?? null, timeoutMs: ms },
  });
}

function internal(e: unknown): CroftError {
  const err = e instanceof Error ? e : new Error(String(e));
  return new CroftError("INTERNAL_ERROR", {
    message: `${err.name}: ${err.message}`,
    hint: "this is a bug in croft, not in your project; report it with the command you ran and this output",
    details: { stack: (err.stack ?? "").split("\n").slice(0, 8) },
  });
}

function dedupe(problems: Problem[]): Problem[] {
  const seen = new Set<string>();
  return problems.filter((p) => {
    const k = `${p.code}\u0000${p.asset ?? ""}\u0000${p.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function emptyAsset(step: PlannedStep): PreviewAsset {
  const kind = step.kind === "sql" ? "sql" : step.kind === "transform" ? "ts" : "ingest";
  return {
    asset: step.asset, kind, status: "skipped", reason: "", rows: null, liveRows: null, partial: false, capped: false,
    diff: null, columns: [], checks: [], sample: [], downstream: [], durationMs: 0,
  };
}
