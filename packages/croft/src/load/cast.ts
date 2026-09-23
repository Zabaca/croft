// Steps 3a–3e of an ingest write (DESIGN.md §5 "One ingest step", §7): stage → classify → plan → cast →
// verify, inside the write transaction. The result is a typed TEMP table plus the plan (TypedBatch), which
// write.ts evolves the real table with and writes from.
//
// Casts are explicit and read the JSON *text* (`v->>'$'`), never the JSON value: JSON → DECIMAL goes
// through DOUBLE, so 1.005 became 1.00 while the text gave 1.01 [V]. DuckDB casts that look clean are
// silently lossy too: `'…+02:00'::TIMESTAMP` drops the offset, `'1.5'::BIGINT` is 2 even through TRY_CAST,
// an implicit INSERT stored 1.7 as 2 in a BIGINT column [V]. So every cast is followed by a round-trip loss
// check: a row whose text is not NULL loses if its typed value is NULL or differs from the text compared
// canonically (numbers as exact decimals of the value cast back to text, integers in a DOUBLE as HUGEINT,
// timestamps as epoch instants). Any loss fails the load: TYPE_CONFLICT, or TYPE_PIN_VIOLATION /
// PIN_ROUNDED for pinned columns.
import { CroftError, problem } from "../core/errors.ts";
import type { CursorType, Fix, Problem, Sql, StageManifest } from "../core/types.ts";
import type { ColumnPin } from "../types.ts";
import { didYouMean } from "../project/suggest.ts";
import { type BatchCursor, RESERVED, type TypedBatch } from "./contract.ts";
import { classify, ident, kindExpr, sqlString, stageRaw } from "./classify.ts";
// evolve.ts owns type spelling: ColumnPlan.existing/target, the real table's types and _croft.columns.type
// must compare equal (TIMETZ, BIGINT[], DECIMAL(p,s)).
import { normalizeType } from "./evolve.ts";
import type { StagedColumn } from "./stage.ts";
import {
  type ColumnDecision, decimalParts, describeKinds, evolve, type IncomingColumn, jsKey, type KnownColumn, newColumnType,
  normalizePins, type Pin, RE, typeFamily,
} from "./types.ts";

export const typedTableName = (asset: string): string => `_croft_typed_${asset}`;

/** Column of the typed table holding the cursor field's original text (what the API sent). */
export const CURSOR_TEXT = "_croft_cursor_text";

const SAMPLE_LIMIT = 5;

// ---------------------------------------------------------------------------------------------------------
// Cast and loss expressions (also used by file ingests over all_varchar CSV text)

// sign, integer digits, fraction digits, exponent
const NUM_PARTS = sqlString(String.raw`^([+-]?)(\d*)\.?(\d*)(?:[eE]([+-]?\d+))?$`);

/**
 * SQL for a number text's exact canonical form, `[-]<digits>e<exponent>` with no leading or trailing
 * zeros ("0" for zero), so "1.50", "15e-1" and "1.5" are equal and "4.35" differs from "4.349999999999999".
 * Why not DECIMAL(38,18), as first designed: DuckDB casts a DOUBLE to DECIMAL from its binary value (4.35
 * became 4.349999999999999488, a false loss for 28% of random doubles), and text → DECIMAL(38,18) overflows
 * at 1e20 and rounds tiny exponents ('5e-324' became 1e-18) [V].
 */
export function numCanon(s: string): string {
  const g = (i: number) => `regexp_extract(${s}, ${NUM_PARTS}, ${i})`;
  const digits = `ltrim(${g(2)} || ${g(3)}, '0')`;
  const sig = `rtrim(${digits}, '0')`;
  const exp = `(coalesce(TRY_CAST(nullif(${g(4)}, '') AS BIGINT), 0) - length(${g(3)}) + length(${digits}) - length(${sig}))`;
  return `(CASE WHEN ${sig} = '' THEN '0' ELSE (CASE WHEN ${g(1)} = '-' THEN '-' ELSE '' END) || ${sig} || 'e' || CAST(${exp} AS VARCHAR) END)`;
}

