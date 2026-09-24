import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { croftHome, type CroftHome } from "./home.ts";
import {
  addProject, LOCK_STALE_MS, listProjects, MISSING_PRUNE_DAYS, type PresenceFs, projectPresence, pruneRegistry, registryLockDbPath,
  registryLockPath, removeProject, volumeRoots, withRegistryLock,
} from "./registry.ts";

let tmp: string;
let home: CroftHome;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "croft-registry-")));
  home = croftHome({ HOME: join(tmp, "user"), CROFT_HOME: join(tmp, "croft-home"), CROFT_JOB_LABEL: `dev.croft.test-${process.pid}-${Date.now()}` });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** A folder with a croft.json, like `croft init` leaves it. */
function project(name: string): string {
  const root = join(tmp, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "croft.json"), `{"database": "warehouse.duckdb", "timezone": "UTC"}\n`);
  return root;
}

const AT = new Date("2026-09-24T10:00:00.000Z");

describe("listProjects", () => {
  test("a missing projects.json is an empty registry", () => {
    expect(listProjects(home)).toEqual([]);
    expect(existsSync(home.registry)).toBe(false);
  });

  test("unparseable JSON is CONFIG_INVALID naming the file, with a way out", () => {
    mkdirSync(home.dir, { recursive: true });
    writeFileSync(home.registry, "[{ not json");
    let err: unknown;
    try {
      listProjects(home);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CroftError);
    const p = (err as CroftError).problem;
    expect(p.code).toBe("CONFIG_INVALID");
    expect(p.file).toBe(home.registry);
    expect(p.message).toContain(home.registry);
    expect(p.hint).toContain("croft schedule on");
    expect(p.fix?.kind).toBe("manual");
  });

  test("entries that are not RegistryEntry shaped are skipped, the rest kept", () => {
    const a = project("a");
    mkdirSync(home.dir, { recursive: true });
    writeFileSync(home.registry, JSON.stringify([
      { root: a, addedAt: AT.toISOString(), via: "os-job" },
      { root: "relative/path", addedAt: AT.toISOString(), via: "os-job" },
      { root: a + "x", addedAt: AT.toISOString(), via: "carrier-pigeon" },
      "nope", null, 7,
    ]));
    expect(listProjects(home)).toEqual([{ root: a, addedAt: AT.toISOString(), via: "os-job" }]);
  });

  test("a JSON value that is not an array is CONFIG_INVALID", () => {
    mkdirSync(home.dir, { recursive: true });
    writeFileSync(home.registry, `{"projects": []}`);
    expect(() => listProjects(home)).toThrow(/projects\.json/);
  });
});

describe("addProject", () => {
  test("creates ~/.croft/projects.json (0600) with the canonical root, addedAt and via; leaves no temp or lock file", () => {
    const a = project("a");
    const r = addProject(home, { root: a, via: "os-job" }, { now: AT });
    expect(r.added).toBe(true);
    expect(r.entry).toEqual({ root: a, addedAt: AT.toISOString(), via: "os-job" });
    expect(JSON.parse(readFileSync(home.registry, "utf8"))).toEqual([r.entry]);
    expect(statSync(home.registry).mode & 0o777).toBe(0o600);
    // The OS lock's database stays (empty: it holds no data); no lock file, journal or temp file does.
    expect(readdirSync(home.dir).sort()).toEqual(["projects.json", "projects.json.lock.db"]);
    expect(statSync(registryLockDbPath(home)).size).toBe(0);
    expect(listProjects(home)).toEqual([r.entry]);
  });

  test("adding a project again updates via and keeps addedAt: one entry per project", () => {
    const a = project("a");
    addProject(home, { root: a, via: "os-job" }, { now: AT });
    const r = addProject(home, { root: a, via: "serve" }, { now: new Date("2026-09-25T00:00:00Z") });
    expect(r.added).toBe(false);
    expect(listProjects(home)).toEqual([{ root: a, addedAt: AT.toISOString(), via: "serve" }]);
  });

  test("a path through a symlink is stored as the real folder, so the project is never listed twice", () => {
    const a = project("a");
    const link = join(tmp, "link-to-a");
    symlinkSync(a, link);
    addProject(home, { root: a, via: "os-job" }, { now: AT });
    addProject(home, { root: link + "/", via: "os-job" }, { now: AT });
    expect(listProjects(home).map((e) => e.root)).toEqual([a]);
  });

  test("addedAt defaults to CROFT_NOW when set", () => {
    const a = project("a");
    const r = addProject(home, { root: a, via: "os-job" }, { env: { CROFT_NOW: "2026-01-02T03:04:05Z" } });
    expect(r.entry.addedAt).toBe("2026-01-02T03:04:05.000Z");
  });

  test("keeps other projects, in the order they were added", () => {
    const [a, b, c] = [project("a"), project("b"), project("c")];
    for (const root of [a, b, c]) addProject(home, { root, via: "os-job" }, { now: AT });
    expect(listProjects(home).map((e) => e.root)).toEqual([a, b, c]);
  });
});

