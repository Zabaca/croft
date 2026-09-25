// croft context [--asset NAME…] (DESIGN.md §4.1, §4.3 "context", §9): the whole project in one payload, for
// an agent's first look: every asset as a compact describe (kind, file, behavior, key, cursor, rows, columns
// with JSON keys, checks, status, staleness, last run, what it reads), what is running, recent failures and
// recent schema changes with the assets that read the changed one.
//
// It never waits on DuckDB (§5): asset facts come from the catalog mirror in runs.sqlite, and runs from
// runs.sqlite. When the catalog lists tables but the warehouse file is gone, the problems carry DB_NOT_FOUND
// and those assets show rows: null and status "unknown" (collectStatus in status.ts). Schema changes of the
// last 7 days come from _croft.writes when the warehouse can be opened at once (no write intent announced and
// no lock held), and otherwise from what runs recorded in their summaries. The asset files are resolved once,
// as status and validate resolve them (project/resolve.ts), for staleness, descriptions, inputs, checks and
// declared secrets; their problems (a file that does not load, CHECK_INVALID) and EDITED_SINCE_LAST_RUN are
// the payload's problems.
//
// Drift (§7, history/drift.ts): each asset's `drift` is status's; a column that stopped arriving and a JSON column
// that gained a kind are also recentSchemaChanges (kinds column_stopped_arriving and json_kind_changed), from the run
// summaries, next to the schema changes (a widening is one already).
//
// Scheduling (§8): the project's setting as status shows it, each ingest's schedule and next run, and the assets
// held from the scheduler (held[], with SCHEDULE_HELD in problems), from the scheduler's view while scheduling is
// on or paused (status.ts collectStatus; never read while it is off).
//
// The payload is capped at 20 KB (§9.6). Past that it sheds detail in order: JSON keys, then column lists,
// then whole assets from the end (listed in data.omitted), and says truncated: true. --asset narrows it.
import { existsSync } from "node:fs";
import { CroftError, problem } from "../../core/errors.ts";
import type { AssetKind, Problem, Reason } from "../../core/types.ts";
import { liveIntents } from "../../db/intent.ts";
import { hasState } from "../../db/state.ts";
import type { CatalogAsset } from "../../history/catalog.ts";
import { driftChange } from "../../history/drift.ts";
import { FAILED_STATUSES } from "../../history/runs-db.ts";
import { didYouMean } from "../../project/suggest.ts";
import { croftHome } from "../../schedule/home.ts";
import type { Row } from "../../types.ts";
import type { CommandImpl, CommandResult, Ctx } from "../command.ts";
import { formatCount, toJsonLine } from "../render.ts";
import {
  type AssetConfig, behaviorOf, checksOf, columnsText, configOf, declareProjectSecrets, isBusy, loadConfigs, readersOf, readOnlyWarehouse, readsOf,
} from "./describe.ts";
import { agoText, clockText, fireText } from "./schedule.ts";
import {
  ago, collectStatus, effectiveStatus, epochMs, INSPECT_IMPORT_TIMEOUT_MS, type LastRun, type RunningEntry, type Scheduling, type StatusAsset,
  renamedRows, type StatusDeps, statusText, zoned,
} from "./status.ts";

export const CONTEXT_CAP_BYTES = 20 * 1024;
const DAY_MS = 86_400_000;

export interface CompactAsset {
  asset: string;
  kind: AssetKind | null;
  file: string | null;
  description: string | null;
  behavior: string;
  key: string[];
  cursor: { field: string | null; value: string | null } | null;
  rows: number | null;
  lastLoadedAt: string | null;
  status: StatusAsset["status"];
  lastRun: LastRun | null;
  /** status's next.reason: "schedule", "scheduling off", "paused", "manual", "after inputs", "none". */
  next: string;
  /** An ingest's schedule as written, and its next fire while scheduling is on (null otherwise). */
  schedule?: string;
  nextFireAt?: string | null;
  /** Why the scheduler does not run it now (status's hold). */
  hold?: StatusAsset["hold"];
  /** Why a bare `croft run` would update it (status's staleReasons); empty when fresh. */
  staleReasons: Reason[];
  /** Present when its code differs from the code its last run used. */
  edited?: true;
  reads: string[];
  checks: string[];
  columns?: { name: string; type: string; jsonKeys?: string[] }[];
  filesGone?: string[];
  schemaChangedAt?: string;
  drift?: StatusAsset["drift"];
}

