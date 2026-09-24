// The per-user OS job (DESIGN.md §8 "Turning it on"): one job per user, whatever the number of projects,
// that runs ~/.croft/tick.ts (user-tick.ts) every minute with an absolute Bun path.
// - macOS: a LaunchAgent, ~/Library/LaunchAgents/<label>.plist, StartInterval 60 and RunAtLoad, loaded with
//   `launchctl bootstrap gui/<uid>` and removed with `launchctl bootout gui/<uid>/<label>` [V].
// - Linux: one crontab line between "# croft:<label> begin" and "# croft:<label> end" markers, read with
//   `crontab -l` and written with `crontab -`; every other line is kept as it was.
// launchd's PATH is /usr/bin:/bin:/usr/sbin:/sbin [V] and cron's is as bare, so the job names Bun by absolute
// path, preferring a stable one (~/.bun/bin/bun, Homebrew's) over a version manager's, which disappears on
// upgrade, but never a stable one older than croft needs (a curl install left behind): each candidate's
// `bun --version` is compared with the running Bun and croft's floor (pickBun). Output goes to
// ~/.croft/logs/tick.log, which heartbeat.ts reads to diagnose a job that never ticks.
//
// ensureJob and removeJob are idempotent: a job whose content is unchanged is not rewritten or reloaded.
// Commands go through an OsRunner (os.ts), so tests pass a fake one; and with CROFT_FORBID_OS_JOBS=1
// (tests/preload.ts) both refuse the real home folder outright, before any file is written.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BUN_FLOOR, versionAtLeast } from "../cli/version.ts";
import { CroftError } from "../core/errors.ts";
import type { CroftHome, Env } from "./home.ts";
import type { ExecResult, OsRunner } from "./os.ts";
import { writeTickScript } from "./user-tick.ts";

const LAUNCHCTL = "/bin/launchctl";
const CRONTAB = "crontab";

export interface JobOptions {
  platform?: NodeJS.Platform;
  /** The user id for launchd's gui/<uid> domain; process.getuid(). */
  uid?: number;
  /** BUN_INSTALL and CROFT_FORBID_OS_JOBS are read from it; process.env. */
  env?: Env;
  /** The running Bun, the last resort for the job's Bun path; process.execPath. */
  execPath?: string;
  /** Whether a candidate Bun path exists (tests fake the machine's). */
  exists?: (path: string) => boolean;
  /** A candidate Bun's version (`<bun> --version`), or null when it does not run; bunVersionOf. */
  bunVersion?: (path: string) => string | null;
  /** The running Bun's version; Bun.version. */
  runningVersion?: string;
  /** Between bootstrap attempts; Bun.sleepSync. */
  sleep?: (ms: number) => void;
}

export interface BunChoice {
  path: string;
  /** False when the only Bun found is a version manager's (it may vanish on the next upgrade). */
  stable: boolean;
  /** Its version, when known (the running Bun's, or what `<path> --version` said). */
  version: string | null;
  /** Stable candidates passed over: older than croft needs, or not running at all (version null). */
  skipped: { path: string; version: string | null }[];
}

export interface JobResult {
  kind: "launchd" | "crontab";
  label: string;
  /** The plist; null for crontab. */
  file: string | null;
  bun: BunChoice;
  /** Whether the job was written or (re)loaded; false when it was already in place. */
  changed: boolean;
  tickScriptChanged: boolean;
}

export interface JobInspection {
  kind: "launchd" | "crontab";
  /** The plist exists, or the crontab has croft's block. */
  installed: boolean;
  /** launchd has the job loaded; null for crontab, which has no such state. */
  loaded: boolean | null;
  /** The Bun the job runs, or null when it is not installed. */
  bun: string | null;
  bunExists: boolean;
}

// ---- Bun ----

/** Version managers and versioned installs: their Bun path changes or disappears on upgrade. */
const VERSIONED = [
  /\/\.asdf\//, /\/\.?mise\//, /\/\.local\/share\/(mise|rtx|fnm)\//, /\/\.proto\//, /\/\.nvm\//, /\/\.volta\//, /\/\.fnm\//,
  /\/\.bum\//, /\/\.bvm\//, /\/Cellar\//, /\/nix\/store\//,
];

export function isVersionManagedPath(p: string): boolean {
  return VERSIONED.some((re) => re.test(p));
}

