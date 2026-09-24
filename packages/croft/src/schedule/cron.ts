// 5-field cron and croft's time-zone-aware matcher (DESIGN.md §8 "Writing a schedule"). Local wall-clock times
// come from Intl through core/time.ts offsetSeconds, never Bun.cron: its zone handling changed between Bun
// versions [V].
//
// A cron is minute hour day-of-month month day-of-week, each field a list of numbers, names (jan-dec, sun-sat),
// `*`, ranges `a-b` and steps `/n` (`a/n` runs from a to the field's end, as in Vixie cron). Day of week 7 is
// Sunday, like 0. When day of month and day of week are both restricted (neither starts with `*`), a day that
// matches either one fires ("0 0 13 * 5": the 13th and every Friday); otherwise a day must match both.
//
// Fire times are instants. Each matching local day expands to its matching wall times, and each wall time
// becomes an instant:
// - a wall time that exists once fires then;
// - a wall time inside a spring-forward gap (02:30 on 2026-03-08 in Los Angeles) fires at the first valid minute
//   after the gap (03:00), the transition itself; several gap times fold into that one fire;
// - a wall time a fall-back repeats (01:30 on 2026-11-01) fires once, at its first occurrence, when the cron
//   names a fixed time. A cron whose minute or hour field starts with `*` ("every 15 minutes", "every hour") is
//   an interval and fires at both occurrences, so its fires stay evenly spaced in real time: cron's own rule for
//   its "wildcard" jobs.
//
// Offsets are looked up per local day: when the offset a day before and two days after the day agree (every day
// but the few around a transition), every wall time of the day maps with that one offset. This assumes at most
// one transition within three days, which real zones keep (core/time.ts assumes one per UTC day).
import { CroftError } from "../core/errors.ts";
import { offsetSeconds } from "../core/time.ts";
import { didYouMean } from "../project/suggest.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** latestFireAtOrBefore looks back this many days, no further. */
export const LOOKBACK_DAYS = 400;

/** A valid cron fires at least this often: Feb 29 on one weekday comes back within 40 years. nextFires stops
 *  looking after this many days without a fire (it never gets there for a cron parseCron accepted). */
const MAX_QUIET_DAYS = 41 * 366;

/** A parsed cron: which values of each field fire. */
export interface Cron {
  /** The five fields, one space apart (`?` in a day field written as `*`). */
  text: string;
  /** Sorted, distinct. */
  minutes: number[];
  hours: number[];
  /** Indexed by day of month 1-31, month 1-12 and day of week 0-6 (Sunday 0). */
  days: boolean[];
  months: boolean[];
  weekdays: boolean[];
  /** The day-of-month field starts with `*`: the days then fire only on matching weekdays too (cron's rule). */
  anyDay: boolean;
  /** The day-of-week field starts with `*`. */
  anyWeekday: boolean;
  /** The minute or hour field starts with `*`: it fires at both passes of a repeated local time. */
  interval: boolean;
}

export type CronParse =
  | { ok: true; cron: Cron }
  /** `problem` is a SCHEDULE_INVALID message; `suggestion` a cron that parses, when one is close. */
  | { ok: false; problem: string; hint: string; suggestion?: string };

interface Field {
  name: string;
  /** "an hour", for "x is not an hour". */
  noun: string;
  min: number;
  max: number;
  /** The highest value a wrapped range runs to (day of week: 6, since 7 is Sunday again). */
  top: number;
  names?: readonly string[];
  /** Names start at this value (months: jan is 1). */
  base?: number;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const MONTH_WORDS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
  "November", "December"];

const FIELDS: readonly Field[] = [
  { name: "minute", noun: "a minute", min: 0, max: 59, top: 59 },
  { name: "hour", noun: "an hour", min: 0, max: 23, top: 23 },
  { name: "day of month", noun: "a day of month", min: 1, max: 31, top: 31 },
  { name: "month", noun: "a month", min: 1, max: 12, top: 12, names: MONTHS, base: 1 },
  { name: "day of week", noun: "a day of week", min: 0, max: 7, top: 6, names: WEEKDAYS, base: 0 },
];

