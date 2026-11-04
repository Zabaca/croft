// croft maintain --orphans over a lake folder of more than one page of objects (S3 and R2 send at most 1,000 keys a call), the real command
// in this process against a Postgres catalog and the S3-compatible test store. DuckDB lists the folder a page at a time, and asks for each
// page after the first at the bucket's root, which a locked instance refuses unless the two warehouses of the command are told to allow it
// (db/modes.ts `listsBucket`). Found in the real-lake trial against R2.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lakeRigReady, type LakeRig, startLakeRig } from "../../db/lake-testkit.ts";
import { closeAllWarehouses } from "../../db/warehouse.ts";
import { cleanup, cli } from "./inspect-testkit.ts";
import { lakeProject } from "./lake-project-testkit.ts";

const ready = lakeRigReady();
if (!ready.ready) console.warn(`[maintain-orphans-bucket.test] SKIPPING: ${ready.skipReason}`);
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

describe("croft maintain --orphans on a folder of more than 1,000 objects", () => {
  maybe("lists and deletes every stray file, not the first page of them", async () => {
    const l = await lakeProject("postgres", { extensionDir: ready.dir, rig });
    const dir = join(l.shared!.files, "main", "orders");
    mkdirSync(dir, { recursive: true });
    const owned = readdirSync(dir).length;
    const strays = 1_150;
    const old = new Date(Date.now() - 3 * 86_400_000);
    for (let i = 0; i < strays; i++) {
      const f = join(dir, `left-behind-${String(i).padStart(4, "0")}.parquet`);
      writeFileSync(f, "stray");
      utimesSync(f, old, old);
    }
    const run = async (args: string[]) => {
      const r = await cli([...args, "--json"], { cwd: l.p.root, env: l.env });
      await closeAllWarehouses();
      return r;
    };
    const listed = await run(["maintain", "--orphans", "--dry-run"]);
    expect(listed.exit, listed.stdout + listed.stderr).toBe(0);
    expect(listed.json.data.orphans.files.length).toBe(strays);
    expect(new Set(listed.json.data.orphans.files).size).toBe(strays);
    const asked = await run(["maintain", "--orphans"]);
    expect(asked.exit, asked.stdout + asked.stderr).toBe(5);
    expect(asked.json.confirmation.impact.files).toBe(strays);
    const done = await run(["confirm", asked.json.confirmation.token]);
    expect(done.exit, done.stdout + done.stderr).toBe(0);
    expect(done.json.data.result).toMatchObject({ status: "orphans_deleted", orphans: { deleted: strays } });
    expect(readdirSync(dir).length).toBe(owned);
    expect(existsSync(join(l.shared!.files, "main"))).toBe(true);
    const q = await run(["query", "select count(*)::INT as n from orders"]);
    expect(q.json.data.rows).toEqual([{ n: 20 }]);
  }, 300_000);
});