export interface SchemaChangeEntry {
  asset: string;
  at: string;
  runId: string | null;
  kind: string;
  column: string | null;
  from: string | null;
  to: string | null;
  readBy: string[];
}

export interface FailureEntry { asset: string; runId: string; at: string; status: string; code: string | null; message: string | null }

export interface ContextData {
  project: {
    root: string;
    database: string;
    timezone: string;
    assets: number;
    scheduling: Scheduling;
  };
  assets: CompactAsset[];
  running: RunningEntry[];
  /** The assets held from the scheduler until a human runs them (status's held). */
  held: string[];
  recentFailures: FailureEntry[];
  recentSchemaChanges: SchemaChangeEntry[];
  schemaChangesFrom: "warehouse" | "runs";
  truncated: boolean;
  omitted?: string[];
}

function changeEntry(asset: string, at: string, runId: string | null, c: Record<string, unknown>): SchemaChangeEntry {
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    asset, at, runId, kind: s(c.kind) ?? "unknown", column: s(c.column),
    from: s(c.from), to: s(c.to) ?? s(c.type), readBy: [],
  };
}

/** Schema changes of the last 7 days from _croft.writes, when the warehouse can be read at once; null when a
 *  writer holds or has announced it (context never waits). A warehouse that cannot be read at all is reported
 *  through `report`, and context goes on without it. */
async function warehouseChanges(ctx: Parameters<CommandImpl["run"]>[0], since: Date, report: (p: Problem) => void): Promise<SchemaChangeEntry[] | null> {
  const project = ctx.project;
  if (!existsSync(project.paths.database)) return [];
  if (liveIntents(project.paths.stateDir, { excludeSelf: true }).length > 0) return null;
  try {
    return await readOnlyWarehouse(ctx, project).read(async (db) => {
      if (!(await hasState(db))) return [];
      const { rows } = await db.query(
        `SELECT asset, loaded_at, run_id, schema_changes FROM _croft.writes
         WHERE loaded_at >= $1::TIMESTAMPTZ AND schema_changes IS NOT NULL AND json_array_length(schema_changes) > 0
         ORDER BY loaded_at DESC LIMIT 200`, [since.toISOString()], "json");
      return rows.flatMap((r: Row) => (Array.isArray(r.schema_changes) ? r.schema_changes : [])
        .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
        .map((c) => changeEntry(String(r.asset), String(r.loaded_at), r.run_id === null ? null : String(r.run_id), c)));
    }, { purpose: "croft context", waitMs: 0 });
  } catch (e) {
    if (isBusy(e)) return null;
    report(e instanceof CroftError ? e.problem : problem("DB_UNREADABLE", {
      message: `the warehouse could not be read: ${String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 300)}`,
      hint: "croft doctor checks the warehouse and says what to do",
      fix: { kind: "command", description: "check the warehouse", command: "croft doctor" },
    }));
    return null;
  }
}

