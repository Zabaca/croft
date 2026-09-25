// Behavior and pin changes of an ingest that already has data (DESIGN.md §6 "Nothing implicit destroys ingested
// data": "Behavior changes" and "Pin changes"; "Destructive operations need confirmation"; §7 "pinned column").
//
// Behavior. _croft.assets records how an ingest's rows were written: its write mode, its key, and behavior_hash
// (write mode, key and incremental field; a lookback or a unit is not part of it, so adding a lookback applies
// directly). When the code now says otherwise and the table has rows, the step fails with INGEST_CONFIG_CHANGED
// before it fetches anything: the stored rows were written under the old rules, and new ones written under the
// new rules would be mixed in silently (an append ingest's repeated rows under a merge, a merge keyed by another
// column, a cursor saved for another field). The fixes: put the change back, or `croft run x --rebuild`, which
// refetches from scratch (trash first, confirmation). A reordered or re-cased key is the same key.
//
// One change has a third fix (§6): an append ingest that gains a key, keeping its incremental field (a keyless
// append that becomes a merge or a keyed append), is converted in place. `croft run x` asks for it itself
// (action convert_key), because that is the command whose meaning the edit changed, and every destructive path
// still goes through `croft confirm` (§6 "How confirmation works"). The conversion keeps one stored row per key:
// the latest _loaded_at, then the highest cursor, then the last written. Stored rows without the key, or a key
// column the table lacks, rule it out (a merge never matches a NULL key). When no stored row would go (every key
// is already unique), nothing is destroyed and the new behavior applies with the write, without asking.
//
// Pins. The pins in the code are authoritative: a pin removed from the code unpins its column (write.ts records
// it, the column keeps its type and values), and a pin that differs from the stored type retypes the column. A
// new or changed pin is tested first by counting the stored values that would change:
// `try_cast(try_cast(x AS new) AS old) IS DISTINCT FROM x`. Stored text is converted the way cast.ts types
// arriving text instead (castExpr/lossExpr: a pin's strptime or money format, numbers compared exactly, instants
// as instants), so `'02134'` → 2134 counts and `'25/03/2026'` under { type: "DATE", format: "%d/%m/%Y" } does not.
//   - Lossless: the column is retyped in the write's own transaction, before any other DDL (applyPinChanges), and
//     reported as a widen whose TYPE_WIDENED says it followed the pin. This also covers a column the batch does
//     not carry.
//   - Lossy: PIN_CHANGES_DATA, with samples of what the values become, and confirmation (action pin_change).
// A pin type must be a plain SQL type that DuckDB knows; anything else is ASSET_INVALID, before any fetch.
//
// Where this runs:
//   settleConfig      runIngest, before it fetches: one short read lease (readConfigState), then either nothing
//                     to do, a failure, a confirmation (pending: the step is skipped with its token, having fetched
//                     nothing), or, once granted, the trash (its own commit) and then the change (applyConfigChange,
//                     one write transaction: every retype, then the deduplication, then _croft.assets/columns).
//                     So a fetch that fails afterwards never costs the confirmed change, and a step whose files
//                     turn out unchanged still has it. A preview applies the change to its own copy, without asking
//                     or trashing, and warns that a real run asks first. `--rebuild` skips all of it but the pin
//                     type checks: the table is rebuilt from scratch under the new rules.
//   applyPinChanges   writeBatch, ingests only: the lossless retypes, and PIN_CHANGES_DATA for a lossy one nobody
//                     confirmed (only a table changed between the check and the write gets there).
//
// A step asks at most one question: a key conversion and a lossy pin together are one convert_key confirmation
// whose impact names both (§6: one token per run).
import { CroftError, type ProblemInit, problem } from "../core/errors.ts";
import type { ColumnPlan, Confirmation, Fix, Impact, Problem, SchemaChange, Sql, StepResult, WriteMode } from "../core/types.ts";
import { now as clockNow, toEpochMicros } from "../core/time.ts";
import { canonicalPath } from "../db/connect.ts";
import { hasState } from "../db/state.ts";
import { getCatalog } from "../history/catalog.ts";
import type { IngestInput, IngestOutcome } from "../run/ingest.ts";
import type { ConfirmRequest } from "../run/step.ts";
import { isoMicros, readStoredColumns, type StoredColumn, tableStats } from "../safety/guards.ts";
import { plannedTrashPath, trashFailed, trashTable, type TrashEntry } from "../safety/trash.ts";
import { castExpr, lossExpr } from "./cast.ts";
import { RESERVED } from "./contract.ts";
import { currentDatabase, isReservedColumn, normalizeType, quoteIdent, type RealColumn, readTableSchema, safeType, tableRef } from "./evolve.ts";
import { normalizePins, type Pin, pinFor, typeFamily } from "./types.ts";

type Pins = Record<string, { type: string; format?: string }>;

const lower = (s: string) => s.toLowerCase();
const sameName = (a: string, b: string) => lower(a) === lower(b);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const were = (n: number) => (n === 1 ? "was" : "were");
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

// ---------------------------------------------------------------------------------------------------------
// Behavior

/** How _croft.assets says an ingest's rows were written. */
export interface StoredBehavior {
  kind: string | null;
  write: WriteMode | null;
  key: string[];
  behaviorHash: string | null;
}

