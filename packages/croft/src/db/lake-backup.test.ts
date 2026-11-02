// `croft backup` of a lake (db/lake-backup.ts; DESIGN.md D151; option 07, slice 3): a project whose warehouse is a lake, backed up by the real
// command in this process, and put back by the steps `croft docs backup` gives, into a fresh catalog and a fresh bucket folder (or a fresh SQLite
// catalog and folder), where the same tables, rows and bookkeeping read back. A Postgres and an S3-compatible store are children of this test.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { cleanup, cli } from "../cli/commands/inspect-testkit.ts";
import { lakeProject, type LakeProject, ORDERS_SQL } from "../cli/commands/lake-project-testkit.ts";
import { lakeRigReady, type LakeRig, READER_LOGIN, startLakeRig, WRITER_LOGIN } from "./lake-testkit.ts";
import { findPgDump } from "./lake-backup.ts";
import { backupRunning, markBackupRunning } from "./lake.ts";
import { closeAllWarehouses } from "./warehouse.ts";

const ready = lakeRigReady();
if (!ready.ready) console.warn(`[lake-backup.test] SKIPPING: ${ready.skipReason}`);
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

const run = async (l: LakeProject, args: string[], env: Record<string, string> = {}) => {
  const r = await cli([...args, "--json"], { cwd: l.p.root, env: { ...l.env, ...env } });
  await closeAllWarehouses();
  return r;
};

/** Everything a lake holds that a person can read: the tables of main and croft's own bookkeeping, as rows. */
async function snapshotOf(l: LakeProject): Promise<Record<string, unknown>> {
  const names = (await run(l, ["query", "select table_schema || '.' || table_name as t from information_schema.tables where table_schema in ('main', '_croft') order by 1"])).json.data.rows.map((r: { t: string }) => r.t) as string[];
  const out: Record<string, unknown> = {};
  for (const t of names) {
    const rows = (await run(l, ["query", `select * from ${t}`, "--limit", "10000", "--full-values"])).json.data.rows as Record<string, unknown>[];
    // Row order is not part of what a table holds; the bookkeeping's own order number is, and it is in the rows.
    out[t] = rows.map((r) => JSON.stringify(r)).sort();
  }
  return out;
}

/** The files under a folder, relative, with sizes. */
function tree(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of readdirSync(dir, { recursive: true }).map(String).sort()) if (statSync(join(dir, f)).isFile()) out[f] = statSync(join(dir, f)).size;
  return out;
}