/** How a cron reads, for hints. */
export const CRON_FIELDS_HINT = "a cron is minute (0-59) hour (0-23) day-of-month (1-31) month (1-12 or jan-dec) "
  + "day-of-week (0-7 or sun-sat; 0 and 7 are Sunday), each a number, name, *, range a-b, step /n or a list";

/** Longest day of each month, Feb 29 included. */
const MONTH_DAYS = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** How many problems a suggestion may fix one after another (one field item each). */
const MAX_FIXES = 12;

/**
 * A cron that does not parse, before its suggestion is checked. `hint` is for when no suggestion is offered;
 * `say` words the hint around the suggestion that is.
 */
type Refusal = { ok: false; problem: string; hint: string; suggestion?: string; say?: (suggestion: string) => string };

/** Parse a 5-field cron. Never throws. A suggestion is offered only when it parses itself: one fix can leave
 *  another problem ("0 0 * janury mnday"), so each is fixed in turn, and none is offered when one cannot be. */
export function parseCron(input: string): CronParse {
  const r = parseOnce(input);
  if (r.ok) return r;
  const suggestion = r.suggestion === undefined ? undefined : repaired(r.suggestion);
  if (suggestion === undefined) return { ok: false, problem: r.problem, hint: r.hint };
  return { ok: false, problem: r.problem, hint: r.say ? r.say(suggestion) : r.hint, suggestion };
}

/** `s` when it parses; else what fixing its problems one by one leads to, when that parses; else undefined. */
function repaired(s: string): string | undefined {
  for (let i = 0; i < MAX_FIXES; i++) {
    const p = parseOnce(s);
    if (p.ok) return s;
    if (p.suggestion === undefined || p.suggestion === s) return undefined;
    s = p.suggestion;
  }
  return undefined;
}

function parseOnce(input: string): { ok: true; cron: Cron } | Refusal {
  const text = input.trim().replace(/\s+/g, " ");
  const tokens = text === "" ? [] : text.split(" ");
  const quoted = JSON.stringify(text);
  const count = {
    ok: false as const, hint: CRON_FIELDS_HINT,
    problem: `schedule ${quoted} has ${tokens.length} field${tokens.length === 1 ? "" : "s"}; a cron has 5: minute hour day-of-month month day-of-week`,
  };
  if (tokens.length === 6) {
    // Seconds first (Spring, node-cron), else a year last (AWS): whichever leaves a cron that parses.
    const seconds = tokens.slice(1).join(" ");
    const fixed = repaired(seconds);
    if (fixed !== undefined) {
      return {
        ok: false, problem: `schedule ${quoted} has 6 fields; croft schedules to the minute, so there is no seconds field`,
        hint: CRON_FIELDS_HINT, suggestion: fixed,
        say: (s) => `drop the first (seconds) field${s === seconds ? "" : ", and fix the rest"}: ${s}`,
      };
    }
    const year = tokens.slice(0, 5).join(" ");
    const fixedYear = repaired(year);
    if (fixedYear !== undefined) {
      return {
        ok: false,
        problem: `schedule ${quoted} has 6 fields; a cron has 5 (minute hour day-of-month month day-of-week), with no year field`,
        hint: CRON_FIELDS_HINT, suggestion: fixedYear,
        say: (s) => `drop the last field${s === year ? "" : ", and fix the rest"}: ${s}`,
      };
    }
    return count;
  }
  if (tokens.length === 7) {
    // Quartz: seconds first and a year last.
    const five = tokens.slice(1, 6).join(" ");
    const fixed = repaired(five);
    if (fixed === undefined) return count;
    return {
      ok: false, problem: `schedule ${quoted} has 7 fields; croft schedules to the minute and has no year field`,
      hint: CRON_FIELDS_HINT, suggestion: fixed,
      say: (s) => `drop the first (seconds) and last (year) fields${s === five ? "" : ", and fix the rest"}: ${s}`,
    };
  }
  if (tokens.length !== 5) return count;
  // `?` (Quartz's "no value") in a day field means what `*` means.
  const fields = tokens.map((t, i) => (t === "?" && (i === 2 || i === 4) ? "*" : t));
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const r = parseField(fields[i]!, FIELDS[i]!);
    if ("problem" in r) {
      const suggestion = r.fixed !== undefined ? tokens.map((f, j) => (j === i ? r.fixed : f)).join(" ") : undefined;
      return {
        ok: false, problem: `schedule ${quoted}: ${r.problem}`, hint: CRON_FIELDS_HINT,
        ...(suggestion !== undefined ? { suggestion, say: (s: string) => `did you mean ${s}? (${CRON_FIELDS_HINT})` } : {}),
      };
    }
    sets.push(r.values);
  }
  const [minutes, hours, days, months, weekdays] = sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (weekdays.has(7)) { weekdays.delete(7); weekdays.add(0); }
  const cron: Cron = {
    text: fields.join(" "),
    minutes: [...minutes].sort((a, b) => a - b),
    hours: [...hours].sort((a, b) => a - b),
    days: flags(days, 32), months: flags(months, 13), weekdays: flags(weekdays, 7),
    anyDay: fields[2]!.startsWith("*"), anyWeekday: fields[4]!.startsWith("*"),
    interval: fields[0]!.startsWith("*") || fields[1]!.startsWith("*"),
  };
  const never = neverFires(cron);
  if (never) return { ok: false, problem: `schedule ${quoted} never fires: ${never}`, hint: "check the day-of-month and month fields; " + CRON_FIELDS_HINT };
  return { ok: true, cron };
}

