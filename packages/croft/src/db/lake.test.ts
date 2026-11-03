// The parts of lake mode that need no lake (DESIGN.md D139, D142, D144; option 07, slice 2): how a lake's errors are told apart (against the
// messages DuckDB, DuckLake and Postgres really gave in the spike and in db/lake-warehouse.test.ts), croft's lock on the writes of a machine
// (taken, waited for, reclaimed from a writer that was killed), the types a lake cannot hold, and the record of which machine wrote.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { isCommitFailure, isConflict, isConnectionError, lakeInexactColumns, lakeRefusedColumns, refuseInexactTypes, LakeWriteLock, machineId, newCommitTag, parseWriter, refuseUnfitLakeColumns, writerRecord, writerReport } from "./lake.ts";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const folder = (): string => {
  const d = mkdtempSync(join(tmpdir(), "croft-lake-"));
  made.push(d);
  return d;
};

describe("telling a lake's errors apart", () => {
  test("a connection that dropped, as the real ones said it", () => {
    for (const m of [
      'TransactionContext Error: Failed to commit: Failed to commit DuckLake transaction.\nFailed to get global stats information from DuckLake: Failed to prepare COPY "COPY (SELECT ...) TO STDOUT (FORMAT "binary");": server closed the connection unexpectedly\n\tThis probably means the server terminated abnormally',
      'Invalid Error: Failed to execute query "ROLLBACK": no connection to the server',
      'IO Error: Failed to query most recent snapshot for DuckLake: Unable to connect to Postgres at "": connection to server at "127.0.0.1", port 61946 failed: Connection refused',
      "FATAL: terminating connection due to administrator command",
      "the database system is shutting down",
      "SSL SYSCALL error: EOF detected",
    ]) expect(isConnectionError(new Error(m)), m).toBe(true);
  });

  test("a refusal is not a connection that dropped: waiting does not change a wrong password or a key the store does not know", () => {
    for (const m of [
      'connection to server at "127.0.0.1", port 5432 failed: FATAL:  password authentication failed for user "lakew"',
      'connection to server at "db", port 5432 failed: FATAL:  role "nobody" does not exist',
      "HTTP Error: HTTP GET error (HTTP 403 Forbidden) InvalidAccessKeyId",
    ]) expect(isConnectionError(new Error(m)), m).toBe(false);
    expect(isConnectionError(new Error("Binder Error: table x does not exist"))).toBe(false);
    expect(isConnectionError("a string")).toBe(false);
  });

  test("a commit that could not finish, and a conflict", () => {
    expect(isCommitFailure(new Error("TransactionContext Error: Failed to commit: Failed to commit DuckLake transaction."))).toBe(true);
    expect(isCommitFailure(new Error("Binder Error: nope"))).toBe(false);
    expect(isConflict(new Error("Transaction conflict - attempting to modify table 1 that another transaction has changed"))).toBe(true);
    expect(isConflict(new Error("database is locked"))).toBe(true);
    expect(isConflict(new Error("Binder Error: nope"))).toBe(false);
  });

  test("a commit tag is new each time and holds nothing a statement could misread", () => {
    const a = newCommitTag();
    expect(a).not.toBe(newCommitTag());
    expect(a).toMatch(/^croft:\d+:[0-9a-f-]{36}$/);
  });
});

