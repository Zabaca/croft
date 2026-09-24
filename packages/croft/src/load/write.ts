// The write half of an ingest step (DESIGN.md §5 "One ingest step" steps 3f–3k, "Replace as a diff",
// "Why dedupe always runs first", "Versions, staleness and atomicity"; §7 "Merge semantics").
//
// writeBatch runs inside the write transaction, after cast.ts left a typed TEMP table (TypedBatch):
//
//   read state   _croft.assets/columns, the real table; OUT_OF_BAND_CHANGE, TABLE_MODIFIED_OUTSIDE_CROFT
//   KEY_NULL     before anything is written; transforms (sql, ts): a duplicate key is CHECK_FAILED unique(key)
//   drift        COLUMN_STOPPED_ARRIVING and JSON_KIND_CHANGED need the table as it was (not for sql)
//   evolve       all DDL (CREATE / ADD COLUMN / ALTER TYPE) before any DML on the table; a SQL transform's
//                SELECT defines its table instead (see "SQL transforms" below)
//   source       the batch aligned to the table's columns, deduplicated by key: highest typed cursor,
//                then highest _croft_seq (MERGE mishandles duplicate source keys both ways [V])
//   guards       SHRINK_GUARD
//   write        replace: MERGE … WHEN MATCHED AND <row differs> THEN UPDATE / NOT MATCHED THEN INSERT /
//                NOT MATCHED BY SOURCE THEN DELETE; keyless: a multiset diff on the row's content
//                append:  INSERT BY NAME
//                merge:   MERGE with an unchanged-row skip; columns absent from the batch keep their values
//                replaceFiles: the same diff, restricted to the rows of the reloaded files; with a key, see
//                "Overlapping files" below
//   checks       caller's blocking checks; a throw rolls the whole transaction back
//   state        cursor, _croft.assets, _croft.columns, _croft.writes (with the step attempt) and, for
//                transforms, _croft.inputs (positions) in the same transaction
//
// Changed rows get one stamp, greatest(now, last stamp + 1 µs), so _loaded_at is strictly increasing per
// table even when the clock steps back; unchanged rows keep theirs, so downstream work wakes only for real
// changes.
//
// Overlapping files (keyed incremental file ingests, DESIGN.md §3b sales.ts: "exports overlap; the key removes
// repeats"). A key's row comes from the latest file that provided it: a file provides its keys when it is
// loaded, and files loaded together provide them in read order (the batch dedupe keeps the last). So `_file`
// names the file a row belongs to, and a reload of changed files (replaceFiles) may only delete a row that
// belongs to a reloaded file AND whose key none of the files still has. files.ts therefore reads the asset's
// other, unchanged files along with a changed one and marks their rows in the FALLBACK column. Those rows are
// never loaded on their own: one of them is used only for a key whose row belongs to a reloaded file that no
// longer has it, taken from the most recently loaded such file (_croft.files.loaded_at, then read order), and
// it replaces the row in full (it is that file's row now). Only a key no file has any more is deleted.
//
// SQL transforms (kind "sql", DESIGN.md §5 "Transforms", §7 "SQL transforms"). The SELECT defines the table's
// shape: its data columns, in order, with the types it gave them (table-batch.ts). The same shape is diffed
// like any replace; any other shape (a column added, removed, retyped, renamed or moved) recreates the table in
// one CREATE OR REPLACE ... AS SELECT ... LIMIT 0 (which keeps STRUCT, MAP and other types no pin could spell,
// and rolls back cleanly [V]), so every row gets the new stamp, and the write reports SchemaChange "recreate".
// Nothing about the old shape is a drift warning: dropping a column is the SQL's decision. A column's type
// comes from the SQL, so it is never pending.
//
// Transform keys. A key is what a transform says identifies a row, and its implied unique(key) is a check: a
// duplicate key in a SQL or TS transform's batch fails CHECK_FAILED with samples before anything is written.
// Only ingests keep deduplicating (an API sends a changed row twice; the last one wins).
import { CroftError, problem } from "../core/errors.ts";
import type { AssetKind, ColumnPlan, CursorType, Problem, SchemaChange, Sql, StepResult, ValueKind } from "../core/types.ts";
import { type InstantInput, now as clockNow, toEpochMicros } from "../core/time.ts";
import { ensureState } from "../db/state.ts";
import { assertNoShrink, detectOutOfBand, type ExtractInfo, isoMicros, readStoredColumns, type StoredColumn, tableStats,
  compareSchema } from "../safety/guards.ts";
import { RESERVED, type TypedBatch, type WriteTarget } from "./contract.ts";
import { detectSinceIgnored, nextCursor, resolveCursorType } from "./cursor.ts";
import { currentDatabase, type EvolveResult, evolveTable, isReservedColumn, normalizeType, quoteIdent, quoteLiteral, type RealColumn,
  readTableSchema, tableRef, tempRef } from "./evolve.ts";

/**
 * BOOLEAN column files.ts adds to a typed batch that carries rows of unchanged files ("Overlapping files" above).
 * It has no ColumnPlan, so it never reaches the table; a row with it true is a fallback candidate, never loaded
 * on its own, and is not counted in rows.in.
 */
export const FALLBACK = "_croft_fallback";

export interface CheckContext {
  asset: string;
  /** Fully qualified reference to the asset's table (already written, not yet committed). */
  table: string;
  /** TEMP table holding the batch as written (aligned to the table's columns, deduplicated). */
  batch: string;
  /** The stamp of the rows this write changed. */
  loadedAt: string;
  rows: StepResult["rows"];
}

/** What a checks hook may return besides nothing: non-blocking findings, and one result per check it ran
 *  (StepResult.checks). A bare Problem[] is the findings alone. */
export interface CheckHookResult {
  problems: Problem[];
  results: StepResult["checks"];
}

/**
 * One transform input's position, upserted into _croft.inputs with the write (catalog.ts InputSeen has the
 * semantics). Instants are ISO-8601 (UTC, microseconds, as catalog entries carry them).
 */
export interface InputPosition {
  input: string;
  /** newRows()'s position: the stamp of the last input row processed (SQL and full-refresh steps: the input's
   *  last_loaded_at they read); null when nothing was read. */
  seenLoadedAt: string | null;
  /** The key of the last input row processed at seenLoadedAt, stored as JSON (bigints exactly); null or
   *  undefined when every row at seenLoadedAt was processed. */
  seenKey?: unknown;
  /** The input's last_loaded_at when the step last read all of it; null or undefined while the snapshot this
   *  position is in is not finished. Staleness compares with it. */
  inputLastLoadedAt?: string | null;
}

