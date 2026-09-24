// The generated per-user tick script (~/.croft/tick.ts) imports nothing from croft, so it is tested the way
// the OS job runs it: `bun --no-env-file <script>` against a fake CROFT_HOME and fake projects whose pinned
// "croft" is a stub that records how it was started.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RunsDb } from "../history/runs-db.ts";
import { croftHome, type CroftHome } from "./home.ts";
import type { RegistryEntry, SchedulingSetting } from "./os.ts";
import { addProject, listProjects, registryLockPath } from "./registry.ts";
import { MAX_TICK_LOG_BYTES, TICK_TEMPLATE_VERSION, tickScriptSource, writeTickScript } from "./user-tick.ts";

let tmp: string;
let userHome: string;
let home: CroftHome;
let record: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "croft-user-tick-")));
  userHome = join(tmp, "user");
  mkdirSync(userHome);
  home = croftHome({ HOME: userHome, CROFT_HOME: join(tmp, "croft-home"), CROFT_JOB_LABEL: `dev.croft.test-${process.pid}-${Date.now()}` });
  record = join(tmp, "invocations.ndjson");
  writeTickScript(home);
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface FakeProject {
  /** Scheduling in runs.sqlite; null: no runs.sqlite at all. */
  scheduling?: SchedulingSetting | null;
  /** How the registry lists it. */
  via?: RegistryEntry["via"];
  /** Install a pinned croft stub (default true). */
  pinned?: boolean;
  /** croft.json "stateDir". */
  stateDir?: string;
  /** package.json "bin" of the pinned copy. */
  bin?: string;
}

/** A project folder with croft.json, runs.sqlite (written by the real RunsDb) and a pinned croft stub that
 *  appends {argv, cwd, execPath, env} to `record`. Registered in projects.json. */
