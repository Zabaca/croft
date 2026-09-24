// croft serve's query worker (DESIGN.md §5 "Server mode, apps and GUIs"): the child process that holds one
// read-only DuckDB instance for the engine and runs its queries. serve/instance.ts owns it, through
// serve/query-worker.ts, over Bun's IPC channel; the HTTP server and the handoff stay in croft serve itself.
//
// Why a process of its own: DuckDB checks for interrupts between tasks, and a SELECT can spend seconds inside one
// scalar or list expression (`list_sort(range(150000000))` is folded while planning; `list_reduce` over a big
// range runs in one call), so interrupts cannot always stop a query, and closing an instance whose query still
// runs keeps the file locked. The one thing nothing inside DuckDB can delay is the process's exit: the kernel
// drops its locks with it. So when a stopped query does not settle in time (a writer is waiting, or its deadline
// passed), the engine SIGKILLs this process, and it always does so to give the file up.
//
// One instance per process, for its whole life: the engine opens the live warehouse or the read copy in a fresh
// worker and kills the worker to release the file. Nothing here closes the instance: the exit does, whatever
// state DuckDB's objects are in (a partly read stream, a query still running).
//
// A query (answer()): the serve gate (sql/gate.ts, profile "serve"), then the statement streamed chunk by chunk.
// DuckDB produces only the chunks read (a `SELECT *` over 20M rows reads one chunk to find out it is more than
// `limit`), each chunk is rendered and counted as JSON on the way, and the query fails with QUERY_TOO_MANY_ROWS as
// soon as it passes `limit` (capped at maxRows) or maxBytes: memory follows what is answered, not what the
// query could return. Rows go back as JSON text, exactly what the client will parse.
//
// It exits by itself when croft serve goes away (the IPC channel disconnects, or it is reparented), so a worker
// never outlives its server holding the file. Terminal signals (Ctrl-C reaches the whole process group) are
// ignored: croft serve decides when its queries end.
import type { DuckDBConnection, DuckDBInstance, DuckDBPreparedStatement, DuckDBResult } from "@duckdb/node-api";
import { CroftError } from "../core/errors.ts";
import type { Problem, Sql } from "../core/types.ts";
import { connect, lockConflict, openInstance, type SandboxSpec } from "../db/connect.ts";
import { checkFormat } from "../db/state.ts";
import { type ColumnInfo, renderRows, renderValueRows, resultShape, typeName } from "../db/values.ts";
import { mapQueryError, toDuck, wireSafe } from "../read/select.ts";
import { tooManyRows } from "../read/wire.ts";
import { assertOneSelect } from "../sql/gate.ts";

/** Messages croft serve sends. */
export type ToWorker =
  | { op: "open"; path: string; spec: SandboxSpec; protect: string[] }
  | { op: "query"; id: number; sql: string; params: unknown[]; limit: number; maxRows: number; maxBytes: number }
  /** Interrupt query `id` (repeated every 20 ms while it runs); ignored once it has settled. */
  | { op: "interrupt"; id: number }
  /** Disconnect every connection: the file is about to be released (the engine then kills this process). */
  | { op: "disconnect" };

/** An error, as it crosses the process boundary. */
export type WireError =
  | { kind: "croft"; problem: Problem }
  /** The query was interrupted because the engine stopped it; the engine knows why. */
  | { kind: "stopped" }
  /** Another process holds the file (DuckDB's lock error). */
  | { kind: "conflict"; program: string | null; pid: number | null; message: string }
  | { kind: "error"; name: string; message: string };

/** Messages the worker sends. `conns` is the connections open after the operation; `peakRss` the process's peak
 *  resident set so far, in bytes. */
export type FromWorker =
  | { op: "ready"; pid: number }
  | { op: "opened"; conns: number }
  | { op: "open_failed"; error: WireError }
  | { op: "answer"; id: number; conns: number; peakRss: number; columns: ColumnInfo[]; rowsJson: string; rowCount: number }
  | { op: "failed"; id: number; conns: number; peakRss: number; error: WireError }
  | { op: "disconnected"; conns: number };

/** What answer() needs besides the SQL. */
export interface AnswerOptions {
  params: unknown[];
  /** The client's row limit; more rows is QUERY_TOO_MANY_ROWS. */
  limit: number;
  /** The server's own cap on `limit`. */
  maxRows: number;
  /** serve.maxBytes: the rows' JSON may not be bigger. */
  maxBytes: number;
  timezone: string;
  /** Paths the gate refuses besides the database's own files (the state folder). */
  protect: string[];
  /** Throws when the query was stopped; called between DuckDB steps and chunks. */
  checkpoint(): void;
}

export interface Answer {
  columns: ColumnInfo[];
  /** The rows as a JSON array, in the §4.3 json rendering (-0 as 0). */
  rowsJson: string;
  rowCount: number;
}

