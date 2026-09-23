// Direct mode of @zabaca/croft/read (DESIGN.md §5 "Server mode, apps and GUIs", "Owning the DuckDB file").
//
// With no croft serve to ask, an app opens the live file read-only for each query and closes it again:
// 1. If a croft runtime is loaded in this process and owns the file, run through its read lease. A second
//    instance on the same file in one process loses data or releases the owner's lock.
// 2. While <state>/write-intent.d/ holds a live intent, wait up to 2 s so the writer gets in; without this,
//    overlapping readers starved a writer [V].
// 3. Open READ_ONLY via connect.ts (fromCache, the "query" sandbox), retrying lock conflicts for up to 5 s.
// 4. Close as soon as no query of this process uses the file. Concurrent queries share one open instance:
//    fromCache hands every caller the same instance, so the last one out closes it.
// It uses no Bun-only APIs: this file ships in the Node build.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { CroftError } from "../core/errors.ts";
import type { LockHolder } from "../core/types.ts";
import type { Row } from "../types.ts";
import { canonicalPath, connect, lockConflict, type LockConflict, openInstance, type SandboxSpec } from "../db/connect.ts";
import { liveIntents, waitForNoIntents } from "../db/intent.ts";
import { checkFormat } from "../db/state.ts";
import { renderRows } from "../db/values.ts";
import type { Project } from "../project/root.ts";
import { runSelect, toDuck } from "./select.ts";
import type { SelectRequest } from "./wire.ts";

export interface DirectTimings {
  intentWaitMs: number; // how long a live write intent holds a new open back (2 s)
  lockRetryMs: number;  // how long lock conflicts are retried (5 s)
  pollMs: number;       // intent poll interval (50 ms, as croft serve)
}
export const DEFAULT_TIMINGS: DirectTimings = { intentWaitMs: 2000, lockRetryMs: 5000, pollMs: 50 };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Jittered exponential backoff: 25 ms doubling to 1 s, each delay drawn from [half, full] (as warehouse.ts). */
function backoffMs(attempt: number): number {
  const base = Math.min(1000, 25 * 2 ** Math.min(attempt, 6));
  return Math.round(base / 2 + Math.random() * (base / 2));
}

// ---- 1. A croft runtime in this process ----------------------------------------------------------------

/** The part of db/warehouse.ts's DuckWarehouse this module relies on, typed structurally so the Node build
 *  does not bundle a second copy of the runtime's lease machinery. */
export interface InProcessWarehouse {
  readonly path: string;
  read<T>(fn: (db: { connection: DuckDBConnection }) => Promise<T>, o?: { purpose: string; waitMs?: number }): Promise<T>;
}

function isWarehouse(v: unknown): v is InProcessWarehouse {
  return !!v && typeof v === "object" && typeof (v as InProcessWarehouse).path === "string" && typeof (v as InProcessWarehouse).read === "function";
}

/**
 * The croft runtime's warehouse for this database file, when one is loaded in this process. warehouse.ts
 * registers every warehouse by canonical path under Symbol.for("croft.warehouses") and the latest under
 * Symbol.for("croft.warehouse"). A runtime that owns a *different* file is ignored: routing this query
 * there would read the wrong database, and a second file is no hazard.
 */
export function inProcessWarehouse(database: string): InProcessWarehouse | null {
  const g = globalThis as Record<symbol, unknown>;
  const path = canonicalPath(database);
  const all = g[Symbol.for("croft.warehouses")];
  if (all instanceof Map) {
    const w: unknown = all.get(path);
    if (isWarehouse(w)) return w;
  }
  const one = g[Symbol.for("croft.warehouse")];
  if (isWarehouse(one) && canonicalPath(one.path) === path) return one;
  return null;
}

// ---- 2–4. Opening the file ourselves ---------------------------------------------------------------------

interface Slot {
  instance: DuckDBInstance | null;
  opening: Promise<DuckDBInstance> | null;
  users: number;
  opens: number;        // times this module opened the file (tests)
  closed: Promise<void>;
  markClosed: () => void;
}

const slots = new Map<string, Slot>(); // by canonical database path
const formatChecked = new Set<string>();

function slotFor(path: string): Slot {
  let s = slots.get(path);
  if (!s) {
    s = { instance: null, opening: null, users: 0, opens: 0, closed: Promise.resolve(), markClosed: () => {} };
    slots.set(path, s);
  }
  return s;
}

/** How often this process opened the file itself (tests). */
export function openCount(database: string): number {
  return slots.get(canonicalPath(database))?.opens ?? 0;
}

/** How many of this process's queries have the file open right now (tests). */
export function openUsers(database: string): number {
  return slots.get(canonicalPath(database))?.users ?? 0;
}

/** Whether this process has the file open right now (tests). */
export function isOpen(database: string): boolean {
  const s = slots.get(canonicalPath(database));
  return !!s && (s.instance !== null || s.opening !== null);
}