function project(name: string, o: FakeProject = {}): string {
  const root = join(tmp, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "croft.json"), JSON.stringify({ database: "warehouse.duckdb", timezone: "UTC", ...(o.stateDir ? { stateDir: o.stateDir } : {}) }));
  if (o.scheduling !== null) {
    const state = o.stateDir ? join(userHome, o.stateDir.replace(/^~\//, "")) : join(root, ".croft");
    const db = RunsDb.open(state);
    db.setScheduling(o.scheduling ?? { state: "on", via: "os-job" });
    db.close();
  }
  if (o.pinned !== false) {
    const copy = join(root, "node_modules", "@zabaca", "croft");
    const bin = o.bin ?? "bin/croft.mjs";
    mkdirSync(dirname(join(copy, bin)), { recursive: true });
    writeFileSync(join(copy, "package.json"), JSON.stringify({ name: "@zabaca/croft", bin: { croft: bin } }));
    writeFileSync(join(copy, bin), `
      import { appendFileSync } from "node:fs";
      console.log("stub croft " + process.argv.slice(2).join(" "));
      appendFileSync(${JSON.stringify(record)}, JSON.stringify({
        argv: process.argv.slice(2), cwd: process.cwd(), execPath: process.execPath, env: process.env, bin: import.meta.path,
      }) + "\\n");
    `);
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    symlinkSync(join("..", "@zabaca", "croft", bin), join(root, "node_modules", ".bin", "croft"));
  }
  addProject(home, { root, via: o.via ?? "os-job" });
  return root;
}

/** Run the generated script as the OS job would: absolute bun, --no-env-file, cwd /, a bare PATH. */
function runTick(extraEnv: Record<string, string> = {}) {
  const r = Bun.spawnSync([process.execPath, "--no-env-file", home.tickScript], {
    cwd: "/", env: { HOME: userHome, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", CROFT_FORBID_OS_JOBS: "1", CROFT_NOTIFY_DRY: "1", ...extraEnv },
    stdout: "pipe", stderr: "pipe",
  });
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

interface Invocation { argv: string[]; cwd: string; execPath: string; env: Record<string, string>; bin: string }

function readInvocations(): Invocation[] {
  if (!existsSync(record)) return [];
  return readFileSync(record, "utf8").trim().split("\n").filter((l) => l).map((l) => JSON.parse(l) as Invocation);
}

/** The stubs run detached after the tick exits: wait for `n` of them. */
async function invocations(n: number, timeoutMs = 10_000): Promise<Invocation[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = readInvocations();
    if (got.length >= n || Date.now() > deadline) return got;
    await Bun.sleep(25);
  }
}

describe("the generated script", () => {
  test("imports nothing from croft: only node: and bun: modules", () => {
    const src = tickScriptSource();
    const specifiers = [...src.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]!);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const s of specifiers) expect(s).toMatch(/^(node|bun):/);
    expect(src).not.toMatch(/\bimport\(/);
    expect(src).not.toMatch(/\brequire\(/);
    expect(src).toContain(`croft-tick-template: ${TICK_TEMPLATE_VERSION}`);
  });

  test("writeTickScript writes it once; unchanged content is not rewritten; an edited copy is restored", () => {
    expect(readFileSync(home.tickScript, "utf8")).toBe(tickScriptSource());
    expect(writeTickScript(home)).toEqual({ path: home.tickScript, changed: false });
    writeFileSync(home.tickScript, "// edited by hand\n");
    expect(writeTickScript(home).changed).toBe(true);
    expect(readFileSync(home.tickScript, "utf8")).toBe(tickScriptSource());
  });

  test("a script written by a newer croft (a later template) is left alone", () => {
    const newer = tickScriptSource().replace(`croft-tick-template: ${TICK_TEMPLATE_VERSION}`, `croft-tick-template: ${TICK_TEMPLATE_VERSION + 1}`);
    writeFileSync(home.tickScript, newer);
    expect(writeTickScript(home).changed).toBe(false);
    expect(readFileSync(home.tickScript, "utf8")).toBe(newer);
  });

  test("with no projects.json it exits 0 and prints nothing", () => {
    const r = runTick();
    expect(r).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
  });
});

describe("each minute", () => {
  test("starts the pinned `croft tick` of every os-job project whose scheduling is on, and no other", async () => {
    const on = project("on");
    const pausedOver = project("paused-over", { scheduling: { state: "on", via: "os-job" } });
    // A pause whose time has passed reads as on (RunsDb.getScheduling does the same).
    const db = RunsDb.open(join(pausedOver, ".croft"));
    db.setScheduling({ state: "paused", via: "os-job", pausedUntil: "2026-01-01T00:00:00Z" });
    db.close();
    project("off", { scheduling: { state: "off", via: null } });
    project("paused", { scheduling: { state: "paused", via: "os-job", pausedUntil: null } });
    project("paused-later", { scheduling: { state: "paused", via: "os-job", pausedUntil: "2099-01-01T00:00:00Z" } });
    project("served", { via: "serve" });                                                  // croft serve ticks it
    project("serve-setting", { scheduling: { state: "on", via: "serve" } });
    project("never-scheduled", { scheduling: null });                                     // no runs.sqlite

    const r = runTick();
    expect(r.exitCode).toBe(0);
    const got = await invocations(2);
    await Bun.sleep(300);                                                                   // and no more
    expect(readInvocations()).toHaveLength(2);
    expect(got.map((i) => i.cwd).sort()).toEqual([on, pausedOver].sort());
    for (const i of got) {
      expect(i.argv).toEqual(["tick"]);
      expect(i.execPath).toBe(process.execPath);                                            // the job's absolute bun
      expect(i.bin).toBe(join(i.cwd, "node_modules", "@zabaca", "croft", "bin", "croft.mjs"));
    }
  });

  test("the child gets an explicit environment: HOME, PATH with the bun dir, LANG, CROFT_HOME, and the test tripwires; nothing else", async () => {
    project("on");
    runTick({ SECRET_TOKEN: "do-not-leak", TMPDIR: tmp, CROFT_JOB_LABEL: home.jobLabel });
    const [i] = await invocations(1);
    expect(i).toBeDefined();
    const env = i!.env;
    expect(env.HOME).toBe(userHome);
    expect(env.PATH!.split(":")[0]).toBe(dirname(process.execPath));
    expect(env.PATH).toContain("/usr/bin");
    expect(env.LANG).toBeTruthy();
    expect(realpathSync(env.CROFT_HOME!)).toBe(realpathSync(home.dir));
    expect(env.CROFT_FORBID_OS_JOBS).toBe("1");
    expect(env.CROFT_NOTIFY_DRY).toBe("1");
    expect(env.CROFT_JOB_LABEL).toBe(home.jobLabel);
    expect(env.TMPDIR).toBe(tmp);
    expect(env.SECRET_TOKEN).toBeUndefined();
    // Bun adds a few of its own to every process; everything else croft chose.
    const own = Object.keys(env).filter((k) => !/^(BUN_|__CF|_$)/.test(k) && k !== "OLDPWD" && k !== "PWD" && k !== "SHLVL");
    expect(own.sort()).toEqual(["CROFT_FORBID_OS_JOBS", "CROFT_HOME", "CROFT_JOB_LABEL", "CROFT_NOTIFY_DRY", "HOME", "LANG", "PATH", "TMPDIR"]);
  });

  test("the child's output goes to the tick log", async () => {
    project("on");
    runTick();
    await invocations(1);
    const deadline = Date.now() + 5000;
    while (!(existsSync(home.tickLog) && readFileSync(home.tickLog, "utf8").includes("stub croft tick")) && Date.now() < deadline) await Bun.sleep(25);
    expect(readFileSync(home.tickLog, "utf8")).toContain("stub croft tick");
  });

  test("a relocated state folder (croft.json stateDir with ~) is where scheduling is read", async () => {
    const root = project("relocated", { stateDir: "~/state/relocated" });
    expect(existsSync(join(userHome, "state", "relocated", "runs.sqlite"))).toBe(true);
    expect(existsSync(join(root, ".croft"))).toBe(false);
    runTick();
    expect((await invocations(1)).map((i) => i.cwd)).toEqual([root]);
  });

  test("the pinned copy's own bin is run (package.json \"bin\")", async () => {
    const root = project("custom-bin", { bin: "dist/cli.mjs" });
    runTick();
    const [i] = await invocations(1);
    expect(i?.bin).toBe(join(root, "node_modules", "@zabaca", "croft", "dist", "cli.mjs"));
  });

  test("a project without its pinned croft is logged with the fix, and nothing is started", async () => {
    const root = project("not-installed", { pinned: false });
    const r = runTick();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(root);
    expect(r.stdout).toContain("bun install");
    await Bun.sleep(200);
    expect(readInvocations()).toEqual([]);
  });

  test("a project listed twice is ticked once", async () => {
    const root = project("twice");
    const entries = JSON.parse(readFileSync(home.registry, "utf8"));
    writeFileSync(home.registry, JSON.stringify([...entries, ...entries]));
    runTick();
    await invocations(1);
    await Bun.sleep(300);
    expect(readInvocations().map((i) => i.cwd)).toEqual([root]);
  });
});

describe("pruning", () => {
  test("drops projects whose folder or croft.json is gone, logs it, and still ticks the rest", async () => {
    const kept = project("kept");
    const moved = project("moved");
    const noConfig = project("no-config");
    rmSync(moved, { recursive: true });
    rmSync(join(noConfig, "croft.json"));
    const r = runTick();
    expect(r.exitCode).toBe(0);
    expect(listProjects(home).map((e) => e.root)).toEqual([kept]);
    expect(r.stdout).toContain(`removed ${moved} from the schedule`);
    expect(r.stdout).toContain(`removed ${noConfig} from the schedule`);
    expect((await invocations(1)).map((i) => i.cwd)).toEqual([kept]);
    expect(existsSync(registryLockPath(home))).toBe(false);
  });

  test("a folder it may not look into is kept and logged (EPERM from macOS privacy protection is not ENOENT)", () => {
    if (process.getuid?.() === 0) return;                  // root reads everything
    const locked = project("locked");
    chmodSync(locked, 0o000);
    try {
      const r = runTick();
      expect(r.exitCode).toBe(0);
      expect(listProjects(home).map((e) => e.root)).toEqual([locked]);
      expect(r.stdout).toContain(locked);
      expect(r.stdout).toMatch(/permission denied|operation not permitted|EACCES|EPERM/i);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test("a registry locked by a live writer is not waited on for long: pruning waits for the next minute", async () => {
    const kept = project("kept");
    rmSync(project("gone"), { recursive: true });
    const lock = registryLockPath(home);
    writeFileSync(lock, `${process.pid}\n`);                 // this test process: alive
    try {
      const t0 = Date.now();
      const r = runTick();
      expect(Date.now() - t0).toBeLessThan(8000);
      expect(r.stdout).toContain("pruning next minute");
      expect(listProjects(home)).toHaveLength(2);
      expect((await invocations(1)).map((i) => i.cwd)).toEqual([kept]);
    } finally {
      rmSync(lock, { force: true });
    }
  });

  test("a corrupt projects.json is logged and left untouched", () => {
    mkdirSync(home.dir, { recursive: true });
    writeFileSync(home.registry, "[{ nope");
    const r = runTick();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(home.registry);
    expect(readFileSync(home.registry, "utf8")).toBe("[{ nope");
  });
});

describe("the tick log", () => {
  test(`is rotated to tick.log.1 past ${MAX_TICK_LOG_BYTES / 1024 / 1024} MB`, () => {
    mkdirSync(home.logDir, { recursive: true });
    writeFileSync(home.tickLog, Buffer.alloc(MAX_TICK_LOG_BYTES + 1, "x"));
    runTick();
    expect(statSync(`${home.tickLog}.1`).size).toBe(MAX_TICK_LOG_BYTES + 1);
    expect(existsSync(home.tickLog) ? statSync(home.tickLog).size : 0).toBeLessThan(1024);
  });
});
