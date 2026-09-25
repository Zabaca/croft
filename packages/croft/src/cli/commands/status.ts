// croft status [--check] (DESIGN.md §4.1, §4.2, §4.3 "status"; §5 "How commands behave while a run is
// writing", "Versions, staleness and atomicity"; §8 "What a code change does"): the freshness and health of
// every asset, and what is running. It never opens the warehouse, so it never waits on DuckDB: it reads the
// catalog mirror and runs.sqlite (bun:sqlite, WAL, readable while DuckDB is locked), the asset files on disk,
// and for a live run's per-step progress the end of its logs/<run>/events.ndjson.
//
// The asset files are resolved as the planner resolves them (project/resolve.ts: SQL parsed on a private
// in-memory DuckDB, TS assets bundled and imported in isolation), for each asset's kind, code hash and inputs.
// Staleness is run/staleness.ts over those and the catalog mirror: why a bare `croft run` would update the
// asset (never_built, code_changed, input_changed, input_replaced). `edited` says the asset's code differs from
// the code its last run used: the code hash of its latest step that ran (lastRanStep: a skipped step records the
// code the asset had, which never ran), else the catalog's; when either hash is unknown (a file that does not
// bundle, a run that recorded none) the file's modification time since that step decides. An
// edited asset whose table was built by older code also gets EDITED_SINCE_LAST_RUN, worded per kind: an
// incremental TS transform is forward-only, so its warning says how many rows older code built, and names the
// rebuild that redoes them (croft run <asset> --rebuild) as a human's fix.
//
// Scheduling (§8, schedule.ts): `next` is the next fire time for a scheduled ingest while scheduling is on
// ("scheduling off" or "paused" otherwise), "manual" for an ingest without a schedule and "after inputs" for a
// transform. While scheduling is on or paused, the scheduler's view (schedule/due.ts scheduleView, which imports
// no asset code) gives the fire times and the holds: an asset a human must run first is `held` and reported as
// SCHEDULE_HELD (a warning), with `croft run <asset>` as the fix. With scheduling off the view is never read.
// SCHEDULER_STALE (a warning, with the likely cause and the tick log) says the scheduler has not ticked for 3
// minutes while on.
//
// ASSET_RENAMED (§6, project/rename.ts findRenamed): an asset never built whose code hash is an orphan table's (its
// file was renamed outside croft), or a croft rename that stopped, is a problem with the fix `croft rename <old>
// <new>`, and both rows say so instead of "never run (croft run …)", since a run would fetch everything again.
//
// INGEST_CONFIG_CHANGED (§6 "Behavior changes", run/plan.ts pendingBehavior): an ingest whose code now says another
// key, write mode or cursor field than its stored rows were written with (the catalog mirror's) is a problem with the
// run's fixes: an error when the run would fail before it fetches, a warning when it would ask to convert in place.
// Its row says which. An incremental TS transform whose input was replaced since it read it (input_replaced) says
// "input x restored; croft run y --rebuild redoes it" (§6 "Restore"; StatusAsset.replaced): a plain run processes new
// input rows only, so its older rows are redone by the rebuild alone, which a human decides on.
//
// `status` exits 0 because the command worked; `--check` exits 1 when anything is failed, crashed, held or
// stale (the scheduler included), which makes it a health probe. In JSON, ok always means "the command worked" and data.healthy
// carries health.
//
// The catalog mirror says what was built, not that it is still there: status stats the warehouse file (it
// never opens it), and when the catalog has entries but the file is gone (deleted, or moved away from the
// "database" path) it reports DB_NOT_FOUND, is not healthy, and shows what was built as unknown.
//
// With readCopy on (§5), data.readCopy says where the read copy is and how current (db/readcopy.ts
// readCopyStatus: a stat and runs.sqlite), and a line under the scheduling line says it in words. A refresh that
// failed, or a copy older than the last run that wrote data, is a warning there with a hint naming
// .croft/readcopy.log (R32-11). It is not an asset's health, so `healthy` does not change.
//
// Drift (§7, history/drift.ts): the COLUMN_STOPPED_ARRIVING, JSON_KIND_CHANGED and TYPE_WIDENED warnings runs of the
// last 7 days recorded in their summaries are each asset's `drift`, and a short note on its row ("drift: login stopped
// arriving (2 h ago)"). They were warnings of those runs; they do not change `healthy`.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { CroftError, problem } from "../../core/errors.ts";
import { formatInstant, parseInstant } from "../../core/time.ts";
import { recordAlive } from "../../core/proc.ts";
import type { AssetKind, Problem, Reason } from "../../core/types.ts";
import { readCopyStatus, readCopyView, type ReadCopyView, readCopyWords } from "../../db/readcopy.ts";
import { allCatalog, type CatalogAsset } from "../../history/catalog.ts";
import { type DriftEntry, driftNote, recentDrift } from "../../history/drift.ts";
import { logDir, tail } from "../../history/logs.ts";
import { RUNS_DB_FILE, RunsDb, type RunRecord, type StepRecord } from "../../history/runs-db.ts";
import { discoverAssets, type DiscoveredAsset } from "../../project/discover.ts";
import type { ResolvedAsset, ResolvedProject } from "../../project/resolve.ts";
import type { Project } from "../../project/root.ts";
import { readServeRecord } from "../../read/locate.ts";
import { editedProblem, staleReasons, type StaleView } from "../../run/staleness.ts";
import type { AssetScheduleView, HoldCode } from "../../schedule/due.ts";
import { croftHome, type CroftHome } from "../../schedule/home.ts";
import type { CommandImpl, CommandResult, Ctx, Next } from "../command.ts";
import { formatCount, table } from "../render.ts";
import {
  clockText, defaultScheduleView, fireText, heldProblem, HUMAN_HOLDS, logTailLines, nextFireOf, resumeCommand, type Scheduling, SCHEDULING_OFF,
  schedulingJson, schedulingOf, type SchedulingRecord, type ScheduleViewFn, staleProblem,
} from "./schedule.ts";

export type { Scheduling } from "./schedule.ts";

export interface RunningEntry {
  runId: string;
  asset: string | null;
  pid: number | null;
  since: string;
  phase: string | null;
  rowsFetched: number | null;
}

