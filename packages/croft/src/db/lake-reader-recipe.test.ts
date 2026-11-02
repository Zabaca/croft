// The recipe for reading a lake from your own DuckDB (option 07, slice 2, acceptance 10; `croft docs lake`): a separate DuckDB with a read-only
// catalog login and a read-only bucket key, made as the docs say, attaches the lake croft wrote and reads a table; its attempts to write a table,
// a file in the bucket or the catalog are refused. The test runs the docs' own SQL (the fenced blocks `postgres-admin` and `duckdb-reader` of
// src/agent/docs/lake.md, with the placeholders filled in), so what is published is what was tried. The only change is INSTALL, which fetches
// the extensions once for a person and is a LOAD of the pinned files here (this test never reaches the network).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { lakeProject } from "../cli/commands/lake-project-testkit.ts";
import { DOCS_DIR } from "../cli/commands/docs.ts";
import { extensionPath, hostPlatform } from "./extension-files.ts";
import { lakeRigReady, type LakeRig, READER_KEY, startLakeRig, WRITER_LOGIN } from "./lake-testkit.ts";
import { closeAllWarehouses } from "./warehouse.ts";

const ready = lakeRigReady();
if (!ready.ready) console.warn(`[lake-reader-recipe.test] SKIPPING the recipe test: ${ready.skipReason}`);
const maybe = ready.ready ? test : test.skip;

let rig: LakeRig;
beforeAll(async () => {
  if (ready.ready) rig = await startLakeRig();
}, 120_000);
afterAll(async () => {
  await closeAllWarehouses();
  await rig?.stop();
});

/** The fenced block of the docs page with this info string (` ```sql postgres-admin `). */
function block(info: string): string {
  const page = readFileSync(join(DOCS_DIR, "lake.md"), "utf8");
  const m = new RegExp("```sql " + info + "\\n([\\s\\S]*?)```").exec(page);
  if (!m) throw new Error(`lake.md has no \`\`\`sql ${info} block`);
  return m[1]!;
}

const fill = (text: string, v: Record<string, string>): string => text.replace(/<(\w+)>/g, (_m, k: string) => {
  if (!(k in v)) throw new Error(`the recipe has a placeholder <${k}> this test does not know`);
  return v[k]!;
});

/** The statements of a block: split where a semicolon ends a line, or a line holds several INSTALLs. */
const statements = (text: string): string[] => text.split(/;\s*(?:\n|$)|;\s+(?=INSTALL)/).map((s) => s.trim()).filter(Boolean);

