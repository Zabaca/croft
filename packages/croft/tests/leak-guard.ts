// The leak guard (DESIGN.md §10 "Test strategy"): a test file that leaves a process behind fails, by name.
//
// tests/preload.ts appends `await import("<this folder>/file-guard.ts?f=<file>")` to every test file as it loads. file-guard.ts
// registers an afterAll at the END of the file's own hooks (Bun runs a file's afterAll hooks in the order they were registered, and a
// hook registered from the preload alone would belong to the whole run, not to a file), and that afterAll calls assertNoLeaks() here.
//
// What counts as left behind, once the file's own afterAll hooks have run:
//  - a process that is a descendant of the test process and was not there when the file loaded: a croft serve, a croft maintain, a
//    Postgres, the S3 store, a Quack listener or a readers' process that a test started and did not stop;
//  - a process that was reparented away from its test (a detached croft run or serve whose parent exited) and runs this checkout's
//    code (a command line naming bin/, src/, tests/ or evals/ of this package's folder) with no `bun test` among its ancestors.
//    Another checkout's processes carry another folder, and a process under another live `bun test` (two suites at once) belongs to
//    that run. A reparented process cannot be told from one that a second suite of THIS checkout started (or that a developer started
//    from it meanwhile), so while another `bun test` runs with this package as its working directory the guard looks at descendants
//    only (CROFT_LEAK_GUARD_ORPHANS=always looks at both, for the guard's own test): one suite per checkout gets the whole check.
// A process that is still exiting gets LEAK_GRACE_MS to finish, polled, never slept: a test's kill() does not wait for the exit.
// What is found is killed (so one leak does not pile up, or hold a port for the files after it) and named in the failure.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export interface Proc { pid: number; ppid: number; stat: string; command: string }

/** This package's folder: what a croft process of this checkout names in its command line. */
export const PACKAGE_ROOT = resolve(import.meta.dir, "..");

/** How long a process that was told to stop gets to be gone (CROFT_LEAK_GRACE_MS overrides it, for the guard's own test). */
export const LEAK_GRACE_MS = Number(process.env.CROFT_LEAK_GRACE_MS) || 5000;

/** Every process on the machine: `ps -A -ww -o pid=,ppid=,stat=,command=`, the same on macOS and Linux. */
export function parseProcessTable(text: string): Proc[] {
  const out: Proc[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), stat: m[3]!, command: m[4]!.trim() });
  }
  return out;
}

export function processTable(): Proc[] {
  const r = spawnSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,stat=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`the leak guard could not list processes: ${r.error?.message ?? r.stderr}`);
  const ownPs = r.pid;
  return parseProcessTable(r.stdout).filter((p) => p.pid !== ownPs);
}

const alive = (p: Proc) => !p.stat.startsWith("Z"); // a zombie is dead; only its parent has not collected it

/** The processes below `root`, any depth, itself excluded. */
export function descendantsOf(root: number, table: Proc[]): Proc[] {
  const kids = new Map<number, Proc[]>();
  for (const p of table) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  const out: Proc[] = [];
  const queue = [root];
  for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
    for (const c of kids.get(pid) ?? []) {
      out.push(c);
      queue.push(c.pid);
    }
  }
  return out;
}

/** Does a `bun test` run sit among the ancestors of `p`? Then the process belongs to that run (and its own guard), not to a stray. */
function underATestRun(p: Proc, byPid: Map<number, Proc>): boolean {
  const seen = new Set<number>();
  for (let cur = byPid.get(p.ppid); cur && !seen.has(cur.pid); cur = byPid.get(cur.ppid)) {
    seen.add(cur.pid);
    if (/\bbun\b[^\n]*\btest\b/.test(cur.command)) return true;
  }
  return false;
}

/**
 * The processes a test file left running: `table` is the machine now, `before` the pids that existed when the file loaded,
 * `self` the test process.
 */
export function findLeaks(table: Proc[], before: ReadonlySet<number>, self: number, packageRoot = PACKAGE_ROOT): Proc[] {
  const ours = new RegExp(`${packageRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(?:bin|src|tests|evals)/`);
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const mine = new Set(descendantsOf(self, table).map((p) => p.pid));
  return table.filter((p) => alive(p) && !before.has(p.pid) && p.pid !== self && (mine.has(p.pid) || (ours.test(p.command) && !underATestRun(p, byPid))));
}

