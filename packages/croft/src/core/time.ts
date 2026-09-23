// Time rendering in the project time zone (DESIGN.md §4 "Timestamps", §7 "Time zones").
// JSON timestamps carry the project offset so they agree with `::DATE` in SQL. croft renders
// instants itself because DuckDB's JSON helpers use the process-local zone.
//
// This is croft's one timestamp renderer: CLI JSON, croft serve and @zabaca/croft/read (db/values.ts),
// cursors and messages all go through formatInstant, so an instant always reads the same way. Offsets are
// always ±HH:MM (RFC 3339 has no seconds offset); the historic local-mean-time offsets with seconds are
// rounded to the minute and the wall clock is shifted with them, so the string still names the exact instant.
// Offsets come from Intl, i.e. the runtime's ICU data. DuckDB bundles its own ICU data for `::DATE` and the
// SQL time functions; `croft doctor` warns with TZDATA_MISMATCH when the two disagree for the project zone.
// No Bun-only APIs: read.ts imports this through db/values.ts.
import { CroftError } from "./errors.ts";

/** An instant: a Date, epoch milliseconds, epoch microseconds (bigint, DuckDB's TIMESTAMPTZ unit),
 *  an ISO-8601 string with an offset, or a DuckDB timestamp value ({ micros }). */
export type InstantInput = Date | number | bigint | string | { readonly micros: bigint };

const MICROS_PER_SECOND = 1_000_000n;
const US_PER_DAY = 86_400_000_000n;
const DAY_MS = 86_400_000;
// Date's range: ±8.64e15 ms. Intl cannot compute offsets outside it.
const MAX_EPOCH_MS = 8.64e15;

const offsetFormats = new Map<string, Intl.DateTimeFormat>();

function offsetFormat(tz: string): Intl.DateTimeFormat {
  let f = offsetFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset", year: "numeric" });
    offsetFormats.set(tz, f);
  }
  return f;
}

/** The zone this machine runs in (used only outside a project). */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export type TimeZoneCheck = { ok: true; name: string } | { ok: false; reason: string; suggestion?: string };

/** Validate a project time zone. It must be a name both Intl and DuckDB accept, spelled canonically,
 *  because the name is part of every transform fingerprint. Offsets like "+07:00" pass Intl but
 *  DuckDB's `SET TimeZone` rejects them. */
export function checkTimeZone(tz: string): TimeZoneCheck {
  if (tz.trim() === "") return { ok: false, reason: "it is empty", suggestion: systemTimeZone() };
  if (/^[+-]\d/.test(tz) || /^(UTC|GMT)[+-]\d/i.test(tz)) {
    return { ok: false, reason: "a fixed offset is not a time zone; use a place name so daylight saving time is handled", suggestion: systemTimeZone() };
  }
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return { ok: false, reason: "it is not an IANA time zone name", suggestion: guessZone(tz) };
  }
  if (resolved !== tz) return { ok: false, reason: `it is spelled "${resolved}"`, suggestion: resolved };
  return { ok: true, name: tz };
}

export function isValidTimeZone(tz: string): boolean {
  return checkTimeZone(tz).ok;
}

// "Tokyo" → "Asia/Tokyo", "los angeles" → "America/Los_Angeles".
function guessZone(input: string): string | undefined {
  const want = input.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!want) return undefined;
  return Intl.supportedValuesOf("timeZone").find((z) => z.toLowerCase().split("/").pop() === want);
}

/** The exact offset from Intl, in seconds (one formatToParts call, ~20 µs). */
function intlOffsetSeconds(tz: string, epochMs: number): number {
  const name = offsetFormat(tz).formatToParts(new Date(epochMs)).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /^GMT(?:([+-])(\d{1,2})(?::?(\d{2}))?(?::?(\d{2}))?)?$/.exec(name);
  if (!m) throw new RangeError(`unexpected offset "${name}" for ${tz}`);
  if (!m[1]) return 0;
  const seconds = Number(m[2]) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
  return m[1] === "-" ? -seconds : seconds;
}

// Offsets are cached per zone and UTC day: the offset at the day's first and last second and, on a transition
// day, the first second on the new offset (a binary search of about 17 lookups). This assumes at most one
// transition per UTC day, which real zones keep; rendering a result then costs two Intl calls per distinct day.
interface DayOffsets { before: number; after: number; switchMs: number }
const offsetCache = new Map<string, Map<number, DayOffsets>>();

