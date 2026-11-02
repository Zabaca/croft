// croft serve in server mode (DESIGN.md D119, §5 "Server mode, apps and GUIs"; option 06, slice 2): the readers' process on
// the read copy. These tests start real readers' processes (children of the test, killed in teardown), which load
// DuckDB's real quack and httpfs files, so they need them (scripts/fetch-extensions.ts fills the folder). Locally a
// missing file skips them and says why on stderr; in CI (CROFT_CI=1) it fails them instead.
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFakeAddon } from "../db/addon-testkit.ts";
import { logDdl } from "../db/bookkeeping.ts";
import { LOG_FORMAT_VERSION } from "../db/state.ts";
import { closeAllWarehouses } from "../db/warehouse.ts";
import { cleanup, seed, type TempProject } from "../read/testkit.ts";
import { aside, ask, count, extensionFiles, openEngine, project, putCopy, rejection, replaceCopy, sleep, until } from "./readers-testkit.ts";
import { openReadersEngine } from "./readers.ts";
import { type RunningServer, startServer } from "./server.ts";
import type { ServeEngine } from "./types.ts";

const { ext, withExt } = extensionFiles("readers.test");
const engines: ServeEngine[] = [];
const servers: RunningServer[] = [];
const scratchDirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop(true).catch(() => {});
  for (const e of engines) await e.close().catch(() => {});
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
  await closeAllWarehouses();
  cleanup();
});
const engine = (p: TempProject, o: Parameters<typeof openEngine>[3] = {}) => openEngine(engines, ext.dir, p, o);
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

