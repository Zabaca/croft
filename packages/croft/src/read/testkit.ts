// Test fixtures for @zabaca/croft/read: temp projects with a real DuckDB file, child processes that hold
// the file or stand in for a live writer, and a croft-serve-like /query mock. Not imported by read.ts.
import { DuckDBInstance } from "@duckdb/node-api";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootId, procStart } from "../core/proc.ts";
import { type Project, loadProject } from "../project/root.ts";

export interface TempProject {
  root: string;
  stateDir: string;
  database: string;
  project: Project;
}

const made: string[] = [];
const children: ChildProcess[] = [];

/** A croft project in a temp folder: croft.json, files/, .croft/ and a warehouse seeded with `seed`. */
export async function makeProject(o: { timezone?: string; seed?: string[]; config?: Record<string, unknown>; sub?: string } = {}): Promise<TempProject> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "croft-read-")));
  made.push(base);
  const root = o.sub ? join(base, o.sub) : base;
  mkdirSync(join(root, "files"), { recursive: true });
  mkdirSync(join(root, ".croft"), { recursive: true });
  writeFileSync(join(root, "croft.json"), JSON.stringify({ database: "warehouse.duckdb", timezone: o.timezone ?? "America/Los_Angeles", ...o.config }));
  const project = loadProject({ root });
  if (o.seed) await seed(project.paths.database, o.seed);
  return { root, stateDir: project.paths.stateDir, database: project.paths.database, project };
}

/** Run statements on the file with a private read-write instance, then close it (releasing the lock). */
export async function seed(database: string, statements: string[]): Promise<void> {
  const db = await DuckDBInstance.create(database, { access_mode: "READ_WRITE" });
  const c = await db.connect();
  try {
    for (const s of statements) await c.run(s);
  } finally {
    c.disconnectSync();
    db.closeSync();
  }
}

export const DUCKDB_API = fileURLToPath(import.meta.resolve("@duckdb/node-api"));

export interface Child {
  proc: ChildProcess;
  pid: number;
  waitFor(line: string, timeoutMs?: number): Promise<void>;
  exited: Promise<number | null>;
}

function track(proc: ChildProcess): Child {
  children.push(proc);
  const lines: string[] = [];
  const waiters: { line: string; resolve: () => void }[] = [];
  let buf = "";
  let err = "";
  proc.stdout?.on("data", (d) => {
    buf += String(d);
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      lines.push(line);
      for (const w of waiters.filter((x) => x.line === line)) w.resolve();
    }
  });
  proc.stderr?.on("data", (d) => (err += String(d)));
  const exited = new Promise<number | null>((r) => proc.on("exit", (code) => r(code)));
  return {
    proc,
    pid: proc.pid!,
    exited,
    waitFor(line, timeoutMs = 10_000) {
      if (lines.includes(line)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`child never printed ${line}: ${err}`)), timeoutMs);
        waiters.push({ line, resolve: () => (clearTimeout(t), resolve()) });
        exited.then((code) => reject(new Error(`child exited (${code}) before printing ${line}: ${err}`)));
      });
    },
  };
}

// A program that is not croft (think DuckDB UI or another app): opens the file read-write, optionally
// writes a row, holds it for HOLD_MS, then closes and prints "released". The instance stays referenced
// from globalThis: Node collects an unreferenced instance quickly, and that releases the lock early.
const HOLDER = `const { DuckDBInstance } = require(process.env.DUCKDB_API);
(async () => {
  const db = await DuckDBInstance.create(process.env.DB_PATH);
  const c = await db.connect();
  globalThis.keep = [db, c];
  if (process.env.INSERT) await c.run(process.env.INSERT);
  console.log("held");
  await new Promise((r) => setTimeout(r, Number(process.env.HOLD_MS)));
  c.disconnectSync();
  db.closeSync();
  console.log("released");
  setInterval(() => {}, 1000);
})().catch((e) => { console.error(e.message); process.exit(1); });`;