export interface WriteBatchInput {
  batch: TypedBatch;
  target: WriteTarget;
  /** The clock; default core/time now() (CROFT_NOW freezes it). */
  now?: InstantInput;
  /** Recorded in _croft.assets.kind; the shrink guard applies to ingests only. Default: the kind already
   *  recorded, else "ingest". "sql": the batch defines the table's shape (a different one recreates it); "sql"
   *  and "ts": a duplicate key is CHECK_FAILED unique(key) rather than deduplicated. */
  kind?: AssetKind;
  /** The asset's file, root-relative ("assets/open_issues.sql"), for the location and fix of problems. */
  file?: string;
  codeHash?: string;
  behaviorHash?: string;
  /** Pins from the asset's `columns` (for _croft.columns.pinned and format). */
  pins?: Record<string, { type: string; format?: string }>;
  /** Parse formats cast.ts decided for CSV date columns (column → strptime pattern). */
  formats?: Record<string, string>;
  /** The `since` handed to rows(), for SINCE_IGNORED and _croft.writes.since_used. */
  sinceUsed?: string | number;
  /** _croft.writes.inputs (TS transforms). */
  inputs?: unknown;
  /** Transforms: each input's position, upserted into _croft.inputs in this transaction, so a position commits
   *  with the rows it produced and never without them. */
  positions?: InputPosition[];
  /** The step attempt this write belongs to (runs.sqlite steps.attempt), for _croft.writes.attempt. reconcile()
   *  counts a crashed step's commits by it, so chunks an earlier failed attempt committed are not its own. */
  attempt?: number;
  /** Downstream assets per column, listed by COLUMN_STOPPED_ARRIVING. */
  readBy?: Record<string, string[]>;
  /** What extraction saw, for SHRINK_GUARD details. */
  extract?: ExtractInfo;
  /** Blocking checks, run after the write and before the bookkeeping. Throw to roll everything back; returned
   *  problems (non-blocking warnings) are passed through, and results become WriteResult.checks. */
  checks?: (tx: Sql, ctx: CheckContext) => Promise<Problem[] | CheckHookResult | void>;
}

export interface WriteResult {
  rows: StepResult["rows"];
  schemaChanges: SchemaChange[];
  cursor?: { before?: string; after?: string; sinceUsed?: string };
  /** The stamp given to added and updated rows (ISO-8601 UTC, microseconds). */
  loadedAt: string;
  /** Whether any row was added, updated or deleted. */
  changed: boolean;
  /** The table was created by this write (a SQL transform's recreated table is a "recreate" schema change). */
  created: boolean;
  /** batch.warnings plus what this write found. */
  warnings: Problem[];
  /** What the checks hook reported for each check it ran (empty without one, or when it returned none). */
  checks: StepResult["checks"];
}

interface AssetState {
  kind: string | null; cursor_value: string | null; cursor_type: CursorType | null; cursor_unit: string | null;
  code_hash: string | null; behavior_hash: string | null;
  last_loaded_us: bigint | null; last_replaced_us: bigint | null;
}

const big = (v: unknown): bigint | null => (v === null || v === undefined ? null : BigInt(v as number | bigint | string));
const lower = (s: string) => s.toLowerCase();
const sameName = (a: string, b: string) => lower(a) === lower(b);
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
// JSON.rawJSON (Bun, Node 21+) writes a bigint as its exact digits; TypeScript's lib does not declare it yet.
const rawJSON = (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON;
const exactJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? rawJSON(x.toString()) : x));

async function readAssetState(tx: Sql, asset: string): Promise<AssetState | null> {
  const [row] = await tx.all<Record<string, unknown>>(
    `SELECT kind, cursor_value, cursor_type, cursor_unit, code_hash, behavior_hash,
       epoch_us(last_loaded_at) AS last_loaded_us, epoch_us(last_replaced_at) AS last_replaced_us
     FROM _croft.assets WHERE name = $1`, [asset]);
  if (!row) return null;
  return {
    kind: row.kind as string | null, cursor_value: row.cursor_value as string | null, cursor_type: row.cursor_type as CursorType | null,
    cursor_unit: row.cursor_unit as string | null, code_hash: row.code_hash as string | null, behavior_hash: row.behavior_hash as string | null,
    last_loaded_us: big(row.last_loaded_us), last_replaced_us: big(row.last_replaced_us),
  };
}

let tempSeq = 0;

