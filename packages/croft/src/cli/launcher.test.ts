import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { binOf, declaresCroft, launch, LAUNCH_ENV, launcherEnv, type LaunchPlan, OUTSIDE_PROJECT, planLaunch, type PlanInput, scanCommand, SELF_ROOT } from "./launcher.ts";
import { CROFT_VERSION } from "./version.ts";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const base = realpathSync(mkdtempSync(join(tmpdir(), "launcher-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;

function dir(files: Record<string, string> = {}): string {
  const d = join(base, `d${n++}`);
  mkdirSync(d, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(d, name)), { recursive: true });
    writeFileSync(join(d, name), text);
  }
  return d;
}

const CONFIG = JSON.stringify({ database: "warehouse.duckdb", timezone: "UTC" });
const PINNING = JSON.stringify({ private: true, dependencies: { "@zabaca/croft": "9.9.9" } });

// The pinned copy in a fake project: it reports how it was started, and exits with FAKE_EXIT (default 7).
const FAKE_BIN = `
const pick = (k) => process.env[k] ?? null;
console.log(JSON.stringify({
  marker: "PINNED-COPY", argv: process.argv.slice(2), cwd: process.cwd(),
  env: Object.fromEntries(["SECRET_X", "LOCAL_Y", "DEV_W", "SHELL_Z", "DUPE", "EXPANDED", "CROFT_CALLER_CWD", "CROFT_LAUNCHER_VERSION", "CROFT_DELEGATED_TO"].map((k) => [k, pick(k)])),
}));
if (process.env.FAKE_SIGNAL) process.kill(process.pid, process.env.FAKE_SIGNAL);
process.exitCode = Number(process.env.FAKE_EXIT ?? 7);
`;

/** A project whose node_modules/@zabaca/croft is a fake copy that prints a marker. */
function fakeProject(extra: Record<string, string> = {}): string {
  return dir({
    "croft.json": CONFIG,
    "package.json": PINNING,
    "assets/.keep": "",
    "node_modules/@zabaca/croft/package.json": JSON.stringify({ name: "@zabaca/croft", version: "9.9.9", bin: { croft: "bin/fake.ts" } }),
    "node_modules/@zabaca/croft/bin/fake.ts": FAKE_BIN,
    ...extra,
  });
}

function input(cwd: string, argv: string[], o: Partial<PlanInput> = {}): PlanInput {
  return { argv, cwd, env: {}, isBun: true, selfRoot: SELF_ROOT, commandNames: ["docs", "help", "version", "init", "doctor", "status", "run"], ...o };
}

describe("scanCommand", () => {
  test("finds the command the way main.ts does", () => {
    expect(scanCommand([])).toEqual({ name: "help", json: false });
    expect(scanCommand(["--json", "status", "x"])).toEqual({ name: "status", json: true });
    expect(scanCommand(["run", "--version"])).toEqual({ name: "version", json: false });
    expect(scanCommand(["--", "--json"])).toEqual({ name: "help", json: false });
  });
});

describe("planLaunch", () => {
  test("NEEDS_BUN when not running under Bun", () => {
    const plan = planLaunch(input(dir(), ["status"], { isBun: false }));
    expect(plan).toMatchObject({ kind: "refuse", exit: 2, problem: { code: "NEEDS_BUN", fix: { command: "curl -fsSL https://bun.sh/install | bash" } } });
  });

  test("outside a project only init, doctor, docs, version and help run", () => {
    const out = dir();
    expect(OUTSIDE_PROJECT).toEqual(["init", "doctor", "docs", "version", "help"]);
    for (const argv of [["init", "x"], ["doctor"], ["docs", "--list"], ["version"], ["--version"], ["help"], []]) {
      expect(planLaunch(input(out, argv)).kind).toBe("local");
    }
    const refused = planLaunch(input(out, ["status", "--json"]));
    expect(refused).toMatchObject({ kind: "refuse", exit: 2, problem: { code: "PROJECT_NOT_FOUND", details: { command: "status" } } });
    expect((refused as Extract<LaunchPlan, { kind: "refuse" }>).problem.message).toStartWith("croft status works inside a croft project; no croft project here");
    // A typo is main.ts's business (did-you-mean), not a missing project.
    expect(planLaunch(input(out, ["stauts"])).kind).toBe("local");
  });

  test("a different pinned copy is delegated to, from the project root", () => {
    const root = fakeProject();
    const plan = planLaunch(input(join(root, "assets"), ["status"]));
    const copy = join(root, "node_modules", "@zabaca", "croft");
    expect(plan).toEqual({ kind: "delegate", root, copy, bin: join(copy, "bin", "fake.ts") });
    // Even the commands that work outside a project use the pinned copy inside one.
    expect(planLaunch(input(root, ["doctor"])).kind).toBe("delegate");
    // No loop: a child already started for this copy runs it.
    expect(planLaunch(input(root, ["status"], { env: { [LAUNCH_ENV.delegatedTo]: copy } })).kind).toBe("local");
  });

  test("the running copy is the pinned one: run here", () => {
    const root = dir({ "croft.json": CONFIG, "package.json": PINNING });
    mkdirSync(join(root, "node_modules", "@zabaca"), { recursive: true });
    symlinkSync(SELF_ROOT, join(root, "node_modules", "@zabaca", "croft"));
    expect(planLaunch(input(root, ["status"])).kind).toBe("local");
  });

  test("a project in data/ of an app is found from the app folder", () => {
    const app = dir({ "package.json": "{}" });
    const root = join(app, "data");
    mkdirSync(root);
    const fake = fakeProject();
    for (const f of ["croft.json", "package.json", "node_modules"]) symlinkSync(join(fake, f), join(root, f));
    const plan = planLaunch(input(app, ["status"]));
    expect(plan).toMatchObject({ kind: "delegate", root });
  });

  test("no pinned copy", () => {
    // Nothing pinned (no package.json dependency): this copy runs.
    expect(planLaunch(input(dir({ "croft.json": CONFIG }), ["status"])).kind).toBe("local");
    // Pinned, node_modules missing (a fresh clone): install first, except for diagnostics and typos.
    const clone = dir({ "croft.json": CONFIG, "package.json": PINNING });
    expect(planLaunch(input(clone, ["status"]))).toEqual({ kind: "install", root: clone });
    for (const argv of [["doctor"], ["docs"], ["init", "--claude"], ["stauts"]]) expect(planLaunch(input(clone, argv)).kind).toBe("local");
    // Pinned, but node_modules exists without croft, or the install failed: refuse, do not retry.
    const partial = dir({ "croft.json": CONFIG, "package.json": PINNING, "node_modules/.keep": "" });
    const refused = planLaunch(input(partial, ["run"]));
    expect(refused).toMatchObject({ kind: "refuse", exit: 2, problem: { code: "DUCKDB_BINDING_MISSING", fix: { command: `cd ${partial} && bun install` } } });
    const failed = planLaunch(input(clone, ["run"], { installFailed: { exit: 1 } }));
    expect(failed).toMatchObject({ kind: "refuse", problem: { code: "DUCKDB_BINDING_MISSING" } });
    expect((failed as Extract<LaunchPlan, { kind: "refuse" }>).problem.message).toContain("bun install exited with 1");
  });

  test("helpers: binOf and declaresCroft", () => {
    const copy = dir({ "package.json": JSON.stringify({ bin: "cli.ts" }) });
    expect(binOf(copy)).toBe(join(copy, "cli.ts"));
    expect(binOf(dir({ "package.json": "{}" }))).toMatch(/src\/cli\/main\.ts$/);
    expect(declaresCroft(dir({ "package.json": JSON.stringify({ devDependencies: { "@zabaca/croft": "1.0.0" } }) }))).toBe(true);
    expect(declaresCroft(dir({ "package.json": "not json" }))).toBe(false);
  });
});

describe("launch", () => {
  const names = ["docs", "help", "version", "init", "doctor", "status", "run"];

  test("a refusal prints one envelope with --json, or a problem on stderr", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const exit = await launch({ main: async () => 0, commandNames: names, argv: ["status", "--json"], cwd: dir(), env: {}, stdout: (t) => out.push(t), stderr: (t) => err.push(t) });
    expect(exit).toBe(2);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    const env = JSON.parse(out[0]!);
    expect(env).toMatchObject({ schemaVersion: 1, ok: false, command: "status", croftVersion: CROFT_VERSION, database: "", data: null });
    expect(env.problems[0].code).toBe("PROJECT_NOT_FOUND");

    const human: string[] = [];
    await launch({ main: async () => 0, commandNames: names, argv: ["status"], cwd: dir(), env: {}, isBun: false, stdout: () => {}, stderr: (t) => human.push(t) });
    expect(human.join("")).toStartWith("error NEEDS_BUN  croft runs on Bun, not Node or another runtime\n");
  });

  test("local plans run main with the same argv", async () => {
    const seen: (readonly string[])[] = [];
    const exit = await launch({ main: async (argv) => { seen.push(argv); return 3; }, commandNames: names, argv: ["docs", "x"], cwd: dir(), env: {} });
    expect(exit).toBe(3);
    expect(seen).toEqual([["docs", "x"]]);
  });

  test("when Bun loaded .env into this process, this copy is started again without it", async () => {
    const cwd = dir({ ".env": "SECRET_X=from-dotenv\n" });
    const delegated: { plan: LaunchPlan; argv: readonly string[]; env: Record<string, string> }[] = [];
    let ranHere = false;
    const exit = await launch({
      main: async () => { ranHere = true; return 0; }, commandNames: names, argv: ["docs"], cwd,
      env: { PATH: "/bin", SECRET_X: "from-dotenv" }, delegate: async (plan, argv, env) => { delegated.push({ plan, argv, env }); return 4; },
    });
    expect(exit).toBe(4);
    expect(ranHere).toBe(false);
    const self = realpathSync(SELF_ROOT);
    expect(delegated[0]!.plan).toEqual({ kind: "delegate", root: cwd, copy: self, bin: join(self, "src", "cli", "main.ts") });
    expect(delegated[0]!.env).toEqual({ PATH: "/bin", CROFT_DELEGATED_TO: self });

    // In that child (or when the shell holds the same value) the keys are only dropped from the environment.
    const env: Record<string, string | undefined> = { SECRET_X: "from-dotenv", CROFT_DELEGATED_TO: self };
    const again = await launch({ main: async () => 0, commandNames: names, argv: ["docs"], cwd, env, delegate: async () => 9 });
    expect(again).toBe(0);
    expect(env).toEqual({ CROFT_DELEGATED_TO: self });
  });

  test("a fresh clone installs, then delegates with the launcher's variables", async () => {
    const root = dir({ "croft.json": CONFIG, "package.json": PINNING });
    const fake = fakeProject();
    const installs: string[] = [];
    const delegated: { plan: LaunchPlan; argv: readonly string[]; env: Record<string, string> }[] = [];
    const err: string[] = [];
    const exit = await launch({
      main: async () => 99, commandNames: names, argv: ["run", "x"], cwd: root, env: { PATH: "/bin", HOME: "/h" },
      stderr: (t) => err.push(t),
      install: (r) => { installs.push(r); symlinkSync(join(fake, "node_modules"), join(r, "node_modules")); return 0; },
      delegate: async (plan, argv, env) => { delegated.push({ plan, argv, env }); return 5; },
    });
    expect(exit).toBe(5);
    expect(installs).toEqual([root]);
    expect(err.join("")).toContain("installing this project's dependencies first");
    expect(delegated[0]!.argv).toEqual(["run", "x"]);
    expect(delegated[0]!.env).toEqual({
      PATH: "/bin", HOME: "/h",
      CROFT_DELEGATED_TO: join(fake, "node_modules", "@zabaca", "croft"), CROFT_LAUNCHER_VERSION: CROFT_VERSION, CROFT_CALLER_CWD: root,
    });
  });

  test("a failed install refuses writers and does not loop", async () => {
    const root = dir({ "croft.json": CONFIG, "package.json": PINNING });
    let installs = 0;
    const out: string[] = [];
    const exit = await launch({
      main: async () => 0, commandNames: names, argv: ["run", "--json"], cwd: root, env: {},
      stdout: (t) => out.push(t), stderr: () => {}, install: () => { installs++; return 1; },
    });
    expect(installs).toBe(1);
    expect(exit).toBe(2);
    expect(JSON.parse(out[0]!).problems[0].code).toBe("DUCKDB_BINDING_MISSING");
  });
});

