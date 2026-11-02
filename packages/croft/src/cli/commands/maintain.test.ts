// croft maintain (DESIGN.md D149 to D152; option 07, slice 3), run in this process against a local lake (a SQLite catalog and a folder): what the
// command says and does, its --json, the confirmation of the one part that deletes what croft cannot vouch for, the pass the scheduler asks
// for, and what croft status and croft doctor say of it. The steps themselves are db/lake-steps.test.ts; a Postgres lake is the journeys'.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extensionsReady } from "../../db/extension-dir-testkit.ts";
import { localLakeBlock, sqliteLakeClock, useLake } from "../../db/lake-testkit.ts";
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

  maybe("a run starts the pass when one is due, after the run, and a trashed version pins the snapshot it was taken from", async () => {
    const l = await lakeProject("local", { extensionDir: ready.dir });
    const T = Date.now();
    const exec = async (args: string[], at?: number) => {
      // A run reads the project's clock from the process (core/time.ts now()), as the real CLI's child does.
      if (at) process.env.CROFT_NOW = iso(at);
      try {
        const r = await cli([...args, "--json"], { cwd: l.p.root, env: { ...l.env, ...(at ? { CROFT_NOW: iso(at) } : {}) } });
        await closeAllWarehouses();
        return r;
      } finally {
        delete process.env.CROFT_NOW;
      }
    };
    // The run that built `orders` was the lake's first look (nothing due). A run a day and an hour later is followed by a pass.
    expect((await exec(["maintain", "--dry-run"])).json.data.auto.lastOkAt).toBeNull();
    const soon = await exec(["run", "orders", "--foreground"], T + 2 * HOUR);
    expect(soon.exit, soon.stdout + soon.stderr).toBe(0);
    expect((await exec(["maintain", "--dry-run"])).json.data.auto.lastOkAt).toBeNull();
    const later = await exec(["run", "orders", "--foreground"], T + 25 * HOUR);
    expect(later.exit, later.stdout + later.stderr).toBe(0);
    const auto = (await exec(["maintain", "--dry-run"])).json.data.auto;
    expect(auto.lastOkAt).not.toBeNull();
    expect(auto.lastPass).toMatchObject({ ok: true });
    // A trashed version in a lake notes the lake's snapshot it was taken from, and the plan names it.
    const asked = await exec(["delete", "orders"]);
    expect(asked.exit).toBe(5);
    expect((await exec(["confirm", asked.json.confirmation.token])).exit).toBe(0);
    const trashDir = join(l.p.stateDir, "trash", "orders");
    const sidecar = JSON.parse(await Bun.file(join(trashDir, (await Array.fromAsync(new Bun.Glob("*.json").scan(trashDir)))[0]!)).text());
    expect(sidecar.lakeSnapshot).toEqual(expect.any(Number));
    const plan = (await exec(["maintain", "--dry-run"])).json.data.plan;
    expect(plan.pins).toEqual([sidecar.lakeSnapshot]);
  }, 240_000);

  maybe("an age-based expiry set by another tool is a warning in doctor and in the plan, and changes nothing croft's pass does (acceptance 3)", async () => {
    const l = await lakeProject("local", { extensionDir: ready.dir });
    await sqliteLakeClock(join(l.p.root, "lake", "catalog.sqlite")).setOption("expire_older_than", "2 days");
    const exec = async (args: string[]) => {
      const r = await cli([...args, "--json"], { cwd: l.p.root, env: l.env });
      await closeAllWarehouses();
      return r;
    };
    const doctor = await exec(["doctor"]);
    const checks = doctor.json.data.checks as { id: string; status: string; code?: string; text: string }[];
    expect(checks.find((c) => c.id === "lake.expiry")).toMatchObject({ status: "warn", code: "LAKE_EXPIRY_OPTION" });
    expect(checks.find((c) => c.id === "lake.expiry")!.text).toContain("expire_older_than = 2 days");
    const plan = await exec(["maintain", "--dry-run"]);
    expect(plan.json.data.plan.expiryOptions).toEqual([{ name: "expire_older_than", value: "2 days" }]);
    expect(plan.json.problems.map((p: { code: string }) => p.code)).toContain("LAKE_EXPIRY_OPTION");
    // The pass expires by its own list, and the lake's option does nothing to it: the table reads, and the plan said nothing to expire.
    const ran = await exec(["maintain"]);
    expect(ran.exit, ran.stdout + ran.stderr).toBe(0);
    expect(ran.json.data.report.plan.expired).toBe(0);
    expect((await exec(["query", "select count(*)::INT as n from orders"])).json.data.rows).toEqual([{ n: 20 }]);
  }, 120_000);

  maybe("the scheduler's tick starts the lake's maintenance when one is due, once, and never runs it itself", async () => {
    const l = await lakeProject("local", { extensionDir: ready.dir });
    const { RunsDb } = await import("../../history/runs-db.ts");
    const { projectTick } = await import("../../schedule/tick.ts");
    const runs = RunsDb.open(l.p.stateDir);
    runs.setScheduling({ state: "on", via: "serve" });
    runs.close();
    const T = Date.now();
    const started: { root: string }[] = [];
    const tick = (at: number) => projectTick({
      project: l.project, env: {}, now: new Date(at), spawn: async () => {}, maintain: async (r) => void started.push({ root: r.root }),
    });
    expect((await tick(T)).result.maintenance).toBeUndefined(); // the first look stamps the lake
    expect((await tick(T + 23 * HOUR)).result.maintenance).toBeUndefined();
    const due = await tick(T + 25 * HOUR);
    expect(due.result.maintenance).toBe(true);
    expect(started.length).toBe(1);
    // The next minute's tick leaves it be: the pass is starting. If it never ran, ten minutes on the tick starts it again.
    expect((await tick(T + 25 * HOUR + 60_000)).result.maintenance).toBeUndefined();
    expect((await tick(T + 25 * HOUR + 11 * 60_000)).result.maintenance).toBe(true);
    expect(started.length).toBe(2);
    // A spawn that fails is a warning of the tick, not its failure.
    const broken = await projectTick({ project: l.project, env: {}, now: new Date(T + 26 * HOUR), spawn: async () => {}, maintain: async () => { throw new Error("no bun"); } });
    expect(broken.result.maintenance).toBeUndefined();
    expect(broken.problems.map((p) => p.message).join(" ")).toContain("could not start the lake's maintenance: no bun");
    // Off, the tick never starts it.
    const cfg = JSON.parse(await Bun.file(join(l.p.root, "croft.json")).text());
    cfg.lake.maintenance = { enabled: false };
    writeFileSync(join(l.p.root, "croft.json"), JSON.stringify(cfg));
    const { loadProject } = await import("../../project/root.ts");
    const off = await projectTick({ project: loadProject({ root: l.p.root }), env: {}, now: new Date(T + 500 * HOUR), spawn: async () => {}, maintain: async () => void started.push({ root: "off" }) });
    expect(off.result.maintenance).toBeUndefined();
    expect(started.length).toBe(2);
  }, 120_000);
});
