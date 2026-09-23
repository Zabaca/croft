// Steps 3a and 3b of an ingest write (DESIGN.md §5, §7): stage the NDJSON parts as a raw TEMP relation
// whose data columns are all JSON, then count each column's values by kind.
//
// Why JSON columns: they keep integers of any size exact [V] and never make a typing decision, so the
// decision is croft's (types.ts), not the sniffer's. Fractions are re-rendered as doubles on the way in
// (`1.50` → `1.5`) [V]; JS numbers were doubles already, so nothing is lost for API rows.
//
// The kinds come from json_type() plus regular expressions over the text (`v->>'$'`). json_type reports
// every non-negative integer as UBIGINT and integers beyond int64 as DOUBLE, while `->>'$'` keeps their
// digits [V]; so integer versus float is decided on the text, and ISO sub-kinds also require DuckDB's own
// cast to succeed.
import { CroftError } from "../core/errors.ts";
import type { Sql, StageManifest } from "../core/types.ts";
import { RESERVED } from "./contract.ts";
import { type CsvKind, type CsvStats, type KindCounts, RE, VALUE_KINDS } from "./types.ts";

/** A JSON row can be large (a document with nested arrays); DuckDB's default cap is 16 MB. */
export const MAX_OBJECT_BYTES = 256 * 1024 * 1024;

export const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;
export const sqlString = (s: string): string => `'${s.replaceAll("'", "''")}'`;

export const rawTableName = (asset: string): string => `_croft_raw_${asset}`;

export interface RawBatch {
  /** TEMP view (or table): _croft_seq BIGINT, one JSON column per staged key, _file VARCHAR for file ingests. */
  table: string;
  kind: "view" | "table";
  rows: number;
  columns: string[];
  hasFile: boolean;
}

/**
 * 3a: stage the parts as read_json(parts, columns = {every key: 'JSON'}). Every key is declared, so read_json
 * never samples or guesses. Run inside the write transaction.
 *
 * By default the raw relation is a TEMP VIEW over read_json, not the TEMP TABLE of DESIGN.md §5: inside the
 * write transaction DuckDB scans a table created by that same transaction about 4.5× slower than
 * read_json over the files (classification of 1M×5 values: 703 ms against 175 ms), and each pass re-reads
 * the files in parallel instead [V]. The parts never change once manifest.json exists, so every pass sees
 * the same rows, and the JSON text is not held in memory. `materialize: true` builds the table instead.
 */
export async function stageRaw(
  tx: Sql,
  manifest: Pick<StageManifest, "asset" | "parts" | "topLevelKeys" | "rows"> & { hasFile?: boolean },
  o: { table?: string; materialize?: boolean } = {},
): Promise<RawBatch> {
  const table = o.table ?? rawTableName(manifest.asset);
  const columns = [...manifest.topLevelKeys];
  const hasFile = manifest.hasFile === true;
  const decl: [string, string][] = [[RESERVED.seq, "BIGINT"], ...columns.map((c): [string, string] => [c, "JSON"])];
  if (hasFile) decl.push([RESERVED.file, "VARCHAR"]);
  const parts = manifest.parts.filter((p) => p.rows > 0);
  const kind = o.materialize ? "table" : "view";
  let select: string;
  if (parts.length === 0) {
    // read_json([]) does not bind [V]; an empty batch is an empty relation of the same shape.
    select = `SELECT ${decl.map(([n, t]) => `CAST(NULL AS ${t}) AS ${ident(n)}`).join(", ")} WHERE false`;
  } else {
    const files = `[${parts.map((p) => sqlString(p.path)).join(", ")}]`;
    const struct = `{${decl.map(([n, t]) => `${sqlString(n)}: ${sqlString(t)}`).join(", ")}}`;
    select = `SELECT * FROM read_json(${files}, columns = ${struct}, format = 'newline_delimited', maximum_object_size = ${MAX_OBJECT_BYTES})`;
  }
  await tx.exec(`CREATE OR REPLACE TEMP ${kind === "view" ? "VIEW" : "TABLE"} ${ident(table)} AS ${select}`);
  const [{ n } = { n: 0 }] = await tx.all<{ n: number }>(`SELECT count(*)::BIGINT AS n FROM ${ident(table)}`);
  if (Number(n) !== manifest.rows) {
    throw new CroftError("INTERNAL_ERROR", {
      message: `staging for ${manifest.asset} holds ${n} rows but its manifest says ${manifest.rows}`,
      hint: "run the asset again; if it repeats, report this croft bug",
      asset: manifest.asset,
      details: { staged: Number(n), manifest: manifest.rows },
    });
  }
  return { table, kind, rows: Number(n), columns, hasFile };
}

