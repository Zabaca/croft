// End-to-end harness: the REAL croft CLI (bun <package>/bin/croft.mjs) in temp projects made by
// `croft init --no-install`, with node_modules/@zabaca/croft linked to this package, as a user's project
// would have it after `bun install`. Every command runs in its own process with stdin ignored, so it is off
// a TTY exactly as Claude Code runs it. A Bun.serve mock API stands in for GitHub- and Stripe-like services.
//
// Nothing here imports croft's source: assertions go through --json envelopes, exit codes and the files a
// user can see.
//
// Run: `bun test tests/e2e` from packages/croft (it is also part of the whole `bun test`). Journeys that hit a
// reported product bug keep their assertions in bugTest() (test.failing); `CROFT_E2E_BUGS=1 bun test tests/e2e`
// runs those as plain tests to show each bug's actual failure.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Server } from "bun";
import { test } from "bun:test";

/** packages/croft */
export const PKG = resolve(import.meta.dir, "../..");
/** The bin a user's `croft` ends up running. */
export const CROFT_BIN = join(PKG, "bin", "croft.mjs");

/**
 * A test for a reported product bug: it is expected to fail (test.failing) until the bug is fixed, and then
 * starts failing the suite as a reminder to turn it into a plain test(). CROFT_E2E_BUGS=1 runs these as plain
 * tests, to see each bug's actual failure.
 */
export const bugTest: typeof test.failing = process.env.CROFT_E2E_BUGS === "1" ? test : test.failing;

// ---------------------------------------------------------------------------------------------------------
// Processes

export interface CliResult {
  args: string[];
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** The --json envelope, when stdout held one. */
  json?: Envelope;
  ms: number;
}

// Loosely typed on purpose: the tests assert the shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Envelope = Record<string, any>;

const spawned = new Set<ReturnType<typeof Bun.spawn>>();
const temps: string[] = [];

/** A clean environment: no .env values from this process, no colors, fast retries between attempts. */
export function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    NO_COLOR: "1",
    // init detects the project time zone from the machine; journeys assume Los Angeles (CI runners are UTC).
    TZ: "America/Los_Angeles",
    CROFT_RETRY_DELAYS: "50,100",
    // The tripwires of tests/preload.ts: no journey installs OS jobs or shows notifications.
    CROFT_FORBID_OS_JOBS: "1",
    CROFT_NOTIFY_DRY: "1",
    ...extra,
  };
}

export interface Running {
  proc: ReturnType<typeof Bun.spawn>;
  done: Promise<CliResult>;
}

/** Start `croft <args>` in `cwd` (off a TTY). */
export function startCroft(cwd: string, args: string[], o: { env?: Record<string, string>; stdin?: string } = {}): Running {
  const started = performance.now();
  const proc = Bun.spawn([process.execPath, CROFT_BIN, ...args], {
    cwd, env: baseEnv(o.env), stdin: o.stdin !== undefined ? new TextEncoder().encode(o.stdin) : "ignore", stdout: "pipe", stderr: "pipe",
  });
  spawned.add(proc);
  const done = (async (): Promise<CliResult> => {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()]);
    const code = await proc.exited;
    spawned.delete(proc);
    let json: Envelope | undefined;
    if (args.includes("--json") && stdout.trim()) {
      try {
        json = JSON.parse(stdout) as Envelope;
      } catch { /* the test reports stdout */ }
    }
    return { args, code: proc.signalCode ? null : code, signal: proc.signalCode ?? null, stdout, stderr, ...(json ? { json } : {}), ms: performance.now() - started };
  })();
  return { proc, done };
}

export function croftIn(cwd: string, args: string[], o: { env?: Record<string, string>; stdin?: string } = {}): Promise<CliResult> {
  return startCroft(cwd, args, o).done;
}

/** A readable one-line account of a result, for assertion messages. */
export function show(r: CliResult): string {
  return `croft ${r.args.join(" ")} → exit ${r.code}${r.signal ? ` (${r.signal})` : ""}\nstdout: ${r.stdout.slice(0, 4000)}\nstderr: ${r.stderr.slice(0, 2000)}`;
}

export async function until<T>(fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, timeoutMs = 20_000, pollMs = 50): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for a condition");
    await Bun.sleep(pollMs);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Projects