/** How the code says they are written now (PlannedStep's write, key and behaviorHash). `hashWith` hashes another
 *  write mode and key with the code's incremental setting (project/resolve.ts behaviorHash), which tells a
 *  changed incremental field apart without _croft recording the field. */
export interface BehaviorNow {
  write: WriteMode;
  key: readonly string[];
  behaviorHash: string;
  hashWith: (write: WriteMode, key: readonly string[]) => string;
}

export type BehaviorPart = "write" | "key" | "incremental";

export interface BehaviorChange {
  changed: BehaviorPart[];
  from: { write: WriteMode; key: string[] };
  to: { write: WriteMode; key: string[] };
  /** A keyless append ingest gaining a key with the same incremental field, as a merge or a keyed append: its
   *  stored rows can be converted in place. */
  appendGainsKey: boolean;
}

function sameKey(a: readonly string[], b: readonly string[]): boolean {
  const x = a.map(lower).sort(), y = b.map(lower).sort();
  return x.length === y.length && x.every((k, n) => k === y[n]);
}

/** What changed between the recorded behavior and the code's, or null when nothing that counts did. Pure. */
export function behaviorChange(stored: StoredBehavior, now: BehaviorNow): BehaviorChange | null {
  if (stored.behaviorHash === null || stored.write === null) return null;
  if (stored.kind !== null && stored.kind !== "ingest") return null;
  if (stored.behaviorHash === now.behaviorHash) return null;
  const changed: BehaviorPart[] = [];
  if (stored.write !== now.write) changed.push("write");
  if (!sameKey(stored.key, now.key)) changed.push("key");
  if (now.hashWith(stored.write, stored.key) !== stored.behaviorHash) changed.push("incremental");
  if (changed.length === 0) return null;
  const appendGainsKey = stored.write === "append" && stored.key.length === 0 && now.key.length > 0
    && (now.write === "merge" || now.write === "append") && !changed.includes("incremental");
  return { changed, from: { write: stored.write, key: [...stored.key] }, to: { write: now.write, key: [...now.key] }, appendGainsKey };
}

/** How converting the stored rows to the new key would go. */
export interface KeyConversion {
  /** The key, spelled as the table's columns are. */
  key: string[];
  /** Stored rows the conversion removes (all but one per key). */
  removed: number;
  /** Stored rows with a NULL in the key: the conversion is not possible. */
  nullKeys: number;
  /** Key columns the table does not have: the conversion is not possible. */
  missing: string[];
  /** Up to 3 keys stored more than once, with how often. */
  sample: { key: Record<string, unknown>; rows: number }[];
}

/** Which of a key's rows stays: the latest _loaded_at, then the highest cursor, then the last written. */
function keepOrder(columns: RealColumn[], cursor?: string): string {
  const stamp = columns.find((c) => sameName(c.name, RESERVED.loadedAt));
  const cur = cursor ? columns.find((c) => sameName(c.name, cursor)) : undefined;
  return [stamp ? `${quoteIdent(stamp.name)} DESC NULLS LAST` : null, cur ? `${quoteIdent(cur.name)} DESC NULLS LAST` : null, "rowid DESC"]
    .filter(Boolean).join(", ");
}

async function countConversion(sql: Sql, o: { ref: string; key: readonly string[]; columns: RealColumn[]; cursor?: string }): Promise<KeyConversion> {
  const key = o.key.map((k) => o.columns.find((c) => sameName(c.name, k))?.name ?? k);
  const missing = o.key.filter((k) => !o.columns.some((c) => sameName(c.name, k)));
  if (missing.length) return { key, removed: 0, nullKeys: 0, missing, sample: [] };
  const part = key.map(quoteIdent).join(", ");
  const [row] = await sql.all<{ n: number | bigint; nulls: number | bigint }>(
    `SELECT (SELECT count(*) FROM (SELECT 1 FROM ${o.ref} QUALIFY row_number() OVER (PARTITION BY ${part} ORDER BY ${keepOrder(o.columns, o.cursor)}) > 1)) AS n,
       (SELECT count(*) FROM ${o.ref} WHERE ${key.map((k) => `${quoteIdent(k)} IS NULL`).join(" OR ")}) AS nulls`);
  const removed = Number(row!.n);
  const sample = removed === 0 ? [] : (await sql.all<Record<string, unknown>>(
    `SELECT ${part}, count(*) AS __rows FROM ${o.ref} GROUP BY ALL HAVING count(*) > 1 ORDER BY count(*) DESC, ${part} LIMIT 3`))
    .map((r) => {
      const { __rows, ...k } = JSON.parse(json(r)) as Record<string, unknown>;
      return { key: k, rows: Number(__rows) };
    });
  return { key, removed, nullKeys: Number(row!.nulls), missing: [], sample };
}

// ---------------------------------------------------------------------------------------------------------
// Pins

/** One pin that differs from its column's stored type. */
export interface PinChange {
  column: string;
  /** The stored type and the pin's, as DuckDB spells them (normalized). */
  from: string;
  to: string;
  /** The pin's strptime pattern or "money", used when the stored values are text. */
  format?: string;
  /** A NULL-only placeholder (_croft.columns.pending): retyped freely. */
  pending: boolean;
  nonNull: number;
  /** Stored values the retype would change. */
  changed: number;
  /** Up to 5 of them: the stored value as text, and what it would become (null: NULL). */
  samples: { value: string | null; becomes: string | null }[];
}

