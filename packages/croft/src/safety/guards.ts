// Guards that keep ingested data safe (DESIGN.md §6 "Nothing implicit destroys ingested data", §5
// "Versions, staleness and atomicity" → "Out-of-band changes", §5 step 3a).
//
// - SHRINK_GUARD: a replace ingest that would lose more than half of its rows (all of them included) fails,
//   because an expired token that returns [] must not wipe the table. The fix needs a human.
// - OUT_OF_BAND_CHANGE: every commit records row_count and max(_loaded_at) in _croft.assets; a table whose
//   real numbers differ was written by something other than croft.
// - TABLE_MODIFIED_OUTSIDE_CROFT: the real schema (duckdb_columns()) differs from _croft.columns.
import { CroftError, problem } from "../core/errors.ts";
import type { Problem, Sql } from "../core/types.ts";
import { hasState } from "../db/state.ts";
import { formatNaive } from "../db/values.ts";
import { RESERVED } from "../load/contract.ts";
import { currentDatabase, isReservedColumn, normalizeType, quoteIdent, type RealColumn, readTableSchema, tableRef } from "../load/evolve.ts";

// ---------------------------------------------------------------------------------------------------------
// Shrink guard

/** What extraction saw, for the SHRINK_GUARD details ("the source returned 0 of 265 rows"). */
export interface ExtractInfo { requests?: number; lastStatus?: number; bodyPreview?: string }

export interface ShrinkInput {
  asset: string;
  rowsBefore: number;
  rowsAfter: number;
  allowShrink?: boolean;
  extract?: ExtractInfo;
}

/** More than half of the rows would go (all of them included). Losing exactly half is allowed. */
export function wouldShrink(rowsBefore: number, rowsAfter: number): boolean {
  return rowsBefore > 0 && 2 * (rowsBefore - rowsAfter) > rowsBefore;
}

export function shrinkGuardError(o: ShrinkInput): CroftError {
  return new CroftError("SHRINK_GUARD", {
    asset: o.asset,
    message: `${o.asset} would go from ${o.rowsBefore} rows to ${o.rowsAfter}; croft does not let a replace ingest remove more than half of its rows`,
    hint: "an expired token or a changed filter often returns few or no rows; check what the source returned before overriding",
    effect: `nothing was written; ${o.asset} keeps its ${o.rowsBefore} rows`,
    fix: { kind: "manual", requiresHuman: true, description: `find out why the source returned ${o.rowsAfter} of ${o.rowsBefore} rows before overriding (croft run ${o.asset} --allow-shrink, which trashes the current rows first)` },
    retryable: false,
    details: { rowsBefore: o.rowsBefore, rowsAfter: o.rowsAfter, ...o.extract },
  });
}

/**
 * Throws SHRINK_GUARD when the replace would lose more than half of the rows. With allowShrink the write
 * goes ahead and the SHRINK_GUARD_DISABLED warning says what the guard would have stopped.
 */
export function assertNoShrink(o: ShrinkInput): Problem | null {
  if (!wouldShrink(o.rowsBefore, o.rowsAfter)) return null;
  if (!o.allowShrink) throw shrinkGuardError(o);
  return shrinkGuardDisabled(o.asset, { rowsBefore: o.rowsBefore, rowsAfter: o.rowsAfter });
}

/** SHRINK_GUARD_DISABLED: an asset sets `allowShrink: true` (validate), or an override let a shrink through. */
export function shrinkGuardDisabled(asset: string, o: { file?: string; line?: number; rowsBefore?: number; rowsAfter?: number } = {}): Problem {
  const shrank = o.rowsBefore !== undefined && o.rowsAfter !== undefined;
  return problem("SHRINK_GUARD_DISABLED", {
    asset,
    file: o.file,
    line: o.line,
    message: shrank
      ? `${asset} went from ${o.rowsBefore} rows to ${o.rowsAfter} with the shrink guard off`
      : `${asset} turns the shrink guard off (allowShrink: true); a source that suddenly returns nothing would empty the table`,
    hint: "remove allowShrink unless the source really shrinks this much; a one-off override is croft run <asset> --allow-shrink",
    fix: o.file ? { kind: "edit", description: "remove allowShrink: true", file: o.file, line: o.line } : undefined,
    details: shrank ? { rowsBefore: o.rowsBefore, rowsAfter: o.rowsAfter } : undefined,
  });
}