export interface LastRun { runId: string; at: string; status: string; code: string | null }

/** One row of `croft status`. `status` is the one-word state the STATUS column starts with. */
export interface StatusAsset {
  asset: string;
  kind: AssetKind | null;
  file: string | null;
  /** "unknown": it was built, but the warehouse file is missing (DB_NOT_FOUND), so its table is gone or elsewhere. */
  status: "ok" | "failed" | "crashed" | "interrupted" | "running" | "skipped" | "never_run" | "no_asset_file" | "unknown";
  /** null when never built, or when the warehouse file is missing. */
  rows: number | null;
  lastRun: LastRun | null;
  next: AssetNext;
  /** A bare `croft run` would update it: staleReasons is not empty. */
  stale: boolean;
  /** run/staleness.ts: never_built, code_changed, input_changed, input_replaced. Empty while it runs. */
  staleReasons: Reason[];
  /** The scheduler holds it until a human acts (SCHEDULE_HELD, LARGE_REPROCESS). */
  held: boolean;
  /** Why the scheduler does not run it now, while scheduling is on or paused: a hold that needs a human (held), or
   *  one that passes by itself (leased, paused, backoff). */
  hold?: { code: HoldCode; reason: string };
  /** Its code differs from the code its last run used. */
  edited: boolean;
  filesGone?: string[];
  schemaChangedAt?: string;
  /** An incremental TS transform whose input was replaced since it read it (input_replaced): each such input, and
   *  whether `croft restore` replaced it. A plain run processes new input rows only; `--rebuild` redoes every row. */
  replaced?: { input: string; restored: boolean }[];
  /** Drift its runs of the last 7 days reported (§7), newest first, one per code and column; `at` in the project zone. */
  drift?: { code: DriftEntry["code"]; column: string | null; text: string; at: string; runId: string }[];
}

/**
 * When an asset runs next. "schedule": at the next fire time (scheduling on); "scheduling off" and "paused": a
 * scheduled ingest that the scheduler does not run now; "manual": an ingest without a schedule; "after inputs": a
 * transform; "none": no asset file. `schedule` is the ingest's schedule as written.
 */
export interface AssetNext {
  at: string | null;
  reason: "schedule" | "scheduling off" | "paused" | "manual" | "after inputs" | "none";
  schedule?: string;
}

export interface StatusData {
  healthy: boolean;
  running: RunningEntry[];
  assets: StatusAsset[];
  scheduling: Scheduling;
  serve?: { url: string; pid: number };
  /** With readCopy on: the read copy, and how current it is (health). */
  readCopy?: ReadCopyView;
}

// ---------------------------------------------------------------------------------------------------------
// Helpers shared by status, context, describe and logs

/** runs.sqlite, or null when the project has never run anything (a read-only command creates nothing). */
export function openRunsDb(stateDir: string): RunsDb | null {
  if (!existsSync(join(stateDir, RUNS_DB_FILE))) return null;
  return RunsDb.open(stateDir);
}

/** A runs.sqlite UTC instant in the project zone (ISO-8601 with the offset, §4 "Timestamps"). */
export function zoned(iso: string | null | undefined, tz: string): string | null {
  if (!iso) return null;
  try {
    return formatInstant(iso, tz);
  } catch {
    return iso;
  }
}

/** Epoch milliseconds of an ISO instant (microsecond fractions and offsets included), NaN when it is not one. */
export function epochMs(iso: string): number {
  try {
    return Number(parseInstant(iso) / 1000n);
  } catch {
    return Date.parse(iso);
  }
}

