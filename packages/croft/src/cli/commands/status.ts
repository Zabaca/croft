// croft status [--check] (DESIGN.md §4.1, §4.2, §4.3 "status"; §5 "How commands behave while a run is
// writing"): the freshness and health of every asset, and what is running. It never opens the warehouse,
// so it never waits on DuckDB: it reads the catalog mirror and runs.sqlite (bun:sqlite, WAL, readable
// while DuckDB is locked), the asset files on disk, and for a live run's per-step progress the end of its
// logs/<run>/events.ndjson. Asset code is not imported either: a TS file's
// kind comes from the catalog, or from a look at its text when it has never run.
//
// Phase 1 has no scheduler: `next` is "manual" for ingests and "after inputs" for transforms, nothing is
// held, and scheduling is {state: "off", via: null}. Staleness is "never built" only; the planner (run
// --dry-run) is what compares code and input versions.
//
// `status` exits 0 because the command worked; `--check` exits 1 when anything is failed, crashed, held or
// stale, which makes it a health probe. In JSON, ok always means "the command worked" and data.healthy
// carries health.
//
// The catalog mirror says what was built, not that it is still there: status stats the warehouse file (it
// never opens it), and when the catalog has entries but the file is gone (deleted, or moved away from the
// "database" path) it reports DB_NOT_FOUND, is not healthy, and shows what was built as unknown.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { problem } from "../../core/errors.ts";
import { formatInstant, parseInstant } from "../../core/time.ts";
import { recordAlive } from "../../core/proc.ts";
import type { AssetKind, Problem } from "../../core/types.ts";
import { allCatalog, type CatalogAsset } from "../../history/catalog.ts";
import { logDir, tail } from "../../history/logs.ts";
import { RUNS_DB_FILE, RunsDb, type RunRecord, type StepRecord } from "../../history/runs-db.ts";
import { discoverAssets, type DiscoveredAsset } from "../../project/discover.ts";
import type { Project } from "../../project/root.ts";
import { readServeRecord } from "../../read/locate.ts";
import type { CommandImpl } from "../command.ts";
import { formatCount, table } from "../render.ts";

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
  next: { at: string | null; reason: "manual" | "after inputs" | "none" };
  stale: boolean;
  staleReasons: string[];
  held: boolean;
  edited: boolean;
  filesGone?: string[];
  schemaChangedAt?: string;
}

export interface Scheduling { state: "on" | "off" | "paused"; via: "os-job" | "serve" | null; lastTickAt: string | null }

