// Concurrency, part 1 (DESIGN.md §10 test strategy, item 4; §5 "Owning the DuckDB file", "Leases", "How commands
// behave while a run is writing"; §8 "What counts as due"): real croft processes against one project.
//
//   - a run plus a query: a query never waits for an extraction, and waits for a write step only, naming the run;
//   - a foreign read-only holder: `run --no-wait` names it at once; a waiting run gets the file once it lets go;
//   - two runs on one asset: ASSET_BUSY with --no-wait, otherwise the second run waits for the lease;
//   - a tick overlapping a manual run: the tick and its `run --due` skip the leased asset, which stays due;
//   - a detached run followed by croft wait (two waiters; a child killed with SIGKILL is crashed, not running).
//
// Slow suite (real processes, ~30 s): it runs in the whole `bun test`. A test that meets a reported croft bug keeps
// its assertions in bugTest (test.failing) with the bug named.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addSale, CI, cleanupAll, foreignHolder, Gate, gatedAsset, initProject, intentFiles, json, killChildren, type MockApi, mockApi,
  placeOf, type Project, show, SLACK, sleep, slowSqlAsset, until,
} from "./cc-testkit.ts";
import { RunsDb } from "../../src/history/runs-db.ts";
import { bugTest, findProblem } from "../e2e/harness.ts";