function compact(s: StatusAsset, config: AssetConfig | null, cat: CatalogAsset | null, reads: readonly string[], tz: string): CompactAsset {
  const b = behaviorOf(config, cat);
  const out: CompactAsset = {
    asset: s.asset, kind: s.kind, file: s.file, description: config?.description ?? null, behavior: b.words, key: b.key,
    cursor: b.incremental?.kind === "cursor" ? { field: b.incremental.field, value: b.incremental.cursorValue } : null,
    rows: s.rows, lastLoadedAt: zoned(cat?.lastLoadedAt ?? null, tz), status: s.status, lastRun: s.lastRun,
    next: s.next.reason, ...(s.next.schedule ? { schedule: s.next.schedule, nextFireAt: s.next.at } : {}), ...(s.hold ? { hold: s.hold } : {}),
    staleReasons: [...s.staleReasons], ...(s.edited ? { edited: true as const } : {}), reads: [...reads],
    checks: checksOf(config, b.key).map((c) => (c.blocking ? c.check : `warn ${c.check}`)),
  };
  if (s.filesGone) out.filesGone = s.filesGone;
  if (s.schemaChangedAt) out.schemaChangedAt = s.schemaChangedAt;
  if (s.drift) out.drift = s.drift;
  if (cat?.columns.length) {
    out.columns = cat.columns.filter((c) => c.name !== "_loaded_at").map((c) => ({
      name: c.name, type: c.type, ...(c.jsonKeys?.length ? { jsonKeys: [...c.jsonKeys] } : {}),
    }));
  }
  return out;
}

const size = (v: unknown) => Buffer.byteLength(toJsonLine(v));

/** Shed detail until the payload fits `cap` bytes: JSON keys, then column lists, then assets from the end. */
export function capContext(d: ContextData, cap = CONTEXT_CAP_BYTES): ContextData {
  if (size(d) <= cap) return d;
  const out: ContextData = { ...d, assets: d.assets.map((a) => ({ ...a })), truncated: true };
  out.recentFailures = out.recentFailures.slice(0, 10);
  out.recentSchemaChanges = out.recentSchemaChanges.slice(0, 20);
  if (size(out) <= cap) return out;
  for (const a of out.assets) if (a.columns) a.columns = a.columns.map(({ name, type }) => ({ name, type }));
  if (size(out) <= cap) return out;
  for (const a of out.assets) delete a.columns;
  if (size(out) <= cap) return out;
  const omitted: string[] = [];
  while (out.assets.length && size({ ...out, omitted }) > cap) omitted.unshift(out.assets.pop()!.asset);
  out.omitted = omitted;
  if (size(out) > cap) {
    out.recentFailures = out.recentFailures.slice(0, 3);
    out.recentSchemaChanges = out.recentSchemaChanges.slice(0, 3);
  }
  return out;
}

export const context: CommandImpl<ContextData> = {
  run: (ctx) => runContext(ctx),
  human(result, ctx) {
    return formatContext(result.data, ctx.now(), ctx.project.timezone, result.problems);
  },
};