/** Money text → plain number text: currency signs, spaces and `,` groups dropped; (x) → -x. */
export function moneyText(t: string): string {
  return `((CASE WHEN regexp_full_match(${t}, '\\s*\\(.*\\)\\s*') THEN '-' ELSE '' END) || regexp_replace(${t}, '[^0-9.\\-]', '', 'g'))`;
}

/**
 * SQL casting a text expression to `type`. TRY_CAST everywhere, so a failure is a NULL the loss check
 * counts, not an error that hides which rows failed. `json` is the JSON value expression, used as-is for
 * JSON columns (nested values are stored raw and exact). `format` is a strptime pattern or "money".
 */
export function castExpr(text: string, type: string, o: { format?: string | null; json?: string } = {}): string {
  const target = normalizeType(type);
  const fam = typeFamily(target);
  const format = o.format ?? undefined;
  switch (fam) {
    case "json":
      return o.json ?? `TRY_CAST(${text} AS JSON)`;
    case "varchar":
      return text;
    case "decimal":
    case "integer":
    case "hugeint":
    case "double":
      return `TRY_CAST(${format === "money" ? moneyText(text) : text} AS ${target})`;
    case "date":
    case "timestamp":
    case "timestamptz":
      if (format && format !== "money") return `TRY_CAST(TRY_STRPTIME(${text}, ${sqlString(format)}) AS ${target})`;
      return `TRY_CAST(${text} AS ${target})`;
    default:
      return `TRY_CAST(${text} AS ${target})`;
  }
}

/**
 * SQL that is true when a row's value changed on the way into `type`: the text is not NULL and the typed
 * value is NULL, or differs from the text compared canonically. VARCHAR and JSON cannot lose anything.
 */
export function lossExpr(text: string, typed: string, type: string, o: { format?: string | null } = {}): string {
  const target = normalizeType(type);
  const fam = typeFamily(target);
  const format = o.format ?? undefined;
  if (fam === "varchar" || fam === "json") return "false";
  let diff: string;
  switch (fam) {
    case "boolean":
      diff = `lower(trim(${text})) IS DISTINCT FROM CAST(${typed} AS VARCHAR)`;
      break;
    case "integer":
    case "hugeint":
    case "double":
    case "decimal": {
      const n = format === "money" ? moneyText(text) : text;
      // The typed value is cast back to text and both sides are compared as exact decimals (numCanon), at
      // any magnitude: 1.7 → 2, 19.999 → 20.00, 1e-30 → 0.00 and 3.14159265358979323846 → DOUBLE all lose.
      // A DOUBLE casts back to its shortest round-trip text, so a JS number never loses against itself.
      // Integer texts must not have leading zeros ('02134' is an identifier, not 2134); in a DOUBLE they
      // compare exactly as HUGEINT, which catches 2^53+1 (and JS's rounded printing of doubles beyond 2^53,
      // which staging already warns about as UNSAFE_INTEGER). Anything else, e.g. hex, `1_000` or words that
      // DuckDB's own casts accept, is a loss.
      //
      // A CASE ladder, because DuckDB evaluates a THEN only for the rows that reach it: most texts equal
      // their cast-back text and never pay for the regular expressions (1M values: ~0.1 s instead of ~2 s).
      const back = `CAST(${typed} AS VARCHAR)`;
      const big = `TRY_CAST(${n} AS HUGEINT)`;
      const intCompare = fam === "double"
        ? `(${big} IS NULL OR ${big} IS DISTINCT FROM TRY_CAST(${typed} AS HUGEINT))`
        : `(${numCanon(n)} IS DISTINCT FROM ${numCanon(back)})`;
      return `(CASE WHEN ${text} IS NULL THEN false WHEN ${typed} IS NULL THEN true` +
        ` WHEN ${n} = ${back} THEN false` +
        ` WHEN regexp_full_match(${n}, ${sqlString(RE.integerText)}) THEN` +
        ` (NOT regexp_full_match(${n}, '[+-]?(0|[1-9]\\d*)') OR ${intCompare})` +
        ` WHEN regexp_full_match(${n}, ${sqlString(RE.number)}) THEN ${numCanon(n)} IS DISTINCT FROM ${numCanon(back)}` +
        ` ELSE true END)`;
    }
    case "date":
    case "timestamp":
    case "timestamptz": {
      if (format && format !== "money") {
        diff = "false"; // strptime with the pinned format either parses the text or gives NULL
        break;
      }
      // The text's instant, read by its own form: an offset makes it zoned; otherwise it is a wall clock,
      // compared as-is for DATE/TIMESTAMP and read in the project zone for TIMESTAMPTZ (as the cast does).
      const zoned = `regexp_matches(${text}, ${sqlString(RE.offsetSuffix)})`;
      const naive = fam === "timestamptz" ? `TRY_CAST(TRY_CAST(${text} AS TIMESTAMP) AS TIMESTAMPTZ)` : `TRY_CAST(${text} AS TIMESTAMP)`;
      const ref = `(CASE WHEN ${zoned} THEN epoch_us(TRY_CAST(${text} AS TIMESTAMPTZ)) ELSE epoch_us(${naive}) END)`;
      const got = fam === "date" ? `epoch_us(CAST(${typed} AS TIMESTAMP))` : `epoch_us(${typed})`;
      diff = `(${ref} IS NULL OR ${ref} <> ${got})`;
      break;
    }
    default:
      diff = "false"; // types croft does not create: a failed cast is the loss
  }
  return `(${text} IS NOT NULL AND (${typed} IS NULL OR ${diff}))`;
}