export function tempDir(prefix = "croft-e2e-"): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
}

export class Project {
  constructor(readonly root: string) {}

  croft(args: string[], o: { env?: Record<string, string>; stdin?: string } = {}): Promise<CliResult> {
    return croftIn(this.root, args, o);
  }

  start(args: string[], o: { env?: Record<string, string> } = {}): Running {
    return startCroft(this.root, args, o);
  }

  /** `croft <args> --json`, asserting that stdout was one envelope. */
  async json(args: string[], o: { env?: Record<string, string> } = {}): Promise<CliResult & { json: Envelope }> {
    const r = await this.croft([...args, "--json"], o);
    if (!r.json) throw new Error(`no JSON envelope\n${show(r)}`);
    return r as CliResult & { json: Envelope };
  }

  /** Rows of `croft query <sql> --json` (all of them: --limit 100000). */
  async rows(sql: string): Promise<Record<string, unknown>[]> {
    const r = await this.json(["query", sql, "--limit", "100000"]);
    if (r.code !== 0) throw new Error(`query failed\n${show(r)}`);
    return r.json.data.rows as Record<string, unknown>[];
  }

  write(rel: string, text: string): void {
    const p = join(this.root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }

  read(rel: string): string {
    return readFileSync(join(this.root, rel), "utf8");
  }

  exists(rel: string): boolean {
    return existsSync(join(this.root, rel));
  }

  remove(rel: string): void {
    unlinkSync(join(this.root, rel));
  }

  /**
   * Replace `from` with `to` in a project file, as an agent's Edit tool does: `from` must occur exactly once (or
   * pass `all` to replace every occurrence, at least one). Throws otherwise, so a template that changed under a
   * journey fails at the edit, not three steps later.
   */
  edit(rel: string, from: string, to: string, o: { all?: boolean } = {}): void {
    const text = this.read(rel);
    const n = text.split(from).length - 1;
    if (n === 0 || (n > 1 && !o.all)) throw new Error(`${rel}: expected ${o.all ? "at least one" : "exactly one"} ${JSON.stringify(from)}, found ${n}\n${text}`);
    this.write(rel, o.all ? text.split(from).join(to) : text.replace(from, () => to));
  }

  /** Append NAME=value to .env, as a user would. */
  secret(name: string, value: string): void {
    const p = join(this.root, ".env");
    const before = existsSync(p) ? readFileSync(p, "utf8") : "";
    writeFileSync(p, `${before}${before.endsWith("\n") || before === "" ? "" : "\n"}${name}=${value}\n`);
  }

  get stateDir(): string {
    return join(this.root, ".croft");
  }
}

/**
 * `croft init <dir> --no-install` from a folder outside any project, then node_modules/@zabaca/croft →
 * this package (what `bun install` would provide). Returns the project.
 */
export async function initProject(name = "proj"): Promise<{ project: Project; init: CliResult }> {
  const base = tempDir();
  const target = join(base, name);
  const init = await croftIn(base, ["init", target, "--no-install", "--json"]);
  if (init.code !== 0) throw new Error(`croft init failed\n${show(init)}`);
  mkdirSync(join(target, "node_modules", "@zabaca"), { recursive: true });
  symlinkSync(PKG, join(target, "node_modules", "@zabaca", "croft"));
  return { project: new Project(target), init };
}

/** Kill whatever croft processes a test left behind and delete the temp folders. */
export async function cleanupAll(): Promise<void> {
  for (const p of spawned) {
    try {
      p.kill("SIGKILL");
    } catch { /* gone */ }
  }
  spawned.clear();
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** Is a pid alive (signal 0)? */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------
// The mock API

export interface Req {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  at: number;
}

export type Handler = (req: Request, url: URL, log: Req) => Response | Promise<Response>;

export interface MockApi {
  url: string;
  log: Req[];
  route(path: string, h: Handler): void;
  requests(path: string): Req[];
  stop(): void;
}

export function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
}

/** JSON text as is (for integers beyond 2^53, which JSON.stringify cannot write). */
export function rawJson(text: string, init: ResponseInit = {}): Response {
  return new Response(text, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
}

export function mockApi(): MockApi {
  const routes = new Map<string, Handler>();
  const log: Req[] = [];
  const server: Server<undefined> = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const entry: Req = {
        method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams),
        headers: Object.fromEntries(req.headers), at: Date.now(),
      };
      log.push(entry);
      const h = routes.get(u.pathname);
      if (!h) return new Response("not found", { status: 404 });
      return h(req, u, entry);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    log,
    route: (path, h) => void routes.set(path, h),
    requests: (path) => log.filter((r) => r.path === path),
    stop: () => server.stop(true),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Small helpers for assertions

/** The codes of an envelope's problems (and of its steps' errors). */
export function codes(env: Envelope): string[] {
  const out = (env.problems ?? []).map((p: { code: string }) => p.code);
  for (const s of env.data?.steps ?? []) if (s.error?.code) out.push(s.error.code);
  return out;
}

/** The problem with this code, from problems[] or a step's error. */
export function findProblem(env: Envelope, code: string): Record<string, any> | undefined {
  return (env.problems ?? []).find((p: { code: string }) => p.code === code)
    ?? (env.data?.steps ?? []).map((s: { error?: { code: string } }) => s.error).find((e: { code: string } | undefined) => e?.code === code);
}

/** The step of `asset` in a run envelope, or in the run a `croft confirm` carried out (data.result). */
export function stepOf(env: Envelope, asset: string): Envelope {
  const steps = (env.data?.steps ?? env.data?.result?.steps ?? []) as Envelope[];
  const s = steps.find((x) => x.asset === asset);
  if (!s) throw new Error(`no step for ${asset} in ${JSON.stringify(env).slice(0, 2000)}`);
  return s;
}

/** The next[] commands that destroy or replace data (§4.3: they never appear there; only a person runs them). */
export function destructiveNext(env: Envelope): string[] {
  return ((env.next ?? []) as { command: string }[]).map((n) => n.command)
    .filter((c) => /croft confirm|--rebuild|--allow-shrink|croft delete|croft restore/.test(c));
}

/** The versions of `asset` in a project's trash (.croft/trash/<asset>/*.duckdb), oldest first. */
export function trashVersions(p: Project, asset: string): string[] {
  const dir = join(p.stateDir, "trash", asset);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".duckdb")).sort() : [];
}

