// What is due (DESIGN.md §8 "What counts as due"): ingests whose schedule fired since last_fire_at, plus their
// stale downstream, plus any stale transform; minus what is held (SCHEDULE_HELD, LARGE_REPROCESS, paused,
// leased). Computed from runs.sqlite (schedule_state, the catalog mirror, leases) without importing asset code
// when nothing changed. Phase 3 contract stub: TK builds it; SC shows it (status, schedule status, doctor).
import { phaseStub } from "../core/phase.ts";
import type { Schedule } from "./types.ts";

export type HoldCode = "SCHEDULE_HELD" | "LARGE_REPROCESS" | "paused" | "leased" | "backoff";

/** One asset as the scheduler sees it. Instants are ISO-8601 UTC. */
export interface AssetScheduleView {
  asset: string;
  kind: "ingest" | "sql" | "ts";
  /** Ingests with a schedule. */
  schedule: Schedule | null;
  /** The next fire after now (ingests with a schedule). */
  nextFireAt: string | null;
  lastFireAt: string | null;
  lastAttemptAt: string | null;
  /** Due now: a fire not yet handled, or a stale transform. */
  due: boolean;
  /** Why it is due, in words ("fired at 11:00", "stale: input issues changed"). */
  dueReason: string | null;
  /** Why the scheduler will not run it now, or null. */
  held: { code: HoldCode; reason: string } | null;
}

export interface ScheduleViewInput {
  root: string;
  now: Date;
}

/** Every asset as the scheduler sees it now. Read-only. */
export async function scheduleView(i: ScheduleViewInput): Promise<AssetScheduleView[]> {
  return phaseStub(`scheduleView(${i.root})`);
}
