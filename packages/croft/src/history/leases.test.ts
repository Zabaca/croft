import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { bootId, currentIdentity, procStart, type ProcessIdentity } from "../core/proc.ts";
import {
  acquire, busyError, holderOf, leaseAlive, listLeases, reclaimDead, release, tryAcquire, waitFor, type Lease,
} from "./leases.ts";
import { RunsDb } from "./runs-db.ts";

let dir: string;
let db: RunsDb;
let children: ChildProcess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "croft-leases-"));
  db = RunsDb.open(dir);
});
afterEach(() => {
  for (const c of children) c.kill("SIGKILL");
  children = [];
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A live process that is not us: a sleeping child. */
function otherLiveProcess(): { id: ProcessIdentity; child: ChildProcess } {
  const child = spawn("sleep", ["30"]);
  children.push(child);
  return { id: { pid: child.pid!, procStart: procStart(child.pid!)!, bootId: bootId() }, child };
}

function insertLease(l: Lease): void {
  db.sqlite.query("INSERT INTO leases (asset, run_id, pid, proc_start, boot_id, since) VALUES (?, ?, ?, ?, ?, ?)")
    .run(l.asset, l.runId, l.pid, l.procStart, l.bootId, l.since);
}

async function expectCode(p: Promise<unknown> | (() => unknown), code: string): Promise<CroftError> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(CroftError);
    expect((e as CroftError).code).toBe(code as CroftError["code"]);
    return e as CroftError;
  }
  throw new Error(`expected ${code}`);
}

describe("acquire and release", () => {
  test("a free asset is leased with this process's identity", async () => {
    const [l] = await acquire(db, "orders", "r_0922_1000_aaaa");
    const me = currentIdentity();
    expect(l).toMatchObject({ asset: "orders", runId: "r_0922_1000_aaaa", pid: me.pid, procStart: me.procStart, bootId: me.bootId });
    expect(holderOf(db, "orders")?.runId).toBe("r_0922_1000_aaaa");
    expect(release(db, "r_0922_1000_aaaa")).toEqual(["orders"]);
    expect(holderOf(db, "orders")).toBeNull();
  });

  test("re-acquiring for the same run in the same process keeps the lease", async () => {
    const [first] = await acquire(db, ["orders"], "r_0922_1000_aaaa");
    const [again] = await acquire(db, ["orders"], "r_0922_1000_aaaa", { noWait: true });
    expect(again).toEqual(first!);
  });

  test("a busy asset fails at once with --no-wait, naming the holding run", async () => {
    db.createRun({ id: "r_0922_1000_hold", trigger: "schedule", human: false, argv: ["run", "--due"] });
    await acquire(db, "orders", "r_0922_1000_hold");
    const err = await expectCode(acquire(db, "orders", "r_0922_1001_mine", { noWait: true }), "ASSET_BUSY");
    expect(err.message).toContain("orders is busy: a scheduled run r_0922_1000_hold");
    expect(err.problem).toMatchObject({
      code: "ASSET_BUSY", asset: "orders", runId: "r_0922_1000_hold", retryable: true,
      fix: { kind: "command", command: "croft wait r_0922_1000_hold" },
      details: { asset: "orders", heldBy: { runId: "r_0922_1000_hold", pid: process.pid, trigger: "schedule",
        command: "croft run --due" } },
    });
    expect(err.exit).toBe(4);
  });

  test("leases are all-or-nothing across assets", async () => {
    await acquire(db, "orders", "r_a");
    const r = tryAcquire(db, ["customers", "orders"], "r_b");
    expect(r.ok).toBe(false);
    expect(holderOf(db, "customers")).toBeNull();
    if (!r.ok) expect(r.busy.map((l) => l.asset)).toEqual(["orders"]);
    release(db, "r_a");
    const ok = tryAcquire(db, ["orders", "customers", "orders"], "r_b");
    expect(ok.ok && ok.leases.map((l) => l.asset)).toEqual(["customers", "orders"]);
  });

  test("release only touches the given run's leases", async () => {
    await acquire(db, ["a", "b"], "r_a");
    await acquire(db, ["c"], "r_c");
    expect(release(db, "r_a", "b")).toEqual(["b"]);
    expect(release(db, "r_a", "c")).toEqual([]);
    expect(listLeases(db).map((l) => [l.asset, l.runId])).toEqual([["a", "r_a"], ["c", "r_c"]]);
  });

  test("an empty selection needs no lease", () => {
    expect(tryAcquire(db, [], "r_a")).toEqual({ ok: true, leases: [], reclaimed: [] });
  });
});

