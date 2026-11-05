// Journey 37: a lake under faults (DESIGN.md D138 to D144; option 07, slice 2, acceptances 3, 5 and 6). The real croft CLI against a local lake and a
// Postgres lake with its store:
//   a. kill -9 at each point of the write path (CROFT_FAULT=after_stage, before_commit, after_commit_before_sqlite) leaves the state before the
//      step or the state after it, never part of it, and the next command reclaims croft's lock on the dead writer and converges;
//   b. kill -9 between the trash and the drop of a delete and of a restore leaves the table whole, and a second try finishes the job;
//   c. Postgres restarted, and its connections ended, while a run waits on a slow API: the run still completes with one write (acceptance 5);
//   d. a wrong password, a bucket key the store refuses, an unreachable host: nothing croft printed, logged or recorded holds the password, the
//      access key id or the secret key, and duckdb_databases() cannot be queried (acceptance 6).
//
// The faults of a, b, e and f each have a project, a shop route and a lake (a database and a bucket folder in the rig) of their own, and kill only
// their own croft processes, so the ones of a lake kind run side by side (test.concurrent, adjacent in their describe; D203). c restarts the rig's Postgres
// and ends its connections, which every other test of that rig would feel, so it runs on its own, after them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { extensionPath, hostPlatform } from "../../src/db/extension-files.ts";
import { lakeRigReady, type LakeRig, localLakeBlock, READER_KEY, READER_LOGIN, RIG_SECRETS, startLakeRig, useLake, WRITER_KEY, WRITER_LOGIN } from "../../src/db/lake-testkit.ts";
import { cleanupAll, type Envelope, initProject, json, type MockApi, mockApi, type Project, show, until } from "./harness.ts";

const ready = lakeRigReady();
if (!ready.ready) console.warn(`[j37] SKIPPING the lake fault journeys: ${ready.skipReason}`);
const maybe = ready.ready ? describe : describe.skip;

let rig: LakeRig | undefined;
let api: MockApi;
beforeAll(async () => {
  api = mockApi();
  if (ready.ready) rig = await startLakeRig();
}, 120_000);
afterAll(async () => {
  api.stop();
  await rig?.stop();
  await cleanupAll();
});

const EXT = { CROFT_EXTENSION_DIR: ready.dir };
const run = (p: Project, args: string[], env: Record<string, string> = {}) => p.json(args, { env: { ...EXT, ...env } });

interface Order { id: number; status: string; amount: number; updated_at: string }
const at = (min: number) => `2026-09-20T10:${String(min).padStart(2, "0")}:00Z`;
const order = (id: number): Order => ({ id, status: "paid", amount: id * 10, updated_at: at(id) });

const ORDERS_TS = (url: string, delayMs = 0) => `import { ingest } from "@zabaca/croft";

type Order = { id: number; updated_at: string };

export default ingest({
  description: "Orders from the shop API",
  key: "id",
  incremental: "updated_at",
  async *rows({ since, http }) {
    const res = await http.get("${url}", { query: { since, wait: ${delayMs} } });
    yield res.json<Order[]>();
  },
});
`;

interface Shop { p: Project; state: { orders: Order[]; delayMs: number }; path: string }
let routes = 0;

async function shop(kind: "local" | "postgres", orders: Order[]): Promise<Shop> {
  const state = { orders, delayMs: 0 };
  const path = `/lake${++routes}/orders`;
  api.route(path, async (_req, url) => {
    if (state.delayMs) await Bun.sleep(state.delayMs);
    const since = url.searchParams.get("since");
    return json([...state.orders].sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at)).filter((o) => !since || Date.parse(o.updated_at) >= Date.parse(since)));
  });
  const { project: p } = await initProject();
  p.remove("assets/example_sales.ts");
  p.write("assets/orders.ts", ORDERS_TS(`${api.url}${path}`));
  p.write("assets/totals.sql", `-- key: status\nSELECT status, count(*) AS orders, sum(amount) AS revenue FROM orders GROUP BY status\n`);
  if (kind === "local") useLake(p.root, { block: localLakeBlock() });
  else useLake(p.root, await rig!.lake());
  const first = await run(p, ["run"]);
  expect(first.code, show(first)).toBe(0);
  return { p, state, path };
}