/** Write a typed batch into its asset's table. Call inside warehouse.write(); it never commits itself. */
export async function writeBatch(tx: Sql, input: WriteBatchInput): Promise<WriteResult> {
  const { batch, target } = input;
  const asset = target.asset;
  const warnings: Problem[] = [...batch.warnings];
  const warned = (code: string, column?: string) =>
    warnings.some((w) => w.code === code && (column === undefined || sameName(String(w.details?.column ?? ""), column)));

  await ensureState(tx);
  const db = await currentDatabase(tx);
  const ref = tableRef(db, asset);
  const state = await readAssetState(tx, asset);
  const kind: AssetKind = input.kind ?? (state?.kind as AssetKind | null) ?? "ingest";
  const stored = await readStoredColumns(tx, asset);
  const before = await tableStats(tx, asset, db);

  // 3a: something other than croft wrote or reshaped the table since the last commit.
  const oob = await detectOutOfBand(tx, asset, before);
  if (oob) warnings.push(oob.problem);
  if (!warned("TABLE_MODIFIED_OUTSIDE_CROFT")) {
    const p = compareSchema(asset, before.exists ? before.columns : null, stored);
    if (p) warnings.push(p);
  }

  const batchCols = await readTableSchema(tx, batch.temp, "temp");
  if (!batchCols) throw new CroftError("INTERNAL_ERROR", { message: `the batch table ${batch.temp} does not exist`, hint: "report this croft bug", asset });
  const inBatch = (name: string) => batchCols.find((c) => sameName(c.name, name));
  if (!inBatch(RESERVED.seq)) {
    throw new CroftError("INTERNAL_ERROR", { message: `the batch table ${batch.temp} has no ${RESERVED.seq} column`, hint: "report this croft bug", asset });
  }
  // A column is present when some row of the batch had the field. Absent columns keep their stored values in
  // a merge and become NULL in a replace (§7).
  const present = new Set<string>();
  for (const p of batch.columns) if (p.incoming.length > 0 && inBatch(p.column)) present.add(lower(p.column));
  if (inBatch(RESERVED.file)) present.add(RESERVED.file);
  // Rows this write loads: fallback rows (FALLBACK) only stand in for keys a reloaded file dropped.
  const fallbackCol = inBatch(FALLBACK)?.name;
  const rowsIn = fallbackCol ? await countLoaded(tx, batch.temp, fallbackCol) : batch.rows;

  const at = { asset, kind, ...(input.file ? { file: input.file } : {}) };
  // A SQL transform's output columns are known even without rows: a key it does not return is refused at once.
  if (target.key.length > 0 && (batch.rows > 0 || kind === "sql")) await assertKeys(tx, at, batch.temp, target.key, batchCols);
  if (target.write === "merge" && target.key.length === 0) {
    throw new CroftError("INTERNAL_ERROR", { message: `${asset}: a merge needs a key`, hint: "report this croft bug", asset });
  }
  if ((kind === "sql" || kind === "ts") && target.key.length > 0 && batch.rows > 0) {
    await assertUniqueKey(tx, { ...at, temp: batch.temp, key: target.key, rows: rowsIn, rowsBefore: before.rowCount, fallbackCol,
      columns: batchCols.filter((c) => batch.columns.some((p) => sameName(p.column, c.name))).map((c) => c.name) });
  }

  let evo: EvolveResult;
  let recreated = false;
  if (kind === "sql") {
    // The SELECT defines the table: create it, keep it, or recreate it with the new shape (DDL, before any DML).
    ({ evo, recreated } = await sqlShape(tx, { ref, db, asset, temp: batch.temp, plans: batch.columns, existed: before.exists }));
  } else {
    // Drift that needs the table as it was.
    if (before.exists && before.rowCount > 0 && rowsIn >= 100) {
      warnings.push(...(await stoppedArriving(tx, ref, asset, before, present, rowsIn, input.readBy ?? {})));
    }
    warnings.push(...jsonKindChanges(asset, batch.columns, stored, before.columns));
    // 3g: every ALTER before any DML.
    evo = await evolveTable(tx, { table: asset, plans: batch.columns, batchColumns: batchCols });
  }
  for (const c of evo.changes) {
    if (c.kind === "widen" && !warned("TYPE_WIDENED", c.column)) {
      warnings.push(problem("TYPE_WIDENED", {
        asset, message: `column ${c.column} widened from ${c.from} to ${c.to}`,
        hint: `stored values were kept exactly; SQL that reads ${c.column} now sees ${c.to}`, details: { column: c.column, from: c.from, to: c.to },
      }));
    }
  }
  const dataCols = evo.columns.filter((c) => !sameName(c.name, RESERVED.loadedAt));
  const n = ++tempSeq;
  const src = `__croft_w${n}_src`;
  const cursorCol = batch.cursor ? dataCols.find((c) => sameName(c.name, batch.cursor!.field)) : undefined;
  const { rows: srcRows, fallbacks } = await buildSource(tx, {
    asset, src, temp: batch.temp, dataCols, batchCols, key: target.key, cursorCol: cursorCol?.name, fallbackCol, ref,
    replaceFiles: target.replaceFiles,
  });

  // 3i: a replace ingest may not lose more than half its rows.
  if (kind === "ingest" && target.write === "replace" && !target.replaceFiles) {
    const w = assertNoShrink({ asset, rowsBefore: before.rowCount, rowsAfter: srcRows, allowShrink: target.allowShrink, extract: input.extract });
    if (w) warnings.push(w);
  }

  const stampUs = await nextStamp(tx, asset, state, before, input.now);
  const stamp = isoMicros(stampUs);
  const counts = await apply(tx, { ref, src, n, dataCols, present, target, srcRows, fallbacks, rowsBefore: recreated ? 0 : before.rowCount, stamp });
  // A recreated table starts empty: every earlier row is gone, and every row of the batch is new.
  if (recreated) counts.deleted = before.rowCount;

  const after = await tableStats(tx, asset, db);
  const rows = { in: rowsIn, ...counts, total: after.rowCount };
  const checks: StepResult["checks"] = [];
  if (input.checks) {
    const extra = await input.checks(tx, { asset, table: ref, batch: src, loadedAt: stamp, rows });
    if (Array.isArray(extra)) warnings.push(...extra);
    else if (extra) {
      warnings.push(...extra.problems);
      checks.push(...extra.results);
    }
  }

  // 3k: the cursor moves only with the rows, in the same transaction, and never backwards.
  let cursorValue = state?.cursor_value ?? null;
  let cursorType = state?.cursor_type ?? null;
  let cursorUnit = state?.cursor_unit ?? null;
  let cursor: WriteResult["cursor"];
  if (batch.cursor) {
    const col = inBatch(batch.cursor.field);
    if (col) {
      const next = await nextCursor(tx, { temp: batch.temp, field: col.name, rawTextColumn: batch.cursor.rawTextColumn, saved: cursorValue, asset });
      // The type is fixed by the first real value: an all-NULL cursor column is still a name-typed placeholder.
      if (next.batchMax !== null) {
        cursorType = resolveCursorType({ field: batch.cursor.field, columnType: col.type, unit: batch.cursor.unit, saved: cursorType, asset });
        cursorValue = next.value;
        cursorUnit = batch.cursor.unit ?? null;
      }
      if (input.sinceUsed !== undefined && batch.rows > 0) {
        const p = await detectSinceIgnored(tx, { asset, temp: batch.temp, field: col.name, since: input.sinceUsed });
        if (p) warnings.push(p);
      }
    }
    cursor = {
      before: state?.cursor_value ?? undefined,
      after: cursorValue ?? undefined,
      sinceUsed: input.sinceUsed === undefined ? undefined : String(input.sinceUsed),
    };
  }

  const changed = counts.added + counts.updated + counts.deleted > 0;
  const us = (v: bigint | null) => (v === null ? null : isoMicros(v));
  await tx.exec(
    `INSERT OR REPLACE INTO _croft.assets (name, kind, write_mode, key_columns, code_hash, behavior_hash, cursor_value, cursor_type,
       cursor_unit, last_loaded_at, last_replaced_at, row_count, max_loaded_at, updated_at)
     VALUES ($1, $2, $3, CAST($4::JSON AS VARCHAR[]), $5, $6, $7, $8, $9, $10::TIMESTAMPTZ, $11::TIMESTAMPTZ, $12, $13::TIMESTAMPTZ, $14::TIMESTAMPTZ)`,
    [asset, kind, target.write, json(target.key), input.codeHash ?? state?.code_hash ?? null,
      input.behaviorHash ?? state?.behavior_hash ?? null, cursorValue, cursorType, cursorUnit,
      changed ? stamp : us(state?.last_loaded_us ?? null), oob ? stamp : us(state?.last_replaced_us ?? null),
      after.rowCount, us(after.maxLoadedAtUs), stamp],
  );
  await writeColumns(tx, {
    asset, columns: evo.columns, plans: batch.columns, stored: recreated ? [] : stored, present, pins: input.pins, formats: input.formats, stamp,
    typedBySql: kind === "sql",
  });
  await tx.exec(
    `INSERT INTO _croft.writes (asset, loaded_at, run_id, mode, rows_in, added, updated, unchanged, deleted, cursor_before, cursor_after,
       since_used, inputs, schema_changes, code_hash, attempt)
     VALUES ($1, $2::TIMESTAMPTZ, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::JSON, $14::JSON, $15, $16::INTEGER)`,
    [asset, stamp, target.runId, target.write, rowsIn, counts.added, counts.updated, counts.unchanged, counts.deleted,
      state?.cursor_value ?? null, cursorValue, input.sinceUsed === undefined ? null : String(input.sinceUsed),
      input.inputs === undefined ? null : json(input.inputs), json(evo.changes), input.codeHash ?? null, input.attempt ?? null],
  );
  for (const p of input.positions ?? []) {
    await tx.exec(
      `INSERT OR REPLACE INTO _croft.inputs (asset, input, seen_loaded_at, seen_key, input_last_loaded_at)
       VALUES ($1, $2, $3::TIMESTAMPTZ, $4::JSON, $5::TIMESTAMPTZ)`,
      [asset, p.input, p.seenLoadedAt, p.seenKey === null || p.seenKey === undefined ? null : exactJson(p.seenKey), p.inputLastLoadedAt ?? null],
    );
  }
  for (const t of [src, `__croft_w${n}_old`, `__croft_w${n}_new`, `__croft_w${n}_pair`]) await tx.exec(`DROP TABLE IF EXISTS ${tempRef(t)}`);

  return { rows, schemaChanges: evo.changes, cursor, loadedAt: stamp, changed, created: evo.created, warnings, checks };
}

