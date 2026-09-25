// croft schedule on|off|status|pause (DESIGN.md §4.1, §4.2, §8 "Turning it on"). Nothing here touches the machine:
// every test uses a fake OsRunner (recording argv; its `launchctl bootstrap` plays the job's first tick by writing a
// heartbeat), a fake HOME with CROFT_HOME under it, a unique CROFT_JOB_LABEL, CROFT_NOW, a heartbeat wait of a
// fraction of a second, and a fake scheduler view (schedule/due.ts is another builder's).
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { CroftError } from "../../core/errors.ts";
import { RunsDb } from "../../history/runs-db.ts";
import { cleanup as cleanupChildren, writeServeJson } from "../../read/testkit.ts";
import type { AssetScheduleView } from "../../schedule/due.ts";
import { croftHome, type CroftHome } from "../../schedule/home.ts";
import type { ExecResult, OsRunner } from "../../schedule/os.ts";
import { plistPath } from "../../schedule/register.ts";
import { addProject, listProjects } from "../../schedule/registry.ts";
import type { Command } from "../command.ts";
import { COMMANDS } from "./index.ts";
import { cleanup, cli, makeProject, type TestProject } from "./inspect-testkit.ts";
import {
  agoText, clockText, fireText, guardRealHome, homeShort, parseFor, passwdHome, readScheduling, runSchedule, schedule, type ScheduleDeps,
  schedulingJson, SINCE_KEY, spanText, staleProblem,
} from "./schedule.ts";

afterAll(async () => {
  cleanupChildren();
  await cleanup();
});

// 10:05 in Los Angeles: the hourly ingest fires next at 11:00, in 55 minutes.
const NOW = "2026-09-24T17:05:00.000Z";
const LA = "America/Los_Angeles";