// ---------------------------------------------------------------------------------------------------------

export interface BuildTypedBatchOptions {
  manifest: StageManifest & { columns?: StagedColumn[]; hasFile?: boolean; warnings?: Problem[] };
  /** The asset's rows of _croft.columns (empty on a first load). */
  knownColumns: readonly KnownColumn[];
  /** The asset's `columns` pins, keyed by column (or source) name. */
  pins?: Record<string, ColumnPin | Pin>;
  /** Cursor ingests: the incremental field, its unit, and the cursor type saved on the first load. */
  cursor?: { field: string; unit?: "s" | "ms"; type?: CursorType };
  /** The asset's real table in `main` (default: the asset name), for the schema check and widen proofs. */
  table?: string;
  /** Downstream assets, named in TYPE_CONFLICT. */
  readBy?: string[];
  /** JSON rows (default) or CSV text: DECIMAL_PRECISION_UNSUPPORTED applies only to JSON. */
  source?: "json" | "csv";
}

/** TypedBatch with the richer ColumnDecision (present/pinned/pending/format) for write.ts. */
export interface TypedBatchResult extends TypedBatch {
  columns: ColumnDecision[];
}

/**
 * Stage the manifest's parts, classify, plan against the stored columns and pins, cast into a typed TEMP
 * table and verify every value survived. Run inside the write transaction: the TEMP tables and every
 * decision roll back with it.
 */
