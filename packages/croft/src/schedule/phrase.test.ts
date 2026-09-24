import { describe, expect, test } from "bun:test";
import { nextFires } from "./cron.ts";
import { PHRASES_HINT } from "./phrase.ts";
import { parseSchedule } from "./types.ts";

function cronOf(text: string): string {
  const p = parseSchedule(text);
  if (!p.ok) throw new Error(`${JSON.stringify(text)}: ${p.problem}`);
  return p.schedule.cron;
}

function refused(text: string): { problem: string; hint: string; suggestion?: string } {
  const p = parseSchedule(text);
  if (p.ok) throw new Error(`${JSON.stringify(text)} parsed as ${p.schedule.cron}`);
  return p;
}

const ACCEPTED: [string, string][] = [
  // every N minutes (N divides 60)
  ["every 15 minutes", "*/15 * * * *"],
  ["every 5 mins", "*/5 * * * *"],
  ["every 30 minutes", "*/30 * * * *"],
  ["every 2 min", "*/2 * * * *"],
  ["every minute", "* * * * *"],
  ["every 1 minute", "* * * * *"],
  ["every 60 minutes", "0 * * * *"],
  // hourly
  ["every hour", "0 * * * *"],
  ["hourly", "0 * * * *"],
  ["Every Hour", "0 * * * *"],
  ["  every   hour  ", "0 * * * *"],
  ["every 1 hour", "0 * * * *"],
  ["every hour at :15", "15 * * * *"],
  ["hourly at :05", "5 * * * *"],
  ["every 6 hours", "0 */6 * * *"],
  ["every 2 hrs", "0 */2 * * *"],
  ["every 24 hours", "0 0 * * *"],
  // daily
  ["daily at 06:00", "0 6 * * *"],
  ["daily at 6:30", "30 6 * * *"],
  ["daily at 23:59", "59 23 * * *"],
  ["daily at 9am", "0 9 * * *"],
  ["daily at 9 am", "0 9 * * *"],
  ["daily at 9:30pm", "30 21 * * *"],
  ["daily at 9:30 p.m.", "30 21 * * *"],
  ["daily at 12am", "0 0 * * *"],
  ["daily at 12pm", "0 12 * * *"],
  ["daily at 12:15am", "15 0 * * *"],
  ["daily at noon", "0 12 * * *"],
  ["daily at midnight", "0 0 * * *"],
  ["every day at 18:45", "45 18 * * *"],
  ["Daily At 6AM.", "0 6 * * *"],
  ["daily", "0 0 * * *"],
  ["every day", "0 0 * * *"],
  // weekdays and weekends
  ["weekdays at 9am", "0 9 * * 1-5"],
  ["every weekday at 09:00", "0 9 * * 1-5"],
  ["on weekdays at 17:30", "30 17 * * 1-5"],
  ["weekends at 10:00", "0 10 * * 0,6"],
  // named days, plural ok
  ["every monday at 08:30", "30 8 * * 1"],
  ["every mondays at 08:30", "30 8 * * 1"],
  ["mondays at 08:30", "30 8 * * 1"],
  ["on mondays at 8:30am", "30 8 * * 1"],
  ["every Mon at 8:30am", "30 8 * * 1"],
  ["every tuesday at 07:00", "0 7 * * 2"],
  ["every wednesday at 07:00", "0 7 * * 3"],
  ["every thurs at 07:00", "0 7 * * 4"],
  ["every friday at 07:00", "0 7 * * 5"],
  ["every saturday at 07:00", "0 7 * * 6"],
  ["every sunday at 23:00", "0 23 * * 0"],
  ["every monday and thursday at 9am", "0 9 * * 1,4"],
  ["every friday, monday at 07:00", "0 7 * * 1,5"],
  ["every monday, wednesday and friday at 07:00", "0 7 * * 1,3,5"],
  ["every monday", "0 0 * * 1"],
  ["every mon-fri at 9am", "0 9 * * 1-5"],
  ["monday to friday at 9am", "0 9 * * 1-5"],
  ["every monday through wednesday at 07:00", "0 7 * * 1-3"],
  ["every monday and tuesday at 07:00", "0 7 * * 1,2"],
  ["every fri-mon at 07:00", "0 7 * * 0,1,5,6"],
  ["every saturday and sunday at 10:00", "0 10 * * 0,6"],
  // monthly
  ["monthly", "0 0 1 * *"],
  ["monthly at 06:00", "0 6 1 * *"],
  // cron, as written (one space apart)
  ["0 6 * * 1-5", "0 6 * * 1-5"],
  ["*/10  9-17 * * MON-FRI", "*/10 9-17 * * MON-FRI"],
  ["0 0 1,15 * *", "0 0 1,15 * *"],
  // cron macros
  ["@hourly", "0 * * * *"],
  ["@daily", "0 0 * * *"],
  ["@midnight", "0 0 * * *"],
  ["@weekly", "0 0 * * 0"],
  ["@monthly", "0 0 1 * *"],
  ["@yearly", "0 0 1 1 *"],
  ["@Annually", "0 0 1 1 *"],
];

