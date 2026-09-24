// Schedule phrases (DESIGN.md §8 "Writing a schedule"): what an ingest's `schedule:` may say, turned into the
// 5-field cron the matcher (schedule/cron.ts) reads.
//
// The phrases, in any case and spacing, with an optional trailing period:
// - "every N minutes" (N divides 60; "every minute"), "every hour" / "hourly" (also "every hour at :15"), and
//   "every N hours" (N divides 24);
// - "daily at 06:00" / "every day at 9am", "weekdays at …", "weekends at …", "every monday at 08:30" (any day,
//   abbreviated or plural, several joined by "," or "and"), "monthly" (the 1st) and "monthly at …". Times are
//   24-hour HH:MM, 9am / 6:30pm, noon or midnight; without "at …" the time is 00:00. Days also take ranges:
//   "mon-fri", "monday to friday", "monday through wednesday";
// - a 5-field cron (cron.ts), or a cron macro (@hourly, @daily, @weekly, @monthly, @yearly).
//
// Anything else is SCHEDULE_INVALID. Its suggestion is a schedule that parses, when one is close: a misspelled
// word ("evry hour"), a missing "at" ("daily 9am") or "every" ("15 minutes"), a bare time ("9am" → "daily at
// 9am"), the nearest N that divides the hour or the day, a time with its minutes written out ("at 6" → "at 06:00").
import { didYouMean } from "../project/suggest.ts";
import { parseCron } from "./cron.ts";
import type { ParsedSchedule } from "./types.ts";

/** The hint for a schedule croft cannot read at all. */
export const PHRASES_HINT = 'write it as "every 15 minutes", "every hour", "daily at 06:00", "weekdays at 9am", '
  + '"every monday at 08:30", "monthly", or a 5-field cron such as "0 6 * * 1-5"';

const TIMES_HINT = "write the time as 06:00, 18:30, 9am or 6:30pm";

type Attempt = { cron: string } | { problem: string; hint: string; suggestion?: string };

/** Parse an ingest's `schedule:` text. Never throws. */
export function parseSchedule(input: string): ParsedSchedule {
  if (typeof input !== "string") {
    return { ok: false, problem: `schedule must be a string, got ${input === null ? "null" : typeof input}`, hint: PHRASES_HINT };
  }
  const text = input.trim();
  if (text === "") return { ok: false, problem: "schedule is empty", hint: PHRASES_HINT };
  const r = attempt(text);
  if ("cron" in r) return { ok: true, schedule: { text, cron: r.cron } };
  return { ok: false, problem: r.problem, hint: r.hint, ...(r.suggestion !== undefined ? { suggestion: r.suggestion } : {}) };
}

function attempt(text: string): Attempt {
  const quoted = JSON.stringify(text);
  const spaced = text.replace(/\s+/g, " ");
  if (spaced.startsWith("@")) return macro(spaced, quoted);
  if (looksLikeCron(spaced)) {
    const c = parseCron(spaced);
    return c.ok ? { cron: c.cron.text } : c;
  }
  const p = normalize(spaced);
  return phrase(p, quoted) ?? unknown(p, quoted);
}

/** Minute and hour are numbers, `*`, ranges or steps: "0 6 * * 1-5", "*\/5 * * * * *", "0 9 * *". */
function looksLikeCron(s: string): boolean {
  const tokens = s.split(" ");
  const numeric = (t: string) => /^[\d*?/,-]+$/.test(t);
  return tokens.length >= 3 && numeric(tokens[0]!) && numeric(tokens[1]!) && tokens.every((t) => /^[\w*?/,#-]+$/.test(t));
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s*\.$/, "").replace(/\b([ap])\.m\.?/g, "$1m").trim();
}

// ---------------------------------------------------------------------------------------------------------
// Phrases

const DAYS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4,
  thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};