function flags(values: Set<number>, size: number): boolean[] {
  return Array.from({ length: size }, (_, i) => values.has(i));
}

type FieldParse = { values: Set<number> } | { problem: string; fixed?: string };

function parseField(raw: string, f: Field): FieldParse {
  const values = new Set<number>();
  const items = raw.split(",");
  for (let k = 0; k < items.length; k++) {
    const item = items[k]!;
    if (item === "") return { problem: `the ${f.name} field has an empty list item` };
    const quartz = quartzToken(item, f);
    if (quartz) return { problem: `${quartz} in the ${f.name} field is not standard cron` };
    const m = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(.*))?$/i.exec(item);
    if (!m) return { problem: `"${item}" in the ${f.name} field is not a number, a name, * or a range` };
    const [, range, stepText] = m as unknown as [string, string, string | undefined];
    let step = 1;
    if (stepText !== undefined) {
      step = /^\d+$/.test(stepText) ? Number(stepText) : NaN;
      if (!(step >= 1)) return { problem: `the step in the ${f.name} field must be a whole number of 1 or more, got "${stepText}"` };
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = f.min;
      hi = f.top;
    } else {
      const [a, b] = range.split("-") as [string, string | undefined];
      const va = value(a, f);
      if (typeof va !== "number") return withFix(va, items, k, item, a);
      lo = va;
      if (b !== undefined) {
        const vb = value(b, f);
        if (typeof vb !== "number") return withFix(vb, items, k, item, b);
        hi = vb;
        if (hi < lo && !(f.max === 7 && hi === 0)) {
          return { problem: `the range ${range} in the ${f.name} field runs backwards`, fixed: replaceItem(items, k, wrapped(lo, hi, f, stepText)) };
        }
        if (f.max === 7 && hi === 0 && lo > 0) hi = 7;    // sat-sun: 6-0 is 6-7
      } else {
        hi = stepText !== undefined ? f.max : lo;          // a/n runs to the end
      }
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values };
}

/** A Quartz-only token in a day field, named for the message: '"L" (last day)'. */
function quartzToken(item: string, f: Field): string | undefined {
  if (f.name !== "day of month" && f.name !== "day of week") return undefined;
  if (item.includes("#")) return '"#" (nth weekday)';
  if (f.name === "day of month" && /^(\d+|L)W$/i.test(item)) return '"W" (nearest weekday)';
  if (/^L$/i.test(item) || /^L-\d+$/i.test(item) || /^\d+L$/i.test(item)) return '"L" (last day)';
  return undefined;
}