// ---------------------------------------------------------------------------------------------------------
// Kind expressions

const full = (text: string, re: string) => `regexp_full_match(${text}, ${sqlString(re)})`;

/** The integer kind of an integer-shaped text: int64 or wider. */
const intKind = (t: string) => `(CASE WHEN TRY_CAST(${t} AS BIGINT) IS NOT NULL THEN 'integer' ELSE 'bigint' END)`;

/** The ISO sub-kind of a string text, confirmed by DuckDB's cast. */
export function stringKindExpr(t: string): string {
  return `(CASE WHEN ${full(t, RE.isoInstant)} AND TRY_CAST(${t} AS TIMESTAMPTZ) IS NOT NULL THEN 'iso_instant'` +
    ` WHEN ${full(t, RE.isoNaive)} AND TRY_CAST(${t} AS TIMESTAMP) IS NOT NULL THEN 'iso_naive'` +
    ` WHEN ${full(t, RE.isoDate)} AND TRY_CAST(${t} AS DATE) IS NOT NULL THEN 'iso_date'` +
    ` ELSE 'string' END)`;
}

/**
 * SQL for the ValueKind of a JSON value, given `json_type(v)` and `v->>'$'` expressions. A top-level JSON
 * null is SQL NULL after read_json; both count as "null".
 */
export function kindExpr(jsonType: string, text: string): string {
  return `(CASE WHEN ${jsonType} IS NULL OR ${jsonType} = 'NULL' THEN 'null'` +
    ` WHEN ${jsonType} = 'BOOLEAN' THEN 'boolean'` +
    ` WHEN ${jsonType} = 'BIGINT' THEN 'integer'` +
    ` WHEN ${jsonType} = 'UBIGINT' THEN ${intKind(text)}` +
    ` WHEN ${jsonType} = 'DOUBLE' THEN (CASE WHEN ${full(text, "-?\\d+")} THEN ${intKind(text)} ELSE 'float' END)` +
    ` WHEN ${jsonType} = 'VARCHAR' THEN ${stringKindExpr(text)}` +
    ` WHEN ${jsonType} = 'OBJECT' THEN 'object'` +
    ` WHEN ${jsonType} = 'ARRAY' THEN 'array'` +
    ` ELSE 'string' END)`;
}

/** kindExpr for a JSON column reference. */
export function valueKindExpr(json: string): string {
  return kindExpr(`json_type(${json})`, `(${json}->>'$')`);
}

// Integers beyond ±2^53 cannot share a DOUBLE column with fractions.
const UNSAFE = (k: string, t: string) => `${k} = 'integer' AND abs(TRY_CAST(${t} AS HUGEINT)) > 9007199254740992`;

export interface ClassifiedColumn {
  name: string;
  /** Rows per kind, "null" included (a row without the key is NULL). */
  counts: KindCounts;
  unsafeIntegers: number;
}

/** 3b: per-column counts by kind, in one scan of the raw table. */
export async function classify(tx: Sql, table: string, columns: readonly string[]): Promise<ClassifiedColumn[]> {
  if (columns.length === 0) return [];
  const inner = columns.map((c, i) => `json_type(${ident(c)}) AS j${i}, (${ident(c)}->>'$') AS t${i}`).join(", ");
  const mid = columns.map((_, i) => `${kindExpr(`j${i}`, `t${i}`)} AS k${i}, t${i}`).join(", ");
  const aggs = columns.flatMap((_, i) => [
    ...VALUE_KINDS.map((k) => `count(*) FILTER (WHERE k${i} = '${k}')::BIGINT AS "${i}:${k}"`),
    `count(*) FILTER (WHERE ${UNSAFE(`k${i}`, `t${i}`)})::BIGINT AS "${i}:unsafe"`,
  ]);
  const [row] = await tx.all<Record<string, number>>(
    `SELECT ${aggs.join(", ")} FROM (SELECT ${mid} FROM (SELECT ${inner} FROM ${ident(table)}))`,
  );
  return columns.map((name, i) => {
    const counts: KindCounts = {};
    for (const k of VALUE_KINDS) {
      const n = Number(row?.[`${i}:${k}`] ?? 0);
      if (n > 0) counts[k] = n;
    }
    return { name, counts, unsafeIntegers: Number(row?.[`${i}:unsafe`] ?? 0) };
  });
}