/**
 * The Bun the job runs. The stable candidates, in order: $BUN_INSTALL/bin/bun, ~/.bun/bin/bun (the official
 * installer, which `bun upgrade` replaces in place), /opt/homebrew/bin/bun, /usr/local/bin/bun (Homebrew's stable
 * symlinks). The job starts each project's pinned croft on it, so an old one left behind must not win:
 * 1. the first stable candidate at least as new as the running Bun (and croft's floor, engines.bun);
 * 2. else the running Bun, when its own path is stable;
 * 3. else the first stable candidate croft still runs on (at least the floor), rather than a version manager's
 *    path that vanishes on upgrade;
 * 4. else the running Bun (unstable).
 * The running Bun's own path is never run to ask; every other candidate is asked once (`<bun> --version`).
 */
export function pickBun(home: CroftHome, o: JobOptions = {}): BunChoice {
  const env = o.env ?? process.env;
  const exists = o.exists ?? existsSync;
  const probe = o.bunVersion ?? bunVersionOf;
  const self = o.execPath ?? process.execPath;
  const running = o.runningVersion ?? Bun.version;
  const want = versionAtLeast(running, BUN_FLOOR) ? running : BUN_FLOOR;
  const candidates = [...new Set([
    ...(env.BUN_INSTALL ? [join(resolve(env.BUN_INSTALL), "bin", "bun")] : []),
    join(home.userHome, ".bun", "bin", "bun"),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
  ])].filter((c) => exists(c));
  const asked = new Map<string, string | null>();
  const versionOf = (c: string): string | null => {
    if (sameFile(c, self)) return running;
    if (!asked.has(c)) asked.set(c, probe(c));
    return asked.get(c)!;
  };
  const choose = (path: string, stable: boolean, version: string | null): BunChoice => ({
    path, stable, version,
    skipped: candidates.filter((c) => c !== path && asked.has(c)).map((c) => ({ path: c, version: asked.get(c)! })),
  });
  const atLeast = (floor: string) => candidates.find((c) => {
    const v = versionOf(c);
    return v !== null && versionAtLeast(v, floor);
  });
  const current = atLeast(want);
  if (current !== undefined) return choose(current, true, versionOf(current));
  if (!isVersionManagedPath(self)) return choose(self, true, running);
  const older = atLeast(BUN_FLOOR);
  if (older !== undefined) return choose(older, true, versionOf(older));
  return choose(self, false, running);
}