export async function buildTypedBatch(tx: Sql, o: BuildTypedBatchOptions): Promise<TypedBatchResult> {
  const { manifest } = o;
  const asset = manifest.asset;
  const table = o.table ?? asset;
  const warnings: Problem[] = [...(manifest.warnings ?? [])];

  // 3a: the real schema wins over _croft.columns; a mismatch means the table was changed outside croft.
  const known = await reconcileSchema(tx, table, o.knownColumns, warnings, asset);
  const raw = await stageRaw(tx, manifest);

  // 3b: kinds per column.
  const classified = await classify(tx, raw.table, raw.columns);
  const sourceOf = new Map((manifest.columns ?? []).map((c) => [c.name, c.sourceName]));
  const incoming: IncomingColumn[] = classified.map((c) => ({
    name: c.name, sourceName: sourceOf.get(c.name) ?? c.name, counts: c.counts, unsafeIntegers: c.unsafeIntegers,
  }));

  // 3c: plan.
  const pins = normalizePins(o.pins as Record<string, string | Pin> | undefined);
  const plan = evolve(known, incoming, pins);
  const byName = new Map(incoming.map((c) => [c.name, c]));

  if ((o.source ?? "json") === "json") {
    for (const d of plan) {
      const dec = d.pinned && d.target ? decimalParts(d.target) : null;
      if (dec && dec.precision > 15 && (byName.get(d.column)?.counts.float ?? 0) > 0) {
        throw new CroftError("DECIMAL_PRECISION_UNSUPPORTED", {
          message: `column ${d.column} is pinned ${d.target}, but its values arrive as JSON numbers, which carry only about 15 significant digits`,
          hint: `yield ${d.column} as a string with every digit, as the source wrote it (a JS number has already lost digits beyond ~15), or pin DECIMAL with precision 15 or less`,
          asset,
          details: { column: d.column, type: d.target, precision: dec.precision },
        });
      }
    }
  }

  for (const d of plan) {
    if (d.decision !== "conflict") continue;
    const kinds = d.conflictKinds ?? [];
    await fillSamples(tx, raw.table, d, (t, _y, json) => `${kindExpr(`json_type(${json})`, t)} IN (${kinds.map((k) => `'${k}'`).join(", ")})`);
    throw typeConflict(asset, d, o.readBy, `${d.badRows} row${d.badRows === 1 ? " has" : "s have"} ${describeKinds(kinds)} values`, newColumnType(kinds, d.column).type);
  }

  // Widening an integer column to DOUBLE needs every stored value to survive `v::DOUBLE::HUGEINT = v`
  // (it catches 9007199254740993 [V]); incoming values are covered by the loss check below.
  for (const d of plan) {
    if (d.decision !== "widen" || d.proof !== "double" || !(await tableExists(tx, table))) continue;
    const col = `main.${ident(table)}.${ident(d.column)}`;
    const bad = `${col} IS NOT NULL AND TRY_CAST(TRY_CAST(${col} AS DOUBLE) AS HUGEINT) IS DISTINCT FROM TRY_CAST(${col} AS HUGEINT)`;
    const [{ n } = { n: 0 }] = await tx.all<{ n: number }>(`SELECT count(*)::BIGINT AS n FROM main.${ident(table)} WHERE ${bad}`);
    if (Number(n) === 0) continue;
    const rows = await tx.all<{ v: string }>(`SELECT CAST(${col} AS VARCHAR) AS v FROM main.${ident(table)} WHERE ${bad} LIMIT ${SAMPLE_LIMIT}`);
    const conflict: ColumnDecision = { ...d, decision: "conflict", target: d.existing ?? undefined, badRows: Number(n), samples: rows.map((r) => r.v) };
    throw typeConflict(asset, conflict, o.readBy,
      `widening to DOUBLE would change ${n} stored value${Number(n) === 1 ? "" : "s"} beyond ±2^53, and the batch has fractions`, "DOUBLE",
      { stored: true });
  }

  // 3d/3e: verify before casting into the typed table, in one scan of the raw table. Each text is extracted
  // and cast once in subqueries; lossExpr then works on plain column references.
  const checked = plan.filter((d) => d.present && d.target && lossCheckable(d) && hasValues(byName.get(d.column)));
  if (checked.length > 0) {
    const inner = checked.map((d, i) => `(${ident(d.column)}->>'$') AS t${i}`).join(", ");
    const mid = checked.map((d, i) => `t${i}, ${castExpr(`t${i}`, d.target!, { format: d.format })} AS y${i}`).join(", ");
    const aggs = checked.flatMap((d, i) => [
      `count(*) FILTER (WHERE ${lossExpr(`t${i}`, `y${i}`, d.target!, { format: d.format })})::BIGINT AS "l${i}"`,
      `count(*) FILTER (WHERE t${i} IS NOT NULL AND y${i} IS NULL)::BIGINT AS "n${i}"`,
    ]);
    const [counts = {}] = await tx.all<Record<string, number>>(
      `SELECT ${aggs.join(", ")} FROM (SELECT ${mid} FROM (SELECT ${inner} FROM ${ident(raw.table)}))`,
    );
    for (let i = 0; i < checked.length; i++) {
      const lost = Number(counts[`l${i}`] ?? 0);
      if (lost === 0) continue;
      const d = checked[i]!;
      const cast = (t: string) => castExpr(t, d.target!, { format: d.format });
      await fillSamples(tx, raw.table, d, (t, y) => lossExpr(t, y, d.target!, { format: d.format }), cast);
      d.badRows = lost;
      throw lossError(asset, d, Number(counts[`n${i}`] ?? 0), o.readBy);
    }
  }

  // Cursor: its type comes from the typed column; its original text is kept next to it.
  const cursor = o.cursor ? resolveCursor(o.cursor, plan, raw.rows, asset) : undefined;
  const cursorSource = cursor ? plan.find((d) => d.column === cursor.field) : undefined;

  // 3d: the typed TEMP table.
  const typed = typedTableName(asset);
  const select = [ident(RESERVED.seq)];
  for (const d of plan) {
    const target = d.target ?? d.existing!;
    const expr = d.present
      ? castExpr(`(${ident(d.column)}->>'$')`, target, { format: d.format, json: ident(d.column) })
      : `CAST(NULL AS ${normalizeType(target)})`;
    select.push(`${expr} AS ${ident(d.column)}`);
  }
  if (raw.hasFile) select.push(ident(RESERVED.file));
  if (cursor && cursorSource?.present) select.push(`(${ident(cursorSource.column)}->>'$') AS ${ident(CURSOR_TEXT)}`);
  else if (cursor) select.push(`CAST(NULL AS VARCHAR) AS ${ident(CURSOR_TEXT)}`);
  await tx.exec(`CREATE OR REPLACE TEMP TABLE ${ident(typed)} AS SELECT ${select.join(", ")} FROM ${ident(raw.table)}`);
  await tx.exec(`DROP ${raw.kind === "view" ? "VIEW" : "TABLE"} IF EXISTS ${ident(raw.table)}`);

  for (const d of plan) warnings.push(...d.warnings.map((w) => ({ ...w, asset: w.asset ?? asset })));
  return { temp: typed, columns: plan, rows: raw.rows, ...(cursor ? { cursor } : {}), warnings };
}

