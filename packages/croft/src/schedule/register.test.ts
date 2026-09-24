// The per-user OS job. Every test uses a fake OsRunner (recording argv), a fake HOME, CROFT_HOME=<tmp> and a
// unique CROFT_JOB_LABEL: nothing here touches the real ~/Library/LaunchAgents, launchd or crontab.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { croftHome, type CroftHome } from "./home.ts";
import type { ExecOptions, ExecResult, OsRunner } from "./os.ts";
import {
  bunVersionOf, cronBlock, ensureJob, inspectJob, installedBunPath, isVersionManagedPath, jobPath, type JobOptions, pickBun, plistPath,
  plistXml, removeJob, upsertCronBlock,
} from "./register.ts";
import { tickScriptSource } from "./user-tick.ts";

let tmp: string;
let userHome: string;
let home: CroftHome;
let label: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "croft-register-")));
  userHome = join(tmp, "Users", "ada");
  mkdirSync(userHome, { recursive: true });
  label = `dev.croft.test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  home = croftHome({ HOME: userHome, CROFT_HOME: join(userHome, ".croft"), CROFT_JOB_LABEL: label });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

interface Call { argv: string[]; input?: string }

/** Records every command; answers with `respond` (default: success, no output). */
function fakeRunner(respond: (argv: string[], o: ExecOptions) => Partial<ExecResult> | undefined = () => undefined) {
  const calls: Call[] = [];
  const runner: OsRunner = {
    exec(argv, o = {}) {
      calls.push({ argv: [...argv], ...(o.input !== undefined ? { input: o.input } : {}) });
      return { status: 0, stdout: "", stderr: "", ...respond([...argv], o) };
    },
  };
  return { runner, calls };
}

const BUN = () => join(userHome, ".bun", "bin", "bun");

/** Options for a Mac with Bun at ~/.bun/bin/bun; every other Bun found says it is 1.3.14, like the running one. */
type Opts = JobOptions & { runner?: OsRunner };
function mac(extra: Partial<Opts> = {}): Opts {
  return {
    platform: "darwin", uid: 501, execPath: BUN(), exists: (p) => p === BUN(), env: {}, sleep: () => {},
    runningVersion: "1.3.14", bunVersion: () => "1.3.14", ...extra,
  };
}
function linux(extra: Partial<Opts> = {}): Opts {
  return {
    platform: "linux", uid: 1000, execPath: BUN(), exists: (p) => p === BUN(), env: {}, sleep: () => {},
    runningVersion: "1.3.14", bunVersion: () => "1.3.14", ...extra,
  };
}

const NOT_LOADED = { status: 113, stderr: `Bad request.\nCould not find service "x" in domain for user gui: 501\n` };

describe("pickBun", () => {
  const at = (...paths: string[]) => (p: string) => paths.includes(p);
  /** A fake `<bun> --version`: each path's version, null for one that does not run. */
  const versions = (v: Record<string, string | null>) => (p: string) => (p in v ? v[p]! : null);
  const mise = () => join(userHome, ".local/share/mise/installs/bun/1.3.14/bin/bun");

  test("prefers ~/.bun/bin/bun, then /opt/homebrew/bin/bun, then /usr/local/bin/bun, over process.execPath", () => {
    const all = at(BUN(), "/opt/homebrew/bin/bun", "/usr/local/bin/bun");
    const o = { execPath: mise(), env: {}, runningVersion: "1.3.14", bunVersion: () => "1.3.14" };
    expect(pickBun(home, { ...o, exists: all })).toEqual({ path: BUN(), stable: true, version: "1.3.14", skipped: [] });
    expect(pickBun(home, { ...o, exists: at("/opt/homebrew/bin/bun", "/usr/local/bin/bun") }).path).toBe("/opt/homebrew/bin/bun");
    expect(pickBun(home, { ...o, exists: at("/usr/local/bin/bun") }).path).toBe("/usr/local/bin/bun");
  });

  test("$BUN_INSTALL/bin/bun (a custom install folder) comes first", () => {
    const custom = join(tmp, "bun-home", "bin", "bun");
    const o = { runningVersion: "1.3.14", bunVersion: () => "1.3.14" };
    expect(pickBun(home, { ...o, execPath: BUN(), exists: at(BUN(), custom), env: { BUN_INSTALL: join(tmp, "bun-home") } }).path).toBe(custom);
  });

  test("with no stable path, process.execPath: stable unless it is a version manager's", () => {
    const o = { runningVersion: "1.3.14", bunVersion: () => null };
    expect(pickBun(home, { ...o, execPath: "/usr/bin/bun", exists: at(), env: {} }))
      .toEqual({ path: "/usr/bin/bun", stable: true, version: "1.3.14", skipped: [] });
    const asdf = join(userHome, ".asdf/installs/bun/1.3.14/bin/bun");
    expect(pickBun(home, { ...o, execPath: asdf, exists: at(), env: {} })).toEqual({ path: asdf, stable: false, version: "1.3.14", skipped: [] });
  });

  test("an old stable Bun (a curl install left behind) is skipped for the running one (review R31-09)", () => {
    const o = { exists: at(BUN()), env: {}, runningVersion: "1.3.14", bunVersion: versions({ [BUN()]: "1.0.0" }) };
    expect(pickBun(home, { ...o, execPath: mise() })).toEqual({
      path: mise(), stable: false, version: "1.3.14", skipped: [{ path: BUN(), version: "1.0.0" }],
    });
    expect(pickBun(home, { ...o, execPath: "/usr/bin/bun" })).toMatchObject({ path: "/usr/bin/bun", stable: true });
  });

  test("a stable Bun at least as new as the running one wins; an older one only over a version manager's path, and never below croft's floor", () => {
    const all = at(BUN(), "/opt/homebrew/bin/bun", "/usr/local/bin/bun");
    const base = { exists: all, env: {}, runningVersion: "1.4.2" };
    // ~/.bun is older than the running Bun, Homebrew's is newer: Homebrew's.
    expect(pickBun(home, { ...base, execPath: mise(), bunVersion: versions({ [BUN()]: "1.3.20", "/opt/homebrew/bin/bun": "1.5.0" }) }))
      .toMatchObject({ path: "/opt/homebrew/bin/bun", stable: true, version: "1.5.0", skipped: [{ path: BUN(), version: "1.3.20" }] });
    // None as new as the running Bun, which is a version manager's: the first stable one croft still runs on.
    expect(pickBun(home, { ...base, execPath: mise(), bunVersion: versions({ [BUN()]: "1.2.0", "/opt/homebrew/bin/bun": "1.3.14" }) }))
      .toMatchObject({ path: "/opt/homebrew/bin/bun", stable: true, version: "1.3.14" });
    // …but the running Bun itself when its path is stable.
    expect(pickBun(home, { ...base, execPath: "/usr/bin/bun", bunVersion: versions({ [BUN()]: "1.3.14" }) }))
      .toMatchObject({ path: "/usr/bin/bun", stable: true, version: "1.4.2" });
    // Below the floor (package.json engines.bun) nothing is taken, even over a version manager's path.
    expect(pickBun(home, { ...base, execPath: mise(), bunVersion: versions({ [BUN()]: "1.3.13", "/opt/homebrew/bin/bun": "1.1.0", "/usr/local/bin/bun": null }) }))
      .toMatchObject({ path: mise(), stable: false, version: "1.4.2" });
  });

  test("a Bun that does not run, or says no version, is skipped", () => {
    const o = { exists: at(BUN(), "/opt/homebrew/bin/bun"), env: {}, runningVersion: "1.3.14", execPath: mise() };
    expect(pickBun(home, { ...o, bunVersion: versions({ [BUN()]: null, "/opt/homebrew/bin/bun": "1.3.14" }) }))
      .toMatchObject({ path: "/opt/homebrew/bin/bun", skipped: [{ path: BUN(), version: null }] });
  });

  test("the running Bun's own path is taken without running it; each other candidate is asked once", () => {
    const asked: string[] = [];
    const bunVersion = (p: string) => { asked.push(p); return "1.0.0"; };
    expect(pickBun(home, { execPath: BUN(), exists: at(BUN()), env: {}, runningVersion: "1.3.14", bunVersion }).path).toBe(BUN());
    expect(asked).toEqual([]);
    pickBun(home, { execPath: mise(), exists: at(BUN(), "/usr/local/bin/bun"), env: {}, runningVersion: "1.3.14", bunVersion });
    expect(asked).toEqual([BUN(), "/usr/local/bin/bun"]);
  });

  test("bunVersionOf runs `<bun> --version`: the real Bun, a fake old one, and ones that fail", () => {
    expect(bunVersionOf(process.execPath)).toBe(Bun.version);
    const dir = join(tmp, "fake-bins");
    mkdirSync(dir, { recursive: true });
    const script = (name: string, body: string) => {
      const p = join(dir, name);
      writeFileSync(p, `#!/bin/sh\n${body}\n`);
      chmodSync(p, 0o755);
      return p;
    };
    expect(bunVersionOf(script("old", "echo 1.0.0"))).toBe("1.0.0");
    expect(bunVersionOf(script("canary", "echo 1.3.15-canary.1+abc123"))).toBe("1.3.15-canary.1+abc123");
    expect(bunVersionOf(script("fails", "echo 1.3.14; exit 3"))).toBeNull();
    expect(bunVersionOf(script("chatty", "echo hello"))).toBeNull();
    expect(bunVersionOf(join(dir, "missing"))).toBeNull();
  });

  test("version-manager and versioned paths", () => {
    for (const p of [
      "/Users/ada/.asdf/installs/bun/1.3.14/bin/bun",
      "/Users/ada/.local/share/mise/installs/bun/1.3.14/bin/bun",
      "/Users/ada/.mise/installs/bun/latest/bin/bun",
      "/Users/ada/.proto/tools/bun/1.3.14/bun",
      "/Users/ada/.nvm/versions/node/v22/bin/bun",
      "/Users/ada/.volta/tools/image/packages/bun/bin/bun",
      "/Users/ada/.local/share/fnm/node-versions/v22/installation/bin/bun",
      "/opt/homebrew/Cellar/bun/1.3.14/bin/bun",
      "/nix/store/abc123-bun-1.3.14/bin/bun",
    ]) expect(isVersionManagedPath(p), p).toBe(true);
    for (const p of ["/Users/ada/.bun/bin/bun", "/opt/homebrew/bin/bun", "/usr/local/bin/bun", "/usr/bin/bun"]) {
      expect(isVersionManagedPath(p), p).toBe(false);
    }
  });
});

