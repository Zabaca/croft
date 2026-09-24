// The eval tasks' self-test, without claude: each task's fixture is set up for real (croft init, the mock API, the
// ingests loaded by the real CLI), then its verifier must fail the untouched fixture and a half-done fix, and pass
// the scripted solution.
//
// Whether this croft builds SQL transforms is read from the fixture's first run: a build without transforms (phase
// 1's planner, before the phase-2 runner) skips them with a note. Then the warehouse checks can only fail, "not
// built", and the rest of the verdict is still asserted in full; any other state of a transform step fails here.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { exec, FIXTURE_SETTINGS, type EvalTask, type Fixture, PKG, setupFixture, show, type Verdict } from "../harness.ts";
import { TASKS } from "./index.ts";
import { HALF_DONE } from "./rename-column.ts";
import { SHOP_TOKEN } from "./shop.ts";
import { DISTINCT_FIX } from "./wrong-number.ts";

const SETUP_MS = 180_000;

/** Did the fixture's first run build the task's transforms? Throws on a step that is neither built nor skipped for
 *  the phase. */
function transformsBuilt(f: Fixture, task: EvalTask): boolean {
  const steps: { asset: string; status: string; reason?: string; skippedBecause?: string }[] = f.setupRun?.json?.data?.steps ?? [];
  const states = task.transforms.map((name) => {
    const s = steps.find((x) => x.asset === name);
    if (s && (s.status === "ok" || s.status === "unchanged")) return true;
    if (s && s.status === "skipped" && /next phase/.test(`${s.skippedBecause ?? ""} ${s.reason ?? ""}`)) return false;
    throw new Error(`transform ${name} was neither built nor skipped for the phase\n${show(f.setupRun!)}`);
  });
  if (new Set(states).size > 1) throw new Error(`some transforms were built and some not\n${show(f.setupRun!)}`);
  return states[0] ?? false;
}

/** Per task, a plausible half-done or wrong fix, and what its failing code check must say. */
const WRONG_FIXES: Record<string, { files: Record<string, string>; codeOk: boolean[]; detail: RegExp }> = {
  // Renamed in orders_clean only: customer_revenue's SQL still reads cust.
  "rename-column": { files: HALF_DONE, codeOk: [true, false], detail: /cust/ },
  // sum(DISTINCT total_cents): wrong on the day two paid orders have the same total.
  "wrong-number": { files: { "assets/daily_revenue.sql": DISTINCT_FIX }, codeOk: [false], detail: /2026-09-17/ },
};

const failing = (v: Verdict, kind?: string) => v.checks.filter((c) => !c.ok && (kind === undefined || c.kind === kind));
const kinds = (v: Verdict, ok: boolean) => [...new Set(v.checks.filter((c) => c.ok === ok).map((c) => c.kind))].sort();
const explain = (v: Verdict) => v.checks.map((c) => `${c.ok ? "ok  " : "FAIL"} [${c.kind}] ${c.name}: ${c.detail}`).join("\n");

describe.each(TASKS.map((t) => [t.name, t] as const))("task %s", (_name, task) => {
  let f: Fixture;
  let built = false;

  beforeAll(async () => {
    f = await setupFixture(task);
    built = transformsBuilt(f, task);
  }, SETUP_MS);
  afterAll(() => f?.close());

  test("the fixture: settings, the linked package, the croft shim on PATH, the secret, loaded ingests and a clean git baseline", async () => {
    expect(JSON.parse(f.read(".claude/settings.json"))).toEqual(FIXTURE_SETTINGS);
    expect(lstatSync(join(f.root, "node_modules", "@zabaca", "croft")).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(f.root, "node_modules", "@zabaca", "croft"))).toBe(realpathSync(PKG));
    expect(f.exists("assets/example_sales.ts")).toBe(false);
    expect(readFileSync(f.path(".env"), "utf8")).toContain(`SHOP_TOKEN=${SHOP_TOKEN}`);
    // The shim, found through PATH the way the agent's shell finds it.
    const viaPath = await exec(["/bin/sh", "-c", "croft status --json"], { cwd: f.root, env: f.env });
    expect(viaPath.code, viaPath.stdout + viaPath.stderr).toBe(0);
    expect(JSON.parse(viaPath.stdout)).toMatchObject({ ok: true, command: "status" });
    // node_modules/.bin/croft, as bun install links it (what `bunx croft` runs).
    const local = await exec(["./node_modules/.bin/croft", "version", "--json"], { cwd: f.root, env: f.env });
    expect(local.code, local.stdout + local.stderr).toBe(0);
    expect(realpathSync(f.path("node_modules/.bin/croft"))).toBe(realpathSync(join(PKG, "bin", "croft.mjs")));
    const shipped = f.setupRun?.json?.data?.steps?.filter((s: { asset: string; status: string }) => s.asset.startsWith("shop_") && s.status === "ok");
    expect(shipped?.map((s: { asset: string }) => s.asset).sort()).toEqual(["shop_order_items", "shop_orders"]);
    expect(f.api.log.filter((r) => r.path.startsWith("/v1/")).length).toBeGreaterThanOrEqual(2);
    expect([...f.originals.keys()]).toEqual(expect.arrayContaining(["assets/shop_orders.ts", "assets/shop_order_items.ts", ...task.transforms.map((t) => `assets/${t}.sql`)]));
    if (f.git) {
      const status = await exec(["git", "status", "--porcelain"], { cwd: f.root, env: f.env });
      expect(status.stdout).toBe("");
      expect(await f.diff()).toBe("");
    }
  }, SETUP_MS);

  test("the verifier fails the untouched fixture: the tables and the SQL are wrong, the raw data is fine", async () => {
    const v = await task.verify(f);
    expect(v.pass, explain(v)).toBe(false);
    expect(kinds(v, false), explain(v)).toEqual(["code", "warehouse"]);
    for (const c of failing(v, "warehouse")) expect(c.detail.length).toBeGreaterThan(0);
  }, SETUP_MS);

  test("the verifier fails a plausible wrong fix on its code checks", async () => {
    const wrong = WRONG_FIXES[task.name];
    expect(wrong, `no wrong fix listed for ${task.name}`).toBeDefined();
    for (const [rel, text] of Object.entries(wrong!.files)) f.write(rel, text);
    const v = await task.verify(f);
    const code = v.checks.filter((c) => c.kind === "code");
    expect(code.map((c) => c.ok), explain(v)).toEqual(wrong!.codeOk);
    expect(code.filter((c) => !c.ok).map((c) => c.detail).join("\n"), explain(v)).toMatch(wrong!.detail);
    expect([...failing(v, "data"), ...failing(v, "files")], explain(v)).toEqual([]);
  }, SETUP_MS);

  test("the verifier passes the scripted solution", async () => {
    const run = await task.solve(f);
    expect(run.code, show(run)).toBe(0);
    const v = await task.verify(f);
    if (built) {
      expect(v.pass, explain(v)).toBe(true);
    } else {
      // This croft does not build transforms yet: only "the table is not built" may fail.
      expect(kinds(v, false), explain(v)).toEqual(["warehouse"]);
      for (const c of failing(v)) expect(c.detail, explain(v)).toMatch(/does not exist|not found|UNKNOWN_TABLE/i);
    }
    if (f.git) expect(await f.diff()).toContain(`assets/${task.transforms[0]}.sql`);
  }, SETUP_MS);
});