// ---------------------------------------------------------------------------------------------------------
// Real table numbers

export interface TableStats {
  exists: boolean;
  rowCount: number;
  /** max(_loaded_at) in epoch microseconds; null for an empty table or one without _loaded_at. */
  maxLoadedAtUs: bigint | null;
  columns: RealColumn[];
}

const big = (v: unknown): bigint | null => (v === null || v === undefined ? null : BigInt(v as number | bigint | string));

/** Row count, newest _loaded_at and columns of an asset's table as it really is. */
export async function tableStats(sql: Sql, table: string, database?: string): Promise<TableStats> {
  const db = database ?? (await currentDatabase(sql));
  const columns = await readTableSchema(sql, table, db);
  if (!columns) return { exists: false, rowCount: 0, maxLoadedAtUs: null, columns: [] };
  const stamp = columns.find((c) => c.name.toLowerCase() === RESERVED.loadedAt);
  // A _loaded_at retyped outside croft is read through try_cast rather than failing the write.
  const max = !stamp ? "NULL" : stamp.type === "TIMESTAMPTZ" ? `epoch_us(max(${quoteIdent(stamp.name)}))`
    : `epoch_us(max(try_cast(${quoteIdent(stamp.name)} AS TIMESTAMPTZ)))`;
  const [row] = await sql.all<{ n: number | bigint; m: number | bigint | null }>(`SELECT count(*) AS n, ${max} AS m FROM ${tableRef(db, table)}`);
  return { exists: true, rowCount: Number(row!.n), maxLoadedAtUs: big(row!.m), columns };
}

/** ISO-8601 UTC with microseconds, the form croft binds TIMESTAMPTZ parameters in. */
export function isoMicros(us: bigint): string {
  return `${formatNaive(us, true)}Z`;
}

// ---------------------------------------------------------------------------------------------------------
// Out-of-band changes

export interface OutOfBand {
  expected: { rowCount: number; maxLoadedAt: string | null };
  actual: { exists: boolean; rowCount: number; maxLoadedAt: string | null };
  problem: Problem;
}

/**
 * Compare what croft recorded at its last commit with the table. null when croft never committed a write
 * of this asset, or when the numbers agree. Updates that keep the row count and newest stamp are not seen;
 * `croft preview --rebuild` finds those.
 */
export async function detectOutOfBand(sql: Sql, asset: string, stats?: TableStats): Promise<OutOfBand | null> {
  if (!(await hasState(sql))) return null;
  const [row] = await sql.all<{ row_count: number | bigint | null; max_us: number | bigint | null }>(
    `SELECT row_count, epoch_us(max_loaded_at) AS max_us FROM _croft.assets WHERE name = $1`, [asset]);
  if (!row || row.row_count === null) return null;
  const s = stats ?? (await tableStats(sql, asset));
  const expectedRows = Number(row.row_count);
  const expectedMax = big(row.max_us);
  if (s.exists && s.rowCount === expectedRows && s.maxLoadedAtUs === expectedMax) return null;
  const iso = (us: bigint | null) => (us === null ? null : isoMicros(us));
  const expected = { rowCount: expectedRows, maxLoadedAt: iso(expectedMax) };
  const actual = { exists: s.exists, rowCount: s.rowCount, maxLoadedAt: iso(s.maxLoadedAtUs) };
  const now = s.exists ? `it now has ${s.rowCount} rows (newest _loaded_at ${actual.maxLoadedAt ?? "none"})` : "the table no longer exists";
  return {
    expected,
    actual,
    problem: problem("OUT_OF_BAND_CHANGE", {
      asset,
      message: `${asset} was changed outside croft: croft left ${expectedRows} rows (newest _loaded_at ${expected.maxLoadedAt ?? "none"}); ${now}`,
      hint: "croft keeps the table as it is now and rebuilds what reads it; to refetch it from the source: croft run " + asset + " --rebuild",
      effect: "assets that read it are rebuilt on their next run",
      details: { expected, actual },
    }),
  };
}

/**
 * Accept an out-of-band change: bump last_replaced_at (downstream becomes stale) and record the table's real
 * numbers so the change is reported once. For callers outside writeBatch, which folds this into its upsert.
 */
