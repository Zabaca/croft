// The eval tasks, by name: the six of DESIGN.md §10 item 9. Phase 2 had the first two (rename-column, wrong-number);
// the rest cover a new source with a schedule, last night's failure, a backfill and an API that changed a type.
import type { EvalTask } from "../harness.ts";
import { apiTypeChange } from "./api-type-change.ts";
import { backfill90d } from "./backfill-90d.ts";
import { failedLastNight } from "./failed-last-night.ts";
import { renameColumn } from "./rename-column.ts";
import { stripeHourly } from "./stripe-hourly.ts";
import { wrongNumber } from "./wrong-number.ts";

export const TASKS: readonly EvalTask[] = [renameColumn, wrongNumber, stripeHourly, failedLastNight, backfill90d, apiTypeChange];

export function taskNamed(name: string): EvalTask | undefined {
  return TASKS.find((t) => t.name === name);
}