let tmp: string;
let userHome: string;
let home: CroftHome;
let label: string;
let env: Record<string, string>;
let p: TestProject;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "croft-schedule-")));
  userHome = join(tmp, "Users", "ada");
  mkdirSync(userHome, { recursive: true });
  label = `dev.croft.test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  env = { HOME: userHome, CROFT_HOME: join(userHome, ".croft"), CROFT_JOB_LABEL: label, CROFT_NOW: NOW };
  home = croftHome(env);
  p = makeProject({ timezone: LA });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const BUN = () => join(userHome, ".bun", "bin", "bun");

/** The scheduler's view of a small project: two scheduled ingests, one manual, a held transform and a due one. */
const VIEW: AssetScheduleView[] = [
  { asset: "github_issues", kind: "ingest", schedule: { text: "every hour", cron: "0 * * * *" }, nextFireAt: "2026-09-24T18:00:00.000Z",
    lastFireAt: "2026-09-24T17:00:00.000Z", lastAttemptAt: "2026-09-24T17:00:04.000Z", due: false, dueReason: null, held: null },
  { asset: "taxi_zones", kind: "ingest", schedule: { text: "monthly", cron: "0 0 1 * *" }, nextFireAt: "2026-10-01T07:00:00.000Z",
    lastFireAt: null, lastAttemptAt: null, due: false, dueReason: null, held: null },
  { asset: "sales", kind: "ingest", schedule: null, nextFireAt: null, lastFireAt: null, lastAttemptAt: null, due: false, dueReason: null, held: null },
  { asset: "issue_triage", kind: "ts", schedule: null, nextFireAt: null, lastFireAt: null, lastAttemptAt: null, due: true,
    dueReason: "stale: input github_issues changed", held: { code: "SCHEDULE_HELD", reason: "new asset, not run by hand yet" } },
  { asset: "open_issues", kind: "sql", schedule: null, nextFireAt: null, lastFireAt: null, lastAttemptAt: null, due: true,
    dueReason: "stale: input github_issues changed", held: null },
];

/** What `croft tick` records: a heartbeat in the project's runs.sqlite. */
function beat(at: string, stateDir = p.stateDir): void {
  const db = RunsDb.open(stateDir);
  db.heartbeat(at);
  db.close();
}

/** Records every command. `launchctl bootstrap` succeeds and, with `tick`, plays the job's first run (RunAtLoad). */
function fakeRunner(o: { tick?: boolean; respond?: (argv: string[]) => Partial<ExecResult> | undefined } = {}) {
  const calls: string[][] = [];
  const runner: OsRunner = {
    exec(argv) {
      calls.push([...argv]);
      const r = o.respond?.([...argv]);
      if (r) return { status: 0, stdout: "", stderr: "", ...r };
      if (argv[1] === "bootstrap" && o.tick) beat(NOW);
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  return { runner, calls };
}

function deps(o: Partial<ScheduleDeps> & { tick?: boolean; respond?: (argv: string[]) => Partial<ExecResult> | undefined } = {}) {
  const { tick, respond, ...rest } = o;
  const fake = fakeRunner({ ...(tick ? { tick } : {}), ...(respond ? { respond } : {}) });
  const d: ScheduleDeps = {
    runner: fake.runner, home,
    job: { platform: "darwin", uid: 501, execPath: BUN(), exists: (x) => x === BUN(), sleep: () => {} },
    scheduleView: async () => VIEW, heartbeatWaitMs: 60, pollMs: 10, ...rest,
  };
  return { deps: d, calls: fake.calls };
}

/** The registered schedule command, running runSchedule with test deps. */
function command(d: ScheduleDeps): Command {
  const spec = COMMANDS.find((c) => c.name === "schedule")!;
  const { load: _load, ...rest } = spec;
  return { ...rest, run: (ctx) => runSchedule(ctx, d), human: schedule.human!.bind(schedule) };
}

function sched(argv: string[], d: ScheduleDeps, o: { env?: Record<string, string>; tty?: boolean } = {}) {
  return cli(["schedule", ...argv], {
    cwd: p.root, env: o.env ?? env, commands: [command(d)], ...(o.tty ? { stdoutTTY: true, stderrTTY: true } : {}),
  });
}

function setting(stateDir = p.stateDir) {
  const db = RunsDb.open(stateDir);
  try {
    return { scheduling: db.getSetting("scheduling"), since: db.getSetting(SINCE_KEY) };
  } finally {
    db.close();
  }
}

describe("croft schedule on", () => {
  test("records it on, registers the project, installs the job, waits for the first tick, and lists the schedule", async () => {
    const { deps: d, calls } = deps({ tick: true });
    const r = await sched(["on", "--json"], d);
    expect(r.exit).toBe(0);
    expect(r.json).toMatchObject({ ok: true, command: "schedule" });
    const data = r.json.data;
    expect(data.action).toBe("on");
    expect(data.root).toBe(p.root);
    expect(data.scheduling).toEqual({ state: "on", via: "os-job", lastTickAt: "2026-09-24T10:05:00-07:00", stale: false });
    expect(data.firstTick).toMatchObject({ ok: true, at: "2026-09-24T10:05:00-07:00" });
    expect(data.job).toEqual({
      kind: "launchd", label, file: plistPath(home), installed: true, loaded: true, bun: BUN(), bunVersion: Bun.version, bunExists: true,
      bunStable: true, bunSkipped: [], changed: true,
    });
    expect(existsSync(plistPath(home))).toBe(true);
    expect(existsSync(home.tickScript)).toBe(true);
    expect(calls).toContainEqual(["/bin/launchctl", "bootstrap", "gui/501", plistPath(home)]);
    expect(listProjects(home)).toEqual([{ root: p.root, addedAt: NOW, via: "os-job" }]);
    expect(data.registry).toEqual({ file: home.registry, projects: 1, osJob: 1 });
    expect(setting()).toEqual({ scheduling: { state: "on", via: "os-job" }, since: NOW });

    // Every scheduled ingest, and the held asset; not the manual ingest or the due transform.
    expect(data.assets.map((a: { asset: string }) => a.asset)).toEqual(["github_issues", "taxi_zones", "issue_triage"]);
    expect(data.assets[0]).toEqual({
      asset: "github_issues", kind: "ingest", schedule: "every hour", cron: "0 * * * *", nextFireAt: "2026-09-24T11:00:00-07:00",
      lastFireAt: "2026-09-24T10:00:00-07:00", lastAttemptAt: "2026-09-24T10:00:04-07:00", due: false, dueReason: null, held: null,
    });
    // A new asset waits for its first run by hand: said as SCHEDULE_HELD, with the run that releases it.
    expect(r.json.problems).toHaveLength(1);
    expect(r.json.problems[0]).toMatchObject({
      severity: "warning", code: "SCHEDULE_HELD", asset: "issue_triage",
      message: "issue_triage is held from the scheduler: new asset, not run by hand yet",
      fix: { kind: "command", command: "croft run issue_triage" },
    });
    expect(r.json.next).toEqual([{ command: "croft run issue_triage", reason: "releases it for the scheduler (new asset, not run by hand yet)" }]);
  });

  test("human output (§4.2)", async () => {
    const r = await sched(["on"], deps({ tick: true }).deps);
    expect(r.exit).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines.slice(0, 8)).toEqual([
      `Scheduling is on for ${p.root} (one job per user; checked every minute; survives restarts).`,
      `The job runs Bun ${Bun.version} from ~/.bun/bin/bun.`,
      "Waiting for the first tick… ok (after 0 s)",
      "  github_issues   every hour   0 * * * *   next 11:00",
      "  taxi_zones      monthly      0 0 1 * *   next Oct 1 00:00",
      "Held until run by hand (the scheduler only runs code a human has run; new assets wait for their first run):",
      "  issue_triage  new asset, not run by hand yet → croft run issue_triage",
      "Turn off: croft schedule off",
    ]);
    expect(r.stdout).toContain("warn  SCHEDULE_HELD  issue_triage");
    expect(r.stdout).toContain("next: croft run issue_triage");
    expect(r.stderr).toBe("");
  });

  test("the job's Bun and its version; a stable Bun passed over for being too old is a note", async () => {
    const brew = "/opt/homebrew/bin/bun";
    const job = {
      platform: "darwin" as const, uid: 501, execPath: brew, runningVersion: "1.3.14", sleep: () => {},
      exists: (x: string) => x === BUN() || x === brew, bunVersion: (x: string) => (x === BUN() ? "1.0.0" : null),
    };
    const r = await sched(["on", "--json"], deps({ tick: true, job }).deps);
    expect(r.json.data.job).toMatchObject({ bun: brew, bunVersion: "1.3.14", bunStable: true, bunSkipped: [{ path: BUN(), version: "1.0.0" }] });
    const human = await sched(["on"], deps({ tick: true, job }).deps);
    expect(human.stdout.split("\n").slice(0, 3)).toEqual([
      `Scheduling is on for ${p.root} (one job per user; checked every minute; survives restarts).`,
      "The job runs Bun 1.3.14 from /opt/homebrew/bin/bun.",
      "note: ~/.bun/bin/bun is Bun 1.0.0, older than croft needs (1.3.14), so the job does not run it",
    ]);
    // Newer than croft needs but older than the Bun running croft; one that does not run at all.
    const newer = { ...job, runningVersion: "1.4.2", bunVersion: (x: string) => (x === BUN() ? "1.3.14" : null) };
    const older = await sched(["on"], deps({ tick: true, job: newer }).deps);
    expect(older.stdout.split("\n")[2]).toBe("note: ~/.bun/bin/bun is Bun 1.3.14, older than the Bun running croft (1.4.2), so the job does not run it");
    const broken = await sched(["on"], deps({ tick: true, job: { ...job, bunVersion: () => null } }).deps);
    expect(broken.stdout.split("\n")[2]).toBe("note: ~/.bun/bin/bun does not run (it printed no version), so the job does not run it");
  });

  test("a project under the home folder is shown as ~/…", () => {
    expect(homeShort("/Users/ada/my-data", "/Users/ada")).toBe("~/my-data");
    expect(homeShort("/Users/ada", "/Users/ada")).toBe("~");
    expect(homeShort("/srv/data", "/Users/ada")).toBe("/srv/data");
  });

  test("with no scheduled ingest, it says how to add a schedule", async () => {
    const r = await sched(["on", "--json"], deps({ tick: true, scheduleView: async () => VIEW.filter((v) => !v.schedule && !v.held) }).deps);
    expect(r.json.data.assets).toEqual([]);
    expect(r.json.next).toEqual([{ command: "croft docs ingest", reason: "no ingest has a schedule yet: add schedule: \"every hour\" (or daily at 06:00, …) to one" }]);
    const human = await sched(["on"], deps({ tick: true, scheduleView: async () => [] }).deps);
    expect(human.stdout).toContain("  no ingest has a schedule yet (add schedule: \"every hour\" to one; croft docs ingest)");
  });

  test("no tick within the wait: SCHEDULER_STALE with the likely cause and the tail of tick.log; scheduling stays on", async () => {
    mkdirSync(home.logDir, { recursive: true });
    writeFileSync(home.tickLog, [
      "2026-09-24T17:05:01.000Z tick: 1 project",
      `2026-09-24T17:05:01.000Z ${userHome}/Documents/my-data: EPERM: operation not permitted, open '${userHome}/Documents/my-data/croft.json'`,
      "",
    ].join("\n"));
    const r = await sched(["on", "--json"], deps().deps);
    expect(r.exit).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.data.scheduling).toMatchObject({ state: "on", via: "os-job", lastTickAt: null, stale: false });
    expect(r.json.data.firstTick).toMatchObject({ ok: false, at: null });
    const stale = r.json.problems.find((x: { code: string }) => x.code === "SCHEDULER_STALE");
    expect(stale).toMatchObject({
      severity: "warning",
      fix: { kind: "manual", requiresHuman: true },
      details: { cause: "privacy", via: "os-job", lastTickAt: null, logFile: home.tickLog },
    });
    expect(stale.message).toMatch(/^no scheduler tick arrived within \d+ s of turning scheduling on: macOS privacy protection stops the scheduler job from reading a project in ~\/Documents/);
    expect(stale.hint).toContain("Full Disk Access");
    expect(stale.details.logTail).toContain("operation not permitted");
    expect(setting().scheduling).toEqual({ state: "on", via: "os-job" });

    const human = await sched(["on"], deps().deps);
    expect(human.stdout).toMatch(/Waiting for the first tick… none after \d+ s \(see the warning below\)\n/);
    expect(human.stdout).toContain(`  ${home.tickLog}, last lines:\n    2026-09-24T17:05:01.000Z tick: 1 project\n`);
    expect(human.stdout).toContain("warn  SCHEDULER_STALE  no scheduler tick arrived within");
  });

  test("CROFT_HEARTBEAT_WAIT_MS shortens the wait (the tests' knob)", async () => {
    const { heartbeatWaitMs: _w, ...d } = deps().deps;
    const t0 = Date.now();
    const r = await sched(["on", "--json"], d, { env: { ...env, CROFT_HEARTBEAT_WAIT_MS: "30" } });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.json.data.firstTick.ok).toBe(false);
  });

  test("on a TTY it says it is waiting (on stderr); off a TTY it does not", async () => {
    const tty = await sched(["on"], deps({ tick: true }).deps, { tty: true });
    expect(tty.stderr).toContain("Waiting for the first tick (the job runs every minute; up to 0 s)…");
    const plain = await sched(["on"], deps({ tick: true }).deps);
    expect(plain.stderr).toBe("");
  });

  test("already on and ticking: the job is left as it is and nothing is waited for", async () => {
    await sched(["on", "--json"], deps({ tick: true }).deps);
    const { deps: d, calls } = deps();
    const r = await sched(["on", "--json"], d);
    expect(r.json.data.firstTick).toEqual({ ok: true, at: "2026-09-24T10:05:00-07:00", waitedMs: 0, alreadyTicking: true });
    expect(r.json.data.job.changed).toBe(false);
    expect(calls.some((c) => c[1] === "bootstrap")).toBe(false);
    expect(r.json.problems.map((x: { code: string }) => x.code)).toEqual(["SCHEDULE_HELD"]);
    const human = await sched(["on"], deps().deps);
    expect(human.stdout.split("\n")[2]).toBe("Already ticking: last tick 0 s ago.");
    // Turning it on again keeps the time it was turned on.
    expect(setting().since).toBe(NOW);
  });

  test("--no-os-job: no job and no wait; croft serve must run", async () => {
    const { deps: d, calls } = deps();
    const r = await sched(["on", "--no-os-job", "--json"], d);
    expect(r.exit).toBe(0);
    expect(calls).toEqual([]);
    expect(existsSync(plistPath(home))).toBe(false);
    expect(r.json.data).toMatchObject({ scheduling: { state: "on", via: "serve", stale: false }, job: null, firstTick: null, serve: null });
    expect(listProjects(home)).toEqual([{ root: p.root, addedAt: NOW, via: "serve" }]);
    const human = await sched(["on", "--no-os-job"], deps().deps);
    expect(human.stdout.split("\n").slice(0, 2)).toEqual([
      `Scheduling is on for ${p.root}, ticked by croft serve only (no OS job): nothing runs on a schedule while croft serve is stopped.`,
      "croft serve is not running: start it in a terminal and keep it running (it ticks every minute).",
    ]);
    writeServeJson(p.stateDir, { url: "http://127.0.0.1:7447", pid: process.pid });
    const serving = await sched(["on", "--no-os-job"], deps().deps);
    expect(serving.stdout).toContain(`croft serve (pid ${process.pid}) is running and ticks every minute.`);
  });

  test("switching to --no-os-job removes the job that only this project used", async () => {
    await sched(["on"], deps({ tick: true }).deps);
    expect(existsSync(plistPath(home))).toBe(true);
    const { deps: d, calls } = deps();
    const r = await sched(["on", "--no-os-job", "--json"], d);
    expect(calls).toContainEqual(["/bin/launchctl", "bootout", `gui/501/${label}`]);
    expect(existsSync(plistPath(home))).toBe(false);
    expect(r.json.data.job).toMatchObject({ installed: false, removed: true });
    expect(r.json.data.scheduling.via).toBe("serve");
    await sched(["on"], deps({ tick: true }).deps);
    const human = await sched(["on", "--no-os-job"], deps().deps);
    expect(human.stdout.split("\n")[2]).toBe("Removed the per-user OS job (no other project uses it).");
  });

  test("a job that cannot be installed leaves scheduling and the registry as they were", async () => {
    const fail = (argv: string[]) => (argv[1] === "bootstrap" ? { status: 5, stderr: "Bootstrap failed: 5: Input/output error" } : undefined);
    const r = await sched(["on", "--json"], deps({ respond: fail }).deps);
    expect(r.exit).toBe(2);
    expect(r.json.problems[0]).toMatchObject({ code: "INSTALL_FAILED" });
    expect(r.json.problems[0].hint).toContain("croft schedule on --no-os-job");
    expect(setting()).toEqual({ scheduling: { state: "off", via: null }, since: null });
    expect(listProjects(home)).toEqual([]);
    expect(readScheduling(p.stateDir, new Date(NOW)).state).toBe("off");
  });

  test("a job that cannot be installed while on through croft serve keeps that", async () => {
    await sched(["on", "--no-os-job"], deps().deps);
    const fail = (argv: string[]) => (argv[1] === "bootstrap" ? { status: 1, stderr: "Bootstrap failed: 1: Operation not permitted" } : undefined);
    const r = await sched(["on", "--json"], deps({ respond: fail }).deps);
    expect(r.exit).toBe(2);
    expect(setting()).toEqual({ scheduling: { state: "on", via: "serve" }, since: NOW });
    expect(listProjects(home)).toEqual([{ root: p.root, addedAt: NOW, via: "serve" }]);
  });

  test("under CROFT_FORBID_OS_JOBS, the real user's croft folder is refused before anything is written", () => {
    const real = passwdHome();
    expect(() => guardRealHome(croftHome({ HOME: real }), {})).toThrow(CroftError);
    expect(() => guardRealHome(croftHome({ HOME: userHome, CROFT_HOME: join(real, ".croft") }), {})).toThrow(/refusing to change the scheduler of the real user/);
    expect(() => guardRealHome(home, {})).not.toThrow();
  });

  test("a croft process whose HOME is a temp folder is not taken for the real user (Bun's os.userInfo() answers $HOME)", () => {
    const script = `const { guardRealHome } = await import(${JSON.stringify(new URL("./schedule.ts", import.meta.url).href)});
