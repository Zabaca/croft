// croft serve in server mode (DESIGN.md D119, §5 "Server mode, apps and GUIs"; option 06, slice 2): the readers' process on
// the read copy. These tests start real readers' processes (children of the test, killed in teardown), which load
// DuckDB's real quack and httpfs files, so they need them (scripts/fetch-extensions.ts fills the folder). Locally a
// missing file skips them and says why on stderr; in CI (CROFT_CI=1) it fails them instead.
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { closeAllWarehouses } from "../db/warehouse.ts";
import { cleanup, seed, type TempProject } from "../read/testkit.ts";
import { aside, ask, count, extensionFiles, openEngine, project, putCopy, rejection, replaceCopy, sleep, until } from "./readers-testkit.ts";
import { openReadersEngine } from "./readers.ts";
import type { ServeEngine } from "./types.ts";

const { ext, withExt } = extensionFiles("readers.test");
const engines: ServeEngine[] = [];
afterAll(async () => {
  for (const e of engines) await e.close().catch(() => {});
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

  withExt("without a copy yet it waits for the first run, and picks the copy up within a second", async () => {
    const p = await project({ copy: false });
    const e = await engine(p);
    expect((await rejection(ask(e, "SELECT 1"))).code).toBe("DB_NOT_FOUND");
    expect(e.status().serverMode?.state).toBe("waiting");
    putCopy(p, aside(p, "late"), "2026-10-30T10:00:00Z");
    await until("the copy to be served", () => e.status().serverMode?.state === "open", 1500);
    expect(await count(e)).toBe(10);
  });

  test("with the extension files missing, croft serve does not start, and says which file (EXTENSION_MISSING)", async () => {
    const p = await project();
    const err = await rejection(openReadersEngine({ root: p.root, extensionDir: join(p.root, "no-extensions"), copyPollMs: 25 }));
    expect(err.code).toBe("EXTENSION_MISSING");
    expect(err.problem.details).toMatchObject({ kind: "file" });
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
    // Every client saw the data move on, and only the counts the copies held.
    for (const s of seen) {
      expect([...s].every((n) => [10, 20, 30, 40].includes(n))).toBe(true);
      expect(s.has(40)).toBe(true);
    }
    expect(e.status().openConnections).toBeGreaterThan(0);
  });

  withExt("a refresh that lands while a long query reads the old file lets that query finish on it", async () => {
    const p = await project({ n: 10 });
    const e = await engine(p);
    const long = ask(e, "SELECT count(*) AS n FROM range(40000000) a, range(30) b WHERE (a.range + b.range) % 7 = 0");
    await sleep(100);
    await replaceCopy(p, 25, "2026-10-30T11:00:00Z");
    await until("the swap", () => (e.status().serverMode?.swaps ?? 0) === 1);
    expect(Number((await long).rows[0]!.n)).toBeGreaterThan(0);
    expect(await count(e)).toBe(25);
  });

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
