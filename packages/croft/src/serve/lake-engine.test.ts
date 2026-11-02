// croft serve over a lake (option 07, slice 2, acceptance 4; DESIGN.md D143): the lake engine reads the lake's last snapshot with the
// read-only login and bucket key, in a child process, and never steps aside. While a write step is held open for ten seconds it answers a
// hundred queries from the last commit, with no step-aside and no 503. On that attach, with the gate left out, a write to a table is refused
// by the read-only attach, a COPY into the lake's folder by the store (the key cannot write), and the catalog by the read-only login.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { lakeProject, type LakeProject } from "../cli/commands/lake-project-testkit.ts";
import { CroftError } from "../core/errors.ts";
import { connect, openMemoryInstance } from "../db/connect.ts";
import { lakeConnection } from "../db/lake.ts";
import { lakeRigReady, type LakeRig, startLakeRig } from "../db/lake-testkit.ts";
import { closeAllWarehouses, openWarehouse } from "../db/warehouse.ts";
import { ProjectEnv } from "../project/env.ts";
import { Rigs } from "./key-rig-testkit.ts";
import { openLakeEngine } from "./lake-engine.ts";

const ready = lakeRigReady();
if (!ready.ready) console.warn(`[lake-engine.test] SKIPPING the lake serve tests: ${ready.skipReason}`);
const maybe = ready.ready ? describe : describe.skip;

let rig: LakeRig;
const rigs = new Rigs();
beforeAll(async () => {
  if (ready.ready) rig = await startLakeRig();
}, 120_000);
afterAll(async () => {
  await rigs.close();
  await closeAllWarehouses();
  await rig?.stop();
});

const TOKEN = "app-token-for-key-tests";

