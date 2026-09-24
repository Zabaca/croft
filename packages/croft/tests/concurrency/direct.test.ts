// Concurrency, part 3: apps reading in direct mode (DESIGN.md §10 test strategy, item 4 "three direct app readers
// against one writer"; §5 "@zabaca/croft/read", "Direct mode"). Three app processes run the public query() back to
// back with no croft serve, each opening the live file read-only per query. A reader that finds a live write intent
// does not open the file (it waits up to 2 s), so however the readers overlap, a writer is never starved: without
// that, two overlapping readers held a writer off for 2.4 s [V].
//
// Slow suite (real processes, ~7 s): it runs in the whole `bun test`. CROFT_CI=1 adds SLACK to every budget.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootId } from "../../src/core/proc.ts";
import { query } from "../../src/read.ts";
import {
  addSale, cleanupAll, directReader, initProject, killChildren, type LineChild, placeOf, probeWriter, type Project, show, SLACK,
  sleep, WRITER_SHARE, writerTimes,
} from "./cc-testkit.ts";

afterAll(async () => {
  killChildren();
  await cleanupAll();
});

const COUNT = "SELECT count(*) AS n FROM example_sales";

async function built(): Promise<Project> {
  const { project: p } = await initProject();
  const r = await p.json(["run", "example_sales", "--only"]);
  if (r.code !== 0) throw new Error(`first run failed\n${show(r)}`);
  return p;
}

interface Summary { ok: number; errors: Record<string, number>; maxMs: number; values: [number, number]; monotonic: boolean }

async function stopReader(r: LineChild): Promise<Summary> {
  r.send("stop");
  return (await r.waitFor("done")) as unknown as Summary;
}

describe("apps reading directly (slow: real processes)", () => {
  test("three direct readers against one writer: the writer gets the file at once, and the readers never fail and see its rows", async () => {
    const p = await built();
    // Three app processes, each with two queries in flight at a time (they share one open instance).
    const readers = [0, 1, 2].map(() => directReader(p.root, COUNT, 2));
    for (const r of readers) await r.waitFor("ready");
    await sleep(300);

    // The probe writer, three times: each gets the file within 100 ms of its intent, as if nobody read.
    for (let i = 0; i < 3; i++) {
      const w = probeWriter(placeOf(p), `r_direct_${i}`, 150);
      const t = await writerTimes(w);
      expect(t.latency, `writer ${i} got the file ${t.latency} ms after its intent`).toBeLessThanOrEqual(100 + WRITER_SHARE + SLACK);
      await w.waitFor("released");
      await sleep(150);
    }

    // Real runs, each writing one order, while the readers keep reading.
    for (let i = 1; i <= 2; i++) {
      addSale(p, 8000 + i);
      const r = await p.json(["run", "example_sales", "--only", "--follow", "60s"]);
      expect(r.code, show(r)).toBe(0);
      expect(r.json.data.steps[0]).toMatchObject({ status: "ok", rows: { added: 1, total: 120 + i } });
      await sleep(200);
    }

    for (const r of readers) {
      const s = await stopReader(r);
      expect(s.errors, JSON.stringify(s)).toEqual({});
      expect(s.ok).toBeGreaterThan(20);
      expect(s.monotonic).toBe(true);
      expect(s.values).toEqual([120, 122]);
      // A reader waits at most for one write step (and the 2 s intent wait), never for the lock retries' 5 s.
      expect(s.maxMs).toBeLessThan(2500 + SLACK);
    }
  }, 60_000);

  test("a stale intent whose PID was reused does not hold a direct reader back", async () => {
    const p = await built();
    expect(await query(COUNT, [], { project: p.root })).toEqual([{ n: 120 }]); // loads direct mode first
    const dir = join(p.stateDir, "write-intent.d");
    mkdirSync(dir, { recursive: true });
    // This process's PID with another start time: the writer that recorded it is gone, and the PID was reused.
    writeFileSync(join(dir, `${process.pid}-1000000000.json`),
      JSON.stringify({ pid: process.pid, procStart: "1000000000", bootId: bootId(), runId: "r_stale", since: new Date().toISOString() }));
    const t0 = performance.now();
    const rows = await query(COUNT, [], { project: p.root });
    expect(rows).toEqual([{ n: 120 }]);
    // A live intent would hold it back for 2 s; a dead one not at all.
    expect(performance.now() - t0).toBeLessThan(1500);
  }, 30_000);
});