describe("the docs' recipe for reading a lake from your own DuckDB", () => {
  maybe("a read-only login and key, made as the docs say, read a table croft wrote and cannot write a table, a file or the catalog", async () => {
    const l = await lakeProject("postgres", { extensionDir: ready.dir, rig });
    const lake = l.shared!;
    const database = (lake.block as { catalog: { database: string } }).catalog.database;
    const v = {
      analyst: "analyst_reader", analyst_password: "An4lyst-pw-Hk27", database, writer: WRITER_LOGIN.user,
      host: rig.pg.host, port: String(rig.pg.port), key_id: READER_KEY.id, key_secret: READER_KEY.secret, endpoint: rig.s3.endpoint,
      use_ssl: "false", bucket: lake.bucket, folder: lake.folder,
    };
    // The person who runs the Postgres makes the login, from the docs' block.
    await rig.pg.sql(fill(block("postgres-admin"), v), database);

    // The analyst, in their own DuckDB (not croft's connection: no sandbox, no lockdown, only their own SQL). INSTALL becomes a LOAD of the
    // pinned file of the same extension.
    const platform = hostPlatform()!;
    const instance = await DuckDBInstance.create(":memory:", { autoinstall_known_extensions: "false", autoload_known_extensions: "false" });
    const c = await instance.connect();
    try {
      for (const s of statements(fill(block("duckdb-reader"), v))) {
        const install = /^INSTALL\s+(\w+)$/i.exec(s);
        if (install) await c.run(`LOAD '${extensionPath(ready.dir, (install[1] === "postgres" ? "postgres" : install[1]) as never, platform)}'`);
        else await c.run(s);
      }
      const rows = async (sql: string) => (await c.runAndReadAll(sql)).getRowsJS();
      const fails = async (sql: string) => c.run(sql).then(() => "", (e: Error) => e.message);

      // It reads what croft wrote ...
      expect(Number((await rows("SELECT count(*) FROM orders"))[0]![0])).toBe(20);
      expect(Number((await rows("SELECT count(*) FROM lake.snapshots()"))[0]![0])).toBeGreaterThan(0);
      // ... and cannot write a table's rows, a table, a file in the bucket, or the catalog.
      expect(await fails("INSERT INTO orders (id, k, note) VALUES (99, 1, 'x')")).toMatch(/read-only/i);
      expect(await fails("CREATE TABLE evil (a INT)")).toMatch(/read-only/i);
      const before = readdirSync(lake.files).length;
      expect(await fails(`COPY (SELECT 1 AS a) TO 's3://${lake.bucket}/${lake.folder}/evil.parquet'`)).toMatch(/403|Forbidden|Access Denied/i);
      expect(existsSync(join(lake.files, "evil.parquet"))).toBe(false);
      expect(readdirSync(lake.files).length).toBe(before);
      expect(await fails(`CALL postgres_execute('__ducklake_metadata_lake', 'DROP TABLE ducklake_snapshot')`)).toMatch(/permission denied|must be owner|read-only transaction/i);
      expect(Number((await rows("SELECT count(*) FROM orders"))[0]![0])).toBe(20);
    } finally {
      c.disconnectSync();
      instance.closeSync();
    }
  }, 120_000);

  // Acceptance 11: a lake croft writes is read by an older DuckDB (1.5.x), because the lake is format 1.0. The older DuckDB is not a dependency, so
  // the test runs when CROFT_TEST_OLD_DUCKDB names a folder with `@duckdb/node-api` of that version installed and CROFT_TEST_OLD_EXTENSIONS a folder
  // holding its postgres_scanner, httpfs and ducklake files; otherwise it is skipped (the run of record is in DESIGN.md D147).
  const oldNode = process.env.CROFT_TEST_OLD_DUCKDB;
  const oldExt = process.env.CROFT_TEST_OLD_EXTENSIONS;
  const maybeOld = ready.ready && oldNode && oldExt ? test : test.skip;
  maybeOld("an older DuckDB (1.5.x), run as the docs say, reads the lake croft wrote", async () => {
    const l = await lakeProject("postgres", { extensionDir: ready.dir, rig });
    const lake = l.shared!;
    const database = (lake.block as { catalog: { database: string } }).catalog.database;
    const v = {
      analyst: "old_reader", analyst_password: "An4lyst-pw-Hk27", database, writer: WRITER_LOGIN.user,
      host: rig.pg.host, port: String(rig.pg.port), key_id: READER_KEY.id, key_secret: READER_KEY.secret, endpoint: rig.s3.endpoint,
      use_ssl: "false", bucket: lake.bucket, folder: lake.folder,
    };
    await rig.pg.sql(fill(block("postgres-admin"), v), database);
    const ext = (name: string): string => join(oldExt!, `${name === "postgres" ? "postgres_scanner" : name}.duckdb_extension`);
    const run = statements(fill(block("duckdb-reader"), v)).map((s) => {
      const install = /^INSTALL\s+(\w+)$/i.exec(s);
      return install ? `LOAD '${ext(install[1]!)}'` : s;
    });
    const script = `import { createRequire } from "node:module";
      const { DuckDBInstance, version } = createRequire(${JSON.stringify(join(oldNode!, "x.js"))})("@duckdb/node-api");
      const i = await DuckDBInstance.create(":memory:", { autoinstall_known_extensions: "false", autoload_known_extensions: "false" });
      const c = await i.connect();
      for (const s of ${JSON.stringify(run)}) await c.run(s);
      const n = Number((await c.runAndReadAll("SELECT count(*) FROM orders")).getRowsJS()[0][0]);
      const v = (await c.runAndReadAll("SELECT version()")).getRowsJS()[0][0];
      console.log(JSON.stringify({ n, v }));`;
    const proc = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(await proc.exited, err).toBe(0);
    const got = JSON.parse(out.trim().split("\n").pop()!) as { n: number; v: string };
    expect(got.v).toMatch(/^v1\.5\./);
    expect(got.n).toBe(20);
  }, 120_000);
});