const SAMPLES = 5;

/** ASSET_INVALID for a pin whose type croft cannot use: not a plain SQL type, or none DuckDB knows. */
function badPin(o: { asset: string; file?: string }, column: string, type: string, why: string): CroftError {
  return new CroftError("ASSET_INVALID", {
    asset: o.asset, ...(o.file ? { file: o.file } : {}),
    message: `${o.asset}: the pin of column ${column}, "${type}", ${why}`,
    hint: "pin a plain SQL type such as BIGINT, DOUBLE, VARCHAR, DATE, TIMESTAMPTZ, JSON or DECIMAL(18,2)",
    effect: "nothing was fetched or written",
    fix: o.file
      ? { kind: "edit", description: `give ${column} a plain SQL type in columns, e.g. ${column}: "VARCHAR"`, file: o.file }
      : { kind: "manual", description: `give ${column} a plain SQL type in columns, e.g. ${column}: "VARCHAR"` },
    details: { column, type },
  });
}

/** The pin's type in DDL form, or ASSET_INVALID: it goes into DDL, so only a plain type passes (evolve.ts). */
function pinType(o: { asset: string; file?: string }, column: string, type: string): string {
  try {
    return safeType(type, column);
  } catch (e) {
    if (e instanceof CroftError && e.code === "ASSET_INVALID") throw badPin(o, column, type, "is not a plain SQL type");
    throw e;
  }
}

/** Every pin's type checked before anything is fetched: plain (pure), then known to DuckDB. Returns each pin's type
 *  as DuckDB spells it (typeof), normalized, by the pin's DDL form. Run outside a transaction: an unknown type is a
 *  failed statement. */
async function checkPinTypes(sql: Sql, o: { asset: string; file?: string; pins: Pins }): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ddl = Object.entries(o.pins).map(([column, p]) => [column, p.type, pinType(o, column, p.type)] as const);
  for (const [column, type, t] of ddl) {
    if (out.has(t)) continue;
    try {
      const [row] = await sql.all<{ t: string }>(`SELECT typeof(CAST(NULL AS ${t})) AS t`);
      out.set(t, normalizeType(row!.t));
    } catch {
      throw badPin(o, column, type, "is not a type DuckDB knows");
    }
  }
  return out;
}

/** The expressions that retype `column`: the conversion (ALTER … USING), and when a stored value counts as changed. */
function retypeExprs(column: string, from: string, to: string, format?: string): { cast: string; loss: string } {
  const x = quoteIdent(column);
  if (typeFamily(from) === "varchar") {
    // Stored text converts as cast.ts types arriving text; a value that becomes NULL is always a change (lossExpr
    // counts none for JSON targets).
    const cast = castExpr(x, to, { format: format ?? null });
    return { cast, loss: `(${x} IS NOT NULL AND ((${cast}) IS NULL OR ${lossExpr(x, `(${cast})`, to, { format: format ?? null })}))` };
  }
  const cast = `TRY_CAST(${x} AS ${to})`;
  return { cast, loss: `(${x} IS NOT NULL AND TRY_CAST(${cast} AS ${from}) IS DISTINCT FROM ${x})` };
}

export interface PinPlanInput {
  asset: string;
  /** The table's real columns (readTableSchema); none: nothing to retype. */
  real: RealColumn[] | null;
  /** _croft.columns (pending flags, source names). */
  stored: StoredColumn[];
  pins?: Pins;
  /** Pin types already resolved (checkPinTypes); others are resolved here when their spelling differs. */
  resolved?: Map<string, string>;
}

/** The pins that differ from their column's stored type, each with the stored values it would change. Read-only. */
export async function planPinChanges(sql: Sql, o: PinPlanInput): Promise<PinChange[]> {
  if (!o.real || !o.pins || Object.keys(o.pins).length === 0) return [];
  const pins = normalizePins(o.pins);
  const db = await currentDatabase(sql);
  const ref = tableRef(db, o.asset);
  const out: PinChange[] = [];
  for (const col of o.real) {
    if (isReservedColumn(col.name)) continue;
    const had = o.stored.find((c) => sameName(c.name, col.name));
    const pin: Pin | undefined = pinFor(pins, col.name, had?.source_name);
    if (!pin) continue;
    const ddl = safeType(pin.type, col.name);
    if (ddl === col.type) continue;
    let to = o.resolved?.get(ddl);
    if (to === undefined) {
      // An alias or a length DuckDB drops (VARCHAR(10), STRING[]): ask DuckDB what the type is.
      const [row] = await sql.all<{ t: string }>(`SELECT typeof(CAST(NULL AS ${ddl})) AS t`);
      to = normalizeType(row!.t);
    }
    if (to === col.type) continue;
    const { cast, loss } = retypeExprs(col.name, col.type, to, pin.format);
    const [row] = await sql.all<{ nn: number | bigint; changed: number | bigint }>(
      `SELECT count(${quoteIdent(col.name)}) AS nn, count(*) FILTER (WHERE ${loss}) AS changed FROM ${ref}`);
    const changed = Number(row!.changed);
    const samples = changed === 0 ? [] : await sql.all<{ value: string | null; becomes: string | null }>(
      `SELECT CAST(${quoteIdent(col.name)} AS VARCHAR) AS value, CAST(${cast} AS VARCHAR) AS becomes FROM ${ref} WHERE ${loss} ORDER BY rowid LIMIT ${SAMPLES}`);
    out.push({
      column: col.name, from: col.type, to, ...(pin.format ? { format: pin.format } : {}), pending: had?.pending === true,
      nonNull: Number(row!.nn), changed, samples: samples.map((s) => ({ value: s.value, becomes: s.becomes })),
    });
  }
  return out;
}

