// Typed cursors (DESIGN.md §3a "Cursor semantics", §8 "Backfills", D19).
//
// - The cursor type is fixed on the first load by the cursor column's SQL type: timestamp/date, integer
//   (with `unit` when it holds epoch time) or string. It never flips afterwards; the one allowed change is
//   date → timestamp, because §7 widens DATE columns to TIMESTAMP(TZ) losslessly.
// - The new cursor is greatest(saved, typed maximum of the batch), compared in DuckDB on the typed column
//   so different offsets compare as instants. The saved value is that row's *original text*, so the API
//   gets back exactly what it sent.
// - `since` = saved − lookback, rendered in the saved value's own form: a timestamp keeps its offset (or its
//   lack of one), separator and fractional precision; an epoch cursor gets a number. Rounding always goes
//   down (earlier), so a lookback never shrinks the re-read window.
// - `--from` values (2026-06-24, full ISO, -90d, -12h, today) are converted to the cursor's type. A text cursor
//   converts nothing: it takes a value written like its saved one and refuses relative values and dates.
import { CroftError, problem } from "../core/errors.ts";
import type { CursorType, Problem, Sql } from "../core/types.ts";
import { formatInstant, now as clockNow, offsetMinutes } from "../core/time.ts";
import { normalizeType, quoteIdent, readTableSchema, tempRef } from "./evolve.ts";
import { RESERVED } from "./contract.ts";

/** A keyed timestamp cursor re-reads 1 s by default: an exclusive API (`updated_at > since`) still returns
 *  rows tied on the boundary, and the key deduplicates them (§3a "Boundary rows"). */
export const DEFAULT_TIMESTAMP_LOOKBACK_MS = 1000;

const INTEGER_TYPES = new Set(["TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT", "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT", "UHUGEINT"]);

/** The cursor type a column of this SQL type gives, or null when it cannot be a cursor (DOUBLE, JSON, ...). */
export function cursorTypeFor(columnType: string): CursorType | null {
  const t = normalizeType(columnType);
  if (t === "TIMESTAMPTZ" || t === "TIMESTAMP" || /^TIMESTAMP_(S|MS|NS)$/.test(t)) return "timestamp";
  if (t === "DATE") return "date";
  if (INTEGER_TYPES.has(t)) return "integer";
  if (t === "VARCHAR" || /^VARCHAR\(\d+\)$/.test(t)) return "string";
  return null;
}

function mismatch(message: string, hint: string, details: Record<string, unknown>, asset?: string): CroftError {
  return new CroftError("CURSOR_TYPE_MISMATCH", { message, hint, asset, details });
}

export interface ResolveCursorInput {
  field: string;
  columnType: string;
  unit?: "s" | "ms";
  /** _croft.assets.cursor_type from earlier loads. */
  saved?: CursorType | null;
  asset?: string;
}

/** The cursor type for this load. Throws CURSOR_TYPE_MISMATCH when the column cannot be a cursor, when
 *  `unit` is set on a non-integer column, or when the type would change after the first load. */
export function resolveCursorType(o: ResolveCursorInput): CursorType {
  const type = cursorTypeFor(o.columnType);
  const details = { field: o.field, columnType: normalizeType(o.columnType), unit: o.unit ?? null, saved: o.saved ?? null };
  if (!type) {
    throw mismatch(`cursor field ${o.field} is ${normalizeType(o.columnType)}; a cursor must be a timestamp, date, integer or text column`,
      "use a field that holds a timestamp, a date, an integer (with unit: \"s\" or \"ms\" for epoch time) or text", details, o.asset);
  }
  if (o.unit && type !== "integer") {
    throw mismatch(`cursor field ${o.field} is ${normalizeType(o.columnType)}; unit applies only to integer epoch cursors`,
      `remove unit from incremental`, details, o.asset);
  }
  if (o.saved && o.saved !== type && !(o.saved === "date" && type === "timestamp")) {
    throw mismatch(`cursor field ${o.field} was a ${o.saved} cursor and is now ${normalizeType(o.columnType)} (${type}); the cursor type is fixed on the first load`,
      "revert the change to the cursor field: its type is fixed by the first load", details, o.asset);
  }
  return type;
}

