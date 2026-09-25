// EMPTY_EXTRACT (DESIGN.md §3a "Cursor semantics", Warnings): an ingest with a lookback re-reads a window of rows on
// every run, from since = saved cursor − lookback. When a run gets no rows at all, although the table has rows whose
// cursor lies inside that window (so the window held rows last time), the source most likely stopped answering
// for real: a revoked or expired token that some APIs answer with an empty list, or a filter changed in rows().
// A warning, never a failure: nothing was lost, and the cursor did not move (zero rows leave it unchanged).
import { problem } from "../core/errors.ts";
import type { Problem, Sql } from "../core/types.ts";
import { hasState } from "../db/state.ts";
import { type ExtractInfo, isoMicros } from "../safety/guards.ts";
import { currentDatabase, quoteIdent, tableRef } from "./evolve.ts";
import { cursorColumn } from "./partial.ts";

export interface EmptyExtractInput {
  asset: string;
  /** The incremental field. */
  field: string;
  /** The `since` the run handed rows(): the saved cursor minus the lookback. */
  since: string | number;
  /** What extraction saw: requests, the last status and body. */
  extract?: ExtractInfo;
}

/** EMPTY_EXTRACT for a run of `asset` that extracted no rows, or null when its table has no row in the window. */
export async function detectEmptyExtract(db: Sql, o: EmptyExtractInput): Promise<Problem | null> {
  if (!(await hasState(db))) return null;
  const col = await cursorColumn(db, o.asset, o.field);
  if (!col) return null;
  const since = String(o.since);
  const ref = tableRef(await currentDatabase(db), o.asset);
  // A since the column's type cannot read counts nothing (try_cast gives NULL).
  const [row] = await db.all<{ n: number | bigint }>(
    `SELECT count(*) AS n FROM ${ref} WHERE ${quoteIdent(col.name)} >= try_cast($1::VARCHAR AS ${col.type})`, [since]);
  const windowRows = Number(row?.n ?? 0);
  if (windowRows === 0) return null;
  const [last] = await db.all<{ us: number | bigint; rows: number | bigint }>(
    `SELECT epoch_us(loaded_at) AS us, rows_in AS rows FROM _croft.writes WHERE asset = $1 AND rows_in > 0 ORDER BY loaded_at DESC LIMIT 1`,
    [o.asset]);
  const e = o.extract;
  const answered = e?.lastStatus !== undefined
    ? `; this run made ${e.requests} request${e.requests === 1 ? "" : "s"}, the last answered ${e.lastStatus}${e.bodyPreview ? ` with ${e.bodyPreview}` : ""}`
    : "";
  return problem("EMPTY_EXTRACT", {
    asset: o.asset,
    message: `${o.asset} returned no rows, but ${windowRows} of its rows have ${o.field} at or after ${since}, the start of its lookback window: last time that window held rows`,
    hint: `this usually means a revoked or expired token (some APIs answer with an empty list rather than an error) or a changed filter in rows(); read the requests in croft logs ${o.asset}${answered}`,
    effect: "nothing was written; the saved position did not move",
    fix: { kind: "command", description: "read this run's requests and what the API answered", command: `croft logs ${o.asset}` },
    details: {
      field: o.field, since, windowRows, requests: e?.requests ?? null, lastStatus: e?.lastStatus ?? null, bodyPreview: e?.bodyPreview ?? null,
      lastRows: last ? { loadedAt: isoMicros(BigInt(last.us)), rows: Number(last.rows) } : null,
    },
  });
}