/** "12 s ago", "5 min ago", "3 h ago", "2 days ago". */
export function ago(iso: string | null | undefined, now: Date): string {
  if (!iso) return "—";
  const ms = epochMs(iso);
  if (Number.isNaN(ms)) return "—";
  const s = Math.round((now.getTime() - ms) / 1000);
  if (s < 0) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
  const days = Math.round(s / 86_400);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function runAlive(r: RunRecord): boolean {
  // A missing boot id is unknown, not dead (core/proc.ts recordAlive).
  return recordAlive({ pid: r.pid, procStart: r.procStart, bootId: r.bootId });
}

/** What the run engine reports about a step while it works: the §4.3 ProgressSnapshot fields status shows. */
interface Progress { asset?: string; phase?: string; rowsFetched?: number }

/** The fields of one progress snapshot ({asset, phase, rowsFetched, requests, elapsedMs}) that are usable;
 *  anything else (absent, another shape, a negative count) is left out, so it shows as null. */
function readProgress(p: unknown): Progress {
  if (!p || typeof p !== "object") return {};
  const o = p as Record<string, unknown>;
  return {
    ...(typeof o.asset === "string" && o.asset ? { asset: o.asset } : {}),
    ...(typeof o.phase === "string" && o.phase ? { phase: o.phase.slice(0, 40) } : {}),
    ...(typeof o.rowsFetched === "number" && Number.isSafeInteger(o.rowsFetched) && o.rowsFetched >= 0 ? { rowsFetched: o.rowsFetched } : {}),
  };
}

/** A live run's runs.summary.progress: the newest snapshot of any of its steps (throttled by the run engine). */
function summaryProgress(r: RunRecord): Progress {
  const s = r.summary;
  return s && typeof s === "object" ? readProgress((s as { progress?: unknown }).progress) : {};
}

/** Lines of events.ndjson read back for progress: at one snapshot per step per second, enough for every step
 *  of a run with the default concurrency to appear, and still a small read from the end of the file. */
const EVENT_TAIL_LINES = 2000;

/** The newest progress event of each asset in a live run's events.ndjson (only the tail is read). runs.summary
 *  holds just the newest snapshot of the whole run, so with steps extracting side by side the others' progress
 *  is here. Empty when the file is missing or unreadable. */
function eventProgress(stateDir: string, runId: string): Map<string, Progress> {
  const out = new Map<string, Progress>();
  let lines: string[];
  try {
    lines = tail(join(logDir(stateDir, runId), "events.ndjson"), EVENT_TAIL_LINES).lines;
  } catch {
    return out;
  }
  for (const line of lines) {
    if (!line.includes('"progress"')) continue;
    try {
      const e = JSON.parse(line) as { type?: unknown };
      if (e?.type !== "progress") continue;
      const p = readProgress(e);
      if (p.asset) out.set(p.asset, p);
    } catch {}
  }
  return out;
}

/** Runs still marked running: the live ones as running[] entries (one per running step), and the ids of
 *  those whose process is gone (croft reconcile marks them crashed on the next write).
 *
 *  A step's phase and rowsFetched come from runs.summary.progress when that snapshot is the step's, and
 *  otherwise from the step's newest progress event in the run's events.ndjson (read only when needed, with
 *  `stateDir`); null when neither says. */
export function runningEntries(db: RunsDb | null, tz: string, stateDir?: string): { running: RunningEntry[]; dead: Set<string> } {
  const running: RunningEntry[] = [];
  const dead = new Set<string>();
  if (!db) return { running, dead };
  for (const r of db.runningRuns()) {
    if (!runAlive(r)) {
      dead.add(r.id);
      continue;
    }
    const latest = summaryProgress(r);
    let events: Map<string, Progress> | null = null;
    const progressFor = (asset: string): Progress => {
      const own = latest.asset === asset ? latest : {};
      if (own.phase !== undefined && own.rowsFetched !== undefined) return own;
      events ??= stateDir ? eventProgress(stateDir, r.id) : new Map();
      const logged = events.get(asset) ?? {};
      return { phase: own.phase ?? logged.phase, rowsFetched: own.rowsFetched ?? logged.rowsFetched };
    };
    const steps = db.stepsFor(r.id).filter((s) => s.status === "running");
    if (steps.length === 0) {
      running.push({ runId: r.id, asset: latest.asset ?? null, pid: r.pid, since: zoned(r.startedAt, tz)!, phase: latest.phase ?? null,
        rowsFetched: latest.rowsFetched ?? null });
      continue;
    }
    for (const s of steps) {
      const p = progressFor(s.asset);
      running.push({ runId: r.id, asset: s.asset, pid: r.pid, since: zoned(s.startedAt, tz)!, phase: p.phase ?? null, rowsFetched: p.rowsFetched ?? null });
    }
  }
  return { running, dead };
}

/** A step's status as the user should read it: a step still marked running in a dead run crashed. */
export function effectiveStatus(step: StepRecord, dead: Set<string>): string {
  return step.status === "running" && dead.has(step.runId) ? "crashed" : step.status;
}

/** A schema change recorded in a run's summary (the run engine's StepResults), for when DuckDB is busy. */
export interface SummaryChange { asset: string; runId: string; at: string; change: Record<string, unknown> }

/** Schema changes that runs since `since` recorded in their summaries: the run engine stores the whole
 *  command result ({data: {steps: StepResult[]}}); a bare {steps} is read too. */
export function schemaChangesFromRuns(db: RunsDb | null, since: Date): SummaryChange[] {
  if (!db) return [];
  const out: SummaryChange[] = [];
  for (const r of db.listRuns({ since, limit: 500 })) {
    const summary = r.summary as { steps?: unknown; data?: { steps?: unknown } | null } | null;
    const steps = summary?.data?.steps ?? summary?.steps;
    if (!Array.isArray(steps)) continue;
    for (const s of steps) {
      if (!s || typeof s !== "object") continue;
      const { asset, schemaChanges } = s as { asset?: unknown; schemaChanges?: unknown };
      if (typeof asset !== "string" || !Array.isArray(schemaChanges)) continue;
      for (const c of schemaChanges) {
        if (c && typeof c === "object") out.push({ asset, runId: r.id, at: r.finishedAt ?? r.startedAt, change: c as Record<string, unknown> });
      }
    }
  }
  return out;
}

/**
 * When an asset runs next, without the scheduler's view: an ingest's `schedule` (its text) makes it "scheduling
 * off" or "paused" by the setting; while on, `at` is the next fire (the view's, else the schedule's own).
 */
export function nextOf(kind: AssetKind | null, hasFile: boolean, s?: { state: SchedulingRecord["state"]; schedule?: string | null; at?: string | null }): AssetNext {
  if (!hasFile) return { at: null, reason: "none" };
  if (kind !== null && kind !== "ingest") return { at: null, reason: "after inputs" };
  if (!s?.schedule) return { at: null, reason: "manual" };
  const reason = s.state === "on" ? "schedule" : s.state === "paused" ? "paused" : "scheduling off";
  return { at: reason === "schedule" ? s.at ?? null : null, reason, schedule: s.schedule };
}

/**
 * The latest step of an asset that ran its code, finished or not: ok, unchanged, failed, interrupted, crashed or
 * running. A skipped step never ran it, though the runner records it with the code the asset had then: attempt 0
 * when its input failed, or an attempt that stopped for a confirmation (runner.ts). null when none ran.
 */
export function lastRanStep(db: RunsDb, asset: string): StepRecord | null {
  const row = db.sqlite
    .query(`SELECT run_id, asset, attempt FROM steps WHERE asset = ? AND attempt >= 1 AND status <> 'skipped'
            ORDER BY started_at DESC, attempt DESC LIMIT 1`)
    .get(asset) as { run_id: string; asset: string; attempt: number } | null;
  return row ? db.getStep(row.run_id, row.asset, row.attempt) : null;
}

function serveOf(stateDir: string): { url: string; pid: number } | undefined {
  const rec = readServeRecord(stateDir);
  if (!rec) return undefined;
  let alive: boolean;
  if (rec.procStart) alive = recordAlive({ pid: rec.pid, procStart: rec.procStart, bootId: rec.bootId ?? null });
  else {
    try {
      process.kill(rec.pid, 0);
      alive = true;
    } catch (e) {
      alive = (e as NodeJS.ErrnoException).code === "EPERM";
    }
  }
  return alive ? { url: rec.url, pid: rec.pid } : undefined;
}

const FAILED = new Set(["failed", "crashed", "interrupted"]);
const DAY_MS = 86_400_000;

/** What runs.sqlite knows about the warehouse without opening it: how many runs there were, and how many
 *  tables the catalog mirror says were built (an entry is written only after a committed write). */
export interface WarehouseHistory { runs: number; built: number; lastLoadedAt: string | null }

export function warehouseHistory(db: RunsDb | null, catalog: readonly CatalogAsset[] = db ? allCatalog(db) : []): WarehouseHistory {
  const runs = db ? (db.sqlite.query("SELECT count(*) AS n FROM runs").get() as { n: number }).n : 0;
  const lastLoadedAt = catalog.map((c) => c.lastLoadedAt).filter((x): x is string => !!x).sort().pop() ?? null;
  return { runs, built: catalog.length, lastLoadedAt };
}

/** DB_NOT_FOUND for a warehouse file that is gone although croft built it before (the catalog lists tables).
 *  null while the file is there, or when nothing was ever built (then a missing file is simply "not yet"). */
export function missingWarehouse(project: Project, history: WarehouseHistory, tz: string): Problem | null {
  if (history.built === 0 || existsSync(project.paths.database)) return null;
  const label = project.databaseLabel;
  const when = zoned(history.lastLoadedAt, tz);
  return problem("DB_NOT_FOUND", {
    message: `${label} is missing: croft built it before (${history.built} table${history.built === 1 ? "" : "s"} recorded in runs.sqlite${when ? `, last written ${when}` : ""}), so it was deleted or moved`,
    hint: `ask the user where ${label} went and put it back (or point "database" in croft.json at it); running an asset instead starts a new, empty warehouse and refetches everything from the sources`,
    fix: { kind: "manual", description: `restore ${label}, or ask the user whether to rebuild it from the sources`, requiresHuman: true },
    effect: "nothing was written",
    details: { path: project.paths.database, builtTables: history.built, runs: history.runs, lastLoadedAt: when },
  });
}

export interface ProjectState {
  data: StatusData;
  /** About the project: DB_NOT_FOUND, discovery's problems, CYCLE, a project that could not be resolved. */
  problems: Problem[];
  /** EDITED_SINCE_LAST_RUN, one per edited asset whose table older code built, in name order. */
  edited: Problem[];
  /** SCHEDULER_STALE, then SCHEDULE_HELD per held asset; a warning when the scheduler's view could not be read. */
  scheduling: Problem[];
  discovered: DiscoveredAsset[];
  /** The asset files resolved (kinds, code hashes, inputs, the graph); null when that failed (see problems). */
  resolved: ResolvedProject | null;
  catalog: CatalogAsset[];
  /** Steps and runs, for context (recent failures). Empty without runs.sqlite. */
  recentSteps: StepRecord[];
  dead: Set<string>;
  summaryChanges: SummaryChange[];
  /** The drift runs of the last 7 days reported (history/drift.ts), newest first. */
  drift: DriftEntry[];
}

/** How long an asset's top-level code may take to load before status, context and describe give up on it. */
export const INSPECT_IMPORT_TIMEOUT_MS = 5000;

/**
 * The project's asset files resolved (project/resolve.ts), or null with the reason as a problem when they cannot
 * be: an inspecting command still reports what the catalog and the files say. Loaded on demand, so the commands
 * that share this module's helpers (logs, confirm) do not load DuckDB.
 */
export async function resolveAssets(project: Project): Promise<{ resolved: ResolvedProject | null; problems: Problem[] }> {
  const { resolveProject } = await import("../../project/resolve.ts");
  try {
    return { resolved: await resolveProject({ root: project.root, timezone: project.timezone, importTimeoutMs: INSPECT_IMPORT_TIMEOUT_MS }), problems: [] };
  } catch (e) {
    if (e instanceof CroftError) return { resolved: null, problems: [e.problem] };
    const why = String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 300);
    return {
      resolved: null,
      problems: [problem("INTERNAL_ERROR", {
        message: `the asset files could not be resolved (${why}), so staleness and edits are not shown`,
        hint: "croft validate checks each asset file and names the one at fault; if it names none, report this croft bug",
        fix: { kind: "command", description: "check the asset files", command: "croft validate" },
      })],
    };
  }
}

