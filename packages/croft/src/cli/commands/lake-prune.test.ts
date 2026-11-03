// The first step of a lake's pass removes the rows of croft's bookkeeping log that a newer row has superseded (db/lake-maintenance.ts
// pruneBookkeeping; DESIGN.md D154; option 07, slice 1 left this to slice 3), on a local lake and on a Postgres lake with the store. The log
// only grows: a row for each asset's state on every run. What a person reads, the views `_croft.<t>`, must be the same before and after, the
// log must be one row per live key after, and everything that writes the bookkeeping afterwards (a run, a delete and its restore from the trash,
// a rename) must go on from the right numbers, because the numbers (`seq`) are what orders a key's rows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { lakeRigReady, type LakeRig, startLakeRig } from "../../db/lake-testkit.ts";
import { closeAllWarehouses } from "../../db/warehouse.ts";
import { cleanup, cli } from "./inspect-testkit.ts";
import { lakeProject, type LakeProject, ORDERS_SQL } from "./lake-project-testkit.ts";

const ready = lakeRigReady();
if (!ready.ready) console.warn(`[lake-prune.test] SKIPPING: ${ready.skipReason}`);

let rig: LakeRig;
beforeAll(async () => {
  if (ready.ready) rig = await startLakeRig();
}, 120_000);
afterAll(async () => {
  await closeAllWarehouses();
  await rig?.stop();
  await cleanup();
});

const TABLES = ["assets", "columns", "inputs", "files", "writes"] as const;

for (const kind of ["local", "postgres"] as const) {
  (ready.ready ? test : test.skip)(`on a ${kind} lake: the log is one row per live key afterwards, the views read the same, and the bookkeeping goes on from the right numbers`, async () => {
    const l: LakeProject = await lakeProject(kind, { extensionDir: ready.dir, ...(kind === "postgres" ? { rig } : {}), files: { "assets/summary.sql": "-- description: orders by k\n-- key: k\nSELECT k, count(*) AS n FROM orders GROUP BY k\n" } });
    const run = async (args: string[]) => {
      const r = await cli([...args, "--json"], { cwd: l.p.root, env: l.env });
      await closeAllWarehouses();
      return r;
    };
    const ok = async (args: string[]) => {
      const r = await run(args);
      expect(r.exit, `${args.join(" ")}\n${r.stdout}${r.stderr}`).toBe(0);
      return r;
    };
    const confirmed = async (args: string[]) => {
      const asked = await run(args);
      expect(asked.exit, asked.stdout + asked.stderr).toBe(5);
      return ok(["confirm", asked.json.confirmation.token]);
    };
    const rows = async (sql: string) => (await ok(["query", sql, "--limit", "100000", "--full-values"])).json.data.rows as Record<string, unknown>[];
    const views = async () => Object.fromEntries(await Promise.all(["meta", ...TABLES].map(async (t) => [t, (await rows(`select * from _croft.${t}`)).map((r) => JSON.stringify(r)).sort()] as const)));
    const logCount = async (t: string) => Number((await rows(`select count(*)::INT as n from _croft.${t}_log`))[0]!.n);
    const orders = (m: number) => writeFileSync(join(l.p.root, "assets", "orders.sql"), ORDERS_SQL.replace("range % 7", `range % ${m}`));

    // A history that writes every kind of bookkeeping row: runs that change the table, a delete and its restore, a rename.
    for (const m of [5, 4, 3]) {
      orders(m);
      await ok(["run", "--foreground"]);
    }
    await confirmed(["delete", "orders"]);
    await confirmed(["restore", "orders"]);
    await ok(["rename", "summary", "by_k"]);
    await ok(["run", "--foreground"]);
    const before = await views();
    const logsBefore = Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, await logCount(t)] as const)));
    expect(logsBefore.assets).toBeGreaterThan((await rows("select count(*)::INT as n from _croft.assets"))[0]!.n as number);

    // The plan counts what the first step would remove; the pass removes exactly that, and the views read the same.
    const plan = (await ok(["maintain", "--dry-run"])).json.data.plan;
    expect(plan.supersededLogRows).toBeGreaterThan(0);
    const pass = (await ok(["maintain"])).json.data.report;
    expect(pass.steps[0]).toMatchObject({ step: "prune", status: "ok" });
    expect(pass.steps[0].did.rows).toBe(plan.supersededLogRows);
    expect(await views()).toEqual(before);
    // Each log holds one row for each key the view shows, and no row of a key that was closed (the rename's old key, the deleted and restored table's).
    for (const t of TABLES) expect(await logCount(t), `_croft.${t}_log`).toBe((await rows(`select count(*)::INT as n from _croft.${t}`))[0]!.n as number);
    // A second pass has nothing to remove, and a plan says so.
    expect((await ok(["maintain", "--dry-run"])).json.data.plan.supersededLogRows).toBe(0);
    expect((await ok(["maintain"])).json.data.report.steps[0].did.rows).toBe(0);

    // The bookkeeping carries on from the numbers that are left: a run, a delete and its restore, a rename back.
    orders(2);
    const again = await ok(["run", "--foreground"]);
    expect(again.json.data.steps.map((s: { asset: string; status: string }) => `${s.asset}:${s.status}`)).toEqual(["orders:ok", "by_k:ok"]);
    const state = async () => (await rows("select name, row_count::INT as n from _croft.assets order by name"));
    expect(await state()).toEqual([{ name: "by_k", n: 2 }, { name: "orders", n: 20 }]);
    await confirmed(["delete", "orders"]);
    expect((await rows("select name from _croft.assets order by name")).map((r) => r.name)).toEqual(["by_k"]);
    await confirmed(["restore", "orders"]);
    expect(await state()).toEqual([{ name: "by_k", n: 2 }, { name: "orders", n: 20 }]);
    await ok(["rename", "by_k", "summary"]);
    expect((await rows("select name from _croft.assets order by name")).map((r) => r.name)).toEqual(["orders", "summary"]);
    expect((await rows("select asset, count(*)::INT as n from _croft.columns group by asset order by asset")).map((r) => r.asset)).toEqual(["orders", "summary"]);
    // The newest row of each key is the newest write: orders' latest write is the run's, and the writes table has them all.
    expect((await rows("select count(*)::INT as n from _croft.writes where asset = 'orders'"))[0]!.n).toBeGreaterThanOrEqual(5);
    const status = await ok(["status"]);
    expect(status.json.data.assets.map((a: { asset: string; status: string }) => `${a.asset}:${a.status}`).sort()).toEqual(["orders:ok", "summary:ok"]);
    // And another pass prunes what that added, once more to the live keys.
    expect((await ok(["maintain"])).json.data.report.steps[0].status).toBe("ok");
    for (const t of TABLES) expect(await logCount(t), `_croft.${t}_log after the second pass`).toBe((await rows(`select count(*)::INT as n from _croft.${t}`))[0]!.n as number);
  }, 600_000);
}
