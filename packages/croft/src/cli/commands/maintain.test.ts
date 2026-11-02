// croft maintain (DESIGN.md D149 to D152; option 07, slice 3), run in this process against a local lake (a SQLite catalog and a folder): what the
// command says and does, its --json, the confirmation of the one part that deletes what croft cannot vouch for, the pass the scheduler asks
// for, and what croft status and croft doctor say of it. The steps themselves are db/lake-steps.test.ts; a Postgres lake is the journeys'.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extensionsReady } from "../../db/extension-dir-testkit.ts";
import { localLakeBlock, useLake } from "../../db/lake-testkit.ts";
import { closeAllWarehouses } from "../../db/warehouse.ts";
import { cleanup, cli, makeProject } from "./inspect-testkit.ts";
import { lakeProject } from "./lake-project-testkit.ts";

afterAll(async () => {
  await closeAllWarehouses();
  await cleanup();
});

const ready = extensionsReady(["httpfs", "postgres", "ducklake", "sqlite"]);
const maybe = ready.ready ? test : test.skip;
if (!ready.ready) console.warn(`[maintain.test] SKIPPING: ${ready.skipReason}`);

const HOUR = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();

describe("croft maintain", () => {
  test("is for a lake: a project that keeps a file is told so, with nothing changed", async () => {
    const p = makeProject({});
    const r = await cli(["maintain", "--json"], { cwd: p.root });
    expect(r.exit).toBe(2);
    expect(r.json.problems[0]).toMatchObject({ code: "MAINTAIN_NEEDS_LAKE", effect: "nothing was changed" });
  });

  maybe("a lake nobody has written is not made by a pass", async () => {
    const p = makeProject({});
    useLake(p.root, { block: localLakeBlock() });
    const env = { CROFT_EXTENSION_DIR: ready.dir };
    for (const args of [["maintain"], ["maintain", "--dry-run"], ["maintain", "--orphans"]]) {
      const r = await cli([...args, "--json"], { cwd: p.root, env });
      expect(r.exit, r.stdout + r.stderr).toBe(0);
      expect(r.json.data.status).toBe("no_lake");
    }
    expect(existsSync(join(p.root, "lake", "catalog.sqlite"))).toBe(false);
  }, 60_000);

  maybe("--dry-run says what a pass would do and changes nothing; a pass does it, and croft status and croft doctor say so", async () => {
    const l = await lakeProject("local", { extensionDir: ready.dir });
    const run = async (args: string[], extra: Record<string, string> = {}) => {
      const r = await cli([...args, "--json"], { cwd: l.p.root, env: { ...l.env, ...extra } });
      await closeAllWarehouses();
      return r;
    };
    const planned = await run(["maintain", "--dry-run"]);
    expect(planned.exit, planned.stdout + planned.stderr).toBe(0);
    expect(planned.json.data).toMatchObject({ status: "planned", report: null, auto: { enabled: true, everyHours: 24, lastOkAt: null } });
    expect(planned.json.data.plan).toMatchObject({ expire: 0, pins: [], expiryOptions: [] });
    expect(planned.json.data.plan.stats.snapshots).toBeGreaterThan(0);
    const snapshots = planned.json.data.plan.stats.snapshots as number;

    const ran = await run(["maintain"]);
    expect(ran.exit, ran.stdout + ran.stderr).toBe(0);
    expect(ran.json.data.status).toBe("ran");
    expect(ran.json.data.report.steps.map((s: { step: string; status: string }) => `${s.step}:${s.status}`)).toEqual(["flush:ok", "expire:ok", "merge:ok", "rewrite:ok", "cleanup:ok"]);
    expect(ran.json.data.report.before.snapshots).toBe(snapshots);
    // A pass makes snapshots of its own (a flush, a merge), and expires none of a lake that is hours old.
    expect(ran.json.data.report.plan.expired).toBe(0);
    expect(ran.json.data.auto.lastOkAt).not.toBeNull();

    // The human words.
    const human = await cli(["maintain"], { cwd: l.p.root, env: l.env });
    await closeAllWarehouses();
    expect(human.exit).toBe(0);
    expect(human.stdout).toContain("Lake maintenance done in");
    expect(human.stdout).toMatch(/flush\s+ok/);
    expect(human.stdout).toMatch(/cleanup\s+ok/);

    const status = await run(["status"]);
    expect(status.json.data.lake.maintenance).toMatchObject({ enabled: true, everyHours: 24, lastPass: { ok: true } });
    expect(status.json.data.lake.maintenance.lastOkAt).toMatch(/\d{4}-\d\d-\d\dT/);
    expect(status.json.problems.filter((x: { code: string }) => x.code === "LAKE_MAINTENANCE_FAILED")).toEqual([]);

    const doctor = await run(["doctor"]);
    const check = (doctor.json.data.checks as { id: string; status: string; text: string }[]).find((c) => c.id === "lake.maintenance")!;
    expect(check.status).toBe("ok");
    expect(check.text).toMatch(/last pass that worked .* ago/);
    expect(check.text).toMatch(/\d+ snapshots · \d+ files/);
    expect(check.text).toContain("files waiting for deletion");
  }, 180_000);

  maybe("--due runs a pass only when one is due: a day after the last that worked (the lake.maintenance setting), not before", async () => {
    const l = await lakeProject("local", { extensionDir: ready.dir });
    const T = Date.now();
    const due = async (at: number) => {
      const r = await cli(["maintain", "--due", "--json"], { cwd: l.p.root, env: { ...l.env, CROFT_NOW: iso(at) } });
      await closeAllWarehouses();
      return r;
    };
    // The first look stamps the lake; nothing is due on its first day.
    expect((await due(T)).json.data.status).toBe("not_due");
    expect((await due(T + 23 * HOUR)).json.data.status).toBe("not_due");
    const first = await due(T + 25 * HOUR);
    expect(first.exit, first.stdout + first.stderr).toBe(0);
    expect(first.json.data.status).toBe("ran");
    // It counts from the pass that worked.
    expect((await due(T + 26 * HOUR)).json.data.status).toBe("not_due");
    expect((await due(T + 48 * HOUR)).json.data.status).toBe("not_due");
    expect((await due(T + 50 * HOUR)).json.data.status).toBe("ran");
    // Off, it is never due.
    const cfg = JSON.parse(await Bun.file(join(l.p.root, "croft.json")).text());
    cfg.lake.maintenance = { enabled: false };
    writeFileSync(join(l.p.root, "croft.json"), JSON.stringify(cfg));
    expect((await due(T + 500 * HOUR)).json.data.status).toBe("not_due");
    expect((await due(T + 500 * HOUR)).json.data.auto.enabled).toBe(false);
  }, 180_000);

  maybe("--orphans lists what is not the lake's own and deletes it only through croft confirm, for the list that was shown", async () => {
    const l = await lakeProject("local", { extensionDir: ready.dir });
    const dir = join(l.p.root, "lake", "data", "main", "orders");
    mkdirSync(dir, { recursive: true });
    const plant = (name: string, days: number) => {
      const f = join(dir, name);
      writeFileSync(f, "stray");
      const when = new Date(Date.now() - days * 86_400_000);
      utimesSync(f, when, when);
      return f;
    };
    const old1 = plant("left-behind-1.parquet", 3);
    const young = plant("written-just-now.parquet", 0);
    const run = async (args: string[]) => {
      const r = await cli([...args, "--json"], { cwd: l.p.root, env: l.env });
      await closeAllWarehouses();
      return r;
    };
    // --dry-run lists, and issues no token.
    const listed = await run(["maintain", "--orphans", "--dry-run"]);
    expect(listed.exit).toBe(0);
    expect(listed.json.data).toMatchObject({ status: "orphans", orphans: { deleted: 0 } });
    expect(listed.json.data.orphans.files).toEqual([expect.stringContaining("left-behind-1.parquet")]);
    expect(listed.json.confirmation).toBeUndefined();
    // Without --dry-run it asks: exit 5, a token, nothing deleted, and the impact in words a person can read.
    const asked = await run(["maintain", "--orphans"]);
    expect(asked.exit, asked.stdout + asked.stderr).toBe(5);
    expect(asked.json.data.status).toBe("needs_confirmation");
    expect(asked.json.confirmation).toMatchObject({ command: "croft maintain --orphans", impact: { rows: 1, unit: "file", asset: "the lake's folder" } });
    expect(asked.json.problems[0]).toMatchObject({ code: "CONFIRMATION_REQUIRED", effect: "nothing was changed" });
    expect(existsSync(old1)).toBe(true);
    // A file that appears before the yes makes the token stale.
    const old2 = plant("left-behind-2.parquet", 5);
    const stale = await run(["confirm", asked.json.confirmation.token]);
    expect(stale.exit, stale.stdout + stale.stderr).not.toBe(0);
    expect(stale.json.data.result ?? stale.json.problems).toBeTruthy();
    expect(JSON.stringify(stale.json)).toContain("CONFIRMATION_STALE");
    expect(existsSync(old1) && existsSync(old2)).toBe(true);
    // Asked again, and confirmed for the list that was shown.
    const again = await run(["maintain", "--orphans"]);
    expect(again.exit).toBe(5);
    expect(again.json.confirmation.impact.rows).toBe(2);
    const done = await run(["confirm", again.json.confirmation.token]);
    expect(done.exit, done.stdout + done.stderr).toBe(0);
    expect(done.json.data.outcome).toBe("used");
    expect(done.json.data.result).toMatchObject({ status: "orphans_deleted", orphans: { deleted: 2 } });
    expect(existsSync(old1) || existsSync(old2)).toBe(false);
    expect(existsSync(young)).toBe(true);
    // The token is spent, and the lake still reads.
    const spent = await run(["confirm", again.json.confirmation.token]);
    expect(spent.exit).not.toBe(0);
    const q = await run(["query", "select count(*)::INT as n from orders"]);
    expect(q.json.data.rows).toEqual([{ n: 20 }]);
    const none = await run(["maintain", "--orphans"]);
    expect(none.json.data.orphans.files).toEqual([]);
    expect(none.exit).toBe(0);
  }, 240_000);

  maybe("a backup that is copying the bucket keeps a pass from running", async () => {
    const l = await lakeProject("local", { extensionDir: ready.dir });
    const { markBackupRunning } = await import("../../db/lake.ts");
    const done = markBackupRunning(l.project.paths.stateDir);
    try {
      const r = await cli(["maintain", "--json"], { cwd: l.p.root, env: l.env });
      expect(r.exit).toBe(4);
      expect(r.json.data.status).toBe("backup_running");
      expect(r.json.problems[0].code).toBe("DB_BUSY");
    } finally {
      done();
    }
    const after = await cli(["maintain", "--json"], { cwd: l.p.root, env: l.env });
    await closeAllWarehouses();
    expect(after.exit, after.stdout).toBe(0);
  }, 120_000);
});
