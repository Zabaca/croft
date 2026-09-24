// Journey 21: croft serve (DESIGN.md §5 "Server mode, apps and GUIs", §4.2). The server runs as a user starts it,
// on a free port (--port 0). An app script reads through @zabaca/croft/read (Bun), which finds the server and its
// token in .croft/serve.json. A croft run writes while the server holds the file: the run succeeds and the app sees
// the new rows. A wrong token is SERVE_UNAUTHORIZED, the banner says what the server is, and SIGTERM stops it and
// removes serve.json. With scheduling on (--no-os-job), the server's loop ticks at once, and the scheduled run it
// starts writes while the server serves.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupAll, type Envelope, initProject, json, laTime, type MockApi, mockApi, PKG, type Project, schedulerEnv, show, until,
} from "./harness.ts";

// `croft schedule on|off` once refused in every croft process started with a temp HOME under CROFT_FORBID_OS_JOBS=1
// (Bun's os.userInfo() answers $HOME); guardRealHome now asks the password database (schedule.ts passwdHome).
const scheduleTest = test;

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

// An app script, as the skill says apps read. APP_OPTS are query()'s options; without them it finds the project,
// the running server and its token by itself.
const APP = `import { query } from "@zabaca/croft/read";
const opts = process.env.APP_OPTS ? JSON.parse(process.env.APP_OPTS) : undefined;
try {
  const rows = await query(process.env.APP_SQL ?? "select id, amount from orders order by id", [], opts);
  process.stdout.write(JSON.stringify({ rows }));
} catch (e) {
  process.stdout.write(JSON.stringify({ code: e.code, message: e.message }));
}
`;

const ordersAsset = (base: string, schedule = "") => `import { ingest } from "@zabaca/croft";

export default ingest({${schedule}
  key: "id",
  async *rows({ http }) {
    yield (await http.get("${base}/orders")).json<Record<string, unknown>[]>();
  },
});
`;

interface ServeRecord { url: string; host: string; port: number; token: string; pid: number }

function app(p: Project, env: Record<string, string> = {}): Envelope {
  p.write("app/orders.mjs", APP);
  const r = spawnSync(process.execPath, [join(p.root, "app", "orders.mjs")], {
    cwd: p.root, encoding: "utf8", timeout: 60_000,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", TMPDIR: process.env.TMPDIR ?? "/tmp", ...env },
  });
  if (r.status !== 0) throw new Error(`the app failed: ${r.stdout}${r.stderr}`);
  return JSON.parse(r.stdout) as Envelope;
}

async function health(rec: ServeRecord, token = rec.token): Promise<{ status: number; body: Envelope }> {
  const res = await fetch(`${rec.url}/health`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json() as Envelope };
}

/** Start croft serve on a free port; resolves once serve.json names it. */
async function startServe(p: Project, env: Record<string, string> = {}) {
  const serve = p.start(["serve", "--port", "0"], { env });
  const file = join(p.stateDir, "serve.json");
  await until(() => existsSync(file) || serve.proc.exitCode !== null, 30_000);
  if (!existsSync(file)) throw new Error(`croft serve did not start\n${show(await serve.done)}`);
  return { serve, file, rec: JSON.parse(readFileSync(file, "utf8")) as ServeRecord };
}