describe("croft backup of a lake", () => {
  maybe("a local lake: the catalog, the folder, run history and the trash are copied as one moment, and put back into a fresh lake they read back equal", async () => {
    const l = await lakeProject("local", { extensionDir: ready.dir });
    const before = await snapshotOf(l);
    const made = await run(l, ["backup"]);
    expect(made.exit, made.stdout + made.stderr).toBe(0);
    const b = made.json.data;
    expect(b.lake).toMatchObject({ kind: "local", catalog: { file: "catalog.sqlite", tool: "sqlite VACUUM INTO" }, data: { dir: "lake-data", reused: 0 } });
    expect(b.lake.data.files).toBeGreaterThan(0);
    expect(b.lake.snapshot).toBeGreaterThan(0);
    expect(Object.keys(tree(b.path)).sort()).toEqual(expect.arrayContaining(["backup.json", "catalog.sqlite", "runs.sqlite"]));
    const manifest = JSON.parse(readFileSync(join(b.path, "backup.json"), "utf8"));
    expect(manifest.lake).toMatchObject({ kind: "local", snapshot: b.lake.snapshot });
    expect(JSON.stringify(manifest)).not.toMatch(/password|secret/i);
    // Put back (croft docs backup): the catalog and the folder to a new place, the stored folder path changed, and the project pointed at them.
    const root2 = join(dirname(l.p.root), `${basename(l.p.root)}-restored`);
    mkdirSync(join(root2, "lake"), { recursive: true });
    cpSync(join(b.path, "catalog.sqlite"), join(root2, "lake", "catalog.sqlite"));
    cpSync(join(b.path, "lake-data"), join(root2, "lake", "data"), { recursive: true });
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(root2, "lake", "catalog.sqlite"));
    db.run("UPDATE ducklake_metadata SET value = ? WHERE key = 'data_path'", [`${join(root2, "lake", "data")}/`]);
    db.close();
    cpSync(join(l.p.root, "croft.json"), join(root2, "croft.json"));
    cpSync(join(l.p.root, "assets"), join(root2, "assets"), { recursive: true });
    mkdirSync(join(root2, "node_modules", "@zabaca"), { recursive: true });
    cpSync(join(l.p.root, "node_modules", "@zabaca"), join(root2, "node_modules", "@zabaca"), { recursive: true, verbatimSymlinks: true });
    mkdirSync(join(root2, ".croft"), { recursive: true });
    cpSync(join(b.path, "runs.sqlite"), join(root2, ".croft", "runs.sqlite"));
    const l2: LakeProject = { ...l, p: { ...l.p, root: root2 } };
    expect(await snapshotOf(l2)).toEqual(before);
    const status = await run(l2, ["status"]);
    expect(status.exit).toBe(0);
    expect(status.json.data.assets[0]).toMatchObject({ asset: "orders", status: "ok" });
  }, 240_000);

  maybe("a Postgres lake: pg_dump of the catalog and a mirror of the bucket folder; a second backup reuses the files the first holds; it restores to a fresh catalog and a fresh bucket (acceptance 7)", async () => {
    const pgDump = findPgDump(process.env);
    expect(pgDump, "pg_dump is needed for this test").not.toBeNull();
    const l = await lakeProject("postgres", { extensionDir: ready.dir, rig });
    const before = await snapshotOf(l);
    const first = await run(l, ["backup"], { CROFT_PG_DUMP: pgDump! });
    expect(first.exit, first.stdout + first.stderr).toBe(0);
    const a = first.json.data;
    expect(a.lake).toMatchObject({ kind: "postgres", catalog: { file: "catalog.dump" }, data: { dir: "lake-data", reused: 0 } });
    expect(a.lake.catalog.tool).toMatch(/pg_dump/);
    // The mirror is the store's folder, file for file.
    const stored = tree(join(rig.s3.root, l.shared!.bucket, l.shared!.folder));
    expect(Object.keys(stored).length).toBeGreaterThan(0);
    expect(tree(join(a.path, "lake-data"))).toEqual(stored);
    expect(a.lake.data.files).toBe(Object.keys(stored).length);
    expect(existsSync(join(a.path, "catalog.dump"))).toBe(true);
    // No credential in the manifest, the output, or the dump's tool line.
    for (const secret of [WRITER_LOGIN.password, READER_LOGIN.password]) expect(first.stdout + readFileSync(join(a.path, "backup.json"), "utf8")).not.toContain(secret);
    // A change, then a second backup: the files that were there are linked, not downloaded again.
    writeFileSync(join(l.p.root, "assets", "orders.sql"), ORDERS_SQL.replace("range % 7", "range % 5"));
    expect((await run(l, ["run", "orders", "--foreground"])).exit).toBe(0);
    const after = await snapshotOf(l);
    expect(after).not.toEqual(before);
    const second = await run(l, ["backup"], { CROFT_PG_DUMP: pgDump! });
    expect(second.exit, second.stdout + second.stderr).toBe(0);
    expect(second.json.data.path).not.toBe(a.path);
    expect(second.json.data.lake.data.reused).toBeGreaterThanOrEqual(Object.keys(stored).length);
    expect(second.json.data.lake.snapshot).toBeGreaterThan(a.lake.snapshot);
    // Put back, as `croft docs backup` says: a fresh database and a fresh folder, the dump restored as the writer, the files copied, the stored
    // folder changed, and a project pointed at them.
    const fresh = await rig.lake();
    const bin = dirname(pgDump!);
    const pgRestore = join(bin, "pg_restore");
    const restored = Bun.spawnSync([pgRestore, "--no-owner", "--host", rig.pg.host, "--port", String(rig.pg.port), "--username", WRITER_LOGIN.user, "--dbname", fresh.db, join(second.json.data.path, "catalog.dump")],
      { env: { PATH: "/usr/bin:/bin", PGPASSWORD: WRITER_LOGIN.password }, stdout: "pipe", stderr: "pipe" });
    expect(restored.exitCode, restored.stderr.toString()).toBe(0);
    const target = join(rig.s3.root, fresh.bucket, fresh.folder);
    cpSync(join(second.json.data.path, "lake-data"), target, { recursive: true });
    await rig.pg.sql(`UPDATE ducklake_metadata SET value = 's3://${fresh.bucket}/${fresh.folder}/' WHERE key = 'data_path'`, fresh.db);
    const root2 = join(dirname(l.p.root), `${basename(l.p.root)}-restored`);
    mkdirSync(join(root2, ".croft"), { recursive: true });
    cpSync(join(l.p.root, "assets"), join(root2, "assets"), { recursive: true });
    mkdirSync(join(root2, "node_modules", "@zabaca"), { recursive: true });
    cpSync(join(l.p.root, "node_modules", "@zabaca"), join(root2, "node_modules", "@zabaca"), { recursive: true, verbatimSymlinks: true });
    cpSync(join(second.json.data.path, "runs.sqlite"), join(root2, ".croft", "runs.sqlite"));
    const config = JSON.parse(readFileSync(join(l.p.root, "croft.json"), "utf8"));
    writeFileSync(join(root2, "croft.json"), JSON.stringify({ ...config, lake: fresh.block }));
    writeFileSync(join(root2, ".env"), Object.entries(fresh.env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
    const l2: LakeProject = { ...l, p: { ...l.p, root: root2 }, env: { CROFT_EXTENSION_DIR: ready.dir }, shared: fresh };
    expect(await snapshotOf(l2)).toEqual(after);
    // The restored lake is a lake like any: a run changes nothing, and writes go to the fresh bucket only.
    const again = await run(l2, ["run", "orders", "--foreground"]);
    expect(again.exit, again.stdout + again.stderr).toBe(0);
    expect(again.json.data.steps[0]).toMatchObject({ asset: "orders", rows: { added: 0, updated: 0, deleted: 0, unchanged: 20 } });
    rmSync(root2, { recursive: true, force: true });
  }, 420_000);

  maybe("a project with no pg_dump is told before anything is written; a lake nobody has written has nothing to back up; a backup copying keeps passes away", async () => {
    const l = await lakeProject("postgres", { extensionDir: ready.dir, rig });
    const none = await run(l, ["backup"], { CROFT_PG_DUMP: "/nowhere/pg_dump" });
    expect(none.exit).toBe(2);
    expect(none.json.problems[0]).toMatchObject({ code: "LAKE_BACKUP_TOOL_MISSING", effect: "nothing was written" });
    expect(existsSync(join(l.p.stateDir, "backups"))).toBe(false);
    // A marker of a running backup is seen by this machine's maintenance, and gone when the backup is.
    const done = markBackupRunning(l.p.stateDir);
    expect(backupRunning(l.p.stateDir)).not.toBeNull();
    done();
    expect(backupRunning(l.p.stateDir)).toBeNull();
  }, 240_000);
});
