// croft wait <run-id> [--timeout 100s] (DESIGN.md §4.1, §4.3 run/wait shapes, §8 "Large first loads").
// Blocks until a run ends and prints its result exactly as `croft run` would have (exit 0, or the run's own
// failure exit), or exits 6 while it is still running. It reads runs.sqlite and the run's events only, so it
// never waits on the database. A run whose process died is marked crashed. Spec in commands/index.ts.
import { CroftError, isCode } from "../../core/errors.ts";
import { isRunId, RunsDb } from "../../history/runs-db.ts";
import { DEFAULT_FOLLOW_MS, detachedRunExists, followRun, parseWait, unknownRun } from "../../run/detach.ts";
import type { RunData } from "../../run/runner.ts";
import type { CommandImpl } from "../command.ts";
import { formatRun, toResult } from "./run.ts";

export const wait: CommandImpl<RunData> = {
  async run(ctx) {
    const runId = ctx.positionals[0];
    if (runId === undefined) {
      throw new CroftError("USAGE_ERROR", {
        message: "croft wait needs a run id", hint: "usage: croft wait <run-id> [--timeout 100s]; croft run prints the id",
        fix: { kind: "command", description: "list recent runs", command: "croft logs --runs" },
      });
    }
    if (!isRunId(runId)) throw unknownRun(runId);
    const timeout = ctx.values.timeout;
    const timeoutMs = typeof timeout === "string" ? parseWait(timeout, "--timeout") : DEFAULT_FOLLOW_MS;
    const stateDir = ctx.project.paths.stateDir;
    const db = RunsDb.open(stateDir);
    let known: boolean;
    try {
      known = db.getRun(runId) !== null;
    } finally {
      db.close();
    }
    // A detached child that has not recorded its run yet still has its process log and spawn handshake; one that
    // died before recording it is reported crashed by followRun, not "running" forever.
    if (!known && !detachedRunExists(stateDir, runId)) throw unknownRun(runId);
    const res = await followRun({
      stateDir, runId, timeoutMs,
      ...(ctx.values.events === true ? { onEvent: (line: string) => ctx.render.progress(line) } : {}),
    });
    if (res.kind === "not_started") {
      const { severity: _s, docs: _d, code, ...init } = res.problem;
      throw new CroftError(isCode(code) ? code : "INTERNAL_ERROR", init);
    }
    return toResult(res.summary);
  },
  human(result, ctx) {
    return formatRun(result.data, ctx);
  },
};
