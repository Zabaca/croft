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
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
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

export const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$/;
export const RUN_ID = /^r_\d{4}_\d{4}_[0-9a-z]{4}$/;

/** Assert the §4.3 envelope keys. */
export function envelopeKeys(env: Envelope): string[] {
  return Object.keys(env).sort();
}