describe("starting", () => {
  withExt("answers from the read copy, with its as-of time and no stale mark; neither file is written", async () => {
    const p = await project({ n: 10, asOf: "2026-10-30T10:00:00Z" });
    const liveBefore = sha(p.database);
    const copyBefore = sha(p.project.paths.readCopy);
    const e = await engine(p);
    const a = await ask(e, "SELECT count(*) AS n FROM orders");
    expect(a.rows).toEqual([{ n: 10 }]);
    expect(a.asOf).toBe("2026-10-30T03:00:00-07:00");
    expect(a.stale).toBeUndefined();
    expect(e.status().serverMode).toMatchObject({ state: "open", asOf: "2026-10-30T03:00:00-07:00", swaps: 0, restarts: 0 });
    await e.close();
    expect(sha(p.database)).toBe(liveBefore);
    expect(sha(p.project.paths.readCopy)).toBe(copyBefore);
  });

  withExt("a copy that is writable on disk is made read-only when the readers' process attaches it, and again after a swap", async () => {
    const p = await project({ n: 10 });
    chmodSync(p.project.paths.readCopy, 0o644);
    const e = await engine(p);
    expect(await count(e)).toBe(10);
    expect(statSync(p.project.paths.readCopy).mode & 0o222).toBe(0);
    // A refresh with server mode off leaves 0644: the next swap makes it read-only again.
    const next = aside(p, "writable-next");
    chmodSync(next, 0o644);
    renameSync(next, p.project.paths.readCopy);
    await until("the swap", () => (e.status().serverMode?.swaps ?? 0) === 1);
    expect(statSync(p.project.paths.readCopy).mode & 0o222).toBe(0);
  });

  withExt("with data already built and no copy, croft serve makes the copy itself, in a child, and answers a retryable 503 until then", async () => {
    const p = await project({ copy: false });
    const made: boolean[] = [];
    const e = await engine(p, { copyMaker: { onDone: (r) => made.push(r.ok) } });
    // Start did not wait for the copy: until it exists a query is told to retry.
    const first = await rejection(ask(e, "SELECT 1"));
    if (e.status().serverMode?.state !== "open") {
      expect(first.code).toBe("SERVE_UNAVAILABLE");
      expect(first.problem.retryable).toBe(true);
      expect(first.problem.details).toMatchObject({ reason: "making_copy" });
    }
    await until("the copy to be made and served", () => e.status().serverMode?.state === "open", 20_000);
    expect(made).toEqual([true]);
    expect(await count(e)).toBe(10);
    expect(statSync(p.project.paths.readCopy).mode & 0o222).toBe(0);
    expect(e.status().serverMode).toMatchObject({ makingCopy: false });
    expect((await ask(e, "SELECT count(*) AS n FROM orders")).asOf).toMatch(/^\d{4}-/);
    // Neither the server nor the child that made the copy holds the live file any more.
    await seed(p.database, ["INSERT INTO orders VALUES (900, 0)"]);
  });

  withExt("with no warehouse yet there is no copy to make: DB_NOT_FOUND until a run makes both, and the copy is picked up within a second", async () => {
    const p = await project({ copy: false });
    const late = aside(p, "late"); // kept before the warehouse goes
    rmSync(p.database);
    const e = await engine(p);
    expect((await rejection(ask(e, "SELECT 1"))).code).toBe("DB_NOT_FOUND");
    expect(e.status().serverMode?.state).toBe("waiting");
    expect(e.status().serverMode?.makingCopy).toBe(false);
    putCopy(p, late, "2026-10-30T10:00:00Z");
    await until("the copy to be served", () => e.status().serverMode?.state === "open", 1500);
    expect(await count(e)).toBe(10);
  });

  withExt("with the copy maker off, a missing copy is DB_NOT_FOUND and waits for a run", async () => {
    const p = await project({ copy: false });
    const e = await engine(p, { copyMaker: false });
    expect((await rejection(ask(e, "SELECT 1"))).code).toBe("DB_NOT_FOUND");
    putCopy(p, aside(p, "late"), "2026-10-30T10:00:00Z");
    await until("the copy to be served", () => e.status().serverMode?.state === "open", 1500);
    expect(await count(e)).toBe(10);
  });

  withExt("with no extension folder named, the readers' process loads quack and httpfs from the server add-on in the project's node_modules (D132)", async () => {
    const p = await project({ n: 10 });
    installFakeAddon(p.root, "server", { from: ext.dir });
    // The child inherits this environment: no folder named, and a cache that holds nothing, so only the add-on can be where the files come from.
    const saved = { dir: process.env.CROFT_EXTENSION_DIR, cache: process.env.XDG_CACHE_HOME };
    const emptyCache = realpathSync(mkdtempSync(join(tmpdir(), "croft-nocache-")));
    scratchDirs.push(emptyCache);
    delete process.env.CROFT_EXTENSION_DIR;
    process.env.XDG_CACHE_HOME = emptyCache;
    try {
      const e = await openReadersEngine({ root: p.root, copyPollMs: 25 });
      engines.push(e);
      expect(await count(e)).toBe(10);
    } finally {
      if (saved.dir !== undefined) process.env.CROFT_EXTENSION_DIR = saved.dir;
      if (saved.cache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = saved.cache;
    }
  });

  test("with the server add-on not installed and no folder named, croft serve does not start, and the error is the install command (EXTENSION_MISSING)", async () => {
    const p = await project();
    const saved = { dir: process.env.CROFT_EXTENSION_DIR, cache: process.env.XDG_CACHE_HOME };
    const emptyCache = realpathSync(mkdtempSync(join(tmpdir(), "croft-nocache-")));
    scratchDirs.push(emptyCache);
    delete process.env.CROFT_EXTENSION_DIR;
    process.env.XDG_CACHE_HOME = emptyCache;
    try {
      const err = await rejection(openReadersEngine({ root: p.root, copyPollMs: 25 }));
      expect(err.code).toBe("EXTENSION_MISSING");
      expect(err.problem.details).toMatchObject({ kind: "addon", addon: "server", installed: false });
      expect(err.problem.fix).toMatchObject({ kind: "command", command: expect.stringContaining("bun add @zabaca/croft-addon-server@") });
    } finally {
      if (saved.dir !== undefined) process.env.CROFT_EXTENSION_DIR = saved.dir;
      if (saved.cache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = saved.cache;
    }
  });

  test("with the extension files missing, croft serve does not start, and says which file (EXTENSION_MISSING)", async () => {
    const p = await project();
    const err = await rejection(openReadersEngine({ root: p.root, extensionDir: join(p.root, "no-extensions"), copyPollMs: 25 }));
    expect(err.code).toBe("EXTENSION_MISSING");
    expect(err.problem.details).toMatchObject({ kind: "file" });
  });

  test("where the copy cannot be cloned and the warehouse is over 1 GB, croft serve does not start, unless the project accepts the cost", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "croft-cp-")));
    scratchDirs.push(dir);
    const cp = join(dir, "cp");
    writeFileSync(cp, '#!/bin/sh\nfor a in "$@"; do case "$a" in -c|--reflink=always) exit 1;; esac; done\nexec /bin/cp "$@"\n');
    chmodSync(cp, 0o755);
    const policy = { platform: "linux" as const, cp: [cp] };
    const p = await project({ n: 10 });
    truncateSync(p.database, 1_500_000_000); // a sparse file: the policy reads only the size
    const err = await rejection(openReadersEngine({ root: p.root, extensionDir: ext.dir, policy }));
    expect(err.code).toBe("SERVER_MODE_COPY_COSTLY");
    expect(err.problem.hint).toContain("serverMode.acceptFullCopyCost");
    // The same warehouse with the cost accepted is not refused by the policy (it then starts, if the extension files are there).
    const accepted = await project({ n: 10, config: { serverMode: { enabled: true, acceptFullCopyCost: true } } });
    truncateSync(accepted.database, 1_500_000_000);
    if (ext.ready) engines.push(await openReadersEngine({ root: accepted.root, extensionDir: ext.dir, policy, copyPollMs: 25 }));
  });

  withExt("a warehouse that grows past the copy limit while croft serve runs does not stop it: /status and /health say so", async () => {
    const policy = { clone: { canClone: false, method: null, why: "no reflink here" }, thresholdBytes: 1_000_000_000_000 };
    const p = await project({ n: 10 });
    const e = await engine(p, { policy });
    const server = startServer({ engine: e, host: "127.0.0.1", port: 0, token: "tok-for-tests", allowOrigins: [], root: p.root, database: "warehouse.duckdb", timezone: "America/Los_Angeles" });
    servers.push(server);
    const get = async (path: string) => (await (await fetch(`${server.url}${path}`, { headers: { Authorization: "Bearer tok-for-tests" } })).json()) as Record<string, any>;
    expect(e.status().serverMode!.copyCost).toBeNull();
    expect((await get("/health")).degraded).toBeUndefined();
    policy.thresholdBytes = 1; // the warehouse is now over the limit
    expect(e.status().serverMode!.copyCost).toMatchObject({ code: "SERVER_MODE_COPY_COSTLY" });
    const health = await get("/health");
    expect(health).toMatchObject({ ok: true, degraded: { code: "SERVER_MODE_COPY_COSTLY" }, serverMode: { state: "open" } });
    expect(health.degraded.message).toContain("serverMode.acceptFullCopyCost");
    expect((await get("/status")).data.serve.engine.serverMode.copyCost.code).toBe("SERVER_MODE_COPY_COSTLY");
    // Still answering, and still taking new copies in.
    expect(await count(e)).toBe(10);
    await replaceCopy(p, 12, "2026-10-30T11:00:00Z");
    await until("the swap", () => (e.status().serverMode?.swaps ?? 0) === 1);
    expect(await count(e)).toBe(12);
  });

  withExt("a copy written by a newer croft fails the start with DB_NEWER_FORMAT, as the live file does", async () => {
    const p = await project({ copy: false });
    const newer = join(p.root, "newer.duckdb");
    copyFileSync(p.database, newer);
    await seed(newer, ["CREATE SCHEMA _croft", "CREATE TABLE _croft.meta (key VARCHAR PRIMARY KEY, value VARCHAR)", "INSERT INTO _croft.meta VALUES ('format_version', '999')", "CHECKPOINT"]);
    putCopy(p, newer, "2026-10-30T10:00:00Z");
    const err = await rejection(openReadersEngine({ root: p.root, extensionDir: ext.dir, copyPollMs: 25 }));
    expect(err.code).toBe("DB_NEWER_FORMAT");
  });
});

