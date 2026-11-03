// croft doctor on a lake (DESIGN.md D144; option 07, slice 2): the warehouse line reads the lake read-only, says where it is and who wrote it,
// and warns with LAKE_OTHER_WRITER when another machine has written since this machine's last write, which a lake cannot stop (one lake has
// one writing machine). Every machine keeps a record of its own, so one machine's write does not hide another's. The lake's folder line says
// what the folder must hold.
import { afterAll, describe, expect, test } from "bun:test";
import { extensionsReady } from "../../db/extension-dir-testkit.ts";
import { lakeOption } from "../../db/lake.ts";
import { closeAllWarehouses, openWarehouse } from "../../db/warehouse.ts";
import { ProjectEnv } from "../../project/env.ts";
import { cleanup, cli } from "./inspect-testkit.ts";
import { lakeProject } from "./lake-project-testkit.ts";

afterAll(async () => {
  delete process.env.CROFT_MACHINE_ID;
  await closeAllWarehouses();
  await cleanup();
});

const ready = extensionsReady(["httpfs", "postgres", "ducklake", "sqlite"]);
const maybe = ready.ready ? test : test.skip;
if (!ready.ready) console.warn(`[lake-doctor.test] SKIPPING: ${ready.skipReason}`);

const DAY = 86_400_000;
const at = (ms: number) => new Date(ms).toISOString();