describe("the LaunchAgent (macOS)", () => {
  const golden = (u: string, lbl: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${lbl}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${u}/.bun/bin/bun</string>
		<string>--no-env-file</string>
		<string>${u}/.croft/tick.ts</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>HOME</key>
		<string>${u}</string>
		<key>PATH</key>
		<string>${u}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
	</dict>
	<key>StartInterval</key>
	<integer>60</integer>
	<key>RunAtLoad</key>
	<true/>
	<key>AbandonProcessGroup</key>
	<true/>
	<key>StandardOutPath</key>
	<string>${u}/.croft/logs/tick.log</string>
	<key>StandardErrorPath</key>
	<string>${u}/.croft/logs/tick.log</string>
</dict>
</plist>
`;

  test("golden plist", () => {
    expect(plistXml({ label: "dev.croft.tick", bun: "/Users/ada/.bun/bin/bun", home: croftHome({ HOME: "/Users/ada" }), platform: "darwin" }))
      .toBe(golden("/Users/ada", "dev.croft.tick"));
  });

  test("strings are XML-escaped", () => {
    const h = croftHome({ HOME: "/Users/a&b <c>" });
    const xml = plistXml({ label: "dev.croft.tick", bun: "/Users/a&b <c>/.bun/bin/bun", home: h, platform: "darwin" });
    expect(xml).toContain("<string>/Users/a&amp;b &lt;c&gt;/.bun/bin/bun</string>");
    expect(xml).not.toContain("a&b");
  });

  test("the plist passes plutil -lint (read-only check, macOS only)", () => {
    if (process.platform !== "darwin" || !existsSync("/usr/bin/plutil")) return;
    const file = join(tmp, "job.plist");
    writeFileSync(file, plistXml({ label, bun: "/Users/a&b/.bun/bin/bun", home: croftHome({ HOME: "/Users/a&b" }), platform: "darwin" }));
    const r = spawnSync("/usr/bin/plutil", ["-lint", file], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    expect(r.stdout.trim()).toBe(`${file}: OK`);
  });

  test("ensureJob writes the plist and tick script, boots out any old job, then bootstraps it into gui/<uid>", () => {
    const { runner, calls } = fakeRunner((argv) => (argv[1] === "bootout" ? NOT_LOADED : undefined));
    const r = ensureJob(runner, home, mac());
    const file = join(userHome, "Library", "LaunchAgents", `${label}.plist`);
    expect(plistPath(home)).toBe(file);
    expect(readFileSync(file, "utf8")).toBe(golden(userHome, label));
    expect(statSync(file).mode & 0o777).toBe(0o644);                      // launchd refuses group/world-writable plists
    expect(readFileSync(home.tickScript, "utf8")).toBe(tickScriptSource());
    expect(existsSync(home.logDir)).toBe(true);                           // launchd opens tick.log there
    expect(calls.map((c) => c.argv)).toEqual([
      ["/bin/launchctl", "bootout", `gui/501/${label}`],
      ["/bin/launchctl", "bootstrap", "gui/501", file],
    ]);
    expect(r).toEqual({ kind: "launchd", label, file, bun: { path: BUN(), stable: true, version: "1.3.14", skipped: [] }, changed: true, tickScriptChanged: true });
  });

  test("unchanged and loaded: nothing is rewritten or reloaded", () => {
    ensureJob(fakeRunner().runner, home, mac());
    const file = plistPath(home);
    utimesSync(file, new Date(0), new Date(0));
    const { runner, calls } = fakeRunner();
    const r = ensureJob(runner, home, mac());
    expect(statSync(file).mtimeMs).toBe(0);
    expect(calls.map((c) => c.argv)).toEqual([["/bin/launchctl", "print", `gui/501/${label}`]]);
    expect(r.changed).toBe(false);
    expect(r.tickScriptChanged).toBe(false);
  });

  test("unchanged but not loaded (booted out, a failed bootstrap): bootstrapped without rewriting", () => {
    ensureJob(fakeRunner().runner, home, mac());
    utimesSync(plistPath(home), new Date(0), new Date(0));
    const { runner, calls } = fakeRunner((argv) => (argv[1] === "print" ? NOT_LOADED : undefined));
    const r = ensureJob(runner, home, mac());
    expect(statSync(plistPath(home)).mtimeMs).toBe(0);
    expect(calls.map((c) => c.argv[1])).toEqual(["print", "bootstrap"]);
    expect(r.changed).toBe(true);
  });

  test("a changed job (another Bun path) is rewritten and reloaded", () => {
    ensureJob(fakeRunner().runner, home, mac());
    const { runner, calls } = fakeRunner();
    const r = ensureJob(runner, home, mac({ exists: (p) => p === "/opt/homebrew/bin/bun" }));
    expect(readFileSync(plistPath(home), "utf8")).toContain("<string>/opt/homebrew/bin/bun</string>");
    expect(calls.map((c) => c.argv[1])).toEqual(["bootout", "bootstrap"]);
    expect(r.changed).toBe(true);
  });

  test("bootstrap right after bootout can fail with 5: Input/output error while launchd tears down; it is retried", () => {
    let bootstraps = 0;
    const slept: number[] = [];
    const { runner } = fakeRunner((argv) => {
      if (argv[1] !== "bootstrap") return undefined;
      return ++bootstraps < 3 ? { status: 5, stderr: "Bootstrap failed: 5: Input/output error\n" } : undefined;
    });
    ensureJob(runner, home, mac({ sleep: (ms) => slept.push(ms) }));
    expect(bootstraps).toBe(3);
    expect(slept.length).toBe(2);
  });

  test("a bootstrap that keeps failing is INSTALL_FAILED with launchctl's words, a hint and the serve fallback", () => {
    const { runner } = fakeRunner((argv) => (argv[1] === "bootstrap" ? { status: 125, stderr: "Bootstrap failed: 125: Domain does not support specified action\n" } : undefined));
    let err: unknown;
    try {
      ensureJob(runner, home, mac());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CroftError);
    const p = (err as CroftError).problem;
    expect(p.code).toBe("INSTALL_FAILED");
    expect(p.message).toContain("launchctl bootstrap");
    expect(p.message).toContain("Domain does not support specified action");
    expect(p.hint).toContain("--no-os-job");
    expect(p.details).toMatchObject({ job: "launchd", label, status: 125 });
  });

  test("removeJob boots the job out and deletes the plist; again, it is a no-op", () => {
    ensureJob(fakeRunner().runner, home, mac());
    const { runner, calls } = fakeRunner();
    expect(removeJob(runner, home, mac())).toEqual({ kind: "launchd", removed: true });
    expect(existsSync(plistPath(home))).toBe(false);
    expect(calls.map((c) => c.argv)).toEqual([["/bin/launchctl", "bootout", `gui/501/${label}`]]);
    const again = fakeRunner((argv) => (argv[1] === "bootout" ? { status: 3, stderr: "Boot-out failed: 3: No such process\n" } : undefined));
    expect(removeJob(again.runner, home, mac())).toEqual({ kind: "launchd", removed: false });
  });

  test("inspectJob reports the plist, whether launchd has it, and its Bun", () => {
    const none = inspectJob(fakeRunner(() => NOT_LOADED).runner, home, mac());
    expect(none).toEqual({ kind: "launchd", installed: false, loaded: false, bun: null, bunExists: false });
    ensureJob(fakeRunner().runner, home, mac());
    expect(inspectJob(fakeRunner().runner, home, mac())).toEqual({ kind: "launchd", installed: true, loaded: true, bun: BUN(), bunExists: true });
    expect(inspectJob(fakeRunner().runner, home, mac({ exists: () => false })).bunExists).toBe(false);
    expect(installedBunPath(home, mac())).toBe(BUN());
  });
});

describe("the crontab block (Linux)", () => {
  const block = (u: string, lbl: string) => [
    `# croft:${lbl} begin`,
    `* * * * * ${u}/.bun/bin/bun --no-env-file ${u}/.croft/tick.ts >> ${u}/.croft/logs/tick.log 2>&1`,
    `# croft:${lbl} end`,
  ].join("\n");

  test("golden crontab block", () => {
    expect(cronBlock({ label: "dev.croft.tick", bun: "/home/ada/.bun/bin/bun", home: croftHome({ HOME: "/home/ada" }) }))
      .toBe(block("/home/ada", "dev.croft.tick"));
  });

  test("paths with spaces or shell characters are quoted, and % is escaped for cron", () => {
    const h = croftHome({ HOME: "/home/ada lovelace", CROFT_HOME: "/home/ada lovelace/100%/it's" });
    expect(cronBlock({ label: "l", bun: "/home/ada lovelace/.bun/bin/bun", home: h }).split("\n")[1]).toBe(
      `* * * * * '/home/ada lovelace/.bun/bin/bun' --no-env-file '/home/ada lovelace/100\\%/it'\\''s/tick.ts' >> '/home/ada lovelace/100\\%/it'\\''s/logs/tick.log' 2>&1`,
    );
  });

  test("upsertCronBlock appends to a table without one, keeping every other line", () => {
    const b = block("/home/ada", "l");
    expect(upsertCronBlock("", "l", b)).toBe(`${b}\n`);
    expect(upsertCronBlock("MAILTO=ada\n0 3 * * * backup.sh\n", "l", b)).toBe(`MAILTO=ada\n0 3 * * * backup.sh\n${b}\n`);
    expect(upsertCronBlock("0 3 * * * backup.sh", "l", b)).toBe(`0 3 * * * backup.sh\n${b}\n`);    // no final newline
  });

  test("upsertCronBlock replaces the block in place, leaving other lines and other labels' blocks alone", () => {
    const old = [
      "0 3 * * * backup.sh",
      "# croft:l begin",
      "* * * * * /old/bun --no-env-file /old/tick.ts >> /old/tick.log 2>&1",
      "# croft:l end",
      "# croft:other begin",
      "* * * * * /x/bun --no-env-file /x/tick.ts",
      "# croft:other end",
      "30 * * * * report.sh",
      "",
    ].join("\n");
    const b = block("/home/ada", "l");
    expect(upsertCronBlock(old, "l", b)).toBe([
      "0 3 * * * backup.sh", b, "# croft:other begin", "* * * * * /x/bun --no-env-file /x/tick.ts", "# croft:other end", "30 * * * * report.sh", "",
    ].join("\n"));
    expect(upsertCronBlock(old, "l", null)).toBe([
      "0 3 * * * backup.sh", "# croft:other begin", "* * * * * /x/bun --no-env-file /x/tick.ts", "# croft:other end", "30 * * * * report.sh", "",
    ].join("\n"));
  });

  test("duplicate blocks collapse into one; a begin marker without its end drops only croft's own lines", () => {
    const b = block("/home/ada", "l");
    const twice = `${b}\n5 * * * * a.sh\n${b}\n`;
    expect(upsertCronBlock(twice, "l", b)).toBe(`${b}\n5 * * * * a.sh\n`);
    const torn = "# croft:l begin\n* * * * * /old/bun --no-env-file /old/tick.ts\n5 * * * * a.sh\n";
    expect(upsertCronBlock(torn, "l", null)).toBe("5 * * * * a.sh\n");
  });

  test("the header some crontab -l versions print is not written back", () => {
    const listed = "# DO NOT EDIT THIS FILE - edit the master and reinstall.\n# (/tmp/crontab.XXXX installed on Thu Sep 24 10:00:00 2026)\n# (Cron version -- $Id: crontab.c,v 2.13 1994/01/17 03:20:37 vixie Exp $)\n0 3 * * * backup.sh\n";
    expect(upsertCronBlock(listed, "l", null)).toBe("0 3 * * * backup.sh\n");
  });

  test("ensureJob with no crontab yet: `crontab -l` says so, and `crontab -` installs the block", () => {
    const { runner, calls } = fakeRunner((argv) => (argv[1] === "-l" ? { status: 1, stderr: "no crontab for ada\n" } : undefined));
    const r = ensureJob(runner, home, linux());
    expect(calls).toEqual([
      { argv: ["crontab", "-l"] },
      { argv: ["crontab", "-"], input: `${block(userHome, label)}\n` },
    ]);
    expect(readFileSync(home.tickScript, "utf8")).toBe(tickScriptSource());
    expect(r).toEqual({ kind: "crontab", label, file: null, bun: { path: BUN(), stable: true, version: "1.3.14", skipped: [] }, changed: true, tickScriptChanged: true });
  });

  test("ensureJob keeps the user's other lines and replaces an old block", () => {
    const current = `0 3 * * * backup.sh\n# croft:${label} begin\n* * * * * /old/bun --no-env-file /old/tick.ts\n# croft:${label} end\n30 * * * * report.sh\n`;
    const { runner, calls } = fakeRunner((argv) => (argv[1] === "-l" ? { stdout: current } : undefined));
    ensureJob(runner, home, linux());
    expect(calls[1]).toEqual({
      argv: ["crontab", "-"], input: `0 3 * * * backup.sh\n${block(userHome, label)}\n30 * * * * report.sh\n`,
    });
  });

  test("an unchanged block is not rewritten", () => {
    const current = `0 3 * * * backup.sh\n${block(userHome, label)}\n`;
    const { runner, calls } = fakeRunner((argv) => (argv[1] === "-l" ? { stdout: current } : undefined));
    expect(ensureJob(runner, home, linux()).changed).toBe(false);
    expect(calls.map((c) => c.argv)).toEqual([["crontab", "-l"]]);
    // Nor when `crontab -l` prints the old vixie header above it.
    const header = "# DO NOT EDIT THIS FILE - edit the master and reinstall.\n# (/tmp/crontab.1 installed on Thu Sep 24 10:00:00 2026)\n# (Cron version -- $Id: crontab.c,v 2.13 1994/01/17 03:20:37 vixie Exp $)\n";
    const again = fakeRunner((argv) => (argv[1] === "-l" ? { stdout: header + current } : undefined));
    expect(ensureJob(again.runner, home, linux()).changed).toBe(false);
    expect(again.calls).toHaveLength(1);
  });

  test("no crontab program is INSTALL_FAILED with the fix and the serve fallback", () => {
    const { runner } = fakeRunner(() => ({ status: null, stderr: "Error: spawnSync crontab ENOENT" }));
    let err: unknown;
    try {
      ensureJob(runner, home, linux());
    } catch (e) {
      err = e;
    }
    const p = (err as CroftError).problem;
    expect(p.code).toBe("INSTALL_FAILED");
    expect(p.message).toContain("crontab");
    expect(p.hint).toContain("cron");
    expect(p.hint).toContain("--no-os-job");
  });

  test("a failing `crontab -` is INSTALL_FAILED with its stderr", () => {
    const { runner } = fakeRunner((argv) => (argv[1] === "-l" ? { stdout: "" } : { status: 1, stderr: "crontab: your UID isn't in the passwd file.\n" }));
    expect(() => ensureJob(runner, home, linux())).toThrow(/UID isn't in the passwd file/);
  });

  test("removeJob strips the block and keeps the rest; without a block it writes nothing", () => {
    const current = `0 3 * * * backup.sh\n${block(userHome, label)}\n`;
    const { runner, calls } = fakeRunner((argv) => (argv[1] === "-l" ? { stdout: current } : undefined));
    expect(removeJob(runner, home, linux())).toEqual({ kind: "crontab", removed: true });
    expect(calls[1]).toEqual({ argv: ["crontab", "-"], input: "0 3 * * * backup.sh\n" });
    const none = fakeRunner((argv) => (argv[1] === "-l" ? { status: 1, stderr: "no crontab for ada\n" } : undefined));
    expect(removeJob(none.runner, home, linux())).toEqual({ kind: "crontab", removed: false });
    expect(none.calls.map((c) => c.argv)).toEqual([["crontab", "-l"]]);
  });

  test("inspectJob and installedBunPath read the block", () => {
    const current = `${block(userHome, label)}\n`;
    const { runner } = fakeRunner((argv) => (argv[1] === "-l" ? { stdout: current } : undefined));
    expect(inspectJob(runner, home, linux())).toEqual({ kind: "crontab", installed: true, loaded: null, bun: BUN(), bunExists: true });
    expect(installedBunPath(home, linux({ runner }))).toBe(BUN());
    const quoted = cronBlock({ label, bun: "/home/a b/bun", home });
    const r2 = fakeRunner((argv) => (argv[1] === "-l" ? { stdout: quoted } : undefined));
    expect(installedBunPath(home, linux({ runner: r2.runner }))).toBe("/home/a b/bun");
  });
});

describe("safety", () => {
  test("PATH for the job: the bun folder first, then the system folders", () => {
    expect(jobPath("/Users/ada/.bun/bin", "darwin")).toBe("/Users/ada/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    expect(jobPath("/usr/local/bin", "linux")).toBe("/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  });

  test("under CROFT_FORBID_OS_JOBS=1 the real home is refused before anything is written", () => {
    const real = croftHome({ HOME: userInfo().homedir, CROFT_JOB_LABEL: label });
    const { runner, calls } = fakeRunner();
    for (const f of [() => ensureJob(runner, real, mac({ env: { CROFT_FORBID_OS_JOBS: "1" } })), () => removeJob(runner, real, mac({ env: { CROFT_FORBID_OS_JOBS: "1" } }))]) {
      expect(f).toThrow(/CROFT_FORBID_OS_JOBS/);
    }
    expect(calls).toEqual([]);
    // A fake HOME with the real ~/.croft is refused too.
    const realCroft = croftHome({ HOME: userHome, CROFT_HOME: join(userInfo().homedir, ".croft"), CROFT_JOB_LABEL: label });
    expect(() => ensureJob(runner, realCroft, mac({ env: { CROFT_FORBID_OS_JOBS: "1" } }))).toThrow(/CROFT_FORBID_OS_JOBS/);
  });

  test("the default env is process.env, whose CROFT_FORBID_OS_JOBS=1 comes from tests/preload.ts", () => {
    expect(process.env.CROFT_FORBID_OS_JOBS).toBe("1");
    const real = croftHome({ HOME: userInfo().homedir, CROFT_JOB_LABEL: label });
    expect(() => ensureJob(fakeRunner().runner, real, { platform: "darwin", uid: 501, sleep: () => {} })).toThrow(/CROFT_FORBID_OS_JOBS/);
  });

  test("an unsupported platform is INSTALL_FAILED pointing at croft serve", () => {
    let err: unknown;
    try {
      ensureJob(fakeRunner().runner, home, { platform: "win32", env: {} });
    } catch (e) {
      err = e;
    }
    expect((err as CroftError).problem.code).toBe("INSTALL_FAILED");
    expect((err as CroftError).problem.hint).toContain("croft serve");
  });
});