async function retype(tx: Sql, ref: string, c: PinChange): Promise<void> {
  const { cast } = retypeExprs(c.column, c.from, c.to, c.format);
  await tx.exec(`ALTER TABLE ${ref} ALTER COLUMN ${quoteIdent(c.column)} SET DATA TYPE ${c.to} USING ${cast}`);
}

/** How a sample reads in a message: text quoted, NULL as NULL. */
function sampleWords(c: PinChange): string {
  const text = typeFamily(c.from) === "varchar" || typeFamily(c.from) === "json";
  const v = (s: string | null, quoted: boolean) => (s === null ? "NULL" : quoted ? JSON.stringify(s) : s);
  const shown = c.samples.slice(0, 3).map((s) => `${v(s.value, text)} → ${v(s.becomes, typeFamily(c.to) === "varchar")}`);
  return shown.length ? ` (e.g. ${shown.join(", ")})` : "";
}

function pinWords(c: PinChange, asset: string): string {
  return `column ${c.column} of ${asset} is ${c.from}; its pin ${c.to} would change ${c.changed} of ${plural(c.nonNull, "stored value")}${sampleWords(c)}`;
}

function pinDetails(changes: PinChange[]): Record<string, unknown> {
  const first = changes[0]!;
  return {
    column: first.column, from: first.from, to: first.to, changed: changes.reduce((n, c) => n + c.changed, 0), nonNull: first.nonNull,
    samples: first.samples, columns: changes.map(({ column, from, to, changed, nonNull, samples }) => ({ column, from, to, changed, nonNull, samples })),
  };
}

/** PIN_CHANGES_DATA: pins that would change stored values. */
function pinChangesData(o: { asset: string; file?: string }, changes: PinChange[], effect: string): ProblemInit {
  const first = changes[0]!;
  const fixText = `pin ${first.column} as ${first.from} again (or remove its pin) to keep the stored values as they are`;
  return {
    asset: o.asset, ...(o.file ? { file: o.file } : {}),
    message: `${changes.map((c) => pinWords(c, o.asset)).join("; ")}; the table would go to the trash first`,
    hint: `a pin retypes the values already stored too; ask the user, and if they agree run croft run ${o.asset} again and confirm (the table goes to the trash first). Otherwise ${fixText}`,
    effect,
    fix: o.file ? { kind: "edit", description: fixText, file: o.file } : { kind: "manual", description: fixText },
    details: pinDetails(changes),
  };
}

export interface ApplyPinsInput extends PinPlanInput {
  file?: string;
  /** The batch's plans: a retyped column's type is set in them, so evolveTable finds the table as planned. */
  plans: ColumnPlan[];
}

export interface AppliedPins {
  plans: ColumnPlan[];
  changes: SchemaChange[];
  warnings: Problem[];
  /** A column holding values changed type: downstream reads a different table (last_replaced_at). */
  replaced: boolean;
}

/**
 * writeBatch's pin guard (ingests), before any other DDL: every pin that differs from its column's stored type
 * retypes the column when no stored value would change, and throws PIN_CHANGES_DATA when one would (runIngest has
 * already asked for, and applied, those; only a table changed in between gets here).
 */
export async function applyPinChanges(tx: Sql, o: ApplyPinsInput): Promise<AppliedPins> {
  const found = await planPinChanges(tx, o);
  if (found.length === 0) return { plans: o.plans, changes: [], warnings: [], replaced: false };
  const lossy = found.filter((c) => c.changed > 0);
  if (lossy.length) throw new CroftError("PIN_CHANGES_DATA", pinChangesData(o, lossy, "nothing was written"));
  const ref = tableRef(await currentDatabase(tx), o.asset);
  const changes: SchemaChange[] = [];
  const warnings: Problem[] = [];
  for (const c of found) {
    await retype(tx, ref, c);
    if (c.pending || c.nonNull === 0) {
      changes.push({ kind: "retype_pending", column: c.column, to: c.to });
      continue;
    }
    changes.push({ kind: "widen", column: c.column, from: c.from, to: c.to });
    warnings.push(problem("TYPE_WIDENED", {
      asset: o.asset,
      message: `column ${c.column} retyped from ${c.from} to ${c.to}, its pin; every stored value converted exactly`,
      hint: `SQL that reads ${c.column} now sees ${c.to}`,
      details: { column: c.column, from: c.from, to: c.to, pinned: true },
    }));
  }
  const plans = o.plans.map((p) => {
    const c = found.find((x) => sameName(x.column, p.column));
    if (!c) return p;
    return { ...p, existing: c.to, ...(p.target !== undefined && normalizeType(p.target) !== c.to ? { target: c.to } : {}) };
  });
  return { plans, changes, warnings, replaced: changes.some((c) => c.kind === "widen") };
}

