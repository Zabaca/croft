// Time rendering in the project time zone (DESIGN.md §4 "Timestamps", §7 "Time zones").
// JSON timestamps carry the project offset so they agree with `::DATE` in SQL. croft renders
// instants itself because DuckDB's JSON helpers use the process-local zone.
import { CroftError } from "./errors.ts";

/** An instant: a Date, epoch milliseconds, epoch microseconds (bigint, DuckDB's TIMESTAMPTZ unit),
 *  an ISO-8601 string with an offset, or a DuckDB timestamp value ({ micros }). */
export type InstantInput = Date | number | bigint | string | { readonly micros: bigint };

const MICROS_PER_SECOND = 1_000_000n;
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

/** UTC offset of `tz` at an instant, in whole minutes (historic second offsets are rounded). */
export function offsetMinutes(epochMs: number, tz: string): number {
  if (!Number.isFinite(epochMs) || Math.abs(epochMs) > MAX_EPOCH_MS) throw new RangeError(`instant out of range: ${epochMs}`);
  const name = offsetFormat(tz).formatToParts(new Date(epochMs)).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /^GMT(?:([+-])(\d{1,2})(?::?(\d{2}))?(?::?(\d{2}))?)?$/.exec(name);
  if (!m) throw new RangeError(`unexpected offset "${name}" for ${tz}`);
  if (!m[1]) return 0;
  const seconds = Number(m[2]) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
  return (m[1] === "-" ? -1 : 1) * Math.round(seconds / 60);
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

/** ISO-8601 in the project zone with its offset, e.g. 2026-09-21T22:00:00-07:00.
 *  Fractions are kept: 3 digits for millisecond precision, 6 when microseconds are present. */
export function formatInstant(value: InstantInput, tz: string): string {
  const micros = toEpochMicros(value);
  let seconds = micros / MICROS_PER_SECOND;
  let fraction = micros % MICROS_PER_SECOND;
  if (fraction < 0n) { fraction += MICROS_PER_SECOND; seconds -= 1n; }       // floor for pre-1970 instants
  const epochMs = Number(seconds) * 1000;
  const offset = offsetMinutes(epochMs, tz);
  const wall = new Date(epochMs + offset * 60_000);
  const frac = fraction === 0n ? "" : fraction % 1000n === 0n
    ? `.${pad(Number(fraction / 1000n), 3)}` : `.${pad(Number(fraction), 6)}`;
  return `${formatYear(wall.getUTCFullYear())}-${pad(wall.getUTCMonth() + 1, 2)}-${pad(wall.getUTCDate(), 2)}`
    + `T${pad(wall.getUTCHours(), 2)}:${pad(wall.getUTCMinutes(), 2)}:${pad(wall.getUTCSeconds(), 2)}${frac}${formatOffset(offset)}`;
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