// ---------------------------------------------------------------------------------------------------------

function hasValues(c: IncomingColumn | undefined): boolean {
  return c !== undefined && Object.entries(c.counts).some(([k, n]) => k !== "null" && (n ?? 0) > 0);
}

function lossCheckable(d: ColumnDecision): boolean {
  const fam = typeFamily(d.target!);
  return fam !== "varchar" && fam !== "json";
}

/**
 * Count the rows matching `where` and keep 5 samples. `where` gets column references for the text, the typed
 * value (NULL without `cast`) and the JSON value, each computed once per row.
 */
async function fillSamples(
  tx: Sql, raw: string, d: ColumnDecision, where: (t: string, y: string, json: string) => string, cast?: (t: string) => string,
): Promise<void> {
  const typed = cast ? cast("t") : "NULL";
  const rows = await tx.all<{ seq: number; value: string | null; typed: string | null; n: number }>(
    `SELECT seq, t AS value, CAST(y AS VARCHAR) AS typed, count(*) OVER ()::BIGINT AS n FROM (` +
      `SELECT seq, t, ${typed} AS y, j FROM (SELECT ${ident(RESERVED.seq)}::BIGINT AS seq, (${ident(d.column)}->>'$') AS t, ` +
      `${ident(d.column)} AS j FROM ${ident(raw)})) WHERE ${where("t", "y", "j")} ORDER BY seq LIMIT ${SAMPLE_LIMIT}`,
  );
  d.badRows = Number(rows[0]?.n ?? 0);
  d.samples = rows.map((r) => r.value);
  d.sampleRows = rows.map((r) => ({ row: Number(r.seq), value: r.value, ...(cast ? { typed: r.typed } : {}) }));
}