/** A recognized phrase: its cron, or a problem with it; null when `p` is no phrase at all. */
function phrase(p: string, quoted: string): Attempt | null {
  let m: RegExpExecArray | null;
  if ((m = /^every (?:(\d+) )?(?:minutes|minute|mins|min)$/.exec(p))) return everyMinutes(m[1] === undefined ? 1 : Number(m[1]), quoted);
  if (/^(?:hourly|every hour)$/.test(p)) return { cron: "0 * * * *" };
  if ((m = /^(?:hourly|every hour) at :(\d{2})$/.exec(p))) {
    const minute = Number(m[1]);
    if (minute > 59) return { problem: `schedule ${quoted}: :${m[1]} is not a minute of the hour (:00 to :59)`, hint: 'for example "every hour at :15"' };
    return { cron: `${minute} * * * *` };
  }
  if ((m = /^every (\d+) (?:hours|hour|hrs|hr)$/.exec(p))) return everyHours(Number(m[1]), quoted);
  if ((m = /^(?:daily|every day)(?: at (.+))?$/.exec(p))) return at(p, m[1], "* * *", quoted);
  if ((m = /^(?:weekdays|every weekdays?|on weekdays)(?: at (.+))?$/.exec(p))) return at(p, m[1], "* * 1-5", quoted);
  if ((m = /^(?:weekends|every weekends?|on weekends)(?: at (.+))?$/.exec(p))) return at(p, m[1], "* * 0,6", quoted);
  if ((m = /^monthly(?: at (.+))?$/.exec(p))) return at(p, m[1], "1 * *", quoted);
  if ((m = /^(?:every |on )?([a-z][a-z, -]*?)(?: at (.+))?$/.exec(p))) {
    const days = dayList(m[1]!);
    if (days) return at(p, m[2], `* * ${days}`, quoted);
  }
  return null;
}

/** "monday", "mondays and thursday", "mon, wed, fri", "mon-fri", "monday to friday" as a day-of-week field
 *  ("1,4", "1-5"), or null. */
function dayList(s: string): string | null {
  const days = new Set<number>();
  for (const part of s.split(/\s*,\s*(?:and\s+)?|\s+and\s+/)) {
    const range = /^([a-z]+)(?:\s*-\s*|\s+(?:to|through|thru)\s+)([a-z]+)$/.exec(part);
    const [from, to] = range ? [dayOf(range[1]!), dayOf(range[2]!)] : [dayOf(part), dayOf(part)];
    if (from === undefined || to === undefined) return null;
    for (let d = from; ; d = (d + 1) % 7) {                // friday to monday wraps over the weekend
      days.add(d);
      if (d === to) break;
    }
  }
  return runs([...days].sort((a, b) => a - b));
}

function dayOf(word: string): number | undefined {
  return DAYS[word] ?? (word.endsWith("s") ? DAYS[word.slice(0, -1)] : undefined);
}

/** Sorted values as a cron list, three or more in a row as a range: [1, 2, 3, 5] → "1-3,5". */
function runs(values: readonly number[]): string {
  const out: string[] = [];
  for (let i = 0; i < values.length;) {
    let j = i;
    while (j + 1 < values.length && values[j + 1] === values[j]! + 1) j++;
    if (j - i >= 2) out.push(`${values[i]}-${values[j]}`);
    else for (let k = i; k <= j; k++) out.push(String(values[k]));
    i = j + 1;
  }
  return out.join(",");
}

/** The cron for `rest` (day-of-month month day-of-week) at a time: "at 9am" or none (00:00). */
function at(p: string, time: string | undefined, rest: string, quoted: string): Attempt {
  if (time === undefined) return { cron: `0 0 ${rest}` };
  const t = parseTime(time);
  if ("h" in t) return { cron: `${t.m} ${t.h} ${rest}` };
  const suggestion = t.fixed !== undefined ? p.slice(0, p.length - time.length) + t.fixed : undefined;
  return {
    problem: `schedule ${quoted}: ${t.problem}`,
    hint: suggestion !== undefined ? `did you mean "${suggestion}"?` : TIMES_HINT,
    ...(suggestion !== undefined ? { suggestion } : {}),
  };
}

type TimeParse = { h: number; m: number } | { problem: string; fixed?: string };

const pad = (n: number) => String(n).padStart(2, "0");

/** A time of day: 06:00, 6:30, 9am, 9:30 pm, noon, midnight. */
function parseTime(s: string): TimeParse {
  if (s === "noon") return { h: 12, m: 0 };
  if (s === "midnight") return { h: 0, m: 0 };
  let m: RegExpExecArray | null;
  if ((m = /^(\d{1,2}):(\d{2})$/.exec(s))) {
    const h = Number(m[1]);
    const minute = Number(m[2]);
    if (h === 24 && minute === 0) return { problem: "24:00 is not a time of day; days start at 00:00", fixed: "00:00" };
    if (h > 23 || minute > 59) return { problem: `${s} is not a time of day (00:00 to 23:59)` };
    return { h, m: minute };
  }
  if ((m = /^(\d{1,2})(?::(\d{2}))? ?([ap])m$/.exec(s))) {
    const h = Number(m[1]);
    const minute = m[2] === undefined ? 0 : Number(m[2]);
    if (minute > 59) return { problem: `${s} is not a time of day` };
    if (h === 0 || h > 12) {
      return h <= 23 ? { problem: `${s} mixes a 24-hour time with am/pm`, fixed: `${pad(h)}:${pad(minute)}` } : { problem: `${s} is not a time of day` };
    }
    return { h: (h % 12) + (m[3] === "p" ? 12 : 0), m: minute };
  }
  if ((m = /^(\d{1,2})$/.exec(s))) {
    const h = Number(m[1]);
    if (h >= 1 && h <= 11) return { problem: `${h} could be ${pad(h)}:00 or ${pad(h + 12)}:00`, fixed: `${pad(h)}:00` };
    if (h <= 23) return { problem: `write the time with minutes: ${pad(h)}:00`, fixed: `${pad(h)}:00` };
  }
  return { problem: `"${s}" is not a time croft reads` };
}

