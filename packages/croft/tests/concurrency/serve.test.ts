// Concurrency, part 2: croft serve in its own process (DESIGN.md §10 test strategy, item 4; §5 "Server mode, apps
// and GUIs": "Write intents", "Handing the file over"). The writers are real `croft run`s and the probe writer
// (probe-writer-testkit.ts), which follows croft's intent protocol and retries the lock every 5 ms, so it measures
// when croft serve really let go. Budgets are DESIGN's and measured from the writer's intent:
//   - the writer gets the file within 100 ms when no query is in flight (plus the probe's own share);
//   - within 2 s + 100 ms with a long query in flight: it may finish for 2 s, then it is interrupted;
//   - every connection is closed first, idle ones included: the lock is released only then.
// The long queries are interruptible cross joins (LONG_QUERY); a query that spends its time inside one scalar or
// list expression cannot be interrupted (review finding R31-01) and is fixed and tested elsewhere.
//
// Slow suite (real processes, ~20 s): it runs in the whole `bun test`. CROFT_CI=1 adds SLACK to every budget.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { bootId } from "../../src/core/proc.ts";
import { listIntents } from "../../src/db/intent.ts";
import {
  addSale, cleanupAll, foreignHolder, GRACE_MS, initProject, intentFiles, killChildren, LONG_QUERY, placeOf, probeWriter,
  type Project, type Reply, rowsVia, type Serve, show, SLACK, sleep, slowSqlAsset, startServe, stopServes, until, WRITER_SHARE,
  writerTimes,
} from "./cc-testkit.ts";

afterAll(async () => {
  await stopServes();
  killChildren();
  await cleanupAll();
});

const COUNT = "SELECT count(*) AS n FROM example_sales";

/** A project with example_sales built, and croft serve running on it. */
async function served(): Promise<{ p: Project; s: Serve }> {
  const { project: p } = await initProject();
  const r = await p.json(["run", "example_sales", "--only"]);
  if (r.code !== 0) throw new Error(`first run failed\n${show(r)}`);
  const s = await startServe(p);
  return { p, s };
}

/** Clients that query back to back until stop(): what an app under steady use sends. 503 is retried. */
function load(s: Serve, clients: number, sql = COUNT) {
  let stopped = false;
  const statuses: Record<number, number> = {};
  const failures: Reply[] = [];
  let maxMs = 0;
  const loop = async () => {
    while (!stopped) {
      const r = await s.query(sql).catch((e) => ({ status: -1, retryAfter: null, body: String(e), ms: 0 }) as Reply);
      statuses[r.status] = (statuses[r.status] ?? 0) + 1;
      if (r.status === 200) maxMs = Math.max(maxMs, r.ms);
      else if (r.status !== 503) failures.push(r);
      if (r.status !== 200) await sleep(50);
    }
  };
  const loops = Array.from({ length: clients }, loop);
  return {
    statuses, failures,
    get maxMs() {
      return maxMs;
    },
    async stop() {
      stopped = true;
      await Promise.all(loops);
    },
  };
}

