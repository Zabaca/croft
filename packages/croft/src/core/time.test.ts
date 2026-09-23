import { describe, expect, test } from "bun:test";
import { CroftError } from "./errors.ts";
import {
  checkTimeZone, formatInstant, formatNaive, formatOffset, now, offsetMinutes, offsetSeconds, parseInstant, toEpochMicros, zonedParts,
} from "./time.ts";

const LA = "America/Los_Angeles";
const TOKYO = "Asia/Tokyo";

describe("formatInstant", () => {
  test("design examples render with the project offset", () => {
    expect(formatInstant(new Date("2026-09-22T05:00:00Z"), LA)).toBe("2026-09-21T22:00:00-07:00");
    // epoch-second cursors from §4.2, converted to ms
    expect(formatInstant(1756000000 * 1000, LA)).toBe("2025-08-23T18:46:40-07:00");
    expect(formatInstant(1758600000 * 1000, LA)).toBe("2025-09-22T21:00:00-07:00");
  });

  test("Los Angeles across spring-forward (2026-03-08)", () => {
    expect(formatInstant("2026-03-08T09:59:59Z", LA)).toBe("2026-03-08T01:59:59-08:00");
    expect(formatInstant("2026-03-08T10:00:00Z", LA)).toBe("2026-03-08T03:00:00-07:00");
  });

  test("Los Angeles across fall-back (2026-11-01): the repeated hour gets two offsets", () => {
    expect(formatInstant("2026-11-01T08:30:00Z", LA)).toBe("2026-11-01T01:30:00-07:00");
    expect(formatInstant("2026-11-01T09:30:00Z", LA)).toBe("2026-11-01T01:30:00-08:00");
  });

  test("Tokyo has no DST: the same instants are always +09:00", () => {
    expect(formatInstant("2026-03-08T10:00:00Z", TOKYO)).toBe("2026-03-08T19:00:00+09:00");
    expect(formatInstant("2026-11-01T09:30:00Z", TOKYO)).toBe("2026-11-01T18:30:00+09:00");
    expect(formatInstant("2026-12-31T15:00:00Z", TOKYO)).toBe("2027-01-01T00:00:00+09:00");
  });

  test("the same instant in both zones", () => {
    const t = "2026-07-01T00:00:00Z";
    expect(formatInstant(t, LA)).toBe("2026-06-30T17:00:00-07:00");
    expect(formatInstant(t, TOKYO)).toBe("2026-07-01T09:00:00+09:00");
  });

  test("keeps microseconds and milliseconds, omits a zero fraction", () => {
    const micros = parseInstant("2026-09-22T05:00:00.123456Z");
    expect(formatInstant(micros, LA)).toBe("2026-09-21T22:00:00.123456-07:00");
    expect(formatInstant({ micros }, TOKYO)).toBe("2026-09-22T14:00:00.123456+09:00");
    expect(formatInstant(new Date("2026-09-22T05:00:00.120Z"), LA)).toBe("2026-09-21T22:00:00.120-07:00");
    expect(formatInstant("2026-09-22T05:00:00.000100Z", LA)).toBe("2026-09-21T22:00:00.000100-07:00");
    expect(formatInstant("2026-09-22T05:00:00.000Z", LA)).toBe("2026-09-21T22:00:00-07:00");
  });

  test("pre-1970 instants with fractions floor correctly", () => {
    expect(formatInstant(-1n, "UTC")).toBe("1969-12-31T23:59:59.999999+00:00");
    expect(formatInstant(-500, "UTC")).toBe("1969-12-31T23:59:59.500+00:00");
  });

  test("UTC renders +00:00; half-hour and 45-minute zones work", () => {
    expect(formatInstant("2026-01-01T00:00:00Z", "UTC")).toBe("2026-01-01T00:00:00+00:00");
    expect(formatInstant("2026-01-01T00:00:00Z", "Asia/Kolkata")).toBe("2026-01-01T05:30:00+05:30");
    expect(formatInstant("2026-01-01T00:00:00Z", "Asia/Kathmandu")).toBe("2026-01-01T05:45:00+05:45");
  });

  test("historic second offsets are rounded to minutes without changing the instant", () => {
    const s = formatInstant("1850-01-01T00:00:00Z", LA);          // LMT -07:52:58
    expect(s).toBe("1849-12-31T16:07:00-07:53");
    expect(parseInstant(s)).toBe(parseInstant("1850-01-01T00:00:00Z"));
  });

  test("round-trips through parseInstant", () => {
    for (const iso of ["2026-03-08T01:59:59.5-08:00", "2026-11-01T01:30:00-08:00", "2000-02-29T12:00:00+09:00"]) {
      const micros = parseInstant(iso);
      expect(parseInstant(formatInstant(micros, LA))).toBe(micros);
      expect(parseInstant(formatInstant(micros, TOKYO))).toBe(micros);
    }
  });

  test("offsets are always ±HH:MM, even for historic second offsets, and the string names the exact instant", () => {
    // Monrovia Mean Time was -00:44:30 until 1972: a half-minute offset rounds away from zero to -00:45.
    const monrovia = parseInstant("1950-06-01T12:00:00.25Z");
    expect(offsetSeconds(Date.parse("1950-06-01T12:00:00Z"), "Africa/Monrovia")).toBe(-(44 * 60 + 30));
    expect(formatInstant(monrovia, "Africa/Monrovia")).toBe("1950-06-01T11:15:00.250-00:45");
    expect(parseInstant(formatInstant(monrovia, "Africa/Monrovia"))).toBe(monrovia);
    for (let i = 0; i < 500; i++) {
      const micros = BigInt(Math.floor((Math.random() * 9.5e9 - 5.4e9) * 1e6));   // 1800..2100
      const s = formatInstant(micros, LA);
      expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3}|\.\d{6})?[+-]\d{2}:\d{2}$/);
      expect(parseInstant(s)).toBe(micros);
    }
  });

  test("instants beyond JS dates render in UTC instead of throwing", () => {
    const far = 10_000_000_000_000_000_000n;                                           // ~ year 318,857
    expect(formatInstant(far, LA)).toBe(`${formatNaive(far, false)}+00:00`);
    expect(formatInstant(-far, LA).endsWith("+00:00")).toBe(true);
  });

  test("rejects naive and invalid inputs", () => {
    expect(() => formatInstant("2026-09-22T05:00:00", LA)).toThrow(RangeError);
    expect(() => formatInstant(new Date("nope"), LA)).toThrow(RangeError);
    expect(() => formatInstant(Number.NaN, LA)).toThrow(RangeError);
  });
});