/** `<bun> --version`: the version it prints, or null when it does not run, fails, or prints something else. */
export function bunVersionOf(path: string): string | null {
  try {
    const r = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 5000, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
    if (r.status !== 0 || typeof r.stdout !== "string") return null;
    return /^\s*v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?)\s*$/.exec(r.stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Whether two paths are the same file: the same path, or the same real file. */
function sameFile(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** PATH for the job and the ticks it starts: Bun's folder first, then the system's. */
export function jobPath(bunDir: string, platform: NodeJS.Platform): string {
  const dirs = [bunDir, ...(platform === "darwin" ? ["/opt/homebrew/bin"] : []), "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [...new Set(dirs)].join(":");
}

// ---- the job ----

/** Write the tick script and make sure the OS job runs it every minute. */
export function ensureJob(runner: OsRunner, home: CroftHome, o: JobOptions = {}): JobResult {
  const platform = o.platform ?? process.platform;
  const kind = jobKind(platform);
  refuseRealHome(home, o);
  const bun = pickBun(home, o);
  const tick = writeTickScript(home);
  const changed = kind === "launchd" ? ensureLaunchAgent(runner, home, bun.path, o) : ensureCrontab(runner, home, bun.path);
  return { kind, label: home.jobLabel, file: kind === "launchd" ? plistPath(home) : null, bun, changed, tickScriptChanged: tick.changed };
}

/** Remove the OS job (the tick script and registry stay). `removed` is false when there was none. */
export function removeJob(runner: OsRunner, home: CroftHome, o: JobOptions = {}): { kind: JobResult["kind"]; removed: boolean } {
  const kind = jobKind(o.platform ?? process.platform);
  refuseRealHome(home, o);
  if (kind === "launchd") {
    const booted = runner.exec([LAUNCHCTL, "bootout", serviceTarget(home, o)]).status === 0;
    const file = plistPath(home);
    const had = existsSync(file);
    rmSync(file, { force: true });
    return { kind, removed: booted || had };
  }
  const table = readCrontab(runner);
  if (!table.split("\n").includes(beginMarker(home.jobLabel))) return { kind, removed: false };
  writeCrontab(runner, upsertCronBlock(table, home.jobLabel, null));
  return { kind, removed: true };
}

/** What is installed now, for status and doctor. Runs `launchctl print` on macOS and `crontab -l` on Linux. */
export function inspectJob(runner: OsRunner, home: CroftHome, o: JobOptions = {}): JobInspection {
  const kind = jobKind(o.platform ?? process.platform);
  const exists = o.exists ?? existsSync;
  if (kind === "launchd") {
    const bun = plistBun(home);
    const loaded = runner.exec([LAUNCHCTL, "print", serviceTarget(home, o)]).status === 0;
    return { kind, installed: existsSync(plistPath(home)), loaded, bun, bunExists: bun !== null && exists(bun) };
  }
  const bun = cronBun(readCrontab(runner), home.jobLabel);
  return { kind, installed: bun !== null, loaded: null, bun, bunExists: bun !== null && exists(bun) };
}

/** The Bun the installed job runs, or null: from the plist on macOS, and on Linux from `crontab -l` when a
 *  runner is given. */
export function installedBunPath(home: CroftHome, o: { platform?: NodeJS.Platform; runner?: OsRunner } = {}): string | null {
  const platform = o.platform ?? process.platform;
  if (platform === "darwin") return plistBun(home);
  if (platform !== "linux" || !o.runner) return null;
  try {
    return cronBun(readCrontab(o.runner), home.jobLabel);
  } catch {
    return null;
  }
}

function jobKind(platform: NodeJS.Platform): JobResult["kind"] {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "crontab";
  throw new CroftError("INSTALL_FAILED", {
    message: `croft's scheduler job needs macOS (launchd) or Linux (cron); this is ${platform}`,
    hint: "run croft on Linux under WSL: croft schedule on --no-os-job, then keep croft serve running, which ticks every minute",
    fix: { kind: "manual", description: "use croft schedule on --no-os-job and keep croft serve running" },
    details: { platform },
  });
}

/** Tests must never install a job for the real user: with CROFT_FORBID_OS_JOBS=1, a home or croft folder that
 *  is the real one (from the password database, not HOME) is refused before anything is written. */
function refuseRealHome(home: CroftHome, o: JobOptions): void {
  const env = o.env ?? process.env;
  if (env.CROFT_FORBID_OS_JOBS !== "1") return;
  let real: string;
  try {
    real = userInfo().homedir;
  } catch {
    return;
  }
  if (resolve(home.userHome) === resolve(real) || resolve(home.dir) === join(resolve(real), ".croft")) {
    throw new CroftError("INTERNAL_ERROR", {
      message: `refusing to install the scheduler job for the real user (${real}): CROFT_FORBID_OS_JOBS=1 (tests must use a fake HOME and CROFT_HOME)`,
      hint: "report this croft bug",
    });
  }
}

// ---- launchd ----

export function plistPath(home: CroftHome): string {
  return join(home.userHome, "Library", "LaunchAgents", `${home.jobLabel}.plist`);
}

function uidOf(o: JobOptions): number {
  const uid = o.uid ?? process.getuid?.();
  if (uid === undefined) throw new CroftError("INTERNAL_ERROR", { message: "cannot tell the user id for launchd's gui domain", hint: "report this croft bug" });
  return uid;
}

function serviceTarget(home: CroftHome, o: JobOptions): string {
  return `gui/${uidOf(o)}/${home.jobLabel}`;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** The LaunchAgent. AbandonProcessGroup keeps launchd from killing what the tick started when it exits (the
 *  project ticks run in their own sessions anyway). */
export function plistXml(i: { label: string; bun: string; home: CroftHome; platform?: NodeJS.Platform }): string {
  const s = (v: string) => `<string>${xml(v)}</string>`;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `\t<key>Label</key>`,
    `\t${s(i.label)}`,
    `\t<key>ProgramArguments</key>`,
    `\t<array>`,
    `\t\t${s(i.bun)}`,
    `\t\t${s("--no-env-file")}`,
    `\t\t${s(i.home.tickScript)}`,
    `\t</array>`,
    `\t<key>EnvironmentVariables</key>`,
    `\t<dict>`,
    `\t\t<key>HOME</key>`,
    `\t\t${s(i.home.userHome)}`,
    `\t\t<key>PATH</key>`,
    `\t\t${s(jobPath(dirname(i.bun), i.platform ?? "darwin"))}`,
    `\t</dict>`,
    `\t<key>StartInterval</key>`,
    `\t<integer>60</integer>`,
    `\t<key>RunAtLoad</key>`,
    `\t<true/>`,
    `\t<key>AbandonProcessGroup</key>`,
    `\t<true/>`,
    `\t<key>StandardOutPath</key>`,
    `\t${s(i.home.tickLog)}`,
    `\t<key>StandardErrorPath</key>`,
    `\t${s(i.home.tickLog)}`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

function plistBun(home: CroftHome): string | null {
  let text: string;
  try {
    text = readFileSync(plistPath(home), "utf8");
  } catch {
    return null;
  }
  const m = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(text);
  return m ? unxml(m[1]!) : null;
}

/** Bootstrap attempts, for launchd still tearing down the job just booted out ("5: Input/output error"). */
const BOOTSTRAP_ATTEMPTS = 5;

function ensureLaunchAgent(runner: OsRunner, home: CroftHome, bun: string, o: JobOptions): boolean {
  const file = plistPath(home);
  const text = plistXml({ label: home.jobLabel, bun, home, platform: "darwin" });
  let existing: string | null = null;
  try {
    existing = readFileSync(file, "utf8");
  } catch { /* not installed */ }
  const target = serviceTarget(home, o);
  if (existing === text) {
    if (runner.exec([LAUNCHCTL, "print", target]).status === 0) return false;
  } else {
    mkdirSync(dirname(file), { recursive: true });
    // launchd refuses a plist that is group- or world-writable.
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o644 });
    renameSync(tmp, file);
    runner.exec([LAUNCHCTL, "bootout", target]);   // the old job, if any; "not loaded" is fine
  }
  bootstrap(runner, home, file, o);
  return true;
}

function bootstrap(runner: OsRunner, home: CroftHome, file: string, o: JobOptions): void {
  const domain = `gui/${uidOf(o)}`;
  const argv = [LAUNCHCTL, "bootstrap", domain, file];
  const sleep = o.sleep ?? ((ms: number) => Bun.sleepSync(ms));
  let r: ExecResult = { status: null, stdout: "", stderr: "" };
  for (let attempt = 1; attempt <= BOOTSTRAP_ATTEMPTS; attempt++) {
    r = runner.exec(argv);
    if (r.status === 0) return;
    const text = `${r.stderr}\n${r.stdout}`;
    const transient = r.status === 5 || r.status === 17 || r.status === 37 || /Input\/output error|already|in progress/i.test(text);
    if (!transient || attempt === BOOTSTRAP_ATTEMPTS) break;
    sleep(200 * attempt);
    runner.exec([LAUNCHCTL, "bootout", `${domain}/${home.jobLabel}`]);
  }
  const said = (r.stderr.trim() || r.stdout.trim() || `exit ${r.status}`).replace(/\s+/g, " ");
  const noGui = r.status === 125 || /Domain does not support|Could not find domain/i.test(said);
  throw new CroftError("INSTALL_FAILED", {
    message: `croft could not load its scheduler job: ${argv.join(" ")} failed: ${said}`,
    hint: `${noGui
      ? "launchd's gui domain exists only while you are logged in to the Mac's desktop (not only over SSH); log in there and run croft schedule on again"
      : `run ${argv.join(" ")} in a terminal to see launchd's reason, then croft schedule on again`}; or schedule without the OS job: croft schedule on --no-os-job, and keep croft serve running`,
    fix: { kind: "manual", description: noGui ? "log in to the Mac's desktop session, then run croft schedule on again" : "fix what launchctl reports, then run croft schedule on again", requiresHuman: true },
    details: { job: "launchd", label: home.jobLabel, plist: file, command: argv, status: r.status, stderr: r.stderr.trim() },
  });
}

// ---- crontab ----

const beginMarker = (label: string) => `# croft:${label} begin`;
const endMarker = (label: string) => `# croft:${label} end`;

/** A word for the crontab command line: sh single quotes when needed, and % escaped (cron turns a bare %
 *  into a newline). */
function cronWord(s: string): string {
  const quoted = /^[A-Za-z0-9_\/.,:@+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
  return quoted.replace(/%/g, "\\%");
}

/** croft's crontab block: the markers and one line that runs the tick script every minute. */
export function cronBlock(i: { label: string; bun: string; home: CroftHome }): string {
  return [
    beginMarker(i.label),
    `* * * * * ${cronWord(i.bun)} --no-env-file ${cronWord(i.home.tickScript)} >> ${cronWord(i.home.tickLog)} 2>&1`,
    endMarker(i.label),
  ].join("\n");
}

/** The header some `crontab -l` versions print, which must not be installed back. */
const CRON_HEADER = /^# (DO NOT EDIT THIS FILE|\(.* installed on |\(Cron version)/;

function stripHeader(table: string): string {
  const lines = table.split("\n");
  let i = 0;
  while (i < 3 && i < lines.length && CRON_HEADER.test(lines[i]!)) i++;
  return lines.slice(i).join("\n");
}

/**
 * The crontab with `label`'s block replaced by `block` (null removes it), at the position of the first old
 * block or else appended. Every other line is kept byte for byte. A begin marker without its end drops only
 * the lines after it that run croft (`--no-env-file`), up to the first other line.
 */
export function upsertCronBlock(table: string, label: string, block: string | null): string {
  const lines = stripHeader(table).split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();   // the final newline
  const out: string[] = [];
  let placed = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== beginMarker(label)) {
      out.push(lines[i]!);
      continue;
    }
    const end = lines.indexOf(endMarker(label), i + 1);
    if (end >= 0) i = end;
    else while (i + 1 < lines.length && lines[i + 1]!.includes("--no-env-file")) i++;
    if (!placed && block !== null) out.push(block);
    placed = true;
  }
  if (!placed && block !== null) out.push(block);
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}

/** The first shell word after the five time fields of croft's line, unquoted. */
function cronBun(table: string, label: string): string | null {
  const lines = table.split("\n");
  const at = lines.indexOf(beginMarker(label));
  const line = at >= 0 ? lines[at + 1] : undefined;
  if (line === undefined) return null;
  const m = /^\s*(?:\S+\s+){5}(.*)$/.exec(line);
  if (!m) return null;
  const rest = m[1]!.replace(/\\%/g, "%");
  if (!rest.startsWith("'")) return rest.split(/\s+/)[0] ?? null;
  let word = "";
  let i = 1;
  for (;;) {
    const close = rest.indexOf("'", i);
    if (close < 0) return null;
    word += rest.slice(i, close);
    if (rest.startsWith("\\''", close + 1)) {
      word += "'";
      i = close + 4;
      continue;
    }
    return word;
  }
}

function readCrontab(runner: OsRunner): string {
  const r = runner.exec([CRONTAB, "-l"]);
  if (r.status === 0) return r.stdout;
  if (r.status !== null && /no crontab/i.test(r.stderr)) return "";
  throw cronFailure([CRONTAB, "-l"], r);
}

function writeCrontab(runner: OsRunner, table: string): void {
  const r = runner.exec([CRONTAB, "-"], { input: table });
  if (r.status !== 0) throw cronFailure([CRONTAB, "-"], r);
}

function cronFailure(argv: string[], r: ExecResult): CroftError {
  const said = (r.stderr.trim() || r.stdout.trim() || `exit ${r.status}`).replace(/\s+/g, " ");
  const missing = r.status === null;
  return new CroftError("INSTALL_FAILED", {
    message: missing
      ? `croft could not run crontab to install its scheduler job (${said})`
      : `croft could not install its scheduler job: ${argv.join(" ")} failed: ${said}`,
    hint: `${missing
      ? "install cron (Debian and Ubuntu: sudo apt install cron; Fedora: sudo dnf install cronie) and make sure it is running, then run croft schedule on again"
      : "fix what crontab reports, then run croft schedule on again"}; or schedule without the OS job: croft schedule on --no-os-job, and keep croft serve running`,
    fix: { kind: "manual", description: missing ? "install and start cron, then run croft schedule on again" : "fix what crontab reports, then run croft schedule on again", requiresHuman: true },
    details: { job: "crontab", command: argv, status: r.status, stderr: r.stderr.trim() },
  });
}

function ensureCrontab(runner: OsRunner, home: CroftHome, bun: string): boolean {
  const table = readCrontab(runner);
  const next = upsertCronBlock(table, home.jobLabel, cronBlock({ label: home.jobLabel, bun, home }));
  if (next === stripHeader(table)) return false;   // the header some `crontab -l` print is not a change
  writeCrontab(runner, next);
  return true;
}
