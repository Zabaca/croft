// Journey 32: server mode (DESIGN.md D119, §5 "Server mode, apps and GUIs"; option 06, slice 2). With "serverMode" on, a run's
// refresh makes the read copy (read-only on disk), croft serve answers apps from a readers' process on that copy and never
// opens the warehouse, a later run swaps its new rows in, and SIGTERM stops everything with exit 0 even with a query
// running. The real CLI, the real readers' process (quack and httpfs from the extension folder), a mock API for the data.
// Locally a missing extension file skips the journey and says why; in CI (CROFT_CI=1) it fails.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { extensionsReady } from "../../src/db/extension-dir-testkit.ts";
import { alive, cleanupAll, type Envelope, initProject, json, type MockApi, mockApi, PKG, type Project, schedulerEnv, show, until, LAKE } from "./harness.ts";

const ext = extensionsReady(["quack", "httpfs"]);
if (!ext.ready) console.warn(`[j32-server-mode] SKIPPING: ${ext.skipReason}`);
const journey = ext.ready && !LAKE ? test : test.skip; // a project with a lake refuses server mode until slice 5 (D138)

let api: MockApi;
let built: { code: number | null; out: string };
beforeAll(() => {
  api = mockApi();
  // @zabaca/croft/read ships as built JavaScript (dist/, git-ignored): build it as publishing would.
  const r = spawnSync(process.execPath, [join(PKG, "scripts", "build-read.ts")], { cwd: PKG, encoding: "utf8" });
  built = { code: r.status, out: `${r.stdout}${r.stderr}` };
});
afterAll(async () => {
  api.stop();
  await cleanupAll();
});

const APP = `import { query } from "@zabaca/croft/read";
try {
  const rows = await query(process.env.APP_SQL ?? "select id, amount from orders order by id", []);
  process.stdout.write(JSON.stringify({ rows }));
} catch (e) {
  process.stdout.write(JSON.stringify({ code: e.code, message: e.message }));
}
`;

const ordersAsset = (base: string) => `import { ingest } from "@zabaca/croft";

export default ingest({
  key: "id",
  async *rows({ http }) {
    yield (await http.get("${base}/orders")).json<Record<string, unknown>[]>();
  },
});
`;

interface ServeRecord { url: string; token: string; pid: number }

function app(p: Project): Envelope {
  p.write("app/orders.mjs", APP);
  const r = spawnSync(process.execPath, [join(p.root, "app", "orders.mjs")], {
    cwd: p.root, encoding: "utf8", timeout: 60_000,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", TMPDIR: process.env.TMPDIR ?? "/tmp" },
  });
  if (r.status !== 0) throw new Error(`the app failed: ${r.stdout}${r.stderr}`);
  return JSON.parse(r.stdout) as Envelope;
}

const get = async (rec: ServeRecord, path: string) =>
  (await (await fetch(`${rec.url}${path}`, { headers: { Authorization: `Bearer ${rec.token}` } })).json()) as Envelope;

