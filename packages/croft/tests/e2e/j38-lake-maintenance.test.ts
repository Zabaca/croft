// Journey 38: a lake's maintenance and the undo promise (DESIGN.md D149 to D152; option 07, slice 3), on the lake of the job that runs it. It runs only
// when the journeys are run on a lake (CROFT_E2E_LAKE=local or postgres; the two lake jobs of ci.yml): it is lake-heavy, and the jobs that run
// every test on every platform have no time to spare. Everything but the last two steps is the real croft CLI in a project with a lake, with the
// project's clock (CROFT_NOW) moved from day to day and the catalog told when each snapshot was made (the lake clock of db/lake-testkit.ts), so
// weeks pass in seconds.
//
// The history, in days before T: a table `gone` made 70 days ago; `orders` rewritten on 8 days, 60 to 53, each a version; `rowsdel` made 51 days
// ago and 7 rows deleted from it, one a day, 50 to 44 (a version each, and a trash version each); `gone` deleted 29 days ago.
//   a. the history builds, and a pass that is not yet due leaves it alone;
//   b. one pass at T (croft maintain): it keeps what the promise keeps, and the lake reads back every version of it exactly: orders' 5 newest
//      versions, 5 newest of rowsdel, and the one snapshot only the trash pins; the versions past both limits are gone, from the lake and from
//      the trash; what was deleted 29 days ago is restored from the trash, exactly;
//   c. maintenance by itself: a run a day on is followed by a pass, status and doctor say when it last worked, and --dry-run is read-only;
//   d. a week of hourly runs over five assets, then a pass, on this lake: the snapshots, files and tables fall to what the kept versions need
//      (acceptance 1); and its cost in a steady state, a month of hourly runs with a pass a day (the numbers are in scripts/simulate-lake-maintenance.ts).
//      It has a lake of its own and shares nothing with a to c, so its work starts in beforeAll and runs beside them; the test of d waits for it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { golden } from "../golden/kit.ts";
import { type LakeClock, openTestLake, postgresLakeClock, sqliteLakeClock } from "../../src/db/lake-testkit.ts";
import { catalogBytes, folderBytes, pass, simulate, statsOf } from "../../src/db/lake-simulation-testkit.ts";
import { cleanupAll, initProject, LAKE, lakeRig, type Project, show } from "./harness.ts";

afterAll(cleanupAll);

const DAY = 86_400_000;
const T = new Date("2026-11-02T12:00:00Z");
const ago = (days: number): Date => new Date(T.getTime() - days * DAY);
const iso = (d: Date): string => d.toISOString();