describe("launcherEnv", () => {
  test("drops what Bun loaded from .env files in the folder, keeps the shell's", () => {
    const cwd = dir({
      ".env": "SECRET_X=from-dotenv\nDUPE=file\nEXPANDED=$HOME/x\n",
      ".env.local": "LOCAL_Y=local\n",
      ".env.development": "DEV_W=dev\n",
      ".env.production": "PROD_V=prod\n",
    });
    const env = { PATH: "/bin", SECRET_X: "from-dotenv", DUPE: "shell", EXPANDED: "/home/me/x", LOCAL_Y: "local", DEV_W: "dev", PROD_V: "prod", HOME: "/home/me" };
    expect(launcherEnv(env, cwd)).toEqual({ PATH: "/bin", DUPE: "shell", PROD_V: "prod", HOME: "/home/me" });
    // NODE_ENV picks the file Bun would have read; NODE_ENV=test skips .env.local.
    expect(launcherEnv({ ...env, NODE_ENV: "production" }, cwd)).toEqual({ PATH: "/bin", DUPE: "shell", DEV_W: "dev", HOME: "/home/me", NODE_ENV: "production" });
    expect(launcherEnv({ LOCAL_Y: "local", NODE_ENV: "test" }, cwd)).toEqual({ LOCAL_Y: "local", NODE_ENV: "test" });
    expect(launcherEnv({ A: "1", B: undefined }, dir())).toEqual({ A: "1" });
  });
});