/** Whether an asset's definition loaded: an SQL file (its header and SELECT were read), or a TS file whose
 *  config validated. */
function defined(def: ResolvedAsset | null): def is ResolvedAsset {
  return !!def && (def.kind === "sql" || !!def.ts?.spec);
}

/** An asset's kind: its definition's when it loaded, else the catalog's, else a look at its text. */
function kindOf(def: ResolvedAsset | null, cat: CatalogAsset | null, file: DiscoveredAsset | null, sniff: (a: DiscoveredAsset) => AssetKind | null): AssetKind | null {
  return (defined(def) ? def.kind : null) ?? cat?.kind ?? def?.kind ?? (file ? sniff(file) : null);
}

/**
 * The staleness view of an asset (run/staleness.ts): its definition now and the catalog mirror. What it reads is
 * its definition's inputs, plus what its last build recorded reading (CatalogAsset.reads: an SQL asset's
 * dependencies from the query plan, which only the bind check finds). An incremental TS transform keeps to its
 * definition: its code change is no reason to run, so an input it no longer reads must not make it stale. A
 * definition that does not load gives no code hash: whether it is incremental is unknown, and an unknown is
 * never a reason to run.
 */
export function staleView(o: { name: string; file: string; kind: AssetKind; def: ResolvedAsset | null; entry: CatalogAsset | null;
  catalog: Readonly<Record<string, CatalogAsset>> }): StaleView {
  const def = defined(o.def) ? o.def : null;
  const incremental = def?.incremental.kind === "new-rows";
  const declared = def?.inputs ?? [];
  const inputs = incremental ? declared : [...new Set([...declared, ...(o.entry?.reads ?? [])])];
  return {
    asset: o.name, file: o.file, kind: o.kind, incremental, inputs, entry: o.entry, inputEntries: o.catalog,
    ...(def?.codeHash ? { codeHash: def.codeHash } : {}),
  };
}

/** What status, context and their tests replace. */
export interface StatusDeps {
  /** The scheduler's view of the assets (schedule/due.ts scheduleView), read only while scheduling is not off. */
  scheduleView?: ScheduleViewFn;
  /** ~/.croft, for SCHEDULER_STALE's diagnosis (the registry, the job, tick.log); croftHome() by default. */
  home?: CroftHome;
}

