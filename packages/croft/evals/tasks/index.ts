// The eval tasks, by name. Phase 2 has two; DESIGN.md §10 item 9 lists the rest (add Stripe charges and a
// schedule, fix last night's failure, backfill 90 days, an API that changed a field type) for later phases.
import type { EvalTask } from "../harness.ts";
import { renameColumn } from "./rename-column.ts";
import { wrongNumber } from "./wrong-number.ts";

export const TASKS: readonly EvalTask[] = [renameColumn, wrongNumber];

export function taskNamed(name: string): EvalTask | undefined {
  return TASKS.find((t) => t.name === name);
}
