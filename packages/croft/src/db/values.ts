// DuckDB values → JavaScript, in two modes (DESIGN.md §4.3, §3e, §7 "Time zones").
//
// "json" (CLI --json, croft serve, @zabaca/croft/read): HUGEINT, DECIMAL and integers beyond ±2^53 become
//   strings; TIMESTAMPTZ is ISO-8601 with the project offset so it agrees with ::DATE in SQL; TIMESTAMP is
//   naive ISO; DATE is YYYY-MM-DD; JSON is parsed. Fractional seconds appear only when non-zero.
// "ts" (TS transforms, ctx.query, internal reads): values that load back unchanged. TIMESTAMPTZ is UTC
//   with Z and microseconds, TIMESTAMP is naive with microseconds, integers are numbers or bigint beyond
//   ±2^53, HUGEINT and DECIMAL(38,0) (the snapshot stand-in for HUGEINT) are always bigint.
//
// croft renders timestamps itself: getRowObjectsJson() formats TIMESTAMPTZ in the process-local zone.
// It uses no Bun-only APIs, so read.ts can import it.
import {
  DuckDBDateValue,
  DuckDBTimestampTZValue,
  DuckDBTimestampValue,
  DuckDBTypeId,
  type DuckDBResultReader,
  type DuckDBType,
  type DuckDBValue,
} from "@duckdb/node-api";
import type { Row } from "../types.ts";

export type RenderMode = "json" | "ts";
export interface RenderContext { mode: RenderMode; timezone: string }
export interface ColumnInfo { name: string; type: string }

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = -MAX_SAFE;
const US_PER_DAY = 86_400_000_000n;

const floorDiv = (a: bigint, b: bigint) => (a % b < 0n ? a / b - 1n : a / b);
const pad = (n: number, w: number) => String(n).padStart(w, "0");

// Proleptic Gregorian date from days since 1970-01-01 (H. Hinnant's civil_from_days).
function civil(days: number): { y: number; m: number; d: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

function isoYear(y: number): string {
  if (y >= 0 && y <= 9999) return pad(y, 4);
  return (y < 0 ? "-" : "+") + pad(Math.abs(y), 6); // ISO 8601 expanded years; JS Date parses them
}

export function formatDate(days: number): string {
  const { y, m, d } = civil(days);
  return `${isoYear(y)}-${pad(m, 2)}-${pad(d, 2)}`;
}

/**
 * "HH:MM:SS" plus fraction: always `fracDigits` wide when `fixed`; otherwise none when zero, and trimmed in
 * groups of three (".5" never, ".500" for whole milliseconds, ".123456" for microseconds).
 */
function clock(usOfDay: bigint, fracDigits: number, fixed: boolean, fracValue?: bigint): string {
  const totalSec = usOfDay / 1_000_000n;
  const h = Number(totalSec / 3600n);
  const mi = Number((totalSec / 60n) % 60n);
  const s = Number(totalSec % 60n);
  const frac = fracValue ?? usOfDay % 1_000_000n;
  let out = `${pad(h, 2)}:${pad(mi, 2)}:${pad(s, 2)}`;
  if (!fixed && frac === 0n) return out;
  let digits = frac.toString().padStart(fracDigits, "0");
  if (!fixed) while (digits.length > 3 && digits.endsWith("000")) digits = digits.slice(0, -3);
  return `${out}.${digits}`;
}

/** Naive ISO timestamp from microseconds since the epoch. */
export function formatNaive(micros: bigint, fixed: boolean): string {
  const days = floorDiv(micros, US_PER_DAY);
  return `${formatDate(Number(days))}T${clock(micros - days * US_PER_DAY, 6, fixed)}`;
}

// Time-zone offsets. Intl gives the wall clock for an instant; offset = wall clock − UTC. formatToParts
// costs ~20 µs, so offsets are cached per UTC day: the offset at the day's first and last second, and on
// a transition day the second it switches. This assumes at most one transition per UTC day, which real
// zones keep (tests compare against DuckDB's ICU across zones and transition seconds).
const formatters = new Map<string, Intl.DateTimeFormat>();
const offsetCache = new Map<string, Map<number, { before: number; after: number; switchMs: number }>>();
const DAY_MS = 86_400_000;
const JS_DATE_LIMIT = 8.64e15;

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", era: "short",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Offset of `tz` from UTC at an instant, in seconds (e.g. -25200 for -07:00). */
export function offsetSeconds(tz: string, epochMs: number): number {
  const ms = Math.floor(epochMs / 1000) * 1000;
  const p: Record<string, string> = {};
  for (const part of formatter(tz).formatToParts(new Date(ms))) p[part.type] = part.value;
  let year = Number(p.year);
  if (p.era === "BC" || p.era === "B") year = 1 - year;
  // setUTCFullYear, unlike Date.UTC, does not map years 0–99 to 1900–1999.
  const wall = new Date(0);
  wall.setUTCFullYear(year, Number(p.month) - 1, Number(p.day));
  wall.setUTCHours(Number(p.hour), Number(p.minute), Number(p.second), 0);
  return Math.round((wall.getTime() - ms) / 1000);
}

function cachedOffset(tz: string, epochMs: number): number {
  let cache = offsetCache.get(tz);
  if (!cache) offsetCache.set(tz, (cache = new Map()));
  const day = Math.floor(epochMs / DAY_MS);
  let info = cache.get(day);
  if (!info) {
    const start = day * DAY_MS;
    const end = start + DAY_MS - 1000;
    const before = offsetSeconds(tz, start);
    const after = offsetSeconds(tz, end);
    let switchMs = end + 1000;
    if (before !== after) {
      // Binary search the first second on the new offset (about 17 lookups, once per transition day).
      let lo = start;
      let hi = end;
      while (hi - lo > 1000) {
        const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
        if (offsetSeconds(tz, mid) === before) lo = mid;
        else hi = mid;
      }
      switchMs = hi;
    }
    info = { before, after, switchMs };
    if (cache.size > 100_000) cache.clear();
    cache.set(day, info);
  }
  return epochMs >= info.switchMs ? info.after : info.before;
}

function formatOffset(sec: number): string {
  const sign = sec < 0 ? "-" : "+";
  const a = Math.abs(sec);
  const hh = pad(Math.floor(a / 3600), 2);
  const mm = pad(Math.floor((a % 3600) / 60), 2);
  const ss = a % 60;
  return `${sign}${hh}:${mm}${ss ? ":" + pad(ss, 2) : ""}`;
}

/** ISO instant: UTC with Z (ts mode), or wall clock in `tz` with its offset (json mode). */
export function formatInstant(micros: bigint, ctx: RenderContext): string {
  if (ctx.mode === "ts") return formatNaive(micros, true) + "Z";
  const ms = Number(floorDiv(micros, 1000n));
  if (Math.abs(ms) >= JS_DATE_LIMIT) return formatNaive(micros, false) + "Z"; // beyond JS Date: no zone data
  const off = cachedOffset(ctx.timezone, ms);
  return formatNaive(micros + BigInt(off) * 1_000_000n, false) + formatOffset(off);
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
    return ctx.mode === "ts" ? parseLossless(text) : JSON.parse(text);
  } catch {
    return text; // DuckDB validates JSON on insert; this only guards odd casts
  }
}

