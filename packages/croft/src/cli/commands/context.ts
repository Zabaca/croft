// croft context [--asset NAME…] (DESIGN.md §4.1, §4.3 "context", §9): the whole project in one payload, for
// an agent's first look: every asset as a compact describe (kind, file, behavior, key, cursor, rows, columns
// with JSON keys, checks, status, last run), what is running, recent failures and recent schema changes.
//
// It never waits on DuckDB (§5): asset facts come from the catalog mirror in runs.sqlite, and runs from
// runs.sqlite. Schema changes of the last 7 days come from _croft.writes when the warehouse can be opened at
// once (no write intent announced and no lock held), and otherwise from what runs recorded in their
// summaries. Asset files are imported (as validate does) for descriptions, checks and declared secrets.
//
// The payload is capped at 20 KB (§9.6). Past that it sheds detail in order: JSON keys, then column lists,
// then whole assets from the end (listed in data.omitted), and says truncated: true. --asset narrows it.
import { existsSync } from "node:fs";
import { CroftError, problem } from "../../core/errors.ts";
import { CHECKS_ENFORCED, CHECKS_NOT_ENFORCED } from "../../core/phase.ts";
import type { AssetKind, Problem } from "../../core/types.ts";
import { liveIntents } from "../../db/intent.ts";
import { hasState } from "../../db/state.ts";
import type { CatalogAsset } from "../../history/catalog.ts";
import { FAILED_STATUSES } from "../../history/runs-db.ts";
import { didYouMean } from "../../project/suggest.ts";
import type { Row } from "../../types.ts";
import type { CommandImpl } from "../command.ts";
import { formatCount, toJsonLine } from "../render.ts";
import { type AssetConfig, behaviorOf, checksOf, columnsText, declareProjectSecrets, isBusy, loadConfigs, readOnlyWarehouse } from "./describe.ts";
import { ago, collectStatus, effectiveStatus, type LastRun, type RunningEntry, type StatusAsset, statusText, zoned } from "./status.ts";

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
  next: string;
  reads: string[];
  checks: string[];
  columns?: { name: string; type: string; jsonKeys?: string[] }[];
  filesGone?: string[];
  schemaChangedAt?: string;
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
    scheduling: { state: "on" | "off" | "paused"; via: "os-job" | "serve" | null };
  };
  assets: CompactAsset[];
  /** false in phase 1: the assets' checks are listed, not run (core/phase.ts). */
  checksEnforced: boolean;
  running: RunningEntry[];
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

function compact(s: StatusAsset, config: AssetConfig | null, cat: CatalogAsset | null, tz: string): CompactAsset {
  const b = behaviorOf(config, cat);
  const out: CompactAsset = {
    asset: s.asset, kind: s.kind, file: s.file, description: config?.description ?? null, behavior: b.words, key: b.key,
    cursor: b.incremental?.kind === "cursor" ? { field: b.incremental.field, value: b.incremental.cursorValue } : null,
    rows: s.rows, lastLoadedAt: zoned(cat?.lastLoadedAt ?? null, tz), status: s.status, lastRun: s.lastRun,
    next: s.next.reason, reads: config?.inputs ?? [], checks: checksOf(config, b.key).map((c) => (c.blocking ? c.check : `warn ${c.check}`)),
  };
  if (s.filesGone) out.filesGone = s.filesGone;
  if (s.schemaChangedAt) out.schemaChangedAt = s.schemaChangedAt;
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
  async run(ctx) {
    const project = ctx.project;
    const tz = project.timezone;
    const now = ctx.now();
    const since = new Date(now.getTime() - 7 * DAY_MS);
    const state = await collectStatus(project, now);
    const configs = await declareProjectSecrets(ctx, project, await loadConfigs(project, state.discovered, { importTimeoutMs: 5000 }));
    const byConfig = new Map(configs.map((c) => [c.name, c]));
    const byCatalog = new Map(state.catalog.map((c) => [c.asset, c]));

    // Kinds known from the configs win over a look at the text.
    for (const a of state.data.assets) {
      const k = byConfig.get(a.asset)?.kind;
      if (k && !byCatalog.has(a.asset)) {
        a.kind = k;
        a.next = { at: null, reason: k === "ingest" ? "manual" : "after inputs" };
      }
    }

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
    recentSchemaChanges = recentSchemaChanges.filter((c) => keep(c.asset)).slice(0, 50);

    let data: ContextData = {
      project: {
        root: project.root, database: project.databaseLabel, timezone: tz, assets: state.data.assets.length,
        scheduling: { state: state.data.scheduling.state, via: state.data.scheduling.via },
      },
      assets: state.data.assets.filter((a) => keep(a.asset))
        .map((a) => compact(a, byConfig.get(a.asset) ?? null, byCatalog.get(a.asset) ?? null, tz)),
      checksEnforced: CHECKS_ENFORCED,
      running: state.data.running.filter((r) => r.asset === null || keep(r.asset)),
      held: [],
      recentFailures,
      recentSchemaChanges,
      schemaChangesFrom,
      truncated: false,
    };
    data = capContext(data);

    const problems: Problem[] = [...state.problems, ...configs.filter((c) => keep(c.name)).flatMap((c) => c.problems), ...warehouseProblems];
    const next = data.truncated
      ? [{ command: "croft context --asset <name>", reason: "the payload was capped at 20 KB; narrow it to the assets you work on" }]
      : [];
    // context reports what it found; broken asset files are problems to fix, not a failure of the command.
    return { data, problems, next, ok: true, exit: 0 };
  },
  human(result, ctx) {
    return formatContext(result.data, ctx.now());
  },
};

