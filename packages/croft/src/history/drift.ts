// Recent drift (DESIGN.md §7 "Drift that does not fail a load is still reported"). COLUMN_STOPPED_ARRIVING,
// JSON_KIND_CHANGED and TYPE_WIDENED are warnings of the write that met them (load/write.ts, load/types.ts); the run
// engine stores every run's command result, problems included, in runs.summary. This reads them back, so status (a
// short "drift" note per asset), context (recentSchemaChanges) and doctor show them without opening the warehouse:
// newest first, one entry per asset, code and column, the latest.
//
// A widening is also a schema change of _croft.writes, which status and context already show; it is listed here too, so
// the drift note names all three.
import type { Problem } from "../core/types.ts";
import type { RunsDb } from "./runs-db.ts";

export const DRIFT_CODES = ["COLUMN_STOPPED_ARRIVING", "JSON_KIND_CHANGED", "TYPE_WIDENED"] as const;
export type DriftCode = (typeof DRIFT_CODES)[number];

export interface DriftEntry {
  asset: string;
  code: DriftCode;
  column: string | null;
  /** A few words: "login stopped arriving", "user now also string", "amount BIGINT → DOUBLE". */
  text: string;
  /** When the run that reported it finished (runs.sqlite, UTC ISO). */
  at: string;
  runId: string;
  /** COLUMN_STOPPED_ARRIVING: the assets that read the column. */
  readBy: string[];
  details: Record<string, unknown>;
}

const isDrift = (code: unknown): code is DriftCode => (DRIFT_CODES as readonly unknown[]).includes(code);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** The few words a drift warning comes down to, from its details. */
export function driftText(code: DriftCode, details: Record<string, unknown>): string {
  const column = typeof details.column === "string" ? details.column : null;
  if (!column) return code === "COLUMN_STOPPED_ARRIVING" ? "a column stopped arriving" : code === "JSON_KIND_CHANGED" ? "a JSON column changed kind" : "a column widened";
  if (code === "COLUMN_STOPPED_ARRIVING") return `${column} stopped arriving`;
  if (code === "JSON_KIND_CHANGED") return `${column} now also ${list(details.added).join(", ") || "another kind"}`;
  return `${column} ${details.from ?? "?"} → ${details.to ?? "?"}`;
}

/** The drift warnings of runs that started at or after `since`, newest first, one per asset, code and column. */
export function recentDrift(db: RunsDb | null, since: Date): DriftEntry[] {
  if (!db) return [];
  const out: DriftEntry[] = [];
  const seen = new Set<string>();
  for (const r of db.listRuns({ since, limit: 500 })) {
    const problems = (r.summary as { problems?: unknown } | null)?.problems;
    if (!Array.isArray(problems)) continue;
    for (const p of problems as Partial<Problem>[]) {
      if (!p || typeof p !== "object" || !isDrift(p.code) || typeof p.asset !== "string") continue;
      const details = p.details && typeof p.details === "object" ? p.details : {};
      const column = typeof details.column === "string" ? details.column : null;
      const key = `${p.asset}\0${p.code}\0${column?.toLowerCase() ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        asset: p.asset, code: p.code, column, text: driftText(p.code, details), at: r.finishedAt ?? r.startedAt, runId: r.id,
        readBy: list(details.readBy), details,
      });
    }
  }
  return out;
}

/** An asset's entries (newest first) in a few words: "login stopped arriving, user now also string (+1 more)". */
export function driftTexts(entries: readonly Pick<DriftEntry, "text">[], max = 3): string {
  const shown = entries.slice(0, max).map((e) => e.text).join(", ");
  return `${shown}${entries.length > max ? ` (+${entries.length - max} more)` : ""}`;
}

/** status's note for an asset's entries: "drift: login stopped arriving, user now also string (+1 more)"; "" for none. */
export function driftNote(entries: readonly Pick<DriftEntry, "text">[]): string {
  return entries.length === 0 ? "" : `drift: ${driftTexts(entries)}`;
}

/** An entry as a schema change of context.recentSchemaChanges ({kind, column, from, to}). */
export function driftChange(e: DriftEntry): Record<string, unknown> {
  const column = e.column ?? undefined;
  if (e.code === "COLUMN_STOPPED_ARRIVING") return { kind: "column_stopped_arriving", column };
  if (e.code === "JSON_KIND_CHANGED") {
    const before = list(e.details.before);
    return { kind: "json_kind_changed", column, from: before.join(", "), to: [...before, ...list(e.details.added)].join(", ") };
  }
  return { kind: "widen", column, from: e.details.from, to: e.details.to };
}
