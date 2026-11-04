// croft maintain --orphans over a lake folder of more than one page of objects (S3 and R2 send at most 1,000 keys a call), the real command
// in this process against a Postgres catalog and the S3-compatible test store. DuckDB lists the folder a page at a time, and asks for each
// page after the first at the bucket's root, which a locked instance refuses unless the two warehouses of the command are told to allow it
// (db/modes.ts `listsBucket`). Found in the real-lake trial against R2. Allowing the bucket's root is the one boundary this widens, so the
// test also proves that the command never lists or deletes a file outside the lake's own folder: a second lake in the same bucket, a folder
// whose name starts with this lake's, a file at the bucket's root, and folders that sort before and after.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

const old = new Date(Date.now() - 3 * 86_400_000);
const plant = (f: string): string => {
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, "stray");
  utimesSync(f, old, old);
  return f;
};
/** Every file under a folder, with its time moved three days back so that anything the command could list, it would. */
function ageAll(dir: string, into: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name);
    if (e.isDirectory()) ageAll(f, into);
    else {
      utimesSync(f, old, old);
      into.push(f);
    }
  }
  return into;
}

describe("croft maintain --orphans on a folder of more than 1,000 objects", () => {
  maybe("lists and deletes every stray file of the lake's folder and nothing outside it", async () => {
    const l = await lakeProject("postgres", { extensionDir: ready.dir, rig });
    const other = await lakeProject("postgres", { extensionDir: ready.dir, rig });
    const bucketDir = dirname(l.shared!.files);
    expect(dirname(other.shared!.files)).toBe(bucketDir);
    // Not this lake's: every file of the second lake, old, and strays of its own; a folder that starts with this lake's name; a file at the
    // bucket's root; folders that sort before and after. All of them survive.
    const theirs = ageAll(other.shared!.files);
    const outside = [
      plant(join(other.shared!.files, "main", "orders", "other-stray.parquet")),
      plant(join(bucketDir, `${l.shared!.folder}-sib`, "main", "orders", "sibling.parquet")),
      plant(join(bucketDir, `${l.shared!.folder}x.parquet`)),
      plant(join(bucketDir, "root-stray.parquet")),
      plant(join(bucketDir, "000", "before.parquet")),
      plant(join(bucketDir, "zzz", "after.parquet")),
    ];
    const dir = join(l.shared!.files, "main", "orders");
    mkdirSync(dir, { recursive: true });
    const owned = readdirSync(dir).length;
    const strays = 1_150;
    for (let i = 0; i < strays; i++) plant(join(dir, `left-behind-${String(i).padStart(4, "0")}.parquet`));
    const run = async (p: typeof l, args: string[]) => {
      const r = await cli([...args, "--json"], { cwd: p.p.root, env: p.env });
      await closeAllWarehouses();
      return r;
    };
    const listed = await run(l, ["maintain", "--orphans", "--dry-run"]);
    expect(listed.exit, listed.stdout + listed.stderr).toBe(0);
    const files: string[] = listed.json.data.orphans.files;
    expect(files.length).toBe(strays);
    expect(new Set(files).size).toBe(strays);
    expect(files.filter((f) => !f.startsWith(`s3://${l.shared!.bucket}/${l.shared!.folder}/`))).toEqual([]);
    const asked = await run(l, ["maintain", "--orphans"]);
    expect(asked.exit, asked.stdout + asked.stderr).toBe(5);
    expect(asked.json.confirmation.impact.files).toBe(strays);
    const done = await run(l, ["confirm", asked.json.confirmation.token]);
    expect(done.exit, done.stdout + done.stderr).toBe(0);
    expect(done.json.data.result).toMatchObject({ status: "orphans_deleted", orphans: { deleted: strays } });
    expect(readdirSync(dir).length).toBe(owned);
    for (const f of [...outside, ...theirs]) expect(existsSync(f), f).toBe(true);
    expect((await run(l, ["query", "select count(*)::INT as n from orders"])).json.data.rows).toEqual([{ n: 20 }]);
    expect((await run(other, ["query", "select count(*)::INT as n from orders"])).json.data.rows).toEqual([{ n: 20 }]);
    // The bucket's root is allowed to the command's own warehouses only: a person's SQL cannot name another folder.
    const peek = await run(l, ["query", `select count(*) as n from glob('s3://${l.shared!.bucket}/${other.shared!.folder}/**')`]);
    expect(peek.exit).not.toBe(0);
  }, 600_000);
});
