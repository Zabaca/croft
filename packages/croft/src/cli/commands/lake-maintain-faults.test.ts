// A lake's maintenance when the store fails it (DESIGN.md D150; option 07, slice 3), in a project, by the real commands: a pass that kept getting
// HTTP 500 from the store's bulk delete is reported (croft maintain, croft status, croft doctor), leaves the lake usable and loses nothing, no
// credential is in anything printed, and the next pass, once the store is back, finishes the cleanup and clears the warning. The store is a child
// of this test that answers HTTP 500 to the next N deletes (db/s3-store-testkit.ts); R2 did, to three bulk deletes in five days.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { lakeRigReady, type LakeRig, RIG_SECRETS, startLakeRig, useLake } from "../../db/lake-testkit.ts";
import { closeAllWarehouses } from "../../db/warehouse.ts";
import { cleanup, cli, makeProject } from "./inspect-testkit.ts";
import { lakeProject, ORDERS_SQL } from "./lake-project-testkit.ts";

const ready = lakeRigReady();
if (!ready.ready) console.warn(`[lake-maintain-faults.test] SKIPPING: ${ready.skipReason}`);
const maybe = ready.ready ? test : test.skip;

let rig: LakeRig;
beforeAll(async () => {
  if (ready.ready) rig = await startLakeRig();
}, 120_000);
afterAll(async () => {
  await closeAllWarehouses();
  await rig?.stop();
  await cleanup();
});