/** What a leaked process is, for the failure: its pid and the start of its command line. */
export function describeProc(p: Proc): string {
  const cmd = p.command.length > 400 ? `${p.command.slice(0, 400)}...` : p.command;
  return `pid ${p.pid} (parent ${p.ppid}): ${cmd}`;
}

function killAll(procs: Proc[]): void {
  for (const p of procs) {
    try {
      process.kill(p.pid, "SIGKILL");
    } catch { /* already gone */ }
  }
}

/** The pids on the machine now: what a file that is loading did not start. */
export function pidsNow(): Set<number> {
  return new Set(processTable().map((p) => p.pid));
}

/** The working directory of a process, or null when it cannot be told (lsof, or /proc on Linux). */
function cwdOf(pid: number): string | null {
  if (process.platform === "linux") {
    const r = spawnSync("readlink", [`/proc/${pid}/cwd`], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  }
  const r = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  return /^n(.+)$/m.exec(r.stdout)?.[1] ?? null;
}

/** Is another `bun test` (not this run, its ancestors or its descendants) running with this package as its working directory? */
export function anotherRunHere(table: Proc[], self: number): boolean {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const mine = new Set(descendantsOf(self, table).map((p) => p.pid));
  const ancestors = new Set<number>();
  for (let cur = byPid.get(self); cur && !ancestors.has(cur.pid); cur = byPid.get(cur.ppid)) ancestors.add(cur.pid);
  return table.some((p) => {
    if (p.pid === self || mine.has(p.pid) || ancestors.has(p.pid) || !alive(p) || !/\bbun\b[^\n]*\btest\b/.test(p.command)) return false;
    const cwd = cwdOf(p.pid);
    return cwd !== null && (cwd === PACKAGE_ROOT || cwd.startsWith(`${PACKAGE_ROOT}/`));
  });
}

/** What the file left now: descendants always; reparented processes too unless another run of this checkout makes them ambiguous. */
function currentLeaks(before: ReadonlySet<number>, self: number): Proc[] {
  const table = processTable();
  const found = findLeaks(table, before, self);
  const mine = new Set(descendantsOf(self, table).map((p) => p.pid));
  if (found.every((p) => mine.has(p.pid)) || process.env.CROFT_LEAK_GUARD_ORPHANS === "always") return found;
  return anotherRunHere(table, self) ? found.filter((p) => mine.has(p.pid)) : found;
}

/** Throw when the file left a process running (after the grace), killing what it left. `file` is named in the failure. */
export async function assertNoLeaks(file: string, before: ReadonlySet<number>, o: { graceMs?: number; self?: number } = {}): Promise<void> {
  const self = o.self ?? process.pid;
  const started = Date.now();
  const deadline = started + (o.graceMs ?? LEAK_GRACE_MS);
  let leaks = currentLeaks(before, self);
  const first = leaks;
  while (leaks.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    leaks = currentLeaks(before, self);
  }
  // CROFT_LEAK_GUARD_REPORT=1 says which files still had a process running after their last test and were let off because it was gone within the grace.
  if (leaks.length === 0 && first.length > 0 && process.env.CROFT_LEAK_GUARD_REPORT === "1") {
    console.warn(`leak guard: ${file}: ${first.length} process${first.length === 1 ? "" : "es"} still exiting after the last test, gone after ${Date.now() - started} ms: ${first.map((p) => p.command.slice(-260)).join(" | ")}`);
  }
  if (leaks.length === 0) return;
  killAll(leaks);
  throw new Error(
    `${file} left ${leaks.length} process${leaks.length === 1 ? "" : "es"} running after its last test:\n${leaks.map((p) => `  ${describeProc(p)}`).join("\n")}\n` +
      "Stop what a test starts before it ends: await the exit of the child (kill it in afterEach/afterAll, or in a finally), or close the server that owns it. The guard killed what it found (DESIGN.md §10 \"Test strategy\", the rules against flaking).",
  );
}