/** UTC offset of `tz` at an instant, in seconds, exactly (historic local mean time has seconds, e.g.
 *  -07:52:58 for Los Angeles before 1883). Throws RangeError outside JS dates (±8.64e15 ms). */
export function offsetSeconds(epochMs: number, tz: string): number {
  if (!Number.isFinite(epochMs) || Math.abs(epochMs) > MAX_EPOCH_MS) throw new RangeError(`instant out of range: ${epochMs}`);
  const ms = Math.floor(epochMs / 1000) * 1000;                                // offsets change on whole seconds
  const day = Math.floor(ms / DAY_MS);
  const start = day * DAY_MS;
  const end = start + DAY_MS - 1000;
  if (start < -MAX_EPOCH_MS || end > MAX_EPOCH_MS) return intlOffsetSeconds(tz, ms); // the edge day: no cache
  let cache = offsetCache.get(tz);
  if (!cache) offsetCache.set(tz, (cache = new Map()));
  let info = cache.get(day);
  if (!info) {
    const before = intlOffsetSeconds(tz, start);
    const after = intlOffsetSeconds(tz, end);
    let switchMs = end + 1000;
    if (before !== after) {
      let lo = start;
      let hi = end;
      while (hi - lo > 1000) {
        const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
        if (intlOffsetSeconds(tz, mid) === before) lo = mid;
        else hi = mid;
      }
      switchMs = hi;
    }
    info = { before, after, switchMs };
    if (cache.size > 100_000) cache.clear();
    cache.set(day, info);
  }
  return ms >= info.switchMs ? info.after : info.before;
}

/** UTC offset of `tz` at an instant, in whole minutes: historic second offsets are rounded half away from
 *  zero (-00:44:30 → -00:45). */
export function offsetMinutes(epochMs: number, tz: string): number {
  const seconds = offsetSeconds(epochMs, tz);
  const minutes = Math.round(Math.abs(seconds) / 60);
  return seconds < 0 && minutes !== 0 ? -minutes : minutes;
}