/** A number or a name in range, or why not (with the name it is closest to). */
function value(token: string, f: Field): number | { problem: string; name?: string } {
  if (/^\d+$/.test(token)) {
    const n = Number(token);
    if (n < f.min || n > f.max) return { problem: `${f.name} ${n} is out of range (${f.min}-${f.max})` };
    return n;
  }
  const lower = token.toLowerCase();
  if (f.names) {
    const i = f.names.indexOf(lower);
    if (i >= 0) return i + (f.base ?? 0);
    const name = didYouMean(lower, f.names);
    return { problem: `"${token}" is not ${f.noun} (${f.names[0]}-${f.names.at(-1)} or ${f.min}-${f.max})`, ...(name ? { name } : {}) };
  }
  return { problem: `"${token}" is not ${f.noun} (${f.min}-${f.max})` };
}

function withFix(bad: { problem: string; name?: string }, items: readonly string[], k: number, item: string, token: string): FieldParse {
  if (!bad.name) return { problem: bad.problem };
  const at = item.indexOf(token);
  return { problem: bad.problem, fixed: replaceItem(items, k, item.slice(0, at) + bad.name + item.slice(at + token.length)) };
}

function replaceItem(items: readonly string[], k: number, to: string): string {
  return items.map((x, i) => (i === k ? to : x)).join(",");
}

/** A backwards range a-b as the two ranges it means: a to the field's end, and its start to b. A day of week
 *  from 7 is Sunday's other number, so 7-mon is the plain range 0-1. */
function wrapped(lo: number, hi: number, f: Field, stepText: string | undefined): string {
  const part = (a: number, b: number) => (a === b ? `${a}` : `${a}-${b}${stepText !== undefined ? `/${stepText}` : ""}`);
  if (f.max === 7 && lo === 7) return part(0, hi);
  return `${part(lo, f.top)},${part(f.min, hi)}`;
}

/** Why a cron can never fire, or undefined. Only a day of month that no listed month has can do that, and only
 *  when the day of week does not stand in for it (both restricted: either one matching is enough). */
function neverFires(c: Cron): string | undefined {
  if (!c.anyDay && !c.anyWeekday) return undefined;
  const months = c.months.flatMap((on, m) => (on ? [m] : []));
  const days = c.days.flatMap((on, d) => (on ? [d] : []));
  if (months.some((m) => days.some((d) => d <= MONTH_DAYS[m]!))) return undefined;
  const names = months.map((m) => MONTH_WORDS[m - 1]!);
  return `${list(names, "and")} ${names.length === 1 ? "has" : "have"} no day ${list(days.map(String), "or")}`;
}