export interface CursorSpecCheck {
  asset: string;
  field: string;
  /** The cursor's type when known (from state or the column cache); omit before the first load. */
  type?: CursorType | null;
  /** The cursor column's SQL type when known, to report columns that cannot be cursors. */
  columnType?: string;
  unit?: "s" | "ms";
  lookbackMs?: number;
  file?: string;
}

/** CURSOR_TYPE_MISMATCH problems for `validate`: lookback on an integer cursor without unit or on a string
 *  cursor, unit on a non-integer cursor, and cursor columns of an unusable type. */
export function validateCursorSpec(o: CursorSpecCheck): Problem[] {
  const out: Problem[] = [];
  const type = o.type ?? (o.columnType ? cursorTypeFor(o.columnType) : undefined);
  const fix = (description: string) => (o.file ? { kind: "edit" as const, description, file: o.file } : { kind: "manual" as const, description });
  const at = { asset: o.asset, file: o.file, details: { field: o.field, type: type ?? null, unit: o.unit ?? null, lookbackMs: o.lookbackMs ?? 0 } };
  if (o.columnType && cursorTypeFor(o.columnType) === null) {
    out.push(problem("CURSOR_TYPE_MISMATCH", {
      ...at, message: `cursor field ${o.field} is ${normalizeType(o.columnType)}; a cursor must be a timestamp, date, integer or text column`,
      hint: "choose a field that holds a timestamp, a date, an integer or text", fix: fix(`choose another incremental field than ${o.field}`),
    }));
    return out;
  }
  const lookback = (o.lookbackMs ?? 0) > 0;
  if (lookback && type === "integer" && !o.unit) {
    out.push(problem("CURSOR_TYPE_MISMATCH", {
      ...at, message: `cursor ${o.field} holds plain integers, so a lookback has no unit to subtract`,
      hint: `if ${o.field} holds epoch time, add unit: "s" or "ms"; otherwise remove lookback`,
      fix: fix(`incremental: { field: "${o.field}", unit: "s", lookback: ... } (or "ms"), or remove lookback`),
    }));
  }
  if (lookback && type === "string") {
    out.push(problem("CURSOR_TYPE_MISMATCH", {
      ...at, message: `cursor ${o.field} is text, and text has no lookback arithmetic`,
      hint: "remove lookback, or use a timestamp, date or epoch field as the cursor",
      fix: fix("remove lookback from incremental"),
    }));
  }
  if (o.unit && type && type !== "integer") {
    out.push(problem("CURSOR_TYPE_MISMATCH", {
      ...at, message: `cursor ${o.field} is a ${type} cursor; unit applies only to integer epoch cursors`,
      hint: "remove unit from incremental", fix: fix("remove unit from incremental"),
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Typed maximum

export interface NextCursorInput {
  /** The batch's TEMP table. */
  temp: string;
  field: string;
  rawTextColumn: string;
  /** The saved cursor text, if any. */
  saved?: string | null;
  asset?: string;
}

export interface NextCursor {
  /** The cursor to save: the batch maximum's original text when it is newer, otherwise `saved`. */
  value: string | null;
  advanced: boolean;
  /** Original text of the batch's typed maximum (null when every cursor value is NULL). */
  batchMax: string | null;
}

/**
 * greatest(saved, typed max) over the batch. Ties keep the saved text, so an instant sent with another
 * offset does not churn the cursor. The saved text is compared typed (try_cast to the column's type); a saved
 * value the column type cannot read is CURSOR_TYPE_MISMATCH rather than a silent reset.
 */
export async function nextCursor(tx: Sql, o: NextCursorInput): Promise<NextCursor> {
  const cols = (await readTableSchema(tx, o.temp, "temp")) ?? [];
  const col = cols.find((c) => c.name.toLowerCase() === o.field.toLowerCase());
  if (!col) return { value: o.saved ?? null, advanced: false, batchMax: null };
  const raw = cols.find((c) => c.name.toLowerCase() === o.rawTextColumn.toLowerCase());
  const f = `b.${quoteIdent(col.name)}`;
  // The raw column may be staged as JSON; ->>'$' unwraps a JSON string to its text.
  const rawExpr = raw ? (raw.type === "JSON" ? `b.${quoteIdent(raw.name)}->>'$'` : `CAST(b.${quoteIdent(raw.name)} AS VARCHAR)`) : "NULL";
  const seq = cols.some((c) => c.name === RESERVED.seq) ? `, b.${quoteIdent(RESERVED.seq)} DESC` : "";
  const typed = `try_cast($1::VARCHAR AS ${col.type})`;
  const [row] = await tx.all<{ raw: string | null; typed_text: string; readable: boolean | null; newer: boolean | null }>(
    `SELECT ${rawExpr} AS raw, CAST(${f} AS VARCHAR) AS typed_text, ${typed} IS NOT NULL AS readable, ${f} > ${typed} AS newer
     FROM ${tempRef(o.temp)} AS b WHERE ${f} IS NOT NULL ORDER BY ${f} DESC${seq} LIMIT 1`,
    [o.saved ?? null],
  );
  if (!row) return { value: o.saved ?? null, advanced: false, batchMax: null };
  const batchMax = row.raw ?? row.typed_text;
  if (o.saved == null) return { value: batchMax, advanced: true, batchMax };
  if (!row.readable) {
    throw mismatch(`the saved cursor "${o.saved}" cannot be read as ${col.type} (column ${col.name})`,
      "the cursor field's type changed after the first load; revert the change to the cursor field",
      { field: o.field, saved: o.saved, columnType: col.type }, o.asset);
  }
  return row.newer ? { value: batchMax, advanced: true, batchMax } : { value: o.saved, advanced: false, batchMax };
}

// ---------------------------------------------------------------------------------------------------------
// ISO text in its own form

const ISO = /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})(?:([T ])(\d{2}):(\d{2})(?::(\d{2})(?:([.,])(\d+))?)?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?)?$/;
const US_PER_MIN = 60_000_000n;
const US_PER_DAY = 86_400_000_000n;

/** The textual form of an ISO date or date-time, and its wall clock in microseconds (as if UTC). */
interface IsoForm {
  wall: bigint;
  hasTime: boolean;
  sep: string;
  hasSeconds: boolean;
  fracSep: string;
  fracDigits: number;
  /** The offset exactly as written ("Z", "+02:00", "+0200", "-07"), or null for a naive value. */
  offsetText: string | null;
  offsetMinutes: number;
}

function parseIsoForm(text: string): IsoForm | null {
  const m = ISO.exec(text.trim());
  if (!m) return null;
  const [, y, mo, d, sep, h, mi, s, fracSep, frac, off] = m;
  const year = Number(y), month = Number(mo), day = Number(d);
  const hour = Number(h ?? 0), minute = Number(mi ?? 0), second = Number(s ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCDate() !== day) return null;
  date.setUTCHours(hour, minute, second, 0);
  const micros = BigInt(date.getTime()) * 1000n + (frac ? BigInt(frac.slice(0, 6).padEnd(6, "0")) : 0n);
  let offsetMinutes = 0;
  if (off && off.toUpperCase() !== "Z") {
    const digits = off.slice(1).replace(":", "");
    offsetMinutes = (off[0] === "-" ? -1 : 1) * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || 0));
  }
  return {
    wall: micros, hasTime: sep !== undefined, sep: sep ?? "T", hasSeconds: s !== undefined, fracSep: fracSep ?? ".",
    fracDigits: frac?.length ?? 0, offsetText: off ?? null, offsetMinutes,
  };
}

const floorDiv = (a: bigint, b: bigint) => (a % b !== 0n && (a < 0n) !== (b < 0n) ? a / b - 1n : a / b);
const pad = (n: number | bigint, w: number) => String(n).padStart(w, "0");

function formatDay(wall: bigint): string {
  const ms = Number(floorDiv(wall, US_PER_DAY) * 86_400_000n);
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const year = y >= 0 && y <= 9999 ? pad(y, 4) : `${y < 0 ? "-" : "+"}${pad(Math.abs(y), 6)}`;
  return `${year}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;
}

/** Render a wall clock in a form: floors to the form's precision (minutes, seconds or its fraction). */
function renderForm(wall: bigint, form: IsoForm): string {
  if (!form.hasTime) return formatDay(floorDiv(wall, US_PER_DAY) * US_PER_DAY);
  const unit = !form.hasSeconds ? US_PER_MIN : form.fracDigits >= 6 ? 1n : 10n ** BigInt(6 - form.fracDigits);
  const w = floorDiv(wall, unit) * unit;
  const dayStart = floorDiv(w, US_PER_DAY) * US_PER_DAY;
  const us = w - dayStart;
  const secs = us / 1_000_000n;
  let out = `${formatDay(dayStart)}${form.sep}${pad(secs / 3600n, 2)}:${pad((secs / 60n) % 60n, 2)}`;
  if (form.hasSeconds) {
    out += `:${pad(secs % 60n, 2)}`;
    if (form.fracDigits > 0) out += form.fracSep + pad(us % 1_000_000n, 6).padEnd(form.fracDigits, "0").slice(0, form.fracDigits);
  }
  return out + (form.offsetText ?? "");
}

const toInstant = (form: IsoForm) => form.wall - BigInt(form.offsetMinutes) * US_PER_MIN;
const fromInstant = (instant: bigint, form: IsoForm) => instant + BigInt(form.offsetMinutes) * US_PER_MIN;

function toNumberOrText(v: bigint): number | string {
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
}

export interface SinceOptions {
  type: CursorType;
  unit?: "s" | "ms";
  lookbackMs?: number;
  /** Keyed ingests get DEFAULT_TIMESTAMP_LOOKBACK_MS on timestamp cursors when no lookback is set. */
  keyed?: boolean;
  asset?: string;
  field?: string;
}

/** The lookback that applies: the configured one, or the 1 s default for keyed timestamp cursors. */
export function effectiveLookbackMs(o: Pick<SinceOptions, "type" | "lookbackMs" | "keyed">): number {
  if (o.lookbackMs && o.lookbackMs > 0) return o.lookbackMs;
  return o.keyed && o.type === "timestamp" ? DEFAULT_TIMESTAMP_LOOKBACK_MS : 0;
}

/**
 * `since` for the next run: the saved cursor minus the lookback, in the saved value's own form. Integer
 * cursors give a number (text beyond ±2^53, so no digit is lost); timestamps and dates give text.
 */
export function renderSince(saved: string, o: SinceOptions): string | number {
  const lookbackMs = effectiveLookbackMs(o);
  const name = o.field ? `cursor ${o.field}` : "this cursor";
  const details = { field: o.field ?? null, saved, type: o.type, unit: o.unit ?? null, lookbackMs };
  switch (o.type) {
    case "string":
      if (lookbackMs > 0) throw mismatch(`${name} is text; a lookback cannot be subtracted from text`, "remove lookback from incremental", details, o.asset);
      return saved;
    case "integer": {
      if (!/^[+-]?\d+$/.test(saved.trim())) throw mismatch(`the saved cursor "${saved}" is not an integer`, "the saved position was not written by this cursor field; revert the change to the cursor field", details, o.asset);
      const v = BigInt(saved.trim());
      if (lookbackMs === 0) return toNumberOrText(v);
      if (!o.unit) {
        throw mismatch(`${name} holds plain integers, so a lookback has no unit to subtract`,
          'if the field holds epoch time, add unit: "s" or "ms"; otherwise remove lookback', details, o.asset);
      }
      const lb = BigInt(Math.ceil(lookbackMs));
      return toNumberOrText(o.unit === "ms" ? v - lb : floorDiv(v * 1000n - lb, 1000n));
    }
    case "date":
    case "timestamp": {
      const form = parseIsoForm(saved);
      if (!form) throw mismatch(`the saved cursor "${saved}" is not an ISO-8601 ${o.type}`, "the saved position was not written by this cursor field; revert the change to the cursor field", details, o.asset);
      if (lookbackMs === 0) return saved;
      return renderForm(form.wall - BigInt(Math.ceil(lookbackMs)) * 1000n, form);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// --from

export interface FromOptions {
  type: CursorType;
  unit?: "s" | "ms";
  /** The project time zone: dates, `today` and naive times are read in it. */
  timezone: string;
  now?: Date;
  /** The saved cursor, whose form (offset, separator, precision) a timestamp result copies. */
  template?: string | null;
  asset?: string;
  /** The cursor field, for messages. */
  field?: string;
}

export interface FromResult {
  since: string | number;
  /** The instant it stands for, in the project zone, for the echo "since: 1750748400 (2026-06-24T00:00:00-07:00)". */
  instant?: string;
}

const RELATIVE = /^-\s*(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)$/i;
const RELATIVE_US: Record<string, bigint> = { s: 1_000_000n, m: US_PER_MIN, h: 60n * US_PER_MIN, d: US_PER_DAY, w: 7n * US_PER_DAY };

/**
 * Epoch microseconds of a wall clock in `tz`, disambiguated like Temporal's "compatible": a repeated wall
 * time (fall back) takes the earlier instant, a skipped one (spring forward) moves forward by the gap.
 */
export function zonedWallToInstant(wall: bigint, tz: string): bigint {
  const ms = Number(floorDiv(wall, 1000n));
  const before = offsetMinutes(ms - 86_400_000, tz);
  const after = offsetMinutes(ms + 86_400_000, tz);
  const valid = [before, after].map((o) => ms - o * 60_000).filter((t) => ms - t === offsetMinutes(t, tz) * 60_000);
  // Both valid: the earlier instant. Neither (a gap): the offset in force before the gap, which lands after it.
  const t = valid.length ? Math.min(...valid) : ms - before * 60_000;
  return BigInt(t) * 1000n + (wall - floorDiv(wall, 1000n) * 1000n);
}

function wallInZone(instant: bigint, tz: string): bigint {
  const ms = Number(floorDiv(instant, 1000n));
  return instant + BigInt(offsetMinutes(ms, tz)) * US_PER_MIN;
}

function usage(input: string, why: string): CroftError {
  return new CroftError("USAGE_ERROR", {
    message: `--from ${JSON.stringify(input)}: ${why}`,
    hint: "use a date (2026-06-24), a full ISO timestamp (2026-06-24T10:00:00Z), a relative value (-90d, -12h) or today",
    details: { from: input },
  });
}

/**
 * `--from` on a text cursor. Text compares as text, so croft converts nothing: a value written like the saved
 * cursor ("v0006" for "v0005") is passed to rows() as is. A relative value (-90d) or `today` means nothing as text,
 * and a date or timestamp is refused unless the saved cursor is one too, in the same form (a VARCHAR pin on a date
 * field): otherwise the API would get "-90d" or "2026-09-01" as a filter it cannot use (CURSOR_TYPE_MISMATCH).
 * Before the first load there is no saved value to compare with, so only relative values and `today` are refused.
 */
function stringFrom(s: string, o: FromOptions): FromResult {
  const saved = o.template ?? null;
  const name = o.field ? `cursor ${o.field}` : "this cursor";
  const details = { from: s, type: "string" as const, saved, field: o.field ?? null };
  const like = saved !== null ? `the saved cursor "${saved}"` : `the values of ${o.field ?? "the cursor field"}`;
  const refuse = (why: string) =>
    mismatch(`--from ${s}: ${name} holds text${saved !== null ? ` ("${saved}")` : ""}, ${why}`,
      `pass --from a value written like ${like}; a text cursor is compared as text, so croft cannot convert a date or a relative time into it`,
      details, o.asset);
  if (/^today$/i.test(s) || RELATIVE.test(s)) throw refuse(`and a relative time (${s}) cannot be turned into text`);
  if (saved === null) return { since: s };
  const value = parseIsoForm(s);
  const form = parseIsoForm(saved);
  if (value && !form) throw refuse(`not dates, so ${s} cannot be compared with it`);
  if (!value && form) throw refuse(`written as ${form.hasTime ? "a timestamp" : "a date"}, and ${s} is not one`);
  if (value && form && value.hasTime !== form.hasTime) {
    throw refuse(`written as ${form.hasTime ? "a timestamp" : "a date"}, and ${s} is ${value.hasTime ? "a timestamp" : "a date"}; as text they do not compare`);
  }
  return { since: s };
}

/** Convert a `--from` value to the cursor's type. */
export function parseFrom(input: string, o: FromOptions): FromResult {
  const s = input.trim();
  if (!s) throw usage(input, "it is empty");
  if (o.type === "string") return stringFrom(s, o);
  if (o.type === "integer" && /^\d+$/.test(s)) return { since: toNumberOrText(BigInt(s)) };
  if (o.type === "integer" && !o.unit) {
    throw mismatch(`--from ${s}: this cursor holds plain integers, so it takes a number, not a date`,
      "pass the integer to start from, or add unit: \"s\" or \"ms\" if the field holds epoch time", { from: s, type: o.type }, o.asset);
  }
  const nowUs = BigInt((o.now ?? clockNow()).getTime()) * 1000n;
  let instant: bigint;
  let dateOnly: string | null = null;
  const rel = RELATIVE.exec(s);
  if (/^today$/i.test(s)) {
    const wall = wallInZone(nowUs, o.timezone);
    instant = zonedWallToInstant(floorDiv(wall, US_PER_DAY) * US_PER_DAY, o.timezone);
  } else if (rel) {
    instant = nowUs - BigInt(rel[1]!) * RELATIVE_US[rel[2]![0]!.toLowerCase()]!;
  } else {
    const form = parseIsoForm(s);
    if (!form) throw usage(input, "not a date, timestamp or relative value");
    if (!form.hasTime) dateOnly = s;
    instant = form.offsetText ? toInstant(form) : zonedWallToInstant(form.wall, o.timezone);
  }
  const echo = (us: bigint) => formatInstant(us, o.timezone);
  switch (o.type) {
    case "date": {
      const day = dateOnly ?? formatDay(wallInZone(instant, o.timezone));
      return { since: day, instant: echo(zonedWallToInstant(parseIsoForm(day)!.wall, o.timezone)) };
    }
    case "integer": {
      const v = o.unit === "ms" ? floorDiv(instant, 1000n) : floorDiv(instant, 1_000_000n);
      return { since: toNumberOrText(v), instant: echo(o.unit === "ms" ? v * 1000n : v * 1_000_000n) };
    }
    case "timestamp": {
      const template = o.template ? parseIsoForm(o.template) : null;
      if (template?.hasTime) {
        // Copy the saved form. A naive cursor holds wall clocks, read here as the project zone's.
        const wall = template.offsetText ? fromInstant(instant, template) : wallInZone(instant, o.timezone);
        const text = renderForm(wall, template);
        const back = parseIsoForm(text)!;
        return { since: text, instant: echo(back.offsetText ? toInstant(back) : zonedWallToInstant(back.wall, o.timezone)) };
      }
      const z: IsoForm = { wall: 0n, hasTime: true, sep: "T", hasSeconds: true, fracSep: ".", fracDigits: 0, offsetText: "Z", offsetMinutes: 0 };
      const text = renderForm(instant, z);
      return { since: text, instant: echo(toInstant(parseIsoForm(text)!)) };
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// SINCE_IGNORED

export interface SinceIgnoredInput {
  asset: string;
  temp: string;
  field: string;
  since: string | number;
}

/**
 * SINCE_IGNORED when most of the batch's cursor values are older than the `since` the code received: the
 * code probably never passed `since` to the API and refetches everything each run.
 */
export async function detectSinceIgnored(tx: Sql, o: SinceIgnoredInput): Promise<Problem | null> {
  const cols = (await readTableSchema(tx, o.temp, "temp")) ?? [];
  const col = cols.find((c) => c.name.toLowerCase() === o.field.toLowerCase());
  if (!col || !cursorTypeFor(col.type)) return null;
  const f = quoteIdent(col.name);
  const typed = `try_cast($1::VARCHAR AS ${col.type})`;
  const [row] = await tx.all<{ older: number | bigint; total: number | bigint; readable: boolean }>(
    `SELECT count(*) FILTER (WHERE ${f} < ${typed}) AS older, count(${f}) AS total, ${typed} IS NOT NULL AS readable FROM ${tempRef(o.temp)}`,
    [String(o.since)],
  );
  if (!row?.readable) return null;
  const older = Number(row.older), total = Number(row.total);
  if (older === 0 || older * 2 <= total) return null;
  return problem("SINCE_IGNORED", {
    asset: o.asset,
    message: `${older} of ${total} rows are older than since (${o.since}); the code probably does not pass since to the API`,
    hint: "pass since to the API's filter (for example query: { since }), so each run fetches only what changed",
    details: { field: o.field, since: o.since, older, rows: total },
  });
}