/** "+HH:MM" / "-HH:MM" for an offset in minutes; UTC is "+00:00". */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60), 2)}:${pad(abs % 60, 2)}`;
}

/** Epoch microseconds for any supported instant input. */
export function toEpochMicros(value: InstantInput): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError(`not an instant: ${value}`);
    return BigInt(Math.round(value * 1000));
  }
  if (typeof value === "string") return parseInstant(value);
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) throw new RangeError("not an instant: Invalid Date");
    return BigInt(ms) * 1000n;
  }
  if (value && typeof value === "object" && typeof value.micros === "bigint") return value.micros;
  throw new RangeError(`not an instant: ${String(value)}`);
}

const ISO_INSTANT =
  /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2})?)?)$/i;

/** Parse an ISO-8601 instant (it must carry Z or an offset) to epoch microseconds, keeping
 *  microsecond precision. Accepts DuckDB's VARCHAR form too ("2024-01-02 02:00:00.5-08"). */
export function parseInstant(text: string): bigint {
  const m = ISO_INSTANT.exec(text.trim());
  if (!m) throw new RangeError(`not an ISO-8601 instant with an offset: "${text}"`);
  const [, y, mo, d, h, mi, s, frac, off] = m as unknown as string[];
  const year = Number(y), month = Number(mo), day = Number(d), hour = Number(h), minute = Number(mi), second = Number(s ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 24 || minute > 59 || second > 59
    || (hour === 24 && (minute > 0 || second > 0 || frac))) {
    throw new RangeError(`not a valid date and time: "${text}"`);
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  let micros = BigInt(date.getTime()) * 1000n;
  if (frac) micros += BigInt(frac.slice(0, 6).padEnd(6, "0"));
  const offset = off!.toUpperCase();
  if (offset !== "Z") {
    const digits = offset.slice(1).replace(/:/g, "");
    const secs = Number(digits.slice(0, 2)) * 3600 + Number(digits.slice(2, 4) || 0) * 60 + Number(digits.slice(4, 6) || 0);
    micros -= BigInt((offset[0] === "-" ? -1 : 1) * secs) * MICROS_PER_SECOND;
  }
  return micros;
}

/** ISO-8601 in the project zone with its ±HH:MM offset, e.g. 2026-09-21T22:00:00-07:00.
 *  Fractions are kept: 3 digits for millisecond precision, 6 when microseconds are present. Beyond the range
 *  of JS dates (±275,760 years, which DuckDB's TIMESTAMPTZ exceeds) there is no zone data: UTC, +00:00. */
export function formatInstant(value: InstantInput, tz: string): string {
  const micros = toEpochMicros(value);
  const epochMs = Number(floorDiv(micros, 1000n));
  const offset = Math.abs(epochMs) <= MAX_EPOCH_MS ? offsetMinutes(epochMs, tz) : 0;
  return formatNaive(micros + BigInt(offset) * 60n * MICROS_PER_SECOND, false) + formatOffset(offset);
}

/** Proleptic Gregorian date from days since 1970-01-01 (H. Hinnant's civil_from_days). */
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

/** YYYY-MM-DD from days since 1970-01-01; years outside 0000–9999 use ISO-8601 expanded years (±YYYYYY). */
export function formatDate(days: number): string {
  const { y, m, d } = civil(days);
  return `${formatYear(y)}-${pad(m, 2)}-${pad(d, 2)}`;
}

/**
 * "HH:MM:SS" plus fraction: always `fracDigits` wide when `fixed`; otherwise none when zero, and trimmed in
 * groups of three (".5" never, ".500" for whole milliseconds, ".123456" for microseconds).
 */
export function formatClock(usOfDay: bigint, fracDigits: number, fixed: boolean, fracValue?: bigint): string {
  const totalSec = usOfDay / MICROS_PER_SECOND;
  const h = Number(totalSec / 3600n);
  const mi = Number((totalSec / 60n) % 60n);
  const s = Number(totalSec % 60n);
  const frac = fracValue ?? usOfDay % MICROS_PER_SECOND;
  const out = `${pad(h, 2)}:${pad(mi, 2)}:${pad(s, 2)}`;
  if (!fixed && frac === 0n) return out;
  let digits = frac.toString().padStart(fracDigits, "0");
  if (!fixed) while (digits.length > 3 && digits.endsWith("000")) digits = digits.slice(0, -3);
  return `${out}.${digits}`;
}

/** Naive ISO timestamp from microseconds since the epoch: microseconds always when `fixed`, else as formatClock. */
export function formatNaive(micros: bigint, fixed: boolean): string {
  const days = floorDiv(micros, US_PER_DAY);
  return `${formatDate(Number(days))}T${formatClock(micros - days * US_PER_DAY, 6, fixed)}`;
}

function floorDiv(a: bigint, b: bigint): bigint {
  return a % b < 0n ? a / b - 1n : a / b;
}

/** Wall-clock fields of an instant in `tz` (for schedules and human output). */
export function zonedParts(value: InstantInput, tz: string): {
  year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number; offsetMinutes: number;
} {
  const ms = Number(toEpochMicros(value) / 1000n);
  const offset = offsetMinutes(ms, tz);
  const wall = new Date(ms + offset * 60_000);
  return {
    year: wall.getUTCFullYear(), month: wall.getUTCMonth() + 1, day: wall.getUTCDate(),
    hour: wall.getUTCHours(), minute: wall.getUTCMinutes(), second: wall.getUTCSeconds(),
    weekday: wall.getUTCDay(), offsetMinutes: offset,
  };
}

/** The current time. CROFT_NOW (an ISO instant or epoch milliseconds) freezes the clock for tests. */
export function now(env: Record<string, string | undefined> = process.env): Date {
  const fake = env.CROFT_NOW?.trim();
  if (!fake) return new Date();
  try {
    const micros = /^-?\d+$/.test(fake) ? BigInt(fake) * 1000n : parseInstant(fake);
    return new Date(Number(micros / 1000n));
  } catch {
    throw new CroftError("USAGE_ERROR", {
      message: `CROFT_NOW="${fake}" is not an instant`,
      hint: "set CROFT_NOW to an ISO-8601 instant like 2026-09-21T22:00:00-07:00, or unset it",
    });
  }
}

/** `now()` rendered in the project zone. */
export function nowIso(tz: string, env?: Record<string, string | undefined>): string {
  return formatInstant(now(env), tz);
}

function formatYear(year: number): string {
  if (year >= 0 && year <= 9999) return pad(year, 4);
  return `${year < 0 ? "-" : "+"}${pad(Math.abs(year), 6)}`;                // ISO-8601 expanded years
}

function daysInMonth(year: number, month: number): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month, 0);
  return d.getUTCDate();
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}