export const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$/;
export const RUN_ID = /^r_\d{4}_\d{4}_[0-9a-z]{4}$/;

/** Assert the §4.3 envelope keys. */
export function envelopeKeys(env: Envelope): string[] {
  return Object.keys(env).sort();
}

// ---------------------------------------------------------------------------------------------------------
// Scheduling and serving (phase 3)

let labels = 0;

/**
 * The environment for a journey that turns scheduling on: a temp HOME with its own croft folder (the registry,
 * projects.json, and the per-user tick log live there) and a job label no other test uses. Every journey also runs
 * with the tripwires of baseEnv(), and turns scheduling on with `croft schedule on --no-os-job`, so no OS job is
 * ever installed; the real ~/.croft is never read or written.
 */
export function schedulerEnv(): { HOME: string; CROFT_HOME: string; CROFT_JOB_LABEL: string } {
  const home = tempDir("croft-home-");
  mkdirSync(join(home, ".croft"), { recursive: true });
  return { HOME: home, CROFT_HOME: join(home, ".croft"), CROFT_JOB_LABEL: `dev.croft.e2e.${process.pid}.${++labels}` };
}

/**
 * CROFT_NOW for a wall-clock time on one day in the project zone (America/Los_Angeles, -07:00 in June).
 *
 * The day is years away from the real clock on purpose: runs.sqlite (runs, steps), fire times, heartbeats and
 * last_fire_at all follow CROFT_NOW, so a stamp taken from the real clock by mistake stands out.
 */
export function laTime(hour: number, minute = 0): string {
  return `2036-06-10T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00-07:00`;
}

/** The JSON lines of a file ([] when it does not exist). */
export function ndjson(path: string): Envelope[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Envelope);
}

/** @duckdb/node-api, for programs that are not croft (a GUI holding a file, a notebook reading one). */
export const DUCKDB_API = Bun.fileURLToPath(import.meta.resolve("@duckdb/node-api"));