// ---------------------------------------------------------------------------------------------------------

/** Who a key problem is about: the asset, its kind (the wording differs), and its file (the fix). */
interface KeyOwner { asset: string; kind: AssetKind; file?: string }

async function assertKeys(tx: Sql, o: KeyOwner, temp: string, key: string[], batchCols: RealColumn[]): Promise<void> {
  const { asset } = o;
  const missing = key.filter((k) => !batchCols.some((c) => sameName(c.name, k)));
  const [row] = missing.length
    ? [{ n: -1 }]
    : await tx.all<{ n: number | bigint }>(`SELECT count(*) AS n FROM ${tempRef(temp)} WHERE ${key.map((k) => `${quoteIdent(k)} IS NULL`).join(" OR ")}`);
  const nulls = Number(row!.n);
  if (nulls === 0) return;
  let samples: Record<string, unknown>[] = [];
  if (!missing.length) {
    const cols = [RESERVED.seq, ...key].map(quoteIdent).join(", ");
    samples = (await tx.all<Record<string, unknown>>(
      `SELECT ${cols} FROM ${tempRef(temp)} WHERE ${key.map((k) => `${quoteIdent(k)} IS NULL`).join(" OR ")} ORDER BY ${quoteIdent(RESERVED.seq)} LIMIT 5`,
    )).map((r) => JSON.parse(json(r)) as Record<string, unknown>);
  }
  const keyText = key.join(", ");
  const sql = o.kind === "sql";
  const fixText = sql ? `leave rows without ${keyText} out of the SELECT, or change its -- key: line` : `skip rows without ${keyText} in rows()/map(), or change key`;
  throw new CroftError("KEY_NULL", {
    asset, ...(o.file ? { file: o.file } : {}),
    message: missing.length
      ? sql ? `${asset}: the key ${missing.join(", ")} is not a column its SELECT returns` : `${asset}: the key ${missing.join(", ")} is missing from every row of the batch`
      : `${asset}: ${nulls} row${nulls === 1 ? "" : "s"} have no value for the key ${keyText}`,
    hint: sql
      ? `a key is never empty; leave such rows out of the SELECT (WHERE ${key.map((k) => `${k} IS NOT NULL`).join(" AND ")}), or choose a key that is always set`
      : `a key is never empty; drop or fix such rows in rows() or map(), or choose a key that is always set`,
    effect: "nothing was written",
    fix: o.file ? { kind: "edit", description: fixText, file: o.file } : { kind: "manual", description: fixText },
    details: { key, rows: missing.length ? null : nulls, missing, samples },
  });
}

/** Rows CHECK_FAILED details carry, and how many of them its message shows (checks/run.ts does the same). */
const CHECK_SAMPLES = 20;
const CHECK_SHOWN = 3;

/** How a sample value reads in a message: text quoted, NULL as NULL. */
function shown(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  return typeof v === "string" ? JSON.stringify(v) : typeof v === "object" ? json(v) : String(v);
}

/**
 * A transform's key identifies one row (its implied unique(key) check): a duplicate in the batch is CHECK_FAILED
 * with up to 20 sample rows (every row of the first duplicated keys, in key then batch order), before anything
 * is written. Runs after assertKeys, so no key is NULL.
 */
