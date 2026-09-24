import { describe, expect, test } from "bun:test";
import { CroftError } from "../core/errors.ts";
import { formatInstant } from "../core/time.ts";
import { type Cron, latestFireAtOrBefore, LOOKBACK_DAYS, nextFires, parseCron } from "./cron.ts";

const LA = "America/Los_Angeles";
const NY = "America/New_York";
const LONDON = "Europe/London";
const SYDNEY = "Australia/Sydney";
const LORD_HOWE = "Australia/Lord_Howe";
const KOLKATA = "Asia/Kolkata";

const MINUTE = 60_000;

/** The next `n` fires after `after`, in local time (the offset shows which side of a transition each is on). */
function local(cron: string, tz: string, after: string, n: number): string[] {
  return nextFires(cron, tz, new Date(after), n).map((d) => formatInstant(d, tz));
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function cron(text: string): Cron {
  const p = parseCron(text);
  if (!p.ok) throw new Error(`${text}: ${p.problem}`);
  return p.cron;
}

function refused(text: string): { problem: string; hint: string; suggestion?: string } {
  const p = parseCron(text);
  if (p.ok) throw new Error(`${text} parsed`);
  return p;
}

describe("parseCron", () => {
  test("numbers, *, ranges, steps and lists", () => {
    const c = cron("*/15 9-17 1,15 * 1-5");
    expect(c.text).toBe("*/15 9-17 1,15 * 1-5");
    expect(c.minutes).toEqual([0, 15, 30, 45]);
    expect(c.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(c.days.flatMap((on, d) => (on ? [d] : []))).toEqual([1, 15]);
    expect(c.months.flatMap((on, m) => (on ? [m] : []))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(c.weekdays.flatMap((on, d) => (on ? [d] : []))).toEqual([1, 2, 3, 4, 5]);
    expect(c.anyDay).toBe(false);
    expect(c.anyWeekday).toBe(false);
  });

  test("a range with a step, a start with a step (a/n runs to the field's end), and lists of both", () => {
    expect(cron("10-40/10 0 * * *").minutes).toEqual([10, 20, 30, 40]);
    expect(cron("50/5 0 * * *").minutes).toEqual([50, 55]);
    expect(cron("0 1,3-5,20-23/2 * * *").hours).toEqual([1, 3, 4, 5, 20, 22]);
    expect(cron("0 0 */10 * *").days.flatMap((on, d) => (on ? [d] : []))).toEqual([1, 11, 21, 31]);
  });

  test("month and weekday names, any case; 7 is Sunday too", () => {
    const c = cron("0 9 * JAN,jul-Sep mon-FRI");
    expect(c.months.flatMap((on, m) => (on ? [m] : []))).toEqual([1, 7, 8, 9]);
    expect(c.weekdays.flatMap((on, d) => (on ? [d] : []))).toEqual([1, 2, 3, 4, 5]);
    expect(cron("0 0 * * 7").weekdays.flatMap((on, d) => (on ? [d] : []))).toEqual([0]);
    expect(cron("0 0 * * 5-7").weekdays.flatMap((on, d) => (on ? [d] : []))).toEqual([0, 5, 6]);
    expect(cron("0 0 * * sun").weekdays.flatMap((on, d) => (on ? [d] : []))).toEqual([0]);
  });

  test("the text is the five fields one space apart; ? in a day field is *", () => {
    expect(cron("  0   6 *  * 1-5 ").text).toBe("0 6 * * 1-5");
    expect(cron("0 6 ? * mon").text).toBe("0 6 * * mon");
    expect(cron("0 6 1 * ?").text).toBe("0 6 1 * *");
  });

  test("interval: the minute or hour field starts with * (cron's wildcard jobs)", () => {
    expect(cron("*/15 * * * *").interval).toBe(true);
    expect(cron("0 * * * *").interval).toBe(true);
    expect(cron("* 2 * * *").interval).toBe(true);
    expect(cron("*/20 1-3 * * *").interval).toBe(true);
    expect(cron("30 1 * * *").interval).toBe(false);
    expect(cron("0 1-3 * * *").interval).toBe(false);
    expect(cron("0,30 9 * * 1-5").interval).toBe(false);
  });

  test.each([
    ["0 9 * *", 'schedule "0 9 * *" has 4 fields; a cron has 5: minute hour day-of-month month day-of-week'],
    ["60 * * * *", 'schedule "60 * * * *": minute 60 is out of range (0-59)'],
    ["0 24 * * *", 'schedule "0 24 * * *": hour 24 is out of range (0-23)'],
    ["0 0 0 * *", 'schedule "0 0 0 * *": day of month 0 is out of range (1-31)'],
    ["0 0 32 * *", 'schedule "0 0 32 * *": day of month 32 is out of range (1-31)'],
    ["0 0 * 13 *", 'schedule "0 0 * 13 *": month 13 is out of range (1-12)'],
    ["0 0 * * 8", 'schedule "0 0 * * 8": day of week 8 is out of range (0-7)'],
    ["*/0 * * * *", 'schedule "*/0 * * * *": the step in the minute field must be a whole number of 1 or more, got "0"'],
    ["0 0 * * mon-", 'schedule "0 0 * * mon-": "mon-" in the day of week field is not a number, a name, * or a range'],
    ["0 0 L * *", 'schedule "0 0 L * *": "L" (last day) in the day of month field is not standard cron'],
    ["0 0 * * 5#3", 'schedule "0 0 * * 5#3": "#" (nth weekday) in the day of week field is not standard cron'],
    ["0 0 15W * *", 'schedule "0 0 15W * *": "W" (nearest weekday) in the day of month field is not standard cron'],
    ["0 0,,1 * * *", 'schedule "0 0,,1 * * *": the hour field has an empty list item'],
    ["0 0 30 2 *", 'schedule "0 0 30 2 *" never fires: February has no day 30'],
    ["0 0 31 4,6 *", 'schedule "0 0 31 4,6 *" never fires: April and June have no day 31'],
    ["0 0 31 apr,jun,sep,nov *", 'schedule "0 0 31 apr,jun,sep,nov *" never fires: April, June, September and November have no day 31'],
  ])("%s is refused", (text, message) => {
    expect(refused(text).problem).toBe(message);
    expect(refused(text).hint).not.toBe("");
  });

  test("Feb 29 is a valid day (it fires in leap years); a day that exists in one listed month is enough", () => {
    expect(parseCron("0 0 29 2 *").ok).toBe(true);
    expect(parseCron("0 0 31 1,2 *").ok).toBe(true);
    // Day of month or day of week (both restricted): it fires every Monday in February.
    expect(parseCron("0 0 30 2 mon").ok).toBe(true);
  });

  test("a misspelled name suggests the name; a backwards range suggests its two halves", () => {
    expect(refused("0 9 * * mon-fir")).toMatchObject({
      problem: 'schedule "0 9 * * mon-fir": "fir" is not a day of week (sun-sat or 0-7)', suggestion: "0 9 * * mon-fri",
    });
    expect(refused("0 9 * jnu *")).toMatchObject({ suggestion: "0 9 * jun *" });
    expect(refused("0 9 * * fri-mon")).toMatchObject({
      problem: 'schedule "0 9 * * fri-mon": the range fri-mon in the day of week field runs backwards',
      suggestion: "0 9 * * 5-6,0-1",
    });
    expect(refused("0 22-2 * * *")).toMatchObject({ suggestion: "0 22-23,0-2 * * *" });
  });

  test("the suggestion for a backwards range keeps its step", () => {
    expect(refused("0 22-4/2 * * *").suggestion).toBe("0 22-23/2,0-4/2 * * *");
  });

  test("six fields: croft schedules to the minute, so the seconds field is dropped", () => {
    expect(refused("0 */5 * * * *")).toMatchObject({
      problem: 'schedule "0 */5 * * * *" has 6 fields; croft schedules to the minute, so there is no seconds field',
      suggestion: "*/5 * * * *",
    });
  });

  test("every suggestion parses", () => {
    for (const text of ["0 9 * * mon-fir", "0 9 * jnu *", "0 9 * * fri-mon", "0 22-4/2 * * *", "0 */5 * * * *"]) {
      const s = refused(text).suggestion!;
      expect(parseCron(s).ok).toBe(true);
    }
  });
});

describe("nextFires", () => {
  test("strictly after `after`, as instants, in order", () => {
    expect(local("*/15 * * * *", "UTC", "2026-09-24T10:07:00Z", 3)).toEqual([
      "2026-09-24T10:15:00+00:00", "2026-09-24T10:30:00+00:00", "2026-09-24T10:45:00+00:00"]);
    expect(local("*/15 * * * *", "UTC", "2026-09-24T10:15:00Z", 1)).toEqual(["2026-09-24T10:30:00+00:00"]);
    expect(local("*/15 * * * *", "UTC", "2026-09-24T10:14:59.999Z", 1)).toEqual(["2026-09-24T10:15:00+00:00"]);
    expect(nextFires("* * * * *", "UTC", new Date("2026-09-24T10:00:00Z"), 0)).toEqual([]);
  });

  test("hours, weekdays and the month boundary in the project zone", () => {
    // 2026-09-25 is a Friday.
    expect(local("0 9 * * 1-5", LA, "2026-09-25T10:00:00-07:00", 3)).toEqual([
      "2026-09-28T09:00:00-07:00", "2026-09-29T09:00:00-07:00", "2026-09-30T09:00:00-07:00"]);
    expect(local("0 0 1 * *", LA, "2026-09-24T12:00:00-07:00", 3)).toEqual([
      "2026-10-01T00:00:00-07:00", "2026-11-01T00:00:00-07:00", "2026-12-01T00:00:00-08:00"]);
    expect(local("30 8 * * mon", LA, "2026-09-24T12:00:00-07:00", 2)).toEqual([
      "2026-09-28T08:30:00-07:00", "2026-10-05T08:30:00-07:00"]);
  });

  test("the local day, not the UTC day, decides the weekday", () => {
    // 23:30 on Sunday in Los Angeles is Monday in UTC; "Sundays at 23:30" fires then.
    expect(local("30 23 * * 0", LA, "2026-09-24T00:00:00-07:00", 1)).toEqual(["2026-09-27T23:30:00-07:00"]);
    expect(local("30 23 * * 0", KOLKATA, "2026-09-24T00:00:00+05:30", 1)).toEqual(["2026-09-27T23:30:00+05:30"]);
  });

  test("day of month and day of week both restricted: either one matches (cron's rule)", () => {
    // The 13th, and every Friday. 2026-11-13 is a Friday.
    expect(local("0 0 13 * 5", "UTC", "2026-11-01T00:00:00Z", 4)).toEqual([
      "2026-11-06T00:00:00+00:00", "2026-11-13T00:00:00+00:00", "2026-11-20T00:00:00+00:00", "2026-11-27T00:00:00+00:00"]);
    expect(local("0 0 12 * 5", "UTC", "2026-11-01T00:00:00Z", 3)).toEqual([
      "2026-11-06T00:00:00+00:00", "2026-11-12T00:00:00+00:00", "2026-11-13T00:00:00+00:00"]);
  });

  test("a day field starting with * (a step) makes it both, as in cron", () => {
    // Odd days of the month that are Mondays: 2026-11-09 and 2026-11-23.
    expect(local("0 0 */2 * 1", "UTC", "2026-11-01T00:00:00Z", 2)).toEqual([
      "2026-11-09T00:00:00+00:00", "2026-11-23T00:00:00+00:00"]);
  });

  test("February 29 fires in leap years only, across 2100 (no leap day)", () => {
    expect(local("0 0 29 2 *", "UTC", "2026-09-24T00:00:00Z", 3)).toEqual([
      "2028-02-29T00:00:00+00:00", "2032-02-29T00:00:00+00:00", "2036-02-29T00:00:00+00:00"]);
    expect(local("0 0 29 2 *", "UTC", "2097-01-01T00:00:00Z", 2)).toEqual([
      "2104-02-29T00:00:00+00:00", "2108-02-29T00:00:00+00:00"]);
  });

  test("Asia/Kolkata (+05:30, no DST): whole local hours are half-hours in UTC", () => {
    expect(nextFires("0 * * * *", KOLKATA, new Date("2026-09-24T10:00:00Z"), 3).map(iso)).toEqual([
      "2026-09-24T10:30:00.000Z", "2026-09-24T11:30:00.000Z", "2026-09-24T12:30:00.000Z"]);
    expect(local("0 9 * * *", KOLKATA, "2026-09-24T12:00:00+05:30", 2)).toEqual([
      "2026-09-25T09:00:00+05:30", "2026-09-26T09:00:00+05:30"]);
    expect(iso(nextFires("0 9 * * *", KOLKATA, new Date("2026-09-24T12:00:00+05:30"), 1)[0]!)).toBe("2026-09-25T03:30:00.000Z");
  });

  test("an invalid cron is SCHEDULE_INVALID", () => {
    let err: unknown;
    try { nextFires("0 25 * * *", "UTC", new Date(), 1); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CroftError);
    expect((err as CroftError).code).toBe("SCHEDULE_INVALID");
  });
});

describe("DST golden days", () => {
  test("America/Los_Angeles 2026-03-08: daily at 02:30 fires once, at 03:00 (the first minute after the gap)", () => {
    expect(local("30 2 * * *", LA, "2026-03-07T00:00:00-08:00", 3)).toEqual([
      "2026-03-07T02:30:00-08:00", "2026-03-08T03:00:00-07:00", "2026-03-09T02:30:00-07:00"]);
  });

  test("America/Los_Angeles 2026-11-01: daily at 01:30 fires once, at its first occurrence", () => {
    expect(local("30 1 * * *", LA, "2026-10-31T00:00:00-07:00", 3)).toEqual([
      "2026-10-31T01:30:00-07:00", "2026-11-01T01:30:00-07:00", "2026-11-02T01:30:00-08:00"]);
    // Asked during the repeated hour (01:10 PST, after the first 01:30), the next fire is tomorrow's.
    expect(local("30 1 * * *", LA, "2026-11-01T09:10:00Z", 1)).toEqual(["2026-11-02T01:30:00-08:00"]);
  });

  test("America/New_York 2026-03-08 and 2026-11-01", () => {
    expect(local("30 2 * * *", NY, "2026-03-07T12:00:00-05:00", 2)).toEqual([
      "2026-03-08T03:00:00-04:00", "2026-03-09T02:30:00-04:00"]);
    expect(local("30 1 * * *", NY, "2026-10-31T12:00:00-04:00", 2)).toEqual([
      "2026-11-01T01:30:00-04:00", "2026-11-02T01:30:00-05:00"]);
  });

  test("Europe/London 2026-03-29 (01:00 → 02:00) and 2026-10-25 (02:00 → 01:00)", () => {
    expect(local("30 1 * * *", LONDON, "2026-03-28T12:00:00+00:00", 2)).toEqual([
      "2026-03-29T02:00:00+01:00", "2026-03-30T01:30:00+01:00"]);
    expect(local("30 1 * * *", LONDON, "2026-10-24T12:00:00+01:00", 2)).toEqual([
      "2026-10-25T01:30:00+01:00", "2026-10-26T01:30:00+00:00"]);
  });

  test("Australia/Sydney 2026-04-05 (03:00 → 02:00) and 2026-10-04 (02:00 → 03:00)", () => {
    expect(local("30 2 * * *", SYDNEY, "2026-04-04T12:00:00+11:00", 2)).toEqual([
      "2026-04-05T02:30:00+11:00", "2026-04-06T02:30:00+10:00"]);
    expect(local("30 2 * * *", SYDNEY, "2026-10-03T12:00:00+10:00", 2)).toEqual([
      "2026-10-04T03:00:00+11:00", "2026-10-05T02:30:00+11:00"]);
  });

  test("Australia/Lord_Howe: a 30-minute DST (02:00 → 01:30 on 2026-04-05, 02:00 → 02:30 on 2026-10-04)", () => {
    expect(local("45 1 * * *", LORD_HOWE, "2026-04-04T12:00:00+11:00", 2)).toEqual([
      "2026-04-05T01:45:00+11:00", "2026-04-06T01:45:00+10:30"]);
    expect(local("15 2 * * *", LORD_HOWE, "2026-10-03T12:00:00+10:30", 2)).toEqual([
      "2026-10-04T02:30:00+11:00", "2026-10-05T02:15:00+11:00"]);
  });

  test("several gap times fold into the one fire after the gap; a fixed repeated hour fires once", () => {
    expect(local("0,30 2 * * *", LA, "2026-03-08T00:00:00-08:00", 2)).toEqual([
      "2026-03-08T03:00:00-07:00", "2026-03-09T02:00:00-07:00"]);
    expect(local("0 1-3 * * *", LA, "2026-11-01T00:00:00-07:00", 3)).toEqual([
      "2026-11-01T01:00:00-07:00", "2026-11-01T02:00:00-08:00", "2026-11-01T03:00:00-08:00"]);
  });

  test("every hour keeps firing hourly in real time through the repeated hour", () => {
    expect(local("0 * * * *", LA, "2026-11-01T00:30:00-07:00", 4)).toEqual([
      "2026-11-01T01:00:00-07:00", "2026-11-01T01:00:00-08:00", "2026-11-01T02:00:00-08:00", "2026-11-01T03:00:00-08:00"]);
    expect(local("0 * * * *", LA, "2026-03-08T00:30:00-08:00", 3)).toEqual([
      "2026-03-08T01:00:00-08:00", "2026-03-08T03:00:00-07:00", "2026-03-08T04:00:00-07:00"]);
  });

  test.each([
    [LA, "2026-03-08"], [LA, "2026-11-01"], [NY, "2026-03-08"], [NY, "2026-11-01"],
    [LONDON, "2026-03-29"], [LONDON, "2026-10-25"], [SYDNEY, "2026-04-05"], [SYDNEY, "2026-10-04"],
    [LORD_HOWE, "2026-04-05"], [LORD_HOWE, "2026-10-04"], [KOLKATA, "2026-03-08"],
  ])("every 15 minutes in %s on %s: no duplicates, no missing instants", (tz, day) => {
    // From 22:00 UTC two days before, well past the transition: 300 fires (75 hours).
    const start = new Date(new Date(`${day}T00:00:00Z`).getTime() - 26 * 3_600_000);
    const fires = nextFires("*/15 * * * *", tz, start, 300).map((d) => d.getTime());
    expect(fires.length).toBe(300);
    expect(new Set(fires).size).toBe(300);
    for (let i = 1; i < fires.length; i++) expect(fires[i]! - fires[i - 1]!).toBe(15 * MINUTE);
  });
});

// A reference that knows nothing about offsets: it walks real time one minute at a time, reads the local wall
// clock from Intl, and applies the rules literally. A matching wall minute fires when it is reached; wall minutes
// a spring-forward jumps over fire at the minute the clock lands on; a fixed-time cron does not fire again at a
// wall minute it already passed (the repeated hour of a fall-back).
/** The local wall clock at every minute of [fromMs, toMs), as minutes since 1970-01-01T00:00 local. */
function wallMinutes(tz: string, fromMs: number, toMs: number): number[] {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
  });
  const out: number[] = [];
  for (let t = fromMs; t < toMs; t += MINUTE) {
    const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    out.push(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute)) / MINUTE);
  }
  return out;
}