export async function runContext(ctx: Ctx, deps: StatusDeps = {}): Promise<CommandResult<ContextData>> {
  const project = ctx.project;
  const tz = project.timezone;
  const now = ctx.now();
  const since = new Date(now.getTime() - 7 * DAY_MS);
  const state = await collectStatus(project, now, {
    home: deps.home ?? croftHome(ctx.processEnv), ...(deps.scheduleView ? { scheduleView: deps.scheduleView } : {}),
  });
  const configs = await declareProjectSecrets(ctx, project, state.resolved
    ? state.resolved.assets.map(configOf)
    : await loadConfigs(project, state.discovered, { importTimeoutMs: INSPECT_IMPORT_TIMEOUT_MS }));
  const byConfig = new Map(configs.map((c) => [c.name, c]));
  const byCatalog = new Map(state.catalog.map((c) => [c.asset, c]));
  const reads = readsOf(state.resolved, state.catalog);

  let filter: Set<string> | null = null;
  const wanted = ctx.values.asset;
  if (wanted !== undefined) {
    const names = (Array.isArray(wanted) ? wanted : [wanted]).map(String);
    const known = state.data.assets.map((a) => a.asset);
    for (const n of names) {
      if (!known.includes(n)) {
        const guess = didYouMean(n, known);
        throw new CroftError("UNKNOWN_TABLE", {
          message: `there is no asset named ${n}`,
          hint: guess ? `did you mean ${guess}?` : "croft status lists the assets",
          fix: guess ? { kind: "command", description: `use ${guess}`, command: `croft context --asset ${guess}` }
            : { kind: "command", description: "list the assets", command: "croft status" },
          details: { asset: n, ...(guess ? { suggestion: guess } : {}) },
        });
      }
    }
    filter = new Set(names);
  }
  const keep = (asset: string) => !filter || filter.has(asset);

  const recentFailures: FailureEntry[] = state.recentSteps
    .filter((s) => keep(s.asset))
    .map((s) => ({ s, status: effectiveStatus(s, state.dead) }))
    .filter(({ status }) => (FAILED_STATUSES as readonly string[]).includes(status))
    .slice(0, 20)
    .map(({ s, status }) => ({
      asset: s.asset, runId: s.runId, at: zoned(s.finishedAt ?? s.startedAt, tz)!, status, code: s.error?.code ?? null,
      message: s.error?.message ?? null,
    }));

  const warehouseProblems: Problem[] = [];
  let recentSchemaChanges = await warehouseChanges(ctx, since, (p) => warehouseProblems.push(p));
  let schemaChangesFrom: ContextData["schemaChangesFrom"] = "warehouse";
  if (recentSchemaChanges === null) {
    schemaChangesFrom = "runs";
    recentSchemaChanges = state.summaryChanges.map((c) => changeEntry(c.asset, zoned(c.at, tz)!, c.runId, c.change));
  }
  // Drift that is no schema change of the table (§7): newest first with the rest.
  const drifted = state.drift.filter((e) => e.code !== "TYPE_WIDENED").map((e) => changeEntry(e.asset, zoned(e.at, tz)!, e.runId, driftChange(e)));
  if (drifted.length) recentSchemaChanges = [...recentSchemaChanges, ...drifted].sort((x, y) => epochMs(y.at) - epochMs(x.at));
  recentSchemaChanges = recentSchemaChanges.filter((c) => keep(c.asset)).slice(0, 50)
    .map((c) => ({ ...c, readBy: readersOf(c.asset, reads) }));

  let data: ContextData = {
    project: {
      root: project.root, database: project.databaseLabel, timezone: tz, assets: state.data.assets.length,
      scheduling: state.data.scheduling,
    },
    assets: state.data.assets.filter((a) => keep(a.asset))
      .map((a) => compact(a, byConfig.get(a.asset) ?? null, byCatalog.get(a.asset) ?? null, reads.get(a.asset) ?? [], tz)),
    running: state.data.running.filter((r) => r.asset === null || keep(r.asset)),
    held: state.data.assets.filter((a) => a.held && keep(a.asset)).map((a) => a.asset),
    recentFailures,
    recentSchemaChanges,
    schemaChangesFrom,
    truncated: false,
  };
  data = capContext(data);

  const problems: Problem[] = [
    ...state.problems, ...configs.filter((c) => keep(c.name)).flatMap((c) => c.problems),
    ...state.edited.filter((p) => p.asset === undefined || keep(p.asset)), ...warehouseProblems,
    ...state.scheduling.filter((p) => p.asset === undefined || keep(p.asset)),
  ];
  const next = data.truncated
    ? [{ command: "croft context --asset <name>", reason: "the payload was capped at 20 KB; narrow it to the assets you work on" }]
    : [];
  // context reports what it found; broken asset files are problems to fix, not a failure of the command.
  return { data, problems, next, ok: true, exit: 0 };
}

/** "scheduling on (last tick 12 s ago)", "scheduling paused until 14:00", "scheduling off". */
function schedulingWords(s: Scheduling, now: Date, tz: string): string {
  if (s.state === "paused") return `scheduling paused ${s.pausedUntil ? `until ${clockText(s.pausedUntil, tz, now)}` : "until croft schedule on"}`;
  if (s.state === "off") return "scheduling off";
  return `scheduling on (${s.lastTickAt ? `last tick ${agoText(s.lastTickAt, now)}` : "no tick yet"}${s.stale ? ", stale" : ""})`;
}

