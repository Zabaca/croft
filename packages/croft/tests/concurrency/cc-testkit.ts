// Helpers for the concurrency suite (DESIGN.md §10 test strategy, items 4 and 7): real processes only. croft is
// the real CLI (tests/e2e/harness.ts), croft serve is `croft serve --port 0 --json` in its own process, a writer is
// a real `croft run` or the probe writer (probe-writer-testkit.ts: croft's own intent protocol, then a lock retry
// every 5 ms, so it measures when the file is really free), a foreign program is a plain @duckdb/node-api process,
// and an app is the public query() of @zabaca/croft/read.
//
// Timing budgets are DESIGN's. Every duration is measured from the event it times (a writer's intent `since`,
// stamped by the writer itself), so a slow child start never counts. CROFT_CI=1 adds SLACK to each budget for
// CPU-starved runners.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { baseEnv, CROFT_BIN, type Project } from "../e2e/harness.ts";

export {
  alive, baseEnv, cleanupAll, CROFT_BIN, croftIn, type CliResult, type Envelope, initProject, json, type MockApi, mockApi, PKG,
  Project, show, startCroft, tempDir, until,
} from "../e2e/harness.ts";

export const CI = process.env.CROFT_CI === "1";
/** Extra time CPU-starved CI runners get on every timing budget. */
export const SLACK = CI ? 600 : 0;
/** The probe writer's own share of a handoff: its 5 ms lock retries and its scheduling. */
export const WRITER_SHARE = 150;
/** DESIGN §5: a running query may finish for 2 s before it is interrupted for a writer. */
export const GRACE_MS = 2000;

export const DUCKDB_API = Bun.resolveSync("@duckdb/node-api", import.meta.dir);
const HERE = import.meta.dir;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A query that runs for hours unless interrupted, and passes the serve gate (range() is allowed). DuckDB checks
 * for interrupts between the tasks of a cross join, so an interrupt stops it within milliseconds (unlike a query
 * that spends its time inside one scalar or list expression, review finding R31-01).
 */
export const LONG_QUERY = "SELECT sum(a.range * b.range) AS s FROM range(10000000) a, range(1000000) b";

// ---------------------------------------------------------------------------------------------------------
// Children that report JSON lines

export interface Event { event: string; t: number; [k: string]: unknown }

export interface LineChild {
  proc: ChildProcess;
  pid: number;
  events: Event[];
  stderr(): string;
  /** The first event with this name (waits for it). */
  waitFor(event: string, timeoutMs?: number): Promise<Event>;
  /** Write a line to the child's stdin (a probe writer or foreign holder lets go; a reader stops). */
  send(line?: string): void;
  exited: Promise<number | null>;
}

const children = new Set<ChildProcess>();

function lineChild(proc: ChildProcess): LineChild {
  children.add(proc);
  const events: Event[] = [];
  let buf = "";
  let err = "";
  proc.stdout!.on("data", (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as Event);
      } catch {
        events.push({ event: line, t: Date.now() });
      }
    }
  });
  proc.stderr!.on("data", (d) => (err += String(d)));
  const exited = new Promise<number | null>((r) => proc.on("exit", (code) => {
    children.delete(proc);
    r(code);
  }));
  return {
    proc, pid: proc.pid!, events, exited,
    stderr: () => err,
    async waitFor(event, timeoutMs = 30_000) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const e = events.find((x) => x.event === event);
        if (e) return e;
        if (Date.now() > end) throw new Error(`child ${proc.pid} never reported ${event}; events ${JSON.stringify(events)}; stderr ${err}`);
        if (proc.exitCode !== null) throw new Error(`child ${proc.pid} exited (${proc.exitCode}) before ${event}; stderr ${err}`);
        await sleep(2);
      }
    },
    send(line = "go") {
      proc.stdin?.write(`${line}\n`);
    },
  };
}

/** Kill every child this kit started (afterAll). */
export function killChildren(): void {
  for (const c of children) {
    try {
      c.kill("SIGKILL");
    } catch {}
  }
  children.clear();
}

/** Where a project keeps its warehouse and state. */
export interface Place { database: string; stateDir: string }
export const placeOf = (p: Project): Place => ({ database: join(p.root, "warehouse.duckdb"), stateDir: p.stateDir });

/**
 * The probe writer (probe-writer-testkit.ts): intent, lock retried every 5 ms (or `retryMs`), a row written (and `sql`
 * run), the file held for `hold` ms (or until send()), then closed and the intent removed. Events: intent {since},
 * acquired, released.
 */
