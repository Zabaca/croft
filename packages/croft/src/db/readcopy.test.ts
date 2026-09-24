// The read copy (db/readcopy.ts, DESIGN.md §5 "Server mode, apps and GUIs"): after a run that committed, a
// faithful copy of the warehouse (CHECKPOINT first, so commits still in the WAL are in it), cloned by a child
// process under the write lease, renamed into place so no reader ever sees a half file, coalesced within and
// across processes, off by default, and never a thrown error.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { bootId, currentIdentity } from "../core/proc.ts";
import { formatInstant } from "../core/time.ts";
import { RunsDb } from "../history/runs-db.ts";
import { loadProject } from "../project/root.ts";
import { cleanup, makeProject as makeReadProject, seed, spawnHolder, type TempProject } from "../read/testkit.ts";
import { cleanupProjects, makeProject, runIn } from "../run/testkit.ts";
import { listIntents } from "./intent.ts";
import { type ReadCopyHooks, type ReadCopyOutcome, READ_COPY_LOG, READ_COPY_SETTING, readCopyStatus, refreshReadCopy } from "./readcopy.ts";
import { closeAllWarehouses, openWarehouse, warehouseFor } from "./warehouse.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const savedNow = process.env.CROFT_NOW;

afterEach(async () => {
  if (savedNow === undefined) delete process.env.CROFT_NOW;
  else process.env.CROFT_NOW = savedNow;
  await closeAllWarehouses();
});
afterAll(async () => {
  await closeAllWarehouses();
  cleanupProjects();
  cleanup();
});

/** An ingest of `n` fixed rows, no network. */
const items = (n: number) => `import { ingest } from "@zabaca/croft";
export default ingest({
  key: "id",
  async *rows() {
    yield Array.from({ length: ${n} }, (_, i) => ({ id: i + 1, name: "item " + (i + 1), price: (i + 1) * 1.5, tags: ["a", "b"] }));
  },
});
`;

/** Rows of a DuckDB file through a private read-only instance, closed at once. */
async function readRows(file: string, sql: string): Promise<Record<string, unknown>[]> {
  const db = await DuckDBInstance.create(file, { access_mode: "READ_ONLY" });
  const c = await db.connect();
  try {
    return (await c.runAndReadAll(sql)).getRowObjectsJS() as Record<string, unknown>[];
  } finally {
    c.disconnectSync();
    db.closeSync();
  }
}

/** A project with readCopy on and a seeded warehouse (no assets). */
const seeded = (statements = ["CREATE TABLE t AS SELECT range AS n FROM range(10)"], config: Record<string, unknown> = { readCopy: true }) =>
  makeReadProject({ config, seed: statements });

const copyOf = (p: TempProject) => p.project.paths.readCopy;

/** Temporary files a refresh may leave next to the copy (it must not). */
const temps = (p: TempProject) => readdirSync(dirname(copyOf(p))).filter((n) => n.startsWith(`.${basename(copyOf(p))}.`));

function refreshed(o: ReadCopyOutcome): Extract<ReadCopyOutcome, { status: "refreshed" }> {
  if (o.status !== "refreshed") throw new Error(`expected a refresh, got ${JSON.stringify(o)}`);
  return o;
}

