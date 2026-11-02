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

describe("croft doctor on a lake", () => {
  maybe("says where the lake is and who wrote it; warns when another machine has written since this machine's last write, also after this machine wrote over it", async () => {
    const l = await lakeProject("local", { extensionDir: ready.dir });
    type Check = { id: string; status: string; text: string; details: Record<string, unknown>; code?: string };
    /** `croft doctor` as the machine `machine` (the default one when undefined). */
    const doctorAs = async (machine?: string) => {
      if (machine) process.env.CROFT_MACHINE_ID = machine;
      else delete process.env.CROFT_MACHINE_ID;
      try {
        const r = await cli(["doctor", "--json"], { cwd: l.p.root, env: l.env });
        const checks = (r.json as { data: { checks: Check[] } }).data.checks;
        await closeAllWarehouses(); // doctor read the lake in this process; the next writer is a writer
        return (id: string) => checks.find((c) => c.id === id)!;
      } finally {
        delete process.env.CROFT_MACHINE_ID;
      }
    };
    const writeAs = async (machine: string | undefined, run: string) => {
      if (machine) process.env.CROFT_MACHINE_ID = machine;
      else delete process.env.CROFT_MACHINE_ID;
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
      }
    };

    // The lake was built by this machine (lakeProject ran croft here).
    const mine = await doctorAs();
    expect(mine("lake.folder").text).toContain("must hold nothing but this lake");
    expect(mine("warehouse").status).toBe("ok");
    expect(mine("warehouse").text).toContain("by this machine");
    expect(mine("warehouse").details).toMatchObject({ lake: "local", meta: { format_version: "4", bookkeeping: "log" } });

    // Another machine writes: doctor, on this one, warns and names it.
    await writeAs("another-machine", "r_other");
    const other = await doctorAs();
    expect(other("warehouse").status).toBe("warn");
    expect(other("warehouse").code).toBe("LAKE_OTHER_WRITER");
    expect(other("warehouse").text).toContain("has written this lake since this machine's last write");
    expect(other("warehouse").details).toMatchObject({ otherWriters: [{ run: "r_other" }] });

    // This machine writes over it: its own write is the newest now, and it still says another machine wrote between its two writes.
    await writeAs(undefined, "r_mine");
    const over = await doctorAs();
    expect(over("warehouse").status).toBe("warn");
    expect(over("warehouse").code).toBe("LAKE_OTHER_WRITER");
    expect(over("warehouse").details).toMatchObject({ writer: { run: "r_mine", crossed: { run: "r_other" } } });

    // Its next write found nothing new: the warning is gone.
    await writeAs(undefined, "r_mine_2");
    const quiet = await doctorAs();
    expect(quiet("warehouse").status).toBe("ok");
    expect(quiet("warehouse").details).toMatchObject({ writer: { run: "r_mine_2", crossed: null } });

    // The other machine, asking: this machine has written since its last write.
    const theirs = await doctorAs("another-machine");
    expect(theirs("warehouse").status).toBe("warn");
    expect(theirs("warehouse").code).toBe("LAKE_OTHER_WRITER");

    // A machine that has never written is no competing writer: it is told who wrote, and nothing else.
    const reader = await doctorAs("a-machine-that-only-reads");
    expect(reader("warehouse").status).toBe("ok");
    expect(reader("warehouse").text).toContain("this machine has not written it");
  }, 180_000);
});