/** What the lake holds of orders, and what croft's bookkeeping says of it: they must agree after any fault. */
async function view(p: Project): Promise<{ rows: number; recorded: number; written: number; cursor: string | null }> {
  const rows = (await run(p, ["query", "select count(*)::INT as n from orders"])).json.data.rows[0].n as number;
  const [a] = (await run(p, ["query", "select row_count::INT as n, cursor_value as c from _croft.assets where name = 'orders'"])).json.data.rows as { n: number; c: string | null }[];
  const [w] = (await run(p, ["query", "select coalesce(sum(added), 0)::INT as n from _croft.writes where asset = 'orders'"])).json.data.rows as { n: number }[];
  return { rows, recorded: a!.n, written: w!.n, cursor: a!.c };
}

for (const kind of ["local", "postgres"] as const) {
  maybe(`journey 37 (${kind} lake): faults`, () => {
    for (const [fault, after] of [["after_stage", false], ["before_commit", false], ["after_commit_before_sqlite", true]] as const) {
      test.concurrent(`a. kill -9 at ${fault}: the lake is as it was before the step${after ? " ended" : ""} or as it is after it, and the next run converges`, async () => {
        const { p, state } = await shop(kind, [1, 2, 3].map(order));
        state.orders.push(order(4), order(5));
        const killed = await run(p, ["run", "orders", "--follow", "30s"], { CROFT_FAULT: fault });
        expect(killed.code, show(killed)).toBe(1);
        expect(killed.json.data.status).toBe("crashed");
        // Whatever the lake holds is whole: the rows, what croft recorded of them and the sum of what it wrote agree.
        const v = await view(p);
        expect(v.rows).toBe(after ? 5 : 3);
        expect(v.recorded).toBe(v.rows);
        expect(v.written).toBe(v.rows);
        expect(v.cursor).toBe(after ? at(5) : at(3));
        // The writer died holding croft's lock on the lake's writes; the next command reclaims it and goes on.
        const next = await run(p, ["run", "orders"]);
        expect(next.code, show(next)).toBe(0);
        const done = await view(p);
        expect(done).toEqual({ rows: 5, recorded: 5, written: 5, cursor: at(5) });
        expect(existsSync(join(p.stateDir, "lake-write.lock"))).toBe(false);
      }, 300_000);
    }

    test.concurrent("b. kill -9 between the trash and the drop of a delete, and of a restore: the table is whole, and a second try finishes", async () => {
      const { p } = await shop(kind, [1, 2, 3, 4].map(order));
      const asked = await run(p, ["delete", "orders"]);
      expect(asked.code, show(asked)).toBe(5);
      const killed = await p.croft(["confirm", asked.json.confirmation.token], { env: { ...EXT, CROFT_FAULT: "between_trash_and_drop" } });
      expect(killed.code).not.toBe(0);
      expect((await view(p)).rows).toBe(4);
      expect(readdirSync(join(p.stateDir, "trash", "orders")).filter((f) => f.endsWith(".duckdb")).length).toBeGreaterThanOrEqual(1);
      const again = await run(p, ["delete", "orders"]);
      expect(again.code, show(again)).toBe(5);
      expect((await run(p, ["confirm", again.json.confirmation.token])).code).toBe(0);
      expect((await run(p, ["query", "select count(*) from orders"])).code).not.toBe(0);
      // A restore killed in the same place leaves the table absent (it was deleted), and a second restore brings it back whole.
      const ask = await run(p, ["restore", "orders"]);
      expect(ask.code, show(ask)).toBe(5);
      const killedRestore = await p.croft(["confirm", ask.json.confirmation.token], { env: { ...EXT, CROFT_FAULT: "between_trash_and_drop" } });
      expect(killedRestore.code).not.toBe(0);
      const ask2 = await run(p, ["restore", "orders"]);
      expect((await run(p, ["confirm", ask2.json.confirmation.token])).code).toBe(0);
      expect(await view(p)).toMatchObject({ rows: 4, recorded: 4 });
    }, 300_000);

    test.concurrent("e. kill -9 between the trash and the reset of a rebuild: the table is whole, and a new confirmation finishes it", async () => {
      const { p, state } = await shop(kind, [1, 2, 3].map(order));
      p.remove("assets/totals.sql");
      state.orders.push(order(4));
      const asked = await run(p, ["run", "orders", "--rebuild"]);
      expect(asked.code, show(asked)).toBe(5);
      const killed = await p.croft(["confirm", asked.json.confirmation.token], { env: { ...EXT, CROFT_FAULT: "between_trash_and_reset" } });
      expect(killed.code).not.toBe(0);
      expect(readdirSync(join(p.stateDir, "trash", "orders")).filter((f) => f.endsWith(".duckdb")).length).toBe(1);
      expect(await view(p)).toMatchObject({ rows: 3, recorded: 3, written: 3 }); // the trash committed, the table did not change
      const again = await run(p, ["run", "orders", "--rebuild"]);
      expect(again.code, show(again)).toBe(5);
      expect((await run(p, ["confirm", again.json.confirmation.token])).code).toBe(0);
      expect(await view(p)).toMatchObject({ rows: 4, recorded: 4 }); // refetched whole
      expect(readdirSync(join(p.stateDir, "trash", "orders")).filter((f) => f.endsWith(".duckdb")).length).toBe(2);
    }, 300_000);

    for (const point of ["rename_before_commit", "rename_after_commit", "rename_after_state", "rename_after_earlier", "rename_after_trash"]) {
      test.concurrent(`f. kill -9 at ${point} of a rename: nothing is lost, and the same rename finishes it`, async () => {
        const { p } = await shop(kind, [1, 2, 3].map(order));
        p.remove("assets/totals.sql");
        const killed = await p.croft(["rename", "orders", "sales", "--json"], { env: { ...EXT, CROFT_FAULT: point } });
        expect(killed.signal === "SIGKILL" || killed.code === 137, show(killed)).toBe(true); // killed, as a crash would
        // Whichever side of the commit it stopped on, the rows are in the lake under one of the two names.
        const names = ((await run(p, ["query", "select table_name as n from duckdb_tables() where schema_name = 'main' and table_name in ('orders', 'sales')"])).json.data.rows as { n: string }[]).map((r) => r.n);
        expect(names.length, point).toBe(1);
        const again = await run(p, ["rename", "orders", "sales"]);
        expect(again.code, show(again)).toBe(0);
        expect((await run(p, ["query", "select count(*)::INT as n from sales"])).json.data.rows).toEqual([{ n: 3 }]);
        expect((await run(p, ["query", "select count(*) from orders"])).code).not.toBe(0);
        const recorded = ((await run(p, ["query", "select name from _croft.assets order by name"])).json.data.rows as { name: string }[]).map((r) => r.name);
        expect(recorded).toContain("sales"); // (totals is still recorded: its file was removed, its table is not croft's to drop)
        expect(recorded).not.toContain("orders");
        expect(existsSync(join(p.stateDir, "lake-write.lock"))).toBe(false);
      }, 180_000);
    }
  });
}