if (!LAKE) {
  test.skip("journey 38 runs on a lake: CROFT_E2E_LAKE=local or postgres (the lake jobs of ci.yml)", () => {});
} else {
  describe(`journey 38 (${LAKE} lake): maintenance and the undo promise`, () => {
    let p: Project;
    let clock: LakeClock;
    /** The CLI at `days` before T, and the snapshots it made are said to be from then. */
    const at = async (days: number, args: string[], code = 0): Promise<{ json: Record<string, any>; id: number }> => {
      const r = await p.json(args, { env: { CROFT_NOW: iso(ago(days)) } });
      expect(r.code, show(r)).toBe(code);
      return { json: r.json, id: await clock.mark(ago(days)) };
    };
    /** Ask for a destructive command and confirm it, at `days` before T. */
    const confirmed = async (days: number, args: string[]): Promise<{ json: Record<string, any>; id: number }> => {
      const asked = await p.json(args, { env: { CROFT_NOW: iso(ago(days)) } });
      expect(asked.code, show(asked)).toBe(5);
      return at(days, ["confirm", asked.json.confirmation.token]);
    };
    const orders = (k: number) => `-- description: orders, version ${k}\n-- key: id\nSELECT range AS id, ${k} AS v FROM range(12)\n`;
    const sql = async (query: string): Promise<{ code: number; rows: Record<string, unknown>[]; message?: string }> => {
      const r = await p.json(["query", query]);
      return { code: r.code ?? -1, rows: r.json.data?.rows ?? [], message: r.json.problems?.[0]?.message };
    };
    /** The one value of `v` orders held at snapshot `id`, or null when the snapshot is gone. */
    const ordersAt = async (id: number): Promise<number | null> => {
      const r = await sql(`select min(v)::INT as v, max(v)::INT as w, count(*)::INT as n from orders AT (VERSION => ${id})`);
      if (r.code !== 0) {
        expect(r.message, `a snapshot that is gone says so`).toContain("No snapshot found");
        return null;
      }
      expect(r.rows[0]!.v).toBe(r.rows[0]!.w);
      expect(r.rows[0]!.n).toBe(12);
      return r.rows[0]!.v as number;
    };
    const rowsdelAt = async (id: number): Promise<number | null> => {
      const r = await sql(`select count(*)::INT as n from rowsdel AT (VERSION => ${id})`);
      return r.code === 0 ? (r.rows[0]!.n as number) : null;
    };

    const so: number[] = []; // orders' snapshot of version k, at index k
    const sd: number[] = []; // the snapshot of the delete of row k from rowsdel, at index k
    let sRowsdel = 0;
    let sGone = 0;

    /** Test d's work, started in beforeAll: the lake of its own, the week, the pass and every expectation about them. */
    const runWeek = async (): Promise<void> => {
      const rig = LAKE === "postgres" ? await lakeRig() : undefined;
      const { lakeRigReady } = await import("../../src/db/lake-testkit.ts");
      const l = await openTestLake(LAKE!, { extensionDir: lakeRigReady().dir, ...(rig ? { rig } : {}) });
      try {
        // The week ended 40 days ago, so the promise keeps each asset's 5 newest versions, the state at the start of the window, and the newest.
        const start = new Date(T.getTime() - 40 * DAY - 7 * DAY);
        const sim = await simulate(l, { start, hours: 7 * 24, fullRefresh: "replace" });
        expect(sim.commits).toBe(840);
        const before = await statsOf(l);
        const catalogBefore = await catalogBytes(l);
        expect(before.snapshots).toBeGreaterThan(800);
        expect(before.dataFiles).toBeGreaterThan(800);
        expect(before.inlinedTables).toBeGreaterThan(150);
        const report = await pass(l, T);
        expect(report.ok, JSON.stringify(report.steps)).toBe(true);
        const after = await statsOf(l);
        console.log(`[j38 ${LAKE}] a week: ${JSON.stringify({ before, after, passMs: report.tookMs, steps: report.steps.map((s) => [s.step, s.tookMs]), catalogMBBefore: catalogBefore / 1e6, catalogMBAfter: (await catalogBytes(l)) / 1e6, dataMBAfter: folderBytes(l.dataDir) / 1e6 })}`);
        // What the kept versions need: 5 assets, 5 versions each at most, the window's start and the newest snapshot, and the pass's own.
        expect(after.snapshots).toBeLessThan(40);
        expect(after.dataFiles).toBeLessThan(40);
        expect(after.inlinedTables).toBeLessThan(25);
        expect(after.pendingDeletion).toBe(0);
        expect(report.tookMs).toBeLessThan(20_000); // timing-gap: a pass over this week takes 0.3 to 0.9 s (D150); one that merged nothing would take minutes
        // The lake still reads: every table as of today.
        const rows = await l.r.read((db) => db.all<{ n: number | bigint }>("SELECT (SELECT count(*) FROM tiny_a) + (SELECT count(*) FROM inc_a) + (SELECT count(*) FROM full_r) AS n"), { purpose: "j38" });
        expect(Number(rows[0]!.n)).toBe(840 + 4225 + 2000);
      } finally {
        await l.close();
      }
    };
    let week: Promise<void>;

    beforeAll(async () => {
      p = (await initProject("maintenance")).project;
      // Its own clock for the catalog, and the lake's block with maintenance by itself switched off while the history is built: a pass between
      // two steps would add snapshots of its own, and the journey says which snapshot is which.
      const cfg = JSON.parse(p.read("croft.json")) as Record<string, any>;
      const { localLakeBlock } = await import("../../src/db/lake-testkit.ts");
      cfg.lake = { ...(cfg.lake ?? localLakeBlock()), maintenance: { enabled: false } };
      p.write("croft.json", JSON.stringify(cfg, null, 2));
      if (LAKE === "local") clock = sqliteLakeClock(join(p.root, "lake", "catalog.sqlite"));
      else clock = postgresLakeClock(await lakeRig(), cfg.lake.catalog.database);
      week = runWeek();
      week.catch(() => {}); // a failure is reported by test d, which waits for it, not as an unhandled rejection while a to c run
    }, 180_000);

    test("a. the history builds: a table made 70 days ago, orders rewritten for 8 days, rows deleted from rowsdel for 7, and gone deleted 29 days ago", async () => {
      p.write("assets/gone.sql", "-- description: a table that will be deleted\n-- key: id\nSELECT range AS id FROM range(30)\n");
      sGone = (await at(70, ["run", "gone"])).id;
      let last = sGone;
      for (let k = 1; k <= 8; k++) {
        p.write("assets/orders.sql", orders(k));
        const r = await at(61 - k, ["run", "orders"]);
        expect(r.id, `one snapshot for orders v${k}`).toBe(last + 1);
        last = r.id;
        so[k] = r.id;
      }
      p.write("assets/rowsdel.sql", "-- description: rows deleted one a day\n-- key: id\nSELECT range AS id, 'x' AS v FROM range(40)\n");
      const made = await at(51, ["run", "rowsdel"]);
      expect(made.id).toBe(last + 1);
      sRowsdel = made.id;
      last = made.id;
      for (let k = 1; k <= 7; k++) {
        const r = await confirmed(51 - k, ["delete", "rowsdel", "--where", `id = ${k}`]);
        expect(r.id, `one snapshot for the delete of row ${k}`).toBe(last + 1);
        last = r.id;
        sd[k] = r.id;
      }
      const gone = await confirmed(29, ["delete", "gone"]);
      expect(gone.json.data.result.status).toBe("deleted");
      // The trash holds a version for each deletion, and each notes the snapshot it was taken from.
      const versions = readdirSync(join(p.stateDir, "trash", "rowsdel")).filter((f) => f.endsWith(".duckdb"));
      expect(versions.length).toBe(7);
      // Nothing was expired by anything so far: every version still reads back.
      for (let k = 1; k <= 8; k++) expect(await ordersAt(so[k]!), `orders v${k} before the pass`).toBe(k);
      expect(await rowsdelAt(sRowsdel)).toBe(40);
      // The pass is not due (maintenance by itself is off here); a plan is a read.
      const plan = golden("maintain", await p.croft(["maintain", "--dry-run", "--json"], { env: { CROFT_NOW: iso(T) } }));
      expect(plan.data.status).toBe("planned");
      expect(plan.data.plan.expire).toBeGreaterThan(0);
      // The trash pins the snapshots its versions were taken from: the five newest deletions of rowsdel (the snapshot before each), and gone's
      // (the snapshot before the last deletion). The two oldest versions of rowsdel are older than 30 days with five newer, so they pin nothing.
      expect(plan.data.plan.pins).toEqual([sd[2], sd[3], sd[4], sd[5], sd[6], sd[7]]);
    }, 600_000);

    test("b. one pass keeps exactly what the promise keeps, reads it back exactly, drops what is past both limits, and the 29-day-old delete is restored", async () => {
      const before = await sql("select count(*)::INT as n from orders");
      expect(before.rows).toEqual([{ n: 12 }]);
      const ran = golden("maintain", await p.croft(["maintain", "--json"], { env: { CROFT_NOW: iso(T) } }));
      expect(ran.data.status).toBe("ran");
      expect(ran.data.report.steps.map((s: { status: string }) => s.status)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok"]);
      expect(ran.data.report.plan.expired).toBeGreaterThan(0);
      expect(ran.data.report.after.snapshots).toBeLessThan(ran.data.report.before.snapshots);
      expect(ran.data.report.plan.assets).toMatchObject({ orders: 5, rowsdel: 5 });
      expect(ran.data.report.plan.because.pinned).toBe(6);
      // orders: its 5 newest versions read back with the rows they had; the 3 older are gone.
      for (let k = 4; k <= 8; k++) expect(await ordersAt(so[k]!), `orders v${k} (the ${9 - k}th newest)`).toBe(k);
      for (let k = 1; k <= 3; k++) expect(await ordersAt(so[k]!), `orders v${k} is past both limits`).toBeNull();
      // rowsdel: after delete k there are 40 - k rows. The 5 newest versions (deletes 3 to 7) and the snapshot the trash pins for the
      // third delete's version (taken after the second delete) read back; the creation and the first delete are gone.
      for (let k = 3; k <= 7; k++) expect(await rowsdelAt(sd[k]!), `rowsdel after delete ${k}`).toBe(40 - k);
      expect(await rowsdelAt(sd[2]!), "rowsdel after delete 2: pinned by the trash").toBe(38);
      expect(await rowsdelAt(sd[1]!), "rowsdel after delete 1: past both limits").toBeNull();
      expect(await rowsdelAt(sRowsdel), "rowsdel as made: past both limits").toBeNull();
      // The trash let go of its two oldest versions of rowsdel, by the same rule, and kept the five newest.
      const versions = readdirSync(join(p.stateDir, "trash", "rowsdel")).filter((f) => f.endsWith(".duckdb"));
      expect(versions.length).toBe(5);
      // What was deleted 29 days ago is in the trash and restores exactly; the lake read of it, as it was, is the pinned snapshot's.
      const list = (await p.json(["restore"], { env: { CROFT_NOW: iso(T) } })).json.data.versions as { asset: string }[];
      expect(list.filter((v) => v.asset === "gone").length).toBe(1);
      const token = (await p.json(["restore", "gone"], { env: { CROFT_NOW: iso(T) } })).json.confirmation.token;
      const restored = golden("confirm", await p.croft(["confirm", token, "--json"], { env: { CROFT_NOW: iso(T) } }));
      expect(restored.data.result.status).toBe("restored");
      expect((await sql("select count(*)::INT as n, min(id)::INT as lo, max(id)::INT as hi from gone")).rows).toEqual([{ n: 30, lo: 0, hi: 29 }]);
      // Nothing the promise keeps was lost: orders today is as it was.
      expect(await sql("select count(*)::INT as n from orders")).toMatchObject({ rows: [{ n: 12 }] });
      // A second pass has nothing more to expire.
      const again = golden("maintain", await p.croft(["maintain", "--json"], { env: { CROFT_NOW: iso(T) } }));
      expect(again.data.report.plan.expired).toBe(0);
    }, 600_000);

    test("c. a run a day on is followed by a pass; status and doctor say when it last worked; --dry-run reads and does not change", async () => {
      // Switch maintenance by itself on: a pass is due a day after the last that worked (the one at T).
      const cfg = JSON.parse(p.read("croft.json")) as Record<string, any>;
      cfg.lake.maintenance = { enabled: true, everyHours: 24 };
      p.write("croft.json", JSON.stringify(cfg, null, 2));
      const early = new Date(T.getTime() + 2 * 3_600_000);
      expect((await p.json(["run", "orders"], { env: { CROFT_NOW: iso(early) } })).code).toBe(0);
      const none = golden("maintain", await p.croft(["maintain", "--dry-run", "--json"], { env: { CROFT_NOW: iso(early) } }));
      expect(Date.parse(none.data.auto.lastOkAt)).toBe(T.getTime()); // the pass at T, not one after the run two hours on
      const late = new Date(T.getTime() + 25 * 3_600_000);
      expect((await p.json(["run", "orders"], { env: { CROFT_NOW: iso(late) } })).code).toBe(0);
      const status = golden("status", await p.croft(["status", "--json"], { env: { CROFT_NOW: iso(late) } }));
      expect(status.data.lake.maintenance).toMatchObject({ enabled: true, everyHours: 24, lastPass: { ok: true } });
      expect(Date.parse(status.data.lake.maintenance.lastOkAt)).toBe(late.getTime()); // the pass after the run, 25 hours after T
      expect(status.problems.filter((x: { code: string }) => x.code === "LAKE_MAINTENANCE_FAILED")).toEqual([]);
      const doctor = golden("doctor", await p.croft(["doctor", "--json"], { env: { CROFT_NOW: iso(late) } }));
      const check = (doctor.data.checks as { id: string; status: string; text: string }[]).find((c) => c.id === "lake.maintenance")!;
      expect(check.status).toBe("ok");
      expect(check.text).toContain("last pass that worked");
      // --dry-run never changes the lake: the same counts before and after.
      const a = (await p.json(["maintain", "--dry-run"], { env: { CROFT_NOW: iso(late) } })).json.data.plan.stats;
      const b = (await p.json(["maintain", "--dry-run"], { env: { CROFT_NOW: iso(late) } })).json.data.plan.stats;
      expect(b).toEqual(a);
      // The files in the lake's folder that the lake does not own: none; a backup of the lake copies it (the lake journeys' own check of it is db/lake-backup.test.ts).
      const orphans = golden("maintain", await p.croft(["maintain", "--orphans", "--json"], { env: { CROFT_NOW: iso(late) } }));
      expect(orphans.data.orphans.files).toEqual([]);
      const backup = golden("backup", await p.croft(["backup", "--json"], { env: { CROFT_NOW: iso(late) } }));
      expect(backup.data.lake.catalog.bytes).toBeGreaterThan(0);
      expect(existsSync(join(backup.data.path, "backup.json"))).toBe(true);
    }, 600_000);

    test("d. a week of hourly runs over five assets, then a pass: the snapshots, files and tables fall to what the kept versions need (acceptance 1)", async () => {
      await week;
    }, 900_000);
  });
}