describe("removeProject", () => {
  test("removes the entry and returns it with what remains", () => {
    const [a, b] = [project("a"), project("b")];
    addProject(home, { root: a, via: "os-job" }, { now: AT });
    addProject(home, { root: b, via: "serve" }, { now: AT });
    const r = removeProject(home, a);
    expect(r.removed?.root).toBe(a);
    expect(r.entries).toEqual([{ root: b, addedAt: AT.toISOString(), via: "serve" }]);
    expect(listProjects(home)).toEqual(r.entries);
  });

  test("an unknown project removes nothing and does not create the file", () => {
    const r = removeProject(home, project("a"));
    expect(r).toEqual({ removed: null, entries: [] });
    expect(existsSync(home.registry)).toBe(false);
  });

  test("a project whose folder is already gone is still removed by its path", () => {
    const a = project("a");
    addProject(home, { root: a, via: "os-job" }, { now: AT });
    rmSync(a, { recursive: true });
    expect(removeProject(home, a).removed?.root).toBe(a);
    expect(listProjects(home)).toEqual([]);
  });
});

describe("pruneRegistry", () => {
  test("drops projects whose folder or croft.json is gone, keeps the rest", () => {
    const [a, b, c] = [project("a"), project("b"), project("c")];
    for (const root of [a, b, c]) addProject(home, { root, via: "os-job" }, { now: AT });
    rmSync(a, { recursive: true });
    rmSync(join(c, "croft.json"));
    const r = pruneRegistry(home);
    expect(r.removed.map((e) => e.root)).toEqual([a, c]);
    expect(r.entries.map((e) => e.root)).toEqual([b]);
    expect(listProjects(home).map((e) => e.root)).toEqual([b]);
  });

  test("nothing to prune writes nothing", () => {
    const a = project("a");
    addProject(home, { root: a, via: "os-job" }, { now: AT });
    utimesSync(home.registry, new Date(0), new Date(0));
    expect(pruneRegistry(home).removed).toEqual([]);
    expect(statSync(home.registry).mtimeMs).toBe(0);
  });

  test("a folder croft may not look into is kept, not pruned (macOS privacy protection answers EPERM, not ENOENT)", () => {
    expect(projectPresence(join(tmp, "missing"))).toBe("gone");
    expect(projectPresence(project("here"))).toBe("present");
    const file = join(tmp, "a-file");
    writeFileSync(file, "");
    expect(projectPresence(file)).toBe("gone");            // ENOTDIR: not a folder at all
    if (process.getuid?.() !== 0) {
      const locked = project("locked");
      const { chmodSync } = require("node:fs") as typeof import("node:fs");
      chmodSync(locked, 0o000);
      try {
        expect(projectPresence(locked)).toBe("unknown");   // EACCES: stat of croft.json inside it fails
        addProject(home, { root: locked, via: "os-job" }, { now: AT });
        expect(pruneRegistry(home).removed).toEqual([]);
      } finally {
        chmodSync(locked, 0o755);
      }
    }
  });
});

