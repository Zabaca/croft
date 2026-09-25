// The eval tasks' self-test, without claude: each task's fixture is set up for real (croft init, the mock API, the
// ingests loaded by the real CLI, the task's `after` step), then its verifier must fail the untouched fixture, fail
// each plausible wrong solution on exactly the checks that solution gets wrong, and pass the scripted solution.
//
// Each task module exports its SelfTest (verify.ts): the secret its fixture writes, what the first run built, the
// kinds of check the untouched fixture fails, the wrong solutions (applied in order to one fixture, each with the
// session it is verified with), the session a good agent would have had, and the files its solution's diff touches.
// The tasks run concurrently, one test each: every step waits on croft processes, and each task has its own
// fixture and mock API.
import { describe, expect, test } from "bun:test";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { type EvalTask, exec, FIXTURE_SETTINGS, type Fixture, PKG, setupFixture, show, type Verdict } from "../harness.ts";
import type { SelfTest } from "../verify.ts";
import { selfTest as apiTypeChange } from "./api-type-change.ts";
import { selfTest as backfill90d } from "./backfill-90d.ts";
import { selfTest as failedLastNight } from "./failed-last-night.ts";
import { TASKS } from "./index.ts";
import { selfTest as renameColumn } from "./rename-column.ts";
import { selfTest as stripeHourly } from "./stripe-hourly.ts";
import { selfTest as wrongNumber } from "./wrong-number.ts";

const TASK_MS = 600_000;

const SELF_TESTS: Record<string, SelfTest> = {
  "rename-column": renameColumn,
  "wrong-number": wrongNumber,
  "stripe-hourly": stripeHourly,
  "failed-last-night": failedLastNight,
  "backfill-90d": backfill90d,
  "api-type-change": apiTypeChange,
};

const failing = (v: Verdict) => v.checks.filter((c) => !c.ok);
const kinds = (v: Verdict, ok: boolean) => [...new Set(v.checks.filter((c) => c.ok === ok).map((c) => c.kind))].sort();
const explain = (v: Verdict) => v.checks.map((c) => `${c.ok ? "ok  " : "FAIL"} [${c.kind}] ${c.name}: ${c.detail}`).join("\n");

/** The fixture: settings, the linked package, the croft shim on PATH, the secret, what the first run built, and a
 *  clean git baseline. */
async function fixtureIsReady(f: Fixture, spec: SelfTest): Promise<void> {
  expect(JSON.parse(f.read(".claude/settings.json"))).toEqual(FIXTURE_SETTINGS);
  expect(lstatSync(join(f.root, "node_modules", "@zabaca", "croft")).isSymbolicLink()).toBe(true);
  expect(realpathSync(join(f.root, "node_modules", "@zabaca", "croft"))).toBe(realpathSync(PKG));
  expect(f.exists("assets/example_sales.ts")).toBe(false);
  expect(readFileSync(f.path(".env"), "utf8")).toContain(`${spec.secret.name}=${spec.secret.value}`);
  // The shim, found through PATH the way the agent's shell finds it.
  const viaPath = await exec(["/bin/sh", "-c", "croft status --json"], { cwd: f.root, env: f.env });
  expect(viaPath.code, viaPath.stdout + viaPath.stderr).toBe(0);
  expect(JSON.parse(viaPath.stdout)).toMatchObject({ ok: true, command: "status" });
  // node_modules/.bin/croft, as bun install links it (what `bunx croft` runs).
  const local = await exec(["./node_modules/.bin/croft", "version", "--json"], { cwd: f.root, env: f.env });
  expect(local.code, local.stdout + local.stderr).toBe(0);
  expect(realpathSync(f.path("node_modules/.bin/croft"))).toBe(realpathSync(join(PKG, "bin", "croft.mjs")));
  // The first run built what the task starts from (a failure the task needs comes after it, in `after`).
  const steps: { asset: string; status: string }[] = f.setupRun?.json?.data?.steps ?? [];
  expect(steps.filter((s) => s.status === "ok").map((s) => s.asset).sort(), show(f.setupRun!)).toEqual([...spec.built].sort());
  if (spec.built.length > 0) expect(f.api.log.length).toBeGreaterThan(0);
  for (const name of spec.built) expect([...f.originals.keys()].some((rel) => rel === `assets/${name}.ts` || rel === `assets/${name}.sql`), name).toBe(true);
  expect(f.clock).toBeNull();
  if (f.git) {
    const status = await exec(["git", "status", "--porcelain"], { cwd: f.root, env: f.env });
    expect(status.stdout).toBe("");
    expect(await f.diff()).toBe("");
  }
}

async function selfTest(task: EvalTask, spec: SelfTest): Promise<void> {
  const f = await setupFixture(task);
  try {
    await fixtureIsReady(f, spec);

    // The untouched fixture fails, with no session to go by.
    let v = await task.verify(f, null);
    expect(v.pass, explain(v)).toBe(false);
    expect(kinds(v, false), `untouched:\n${explain(v)}`).toEqual([...spec.untouched].sort());
    for (const c of failing(v)) expect(c.detail.length).toBeGreaterThan(0);

    // Each plausible wrong solution fails exactly the checks it gets wrong.
    expect(spec.wrong.length).toBeGreaterThan(0);
    for (const w of spec.wrong) {
      const g = w.fresh ? await setupFixture(task) : f;
      try {
        await w.apply(g);
        v = await task.verify(g, w.session ?? spec.session);
        const why = `wrong solution "${w.what}":\n${explain(v)}`;
        expect(failing(v).map((c) => c.name).sort(), why).toEqual([...w.fails].sort());
        expect(failing(v).map((c) => c.detail).join("\n"), why).toMatch(w.detail);
      } finally {
        if (g !== f) g.close();
      }
    }

    // The scripted solution passes, from the fixture's own files: a wrong solution's edits are not the solution's
    // (its runs' effects stay, and the solution copes with them as an agent that tried something first would).
    for (const [rel, text] of f.originals) f.write(rel, text);
    const run = await task.solve(f);
    expect(run.code, show(run)).toBe(0);
    v = await task.verify(f, spec.session);
    expect(v.pass, `the scripted solution:\n${explain(v)}`).toBe(true);
    if (f.git) {
      const diff = await f.diff();
      if (spec.diff.length === 0) expect(diff).toBe("");
      for (const rel of spec.diff) expect(diff).toContain(rel);
    }
  } finally {
    f.close();
  }
}

describe("the eval tasks' verifiers", () => {
  test("every task has a self-test", () => {
    expect(TASKS.map((t) => t.name).sort()).toEqual(Object.keys(SELF_TESTS).sort());
  });

  for (const task of TASKS) {
    test.concurrent(`${task.name}: the fixture is ready; the verifier fails the untouched fixture and each plausible wrong solution, and passes the scripted one`, () => selfTest(task, SELF_TESTS[task.name]!), TASK_MS);
  }
});