maybe("journey 37 (postgres lake): the catalog restarts mid-command", () => {
  test("c. a run that waits on a slow API while Postgres restarts, and its connections are ended, completes with one write", async () => {
    const { p, state, path } = await shop("postgres", [1, 2, 3].map(order));
    state.orders.push(order(4), order(5), order(6));
    state.delayMs = 2500;
    const running = p.start(["run", "orders", "--foreground", "--json"], { env: { ...EXT } });
    await until(() => api.log.some((r) => r.path === path && Date.now() - r.at < 1500), 20_000);
    expect(await rig!.pg.terminateConnections()).toBeGreaterThanOrEqual(0);
    await rig!.pg.restart(300);
    state.delayMs = 0;
    const result = await running.done;
    const env = JSON.parse(result.stdout) as Envelope;
    expect(result.code, show(result)).toBe(0);
    expect(env.data.steps[0]).toMatchObject({ asset: "orders", status: "ok", rows: { added: 3, total: 6 } });
    const v = await view(p);
    expect(v).toEqual({ rows: 6, recorded: 6, written: 6, cursor: at(6) });
    // One write: the step's row in _croft.writes appears once for this run.
    const writes = (await run(p, ["query", "select count(*)::INT as n from _croft.writes where asset = 'orders' and run_id = $1".replace("$1", `'${env.data.runId}'`)])).json.data.rows;
    expect(writes).toEqual([{ n: 1 }]);
  }, 180_000);
});