async function assertUniqueKey(tx: Sql, o: KeyOwner & {
  temp: string; key: string[]; rows: number; rowsBefore: number; columns: string[]; fallbackCol?: string;
}): Promise<void> {
  const part = o.key.map(quoteIdent).join(", ");
  const loaded = o.fallbackCol ? ` WHERE NOT coalesce(${quoteIdent(o.fallbackCol)}, false)` : "";
  const groups = await tx.all<Record<string, unknown> & { __n: number | bigint }>(
    `SELECT ${part}, count(*) AS __n FROM ${tempRef(o.temp)}${loaded} GROUP BY ALL HAVING count(*) > 1 ORDER BY ${part}`);
  if (groups.length === 0) return;
  const failing = groups.reduce((n, g) => n + Number(g.__n), 0);
  const sample = (await tx.all<Record<string, unknown>>(
    `SELECT ${o.columns.map(quoteIdent).join(", ")} FROM ${tempRef(o.temp)}${loaded}
     QUALIFY count(*) OVER (PARTITION BY ${part}) > 1 ORDER BY ${part}, ${quoteIdent(RESERVED.seq)} LIMIT ${CHECK_SAMPLES}`,
  )).map((r) => JSON.parse(json(r)) as Record<string, unknown>);
  const keyText = o.key.join(", ");
  const keyOf = (g: Record<string, unknown>) => {
    const pairs = o.key.map((k) => `${k}=${shown(Object.entries(g).find(([c]) => sameName(c, k))?.[1])}`);
    return pairs.length === 1 ? pairs[0]! : `(${pairs.join(", ")})`;
  };
  const eg = groups.slice(0, CHECK_SHOWN).map((g) => `${keyOf(JSON.parse(json(g)) as Record<string, unknown>)} ×${Number(g.__n)}`).join(", ");
  const check = `unique(${keyText})`;
  const sql = o.kind === "sql";
  const fixText = sql
    ? `make the SELECT return one row per ${keyText}, or change its -- key: line`
    : `make rows() return one row per ${keyText}, or change key`;
  throw new CroftError("CHECK_FAILED", {
    asset: o.asset, ...(o.file ? { file: o.file } : {}),
    message: `${check}: ${failing} of ${o.rows} rows share their key with another row, e.g. ${eg}`,
    hint: sql
      ? `a key identifies one row: aggregate to one row per ${keyText} (GROUP BY ${keyText}), keep one of each (QUALIFY row_number() OVER (PARTITION BY ${keyText} ORDER BY …) = 1), or change its -- key: line`
      : `a key identifies one row: return one row per ${keyText} from rows(), or change key`,
    effect: `nothing was written; ${o.asset} keeps its previous ${o.rowsBefore} rows`,
    fix: o.file ? { kind: "edit", description: fixText, file: o.file } : { kind: "manual", description: fixText },
    details: { check, failing, sample },
  });
}

/** Columns as duckdb_columns() spells their types, unnormalized (a STRUCT's field names keep their case). */
async function rawColumns(tx: Sql, database: string, table: string): Promise<RealColumn[]> {
  return tx.all<RealColumn>(
    `SELECT column_name AS name, data_type AS type FROM duckdb_columns()
     WHERE database_name = $1 AND schema_name = 'main' AND table_name = $2 ORDER BY column_index`, [database, table]);
}

/**
 * A SQL transform's table takes the shape of its SELECT: the batch's data columns (those with a plan), in batch
 * order, with their exact types. The same shape keeps the table; none creates it, any other recreates it. Both
 * copy the batch's column definitions (LIMIT 0) and add _loaded_at, so no type is spelled out as text.
 */
async function sqlShape(tx: Sql, o: { ref: string; db: string; asset: string; temp: string; plans: ColumnPlan[]; existed: boolean }):
  Promise<{ evo: EvolveResult; recreated: boolean }> {
  const want = (await rawColumns(tx, "temp", o.temp)).filter((c) => !isReservedColumn(c.name) && o.plans.some((p) => sameName(p.column, c.name)));
  if (o.existed) {
    // Exactly the columns a create would make: the SELECT's, then _loaded_at (a stray _file, or a _loaded_at
    // that is not last, as an ingest's table may have, is another shape).
    const have = await rawColumns(tx, o.db, o.asset);
    const stamp = have.at(-1);
    const same = have.length === want.length + 1 && stamp?.name === RESERVED.loadedAt && normalizeType(stamp.type) === "TIMESTAMPTZ"
      && want.every((c, k) => c.name === have[k]!.name && c.type === have[k]!.type);
    if (same) return { evo: { created: false, changes: [], columns: (await readTableSchema(tx, o.asset, o.db))! }, recreated: false };
  }
  await tx.exec(`CREATE OR REPLACE TABLE ${o.ref} AS SELECT ${[...want.map((c) => quoteIdent(c.name)), `CAST(NULL AS TIMESTAMPTZ) AS ${quoteIdent(RESERVED.loadedAt)}`].join(", ")}
    FROM ${tempRef(o.temp)} LIMIT 0`);
  const columns = (await readTableSchema(tx, o.asset, o.db))!;
  return o.existed
    ? { evo: { created: false, changes: [{ kind: "recreate", reason: "shape_changed" }], columns }, recreated: true }
    : { evo: { created: true, changes: [], columns }, recreated: false };
}

/** Non-reserved columns set in ≥95% of earlier rows and absent from a whole batch of ≥100 rows. */
async function stoppedArriving(tx: Sql, ref: string, asset: string, before: { rowCount: number; columns: RealColumn[] },
  present: Set<string>, batchRows: number, readBy: Record<string, string[]>): Promise<Problem[]> {
  const absent = before.columns.filter((c) => !isReservedColumn(c.name) && !present.has(lower(c.name)));
  if (absent.length === 0) return [];
  const [row] = await tx.all<Record<string, number | bigint>>(
    `SELECT count(*) AS n, ${absent.map((c, i) => `count(${quoteIdent(c.name)}) AS c${i}`).join(", ")} FROM ${ref}`);
  const total = Number(row!.n);
  const out: Problem[] = [];
  absent.forEach((c, i) => {
    const share = total ? Number(row![`c${i}`]) / total : 0;
    if (share < 0.95) return;
    const by = Object.entries(readBy).find(([k]) => sameName(k, c.name))?.[1] ?? [];
    out.push(problem("COLUMN_STOPPED_ARRIVING", {
      asset,
      message: `column ${c.name} stopped arriving: it was set in ${Math.round(share * 1000) / 10}% of earlier rows and is missing from all ${batchRows} rows of this batch`,
      hint: `if the source renamed the field, map it back in rows()${by.length ? `; read by ${by.join(", ")}` : ""}`,
      details: { column: c.name, nonNullShare: share, batchRows, readBy: by },
    }));
  });
  return out;
}

// JSON kinds grouped the way `col->>'field'` cares about: it returns NULL on anything but an object.
const JSON_CLASS: Partial<Record<ValueKind | string, string>> = {
  object: "object", array: "array", string: "string", iso_instant: "string", iso_naive: "string", iso_date: "string",
  integer: "number", bigint: "number", float: "number", boolean: "boolean",
};