describe("the registry lock", () => {
  test("a lock left by a dead process is broken at once", () => {
    mkdirSync(home.dir, { recursive: true });
    writeFileSync(registryLockPath(home), "999999999\n");   // no such pid
    const t0 = Date.now();
    addProject(home, { root: project("a"), via: "os-job" }, { now: AT });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(existsSync(registryLockPath(home))).toBe(false);
  });

  test(`a lock older than ${LOCK_STALE_MS / 1000} s is broken even when its pid is alive (a reused pid)`, () => {
    mkdirSync(home.dir, { recursive: true });
    const lock = registryLockPath(home);
    writeFileSync(lock, `${process.pid}\n`);
    const old = new Date(Date.now() - LOCK_STALE_MS - 5000);
    utimesSync(lock, old, old);
    addProject(home, { root: project("a"), via: "os-job" }, { now: AT });
    expect(listProjects(home)).toHaveLength(1);
  });

  test("a live holder is waited for", async () => {
    mkdirSync(home.dir, { recursive: true });
    const lock = registryLockPath(home);
    // Another process takes the lock and lets go after 300 ms.
    const holder = spawn(process.execPath, ["-e", `
      const fs = require("node:fs");
      fs.writeFileSync(${JSON.stringify(lock)}, process.pid + "\\n", { flag: "wx" });
      console.log("held");
      setTimeout(() => fs.unlinkSync(${JSON.stringify(lock)}), 300);
    `], { stdio: ["ignore", "pipe", "inherit"], env: { PATH: process.env.PATH ?? "" } });
    await new Promise<void>((resolve) => holder.stdout!.once("data", () => resolve()));
    const t0 = Date.now();
    addProject(home, { root: project("a"), via: "os-job" }, { now: AT });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
    expect(listProjects(home)).toHaveLength(1);
    await new Promise((r) => holder.once("exit", r));
  });

  test("withRegistryLock releases the lock when its function throws", () => {
    expect(() => withRegistryLock(home, () => { throw new Error("boom"); })).toThrow("boom");
    expect(existsSync(registryLockPath(home))).toBe(false);
  });

  test("concurrent writers in separate processes lose no update", async () => {
    const n = 8;
    const roots = Array.from({ length: n }, (_, i) => project(`p${i}`));
    const script = join(tmp, "add.ts");
    writeFileSync(script, `
      import { addProject } from ${JSON.stringify(join(import.meta.dir, "registry.ts"))};
      import { croftHome } from ${JSON.stringify(join(import.meta.dir, "home.ts"))};
      const home = croftHome({ HOME: ${JSON.stringify(join(tmp, "user"))}, CROFT_HOME: ${JSON.stringify(home.dir)} });
      addProject(home, { root: process.argv[2], via: "os-job" });
    `);
    const children = roots.map((root) => spawn(process.execPath, ["--no-env-file", script, root], {
      stdio: ["ignore", "inherit", "inherit"], env: { PATH: process.env.PATH ?? "", CROFT_FORBID_OS_JOBS: "1" },
    }));
    const codes = await Promise.all(children.map((c) => new Promise<number | null>((r) => c.once("exit", (code) => r(code)))));
    expect(codes).toEqual(Array(n).fill(0));
    expect(listProjects(home).map((e) => e.root).sort()).toEqual([...roots].sort());
    expect(readdirSync(home.dir).sort()).toEqual(["projects.json", "projects.json.lock.db"]);
  });
});

const DAY = 86_400_000;

/** A file system of folders with device numbers, for mounts no test machine has. */
function fakeFs(dirs: Record<string, number>, denied: string[] = []): PresenceFs {
  return {
    stat(path) {
      if (denied.includes(path)) throw Object.assign(new Error(`EACCES: permission denied, stat '${path}'`), { code: "EACCES" });
      const dev = dirs[path];
      if (dev === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: "ENOENT" });
      return { dev, isDirectory: () => !path.endsWith(".json") };
    },
  };
}