function reference(c: Cron, walls: readonly number[], startMs: number, afterMs: number): number[] {
  const matches = (key: number) => {
    const t = new Date(key * MINUTE);
    const dom = c.days[t.getUTCDate()]!, dow = c.weekdays[t.getUTCDay()]!;
    return c.minutes.includes(t.getUTCMinutes()) && c.hours.includes(t.getUTCHours()) && c.months[t.getUTCMonth() + 1]!
      && (c.anyDay || c.anyWeekday ? dom && dow : dom || dow);
  };
  const seen = new Set<number>();
  const out: number[] = [];
  for (let i = 1; i < walls.length; i++) {
    const w = walls[i]!;
    const t = startMs + i * MINUTE;
    let fire = false;
    for (let skipped = walls[i - 1]! + 1; skipped < w; skipped++) if (matches(skipped)) fire = true;
    if (matches(w) && (c.interval || !seen.has(w))) fire = true;
    seen.add(w);
    if (fire && t > afterMs) out.push(t);
  }
  return out;
}

describe("the matcher against a minute-by-minute reference", () => {
  const CRONS = ["*/15 * * * *", "0 * * * *", "30 1 * * *", "30 2 * * *", "0 1-3 * * *", "*/20 1-2 * * *",
    "45 1 * * *", "15 2 * * *", "* 2 * * *", "0,30 1,2 * * *"];
  test.each([
    [LA, "2026-03-08"], [LA, "2026-11-01"], [NY, "2026-03-08"], [NY, "2026-11-01"],
    [LONDON, "2026-03-29"], [LONDON, "2026-10-25"], [SYDNEY, "2026-04-05"], [SYDNEY, "2026-10-04"],
    [LORD_HOWE, "2026-04-05"], [LORD_HOWE, "2026-10-04"], [KOLKATA, "2026-03-08"],
  ])("%s around %s", (tz, day) => {
    // 40 hours around the transition; the walk starts 3 hours earlier, so a repeated hour's first pass is seen.
    const from = new Date(`${day}T00:00:00Z`).getTime() - 20 * 3_600_000;
    const to = from + 40 * 3_600_000;
    const start = from - 3 * 3_600_000;
    const walls = wallMinutes(tz, start, to);
    for (const text of CRONS) {
      const want = reference(cron(text), walls, start, from);
      expect({ text, fires: nextFires(text, tz, new Date(from), want.length).map((d) => d.toISOString()) })
        .toEqual({ text, fires: want.map((t) => new Date(t).toISOString()) });
      // The fire after the window is after it; latestFireAtOrBefore agrees at every 7th minute.
      expect(nextFires(text, tz, new Date(want.at(-1) ?? from), 1)[0]!.getTime()).toBeGreaterThanOrEqual(to);
      for (let now = from + 7 * MINUTE; now < to; now += 7 * MINUTE) {
        const expected = want.filter((t) => t <= now).at(-1);
        if (expected === undefined) continue;
        expect({ text, now: new Date(now).toISOString(), latest: iso(latestFireAtOrBefore(text, tz, new Date(now))) })
          .toEqual({ text, now: new Date(now).toISOString(), latest: new Date(expected).toISOString() });
      }
    }
  });
});