describe("a warehouse whose bookkeeping is a log (D132)", () => {
  withExt("its read copy is served: the format 4 is read, the tables answer, and croft's log, its views and its schema stay out of reach", async () => {
    const p = await project({ n: 5, copy: false });
    const logged = join(p.root, "logged.duckdb");
    copyFileSync(p.database, logged);
    await seed(logged, [
      "CREATE SCHEMA IF NOT EXISTS _croft", ...logDdl().map((d) => d.ddl),
      `INSERT INTO _croft.meta VALUES ('format_version', '${LOG_FORMAT_VERSION}'), ('bookkeeping', 'log')`,
      "INSERT INTO _croft.assets_log (name, kind, row_count, seq, closed) VALUES ('orders', 'ingest', 5, 1, false)",
      "CHECKPOINT",
    ]);
    putCopy(p, logged, "2026-10-30T10:00:00Z");
    const e = await engine(p);
    expect(await count(e, "orders")).toBe(5);
    expect((await ask(e, "SHOW TABLES")).rows.map((r) => r.name)).toEqual(["orders"]);
    for (const sql of ["SELECT * FROM _croft.assets", "SELECT * FROM _croft.assets_log", "SELECT * FROM wh._croft.assets_log", "SELECT * FROM wh._croft.columns", "SHOW TABLES FROM _croft"]) {
      const err = await rejection(ask(e, sql));
      expect(["QUERY_PATH_DENIED", "QUERY_NOT_SELECT", "UNKNOWN_TABLE"], sql).toContain(err.code);
    }
  });

  withExt("a croft that reads up to the log's format refuses the next one", async () => {
    const p = await project({ n: 5, copy: false });
    const newer = join(p.root, "newer.duckdb");
    copyFileSync(p.database, newer);
    await seed(newer, ["CREATE SCHEMA _croft", "CREATE TABLE _croft.meta (key VARCHAR, value VARCHAR)", `INSERT INTO _croft.meta VALUES ('format_version', '${LOG_FORMAT_VERSION + 1}')`, "CHECKPOINT"]);
    putCopy(p, newer, "2026-10-30T10:00:00Z");
    const err = await rejection(openReadersEngine({ root: p.root, extensionDir: ext.dir, copyPollMs: 25 }));
    expect(err.code).toBe("DB_NEWER_FORMAT");
  });
});