describe("croft maintain against a store that fails a delete", () => {
  maybe("the failure is reported everywhere, loses nothing and leaks nothing; the next pass finishes the cleanup (acceptance 6)", async () => {
    const l = await lakeProject("postgres", { extensionDir: ready.dir, rig });
    const run = async (args: string[], env: Record<string, string> = {}) => {
      const r = await cli([...args, "--json"], { cwd: l.p.root, env: { ...l.env, CROFT_MAINTAIN_RETRY_MS: "1", ...env } });
      await closeAllWarehouses();
      for (const secret of RIG_SECRETS) expect(r.stdout + r.stderr, `${args.join(" ")} must not print a credential`).not.toContain(secret);
      return r;
    };
    // Files for the pass to merge and clean up: the table rewritten a few times.
    for (const n of [5, 4, 3]) {
      writeFileSync(join(l.p.root, "assets", "orders.sql"), ORDERS_SQL.replace("range % 7", `range % ${n}`));
      expect((await run(["run", "orders", "--foreground"])).exit).toBe(0);
    }
    const rows = async () => (await run(["query", "select count(*)::INT as n, sum(k)::INT as s from orders"])).json.data.rows;
    const before = await rows();
    // The store refuses every delete.
    await rig.s3.failDeletes(1000, 500);
    const failed = await run(["maintain"]);
    expect(failed.exit, failed.stdout).toBe(1);
    expect(failed.json.data.status).toBe("failed");
    const steps = failed.json.data.report.steps as { step: string; status: string; attempts: number; error?: string }[];
    expect(steps.map((s) => `${s.step}:${s.status}`)).toEqual(["prune:ok", "flush:ok", "expire:ok", "merge:ok", "rewrite:ok", "cleanup:failed"]);
    expect(steps[5]!.attempts).toBe(4);
    expect(steps[5]!.error).toContain("HTTP 500");
    expect(failed.json.problems[0]).toMatchObject({ code: "LAKE_MAINTENANCE_FAILED", retryable: true });
    expect(failed.json.data.report.after.pendingDeletion).toBeGreaterThan(0);
    // The lake is usable and has lost nothing.
    expect(await rows()).toEqual(before);
    // status says so, as a warning, and the lake is still healthy; doctor says so too.
    const status = await run(["status"]);
    expect(status.json.data.healthy).toBe(true);
    expect(status.json.data.lake.maintenance.lastError).toMatchObject({ step: "cleanup", code: "LAKE_MAINTENANCE_FAILED" });
    expect(status.json.problems.find((p: { code: string }) => p.code === "LAKE_MAINTENANCE_FAILED")).toMatchObject({ severity: "warning" });
    const doctor = await run(["doctor"]);
    const check = (doctor.json.data.checks as { id: string; status: string; text: string; code?: string }[]).find((c) => c.id === "lake.maintenance")!;
    expect(check).toMatchObject({ status: "warn", code: "LAKE_MAINTENANCE_FAILED" });
    expect(check.text).toMatch(/files waiting for deletion/);
    // The scheduler's pass does not try again at once, but within the hour.
    const soon = await run(["maintain", "--due"]);
    expect(soon.json.data.status).toBe("not_due");
    // The store is back; an hour on the pass is due again and finishes the job.
    await rig.s3.failDeletes(0, 500);
    const later = await run(["maintain", "--due"], { CROFT_NOW: new Date(Date.now() + 61 * 60_000).toISOString() });
    expect(later.exit, later.stdout + later.stderr).toBe(0);
    expect(later.json.data.status).toBe("ran");
    expect(later.json.data.report.after.pendingDeletion).toBe(0);
    expect(await rows()).toEqual(before);
    const clean = await run(["status"]);
    expect(clean.json.data.lake.maintenance.lastError).toBeNull();
    expect(clean.json.problems.filter((p: { code: string }) => p.code === "LAKE_MAINTENANCE_FAILED")).toEqual([]);
    const doctor2 = await run(["doctor"]);
    expect((doctor2.json.data.checks as { id: string; status: string }[]).find((c) => c.id === "lake.maintenance")!.status).toBe("ok");
  }, 300_000);

  maybe("a pass that fails after a run never fails the run: the run's result is as if there had been no pass, and the failure is kept", async () => {
    const l = await lakeProject("postgres", { extensionDir: ready.dir, rig });
    const exec = async (args: string[], later = false) => {
      // A run reads the project's clock and the retry knob from the process, as the real CLI's child does.
      if (later) process.env.CROFT_NOW = new Date(Date.now() + 25 * 3_600_000).toISOString();
      process.env.CROFT_MAINTAIN_RETRY_MS = "1";
      try {
        const r = await cli([...args, "--json"], { cwd: l.p.root, env: { ...l.env, ...(later ? { CROFT_NOW: process.env.CROFT_NOW } : {}) } });
        await closeAllWarehouses();
        return r;
      } finally {
        delete process.env.CROFT_NOW;
        delete process.env.CROFT_MAINTAIN_RETRY_MS;
      }
    };
    for (const n of [5, 4, 3]) {
      writeFileSync(join(l.p.root, "assets", "orders.sql"), ORDERS_SQL.replace("range % 7", `range % ${n}`));
      expect((await exec(["run", "orders", "--foreground"])).exit).toBe(0);
    }
    await rig.s3.failDeletes(1000, 500);
    writeFileSync(join(l.p.root, "assets", "orders.sql"), ORDERS_SQL.replace("range % 7", "range % 2"));
    const run = await exec(["run", "orders", "--foreground"], true); // a day on: a pass is due after this run, and the store refuses its deletes
    await rig.s3.failDeletes(0, 500);
    expect(run.exit, run.stdout + run.stderr).toBe(0);
    expect(run.json.ok).toBe(true);
    expect(run.json.data.status).toBe("succeeded");
    expect(run.json.problems).toEqual([]);
    expect(run.json.data.steps[0]).toMatchObject({ asset: "orders", status: "ok" });
    for (const secret of RIG_SECRETS) expect(run.stdout + run.stderr).not.toContain(secret);
    // The table is what the run made, and the failure of the pass after it is kept for status and doctor.
    expect((await exec(["query", "select count(distinct k)::INT as k from orders"])).json.data.rows).toEqual([{ k: 2 }]);
    const status = await exec(["status"]);
    expect(status.json.data.lake.maintenance.lastError).toMatchObject({ step: "cleanup" });
    expect(status.json.problems.find((p: { code: string }) => p.code === "LAKE_MAINTENANCE_FAILED")).toMatchObject({ severity: "warning" });
  }, 300_000);

  maybe("a catalog that cannot be reached is a failed attempt too: kept, shown as a warning, and tried again within the hour", async () => {
    const p = makeProject({ files: { "assets/orders.sql": ORDERS_SQL } });
    useLake(p.root, await rig.lake({ port: 1 })); // nothing listens on port 1
    const env = { CROFT_EXTENSION_DIR: ready.dir, CROFT_MAINTAIN_RETRY_MS: "1" };
    // A lake that cannot be looked at is one nobody can tell was written; the pass is not made, and says why.
    const first = await cli(["maintain", "--json"], { cwd: p.root, env });
    await closeAllWarehouses();
    expect(first.exit, first.stdout + first.stderr).toBe(1);
    expect(first.json.data.status).toBe("failed");
    expect(first.json.problems[0].code).toBe("LAKE_ATTACH_FAILED");
    for (const secret of RIG_SECRETS) expect(first.stdout + first.stderr).not.toContain(secret);
    const status = await cli(["status", "--json"], { cwd: p.root, env });
    expect(status.json.data.lake.maintenance.lastError).toMatchObject({ code: "LAKE_ATTACH_FAILED" });
    expect(status.json.problems.find((x: { code: string }) => x.code === "LAKE_MAINTENANCE_FAILED")).toMatchObject({ severity: "warning" });
    expect((await cli(["maintain", "--due", "--json"], { cwd: p.root, env })).json.data.status).toBe("not_due");
    await closeAllWarehouses();
  }, 120_000);
});
