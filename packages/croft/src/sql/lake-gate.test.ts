// What a lake project's SQL cannot reach (option 07, slice 2, acceptance 7; DESIGN.md D140): the catalog database behind the lake
// (postgres_query, postgres_execute, `__ducklake_metadata_*`), the credentials the instance holds (duckdb_secrets()), the catalogs
// (duckdb_databases()) and the bucket's own files. The same list is sent through `croft query`, an SQL asset, a `-- check:` rule and croft
// serve over HTTP, on a local lake and on a Postgres lake with its store, and each must be refused on every path, with nothing read or
// changed. In a project with a file the same functions still answer (the flag is what a lake adds). A lake's tables stay readable on every
// path (the positive controls), and no credential is in anything that was printed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, makeProject, type TestProject } from "../cli/commands/inspect-testkit.ts";
import { lakeProject } from "../cli/commands/lake-project-testkit.ts";
import { lakeRigReady, type LakeRig, RIG_SECRETS, startLakeRig } from "../db/lake-testkit.ts";
import { closeAllWarehouses } from "../db/warehouse.ts";
import { ProjectEnv } from "../project/env.ts";
import { type Rig, Rigs } from "../serve/key-rig-testkit.ts";
import { openLakeEngine } from "../serve/lake-engine.ts";
import { lakeAttacks, variants } from "./attack-testkit.ts";

const ready = lakeRigReady();
if (!ready.ready) console.warn(`[lake-gate.test] SKIPPING the lake gate tests: ${ready.skipReason}`);
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

interface Lake { p: TestProject; env: Record<string, string>; bucket: string; serve: Rig }

async function lakeWithServer(kind: "local" | "postgres"): Promise<Lake> {
  const { p, env, bucket, project } = await lakeProject(kind, { extensionDir: ready.dir, rig });
  // croft serve over HTTP on the same lake (the serve engine reads it with the read-only login and key).
  const engine = await openLakeEngine({ root: p.root, env: ProjectEnv.load(p.root, env), extensionDir: ready.dir, resources: { threads: 2 } });
  rigs.engines.push(engine);
  const serve = await rigs.rig({ ...p, database: project.paths.database } as never, engine, { sharedTables: [] });
  return { p, env, bucket, serve };
}

/** Every way to run user SQL: each returns whether it was refused, and what it printed. */
function paths(l: Lake) {
  const { p, env } = l;
  return {
    query: async (sql: string) => {
      const x = await cli(["query", sql, "--json"], { cwd: p.root, env });
      return { refused: x.exit === 2, how: x.stdout };
    },
    asset: async (sql: string) => {
      writeFileSync(join(p.root, "assets", "attack.sql"), `${sql}\n`);
      try {
        const x = await cli(["validate", "attack", "--json"], { cwd: p.root, env });
        return { refused: x.exit === 2, how: x.stdout };
      } finally {
        rmSync(join(p.root, "assets", "attack.sql"), { force: true });
      }
    },
    check: async (sql: string) => {
      writeFileSync(join(p.root, "assets", "checked.sql"), `-- check: (SELECT count(*) FROM (${sql}) q) >= 0\nSELECT id FROM orders\n`);
      try {
        const x = await cli(["validate", "checked", "--json"], { cwd: p.root, env });
        return { refused: x.exit === 2 || /CHECK_INVALID/.test(x.stdout), how: x.stdout };
      } finally {
        rmSync(join(p.root, "assets", "checked.sql"), { force: true });
      }
    },
    http: async (sql: string) => {
      const x = await l.serve.call(TOKEN, sql);
      return { refused: x.status >= 400, how: JSON.stringify(x.json) };
    },
  };
}

for (const kind of ["local", "postgres"] as const) {
  maybe(`a lake project's gate (${kind} lake)`, () => {
    let l: Lake;
    beforeAll(async () => {
      l = await lakeWithServer(kind);
      mkdirSync(join(l.p.root, "assets"), { recursive: true });
    }, 120_000);

    test("every attack is refused by croft query, an SQL asset, a check and croft serve, and nothing it printed holds a credential", async () => {
      const run = paths(l);
      const all = lakeAttacks(l.bucket).flatMap(variants);
      expect(all.length).toBeGreaterThan(100);
      const printed: string[] = [];
      const slips: string[] = [];
      for (const attack of all) {
        for (const [name, f] of Object.entries(run)) {
          const x = await f(attack.sql);
          printed.push(x.how);
          if (!x.refused) slips.push(`${name}: ${attack.label}: ${attack.sql}`);
        }
      }
      expect(slips).toEqual([]);
      for (const secret of RIG_SECRETS) for (const t of printed) expect(t).not.toContain(secret);
    }, 600_000);

    test("a lake's tables still answer on every path (the positive control)", async () => {
      const run = paths(l);
      const count = "SELECT count(*) AS n FROM orders";
      expect((await run.query(count)).refused).toBe(false);
      expect((await run.http(count)).refused).toBe(false);
      expect((await run.asset("SELECT id, note FROM orders")).refused).toBe(false);
      expect((await run.check("SELECT id FROM orders WHERE id > 3")).refused).toBe(false);
    }, 120_000);
  });
}

describe("a project with a file", () => {
  test("is not refused what only a lake refuses: the flag is what lake mode adds", async () => {
    const p = makeProject();
    const x = await cli(["query", "select count(*) as n from duckdb_databases()", "--json"], { cwd: p.root, env: {} });
    expect(x.exit).toBe(0);
  });
});