describe("croft serve with writers (slow: real processes)", () => {
  test("under steady load while croft runs write: every query is answered, every run succeeds, and the writer gets the file within 100 ms, or 2 s + 100 ms with a long query in flight", async () => {
    const { p, s } = await served();
    const steady = load(s, 4);
    await until(() => (steady.statuses[200] ?? 0) > 20);

    // Real runs: each writes one new order while the clients keep querying.
    for (let i = 1; i <= 2; i++) {
      addSale(p, 5000 + i);
      const r = await p.json(["run", "example_sales", "--only", "--follow", "60s"]);
      expect(r.code, show(r)).toBe(0);
      expect(r.json.data.steps[0]).toMatchObject({ status: "ok", rows: { added: 1, total: 120 + i } });
    }

    // The probe writer, twice, with only short queries in flight.
    for (let i = 0; i < 2; i++) {
      const w = probeWriter(placeOf(p), `r_idle_${i}`, 100);
      const t = await writerTimes(w);
      expect(t.latency, `writer ${i} got the file ${t.latency} ms after its intent`).toBeLessThanOrEqual(100 + WRITER_SHARE + SLACK);
      await w.waitFor("released");
      await until(async () => (await s.engine()).state === "open", 5000, 20);
    }

    // A long query in flight: it runs for the 2 s grace, then is interrupted (503, Retry-After) and the writer gets in.
    const long = s.query(LONG_QUERY);
    await until(async () => (await s.engine()).inFlight >= 1, 5000, 10);
    await sleep(100);
    const w = probeWriter(placeOf(p), "r_long", 100);
    const t = await writerTimes(w);
    expect(t.latency, `the writer got the file ${t.latency} ms after its intent`).toBeGreaterThanOrEqual(GRACE_MS - 50);
    expect(t.latency, `the writer got the file ${t.latency} ms after its intent`).toBeLessThanOrEqual(GRACE_MS + 100 + WRITER_SHARE + SLACK);
    const interrupted = await long;
    expect(interrupted.status).toBe(503);
    expect(Number(interrupted.retryAfter)).toBeGreaterThanOrEqual(1);
    expect(interrupted.body.problems[0]).toMatchObject({ code: "SERVE_UNAVAILABLE", retryable: true, details: { reason: "write", writeIntent: { runId: "r_long" } } });
    await w.waitFor("released");

    await steady.stop();
    expect(steady.failures, JSON.stringify(steady.failures.slice(0, 3))).toEqual([]);
    expect(steady.statuses[200]).toBeGreaterThan(50);
    expect(await rowsVia(s, COUNT)).toEqual([{ n: 122 }]);
    expect(await rowsVia(s, "SELECT count(*) AS n FROM probe_log")).toEqual([{ n: 3 }]);
    expect(s.stderr()).toBe("");
  }, 90_000);

  test("two writers: A finishes and removes its intent while B still waits, and B gets the file (serve stays closed)", async () => {
    const { p, s } = await served();
    const steady = load(s, 2);
    const a = probeWriter(placeOf(p), "A", "stdin");
    await a.waitFor("acquired");
    // B tries the lock only every 400 ms, like a croft writer deep in its backoff: after A lets go there is a
    // window in which only the server could take the file, and it must not.
    const retryMs = 400;
    const b = probeWriter(placeOf(p), "B", 200, { retryMs });
    await b.waitFor("intent");
    await sleep(300);
    expect(b.events.some((e) => e.event === "acquired")).toBe(false);
    expect((await s.engine()).state).toBe("closed_for_write");

    a.send();
    const states = new Set<string>();
    while (!b.events.some((e) => e.event === "acquired")) {
      states.add((await s.engine()).state);
      await sleep(10);
    }
    const aReleased = (await a.waitFor("released")).t;
    const bAcquired = (await b.waitFor("acquired")).t;
    // A's intent went while B's stayed: the server stayed closed, and B got the file at its next try.
    expect([...states]).toEqual(["closed_for_write"]);
    expect(bAcquired - aReleased, `B got the file ${bAcquired - aReleased} ms after A released`).toBeLessThanOrEqual(retryMs + WRITER_SHARE + SLACK);
    await b.waitFor("released");
    expect(await rowsVia(s, "SELECT who FROM probe_log ORDER BY stamp")).toEqual([{ who: "A" }, { who: "B" }]);
    await steady.stop();
    expect(steady.failures).toEqual([]);

    // Two real runs writing at once (different assets): the second waits for the first's write step; both succeed.
    p.write("assets/slow_copy.sql", slowSqlAsset("example_sales", "order_id", 800));
    addSale(p, 6001);
    const slow = p.start(["run", "slow_copy", "--json", "--follow", "60s"]);
    const sales = p.start(["run", "example_sales", "--only", "--json", "--follow", "60s"]);
    const [r1, r2] = await Promise.all([slow.done, sales.done]);
    expect(r1.code, show(r1)).toBe(0);
    expect(r2.code, show(r2)).toBe(0);
    expect(r2.json!.data.steps[0]).toMatchObject({ asset: "example_sales", status: "ok", rows: { added: 1 } });
    expect(await rowsVia(s, COUNT)).toEqual([{ n: 121 }]);
    expect(intentFiles(p)).toEqual([]);
  }, 60_000);

  test("16 long queries at the handoff and an idle connection: the writer gets the file within 2 s + 100 ms with no connection left open, and the server reopens", async () => {
    const { p, s } = await served();
    // A pooled connection stays open after a query; an HTTP client connection stays open, idle.
    await rowsVia(s, COUNT);
    expect((await s.engine()).openConnections).toBeGreaterThan(0);
    const url = new URL(s.url);
    const idle: Socket = connect(Number(url.port), url.hostname);
    await new Promise<void>((r) => idle.once("connect", () => r()));

    const aborts = Array.from({ length: 16 }, () => new AbortController());
    const answered: Reply[] = [];
    for (const a of aborts) {
      s.query(LONG_QUERY, { signal: a.signal }).then((r) => answered.push(r), () => {});
    }
    await until(async () => {
      const e = await s.engine();
      return e.inFlight === 4 && e.queued === 12;
    }, 10_000, 20);

    const w = probeWriter(placeOf(p), "r_16", "stdin");
    const t = await writerTimes(w);
    expect(t.latency, `the writer got the file ${t.latency} ms after its intent`).toBeLessThanOrEqual(GRACE_MS + 100 + WRITER_SHARE + SLACK);
    // The file is free only once every connection is closed: the engine reports none, and queues the rest.
    const during = await s.engine();
    expect(during).toMatchObject({ state: "closed_for_write", openConnections: 0, inFlight: 0, queued: 12, writeIntent: { runId: "r_16" } });
    // The four that ran were interrupted and told to retry; the twelve queued ones are still waiting.
    await until(() => answered.length >= 4, 3000 + SLACK, 10);
    await sleep(50);
    expect(answered.length).toBe(4);
    for (const r of answered) {
      expect(r.status).toBe(503);
      expect(r.retryAfter).toBe("1");
      expect(r.body.problems[0]).toMatchObject({ code: "SERVE_UNAVAILABLE", details: { reason: "write" } });
    }

    w.send();
    await w.waitFor("released");
    await until(async () => {
      const e = await s.engine();
      return e.state === "open" && e.writeIntent === null;
    }, 5000, 20);
    // The queued long queries run now; their clients give up, and the server serves the next query.
    for (const a of aborts) a.abort();
    await until(async () => {
      const e = await s.engine();
      return e.inFlight === 0 && e.queued === 0;
    }, 10_000, 20);
    const after = await s.query(COUNT);
    expect(after.status).toBe(200);
    expect(after.body.data.rows).toEqual([{ n: 120 }]);
    expect(idle.destroyed).toBe(false);
    idle.destroy();
  }, 60_000);

  test("a stale intent whose PID was reused never keeps croft serve closed, not even at its start", async () => {
    const { p, s } = await served();
    // This test's own PID is alive, but its recorded start time is not this process's: the PID was reused.
    const writeStale = (label: string) => {
      const dir = join(p.stateDir, "write-intent.d");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${process.pid}-1000000000.json`);
      writeFileSync(file, JSON.stringify({ pid: process.pid, procStart: "1000000000", bootId: bootId(), runId: label, since: new Date().toISOString() }));
      return file;
    };
    await rowsVia(s, COUNT);
    const file = writeStale("r_stale");
    const t0 = Date.now();
    const r = await s.query(COUNT);
    expect(r.status).toBe(200);
    expect(Date.now() - t0).toBeLessThanOrEqual(1000 + SLACK);
    await until(() => !existsSync(file), 2000 + SLACK, 20);
    // It may have stepped aside for a moment (the PID exists); it reopens as soon as the start time proves it dead.
    await until(async () => {
      const e = await s.engine();
      return e.state === "open" && e.writeIntent === null;
    }, 1000 + SLACK, 20);

    // A server started while such an intent exists opens at once, and removes it.
    await s.stop();
    const again = writeStale("r_stale_2");
    const s2 = await startServe(p);
    const t1 = Date.now();
    const r2 = await s2.query(COUNT);
    expect(r2.status).toBe(200);
    expect(Date.now() - t1).toBeLessThanOrEqual(1000 + SLACK);
    expect(existsSync(again)).toBe(false);
  }, 60_000);

  // The run announces its intent (croft serve steps aside for it), keeps it for 2 s of the foreign holder (an app on
  // @zabaca/croft/read honors intents but is not recognizable, so it gets that long to step aside), then withdraws it
  // and croft serve answers again. Times are measured from the intent's own `since`, which the run writes as it
  // announces: a loaded machine delays when this test sees the intent, never when the run withdrew it. (Measured
  // from the spawn, the bound failed at 355–849 ms under load: the run had withdrawn at once on a lock error that
  // named only a PID, which is what DuckDB reports while croft serve's worker is being killed to hand the file over;
  // tests/concurrency/pidless-conflict.test.ts has the deterministic repro.)
  test("a croft run blocked by a foreign program withdraws its intent, so croft serve keeps answering; it writes once the program lets go", async () => {
    const { p, s } = await served();
    addSale(p, 7001);
    const holder = foreignHolder(placeOf(p).database, "READ_ONLY");
    await holder.waitFor("held");
    const run = p.start(["run", "example_sales", "--only", "--json", "--follow", "60s"]);
    // Every few milliseconds, whether the intent is there: when it first appears (with its since), and when it is first
    // gone after that.
    let since: number | null = null;
    let withdrawnAt: number | null = null;
    let watching = true;
    const watcher = (async () => {
      while (watching && withdrawnAt === null) {
        const live = listIntents(p.stateDir);
        if (since === null && live[0]) since = Date.parse(live[0].since);
        else if (since !== null && live.length === 0) withdrawnAt = Date.now();
        await sleep(3);
      }
    })();
    // Starting the run is not what is measured: under load it can take seconds.
    await until(() => since !== null, 30_000 + SLACK, 10);

    // A query every 150 ms while the run waits for the foreign program, until five were answered after the withdrawal.
    const replies: (Reply & { at: number })[] = [];
    const deadline = since! + 15_000 + SLACK;
    while (Date.now() < deadline && (withdrawnAt === null || replies.filter((r) => r.at > withdrawnAt!).length < 5)) {
      const at = Date.now();
      replies.push({ ...(await s.query(COUNT)), at });
      await sleep(150);
    }
    watching = false;
    await watcher;
    expect(run.proc.exitCode).toBeNull();
    expect(replies.map((r) => r.status).filter((x) => x !== 200)).toEqual([]);
    expect(replies.every((r) => r.body.data.rows[0].n === 120)).toBe(true);
    // Withdrawn, and not before 2 s of the foreign holder (DESIGN §5 "Foreign holders").
    expect(withdrawnAt, "the intent was never withdrawn").not.toBeNull();
    expect(withdrawnAt! - since!).toBeGreaterThanOrEqual(2000);
    // The queries sent after it were answered promptly.
    const late = replies.filter((r) => r.at > withdrawnAt!);
    expect(Math.max(...late.map((r) => r.ms)), JSON.stringify(replies.map((r) => [r.at - since!, Math.round(r.ms)]))).toBeLessThanOrEqual(2500 + SLACK);

    holder.send();
    const r = await run.done;
    expect(r.code, show(r)).toBe(0);
    expect(r.json!.data.steps[0]).toMatchObject({ status: "ok", rows: { added: 1, total: 121 } });
    expect(await rowsVia(s, COUNT)).toEqual([{ n: 121 }]);
  }, 60_000);
});