/** The scheduler's view by asset while scheduling is on or paused; a warning instead when it cannot be read. */
async function schedulerView(root: string, now: Date, rec: SchedulingRecord, view: ScheduleViewFn):
  Promise<{ byAsset: Map<string, AssetScheduleView>; problems: Problem[] }> {
  if (rec.state === "off") return { byAsset: new Map(), problems: [] };
  try {
    return { byAsset: new Map((await view({ root, now })).map((v) => [v.asset, v])), problems: [] };
  } catch (e) {
    const p = e instanceof CroftError ? { ...e.problem } : problem("INTERNAL_ERROR", {
      message: `the scheduler's view of the assets could not be read (${String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 300)}), so holds are not shown`,
      hint: "croft schedule status reads the same view and shows the whole error; if it fails too, report this croft bug",
      fix: { kind: "command", description: "show what the scheduler sees", command: "croft schedule status" },
    });
    p.severity = "warning";
    return { byAsset: new Map(), problems: [p] };
  }
}

/**
 * Everything `status` shows, from files, the catalog mirror and runs.sqlite only. `resolved` passes asset files
 * already resolved (resolveAssets); otherwise they are resolved here.
 */
export async function collectStatus(project: Project, now: Date, o: { resolved?: ResolvedProject | null } & StatusDeps = {}): Promise<ProjectState> {
  const tz = project.timezone;
  const discovery = await discoverAssets(project.root, { assetsDir: project.paths.assetsDir });
  const resolution = o.resolved !== undefined ? { resolved: o.resolved, problems: [] } : await resolveAssets(project);
  const resolved = resolution.resolved;
  const { sniffKind } = await import("../../project/resolve.ts");
  // INGEST_CONFIG_CHANGED from the mirror (run/plan.ts pendingBehavior), for the ingests whose definitions loaded.
  const { pendingBehavior, resolvedSide } = await import("../../run/plan.ts");
  const definitions = new Map((resolved?.assets ?? []).map((a) => [a.name, a]));
  const db = openRunsDb(project.paths.stateDir);
  try {
    const rec = db ? schedulingOf(db, now) : SCHEDULING_OFF;
    const scheduler = await schedulerView(project.root, now, rec, o.scheduleView ?? defaultScheduleView);
    const catalog = db ? allCatalog(db) : [];
    const byName = new Map(catalog.map((c) => [c.asset, c]));
    const catalogByName = Object.fromEntries(byName);
    const missing = missingWarehouse(project, warehouseHistory(db, catalog), tz);
    const { running, dead } = runningEntries(db, tz, project.paths.stateDir);
    const summaryChanges = schemaChangesFromRuns(db, new Date(now.getTime() - 7 * DAY_MS));
    const drift = recentDrift(db, new Date(now.getTime() - 7 * DAY_MS));
    const names = [...new Set([...discovery.assets.map((a) => a.name), ...catalog.map((c) => c.asset)])].sort();
    const files = new Map(discovery.assets.map((a) => [a.name, a]));
    const edits: Problem[] = [];
    const configChanges: Problem[] = [];
    const assets: StatusAsset[] = names.map((name) => {
      const file = files.get(name) ?? null;
      const cat = byName.get(name) ?? null;
      const def = definitions.get(name) ?? null;
      const kind = kindOf(def, cat, file, sniffKind);
      const step = db?.latestStep(name) ?? null;
      const stepStatus = step ? effectiveStatus(step, dead) : null;
      let lastRun: LastRun | null = null;
      if (step) {
        lastRun = { runId: step.runId, at: zoned(step.finishedAt ?? step.startedAt, tz)!, status: stepStatus!, code: step.error?.code ?? null };
      } else if (cat?.lastRunId) {
        lastRun = { runId: cat.lastRunId, at: zoned(cat.lastLoadedAt, tz) ?? "", status: "ok", code: null };
      }
      // croft delete's step (reason "deleted") dropped the whole table and its mirror entry: the asset is never built
      // again until it runs, although that step is ok.
      const deleted = !cat && step?.reason === "deleted";
      let status: StatusAsset["status"];
      if (!file) status = "no_asset_file";
      else if (stepStatus === "running") status = "running";
      else if (stepStatus && FAILED.has(stepStatus)) status = stepStatus as StatusAsset["status"];
      else if (stepStatus === "skipped") status = "skipped";
      else if (cat || (!deleted && (stepStatus === "ok" || stepStatus === "unchanged"))) status = missing ? "unknown" : "ok";
      else status = "never_run";

      // Staleness: nothing for a table without an asset file (no run updates it) or one being updated now.
      const view = file && kind ? staleView({ name, file: file.file, kind, def, entry: cat, catalog: catalogByName }) : null;
      let reasons: Reason[] = [];
      if (file && status !== "running") {
        reasons = view ? staleReasons(view) : cat ? [] : ["never_built"];
        // A step that committed while its mirror entry was not written yet (reconcile rewrites it) built the table.
        if (!cat && !deleted && (stepStatus === "ok" || stepStatus === "unchanged")) reasons = reasons.filter((r) => r !== "never_built");
      }

      // Edited: the code differs from what its last run used; the file's time since that run when a hash is unknown.
      // A skipped step is no run of the code: the table still holds what the last step that ran built.
      let edited = false;
      if (file && status !== "running") {
        const ran = step && step.status !== "skipped" && step.attempt >= 1 ? step : db ? lastRanStep(db, name) : null;
        const current = def?.codeHash;
        const ranWith = ran?.codeHash ?? cat?.codeHash ?? null;
        // A code hash that differs only because croft.json's timezone changed is no edit (resolve.ts timeZoneChanged).
        if (current && ranWith) edited = current !== ranWith && !(def?.timeZoneChanged && ranWith === cat?.codeHash);
        else if (ran) {
          try {
            edited = statSync(file.path).mtimeMs > Date.parse(ran.startedAt);
          } catch {}
        }
      }
      if (edited && view) {
        const warning = editedProblem(view);
        if (warning) edits.push(warning);
      }
      // An ingest whose code now writes its rows another way than the stored ones were written: the run fails before
      // it fetches, or asks to convert in place (§6 "Behavior changes"), with the run's fixes.
      const side = file && def ? resolvedSide(def) : null;
      const pending = side ? pendingBehavior(side, cat) : null;
      if (pending) configChanges.push(pending.problem);

      // When it runs next: the scheduler's view while scheduling is on, else the schedule's own next fire.
      const sv = scheduler.byAsset.get(name) ?? null;
      const schedule = sv?.schedule ?? def?.schedule ?? null;
      const at = !schedule || rec.state !== "on" ? null
        : sv ? sv.nextFireAt : nextFireOf(schedule.cron, tz, now)[0]?.toISOString() ?? null;
      const hold = sv?.held ?? null;
      const out: StatusAsset = {
        asset: name, kind, file: file?.file ?? null, status, rows: cat && !missing ? cat.rows : null, lastRun,
        next: nextOf(kind, !!file, { state: rec.state, schedule: schedule?.text ?? null, at: zoned(at, tz) }),
        stale: reasons.length > 0, staleReasons: reasons, held: !!file && hold !== null && HUMAN_HOLDS.has(hold.code), edited,
      };
      if (file && hold) out.hold = { code: hold.code, reason: hold.reason };
      // §6 "Restore": an incremental TS transform processes new input rows only, so a replaced input's older rows
      // are redone by `--rebuild` alone; the row says which input, and whether a restore replaced it.
      if (view?.incremental && reasons.includes("input_replaced")) {
        const replaced = replacedInputs(db, view);
        if (replaced.length) out.replaced = replaced;
      }
      if (cat?.filesGone?.length) out.filesGone = [...cat.filesGone];
      const changed = summaryChanges.filter((c) => c.asset === name).map((c) => c.at).sort().pop();
      if (changed) out.schemaChangedAt = zoned(changed, tz)!;
      const drifted = drift.filter((e) => e.asset === name);
      if (drifted.length) out.drift = drifted.map((e) => ({ code: e.code, column: e.column, text: e.text, at: zoned(e.at, tz)!, runId: e.runId }));
      return out;
    });
    const renamed = await renamedProblems(project, discovery.assets, catalog, resolved ? definitions : null);
    const healthy = !missing && !rec.stale && !assets.some((a) => FAILED.has(a.status) || a.held || a.stale);
    const recentSteps = db
      ? db.listRuns({ since: new Date(now.getTime() - 7 * DAY_MS), limit: 200 }).flatMap((r) => db.stepsFor(r.id))
      : [];
    const data: StatusData = {
      healthy,
      running,
      assets,
      scheduling: schedulingJson(rec, tz),
    };
    const serve = serveOf(project.paths.stateDir);
    if (serve) data.serve = serve;
    if (project.config.readCopy) {
      const copy = readCopyView(readCopyStatus(project, db ?? undefined), tz);
      if (copy) data.readCopy = copy;
    }
    // resolveProject's problems are discovery's (all of them: no selectors) and CYCLE.
    const problems = [...(missing ? [missing] : []), ...(resolved ? resolved.problems : discovery.problems), ...resolution.problems, ...renamed, ...configChanges];
    // The scheduler: stale (the diagnosis reads files only: no launchctl or crontab here), then the held assets.
    const schedulingProblems: Problem[] = [];
    if (rec.stale) {
      schedulingProblems.push(staleProblem(rec, {
        root: project.root, stateDir: project.paths.stateDir, tz, now, home: o.home ?? croftHome(), serve: serve ? { pid: serve.pid } : null,
      }));
    }
    schedulingProblems.push(...scheduler.problems);
    for (const a of assets) if (a.held && a.hold?.code === "SCHEDULE_HELD") schedulingProblems.push(heldProblem(a.asset, a.hold.reason));
    return { data, problems, edited: edits, scheduling: schedulingProblems, discovered: discovery.assets, resolved, catalog, recentSteps, dead, summaryChanges, drift };
  } finally {
    db?.close();
  }
}

