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
//
// Server mode (D119) runs the same worker as the readers' process: `open` with `readers` makes an in-memory
// instance (never the live file), loads quack and httpfs by path, attaches the read copy READ_ONLY as `wh`, and
// locks it down to the copy's path (db/modes.ts, kind "readers"). Every connection then runs `USE wh`, so the gate and
// the queries see the copy exactly as they see the live file in file mode. `swap` takes a refreshed copy in: it
// removes any `<copy>.wal` (a valid one would be replayed onto the new copy), DETACHes `wh` and ATTACHes the new file,
// 2 to 10 ms [V: 2.0.0]. A connection's `USE wh` is by name, so it follows the new file; a query that starts meanwhile
// waits for the swap, and one that fails because it straddled it is run again, once. A query already reading the old
// file finishes on it. A start or a swap that fails ends this process (the instance is part set up, and is never
// reused); croft serve replaces it (after a backoff for a start, at once for a swap it killed). The instance stays
// referenced for the process's whole life:
// Quack's listener, once slice 4 starts one, stops when its instance is collected [V: 2.0.0].
import type { DuckDBConnection, DuckDBInstance, DuckDBPreparedStatement, DuckDBResult } from "@duckdb/node-api";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { CroftError } from "../core/errors.ts";
import type { Problem, Sql } from "../core/types.ts";
import { connect, lockConflict, newerStorage, openInstance, openMemoryInstance, type SandboxSpec } from "../db/connect.ts";
import { READ_COPY_ALIAS, READERS_VIEWS_DB } from "../db/modes.ts";
import { checkFormat } from "../db/state.ts";
import { type ColumnInfo, renderRows, renderValueRows, resultShape, typeName } from "../db/values.ts";
import { mapQueryError, toDuck, wireSafe } from "../read/select.ts";
import { tooManyRows } from "../read/wire.ts";
import type { CatalogSnapshot } from "../sql/gate-core.ts";
import { gateSelect, loadCatalog } from "../sql/gate.ts";

/** Messages croft serve sends. */
export type ToWorker =
  /** `path` is the warehouse, or with `readers` the read copy (server mode: the readers' process, an in-memory
   *  instance with the copy attached read-only; the folders are the extension files' and the secret folder's). */
  | { op: "open"; path: string; spec: SandboxSpec; protect: string[]; readers?: { extensionDir: string; secretDir: string; shared: string[] } }
  /** Server mode: the copy at `path` was replaced; detach the old file and attach the new one. */
  | { op: "swap" }
  | { op: "query"; id: number; sql: string; params: unknown[]; limit: number; maxRows: number; maxBytes: number; shared?: string[] }
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
  | { op: "swapped"; conns: number }
  /** The swap failed: this process is part set up and exits at once; croft serve starts another. */
  | { op: "swap_failed"; error: WireError }
  | { op: "answer"; id: number; conns: number; peakRss: number; columns: ColumnInfo[]; rowsJson: string; rowCount: number; tables: string[] }
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
  /** A key's query (D122): the tables the project shares, the only ones it may name. Undefined for the app token. */
  shared?: readonly string[];
  /** The catalog snapshot of the connection's file, when the caller has one (the gate fetches its own otherwise). */
  catalog?: CatalogSnapshot;
  /** Throws when the query was stopped; called between DuckDB steps and chunks. */
  checkpoint(): void;
}

