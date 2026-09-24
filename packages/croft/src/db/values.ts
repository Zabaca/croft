// DuckDB values → JavaScript, in two modes (DESIGN.md §4.3, §3e, §7 "Time zones").
//
// "json" (CLI --json, croft serve, @zabaca/croft/read): HUGEINT, DECIMAL and integers beyond ±2^53 become
//   strings, inside JSON columns too; numbers in a JSON column that DOUBLE cannot hold (1e400) keep their
//   source text; TIMESTAMPTZ is ISO-8601 with the project offset (±HH:MM) so it agrees with ::DATE in SQL;
//   TIMESTAMP is naive ISO; DATE is YYYY-MM-DD. Fractional seconds appear only when non-zero.
// "ts" (TS transforms, ctx.query, internal reads): values that load back unchanged. TIMESTAMPTZ is UTC
//   with Z and microseconds, TIMESTAMP is naive with microseconds, integers are numbers or bigint beyond
//   ±2^53, HUGEINT and DECIMAL(38,0) (the snapshot stand-in for HUGEINT) are always bigint. DECIMAL up to 15
//   digits is a number (a double holds 15 significant digits exactly); wider DECIMAL is its exact text.
//
// croft renders timestamps itself (core/time.ts formatInstant, the one renderer): getRowObjectsJson()
// formats TIMESTAMPTZ in the process-local zone. It uses no Bun-only APIs, so read.ts can import it.
import {
  DuckDBDateValue,
  DuckDBTimestampTZValue,
  DuckDBTimestampValue,
  DuckDBTypeId,
  type DuckDBResultReader,
  type DuckDBType,
  type DuckDBValue,
} from "@duckdb/node-api";
import { formatClock, formatDate, formatInstant as formatZoned, formatNaive } from "../core/time.ts";
import type { Row } from "../types.ts";

export { formatDate, formatNaive };

export type RenderMode = "json" | "ts";
export interface RenderContext { mode: RenderMode; timezone: string }
export interface ColumnInfo { name: string; type: string }

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = -MAX_SAFE;
const US_PER_DAY = 86_400_000_000n;
// Widest DECIMAL a JS number holds exactly: any decimal of up to 15 significant digits survives text → double → text.
const DOUBLE_DIGITS = 15;

const floorDiv = (a: bigint, b: bigint) => (a % b < 0n ? a / b - 1n : a / b);

/** ISO instant: UTC with Z (ts mode), or the wall clock in the project zone with its ±HH:MM offset (json mode). */
export function formatInstant(micros: bigint, ctx: RenderContext): string {
  return ctx.mode === "ts" ? formatNaive(micros, true) + "Z" : formatZoned(micros, ctx.timezone);
}

function infinite(micros: bigint, pos: bigint): string | null {
  if (micros === pos) return "infinity";
  if (micros === -pos) return "-infinity";
  return null;
}

function integer(v: bigint, ctx: RenderContext): number | bigint | string {
  if (v >= MIN_SAFE && v <= MAX_SAFE) return Number(v);
  return ctx.mode === "json" ? v.toString() : v;
}

function parseJson(text: string, ctx: RenderContext): unknown {
  try {
    return parseLossless(text, ctx.mode);
  } catch {
    return text; // DuckDB validates JSON on insert; this only guards odd casts
  }
}

const INTEGER_TEXT = /^-?\d+$/;

// Numbers inside JSON keep their exact value, through the reviver's context.source (Bun ≥ 1.3 / Node 21+).
// Integers beyond ±2^53 (snowflake ids nested in API payloads) become bigint in ts mode and decimal strings in
// json mode, as BIGINT columns do (§4.3). In json mode a number DOUBLE cannot hold (1e400) keeps its source
// text: as Infinity, JSON.stringify would write it as null.
function parseLossless(text: string, mode: RenderMode): unknown {
  return JSON.parse(text, function (this: unknown, _k: string, value: unknown, context?: { source?: string }) {
    if (typeof value !== "number" || Number.isSafeInteger(value)) return value;
    const source = context?.source;
    if (!source) return value;
    if (INTEGER_TEXT.test(source)) return mode === "ts" ? BigInt(source) : source;
    if (mode === "json" && !Number.isFinite(value)) return source;
    return value;
  } as (this: unknown, key: string, value: unknown) => unknown);
}