describe("queries", () => {
  withExt("the app token reads every table of the copy, on a connection whose default database is the copy; the gate is the file mode's", async () => {
    const p = await project({ n: 5, copy: false });
    await seed(p.database, ["CREATE TABLE other AS SELECT 1 AS x"]);
    putCopy(p, aside(p, "two-tables"), "2026-10-30T10:00:00Z");
    const e = await engine(p);
    expect(await count(e, "orders")).toBe(5);
    expect((await ask(e, "SELECT x FROM other")).rows).toEqual([{ x: 1 }]);
    expect((await ask(e, "SHOW TABLES")).rows.map((r) => r.name).sort()).toEqual(["orders", "other"]);
    // Files, settings, other catalogs and writes stay refused, exactly as over the live file.
    for (const sql of ["SELECT * FROM read_csv('/etc/hosts')", "SELECT current_setting('threads')", "SELECT * FROM duckdb_databases()", "SELECT * FROM memory.main.orders", "SELECT * FROM system.main.duckdb_tables"]) {
      const err = await rejection(ask(e, sql));
      expect(["QUERY_PATH_DENIED", "QUERY_NOT_SELECT", "UNKNOWN_TABLE"], sql).toContain(err.code);
    }
    expect((await rejection(ask(e, "INSERT INTO orders VALUES (1, 1)"))).code).toBe("QUERY_NOT_SELECT");
    expect((await rejection(ask(e, "SELECT 1; SELECT 2"))).code).toBeTruthy();
  });

  withExt("params bind, and a result past the limit is an error, never a partial answer", async () => {
    const p = await project({ n: 50 });
    const e = await engine(p);
    expect((await e.query({ sql: "SELECT count(*) AS n FROM orders WHERE id < $1", params: [7], limit: 100 })).rows).toEqual([{ n: 7 }]);
    expect((await rejection(e.query({ sql: "SELECT * FROM orders", params: [], limit: 10 }))).code).toBe("QUERY_TOO_MANY_ROWS");
  });
});