describe("latestFireAtOrBefore", () => {
  test("at or before: a fire exactly at `now` counts", () => {
    expect(iso(latestFireAtOrBefore("0 * * * *", "UTC", new Date("2026-09-24T10:00:00Z")))).toBe("2026-09-24T10:00:00.000Z");
    expect(iso(latestFireAtOrBefore("0 * * * *", "UTC", new Date("2026-09-24T09:59:59.999Z")))).toBe("2026-09-24T09:00:00.000Z");
  });

  test("the spring-forward fire is the instant after the gap", () => {
    expect(iso(latestFireAtOrBefore("30 2 * * *", LA, new Date("2026-03-08T10:30:00Z")))).toBe("2026-03-08T10:00:00.000Z");
    expect(iso(latestFireAtOrBefore("30 2 * * *", LA, new Date("2026-03-08T09:59:00Z")))).toBe("2026-03-07T10:30:00.000Z");
  });

  test("during the repeated hour a fixed time's latest fire is its first occurrence", () => {
    // 01:45 PST, the second pass through 01:xx: the 01:30 fire was at 01:30 PDT (08:30Z), not 09:30Z.
    expect(iso(latestFireAtOrBefore("30 1 * * *", LA, new Date("2026-11-01T09:45:00Z")))).toBe("2026-11-01T08:30:00.000Z");
    expect(iso(latestFireAtOrBefore("*/15 * * * *", LA, new Date("2026-11-01T09:20:00Z")))).toBe("2026-11-01T09:15:00.000Z");
  });

  test(`looks back at most ${LOOKBACK_DAYS} days`, () => {
    expect(iso(latestFireAtOrBefore("0 0 29 2 *", "UTC", new Date("2025-01-15T00:00:00Z")))).toBe("2024-02-29T00:00:00.000Z");
    expect(latestFireAtOrBefore("0 0 29 2 *", "UTC", new Date("2026-09-24T00:00:00Z"))).toBeNull();
    expect(iso(latestFireAtOrBefore("0 0 1 1 *", "UTC", new Date("2026-09-24T00:00:00Z")))).toBe("2026-01-01T00:00:00.000Z");
  });

  test("monthly, in the project zone", () => {
    expect(iso(latestFireAtOrBefore("0 0 1 * *", LA, new Date("2026-09-24T12:00:00Z")))).toBe("2026-09-01T07:00:00.000Z");
    expect(iso(latestFireAtOrBefore("0 0 1 * *", SYDNEY, new Date("2026-09-24T12:00:00Z")))).toBe("2026-08-31T14:00:00.000Z");
  });
});

