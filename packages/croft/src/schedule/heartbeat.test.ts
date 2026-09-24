import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunsDb } from "../history/runs-db.ts";
import { croftHome, type CroftHome } from "./home.ts";
import {
  diagnose, HEARTBEAT_WAIT_MS, isStale, lastHeartbeat, STALE_AFTER_MS, tickLogTail, waitForHeartbeat,
} from "./heartbeat.ts";

let tmp: string;
let userHome: string;
let home: CroftHome;
let root: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "croft-heartbeat-")));
  userHome = join(tmp, "Users", "ada");
  mkdirSync(userHome, { recursive: true });
  home = croftHome({ HOME: userHome, CROFT_HOME: join(userHome, ".croft"), CROFT_JOB_LABEL: `dev.croft.test-${process.pid}-${Date.now()}` });
  root = join(tmp, "project");
  mkdirSync(root);
  writeFileSync(join(root, "croft.json"), `{"database": "warehouse.duckdb", "timezone": "UTC"}\n`);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** What `croft tick` records: the singleton row with its heartbeat. */
function beat(at: Date, stateDir = join(root, ".croft")): void {
  const db = RunsDb.open(stateDir);
  db.sqlite.query("INSERT INTO tick (id, pid, proc_start, heartbeat_at) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at")
    .run(process.pid, "0", at.toISOString());
  db.close();
}

function log(text: string): void {
  mkdirSync(home.logDir, { recursive: true });
  writeFileSync(home.tickLog, text);
}

describe("lastHeartbeat", () => {
  test("null without runs.sqlite, and it is not created", () => {
    expect(lastHeartbeat(root)).toBeNull();
    expect(existsSync(join(root, ".croft", "runs.sqlite"))).toBe(false);
  });

  test("null before the first tick", () => {
    RunsDb.open(join(root, ".croft")).close();
    expect(lastHeartbeat(root)).toBeNull();
  });

  test("the tick row's heartbeat_at", () => {
    const at = new Date("2026-09-24T10:00:00.123Z");
    beat(at);
    expect(lastHeartbeat(root)).toEqual(at);
  });

  test("a relocated state folder (croft.json stateDir) is where it looks", () => {
    const state = join(tmp, "elsewhere", ".croft");
    writeFileSync(join(root, "croft.json"), JSON.stringify({ database: "warehouse.duckdb", timezone: "UTC", stateDir: state }));
    const at = new Date("2026-09-24T10:00:00Z");
    beat(at, state);
    expect(lastHeartbeat(root)).toEqual(at);
    expect(lastHeartbeat(root, { stateDir: state })).toEqual(at);
  });

  test("an unreadable heartbeat_at is no heartbeat", () => {
    const db = RunsDb.open(join(root, ".croft"));
    db.sqlite.query("INSERT INTO tick (id, pid, proc_start, heartbeat_at) VALUES (1, 1, '0', 'yesterday')").run();
    db.close();
    expect(lastHeartbeat(root)).toBeNull();
  });
});

describe("isStale", () => {
  const now = new Date("2026-09-24T10:00:00Z");
  test(`stale once the heartbeat is older than ${STALE_AFTER_MS / 60_000} minutes, or missing`, () => {
    expect(STALE_AFTER_MS).toBe(180_000);
    expect(isStale(now, new Date(now.getTime() - 179_000))).toBe(false);
    expect(isStale(now, new Date(now.getTime() - 180_000))).toBe(false);
    expect(isStale(now, new Date(now.getTime() - 181_000))).toBe(true);
    expect(isStale(now, null)).toBe(true);
    expect(isStale(now, new Date(now.getTime() + 5_000))).toBe(false);   // clock skew: not stale
  });
});

describe("waitForHeartbeat", () => {
  test(`waits up to ${HEARTBEAT_WAIT_MS / 1000} s by default`, () => {
    expect(HEARTBEAT_WAIT_MS).toBe(70_000);
  });

  test("resolves with the first heartbeat at or after the start", async () => {
    const since = new Date();
    beat(new Date(since.getTime() - 10 * 60_000));                   // an old one does not count
    setTimeout(() => beat(new Date()), 150);
    const r = await waitForHeartbeat(root, { home, since, timeoutMs: 5000, pollMs: 20 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.heartbeatAt.getTime()).toBeGreaterThanOrEqual(since.getTime());
      expect(r.waitedMs).toBeLessThan(5000);
    }
  });

  test("times out with a diagnosis from the tick log", async () => {
    const since = new Date();
    beat(new Date(since.getTime() - 10 * 60_000));
    log(`2026-09-24T10:00:00.000Z ${userHome}/Documents/p: cannot check the project: EPERM: operation not permitted, stat '${userHome}/Documents/p/croft.json'\n`);
    const r = await waitForHeartbeat(root, { home, since, timeoutMs: 120, pollMs: 20, diagnose: { platform: "darwin", bunPath: "/bin/sh" } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.waitedMs).toBeGreaterThanOrEqual(100);
      expect(r.diagnosis.cause).toBe("privacy");
      expect(r.diagnosis.logTail).toContain("operation not permitted");
    }
  });
});