const DUCKDB_READ = `const { DuckDBInstance } = require(process.env.DUCKDB_API);
(async () => {
  const db = await DuckDBInstance.create(process.env.DB_PATH, { access_mode: "READ_ONLY" });
  const c = await db.connect();
  const out = {};
  for (const [name, sql] of JSON.parse(process.env.QUERIES)) out[name] = (await c.runAndReadAll(sql)).getRowObjectsJson();
  c.disconnectSync();
  db.closeSync();
  process.stdout.write(JSON.stringify(out));
})().catch((e) => { console.error(e.message); process.exit(1); });`;

/**
 * Open a DuckDB file read-only in a separate process (not croft), run named queries and close it: rows as
 * @duckdb/node-api's getRowObjectsJson() gives them (integers as strings).
 */
export function readDuckDb(path: string, queries: Record<string, string>): Record<string, Record<string, unknown>[]> {
  const r = Bun.spawnSync([process.execPath, "-e", DUCKDB_READ], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", TMPDIR: process.env.TMPDIR ?? "/tmp", DUCKDB_API, DB_PATH: path, QUERIES: JSON.stringify(Object.entries(queries)) },
    stdout: "pipe", stderr: "pipe", timeout: 30_000,
  });
  if (r.exitCode !== 0) throw new Error(`reading ${path} failed: ${r.stderr.toString()}`);
  return JSON.parse(r.stdout.toString()) as Record<string, Record<string, unknown>[]>;
}

// Holds the file open (read-write, as the DuckDB UI or DBeaver do) and answers one SQL line on stdin with a JSON
// line on stdout. The instance stays referenced from globalThis: an unreferenced instance is collected, which
// releases the file. It exits by itself after 90 s, so a test that times out leaves nothing behind.
const DUCKDB_HOLDER = `const { DuckDBInstance } = require(process.env.DUCKDB_API);
setTimeout(() => process.exit(0), 90000);
(async () => {
  const db = await DuckDBInstance.create(process.env.DB_PATH);
  const c = await db.connect();
  globalThis.keep = [db, c];
  let buffer = "";
  process.stdin.on("data", async (chunk) => {
    buffer += chunk;
    for (let nl = buffer.indexOf("\\n"); nl !== -1; nl = buffer.indexOf("\\n")) {
      const sql = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      try {
        console.log(JSON.stringify({ rows: (await c.runAndReadAll(sql)).getRowObjectsJson() }));
      } catch (e) {
        console.log(JSON.stringify({ error: e.message }));
      }
    }
  });
  console.log(JSON.stringify({ held: true }));
})().catch((e) => { console.error(e.message); process.exit(1); });`;