describe("a project that is missing, not gone (review R31-10)", () => {
  test("volumeRoots: where removable and network disks are mounted", () => {
    expect(volumeRoots("/Volumes/ExternalSSD/sales-pipeline")).toEqual(["/Volumes/ExternalSSD"]);
    expect(volumeRoots("/Volumes/ExternalSSD")).toEqual(["/Volumes/ExternalSSD"]);
    expect(volumeRoots("/mnt/usb/work/p")).toEqual(["/mnt/usb"]);
    expect(volumeRoots("/media/ada/DISK/p")).toEqual(["/media/ada", "/media/ada/DISK"]);
    expect(volumeRoots("/media/usb0")).toEqual(["/media/usb0"]);
    expect(volumeRoots("/run/media/ada/DISK/p")).toEqual(["/run/media/ada/DISK"]);
    expect(volumeRoots("/run/media/ada")).toEqual([]);
    expect(volumeRoots("/Users/ada/code/p")).toEqual([]);
    expect(volumeRoots("/home/ada/mnt/p")).toEqual([]);
  });

  test.each([
    // [what, root, folders with their devices, presence]
    ["an unplugged disk on macOS (its /Volumes folder is gone)", "/Volumes/ExternalSSD/sales", { "/": 1, "/Volumes": 1 }, "missing"],
    ["a project folder deleted from a plugged-in disk", "/Volumes/ExternalSSD/sales", { "/": 1, "/Volumes": 1, "/Volumes/ExternalSSD": 7 }, "gone"],
    ["a project at the top of an unplugged disk", "/Volumes/ExternalSSD", { "/": 1, "/Volumes": 1 }, "missing"],
    ["an unmounted Linux disk whose empty mount point stays", "/mnt/usb/sales", { "/": 1, "/mnt": 1, "/mnt/usb": 1 }, "missing"],
    ["a project deleted from a mounted Linux disk", "/mnt/usb/sales", { "/": 1, "/mnt": 1, "/mnt/usb": 3 }, "gone"],
    ["an unmounted udisks disk", "/media/ada/DISK/sales", { "/": 1, "/media": 1, "/media/ada": 1 }, "missing"],
    ["a project deleted from a mounted udisks disk", "/media/ada/DISK/sales", { "/": 1, "/media": 1, "/media/ada": 1, "/media/ada/DISK": 4 }, "gone"],
    ["a mounted disk whose folder around the project is gone", "/run/media/ada/DISK/work/sales",
      { "/": 1, "/run": 2, "/run/media": 2, "/run/media/ada": 2, "/run/media/ada/DISK": 5 }, "missing"],
    ["a deleted project in a folder that is there", "/Users/ada/code/sales", { "/": 1, "/Users": 1, "/Users/ada": 1, "/Users/ada/code": 1 }, "gone"],
    ["a project whose parent folder is gone too", "/Users/ada/code/client/sales", { "/": 1, "/Users": 1, "/Users/ada": 1, "/Users/ada/code": 1 }, "missing"],
    ["a project that is there", "/Volumes/ExternalSSD/sales", { "/Volumes/ExternalSSD/sales/croft.json": 7 }, "present"],
  ] as const)("%s: %s is %s", (_what, root, dirs, want) => {
    expect(projectPresence(root, fakeFs(dirs))).toBe(want);
  });

  test("a folder around the project that cannot be looked into is unknown, not missing", () => {
    expect(projectPresence("/Users/ada/Documents/sales", fakeFs({ "/Users/ada": 1 }, ["/Users/ada/Documents"]))).toBe("unknown");
  });

  test("on the real file system: a parent folder that is gone too makes the project missing", () => {
    expect(projectPresence(join(tmp, "no-such-client", "sales"))).toBe("missing");
    expect(projectPresence(join(tmp, "sales"))).toBe("gone");
    expect(projectPresence(`/Volumes/croft-test-${process.pid}-${Date.now()}/sales`)).toBe("missing");
  });

  test(`pruneRegistry keeps a missing project, marked missingSince, and drops it after ${MISSING_PRUNE_DAYS} days missing`, () => {
    const root = `/Volumes/croft-test-${process.pid}-${Date.now()}/sales-pipeline`;
    mkdirSync(home.dir, { recursive: true });
    writeFileSync(home.registry, JSON.stringify([{ root, addedAt: AT.toISOString(), via: "os-job" }]));
    const first = pruneRegistry(home, { now: AT });
    expect(first.removed).toEqual([]);
    expect(first.missing).toEqual([{ root, addedAt: AT.toISOString(), via: "os-job", missingSince: AT.toISOString() }]);
    expect(listProjects(home)).toEqual(first.missing);
    // Still missing a day short of the limit: kept, and the file is not rewritten.
    utimesSync(home.registry, new Date(0), new Date(0));
    const later = pruneRegistry(home, { now: new Date(AT.getTime() + (MISSING_PRUNE_DAYS - 1) * DAY) });
    expect(later.removed).toEqual([]);
    expect(later.missing.map((e) => e.missingSince)).toEqual([AT.toISOString()]);
    expect(statSync(home.registry).mtimeMs).toBe(0);
    const last = pruneRegistry(home, { now: new Date(AT.getTime() + MISSING_PRUNE_DAYS * DAY) });
    expect(last.removed.map((e) => e.root)).toEqual([root]);
    expect(listProjects(home)).toEqual([]);
  });

  test("a missing project that is back is unmarked, by pruning or by croft schedule on", () => {
    const a = project("a");
    const b = project("b");
    mkdirSync(home.dir, { recursive: true });
    writeFileSync(home.registry, JSON.stringify([
      { root: a, addedAt: AT.toISOString(), via: "os-job", missingSince: AT.toISOString() },
      { root: b, addedAt: AT.toISOString(), via: "os-job", missingSince: AT.toISOString() },
    ]));
    expect(listProjects(home).map((e) => e.missingSince)).toEqual([AT.toISOString(), AT.toISOString()]);
    expect(addProject(home, { root: a, via: "os-job" }, { now: AT }).added).toBe(false);
    expect(listProjects(home)[0]).toEqual({ root: a, addedAt: AT.toISOString(), via: "os-job" });
    const r = pruneRegistry(home, { now: new Date(AT.getTime() + 90 * DAY) });
    expect(r.removed).toEqual([]);
    expect(listProjects(home)).toEqual([
      { root: a, addedAt: AT.toISOString(), via: "os-job" }, { root: b, addedAt: AT.toISOString(), via: "os-job" },
    ]);
  });

  test("with its disk mounted and the folder around it there, a gone project is dropped at once", () => {
    const root = "/Volumes/Work/sales";
    mkdirSync(home.dir, { recursive: true });
    writeFileSync(home.registry, JSON.stringify([{ root, addedAt: AT.toISOString(), via: "os-job" }]));
    const r = pruneRegistry(home, { now: AT, fs: fakeFs({ "/": 1, "/Volumes": 1, "/Volumes/Work": 9 }) });
    expect(r.removed.map((e) => e.root)).toEqual([root]);
  });
});

