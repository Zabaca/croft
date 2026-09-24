// The inputs of one TS transform step (DESIGN.md §3e "The context API", "Rows are guarded against renamed
// columns", "User code never holds the warehouse lock", "Positions never skip rows").
//
//   ctx.rows(x)      every row of input x, from <staging>/<asset>/in/<x>/all.parquet
//   ctx.newRows(x)   the rows after the transform's composite position in x, from new.parquet (an incremental
//                    transform; a full-refresh one keeps no position, so newRows() is rows() there)
//   ctx.query(sql)   one SELECT over the declared inputs, each a view over its all.parquet
//
// Each snapshot is taken on first use, under one short read lease (run/snapshot.ts), and read through a private
// in-memory DuckDB (the "memory" sandbox profile: only the state folder is readable, and the one-SELECT gate
// protects even that from user SQL). Iterators stream their file chunk by chunk on a connection of their own, so
// nested loops and ctx.query() calls in the middle of a loop do not disturb each other.
//
// Rows are plain objects behind a Proxy: reading a column the input does not have throws UNKNOWN_INPUT_COLUMN
// with a did-you-mean, instead of handing back undefined (which would be stored as NULL and pass every rule
// check). croft's own columns (_loaded_at, _file) are readable but not enumerable, so `yield { ...row }` passes
// the data through without them, as an SQL transform's reserved-column exclusion does.
//
// Positions. newRows() hands rows over in snapshot order, (_loaded_at, key). An input row counts as fully
// processed once the code asks for the next one (the usual `for await` loop has yielded every output of a row
// by then); the position of an input is the last such row, across every newRows() iterator of it (the least
// advanced one wins). A loop left early (break, a throw) does not count its last row as processed: the next
// run reads it again rather than skip it. Asking for the next row is also where transform.ts may commit a
// chunk (onRequest), since at that moment every output yielded so far belongs to rows up to the position.
import { readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { DuckDBConnection } from "@duckdb/node-api";
import { CroftError, type ProblemInit } from "../core/errors.ts";
import type { Fix } from "../core/types.ts";
import type { Row } from "../types.ts";
import { openMemory } from "../db/connect.ts";
import { renderValueRows, resultShape } from "../db/values.ts";
import { LeaseSql, type DuckWarehouse } from "../db/warehouse.ts";
import { RESERVED } from "../load/contract.ts";
import type { InputPosition } from "../load/write.ts";
import { quoteIdent, quoteLiteral, type RealColumn } from "../load/evolve.ts";
import { didYouMean } from "../project/suggest.ts";
import { mapQueryError } from "../read/select.ts";
import { relationNames } from "../sql/ast.ts";
import { assertOneSelect } from "../sql/gate.ts";
import { croftError } from "./ingest.ts";
import { type InputFacts, type InputSnapshot, type SeenPosition, snapshotColumnsSql, snapshotInput } from "./snapshot.ts";

/** Properties that code outside the asset reads off any object it is handed (await, JSON.stringify, test
 *  matchers, React): they are never columns, and a guarded row answers undefined for them instead of throwing. */
const PROBED = new Set(["then", "toJSON", "asymmetricMatch", "$$typeof", "nodeType", "inspect"]);
/** croft's columns: readable on a row, left out of its enumerable keys. */
const HIDDEN = new Set<string>([RESERVED.loadedAt, RESERVED.file]);
/** Extra columns an iterator reads for positions; never part of a row. */
const POS_PREFIX = "__croft_pos_";

const CROFT_SRC = fileURLToPath(new URL("../", import.meta.url));

/** The error an aborted step ends with: the signal's own (TIMEOUT, INTERRUPTED), else INTERRUPTED. */
export function stepAborted(signal: AbortSignal, asset: string): CroftError {
  return croftError(signal.reason) ?? new CroftError("INTERRUPTED", {
    asset, message: `${asset} was interrupted`, hint: "run it again; it continues after the last chunk it committed",
  });
}

export interface TransformInputsOptions {
  warehouse: DuckWarehouse;
  asset: string;
  /** The asset's file, root-relative ("assets/issue_triage.ts"), for problem locations. */
  file: string;
  root: string;
  /** The step's staging folder, <state>/staging/<run>/<asset>; snapshots go to its in/<input>/. */
  stageDir: string;
  stateDir: string;
  timezone: string;
  signal: AbortSignal;
  /** The declared inputs. */
  inputs: readonly string[];
  /** What the step's state read found for each input (null: no table). */
  facts: ReadonlyMap<string, InputFacts | null>;
  /** The committed positions (_croft.inputs), by input. */
  saved: ReadonlyMap<string, SeenPosition | null>;
  /** Incremental transforms read newRows() after their positions and track them; a full-refresh transform
   *  keeps no position, so its newRows() is rows(). */
  incremental: boolean;
  /** croft preview's cap: at most this many rows of each input. */
  limit?: number;
  /** Called for every input row handed to the code (the no-progress watchdog counts it). */
  onRow?: () => void;
  /** Called each time the code asks newRows() for its next row, after the position moved past the previous one
   *  and before the next is read: transform.ts commits a chunk here. A rejection reaches the code. */
  onRequest?: () => Promise<void>;
}

/** One newRows() iterator's progress over the input's new.parquet. */
interface NewIterator {
  /** Rows fully processed (the code asked for the one after), and the position after them (null: none yet). */
  done: number;
  donePos: SeenPosition | null;
  /** Rows handed over, and the position of the last one. */
  delivered: number;
  last: SeenPosition | null;
  /** The file was read to its end. */
  completed: boolean;
}

interface InputUse {
  /** The snapshots, being taken (a failed one is forgotten, to be tried again), and once taken. */
  all?: Promise<InputSnapshot>;
  new?: Promise<InputSnapshot>;
  allSnapshot?: InputSnapshot;
  newSnapshot?: InputSnapshot;
  /** The all.parquet view that ctx.query reads. */
  view?: Promise<void>;
  /** newRows() iterators of an incremental transform. */
  iterators: NewIterator[];
  /** Rows handed to the code, by rows() and newRows(). */
  rows: number;
}

export class TransformInputs {
  #db: Awaited<ReturnType<typeof openMemory>> | null = null;
  #opening: Promise<Awaited<ReturnType<typeof openMemory>>> | null = null;
  #idle: DuckDBConnection[] = [];
  #queryConn: Promise<DuckDBConnection> | null = null;
  #queryChain: Promise<unknown> = Promise.resolve();
  #uses = new Map<string, InputUse>();
  #closed = false;

  constructor(private readonly o: TransformInputsOptions) {
    for (const name of o.inputs) this.#uses.set(name, { iterators: [], rows: 0 });
  }

  // -------------------------------------------------------------------------------------------------------
  // The context API

  /** ctx.rows(input): every row of a declared input. */
  rows(input: string): AsyncIterable<Row> {
    const name = this.declared(input, "rows");
    this.assertBuilt(name);
    return { [Symbol.asyncIterator]: () => this.fullIterator(name) };
  }

  /** ctx.newRows(input): the rows after the position (incremental), else every row. */
  newRows(input: string): AsyncIterable<Row> {
    const name = this.declared(input, "newRows");
    this.assertBuilt(name);
    if (!this.o.incremental) return { [Symbol.asyncIterator]: () => this.fullIterator(name) };
    const facts = this.o.facts.get(name);
    if (facts && facts.key.length === 0) throw this.needsKey(name);
    return { [Symbol.asyncIterator]: () => this.newIterator(name) };
  }

  /** ctx.query(sql, ...params): one SELECT over the declared inputs. */
  query(sql: string, params: unknown[]): Promise<Row[]> {
    // The caller's line, for problems: the query itself runs after an await, where the stack no longer has it.
    const caller = new Error().stack ?? "";
    const run = this.#queryChain.then(() => this.runQuery(sql, params, caller));
    this.#queryChain = run.catch(() => {});
    return run;
  }

  // -------------------------------------------------------------------------------------------------------
  // Positions

  /** The position of one input: the least advanced newRows() iterator's, else the committed one. */
  position(input: string): SeenPosition | null {
    const use = this.#uses.get(input);
    const saved = this.o.saved.get(input) ?? null;
    if (!use || use.iterators.length === 0) return saved;
    let least = use.iterators[0]!;
    for (const it of use.iterators) if (it.done < least.done) least = it;
    return least.donePos ?? saved;
  }

  /** Inputs read with newRows() in this step (incremental transforms only). */
  tracked(): string[] {
    return this.o.inputs.filter((n) => (this.#uses.get(n)?.iterators.length ?? 0) > 0);
  }

  /** The positions to commit with a chunk in the middle of the code's work: every input newRows() moved, none
   *  of them read to its end yet (inputLastLoadedAt null, so staleness still sees the input as changed). */
  chunkPositions(): InputPosition[] {
    return this.tracked().map((input) => {
      const p = this.position(input);
      return { input, seenLoadedAt: p?.stamp ?? null, seenKey: p?.key ?? null, inputLastLoadedAt: null };
    });
  }

  /**
   * The positions to commit when the code has finished, for every declared input:
   * - read with newRows(): its position; the input's last_loaded_at counts as seen only when every newRows()
   *   iterator read its snapshot to the end (and no row cap cut it short);
   * - otherwise (read in full, or not at all): an incremental transform keeps its newRows() position, and a
   *   full-refresh one records the input's last_loaded_at, as SQL steps do; either way the input counts as seen
   *   at the last_loaded_at of what the code could read.
   */
  finalPositions(): InputPosition[] {
    return this.o.inputs.map((input) => {
      const use = this.#uses.get(input)!;
      const at = this.seenAt(input);
      if (this.o.incremental && use.iterators.length > 0) {
        const p = this.position(input);
        const snap = use.newSnapshot;
        const complete = use.iterators.every((it) => it.completed) && snap !== undefined && !snap.capped;
        return { input, seenLoadedAt: p?.stamp ?? null, seenKey: p?.key ?? null, inputLastLoadedAt: complete ? snap.facts.lastLoadedAt : null };
      }
      if (this.o.incremental) {
        const saved = this.o.saved.get(input) ?? null;
        return { input, seenLoadedAt: saved?.stamp ?? null, seenKey: saved?.key ?? null, inputLastLoadedAt: at.capped ? null : at.lastLoadedAt };
      }
      return { input, seenLoadedAt: at.lastLoadedAt, seenKey: null, inputLastLoadedAt: at.capped ? null : at.lastLoadedAt };
    });
  }

  /** What the step read of each input, for StepResult.inputs and _croft.writes.inputs. */
  summary(positions: readonly InputPosition[]): { input: string; seenBefore: string | null; seenAfter: string; rows: number }[] {
    return this.o.inputs.map((input) => {
      const p = positions.find((x) => x.input === input);
      const before = this.o.saved.get(input)?.stamp ?? null;
      return { input, seenBefore: before, seenAfter: p?.seenLoadedAt ?? p?.inputLastLoadedAt ?? before ?? "", rows: this.#uses.get(input)?.rows ?? 0 };
    });
  }

  /** Rows newRows() handed over in this step, over every input (incremental transforms). */
  newRowsRead(): number {
    let n = 0;
    for (const u of this.#uses.values()) for (const it of u.iterators) n += it.delivered;
    return n;
  }

  /** Whether a row cap cut any snapshot short (croft preview's partial result). */
  capped(): boolean {
    return [...this.#uses.values()].some((u) => u.allSnapshot?.capped || u.newSnapshot?.capped);
  }

  close(): void {
    this.#closed = true;
    try {
      this.#db?.close();
    } catch {}
    this.#db = null;
    this.#idle = [];
  }

  // -------------------------------------------------------------------------------------------------------

  private seenAt(input: string): { lastLoadedAt: string | null; capped: boolean } {
    const use = this.#uses.get(input);
    const snap = use?.allSnapshot ?? use?.newSnapshot;
    if (snap) return { lastLoadedAt: snap.facts.lastLoadedAt, capped: snap.capped };
    return { lastLoadedAt: this.o.facts.get(input)?.lastLoadedAt ?? null, capped: false };
  }

  private declared(input: unknown, via: "rows" | "newRows" | "query"): string {
    const name = typeof input === "string" ? input : String(input);
    if (this.#uses.has(name)) return name;
    throw this.undeclared(name, via);
  }

  private assertBuilt(name: string): void {
    if (this.o.facts.get(name) === null) throw this.notBuilt(name);
  }

  private snapshot(name: string, kind: "all" | "new"): Promise<InputSnapshot> {
    const use = this.#uses.get(name)!;
    const existing = use[kind];
    if (existing) return existing;
    const p = (async () => {
      if (this.#closed) throw this.afterStep(name);
      const snap = await snapshotInput(this.o.warehouse, {
        input: name, dir: join(this.o.stageDir, "in", name), kind, after: kind === "new" ? this.o.saved.get(name) ?? null : null,
        ...(this.o.limit !== undefined ? { limit: this.o.limit } : {}), signal: this.o.signal,
      });
      if (!snap) throw this.notBuilt(name);
      if (kind === "all") use.allSnapshot = snap;
      else use.newSnapshot = snap;
      return snap;
    })();
    use[kind] = p;
    // A failed snapshot (a busy warehouse) is tried again on the next use.
    p.catch(() => { if (use[kind] === p) delete use[kind]; });
    return p;
  }

  private async database(): Promise<Awaited<ReturnType<typeof openMemory>>> {
    if (this.#db) return this.#db;
    this.#opening ??= openMemory({ timezone: this.o.timezone, stateDir: this.o.stateDir }).then((db) => {
      if (this.#closed) {
        db.close();
        throw this.afterStep(this.o.asset);
      }
      this.#db = db;
      return db;
    });
    return this.#opening;
  }

  private async acquire(): Promise<DuckDBConnection> {
    const db = await this.database();
    return this.#idle.pop() ?? db.connect();
  }

  private release(conn: DuckDBConnection): void {
    if (!this.#closed) this.#idle.push(conn);
  }

  /** Stream a snapshot's rows chunk by chunk on a connection of its own. */
  private async *stream(snap: InputSnapshot, extra: string[]): AsyncGenerator<Row[]> {
    const conn = await this.acquire();
    try {
      const cap = snap.capped ? ` LIMIT ${snap.rows}` : "";
      const result = await conn.stream(
        `SELECT ${[snapshotColumnsSql(snap.facts.columns), ...extra].join(", ")} FROM read_parquet(${quoteLiteral(snap.path)})${cap}`);
      const shape = resultShape(result);
      const ctx = { mode: "ts" as const, timezone: this.o.timezone };
      for (;;) {
        // An aborted step must not look like the end of the input: that would count every row as processed.
        if (this.o.signal.aborted) throw stepAborted(this.o.signal, this.o.asset);
        const chunk = await result.fetchChunk();
        if (!chunk || chunk.rowCount === 0) return;
        yield renderValueRows(chunk.getRows(), shape, ctx);
      }
    } finally {
      this.release(conn);
    }
  }

  /** rows(): the whole input (and a full-refresh transform's newRows()). */
  private fullIterator(name: string): AsyncIterator<Row> {
    const use = this.#uses.get(name)!;
    let rows: AsyncGenerator<Row[]> | null = null;
    let page: Row[] = [];
    let at = 0;
    const guard = this.guard(name);
    return {
      next: async (): Promise<IteratorResult<Row>> => {
        if (!rows) {
          const snap = await this.snapshot(name, "all");
          guard.columns(snap.facts.columns);
          rows = this.stream(snap, []);
        }
        while (at >= page.length) {
          const n = await rows.next();
          if (n.done) return { done: true, value: undefined };
          page = n.value;
          at = 0;
        }
        use.rows++;
        this.o.onRow?.();
        return { done: false, value: guard.row(page[at++]!) };
      },
      return: async (): Promise<IteratorResult<Row>> => {
        await rows?.return(undefined);
        return { done: true, value: undefined };
      },
    };
  }

  /** newRows() of an incremental transform: the rows after the position, with the position tracked. */
  private newIterator(name: string): AsyncIterator<Row> {
    const use = this.#uses.get(name)!;
    const it: NewIterator = { done: 0, donePos: null, delivered: 0, last: null, completed: false };
    use.iterators.push(it);
    let rows: AsyncGenerator<Row[]> | null = null;
    let page: Row[] = [];
    let at = 0;
    let keyCount = 0;
    const guard = this.guard(name);
    return {
      next: async (): Promise<IteratorResult<Row>> => {
        // Asking for the next row: the previous one is processed.
        it.done = it.delivered;
        it.donePos = it.last;
        if (it.completed) return { done: true, value: undefined };
        await this.o.onRequest?.();
        if (!rows) {
          const snap = await this.snapshot(name, "new");
          guard.columns(snap.facts.columns);
          keyCount = snap.facts.key.length;
          const extra = snap.facts.key.map((k, i) => `CAST(${quoteIdent(k.name)} AS VARCHAR) AS ${quoteIdent(POS_PREFIX + i)}`);
          rows = this.stream(snap, extra);
        }
        while (at >= page.length) {
          const n = await rows.next();
          if (n.done) {
            it.completed = true;
            return { done: true, value: undefined };
          }
          page = n.value;
          at = 0;
        }
        const data = page[at++]!;
        const key: string[] = [];
        for (let i = 0; i < keyCount; i++) {
          key.push(String(data[POS_PREFIX + i]));
          delete data[POS_PREFIX + i];
        }
        const stamp = data[RESERVED.loadedAt];
        it.last = typeof stamp === "string" ? { stamp, key: keyCount > 0 ? key : null } : it.last;
        it.delivered++;
        use.rows++;
        this.o.onRow?.();
        return { done: false, value: guard.row(data) };
      },
      // Left early (break, or a throw in the loop): the last row handed over is not counted as processed.
      return: async (): Promise<IteratorResult<Row>> => {
        await rows?.return(undefined);
        return { done: true, value: undefined };
      },
    };
  }

  private async runQuery(sql: string, params: unknown[], caller: string): Promise<Row[]> {
    if (typeof sql !== "string") {
      throw new CroftError("QUERY_NOT_SELECT", {
        asset: this.o.asset, ...this.at(caller), message: "ctx.query takes one SELECT as a string",
        hint: `for example: await query("select count(*) as n from ${this.o.inputs[0] ?? "my_input"}")`,
      });
    }
    if (this.#closed) throw this.afterStep(this.o.asset);
    this.#queryConn ??= this.acquire();
    let conn: DuckDBConnection;
    try {
      conn = await this.#queryConn;
    } catch (e) {
      this.#queryConn = null;
      throw e;
    }
    let ast: Awaited<ReturnType<typeof assertOneSelect>>;
    try {
      ast = await assertOneSelect(conn, sql, { profile: "memory", protect: [this.o.stateDir] });
    } catch (e) {
      throw this.queryFailed(e, sql, caller);
    }
    const names = relationNames(ast);
    const declared = new Map([...this.#uses.keys()].map((n) => [n.toLowerCase(), n]));
    const unknown = names.find((n) => !declared.has(n));
    if (unknown !== undefined) throw this.undeclared(unknown, "query", caller);
    for (const n of names) {
      const name = declared.get(n)!;
      this.assertBuilt(name);
      await this.view(conn, name);
    }
    let rows: Row[];
    let columns: string[];
    try {
      const out = await new LeaseSql(conn, { mode: "ts", timezone: this.o.timezone }, null).query(sql, params);
      rows = out.rows;
      columns = out.columns.map((c) => c.name);
    } catch (e) {
      throw this.queryFailed(mapQueryError(e, "memory"), sql, caller);
    }
    const guard = this.guard(null);
    guard.names(columns);
    return rows.map((r) => guard.row(r));
  }

  /** The all.parquet view that puts an input under its own name for ctx.query. */
  private view(conn: DuckDBConnection, name: string): Promise<void> {
    const use = this.#uses.get(name)!;
    use.view ??= (async () => {
      const snap = await this.snapshot(name, "all");
      const cap = snap.capped ? ` LIMIT ${snap.rows}` : "";
      await conn.run(`CREATE OR REPLACE VIEW ${quoteIdent(name)} AS SELECT ${snapshotColumnsSql(snap.facts.columns)} FROM read_parquet(${quoteLiteral(snap.path)})${cap}`);
    })();
    use.view.catch(() => { delete use.view; });
    return use.view;
  }

  // -------------------------------------------------------------------------------------------------------
  // Guarded rows

  /** The Proxy guard for rows of one input (null: a ctx.query result). */
  private guard(input: string | null): { columns(cols: readonly RealColumn[]): void; names(cols: readonly string[]): void; row(data: Row): Row } {
    let columns: string[] = [];
    const handler: ProxyHandler<Row> = {
      get: (target, prop, receiver) => {
        if (typeof prop === "string" && !(prop in target) && !PROBED.has(prop)) throw this.unknownColumn(input, prop, columns);
        return Reflect.get(target, prop, receiver);
      },
    };
    return {
      columns: (cols) => { columns = cols.map((c) => c.name); },
      names: (cols) => { columns = [...cols]; },
      row: (data) => {
        for (const k of HIDDEN) if (Object.hasOwn(data, k)) Object.defineProperty(data, k, { enumerable: false });
        return new Proxy(data, handler);
      },
    };
  }

  // -------------------------------------------------------------------------------------------------------
  // Problems

  /** The first stack frame in the project's own code (the asset or lib/), for a problem's location: of `stack`,
   *  or of the current call. */
  private callSite(stack = new Error().stack ?? ""): { file: string; line: number; column?: number } | null {
    const roots = [this.o.root];
    try {
      const real = realpathSync(this.o.root);
      if (real !== this.o.root) roots.push(real);
    } catch {}
    for (const line of stack.split("\n")) {
      const m = /^\s*at (?:.*? \()?(?:file:\/\/)?(.+?)(?:\?[^:]*)?:(\d+)(?::(\d+))?\)?\s*$/.exec(line);
      if (!m) continue;
      const path = m[1]!;
      if (path.startsWith(CROFT_SRC) || path.split(sep).includes("node_modules")) continue;
      const root = roots.find((r) => path.startsWith(r + sep));
      if (!root) continue;
      return { file: relative(root, path).split(sep).join("/"), line: Number(m[2]), ...(m[3] ? { column: Number(m[3]) } : {}) };
    }
    return null;
  }

  private at(stack?: string): Pick<ProblemInit, "file" | "line" | "column"> {
    const site = this.callSite(stack);
    return site ? { file: site.file, line: site.line, ...(site.column ? { column: site.column } : {}) } : { file: this.o.file };
  }

  /** Whether `word` stands exactly once, as a whole name, on a line of a project file: a replace fix that is
   *  safe to apply as is. */
  private once(file: string, line: number, word: string): boolean {
    try {
      const text = readFileSync(join(this.o.root, file), "utf8").split("\n")[line - 1] ?? "";
      const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return (text.match(new RegExp(`(?<![\\w$])${esc}(?![\\w$])`, "g")) ?? []).length === 1;
    } catch {
      return false;
    }
  }

  private unknownColumn(input: string | null, column: string, columns: readonly string[]): CroftError {
    const guess = didYouMean(column, columns);
    const what = input ?? "the ctx.query result";
    const at = this.at();
    const list = columns.filter((c) => !c.startsWith(POS_PREFIX)).join(", ");
    const file = at.file ?? this.o.file;
    const fix: Fix | undefined = guess
      ? {
        kind: "edit", description: `read ${JSON.stringify(guess)} instead of ${JSON.stringify(column)}`, file,
        ...(at.line ? { line: at.line } : {}),
        ...(at.line && this.once(file, at.line, column) ? { replace: { from: column, to: guess } } : {}),
      }
      : undefined;
    return new CroftError("UNKNOWN_INPUT_COLUMN", {
      asset: this.o.asset, ...at,
      message: `${what} has no column ${JSON.stringify(column)}${guess ? `; did you mean ${JSON.stringify(guess)}?` : ""}`,
      hint: guess
        ? `the column may have been renamed upstream; read ${JSON.stringify(guess)} instead`
        : `${what} has these columns: ${list}`,
      ...(fix ? { fix } : {}),
      effect: "nothing was written",
      details: { input, column, ...(guess ? { suggestion: guess } : {}), columns: columns.filter((c) => !c.startsWith(POS_PREFIX)) },
    });
  }

  private undeclared(name: string, via: "rows" | "newRows" | "query", stack?: string): CroftError {
    const at = this.at(stack);
    const self = name.toLowerCase() === this.o.asset;
    const guess = didYouMean(name, [...this.#uses.keys()]);
    const listed = this.o.inputs.map((n) => JSON.stringify(n)).join(", ");
    return new CroftError("UNDECLARED_INPUT", {
      asset: this.o.asset, ...at,
      message: self
        ? `${this.o.asset} reads its own table in ${via === "query" ? "ctx.query" : `${via}()`}; a transform computes its table from its inputs`
        : `${this.o.asset} reads ${name} in ${via === "query" ? "ctx.query" : `${via}()`}, but ${name} is not in its inputs (${listed})`,
      hint: self
        ? "read only the inputs; to build on earlier results, make the transform incremental (incremental: true, newRows())"
        : guess && guess !== name
          ? `did you mean ${guess}? otherwise add ${JSON.stringify(name)} to inputs, so croft builds it first and knows the dependency`
          : `add ${JSON.stringify(name)} to inputs in ${this.o.file}, so croft builds it first and knows the dependency`,
      ...(self ? {} : { fix: { kind: "edit" as const, description: `add ${JSON.stringify(name)} to inputs: [${[...this.o.inputs, name].map((n) => JSON.stringify(n)).join(", ")}]`, file: this.o.file } }),
      details: { input: name, via, inputs: [...this.o.inputs], ...(guess ? { suggestion: guess } : {}) },
    });
  }

  private needsKey(name: string): CroftError {
    return new CroftError("INPUT_NEEDS_KEY", {
      asset: this.o.asset, ...this.at(),
      message: `${this.o.asset} reads ${name} with newRows(), and ${name} has no key; newRows() remembers its place by (_loaded_at, key)`,
      hint: `give ${name} a key (-- key: in its SQL header, or key: in its TS config), or read it with rows()`,
      details: { input: name },
    });
  }

  private notBuilt(name: string): CroftError {
    return new CroftError("DB_NOT_FOUND", {
      asset: this.o.asset,
      message: `${this.o.asset} reads ${name}, which is not built yet`,
      hint: `build it first: croft run ${name}`,
      fix: { kind: "command", description: `build ${name}`, command: `croft run ${name}` },
      details: { input: name },
    });
  }

  private afterStep(name: string): CroftError {
    return new CroftError("QUERY_FAILED", {
      asset: this.o.asset,
      message: `${name} was read after ${this.o.asset}'s step finished`,
      hint: "await every rows(), newRows() and query() inside rows()",
    });
  }

  private queryFailed(e: unknown, sql: string, caller: string): unknown {
    if (!(e instanceof CroftError)) return e;
    const { severity: _s, code: _c, docs: _d, ...init } = e.problem;
    return new CroftError(e.code, {
      ...init, asset: this.o.asset, ...this.at(caller),
      message: `ctx.query: ${init.message}`,
      details: { ...init.details, sql: sql.slice(0, 500) },
    });
  }
}