describe("parseInstant", () => {
  test("accepts offsets in several spellings and DuckDB's VARCHAR form", () => {
    const want = parseInstant("2024-01-02T10:00:00Z");
    expect(parseInstant("2024-01-02 02:00:00-08")).toBe(want);
    expect(parseInstant("2024-01-02T02:00:00-0800")).toBe(want);
    expect(parseInstant("2024-01-02T19:00:00+09:00")).toBe(want);
    expect(parseInstant("2024-01-02t10:00:00z")).toBe(want);
    expect(parseInstant("2024-01-02T10:00Z")).toBe(want);
  });

  test("keeps microseconds and drops nanoseconds", () => {
    expect(parseInstant("1970-01-01T00:00:00.123456789Z")).toBe(123456n);
  });

  test("rejects impossible dates", () => {
    expect(() => parseInstant("2026-02-30T00:00:00Z")).toThrow(RangeError);
    expect(() => parseInstant("2026-13-01T00:00:00Z")).toThrow(RangeError);
    expect(() => parseInstant("2025-02-29T00:00:00Z")).toThrow(RangeError);
    expect(parseInstant("2024-02-29T00:00:00Z")).toBeGreaterThan(0n);
  });
});

describe("offsets and parts", () => {
  test("offsetMinutes and formatOffset", () => {
    expect(offsetMinutes(Date.parse("2026-01-15T00:00:00Z"), LA)).toBe(-480);
    expect(offsetMinutes(Date.parse("2026-07-15T00:00:00Z"), LA)).toBe(-420);
    expect(offsetMinutes(Date.parse("2026-07-15T00:00:00Z"), TOKYO)).toBe(540);
    expect(formatOffset(-420)).toBe("-07:00");
    expect(formatOffset(345)).toBe("+05:45");
    expect(formatOffset(0)).toBe("+00:00");
  });

  test("offsetSeconds (cached per UTC day) switches at the exact transition second", () => {
    const spring = Date.parse("2026-03-08T10:00:00Z");                                 // LA springs forward
    expect(offsetSeconds(spring - 1000, LA)).toBe(-8 * 3600);
    expect(offsetSeconds(spring - 1, LA)).toBe(-8 * 3600);
    expect(offsetSeconds(spring, LA)).toBe(-7 * 3600);
    expect(offsetSeconds(spring + 999, LA)).toBe(-7 * 3600);
    // Same answers asked in the other order (the day is cached by now).
    expect(offsetSeconds(spring, LA)).toBe(-7 * 3600);
    expect(offsetSeconds(spring - 1000, LA)).toBe(-8 * 3600);
    // Lord Howe changes by 30 minutes at 15:00 UTC.
    const lordHowe = Date.parse("2026-04-04T15:00:00Z");
    expect(offsetSeconds(lordHowe - 1000, "Australia/Lord_Howe")).toBe(11 * 3600);
    expect(offsetSeconds(lordHowe, "Australia/Lord_Howe")).toBe(10.5 * 3600);
    expect(offsetMinutes(lordHowe, "Australia/Lord_Howe")).toBe(630);
    expect(() => offsetSeconds(9e15, LA)).toThrow(RangeError);
  });

  test("zonedParts gives the wall clock", () => {
    expect(zonedParts("2026-11-01T09:30:00Z", LA)).toEqual({
      year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0, weekday: 0, offsetMinutes: -480,
    });
  });

  test("toEpochMicros accepts every input kind", () => {
    expect(toEpochMicros(1500)).toBe(1_500_000n);
    expect(toEpochMicros(1.5)).toBe(1500n);
    expect(toEpochMicros(new Date(2))).toBe(2000n);
    expect(toEpochMicros(7n)).toBe(7n);
    expect(toEpochMicros({ micros: 9n })).toBe(9n);
  });
});