describe("the types a lake cannot hold", () => {
  test("ENUM, UNION, VARINT, BIT and a fixed-size ARRAY, also inside a STRUCT, a LIST or a MAP, and nothing else", () => {
    const cols = [
      { name: "a", type: "ENUM('x', 'y')" }, { name: "b", type: "UNION(num INTEGER, str VARCHAR)" }, { name: "c", type: "VARINT" },
      { name: "d", type: "STRUCT(s ENUM('p', 'q'), n INTEGER)" }, { name: "e", type: "ENUM('a')[]" }, { name: "f", type: "MAP(VARCHAR, UNION(i INTEGER))" },
      { name: "g", type: "VARCHAR" }, { name: "h", type: "BIGINT[]" }, { name: "i", type: "STRUCT(enumeration VARCHAR)" }, { name: "j", type: "HUGEINT" }, { name: "k", type: "BIGNUM" },
      { name: "l", type: "BIT" }, { name: "m", type: "INTEGER[3]" }, { name: "n", type: "STRUCT(a VARCHAR[2])" }, { name: "o", type: "STRUCT(bit INTEGER)" }, { name: "p", type: "BIGINT[][]" },
    ];
    expect(lakeRefusedColumns(cols).map((c) => [c.name, c.kind])).toEqual([["a", "ENUM"], ["b", "UNION"], ["c", "VARINT"], ["d", "ENUM"], ["e", "ENUM"], ["f", "UNION"], ["k", "VARINT"], ["l", "BIT"], ["m", "ARRAY"], ["n", "ARRAY"]]);
  });

  test("LAKE_TYPE_UNSUPPORTED names every column, the cast that fixes each, and that nothing was written", () => {
    let caught: unknown;
    try {
      refuseUnfitLakeColumns("orders", [{ name: "status", type: "ENUM('open','closed')" }, { name: "big", type: "VARINT" }, { name: "flags", type: "BIT" }, { name: "xy", type: "DOUBLE[2]" }, { name: "ok", type: "INTEGER" }], "assets/orders.sql");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CroftError);
    const p = (caught as CroftError).problem;
    expect(p.code).toBe("LAKE_TYPE_UNSUPPORTED");
    expect(p.message).toContain("status is ENUM('open','closed')");
    expect(p.hint).toContain("CAST(status AS VARCHAR) AS status");
    expect(p.hint).toContain("CAST(big AS DECIMAL(38,0)) AS big");
    expect(p.hint).toContain("CAST(flags AS VARCHAR) AS flags");
    expect(p.hint).toContain("CAST(xy AS DOUBLE[]) AS xy");
    expect(p.effect).toBe("nothing was written");
    expect(p.file).toBe("assets/orders.sql");
    expect(p.fix).toMatchObject({ kind: "manual" });
    expect(() => refuseUnfitLakeColumns("orders", [{ name: "ok", type: "INTEGER" }])).not.toThrow();
  });
});

describe("which machine wrote", () => {
  test("the machine id is the same every time, 16 hex digits, and the record round-trips", () => {
    expect(machineId()).toMatch(/^[0-9a-f]{16}$/);
    expect(machineId()).toBe(machineId());
    const at = new Date("2026-11-02T12:00:00.000Z");
    const rec = writerRecord("r_1", at);
    expect(rec).toMatchObject({ machine: machineId(), run: "r_1", at: "2026-11-02T12:00:00.000Z" });
    expect(parseWriter(JSON.stringify(rec))).toEqual(rec);
    // $CROFT_MACHINE_ID names the machine, and a machine named differently is another machine.
    const before = process.env.CROFT_MACHINE_ID;
    try {
      process.env.CROFT_MACHINE_ID = "box-a";
      const a = machineId();
      process.env.CROFT_MACHINE_ID = "box-b";
      expect(machineId()).not.toBe(a);
      expect(a).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      if (before === undefined) delete process.env.CROFT_MACHINE_ID;
      else process.env.CROFT_MACHINE_ID = before;
    }
    // The counter orders the machines' writes whatever their clocks say, and a crossing stays 7 days.
    const me = machineId();
    const DAY = 86_400_000;
    const t = Date.parse("2026-11-02T12:00:00.000Z");
    const row = (machine: string, n: number, at: number, crossed: unknown = null) => ({ key: `writer.${machine}`, value: JSON.stringify({ machine, host: machine, at: new Date(at).toISOString(), run: null, croft: "x", n, crossed }) });
    const behind = writerRecord("r", new Date(t), [row(me, 1, t), row("other", 2, t - 3 * DAY)]); // the other wrote after, by a clock three days behind
    expect(behind.n).toBe(3);
    expect(behind.crossed).toMatchObject({ machine: "other", at: new Date(t - 3 * DAY).toISOString() });
    expect(writerRecord("r", new Date(t), [row(me, 5, t), row("other", 2, t + DAY)]).crossed).toBeNull(); // ahead by the clock, before by the lake's order
    expect(writerRecord("r", new Date(t), []).n).toBe(1);
    expect(writerRecord("r", new Date(t), [row("other", 7, t - DAY)]).crossed).toMatchObject({ machine: "other" }); // a machine's first write
    const meta = (n: number, crossed: unknown) => Object.fromEntries([row(me, n, t, crossed), row("other", 2, t - 3 * DAY)].map((r) => [r.key, r.value]));
    expect(writerReport(meta(1, null), t).crossing).toMatchObject({ machine: "other" }); // written since: by the counter
    const found = { machine: "other", host: "other", at: new Date(t - 3 * DAY).toISOString(), run: null, seen: new Date(t).toISOString() };
    expect(writerReport(meta(3, found), t + 6 * DAY).crossing).toMatchObject({ machine: "other" }); // kept after this machine wrote over it
    expect(writerReport(meta(3, found), t + 8 * DAY).crossing).toBeNull(); // 7 days after the write that found it
    expect(writerRecord("r", new Date(t + 2 * DAY), [row(me, 3, t, found), row("other", 2, t - 3 * DAY)]).crossed).toMatchObject({ machine: "other" }); // carried by a clean write
    expect(writerRecord("r", new Date(t + 8 * DAY), [row(me, 3, t, found), row("other", 2, t - 3 * DAY)]).crossed).toBeNull();
    expect(writerReport({ [`writer.other`]: row("other", 2, t).value }, t).crossing).toBeNull(); // this machine never wrote
    expect(parseWriter("not json")).toBeNull();
    expect(parseWriter(undefined)).toBeNull();
    expect(parseWriter('{"x":1}')).toBeNull();
  });
});