function jsonKindChanges(asset: string, plans: ColumnPlan[], stored: StoredColumn[], realBefore: RealColumn[]): Problem[] {
  const out: Problem[] = [];
  for (const plan of plans) {
    const s = stored.find((c) => sameName(c.name, plan.column));
    const type = realBefore.find((c) => sameName(c.name, plan.column))?.type ?? s?.type;
    if (!s || type !== "JSON" || !s.kinds?.length) continue;
    const had = new Set(s.kinds.map((k) => JSON_CLASS[k] ?? k));
    const added = [...new Set(plan.incoming.filter((k) => k !== "null").map((k) => JSON_CLASS[k] ?? k))].filter((k) => !had.has(k));
    if (added.length === 0) continue;
    out.push(problem("JSON_KIND_CHANGED", {
      asset,
      message: `JSON column ${plan.column} now also holds ${added.join(", ")} values (before: ${[...had].join(", ")})`,
      hint: `${plan.column}->>'field' returns NULL on anything but an object; check the SQL that reads ${plan.column}`,
      details: { column: plan.column, before: [...had], added },
    }));
  }
  return out;
}

// Casts a batch column may need to match the table: lossless widenings only. Anything else means cast.ts and
// the table disagree, and an implicit INSERT cast could round silently (DOUBLE 1.7 → BIGINT 2 [V]).
const INT_RANK: Record<string, number> = { TINYINT: 1, SMALLINT: 2, INTEGER: 3, BIGINT: 4, HUGEINT: 5 };
function losslessCast(from: string, to: string): boolean {
  if (INT_RANK[from] && INT_RANK[to]) return INT_RANK[from]! < INT_RANK[to]!;
  if (INT_RANK[from] && INT_RANK[from]! <= 3 && to === "DOUBLE") return true;
  if (from === "FLOAT" && to === "DOUBLE") return true;
  // §7: DATE widens to TIMESTAMP (naive midnight) or TIMESTAMPTZ (midnight in the session's project zone).
  return from === "DATE" && (to === "TIMESTAMP" || to === "TIMESTAMPTZ");
}

interface SourceInput {
  asset: string; src: string; temp: string; dataCols: RealColumn[]; batchCols: RealColumn[]; key: string[]; cursorCol?: string;
  /** The batch's FALLBACK column, when it has one. */
  fallbackCol?: string;
  /** The asset's table, and the files being reloaded (WriteTarget.replaceFiles). */
  ref: string;
  replaceFiles?: string[];
}

/** Rows of the batch this write loads (FALLBACK rows excluded). */
async function countLoaded(tx: Sql, temp: string, fallbackCol: string): Promise<number> {
  const [row] = await tx.all<{ n: number | bigint }>(
    `SELECT count(*) FILTER (WHERE NOT coalesce(${quoteIdent(fallbackCol)}, false)) AS n FROM ${tempRef(temp)}`);
  return Number(row!.n);
}

/**
 * The batch as a TEMP table with exactly the table's data columns (absent ones NULL), deduplicated by key.
 * FALLBACK rows are left out, except, for a keyed file reload, one per key whose row belongs to a reloaded file
 * that no longer has it ("Overlapping files" above); those carry FALLBACK = true in the source.
 */
async function buildSource(tx: Sql, o: SourceInput): Promise<{ rows: number; fallbacks: number }> {
  const b = (name: string) => o.batchCols.find((c) => sameName(c.name, name));
  const exprs: string[] = [];
  for (const col of o.dataCols) {
    const have = b(col.name);
    const q = quoteIdent(col.name);
    if (!have) exprs.push(`CAST(NULL AS ${col.type}) AS ${q}`);
    else if (have.type === col.type) exprs.push(`b.${quoteIdent(have.name)} AS ${q}`);
    else {
      const [row] = await tx.all<{ n: number | bigint }>(`SELECT count(${quoteIdent(have.name)}) AS n FROM ${tempRef(o.temp)}`);
      if (Number(row!.n) > 0 && !losslessCast(have.type, col.type)) {
        throw new CroftError("INTERNAL_ERROR", {
          asset: o.asset,
          message: `batch column ${have.name} is ${have.type} but ${o.asset}.${col.name} is ${col.type}; the typed batch must match the table`,
          hint: "report this croft bug",
          details: { column: col.name, batchType: have.type, tableType: col.type },
        });
      }
      exprs.push(`CAST(b.${quoteIdent(have.name)} AS ${col.type}) AS ${q}`);
    }
  }
  exprs.push(`b.${quoteIdent(RESERVED.seq)} AS ${quoteIdent(RESERVED.seq)}`);
  const fb = o.fallbackCol ? `coalesce(b.${quoteIdent(o.fallbackCol)}, false)` : null;
  const aligned = (where: string | null) => `SELECT ${exprs.join(", ")} FROM ${tempRef(o.temp)} AS b${where ? ` WHERE ${where}` : ""}`;
  let sql = aligned(fb ? `NOT ${fb}` : null);
  // An empty batch may lack the key columns altogether (and so may the table); there is nothing to dedupe.
  const keyed = o.key.length > 0 && o.key.every((k) => o.dataCols.some((c) => sameName(c.name, k)));
  if (keyed) {
    const order = [o.cursorCol ? `${quoteIdent(o.cursorCol)} DESC NULLS LAST` : null, `${quoteIdent(RESERVED.seq)} DESC`].filter(Boolean).join(", ");
    sql = `SELECT * FROM (${sql}) QUALIFY row_number() OVER (PARTITION BY ${o.key.map(quoteIdent).join(", ")} ORDER BY ${order}) = 1`;
  }
  const fileCol = o.dataCols.find((c) => sameName(c.name, RESERVED.file))?.name;
  const withFallback = Boolean(fb && keyed && fileCol && o.replaceFiles?.length);
  const flag = quoteIdent(FALLBACK);
  await tx.exec(`CREATE OR REPLACE TEMP TABLE ${quoteIdent(o.src)} AS ${withFallback ? `SELECT *, false AS ${flag} FROM (${sql})` : sql}`);
  let fallbacks = 0;
  if (withFallback) {
    const on = (l: string, r: string) => o.key.map((k) => `${l}.${quoteIdent(k)} = ${r}.${quoteIdent(k)}`).join(" AND ");
    const file = quoteIdent(fileCol!);
    // One candidate per key whose row belongs to a reloaded file and that no loaded row has: the most recently
    // loaded file that has it, then the last in read order.
    const [row] = await tx.all<{ Count: number | bigint }>(
      `INSERT INTO ${tempRef(o.src)} BY NAME
       SELECT * EXCLUDE (__croft_at), true AS ${flag} FROM (
         SELECT a.*, f.loaded_at AS __croft_at FROM (${aligned(fb)}) AS a
         LEFT JOIN _croft.files AS f ON f.asset = $1 AND f.path = a.${file}
         WHERE EXISTS (SELECT 1 FROM ${o.ref} AS t WHERE ${on("t", "a")} AND t.${file} IN (${o.replaceFiles!.map(quoteLiteral).join(", ")}))
           AND NOT EXISTS (SELECT 1 FROM ${tempRef(o.src)} AS s WHERE ${on("s", "a")})
         QUALIFY row_number() OVER (PARTITION BY ${o.key.map((k) => `a.${quoteIdent(k)}`).join(", ")}
           ORDER BY f.loaded_at DESC NULLS LAST, a.${quoteIdent(RESERVED.seq)} DESC) = 1)`, [o.asset]);
    fallbacks = Number(row?.Count ?? 0);
  }
  const [row] = await tx.all<{ n: number | bigint }>(`SELECT count(*) AS n FROM ${tempRef(o.src)}`);
  return { rows: Number(row!.n), fallbacks };
}

