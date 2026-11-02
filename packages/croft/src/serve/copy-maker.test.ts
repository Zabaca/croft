// Making the read copy for croft serve in server mode (serve/copy-maker.ts, DESIGN.md D119): when it is missing, behind or
// failed, a short-lived child refreshes it, once at a time, with a wait after a failure; the server itself opens nothing.
// Nothing here needs DuckDB's extension files.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunsDb } from "../history/runs-db.ts";
import { readCopyStatus } from "../db/readcopy.ts";
import { cleanup, makeProject, type TempProject } from "../read/testkit.ts";
import { type CopyNeed, CopyMaker } from "./copy-maker.ts";

setDefaultTimeout(60_000); // as readers-testkit.ts: real child processes
const makers: CopyMaker[] = [];
const controls: string[] = [];
afterAll(async () => {
  for (const m of makers) await m.stop();
  for (const d of controls) rmSync(d, { recursive: true, force: true });
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

// ---- ending a child (D122) ---------------------------------------------------------------------------------------------------------
// A real refresh (serve/refresh-slow-testkit.ts) held under the write lease between the checkpoint of the live warehouse and the clone.
describe("ending a real refresh in the middle of its copy", () => {
  const FIXTURE = join(import.meta.dir, "refresh-slow-testkit.ts");
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const control = () => {
    const d = mkdtempSync(join(tmpdir(), "croft-refresh-"));
    controls.push(d);
    return d;
  };
  const slow = (p: TempProject, dir: string, graceMs = 60_000) => [process.execPath, "--no-env-file", FIXTURE, p.root, dir, String(graceMs)];
  const rowsOf = async (file: string, table: string) => {
    const db = await DuckDBInstance.create(file, { access_mode: "READ_ONLY" });
    try {
      const c = await db.connect();
      return Number((await c.runAndReadAll(`SELECT count(*) AS n FROM ${table}`)).getRowObjectsJS()[0]!.n);
    } finally {
      db.closeSync();
    }
  };

  test("stopping asks first (SIGTERM): the child finishes the refresh it is in, the copy is whole, and nothing was killed", async () => {
    const p = await serverMode();
    const dir = control();
    const done: { need: CopyNeed; ok: boolean; message: string | null }[] = [];
    const m = maker(p, { argv: slow(p, dir), stopGraceMs: 30_000, onDone: (r) => done.push(r) });
    m.check();
    await until("the refresh to reach its pause", () => existsSync(join(dir, "checkpointed")));
    const pid = Number(readFileSync(join(dir, "checkpointed"), "utf8"));
    const stopping = m.stop();
    await Bun.sleep(400); // long enough for a SIGKILL to have landed
    expect(alive(pid)).toBe(true);
    expect(existsSync(p.project.paths.readCopy)).toBe(false);
    writeFileSync(join(dir, "proceed"), "");
    await stopping;
    expect(alive(pid)).toBe(false);
    expect(done).toEqual([{ need: "missing", ok: true, message: null }]);
    m.check(); // stopped: no more children
    expect(m.started).toBe(1);
    expect(statSync(p.project.paths.readCopy).mode & 0o222).toBe(0);
    expect(await rowsOf(p.project.paths.readCopy, "t")).toBe(10);
    expect(await rowsOf(p.database, "t")).toBe(10);
  }, 60_000);

  test("a child that has not finished when the grace is over is killed, and the live warehouse is whole", async () => {
    const p = await serverMode();
    const dir = control();
    const done: { need: CopyNeed; ok: boolean; message: string | null }[] = [];
    const m = maker(p, { argv: slow(p, dir), stopGraceMs: 600, onDone: (r) => done.push(r) });
    m.check();
    await until("the refresh to reach its pause", () => existsSync(join(dir, "checkpointed")));
    const pid = Number(readFileSync(join(dir, "checkpointed"), "utf8"));
    const t = Date.now();
    await m.stop();
    const took = Date.now() - t;
    expect(took).toBeGreaterThanOrEqual(500);
    expect(took).toBeLessThan(10_000);
    expect(alive(pid)).toBe(false);
    expect(done).toHaveLength(1);
    expect(done[0]!.ok).toBe(false);
    expect(existsSync(p.project.paths.readCopy)).toBe(false);
    expect(await rowsOf(p.database, "t")).toBe(10);
  }, 60_000);

  test("a child whose croft serve was killed notices, and ends itself within its grace", async () => {
    const p = await serverMode();
    const dir = control();
    // A stand-in croft serve: a process that starts the maker, and is then killed without a chance to stop anything.
    const script = `
      import { CopyMaker } from ${JSON.stringify(join(import.meta.dir, "copy-maker.ts"))};
      import { loadProject } from ${JSON.stringify(join(import.meta.dir, "../project/root.ts"))};
      const m = new CopyMaker({ project: loadProject({ root: ${JSON.stringify(p.root)} }), argv: ${JSON.stringify(slow(p, dir, 700))} });
      m.check();
      setInterval(() => {}, 1000);`;
    const parent = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { stdout: "ignore", stderr: "pipe" });
    try {
      await until("the refresh to reach its pause", () => existsSync(join(dir, "checkpointed")));
      const pid = Number(readFileSync(join(dir, "checkpointed"), "utf8"));
      expect(alive(pid)).toBe(true);
      parent.kill("SIGKILL");
      await parent.exited;
      // Within half a second it sees its parent gone, and 700 ms later it is gone itself: it was held far longer than that.
      await until("the orphan to end", () => !alive(pid), 15_000);
      expect(existsSync(p.project.paths.readCopy)).toBe(false);
      expect(await rowsOf(p.database, "t")).toBe(10);
    } finally {
      parent.kill("SIGKILL");
    }
  }, 60_000);
});