describe("journey 32: server mode", () => {
  journey("a run makes the read-only copy, croft serve answers from it and never opens the warehouse, a run swaps new rows in, SIGTERM stops it clean", async () => {
    expect(built.code, built.out).toBe(0);
    const state = { orders: [{ id: 1, amount: 10 }, { id: 2, amount: 20 }] };
    api.route("/orders", () => json(state.orders));
    const { project: p } = await initProject();
    p.remove("assets/example_sales.ts");
    p.write("assets/orders.ts", ordersAsset(api.url));
    const env = { ...schedulerEnv(), CROFT_EXTENSION_DIR: ext.dir };
    const home = { env };
    p.edit("croft.json", '"timezone"', '"serverMode": { "enabled": true, "quackPort": 0 }, "timezone"');

    // A run that changes data makes the copy, read-only on disk, even though readCopy is not set.
    const first = await p.json(["run"], home);
    expect(first.code, show(first)).toBe(0);
    const copy = join(p.root, "warehouse.read.duckdb");
    expect(existsSync(copy)).toBe(true);
    expect(statSync(copy).mode & 0o222).toBe(0);

    const doctor = await p.json(["doctor"], home);
    expect(doctor.json.data.checks.find((c: Envelope) => c.id === "servermode")).toMatchObject({ status: "ok", details: { serving: false } });
    const offline = (await p.json(["status"], home)).json.data.serverMode;
    expect(offline.serving).toBe(false);
    // The mode's extension files are found (D134): from the folder the journey names, not an add-on.
    expect(offline.addons).toHaveLength(1);
    expect(offline.addons[0]).toMatchObject({ addon: "server", ok: true });

    const serve = p.start(["serve", "--port", "0"], home);
    const file = join(p.stateDir, "serve.json");
    await until(() => existsSync(file) || serve.proc.exitCode !== null, 30_000);
    if (!existsSync(file)) throw new Error(`croft serve did not start\n${show(await serve.done)}`);
    const rec = JSON.parse(readFileSync(file, "utf8")) as ServeRecord;

    // It answers from the copy, and says as of when.
    expect(app(p)).toEqual({ rows: [{ id: 1, amount: 10 }, { id: 2, amount: 20 }] });
    const q = await (await fetch(`${rec.url}/query`, {
      method: "POST", headers: { Authorization: `Bearer ${rec.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ sql: "select count(*) as n from orders" }),
    })).json() as Envelope;
    expect(q.data.rows).toEqual([{ n: 2 }]);
    expect(q.data.asOf).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?-0[78]:00$/);
    expect(q.data.stale).toBeUndefined();
    const health = await get(rec, "/health");
    expect(health).toMatchObject({ ok: true, writeIntent: null, serverMode: { state: "open", asOf: q.data.asOf } });

    // doctor and status say what is going on.
    const live = await p.json(["doctor"], home);
    expect(live.json.data.checks.find((c: Envelope) => c.id === "servermode")).toMatchObject({ status: "ok", details: { serving: true } });
    // croft serve holds only the copy: doctor does not name it as a holder of the warehouse.
    const warehouse = live.json.data.checks.find((c: Envelope) => c.id === "warehouse");
    expect(warehouse.text).toContain("not held");
    expect(warehouse.text).not.toContain("read server");
    expect(warehouse.details.heldBy).toBeNull();
    expect(JSON.parse(readFileSync(file, "utf8")).serverMode).toBe(true);
    const status = await p.json(["status"], home);
    expect(status.json.data.serverMode.serving).toBe(true);
    expect(status.json.data.serverMode.addons[0]).toMatchObject({ addon: "server", ok: true });

    // A run writes while croft serve runs: it never waits for it, and the new rows reach the app within a second or so.
    const engine = async () => (await get(rec, "/status")).data.serve.engine;
    const pid = (await engine()).serverMode.workerPid as number;
    state.orders.push({ id: 3, amount: 30 });
    const run = await p.json(["run"], home);
    expect(run.code, show(run)).toBe(0);
    expect(run.json.data.steps.map((s: Envelope) => [s.asset, s.status])).toEqual([["orders", "ok"]]);
    expect(run.ms).toBeLessThan(20_000);
    await until(async () => (await engine()).serverMode.swaps >= 1, 10_000);
    expect(app(p).rows).toEqual([{ id: 1, amount: 10 }, { id: 2, amount: 20 }, { id: 3, amount: 30 }]);
    const after = await engine();
    expect(after.serverMode).toMatchObject({ state: "open", workerPid: pid, restarts: 0 });
    expect(after.writeIntent).toBeNull();
    expect(statSync(copy).mode & 0o222).toBe(0);

    // SIGTERM with a query running: exit 0, no crash output, serve.json gone, the readers' process gone.
    const slow = fetch(`${rec.url}/query`, {
      method: "POST", headers: { Authorization: `Bearer ${rec.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT sum(a.range * b.range) AS s FROM range(10000000) a, range(1000000) b" }),
    }).catch(() => null);
    await until(async () => (await engine()).inFlight === 1, 10_000);
    serve.proc.kill("SIGTERM");
    const stopped = await serve.done;
    expect(stopped.code, show(stopped)).toBe(0);
    expect(`${stopped.stdout}${stopped.stderr}`).not.toMatch(/panic|crash|oh no|segmentation|SIGSEGV|SIGABRT/i);
    expect(existsSync(file)).toBe(false);
    expect(alive(pid)).toBe(false);
    await slow;
    expect(stopped.stdout).toContain("server mode: answers from warehouse.read.duckdb, never opens warehouse.duckdb");
    expect(stopped.stdout).toContain("croft serve stopped (SIGTERM)");
    expect(`${stopped.stdout}${stopped.stderr}`).not.toContain(rec.token);
    // With croft serve gone, apps read the file directly again.
    expect(app(p).rows).toHaveLength(3);
  }, 180_000);

  journey("data already built and no run to come: turn the mode on, start croft serve, and it makes the copy itself and answers", async () => {
    api.route("/orders", () => json([{ id: 1, amount: 10 }, { id: 2, amount: 20 }]));
    const { project: p } = await initProject();
    p.remove("assets/example_sales.ts");
    p.write("assets/orders.ts", ordersAsset(api.url));
    const home = { env: { ...schedulerEnv(), CROFT_EXTENSION_DIR: ext.dir } };
    expect((await p.json(["run"], home)).code).toBe(0);
    const copy = join(p.root, "warehouse.read.duckdb");
    expect(existsSync(copy)).toBe(false); // server mode and readCopy were off
    p.edit("croft.json", '"timezone"', '"serverMode": { "enabled": true, "quackPort": 0 }, "timezone"');

    const serve = p.start(["serve", "--port", "0"], home);
    const file = join(p.stateDir, "serve.json");
    await until(() => existsSync(file) || serve.proc.exitCode !== null, 30_000);
    if (!existsSync(file)) throw new Error(`croft serve did not start\n${show(await serve.done)}`);
    const rec = JSON.parse(readFileSync(file, "utf8")) as ServeRecord;
    // It started without waiting for the copy. Until there is one a query is told to retry (503); then it is answered.
    const ask = () => fetch(`${rec.url}/query`, {
      method: "POST", headers: { Authorization: `Bearer ${rec.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ sql: "select count(*) as n from orders" }),
    });
    const seen: number[] = [];
    const answer = await until(async () => {
      const r = await ask();
      seen.push(r.status);
      return r.status === 200 ? ((await r.json()) as Envelope) : null;
    }, 60_000, 100);
    expect(seen.filter((s) => s !== 200 && s !== 503)).toEqual([]);
    expect(answer.data.rows).toEqual([{ n: 2 }]);
    expect(answer.data.asOf).toBeString();
    expect(existsSync(copy)).toBe(true);
    expect(statSync(copy).mode & 0o222).toBe(0);
    serve.proc.kill("SIGTERM");
    const stopped = await serve.done;
    expect(stopped.code, show(stopped)).toBe(0);
  }, 180_000);

  journey("turned off again, the next refresh writes the copy with the usual permissions", async () => {
    const state = { orders: [{ id: 1, amount: 10 }] };
    api.route("/orders", () => json(state.orders));
    const { project: p } = await initProject();
    p.remove("assets/example_sales.ts");
    p.write("assets/orders.ts", ordersAsset(api.url));
    const home = { env: { ...schedulerEnv(), CROFT_EXTENSION_DIR: ext.dir } };
    p.edit("croft.json", '"timezone"', '"serverMode": { "enabled": true, "quackPort": 0 }, "timezone"');
    expect((await p.json(["run"], home)).code).toBe(0);
    const copy = join(p.root, "warehouse.read.duckdb");
    expect(statSync(copy).mode & 0o222).toBe(0);
    p.edit("croft.json", '"serverMode": { "enabled": true, "quackPort": 0 }', '"readCopy": true, "serverMode": { "enabled": false }');
    state.orders.push({ id: 2, amount: 20 });
    expect((await p.json(["run"], home)).code).toBe(0);
    expect(statSync(copy).mode & 0o200).toBe(0o200);
  }, 120_000);
});