/** Thrown by an AnswerOptions.checkpoint when the query was stopped. */
export class Stopped extends Error {
  constructor() {
    super("the query was stopped");
  }
}

/**
 * One SELECT through the serve gate, streamed and rendered chunk by chunk within limit (at most maxRows) and
 * maxBytes. Errors are CroftErrors (mapQueryError) except Stopped and croft's own bugs. A stream left partly
 * read (the result was too big, or failed) is closed before this returns, so the connection can run the next query.
 */
export async function answer(conn: DuckDBConnection, sql: string, o: AnswerOptions): Promise<Answer> {
  o.checkpoint();
  await assertOneSelect(conn, sql, { profile: "serve", protect: o.protect });
  o.checkpoint();
  let stmt: DuckDBPreparedStatement;
  try {
    stmt = await conn.prepare(sql);
  } catch (e) {
    throw mapQueryError(e, "serve");
  }
  let result: DuckDBResult | null = null;
  let finished = false;
  try {
    o.checkpoint();
    if (o.params.length) stmt.bind(o.params.map(toDuck));
    result = await stmt.stream();
    const shape = resultShape(result);
    const columns = shape.types.map((t, i) => ({ name: shape.names[i]!, type: typeName(t) }));
    const ctx = { mode: "json" as const, timezone: o.timezone };
    const cap = Math.min(o.limit, o.maxRows);
    const parts: string[] = [];
    let rows = 0;
    let bytes = 0;
    for (;;) {
      o.checkpoint();
      const chunk = await result.fetchChunk();
      if (!chunk || chunk.rowCount === 0) break;
      // Past the limit: an error, never a partial result, and the rows beyond it are never rendered.
      if (rows + chunk.rowCount > cap) throw tooMany(o.limit, o.maxRows);
      for (const row of renderValueRows(chunk.getRows(), shape, ctx)) {
        const text = JSON.stringify(wireSafe(row));
        bytes += Buffer.byteLength(text) + 1;
        if (bytes > o.maxBytes) throw tooBig(o.maxBytes, o.limit, rows);
        parts.push(text);
        rows++;
      }
    }
    finished = true;
    return { columns, rowsJson: `[${parts.join(",")}]`, rowCount: rows };
  } catch (e) {
    throw mapQueryError(e, "serve");
  } finally {
    // A partly read stream keeps its query open on the connection (and its memory until garbage collection);
    // the next statement on the connection closes it.
    if (result && !finished) await conn.run("SELECT 1").catch(() => {});
    try {
      stmt.destroySync();
    } catch {}
  }
}

function tooMany(limit: number, maxRows: number): CroftError {
  if (limit <= maxRows) return tooManyRows(limit, { via: "read server" });
  const cap = maxRows.toLocaleString("en-US");
  return new CroftError("QUERY_TOO_MANY_ROWS", {
    message: `the query returned more than ${cap} rows, the most croft's read server answers at once (the request asked for up to ${limit.toLocaleString("en-US")}); croft never returns a partial result`,
    hint: "page through the rows with LIMIT and OFFSET (or WHERE on a key), or aggregate in SQL",
    retryable: false,
    details: { limit, maxRows, via: "read server" },
  });
}

function tooBig(maxBytes: number, limit: number, rowsWithinMaxBytes: number): CroftError {
  return new CroftError("QUERY_TOO_MANY_ROWS", {
    message: `the result is larger than serve.maxBytes (${maxBytes.toLocaleString("en-US")} bytes); croft never returns a partial result`,
    hint: "select fewer or smaller columns, filter or aggregate in SQL, or raise serve.maxBytes in croft.json",
    retryable: false,
    details: { maxBytes, limit, rowsWithinMaxBytes, via: "read server" },
  });
}

/** An error as it crosses to croft serve. */
export function toWire(e: unknown): WireError {
  if (e instanceof Stopped) return { kind: "stopped" };
  if (e instanceof CroftError) return { kind: "croft", problem: e.problem };
  const conflict = lockConflict(e);
  if (conflict) return { kind: "conflict", program: conflict.program, pid: conflict.pid, message: String((e as Error)?.message ?? e) };
  const err = e instanceof Error ? e : new Error(String(e));
  return { kind: "error", name: err.name, message: err.message };
}

/** The peak resident set of this process, in bytes. getrusage reports it in bytes on macOS and in KiB on Linux, and
 *  Bun passes it on as it is: a peak below the current resident set can only be KiB. */
function peakRss(): number {
  const max = process.resourceUsage().maxRSS;
  const now = process.memoryUsage().rss;
  return Math.max(max >= now ? max : max * 1024, now);
}