describe("the OS lock", () => {
  test("a writer killed while holding both locks leaves nothing that blocks the next one", async () => {
    const script = join(tmp, "die.ts");
    writeFileSync(script, `
      import { withRegistryLock } from ${JSON.stringify(join(import.meta.dir, "registry.ts"))};
      import { croftHome } from ${JSON.stringify(join(import.meta.dir, "home.ts"))};
      const home = croftHome({ HOME: ${JSON.stringify(join(tmp, "user"))}, CROFT_HOME: ${JSON.stringify(home.dir)} });
      withRegistryLock(home, () => process.kill(process.pid, "SIGKILL"));
    `);
    const child = Bun.spawn([process.execPath, "--no-env-file", script], { stdio: ["ignore", "inherit", "inherit"], env: { PATH: process.env.PATH ?? "" } });
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
    expect(existsSync(registryLockPath(home))).toBe(true);           // its lock file, with a dead pid
    const t0 = Date.now();
    addProject(home, { root: project("a"), via: "os-job" }, { now: AT });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(listProjects(home)).toHaveLength(1);
    expect(existsSync(registryLockPath(home))).toBe(false);
  });

  test("a writer that cannot get the lock in time is DB_BUSY, naming the lock, with a hint", async () => {
    const script = join(tmp, "hold.ts");
    writeFileSync(script, `
      import { withRegistryLock } from ${JSON.stringify(join(import.meta.dir, "registry.ts"))};
      import { croftHome } from ${JSON.stringify(join(import.meta.dir, "home.ts"))};
      const home = croftHome({ HOME: ${JSON.stringify(join(tmp, "user"))}, CROFT_HOME: ${JSON.stringify(home.dir)} });
      withRegistryLock(home, () => { console.log("held"); Bun.sleepSync(20_000); });
    `);
    const holder = spawn(process.execPath, ["--no-env-file", script], { stdio: ["ignore", "pipe", "inherit"], env: { PATH: process.env.PATH ?? "" } });
    try {
      await new Promise<void>((resolve) => holder.stdout!.once("data", () => resolve()));
      let caught: unknown;
      const t0 = Date.now();
      try {
        withRegistryLock(home, () => {}, { waitMs: 300 });
      } catch (e) {
        caught = e;
      }
      expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
      expect(caught).toBeInstanceOf(CroftError);
      const p = (caught as CroftError).problem;
      expect(p.code).toBe("DB_BUSY");
      expect(p.message).toContain(home.registry);
      expect(p.message).toContain("for more than 300 ms");
      expect(p.hint).toContain(`lsof ${registryLockDbPath(home)}`);
      expect(p.fix?.kind).toBe("manual");
    } finally {
      holder.kill("SIGKILL");
      await new Promise((r) => holder.once("exit", r));
    }
    // The kernel dropped the killed holder's lock.
    addProject(home, { root: project("a"), via: "os-job" }, { now: AT });
    expect(listProjects(home)).toHaveLength(1);
  });

  test("a lock file held by a live croft from before the OS lock is waited for too, then DB_BUSY naming the file", () => {
    mkdirSync(home.dir, { recursive: true });
    writeFileSync(registryLockPath(home), `${process.pid}\n`);      // alive, and fresh
    let caught: unknown;
    try {
      withRegistryLock(home, () => {}, { waitMs: 200 });
    } catch (e) {
      caught = e;
    }
    const p = (caught as CroftError).problem;
    expect(p.code).toBe("DB_BUSY");
    expect(p.hint).toContain(`${registryLockPath(home)} holds its pid`);
    expect(readFileSync(registryLockPath(home), "utf8")).toBe(`${process.pid}\n`);   // not broken
  });

  test("a lock database that is not a database is CONFIG_INVALID, with the way out", () => {
    mkdirSync(home.dir, { recursive: true });
    writeFileSync(registryLockDbPath(home), "not a database ".repeat(100));
    let caught: unknown;
    try {
      addProject(home, { root: project("a"), via: "os-job" }, { now: AT });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CroftError);
    const p = (caught as CroftError).problem;
    expect(p.code).toBe("CONFIG_INVALID");
    expect(p.file).toBe(registryLockDbPath(home));
    expect(p.hint).toContain(`delete ${registryLockDbPath(home)}`);
  });
});