const { croftHome } = await import(${JSON.stringify(new URL("../../schedule/home.ts", import.meta.url).href)});
guardRealHome(croftHome(process.env), process.env);
process.stdout.write("allowed");`;
    const r = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: userHome, CROFT_HOME: home.dir, CROFT_FORBID_OS_JOBS: "1" },
    });
    expect(`${r.stdout}${r.stderr}`).toBe("allowed");
  });
});

describe("croft schedule off", () => {
  test("records it off, unregisters the project, and removes the job no other project uses", async () => {
    await sched(["on"], deps({ tick: true }).deps);
    const { deps: d, calls } = deps();
    const r = await sched(["off", "--json"], d);
    expect(r.exit).toBe(0);
    expect(r.json.problems).toEqual([]);
    expect(r.json.data).toMatchObject({
      action: "off", scheduling: { state: "off", via: null }, registry: { projects: 0, osJob: 0 },
      job: { kind: "launchd", label, installed: false, removed: true }, assets: [],
    });
    expect(calls).toContainEqual(["/bin/launchctl", "bootout", `gui/501/${label}`]);
    expect(existsSync(plistPath(home))).toBe(false);
    expect(listProjects(home)).toEqual([]);
    expect(setting().scheduling).toEqual({ state: "off", via: null });

    await sched(["on"], deps({ tick: true }).deps);
    const human = await sched(["off"], deps().deps);
    expect(human.stdout.split("\n").slice(0, 2)).toEqual([
      `Scheduling is off for ${p.root}: nothing runs on a schedule until croft schedule on.`,
      "Removed the per-user OS job (no other project uses it).",
    ]);
  });

  test("the job stays while another project uses it", async () => {
    await sched(["on"], deps({ tick: true }).deps);
    const other = makeProject();
    addProject(home, { root: other.root, via: "os-job" });
    const { deps: d, calls } = deps();
    const r = await sched(["off", "--json"], d);
    expect(r.json.data).toMatchObject({ job: null, registry: { projects: 1, osJob: 1 } });
    expect(calls.some((c) => c[1] === "bootout")).toBe(false);
    expect(existsSync(plistPath(home))).toBe(true);
    await sched(["on"], deps({ tick: true }).deps);
    const human = await sched(["off"], deps().deps);
    expect(human.stdout).toContain("The per-user OS job stays: it ticks 1 other project.");
  });

  test("a registered project whose folder is gone does not keep the job", async () => {
    await sched(["on"], deps({ tick: true }).deps);
    addProject(home, { root: join(tmp, "moved-away"), via: "os-job" });
    const r = await sched(["off", "--json"], deps().deps);
    expect(r.json.data.job).toMatchObject({ removed: true });
    expect(listProjects(home)).toEqual([]);
  });

  test("a job that cannot be removed is a warning; scheduling is off anyway", async () => {
    await sched(["on"], deps({ tick: true }).deps);
    const r = await sched(["off", "--json"], deps({ job: { platform: "linux", uid: 1000, sleep: () => {} }, respond: (argv) => (argv[0] === "crontab" ? { status: 1, stderr: "crontab: permission denied" } : undefined) }).deps);
    expect(r.exit).toBe(0);
    expect(r.json.problems).toHaveLength(1);
    expect(r.json.problems[0]).toMatchObject({ code: "INSTALL_FAILED", severity: "warning", effect: "scheduling is off for this project: its ticks exit at once" });
    expect(setting().scheduling).toEqual({ state: "off", via: null });
  });

  test("off when it never was on: nothing to remove, and no complaint", async () => {
    const r = await sched(["off", "--json"], deps({ respond: () => ({ status: 113, stderr: "Could not find service" }) }).deps);
    expect(r.exit).toBe(0);
    expect(r.json.problems).toEqual([]);
    expect(r.json.data.job).toMatchObject({ removed: false });
  });
});

describe("croft schedule pause", () => {
  test("--for: paused until then; ticks resume on their own after it", async () => {
    await sched(["on", "--no-os-job"], deps().deps);
    const r = await sched(["pause", "--for", "2h", "--json"], deps().deps);
    expect(r.exit).toBe(0);
    expect(r.json.data.scheduling).toEqual({ state: "paused", via: "serve", lastTickAt: null, pausedUntil: "2026-09-24T12:05:00-07:00" });
    expect(r.json.next).toEqual([{ command: "croft schedule on --no-os-job", reason: "resume scheduled runs now" }]);
    expect(setting().scheduling).toEqual({ state: "paused", via: "serve", pausedUntil: "2026-09-24T19:05:00.000Z" });
    // After the pause it reads as on; a tick is due within a minute of its end, so it is not stale yet.
    expect(readScheduling(p.stateDir, new Date("2026-09-24T19:06:00Z"))).toMatchObject({ state: "on", stale: false });
    expect(readScheduling(p.stateDir, new Date("2026-09-24T19:09:00Z"))).toMatchObject({ state: "on", stale: true });
    const human = await sched(["pause", "--for", "30m"], deps().deps);
    expect(human.stdout.split("\n")[0]).toBe(`Scheduling is paused for ${p.root} until 10:35 (in 30 min); croft schedule on --no-os-job resumes it now.`);
  });

  test("without --for: until croft schedule on, which resumes it", async () => {
    await sched(["on"], deps({ tick: true }).deps);
    const r = await sched(["pause", "--json"], deps().deps);
    expect(r.json.data.scheduling).toEqual({ state: "paused", via: "os-job", lastTickAt: "2026-09-24T10:05:00-07:00", pausedUntil: null });
    const human = await sched(["pause"], deps().deps);
    expect(human.stdout.split("\n")[0]).toBe(`Scheduling is paused for ${p.root} until croft schedule on; croft schedule on resumes it now.`);
    const on = await sched(["on", "--no-os-job", "--json"], deps().deps);
    expect(on.json.data.scheduling).toMatchObject({ state: "on", via: "serve" });
  });

  test("a project ticked by croft serve only is told to resume with --no-os-job; one on the OS job without it", async () => {
    await sched(["on", "--no-os-job"], deps().deps);
    const serveOnly = await sched(["pause", "--for", "2h", "--json"], deps().deps);
    expect(serveOnly.json.next).toEqual([{ command: "croft schedule on --no-os-job", reason: "resume scheduled runs now" }]);
    const human = await sched(["pause", "--for", "30m"], deps().deps);
    expect(human.stdout.split("\n")[0]).toBe(`Scheduling is paused for ${p.root} until 10:35 (in 30 min); croft schedule on --no-os-job resumes it now.`);
    const open = await sched(["pause"], deps().deps);
    expect(open.stdout.split("\n")[0]).toBe(`Scheduling is paused for ${p.root} until croft schedule on --no-os-job; croft schedule on --no-os-job resumes it now.`);
    const status = await sched(["status"], deps().deps);
    expect(status.stdout.split("\n")[0]).toBe("Scheduling paused · until croft schedule on --no-os-job · ticks from croft serve (not running) · never ticked");

    await sched(["off"], deps().deps);
    await sched(["on"], deps({ tick: true }).deps);
    const osJob = await sched(["pause", "--json"], deps().deps);
    expect(osJob.json.next).toEqual([{ command: "croft schedule on", reason: "resume scheduled runs now" }]);
  });

  test("pausing scheduling that is off is refused", async () => {
    const r = await sched(["pause", "--json"], deps().deps);
    expect(r.exit).toBe(2);
    expect(r.json.problems[0]).toMatchObject({
      code: "USAGE_ERROR", message: "scheduling is off for this project, so there is nothing to pause",
      fix: { kind: "command", command: "croft schedule status" },
    });
  });
});

describe("croft schedule on after a pause resumes it as it was (R32-10)", () => {
  test("a project ticked by croft serve only stays so: no OS job is installed on macOS", async () => {
    await sched(["on", "--no-os-job"], deps().deps);
    await sched(["pause", "--for", "2h"], deps().deps);
    const { deps: d, calls } = deps({ tick: true });
    const r = await sched(["on", "--json"], d);
    expect(r.exit).toBe(0);
    expect(calls).toEqual([]);
    expect(existsSync(plistPath(home))).toBe(false);
    expect(r.json.data).toMatchObject({ scheduling: { state: "on", via: "serve", stale: false }, job: null, firstTick: null });
    expect(setting().scheduling).toEqual({ state: "on", via: "serve" });
    expect(listProjects(home)).toEqual([{ root: p.root, addedAt: NOW, via: "serve" }]);
    const human = await sched(["pause"], deps().deps);
    expect(human.exit).toBe(0);
    const again = await sched(["on"], deps().deps);
    expect(again.stdout.split("\n")[0]).toBe(`Scheduling is on for ${p.root}, ticked by croft serve only (no OS job): nothing runs on a schedule while croft serve is stopped.`);
  });

  test("on Linux without crontab (a container), resuming works instead of failing with INSTALL_FAILED", async () => {
    const linux = { platform: "linux" as const, uid: 1000, execPath: BUN(), exists: (x: string) => x === BUN(), sleep: () => {} };
    const noCron = (argv: string[]) => (argv[0] === "crontab" ? { status: 127, stderr: "crontab: not found" } : undefined);
    await sched(["on", "--no-os-job"], deps({ job: linux, respond: noCron }).deps);
    await sched(["pause", "--for", "2h"], deps({ job: linux, respond: noCron }).deps);
    const { deps: d, calls } = deps({ job: linux, respond: noCron });
    const r = await sched(["on", "--json"], d);
    expect(r.exit).toBe(0);
    expect(r.json.problems.map((x: { code: string }) => x.code)).not.toContain("INSTALL_FAILED");
    expect(calls).toEqual([]);
    expect(r.json.data.scheduling).toMatchObject({ state: "on", via: "serve" });
    expect(readScheduling(p.stateDir, new Date(NOW))).toMatchObject({ state: "on", via: "serve" });
  });

  test("a pause that has ended reads as on, as every surface shows it: croft schedule on then asks for the OS job", async () => {
    await sched(["on", "--no-os-job"], deps().deps);
    await sched(["pause", "--for", "1h"], deps().deps);
    const later = { ...env, CROFT_NOW: "2026-09-24T20:00:00.000Z" };
    const status = await sched(["status", "--json"], deps().deps, { env: later });
    expect(status.json.data.scheduling).toMatchObject({ state: "on", via: "serve" });
    const r = await sched(["on", "--json"], deps({ tick: true }).deps, { env: later });
    expect(r.exit).toBe(0);
    expect(r.json.data.scheduling).toMatchObject({ state: "on", via: "os-job" });
  });

  test("--no-os-job still switches a paused OS-job project to croft serve; a paused OS-job project resumes on the job", async () => {
    await sched(["on"], deps({ tick: true }).deps);
    await sched(["pause"], deps().deps);
    const resumed = await sched(["on", "--json"], deps({ tick: true }).deps);
    expect(resumed.json.data.scheduling).toMatchObject({ state: "on", via: "os-job" });
    expect(resumed.json.data.job).toMatchObject({ installed: true });
    await sched(["pause"], deps().deps);
    const { deps: d, calls } = deps();
    const serve = await sched(["on", "--no-os-job", "--json"], d);
    expect(serve.json.data.scheduling).toMatchObject({ state: "on", via: "serve" });
    expect(calls).toContainEqual(["/bin/launchctl", "bootout", `gui/501/${label}`]);
  });

  test("on (not paused) through croft serve, croft schedule on still asks for the OS job, as the serve_not_running hint says", async () => {
    await sched(["on", "--no-os-job"], deps().deps);
    const r = await sched(["on", "--json"], deps({ tick: true }).deps);
    expect(r.json.data.scheduling).toMatchObject({ state: "on", via: "os-job" });
    expect(listProjects(home)).toEqual([{ root: p.root, addedAt: NOW, via: "os-job" }]);
  });
});

describe("usage", () => {
  test("flags only go with their action; unknown actions get a suggestion", async () => {
    const d = deps().deps;
    for (const [argv, flag] of [[["on", "--for", "2h"], "--for"], [["off", "--no-os-job"], "--no-os-job"], [["status", "--for", "1h"], "--for"]] as const) {
      const r = await sched([...argv, "--json"], d);
      expect(r.exit).toBe(2);
      expect(r.json.problems[0]).toMatchObject({ code: "USAGE_ERROR", message: `${flag} does not apply to croft schedule ${argv[0]}` });
    }
    const bad = await sched(["pause", "--for", "soon", "--json"], d);
    expect(bad.json.problems[0]).toMatchObject({ code: "USAGE_ERROR", message: "--for \"soon\" is not a pause length" });
    const enable = await sched(["enable", "--json"], d);
    expect(enable.exit).toBe(2);
    expect(enable.json.problems[0]).toMatchObject({ code: "USAGE_ERROR", fix: { command: "croft schedule on" } });
    expect(enable.json.problems[0].hint).toStartWith("did you mean croft schedule on?");
    const typo = await sched(["stauts", "--json"], d);
    expect(typo.json.problems[0].fix.command).toBe("croft schedule status");
  });

  test("--for lengths", () => {
    expect(parseFor("2h")).toBe(7_200_000);
    expect(parseFor("30m")).toBe(1_800_000);
    expect(parseFor("1d")).toBe(86_400_000);
    expect(parseFor("90 minutes")).toBe(5_400_000);
    expect(parseFor("1h30m")).toBe(5_400_000);
    expect(parseFor("1.5h")).toBe(5_400_000);
    for (const bad of ["", "2", "soon", "10s", "2 fortnights", "400d", "2h and more"]) expect(() => parseFor(bad)).toThrow(CroftError);
  });
});

describe("croft schedule status", () => {
  async function onAndTicking(at = NOW) {
    await sched(["on"], deps({ tick: true }).deps);
    beat(at);
  }

  test("the setting, the last tick, the job as installed, and every asset as the scheduler sees it", async () => {
    await onAndTicking();
    const r = await sched(["status", "--json"], deps().deps);
    expect(r.exit).toBe(0);
    const d = r.json.data;
    expect(d).toMatchObject({
      action: "status", root: p.root, scheduling: { state: "on", via: "os-job", lastTickAt: "2026-09-24T10:05:00-07:00", stale: false },
      job: { kind: "launchd", label, file: plistPath(home), installed: true, loaded: true, bun: BUN(), bunVersion: Bun.version, bunExists: true },
      registry: { projects: 1, osJob: 1 }, serve: null,
    });
    expect(d.assets.map((a: { asset: string }) => a.asset)).toEqual(VIEW.map((v) => v.asset));
    expect(d.assets[3]).toEqual({
      asset: "issue_triage", kind: "ts", schedule: null, cron: null, nextFireAt: null, lastFireAt: null, lastAttemptAt: null,
      due: true, dueReason: "stale: input github_issues changed", held: { code: "SCHEDULE_HELD", reason: "new asset, not run by hand yet" },
    });
    expect(r.json.problems.map((x: { code: string }) => x.code)).toEqual(["SCHEDULE_HELD"]);
    // A bare `croft schedule` is the status.
    const bare = await sched(["--json"], deps().deps);
    expect(bare.json.data.action).toBe("status");
  });

  test("human output: a head line, the job, and a table", async () => {
    await onAndTicking("2026-09-24T17:04:48.000Z");
    const r = await sched(["status"], deps().deps);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toBe("Scheduling on · ticks from the per-user OS job · last tick 12 s ago");
    expect(lines[1]).toBe(`Job: launchd ${label} · installed, loaded · Bun ${Bun.version} at ~/.bun/bin/bun`);
    const row = (name: string) => lines.find((l) => l.startsWith(`${name} `))!.split(/\s{3,}/);
    expect(lines[2]!.split(/\s{3,}/)).toEqual(["ASSET", "SCHEDULE", "CRON", "NEXT", "LAST FIRE", "STATUS"]);
    expect(row("github_issues")).toEqual(["github_issues", "every hour", "0 * * * *", "in 55 min", "10:00", "—"]);
    expect(row("taxi_zones")).toEqual(["taxi_zones", "monthly", "0 0 1 * *", "Oct 1 00:00", "—", "—"]);
    expect(row("sales")).toEqual(["sales", "manual", "—", "—", "—", "—"]);
    expect(row("issue_triage")).toEqual(["issue_triage", "after inputs", "—", "—", "—", "held: new asset, not run by hand yet (croft run issue_triage)"]);
    expect(row("open_issues")).toEqual(["open_issues", "after inputs", "—", "—", "—", "due: stale: input github_issues changed"]);
  });

  test("the job's Bun: its version asked of it; one older than croft needs, or one that does not run, is a note", async () => {
    await onAndTicking("2026-09-24T17:04:48.000Z");
    const ask = (v: string | null) => deps({ job: { platform: "darwin", uid: 501, execPath: "/usr/local/bin/bun", exists: (x) => x === BUN(), bunVersion: () => v, sleep: () => {} } }).deps;
    const r = await sched(["status", "--json"], ask("1.0.0"));
    expect(r.json.data.job).toMatchObject({ bun: BUN(), bunVersion: "1.0.0", bunExists: true });
    const human = (await sched(["status"], ask("1.0.0"))).stdout.split("\n");
    expect(human[1]).toBe(`Job: launchd ${label} · installed, loaded · Bun 1.0.0 at ~/.bun/bin/bun`);
    expect(human[2]).toBe("note: the job's Bun (1.0.0) is older than croft needs (1.3.14): croft schedule on points the job at a newer one");
    const dead = (await sched(["status"], ask(null))).stdout.split("\n");
    expect(dead[1]).toBe(`Job: launchd ${label} · installed, loaded · Bun at ~/.bun/bin/bun (does not run)`);
    expect(dead[2]).toBe("note: the job's Bun does not run (it printed no version): croft schedule on points the job at one that does");
    // Gone: said as missing, and not asked.
    const gone = await sched(["status"], deps({ job: { platform: "darwin", uid: 501, execPath: "/usr/local/bin/bun", exists: () => false, bunVersion: () => { throw new Error("asked"); }, sleep: () => {} } }).deps);
    expect(gone.stdout.split("\n")[1]).toBe(`Job: launchd ${label} · installed, loaded · Bun at ~/.bun/bin/bun (missing)`);
  });

  test("stale: no tick for more than 3 minutes is SCHEDULER_STALE, with the cause (here: the job is gone)", async () => {
    await onAndTicking("2026-09-24T16:55:00.000Z");
    const db = RunsDb.open(p.stateDir);
    db.setSetting(SINCE_KEY, "2026-09-24T16:50:00.000Z");   // turned on 15 minutes ago
    db.close();
    rmSync(plistPath(home));
    const r = await sched(["status", "--json"], deps().deps);
    expect(r.exit).toBe(0);
    expect(r.json.data.scheduling).toMatchObject({ state: "on", stale: true, lastTickAt: "2026-09-24T09:55:00-07:00" });
    expect(r.json.data.job).toMatchObject({ installed: false });
    const stale = r.json.problems.find((x: { code: string }) => x.code === "SCHEDULER_STALE");
    expect(stale).toMatchObject({
      severity: "warning", fix: { kind: "command", command: "croft schedule on" },
      details: { cause: "job_missing", via: "os-job", lastTickAt: "2026-09-24T09:55:00-07:00", quietForMs: 600_000 },
    });
    expect(stale.message).toBe(`the scheduler has not ticked for 10 min (last tick 2026-09-24T09:55:00-07:00): the per-user OS job is not installed (${plistPath(home)} is gone)`);
    const human = await sched(["status"], deps().deps);
    expect(human.stdout.split("\n")[0]).toBe("Scheduling on · ticks from the per-user OS job · last tick 10 min ago (stale)");
    expect(human.stdout).toContain(`Job: launchd ${label} · not installed`);
  });

  test("off: every asset still listed, no holds reported, and next says how to turn it on", async () => {
    const r = await sched(["status", "--json"], deps().deps);
    expect(r.json.data).toMatchObject({ scheduling: { state: "off", via: null, lastTickAt: null }, job: null });
    expect(r.json.data.scheduling).not.toHaveProperty("stale");
    expect(r.json.problems).toEqual([]);
    expect(r.json.next).toEqual([{ command: "croft schedule on", reason: "ask the user first: it runs the scheduled ingests on their schedules, unattended" }]);
    expect((await sched(["status"], deps().deps)).stdout.split("\n")[0]).toBe("Scheduling off · never ticked");
  });

  test("the scheduler's view failing fails status, but only warns after on", async () => {
    const boom = async () => {
      throw new CroftError("DB_UNREADABLE", { message: "runs.sqlite is damaged", hint: "restore it" });
    };
    const st = await sched(["status", "--json"], deps({ scheduleView: boom }).deps);
    expect(st.exit).toBe(2);
    expect(st.json.problems[0].code).toBe("DB_UNREADABLE");
    const on = await sched(["on", "--json"], deps({ tick: true, scheduleView: boom }).deps);
    expect(on.exit).toBe(0);
    expect(on.json.problems).toEqual([expect.objectContaining({ code: "DB_UNREADABLE", severity: "warning" })]);
    expect(on.json.data).toMatchObject({ scheduling: { state: "on" }, assets: [], assetsUnavailable: true });
    expect(on.json.next).toEqual([]);
    const human = await sched(["on"], deps({ scheduleView: boom }).deps);
    expect(human.stdout).toContain("  (the scheduled ingests could not be listed: see the warning below)\n");
    expect(human.stdout).not.toContain("no ingest has a schedule yet");
  });
});

describe("the setting and staleness", () => {
  function put(v: { scheduling?: unknown; since?: string; heartbeat?: string }) {
    const db = RunsDb.open(p.stateDir);
    if (v.scheduling !== undefined) db.setSetting("scheduling", v.scheduling);
    if (v.since) db.setSetting(SINCE_KEY, v.since);
    if (v.heartbeat) db.heartbeat(v.heartbeat);
    db.close();
  }
  const at = (iso: string) => new Date(iso);

  test("off without runs.sqlite, which is not created", () => {
    expect(readScheduling(join(p.root, "nowhere"), at(NOW))).toMatchObject({ state: "off", via: null, stale: false });
    expect(existsSync(join(p.root, "nowhere"))).toBe(false);
  });

  test("on: stale 3 minutes after the later of the last tick and turning it on", () => {
    put({ scheduling: { state: "on", via: "os-job" }, since: "2026-09-24T17:00:00.000Z" });
    expect(readScheduling(p.stateDir, at("2026-09-24T17:02:59Z")).stale).toBe(false);
    expect(readScheduling(p.stateDir, at("2026-09-24T17:03:01Z")).stale).toBe(true);
    put({ heartbeat: "2026-09-24T17:02:30.000Z" });
    expect(readScheduling(p.stateDir, at("2026-09-24T17:05:00Z"))).toMatchObject({ stale: false, quietSince: "2026-09-24T17:02:30.000Z" });
    expect(readScheduling(p.stateDir, at("2026-09-24T17:05:31Z")).stale).toBe(true);
  });

  test("on without a known start and without a tick: stale (it never ticked)", () => {
    put({ scheduling: { state: "on", via: "serve" } });
    expect(readScheduling(p.stateDir, at(NOW)).stale).toBe(true);
  });

  test("paused and off are never stale; JSON shows stale only while on and pausedUntil only while paused", () => {
    put({ scheduling: { state: "paused", via: "os-job", pausedUntil: null }, heartbeat: "2026-09-20T00:00:00.000Z" });
    const r = readScheduling(p.stateDir, at(NOW));
    expect(r).toMatchObject({ state: "paused", stale: false });
    expect(schedulingJson(r, LA)).toEqual({ state: "paused", via: "os-job", lastTickAt: "2026-09-19T17:00:00-07:00", pausedUntil: null });
    put({ scheduling: { state: "off", via: null } });
    expect(schedulingJson(readScheduling(p.stateDir, at(NOW)), LA)).toEqual({ state: "off", via: null, lastTickAt: "2026-09-19T17:00:00-07:00" });
  });

  test("serve only: croft serve not running, or running without ticks checking in", () => {
    put({ scheduling: { state: "on", via: "serve" }, since: "2026-09-24T16:00:00.000Z" });
    const rec = readScheduling(p.stateDir, at(NOW));
    const o = { root: p.root, stateDir: p.stateDir, tz: LA, now: at(NOW), home };
    const down = staleProblem(rec, { ...o, serve: null });
    expect(down).toMatchObject({
      code: "SCHEDULER_STALE", details: { cause: "serve_not_running", via: "serve" },
      fix: { kind: "manual", requiresHuman: true },
    });
    expect(down.message).toBe("the scheduler has not ticked since scheduling was turned on 65 min ago: scheduling is on for croft serve only (croft schedule on --no-os-job), and croft serve is not running");
    mkdirSync(join(p.stateDir, "logs"), { recursive: true });
    writeFileSync(join(p.stateDir, "logs", "tick.log"), "── croft serve (pid 1) starts croft tick\nerror: croft is not installed\n");
    const up = staleProblem(rec, { ...o, serve: { pid: 4121 } });
    expect(up.details).toMatchObject({ cause: "serve_not_ticking", logFile: join(p.stateDir, "logs", "tick.log") });
    expect(up.details!.logTail).toContain("croft is not installed");
    expect(up.message).toContain("croft serve (pid 4121) is running, but no croft tick it starts checks in");
  });

  test("os-job: a project missing from the registry, and a job launchd has not loaded", () => {
    put({ scheduling: { state: "on", via: "os-job" }, since: "2026-09-24T16:00:00.000Z" });
    const rec = readScheduling(p.stateDir, at(NOW));
    const o = { root: p.root, stateDir: p.stateDir, tz: LA, now: at(NOW), home, platform: "darwin" as const, uid: 501, serve: null };
    expect(staleProblem(rec, o).details).toMatchObject({ cause: "not_registered" });
    addProject(home, { root: p.root, via: "os-job" });
    mkdirSync(join(userHome, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plistPath(home), "<plist/>");
    const notLoaded = fakeRunner({ respond: (argv) => (argv[1] === "print" ? { status: 113, stderr: "Could not find service" } : undefined) });
    expect(staleProblem(rec, { ...o, runner: notLoaded.runner }).details).toMatchObject({ cause: "job_not_loaded" });
    // Without a runner only files are read: installed, so the tick log decides.
    expect(staleProblem(rec, o).details).toMatchObject({ cause: "unknown" });
  });
});

describe("times in words", () => {
  const now = new Date(NOW);
  test("fire times: in N min within 90 minutes, a clock time today, a date otherwise", () => {
    expect(fireText("2026-09-24T18:00:00.000Z", LA, now)).toBe("in 55 min");
    expect(fireText("2026-09-24T17:05:20.000Z", LA, now)).toBe("in 1 min");
    expect(fireText("2026-09-24T23:00:00.000Z", LA, now)).toBe("16:00");
    expect(fireText("2026-10-01T07:00:00.000Z", LA, now)).toBe("Oct 1 00:00");
    expect(clockText("2027-01-04T16:30:00.000Z", LA, now)).toBe("Jan 4 2027 08:30");
    expect(clockText("2026-09-24T17:00:00.000Z", LA, now)).toBe("10:00");
  });

  test("spans and ago", () => {
    expect(spanText(12_000)).toBe("12 s");
    expect(spanText(10 * 60_000)).toBe("10 min");
    expect(spanText(5 * 3_600_000)).toBe("5 h");
    expect(spanText(3 * 86_400_000)).toBe("3 days");
    expect(agoText("2026-09-24T17:04:48.000Z", now)).toBe("12 s ago");
    expect(agoText(null, now)).toBe("—");
  });
});