function list(items: readonly string[], word: string): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} ${word} ${items.at(-1)}`;
}

// ---------------------------------------------------------------------------------------------------------
// The matcher

const compiled = new Map<string, Cron>();

/** The parsed cron, cached; SCHEDULE_INVALID when it does not parse. */
function compile(text: string): Cron {
  let c = compiled.get(text);
  if (!c) {
    const p = parseCron(text);
    if (!p.ok) throw new CroftError("SCHEDULE_INVALID", { message: p.problem, hint: p.hint });
    if (compiled.size > 1000) compiled.clear();
    compiled.set(text, (c = p.cron));
  }
  return c;
}

/** Days since 1970-01-01 of the local date at an instant. */
function localDay(ms: number, tz: string): number {
  return Math.floor((ms + offsetSeconds(ms, tz) * 1000) / DAY_MS);
}

/** Month (1-12) and day of month from days since 1970-01-01 (H. Hinnant's civil_from_days). */
function monthDay(days: number): { m: number; d: number } {
  const z = days + 719468;
  const doe = z - Math.floor(z / 146097) * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  return { m: mp < 10 ? mp + 3 : mp - 9, d: doy - Math.floor((153 * mp + 2) / 5) + 1 };
}

function dayMatches(c: Cron, day: number): boolean {
  const { m, d } = monthDay(day);
  if (!c.months[m]) return false;
  const dom = c.days[d]!;
  const dow = c.weekdays[(((day + 4) % 7) + 7) % 7]!;       // 1970-01-01 was a Thursday
  return c.anyDay || c.anyWeekday ? dom && dow : dom || dow;
}

/** The fire instants (epoch ms) of one matching local day, ascending and distinct. */
function firesOn(c: Cron, tz: string, day: number): number[] {
  const midnight = day * DAY_MS;                             // the day's 00:00 wall time, read as if UTC
  const before = offsetSeconds(midnight - DAY_MS, tz) * 1000;
  const after = offsetSeconds(midnight + 2 * DAY_MS, tz) * 1000;
  const out: number[] = [];
  if (before === after) {
    for (const h of c.hours) for (const m of c.minutes) out.push(midnight + (h * 60 + m) * MINUTE_MS - before);
    return out;
  }
  // A transition is near: each wall time is tried with both offsets. The larger offset gives the earlier instant.
  const high = Math.max(before, after);
  const low = Math.min(before, after);
  for (const h of c.hours) {
    for (const m of c.minutes) {
      const wall = midnight + (h * 60 + m) * MINUTE_MS;
      const early = wall - high;
      const late = wall - low;
      const earlyOk = offsetSeconds(early, tz) * 1000 === high;
      const lateOk = offsetSeconds(late, tz) * 1000 === low;
      if (earlyOk) {
        out.push(early);
        if (lateOk && c.interval) out.push(late);            // the repeated pass: intervals only
      } else if (lateOk) {
        out.push(late);
      } else {
        out.push(transitionBetween(early, late, tz));        // in the gap: the first minute after it
      }
    }
  }
  return distinctSorted(out);
}

/** The first whole minute in (lo, hi] whose offset differs from lo's. */
function transitionBetween(lo: number, hi: number, tz: string): number {
  const at = offsetSeconds(lo, tz);
  while (hi - lo > MINUTE_MS) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE_MS) * MINUTE_MS;
    if (offsetSeconds(mid, tz) === at) lo = mid;
    else hi = mid;
  }
  return Math.ceil(hi / MINUTE_MS) * MINUTE_MS;
}

function distinctSorted(xs: number[]): number[] {
  xs.sort((a, b) => a - b);
  return xs.filter((x, i) => i === 0 || x !== xs[i - 1]);
}

/** The first `n` fire times strictly after `after`, as instants, for `cron` read in `timeZone`. Throws
 *  SCHEDULE_INVALID for a cron that does not parse, and RangeError for an unknown zone. */
export function nextFires(cron: string, timeZone: string, after: Date, n: number): Date[] {
  const c = compile(cron);
  const from = after.getTime();
  if (!(n > 0) || !Number.isFinite(from)) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  // From the day before: its gap or repeated times can land after `after`. Once there are n fires, one more
  // day is read, which covers a repeated hour that crosses midnight.
  let last = Infinity;
  let quiet = 0;
  for (let day = localDay(from, timeZone) - 1; day <= last; day++) {
    if (!dayMatches(c, day)) {
      if (++quiet > MAX_QUIET_DAYS) break;
      continue;
    }
    quiet = 0;
    for (const t of firesOn(c, timeZone, day)) {
      if (t > from && !seen.has(t)) { seen.add(t); out.push(t); }
    }
    if (out.length >= n && last === Infinity) last = day + 1;
  }
  return out.sort((a, b) => a - b).slice(0, n).map((t) => new Date(t));
}

/** The latest fire time at or before `now`, or null when `cron` did not fire in the LOOKBACK_DAYS before it.
 *  Throws like nextFires. */
export function latestFireAtOrBefore(cron: string, timeZone: string, now: Date): Date | null {
  const c = compile(cron);
  const at = now.getTime();
  if (!Number.isFinite(at)) return null;
  const floor = at - LOOKBACK_DAYS * DAY_MS;
  let best = -Infinity;
  let stop = -Infinity;
  // From the day after (a gap time of today can land on it) back to the lookback's first day; once a fire is
  // found, one more day is read.
  for (let day = localDay(at, timeZone) + 1, end = localDay(floor, timeZone) - 1; day >= Math.max(end, stop); day--) {
    if (!dayMatches(c, day)) continue;
    for (const t of firesOn(c, timeZone, day)) if (t <= at && t >= floor && t > best) best = t;
    if (best !== -Infinity && stop === -Infinity) stop = day - 1;
  }
  return best === -Infinity ? null : new Date(best);
}