/** Run one query in direct mode. */
export async function directQuery(project: Project, req: SelectRequest, timings: DirectTimings = DEFAULT_TIMINGS): Promise<Row[]> {
  const inproc = inProcessWarehouse(project.paths.database);
  if (inproc) {
    return inproc.read((db) => runSelect(db.connection, req, { timezone: project.timezone, profile: "query", protect: [project.paths.stateDir] }), { purpose: "@zabaca/croft/read" });
  }
  const path = canonicalPath(project.paths.database);
  const spec: SandboxSpec = { profile: "query", timezone: project.timezone, root: project.root };
  const instance = await acquire(project, path, timings);
  let conn: DuckDBConnection | undefined;
  try {
    conn = await connect(instance, spec, path);
    if (!formatChecked.has(path)) {
      // Refuse a database written by a newer croft (DB_NEWER_FORMAT), as every croft read lease does.
      await checkFormat(sqlOn(conn, project.timezone));
      formatChecked.add(path);
    }
    return await runSelect(conn, req, { timezone: project.timezone, profile: "query", protect: [project.paths.stateDir] });
  } finally {
    conn?.disconnectSync();
    release(path);
  }
}

/** A minimal Sql over one connection, for db/state.ts's format check. */
function sqlOn(conn: DuckDBConnection, timezone: string) {
  return {
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return renderRows(await conn.runAndReadAll(sql, params.map(toDuck)), { mode: "ts", timezone }) as T[];
    },
    async exec(sql: string, params: unknown[] = []): Promise<void> {
      await conn.run(sql, params.map(toDuck));
    },
  };
}

async function acquire(project: Project, path: string, t: DirectTimings): Promise<DuckDBInstance> {
  const slot = slotFor(path);
  for (;;) {
    if (slot.instance) {
      // Join the open instance, unless a writer announced itself meanwhile: then let the file close and
      // go through the intent wait, so a stream of overlapping queries cannot keep a writer out.
      if (liveIntents(project.paths.stateDir, { excludeSelf: true }).length === 0) {
        slot.users++;
        return slot.instance;
      }
      await slot.closed;
      continue;
    }
    if (slot.opening) {
      await slot.opening; // a failed open fails every query that waited for it
      continue;
    }
    let markClosed!: () => void;
    slot.closed = new Promise<void>((r) => (markClosed = r));
    slot.markClosed = markClosed;
    slot.opening = open(project, path, t).finally(() => (slot.opening = null));
    try {
      slot.instance = await slot.opening;
      slot.opens++;
    } catch (e) {
      slot.markClosed();
      throw e;
    }
    slot.users++;
    return slot.instance;
  }
}

function release(path: string): void {
  const slot = slots.get(path);
  if (!slot || --slot.users > 0) return;
  slot.users = 0;
  const instance = slot.instance;
  slot.instance = null;
  // Every connection is already disconnected (directQuery's finally), so closeSync releases the OS lock.
  instance?.closeSync();
  slot.markClosed();
}

async function open(project: Project, path: string, t: DirectTimings): Promise<DuckDBInstance> {
  if (!existsSync(path)) {
    throw new CroftError("DB_NOT_FOUND", {
      message: `the warehouse ${path} does not exist yet`,
      hint: `build the data first: run \`croft run\` in ${project.root}`,
      fix: { kind: "command", description: "build the assets", command: "croft run" },
    });
  }
  await waitForNoIntents(project.paths.stateDir, { timeoutMs: t.intentWaitMs, pollMs: t.pollMs });
  const start = Date.now();
  const deadline = start + t.lockRetryMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return (await openInstance(path, "read_only")).instance;
    } catch (e) {
      const conflict = lockConflict(e);
      if (!conflict) throw e;
      if (Date.now() >= deadline) throw busy(project, conflict, Date.now() - start);
      await sleep(Math.max(1, Math.min(backoffMs(attempt), deadline - Date.now())));
    }
  }
}

/** DB_BUSY when croft holds the file (a run's live intent, or croft serve), else DB_HELD_BY_OTHER_PROGRAM. */
function busy(project: Project, c: LockConflict, waitedMs: number): CroftError {
  const secs = Math.round(waitedMs / 100) / 10;
  const intent = c.pid === null ? undefined : liveIntents(project.paths.stateDir).find((i) => i.pid === c.pid);
  const holder: LockHolder = intent
    ? { pid: c.pid, program: "croft", action: "write", since: intent.since, ...(intent.runId ? { runId: intent.runId } : {}) }
    : { pid: c.pid, program: c.program };
  const details = { holder, waitedMs, database: project.paths.database };
  if (intent) {
    return new CroftError("DB_BUSY", {
      message: `the warehouse is busy: croft ${intent.runId ? `run ${intent.runId}` : `(pid ${c.pid})`} is writing; waited ${secs} s`,
      hint: "retry shortly; croft holds the file only while a write step runs",
      retryable: true,
      details,
    });
  }
  if (c.pid !== null && servePid(project.paths.stateDir) === c.pid) {
    return new CroftError("DB_BUSY", {
      message: `the warehouse is held by croft serve (pid ${c.pid}); waited ${secs} s`,
      hint: "query through that server (set CROFT_URL), or stop it and retry",
      retryable: true,
      details: { ...details, holder: { ...holder, program: "croft serve" } },
    });
  }
  const who = `${c.program ?? "another program"}${c.pid !== null ? ` (PID ${c.pid})` : ""}`;
  return new CroftError("DB_HELD_BY_OTHER_PROGRAM", {
    message: `the warehouse is held by ${who}; waited ${secs} s`,
    hint: `close ${who}, then retry; apps should open the file only per query (@zabaca/croft/read does)`,
    retryable: true,
    details,
  });
}

function servePid(stateDir: string): number | null {
  try {
    const v = JSON.parse(readFileSync(join(stateDir, "serve.json"), "utf8")) as { pid?: unknown };
    return typeof v.pid === "number" ? v.pid : null;
  } catch {
    return null;
  }
}