export async function markOutOfBand(tx: Sql, asset: string, at: string, stats?: TableStats): Promise<void> {
  const s = stats ?? (await tableStats(tx, asset));
  await tx.exec(
    `UPDATE _croft.assets SET last_replaced_at = $2::TIMESTAMPTZ, row_count = $3, max_loaded_at = $4::TIMESTAMPTZ WHERE name = $1`,
    [asset, at, s.rowCount, s.maxLoadedAtUs === null ? null : isoMicros(s.maxLoadedAtUs)],
  );
}

// ---------------------------------------------------------------------------------------------------------
// Schema changed outside croft

export interface StoredColumn {
  name: string; type: string; source_name: string | null; format: string | null; pinned: boolean | null;
  pending: boolean | null; kinds: string[] | null; present_last_batch: boolean | null; added_at: string | null;
}

/** _croft.columns rows of an asset (types normalized); empty when croft has no record. */
export async function readStoredColumns(sql: Sql, asset: string): Promise<StoredColumn[]> {
  if (!(await hasState(sql))) return [];
  const rows = await sql.all<StoredColumn>(
    `SELECT name, type, source_name, format, pinned, pending, kinds, present_last_batch, added_at FROM _croft.columns WHERE asset = $1 ORDER BY added_at, name`,
    [asset]);
  return rows.map((r) => ({ ...r, type: r.type ? normalizeType(r.type) : r.type }));
}

export interface SchemaDiff { added: RealColumn[]; dropped: { name: string; type: string }[]; retyped: { column: string; stored: string; real: string }[] }

/** Compare the real columns (duckdb_columns()) with croft's record, ignoring croft's reserved columns. */
export function diffSchema(real: RealColumn[] | null, stored: { name: string; type: string }[]): SchemaDiff {
  const r = (real ?? []).filter((c) => !isReservedColumn(c.name));
  const s = stored.filter((c) => !isReservedColumn(c.name));
  const find = (list: { name: string }[], name: string) => list.find((c) => c.name.toLowerCase() === name.toLowerCase());
  const added = r.filter((c) => !find(s, c.name));
  const dropped = s.filter((c) => !find(r, c.name)).map((c) => ({ name: c.name, type: c.type }));
  const retyped: SchemaDiff["retyped"] = [];
  for (const c of r) {
    const had = s.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
    if (had && normalizeType(had.type) !== normalizeType(c.type)) retyped.push({ column: c.name, stored: normalizeType(had.type), real: normalizeType(c.type) });
  }
  return { added, dropped, retyped };
}

/** TABLE_MODIFIED_OUTSIDE_CROFT for a schema difference, or null when there is none (or no record yet). */
export function compareSchema(asset: string, real: RealColumn[] | null, stored: { name: string; type: string }[]): Problem | null {
  if (stored.length === 0) return null;
  const d = diffSchema(real, stored);
  if (real && d.added.length === 0 && d.dropped.length === 0 && d.retyped.length === 0) return null;
  const parts: string[] = [];
  if (!real) parts.push("the table was dropped");
  else {
    if (d.added.length) parts.push(`added ${d.added.map((c) => `${c.name} ${c.type}`).join(", ")}`);
    if (d.dropped.length) parts.push(`dropped ${d.dropped.map((c) => c.name).join(", ")}`);
    if (d.retyped.length) parts.push(`retyped ${d.retyped.map((c) => `${c.column} (${c.stored} → ${c.real})`).join(", ")}`);
  }
  return problem("TABLE_MODIFIED_OUTSIDE_CROFT", {
    asset,
    message: `${asset}'s columns were changed outside croft: ${parts.join("; ")}`,
    hint: `croft continues with the table as it is; if the change was a mistake, rebuild it: croft run ${asset} --rebuild`,
    details: { exists: real !== null, added: d.added, dropped: d.dropped, retyped: d.retyped },
  });
}

/** Read both schemas and compare them (DESIGN.md §5 step 3a). */
export async function detectTableModified(sql: Sql, asset: string, real?: RealColumn[] | null): Promise<Problem | null> {
  const stored = await readStoredColumns(sql, asset);
  if (stored.length === 0) return null;
  return compareSchema(asset, real === undefined ? await readTableSchema(sql, asset) : real, stored);
}