function sampleText(samples: unknown[] | undefined): string {
  const shown = (samples ?? []).map((s) => (typeof s === "string" ? JSON.stringify(s) : String(s)));
  return shown.length ? ` (e.g. ${shown.join(", ")})` : "";
}

/** Fixes in the order of DESIGN.md §7: clean the value, pin a type (with a format), pin VARCHAR. */
function conflictFixes(d: ColumnDecision, stored: string): Fix[] {
  const key = jsKey(d.column);
  const acc = /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(d.sourceName) ? `r.${d.sourceName}` : `r[${JSON.stringify(d.sourceName)}]`;
  const fam = typeFamily(stored);
  let clean: string;
  if (fam === "integer" || fam === "hugeint" || fam === "double" || fam === "decimal") {
    clean = `${key}: ${acc} == null || ${acc} === "" || !Number.isFinite(Number(${acc})) ? null : Number(${acc})`;
  } else if (fam === "boolean") {
    clean = `${key}: ${acc} == null ? null : ${acc} === true || ${acc} === "true"`;
  } else if (fam === "timestamptz" || fam === "timestamp" || fam === "date") {
    clean = `${key}: ${acc} ? new Date(${acc}) : null   // a Date is stored as an ISO instant`;
  } else {
    clean = `${key}: ${acc} == null ? null : String(${acc})`;
  }
  const temporal = fam === "timestamptz" || fam === "timestamp" || fam === "date";
  return [
    { kind: "manual", description: `clean the value in rows() or map() before it is yielded: yield page.map((r) => ({ ...r, ${clean} }))` },
    {
      kind: "manual",
      description: temporal
        ? `pin a type with its format: columns: { ${key}: { type: "${stored}", format: "%Y-%m-%d %H:%M:%S" } }`
        : `pin a type: columns: { ${key}: "${stored}" }`,
    },
    { kind: "manual", description: `pin VARCHAR to accept text on purpose: columns: { ${key}: "VARCHAR" }; min, max and ORDER BY then compare as text ('9' > '10')` },
  ];
}

function typeConflict(asset: string, d: ColumnDecision, readBy: string[] | undefined, what: string, incomingType: string, extra: Record<string, unknown> = {}): CroftError {
  const stored = d.existing ?? d.target ?? "?";
  const fixes = conflictFixes(d, stored);
  const down = readBy?.length ? ` Read by ${readBy.join(", ")}.` : "";
  return new CroftError("TYPE_CONFLICT", {
    message: `column ${d.column} is ${stored}, but ${what}${sampleText(d.samples)}.${down}`,
    hint: "the load was rolled back and the cursor did not move; fix it in order: clean the value, pin a type with a format, or pin VARCHAR",
    effect: "nothing was written; downstream assets keep their current data",
    asset,
    fix: fixes[0],
    // §4.3's fields first (column, existingType, incomingKinds, badRows, samples, readBy); storedType, incoming
    // and conflictKinds are kept for readers of the earlier names.
    details: {
      column: d.column, existingType: stored, incomingKinds: d.incoming, badRows: d.badRows, samples: d.sampleRows ?? d.samples,
      readBy: readBy ?? [], sourceName: d.sourceName, storedType: stored, incomingType, incoming: d.incoming,
      conflictKinds: d.conflictKinds, fixes, ...extra,
    },
  });
}