export function formatContext(d: ContextData, now: Date): string {
  const lines = [`${d.project.root} · ${d.project.database} · ${d.project.timezone} · ${d.project.assets} asset${d.project.assets === 1 ? "" : "s"} · scheduling ${d.project.scheduling.state}`];
  for (const a of d.assets) {
    const status: StatusAsset = {
      asset: a.asset, kind: a.kind, file: a.file, status: a.status, rows: a.rows, lastRun: a.lastRun,
      next: { at: null, reason: a.next as StatusAsset["next"]["reason"] }, stale: false, staleReasons: [], held: false, edited: false,
      ...(a.filesGone ? { filesGone: a.filesGone } : {}), ...(a.schemaChangedAt ? { schemaChangedAt: a.schemaChangedAt } : {}),
    };
    lines.push("");
    lines.push(`${a.asset} · ${a.kind ?? "unknown kind"} · ${a.file ?? "(no asset file)"} · ${a.rows === null ? "not built" : `${formatCount(a.rows)} rows`} · ${statusText(status, now)}`);
    if (a.description) lines.push(`  ${a.description}`);
    lines.push(`  behavior  ${a.behavior}`);
    if (a.cursor) lines.push(`  cursor    ${a.cursor.field} = ${a.cursor.value ?? "(nothing saved yet)"}`);
    if (a.reads.length) lines.push(`  reads     ${a.reads.join(", ")}`);
    if (a.columns?.length) lines.push(`  columns   ${columnsText(a.columns)}`);
    if (a.checks.length) lines.push(`  checks    ${a.checks.join(" · ")}`);
  }
  if (d.checksEnforced === false && d.assets.some((a) => a.checks.length)) lines.push("", CHECKS_NOT_ENFORCED);
  if (d.omitted?.length) lines.push("", `(${d.omitted.length} more assets not shown: ${d.omitted.join(", ")}; croft context --asset <name>)`);
  if (d.running.length) {
    lines.push("", "Running");
    for (const r of d.running) lines.push(`  ${r.runId}${r.asset ? ` ${r.asset}` : ""} since ${ago(r.since, now)}`);
  }
  if (d.recentFailures.length) {
    lines.push("", "Recent failures (7 days)");
    for (const f of d.recentFailures) lines.push(`  ${f.asset} ${f.runId} ${f.status}${f.code ? ` ${f.code}` : ""} ${ago(f.at, now)}`);
  }
  if (d.recentSchemaChanges.length) {
    lines.push("", "Recent schema changes (7 days)");
    for (const c of d.recentSchemaChanges) {
      const what = c.kind === "add_column" ? `+ ${c.column} ${c.to ?? ""}` : c.kind === "widen" ? `${c.column} ${c.from} → ${c.to}` : `${c.kind}${c.column ? ` ${c.column}` : ""}`;
      lines.push(`  ${c.asset} ${what.trim()} ${ago(c.at, now)}`);
    }
  }
  return lines.join("\n");
}