describe("journey 21: croft serve", () => {
  test("an app reads through it, a run writes while it serves, a wrong token is refused, the banner, SIGTERM", async () => {
    expect(built.code, built.out).toBe(0);
    const state = { orders: [{ id: 1, amount: 10 }, { id: 2, amount: 20 }] };
    api.route("/orders", () => json(state.orders));
    const { project: p } = await initProject();
    p.remove("assets/example_sales.ts");
    p.write("assets/orders.ts", ordersAsset(api.url));
    p.write("assets/order_total.sql", "SELECT count(*) AS n, sum(amount) AS total FROM orders\n");
    // A temp HOME for every croft here too: status and doctor read the scheduler's per-user folder.
    const home = { env: schedulerEnv() };
    const first = await p.json(["run"], home);
    expect(first.code, show(first)).toBe(0);

    const { serve, file, rec } = await startServe(p, home.env);
    expect(rec.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(rec.port).toBeGreaterThan(0);
    expect(rec.url).toBe(`http://127.0.0.1:${rec.port}`);
    expect(rec.token.length).toBeGreaterThanOrEqual(32);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const up = await health(rec);
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ ok: true, pid: rec.pid, database: "warehouse.duckdb", writeIntent: null, queriesToday: 0 });
    expect((await health(rec, "not-the-token")).status).toBe(401);

    // The app finds the server and its token in .croft/serve.json: its query goes over HTTP.
    expect(app(p)).toEqual({ rows: [{ id: 1, amount: 10 }, { id: 2, amount: 20 }] });
    expect((await health(rec)).body.queriesToday).toBe(1);
    const status = await p.json(["status"], home);
    expect(status.json.data.serve).toEqual({ url: rec.url, pid: rec.pid });
    const doctor = await p.json(["doctor"], home);
    expect(doctor.json.data.checks.find((c: Envelope) => c.id === "serve")).toMatchObject({ status: "ok", details: { running: true, pid: rec.pid, url: rec.url } });

    // A run writes while the server holds the file (its read-only instance is open): the server steps aside, the run
    // succeeds, the app sees the rows, and the server is open again.
    const engine = async () => ((await (await fetch(`${rec.url}/status`, { headers: { Authorization: `Bearer ${rec.token}` } })).json()) as Envelope).data.serve.engine;
    expect(await engine()).toMatchObject({ state: "open", writeIntent: null });
    expect((await engine()).openConnections).toBeGreaterThan(0);
    state.orders.push({ id: 3, amount: 30 }, { id: 4, amount: 40 });
    const run = await p.json(["run"], home);
    expect(run.code, show(run)).toBe(0);
    expect(run.json.data.status).toBe("succeeded");
    expect(run.json.data.steps.map((s: Envelope) => [s.asset, s.status])).toEqual([["orders", "ok"], ["order_total", "ok"]]);
    expect(app(p).rows).toEqual([{ id: 1, amount: 10 }, { id: 2, amount: 20 }, { id: 3, amount: 30 }, { id: 4, amount: 40 }]);
    // sum() of a BIGINT is a HUGEINT: a string, as croft query --json writes it.
    expect(app(p, { APP_SQL: "select n, total from order_total" }).rows).toEqual([{ n: 4, total: "100" }]);
    expect((await health(rec)).body).toMatchObject({ queriesToday: 3, writeIntent: null });
    expect(await engine()).toMatchObject({ state: "open", writeIntent: null });

    // A wrong token: SERVE_UNAUTHORIZED, from an explicit URL, from CROFT_URL, and over plain HTTP.
    expect(app(p, { APP_OPTS: JSON.stringify({ url: rec.url, token: "wrong-token" }) })).toMatchObject({ code: "SERVE_UNAUTHORIZED" });
    expect(app(p, { CROFT_URL: rec.url, CROFT_SERVE_TOKEN: "wrong-token" })).toMatchObject({ code: "SERVE_UNAUTHORIZED" });
    const raw = await fetch(`${rec.url}/query`, {
      method: "POST", headers: { Authorization: "Bearer wrong-token", "Content-Type": "application/json" }, body: JSON.stringify({ sql: "select 1" }),
    });
    expect(raw.status).toBe(401);
    expect(((await raw.json()) as Envelope).problems[0]).toMatchObject({ code: "SERVE_UNAUTHORIZED" });

    // One server per project.
    const second = await p.json(["serve", "--port", "0"], home);
    expect(second.code, show(second)).toBe(2);
    expect(second.json.problems[0].message).toContain(`croft serve is already running for this project (pid ${rec.pid}`);

    // SIGTERM: a clean stop, serve.json removed; apps read the file directly again.
    serve.proc.kill("SIGTERM");
    const stopped = await serve.done;
    expect(stopped.code, show(stopped)).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(stopped.stdout.split("\n")).toEqual([
      `croft serve · ${rec.url} · database warehouse.duckdb (read-only, steps aside for writes)`,
      "token: .croft/serve.json (hosted apps: set CROFT_SERVE_TOKEN)",
      "scheduler: off (croft schedule on turns it on; on a server without an OS job: croft schedule on --no-os-job)",
      'apps: import from "@zabaca/croft/read" in this project, or set CROFT_URL + CROFT_SERVE_TOKEN',
      "^C to stop",
      "croft serve stopped (SIGTERM)",
      "",
    ]);
    expect(`${stopped.stdout}${stopped.stderr}`).not.toContain(rec.token);
    expect(app(p).rows).toHaveLength(4);
    await expect(fetch(`${rec.url}/health`)).rejects.toThrow();
    expect((await p.json(["status"], home)).json.data.serve).toBeUndefined();
  }, 120_000);

  scheduleTest("with scheduling on, its loop ticks at once, and the scheduled run writes while it serves", async () => {
    expect(built.code, built.out).toBe(0);
    const state = { orders: [{ id: 1, amount: 10 }] };
    api.route("/orders", () => json(state.orders));
    const { project: p } = await initProject();
    p.remove("assets/example_sales.ts");
    p.write("assets/orders.ts", ordersAsset(api.url, '\n  schedule: "every hour",'));
    const sched = schedulerEnv();
    const at = (h: number, m = 0) => ({ env: { ...sched, CROFT_NOW: laTime(h, m) } });
    expect((await p.json(["run", "orders"], at(10, 5))).code).toBe(0);            // approves it for the scheduler
    const on = await p.json(["schedule", "on", "--no-os-job"], at(10, 30));
    expect(on.code, show(on)).toBe(0);
    expect(on.json.data.scheduling).toMatchObject({ state: "on", via: "serve" });

    // Started at 11:00, the server ticks at once: the ingest is due, and its run writes while the server serves.
    state.orders.push({ id: 2, amount: 20 });
    const { serve, file, rec } = await startServe(p, at(11).env);
    const tickLog = join(p.stateDir, "logs", "tick.log");
    const log = await until(() => {
      const text = existsSync(tickLog) ? readFileSync(tickLog, "utf8") : "";
      return /tick: started r_\S+ \(orders\)/.test(text) ? text : null;
    }, 30_000);
    expect(log).toContain(`croft serve (pid ${rec.pid}) starts croft tick`);
    const runId = /tick: started (r_\S+) \(orders\)/.exec(log)![1]!;
    const done = await p.json(["wait", runId, "--timeout", "60s"], at(11));
    expect(done.code, show(done)).toBe(0);
    expect(done.json.data.steps[0]).toMatchObject({ asset: "orders", status: "ok", reason: "scheduled", rows: { added: 1, total: 2 } });
    expect(app(p).rows).toEqual([{ id: 1, amount: 10 }, { id: 2, amount: 20 }]);
    expect((await health(rec)).body.queriesToday).toBe(1);

    const view = await p.json(["schedule", "status"], at(11, 1));
    expect(view.json.data).toMatchObject({ scheduling: { state: "on", via: "serve", lastTickAt: laTime(11), stale: false }, serve: { url: rec.url, pid: rec.pid } });
    expect(view.json.data.assets.find((a: Envelope) => a.asset === "orders")).toMatchObject({ lastFireAt: laTime(11), due: false });
    expect((await p.croft(["schedule", "status"], at(11, 1))).stdout).toContain(`ticks from croft serve (pid ${rec.pid})`);

    serve.proc.kill("SIGTERM");
    const stopped = await serve.done;
    expect(stopped.code, show(stopped)).toBe(0);
    expect(stopped.stdout).toContain("scheduler: on, ticking every minute");
    expect(existsSync(file)).toBe(false);
  }, 120_000);
});