describe("racing writers and a stale lock (review R31-03)", () => {
  /** Long-lived writer processes: each adds the project it is sent, at the instant it is sent, and answers. */
  function writers(n: number) {
    const script = join(tmp, "writer.ts");
    writeFileSync(script, `
      import { addProject } from ${JSON.stringify(join(import.meta.dir, "registry.ts"))};
      import { croftHome } from ${JSON.stringify(join(import.meta.dir, "home.ts"))};
      process.on("message", (m) => {
        const home = croftHome({ HOME: m.userHome, CROFT_HOME: m.dir });
        while (Date.now() < m.at) {}                     // start together
        try {
          addProject(home, { root: m.root, via: "os-job" });
          process.send({ ok: true });
        } catch (e) {
          process.send({ ok: false, error: String((e && e.stack) || e) });
        }
      });
      process.send({ ready: true });
    `);
    return Array.from({ length: n }, () => {
      const inbox: unknown[] = [];
      let waiting: ((m: unknown) => void) | null = null;
      const proc = Bun.spawn([process.execPath, "--no-env-file", script], {
        ipc(m) {
          if (waiting) {
            const w = waiting;
            waiting = null;
            w(m);
          } else {
            inbox.push(m);
          }
        },
        stdio: ["ignore", "inherit", "inherit"], env: { PATH: process.env.PATH ?? "", CROFT_FORBID_OS_JOBS: "1" },
      });
      const next = () => new Promise<unknown>((r) => {
        if (inbox.length > 0) r(inbox.shift());
        else waiting = r;
      });
      return { proc, next };
    });
  }

  test("24 writers starting at once over a lock left by a dead pid (25 times) or by a live pid a minute ago (10 times) lose no entry", async () => {
    const N = 24;
    const pool = writers(N);
    try {
      await Promise.all(pool.map((w) => w.next()));
      const roots = Array.from({ length: N }, (_, i) => join(tmp, "projects", `p${i}`));
      const trials: ("dead" | "old")[] = [...Array<"dead">(25).fill("dead"), ...Array<"old">(10).fill("old")];
      const lost: string[] = [];
      for (const [t, mode] of trials.entries()) {
        const dir = join(tmp, "homes", `t${t}`);
        mkdirSync(dir, { recursive: true });
        const lock = join(dir, "projects.json.lock");
        if (mode === "dead") {
          writeFileSync(lock, "999999999\n");            // no such pid
        } else {
          writeFileSync(lock, `${process.pid}\n`);       // alive, but the file is a minute old (a reused pid)
          const old = new Date(Date.now() - 60_000);
          utimesSync(lock, old, old);
        }
        const answers = pool.map((w) => w.next());
        const at = Date.now() + 100;
        pool.forEach((w, i) => w.proc.send({ dir, userHome: join(tmp, "user"), root: roots[i], at }));
        const got = await Promise.all(answers);
        expect(got.filter((m) => !(m as { ok: boolean }).ok)).toEqual([]);
        const have = listProjects(croftHome({ HOME: join(tmp, "user"), CROFT_HOME: dir })).map((e) => e.root);
        if (have.length !== N) lost.push(`trial ${t} (${mode} lock): ${have.length}/${N} projects`);
        expect(existsSync(lock)).toBe(false);
      }
      expect(lost).toEqual([]);
    } finally {
      for (const w of pool) w.proc.kill();
      await Promise.all(pool.map((w) => w.proc.exited));
    }
  }, 180_000);
});