export function formatContext(d: ContextData, now: Date, tz = d.project.timezone, problems: readonly Problem[] = []): string {
  // An ASSET_RENAMED pair's rows say `croft rename`, never `croft run` (status.ts statusText).
  const renamed = renamedRows(problems);
  const lines = [`${d.project.root} · ${d.project.database} · ${d.project.timezone} · ${d.project.assets} asset${d.project.assets === 1 ? "" : "s"} · ${schedulingWords(d.project.scheduling, now, tz)}`];
  for (const a of d.assets) {
    const status: StatusAsset = {
      asset: a.asset, kind: a.kind, file: a.file, status: a.status, rows: a.rows, lastRun: a.lastRun,
      next: { at: null, reason: a.next as StatusAsset["next"]["reason"] }, stale: a.staleReasons.length > 0, staleReasons: a.staleReasons,
      held: a.hold !== undefined && d.held.includes(a.asset), ...(a.hold ? { hold: a.hold } : {}), edited: a.edited === true,
      ...(a.filesGone ? { filesGone: a.filesGone } : {}), ...(a.schemaChangedAt ? { schemaChangedAt: a.schemaChangedAt } : {}),
      ...(a.drift ? { drift: a.drift } : {}),
    };
    lines.push("");
    const rows = a.rows !== null ? `${formatCount(a.rows)} rows` : a.status === "unknown" || a.lastLoadedAt ? "rows unknown" : "not built";
    lines.push(`${a.asset} · ${a.kind ?? "unknown kind"} · ${a.file ?? "(no asset file)"} · ${rows} · ${statusText(status, now, renamed.get(a.asset))}`);
    if (a.description) lines.push(`  ${a.description}`);
    if (a.schedule) {
      const when = a.next === "schedule" ? (a.nextFireAt ? `next ${fireText(a.nextFireAt, tz, now)}` : "next fire unknown")
        : a.next === "paused" ? "paused" : "scheduling is off (croft schedule on)";
      lines.push(`  schedule  ${a.schedule} · ${when}`);
    }
    lines.push(`  behavior  ${a.behavior}`);
    if (a.cursor) lines.push(`  cursor    ${a.cursor.field} = ${a.cursor.value ?? "(nothing saved yet)"}`);
    if (a.reads.length) lines.push(`  reads     ${a.reads.join(", ")}`);
    if (a.columns?.length) lines.push(`  columns   ${columnsText(a.columns)}`);
    if (a.checks.length) lines.push(`  checks    ${a.checks.join(" · ")}`);
  }
  if (d.omitted?.length) lines.push("", `(${d.omitted.length} more assets not shown: ${d.omitted.join(", ")}; croft context --asset <name>)`);
  if (d.running.length) {
    lines.push("", "Running");
    for (const r of d.running) {
      const progress = [r.phase, r.rowsFetched !== null ? `${formatCount(r.rowsFetched)} rows fetched` : null].filter(Boolean);
      lines.push(`  ${r.runId}${r.asset ? ` ${r.asset}` : ""} since ${ago(r.since, now)}${progress.map((x) => ` · ${x}`).join("")}`);
    }
  }
  if (d.recentFailures.length) {
    lines.push("", "Recent failures (7 days)");
    for (const f of d.recentFailures) lines.push(`  ${f.asset} ${f.runId} ${f.status}${f.code ? ` ${f.code}` : ""} ${ago(f.at, now)}`);
  }
  if (d.recentSchemaChanges.length) {
    lines.push("", "Recent schema changes (7 days)");
    for (const c of d.recentSchemaChanges) {
      const what = c.kind === "add_column" ? `+ ${c.column} ${c.to ?? ""}` : c.kind === "widen" ? `${c.column} ${c.from} → ${c.to}`
        : c.kind === "column_stopped_arriving" ? `${c.column} stopped arriving`
        : c.kind === "json_kind_changed" ? `${c.column} JSON ${c.from} → ${c.to}` : `${c.kind}${c.column ? ` ${c.column}` : ""}`;
      lines.push(`  ${c.asset} ${what.trim()} ${ago(c.at, now)}`);
    }
  }
  return lines.join("\n");
}
