// Schedules (DESIGN.md §8 "Writing a schedule"): what an ingest's `schedule:` says, and when it fires.
//
// A phrase ("every hour", "weekdays at 9am", a 5-field cron) parses to a normalized 5-field cron
// (schedule/phrase.ts). Fire times come from croft's own time-zone-aware matcher (schedule/cron.ts: Intl, never
// Bun.cron) and are instants, so DST neither drops nor doubles them:
// - a local time that does not exist (02:30 on a spring-forward day) fires at the first valid minute after
//   the gap;
// - a repeated local time (01:30 on a fall-back day) fires once, at its first occurrence. An interval (a cron
//   whose minute or hour field starts with `*`: "every 15 minutes", "every hour") keeps firing in real time
//   through the repeated hour instead, so its fires stay evenly spaced.
//
// This module is the contract other modules import; the implementations live in phrase.ts and cron.ts.

/** A parsed schedule: the text as written and its 5-field cron (minute hour day-of-month month day-of-week). */
export interface Schedule {
  text: string;
  cron: string;
}

export type ParsedSchedule =
  | { ok: true; schedule: Schedule }
  /** `problem` is the message of a SCHEDULE_INVALID and `hint` its hint; `suggestion` a schedule that parses,
   *  when one is close (the hint then asks "did you mean …?"). */
  | { ok: false; problem: string; hint: string; suggestion?: string };

/** Parse an ingest's `schedule:` text. Never throws. */
export { parseSchedule } from "./phrase.ts";

/** nextFires(cron, timeZone, after, n): the first `n` fire times strictly after `after`, as instants, for
 *  `cron` read in `timeZone`.
 *  latestFireAtOrBefore(cron, timeZone, now): the latest fire time at or before `now`, or null when `cron`
 *  did not fire in the 400 days before it. The tick compares it with last_fire_at: a later one is a fire not
 *  yet handled.
 *  Both throw SCHEDULE_INVALID for a cron that does not parse. */
export { latestFireAtOrBefore, LOOKBACK_DAYS, nextFires } from "./cron.ts";