describe("checkTimeZone", () => {
  test("accepts canonical IANA names, including aliases DuckDB accepts", () => {
    for (const tz of [LA, TOKYO, "UTC", "Etc/UTC", "US/Pacific", "Asia/Kolkata"]) expect(checkTimeZone(tz)).toEqual({ ok: true, name: tz });
  });

  test("rejects offsets, which DuckDB's SET TimeZone refuses", () => {
    const r = checkTimeZone("+07:00");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("fixed offset");
    expect(checkTimeZone("UTC+2").ok).toBe(false);
  });

  test("suggests the canonical spelling and guesses from a city", () => {
    expect(checkTimeZone("america/los_angeles")).toEqual({ ok: false, reason: 'it is spelled "America/Los_Angeles"', suggestion: LA });
    const tokyo = checkTimeZone("Tokyo");
    expect(tokyo.ok).toBe(false);
    if (!tokyo.ok) expect(tokyo.suggestion).toBe(TOKYO);
    const la = checkTimeZone("los angeles");
    if (!la.ok) expect(la.suggestion).toBe(LA);
    expect(checkTimeZone("Mars/Olympus").ok).toBe(false);
    expect(checkTimeZone("").ok).toBe(false);
  });
});

describe("now", () => {
  test("honors CROFT_NOW as ISO or epoch ms", () => {
    expect(now({ CROFT_NOW: "2026-09-21T22:00:00-07:00" }).toISOString()).toBe("2026-09-22T05:00:00.000Z");
    expect(now({ CROFT_NOW: "0" }).getTime()).toBe(0);
    expect(now({ CROFT_NOW: "1758600000000" }).getTime()).toBe(1758600000000);
  });

  test("uses the real clock without CROFT_NOW", () => {
    const before = Date.now();
    const t = now({}).getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });

  test("an invalid CROFT_NOW is a usage error", () => {
    let err: unknown;
    try { now({ CROFT_NOW: "yesterday" }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CroftError);
    expect((err as CroftError).code).toBe("USAGE_ERROR");
  });
});