describe("diagnose", () => {
  const base = { platform: "darwin" as const, procVersion: null, bunPath: "/bin/sh", exists: (p: string) => p === "/bin/sh" };

  test("macOS privacy protection: EPERM on ~/Documents, ~/Desktop or ~/Downloads", () => {
    log(`2026-09-24T10:00:00.000Z ${userHome}/Desktop/shop: cannot check the project: EPERM: operation not permitted, stat '${userHome}/Desktop/shop/croft.json'\n`);
    const d = diagnose(home, base);
    expect(d.cause).toBe("privacy");
    expect(d.message).toContain("privacy");
    expect(d.message).toContain("~/Desktop");
    expect(d.hint).toContain("Full Disk Access");
    expect(d.hint).toContain("/bin/sh");                                // the Bun to allow
    expect(d.hint).toContain("croft schedule on");
    expect(d.fix).toMatchObject({ kind: "manual", requiresHuman: true });
    expect(d.logTail).toContain("operation not permitted");
  });

  test("\"Operation not permitted\" without a folder name is still privacy protection on macOS", () => {
    log("error: Operation not permitted\n");
    expect(diagnose(home, base).cause).toBe("privacy");
  });

  test("Bun missing: the job's Bun path is gone", () => {
    const d = diagnose(home, { ...base, bunPath: join(userHome, ".asdf/installs/bun/1.2.0/bin/bun"), exists: () => false });
    expect(d.cause).toBe("bun_missing");
    expect(d.message).toContain(".asdf/installs/bun/1.2.0/bin/bun");
    expect(d.hint).toContain("croft schedule on");
    expect(d.fix).toMatchObject({ kind: "command", command: "croft schedule on" });
  });

  test("Bun missing: the shell could not find it (cron's log)", () => {
    log("/bin/sh: 1: /home/ada/.bun/bin/bun: not found\n");
    expect(diagnose(home, { ...base, platform: "linux", bunPath: null }).cause).toBe("bun_missing");
    log("/bin/sh: /home/ada/.bun/bin/bun: No such file or directory\n");
    expect(diagnose(home, { ...base, platform: "linux", bunPath: null }).cause).toBe("bun_missing");
  });

  test("a project whose croft is not installed", () => {
    log(`2026-09-24T10:00:00.000Z ${root}: its croft is not installed (no node_modules/@zabaca/croft); run bun install in that folder\n`);
    const d = diagnose(home, base);
    expect(d.cause).toBe("croft_missing");
    expect(d.message).toContain(root);
    expect(d.fix).toMatchObject({ kind: "command", command: `cd ${root} && bun install` });
  });

  test("WSL: /proc/version names Microsoft", () => {
    const d = diagnose(home, { ...base, platform: "linux", bunPath: null, procVersion: "Linux version 5.15.153.1-microsoft-standard-WSL2 (root@65c757a075e2)" });
    expect(d.cause).toBe("wsl");
    expect(d.message).toContain("WSL");
    expect(d.hint).toContain("croft serve");
    expect(d.hint).toContain("--no-os-job");
  });

  test("otherwise a generic cause, pointing at the log", () => {
    const d = diagnose(home, base);
    expect(d).toMatchObject({ cause: "unknown", logTail: "" });
    expect(d.message).toContain("tick.log");
    expect(d.hint).toContain(home.tickLog);
    const linux = diagnose(home, { ...base, platform: "linux", bunPath: null });
    expect(linux.hint).toContain("cron");
  });

  test("the log tail is the last 20 lines", () => {
    log(Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") + "\n");
    const tail = tickLogTail(home);
    expect(tail.split("\n")).toEqual(Array.from({ length: 20 }, (_, i) => `line ${i + 30}`));
    expect(diagnose(home, base).logTail).toBe(tail);
  });
});
