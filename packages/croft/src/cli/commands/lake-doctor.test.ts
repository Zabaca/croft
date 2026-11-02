// croft doctor on a lake (DESIGN.md D144; option 07, slice 2): the warehouse line reads the lake read-only, says where it is and who wrote it last,
// and warns with LAKE_OTHER_WRITER when that was another machine, which a lake cannot stop (one lake has one writing machine). The lake's folder
// line says what the folder must hold.
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
  maybe("says where the lake is and that this machine wrote it; warns when another machine wrote since; is quiet again after a write here", async () => {
    const l = await lakeProject("local", { extensionDir: ready.dir });
    type Check = { id: string; status: string; text: string; details: Record<string, unknown>; code?: string };
    const doctor = async () => {
      const r = await cli(["doctor", "--json"], { cwd: l.p.root, env: l.env });
      const checks = (r.json as { data: { checks: Check[] } }).data.checks;
      await closeAllWarehouses(); // doctor read the lake in this process; the next writer is a writer
      return (id: string) => checks.find((c) => c.id === id)!;
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

    const mine = await doctor();
    expect(mine("lake.folder").text).toContain("must hold nothing but this lake");
    expect(mine("warehouse").status).toBe("ok");
    expect(mine("warehouse").text).toContain("by this machine");
    expect(mine("warehouse").details).toMatchObject({ lake: "local", meta: { format_version: "4", bookkeeping: "log" } });

    // Another machine writes: doctor, on this one, warns and names it.
    await writeAs("another-machine", "r_other");
    const other = await doctor();
    expect(other("warehouse").status).toBe("warn");
    expect(other("warehouse").code).toBe("LAKE_OTHER_WRITER");
    expect(other("warehouse").text).toContain("another machine");
    expect(other("warehouse").details).toMatchObject({ writer: { run: "r_other" } });

    // This machine writes again: its record is the last, and the warning is gone.
    await writeAs(undefined, "r_mine");
    const again = await doctor();
    expect(again("warehouse").status).toBe("ok");
    expect(again("warehouse").details).toMatchObject({ writer: { run: "r_mine" } });
  }, 120_000);
});
