// Journey 12: `croft doctor --json` (DESIGN §2): environment plus project summary, quick, and no writes.
import { afterAll, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { stripeAsset } from "./fixtures.ts";
import { bugTest, cleanupAll, croftIn, initProject, type Project, show, tempDir } from "./harness.ts";

afterAll(cleanupAll);

let withMissingSecret: Project | undefined;

function listing(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).filter((f) => !f.startsWith("node_modules")).sort();
}

test("journey 12: doctor --json on a fresh project, after a run, and outside any project", async () => {
  const { project: p } = await initProject();

  // A fresh project: doctor writes nothing (no warehouse, no runs.sqlite).
  const before = listing(p.root);
  const fresh = await p.json(["doctor"]);
  expect(fresh.code, show(fresh)).toBe(0);
  expect(listing(p.root)).toEqual(before);
  expect(p.exists("warehouse.duckdb")).toBe(false);
  expect(fresh.json).toMatchObject({ schemaVersion: 1, ok: true, command: "doctor" });
  const ids = fresh.json.data.checks.map((c: { id: string }) => c.id);
  expect(ids).toEqual(expect.arrayContaining(["bun", "croft", "duckdb", "warehouse", "config", "storage", "writable", "env", "claude"]));
  for (const c of fresh.json.data.checks) {
    expect(["environment", "project", "scheduling"]).toContain(c.section);
    expect(["ok", "info", "warn", "error"]).toContain(c.status);
    expect(typeof c.text).toBe("string");
  }
  expect(fresh.json.data.summary.errors).toBe(0);
  expect(fresh.json.data.project).toMatchObject({ root: p.root, relocated: false });

  // After a run: the warehouse is described (size, not held, formats), still with no errors.
  const run = await p.json(["run", "example_sales"]);
  expect(run.code, show(run)).toBe(0);
  const after = await p.json(["doctor"]);
  expect(after.code, show(after)).toBe(0);
  const wh = after.json.data.checks.find((c: { id: string }) => c.id === "warehouse");
  expect(wh.status, JSON.stringify(wh)).toBe("ok");
  expect(wh.details).toMatchObject({ exists: true, writable: true, heldBy: null });
  expect(wh.details.meta.format_version).toBe("2");
  expect(after.json.data.summary).toMatchObject({ errors: 0, warnings: 0 });
  expect(after.json.durationMs).toBeLessThan(3000); // §4.1: "under 1 s" (loose bound for loaded CI machines)
  // Human output: sections, one line per check.
  const human = await p.croft(["doctor"]);
  expect(human.code).toBe(0);
  expect(human.stdout).toContain("Environment");
  expect(human.stdout).toContain("Project");

  // Outside a project, doctor still runs (the launcher's own copy) and says there is no project.
  const outside = await croftIn(tempDir(), ["doctor", "--json"]);
  expect(outside.json, show(outside)).toBeDefined();
  expect(outside.code, show(outside)).not.toBe(2);
  expect(outside.json!.data.checks.some((c: { id: string }) => c.id === "bun")).toBe(true);

  // Set up the next test: an asset that declares a secret .env does not have.
  p.write("assets/stripe_charges.ts", stripeAsset("http://127.0.0.1:9"));
  withMissingSecret = p;
}, 120_000);

// BUG (reported): DESIGN §2's install-time table and its sample output have doctor report a declared secret that
// is missing ("warn SECRET_MISSING STRIPE_KEY (used by stripe_charges)", with the .env fix). doctor has no such
// check yet, although `croft secrets` already finds declared secrets. Flip to test() once fixed.
bugTest("journey 12b: doctor warns SECRET_MISSING for a declared secret that is not set", async () => {
  expect(withMissingSecret).toBeDefined();
  const r = await withMissingSecret!.json(["doctor"]);
  expect(r.code, show(r)).toBe(0);
  const missing = r.json.problems.find((x: { code: string }) => x.code === "SECRET_MISSING");
  expect(missing, show(r)).toBeDefined();
  expect(missing.severity).toBe("warning");
  expect(`${missing.hint} ${missing.fix?.description ?? ""}`).toContain(".env");
}, 60_000);