maybe("journey 37 (postgres lake): credentials never leave", () => {
  /** Every text file under the state folder, and runs.sqlite's bytes, as one string. */
  function recorded(p: Project): string {
    const parts: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const f = join(dir, name);
        const st = statSync(f);
        if (st.isDirectory()) {
          if (name === "trash" || name === "lake-secrets") continue; // DuckDB files and secrets, never ours to print
          walk(f);
        } else if (st.size < 8_000_000) parts.push(readFileSync(f).toString("latin1"));
      }
    };
    walk(p.stateDir);
    return parts.join("\n");
  }

  const everything = async (p: Project, cases: { args: string[]; env?: Record<string, string> }[]): Promise<string> => {
    const out: string[] = [];
    for (const c of cases) {
      const r = await p.croft([...c.args], { env: { ...EXT, ...(c.env ?? {}) } });
      out.push(r.stdout, r.stderr);
      const j = await p.croft([...c.args, "--json"], { env: { ...EXT, ...(c.env ?? {}) } });
      out.push(j.stdout, j.stderr);
    }
    return out.join("\n");
  };

  const assertClean = (text: string, extra: string[] = []) => {
    for (const s of [...RIG_SECRETS, ...extra]) expect(text, `a secret in output: ${s.slice(0, 6)}...`).not.toContain(s);
  };

  test("d. a wrong password: attach fails with a code and a fix, and nothing printed or recorded has the password", async () => {
    const wrong = "test-wrong-password";
    const lake = await rig!.lake({ writerPassword: wrong });
    const { project: p } = await initProject();
    useLake(p.root, lake);
    const r = await run(p, ["run"]);
    expect(r.code, show(r)).toBe(2);
    expect(JSON.stringify(r.json)).toContain("LAKE_ATTACH_FAILED");
    const text = await everything(p, [{ args: ["run"] }, { args: ["status"] }, { args: ["doctor"] }]);
    assertClean(text, [wrong]);
    assertClean(recorded(p), [wrong]);
    assertClean(JSON.stringify(r.json), [wrong]);
  }, 180_000);

  test("d. a bucket key the store refuses (it echoes the key id in its 403): the first write big enough to make a file fails clean", async () => {
    const unknown = "UNKNOWNKEYID0123456";
    const lake = await rig!.lake({ writerKeyId: unknown });
    const { project: p } = await initProject();
    p.remove("assets/example_sales.ts");
    p.write("assets/big.sql", "-- key: id\nSELECT range AS id, 'x' || range AS s FROM range(20000)\n");
    useLake(p.root, lake);
    const r = await run(p, ["run"]);
    expect(r.code, show(r)).not.toBe(0);
    const text = await everything(p, [{ args: ["run"] }, { args: ["query", "select 1"] }, { args: ["doctor"] }]);
    assertClean(text, [unknown]);
    assertClean(recorded(p), [unknown]);
    assertClean(r.stdout + r.stderr, [unknown]);
  }, 180_000);

  test("d. a host nobody listens on: LAKE_ATTACH_FAILED, retryable, without any secret", async () => {
    const lake = await rig!.lake({ port: 1 });
    const { project: p } = await initProject();
    useLake(p.root, lake);
    const r = await run(p, ["run"]);
    expect(r.code).not.toBe(0);
    expect(JSON.stringify(r.json)).toContain("LAKE_ATTACH_FAILED");
    assertClean(r.stdout + r.stderr);
    assertClean(recorded(p));
  }, 180_000);

  test("d. duckdb_databases() and duckdb_secrets() cannot be queried, and the secret folder holds no secret file", async () => {
    const { project: p } = await initProject();
    useLake(p.root, await rig!.lake());
    expect((await run(p, ["run"])).code).toBe(0);
    for (const sql of ["select * from duckdb_databases()", "select * from duckdb_secrets()", "select * from which_secret('s3://lakeb/x', 's3')"]) {
      const r = await run(p, ["query", sql]);
      expect(r.code, show(r)).toBe(2);
      assertClean(r.stdout + r.stderr);
    }
    // The secrets exist in memory only: croft never writes a persistent secret, so the folder DuckDB would keep them in has none.
    const dir = join(p.stateDir, "lake-secrets");
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    assertClean(recorded(p));
    void READER_KEY; void READER_LOGIN; void WRITER_KEY; void WRITER_LOGIN;
  }, 180_000);
});