/** greatest(now, last stamp + 1 µs) over every stamp croft knows for the table: last_loaded_at, the newest
 *  _croft.writes row (its primary key) and the newest _loaded_at actually in the table. */
async function nextStamp(tx: Sql, asset: string, state: AssetState | null, before: { maxLoadedAtUs: bigint | null }, now?: InstantInput): Promise<bigint> {
  const [w] = await tx.all<{ us: number | bigint | null }>(`SELECT epoch_us(max(loaded_at)) AS us FROM _croft.writes WHERE asset = $1`, [asset]);
  let stamp = toEpochMicros(now ?? clockNow());
  for (const last of [state?.last_loaded_us ?? null, big(w?.us), before.maxLoadedAtUs]) {
    if (last !== null && last + 1n > stamp) stamp = last + 1n;
  }
  return stamp;
}

interface ApplyInput {
  ref: string; src: string; n: number; dataCols: RealColumn[]; present: Set<string>; target: WriteTarget;
  /** Rows in src, and how many of them are fallback rows (keyed file reloads only). */
  srcRows: number; fallbacks: number; rowsBefore: number; stamp: string;
}
type Counts = { added: number; updated: number; unchanged: number; deleted: number };

async function apply(tx: Sql, o: ApplyInput): Promise<Counts> {
  const { target } = o;
  const keyed = target.key.length > 0;
  if (o.rowsBefore === 0) return insertAll(tx, o);
  if (o.srcRows === 0) return emptyBatch(tx, o);
  if (keyed && target.write !== "append") return mergeByKey(tx, o);
  if (target.write === "replace" || target.replaceFiles) return diffByContent(tx, o);
  return insertAll(tx, o);
}

const cols = (list: RealColumn[], prefix = "") => list.map((c) => prefix + quoteIdent(c.name)).join(", ");

function fileScope(target: WriteTarget, alias: string): string | null {
  if (!target.replaceFiles) return null;
  if (target.replaceFiles.length === 0) return "false";
  return `${alias}${quoteIdent(RESERVED.file)} IN (${target.replaceFiles.map(quoteLiteral).join(", ")})`;
}

async function insertAll(tx: Sql, o: ApplyInput): Promise<Counts> {
  if (o.srcRows > 0) {
    await tx.exec(
      `INSERT INTO ${o.ref} BY NAME SELECT ${cols(o.dataCols)}, $1::TIMESTAMPTZ AS ${quoteIdent(RESERVED.loadedAt)} FROM ${tempRef(o.src)} ORDER BY ${quoteIdent(RESERVED.seq)}`,
      [o.stamp]);
  }
  return { added: o.srcRows, updated: 0, unchanged: 0, deleted: 0 };
}

/** No rows: a replace empties its scope (the shrink guard has already had its say), anything else is a
 *  no-op. Kept apart from the MERGE because an empty batch may not even carry the key columns. */
async function emptyBatch(tx: Sql, o: ApplyInput): Promise<Counts> {
  const scope = fileScope(o.target, "");
  if (!scope && o.target.write !== "replace") return { added: 0, updated: 0, unchanged: 0, deleted: 0 };
  // A DELETE's result is its row count [V].
  const [row] = await tx.all<{ Count: number | bigint }>(`DELETE FROM ${o.ref}${scope ? ` WHERE ${scope}` : ""}`);
  return { added: 0, updated: 0, unchanged: 0, deleted: Number(row?.Count ?? 0) };
}

/** MERGE by key. replace: every column is compared and set (absent → NULL) and unmatched table rows are
 *  deleted; merge: only columns present in the batch are compared and set. A fallback row (keyed file reload)
 *  always matches a row of a reloaded file and replaces it in full: the row is that other file's now. */
async function mergeByKey(tx: Sql, o: ApplyInput): Promise<Counts> {
  const { target } = o;
  const isKey = (name: string) => target.key.some((k) => sameName(k, name));
  const valueCols = o.dataCols.filter((c) => !isKey(c.name) && (target.write === "replace" || o.present.has(lower(c.name))));
  const stampCol = quoteIdent(RESERVED.loadedAt);
  const on = target.key.map((k) => `t.${quoteIdent(k)} = s.${quoteIdent(k)}`).join(" AND ");
  const clauses: string[] = [];
  const setOf = (list: RealColumn[]) => list.map((c) => `${quoteIdent(c.name)} = s.${quoteIdent(c.name)}`).join(", ");
  if (o.fallbacks > 0) {
    // The first WHEN whose condition holds applies [V]. Its _file always differs (a reloaded file's row).
    clauses.push(`WHEN MATCHED AND s.${quoteIdent(FALLBACK)} THEN UPDATE SET ${setOf(o.dataCols.filter((c) => !isKey(c.name)))}, ${stampCol} = $1::TIMESTAMPTZ`);
  }
  if (valueCols.length) {
    const differs = valueCols.map((c) => `t.${quoteIdent(c.name)} IS DISTINCT FROM s.${quoteIdent(c.name)}`).join(" OR ");
    clauses.push(`WHEN MATCHED AND (${differs}) THEN UPDATE SET ${setOf(valueCols)}, ${stampCol} = $1::TIMESTAMPTZ`);
  }
  clauses.push(`WHEN NOT MATCHED${o.fallbacks > 0 ? ` AND NOT s.${quoteIdent(FALLBACK)}` : ""} THEN INSERT (${cols(o.dataCols)}, ${stampCol}) VALUES (${cols(o.dataCols, "s.")}, $1::TIMESTAMPTZ)`);
  const scope = fileScope(target, "t.");
  if (scope) clauses.push(`WHEN NOT MATCHED BY SOURCE AND ${scope} THEN DELETE`);
  else if (target.write === "replace") clauses.push(`WHEN NOT MATCHED BY SOURCE THEN DELETE`);
  // MERGE cannot sit in a subquery or CTE [V], so the actions come back one row per changed row; unchanged
  // rows are not returned, which keeps this proportional to what was written.
  const actions = await tx.all<{ a: string }>(
    `MERGE INTO ${o.ref} AS t USING ${tempRef(o.src)} AS s ON (${on}) ${clauses.join(" ")} RETURNING merge_action AS a`, [o.stamp]);
  const c = { INSERT: 0, UPDATE: 0, DELETE: 0 } as Record<string, number>;
  for (const r of actions) c[r.a] = (c[r.a] ?? 0) + 1;
  const added = c.INSERT!, updated = c.UPDATE!, deleted = c.DELETE!;
  return { added, updated, deleted, unchanged: Math.max(0, o.srcRows - added - updated) };
}