describe("croft doctor on a lake", () => {
  maybe("says where the lake is and who wrote it; warns when another machine has written since this machine's last write, also after this machine wrote over it, for 7 days", async () => {
    const l = await lakeProject("local", { extensionDir: ready.dir });
    type Check = { id: string; status: string; text: string; details: Record<string, unknown>; code?: string };
    const T0 = Date.now();
    /** `croft doctor` as the machine `machine` (the default one when undefined), at `clock` (ms). */
    const doctorAs = async (machine?: string, clock = T0) => {
      if (machine) process.env.CROFT_MACHINE_ID = machine;
      else delete process.env.CROFT_MACHINE_ID;
      try {
        const r = await cli(["doctor", "--json"], { cwd: l.p.root, env: { ...l.env, CROFT_NOW: at(clock) } });
        const checks = (r.json as { data: { checks: Check[] } }).data.checks;
        await closeAllWarehouses(); // doctor read the lake in this process; the next writer is a writer
        return (id: string) => checks.find((c) => c.id === id)!;
      } finally {
        delete process.env.CROFT_MACHINE_ID;
      }
    };
    /** A write by `machine`, whose clock says `clock` (ms): the clock is what the machine puts in its record, the lake's commit order is not. */
    const writeAs = async (machine: string | undefined, run: string, clock = T0) => {
      if (machine) process.env.CROFT_MACHINE_ID = machine;
      else delete process.env.CROFT_MACHINE_ID;
      process.env.CROFT_NOW = at(clock);
      const w = openWarehouse({
        path: l.project.paths.database, mode: "read_write", timezone: l.project.timezone, root: l.project.root, stateDir: l.project.paths.stateDir,
        ...lakeOption(l.project, ProjectEnv.load(l.project.root, l.env)), isTTY: false, register: false,
      });
      try {
        await w.write("a write", (tx) => tx.exec("SELECT 1"), { runId: run });
      } finally {
        await w.close();
        await closeAllWarehouses();
        delete process.env.CROFT_MACHINE_ID;
        delete process.env.CROFT_NOW;
      }
    };

    // The lake was built by this machine (lakeProject ran croft here).
    const mine = await doctorAs();
    expect(mine("lake.folder").text).toContain("must hold nothing but this lake");
    expect(mine("warehouse").status).toBe("ok");
    expect(mine("warehouse").text).toContain("by this machine");
    expect(mine("warehouse").details).toMatchObject({ lake: "local", meta: { format_version: "4", bookkeeping: "log" } });

    // Another machine writes, with a clock three days BEHIND this one's: its record is older by the clocks and newer by the lake's order,
    // and the order is what counts. Doctor, on this machine, warns and names it, and when it wrote (by its own clock).
    await writeAs("another-machine", "r_other", T0 - 3 * DAY);
    const other = await doctorAs();
    expect(other("warehouse").status).toBe("warn");
    expect(other("warehouse").code).toBe("LAKE_OTHER_WRITER");
    expect(other("warehouse").text).toContain("has written this lake since this machine's last write");
    expect(other("warehouse").details).toMatchObject({ otherWriters: [{ run: "r_other", at: at(T0 - 3 * DAY) }] });

    // This machine writes over it, and its own write is the newest now; it still says another machine wrote between its two writes.
    await writeAs(undefined, "r_mine", T0);
    const over = await doctorAs();
    expect(over("warehouse").status).toBe("warn");
    expect(over("warehouse").code).toBe("LAKE_OTHER_WRITER");
    expect(over("warehouse").details).toMatchObject({ writer: { run: "r_mine", crossed: { run: "r_other" } } });

    // A later write of its own that finds nothing new does not clear it: it stays for 7 days from the write that found it.
    await writeAs(undefined, "r_mine_2", T0 + 1 * DAY);
    const later = await doctorAs(undefined, T0 + 1 * DAY);
    expect(later("warehouse").status).toBe("warn");
    expect(later("warehouse").details).toMatchObject({ writer: { run: "r_mine_2", crossed: { run: "r_other" } } });
    expect((await doctorAs(undefined, T0 + 6 * DAY))("warehouse").status).toBe("warn");
    // Past the 7 days it is gone from what doctor says, and the next write drops it from the record.
    expect((await doctorAs(undefined, T0 + 8 * DAY))("warehouse").status).toBe("ok");
    await writeAs(undefined, "r_mine_3", T0 + 8 * DAY);
    const quiet = await doctorAs(undefined, T0 + 8 * DAY);
    expect(quiet("warehouse").status).toBe("ok");
    expect(quiet("warehouse").details).toMatchObject({ writer: { run: "r_mine_3", crossed: null } });

    // The other machine, asking: this machine has written since its last write (its clock is behind, which does not matter).
    const theirs = await doctorAs("another-machine", T0 + 8 * DAY);
    expect(theirs("warehouse").status).toBe("warn");
    expect(theirs("warehouse").code).toBe("LAKE_OTHER_WRITER");

    // A machine that has never written is no competing writer: it is told who wrote, and nothing else.
    const reader = await doctorAs("a-machine-that-only-reads", T0 + 8 * DAY);
    expect(reader("warehouse").status).toBe("ok");
    expect(reader("warehouse").text).toContain("this machine has not written it");
  }, 240_000);

  maybe("the counter of a write follows the lake's order: one more than the largest any machine's record holds, whatever the clocks say", async () => {
    const l = await lakeProject("local", { extensionDir: ready.dir });
    const T0 = Date.now();
    const records = async () => {
      const w = openWarehouse({
        path: l.project.paths.database, mode: "read_only", timezone: l.project.timezone, root: l.project.root, stateDir: l.project.paths.stateDir,
        ...lakeOption(l.project, ProjectEnv.load(l.project.root, l.env)), isTTY: false, register: false,
      });
      try {
        const rows = await w.read((db) => db.all<{ key: string; value: string }>("SELECT key, value FROM _croft.meta WHERE key LIKE 'writer.%' ORDER BY key"), { purpose: "test" });
        return rows.map((r) => JSON.parse(r.value) as { machine: string; n: number; at: string });
      } finally {
        await w.close();
        await closeAllWarehouses();
      }
    };
    const write = async (machine: string, clock: number) => {
      process.env.CROFT_MACHINE_ID = machine;
      process.env.CROFT_NOW = at(clock);
      const w = openWarehouse({
        path: l.project.paths.database, mode: "read_write", timezone: l.project.timezone, root: l.project.root, stateDir: l.project.paths.stateDir,
        ...lakeOption(l.project, ProjectEnv.load(l.project.root, l.env)), isTTY: false, register: false,
      });
      try {
        await w.write("a write", (tx) => tx.exec("SELECT 1"), { runId: "r" });
      } finally {
        await w.close();
        await closeAllWarehouses();
        delete process.env.CROFT_MACHINE_ID;
        delete process.env.CROFT_NOW;
      }
    };
    const first = (await records()).map((r) => r.n); // the build by this machine: one write
    expect(first).toEqual([1]);
    await write("a", T0 + 5 * DAY); // a clock ahead
    await write("b", T0 - 5 * DAY); // a clock behind
    await write("a", T0 - 9 * DAY); // and a clock that went backwards
    expect((await records()).map((r) => r.n).sort((x, y) => x - y)).toEqual([1, 3, 4]); // this machine 1, b 3, a 4: the order of the commits
  }, 240_000);
});

describe("doctor's time for comparing tables (D-R7)", () => {
  test("a lake over a network gets more than the file's 400 ms, which never compared more than the first of its tables; one on this machine keeps the file's", async () => {
    const { lakeScanMs, TABLE_SCAN_LAKE_MS, TABLE_SCAN_MS } = await import("./doctor.ts");
    expect(lakeScanMs("postgres")).toBe(TABLE_SCAN_LAKE_MS);
    expect(TABLE_SCAN_LAKE_MS).toBeGreaterThanOrEqual(10 * TABLE_SCAN_MS);
    expect(lakeScanMs("local")).toBe(TABLE_SCAN_MS);
  });
});