/** The worker's side: one instance, its connections, and the queries running on them. */
class Host {
  private instance: DuckDBInstance | null = null;
  private spec: SandboxSpec | null = null;
  private path = "";
  private protect: string[] = [];
  private readonly idle: DuckDBConnection[] = [];
  private readonly all = new Set<DuckDBConnection>();
  /** Queries running, by the engine's id: their connection once they have one, and whether they were stopped. */
  private readonly running = new Map<number, { conn: DuckDBConnection | null; stopped: boolean }>();

  constructor(private readonly send: (m: FromWorker) => void) {}

  handle(m: ToWorker): void {
    switch (m.op) {
      case "open":
        void this.open(m);
        return;
      case "query":
        // Registered before anything awaits, so an interrupt that follows at once finds it.
        this.running.set(m.id, { conn: null, stopped: false });
        void this.query(m);
        return;
      case "interrupt": {
        const q = this.running.get(m.id);
        if (!q) return;
        q.stopped = true;
        q.conn?.interrupt();
        return;
      }
      case "disconnect":
        this.dropAll();
        this.send({ op: "disconnected", conns: this.all.size });
        return;
    }
  }

  private async open(m: Extract<ToWorker, { op: "open" }>): Promise<void> {
    try {
      if (this.instance) throw new Error("this worker already has a database open");
      this.instance = (await openInstance(m.path, "read_only")).instance;
      this.spec = m.spec;
      this.path = m.path;
      this.protect = m.protect;
      // Refuse a database from a newer croft before serving it (DB_NEWER_FORMAT), as every croft read does.
      const conn = await this.take();
      try {
        await checkFormat(sqlOn(conn, m.spec.timezone));
      } finally {
        this.give(conn);
      }
      this.send({ op: "opened", conns: this.all.size });
    } catch (e) {
      // The instance, if it opened, stays as it is: the engine kills this worker.
      this.send({ op: "open_failed", error: toWire(e) });
    }
  }

  private async query(m: Extract<ToWorker, { op: "query" }>): Promise<void> {
    const q = this.running.get(m.id)!;
    let conn: DuckDBConnection | null = null;
    let reply: FromWorker;
    try {
      if (!this.instance || !this.spec) throw new Error("the query worker has no database open");
      conn = await this.take();
      q.conn = conn;
      if (q.stopped) conn.interrupt();
      const a = await answer(conn, m.sql, {
        params: m.params, limit: m.limit, maxRows: m.maxRows, maxBytes: m.maxBytes, timezone: this.spec.timezone, protect: this.protect,
        checkpoint: () => {
          if (q.stopped) throw new Stopped();
        },
      });
      reply = { op: "answer", id: m.id, conns: 0, peakRss: 0, ...a };
    } catch (e) {
      reply = { op: "failed", id: m.id, conns: 0, peakRss: 0, error: q.stopped ? { kind: "stopped" } : toWire(e) };
    }
    // Forgotten before its connection goes back: a late interrupt must never reach the next query on it.
    this.running.delete(m.id);
    if (conn) this.give(conn);
    this.send({ ...reply, conns: this.all.size, peakRss: peakRss() });
  }

  private async take(): Promise<DuckDBConnection> {
    const reuse = this.idle.pop();
    if (reuse) return reuse;
    const conn = await connect(this.instance!, this.spec!, this.path);
    this.all.add(conn);
    return conn;
  }

  private give(conn: DuckDBConnection): void {
    if (this.all.has(conn)) this.idle.push(conn);
  }

  private dropAll(): void {
    this.idle.length = 0;
    for (const c of [...this.all]) {
      try {
        c.disconnectSync();
        this.all.delete(c);
      } catch {
        // Counted as still open: the engine reports it before it kills this process.
      }
    }
  }
}

/** A minimal Sql over one connection, for db/state.ts's format check. */
function sqlOn(conn: DuckDBConnection, timezone: string): Sql {
  return {
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return renderRows(await conn.runAndReadAll(sql, params.map(toDuck)), { mode: "ts", timezone }) as T[];
    },
    async exec(sql: string, params: unknown[] = []): Promise<void> {
      await conn.run(sql, params.map(toDuck));
    },
  };
}

/** Run as croft serve's worker: `bun --no-env-file worker.ts`, with an IPC channel to croft serve. */
function main(): void {
  const send = process.send?.bind(process);
  if (!send) {
    console.error("croft's query worker runs only as a child of croft serve");
    process.exit(2);
  }
  const die = () => process.kill(process.pid, "SIGKILL");
  // croft serve went away: nothing may keep its file locked. SIGKILL rather than exit(): a query may still run.
  process.on("disconnect", die);
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) die();
  }, 500);
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(s, () => {});
  const host = new Host((m) => {
    try {
      send(m);
    } catch {
      die(); // the channel is gone
    }
  });
  process.on("message", (m) => host.handle(m as ToWorker));
  send({ op: "ready", pid: process.pid } satisfies FromWorker);
}

if (import.meta.main) main();