/** Set a key on a plain object. `o[k] = v` with k "__proto__" would replace the prototype instead. */
function setKey(o: Record<string, unknown>, k: string, v: unknown): void {
  if (k === "__proto__") Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  else o[k] = v;
}

// @duckdb/node-api builds a STRUCT's entries with `entries[name] = value`, so a field named "__proto__" became
// the entries object's prototype: an object or NULL value is recovered from there; a scalar was dropped by it.
function structEntry(entries: Readonly<Record<string, DuckDBValue>>, name: string): DuckDBValue {
  if (Object.hasOwn(entries, name)) return entries[name]!;
  if (name !== "__proto__") return null;
  const proto = Object.getPrototypeOf(entries) as DuckDBValue | object;
  return proto === Object.prototype ? null : (proto as DuckDBValue);
}

/** Render one DuckDB value of the given column type. */
export function renderValue(value: DuckDBValue, type: DuckDBType, ctx: RenderContext): unknown {
  if (value === null) return null;
  switch (type.typeId) {
    case DuckDBTypeId.BOOLEAN:
      return value;
    case DuckDBTypeId.TINYINT: case DuckDBTypeId.SMALLINT: case DuckDBTypeId.INTEGER:
    case DuckDBTypeId.UTINYINT: case DuckDBTypeId.USMALLINT: case DuckDBTypeId.UINTEGER:
      return value;
    case DuckDBTypeId.BIGINT: case DuckDBTypeId.UBIGINT:
      return integer(value as bigint, ctx);
    case DuckDBTypeId.HUGEINT: case DuckDBTypeId.UHUGEINT:
      return ctx.mode === "json" ? String(value) : (value as bigint);
    case DuckDBTypeId.BIGNUM:
      return ctx.mode === "json" ? String(value) : BigInt(String(value));
    case DuckDBTypeId.FLOAT: case DuckDBTypeId.DOUBLE: {
      const n = value as number;
      // JSON has no NaN or Infinity; JSON.stringify would silently turn them into null.
      return ctx.mode === "json" && !Number.isFinite(n) ? String(n) : n;
    }
    case DuckDBTypeId.DECIMAL: {
      const dec = value as { value: bigint; scale: number; width: number; toString(): string; toDouble(): number };
      if (ctx.mode === "json") return dec.toString();
      if (dec.scale === 0 && dec.width === 38) return dec.value; // HUGEINT stand-in in Parquet snapshots
      return dec.width > DOUBLE_DIGITS ? dec.toString() : dec.toDouble();
    }
    case DuckDBTypeId.VARCHAR:
      return type.alias === "JSON" ? parseJson(value as string, ctx) : value;
    case DuckDBTypeId.ENUM:
      return value;
    case DuckDBTypeId.DATE: {
      const d = value as DuckDBDateValue;
      if (!d.isFinite) return d.days > 0 ? "infinity" : "-infinity";
      return formatDate(d.days);
    }
    case DuckDBTypeId.TIMESTAMP: {
      const t = value as DuckDBTimestampValue;
      return infinite(t.micros, DuckDBTimestampValue.PosInf.micros) ?? formatNaive(t.micros, ctx.mode === "ts");
    }
    case DuckDBTypeId.TIMESTAMP_TZ: {
      const t = value as DuckDBTimestampTZValue;
      return infinite(t.micros, DuckDBTimestampTZValue.PosInf.micros) ?? formatInstant(t.micros, ctx);
    }
    case DuckDBTypeId.TIMESTAMP_S: {
      const s = (value as { seconds: bigint }).seconds;
      return formatNaive(s * 1_000_000n, ctx.mode === "ts");
    }
    case DuckDBTypeId.TIMESTAMP_MS: {
      const ms = (value as { millis: bigint }).millis;
      return formatNaive(ms * 1000n, ctx.mode === "ts");
    }
    case DuckDBTypeId.TIMESTAMP_NS: {
      const ns = (value as { nanos: bigint }).nanos;
      const days = floorDiv(ns, US_PER_DAY * 1000n);
      const nsOfDay = ns - days * US_PER_DAY * 1000n;
      return `${formatDate(Number(days))}T${formatClock(nsOfDay / 1000n, 9, ctx.mode === "ts", nsOfDay % 1_000_000_000n)}`;
    }
    case DuckDBTypeId.TIME:
      return formatClock((value as { micros: bigint }).micros, 6, ctx.mode === "ts");
    case DuckDBTypeId.LIST: case DuckDBTypeId.ARRAY: {
      const child = (type as { valueType: DuckDBType }).valueType;
      return (value as { items: readonly DuckDBValue[] }).items.map((v) => renderValue(v, child, ctx));
    }
    case DuckDBTypeId.STRUCT: {
      const st = type as { entryNames: readonly string[]; entryTypes: readonly DuckDBType[] };
      const entries = (value as { entries: Readonly<Record<string, DuckDBValue>> }).entries;
      const out: Record<string, unknown> = {};
      st.entryNames.forEach((name, i) => setKey(out, name, renderValue(structEntry(entries, name), st.entryTypes[i]!, ctx)));
      return out;
    }
    case DuckDBTypeId.MAP: {
      const mt = type as { keyType: DuckDBType; valueType: DuckDBType };
      return (value as { entries: { key: DuckDBValue; value: DuckDBValue }[] }).entries.map((e) => ({
        key: renderValue(e.key, mt.keyType, ctx),
        value: renderValue(e.value, mt.valueType, ctx),
      }));
    }
    case DuckDBTypeId.UNION: {
      const ut = type as { memberTags: readonly string[]; memberTypes: readonly DuckDBType[] };
      const u = value as { tag: string; value: DuckDBValue };
      const member = ut.memberTypes[ut.memberTags.indexOf(u.tag)];
      return { tag: u.tag, value: member ? renderValue(u.value, member, ctx) : String(u.value) };
    }
    default:
      // UUID, BLOB (DuckDB's escaped text, castable back), INTERVAL, TIME_TZ, BIT, GEOMETRY, VARIANT, ...
      return typeof value === "object" ? String(value) : value;
  }
}