export function probeWriter(at: Place, label: string, hold: number | "stdin", o: { startAt?: number; sql?: string[]; retryMs?: number } = {}): LineChild {
  const env = {
    ...process.env, ...(o.startAt ? { START_AT: String(o.startAt) } : {}), ...(o.sql ? { PROBE_SQL: JSON.stringify(o.sql) } : {}),
    ...(o.retryMs ? { RETRY_MS: String(o.retryMs) } : {}),
  };
  return lineChild(spawn(process.execPath, [join(HERE, "probe-writer-testkit.ts"), at.database, at.stateDir, label, String(hold)], {
    env, stdio: ["pipe", "pipe", "pipe"],
  }));
}

/** When the probe writer's intent appeared (its own clock), and when it got the file. */
export async function writerTimes(w: LineChild): Promise<{ appeared: number; acquired: number; latency: number }> {
  const intent = await w.waitFor("intent");
  const acquired = (await w.waitFor("acquired")).t;
  const appeared = Date.parse(String(intent.since));
  return { appeared, acquired, latency: acquired - appeared };
}

// A program that is not croft (the DuckDB UI, DBeaver, a notebook): it opens the file in MODE, prints "held",
// and keeps it until a line arrives on stdin, then closes it and prints "released". Its command line names no
// croft, so croft cannot mistake it for itself. The instance stays referenced from globalThis: an unreferenced
// instance is collected, and that would release the lock early.
const FOREIGN = `const { DuckDBInstance } = require(process.env.DUCKDB_API);
(async () => {
  const db = await DuckDBInstance.create(process.env.DB_PATH, { access_mode: process.env.MODE });
  const c = await db.connect();
  globalThis.keep = [db, c];
  console.log(JSON.stringify({ event: "held", t: Date.now() }));
  await new Promise((r) => { process.stdin.once("data", r); process.stdin.once("end", r); });
  c.disconnectSync();
  db.closeSync();
  console.log(JSON.stringify({ event: "released", t: Date.now() }));
  setInterval(() => {}, 1000);
})().catch((e) => { console.error(e.message); process.exit(1); });`;

/** A foreign program holding the file READ_ONLY or READ_WRITE until send(). */
export function foreignHolder(database: string, mode: "READ_ONLY" | "READ_WRITE"): LineChild {
  return lineChild(spawn(process.execPath, ["-e", FOREIGN], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", DUCKDB_API, DB_PATH: database, MODE: mode }, stdio: ["pipe", "pipe", "pipe"],
  }));
}

/** An app in direct mode (direct-reader-testkit.ts): queries back to back, in `loops` concurrent loops, until send(),
 *  then a "done" summary. */
export function directReader(root: string, sql: string, loops = 1): LineChild {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^CROFT_(URL|SERVE_TOKEN|PROJECT)$/.test(k)) env[k] = v;
  return lineChild(spawn(process.execPath, [join(HERE, "direct-reader-testkit.ts"), root, sql, String(loops)], { env, stdio: ["pipe", "pipe", "pipe"] }));
}

// ---------------------------------------------------------------------------------------------------------
// croft serve in its own process

export interface EngineStatus {
  state: "open" | "stepping_aside" | "closed_for_write" | "reopening" | "stopped";
  writeIntent: { pid: number; runId: string | null; since: string } | null;
  inFlight: number;
  queued: number;
  openConnections: number;
  queriesToday: number;
}

export interface Reply {
  status: number;
  retryAfter: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  ms: number;
}

export interface Serve {
  url: string;
  pid: number;
  token: string;
  proc: ReturnType<typeof Bun.spawn>;
  /** The server's stderr so far. */
  stderr(): string;
  /** GET /status → the engine's state. */
  engine(): Promise<EngineStatus>;
  /** POST /query with the token (or another). Never throws for an HTTP status; rejects when `signal` aborts. */
  query(sql: string, o?: { limit?: number; token?: string; signal?: AbortSignal; params?: unknown[] }): Promise<Reply>;
  /** SIGTERM, then the exit code. */
  stop(): Promise<number | null>;
}

const serves = new Set<Serve>();