export interface Answer {
  columns: ColumnInfo[];
  /** The rows as a JSON array, in the §4.3 json rendering (-0 as 0). */
  rowsJson: string;
  rowCount: number;
  /** The project's tables the query read, ASCII-lowercased: what a key query's log line names. */
  tables: string[];
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
  const verdict = await gateSelect(conn, sql, {
    profile: "serve", protect: o.protect, ...(o.shared !== undefined ? { shared: o.shared } : {}), ...(o.catalog ? { catalog: o.catalog } : {}),
  });
  o.checkpoint();
  let stmt: DuckDBPreparedStatement;
  try {
    // The gate's SQL: the query as written, except a key's SHOW TABLES, which lists the shared tables only.
    stmt = await conn.prepare(verdict.sql);
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
    return { columns, rowsJson: `[${parts.join(",")}]`, rowCount: rows, tables: verdict.tables };
  } catch (e) {
    throw mapQueryError(e, "serve");
  } finally {
    // On DuckDB 2.0 a partly read stream blocks its connection from starting another statement (RESOURCE_IN_USE)
    // until it is closed. closeSync is idempotent, and waits out a fetch in flight.
    if (result && !finished) {
      try {
        result.closeSync();
      } catch {}
    }
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

/** The peak resident set of this process, in bytes. getrusage reports it in bytes on macOS and in KiB elsewhere, and
 *  Bun passes it on as it is. The unit goes by the platform, not by the value: macOS's peak can lag the current
 *  resident set by a few pages, and reading such a peak as KiB made it 1024 times too large. */
export function peakRss(platform: NodeJS.Platform = process.platform, usage = process.resourceUsage().maxRSS, rss = process.memoryUsage().rss): number {
  return Math.max(platform === "darwin" ? usage : usage * 1024, rss);
}

/** The worker's side: one instance, its connections, and the queries running on them. */
class Host {
  private instance: DuckDBInstance | null = null;
  private spec: SandboxSpec | null = null;
  private path = "";
  /** The connection factory's key for this instance: the warehouse path, or for the readers' process `:memory:readers`. */
  private key = "";
  private protect: string[] = [];
  private readonly idle: DuckDBConnection[] = [];
  private readonly all = new Set<DuckDBConnection>();
  /** Queries running, by the engine's id: their connection once they have one, and whether they were stopped. */
  private readonly running = new Map<number, { conn: DuckDBConnection | null; stopped: boolean }>();
  /** The readers' process (server mode): the connection that started the mode and swaps the copy. It never runs
   *  `USE wh` and is not one of the pooled connections; null in file mode. */
  private admin: DuckDBConnection | null = null;
  /** The swap in progress, if any: a query starting meanwhile waits for it. */
  private swapping: Promise<void> | null = null;
  /** Swaps completed. A query that fails with another count than it started with straddled one. */
  private epoch = 0;
  /** The tables the project shares with keys, and which of them have a view in the readers' in-memory database now. */
  private shared: string[] = [];
  private views: string[] = [];
  /** Catalog snapshots, one per way of reading the file (the app token's `wh`, a key's views, the live file), each good for
   *  the epoch it was loaded in: the file cannot change under a worker, and a swap moves the epoch on. */
  private readonly catalogs = new Map<string, { epoch: number; snapshot: Promise<CatalogSnapshot> }>();
  /** The database each readers' connection works in (`USE`). */
  private readonly using = new WeakMap<DuckDBConnection, string>();

  constructor(private readonly send: (m: FromWorker) => void, private readonly exit: () => void = () => {}) {}

  handle(m: ToWorker): void {
    switch (m.op) {
      case "open":
        void this.open(m);
        return;
      case "swap":
        void this.swap();
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
      if (m.readers) {
        // Server mode: an in-memory instance, the copy attached read-only by the mode. A valid `<copy>.wal` SQL left
        // beside it would be replayed in memory by the attach, so none is there when it attaches.
        rmSync(`${m.path}.wal`, { force: true });
        this.instance = await openMemoryInstance();
        this.spec = readersSpec(m.spec, m.path, m.readers);
        this.path = m.path;
        this.protect = m.protect;
        this.key = READERS_KEY;
        lockCopy(m.path);
        this.admin = await connect(this.instance, this.spec, this.key); // checks the files, loads, attaches, locks
        await this.refuseWal(this.admin);
        this.shared = m.readers.shared;
        await this.makeViews(this.admin);
      } else {
        this.instance = (await openInstance(m.path, "read_only")).instance;
        this.key = m.path;
        this.spec = m.spec;
        this.path = m.path;
        this.protect = m.protect;
      }
      // Refuse a database from a newer croft before serving it (DB_NEWER_FORMAT), as every croft read does.
      const conn = await this.take();
      try {
        await checkFormat(sqlOn(conn, m.spec.timezone));
      } finally {
        this.give(conn);
      }
      this.send({ op: "opened", conns: this.all.size });
    } catch (e) {
      // The instance, if it opened, stays as it is: the engine kills this worker. A readers' process also ends itself,
      // since the instance is part set up and is never reused.
      this.send({ op: "open_failed", error: toWire(m.readers ? readersOpenError(e, m.path) : e) });
      if (m.readers) this.exit();
    }
  }

  /** A read-only attach makes no WAL. One that is there right after it appeared while the copy was attached, so something
   *  had it open for writing: detach, and fail (the process ends and is replaced; the new one removes the file first). */
  private async refuseWal(admin: DuckDBConnection): Promise<void> {
    if (!existsSync(`${this.path}.wal`)) return;
    try {
      await admin.run(`DETACH ${READ_COPY_ALIAS}`);
    } catch {
      // The process ends either way.
    }
    throw new Error("a WAL appeared beside the read copy while it was being attached, so it is not served");
  }

  /** Take in the refreshed copy: detach the old file and attach the one now at the same path. */
  private async swap(): Promise<void> {
    const admin = this.admin;
    if (!admin) {
      this.send({ op: "swap_failed", error: toWire(new Error("this worker is not a readers' process")) });
      return;
    }
    const done = (async () => {
      rmSync(`${this.path}.wal`, { force: true });
      lockCopy(this.path);
      await admin.run(`DETACH ${READ_COPY_ALIAS}`);
      await admin.run(`ATTACH ${sqlString(this.path)} AS ${READ_COPY_ALIAS} (READ_ONLY)`);
      await this.refuseWal(admin);
      await this.makeViews(admin);
      // A copy a newer croft wrote is refused here as it is when the process opens (DB_NEWER_FORMAT): the process ends,
      // and the one that replaces it reports the same until the copy is one this croft reads.
      const conn = await this.take();
      try {
        await checkFormat(sqlOn(conn, this.spec!.timezone));
      } finally {
        this.give(conn);
      }
      this.epoch++;
    })();
    this.swapping = done.catch(() => {});
    try {
      await done;
      this.send({ op: "swapped", conns: this.all.size });
    } catch (e) {
      this.send({ op: "swap_failed", error: toWire(readersOpenError(e, this.path)) });
      this.exit();
    } finally {
      this.swapping = null;
    }
  }

  private async query(m: Extract<ToWorker, { op: "query" }>): Promise<void> {
    const q = this.running.get(m.id)!;
    let conn: DuckDBConnection | null = null;
    let reply: FromWorker;
    try {
      if (!this.instance || !this.spec) throw new Error("the query worker has no database open");
      let a: Answer | null = null;
      // A key's query works in the views of the shared tables; the app token's on the copy itself.
      const scoped = m.shared !== undefined;
      const db = scoped ? READERS_VIEWS_DB : READ_COPY_ALIAS;
      for (let attempt = 0; a === null; attempt++) {
        const epoch = this.epoch;
        try {
          // A swap in progress is waited for: between its DETACH and its ATTACH there is no `wh` to read.
          if (this.swapping) await this.swapping;
          conn = await this.take(db);
          q.conn = conn;
          if (q.stopped) conn.interrupt();
          a = await answer(conn, m.sql, {
            params: m.params, limit: m.limit, maxRows: m.maxRows, maxBytes: m.maxBytes, timezone: this.spec.timezone, protect: this.protect,
            ...(m.shared !== undefined ? { shared: m.shared } : {}), catalog: await this.catalogFor(conn, this.admin ? db : this.key, () => q.stopped),
            checkpoint: () => {
              if (q.stopped) throw new Stopped();
            },
          });
        } catch (e) {
          // A query that straddled a swap may have bound to the file just detached, and read nothing: it runs again, once.
          if (attempt > 0 || !this.admin || q.stopped) throw e;
          if (this.swapping) await this.swapping;
          if (this.epoch === epoch) throw e;
          if (conn) this.give(conn);
          conn = null;
        }
      }
      reply = { op: "answer", id: m.id, conns: 0, peakRss: 0, ...a };
    } catch (e) {
      reply = { op: "failed", id: m.id, conns: 0, peakRss: 0, error: q.stopped ? { kind: "stopped" } : toWire(e) };
    }
    // Forgotten before its connection goes back: a late interrupt must never reach the next query on it.
    this.running.delete(m.id);
    if (conn) this.give(conn);
    this.send({ ...reply, conns: this.all.size, peakRss: peakRss() });
  }

  /** A connection, working in `db` when this is the readers' process (the copy for the app token, the views for a key). */
  private async take(db: string = READ_COPY_ALIAS): Promise<DuckDBConnection> {
    const reuse = this.idle.pop();
    const conn = reuse ?? await connect(this.instance!, this.spec!, this.key);
    if (this.admin && this.using.get(conn) !== db) {
      // The readers' process: the copy is the default database, as the live file's own catalog is in file mode.
      try {
        await conn.run(`USE ${db}`);
        this.using.set(conn, db);
      } catch (e) {
        conn.disconnectSync();
        this.all.delete(conn);
        throw e;
      }
    }
    this.all.add(conn);
    return conn;
  }

  /**
   * The catalog snapshot for queries on `conn`, loaded once per epoch for `via` (the gate's input, sql/gate-core.ts). The
   * query that loads it may be stopped (its deadline, its client going away) and take the load down with it, so a query
   * that waited on a load that failed loads once with its own connection, unless it was stopped itself.
   */
  private async catalogFor(conn: DuckDBConnection, via: string, stopped: () => boolean): Promise<CatalogSnapshot> {
    for (let attempt = 0; ; attempt++) {
      const hit = this.catalogs.get(via);
      let entry = hit && hit.epoch === this.epoch ? hit : null;
      if (!entry) {
        const made = { epoch: this.epoch, snapshot: loadCatalog(conn) };
        made.snapshot.catch(() => {
          if (this.catalogs.get(via) === made) this.catalogs.delete(via);
        });
        this.catalogs.set(via, made);
        entry = made;
      }
      try {
        return await entry.snapshot;
      } catch (e) {
        if (attempt > 0 || stopped()) throw e;
      }
    }
  }

  /**
   * One view in the readers' in-memory database for each shared table the copy has: `CREATE VIEW memory.main.t AS SELECT *
   * FROM wh.main.t`. A key's connection works in that database, so the names it can type are those views, and a hidden
   * table is not a name there at all (the gate's catalog snapshot says the same, D123). Views from before a swap are
   * dropped first, and made again from the new copy; a shared table the copy lacks has no view. DDL in the in-memory
   * database is not refused by the lock [V: 2.0.0].
   */
  private async makeViews(admin: DuckDBConnection): Promise<void> {
    for (const name of this.views) await admin.run(`DROP VIEW IF EXISTS ${READERS_VIEWS_DB}.main.${quote(name)}`);
    this.views = [];
    if (!this.shared.length) return;
    const reader = await admin.runAndReadAll(
      `SELECT table_name FROM duckdb_tables() WHERE database_name = ${sqlString(READ_COPY_ALIAS)} AND schema_name = 'main' AND NOT temporary`);
    const have = new Map(reader.getRowsJS().map((r) => [String(r[0]).replace(/[A-Z]/g, (c) => c.toLowerCase()), String(r[0])] as const));
    for (const name of this.shared) {
      const actual = have.get(name);
      if (actual === undefined) continue;
      await admin.run(`CREATE VIEW ${READERS_VIEWS_DB}.main.${quote(name)} AS SELECT * FROM ${READ_COPY_ALIAS}.main.${quote(actual)}`);
      this.views.push(name);
    }
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

const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;

/** The connection factory's key for the readers' process's one instance. */
export const READERS_KEY = ":memory:readers";

/**
 * Make the copy read-only on disk before it is attached. A refresh in server mode does it, but a copy a project made while
 * it only had `readCopy` on is 0644, and attached as it is, a read-write `ATTACH` of it inside the process worked and a
 * valid WAL was left behind. Not the owner, or root (which ignores the mode): nothing changes, and the gate is the only
 * guard (D119).
 */
export function lockCopy(path: string): void {
  try {
    chmodSync(path, 0o444);
  } catch {
    // Not ours to change.
  }
}

/** The sandbox of the readers' process: the serve profile with the `readers` mode, which attaches `copy` read-only and
 *  allows its path and no folder (db/modes.ts). The one place it is built, so a test that opens the same instance to try
 *  SQL past the gate (serve/readers-session-testkit.ts) cannot drift from the worker. */
export function readersSpec(spec: SandboxSpec, copy: string, r: { extensionDir: string; secretDir: string }): SandboxSpec {
  return { ...spec, mode: { kind: "readers", extensionDir: r.extensionDir, secretDir: r.secretDir, copy } };
}

/**
 * Why a readers' process could not start or swap, as the error to report. A copy a newer DuckDB wrote is DB_NEWER_FORMAT,
 * as for the live file (the mode's attach reports it as INTERNAL_ERROR with DuckDB's first line in details.duckdb).
 */
function readersOpenError(e: unknown, copy: string): unknown {
  const detail = e instanceof CroftError ? e.problem.details?.duckdb : undefined;
  const newer = newerStorage(typeof detail === "string" ? new Error(detail) : e, { database: copy });
  return newer ?? e;
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
  }, () => setTimeout(die, 200)); // a readers' process that failed to start or swap: its answer is on the way first
  // The instance is referenced for this process's whole life (Quack's listener stops when its instance is collected).
  (globalThis as Record<string, unknown>).__croftWorkerHost = host;
  process.on("message", (m) => host.handle(m as ToWorker));
  send({ op: "ready", pid: process.pid } satisfies FromWorker);
}

if (import.meta.main) main();
