// croft wait through the real CLI: a detached child that dies before it records its run is reported crashed
// (exit 1), not "still running" (exit 6) forever.
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { closeAllWarehouses } from "../../db/warehouse.ts";
import { RunsDb } from "../../history/runs-db.ts";
import { readChildRecord } from "../../run/detach.ts";
import { cleanupProjects, cli, makeProject, until } from "../../run/testkit.ts";

afterAll(async () => {
  await closeAllWarehouses();
  cleanupProjects();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("croft wait", () => {
  test("a child killed before it recorded its run is crashed, and wait says so at once", async () => {
    // Top-level work keeps the child in planning (before the run record) for 4 s (the parent plans first, too).
    const root = makeProject({ "assets/slow_load.ts": `import { ingest } from "@zabaca/croft";
await new Promise((r) => setTimeout(r, 4000));
export default ingest({ async *rows() { yield [{ id: 1 }]; } });
` });
    const r = await cli(root, ["run", "slow_load", "--json", "--follow", "0.5s"]);
    expect(r.code).toBe(6);
    const runId = r.json!.data.runId as string;
    const stateDir = join(root, ".croft");
    const child = readChildRecord(stateDir, runId)!;
    expect(child).not.toBeNull();
    expect(alive(child.pid)).toBe(true);

    // Still starting: exit 6.
    const starting = await cli(root, ["wait", runId, "--timeout", "0.3s", "--json"]);
    expect(starting.code).toBe(6);

    process.kill(child.pid, "SIGKILL");
    await until(() => !alive(child.pid));
    for (let i = 0; i < 2; i++) {
      const t0 = Date.now();
      const w = await cli(root, ["wait", runId, "--timeout", "5s", "--json"]);
      expect(w.code).toBe(1);
      expect(Date.now() - t0).toBeLessThan(4_000);
      expect(w.json).toMatchObject({ ok: false, command: "wait", data: { runId, status: "crashed", steps: [] } });
      expect(w.json!.problems[0]).toMatchObject({ code: "RUN_CRASHED", runId });
    }
    const db = RunsDb.open(stateDir);
    try {
      expect(db.getRun(runId)).toBeNull();
    } finally {
      db.close();
    }
  }, 60_000);
});