const MINUTE_STEPS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60];
const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12, 24];

function everyMinutes(n: number, quoted: string): Attempt {
  if (n === 60) return { cron: "0 * * * *" };
  if (MINUTE_STEPS.includes(n)) return { cron: n === 1 ? "* * * * *" : `*/${n} * * * *` };
  const hint = "Minutes must divide 60: 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30 or 60";
  if (n === 0) return { problem: `schedule ${quoted}: the interval must be at least a minute`, hint: `did you mean "every minute"?`, suggestion: "every minute" };
  const hours = n / 60;
  const suggestion = Number.isInteger(hours) && HOUR_STEPS.includes(hours) ? hoursPhrase(hours) : minutesPhrase(nearest(n, MINUTE_STEPS));
  return {
    problem: `schedule ${quoted}: ${n} does not divide 60, so cron cannot fire every ${n} minutes (its minutes restart at :00 each hour)`,
    hint: `did you mean "${suggestion}"? ${hint}`, suggestion,
  };
}

function everyHours(n: number, quoted: string): Attempt {
  if (n === 1) return { cron: "0 * * * *" };
  if (n === 24) return { cron: "0 0 * * *" };
  if (HOUR_STEPS.includes(n)) return { cron: `0 */${n} * * *` };
  const suggestion = hoursPhrase(nearest(n, HOUR_STEPS));
  const hint = `did you mean "${suggestion}"? Hours must divide 24: 1, 2, 3, 4, 6, 8, 12 or 24`;
  if (n === 0) return { problem: `schedule ${quoted}: the interval must be at least an hour`, hint, suggestion };
  return {
    problem: `schedule ${quoted}: ${n} does not divide 24, so cron cannot fire every ${n} hours (its hours restart at 00:00 each day)`,
    hint, suggestion,
  };
}

/** The closest step; a tie goes to the smaller (more frequent) one. */
function nearest(n: number, steps: readonly number[]): number {
  return steps.reduce((best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best));
}

function minutesPhrase(n: number): string {
  return n === 1 ? "every minute" : n === 60 ? "every hour" : `every ${n} minutes`;
}

function hoursPhrase(n: number): string {
  return n === 1 ? "every hour" : n === 24 ? "daily at 00:00" : `every ${n} hours`;
}

const MACROS: Record<string, string> = {
  "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *", "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *",
};