/**
 * ASSET_RENAMED (DESIGN.md §6 "Nothing implicit destroys ingested data"): a never-built asset whose code built an
 * orphan table (its file was renamed outside croft), or a croft rename that stopped (project/rename.ts findRenamed).
 * The fix is `croft rename <orphan> <new>`, never a run, which would fetch everything again. From what status has
 * read (the files, the mirror, the resolved code hashes; `definitions` null: hashed without importing). Never fails
 * status.
 */
export async function renamedProblems(project: Project, discovered: readonly DiscoveredAsset[], catalog: readonly CatalogAsset[],
  definitions: ReadonlyMap<string, ResolvedAsset> | null): Promise<Problem[]> {
  try {
    const { findRenamed, renamedProblem } = await import("../../project/rename.ts");
    const codeHash = definitions ? (n: string) => {
      const d = definitions.get(n);
      return d && d.loaded ? d.codeHash ?? null : undefined;
    } : undefined;
    return (await findRenamed(project.root, { project, discovered, catalog, ...(codeHash ? { codeHash } : {}) })).map(renamedProblem);
  } catch {
    return [];
  }
}

/** Whether instant `a` is later than `b` (microseconds count; text order when either does not parse). */
function later(a: string, b: string): boolean {
  try {
    return parseInstant(a) > parseInstant(b);
  } catch {
    return a > b;
  }
}

/**
 * The inputs an incremental TS transform has not read since they were replaced (staleness's input_replaced: an
 * input's lastReplacedAt is later than the version the transform last read of it), each with whether `croft restore`
 * replaced it since (a "restored" step of the input in runs.sqlite, delete.ts and restore.ts).
 */
function replacedInputs(db: RunsDb | null, view: StaleView): { input: string; restored: boolean }[] {
  const out: { input: string; restored: boolean }[] = [];
  const entry = (name: string) => view.inputEntries[name] ?? Object.entries(view.inputEntries).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1] ?? null;
  for (const input of view.inputs) {
    const replacedAt = entry(input)?.lastReplacedAt ?? null;
    const seen = view.entry?.inputsSeen?.[input]?.inputLastLoadedAt ?? null;
    if (!replacedAt || !seen || !later(replacedAt, seen)) continue;
    const restores = db
      ? db.sqlite.query("SELECT finished_at FROM steps WHERE asset = ? AND status = 'ok' AND reason = 'restored' AND finished_at IS NOT NULL")
        .all(input) as { finished_at: string }[]
      : [];
    out.push({ input, restored: restores.some((r) => later(r.finished_at, seen)) });
  }
  return out;
}