let api: MockApi;
const homes: string[] = [];
beforeAll(() => {
  api = mockApi();
});
afterAll(async () => {
  api.stop();
  killChildren();
  await cleanupAll();
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

/** A project whose example_sales is built (the warehouse exists). */
async function built(): Promise<Project> {
  const { project: p } = await initProject();
  const r = await p.json(["run", "example_sales", "--only"]);
  if (r.code !== 0) throw new Error(`first run failed\n${show(r)}`);
  return p;
}

/** A gated TS ingest `name` at /<route>: its rows wait for the gate. */
function gated(p: Project, name: string, route: string, gate: Gate, o: { schedule?: string } = {}): void {
  api.route(`/${route}`, async () => {
    await gate.pass();
    return json([{ id: 1, v: "a" }, { id: 2, v: "b" }]);
  });
  p.write(`assets/${name}.ts`, gatedAsset(`${api.url}/${route}`, o));
}

/** Scheduling on for croft serve only (no OS job), in runs.sqlite: what `croft schedule on --no-os-job` records. */
function turnSchedulingOn(p: Project): void {
  const db = RunsDb.open(p.stateDir);
  try {
    db.setScheduling({ state: "on", via: "serve" });
  } finally {
    db.close();
  }
}

/** The running run of `runId` as `croft status --json` shows it. */
async function running(p: Project, runId: string): Promise<Record<string, any> | undefined> {
  const st = await p.json(["status"]);
  return (st.json.data.running as Record<string, any>[]).find((r) => r.runId === runId);
}

describe("runs and readers (slow: real processes)", () => {
  test("a run plus a query: an extraction holds no lock; a write step holds it and the query waits, naming the run", async () => {
    const p = await built();
    const gate = new Gate().closed();
    gated(p, "feed", "c1/feed", gate);
    const sleepMs = CI ? 7000 : 5000;
    p.write("assets/slow_copy.sql", slowSqlAsset("example_sales", "order_id", sleepMs));

    // 1. While the run extracts (its only request waits at the mock API), the file is not held: a query answers.
    const r1 = await p.json(["run", "feed", "--follow", "0.3s"]);
    expect(r1.code, show(r1)).toBe(6);
    const feedRun = r1.json.data.runId as string;
    await until(() => api.requests("/c1/feed").length === 1);
    const q1 = await p.json(["query", "SELECT count(*) AS n FROM example_sales"]);
    expect(q1.code, show(q1)).toBe(0);
    expect(q1.json.data.rows).toEqual([{ n: 120 }]);
    expect(q1.stderr).not.toContain("waiting for the warehouse");
    expect(q1.ms).toBeLessThan(2000 + (CI ? 2000 : 0));
    gate.open();
    const w1 = await p.json(["wait", feedRun, "--timeout", "60s"]);
    expect(w1.code, show(w1)).toBe(0);
    expect(w1.json.data.status).toBe("succeeded");

    // 2. While a write step runs (the SQL step sleeps inside its write transaction), a query waits for it; past 2 s
    //    it names the holder: the run and the asset it writes. Then it answers.
    const r2 = await p.json(["run", "slow_copy", "--follow", "0.3s"]);
    expect(r2.code, show(r2)).toBe(6);
    const slowRun = r2.json.data.runId as string;
    await until(async () => (await running(p, slowRun))?.phase === "write", 20_000, 50);
    const waiting = p.start(["query", "SELECT count(*) AS n FROM example_sales", "--json"]);
    // Meanwhile status and doctor never wait: doctor reports the writer instead of opening the file.
    const [st, doc] = await Promise.all([p.json(["status"]), p.json(["doctor"])]);
    expect(st.code, show(st)).toBe(0);
    expect(st.json.data.running.map((r: { runId: string }) => r.runId)).toContain(slowRun);
    expect(st.ms).toBeLessThan(1500 + SLACK);
    const warehouse = (doc.json.data.checks as { id: string; text: string }[]).find((c) => c.id === "warehouse");
    expect(warehouse?.text, show(doc)).toContain(`busy: croft run ${slowRun} is writing`);
    expect(waiting.proc.exitCode).toBeNull();
    const q2 = (await waiting.done) as Awaited<ReturnType<typeof p.json>>;
    expect(q2.code, show(q2)).toBe(0);
    expect(q2.json.data.rows).toEqual([{ n: 120 }]);
    expect(q2.ms).toBeGreaterThan(1500);
    expect(q2.stderr).toContain(`waiting for the warehouse: croft run ${slowRun}, writing slow_copy holds it`);
    const w2 = await p.json(["wait", slowRun, "--timeout", "60s"]);
    expect(w2.code, show(w2)).toBe(0);
    expect(w2.json.data.steps.find((s: { asset: string }) => s.asset === "slow_copy")).toMatchObject({ status: "ok", rows: { added: 120 } });
  }, 60_000);

  test("a foreign read-only holder: run --no-wait names it at once; a waiting run withdraws its intent, then writes once it lets go", async () => {
    const p = await built();
    addSale(p, 2001);
    const holder = foreignHolder(placeOf(p).database, "READ_ONLY");
    await holder.waitFor("held");

    const now = await p.json(["run", "example_sales", "--only", "--no-wait"]);
    expect(now.code, show(now)).toBe(4);
    const problem = findProblem(now.json, "DB_HELD_BY_OTHER_PROGRAM");
    expect(problem, show(now)).toBeDefined();
    expect(problem!.details.holder.pid).toBe(holder.pid);
    expect(problem!.message).toContain(`PID ${holder.pid}`);
    expect(problem!.hint).toContain(`PID ${holder.pid}`);
    expect(problem!.retryable).toBe(true);

    const waiting = p.start(["run", "example_sales", "--only", "--json", "--follow", "60s"]);
    // It announces itself and waits; after 2 s of a foreign holder it takes its intent back (croft serve would keep
    // serving meanwhile), and keeps waiting.
    await until(() => intentFiles(p).length > 0, 10_000, 10);
    const announced = Date.now();
    await until(() => intentFiles(p).length === 0, 10_000, 10);
    expect(Date.now() - announced).toBeGreaterThanOrEqual(1500);
    expect(waiting.proc.exitCode).toBeNull();
    await sleep(300);
    holder.send();
    await holder.waitFor("released");
    const r = await waiting.done;
    expect(r.code, show(r)).toBe(0);
    expect(r.json!.data.steps[0]).toMatchObject({ asset: "example_sales", status: "ok", rows: { added: 1, total: 121 } });
  }, 60_000);

  // Bug: DESIGN §5 "Lock conflicts ... After 2 s the holder is printed." `croft run` waits silently: its warehouse
  // onWait (run/runner.ts) only registers a lock waiter, so a run blocked by a foreign program (or by another run's
  // write step) says nothing until its 90 s wait ends with DB_HELD_BY_OTHER_PROGRAM; --events shows only the
  // step's "write" phase. Repro: hold warehouse.duckdb read-only in another process, then
  // `croft run example_sales --foreground` in the project: stderr stays empty for the whole wait.
  bugTest("a run blocked by a foreign holder prints the holder after 2 s (DESIGN §5)", async () => {
    const p = await built();
    addSale(p, 2002);
    const holder = foreignHolder(placeOf(p).database, "READ_ONLY");
    await holder.waitFor("held");
    const fg = p.start(["run", "example_sales", "--only", "--foreground"]);
    await sleep(3500);
    holder.send();
    const r = await fg.done;
    expect(r.code, show(r)).toBe(0);
    expect(r.stderr).toContain(`PID ${holder.pid}`);
  }, 30_000);

  test("a foreign read-write holder: croft query waits, names it after 2 s, and answers once it lets go", async () => {
    const p = await built();
    const holder = foreignHolder(placeOf(p).database, "READ_WRITE");
    await holder.waitFor("held");
    const q = p.start(["query", "SELECT count(*) AS n FROM example_sales", "--json"]);
    await sleep(3500);
    expect(q.proc.exitCode).toBeNull();
    holder.send();
    const r = await q.done;
    expect(r.code, show(r)).toBe(0);
    expect(r.json!.data.rows).toEqual([{ n: 120 }]);
    expect(r.stderr).toMatch(new RegExp(`waiting for the warehouse: .*\\(PID ${holder.pid}\\) holds it`));
  }, 30_000);

  test("two runs on one asset: --no-wait is ASSET_BUSY naming the run; a second run waits for the lease, then runs", async () => {
    const { project: p } = await initProject();
    const gate = new Gate().closed();
    gated(p, "feed", "c3/feed", gate);
    const a = await p.json(["run", "feed", "--follow", "0.3s"]);
    expect(a.code, show(a)).toBe(6);
    const first = a.json.data.runId as string;
    await until(() => api.requests("/c3/feed").length === 1);

    const busy = await p.json(["run", "feed", "--no-wait"]);
    expect(busy.code, show(busy)).toBe(4);
    const problem = findProblem(busy.json, "ASSET_BUSY");
    expect(problem, show(busy)).toBeDefined();
    expect(problem!.asset).toBe("feed");
    expect(`${problem!.message} ${JSON.stringify(problem!.details ?? {})} ${problem!.runId ?? ""}`).toContain(first);
    expect(busy.json.data.steps.map((s: { status: string }) => s.status)).toEqual(["skipped"]);

    // A second run without --no-wait waits for the lease: no request of its own until the first run is done.
    const second = p.start(["run", "feed", "--json", "--follow", "60s"]);
    await sleep(800);
    expect(second.proc.exitCode).toBeNull();
    expect(api.requests("/c3/feed").length).toBe(1);
    const openedAt = Date.now();
    gate.open();
    const r = await second.done;
    expect(r.code, show(r)).toBe(0);
    expect(r.json!.data.runId).not.toBe(first);
    expect(r.json!.data.steps[0]).toMatchObject({ asset: "feed", status: "ok", rows: { added: 0, unchanged: 2 } });
    const reqs = api.requests("/c3/feed");
    expect(reqs.length).toBe(2);
    expect(reqs[1]!.at).toBeGreaterThanOrEqual(openedAt);
    const w = await p.json(["wait", first, "--timeout", "30s"]);
    expect(w.code, show(w)).toBe(0);
    expect(w.json.data.steps[0]).toMatchObject({ asset: "feed", status: "ok", rows: { added: 2 } });
  }, 60_000);

  test("a tick overlapping a manual run: the tick and its run --due skip the leased asset, which stays due", async () => {
    const { project: p } = await initProject();
    const gate = new Gate();
    gated(p, "feed", "c4/feed", gate, { schedule: "every hour" });
    const home = realpathSync(mkdtempSync(join(tmpdir(), "croft-cc-home-")));
    homes.push(home);
    // Two hours ahead: the hourly schedule has fired since the runs by hand, which use the real clock.
    const later = new Date(Date.now() + 2 * 3600_000).toISOString();
    const sched = { HOME: home, CROFT_HOME: join(home, ".croft"), CROFT_JOB_LABEL: `dev.croft.test.${process.pid}.${Date.now()}`, CROFT_NOW: later };

    // Run by hand once: the scheduler only runs code a person has run.
    const approve = await p.json(["run", "feed"]);
    expect(approve.code, show(approve)).toBe(0);
    // Scheduling on for croft serve only, as `croft schedule on --no-os-job` records it. The command itself refuses
    // under the test tripwire (the bug test below), so the setting is written the way it writes it.
    turnSchedulingOn(p);

    // A manual run holds feed (its request waits at the mock API).
    gate.closed();
    const manual = await p.json(["run", "feed", "--follow", "0.3s"]);
    expect(manual.code, show(manual)).toBe(6);
    const manualRun = manual.json.data.runId as string;
    await until(() => api.requests("/c4/feed").length === 2);

    const tick = await p.json(["tick"], { env: sched });
    expect(tick.code, show(tick)).toBe(0);
    expect(tick.json.data.spawned).toEqual([]);
    expect(tick.json.data.held).toEqual([{ asset: "feed", code: "leased", reason: expect.stringContaining(manualRun) }]);

    // The run a tick starts (`croft run --due`) re-checks the leases: one that meets the lease skips the asset.
    const due = await p.json(["run", "--due", "feed", "--foreground"], { env: sched });
    expect(due.code, show(due)).toBe(0);
    expect(due.json.data.steps).toEqual([expect.objectContaining({ asset: "feed", status: "skipped", skippedBecause: expect.stringContaining("stays due") })]);
    expect(due.json.data.steps[0].skippedBecause).toContain(manualRun);
    expect(api.requests("/c4/feed").length).toBe(2);

    const view = async () => {
      const s = await p.json(["schedule", "status"], { env: sched });
      expect(s.code, show(s)).toBe(0);
      return (s.json.data.assets as Record<string, any>[]).find((a) => a.asset === "feed")!;
    };
    expect(await view()).toMatchObject({ due: true, held: { code: "leased" } });

    // The manual run ends; the fire is still unhandled, so the next tick starts the scheduled run.
    gate.open();
    const m = await p.json(["wait", manualRun, "--timeout", "30s"]);
    expect(m.code, show(m)).toBe(0);
    expect(await view()).toMatchObject({ due: true, held: null });
    const tick2 = await p.json(["tick"], { env: sched });
    expect(tick2.code, show(tick2)).toBe(0);
    expect(tick2.json.data.held).toEqual([]);
    expect(tick2.json.data.spawned).toEqual([{ runId: expect.any(String), assets: ["feed"] }]);
    const scheduled = await p.json(["wait", tick2.json.data.spawned[0].runId, "--timeout", "60s"], { env: sched });
    expect(scheduled.code, show(scheduled)).toBe(0);
    expect(scheduled.json.data.steps[0]).toMatchObject({ asset: "feed", status: "ok", rows: { unchanged: 2 } });
    expect(await view()).toMatchObject({ due: false });
  }, 60_000);

  // A `croft run --due` that meets a lease taken after its tick planned skips the asset "held: run … holds it; it
  // stays due", and it does stay due (DESIGN §8: "Overlaps skip. An asset still leased ... is skipped and stays due."):
  // the tick records the fire before it spawns the run, noted with the run (settings schedule.spawned), and a fire
  // the ended run never attempted goes back (schedule/due.ts), so it is not lost if the manual run then fails. Once a
  // bug (the fire was spent). The tick's run is slowed at import by a flag file, a manual run takes the lease
  // meanwhile, and `croft schedule status` then shows feed due: true.
  test("a scheduled run that meets a manual run's lease skips the asset, which stays due (the fire is not lost)", async () => {
    const { project: p } = await initProject();
    const gate = new Gate();
    api.route("/c4b/feed", async () => {
      await gate.pass();
      return json([{ id: 1, v: "a" }]);
    });
    const flag = join(p.root, "slow-import.flag");
    // Top-level code that takes a while while the flag exists (and says so): the tick's run plans (imports) slowly.
    const slowImport = `if (existsSync(${JSON.stringify(flag)})) {\n  writeFileSync(${JSON.stringify(`${flag}.seen`)}, "1");\n  await Bun.sleep(${CI ? 4000 : 2500});\n}\n`;
    p.write("assets/feed.ts", `import { existsSync, writeFileSync } from "node:fs";
${gatedAsset(`${api.url}/c4b/feed`, { schedule: "every hour" }).replace('import { ingest } from "@zabaca/croft";\n', `import { ingest } from "@zabaca/croft";\n${slowImport}`)}`);
    const home = realpathSync(mkdtempSync(join(tmpdir(), "croft-cc-home-")));
    homes.push(home);
    const base = { HOME: home, CROFT_HOME: join(home, ".croft"), CROFT_JOB_LABEL: `dev.croft.test.${process.pid}.${Date.now()}` };
    const sched = { ...base, CROFT_NOW: new Date(Date.now() + 2 * 3600_000).toISOString() };
    const approve = await p.json(["run", "feed"]);
    expect(approve.code, show(approve)).toBe(0);
    turnSchedulingOn(p);
    // A tick now: nothing is due yet, and it caches what it knows of feed (so the next tick imports nothing).
    const quiet = await p.json(["tick"], { env: base });
    expect(quiet.json.data.spawned).toEqual([]);

    p.write("slow-import.flag", "1");
    const tick = await p.json(["tick"], { env: sched });
    expect(tick.json.data.spawned).toEqual([{ runId: expect.any(String), assets: ["feed"] }]);
    const scheduledRun = tick.json.data.spawned[0].runId as string;
    // While the scheduled run imports, a person runs feed: the manual run takes the lease first.
    await until(() => p.exists("slow-import.flag.seen"), 20_000, 10);
    p.remove("slow-import.flag");
    gate.closed();
    const manual = await p.json(["run", "feed", "--follow", "0.3s"]);
    expect(manual.code, show(manual)).toBe(6);
    const skipped = await p.json(["wait", scheduledRun, "--timeout", "30s"], { env: sched });
    expect(skipped.json.data.steps[0]).toMatchObject({ asset: "feed", status: "skipped", skippedBecause: expect.stringContaining("stays due") });
    const s = await p.json(["schedule", "status"], { env: sched });
    expect((s.json.data.assets as Record<string, any>[]).find((a) => a.asset === "feed")).toMatchObject({ due: true });
    gate.open();
    await p.croft(["wait", manual.json.data.runId, "--timeout", "30s"]);
  }, 60_000);

  // Bug: `croft schedule on --no-os-job` always refuses in a test, although HOME and CROFT_HOME are temp folders as
  // its own message asks. guardRealHome (cli/commands/schedule.ts) takes the real user's home from
  // os.userInfo().homedir, which under Bun is $HOME (Node reads the passwd entry), so every HOME counts as the real
  // user's while CROFT_FORBID_OS_JOBS=1 and the command exits 1 with INTERNAL_ERROR. No test can turn scheduling on
  // through the CLI (the e2e journeys included). Repro, in a project: CROFT_FORBID_OS_JOBS=1 HOME=$(mktemp -d)
  // CROFT_HOME=$HOME/.croft croft schedule on --no-os-job --json → "refusing to change the scheduler of the real
  // user (<the temp HOME>)".
  test("croft schedule on --no-os-job works with a temp HOME and CROFT_HOME under the test tripwire", async () => {
    const { project: p } = await initProject();
    const home = realpathSync(mkdtempSync(join(tmpdir(), "croft-cc-home-")));
    homes.push(home);
    const on = await p.json(["schedule", "on", "--no-os-job"], {
      env: { HOME: home, CROFT_HOME: join(home, ".croft"), CROFT_JOB_LABEL: `dev.croft.test.${process.pid}.${Date.now()}` },
    });
    expect(on.code, show(on)).toBe(0);
    expect(on.json.data.scheduling).toMatchObject({ state: "on", via: "serve" });
  }, 30_000);

  test("a detached run followed by croft wait: two waiters get the same result; a child killed with SIGKILL is crashed", async () => {
    const { project: p } = await initProject();
    const gate = new Gate().closed();
    gated(p, "feed", "c5/feed", gate);
    const r = await p.json(["run", "feed", "--follow", "0.3s"]);
    expect(r.code, show(r)).toBe(6);
    const runId = r.json.data.runId as string;
    expect(r.json.next).toEqual([{ command: `croft wait ${runId} --timeout 100s`, reason: "still running" }]);
    const w1 = p.start(["wait", runId, "--json", "--timeout", "60s"]);
    const w2 = p.start(["wait", runId, "--json", "--timeout", "60s"]);
    await until(() => api.requests("/c5/feed").length === 1);
    await sleep(200);
    gate.open();
    const [a, b] = await Promise.all([w1.done, w2.done]);
    expect(a.code, show(a)).toBe(0);
    expect(b.code, show(b)).toBe(0);
    expect(a.json!.data.status).toBe("succeeded");
    expect(b.json!.data).toEqual(a.json!.data);

    // A run whose detached child dies (kill -9) ends as crashed for croft wait, never "still running"; its lease
    // goes, and the next run of the asset works.
    gate.closed();
    const r2 = await p.json(["run", "feed", "--follow", "0.3s"]);
    expect(r2.code, show(r2)).toBe(6);
    const crashed = r2.json.data.runId as string;
    await until(() => api.requests("/c5/feed").length === 2);
    const live = await running(p, crashed);
    expect(live, "status shows the detached run").toBeDefined();
    process.kill(live!.pid as number, "SIGKILL");
    const w = await p.json(["wait", crashed, "--timeout", "30s"]);
    expect(w.code, show(w)).toBe(1);
    expect(w.json.data).toMatchObject({ runId: crashed, status: "crashed" });
    expect(findProblem(w.json, "RUN_CRASHED"), show(w)).toBeDefined();
    gate.open();
    const again = await p.json(["run", "feed", "--follow", "30s"]);
    expect(again.code, show(again)).toBe(0);
    expect(again.json.data.status).toBe("succeeded");

    // A child killed at once, perhaps before it recorded its run: croft wait reads the spawn handshake
    // (_process.json) and reports it crashed too.
    const r3 = await p.json(["run", "feed", "--follow", "0s"]);
    expect(r3.code, show(r3)).toBe(6);
    const early = r3.json.data.runId as string;
    const handshake = JSON.parse(p.read(`.croft/logs/${early}/_process.json`)) as { pid: number };
    try {
      process.kill(handshake.pid, "SIGKILL");
    } catch {} // it may have finished already: then wait reports its real end below
    const w3 = await p.json(["wait", early, "--timeout", "30s"]);
    expect([0, 1], show(w3)).toContain(w3.code ?? -1);
    expect(w3.json.data.status, show(w3)).toBe(w3.code === 0 ? "succeeded" : "crashed");
  }, 60_000);
});