maybe("journey 37 (postgres lake): a lake that cannot be attached ends every step with its own error (the second real-lake trial)", () => {
  /** A project with two ingests that run side by side and a SQL asset over one, as the trial's had. */
  async function twoIngests(): Promise<Project> {
    const { project: p } = await initProject();
    p.write("files/events.csv", "event_id,kind\n1,view\n2,click\n3,buy\n");
    p.write("assets/events.ts", `import { ingest } from "@zabaca/croft";\nexport default ingest({ description: "events", file: "files/events.csv", key: "event_id" });\n`);
    p.write("assets/daily_events.sql", "-- key: kind\nSELECT kind, count(*) AS n FROM events GROUP BY kind\n");
    return p;
  }
  const steps = (r: { json: Envelope }): { asset: string; status: string; attempt: number }[] => r.json.data.steps;

  test("a wrong password: each ingest says LAKE_ATTACH_FAILED once, and none says INTERNAL_ERROR or is called temporary", async () => {
    const p = await twoIngests();
    useLake(p.root, await rig!.lake({ writerPassword: "test-wrong-password" }));
    const r = await run(p, ["run"]);
    expect(r.code, show(r)).toBe(2);
    const text = JSON.stringify(r.json);
    expect(text).not.toContain("INTERNAL_ERROR");
    expect(text).not.toContain("left part set up");
    expect(text).not.toMatch(/the error is temporary/);
    const failed = steps(r).filter((s) => s.status === "failed");
    expect(failed.map((s) => s.asset).sort()).toEqual(["events", "example_sales"]);
    for (const s of failed) expect(s.attempt, show(r)).toBe(1);
  }, 180_000);

  test("a database that holds another lake (DuckLake 1.1): LAKE_CATALOG_MISMATCH, not retried, not called temporary, and no migration advice", async () => {
    const lake = await rig!.lake();
    const platform = hostPlatform()!;
    const foreign = await DuckDBInstance.create(":memory:", { autoinstall_known_extensions: "false", autoload_known_extensions: "false" });
    const fc = await foreign.connect();
    try {
      for (const name of ["httpfs", "postgres", "ducklake"] as const) await fc.run(`LOAD '${extensionPath(ready.dir, name, platform)}'`);
      await fc.run(`CREATE SECRET pg (TYPE postgres, HOST '${rig!.pg.host}', PORT ${rig!.pg.port}, DATABASE '${lake.db}', USER '${WRITER_LOGIN.user}', PASSWORD '${WRITER_LOGIN.password}', SSLMODE 'disable')`);
      await fc.run(`ATTACH 'ducklake:postgres:' AS other (META_SECRET pg, DATA_PATH 's3://${lake.bucket}/another-tool/', DUCKLAKE_VERSION '1.1')`);
      await fc.run("CREATE TABLE other.t AS SELECT 1 AS a");
    } finally {
      fc.disconnectSync();
      foreign.closeSync();
    }
    const p = await twoIngests();
    useLake(p.root, lake);
    const r = await run(p, ["run"]);
    expect(r.code, show(r)).toBe(2);
    const text = JSON.stringify(r.json);
    expect(text).toContain("LAKE_CATALOG_MISMATCH");
    expect(text).not.toContain("INTERNAL_ERROR");
    expect(text).not.toMatch(/AUTOMATIC_MIGRATION|the error is temporary/);
    for (const s of steps(r).filter((x) => x.status === "failed")) expect(s.attempt, show(r)).toBe(1);
    const d = await run(p, ["doctor"]);
    expect(JSON.stringify(d.json)).toContain("LAKE_CATALOG_MISMATCH");
  }, 180_000);
});