/** `croft serve --port 0 --json` in the project; resolves once it listens (its one envelope) with serve.json's token. */
export async function startServe(p: { root: string; stateDir: string }, o: { env?: Record<string, string> } = {}): Promise<Serve> {
  const proc = Bun.spawn([process.execPath, CROFT_BIN, "serve", "--port", "0", "--json"], {
    cwd: p.root, env: baseEnv(o.env), stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  let err = "";
  void (async () => {
    const dec = new TextDecoder();
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) err += dec.decode(chunk);
  })();
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let out = "";
  const deadline = Date.now() + 20_000;
  while (!out.includes("\n")) {
    const next = await Promise.race([reader.read(), sleep(Math.max(1, deadline - Date.now())).then(() => null)]);
    if (next === null) throw new Error(`croft serve did not start in 20 s; stderr: ${err}`);
    if (next.done) throw new Error(`croft serve exited before listening (${await proc.exited}); stdout: ${out}; stderr: ${err}`);
    out += dec.decode(next.value);
  }
  // Keep draining stdout so the server never blocks on a full pipe.
  void (async () => {
    for (;;) if ((await reader.read()).done) break;
  })();
  const envelope = JSON.parse(out.slice(0, out.indexOf("\n")));
  if (!envelope.ok) throw new Error(`croft serve refused to start: ${out}`);
  const record = JSON.parse(readFileSync(join(p.stateDir, "serve.json"), "utf8")) as { token: string; pid: number; url: string };
  const url = envelope.data.url as string;
  const auth = (token = record.token) => ({ authorization: `Bearer ${token}` });
  const s: Serve = {
    url, pid: envelope.data.pid, token: record.token, proc,
    stderr: () => err,
    async engine() {
      const res = await fetch(`${url}/status`, { headers: auth() });
      const body = await res.json() as { data: { serve: { engine: EngineStatus } } };
      return body.data.serve.engine;
    },
    async query(sql, q = {}) {
      const t0 = performance.now();
      const body = { sql, ...(q.params ? { params: q.params } : {}), ...(q.limit ? { limit: q.limit } : {}) };
      const res = await fetch(`${url}/query`, {
        method: "POST", headers: { ...auth(q.token), "content-type": "application/json" }, body: JSON.stringify(body),
        ...(q.signal ? { signal: q.signal } : {}),
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {}
      return { status: res.status, retryAfter: res.headers.get("retry-after"), body: parsed, ms: performance.now() - t0 };
    },
    async stop() {
      serves.delete(s);
      if (proc.exitCode === null) proc.kill("SIGTERM");
      const timer = setTimeout(() => proc.kill("SIGKILL"), 5000);
      const code = await proc.exited;
      clearTimeout(timer);
      return code;
    },
  };
  serves.add(s);
  return s;
}

/** Stop every croft serve still running (afterAll). */
export async function stopServes(): Promise<void> {
  for (const s of [...serves]) await s.stop();
}

/** A query answered with rows (retrying 503s as a client would): the rows. */
export async function rowsVia(s: Serve, sql: string, timeoutMs = 15_000): Promise<Record<string, unknown>[]> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r = await s.query(sql);
    if (r.status === 200) return r.body.data.rows;
    if (r.status !== 503 || Date.now() > end) throw new Error(`query failed: ${r.status} ${JSON.stringify(r.body)}`);
    await sleep(100);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Projects

/** Append an order to files/example_sales.csv, so the next run of example_sales really writes. */
export function addSale(p: Project, orderId: number): void {
  p.write("files/example_sales.csv", `${p.read("files/example_sales.csv").replace(/\n?$/, "\n")}${orderId},2026-05-01,Test Shop,West,Widget,1,1.00,1.00\n`);
}

/** The live write intents' files (write-intent.d), temp files excluded. */
export function intentFiles(p: Project): string[] {
  const dir = join(p.stateDir, "write-intent.d");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
}

/**
 * An SQL transform that holds its write lease for `ms`: DuckDB's sleep_ms runs once, inside the step's write
 * transaction (CREATE TEMP TABLE __croft_next AS <body>), so the run keeps the file read-write that long.
 */
export function slowSqlAsset(input: string, key: string, ms: number): string {
  return `-- description: a copy of ${input} that takes ${ms} ms to build (the concurrency suite's slow write step)
-- key: ${key}
SELECT i.*, p.pause FROM ${input} i, (SELECT coalesce(sleep_ms(${ms})::INTEGER, 0) AS pause) p
`;
}

/** A TS ingest whose one request waits at the mock API until the test opens its gate (a long extraction). */
export function gatedAsset(url: string, o: { schedule?: string } = {}): string {
  return `import { ingest } from "@zabaca/croft";

export default ingest({
  description: "rows from a mock API that answers when the test says so",${o.schedule ? `\n  schedule: "${o.schedule}",` : ""}
  key: "id",
  async *rows({ http }) {
    yield (await http.get("${url}", { timeoutMs: 60_000 })).json<Record<string, unknown>[]>();
  },
});
`;
}

/**
 * A gate the mock API waits on: closed() makes requests wait, open() lets them (and later ones) through. Open it
 * within 10 s: the mock's Bun.serve drops a request it has not answered by then (its default idleTimeout).
 */
export class Gate {
  private wait: Promise<void> = Promise.resolve();
  private release: () => void = () => {};
  closed(): this {
    this.wait = new Promise<void>((r) => (this.release = r));
    return this;
  }
  open(): void {
    this.release();
    this.wait = Promise.resolve();
  }
  pass(): Promise<void> {
    return this.wait;
  }
}