const busy = (h: unknown, waited: number) => new CroftError("DB_BUSY", { message: `busy ${JSON.stringify(h)} ${waited}`, hint: "" });
const aborted = () => new CroftError("INTERRUPTED", { message: "stopped", hint: "" });

describe("croft's lock on the writes of a machine", () => {
  test("is taken, shows its holder, and is released", async () => {
    const lock = new LakeWriteLock(folder());
    expect(lock.holder()).toBeNull();
    const release = await lock.acquire({ waitMs: 100, runId: "r_1", asset: "orders", label: "ingest orders", busy, aborted });
    expect(lock.holder()).toMatchObject({ pid: process.pid, program: "croft", runId: "r_1", asset: "orders", action: "write" });
    release();
    expect(lock.holder()).toBeNull();
    // And again: a lock released is free.
    (await lock.acquire({ waitMs: 100, label: "x", busy, aborted }))();
  });

  test("makes a second taker wait, and tells it who holds the lock when the wait runs out", async () => {
    const dir = folder();
    const a = new LakeWriteLock(dir);
    const b = new LakeWriteLock(dir);
    const release = await a.acquire({ waitMs: 100, runId: "r_a", label: "a", busy, aborted });
    const started = Date.now();
    const err = await b.acquire({ waitMs: 300, runId: "r_b", label: "b", busy, aborted }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CroftError);
    expect((err as CroftError).message).toContain("r_a");
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    // A taker that is waiting gets it the moment it is released.
    const waiting = b.acquire({ waitMs: 5000, runId: "r_b", label: "b", busy, aborted });
    setTimeout(release, 150);
    (await waiting)();
  });

  test("hands out one writer at a time among many", async () => {
    const dir = folder();
    let inside = 0;
    let most = 0;
    await Promise.all(Array.from({ length: 8 }, async (_, i) => {
      const release = await new LakeWriteLock(dir).acquire({ waitMs: 20_000, runId: `r_${i}`, label: "w", busy, aborted });
      inside++;
      most = Math.max(most, inside);
      await Bun.sleep(15);
      inside--;
      release();
    }));
    expect(most).toBe(1);
  });

  test("is given up to a signal at once", async () => {
    const dir = folder();
    const release = await new LakeWriteLock(dir).acquire({ waitMs: 100, label: "a", busy, aborted });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const err = await new LakeWriteLock(dir).acquire({ waitMs: 20_000, label: "b", signal: ac.signal, busy, aborted }).catch((e: unknown) => e);
    expect((err as CroftError).code).toBe("INTERRUPTED");
    release();
  });

  test("is reclaimed from a writer that was killed (kill -9), by the next taker", async () => {
    const dir = folder();
    const script = `import { LakeWriteLock } from ${JSON.stringify(join(import.meta.dir, "lake.ts"))};
      const l = new LakeWriteLock(${JSON.stringify(dir)});
      await l.acquire({ waitMs: 1000, runId: "r_dead", label: "x", busy: (h) => new Error("busy"), aborted: () => new Error("stopped") });
      console.log("HELD");
      await Bun.sleep(60000);`;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "inherit", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
    try {
      const reader = child.stdout.getReader();
      let seen = "";
      while (!seen.includes("HELD")) {
        const r = await reader.read();
        if (r.done) throw new Error(`the child ended: ${seen}`);
        seen += new TextDecoder().decode(r.value);
      }
      const lock = new LakeWriteLock(dir);
      expect(lock.holder()).toMatchObject({ pid: child.pid, runId: "r_dead" });
      child.kill("SIGKILL");
      await child.exited;
      expect(lock.holder()).toBeNull(); // the dead holder is found out and reclaimed on the way
      (await lock.acquire({ waitMs: 1000, label: "next", busy, aborted }))();
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);

  test("two waiters that judged a holder dead: the one that is late does not remove the lock the first let a new taker make", async () => {
    const dir = folder();
    const lockDir = join(dir, "lake-write.lock");
    mkdirSync(lockDir);
    const dead = { pid: 2_147_483_000, procStart: "never", bootId: "never", runId: "r_dead", label: "x", since: "2026-11-01T00:00:00.000Z" };
    writeFileSync(join(lockDir, "holder.json"), JSON.stringify(dead));
    type Inside = { read(): unknown; reclaim(judged: unknown): void };
    const late = new LakeWriteLock(dir);
    const judgedByLate = (late as unknown as Inside).read(); // the late waiter has looked and judged the holder dead ...
    expect(judgedByLate).toMatchObject({ runId: "r_dead" });
    const first = new LakeWriteLock(dir);
    expect(first.holder()).toBeNull(); // ... the first reclaims it ...
    const taker = new LakeWriteLock(dir);
    const release = await taker.acquire({ waitMs: 100, runId: "r_live", label: "live", busy, aborted }); // ... and a new taker makes the lock ...
    try {
      (late as unknown as Inside).reclaim(judgedByLate); // ... and only then does the late waiter act on what it saw.
      expect(taker.holder()).toMatchObject({ pid: process.pid, runId: "r_live" }); // the live lock is still there
    } finally {
      release();
    }
    // A reclaimer's own lock does not outlive it, and one left by a reclaimer that died is cleared after a while.
    expect(existsSync(`${lockDir}.reclaim`)).toBe(false);
    mkdirSync(`${lockDir}.reclaim`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${lockDir}.reclaim`, old, old);
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "holder.json"), JSON.stringify(dead));
    const again = new LakeWriteLock(dir);
    expect(again.holder()).toBeNull(); // the stale reclaim lock is cleared by this try ...
    expect(again.holder()).toBeNull(); // ... and the dead holder is reclaimed by the next
    expect(existsSync(lockDir)).toBe(false);
  });

  test("a dead holder that a reclaim cannot remove (another reclaimer's lock is fresh) is waited on, not spun on", async () => {
    const dir = folder();
    const lockDir = join(dir, "lake-write.lock");
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "holder.json"), JSON.stringify({ pid: 2_147_483_000, procStart: "never", bootId: "never", runId: "r_dead", label: "x", since: "2026-11-01T00:00:00.000Z" }));
    mkdirSync(`${lockDir}.reclaim`); // a reclaimer that is at it (or died a moment ago): this one's reclaim removes nothing
    class Counting extends LakeWriteLock {
      looks = 0;
      override holder() {
        this.looks++;
        return super.holder();
      }
    }
    const lock = new Counting(dir);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 600);
    const err = await lock.acquire({ waitMs: 20_000, label: "w", signal: ac.signal, busy, aborted }).catch((e: unknown) => e);
    expect((err as CroftError).code).toBe("INTERRUPTED");
    expect(lock.looks).toBeLessThan(40); // a spin would have looked thousands of times, starting `ps` each
    expect(lock.looks).toBeGreaterThan(1);
  });

  test("a lock folder whose taker died before it wrote its name is stale after a while, not at once", async () => {
    const dir = folder();
    const lockDir = join(dir, "lake-write.lock");
    mkdirSync(lockDir);
    const lock = new LakeWriteLock(dir);
    expect(lock.holder()).toMatchObject({ pid: null, program: "croft" }); // just made: its taker may be about to write its name
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockDir, old, old);
    expect(lock.holder()).toBeNull();
    writeFileSync(join(dir, "other"), "x");
    (await lock.acquire({ waitMs: 1000, label: "next", busy, aborted }))();
  });
});

describe("the types a lake stores inexactly (D174)", () => {
  test("HUGEINT, UHUGEINT, INTERVAL and TIMETZ, also inside a STRUCT, a LIST or a MAP, by the column's type", () => {
    const cols = [
      { name: "a", type: "HUGEINT" }, { name: "b", type: "UHUGEINT" }, { name: "c", type: "INTERVAL" }, { name: "d", type: "TIME WITH TIME ZONE" },
      { name: "e", type: "STRUCT(h HUGEINT, n INTEGER)" }, { name: "f", type: "HUGEINT[]" }, { name: "g", type: "MAP(VARCHAR, INTERVAL)" },
      { name: "h", type: "DECIMAL(38,0)" }, { name: "i", type: "BIGINT" }, { name: "j", type: "STRUCT(interval VARCHAR)" }, { name: "k", type: "TIME" },
      { name: "l", type: "TIMESTAMP WITH TIME ZONE" },
    ];
    expect(lakeInexactColumns(cols).map((c) => [c.name, c.kind, c.nested])).toEqual([
      ["a", "HUGEINT", false], ["b", "UHUGEINT", false], ["c", "INTERVAL", false], ["d", "TIMETZ", false],
      ["e", "HUGEINT", true], ["f", "HUGEINT", true], ["g", "INTERVAL", true],
    ]);
  });

  test("LAKE_VALUES_INEXACT names every column and the cast that keeps it exact, and that nothing was written", () => {
    let caught: unknown;
    try {
      refuseInexactTypes("totals", [{ name: "big", type: "HUGEINT" }, { name: "gap", type: "INTERVAL" }, { name: "at", type: "TIME WITH TIME ZONE" }, { name: "st", type: "STRUCT(h HUGEINT)" }, { name: "ok", type: "BIGINT" }], "assets/totals.sql");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CroftError);
    const p = (caught as CroftError).problem;
    expect(p.code).toBe("LAKE_VALUES_INEXACT");
    expect(p.message).toContain("big is HUGEINT");
    expect(p.hint).toContain("CAST(big AS DECIMAL(38,0)) AS big");
    expect(p.hint).toContain("CAST(gap AS VARCHAR) AS gap");
    expect(p.hint).toContain("CAST(at AS TIME) AS at");
    expect(p.hint).toContain("to_json(st)");
    expect(p.effect).toBe("nothing was written");
    expect(p.file).toBe("assets/totals.sql");
    expect(() => refuseInexactTypes("totals", [{ name: "ok", type: "DECIMAL(38,0)" }])).not.toThrow();
    // A write that has both kinds is told the unsupported ones first, and the inexact ones once they are fixed.
    expect(() => refuseUnfitLakeColumns("t", [{ name: "e", type: "ENUM('a')" }, { name: "h", type: "HUGEINT" }])).toThrow(/cannot store/);
    expect(() => refuseUnfitLakeColumns("t", [{ name: "h", type: "HUGEINT" }])).toThrow(/differently from the ones written/);
  });
});