function lossError(asset: string, d: ColumnDecision, nullCount: number, readBy: string[] | undefined): CroftError {
  const target = d.target!;
  const n = d.badRows ?? 0;
  const rows = `${n} value${n === 1 ? "" : "s"}`;
  const details = {
    column: d.column, sourceName: d.sourceName, type: target, storedType: d.existing, incoming: d.incoming, badRows: n,
    samples: d.sampleRows ?? d.samples, readBy: readBy ?? [],
  };
  if (d.pinned) {
    if (decimalParts(target) && nullCount === 0) {
      return new CroftError("PIN_ROUNDED", {
        message: `column ${d.column} is pinned ${target}, and ${rows} would be rounded to fit it${sampleText(d.samples)}`,
        hint: `widen the pin's scale (e.g. DECIMAL(18,${(decimalParts(target)!.scale) + 2})), or round the values in rows() or map() on purpose`,
        effect: "nothing was written",
        asset, details,
      });
    }
    return new CroftError("TYPE_PIN_VIOLATION", {
      message: `column ${d.column} is pinned ${target}, but ${rows} do not cast to it exactly${sampleText(d.samples)}`,
      hint: `clean the values in rows() or map(), change the pin, or pin VARCHAR to keep them as text`,
      effect: "nothing was written",
      asset, details,
    });
  }
  const fixes = conflictFixes(d, target);
  return new CroftError("TYPE_CONFLICT", {
    message: `column ${d.column} is ${target}, but ${rows} would change on the way in${sampleText(d.samples)}.${readBy?.length ? ` Read by ${readBy.join(", ")}.` : ""}`,
    hint: "the load was rolled back and the cursor did not move; fix it in order: clean the value, pin a type with a format, or pin VARCHAR",
    effect: "nothing was written; downstream assets keep their current data",
    asset, fix: fixes[0],
    // §4.3: existingType is the type the values failed to fit (the message's "column … is <type>").
    details: { existingType: target, incomingKinds: d.incoming, ...details, fixes },
  });
}

// ---------------------------------------------------------------------------------------------------------
// The real schema (3a)

const RESERVED_COLUMNS = new Set<string>([RESERVED.loadedAt, RESERVED.file, RESERVED.seq]);