function macro(s: string, quoted: string): Attempt {
  const name = s.toLowerCase();
  const cron = MACROS[name];
  if (cron) return { cron };
  if (name === "@reboot") return { problem: `schedule ${quoted}: croft schedules times of day, not startup`, hint: PHRASES_HINT };
  const close = didYouMean(name, Object.keys(MACROS));
  return {
    problem: `schedule ${quoted} is not a cron macro (@hourly, @daily, @weekly, @monthly, @yearly)`,
    hint: close ? `did you mean "${close}"?` : PHRASES_HINT, ...(close ? { suggestion: close } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Did you mean

/** Phrases croft does not read, with what it reads instead. */
const INSTEAD: Record<string, string> = {
  "weekly": "every monday at 00:00", "once a week": "every monday at 00:00", "once a month": "monthly",
  "yearly": "0 0 1 1 *", "annually": "0 0 1 1 *", "every year": "0 0 1 1 *", "once a year": "0 0 1 1 *",
  "twice a day": "0 0,12 * * *", "twice daily": "0 0,12 * * *",
  "once a day": "daily at 00:00", "nightly": "daily at 00:00", "every night": "daily at 00:00",
  "every hours": "every hour", "every minutes": "every minute",
  "every other day": "0 0 */2 * *",
};

/** Words the phrases use, for spelling fixes. The plural comes first: "minuts" is closest to both. */
const WORDS = ["every", "minutes", "minute", "mins", "min", "hours", "hour", "hrs", "hr", "hourly", "daily", "day",
  "at", "and", "on", "weekdays", "weekday", "weekends", "weekend", "monthly", "noon", "midnight", "am", "pm",
  ...Object.keys(DAYS).flatMap((d) => [d, `${d}s`])];

function unknown(p: string, quoted: string): Attempt {
  return unit(p, quoted) ?? notAPhrase(quoted, INSTEAD[p] ?? closest(p));
}

function notAPhrase(quoted: string, suggestion: string | undefined): Attempt {
  return {
    problem: `schedule ${quoted} is not a phrase croft knows, nor a 5-field cron`,
    hint: suggestion !== undefined ? `did you mean "${suggestion}"?` : PHRASES_HINT,
    ...(suggestion !== undefined ? { suggestion } : {}),
  };
}

/** Units cron cannot count: seconds, days, weeks, months. */
function unit(p: string, quoted: string): Attempt | null {
  const m = /^every (?:(\d+) )?(seconds?|secs?|days?|weeks?|months?)$/.exec(p);
  if (!m) return null;
  const n = m[1] === undefined ? 1 : Number(m[1]);
  const what = m[2]!;
  if (what.startsWith("sec")) {
    return {
      problem: `schedule ${quoted}: croft schedules to the minute, so every minute is the most often`,
      hint: 'did you mean "every minute"?', suggestion: "every minute",
    };
  }
  if (what.startsWith("day")) {
    if (n === 1) return notAPhrase(quoted, "daily");
    const cron = n >= 2 && n <= 31 ? `0 0 */${n} * *` : undefined;
    return {
      problem: `schedule ${quoted}: cron cannot count days across months (they restart on the 1st)`,
      hint: cron ? `did you mean "${cron}"? It fires on the 1st, ${ordinal(1 + n)}, ${ordinal(1 + 2 * n)}, … of each month; or use daily`
        : 'use "daily"',
      ...(cron ? { suggestion: cron } : {}),
    };
  }
  if (what.startsWith("week")) {
    if (n === 1) return notAPhrase(quoted, "every monday at 00:00");
    return { problem: `schedule ${quoted}: cron cannot count weeks`, hint: 'name a day instead, like "every monday at 09:00"' };
  }
  if (n === 1) return notAPhrase(quoted, "monthly");
  const cron = n >= 2 && 12 % n === 0 ? `0 0 1 */${n} *` : undefined;
  return {
    problem: `schedule ${quoted}: cron counts months only when they divide the year (2, 3, 4 or 6)`,
    hint: cron ? `did you mean "${cron}"? It fires at 00:00 on the 1st of every ${ordinal(n)} month from January`
      : 'use "monthly", or a cron such as "0 0 1 */3 *" (every third month)',
    ...(cron ? { suggestion: cron } : {}),
  };
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${s}`;
}

/** The closest phrase that parses: spelling fixed word by word, a missing "at" or "every" put back, a bare time
 *  made daily. */
function closest(p: string): string | undefined {
  const spelled = p.split(" ").map((w) => (/^[a-z]+$/.test(w) && !WORDS.includes(w) ? didYouMean(w, WORDS) ?? w : w)).join(" ");
  for (const candidate of new Set([p, spelled])) {
    const fixed = parses(withAt(candidate)) ?? parses(`daily at ${candidate.replace(/^at /, "")}`)
      ?? (candidate.startsWith("every ") ? undefined : parses(`every ${candidate}`));
    if (fixed !== undefined && fixed !== p) return fixed;
    if (candidate !== p) {
      const direct = parses(candidate);
      if (direct !== undefined) return direct;
    }
  }
  return undefined;
}

/** "daily 9am" → "daily at 9am": "at" before the last word, when that word is a time. */
function withAt(p: string): string {
  const i = p.lastIndexOf(" ");
  if (i < 0 || / at /.test(` ${p} `)) return p;
  const tail = p.slice(i + 1);
  return "h" in parseTime(tail) || /^\d{1,2}$/.test(tail) ? `${p.slice(0, i)} at ${tail}` : p;
}

/** The phrase itself when it parses, or the phrase its own problem suggests. */
function parses(p: string): string | undefined {
  const r = phrase(p, JSON.stringify(p));
  if (!r) return undefined;
  if ("cron" in r) return p;
  return r.suggestion;
}