describe("the copy is refreshed under the readers", () => {
  withExt("a replaced copy is swapped in within the poll; the readers' process and its connections stay, and asOf follows", async () => {
    const p = await project({ n: 10, asOf: "2026-10-30T10:00:00Z" });
    const swapped: { asOf: string; ms: number }[] = [];
    const e = await engine(p, { hooks: { swapped: (x) => swapped.push(x) } });
    const pid = e.status().serverMode!.workerPid;
    expect(await count(e)).toBe(10);
    await replaceCopy(p, 25, "2026-10-30T11:00:00Z");
    await until("the swap", () => (e.status().serverMode?.swaps ?? 0) === 1);
    const a = await ask(e, "SELECT count(*) AS n FROM orders");
    expect(a.rows).toEqual([{ n: 25 }]);
    expect(a.asOf).toBe("2026-10-30T04:00:00-07:00");
    expect(e.status().serverMode).toMatchObject({ workerPid: pid, restarts: 0 });
    expect(swapped).toHaveLength(1);
    expect(swapped[0]!.ms).toBeLessThan(500);
  });

  withExt("across three refreshes under steady queries from two clients, no query fails and the process and its connections survive", async () => {
    const p = await project({ n: 10, asOf: "2026-10-30T10:00:00Z" });
    const e = await engine(p);
    const pid = e.status().serverMode!.workerPid;
    let stop = false;
    const failures: unknown[] = [];
    const seen = [new Set<number>(), new Set<number>()];
    const client = async (i: number) => {
      while (!stop) {
        try {
          seen[i]!.add(await count(e));
        } catch (err) {
          failures.push(err);
        }
        await sleep(2);
      }
    };
    const clients = [client(0), client(1)];
    await sleep(100);
    for (const [step, n] of [20, 30, 40].entries()) {
      await replaceCopy(p, n, `2026-10-30T1${step + 1}:00:00Z`);
      await until(`swap ${step + 1}`, () => (e.status().serverMode?.swaps ?? 0) === step + 1);
      await sleep(100);
    }
    stop = true;
    await Promise.all(clients);
    expect(failures).toEqual([]);
    expect(e.status().serverMode).toMatchObject({ workerPid: pid, swaps: 3, restarts: 0 });
    expect(await count(e)).toBe(40);
    expect(e.status().openConnections).toBeGreaterThan(0);
    // The readers wrote nothing into the copy they served: after they stop, it is the file that was put there.
    const placed = sha(p.project.paths.readCopy);
    await e.close();
    expect(sha(p.project.paths.readCopy)).toBe(placed);
    expect(existsSync(`${p.project.paths.readCopy}.wal`)).toBe(false);
    // Every client saw the data move on, and only the counts the copies held.
    for (const s of seen) {
      expect([...s].every((n) => [10, 20, 30, 40].includes(n))).toBe(true);
      expect(s.has(40)).toBe(true);
    }
  });

  // A CPU-bound query of about 2 s here and 4 s or more on a CI runner: the explicit timeout is for the runner, and the test
  // asserts order, not speed (the swap and the next query come while the long one is still running).
  withExt("a refresh that lands while a long query reads the old file lets that query finish on it, and the swap does not wait for it", async () => {
    const p = await project({ n: 10 });
    const e = await engine(p);
    let finished = false;
    const long = ask(e, "SELECT count(*) AS n FROM range(25000000) a, range(30) b WHERE (a.range + b.range) % 7 = 0").finally(() => (finished = true));
    await sleep(100);
    await replaceCopy(p, 25, "2026-10-30T11:00:00Z");
    await until("the swap", () => (e.status().serverMode?.swaps ?? 0) === 1);
    expect(finished).toBe(false); // the swap did not wait for the query
    expect(await count(e)).toBe(25); // and a query after it reads the new copy at once
    expect(finished).toBe(false);
    expect(Number((await long).rows[0]!.n)).toBeGreaterThan(0); // the long one finishes on the old file
  }, 60_000);

  withExt("a valid <copy>.wal left beside a refreshed copy is not replayed: the readers see the copy, and the file is gone", async () => {
    const p = await project({ n: 10 });
    const e = await engine(p);
    // A WAL that belongs to the new copy's file: made by writing to a file and copying it while its WAL is still there.
    const next = join(p.root, "wal-source.duckdb");
    const script = `const { DuckDBInstance } = require(${JSON.stringify(import.meta.resolve("@duckdb/node-api").replace("file://", ""))});
      (async () => { const i = await DuckDBInstance.create(${JSON.stringify(next)}, { checkpoint_threshold: "1GB" }); const c = await i.connect();
        await c.run("CREATE TABLE orders AS SELECT range AS id, range % 7 AS k FROM range(30)"); await c.run("CHECKPOINT");
        await c.run("INSERT INTO orders SELECT range + 1000, 0 FROM range(5)");
        require("node:fs").copyFileSync(${JSON.stringify(next)}, ${JSON.stringify(next + ".copy")}); require("node:fs").copyFileSync(${JSON.stringify(next + ".wal")}, ${JSON.stringify(next + ".copy.wal")});
        c.disconnectSync(); i.closeSync(); })();`;
    expect(spawnSync(process.execPath, ["-e", script], { encoding: "utf8" }).status).toBe(0);
    expect(existsSync(next + ".copy.wal")).toBe(true);
    // The copy (30 orders) lands with its WAL beside it, which would add 5 orders if replayed. The WAL is there first:
    // the swap that the new copy triggers must find it gone.
    renameSync(next + ".copy.wal", `${p.project.paths.readCopy}.wal`);
    putCopy(p, next + ".copy", "2026-10-30T11:00:00Z");
    await until("the swap", () => (e.status().serverMode?.swaps ?? 0) === 1);
    expect(await count(e)).toBe(30);
    expect(existsSync(`${p.project.paths.readCopy}.wal`)).toBe(false);
  });
});
