// Journey 4: a replace ingest whose API starts returning [] (an expired token, say).
// - `croft run` → SHRINK_GUARD, exit 1, nothing changed;
// - `croft run --allow-shrink` off a TTY → exit 5 with a confirmation token (never in next[]);
// - `croft confirm <token>` empties the table, and the old rows are in a trash file.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bugTest, cleanupAll, findProblem, initProject, json, type MockApi, mockApi, type Project, show } from "./harness.ts";

let api: MockApi;
let spent: { p: Project; token: string } | undefined;
beforeAll(() => {
  api = mockApi();
});
afterAll(async () => {
  api.stop();
  await cleanupAll();
});

const zonesAsset = (base: string) => `import { ingest } from "@zabaca/croft";

export default ingest({
  description: "Taxi zones from the zones API",
  key: "LocationID",
  async *rows({ http }) {
    const res = await http.get("${base}/zones");
    yield res.json<Record<string, unknown>[]>();
  },
});
`;

test("journey 4: SHRINK_GUARD → --allow-shrink gives a token (exit 5) → croft confirm empties the table into the trash", async () => {
  let zones: Record<string, unknown>[] = Array.from({ length: 6 }, (_, i) => ({ LocationID: i + 1, Borough: i % 2 ? "Queens" : "Bronx", Zone: `Zone ${i + 1}` }));
  api.route("/zones", () => json(zones));
  const { project: p } = await initProject();
  p.write("assets/taxi_zones.ts", zonesAsset(api.url));

  const ok = await p.json(["run", "taxi_zones"]);
  expect(ok.code, show(ok)).toBe(0);
  expect(ok.json.data.steps[0].rows).toMatchObject({ added: 6, total: 6 });

  // The API now answers [].
  zones = [];
  const guarded = await p.json(["run", "taxi_zones"]);
  expect(guarded.code, show(guarded)).toBe(1);
  expect(guarded.json.ok).toBe(false);
  const g = findProblem(guarded.json, "SHRINK_GUARD");
  expect(g, show(guarded)).toBeDefined();
  expect(g!.fix).toMatchObject({ kind: "manual", requiresHuman: true });
  // Not retried: a shrink is not a transient failure.
  expect(guarded.json.data.steps[0].attempt).toBe(1);
  expect((await p.rows("select count(*) n from taxi_zones"))[0]!.n).toBe(6);

  // --allow-shrink off a TTY: exit 5 and a confirmation; nothing destructive in next[].
  const asked = await p.json(["run", "taxi_zones", "--allow-shrink"]);
  expect(asked.code, show(asked)).toBe(5);
  expect(asked.json.ok).toBe(false);
  const c = asked.json.confirmation;
  expect(c, show(asked)).toBeDefined();
  expect(c.token).toMatch(/^c_[0-9a-f]{6}$/);
  expect(c.command).toBe("croft run taxi_zones --allow-shrink");
  expect(c.impact).toMatchObject({ asset: "taxi_zones", rows: 6 });
  expect(typeof c.expiresAt).toBe("string");
  expect(Date.parse(c.expiresAt) - Date.now()).toBeGreaterThan(10 * 60_000);
  expect(asked.json.next.some((n: { command: string }) => /confirm|allow-shrink/.test(n.command))).toBe(false);
  expect(findProblem(asked.json, "CONFIRMATION_REQUIRED")?.hint ?? "").toContain(`croft confirm ${c.token}`);
  expect((await p.rows("select count(*) n from taxi_zones"))[0]!.n).toBe(6);

  // croft confirm: the table goes to the trash first, then the replace writes 0 rows.
  const done = await p.json(["confirm", c.token]);
  expect(done.code, show(done)).toBe(0);
  expect(done.json).toMatchObject({ ok: true, command: "confirm", data: { token: c.token, command: "croft run taxi_zones --allow-shrink" } });
  const step = done.json.data.result.steps[0];
  expect(step).toMatchObject({ asset: "taxi_zones", status: "ok", trashed: { rows: 6 }, rows: { total: 0, deleted: 6 } });
  expect((await p.rows("select count(*) n from taxi_zones"))[0]!.n).toBe(0);
  const trash = readdirSync(join(p.stateDir, "trash", "taxi_zones")).filter((f) => f.endsWith(".duckdb"));
  expect(trash).toHaveLength(1);
  expect(String(step.trashed.path)).toContain(join("trash", "taxi_zones"));
  const sidecar = readdirSync(join(p.stateDir, "trash", "taxi_zones")).find((f) => f.endsWith(".json"));
  expect(sidecar).toBeDefined();
  expect(JSON.parse(readFileSync(join(p.stateDir, "trash", "taxi_zones", sidecar!), "utf8"))).toMatchObject({ rows: 6 });

  spent = { p, token: c.token };

  // status / logs still describe the table sensibly after the shrink.
  const st = await p.json(["status"]);
  expect(st.json.data.assets.find((a: { asset: string }) => a.asset === "taxi_zones")).toMatchObject({ rows: 0, status: "ok" });
}, 120_000);

// BUG (reported): tokens are single-use (§6), but `croft confirm <spent token>` re-runs the stored command.
// When the guard no longer trips (the table is already empty) the run fetches and writes again and confirm
// exits 0, instead of refusing the spent token up front with CONFIRMATION_STALE. Flip to test() once fixed.
bugTest("journey 4b: a spent confirmation token is refused without running anything", async () => {
  expect(spent).toBeDefined();
  const { p, token } = spent!;
  const before = api.requests("/zones").length;
  const again = await p.json(["confirm", token]);
  expect(again.code, show(again)).not.toBe(0);
  expect(again.json.problems.map((x: { code: string }) => x.code)).toContain("CONFIRMATION_STALE");
  expect(api.requests("/zones").length).toBe(before);
}, 60_000);