describe("dead holders", () => {
  const me = () => currentIdentity();
  const since = "2026-09-22T17:00:00.000Z";

  test("a different start time means the holder is dead, and acquire reclaims it", async () => {
    const dead: Lease = { asset: "orders", runId: "r_dead", pid: me().pid, procStart: "Mon Jan  1 00:00:00 2001", bootId: me().bootId, since };
    insertLease(dead);
    expect(leaseAlive(dead)).toBe(false);
    const r = tryAcquire(db, "orders", "r_new");
    expect(r).toMatchObject({ ok: true, reclaimed: [dead] });
    expect(holderOf(db, "orders")?.runId).toBe("r_new");
  });

  test("a different boot id means dead even when the pid and start time match", () => {
    const rebooted: Lease = { asset: "orders", runId: "r_old", pid: me().pid, procStart: me().procStart, bootId: "boot-before", since };
    expect(leaseAlive(rebooted)).toBe(false);
    insertLease(rebooted);
    expect(holderOf(db, "orders")).toBeNull();   // reclaimed on read
    expect(listLeases(db)).toEqual([]);
  });

  test("a lease with no identity recorded counts as dead", () => {
    db.sqlite.query("INSERT INTO leases (asset, run_id, pid, since) VALUES ('x', 'r_x', 1, ?)").run(since);
    expect(reclaimDead(db).map((l) => l.asset)).toEqual(["x"]);
  });

  test("a holder that exited is dead; a live one is not", async () => {
    const { id, child } = otherLiveProcess();
    const lease: Lease = { asset: "orders", runId: "r_child", ...id, since };
    insertLease(lease);
    expect(leaseAlive(lease)).toBe(true);
    expect(tryAcquire(db, "orders", "r_me").ok).toBe(false);
    expect(reclaimDead(db)).toEqual([]);
    child.kill("SIGKILL");
    await new Promise((r) => child.on("exit", r));
    expect(listLeases(db)[0]?.alive).toBe(false);
    expect(reclaimDead(db)).toEqual([lease]);
    expect(tryAcquire(db, "orders", "r_me").ok).toBe(true);
  });
});

describe("waiting", () => {
  test("acquire waits for the holder to release", async () => {
    const { id } = otherLiveProcess();
    await acquire(db, "orders", "r_other", { identity: id });
    const waits: Lease[][] = [];
    setTimeout(() => release(db, "r_other"), 150);
    const t0 = Date.now();
    const [l] = await acquire(db, "orders", "r_me", { waitMs: 5000, onWait: (b) => waits.push(b) });
    expect(l?.runId).toBe("r_me");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    expect(waits).toHaveLength(1);
    expect(waits[0]?.[0]?.runId).toBe("r_other");
  });

  test("acquire gives up with ASSET_BUSY after waitMs", async () => {
    const { id } = otherLiveProcess();
    await acquire(db, "orders", "r_other", { identity: id });
    const t0 = Date.now();
    const err = await expectCode(acquire(db, "orders", "r_me", { waitMs: 200 }), "ASSET_BUSY");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
    expect((err.problem.details as { waitedMs: number }).waitedMs).toBeGreaterThanOrEqual(200);
    expect(err.message).toMatch(/\(waited 0\.[2-9] s\)$/);
  });

  test("acquire notices a holder that dies while we wait", async () => {
    const { id, child } = otherLiveProcess();
    await acquire(db, "orders", "r_other", { identity: id });
    setTimeout(() => child.kill("SIGKILL"), 100);
    const [l] = await acquire(db, "orders", "r_me", { waitMs: 5000 });
    expect(l?.runId).toBe("r_me");
  });

  test("an abort while waiting throws INTERRUPTED", async () => {
    const { id } = otherLiveProcess();
    await acquire(db, "orders", "r_other", { identity: id });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await expectCode(acquire(db, "orders", "r_me", { waitMs: 10_000, signal: ac.signal }), "INTERRUPTED");
    const pre = new AbortController();
    pre.abort();
    await expectCode(acquire(db, "free", "r_me", { signal: pre.signal }), "INTERRUPTED");
  });

  test("waitFor resolves null once free, or the holder at timeout", async () => {
    expect(await waitFor(db, "orders", { timeoutMs: 10 })).toBeNull();
    const { id } = otherLiveProcess();
    await acquire(db, "orders", "r_other", { identity: id });
    expect((await waitFor(db, "orders", { timeoutMs: 120, pollMs: 20 }))?.runId).toBe("r_other");
    setTimeout(() => release(db, "r_other"), 80);
    expect(await waitFor(db, "orders", { timeoutMs: 5000, pollMs: 20 })).toBeNull();
    expect(holderOf(db, "orders")).toBeNull();   // waitFor does not take the lease
  });
});

test("busyError describes a manual holder and how long it has held the asset", () => {
  let now = Date.parse("2026-09-22T17:00:00Z");
  const clocked = RunsDb.open(dir, { now: () => new Date(now) });
  clocked.createRun({ id: "r_0922_1000_abcd", trigger: "manual", human: true, argv: ["run", "orders"] });
  const lease: Lease = { asset: "orders", runId: "r_0922_1000_abcd", ...currentIdentity(), since: "2026-09-22T16:59:52.000Z" };
  expect(busyError(clocked, lease).message).toBe("orders is busy: run r_0922_1000_abcd (pid " + process.pid + ") has held it for 8 s");
  now += 10 * 60_000;
  expect(busyError(clocked, lease).message).toContain("for 10 min");
  expect(busyError(clocked, { ...lease, runId: "r_unknown" }).problem.details).toMatchObject({
    heldBy: { trigger: null, command: null },
  });
  clocked.close();
});