for (const kind of ["local", "postgres"] as const) {
  maybe(`croft serve over a ${kind} lake`, () => {
    let l: LakeProject;
    let serve: Awaited<ReturnType<Rigs["rig"]>>;
    let engineStatus: () => ReturnType<Awaited<ReturnType<typeof openLakeEngine>>["status"]>;
    beforeAll(async () => {
      l = await lakeProject(kind, { extensionDir: ready.dir, rig });
      const engine = await openLakeEngine({ root: l.p.root, env: ProjectEnv.load(l.p.root, l.env), extensionDir: ready.dir, resources: { threads: 2 } });
      rigs.engines.push(engine);
      engineStatus = () => engine.status();
      serve = await rigs.rig({ ...l.p, database: l.project.paths.database } as never, engine, { sharedTables: [] });
    }, 120_000);

    test("answers a hundred queries from the last snapshot while a write step is held open for ten seconds: no step-aside, no 503", async () => {
      const lake = lakeConnection(l.project, ProjectEnv.load(l.p.root, l.env), { extensionDir: ready.dir })!;
      const w = openWarehouse({
        path: l.project.paths.database, mode: "read_write", timezone: l.project.timezone, root: l.p.root, stateDir: l.project.paths.stateDir, lake,
        register: false, isTTY: false,
      });
      let inside!: () => void;
      const entered = new Promise<void>((resolve) => (inside = resolve));
      const held = w.write("a long write", async (tx) => {
        await tx.exec("INSERT INTO orders (id, k, note) SELECT 1000 + range, 0, 'new' FROM range(5)");
        inside();
        await Bun.sleep(10_000);
      }, { runId: "r_long", asset: "orders" });
      await entered;
      const started = Date.now();
      const statuses: number[] = [];
      const counts = new Set<number>();
      let sent = 0;
      while (sent < 100 || Date.now() - started < 9_000) {
        const batch = await Promise.all(Array.from({ length: 4 }, () => serve.call(TOKEN, "SELECT count(*) AS n FROM orders")));
        for (const x of batch) {
          statuses.push(x.status);
          if (x.status === 200) counts.add(Number(x.json.data.rows[0].n));
        }
        sent += batch.length;
        if (sent >= 100 && Date.now() - started >= 9_000) break;
        await Bun.sleep(50);
      }
      expect(sent).toBeGreaterThanOrEqual(100);
      expect(statuses.every((s) => s === 200), `statuses: ${[...new Set(statuses)].join(", ")}`).toBe(true);
      // The last snapshot, whole: the uncommitted five rows are never seen.
      expect([...counts]).toEqual([20]);
      expect(engineStatus()).toMatchObject({ state: "open", writeIntent: null });
      expect(Date.now() - started).toBeGreaterThanOrEqual(9_000);
      await held;
      // The commit lands, and the next query sees it.
      const after = await serve.call(TOKEN, "SELECT count(*) AS n FROM orders");
      expect(after.json.data.rows[0].n).toBe(25);
      await w.close();
    }, 90_000);

    test("a connection that got past the gate still cannot write a table, write a file into the lake's folder, or touch the catalog", async () => {
      const lake = lakeConnection(l.project, ProjectEnv.load(l.p.root, l.env), { extensionDir: ready.dir })!;
      const instance = await openMemoryInstance();
      const c = await connect(instance, { profile: "serve", timezone: "UTC", mode: lake.mode("read") }, ":memory:lake-bypass");
      try {
        await c.run("USE lake");
        const read = async (sql: string): Promise<unknown[][]> => (await c.runAndReadAll(sql)).getRowsJS();
        // It reads the lake (it is attached with real credentials) ...
        expect(Number((await read("SELECT count(*) FROM orders"))[0]![0])).toBeGreaterThan(0);
        // ... read-only: DuckDB refuses the write before any credential is asked.
        expect(await c.run("INSERT INTO orders (id, k, note) VALUES (1, 1, 'x')").then(() => "", (e: Error) => e.message)).toMatch(/read-only/i);
        expect(await c.run("CREATE TABLE evil (a INT)").then(() => "", (e: Error) => e.message)).toMatch(/read-only/i);
        // A COPY is not a write to the lake, and DuckDB allows it on a read-only attach: only the key that cannot write keeps it out.
        // That holds for a lake in a bucket. A local lake has no key: its folder is the user's own, and a connection past the gate could
        // write there (croft docs lake says so; it is a lake for one machine and development, where the gate is the only wall).
        if (kind === "postgres") {
          const folder = l.shared!.files;
          const before = readdirSync(folder).length;
          const copy = await c.run(`COPY (SELECT 1 AS a) TO '${l.bucket}evil.parquet'`).then(() => "", (e: Error) => e.message);
          expect(copy, "a COPY into the lake's folder").toMatch(/403|Forbidden|Access Denied/i);
          expect(existsSync(join(folder, "evil.parquet"))).toBe(false);
          expect(readdirSync(folder).length).toBe(before);
        }
        if (kind === "postgres") {
          // The catalog: the gate would refuse postgres_execute; past it, the read-only login has no right to change anything.
          const raw = await c.run("CALL postgres_execute('__ducklake_metadata_lake', 'DROP TABLE ducklake_snapshot')").then(() => "", (e: Error) => e.message);
          expect(raw).toMatch(/permission denied|must be owner|read-only|not allowed/i);
          expect(Number((await read("SELECT count(*) FROM orders"))[0]![0])).toBeGreaterThan(0);
        }
      } finally {
        c.disconnectSync();
        instance.closeSync();
      }
    }, 60_000);

    test("a key is refused: it works in server mode only, and this engine says so", async () => {
      const key = serve.key("somebody");
      const x = await serve.call(key, "SELECT 1 AS n");
      expect(x.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(x.json)).toContain("SERVE_KEY_NEEDS_SERVER_MODE");
    }, 30_000);
  });
}

describe("the lake engine's errors", () => {
  test("is a CroftError class the HTTP layer maps (smoke)", () => {
    expect(new CroftError("LAKE_CONNECTION_LOST", { message: "x", hint: "y" }).exit).toBe(1);
  });
});