// ts mode keeps unsafe integers inside JSON exact as bigint (reviver context.source, Bun ≥ 1.3 / Node 21+).
function parseLossless(text: string): unknown {
  return JSON.parse(text, function (this: unknown, _k: string, value: unknown, context?: { source?: string }) {
    if (typeof value === "number" && !Number.isSafeInteger(value) && context?.source && /^-?\d+$/.test(context.source)) {
      return BigInt(context.source);
    }
    return value;
  } as (this: unknown, key: string, value: unknown) => unknown);
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
      return dec.toDouble();
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
      return `${formatDate(Number(days))}T${clock(nsOfDay / 1000n, 9, ctx.mode === "ts", nsOfDay % 1_000_000_000n)}`;
    }
    case DuckDBTypeId.TIME:
      return clock((value as { micros: bigint }).micros, 6, ctx.mode === "ts");
    case DuckDBTypeId.LIST: case DuckDBTypeId.ARRAY: {
      const child = (type as { valueType: DuckDBType }).valueType;
      return (value as { items: readonly DuckDBValue[] }).items.map((v) => renderValue(v, child, ctx));
    }
    case DuckDBTypeId.STRUCT: {
      const st = type as { entryNames: readonly string[]; entryTypes: readonly DuckDBType[] };
      const entries = (value as { entries: Readonly<Record<string, DuckDBValue>> }).entries;
      const out: Record<string, unknown> = {};
      st.entryNames.forEach((name, i) => (out[name] = renderValue(entries[name] ?? null, st.entryTypes[i]!, ctx)));
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

/** All rows of a fully read result as objects. Duplicate column names get DuckDB's `:1` suffixes. */
export function renderRows(reader: DuckDBResultReader, ctx: RenderContext): Row[] {
  const names = reader.deduplicatedColumnNames();
  const types = reader.columnTypes();
  const rows = reader.getRows();
  const out: Row[] = new Array(rows.length);
  for (let r = 0; r < rows.length; r++) {
    const src = rows[r]!;
    const row: Row = {};
    for (let c = 0; c < names.length; c++) row[names[c]!] = renderValue(src[c] ?? null, types[c]!, ctx);
    out[r] = row;
  }
  return out;
}
