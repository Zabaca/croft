// The readers' process as a process (DESIGN.md D119; option 06, slice 2): it is replaced when it is killed or crashes, a
// process that cannot start its mode ends itself and is replaced after a backoff (its instance is part set up and is never
// reused), a copy a newer croft wrote is refused like the live file is, and the right engine opens for the project.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { extensionPath, hostPlatform } from "../db/extension-files.ts";
import { closeAllWarehouses } from "../db/warehouse.ts";
import { makeProject, cleanup, seed, type TempProject } from "../read/testkit.ts";
import { aside, ask, count, extensionFiles, openEngine, project, putCopy, rejection, sleep, until } from "./readers-testkit.ts";
import { openEngine as openFor } from "./open.ts";
import { QueryWorker } from "./query-worker.ts";
import { restartDelayMs } from "./readers.ts";
import type { ServeEngine } from "./types.ts";

const { ext, withExt } = extensionFiles("readers-process.test");
const engines: ServeEngine[] = [];
const scratch: string[] = [];
afterAll(async () => {
  for (const e of engines) await e.close().catch(() => {});
  await closeAllWarehouses();
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  cleanup();
});
const engine = (p: TempProject, o: Parameters<typeof openEngine>[3] = {}, dir = ext.dir) => openEngine(engines, dir, p, o);

/** An extension folder of symlinks to the real files, so a test can take a file away and put it back. */
function linkedExtensions(): { dir: string; hide(): void; restore(): void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "croft-ext-")));
  scratch.push(dir);
  const platform = hostPlatform()!;
  const files = (["quack", "httpfs"] as const).map((n) => ({ from: extensionPath(ext.dir, n, platform), to: extensionPath(dir, n, platform) }));
  for (const f of files) {
    mkdirSync(join(f.to, ".."), { recursive: true });
    symlinkSync(f.from, f.to);
  }
  return {
    dir,
    hide: () => files.forEach((f) => renameSync(f.to, `${f.to}.hidden`)),
    restore: () => files.forEach((f) => renameSync(`${f.to}.hidden`, f.to)),
  };
}

describe("restarting", () => {
  test("the wait before a start is none the first time, then 250 ms doubling to 60 s", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 9].map(restartDelayMs)).toEqual([0, 250, 500, 1000, 2000, 4000, 8000, 60_000]);
  });

  withExt("a readers' process that is killed (the OOM killer, a crash) is replaced at once, and queries keep being answered", async () => {
    const p = await project({ n: 10 });
    const pids: number[] = [];
    const e = await engine(p, { hooks: { queryEnded: (x) => pids.push(x.workerPid) } });
    await ask(e, "SELECT 1 AS x");
    const first = e.status().serverMode!.workerPid!;
    process.kill(first, "SIGKILL");
    // Until the engine has noticed, a query can still reach the dead process: it is told to retry, as the read client
    // does on a 503.
    const end = Date.now() + 15_000;
    for (;;) {
      try {
        expect(await count(e)).toBe(10);
        break;
      } catch (err) {
        if (Date.now() > end || !(err instanceof CroftError) || err.code !== "SERVE_UNAVAILABLE") throw err;
        expect(err.problem.retryable).toBe(true);
        await sleep(20);
      }
    }
    expect(e.status().serverMode).toMatchObject({ state: "open", restarts: 1 });
    expect(e.status().serverMode!.workerPid).not.toBe(first);
  });

  withExt("a process that cannot start its mode ends itself; the engine tries again after a backoff, queries are refused with the reason, and it recovers", async () => {
    const p = await project({ n: 10 });
    const links = linkedExtensions();
    const exits: number[] = [];
    const waits: number[] = [];
    const e = await engine(p, {
      hooks: { exited: (x) => exits.push(x.pid) },
      restartDelayMs: (n) => (waits.push(n), n === 0 ? 0 : 200),
    }, links.dir);
    const first = e.status().serverMode!.workerPid!;
    // The extension file goes away (an upgrade of the folder, a cleanup), and the process dies.
    links.hide();
    process.kill(first, "SIGKILL");
    const err = await until("the restart to fail", async () => {
      try {
        await ask(e, "SELECT 1");
        return false;
      } catch (x) {
        return (x as { code?: string }).code === "EXTENSION_MISSING" ? true : false;
      }
    }).then(() => rejection(ask(e, "SELECT 1")));
    expect(err.code).toBe("EXTENSION_MISSING");
    // Every process that failed to start has exited by itself or by the engine: none is left holding anything.
    await until("the failed processes to exit", () => exits.length >= 2);
    expect(waits.length).toBeGreaterThanOrEqual(1);
    expect(waits.some((n) => n >= 1)).toBe(true);
    expect(e.status().serverMode!.state).toBe("restarting");
    // The file is back: the next try starts a process that serves.
    links.restore();
    await until("the recovery", () => e.status().serverMode?.state === "open");
    expect(await count(e)).toBe(10);
  }, 60_000);

  withExt("a start that fails makes the readers' process exit by itself (its instance is never reused)", async () => {
    const p = await project({ n: 10 });
    const w = QueryWorker.spawn();
    await w.ready;
    const err = await rejection(w.open({
      path: p.project.paths.readCopy,
      spec: { profile: "serve", timezone: "UTC", stateDir: p.stateDir },
      protect: [p.stateDir],
      readers: { extensionDir: join(p.root, "no-extensions"), secretDir: join(p.stateDir, "readers-secrets") },
    }));
    expect(err.code).toBe("EXTENSION_MISSING");
    const t = Date.now();
    await w.exited; // nobody killed it
    expect(Date.now() - t).toBeLessThan(5000);
    await expect(w.query(1, { sql: "SELECT 1", params: [], limit: 1, maxRows: 1, maxBytes: 100 })).rejects.toThrow();
  });
});

describe("a copy from a newer croft", () => {
  withExt("is refused at a swap like the live file is, with DB_NEWER_FORMAT, until a copy this croft reads comes", async () => {
    const p = await project({ n: 10 });
    const e = await engine(p);
    expect(await count(e)).toBe(10);
    const newer = aside(p, "newer");
    await seed(newer, ["CREATE SCHEMA _croft", "CREATE TABLE _croft.meta (key VARCHAR PRIMARY KEY, value VARCHAR)", "INSERT INTO _croft.meta VALUES ('format_version', '999')", "CHECKPOINT"]);
    putCopy(p, newer, "2026-10-30T11:00:00Z");
    await until("the refusal", async () => {
      try {
        await ask(e, "SELECT 1");
        return false;
      } catch (x) {
        return (x as { code?: string }).code === "DB_NEWER_FORMAT";
      }
    });
    putCopy(p, aside(p, "good"), "2026-10-30T12:00:00Z");
    await until("the recovery", async () => e.status().serverMode?.state === "open", 20_000);
    expect(await count(e)).toBe(10);
  }, 60_000);
});

describe("which engine opens", () => {
  withExt("server mode opens the readers' engine; a project without it opens the file engine, as before", async () => {
    const on = await project({ n: 10 });
    const readers = await openFor({ root: on.root });
    engines.push(readers);
    expect(readers.status().serverMode).toBeDefined();
    expect(await count(readers)).toBe(10);

    const off = await makeProject({ seed: ["CREATE TABLE orders AS SELECT range AS id FROM range(3)"] });
    const file = await openFor({ root: off.root });
    engines.push(file);
    expect(file.status().serverMode).toBeUndefined();
    expect(await count(file)).toBe(3);
  });
});