export interface FileHolder {
  proc: ReturnType<typeof Bun.spawn>;
  /** Run one SQL statement on the holder's own connection. */
  query(sql: string): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

/** A program that is not croft holding a DuckDB file open (read-write), until close(). */
export async function holdDuckDb(path: string): Promise<FileHolder> {
  const proc = Bun.spawn([process.execPath, "-e", DUCKDB_HOLDER], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", TMPDIR: process.env.TMPDIR ?? "/tmp", DUCKDB_API, DB_PATH: path },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  spawned.add(proc);
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  const line = async (): Promise<Envelope> => {
    const deadline = Date.now() + 20_000;
    for (let nl = text.indexOf("\n"); nl === -1; nl = text.indexOf("\n")) {
      if (Date.now() > deadline) throw new Error(`the holder of ${path} did not answer: ${text}`);
      const { value, done } = await reader.read();
      if (done) throw new Error(`the holder of ${path} exited: ${text}${await new Response(proc.stderr as ReadableStream).text()}`);
      text += decoder.decode(value);
    }
    const nl = text.indexOf("\n");
    const out = JSON.parse(text.slice(0, nl)) as Envelope;
    text = text.slice(nl + 1);
    return out;
  };
  const first = await line();
  if (!first.held) throw new Error(`the holder of ${path} said ${JSON.stringify(first)}`);
  const stdin = proc.stdin as import("bun").FileSink;
  return {
    proc,
    async query(sql) {
      stdin.write(`${sql.replace(/\n/g, " ")}\n`);
      await stdin.flush();
      const r = await line();
      if (r.error) throw new Error(r.error as string);
      return r.rows as Record<string, unknown>[];
    },
    async close() {
      proc.kill();
      await proc.exited;
      spawned.delete(proc);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Phase 5: the rest of what `bun install` leaves in a project, and the hook's shell

/**
 * node_modules/.bin/croft → the package's bin, as `bun install` links it. The hook that `croft init --with-hook`
 * adds runs ./node_modules/.bin/croft, so a journey that runs the hook command needs it.
 */
export function linkCroftBin(p: Project): void {
  const bin = join(p.root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  if (!existsSync(join(bin, "croft"))) symlinkSync(join("..", "@zabaca", "croft", "bin", "croft.mjs"), join(bin, "croft"));
}

/**
 * TypeScript and Bun's types in node_modules, with node_modules/.bin/tsc, as `bun install` leaves them for the
 * devDependencies croft init writes (`croft validate --types` runs that tsc; a journey runs it too).
 */
export function linkTypescript(p: Project): void {
  const nm = join(p.root, "node_modules");
  mkdirSync(join(nm, "@types"), { recursive: true });
  mkdirSync(join(nm, ".bin"), { recursive: true });
  if (!existsSync(join(nm, "typescript"))) symlinkSync(join(PKG, "node_modules", "typescript"), join(nm, "typescript"));
  if (!existsSync(join(nm, "@types", "bun"))) symlinkSync(join(PKG, "node_modules", "@types", "bun"), join(nm, "@types", "bun"));
  if (!existsSync(join(nm, ".bin", "tsc"))) symlinkSync(join("..", "typescript", "bin", "tsc"), join(nm, ".bin", "tsc"));
}

/** The project's own `tsc --noEmit` (node_modules/.bin/tsc, run by this Bun as croft runs it), from its root. */
export async function projectTsc(p: Project): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([process.execPath, join(p.root, "node_modules", ".bin", "tsc"), "--noEmit", "--pretty", "false"], {
    cwd: p.root, env: baseEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  spawned.add(proc);
  const [out, err] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()]);
  const code = await proc.exited;
  spawned.delete(proc);
  return { code, out: `${out}${err}` };
}

/**
 * Run a command as Claude Code runs a hook's command: through `sh -c`, in `cwd` (Claude's current folder), with
 * the hook's JSON on stdin and CLAUDE_PROJECT_DIR set by the caller. The result's args are ["sh", "-c", command].
 */
export async function hookShell(cwd: string, command: string, o: { env?: Record<string, string>; stdin: string }): Promise<CliResult> {
  const started = performance.now();
  const proc = Bun.spawn(["/bin/sh", "-c", command], {
    cwd, env: baseEnv(o.env), stdin: new TextEncoder().encode(o.stdin), stdout: "pipe", stderr: "pipe",
  });
  spawned.add(proc);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()]);
  const code = await proc.exited;
  spawned.delete(proc);
  return { args: ["sh", "-c", command], code: proc.signalCode ? null : code, signal: proc.signalCode ?? null, stdout, stderr, ms: performance.now() - started };
}

/**
 * The JSON Claude Code writes on a PostToolUse hook's stdin after an Edit, MultiEdit or Write of `file` (absolute),
 * with `cwd` as Claude's current folder: the fields of code.claude.com/docs/en/hooks (session_id,
 * transcript_path, cwd, permission_mode, hook_event_name, tool_name, tool_input, tool_response, tool_use_id).
 */
export function postToolUse(o: { tool: "Edit" | "Write" | "MultiEdit"; file: string; cwd: string; content?: string }): string {
  const input = o.tool === "Write"
    ? { file_path: o.file, content: o.content ?? "" }
    : o.tool === "MultiEdit"
      ? { file_path: o.file, edits: [{ old_string: "a", new_string: "b", replace_all: false }] }
      : { file_path: o.file, old_string: "a", new_string: "b", replace_all: false };
  const response = o.tool === "Write"
    ? { type: "update", filePath: o.file, content: o.content ?? "", structuredPatch: [] }
    : { filePath: o.file, oldString: "a", newString: "b", originalFile: "", structuredPatch: [], userModified: false, replaceAll: false };
  return JSON.stringify({
    session_id: "0a1b2c3d-e2e0-4000-8000-000000000029",
    transcript_path: join(tmpdir(), "croft-e2e-transcript.jsonl"),
    cwd: o.cwd,
    permission_mode: "default",
    hook_event_name: "PostToolUse",
    tool_name: o.tool,
    tool_input: input,
    tool_response: response,
    tool_use_id: "toolu_01E2eHookJourney0000000",
  });
}