// ---------------------------------------------------------------------------------------------------------
// CSV text (file ingests read CSV with all_varchar and type it with types.ts csvColumnType)

/** SQL for the CsvKind of a text cell; agrees with types.ts csvKind(). */
export function csvKindExpr(t: string): string {
  const dm = RE.csvDayMonth;
  const part = (n: number) => `TRY_CAST(regexp_extract(${t}, ${sqlString(`^(?:${dm})$`)}, ${n}) AS INTEGER)`;
  const sep = (n: number) => `regexp_extract(${t}, ${sqlString(`^(?:${dm})$`)}, ${n})`;
  const validDm = `(${part(1)} BETWEEN 1 AND 31 AND ${part(3)} BETWEEN 1 AND 31 AND (${part(1)} <= 12 OR ${part(3)} <= 12))`;
  return `(CASE WHEN ${t} IS NULL OR trim(${t}) = '' THEN 'empty'` +
    ` WHEN ${full(t, RE.csvBoolean)} THEN 'boolean'` +
    ` WHEN ${full(t, RE.csvInteger)} THEN ${intKind(t)}` +
    ` WHEN ${full(t, RE.csvDecimal)} THEN 'decimal'` +
    ` WHEN ${full(t, RE.csvMoney)} THEN 'money'` +
    ` WHEN ${full(t, dm)} AND ${sep(2)} = ${sep(4)} AND ${validDm} THEN 'day_month'` +
    ` ELSE ${stringKindExpr(t)} END)`;
}

const CSV_KINDS: readonly CsvKind[] = ["empty", "boolean", "integer", "bigint", "decimal", "money", "day_month", "iso_instant", "iso_naive", "iso_date", "string"];

/** CsvStats per VARCHAR column of a table, in one scan. */
export async function classifyCsv(tx: Sql, table: string, columns: readonly string[]): Promise<Map<string, CsvStats>> {
  const out = new Map<string, CsvStats>();
  if (columns.length === 0) return out;
  const dm = sqlString(`^(?:${RE.csvDayMonth})$`);
  const mid = columns.map((c, i) => `${csvKindExpr(ident(c))} AS k${i}, ${ident(c)} AS t${i}`).join(", ");
  const aggs = columns.flatMap((_, i) => {
    const k = `k${i}`;
    const t = `t${i}`;
    return [
      ...CSV_KINDS.map((kind) => `count(*) FILTER (WHERE ${k} = '${kind}')::BIGINT AS "${i}:${kind}"`),
      `count(*) FILTER (WHERE ${k} IN ('integer', 'bigint') AND (TRY_CAST(${t} AS HUGEINT) IS NULL OR abs(TRY_CAST(${t} AS HUGEINT)) > 9007199254740992))::BIGINT AS "${i}:unsafe"`,
      `coalesce(max(length(regexp_extract(${t}, '\\.(\\d+)', 1))) FILTER (WHERE ${k} IN ('decimal', 'money')), 0)::BIGINT AS "${i}:scale"`,
      `coalesce(list(DISTINCT regexp_extract(${t}, ${dm}, 2)) FILTER (WHERE ${k} = 'day_month'), [])::VARCHAR[] AS "${i}:seps"`,
      `count(*) FILTER (WHERE ${k} = 'day_month' AND TRY_CAST(regexp_extract(${t}, ${dm}, 1) AS INTEGER) > 12)::BIGINT AS "${i}:first"`,
      `count(*) FILTER (WHERE ${k} = 'day_month' AND TRY_CAST(regexp_extract(${t}, ${dm}, 3) AS INTEGER) > 12)::BIGINT AS "${i}:second"`,
    ];
  });
  const [row] = await tx.all<Record<string, unknown>>(`SELECT count(*)::BIGINT AS n, ${aggs.join(", ")} FROM (SELECT ${mid} FROM ${ident(table)})`);
  const num = (key: string) => Number(row?.[key] ?? 0);
  columns.forEach((name, i) => {
    const counts: Partial<Record<CsvKind, number>> = {};
    for (const k of CSV_KINDS) {
      const n = num(`${i}:${k}`);
      if (n > 0) counts[k] = n;
    }
    out.set(name, {
      rows: num("n"), counts, unsafeIntegers: num(`${i}:unsafe`), maxScale: num(`${i}:scale`),
      dateSeparators: ((row?.[`${i}:seps`] as string[] | undefined) ?? []).slice().sort(),
      firstOver12: num(`${i}:first`), secondOver12: num(`${i}:second`),
    });
  });
  return out;
}