// ---------------------------------------------------------------------------------------------------------
// Reading the state (runIngest, before it fetches)

export interface ConfigState {
  /** Rows in the table (0 when there is none). */
  rows: number;
  change: BehaviorChange | null;
  /** Present when change.appendGainsKey. */
  conversion?: KeyConversion;
  /** Pins that differ from their column's stored type. */
  pins: PinChange[];
}

export interface ReadConfigInput {
  asset: string;
  file?: string;
  pins: Pins;
  now: BehaviorNow;
  /** The cursor field, which orders a key's rows after _loaded_at. */
  cursor?: string;
  /** --rebuild: only the pin types are checked. */
  rebuild?: boolean;
}

/** Everything settleConfig decides on, read under one lease. Not in a transaction (checkPinTypes). */
export async function readConfigState(sql: Sql, o: ReadConfigInput): Promise<ConfigState> {
  const resolved = await checkPinTypes(sql, o);
  if (o.rebuild || !(await hasState(sql))) return { rows: 0, change: null, pins: [] };
  const db = await currentDatabase(sql);
  const columns = await readTableSchema(sql, o.asset, db);
  if (!columns) return { rows: 0, change: null, pins: [] };
  const ref = tableRef(db, o.asset);
  const [n] = await sql.all<{ n: number | bigint }>(`SELECT count(*) AS n FROM ${ref}`);
  const rows = Number(n!.n);
  const [a] = await sql.all<{ kind: string | null; write_mode: string | null; key_columns: string[] | null; behavior_hash: string | null }>(
    `SELECT kind, write_mode, key_columns, behavior_hash FROM _croft.assets WHERE name = $1`, [o.asset]);
  const change = a && rows > 0
    ? behaviorChange({ kind: a.kind, write: a.write_mode as WriteMode | null, key: a.key_columns ?? [], behaviorHash: a.behavior_hash }, o.now)
    : null;
  const conversion = change?.appendGainsKey
    ? await countConversion(sql, { ref, key: change.to.key, columns, ...(o.cursor ? { cursor: o.cursor } : {}) })
    : undefined;
  const pins = await planPinChanges(sql, { asset: o.asset, real: columns, stored: await readStoredColumns(sql, o.asset), pins: o.pins, resolved });
  return { rows, change, ...(conversion ? { conversion } : {}), pins };
}

// ---------------------------------------------------------------------------------------------------------
// The change itself

export interface ConfigChangeInput {
  asset: string;
  /** Lossy pins the user confirmed: retyped with the conversion that was shown. */
  pins: PinChange[];
  /** An append ingest gaining a key: keep one stored row per key, and record the new behavior. */
  convert?: { key: string[]; write: WriteMode; behaviorHash: string; cursor?: string };
  now?: Date;
}

/**
 * The confirmed change, in one write transaction after the trash committed: every retype (DDL first), then the
 * deduplication, then _croft.assets (the new behavior, the table's numbers so OUT_OF_BAND_CHANGE stays quiet, and
 * last_replaced_at, so what reads the table is rebuilt) and _croft.columns. Returns the rows removed.
 */
export async function applyConfigChange(tx: Sql, o: ConfigChangeInput): Promise<{ removed: number; changes: SchemaChange[] }> {
  const db = await currentDatabase(tx);
  const ref = tableRef(db, o.asset);
  const changes: SchemaChange[] = [];
  for (const c of o.pins) {
    await retype(tx, ref, c);
    changes.push({ kind: "widen", column: c.column, from: c.from, to: c.to });
  }
  let removed = 0;
  if (o.convert) {
    const columns = (await readTableSchema(tx, o.asset, db)) ?? [];
    const part = o.convert.key.map(quoteIdent).join(", ");
    // A DELETE's result is its row count [V].
    const [row] = await tx.all<{ Count: number | bigint }>(
      `DELETE FROM ${ref} WHERE rowid IN (SELECT rowid FROM ${ref} QUALIFY row_number() OVER (PARTITION BY ${part} ORDER BY ${keepOrder(columns, o.convert.cursor)}) > 1)`);
    removed = Number(row?.Count ?? 0);
  }
  const stats = await tableStats(tx, o.asset, db);
  const [s] = await tx.all<{ ll: number | bigint | null; lr: number | bigint | null }>(
    `SELECT epoch_us(last_loaded_at) AS ll, epoch_us(last_replaced_at) AS lr FROM _croft.assets WHERE name = $1`, [o.asset]);
  let stamp = toEpochMicros(o.now ?? clockNow());
  for (const v of [s?.ll, s?.lr, stats.maxLoadedAtUs]) if (v !== null && v !== undefined && BigInt(v) + 1n > stamp) stamp = BigInt(v) + 1n;
  const at = isoMicros(stamp);
  const max = stats.maxLoadedAtUs === null ? null : isoMicros(stats.maxLoadedAtUs);
  if (o.convert) {
    await tx.exec(
      `UPDATE _croft.assets SET write_mode = $2, key_columns = CAST($3::JSON AS VARCHAR[]), behavior_hash = $4, row_count = $5,
         max_loaded_at = $6::TIMESTAMPTZ, last_replaced_at = $7::TIMESTAMPTZ, updated_at = $7::TIMESTAMPTZ WHERE name = $1`,
      [o.asset, o.convert.write, json(o.convert.key), o.convert.behaviorHash, stats.rowCount, max, at]);
  } else {
    await tx.exec(
      `UPDATE _croft.assets SET row_count = $2, max_loaded_at = $3::TIMESTAMPTZ, last_replaced_at = $4::TIMESTAMPTZ, updated_at = $4::TIMESTAMPTZ WHERE name = $1`,
      [o.asset, stats.rowCount, max, at]);
  }
  for (const c of o.pins) {
    await tx.exec(`UPDATE _croft.columns SET type = $3, pinned = true, pending = false WHERE asset = $1 AND lower(name) = lower($2)`, [o.asset, c.column, c.to]);
  }
  return { removed, changes };
}