export interface StatusData {
  healthy: boolean;
  running: RunningEntry[];
  assets: StatusAsset[];
  scheduling: Scheduling;
  serve?: { url: string; pid: number };
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

/** An asset's kind without importing its code: .sql files are SQL transforms; a .ts file that calls
 *  transform( is a TS transform, one that calls ingest( an ingest. null when the text says neither. */
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

export function nextOf(kind: AssetKind | null, hasFile: boolean): StatusAsset["next"] {
  if (!hasFile) return { at: null, reason: "none" };
  return { at: null, reason: kind === "ingest" ? "manual" : kind === null ? "manual" : "after inputs" };
}

/** Whether a scheduler tick has checked in: the tick row's heartbeat, or null. */
function lastTick(db: RunsDb | null, tz: string): string | null {
  if (!db) return null;
  const row = db.sqlite.query("SELECT heartbeat_at FROM tick WHERE id = 1").get() as { heartbeat_at: string | null } | null;
  return zoned(row?.heartbeat_at ?? null, tz);
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
  problems: Problem[];
  discovered: DiscoveredAsset[];
  catalog: CatalogAsset[];
  /** Steps and runs, for context (recent failures). Empty without runs.sqlite. */
  recentSteps: StepRecord[];
  dead: Set<string>;
  summaryChanges: SummaryChange[];
}

/**
 * Everything `status` shows, from files, the catalog mirror and runs.sqlite only. `kinds` may supply asset
 * kinds known from their configs (context imports the asset files); otherwise the catalog or a look at the
 * file decides.
 */
export async function collectStatus(project: Project, now: Date, o: { kinds?: Record<string, AssetKind | null> } = {}): Promise<ProjectState> {
  const tz = project.timezone;
  const discovery = await discoverAssets(project.root, { assetsDir: project.paths.assetsDir });
  const db = openRunsDb(project.paths.stateDir);
  try {
    const catalog = db ? allCatalog(db) : [];
    const byName = new Map(catalog.map((c) => [c.asset, c]));
    const missing = missingWarehouse(project, warehouseHistory(db, catalog), tz);
    const { running, dead } = runningEntries(db, tz, project.paths.stateDir);
    const summaryChanges = schemaChangesFromRuns(db, new Date(now.getTime() - 7 * DAY_MS));
    const names = [...new Set([...discovery.assets.map((a) => a.name), ...catalog.map((c) => c.asset)])].sort();
    const files = new Map(discovery.assets.map((a) => [a.name, a]));
    const assets: StatusAsset[] = names.map((name) => {
      const file = files.get(name) ?? null;
      const cat = byName.get(name) ?? null;
      const kind = cat?.kind ?? (o.kinds && name in o.kinds ? o.kinds[name]! : file ? sniffKind(file) : null);
      const step = db?.latestStep(name) ?? null;
      const stepStatus = step ? effectiveStatus(step, dead) : null;
      let lastRun: LastRun | null = null;
      if (step) {
        lastRun = { runId: step.runId, at: zoned(step.finishedAt ?? step.startedAt, tz)!, status: stepStatus!, code: step.error?.code ?? null };
      } else if (cat?.lastRunId) {
        lastRun = { runId: cat.lastRunId, at: zoned(cat.lastLoadedAt, tz) ?? "", status: "ok", code: null };
      }
      let status: StatusAsset["status"];
      if (!file) status = "no_asset_file";
      else if (stepStatus === "running") status = "running";
      else if (stepStatus && FAILED.has(stepStatus)) status = stepStatus as StatusAsset["status"];
      else if (stepStatus === "skipped") status = "skipped";
      else if (cat || stepStatus === "ok" || stepStatus === "unchanged") status = missing ? "unknown" : "ok";
      else status = "never_run";
      const staleReasons = file && !cat && status !== "running" && !(stepStatus === "ok" || stepStatus === "unchanged") ? ["never_built"] : [];
      // Edited: the file changed after the step that last read it started (only once it has run).
      let edited = false;
      if (file && step && status !== "running") {
        try {
          edited = statSync(file.path).mtimeMs > Date.parse(step.startedAt);
        } catch {}
      }
      const out: StatusAsset = {
        asset: name, kind, file: file?.file ?? null, status, rows: cat && !missing ? cat.rows : null, lastRun,
        next: nextOf(kind, !!file), stale: staleReasons.length > 0, staleReasons, held: false, edited,
      };
      if (cat?.filesGone?.length) out.filesGone = [...cat.filesGone];
      const changed = summaryChanges.filter((c) => c.asset === name).map((c) => c.at).sort().pop();
      if (changed) out.schemaChangedAt = zoned(changed, tz)!;
      return out;
    });
    const healthy = !missing && !assets.some((a) => FAILED.has(a.status) || a.held || a.stale);
    const recentSteps = db
      ? db.listRuns({ since: new Date(now.getTime() - 7 * DAY_MS), limit: 200 }).flatMap((r) => db.stepsFor(r.id))
      : [];
    const data: StatusData = {
      healthy,
      running,
      assets,
      scheduling: { state: "off", via: null, lastTickAt: lastTick(db, tz) },
    };
    const serve = serveOf(project.paths.stateDir);
    if (serve) data.serve = serve;
    const problems = missing ? [missing, ...discovery.problems] : discovery.problems;
    return { data, problems, discovered: discovery.assets, catalog, recentSteps, dead, summaryChanges };
  } finally {
    db?.close();
  }
}

// ---------------------------------------------------------------------------------------------------------
// The command

export const status: CommandImpl<StatusData> = {
  async run(ctx) {
    const project = ctx.project;
    const state = await collectStatus(project, ctx.now());
    const check = ctx.values.check === true;
    const unhealthy = !state.data.healthy;
    const next = state.data.assets
      .filter((a) => FAILED.has(a.status))
      .slice(0, 3)
      .map((a) => ({ command: `croft logs ${a.asset} --failed`, reason: `${a.asset} ${a.status}${a.lastRun?.code ? ` (${a.lastRun.code})` : ""}` }));
    return { data: state.data, problems: state.problems, next, ok: true, exit: check && unhealthy ? 1 : 0 };
  },
  human(result, ctx) {
    return formatStatus(result.data, ctx.now());
  },
};

/** The STATUS column: the state plus the notes that matter (§4.2). */
export function statusText(a: StatusAsset, now: Date): string {
  const notes: string[] = [];
  let head: string;
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
  if (a.filesGone?.length) notes.push(`${a.filesGone.length} file${a.filesGone.length === 1 ? "" : "s"} gone`);
  if (a.schemaChangedAt) notes.push(`schema changed ${ago(a.schemaChangedAt, now)}`);
  if (a.edited) notes.push("edited since its last run");
  return [head, ...notes].join(" · ");
}

export function formatStatus(d: StatusData, now: Date): string {
  if (d.assets.length === 0) {
    return ["No assets yet: add one to assets/ (croft docs ingest has templates), then croft run <asset>.", schedulingLine(d, now)].join("\n");
  }
  const rows = d.assets.map((a) => [
    a.asset,
    a.rows === null ? "—" : formatCount(a.rows),
    a.lastRun ? ago(a.lastRun.at, now) : "—",
    a.next.reason === "none" ? "—" : a.next.reason,
    statusText(a, now),
  ]);
  const lines = [table(["ASSET", "ROWS", "LAST RUN", "NEXT", "STATUS"], rows, { limit: Infinity, maxWidth: 200 }).text];
  for (const r of d.running) {
    lines.push(`running  ${r.runId}${r.asset ? `  ${r.asset}` : ""}${r.pid !== null ? `  pid ${r.pid}` : ""}  since ${ago(r.since, now).replace(/ ago$/, "")}${r.phase ? `  ${r.phase}` : ""}${r.rowsFetched !== null ? `  ${formatCount(r.rowsFetched)} rows fetched` : ""}`);
  }
  lines.push(schedulingLine(d, now));
  return lines.join("\n");
}

function schedulingLine(d: StatusData, now: Date): string {
  const parts = [`Scheduling ${d.scheduling.state}`];
  if (d.scheduling.lastTickAt) parts.push(`last tick ${ago(d.scheduling.lastTickAt, now)}`);
  parts.push(`${d.running.length} running`);
  if (d.serve) parts.push(`croft serve ${d.serve.url} (pid ${d.serve.pid})`);
  return parts.join(" · ");
}