test("the launcher, init and doctor load without DuckDB, so a broken binding cannot stop them", () => {
  const files = ["./launcher.ts", "./commands/init.ts", "./commands/doctor.ts"].map((f) => fileURLToPath(new URL(f, import.meta.url)));
  const script = `for (const f of ${JSON.stringify(files)}) await import(f);
    const keys = Object.keys(require.cache);
    console.log(JSON.stringify({ modules: keys.length, duckdb: keys.filter((k) => k.includes("@duckdb")) }));`;
  const r = Bun.spawnSync([process.execPath, "--no-env-file", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const seen = JSON.parse(r.stdout.toString());
  expect(seen.modules).toBeGreaterThan(10);                            // require.cache does list ES modules
  expect(seen.duckdb).toEqual([]);
});

describe("the real bin delegates to the project's pinned copy", () => {
  function croftBin(args: string[], cwd: string, env: Record<string, string> = {}) {
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("CROFT_")) base[k] = v;
    // Started like the global shim (`#!/usr/bin/env bun`): without --no-env-file, so Bun loads cwd/.env.
    const r = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd, env: { ...base, ...env }, stdout: "pipe", stderr: "pipe" });
    const line = r.stdout.toString().split("\n").find((l) => l.includes("PINNED-COPY"));
    return { exit: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString(), marker: line ? JSON.parse(line) : null };
  }

  test("args, exit code and the project root as working folder are forwarded", () => {
    const root = fakeProject();
    const r = croftBin(["status", "--json", "two words", "--", "--x"], join(root, "assets"));
    expect(r.stderr).toBe("");
    expect(r.exit).toBe(7);
    expect(r.marker).toMatchObject({
      marker: "PINNED-COPY", argv: ["status", "--json", "two words", "--", "--x"], cwd: root,
      env: { CROFT_CALLER_CWD: join(root, "assets"), CROFT_LAUNCHER_VERSION: CROFT_VERSION, CROFT_DELEGATED_TO: join(root, "node_modules", "@zabaca", "croft") },
    });
  });

  test("the pinned copy runs with --no-env-file and without what Bun loaded into the launcher", () => {
    const root = fakeProject({ ".env": "SECRET_X=from-dotenv\nDUPE=file\n", ".env.local": "LOCAL_Y=local\n" });
    const r = croftBin(["run"], root, { SHELL_Z: "kept", DUPE: "shell" });
    expect(r.exit).toBe(7);
    expect(r.marker.env).toMatchObject({ SECRET_X: null, LOCAL_Y: null, SHELL_Z: "kept", DUPE: "shell" });
  });

  test("a child killed by a signal exits 128 + n; exit 0 passes through", () => {
    const root = fakeProject();
    expect(croftBin(["run"], root, { FAKE_SIGNAL: "SIGTERM" }).exit).toBe(143);
    expect(croftBin(["run"], root, { FAKE_EXIT: "0" }).exit).toBe(0);
  });

  test("outside a project the bin runs its own commands", () => {
    const r = croftBin(["--version"], dir());
    expect(r).toMatchObject({ exit: 0, stdout: `croft ${CROFT_VERSION}\n` });
    // With a .env in the folder, Bun loads it into the launcher; the rerun without it still answers.
    const withEnv = croftBin(["--version"], dir({ ".env": "SECRET_X=from-dotenv\n" }));
    expect(withEnv).toMatchObject({ exit: 0, stdout: `croft ${CROFT_VERSION}\n`, stderr: "" });
  });

  test("a pinned but uninstalled project still runs doctor locally, without installing", () => {
    const root = dir({ "croft.json": CONFIG, "package.json": PINNING });
    const r = croftBin(["doctor", "--json"], root);
    expect(r.stderr).not.toContain("installing");
    const env = JSON.parse(r.stdout);
    expect(env.command).toBe("doctor");
    expect(env.data.checks.find((c: { id: string }) => c.id === "croft").text).toContain("pinned croft is not installed");
  });
});