/** A child process holding the database read-write for `holdMs`. */
export function spawnHolder(database: string, holdMs: number, insert?: string): Child {
  return track(spawn(process.execPath, ["-e", HOLDER], {
    env: { ...process.env, DUCKDB_API, DB_PATH: database, HOLD_MS: String(holdMs), INSERT: insert ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  }));
}

/** A child that only exists (a live PID to own a write intent or a serve.json). */
export function spawnIdle(): Child {
  return track(spawn(process.execPath, ["-e", "console.log('up'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "pipe"] }));
}

/** Write an intent file for a process, as db/intent.ts would. Returns its path. */
export function writeIntent(stateDir: string, pid: number, runId = "r_test"): string {
  const dir = join(stateDir, "write-intent.d");
  mkdirSync(dir, { recursive: true });
  const start = procStart(pid) ?? "gone";
  const file = join(dir, `${pid}-${start.replace(/[^A-Za-z0-9]+/g, "_")}.json`);
  writeFileSync(file, JSON.stringify({ pid, procStart: start, bootId: bootId(), runId, since: new Date().toISOString() }) + "\n");
  return file;
}

/** Write <state>/serve.json for a (live or dead) process. */
export function writeServeJson(stateDir: string, o: { url: string; token?: string; pid: number; procStart?: string | null; bootId?: string | null }): void {
  const rec: Record<string, unknown> = { url: o.url, pid: o.pid };
  if (o.token !== undefined) rec.token = o.token;
  if (o.procStart !== null) rec.procStart = o.procStart ?? procStart(o.pid);
  if (o.bootId !== null) rec.bootId = o.bootId ?? bootId();
  writeFileSync(join(stateDir, "serve.json"), JSON.stringify(rec), { mode: 0o600 });
}

/** A port nothing listens on (bound, then closed). */
export async function deadPort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = s.port!;
  await s.stop(true);
  return port;
}

export interface SeenRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  raw: string;
}

export interface MockServe {
  url: string;
  port: number;
  seen: SeenRequest[];
  stop(): Promise<void>;
}

type Reply = Response | Promise<Response>;

/** The query envelope of DESIGN.md §4.3, as croft serve returns it. */
export function envelope(rows: unknown[], o: { ok?: boolean; problems?: unknown[]; truncatedRows?: unknown; truncatedValues?: unknown } = {}) {
  return {
    schemaVersion: 1, ok: o.ok ?? true, command: "query", croftVersion: "0.1.0-dev.0", database: "warehouse.duckdb",
    timezone: "America/Los_Angeles", durationMs: 1,
    data: { columns: [], rows, rowCount: rows.length, truncatedRows: o.truncatedRows ?? 0, truncatedValues: o.truncatedValues ?? 0 },
    problems: o.problems ?? [], next: [],
  };
}

/**
 * A croft-serve-like mock on 127.0.0.1. `answer` decides each reply; by default the mock checks the bearer
 * token and Content-Type like croft serve and answers with `run(body)` rendered into a query envelope.
 */
export function mockServe(o: {
  token?: string;
  run?: (body: { sql: string; params?: unknown[]; limit?: number }) => Promise<unknown[]>;
  answer?: (req: SeenRequest, n: number) => Reply | undefined;
}): MockServe {
  const seen: SeenRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const text = await request.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {}
      const headers: Record<string, string> = {};
      request.headers.forEach((v, k) => (headers[k] = v));
      const req: SeenRequest = { method: request.method, path: new URL(request.url).pathname, headers, body, raw: text };
      seen.push(req);
      const custom = o.answer?.(req, seen.length);
      if (custom) return custom;
      if (o.token !== undefined && headers.authorization !== `Bearer ${o.token}`) return new Response("unauthorized", { status: 401 });
      if (!headers["content-type"]?.startsWith("application/json")) return new Response("unsupported media type", { status: 415 });
      if (req.method !== "POST" || req.path !== "/query") return new Response("not found", { status: 404 });
      try {
        const rows = await (o.run ?? (async () => []))(body as { sql: string });
        return Response.json(envelope(rows));
      } catch (e) {
        const problem = (e as { problem?: unknown }).problem;
        if (!problem) throw e;
        return Response.json(envelope([], { ok: false, problems: [problem] }), { status: 400 });
      }
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, port: server.port!, seen, stop: () => server.stop(true) };
}

export function cleanup(): void {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
