// Journey 4: a replace ingest whose API starts returning [] (an expired token, say).
// - `croft run` → SHRINK_GUARD, exit 1, nothing changed;
// - `croft run --allow-shrink` off a TTY → exit 5 with a confirmation token (never in next[]);
// - `croft confirm <token>` empties the table, and the old rows are in a trash file.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAll, findProblem, initProject, json, type MockApi, mockApi, type Project, show } from "./harness.ts";

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

// Tokens are single-use (§6): `croft confirm <spent token>` is refused up front with CONFIRMATION_STALE,
// without running the stored command again (which, with the table already empty, would fetch and write).
test("journey 4b: a spent confirmation token is refused without running anything", async () => {
  expect(spent).toBeDefined();
  const { p, token } = spent!;
  const before = api.requests("/zones").length;
  const again = await p.json(["confirm", token]);
  expect(again.code, show(again)).not.toBe(0);
  expect(again.json.problems.map((x: { code: string }) => x.code)).toContain("CONFIRMATION_STALE");
  expect(api.requests("/zones").length).toBe(before);
}, 60_000);

/** A project whose replace ingest `taxi_zones` (from `path`) loaded `rows` rows and now gets [] back, with a
 *  pending --allow-shrink confirmation. */
async function pendingShrink(path: string, rows: number): Promise<{ p: Project; token: string; set: (z: Record<string, unknown>[]) => void }> {
  let zones: Record<string, unknown>[] = Array.from({ length: rows }, (_, i) => ({ LocationID: i + 1, v: 1 }));
  api.route(path, () => json(zones));
  const { project: p } = await initProject();
  p.write("assets/taxi_zones.ts", zonesAsset(`${api.url}${path.replace(/\/zones$/, "")}`));
  const ok = await p.json(["run", "taxi_zones"]);
  expect(ok.code, show(ok)).toBe(0);
  zones = [];
  const asked = await p.json(["run", "taxi_zones", "--allow-shrink"]);
  expect(asked.code, show(asked)).toBe(5);
  return { p, token: asked.json.confirmation.token as string, set: (z) => { zones = z; } };
}

// §6: a destructive action runs only through `croft confirm <token>`, the one prefix the Claude Code "ask" rule
// gates. `croft run` takes no token: not as a flag, and not from the environment variable croft uses internally.
test("journey 4c: croft run cannot carry out a confirmation; only croft confirm can", async () => {
  const { p, token } = await pendingShrink("/c/zones", 5);
  const count = async () => (await p.rows("select count(*) n from taxi_zones"))[0]!.n;

  for (const flag of [["--confirm-token", token], [`--confirm-token=${token}`]]) {
    const r = await p.json(["run", "taxi_zones", "--allow-shrink", ...flag]);
    expect(r.code, show(r)).toBe(2);
    expect(findProblem(r.json, "USAGE_ERROR")?.message ?? "", show(r)).toContain("has no option --confirm-token");
    expect(await count()).toBe(5);
  }
  const help = await p.croft(["help", "run"]);
  expect(help.stdout).not.toContain("confirm-token");

  // The variable that hands a detached confirmed run its grant does nothing when typed in, even for a
  // hand-made "detached child".
  const env = { CROFT_CONFIRM_GRANT: token };
  const viaEnv = await p.json(["run", "taxi_zones", "--allow-shrink", "--foreground"], { env });
  expect(viaEnv.code, show(viaEnv)).toBe(5);
  expect(viaEnv.json.confirmation.token).not.toBe(token);
  const child = await p.json(["run", "taxi_zones", "--allow-shrink", "--run-id", "r_0101_0000_abcd", "--detached"], { env });
  expect(child.code, show(child)).toBe(2);
  expect(findProblem(child.json, "USAGE_ERROR")?.message ?? "", show(child)).toContain("no confirmation grant");
  expect(await count()).toBe(5);

  // croft confirm still carries it out (human output: the run's own lines).
  const done = await p.croft(["confirm", token]);
  expect(done.code, show(done)).toBe(0);
  expect(done.stdout, show(done)).toMatch(/ok\s+taxi_zones/);
  expect(done.stdout).toContain("previous 5 rows in the trash");
  expect(await count()).toBe(0);
}, 120_000);

// When the confirmed command no longer needs confirmation (the source recovered), confirm returns the
// command's own result plus a note, never INTERNAL_ERROR; the token is spent, so it cannot run again.
test("journey 4d: confirm after the source recovered runs a normal run, says so, and spends the token", async () => {
  const { p, token, set } = await pendingShrink("/d/zones", 4);
  set(Array.from({ length: 4 }, (_, i) => ({ LocationID: i + 1, v: 2 })));
  const r = await p.json(["confirm", token]);
  expect(r.code, show(r)).toBe(0);
  expect(r.json.ok).toBe(true);
  expect(r.json.problems.map((x: { code: string }) => x.code)).not.toContain("INTERNAL_ERROR");
  expect(r.json.data).toMatchObject({ token, command: "croft run taxi_zones --allow-shrink", outcome: "not_needed" });
  expect(r.json.data.note).toContain("did not need");
  expect(r.json.data.result.steps[0]).toMatchObject({ asset: "taxi_zones", status: "ok", rows: { total: 4, updated: 4 } });
  expect(r.json.data.result.steps[0].trashed).toBeUndefined();
  expect(await p.rows("select distinct v from taxi_zones")).toEqual([{ v: 2 }]);

  const before = api.requests("/d/zones").length;
  const again = await p.json(["confirm", token]);
  expect(again.code, show(again)).toBe(5);
  expect(findProblem(again.json, "CONFIRMATION_STALE")?.details).toMatchObject({ reason: "used" });
  expect(api.requests("/d/zones").length).toBe(before);
}, 120_000);
