// croft tick (hidden; DESIGN.md §8 "Each tick only plans and spawns", §5 "Server mode"): one scheduler tick for the
// project in the current folder, run every minute by the per-user OS job (~/.croft/tick.ts) and by croft serve's
// loop. It exits at once unless scheduling is on, starts one detached `croft run --due` per group of due assets,
// and exits (schedule/tick.ts). Its output goes to tick.log: one line, or with --json the TickResult
// (schedule/os.ts). Spec in commands/index.ts.
import type { TickResult } from "../../schedule/os.ts";
import { projectTick } from "../../schedule/tick.ts";
import type { CommandImpl } from "../command.ts";

export const tick: CommandImpl<TickResult> = {
  async run(ctx) {
    const out = await projectTick({ project: ctx.project, env: ctx.processEnv, now: ctx.now() });
    return { data: out.result, problems: out.problems, next: [] };
  },
  human(result) {
    return formatTick(result.data);
  },
};

const EXITED: Record<NonNullable<TickResult["exited"]>, string> = {
  scheduling_off: "scheduling is off for this project",
  paused: "scheduling is paused for this project",
  another_tick: "another tick of this project is running",
};

/** One line for tick.log, then one per held asset. */
export function formatTick(d: TickResult): string {
  if (d.exited) return `tick: nothing to do: ${EXITED[d.exited]}`;
  const started = d.spawned.length
    ? d.spawned.map((s) => `started ${s.runId} (${s.assets.join(", ")})`).join("; ")
    : "nothing due";
  const lines = [`tick: ${started}${d.importedAssetCode ? " · read changed asset files" : ""} (${d.tookMs} ms)`];
  for (const h of d.held) lines.push(`  held ${h.asset} (${h.code}): ${h.reason}`);
  return lines.join("\n");
}
