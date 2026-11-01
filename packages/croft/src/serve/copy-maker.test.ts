// Making the read copy for croft serve in server mode (serve/copy-maker.ts, DESIGN.md D119): when it is missing, behind or
// failed, a short-lived child refreshes it, once at a time, with a wait after a failure; the server itself opens nothing.
// Nothing here needs DuckDB's extension files.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync, statSync, utimesSync } from "node:fs";
import { RunsDb } from "../history/runs-db.ts";
import { readCopyStatus } from "../db/readcopy.ts";
import { cleanup, makeProject, type TempProject } from "../read/testkit.ts";
import { CopyMaker } from "./copy-maker.ts";

const makers: CopyMaker[] = [];
afterAll(async () => {
  for (const m of makers) await m.stop();
  cleanup();
});

const SEED = ["CREATE TABLE t AS SELECT range AS n FROM range(10)"];
const serverMode = () => makeProject({ config: { serverMode: { enabled: true } }, seed: SEED });
const maker = (p: TempProject, o: Partial<ConstructorParameters<typeof CopyMaker>[0]> = {}) => {
  const m = new CopyMaker({ project: p.project, ...o });
  makers.push(m);
  return m;
};
const until = async (what: string, cond: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};
const node = (code: string) => [process.execPath, "-e", code];

/** A finished run that wrote data, by a process that is gone (the way doctor's tests make one). */
function wrote(p: TempProject, at: string): void {
  const db = RunsDb.open(p.stateDir, { now: () => new Date(at) });
  try {
    const run = db.createRun({ trigger: "manual", human: true, argv: ["run"], identity: { pid: 2 ** 22 + 9, procStart: "1", bootId: "gone" } });
    db.startStep({ runId: run.id, asset: "t", attempt: 1, reason: "never_built" });
    db.finishStep(run.id, "t", 1, { status: "ok" });
    db.finishRun(run.id, "succeeded");
  } finally {
    db.close();
  }
}

describe("when a copy is needed", () => {
  test("only where there is a warehouse: missing, behind the last run that wrote data, or failed", async () => {
    const empty = await makeProject({ config: { serverMode: { enabled: true } } });
    expect(maker(empty).need()).toBeNull(); // nothing to copy until a run creates the warehouse

    const p = await serverMode();
    expect(maker(p).need()).toBe("missing");

    // A copy, and a run that wrote after it: behind.
    const m = maker(p, { argv: node("process.exit(0)") });
    m.check();
    await until("the stand-in child", () => !m.running);
    wrote(p, "2026-10-30T10:00:00Z");
    const copy = p.project.paths.readCopy;
    await Bun.write(copy, "a copy");
    utimesSync(copy, new Date("2026-10-30T09:00:00Z"), new Date("2026-10-30T09:00:00Z"));
    expect(maker(p).need()).toBe("behind");

    // A refresh that failed.
    const db = RunsDb.open(p.stateDir);
    db.setSetting("readCopy", { requested: 1, holder: null, refreshedAt: null, method: null, heldMs: null, covers: null, lastError: { at: "2026-10-30T10:30:00Z", code: null, message: "disk full" } });
    db.close();
    expect(maker(p).need()).toBe("failed");
  });
});

describe("making it", () => {
  test("a real child makes the copy from a warehouse that nothing has run on: read-only, current, and the server opened nothing", async () => {
    const p = await serverMode();
    const done: boolean[] = [];
    const m = maker(p, { onDone: (r) => done.push(r.ok) });
    m.check();
    expect(m.running).toBe(true);
    await until("the copy", () => existsSync(p.project.paths.readCopy) && !m.running);
    expect(done).toEqual([true]);
    expect(statSync(p.project.paths.readCopy).mode & 0o222).toBe(0);
    expect(readCopyStatus(p.project).health).not.toBe("missing");
    expect(m.started).toBe(1);
    // Settled: asking again at once starts nothing.
    m.check();
    expect(m.running).toBe(false);
    expect(m.started).toBe(1);
  });

  test("one child at a time, and a failure waits before the next, longer each time", async () => {
    const p = await serverMode();
    const results: (string | null)[] = [];
    const m = maker(p, { argv: node("console.log(JSON.stringify({ status: 'failed', error: { message: 'disk full' } })); process.exit(1)"), failureWaitMs: 150, onDone: (r) => results.push(r.message) });
    m.check();
    m.check();
    expect(m.started).toBe(1);
    await until("the failure", () => results.length === 1);
    expect(m.lastFailure).toBe("disk full");
    m.check(); // inside the wait
    expect(m.started).toBe(1);
    await Bun.sleep(180);
    m.check();
    expect(m.started).toBe(2);
    await until("the second failure", () => results.length === 2);
    await Bun.sleep(180);
    m.check(); // the wait doubled to 300 ms
    expect(m.started).toBe(2);
  });

  test("another process refreshing (coalesced) or nothing to copy yet is not a copy: it waits a moment, and tries again", async () => {
    const p = await serverMode();
    const m = maker(p, { argv: node("console.log(JSON.stringify({ status: 'coalesced' }))"), failureWaitMs: 50 });
    m.check();
    await until("the child", () => !m.running);
    expect(m.lastFailure).toBe("coalesced");
  });

  test("stopping kills the child that runs, and starts no more", async () => {
    const p = await serverMode();
    const m = maker(p, { argv: node("setInterval(() => {}, 1000)") });
    m.check();
    expect(m.running).toBe(true);
    await m.stop();
    expect(m.running).toBe(false);
    m.check();
    expect(m.started).toBe(1);
  });

  test("a copy that exists and is current is left alone", async () => {
    const p = await serverMode();
    const first = maker(p);
    first.check();
    await until("the copy", () => existsSync(p.project.paths.readCopy) && !first.running);
    const again = maker(p, { argv: node("process.exit(7)") });
    again.check();
    expect(again.started).toBe(0);
    rmSync(p.project.paths.readCopy);
    again.check();
    expect(again.started).toBe(1);
  });
});
