// croft serve answers from the read copy (readCopy in croft.json) while a writer holds the live file (DESIGN.md §5
// "Server mode, apps and GUIs"): the data carries stale: true and asOf, the copy's mtime in the project offset.
// Queries that wait in the queue when the server steps aside, and queries interrupted for the writer, move to the
// copy too. With readCopy off, or no copy yet, queries wait for the writer as before.
import { afterAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { copyFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { post } from "../read/http.ts";
import { cleanup, makeProject, seed, spawnHolder, type TempProject } from "../read/testkit.ts";
import { openServeEngine, type ServeEngineInternals } from "./instance.ts";
import { type RunningServer, startServer } from "./server.ts";
import type { ServeEngine, ServeEngineOptions, ServeQueryData } from "./types.ts";

const CI = process.env.CROFT_CI === "1";
const SLACK = CI ? 600 : 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** What serve/types.ts ServeQueryData carries for an answer from the read copy. */
type Answer = ServeQueryData & { stale?: true; asOf?: string };

const engines: ServeEngine[] = [];
const children: ChildProcess[] = [];
const servers: RunningServer[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop(true).catch(() => {});
  for (const e of engines) await e.close().catch(() => {});
  for (const c of children) c.kill("SIGKILL");
  cleanup();
});

async function engine(p: TempProject, o: Partial<ServeEngineOptions & ServeEngineInternals> = {}): Promise<ServeEngine> {
  const e = await openServeEngine({ root: p.root, resources: { threads: 2 }, ...o });
  engines.push(e);
  return e;
}

async function until(what: string, cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

async function rejection(p: Promise<unknown>): Promise<CroftError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
  throw new Error("expected a CroftError");
}

const q = (sql: string, o: { limit?: number; signal?: AbortSignal } = {}) => ({ sql, params: [], limit: o.limit ?? 10_000, signal: o.signal });
const ask = (e: ServeEngine, sql: string, o: { limit?: number } = {}) => e.query(q(sql, o)) as Promise<Answer>;

/**
 * A project whose warehouse has `live` applied after `copied`, and a read copy of the `copied` state with the
 * given mtime. The copy is made the way the refresh leaves it: a whole file renamed into place.
 */
async function project(o: { readCopy?: boolean; copied: string[]; live?: string[]; asOf?: string; copy?: boolean }): Promise<TempProject> {
  const p = await makeProject({ config: { readCopy: o.readCopy ?? true }, seed: o.copied });
  copyFileSync(p.database, template(p)); // this process holds no lock on the file yet
  if (o.copy !== false) placeCopy(p, template(p), o.asOf ?? "2026-09-23T10:00:00Z");
  if (o.live) await seed(p.database, o.live);
  return p;
}

/** The copied state, kept aside: new copies are made from it, never from a file the engine may have open (closing a
 *  descriptor on a file drops this process's DuckDB lock on it, §5). */
const template = (p: TempProject) => join(p.root, "template.duckdb");

/** Put `from` in place as the read copy, with mtime `asOf`, the way a refresh does: a whole file renamed over it. */
function placeCopy(p: TempProject, from: string, asOf: string): void {
  const tmp = `${p.project.paths.readCopy}.test-tmp`;
  copyFileSync(from, tmp);
  const at = new Date(asOf);
  utimesSync(tmp, at, at);
  renameSync(tmp, p.project.paths.readCopy);
}

/** A new read copy: the copied state plus `statements`. */
async function replaceCopy(p: TempProject, statements: string[], asOf: string): Promise<void> {
  const next = join(p.root, "next.duckdb");
  copyFileSync(template(p), next);
  await seed(next, statements);
  placeCopy(p, next, asOf);
}

// A croft writer in a child process: warehouse.ts's write lease (intent, lock, linger), held for holdMs.
const WRITER = `
const { openWarehouse } = await import(process.env.CROFT_WAREHOUSE_TS);
const [path, root, stateDir, label, holdMs] = process.argv.slice(2);
const w = openWarehouse({ path, mode: "read_write", timezone: "UTC", root, stateDir, isTTY: false, waits: { offTtyMs: 20000 }, runId: label });
await w.write(label, async (tx) => {
  console.log("acquired");
  await tx.exec("CREATE TABLE IF NOT EXISTS log (who VARCHAR)");
  await tx.exec("INSERT INTO log VALUES ($1)", [label]);
  await new Promise((r) => setTimeout(r, Number(holdMs)));
}, { runId: label });
await w.close();
console.log("released");
`;

interface Writer { lines: string[]; waitFor(line: string, timeoutMs?: number): Promise<void> }

function writer(p: TempProject, label: string, holdMs: number): Writer {
  const script = join(p.root, "writer.mjs");
  writeFileSync(script, WRITER);
  const proc = spawn(process.execPath, [script, p.database, p.root, p.stateDir, label, String(holdMs)], {
    env: { ...process.env, CROFT_WAREHOUSE_TS: join(import.meta.dir, "..", "db", "warehouse.ts") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(proc);
  const lines: string[] = [];
  let buf = "";
  let err = "";
  proc.stdout!.on("data", (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      lines.push(buf.slice(0, i).trim());
      buf = buf.slice(i + 1);
    }
  });
  proc.stderr!.on("data", (d) => (err += String(d)));
  return {
    lines,
    async waitFor(line, timeoutMs = 20_000) {
      const end = Date.now() + timeoutMs;
      while (!lines.includes(line)) {
        if (Date.now() > end || proc.exitCode !== null) throw new Error(`writer never printed ${line}: ${err}`);
        await sleep(2);
      }
    },
  };
}

const T = "CREATE TABLE t AS SELECT range AS n FROM range(5)";

describe("readCopy on", () => {
  test("during a write the copy answers, stale: true with its time; before and after, the live file answers", async () => {
    const p = await project({ copied: [T], live: ["INSERT INTO t SELECT range FROM range(5, 8)"] });
    const e = await engine(p);
    const before = await ask(e, "SELECT count(*)::INTEGER AS c FROM t");
    expect(before.rows).toEqual([{ c: 8 }]);
    expect(before.stale).toBeUndefined();
    expect(before.asOf).toBeUndefined();

    const w = writer(p, "r_write", 1500);
    await w.waitFor("acquired");
    await until("the server to step aside", () => e.status().state === "closed_for_write");
    const started = Date.now();
    const during = await ask(e, "SELECT count(*)::INTEGER AS c, max(n)::INTEGER AS top FROM t");
    expect(Date.now() - started).toBeLessThan(500 + SLACK); // answered, not queued behind the writer
    expect(during).toMatchObject({ rows: [{ c: 5, top: 4 }], rowCount: 1, stale: true, asOf: "2026-09-23T03:00:00-07:00" });
    expect(during.columns).toEqual([{ name: "c", type: "INTEGER" }, { name: "top", type: "INTEGER" }]);
    // The same gate and limits as the live file.
    expect((await rejection(ask(e, "SELECT * FROM duckdb_settings()"))).code).toBe("QUERY_PATH_DENIED");
    expect((await rejection(ask(e, "SELECT range FROM range(25)", { limit: 20 }))).code).toBe("QUERY_TOO_MANY_ROWS");
    expect((await rejection(ask(e, "SELECT nope FROM t"))).code).toBe("UNKNOWN_COLUMN");
    expect(e.status().state).toBe("closed_for_write");

    await w.waitFor("released");
    await until("the server to reopen", () => e.status().state === "open");
    const after = await ask(e, "SELECT count(*)::INTEGER AS c FROM t");
    expect(after.rows).toEqual([{ c: 8 }]);
    expect(after.stale).toBeUndefined();
    expect((await ask(e, "SELECT who FROM log")).rows).toEqual([{ who: "r_write" }]);
    expect(e.status().queriesToday).toBeGreaterThanOrEqual(6);
  });

  test("a query waiting in the queue when the server steps aside moves to the copy; one interrupted for the writer is answered from it", async () => {
    // The live table is big enough that the pair count runs for minutes; the copy's is instant.
    const p = await project({ copied: ["CREATE TABLE big AS SELECT range AS n FROM range(8)"], live: ["INSERT INTO big SELECT range FROM range(8, 300000)"] });
    const e = await engine(p, { maxConcurrent: 1, graceMs: 300 });
    const PAIRS = "SELECT count(*)::INTEGER AS c FROM big a, big b WHERE (a.n * b.n) % 7 = 3";
    let expected = 0;
    for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) if ((a * b) % 7 === 3) expected++;
    const slow = ask(e, PAIRS);
    await until("the slow query to run", () => e.status().inFlight === 1);
    const queued = ask(e, "SELECT count(*)::INTEGER AS c FROM big");
    await until("the second query to queue", () => e.status().queued === 1);

    const w = writer(p, "r_big", 1500);
    const [waited, interrupted] = await Promise.all([queued, slow]);
    expect(waited).toMatchObject({ rows: [{ c: 8 }], stale: true });
    expect(interrupted).toMatchObject({ rows: [{ c: expected }], stale: true, asOf: "2026-09-23T03:00:00-07:00" });
    await w.waitFor("released");
    await until("the server to reopen", () => e.status().state === "open");
    expect((await ask(e, "SELECT count(*)::INTEGER AS c FROM big")).rows).toEqual([{ c: 300000 }]);
  });

  test("a refreshed copy, renamed over the old one while the live file serves, answers at the next write", async () => {
    const p = await project({ copied: [T], asOf: "2026-09-23T10:00:00Z" });
    const e = await engine(p);
    let w = writer(p, "r_1", 800);
    await w.waitFor("acquired");
    await until("the server to step aside", () => e.status().state === "closed_for_write");
    expect(await ask(e, "SELECT count(*)::INTEGER AS c FROM t")).toMatchObject({ rows: [{ c: 5 }], asOf: "2026-09-23T03:00:00-07:00" });
    await w.waitFor("released");
    await until("the server to reopen", () => e.status().state === "open");

    await replaceCopy(p, ["INSERT INTO t VALUES (99)"], "2026-09-24T10:00:00Z");
    w = writer(p, "r_2", 800);
    await w.waitFor("acquired");
    await until("the server to step aside", () => e.status().state === "closed_for_write");
    expect(await ask(e, "SELECT count(*)::INTEGER AS c FROM t")).toMatchObject({ rows: [{ c: 6 }], stale: true, asOf: "2026-09-24T03:00:00-07:00" });
    await w.waitFor("released");
  });

  test("a copy replaced while the server answers from it is picked up once its queries have ended", async () => {
    const p = await project({ copied: [T], asOf: "2026-09-23T10:00:00Z" });
    const e = await engine(p);
    const w = writer(p, "r_long", 2500);
    await w.waitFor("acquired");
    await until("the server to step aside", () => e.status().state === "closed_for_write");
    expect(await ask(e, "SELECT count(*)::INTEGER AS c FROM t")).toMatchObject({ rows: [{ c: 5 }], asOf: "2026-09-23T03:00:00-07:00" });
    await replaceCopy(p, ["INSERT INTO t VALUES (7), (8)"], "2026-09-24T12:00:00Z");
    await sleep(200); // past the linger of the old copy's instance
    expect(await ask(e, "SELECT count(*)::INTEGER AS c FROM t")).toMatchObject({ rows: [{ c: 7 }], stale: true, asOf: "2026-09-24T05:00:00-07:00" });
    await w.waitFor("released");
  });

  test("over HTTP, the query envelope's data carries stale and asOf", async () => {
    const p = await project({ copied: [T], live: ["INSERT INTO t VALUES (5)"] });
    const e = await engine(p);
    const token = "t0ken-readcopy-test";
    const server = startServer({ engine: e, host: "127.0.0.1", port: 0, token, allowOrigins: [], root: p.root });
    servers.push(server);
    const ask = async () => {
      const reply = await post(new URL("/query", server.url), JSON.stringify({ sql: "SELECT count(*)::INTEGER AS c FROM t" }), {
        "Content-Type": "application/json", Authorization: `Bearer ${token}`,
      }, { connectMs: 2000, responseMs: 20_000 });
      expect(reply.status).toBe(200);
      return JSON.parse(reply.body) as { ok: boolean; data: Record<string, unknown> };
    };
    const live = await ask();
    expect(live.data).toMatchObject({ rows: [{ c: 6 }], truncatedRows: 0 });
    expect(live.data.stale).toBeUndefined();
    const w = writer(p, "r_http", 1500);
    await w.waitFor("acquired");
    await until("the server to step aside", () => e.status().state === "closed_for_write");
    const stale = await ask();
    expect(stale.ok).toBe(true);
    expect(stale.data).toMatchObject({ rows: [{ c: 5 }], rowCount: 1, truncatedRows: 0, truncatedValues: 0, stale: true, asOf: "2026-09-23T03:00:00-07:00" });
    await w.waitFor("released");
  });

  test("between queries the copy is not held: a GUI can open it read-write", async () => {
    const p = await project({ copied: [T] });
    const e = await engine(p);
    const w = writer(p, "r_gui", 1500);
    await w.waitFor("acquired");
    await until("the server to step aside", () => e.status().state === "closed_for_write");
    expect((await ask(e, "SELECT count(*)::INTEGER AS c FROM t")).stale).toBe(true);
    await sleep(250); // the copy's linger (100 ms) is over
    const gui = spawnHolder(p.project.paths.readCopy, 100);
    children.push(gui.proc);
    await gui.waitFor("held", 5000);
    await gui.waitFor("released", 5000);
    await w.waitFor("released");
  });
});

describe("otherwise queries wait for the writer, as before", () => {
  test("readCopy off: a query during a write waits and is answered from the live file", async () => {
    const p = await project({ readCopy: false, copied: [T], live: ["INSERT INTO t VALUES (5)"] });
    const e = await engine(p);
    const w = writer(p, "r_off", 600);
    await w.waitFor("acquired");
    await until("the server to step aside", () => e.status().state === "closed_for_write");
    const pending = ask(e, "SELECT count(*)::INTEGER AS c FROM t");
    await until("the query to queue", () => e.status().queued === 1);
    const r = await pending;
    expect(r.rows).toEqual([{ c: 6 }]);
    expect(r.stale).toBeUndefined();
    await w.waitFor("released");
  });

  test("readCopy on without a copy yet: the query waits, and past queueMs gets SERVE_UNAVAILABLE", async () => {
    const p = await project({ copied: [T], copy: false });
    const e = await engine(p, { queueMs: 300 });
    const w = writer(p, "r_nocopy", 1500);
    await w.waitFor("acquired");
    await until("the server to step aside", () => e.status().state === "closed_for_write");
    const err = await rejection(ask(e, "SELECT count(*) FROM t"));
    expect(err.code).toBe("SERVE_UNAVAILABLE");
    expect(err.problem.details).toMatchObject({ reason: "write" });
    await w.waitFor("released");
    await until("the server to reopen", () => e.status().state === "open");
    expect((await ask(e, "SELECT count(*)::INTEGER AS c FROM t")).stale).toBeUndefined();
  });
});