// ---------------------------------------------------------------------------------------------------------
// Problems

function incrementalWords(i: IngestInput["step"]["incremental"]): string {
  return i.kind === "cursor" ? i.field : i.kind === "files" ? "new and changed files" : i.kind === "new-rows" ? "new rows" : "none";
}

function label(b: { write: WriteMode; key: readonly string[] }): string {
  const k = b.key.join(", ");
  if (b.write === "merge") return `merge by ${k}`;
  return b.key.length ? `${b.write} (key ${k})` : b.write;
}

/** What changed, in words: "write: append → merge", "key: none → id", "incremental: at → created_at". */
function changeParts(c: BehaviorChange, incremental: { from: string | null; to: string }): string[] {
  const key = (k: string[]) => (k.length ? k.join(", ") : "none");
  const parts: string[] = [];
  if (c.changed.includes("write")) parts.push(`write: ${c.from.write} → ${c.to.write}`);
  if (c.changed.includes("key")) parts.push(`key: ${key(c.from.key)} → ${key(c.to.key)}`);
  if (c.changed.includes("incremental")) {
    parts.push(incremental.from !== null ? `incremental: ${incremental.from} → ${incremental.to}` : `incremental: now ${incremental.to}`);
  }
  return parts;
}

interface Owner { asset: string; file: string }