describe("performance", () => {
  test("nextFires for 3 fires takes under 5 ms, even for a zone used for the first time", () => {
    const cases: [string, string][] = [
      ["*/15 * * * *", "Pacific/Chatham"], ["0 * * * *", "America/Sao_Paulo"], ["30 2 * * *", "America/Denver"],
      ["0 9 * * 1-5", "Europe/Berlin"], ["0 0 1 * *", "Asia/Tokyo"], ["30 8 * * mon", "Africa/Cairo"],
      ["0 0 29 2 *", "America/Chicago"], ["* * * * *", "Asia/Kathmandu"],
    ];
    const after = new Date("2026-09-24T17:00:00Z");
    for (const [text, tz] of cases) {
      const t0 = performance.now();
      const fires = nextFires(text, tz, after, 3);
      const ms = performance.now() - t0;
      expect(fires.length).toBe(3);
      expect({ text, tz, fast: ms < 5 }).toEqual({ text, tz, fast: true });
    }
  });

  test("latestFireAtOrBefore is as quick", () => {
    const now = new Date("2026-09-24T17:00:00Z");
    for (const text of ["*/15 * * * *", "0 * * * *", "30 2 * * *", "0 9 * * 1-5", "0 0 1 * *", "0 0 1 1 *"]) {
      latestFireAtOrBefore(text, LA, now);
      const t0 = performance.now();
      latestFireAtOrBefore(text, LA, now);
      expect({ text, fast: performance.now() - t0 < 5 }).toEqual({ text, fast: true });
    }
  });
});
