// Schedules (DESIGN.md §8 "Writing a schedule"): what an ingest's `schedule:` says, and when it fires.
//
// A phrase ("every hour", "weekdays at 9am", a 5-field cron) parses to a normalized 5-field cron. Fire times
// come from croft's own time-zone-aware matcher (Intl, never Bun.cron) and are instants, so DST neither drops
// nor doubles them:
// - a local time that does not exist (02:30 on a spring-forward day) fires at the first valid minute after
//   the gap;
// - a repeated local time (01:30 on a fall-back day) fires once, at its first occurrence.
import { phaseStub } from "../core/phase.ts";

/** A parsed schedule: the text as written and its 5-field cron (minute hour day-of-month month day-of-week). */
export interface Schedule {
  text: string;
  cron: string;
}

export type ParsedSchedule =
  | { ok: true; schedule: Schedule }
  /** `problem` is the message of a SCHEDULE_INVALID; `suggestion` a phrase that parses, when one is close. */
  | { ok: false; problem: string; suggestion?: string };

/** Parse an ingest's `schedule:` text. Never throws. */
export function parseSchedule(text: string): ParsedSchedule {
  return phaseStub(`parseSchedule(${JSON.stringify(text)})`);
}

/** The first `n` fire times strictly after `after`, as instants, for `cron` read in `timeZone`. */
export function nextFires(cron: string, timeZone: string, after: Date, n: number): Date[] {
  return phaseStub(`nextFires(${cron}, ${timeZone}, ${after.toISOString()}, ${n})`);
}

/** The latest fire time at or before `now`, or null when `cron` never fired before `now` (it looks back at most
 *  400 days). The tick compares it with last_fire_at: a later one is a fire not yet handled. */
export function latestFireAtOrBefore(cron: string, timeZone: string, now: Date): Date | null {
  return phaseStub(`latestFireAtOrBefore(${cron}, ${timeZone}, ${now.toISOString()})`);
}