async function tableExists(tx: Sql, table: string): Promise<boolean> {
  const rows = await tx.all<{ n: number }>(
    `SELECT count(*)::BIGINT AS n FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = 'main' AND table_name = $1`,
    [table],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/** The table's columns from duckdb_columns() (reserved columns excluded), or null when it does not exist. */
export async function realColumns(tx: Sql, table: string): Promise<{ name: string; type: string }[] | null> {
  if (!(await tableExists(tx, table))) return null;
  const rows = await tx.all<{ name: string; type: string }>(
    `SELECT column_name AS name, data_type AS type FROM duckdb_columns() WHERE database_name = current_database() ` +
      `AND schema_name = 'main' AND table_name = $1 ORDER BY column_index`,
    [table],
  );
  return rows.filter((r) => !RESERVED_COLUMNS.has(r.name)).map((r) => ({ name: r.name, type: normalizeType(r.type) }));
}

/**
 * The columns to plan against: _croft.columns, corrected by the real table. DuckDB wins; every difference
 * is reported once as TABLE_MODIFIED_OUTSIDE_CROFT.
 */
async function reconcileSchema(tx: Sql, table: string, known: readonly KnownColumn[], warnings: Problem[], asset: string): Promise<KnownColumn[]> {
  const real = await realColumns(tx, table);
  if (real === null) return [...known];
  const realByLower = new Map(real.map((c) => [c.name.toLowerCase(), c]));
  const knownByLower = new Map(known.map((c) => [c.name.toLowerCase(), c]));
  const changes: string[] = [];
  const out: KnownColumn[] = [];
  for (const k of known) {
    const r = realByLower.get(k.name.toLowerCase());
    if (!r) {
      changes.push(`column ${k.name} was dropped`);
      continue;
    }
    if (normalizeType(k.type) !== r.type) {
      changes.push(`column ${k.name} is ${r.type} in the table but ${normalizeType(k.type)} in croft's records`);
      out.push({ ...k, name: r.name, type: r.type, pending: false });
    } else out.push({ ...k, name: r.name });
  }
  for (const r of real) {
    if (knownByLower.has(r.name.toLowerCase())) continue;
    if (known.length > 0) changes.push(`column ${r.name} (${r.type}) was added`);
    out.push({ name: r.name, type: r.type, sourceName: r.name, pinned: false, pending: false });
  }
  if (changes.length > 0) {
    warnings.push(problem("TABLE_MODIFIED_OUTSIDE_CROFT", {
      message: `table ${table} was changed outside croft: ${changes.join("; ")}; croft uses the table as it is`,
      hint: "change tables through assets; `croft describe` shows the columns croft now tracks",
      asset,
      details: { table, changes },
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Cursor (DESIGN.md §3a "Cursor semantics")

function cursorTypeOf(type: string): CursorType | null {
  switch (typeFamily(type)) {
    case "timestamp":
    case "timestamptz":
      return "timestamp";
    case "date":
      return "date";
    case "integer":
    case "hugeint":
      return "integer";
    case "varchar":
      return "string";
    default:
      return null;
  }
}

function resolveCursor(spec: NonNullable<BuildTypedBatchOptions["cursor"]>, plan: ColumnDecision[], rows: number, asset: string): BatchCursor | undefined {
  const lower = spec.field.toLowerCase();
  const d = plan.find((c) => c.column.toLowerCase() === lower) ?? plan.find((c) => c.sourceName === spec.field);
  if (!d || !d.present) {
    if (rows === 0 && !d) return undefined;
    if (rows > 0) {
      const names = plan.filter((c) => c.present).map((c) => c.column);
      const guess = didYouMean(spec.field, names);
      throw new CroftError("UNKNOWN_COLUMN", {
        message: `the incremental field ${spec.field} is missing from all ${rows} rows of ${asset}`,
        hint: guess ? `did you mean incremental: "${guess}"?` : `the rows have: ${names.slice(0, 20).join(", ") || "(no columns)"}`,
        asset,
        details: { field: spec.field, columns: names, suggestion: guess ?? null },
      });
    }
  }
  const target = d!.target ?? d!.existing!;
  const type = cursorTypeOf(target);
  if (type === null) {
    throw new CroftError("CURSOR_TYPE_MISMATCH", {
      message: `the incremental field ${d!.column} is ${target}; a cursor must be a timestamp, date, integer or text column`,
      hint: `use a timestamp or an increasing integer (with unit: "s" or "ms" for epoch time) as the cursor`,
      asset,
      details: { field: d!.column, type: target },
    });
  }
  if (spec.unit && type !== "integer") {
    throw new CroftError("CURSOR_TYPE_MISMATCH", {
      message: `incremental: { field: "${spec.field}", unit: "${spec.unit}" } needs an integer column, but ${d!.column} is ${target}`,
      hint: "remove unit, or point the cursor at an epoch-time integer field",
      asset,
      details: { field: d!.column, type: target, unit: spec.unit },
    });
  }
  // The type is fixed on the first load; widening a DATE cursor column to a timestamp keeps it ordered.
  if (spec.type && spec.type !== type && !(spec.type === "date" && type === "timestamp")) {
    throw new CroftError("CURSOR_TYPE_MISMATCH", {
      message: `the cursor of ${asset} was saved as ${spec.type}, but ${d!.column} now types as ${type} (${target})`,
      hint: "clean the field in rows() so it keeps its type, or pin the column's type",
      asset,
      details: { field: d!.column, saved: spec.type, now: type, columnType: target },
    });
  }
  return { field: d!.column, type, ...(spec.unit ? { unit: spec.unit } : {}), rawTextColumn: CURSOR_TEXT };
}