/** The words for an incremental TS transform's replaced inputs (StatusAsset.replaced): which, how, and that only
 *  `--rebuild` redoes the rows it built from them (§6 "Restore"). */
function replacedText(a: Pick<StatusAsset, "asset" | "replaced">): string | null {
  const list = a.replaced ?? [];
  if (list.length === 0) return null;
  const inputs = (xs: readonly { input: string }[]) => `${xs.length === 1 ? "input" : "inputs"} ${xs.map((x) => x.input).join(", ")}`;
  const restored = list.filter((x) => x.restored);
  const other = list.filter((x) => !x.restored);
  const what = [
    ...(restored.length ? [`${inputs(restored)} restored`] : []),
    ...(other.length ? [`${inputs(other)} replaced (rows deleted or changed)`] : []),
  ];
  return `${what.join("; ")}; croft run ${a.asset} --rebuild redoes it`;
}

/** A pending INGEST_CONFIG_CHANGED as a status row says it (run/plan.ts pendingBehavior's problem), by asset. */
export function configRows(problems: readonly Problem[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of problems ?? []) {
    if (p.code !== "INGEST_CONFIG_CHANGED" || p.details?.pending !== true || !p.asset) continue;
    out.set(p.asset, p.severity === "error"
      ? `its code changes how its rows are written: croft run ${p.asset} fails until that is settled (INGEST_CONFIG_CHANGED)`
      : `its code adds a key: croft run ${p.asset} asks to convert its stored rows in place (INGEST_CONFIG_CHANGED)`);
  }
  return out;
}

/** A renamed asset as a row of `croft status` shows it (both its names), from the ASSET_RENAMED problems. */
export interface RenamedRow { from: string; to: string; unfinished: boolean }

export function renamedRows(problems: readonly Problem[] | undefined): Map<string, RenamedRow> {
  const out = new Map<string, RenamedRow>();
  for (const p of problems ?? []) {
    const d = p.details;
    if (p.code !== "ASSET_RENAMED" || typeof d?.from !== "string" || typeof d?.to !== "string") continue;
    const row = { from: d.from, to: d.to, unfinished: d.unfinished === true };
    out.set(row.from, row);
    out.set(row.to, row);
  }
  return out;
}

/** The stale assets a run would update for a reason other than never having been built (a never-run asset
 *  says `croft run <asset>` in its own row). */
function staleForNext(assets: readonly StatusAsset[]): StatusAsset[] {
  return assets.filter((a) => !FAILED.has(a.status) && a.staleReasons.some((r) => r !== "never_built"));
}

const REASON_WORDS: Partial<Record<Reason, string>> = {
  code_changed: "code changed",
  input_changed: "inputs changed",
  input_replaced: "an input was replaced",
};

/** "stale: code changed, inputs changed", or null when nothing but never_built (the row's head says that). */
export function staleText(reasons: readonly Reason[]): string | null {
  const words = reasons.filter((r) => r !== "never_built").map((r) => REASON_WORDS[r] ?? r.replaceAll("_", " "));
  return words.length ? `stale: ${words.join(", ")}` : null;
}

// ---------------------------------------------------------------------------------------------------------
// The command

export const status: CommandImpl<StatusData> = {
  run: (ctx) => runStatus(ctx),
  human(result, ctx) {
    return formatStatus(result.data, ctx.now(), {
      tz: ctx.project.timezone, problems: result.problems, root: ctx.project.root, database: ctx.project.paths.database,
    });
  },
};

export async function runStatus(ctx: Ctx, deps: StatusDeps = {}): Promise<CommandResult<StatusData>> {
  const project = ctx.project;
  const state = await collectStatus(project, ctx.now(), { home: deps.home ?? croftHome(ctx.processEnv), ...(deps.scheduleView ? { scheduleView: deps.scheduleView } : {}) });
  const check = ctx.values.check === true;
  const unhealthy = !state.data.healthy;
  const next = statusNext(state.data.assets);
  return { data: state.data, problems: [...state.problems, ...state.edited, ...state.scheduling], next, ok: true, exit: check && unhealthy ? 1 : 0 };
}

/** next[] of the status envelope: the failed assets' logs, a dry run for the stale ones, a run for the held ones.
 *  croft serve's GET /status answers with the same. */
export function statusNext(assets: readonly StatusAsset[]): Next[] {
  const next: Next[] = assets
    .filter((a) => FAILED.has(a.status))
    .slice(0, 3)
    .map((a) => ({ command: `croft logs ${a.asset} --failed`, reason: `${a.asset} ${a.status}${a.lastRun?.code ? ` (${a.lastRun.code})` : ""}` }));
  const stale = staleForNext(assets).map((a) => a.asset);
  if (stale.length) {
    const names = stale.length > 5 ? `${stale.slice(0, 5).join(", ")}, …` : stale.join(", ");
    next.push({
      command: "croft run --dry-run",
      reason: `${stale.length} asset${stale.length === 1 ? " is" : "s are"} stale (${names}): see what a run would update and why`,
    });
  }
  for (const a of assets.filter((x) => x.held && x.hold?.code === "SCHEDULE_HELD").slice(0, 3)) {
    next.push({ command: `croft run ${a.asset}`, reason: `releases it for the scheduler (${a.hold!.reason})` });
  }
  return next;
}

/** The STATUS column: the state plus the notes that matter (§4.2). `renamed`: the asset is one name of an
 *  ASSET_RENAMED pair, whose row says `croft rename`, never `croft run` (a run would fetch everything again).
 *  `config`: a pending INGEST_CONFIG_CHANGED in words (configRows). */