describe("parseSchedule: phrases", () => {
  test.each(ACCEPTED)("%s → %s", (text, cron) => {
    expect(cronOf(text)).toBe(cron);
  });

  test("the text is kept as written (trimmed); the cron is the normalized form", () => {
    expect(parseSchedule("  Every Hour ")).toEqual({ ok: true, schedule: { text: "Every Hour", cron: "0 * * * *" } });
  });

  test("every cron it gives parses again to itself and fires", () => {
    const after = new Date("2026-09-24T17:00:00Z");
    for (const [text] of ACCEPTED) {
      const cron = cronOf(text);
      expect({ text, again: cronOf(cron) }).toEqual({ text, again: cron });
      expect(nextFires(cron, "America/Los_Angeles", after, 3).length).toBe(3);
    }
  });
});

describe("parseSchedule: SCHEDULE_INVALID", () => {
  test("an unknown phrase says what croft reads", () => {
    expect(refused("whenever you like")).toEqual({
      ok: false, problem: 'schedule "whenever you like" is not a phrase croft knows, nor a 5-field cron', hint: PHRASES_HINT,
    } as never);
    expect(PHRASES_HINT).toBe('write it as "every 15 minutes", "every hour", "daily at 06:00", "weekdays at 9am", '
      + '"every monday at 08:30", "monthly", or a 5-field cron such as "0 6 * * 1-5"');
  });

  test("empty", () => {
    expect(refused("   ")).toMatchObject({ problem: "schedule is empty", hint: PHRASES_HINT });
  });

  test.each([
    ["evry hour", "every hour"],
    ["every hours", "every hour"],
    ["hourley", "hourly"],
    ["every 15 minuts", "every 15 minutes"],
    ["dialy at 06:00", "daily at 06:00"],
    ["every mondy at 08:30", "every monday at 08:30"],
    ["every tuesay and thrusday at 9am", "every tuesday and thursday at 9am"],
    ["wekdays at 9am", "weekdays at 9am"],
    ["montly", "monthly"],
    ["daily 9am", "daily at 9am"],
    ["weekdays 06:00", "weekdays at 06:00"],
    ["at 9am", "daily at 9am"],
    ["9am", "daily at 9am"],
    ["06:00", "daily at 06:00"],
    ["weekly", "every monday at 00:00"],
    ["every week", "every monday at 00:00"],
    ["every month", "monthly"],
    ["yearly", "0 0 1 1 *"],
    ["twice a day", "0 0,12 * * *"],
    ["every 30 seconds", "every minute"],
    ["every 2 days", "0 0 */2 * *"],
    ["every day at 9", "every day at 09:00"],
    ["dialy at 9", "daily at 09:00"],
    ["@hourley", "@hourly"],
    ["15 minutes", "every 15 minutes"],
    ["hour", "every hour"],
    ["day at 6am", "every day at 6am"],
    ["every 1 day", "daily"],
  ])("%s → did you mean %s?", (text, suggestion) => {
    const p = refused(text);
    expect(p.suggestion).toBe(suggestion);
    expect(p.hint).toStartWith(`did you mean "${suggestion}"?`);
    expect(parseSchedule(suggestion).ok).toBe(true);
  });

  test("every N minutes: N must divide 60; the nearest N that does is suggested", () => {
    expect(refused("every 7 minutes")).toEqual({
      ok: false,
      problem: 'schedule "every 7 minutes": 7 does not divide 60, so cron cannot fire every 7 minutes (its minutes restart at :00 each hour)',
      hint: 'did you mean "every 6 minutes"? Minutes must divide 60: 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30 or 60',
      suggestion: "every 6 minutes",
    } as never);
    expect(refused("every 8 minutes").suggestion).toBe("every 6 minutes");   // a tie: the more frequent
    expect(refused("every 9 minutes").suggestion).toBe("every 10 minutes");
    expect(refused("every 25 minutes").suggestion).toBe("every 20 minutes");
    expect(refused("every 45 minutes").suggestion).toBe("every 30 minutes");
    expect(refused("every 50 minutes").suggestion).toBe("every hour");
    expect(refused("every 90 minutes").suggestion).toBe("every hour");
    expect(refused("every 120 minutes").suggestion).toBe("every 2 hours");
    expect(refused("every 0 minutes")).toMatchObject({
      problem: 'schedule "every 0 minutes": the interval must be at least a minute', suggestion: "every minute",
    });
  });

  test("every N hours: N must divide 24", () => {
    expect(refused("every 5 hours")).toMatchObject({
      problem: 'schedule "every 5 hours": 5 does not divide 24, so cron cannot fire every 5 hours (its hours restart at 00:00 each day)',
      suggestion: "every 4 hours",
    });
    expect(refused("every 7 hours").suggestion).toBe("every 6 hours");
    expect(refused("every 36 hours").suggestion).toBe("daily at 00:00");
    expect(refused("every 0 hours").suggestion).toBe("every hour");
  });

  test("times: a bare hour is ambiguous, 24:00 is 00:00, am/pm needs a 12-hour clock", () => {
    expect(refused("daily at 6")).toMatchObject({
      problem: 'schedule "daily at 6": 6 could be 06:00 or 18:00', suggestion: "daily at 06:00",
    });
    expect(refused("daily at 18")).toMatchObject({ problem: 'schedule "daily at 18": write the time with minutes: 18:00', suggestion: "daily at 18:00" });
    expect(refused("daily at 24:00")).toMatchObject({
      problem: 'schedule "daily at 24:00": 24:00 is not a time of day; days start at 00:00', suggestion: "daily at 00:00",
    });
    expect(refused("weekdays at 13pm")).toMatchObject({
      problem: 'schedule "weekdays at 13pm": 13pm mixes a 24-hour time with am/pm', suggestion: "weekdays at 13:00",
    });
    expect(refused("daily at 9:75")).toMatchObject({ problem: 'schedule "daily at 9:75": 9:75 is not a time of day (00:00 to 23:59)' });
    expect(refused("daily at 9:75").suggestion).toBeUndefined();
    expect(refused("every monday at teatime")).toMatchObject({
      problem: 'schedule "every monday at teatime": "teatime" is not a time croft reads',
      hint: "write the time as 06:00, 18:30, 9am or 6:30pm",
    });
    expect(refused("hourly at :75")).toMatchObject({ problem: 'schedule "hourly at :75": :75 is not a minute of the hour (:00 to :59)' });
  });

  test("units croft cannot schedule say why", () => {
    expect(refused("every 30 seconds").problem).toBe('schedule "every 30 seconds": croft schedules to the minute, so every minute is the most often');
    expect(refused("every 2 days")).toMatchObject({
      problem: 'schedule "every 2 days": cron cannot count days across months (they restart on the 1st)',
      hint: 'did you mean "0 0 */2 * *"? It fires on the 1st, 3rd, 5th, … of each month; or use daily',
    });
    expect(refused("every 2 weeks")).toMatchObject({
      problem: 'schedule "every 2 weeks": cron cannot count weeks', hint: 'name a day instead, like "every monday at 09:00"',
    });
    expect(refused("every 3 months")).toMatchObject({ suggestion: "0 0 1 */3 *" });
    expect(refused("@reboot")).toMatchObject({
      problem: 'schedule "@reboot": croft schedules times of day, not startup', hint: PHRASES_HINT,
    });
  });

  test("cron errors come from the cron parser, suggestions included", () => {
    expect(refused("0 25 * * *").problem).toBe('schedule "0 25 * * *": hour 25 is out of range (0-23)');
    expect(refused("0 9 * *").problem).toBe('schedule "0 9 * *" has 4 fields; a cron has 5: minute hour day-of-month month day-of-week');
    expect(refused("0 */5 * * * *").suggestion).toBe("*/5 * * * *");
    expect(refused("0 9 * * mon-fir").suggestion).toBe("0 9 * * mon-fri");
  });

  test("never throws, whatever it is given", () => {
    for (const bad of [undefined, null, 5, {}, "\u0000", "every", "at", "every at", "every 99999999999999999999 minutes", "* * * * * * * *"]) {
      const p = parseSchedule(bad as string);
      expect(p.ok).toBe(false);
    }
  });
});
