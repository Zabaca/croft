import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { croftHome, type CroftHome } from "./home.ts";
import {
  addProject, LOCK_STALE_MS, listProjects, projectPresence, pruneRegistry, registryLockPath, removeProject, withRegistryLock,
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
    expect(readdirSync(home.dir).sort()).toEqual(["projects.json"]);
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
    expect(readdirSync(home.dir).sort()).toEqual(["projects.json"]);
  });
});