/** SQL type name as croft writes it: TIMESTAMPTZ rather than DuckDB's long "TIMESTAMP WITH TIME ZONE". */
export function typeName(type: DuckDBType): string {
  return (type.alias ?? type.toString()).replaceAll("TIMESTAMP WITH TIME ZONE", "TIMESTAMPTZ").replaceAll("TIME WITH TIME ZONE", "TIMETZ");
}

/** Column names and SQL types of a result. */
export function resultColumns(reader: DuckDBResultReader): ColumnInfo[] {
  const names = reader.deduplicatedColumnNames();
  return reader.columnTypes().map((t, i) => ({ name: names[i]!, type: typeName(t) }));
}

/** All rows of a fully read result as objects. Duplicate column names get DuckDB's `:1` suffixes; a column
 *  named "__proto__" is an ordinary key. */
export function renderRows(reader: DuckDBResultReader, ctx: RenderContext): Row[] {
  return renderValueRows(reader.getRows(), { names: reader.deduplicatedColumnNames(), types: reader.columnTypes() }, ctx);
}

/** The column names (deduplicated, as renderRows keys them) and types of a result, fully read or streaming. */
export interface ResultShape { names: readonly string[]; types: readonly DuckDBType[] }

/** The shape of a streaming result (`connection.stream()`), whose rows arrive one chunk at a time. */
export function resultShape(result: { deduplicatedColumnNames(): string[]; columnTypes(): DuckDBType[] }): ResultShape {
  return { names: result.deduplicatedColumnNames(), types: result.columnTypes() };
}

/**
 * Row-major DuckDB values as objects, keyed by `shape.names`: the rows of one chunk of a streaming result (a TS
 * transform streams its input snapshots chunk by chunk, run/inputs.ts), or of a fully read one (renderRows).
 */
export function renderValueRows(rows: readonly (readonly DuckDBValue[])[], shape: ResultShape, ctx: RenderContext): Row[] {
  const { names, types } = shape;
  const proto = names.includes("__proto__");
  const out: Row[] = new Array(rows.length);
  for (let r = 0; r < rows.length; r++) {
    const src = rows[r]!;
    const row: Row = {};
    for (let c = 0; c < names.length; c++) {
      const v = renderValue(src[c] ?? null, types[c]!, ctx);
      if (proto) setKey(row, names[c]!, v);
      else row[names[c]!] = v;
    }
    out[r] = row;
  }
  return out;
}