export function statusText(a: StatusAsset, now: Date, renamed?: RenamedRow, config?: string): string {
  const notes: string[] = [];
  let head: string;
  const rename = renamed ? `croft rename ${renamed.from} ${renamed.to}` : "";
  switch (a.status) {
    case "failed":
    case "crashed":
    case "interrupted":
      head = `${a.status}${a.lastRun?.code ? `: ${a.lastRun.code}` : ""} (croft logs ${a.asset} --failed)`;
      break;
    case "running":
      head = `running${a.lastRun ? ` (${a.lastRun.runId})` : ""}`;
      break;
    case "never_run":
      head = `never run (croft run ${a.asset})`;
      break;
    case "no_asset_file":
      head = "no asset file (its table is kept)";
      break;
    case "unknown":
      head = "unknown: the warehouse file is missing";
      break;
    case "skipped":
      head = "skipped";
      break;
    default:
      head = "ok";
  }
  if (renamed) {
    const words = renamed.unfinished ? `the rename of ${renamed.from} to ${renamed.to} did not finish`
      : a.asset === renamed.to ? `looks like ${renamed.from} renamed` : `looks renamed to ${renamed.to}`;
    if (a.status === "never_run") head = `never run: ${words} (${rename})`;
    else if (a.status === "no_asset_file") head = `no asset file: ${words} (${rename})`;
    else notes.push(`${words} (${rename})`);
  }
  // Held from the scheduler (§6): on a healthy row it is the state, with the run that releases it.
  if (a.held && a.hold) {
    const held = `held: ${a.hold.code === "LARGE_REPROCESS" ? "LARGE_REPROCESS, " : ""}${a.hold.reason}`;
    if (head === "ok") head = a.hold.reason.includes("croft run") ? held : `${held} (croft run ${a.asset})`;
    else notes.push(held);
  }
  // An incremental TS transform's replaced input is redone by --rebuild alone (§6 "Restore"): its own words.
  const replaced = replacedText(a);
  const stale = staleText(replaced ? a.staleReasons.filter((r) => r !== "input_replaced") : a.staleReasons);
  // The command goes on a healthy row only: a failed or held one already names what to do first.
  if (stale) notes.push(head === "ok" ? `${stale} (croft run ${a.asset})` : stale);
  if (replaced) notes.push(stale ? replaced : `stale: ${replaced}`);
  if (a.filesGone?.length) notes.push(`${a.filesGone.length} file${a.filesGone.length === 1 ? "" : "s"} gone`);
  if (a.schemaChangedAt) notes.push(`schema changed ${ago(a.schemaChangedAt, now)}`);
  if (a.drift?.length) notes.push(`${driftNote(a.drift)} (${ago(a.drift[0]!.at, now)})`);
  if (a.edited) notes.push("edited since its last run");
  if (config) notes.push(config);
  return [head, ...notes].join(" · ");
}

/** The NEXT column: "in 55 min", "Oct 1 00:00", "every hour (off)", "paused", "manual", "after inputs", "—". */
export function nextText(n: AssetNext, tz: string, now: Date): string {
  switch (n.reason) {
    case "none":
      return "—";
    case "schedule":
      return n.at ? fireText(n.at, tz, now) : n.schedule ?? "—";
    case "scheduling off":
      return `${n.schedule} (off)`;
    default:
      return n.reason;
  }
}

/** The §4.2 table, what is running, the scheduling line, and with readCopy on the read copy's line. `problems`: a
 *  SCHEDULER_STALE's tick log is printed under the scheduling line. `root` and `database`: the read copy's paths are
 *  shown relative to the project. */
export function formatStatus(d: StatusData, now: Date, o: { tz?: string; problems?: readonly Problem[]; root?: string; database?: string } = {}): string {
  const tz = o.tz ?? "UTC";
  const stale = o.problems?.find((p) => p.code === "SCHEDULER_STALE");
  const tail = [...(stale ? logTailLines(stale) : []), ...readCopyLines(d, now, tz, o)];
  if (d.assets.length === 0) {
    return ["No assets yet: add one to assets/ (croft docs ingest has templates), then croft run <asset>.", schedulingLine(d, now, tz), ...tail].join("\n");
  }
  const renamed = renamedRows(o.problems);
  const config = configRows(o.problems);
  const rows = d.assets.map((a) => [
    a.asset,
    a.rows === null ? "—" : formatCount(a.rows),
    a.lastRun ? ago(a.lastRun.at, now) : "—",
    nextText(a.next, tz, now),
    statusText(a, now, renamed.get(a.asset), config.get(a.asset)),
  ]);
  const lines = [table(["ASSET", "ROWS", "LAST RUN", "NEXT", "STATUS"], rows, { limit: Infinity, maxWidth: 200 }).text];
  for (const r of d.running) {
    lines.push(`running  ${r.runId}${r.asset ? `  ${r.asset}` : ""}${r.pid !== null ? `  pid ${r.pid}` : ""}  since ${ago(r.since, now).replace(/ ago$/, "")}${r.phase ? `  ${r.phase}` : ""}${r.rowsFetched !== null ? `  ${formatCount(r.rowsFetched)} rows fetched` : ""}`);
  }
  lines.push(schedulingLine(d, now, tz), ...tail);
  return lines.join("\n");
}

/** "Read copy warehouse.read.duckdb · as of 11:58 (2 min ago)", and for a warning its hint on the next line. */
function readCopyLines(d: StatusData, now: Date, tz: string, o: { root?: string; database?: string }): string[] {
  if (!d.readCopy) return [];
  const root = o.root ?? "";
  const w = readCopyWords(d.readCopy, { root, database: o.database ?? "", tz, now });
  return [`Read copy ${w.text}`, ...(w.hint ? [`  hint: ${w.hint}`] : [])];
}

function schedulingLine(d: StatusData, now: Date, tz: string): string {
  const s = d.scheduling;
  const parts = [`Scheduling ${s.state}${s.state === "paused" ? ` ${s.pausedUntil ? `until ${clockText(s.pausedUntil, tz, now)}` : `until ${resumeCommand(s.via)}`}` : ""}`];
  if (s.lastTickAt) parts.push(`last tick ${ago(s.lastTickAt, now)}${s.stale ? " (stale)" : ""}`);
  else if (s.state === "on") parts.push(s.stale ? "no tick yet (stale)" : "no tick yet");
  parts.push(`${d.running.length} running`);
  if (d.serve) parts.push(`croft serve ${d.serve.url} (pid ${d.serve.pid})`);
  return parts.join(" · ");
}