async function until(what: string, cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

describe("off by default", () => {
  test("without readCopy (or with it false) nothing is copied, recorded or opened", async () => {
    for (const config of [{}, { readCopy: false }]) {
      const root = makeProject({ "assets/items.ts": items(3) }, { config });
      expect((await runIn(root, ["items"])).exit).toBe(0);
      await closeAllWarehouses();
      expect(await refreshReadCopy(root)).toEqual({ status: "disabled" });
      const project = loadProject({ root });
      expect(existsSync(project.paths.readCopy)).toBe(false);
      expect(warehouseFor(project.paths.database)?.isOpen ?? false).toBe(false);
      const runs = RunsDb.open(project.paths.stateDir);
      try {
        expect(runs.getSetting(READ_COPY_SETTING)).toBeNull();
      } finally {
        runs.close();
      }
      expect(readCopyStatus(project)).toMatchObject({ enabled: false, exists: false, asOf: null });
    }
  });
});

describe("the copy", () => {
  test("after a run, warehouse.read.duckdb holds exactly what the warehouse holds; its mtime is the checkpoint's time", async () => {
    const root = makeProject({ "assets/items.ts": items(250) }, { config: { readCopy: true } });
    expect((await runIn(root, ["items"])).exit).toBe(0);
    process.env.CROFT_NOW = "2026-09-24T17:00:00Z";
    const out = refreshed(await refreshReadCopy(root));
    const project = loadProject({ root });
    expect(out).toMatchObject({ path: join(root, "warehouse.read.duckdb"), rounds: 1, asOf: "2026-09-24T10:00:00-07:00" });
    expect(["clone", "reflink", "copy"]).toContain(out.method);
    expect(out.heldMs).toBeGreaterThanOrEqual(0);
    expect(statSync(out.path).mtimeMs).toBe(Date.parse("2026-09-24T17:00:00Z"));
    await closeAllWarehouses();
    for (const sql of ["SELECT * FROM items ORDER BY id", "SELECT name, row_count, cursor_value FROM _croft.assets ORDER BY name", "SELECT asset, name, type FROM _croft.columns ORDER BY ALL"]) {
      const live = await readRows(project.paths.database, sql);
      expect(live.length).toBeGreaterThan(0);
      expect(await readRows(out.path, sql)).toEqual(live);
    }
    expect((await readRows(out.path, "SELECT count(*)::INTEGER AS c FROM items"))[0]).toEqual({ c: 250 });
    expect(readdirSync(root).filter((n) => n.includes(".tmp"))).toEqual([]);
    expect(readCopyStatus(project)).toMatchObject({
      enabled: true, path: out.path, exists: true, asOf: "2026-09-24T10:00:00-07:00", method: out.method, lastError: null,
      refreshedAt: "2026-09-24T17:00:00.000Z",
    });
  });

  test("CHECKPOINT first: commits still in the WAL of the run's open instance reach the copy; the run's warehouse stays open", async () => {
    const p = await makeReadProject({ config: { readCopy: true } });
    const w = openWarehouse({ path: p.database, mode: "read_write", timezone: "UTC", root: p.root, stateDir: p.stateDir, isTTY: false, lingerMs: 60_000 });
    await w.write("seed", async (tx) => {
      await tx.exec("CREATE TABLE t AS SELECT range AS n FROM range(1500)");
    }, { runId: "r_seed" });
    expect(w.isOpen).toBe(true);
    expect(statSync(`${p.database}.wal`).size).toBeGreaterThan(0); // committed, but only in the WAL
    const out = refreshed(await refreshReadCopy(p.root, { warehouse: w, runId: "r_seed" }));
    expect(w.isOpen).toBe(true); // the caller's warehouse: the caller closes it
    await closeAllWarehouses();
    expect(await readRows(out.path, "SELECT count(*)::INTEGER AS c, sum(n)::BIGINT AS s FROM t")).toEqual([{ c: 1500, s: 1124250n }]);
  });

  test("the lease covers the CHECKPOINT and the clone only: file and write intent are released before the rename", async () => {
    const p = await seeded();
    const seen: Record<string, unknown> = {};
    const hooks: ReadCopyHooks = {
      checkpointed: () => {
        seen.intentsAtCheckpoint = listIntents(p.stateDir).length;
        seen.openAtCheckpoint = warehouseFor(p.database)?.isOpen;
      },
      cloned: (e) => {
        seen.tmpAtClone = existsSync(e.tmp);
        seen.intentsAtClone = listIntents(p.stateDir).length;
      },
      beforeRename: (e) => {
        seen.intentsBeforeRename = listIntents(p.stateDir).length;
        seen.openBeforeRename = warehouseFor(p.database)?.isOpen;
        seen.copyBeforeRename = existsSync(e.path);
        seen.tmpBeforeRename = existsSync(e.tmp) && dirname(e.tmp) === dirname(e.path);
      },
    };
    refreshed(await refreshReadCopy(p.root, { hooks }));
    expect(seen).toEqual({
      intentsAtCheckpoint: 1, openAtCheckpoint: true, tmpAtClone: true, intentsAtClone: 1,
      intentsBeforeRename: 0, openBeforeRename: false, copyBeforeRename: false, tmpBeforeRename: true,
    });
    expect(existsSync(copyOf(p))).toBe(true);
    expect(temps(p)).toEqual([]);
  });

  for (const platform of ["darwin", "linux"] as const) {
    test(`atomic replacement (${platform} clone command): a reader of the old copy keeps working; the new copy replaces it whole`, async () => {
      const p = await seeded();
      const first = refreshed(await refreshReadCopy(p.root, { platform }));
      // The native command clones (APFS) or reflinks; the other platform's flag fails here and a plain cp copies.
      if (platform !== process.platform) expect(first.method).toBe("copy");
      else if (platform === "darwin") expect(first.method).toBe("clone");
      const ino = statSync(first.path).ino;
      // A GUI holding the old copy open.
      const gui = await DuckDBInstance.create(first.path, { access_mode: "READ_ONLY" });
      const conn = await gui.connect();
      try {
        const count = async (c = conn) => (await c.runAndReadAll("SELECT count(*)::INTEGER FROM t")).getRowsJS()[0]![0];
        expect(await count()).toBe(10);
        await seed(p.database, ["INSERT INTO t SELECT range FROM range(10, 25)"]);
        let during: unknown;
        const second = refreshed(await refreshReadCopy(p.root, {
          platform,
          hooks: {
            // Just before the rename, a GUI that opens the copy gets the old, whole file.
            beforeRename: async () => {
              during = (await readRows(first.path, "SELECT count(*)::INTEGER AS c FROM t"))[0];
            },
          },
        }));
        expect(during).toEqual({ c: 10 });
        expect(statSync(second.path).ino).not.toBe(ino); // renamed into place, never rewritten in place
        // The old reader is not broken: it still reads its (old) file, new queries included.
        expect(await count()).toBe(10);
        expect((await conn.runAndReadAll("SELECT sum(n)::INTEGER FROM t")).getRowsJS()[0]![0]).toBe(45);
        // A new reader sees the new copy.
        expect(await readRows(second.path, "SELECT count(*)::INTEGER AS c FROM t")).toEqual([{ c: 25 }]);
        expect(temps(p)).toEqual([]);
      } finally {
        conn.disconnectSync();
        gui.closeSync();
      }
    });
  }

  test("a WAL a GUI left next to the old copy is removed before the new copy takes its place", async () => {
    const p = await seeded();
    refreshed(await refreshReadCopy(p.root));
    writeFileSync(`${copyOf(p)}.wal`, "not this copy's WAL");
    await seed(p.database, ["INSERT INTO t VALUES (100)"]);
    refreshed(await refreshReadCopy(p.root));
    expect(existsSync(`${copyOf(p)}.wal`)).toBe(false);
    expect(await readRows(copyOf(p), "SELECT count(*)::INTEGER AS c FROM t")).toEqual([{ c: 11 }]);
  });

  test("a relocated database gets its copy next to it, named after it", async () => {
    const p = await makeReadProject({ config: { readCopy: true, database: "data/shop.duckdb" } });
    mkdirSync(dirname(p.database), { recursive: true });
    await seed(p.database, ["CREATE TABLE t AS SELECT 1 AS n"]);
    const out = refreshed(await refreshReadCopy(p.root));
    expect(out.path).toBe(join(p.root, "data", "shop.read.duckdb"));
    expect(await readRows(out.path, "SELECT n FROM t")).toEqual([{ n: 1 }]);
  });
});

describe("coalescing", () => {
  test("in this process: calls made while a refresh runs share one refresh after it", async () => {
    const p = await seeded();
    const gate = Promise.withResolvers<void>();
    let checkpoints = 0;
    const hooks: ReadCopyHooks = {
      checkpointed: () => {
        checkpoints++;
      },
      beforeRename: async () => {
        if (checkpoints === 1) await gate.promise;
      },
    };
    const first = refreshReadCopy(p.root, { hooks });
    await until("the first refresh to checkpoint", () => checkpoints === 1);
    const second = refreshReadCopy(p.root, { hooks });
    const third = refreshReadCopy(p.root, { hooks });
    await sleep(50);
    expect(checkpoints).toBe(1);
    gate.resolve();
    const [a, b, c] = await Promise.all([first, second, third]);
    expect(checkpoints).toBe(2);
    expect(refreshed(a).rounds).toBe(1);
    expect(refreshed(b).rounds).toBe(1);
    expect(b).toBe(c); // one follow-up for both
    // And afterwards a call starts a refresh of its own again.
    refreshed(await refreshReadCopy(p.root, { hooks }));
    expect(checkpoints).toBe(3);
  });

  test("across processes: a request while another process refreshes is left to it, which refreshes once more", async () => {
    const p = await seeded();
    const script = join(p.root, "refresh-child.ts");
    writeFileSync(script, `
const { refreshReadCopy } = await import(process.env.CROFT_READCOPY_TS);
let rounds = 0;
const hooks = {
  beforeRename: async () => {
    if (++rounds > 1) return;
    console.log("paused");
    await new Promise((resolve) => process.stdin.once("data", resolve));
  },
};
const out = await refreshReadCopy(process.argv[2], { hooks });
console.log(JSON.stringify(out));
process.exit(0);
`);
    const child = spawn(process.execPath, [script, p.root], {
      env: { ...process.env, CROFT_READCOPY_TS: join(import.meta.dir, "readcopy.ts") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d) => (stdout += String(d)));
    child.stderr!.on("data", (d) => (stderr += String(d)));
    const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
    try {
      await until("the child to pause after its first round", () => stdout.includes("paused") || child.exitCode !== null, 20_000);
      expect(stderr).toBe("");
      // Meanwhile a run here committed rows and asks for a refresh: the child is refreshing, so it is left to it.
      await seed(p.database, ["INSERT INTO t SELECT range FROM range(10, 17)"]);
      const started = Date.now();
      expect(await refreshReadCopy(p.root)).toEqual({ status: "coalesced" });
      expect(Date.now() - started).toBeLessThan(2000);
      child.stdin!.write("go\n");
      expect(await exited).toBe(0);
      const out = JSON.parse(stdout.trim().split("\n").pop()!) as ReadCopyOutcome;
      expect(out).toMatchObject({ status: "refreshed", rounds: 2 });
      expect(await readRows(copyOf(p), "SELECT count(*)::INTEGER AS c FROM t")).toEqual([{ c: 17 }]);
      const runs = RunsDb.open(p.stateDir);
      try {
        expect(runs.getSetting<{ holder: unknown }>(READ_COPY_SETTING)?.holder).toBeNull();
      } finally {
        runs.close();
      }
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("a refresher that died leaves nothing behind: the next request takes over", async () => {
    const p = await seeded();
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    const runs = RunsDb.open(p.stateDir);
    try {
      runs.setSetting(READ_COPY_SETTING, { requested: 4, holder: { pid: dead, procStart: "1700000000", bootId: bootId() } });
    } finally {
      runs.close();
    }
    writeFileSync(join(dirname(copyOf(p)), `.${basename(copyOf(p))}.${dead}-x1.tmp`), "a half copy of a killed refresh");
    const out = refreshed(await refreshReadCopy(p.root));
    expect(out.rounds).toBe(1);
    expect(temps(p)).toEqual([]);
    const after = RunsDb.open(p.stateDir);
    try {
      expect(after.getSetting(READ_COPY_SETTING)).toMatchObject({ requested: 5, holder: null, lastError: null });
    } finally {
      after.close();
    }
  });
});

describe("errors are logged and recorded, never thrown", () => {
  test("a clone that fails: the old copy stays, no temporary file is left, the warehouse is released", async () => {
    const p = await seeded();
    process.env.CROFT_NOW = "2026-09-24T17:00:00Z";
    const good = refreshed(await refreshReadCopy(p.root));
    await seed(p.database, ["INSERT INTO t VALUES (100)"]);
    process.env.CROFT_NOW = "2026-09-24T18:00:00Z";
    const out = await refreshReadCopy(p.root, { cp: [join(p.root, "no-such-cp")] });
    expect(out).toMatchObject({ status: "failed", rounds: 1 });
    if (out.status !== "failed") throw new Error("unreachable");
    expect(out.error.message).toContain("cp");
    expect(temps(p)).toEqual([]);
    expect(listIntents(p.stateDir)).toEqual([]);
    expect(warehouseFor(p.database)?.isOpen).toBe(false);
    expect(await readRows(good.path, "SELECT count(*)::INTEGER AS c FROM t")).toEqual([{ c: 10 }]);
    const log = readFileSync(join(p.stateDir, READ_COPY_LOG), "utf8");
    expect(log).toContain("2026-09-24T18:00:00.000Z");
    expect(log).toContain(out.error.message);
    expect(readCopyStatus(p.project)).toMatchObject({
      exists: true, refreshedAt: "2026-09-24T17:00:00.000Z", asOf: good.asOf,
      lastError: { at: "2026-09-24T18:00:00.000Z", message: out.error.message },
    });
    // The next good refresh clears the error.
    refreshed(await refreshReadCopy(p.root));
    expect(readCopyStatus(p.project).lastError).toBeNull();
  });

  test("a clone that hangs is killed at its timeout, and the lease ends with it", async () => {
    const p = await seeded();
    const hang = join(p.root, "hanging-cp");
    writeFileSync(hang, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
    const started = Date.now();
    const out = await refreshReadCopy(p.root, { cp: [hang], cloneTimeoutMs: 200 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(out).toMatchObject({ status: "failed", error: { code: null } });
    if (out.status !== "failed") throw new Error("unreachable");
    expect(out.error.message).toContain("took longer than");
    expect(listIntents(p.stateDir)).toEqual([]);
    expect(warehouseFor(p.database)?.isOpen).toBe(false);
    expect(temps(p)).toEqual([]);
  });

  test("a program holding the warehouse: the refresh gives up after its wait and says who", async () => {
    const p = await seeded();
    const holder = spawnHolder(p.database, 10_000);
    try {
      await holder.waitFor("held");
      const started = Date.now();
      const out = await refreshReadCopy(p.root, { waitMs: 300 });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(out.status).toBe("failed");
      if (out.status !== "failed") throw new Error("unreachable");
      expect(["DB_HELD_BY_OTHER_PROGRAM", "DB_BUSY"]).toContain(out.error.code!);
      expect(existsSync(copyOf(p))).toBe(false);
      expect(listIntents(p.stateDir)).toEqual([]);
      expect(readFileSync(join(p.stateDir, READ_COPY_LOG), "utf8")).toContain(out.error.code!);
    } finally {
      holder.proc.kill("SIGKILL");
    }
  });

  test("no warehouse yet: nothing to copy, and the refresh does not create one", async () => {
    const p = await makeReadProject({ config: { readCopy: true } });
    expect(await refreshReadCopy(p.root)).toMatchObject({ status: "skipped" });
    expect(existsSync(p.database)).toBe(false);
    expect(existsSync(copyOf(p))).toBe(false);
  });

  test("a broken croft.json or a missing project: skipped, not thrown", async () => {
    const p = await seeded();
    writeFileSync(join(p.root, "croft.json"), "{ not json");
    expect(await refreshReadCopy(p.root)).toMatchObject({ status: "skipped" });
    expect(await refreshReadCopy(join(p.root, "no-such-folder"))).toMatchObject({ status: "skipped" });
  });
});

describe("readCopyStatus: how current the copy is, for doctor and status (R32-11)", () => {
  /** A finished run that committed a write, finished at `at`, by a process that is gone (or this one, `alive`). */
  function wrote(stateDir: string, at: string, alive = false): string {
    const runs = RunsDb.open(stateDir, { now: () => new Date(at) });
    try {
      const identity = alive ? undefined : { pid: 2 ** 22 + 7, procStart: "12345", bootId: bootId() };
      const run = runs.createRun({ trigger: "manual", human: true, argv: ["run", "t"], ...(identity ? { identity } : {}) });
      runs.startStep({ runId: run.id, asset: "t", attempt: 1, reason: "never_built" });
      runs.finishStep(run.id, "t", 1, { status: "ok", rows: { in: 1, added: 1 } });
      runs.finishRun(run.id, "succeeded");
      return run.id;
    } finally {
      runs.close();
    }
  }

  function setState(stateDir: string, patch: Record<string, unknown>): void {
    const runs = RunsDb.open(stateDir);
    try {
      runs.setSetting(READ_COPY_SETTING, { ...(runs.getSetting<Record<string, unknown>>(READ_COPY_SETTING) ?? {}), ...patch });
    } finally {
      runs.close();
    }
  }

  test("ok: the last refresh came after the last run that wrote data", async () => {
    const p = await seeded();
    const run = wrote(p.stateDir, "2026-09-24T16:59:00.000Z");
    process.env.CROFT_NOW = "2026-09-24T17:00:00Z";
    refreshed(await refreshReadCopy(p.root));
    expect(readCopyStatus(p.project)).toMatchObject({
      enabled: true, exists: true, health: "ok", refreshing: false, lastError: null,
      lastWrite: { runId: run, at: "2026-09-24T16:59:00.000Z" }, log: join(p.stateDir, READ_COPY_LOG),
    });
  });

  test("behind: a run wrote data after the last refresh and no refresh followed; while that run is alive, refreshing", async () => {
    const p = await seeded();
    process.env.CROFT_NOW = "2026-09-24T17:00:00Z";
    refreshed(await refreshReadCopy(p.root));
    const run = wrote(p.stateDir, "2026-09-24T17:05:00.000Z");
    expect(readCopyStatus(p.project)).toMatchObject({ health: "behind", refreshing: false, lastWrite: { runId: run, at: "2026-09-24T17:05:00.000Z" } });
    // The run that wrote last is still finishing: its own refresh follows.
    wrote(p.stateDir, "2026-09-24T17:06:00.000Z", true);
    expect(readCopyStatus(p.project)).toMatchObject({ health: "refreshing", refreshing: true });
    // The next refresh covers both.
    refreshed(await refreshReadCopy(p.root));
    expect(readCopyStatus(p.project)).toMatchObject({ health: "ok", refreshing: false });
  });

  test("behind is judged by run order, not by clocks: a refresh under a frozen CROFT_NOW in the past still covers a later run", async () => {
    const p = await seeded();
    wrote(p.stateDir, "2026-09-24T17:05:00.000Z");
    process.env.CROFT_NOW = "2020-01-01T00:00:00Z";
    refreshed(await refreshReadCopy(p.root));
    expect(readCopyStatus(p.project).health).toBe("ok");
  });

  test("a copy with no record of the runs it covers (made by an older croft) is judged by its time", async () => {
    const p = await seeded();
    process.env.CROFT_NOW = "2026-09-24T17:00:00Z";
    refreshed(await refreshReadCopy(p.root));
    setState(p.stateDir, { covers: null });
    wrote(p.stateDir, "2026-09-24T16:00:00.000Z");
    expect(readCopyStatus(p.project).health).toBe("ok");
    wrote(p.stateDir, "2026-09-24T18:00:00.000Z");
    expect(readCopyStatus(p.project).health).toBe("behind");
  });

  test("failed: the last refresh failed, with its error; a refresh under way is refreshing", async () => {
    const p = await seeded();
    process.env.CROFT_NOW = "2026-09-24T17:00:00Z";
    refreshed(await refreshReadCopy(p.root));
    process.env.CROFT_NOW = "2026-09-24T18:00:00Z";
    const out = await refreshReadCopy(p.root, { cp: [join(p.root, "no-such-cp")] });
    if (out.status !== "failed") throw new Error(`expected a failure, got ${JSON.stringify(out)}`);
    const s = readCopyStatus(p.project);
    expect(s).toMatchObject({ health: "failed", lastError: { at: "2026-09-24T18:00:00.000Z", message: out.error.message } });
    setState(p.stateDir, { holder: { pid: process.pid, procStart: currentIdentity().procStart, bootId: bootId() } });
    expect(readCopyStatus(p.project)).toMatchObject({ health: "refreshing", refreshing: true });
  });

  test("missing: on, no copy yet, and nothing failed; off: health off", async () => {
    const p = await seeded();
    expect(readCopyStatus(p.project)).toMatchObject({ enabled: true, exists: false, health: "missing", lastWrite: null });
    const off = await seeded(undefined, {});
    expect(readCopyStatus(off.project)).toMatchObject({ enabled: false, health: "off" });
  });

  test("the module loads without DuckDB: doctor imports it, and a binding that does not load must not break doctor", () => {
    const plugin = join(dirname(copyOfDir()), "no-duckdb-plugin.js");
    writeFileSync(plugin, `Bun.plugin({ name: "no-duckdb", setup(build) {
  build.onResolve({ filter: /^@duckdb\\// }, (args) => { throw new Error("simulated: no DuckDB binding for " + args.path); });
} });\n`);
    const url = new URL("./readcopy.ts", import.meta.url).href;
    const r = spawnSync(process.execPath, ["--no-env-file", "--preload", plugin, "-e", `const m = await import(${JSON.stringify(url)}); process.stdout.write(typeof m.readCopyStatus);`], {
      encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    expect(`${r.stdout}${r.stderr}`).toBe("function");
  });
});

/** A temp folder for files a test writes outside any project. */
function copyOfDir(): string {
  const dir = join(process.env.TMPDIR ?? "/tmp", `croft-readcopy-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "x");
}

test("readCopyStatus renders the copy's time in the project offset", async () => {
  const p = await seeded();
  expect(readCopyStatus(p.project)).toMatchObject({ enabled: true, exists: false, asOf: null, refreshedAt: null, lastError: null });
  process.env.CROFT_NOW = "2026-01-15T18:00:00Z";
  refreshed(await refreshReadCopy(p.root));
  expect(readCopyStatus(p.project).asOf).toBe(formatInstant(Date.parse("2026-01-15T18:00:00Z"), "America/Los_Angeles"));
  expect(readCopyStatus(p.project).asOf).toBe("2026-01-15T10:00:00-08:00");
});