/**
 * Keyless replace (and file reloads without a key-merge): pair table rows with batch rows of identical
 * content, occurrence by occurrence (a multiset diff), then delete the unpaired table rows and insert the
 * unpaired batch rows. Paired rows are untouched and keep their _loaded_at. DuckDB runs the pairing as a hash
 * join on IS NOT DISTINCT FROM [V], which hashes every column and compares values exactly, so no two
 * different rows can pair on a hash collision.
 */
async function diffByContent(tx: Sql, o: ApplyInput): Promise<Counts> {
  const old = `__croft_w${o.n}_old`, neu = `__croft_w${o.n}_new`, pair = `__croft_w${o.n}_pair`;
  const cmp = o.dataCols;
  const part = cmp.length ? `PARTITION BY ${cols(cmp)} ` : "";
  const scope = fileScope(o.target, "");
  await tx.exec(`CREATE OR REPLACE TEMP TABLE ${quoteIdent(old)} AS
    SELECT rowid AS __rid, row_number() OVER (${part}ORDER BY rowid) AS __n${cmp.length ? ", " + cols(cmp) : ""}
    FROM ${o.ref}${scope ? ` WHERE ${scope}` : ""}`);
  await tx.exec(`CREATE OR REPLACE TEMP TABLE ${quoteIdent(neu)} AS
    SELECT ${quoteIdent(RESERVED.seq)} AS __seq, row_number() OVER (${part}ORDER BY ${quoteIdent(RESERVED.seq)}) AS __n${cmp.length ? ", " + cols(cmp) : ""}
    FROM ${tempRef(o.src)}`);
  const match = ["o.__n = n.__n", ...cmp.map((c) => `o.${quoteIdent(c.name)} IS NOT DISTINCT FROM n.${quoteIdent(c.name)}`)].join(" AND ");
  await tx.exec(`CREATE OR REPLACE TEMP TABLE ${quoteIdent(pair)} AS SELECT o.__rid, n.__seq FROM ${tempRef(old)} o JOIN ${tempRef(neu)} n ON ${match}`);
  const [row] = await tx.all<{ o: number | bigint; p: number | bigint }>(
    `SELECT (SELECT count(*) FROM ${tempRef(old)}) AS o, (SELECT count(*) FROM ${tempRef(pair)}) AS p`);
  const oldRows = Number(row!.o), paired = Number(row!.p);
  const deleted = oldRows - paired, added = o.srcRows - paired;
  if (deleted > 0) {
    await tx.exec(`DELETE FROM ${o.ref} WHERE rowid IN (SELECT __rid FROM ${tempRef(old)} WHERE __rid NOT IN (SELECT __rid FROM ${tempRef(pair)}))`);
  }
  if (added > 0) {
    await tx.exec(
      `INSERT INTO ${o.ref} BY NAME SELECT ${cols(o.dataCols)}, $1::TIMESTAMPTZ AS ${quoteIdent(RESERVED.loadedAt)} FROM ${tempRef(o.src)}
       WHERE ${quoteIdent(RESERVED.seq)} NOT IN (SELECT __seq FROM ${tempRef(pair)}) ORDER BY ${quoteIdent(RESERVED.seq)}`,
      [o.stamp]);
  }
  return { added, updated: 0, unchanged: paired, deleted };
}

interface ColumnsInput {
  asset: string; columns: RealColumn[]; plans: ColumnPlan[]; stored: StoredColumn[]; present: Set<string>;
  pins?: Record<string, { type: string; format?: string }>; formats?: Record<string, string>; stamp: string;
  /** A SQL transform's columns: the SELECT typed them, so none is a pending placeholder. */
  typedBySql?: boolean;
}

/** Make _croft.columns describe the table as it now is: one row per non-reserved column. */
async function writeColumns(tx: Sql, o: ColumnsInput): Promise<void> {
  const real = o.columns.filter((c) => !isReservedColumn(c.name));
  await tx.exec(`DELETE FROM _croft.columns WHERE asset = $1 AND NOT list_contains(CAST($2::JSON AS VARCHAR[]), name)`,
    [o.asset, json(real.map((c) => c.name))]);
  const find = <T>(rec: Record<string, T> | undefined, name: string): T | undefined =>
    rec ? Object.entries(rec).find(([k]) => sameName(k, name))?.[1] : undefined;
  for (const col of real) {
    const plan = o.plans.find((p) => sameName(p.column, col.name));
    const had = o.stored.find((c) => sameName(c.name, col.name));
    const pin = find(o.pins, col.name);
    const pinned = o.pins ? pin !== undefined : (had?.pinned ?? false);
    const incoming = plan?.incoming ?? [];
    const nonNull = incoming.some((k) => k !== "null");
    // Pending: holds only NULLs so far. It starts with a new column and ends at its first real value.
    const pending = !o.typedBySql && !pinned && (had ? had.pending === true : plan !== undefined) && !nonNull;
    const kinds = [...new Set([...(had?.kinds ?? []), ...incoming.filter((k) => k !== "null")])];
    const format = find(o.formats, col.name) ?? pin?.format ?? had?.format ?? null;
    await tx.exec(
      `INSERT OR REPLACE INTO _croft.columns (asset, name, type, source_name, format, pinned, pending, kinds, present_last_batch, added_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CAST($8::JSON AS VARCHAR[]), $9, $10::TIMESTAMPTZ)`,
      [o.asset, col.name, col.type, plan?.sourceName ?? had?.source_name ?? col.name, format, pinned, pending, json(kinds),
        o.present.has(lower(col.name)), had?.added_at ?? o.stamp],
    );
  }
}