function keySample(conv: KeyConversion): string {
  const shown = conv.sample.map((s) => {
    const pairs = Object.entries(s.key).map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v) : String(v)}`);
    return `${pairs.length === 1 ? pairs[0] : `(${pairs.join(", ")})`} ×${s.rows}`;
  });
  return shown.length ? ` (e.g. ${shown.join(", ")})` : "";
}

/** INGEST_CONFIG_CHANGED. With `conversion` (and nothing ruling it out) the conversion is a third fix. */
function configChanged(o: Owner & { change: BehaviorChange; rows: number; incremental: { from: string | null; to: string };
  conversion?: KeyConversion; pins?: PinChange[] }): ProblemInit {
  const { asset, file, change, rows } = o;
  const parts = changeParts(change, o.incremental);
  const what = change.changed.map((p) => (p === "write" ? "write mode" : p === "key" ? "key" : "incremental field")).join(" and ");
  const conv = o.conversion;
  const blocked = conv && conv.missing.length ? `the stored rows have no column ${conv.missing.join(", ")}`
    : conv && conv.nullKeys > 0 ? `${plural(conv.nullKeys, "stored row")} ${conv.nullKeys === 1 ? "has" : "have"} no ${conv.key.join(", ")}` : null;
  const convertible = Boolean(conv) && !blocked;
  const rebuild = `croft run ${asset} --rebuild refetches everything under the new rules (its table goes to the trash first, and it asks for confirmation)`;
  const fixes: Fix[] = [
    { kind: "edit", description: `put the ${what} back as it was (${parts.join("; ")})`, file },
    { kind: "manual", requiresHuman: true, description: `ask the user whether to refetch from the source: ${rebuild}` },
  ];
  let message: string;
  let hint: string;
  if (convertible) {
    const k = conv!.key.join(", ");
    message = `${asset} now has the key ${k}, but its ${plural(rows, "stored row")} ${were(rows)} appended without one: converting it in place keeps the latest row of each ${k} and removes ${plural(conv!.removed, "duplicate row")}${keySample(conv!)}; its table goes to the trash first`;
    if (o.pins?.length) message += `; and ${o.pins.map((c) => pinWords(c, asset)).join("; ")}`;
    hint = `ask the user; if they agree, run croft run ${asset} again and confirm the conversion. Otherwise remove the key again, or ${rebuild}`;
    fixes.push({ kind: "manual", requiresHuman: true, description: `ask the user whether to convert in place: croft run ${asset} asks for confirmation, moves the table to the trash first, then keeps the latest row of each ${k}` });
  } else {
    message = `${asset}'s ${plural(rows, "stored row")} ${were(rows)} written as ${label(change.from)}, but its code now says ${label(change.to)} (${parts.join("; ")}); croft does not rewrite stored rows on its own${blocked ? `, and converting them in place is not possible: ${blocked}` : ""}`;
    hint = `put the ${what} back as it was in ${file}, or ${rebuild}`;
  }
  return {
    asset, file, message, hint, effect: "nothing was fetched or written", fix: fixes[0],
    details: {
      changed: change.changed, from: change.from, to: change.to, rows, convertible,
      ...(conv ? { removed: conv.removed, nullKeys: conv.nullKeys, missing: conv.missing, sample: conv.sample } : {}),
      ...(o.pins?.length ? { pins: pinDetails(o.pins) } : {}),
      fixes,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// runIngest's side

export interface ConfigSettled {
  /** Retypes the confirmed change made (StepResult.schemaChanges, before the write's own). */
  schemaChanges: SchemaChange[];
  /** What was applied, as warnings (the change and where the table went). */
  warnings: Problem[];
  /** The table's trashed version. */
  trashed?: TrashEntry;
  /** For the step's reason. */
  note?: string;
}

/** The confirmation command: `croft run x` itself asks, since the edit changed what it does. */
export const changeCommand = (asset: string) => `croft run ${asset}`;

/** CONFIRMATION_REQUIRED for a pending conversion or pin change: nothing was fetched or changed. */
function changeConfirmation(c: Confirmation, what: string): Problem {
  const asset = c.impact.asset;
  return problem("CONFIRMATION_REQUIRED", {
    asset,
    message: `needs confirmation: ${what}`,
    hint: `first the current table goes to the trash (.croft/trash/${asset}/); ask the user, and only if they agree: croft confirm ${c.token} (valid 15 min)`,
    effect: "nothing was fetched or changed",
    fix: { kind: "manual", requiresHuman: true, description: `show the user this impact; only after an explicit yes: croft confirm ${c.token}` },
    details: { token: c.token, expiresAt: c.expiresAt, action: c.impact.action, rows: c.impact.rows, trashPath: c.impact.trashPath ?? null },
  });
}

/**
 * Settle a behavior or pin change before the ingest fetches anything (see the header). Throws INGEST_CONFIG_CHANGED,
 * PIN_CHANGES_DATA or ASSET_INVALID; returns `{ outcome }` for a confirmation that is waiting (the step is skipped),
 * or what was applied. `hashWith` is the planner's behaviorHash with the step's incremental setting.
 */
export async function settleConfig(i: IngestInput, o: { started: number; hashWith: BehaviorNow["hashWith"] }): Promise<{ outcome: IngestOutcome } | ConfigSettled> {
  const { step, warehouse, log, signal, runId } = i;
  const asset = step.asset;
  const inc = step.incremental;
  const cursor = inc.kind === "cursor" ? inc.field : undefined;
  const rebuild = i.rebuild === true || step.reasons.includes("rebuild");
  const state = await warehouse.read((db) => readConfigState(db, {
    asset, file: step.file, pins: step.spec?.pins ?? {}, rebuild, ...(cursor ? { cursor } : {}),
    now: { write: step.write, key: step.key, behaviorHash: step.behaviorHash, hashWith: o.hashWith },
  }), { purpose: `check how ${asset}'s rows are written`, signal });
  const { change, conversion } = state;
  const lossy = state.pins.filter((c) => c.changed > 0);
  const owner = { asset, file: step.file };
  // _croft does not record the incremental field; the catalog mirror knows a cursor ingest's.
  const was = change ? getCatalog(i.runs, asset)?.cursor?.field ?? null : null;
  const incremental = { from: was !== null && was !== cursor ? was : null, to: incrementalWords(inc) };

  if (change) {
    const blocked = !change.appendGainsKey || !conversion || conversion.missing.length > 0 || conversion.nullKeys > 0;
    if (blocked) throw new CroftError("INGEST_CONFIG_CHANGED", configChanged({ ...owner, change, rows: state.rows, incremental, ...(conversion ? { conversion } : {}) }));
  }
  const convert = change && conversion ? conversion : undefined;
  if ((!convert || convert.removed === 0) && lossy.length === 0) {
    if (convert) log.write(`${asset} gains the key ${convert.key.join(", ")}: every stored row already has its own, so the rows are kept as they are`);
    return { schemaChanges: [], warnings: [] };
  }

  // Destructive: one question for everything this step would change (§6: one token per run).
  const k = convert?.key.join(", ");
  const actions = [...(convert && convert.removed > 0 ? [`append ingest gains key ${k}; duplicates removed in place`] : []),
    ...lossy.map((c) => `pin change: ${c.column} ${c.from} → ${c.to}`)];
  const stateDir = canonicalPath(i.project.paths.stateDir);
  const impact: Impact = {
    asset, action: actions.join("; "), rows: (convert?.removed ?? 0) + lossy.reduce((n, c) => n + c.changed, 0),
    trashPath: plannedTrashPath(stateDir, asset), downstream: [...step.readBy],
  };
  const converting = convert !== undefined && convert.removed > 0;
  const init: ProblemInit = converting
    ? configChanged({ ...owner, change: change!, rows: state.rows, incremental, conversion: convert, pins: lossy })
    : pinChangesData(owner, lossy, "nothing was fetched or written");
  const code = converting ? "INGEST_CONFIG_CHANGED" : "PIN_CHANGES_DATA";
  const what = converting
    ? `${asset} would keep one row per ${k}, removing ${plural(convert!.removed, "duplicate row")}${lossy.length ? `, and ${lossy.map((c) => `${c.column} would become ${c.to} (${plural(c.changed, "value")} change)`).join(", ")}` : ""}`
    : lossy.map((c) => `${c.column} of ${asset} would become ${c.to}: ${plural(c.changed, "stored value")} change`).join("; ");

  let trashed: TrashEntry | null = null;
  const preview = i.preview !== undefined;
  if (!preview) {
    if (!i.confirmChange) throw new CroftError(code, init);
    const req: ConfirmRequest = { asset, action: converting ? "convert_key" : "pin_change", command: changeCommand(asset), impact, problem: problem(code, init) };
    const decision = await i.confirmChange(req);
    if (decision.kind === "declined") throw new CroftError(code, init);
    if (decision.kind === "pending") {
      const c = decision.confirmation;
      log.write(`needs confirmation ${c.token}: ${what}`);
      return { outcome: pendingOutcome(i, c, what, state.rows, o.started, req.problem) };
    }
    log.write(`confirmed: moving ${asset} to the trash first, then ${converting ? "converting it in place" : "retyping its pinned columns"}`);
    const why = `${converting ? `key ${k} added` : `pin ${lossy.map((c) => `${c.column} ${c.from} → ${c.to}`).join(", ")}`} (${runId})`;
    try {
      trashed = await trashTable(warehouse, asset, why, { runId, signal });
    } catch (te) {
      const busy = te instanceof CroftError && (te.code === "DB_BUSY" || te.code === "DB_HELD_BY_OTHER_PROGRAM");
      if (busy) throw te;
      throw trashFailed(asset, te);
    }
    if (i.fault === "between_trash_and_drop") process.kill(process.pid, "SIGKILL");
  } else {
    log.write(`preview: ${what}; applied to the preview's copy (a real run asks for confirmation first)`);
  }

  const applied = await warehouse.write(`change ${asset}`, (tx) => applyConfigChange(tx, {
    asset, pins: lossy,
    ...(convert ? { convert: { key: convert.key, write: step.write, behaviorHash: step.behaviorHash, ...(cursor ? { cursor } : {}) } } : {}),
    ...(i.now ? { now: i.now() } : {}),
  }), { runId, asset, signal });

  const where = trashed ? `; the previous table is in the trash: ${trashed.path}` : preview ? "; a real run asks for confirmation first" : "";
  const extra = { ...(trashed ? { trashPath: trashed.path, trashedRows: trashed.rows } : {}), ...(preview ? { preview: true } : {}) };
  const warnings: Problem[] = [];
  if (converting) {
    warnings.push({
      ...problem("INGEST_CONFIG_CHANGED", {
        asset, file: step.file,
        message: `${asset} was converted in place to ${label({ write: step.write, key: convert!.key })}: ${plural(applied.removed, "duplicate row")} removed${where}`,
        hint: trashed ? `croft restore ${asset} brings the previous table back` : "the preview's copy shows what the conversion keeps",
        details: { removed: applied.removed, key: convert!.key, ...extra },
      }),
      severity: "warning",
    });
  }
  if (lossy.length) {
    warnings.push({
      ...problem("PIN_CHANGES_DATA", {
        asset, file: step.file,
        message: `${lossy.map((c) => `column ${c.column} retyped from ${c.from} to ${c.to}, its pin: ${plural(c.changed, "stored value")} changed`).join("; ")}${where}`,
        hint: trashed ? `croft restore ${asset} brings the previous table back` : "the preview's copy shows the retyped values",
        details: { ...pinDetails(lossy), ...extra },
      }),
      severity: "warning",
    });
  }
  const note = [converting ? `converted in place to ${label({ write: step.write, key: convert!.key })} (${plural(applied.removed, "duplicate row")} removed)` : null,
    lossy.length ? `retyped ${lossy.map((c) => c.column).join(", ")} to match the pins` : null].filter(Boolean).join("; ");
  return { schemaChanges: applied.changes, warnings, ...(trashed ? { trashed } : {}), note };
}

/** The step's outcome while its confirmation waits: skipped, nothing fetched or written. `cause` (INGEST_CONFIG_CHANGED or
 *  PIN_CHANGES_DATA, with its samples) goes with it as a warning, so the person asked sees what would change (§6). */
function pendingOutcome(i: IngestInput, c: Confirmation, what: string, rows: number, started: number, cause: Problem): IngestOutcome {
  const { step } = i;
  const result: StepResult = {
    asset: step.asset, status: "skipped", reason: "needs confirmation", behavior: step.behavior, attempt: i.attempt, maxAttempts: i.maxAttempts,
    skippedBecause: `${what}; confirmation ${c.token} is waiting for a human`,
    rows: { in: 0, added: 0, updated: 0, unchanged: 0, deleted: 0, total: rows }, schemaChanges: [], checks: [], requests: 0,
    logsCommand: `croft logs ${step.asset}`, durationMs: Date.now() - started,
  };
  const shown: Problem = { ...cause, severity: "warning", hint: `show the user these values with the confirmation's impact; only after an explicit yes: croft confirm ${c.token}` };
  return { result, warnings: [shown], problems: [changeConfirmation(c, what)], confirmation: c };
}
