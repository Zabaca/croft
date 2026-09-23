import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CroftError } from "../core/errors.ts";
import type { Sql } from "../core/types.ts";
import { openMemory } from "../db/connect.ts";
import { closeAllWarehouses, type DuckWarehouse, LeaseSql, openWarehouse } from "../db/warehouse.ts";
import { createHttp } from "../http/http.ts";
import { readStoredColumns } from "../safety/guards.ts";
import type { FileIngest, Http, HttpInit, HttpResponse } from "../types.ts";
import { ident } from "./classify.ts";
import {
  buildFileBatch, type ByteHttp, extractFiles, type ExtractFilesInput, type FileBatch, type FileExtract, fileId, formatFromContentType, formatFromName,
  parquetColumn, readKnownFiles, recordFiles,
} from "./files.ts";
import { type KnownColumn, normalizePins } from "./types.ts";
import { type WriteResult, writeBatch } from "./write.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const cleanups: (() => void | Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups) await c();
  await closeAllWarehouses();
});

const noHttp: Http = {
  get: () => Promise.reject(new Error("no network in this test")),
  post: () => Promise.reject(new Error("no network in this test")),
};

let runSeq = 0;

interface Project {
  root: string;
  stateDir: string;
  w: DuckWarehouse;
  timezone: string;
  asset: string;
  /** Write a file under the project (text, bytes, or a fixture copied by name). */
  put(rel: string, content: string | Uint8Array | { fixture: string }): string;
  remove(rel: string): void;
}

function project(o: { timezone?: string; asset?: string } = {}): Project {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-files-")));
  const stateDir = join(root, ".croft");
  mkdirSync(join(root, "files"), { recursive: true });
  mkdirSync(stateDir);
  const timezone = o.timezone ?? "UTC";
  const w = openWarehouse({ path: join(root, "warehouse.duckdb"), mode: "read_write", timezone, root, stateDir, register: false, isTTY: false });
  return {
    root, stateDir, w, timezone, asset: o.asset ?? "sales",
    put(rel, content) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      if (typeof content === "object" && "fixture" in content) copyFileSync(join(FIXTURES, content.fixture), abs);
      else writeFileSync(abs, content);
      return abs;
    },
    remove(rel) {
      rmSync(join(root, rel));
    },
  };
}

async function knownColumnsOf(sql: Sql, asset: string): Promise<KnownColumn[]> {
  return (await readStoredColumns(sql, asset)).map((c) => ({
    name: c.name, type: c.type, sourceName: c.source_name, format: c.format, pinned: c.pinned, pending: c.pending, kinds: c.kinds,
  }));
}

type Config = Omit<FileIngest, "rows">;

async function extract(p: Project, config: Config, o: Partial<ExtractFilesInput> = {}): Promise<FileExtract> {
  const known = await p.w.read((db) => readKnownFiles(db, p.asset), { purpose: "test" });
  const knownColumns = await p.w.read((db) => knownColumnsOf(db, p.asset), { purpose: "test" });
  return extractFiles({
    asset: p.asset, config: config as FileIngest, root: p.root, stateDir: p.stateDir, runId: `r_${++runSeq}`, known, http: noHttp,
    signal: new AbortController().signal, knownColumns, timezone: p.timezone, ...o,
  });
}

interface Loaded { extract: FileExtract; batch?: FileBatch; result?: WriteResult }

/** One ingest step as the runner does it: extract, then build + write + record in one real write lease. */
async function run(p: Project, config: Config, o: Partial<ExtractFilesInput> = {}): Promise<Loaded> {
  const ex = await extract(p, config, o);
  if (ex.unchanged) return { extract: ex };
  const key = config.key === undefined ? [] : Array.isArray(config.key) ? config.key : [config.key];
  const write = config.incremental ? (key.length ? "merge" : "append") : "replace";
  const pins = normalizePins(config.columns as Record<string, string | { type: string; format?: string }> | undefined);
  const runId = `r_${++runSeq}`;
  return p.w.write(p.asset, async (tx) => {
    const batch = await buildFileBatch(tx, { extract: ex, knownColumns: await knownColumnsOf(tx, p.asset), pins, timezone: p.timezone });
    const result = await writeBatch(tx, {
      batch, target: { asset: p.asset, write, key, runId, ...(batch.replaceFiles ? { replaceFiles: batch.replaceFiles } : {}) },
      formats: batch.formats, pins,
    });
    await recordFiles(tx, p.asset, ex, result.loadedAt);
    return { extract: ex, batch, result };
  }, { runId });
}

const q = <T = Record<string, unknown>>(p: Project, sql: string, params?: unknown[]) => p.w.read((db) => db.all<T>(sql, params), { purpose: "test" });
const types = async (p: Project, table = p.asset) =>
  Object.fromEntries((await q<{ column_name: string; column_type: string }>(p, `DESCRIBE ${ident(table)}`)).map((r) => [r.column_name, r.column_type]));
const columnsRow = (p: Project) => q<{ name: string; type: string; format: string | null; source_name: string }>(p, `SELECT name, type, format, source_name FROM _croft.columns WHERE asset = $1 ORDER BY name`, [p.asset]);

async function failure(p: Promise<unknown>): Promise<CroftError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
  throw new Error("expected a CroftError");
}

const codes = (l: { warnings?: { code: string }[] } | undefined) => (l?.warnings ?? []).map((w) => w.code);

// ---------------------------------------------------------------------------------------------------------

describe("formats and names", () => {
  test("format from the extension, .gz looked through, and from Content-Type", () => {
    expect(formatFromName("files/a.csv")).toBe("csv");
    expect(formatFromName("A.TSV")).toBe("tsv");
    expect(formatFromName("x.jsonl")).toBe("ndjson");
    expect(formatFromName("x.ndjson")).toBe("ndjson");
    expect(formatFromName("x.json.gz")).toBe("json");
    expect(formatFromName("x.parquet")).toBe("parquet");
    expect(formatFromName("x.xlsx")).toBeUndefined();
    expect(formatFromContentType("text/csv; charset=utf-8")).toBe("csv");
    expect(formatFromContentType("application/json")).toBe("json");
    expect(formatFromContentType("application/x-ndjson")).toBe("ndjson");
    expect(formatFromContentType("application/vnd.apache.parquet")).toBe("parquet");
    expect(formatFromContentType("text/html")).toBeUndefined();
  });

  test("file identity: root-relative with /, absolute outside the root", () => {
    expect(fileId("/p", "/p/files/a.csv")).toBe("files/a.csv");
    expect(fileId("/p", "/data/a.csv")).toBe("/data/a.csv");
  });

  test("Parquet types normalize to croft's lattice", () => {
    expect(parquetColumn("a", "SMALLINT")).toEqual({ expr: `CAST("a" AS BIGINT)`, type: "BIGINT" });
    expect(parquetColumn("a", "INTEGER").type).toBe("BIGINT");
    expect(parquetColumn("a", "UBIGINT").type).toBe("HUGEINT");
    expect(parquetColumn("a", "FLOAT")).toEqual({ expr: `CAST(CAST("a" AS VARCHAR) AS DOUBLE)`, type: "DOUBLE" });
    expect(parquetColumn("a", "UUID").type).toBe("VARCHAR");
    expect(parquetColumn("a", "STRUCT(a INTEGER, b INTEGER[])").type).toBe("JSON");
    expect(parquetColumn("a", "INTEGER[]").type).toBe("JSON");
    expect(parquetColumn("a", "MAP(VARCHAR, INTEGER)").type).toBe("JSON");
    expect(parquetColumn("a", "TIMESTAMP_NS").type).toBe("TIMESTAMP");
    expect(parquetColumn("a", "TIMESTAMP WITH TIME ZONE")).toEqual({ expr: `"a"`, type: "TIMESTAMPTZ" });
    expect(parquetColumn("a", "DECIMAL(18,2)").type).toBe("DECIMAL(18,2)");
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("DuckDB and Bun behaviors this module relies on", () => {
  async function memory() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "croft-files-v-")));
    const db = await openMemory({ timezone: "UTC", stateDir: dir });
    cleanups.push(() => db.close());
    const conn = await db.connect();
    return { dir, conn, sql: new LeaseSql(conn, { mode: "ts", timezone: "UTC" }, null) };
  }

  test("a latin-1 CSV read as UTF-8 fails and aborts the transaction; JavaScript's fatal decoder agrees", async () => {
    const { dir, conn, sql } = await memory();
    copyFileSync(join(FIXTURES, "latin1.csv"), join(dir, "l.csv"));
    await conn.run("BEGIN TRANSACTION");
    const err = await sql.all(`SELECT * FROM read_csv('${dir}/l.csv', all_varchar = true)`).catch((e: Error) => e);
    expect(String(err)).toContain("not utf-8 encoded");
    const after = await sql.all(`SELECT 1 AS one`).catch((e: Error) => e);
    expect(String(after)).toContain("transaction is aborted");
    await conn.run("ROLLBACK");
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(join(dir, "l.csv")))).toThrow();
    expect(await sql.all(`SELECT name FROM read_csv('${dir}/l.csv', all_varchar = true, encoding = 'latin-1') ORDER BY id`)).toEqual([{ name: "José" }, { name: "Zoë" }]);
  });

  test("sniff_csv calls a header-less all-text file's first line a header, and skips a preamble", async () => {
    const { dir, sql } = await memory();
    copyFileSync(join(FIXTURES, "names-no-header.csv"), join(dir, "n.csv"));
    writeFileSync(join(dir, "pre.csv"), "exported by shop\n\nid,name\n1,x\n");
    const [n] = await sql.all<{ HasHeader: boolean; Columns: { type: string }[] }>(`SELECT HasHeader, Columns FROM sniff_csv('${dir}/n.csv')`);
    expect(n!.HasHeader).toBe(true);
    expect(n!.Columns.every((c) => c.type === "VARCHAR")).toBe(true);
    const [pre] = await sql.all<{ SkipRows: number }>(`SELECT SkipRows FROM sniff_csv('${dir}/pre.csv')`);
    expect(Number(pre!.SkipRows)).toBe(2);
  });

  test("union_by_name keeps a later file's column and matches names case-insensitively; rowid follows file order", async () => {
    const { dir, sql } = await memory();
    writeFileSync(join(dir, "a.csv"), "id,Name\n1,x\n");
    writeFileSync(join(dir, "b.csv"), "ID,name,coupon\n2,y,C\n");
    await sql.exec(`CREATE TEMP TABLE t AS SELECT * FROM read_csv(['${dir}/b.csv', '${dir}/a.csv'], all_varchar = true, union_by_name = true, filename = 'src')`);
    // The first file's spelling wins ("ID"); the column answers to either case.
    const rows = await sql.all<Record<string, unknown>>(`SELECT rowid AS r, id AS id, name AS name, coupon, src FROM t ORDER BY rowid`);
    expect(rows).toEqual([
      { r: 0, id: "2", name: "y", coupon: "C", src: `${dir}/b.csv` },
      { r: 1, id: "1", name: "x", coupon: null, src: `${dir}/a.csv` },
    ]);
  });

  test("with an explicit dialect a ragged file fails instead of being re-dialected; the default sniff drops lines or goes one-column", async () => {
    const { dir, sql } = await memory();
    writeFileSync(join(dir, "r.csv"), "id,name\n1,a\n2,b,c\n");
    expect(await sql.all(`SELECT * FROM read_csv('${dir}/r.csv', all_varchar = true)`)).toHaveLength(1); // two lines silently gone
    const err = await sql.all(`SELECT * FROM read_csv('${dir}/r.csv', all_varchar = true, header = true, delim = ',', quote = '"', escape = '"', skip = 0)`).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    writeFileSync(join(dir, "r2.csv"), "id,name,note\n1,a,x\n2,b,y\n3,c,z,EXTRA\n4,d,w\n");
    const [sniffed] = await sql.all<{ Delimiter: string; Columns: { name: string }[] }>(`SELECT Delimiter, Columns FROM sniff_csv('${dir}/r2.csv')`);
    expect(sniffed!.Delimiter).not.toBe(",");
    expect(sniffed!.Columns.map((c) => c.name)).toEqual(["id,name,note"]);
    const strict = await sql.all(`SELECT count(*) FROM read_csv('${dir}/r2.csv', auto_detect = false, header = true, delim = ',', quote = '"', escape = '"', columns = {'a': 'VARCHAR', 'b': 'VARCHAR', 'c': 'VARCHAR'})`).catch((e: Error) => e);
    expect(String(strict)).toContain("Line: 4");
  });

  test("rows a transaction inserts get transaction-local rowids, contiguous in insertion order", async () => {
    const { conn, sql } = await memory();
    await conn.run("BEGIN TRANSACTION");
    await sql.exec(`CREATE TEMP TABLE t (a VARCHAR)`);
    await sql.exec(`INSERT INTO t SELECT 'x' || i FROM range(3) r(i)`);
    await sql.exec(`INSERT INTO t SELECT 'y' || i FROM range(1000) r(i)`);
    const [r] = await sql.all<{ lo: string; hi: string; n: number; bad: number }>(
      `SELECT min(rowid)::VARCHAR AS lo, max(rowid)::VARCHAR AS hi, count(*)::INTEGER AS n,
        count(*) FILTER (WHERE a <> CASE WHEN rowid - (SELECT min(rowid) FROM t) < 3 THEN 'x' || (rowid - (SELECT min(rowid) FROM t)) ELSE 'y' || (rowid - (SELECT min(rowid) FROM t) - 3) END)::INTEGER AS bad FROM t`);
    await conn.run("ROLLBACK");
    expect(BigInt(r!.lo)).toBeGreaterThanOrEqual(36028797018960000n);
    expect(BigInt(r!.hi) - BigInt(r!.lo) + 1n).toBe(1003n);
    expect(r!.bad).toBe(0);
  });

  test("filename = '<name>' keeps a CSV column called filename; INSERT BY NAME is case-insensitive", async () => {
    const { dir, sql } = await memory();
    writeFileSync(join(dir, "f.csv"), "ID,filename\n7,x.txt\n");
    await sql.exec(`CREATE TEMP TABLE t (id VARCHAR, filename VARCHAR, src VARCHAR)`);
    await sql.exec(`INSERT INTO t BY NAME SELECT * FROM read_csv(['${dir}/f.csv'], all_varchar = true, filename = 'src')`);
    expect(await sql.all(`SELECT id, filename FROM t`)).toEqual([{ id: "7", filename: "x.txt" }]);
  });

  test("Bun.Glob returns root-relative matches, skips dot folders, and takes absolute patterns", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-glob-")));
    for (const f of ["files/b.csv", "files/a.csv", "files/sub/c.csv", "files/.hidden/d.csv"]) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), "x");
    }
    const scan = async (pattern: string, cwd: string) => {
      const out: string[] = [];
      for await (const m of new Bun.Glob(pattern).scan({ cwd, onlyFiles: true })) out.push(m);
      return out.sort();
    };
    expect(await scan("files/**/*.csv", root)).toEqual(["files/a.csv", "files/b.csv", "files/sub/c.csv"]);
    expect(await scan(`${root}/files/*.csv`, "/")).toEqual([`${root}/files/a.csv`, `${root}/files/b.csv`]);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("extractFiles", () => {
  test("globs resolve in sorted order to root-relative paths; statuses follow sha256", async () => {
    const p = project();
    p.put("files/sales/2026-02.csv", { fixture: "sales/2026-02.csv" });
    p.put("files/sales/2026-01.csv", { fixture: "sales/2026-01.csv" });
    const cfg = { file: "files/sales/*.csv", incremental: true };
    const first = await extract(p, cfg);
    expect(first.format).toBe("csv");
    expect(first.files.map((f) => [f.path, f.status])).toEqual([["files/sales/2026-01.csv", "new"], ["files/sales/2026-02.csv", "new"]]);
    expect(first.load).toEqual(["files/sales/2026-01.csv", "files/sales/2026-02.csv"]);
    expect(first.unchanged).toBe(false);
    const jan = first.files[0]!;
    expect(jan.size).toBe(readFileSync(join(FIXTURES, "sales/2026-01.csv")).length);
    expect(jan.sha256).toBe(new Bun.CryptoHasher("sha256").update(readFileSync(join(FIXTURES, "sales/2026-01.csv"))).digest("hex"));
    expect(jan.local!.startsWith(join(p.stateDir, "staging"))).toBe(true);
    expect(readFileSync(jan.local!)).toEqual(readFileSync(join(p.root, "files/sales/2026-01.csv")));
    expect(jan.csv).toMatchObject({ encoding: "utf-8", encodingGuessed: false, delimiter: ",", header: true, headerFrom: "sniffed", skip: 0 });

    // Known rows as _croft.files would hold them.
    const known = first.files.map(({ path, size, mtime, etag, sha256 }) => ({ path, size, mtime, etag, sha256 }));
    const again = await extract(p, cfg, { known });
    expect(again.unchanged).toBe(true);
    expect(again.load).toEqual([]);
    expect(again.files.every((f) => f.status === "unchanged" && f.local === undefined)).toBe(true);

    p.put("files/sales/2026-01.csv", readFileSync(join(FIXTURES, "sales/2026-01.csv"), "utf8").replace("$20.00", "$21.00"));
    p.put("files/sales/2026-03.csv", "order_id,email,amount,ordered_on\n1006,f@example.com,$1.00,05/01/2026\n");
    p.remove("files/sales/2026-02.csv");
    const third = await extract(p, cfg, { known });
    expect(third.files.map((f) => [f.path, f.status])).toEqual([
      ["files/sales/2026-01.csv", "changed"], ["files/sales/2026-03.csv", "new"], ["files/sales/2026-02.csv", "gone"],
    ]);
    expect(third.load).toEqual(["files/sales/2026-01.csv", "files/sales/2026-03.csv"]);
    expect(third.gone).toEqual(["files/sales/2026-02.csv"]);

    const rebuilt = await extract(p, cfg, { known, rebuild: true });
    expect(rebuilt.files.filter((f) => f.status !== "gone").map((f) => f.status)).toEqual(["changed", "new"]);
  });

  test("a non-incremental ingest loads every file when anything changed, and nothing when nothing did", async () => {
    const p = project();
    p.put("files/a.csv", "id,v\n1,x\n");
    p.put("files/b.csv", "id,v\n2,y\n");
    const cfg = { file: "files/*.csv" };
    const first = await extract(p, cfg);
    const known = first.files.map(({ path, size, mtime, etag, sha256 }) => ({ path, size, mtime, etag, sha256 }));
    expect((await extract(p, cfg, { known })).unchanged).toBe(true);
    p.put("files/b.csv", "id,v\n2,z\n");
    const changed = await extract(p, cfg, { known });
    expect(changed.load).toEqual(["files/a.csv", "files/b.csv"]);
    p.remove("files/b.csv");
    p.put("files/a.csv", "id,v\n1,x\n");
    const gone = await extract(p, cfg, { known });
    expect(gone.unchanged).toBe(false); // a gone file changes a replace
    expect(gone.load).toEqual(["files/a.csv"]);
    expect(gone.gone).toEqual(["files/b.csv"]);
  });

  test("FILE_NOT_FOUND for a missing path, a glob that matches nothing, or a folder", async () => {
    const p = project();
    const missing = await failure(extract(p, { file: "files/nope.csv" }));
    expect(missing.code).toBe("FILE_NOT_FOUND");
    expect(missing.message).toContain("files/nope.csv does not exist");
    const glob = await failure(extract(p, { file: "files/sales/*.csv" }));
    expect(glob.code).toBe("FILE_NOT_FOUND");
    expect(glob.message).toContain(`no file matches "files/sales/*.csv"`);
    mkdirSync(join(p.root, "files/folder"));
    const folder = await failure(extract(p, { file: "files/folder" }));
    expect(folder.problem.hint).toContain(`"files/folder/*.csv"`);
  });

  test("an unknown extension or mixed formats are ASSET_INVALID; format: overrides the extension", async () => {
    const p = project();
    p.put("files/a.txt", "id\n1\n");
    expect((await failure(extract(p, { file: "files/a.txt" }))).message).toContain("cannot tell the format of files/a.txt");
    expect((await extract(p, { file: "files/a.txt", format: "csv" })).format).toBe("csv");
    p.put("files/m/a.csv", "id\n1\n");
    p.put("files/m/b.json", "[]");
    const mixed = await failure(extract(p, { file: "files/m/*" }));
    expect(mixed.code).toBe("ASSET_INVALID");
    expect(mixed.message).toContain("different formats");
  });

  test("files inside the state folder never match a glob", async () => {
    const p = project();
    p.put("a.csv", "id\n1\n");
    p.put(".croft/staging/old/x/b.csv", "id\n2\n");
    const ex = await extract(p, { file: "**/*.csv" });
    expect(ex.files.map((f) => f.path)).toEqual(["a.csv"]);
    // A relocated state folder that is not hidden is excluded too, including its own staging.
    const state = join(p.root, "state");
    p.put("state/staging/old/x/c.csv", "id\n3\n");
    const ex2 = await extract(p, { file: "**/*.csv" }, { stateDir: state });
    expect(ex2.files.map((f) => f.path)).toEqual(["a.csv"]);
    expect(ex2.files[0]!.local!.startsWith(join(state, "staging"))).toBe(true);
  });

  test("an aborted signal stops extraction with INTERRUPTED", async () => {
    const p = project();
    p.put("files/a.csv", "id\n1\n");
    const ac = new AbortController();
    ac.abort();
    expect((await failure(extract(p, { file: "files/a.csv" }, { signal: ac.signal }))).code).toBe("INTERRUPTED");
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("CSV", () => {
  test("a glob with a column added in a later file keeps it (union_by_name); CSV text rules type every column", async () => {
    const p = project({ timezone: "America/New_York" });
    p.put("files/sales/2026-01.csv", { fixture: "sales/2026-01.csv" });
    p.put("files/sales/2026-02.csv", { fixture: "sales/2026-02.csv" });
    const { batch, result } = await run(p, { file: "files/sales/*.csv", incremental: true });
    expect(result!.rows).toMatchObject({ in: 5, added: 5, total: 5 });
    expect(await types(p)).toEqual({
      order_id: "BIGINT", email: "VARCHAR", amount: "DECIMAL(18,2)", ordered_on: "DATE", coupon: "VARCHAR", _file: "VARCHAR", _loaded_at: "TIMESTAMP WITH TIME ZONE",
    });
    expect(await q(p, `SELECT order_id, email, amount::VARCHAR AS amount, ordered_on::VARCHAR AS ordered_on, coupon, _file FROM sales ORDER BY order_id`)).toEqual([
      { order_id: 1001, email: " Alice@Example.COM ", amount: "1234.50", ordered_on: "2026-03-25", coupon: null, _file: "files/sales/2026-01.csv" },
      { order_id: 1002, email: "bob@example.com", amount: "20.00", ordered_on: "2026-03-26", coupon: null, _file: "files/sales/2026-01.csv" },
      { order_id: 1003, email: "carol@example.com", amount: "-3.00", ordered_on: "2026-03-27", coupon: null, _file: "files/sales/2026-01.csv" },
      { order_id: 1004, email: "dan@example.com", amount: "15.25", ordered_on: "2026-04-01", coupon: "SPRING", _file: "files/sales/2026-02.csv" },
      { order_id: 1005, email: "eve@example.com", amount: "2000.00", ordered_on: "2026-04-02", coupon: null, _file: "files/sales/2026-02.csv" },
    ]);
    expect(batch!.formats).toEqual({ amount: "money", ordered_on: "%m/%d/%Y" });
    expect(batch!.replaceFiles).toEqual(["files/sales/2026-01.csv", "files/sales/2026-02.csv"]);
    expect((await columnsRow(p)).filter((c) => c.format)).toEqual([
      { name: "amount", type: "DECIMAL(18,2)", format: "money", source_name: "amount" },
      { name: "ordered_on", type: "DATE", format: "%m/%d/%Y", source_name: "ordered_on" },
    ]);
    // Rows keep yield order: seq follows the files' order.
    expect(await q(p, `SELECT path FROM _croft.files ORDER BY path`)).toEqual([{ path: "files/sales/2026-01.csv" }, { path: "files/sales/2026-02.csv" }]);
  });

  test("latin-1: read as latin-1 with CSV_ENCODING_GUESSED; a declared encoding silences it", async () => {
    const p = project({ asset: "people" });
    p.put("files/people.csv", { fixture: "latin1.csv" });
    const guessed = await run(p, { file: "files/people.csv" });
    expect(codes(guessed.extract)).toEqual(["CSV_ENCODING_GUESSED"]);
    expect(codes(guessed.result)).toContain("CSV_ENCODING_GUESSED");
    expect(guessed.extract.files[0]!.csv).toMatchObject({ encoding: "latin-1", encodingGuessed: true });
    expect(await q(p, `SELECT id, name, city FROM people ORDER BY id`)).toEqual([{ id: 1, name: "José", city: "Málaga" }, { id: 2, name: "Zoë", city: "Köln" }]);

    const q2 = project({ asset: "people" });
    q2.put("files/people.csv", { fixture: "latin1.csv" });
    const declared = await run(q2, { file: "files/people.csv", csv: { encoding: "latin-1" } });
    expect(codes(declared.extract)).toEqual([]);
    expect(await q(q2, `SELECT name FROM people ORDER BY id`)).toEqual([{ name: "José" }, { name: "Zoë" }]);

    // A UTF-16 byte-order mark is read as UTF-16, not as latin-1 garbage.
    const u = project({ asset: "people" });
    u.put("files/people.csv", new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("id,name\n1,Zoë\n", "utf16le")])));
    const r16 = await run(u, { file: "files/people.csv" });
    expect(r16.extract.files[0]!.csv).toMatchObject({ encoding: "utf-16", encodingGuessed: true });
    expect(r16.extract.warnings[0]!.message).toContain("read it as utf-16");
    expect(await q(u, `SELECT id, name FROM people`)).toEqual([{ id: 1, name: "Zoë" }]);
  });

  test("a header-less all-text file is CSV_HEADER_AMBIGUOUS with its first two lines; csv.header decides", async () => {
    const p = project({ asset: "names" });
    p.put("files/names.csv", { fixture: "names-no-header.csv" });
    const e = await failure(run(p, { file: "files/names.csv" }));
    expect(e.code).toBe("CSV_HEADER_AMBIGUOUS");
    expect(e.message).toContain("  Alice,Paris\n  Bob,London");
    expect(e.problem.details).toMatchObject({ file: "files/names.csv", lines: ["Alice,Paris", "Bob,London"] });
    expect(e.problem.hint).toContain("csv: { header: true }");
    expect(await q(p, `SELECT count(*)::INTEGER AS n FROM duckdb_tables() WHERE table_name = 'names'`)).toEqual([{ n: 0 }]);

    const noHeader = await run(p, { file: "files/names.csv", csv: { header: false } });
    expect(noHeader.extract.files[0]!.csv).toMatchObject({ header: false, headerFrom: "declared" });
    expect(await q(p, `SELECT column0, column1 FROM names ORDER BY column0`)).toEqual([
      { column0: "Alice", column1: "Paris" }, { column0: "Bob", column1: "London" }, { column0: "Carol", column1: "Berlin" },
    ]);

    const h = project({ asset: "names" });
    h.put("files/names.csv", { fixture: "names-no-header.csv" });
    await run(h, { file: "files/names.csv", csv: { header: true } });
    expect(await q(h, `SELECT "Alice", "Paris" FROM names ORDER BY 1`)).toEqual([{ Alice: "Bob", Paris: "London" }, { Alice: "Carol", Paris: "Berlin" }]);
  });

  test("an all-text file whose first line matches stored or sibling column names is a header", async () => {
    const p = project({ asset: "people" });
    p.put("files/a.csv", "code,name,qty\nA1,Alice,3\n");
    await run(p, { file: "files/*.csv", incremental: true });
    p.put("files/b.csv", "name,code\nBob,B2\n"); // every column is text in this file
    const second = await run(p, { file: "files/*.csv", incremental: true });
    expect(second.extract.files.find((f) => f.path === "files/b.csv")!.csv).toMatchObject({ header: true, headerFrom: "known" });
    expect(second.extract.load).toEqual(["files/b.csv"]);
    expect(await q(p, `SELECT code, name, qty FROM people ORDER BY code`)).toEqual([{ code: "A1", name: "Alice", qty: 3 }, { code: "B2", name: "Bob", qty: null }]);

    // Within one load, a file with a detectable header vouches for its all-text sibling.
    const s = project({ asset: "people" });
    s.put("files/a.csv", "code,name,qty\nA1,Alice,3\n");
    s.put("files/b.csv", "name,code\nBob,B2\n");
    const both = await extract(s, { file: "files/*.csv" });
    expect(both.files.map((f) => f.csv?.headerFrom)).toEqual(["sniffed", "known"]);
    // A line that is not made of known names stays ambiguous.
    s.put("files/c.csv", "Carol,C3\nDan,D4\n");
    expect((await failure(extract(s, { file: "files/*.csv" }))).code).toBe("CSV_HEADER_AMBIGUOUS");
  });

  test("lines the sniffer would skip before the header need csv.skip", async () => {
    const p = project({ asset: "export" });
    p.put("files/export.csv", "exported by shop\n\nid,name\n1,x\n2,y\n");
    const e = await failure(run(p, { file: "files/export.csv" }));
    expect(e.code).toBe("CSV_HEADER_AMBIGUOUS");
    expect(e.message).toContain("skip the first 2 lines");
    expect(e.problem.fix).toMatchObject({ kind: "manual" });
    expect(e.problem.hint).toContain("csv: { skip: 2 }");
    await run(p, { file: "files/export.csv", csv: { skip: 2 } });
    expect(await q(p, `SELECT id, name FROM export ORDER BY id`)).toEqual([{ id: 1, name: "x" }, { id: 2, name: "y" }]);
  });

  test("a ragged file fails loudly with FILE_UNREADABLE naming the file and the line, instead of loading as one column", async () => {
    const p = project({ asset: "bad" });
    p.put("files/bad.csv", "id,name,note\n1,a,x\n2,b,y\n3,c,z,EXTRA\n4,d,w\n");
    for (const csv of [{ header: true }, {}, { delimiter: "," }]) {
      const e = await failure(run(p, { file: "files/bad.csv", csv }));
      expect(e.code).toBe("FILE_UNREADABLE");
      expect(e.message).toContain("cannot read files/bad.csv");
      expect(e.message).toContain("Line: 4");
      expect(e.message).not.toContain("staging");
      expect(e.problem.hint).toContain("same columns");
    }
    p.put("files/bad.csv", "id,name,note\n1,a,x\n2,b\n");
    expect((await failure(run(p, { file: "files/bad.csv" }))).message).toContain("Line: 3");
  });

  test("money, day-first and month-first dates, ambiguous dates by time zone, mixed orders", async () => {
    const eu = project({ timezone: "Europe/Berlin", asset: "days" });
    eu.put("files/days.csv", { fixture: "dates-ambiguous.csv" });
    const r = await run(eu, { file: "files/days.csv" });
    expect(codes(r.batch)).toContain("AMBIGUOUS_DATE_FORMAT");
    expect(r.batch!.formats).toEqual({ day: "%d/%m/%Y" });
    expect(await q(eu, `SELECT day::VARCHAR AS day FROM days ORDER BY id`)).toEqual([{ day: "2026-04-03" }, { day: "2026-06-05" }]);

    const us = project({ timezone: "America/Chicago", asset: "days" });
    us.put("files/days.csv", { fixture: "dates-ambiguous.csv" });
    const r2 = await run(us, { file: "files/days.csv" });
    expect(r2.batch!.formats).toEqual({ day: "%m/%d/%Y" });
    const amb = r2.batch!.warnings.find((w) => w.code === "AMBIGUOUS_DATE_FORMAT")!;
    expect(amb.message).toContain("month-first");
    expect(await q(us, `SELECT day::VARCHAR AS day FROM days ORDER BY id`)).toEqual([{ day: "2026-03-04" }, { day: "2026-05-06" }]);

    const df = project({ timezone: "America/Chicago", asset: "days" });
    df.put("files/days.csv", { fixture: "dates-day-first.csv" });
    const r3 = await run(df, { file: "files/days.csv" });
    expect(codes(r3.batch)).not.toContain("AMBIGUOUS_DATE_FORMAT");
    expect(r3.batch!.formats).toEqual({ day: "%d/%m/%Y" });
    expect(await q(df, `SELECT day::VARCHAR AS day FROM days ORDER BY id`)).toEqual([{ day: "2026-03-25" }, { day: "2026-04-01" }]);

    const mixed = project({ asset: "days" });
    mixed.put("files/days.csv", { fixture: "dates-mixed.csv" });
    const r4 = await run(mixed, { file: "files/days.csv" });
    expect(codes(r4.batch)).toContain("MIXED_DATE_FORMATS");
    expect((await types(mixed)).day).toBe("VARCHAR");

    const money = project({ asset: "m" });
    money.put("files/m.csv", 'id,price,qty,rate,flag,zip,note\n1,"$1,234.56",3,0.5,true,02134,\n2,($7.25),10,1.25,FALSE,90210, \n');
    const r5 = await run(money, { file: "files/m.csv" });
    expect(await types(money)).toMatchObject({ id: "BIGINT", price: "DECIMAL(18,2)", qty: "BIGINT", rate: "DOUBLE", flag: "BOOLEAN", zip: "VARCHAR", note: "VARCHAR" });
    expect(await q(money, `SELECT price::VARCHAR AS price, rate, flag, zip, note FROM m ORDER BY id`)).toEqual([
      { price: "1234.56", rate: 0.5, flag: true, zip: "02134", note: null },
      { price: "-7.25", rate: 1.25, flag: false, zip: "90210", note: null }, // whitespace-only cells are NULL
    ]);
    expect(r5.batch!.formats).toEqual({ price: "money" });
  });

  test("a stored date format is respected: a later value that does not parse with it is TYPE_CONFLICT", async () => {
    const p = project({ asset: "days" });
    p.put("files/a.csv", "id,day\n1,03/25/2026\n");
    await run(p, { file: "files/*.csv", incremental: true });
    expect((await columnsRow(p)).find((c) => c.name === "day")!.format).toBe("%m/%d/%Y");
    // Unambiguous in the other order on its own; with the stored format it must fail, never flip.
    p.put("files/b.csv", "id,day\n2,25/03/2026\n");
    const e = await failure(run(p, { file: "files/*.csv", incremental: true }));
    expect(e.code).toBe("TYPE_CONFLICT");
    expect(e.message).toContain("column day is DATE (format %m/%d/%Y)");
    expect(e.message).toContain(`"25/03/2026"`);
    expect(e.problem.details).toMatchObject({ column: "day", format: "%m/%d/%Y", badRows: 1 });
    expect(e.problem.fix!.description).toContain("map");
    expect(await q(p, `SELECT count(*)::INTEGER AS n FROM days`)).toEqual([{ n: 1 }]);
    expect(await q(p, `SELECT path FROM _croft.files ORDER BY path`)).toEqual([{ path: "files/a.csv" }]);
    // An ambiguous later value parses with the stored order.
    p.put("files/b.csv", "id,day\n2,04/05/2026\n");
    await run(p, { file: "files/*.csv", incremental: true });
    expect(await q(p, `SELECT day::VARCHAR AS day FROM days ORDER BY id`)).toEqual([{ day: "2026-03-25" }, { day: "2026-04-05" }]);
  });

  test("a later file with text in a number column is TYPE_CONFLICT with samples; a pinned money column parses money", async () => {
    const p = project({ asset: "n" });
    p.put("files/a.csv", "id,qty\n1,5\n");
    await run(p, { file: "files/*.csv", incremental: true });
    p.put("files/b.csv", "id,qty\n2,five\n3,6\n");
    const e = await failure(run(p, { file: "files/*.csv", incremental: true }));
    expect(e.code).toBe("TYPE_CONFLICT");
    expect(e.message).toContain("column qty is BIGINT");
    expect(e.problem.details!.samples).toEqual([{ row: 1, value: "five" }]);

    const m = project({ asset: "m" });
    m.put("files/m.csv", 'id,price\n1,"$1,000.10"\n');
    await run(m, { file: "files/m.csv", columns: { price: "DECIMAL(12,2)" } });
    expect(await q(m, `SELECT price::VARCHAR AS p FROM m`)).toEqual([{ p: "1000.10" }]);
    m.put("files/m.csv", "id,price\n1,$1.005\n");
    expect((await failure(run(m, { file: "files/m.csv", columns: { price: "DECIMAL(12,2)" } }))).code).toBe("PIN_ROUNDED");
  });

  test("column names are cleaned; a CSV column named filename or _file survives", async () => {
    const p = project({ asset: "c" });
    p.put("files/c.csv", "Order ID,Amount ($),filename,_file\n1,2,x.txt,y\n");
    await run(p, { file: "files/c.csv" });
    expect(Object.keys(await types(p))).toEqual(["Order_ID", "Amount", "filename", "_source_file", "_file", "_loaded_at"]);
    expect(await q(p, `SELECT Order_ID, filename, _source_file, _file FROM c`)).toEqual([{ Order_ID: 1, filename: "x.txt", _source_file: "y", _file: "files/c.csv" }]);
    expect((await columnsRow(p)).map((c) => [c.name, c.source_name])).toEqual([
      ["Amount", "Amount ($)"], ["Order_ID", "Order ID"], ["_source_file", "_file"], ["filename", "filename"],
    ]);
  });

  test("TSV, a semicolon file, a gzip file and an empty file", async () => {
    const p = project({ asset: "t" });
    p.put("files/t.tsv", "id\tname\n1\ta b\n");
    await run(p, { file: "files/t.tsv" });
    expect(await q(p, `SELECT id, name FROM t`)).toEqual([{ id: 1, name: "a b" }]);

    const s = project({ asset: "s" });
    s.put("files/s.csv", 'id;name;note\n1;a;"x;y"\n');
    await run(s, { file: "files/s.csv" });
    expect(await q(s, `SELECT id, name, note FROM s`)).toEqual([{ id: 1, name: "a", note: "x;y" }]);

    const g = project({ asset: "g" });
    g.put("files/g.csv.gz", Bun.gzipSync(new TextEncoder().encode("id,name\n1,Zoë\n")));
    await run(g, { file: "files/g.csv.gz" });
    expect(await q(g, `SELECT id, name FROM g`)).toEqual([{ id: 1, name: "Zoë" }]);

    const e = project({ asset: "e" });
    e.put("files/a.csv", "id,v\n1,x\n");
    e.put("files/b.csv", "");
    const r = await run(e, { file: "files/*.csv", incremental: true });
    expect(r.result!.rows.total).toBe(1);
    expect(await q(e, `SELECT path, size FROM _croft.files ORDER BY path`)).toEqual([{ path: "files/a.csv", size: 9 }, { path: "files/b.csv", size: 0 }]);
  });

  test("_croft_seq counts rows from 1 in file order inside the write transaction; previewRows caps a direct read", async () => {
    const p = project();
    p.put("files/sales/2026-01.csv", { fixture: "sales/2026-01.csv" });
    p.put("files/sales/2026-02.csv", { fixture: "sales/2026-02.csv" });
    const seqs = await p.w.write("seq", async (tx) => {
      const b = await buildFileBatch(tx, { extract: await extract(p, { file: "files/sales/*.csv" }), knownColumns: [], timezone: "UTC" });
      return tx.all<{ s: number; id: number; f: string }>(`SELECT _croft_seq AS s, order_id AS id, _file AS f FROM ${ident(b.temp)} ORDER BY _croft_seq`);
    }, { runId: "r_seq" });
    expect(seqs.map((r) => [r.s, r.id])).toEqual([[1, 1001], [2, 1002], [3, 1003], [4, 1004], [5, 1005]]);
    const ex = await extract(p, { file: "files/sales/*.csv" }, { previewRows: 4 });
    const n = await p.w.write("preview", async (tx) => (await buildFileBatch(tx, { extract: ex, knownColumns: [], timezone: "UTC" })).rows, { runId: "r_preview" });
    expect(n).toBe(4);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("changed and deleted files", () => {
  test("a changed file is reloaded through writeBatch with replaceFiles; other files keep their rows and stamps", async () => {
    const p = project();
    const cfg = { file: "files/sales/*.csv", incremental: true };
    p.put("files/sales/2026-01.csv", { fixture: "sales/2026-01.csv" });
    p.put("files/sales/2026-02.csv", { fixture: "sales/2026-02.csv" });
    await run(p, cfg);
    const stamp = async () => Object.fromEntries((await q<{ id: number; s: string }>(p, `SELECT order_id AS id, _loaded_at::VARCHAR AS s FROM sales`)).map((r) => [r.id, r.s]));
    const before = await stamp();

    // Jan: 1002's amount corrected, 1003 removed, 1007 added.
    p.put("files/sales/2026-01.csv", 'order_id,email,amount,ordered_on\n1001, Alice@Example.COM ,"$1,234.50",03/25/2026\n1002,bob@example.com,$22.00,03/26/2026\n1007,gus@example.com,$9.99,03/28/2026\n');
    const r = await run(p, cfg);
    expect(r.extract.load).toEqual(["files/sales/2026-01.csv"]);
    expect(r.batch!.replaceFiles).toEqual(["files/sales/2026-01.csv"]);
    expect(r.result!.rows).toMatchObject({ in: 3, added: 2, unchanged: 1, deleted: 2, total: 5 });
    const after = await stamp();
    expect(after[1001]).toBe(before[1001]!); // identical row: untouched
    expect(after[1004]).toBe(before[1004]!); // other file: untouched
    expect(after[1002]).not.toBe(before[1002]!);
    expect(await q(p, `SELECT order_id, amount::VARCHAR AS a FROM sales ORDER BY order_id`)).toEqual([
      { order_id: 1001, a: "1234.50" }, { order_id: 1002, a: "22.00" }, { order_id: 1004, a: "15.25" }, { order_id: 1005, a: "2000.00" }, { order_id: 1007, a: "9.99" },
    ]);
    const files = await q<{ path: string; sha256: string }>(p, `SELECT path, sha256 FROM _croft.files ORDER BY path`);
    expect(files[0]!.sha256).toBe(new Bun.CryptoHasher("sha256").update(readFileSync(join(p.root, "files/sales/2026-01.csv"))).digest("hex"));
  });

  test("keyed: a reloaded file merges by key, and its vanished keys are deleted", async () => {
    const p = project();
    const cfg = { file: "files/sales/*.csv", incremental: true, key: "order_id" };
    p.put("files/sales/2026-01.csv", { fixture: "sales/2026-01.csv" });
    p.put("files/sales/2026-02.csv", { fixture: "sales/2026-02.csv" });
    await run(p, cfg);
    p.put("files/sales/2026-02.csv", "order_id,email,amount,ordered_on,coupon\n1004,dan@example.com,$15.25,04/01/2026,SUMMER\n");
    const r = await run(p, cfg);
    expect(r.result!.rows).toMatchObject({ in: 1, added: 0, updated: 1, deleted: 1, total: 4 });
    expect(await q(p, `SELECT order_id, coupon FROM sales WHERE _file = 'files/sales/2026-02.csv'`)).toEqual([{ order_id: 1004, coupon: "SUMMER" }]);
  });

  test("a deleted file keeps its rows (incremental) and is reported gone on every run", async () => {
    const p = project();
    const cfg = { file: "files/sales/*.csv", incremental: true };
    p.put("files/sales/2026-01.csv", { fixture: "sales/2026-01.csv" });
    p.put("files/sales/2026-02.csv", { fixture: "sales/2026-02.csv" });
    await run(p, cfg);
    p.remove("files/sales/2026-02.csv");
    const r = await run(p, cfg);
    expect(r.extract.unchanged).toBe(true);
    expect(r.extract.gone).toEqual(["files/sales/2026-02.csv"]);
    expect(await q(p, `SELECT count(*)::INTEGER AS n FROM sales WHERE _file = 'files/sales/2026-02.csv'`)).toEqual([{ n: 2 }]);
    // A new file is loaded; the gone file stays recorded and reported, its rows untouched.
    p.put("files/sales/2026-03.csv", "order_id,email,amount,ordered_on\n1006,f@example.com,$1.00,05/01/2026\n");
    const r2 = await run(p, cfg);
    expect(r2.extract.gone).toEqual(["files/sales/2026-02.csv"]);
    expect(r2.result!.rows).toMatchObject({ added: 1, deleted: 0, total: 6 });
    expect((await q<{ path: string }>(p, `SELECT path FROM _croft.files ORDER BY path`)).map((f) => f.path)).toEqual([
      "files/sales/2026-01.csv", "files/sales/2026-02.csv", "files/sales/2026-03.csv",
    ]);
    // It comes back unchanged: nothing to do (its rows are still there).
    p.put("files/sales/2026-02.csv", { fixture: "sales/2026-02.csv" });
    const r3 = await run(p, cfg);
    expect(r3.extract.unchanged).toBe(true);
    expect(r3.extract.gone).toEqual([]);
  });

  test("a non-incremental ingest mirrors its files: a deleted file's rows and record go with the replace", async () => {
    const p = project({ asset: "zones" });
    p.put("files/zones/a.csv", "id,zone\n1,A\n2,B\n3,C\n");
    p.put("files/zones/b.csv", "id,zone\n4,D\n");
    await run(p, { file: "files/zones/*.csv", key: "id" });
    p.remove("files/zones/b.csv");
    const r = await run(p, { file: "files/zones/*.csv", key: "id" });
    expect(r.batch!.replaceFiles).toBeUndefined();
    expect(r.result!.rows).toMatchObject({ deleted: 1, total: 3 });
    expect(await q(p, `SELECT path FROM _croft.files`)).toEqual([{ path: "files/zones/a.csv" }]);
    expect((await run(p, { file: "files/zones/*.csv", key: "id" })).extract.unchanged).toBe(true);
  });

  test("DUPLICATE_ROWS_ACROSS_FILES for a keyless incremental ingest, within a load and against the table", async () => {
    const p = project({ asset: "d" });
    const cfg = { file: "files/*.csv", incremental: true };
    p.put("files/a.csv", "id,v\n1,x\n2,y\n");
    p.put("files/b.csv", "id,v\n1,x\n3,z\n");
    const r = await run(p, cfg);
    const dup = r.result!.warnings.find((w) => w.code === "DUPLICATE_ROWS_ACROSS_FILES")!;
    expect(dup.details).toMatchObject({ rows: 2, inBatch: 2, againstTable: 0, files: ["files/a.csv", "files/b.csv"] });
    expect(dup.hint).toContain("key");
    p.put("files/c.csv", "id,v\n3,z\n4,w\n");
    const r2 = await run(p, cfg);
    expect(r2.result!.warnings.find((w) => w.code === "DUPLICATE_ROWS_ACROSS_FILES")!.details).toMatchObject({ rows: 1, inBatch: 0, againstTable: 1 });
    // A reloaded file is not compared with its own old rows; a keyed ingest is never warned.
    p.put("files/c.csv", "id,v\n4,w\n5,q\n");
    expect(codes((await run(p, cfg)).result)).not.toContain("DUPLICATE_ROWS_ACROSS_FILES");
    const k = project({ asset: "d" });
    k.put("files/a.csv", "id,v\n1,x\n");
    k.put("files/b.csv", "id,v\n1,x\n");
    expect(codes((await run(k, { ...cfg, key: "id" })).result)).not.toContain("DUPLICATE_ROWS_ACROSS_FILES");
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("URLs", () => {
  function server(o: { etag?: () => string; body: () => Uint8Array | string; type?: string; lastModified?: string }) {
    const seen: { inm: string | null; ims: string | null }[] = [];
    const s = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push({ inm: req.headers.get("if-none-match"), ims: req.headers.get("if-modified-since") });
        const etag = o.etag?.();
        if (etag && req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
        const headers: Record<string, string> = { "content-type": o.type ?? "text/csv" };
        if (etag) headers.etag = etag;
        if (o.lastModified) headers["last-modified"] = o.lastModified;
        return new Response(o.body() as BodyInit, { headers });
      },
    });
    cleanups.push(() => s.stop(true));
    return { url: s.url.href, seen };
  }

  test("conditional GET: 200 downloads and loads; the next run sends If-None-Match / If-Modified-Since and a 304 is unchanged", async () => {
    let body = "LocationID,Borough,Zone\n1,EWR,Newark Airport\n2,Queens,Jamaica Bay\n";
    let etag = '"v1"';
    const srv = server({ etag: () => etag, body: () => body, lastModified: "Tue, 01 Sep 2026 10:00:00 GMT" });
    const url = `${srv.url}misc/taxi_zone_lookup.csv`;
    const p = project({ asset: "taxi_zones" });
    const cfg = { file: url, key: "LocationID" };
    const first = await run(p, cfg);
    expect(first.extract.files[0]).toMatchObject({ path: url, url, status: "new", etag: '"v1"', mtime: "2026-09-01T10:00:00.000Z", size: body.length });
    expect(first.extract.files[0]!.local!.startsWith(join(p.stateDir, "staging"))).toBe(true);
    expect(await q(p, `SELECT LocationID, Zone, _file FROM taxi_zones ORDER BY 1`)).toEqual([
      { LocationID: 1, Zone: "Newark Airport", _file: url }, { LocationID: 2, Zone: "Jamaica Bay", _file: url },
    ]);
    expect(srv.seen[0]).toEqual({ inm: null, ims: null });

    const second = await run(p, cfg);
    expect(srv.seen[1]).toEqual({ inm: '"v1"', ims: "Tue, 01 Sep 2026 10:00:00 GMT" });
    expect(second.extract.unchanged).toBe(true);
    expect(second.extract.files[0]).toMatchObject({ status: "unchanged", etag: '"v1"' });

    body += "3,Manhattan,Alphabet City\n";
    etag = '"v2"';
    const third = await run(p, cfg);
    expect(third.extract.files[0]).toMatchObject({ status: "changed", etag: '"v2"' });
    expect(third.result!.rows).toMatchObject({ added: 1, unchanged: 2, total: 3 });
    expect(await q(p, `SELECT etag FROM _croft.files`)).toEqual([{ etag: '"v2"' }]);

    // --rebuild asks unconditionally.
    await extract(p, cfg, { rebuild: true });
    expect(srv.seen.at(-1)).toEqual({ inm: null, ims: null });
  });

  test("an extension-less URL takes its format from Content-Type; bytes arrive intact (Parquet, latin-1)", async () => {
    const parquet = new Uint8Array(readFileSync(join(FIXTURES, "types-2.parquet")));
    const srv = server({ body: () => parquet, type: "application/vnd.apache.parquet" });
    const p = project({ asset: "remote" });
    const r = await run(p, { file: `${srv.url}export` });
    expect(r.extract.format).toBe("parquet");
    expect(r.extract.files[0]!.sha256).toBe(new Bun.CryptoHasher("sha256").update(parquet).digest("hex"));
    expect(await q(p, `SELECT small, int32, extra FROM remote`)).toEqual([{ small: 3, int32: 5000000000, extra: "later" }]);

    const latin = new Uint8Array(readFileSync(join(FIXTURES, "latin1.csv")));
    const srv2 = server({ body: () => latin });
    const l = project({ asset: "people" });
    const r2 = await run(l, { file: `${srv2.url}people.csv` });
    expect(codes(r2.extract)).toEqual(["CSV_ENCODING_GUESSED"]);
    expect(await q(l, `SELECT name FROM people ORDER BY id`)).toEqual([{ name: "José" }, { name: "Zoë" }]);
  });

  test("a download retries a 503 (honoring Retry-After), and an abort while waiting is INTERRUPTED", async () => {
    let hits = 0;
    const s = Bun.serve({
      port: 0,
      fetch: () => (++hits === 1 ? new Response("busy", { status: 503, headers: { "retry-after": "0" } }) : new Response("id\n1\n", { headers: { "content-type": "text/csv" } })),
    });
    cleanups.push(() => s.stop(true));
    const p = project({ asset: "x" });
    const ex = await extract(p, { file: `${s.url.href}x.csv` });
    expect(hits).toBe(2);
    expect(ex.files[0]).toMatchObject({ status: "new", size: 5 });

    const slow = Bun.serve({ port: 0, fetch: () => new Response("busy", { status: 503, headers: { "retry-after": "5" } }) });
    cleanups.push(() => slow.stop(true));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const started = Date.now();
    const e = await failure(extract(p, { file: `${slow.url.href}x.csv` }, { signal: ac.signal }));
    expect(e.code).toBe("INTERRUPTED");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("an HTTP failure is HTTP_ERROR; ctx.http's getBytes is used when it has one", async () => {
    const s = Bun.serve({ port: 0, fetch: () => new Response("gone", { status: 404 }) });
    cleanups.push(() => s.stop(true));
    const p = project({ asset: "x" });
    const e = await failure(extract(p, { file: `${s.url.href}x.csv` }));
    expect(e.code).toBe("HTTP_ERROR");
    expect(e.problem.details).toMatchObject({ status: 404, attempts: 1 });

    const calls: string[] = [];
    const http: Http & ByteHttp = {
      get: () => Promise.reject(new Error("get() must not be used for downloads")),
      post: () => Promise.reject(new Error("unused")),
      async getBytes(url: string, init?: HttpInit): Promise<HttpResponse & { bytes: Uint8Array }> {
        calls.push(`${url} ${JSON.stringify(init?.headers ?? {})}`);
        const bytes = new TextEncoder().encode("id\n1\n");
        return { status: 200, url, headers: new Headers({ etag: '"e"' }), text: "", json: () => null as never, bytes };
      },
    };
    const ex = await extract(p, { file: "https://example.invalid/data.csv" }, { http });
    expect(calls).toEqual(["https://example.invalid/data.csv {}"]);
    expect(ex.files[0]).toMatchObject({ etag: '"e"', size: 5, status: "new" });

    // ctx.http itself (createHttp) has no getBytes: extraction falls back to fetch.
    const srv = server({ body: () => "id\n7\n" });
    const real = createHttp({ signal: new AbortController().signal });
    const ex2 = await extract(p, { file: `${srv.url}d.csv` }, { http: real });
    expect(ex2.files[0]!.size).toBe(5);
    expect(real.requests).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("map()", () => {
  test("map cleans values, null drops a row, untouched CSV columns keep the CSV rules, and rows carry _file", async () => {
    const p = project();
    p.put("files/sales/2026-01.csv", { fixture: "sales/2026-01.csv" });
    p.put("files/sales/2026-02.csv", { fixture: "sales/2026-02.csv" });
    const seen: unknown[] = [];
    const cfg: Config = {
      file: "files/sales/*.csv",
      incremental: true,
      map: (row) => {
        seen.push(row);
        if (row.order_id === "1003") return null;
        return { ...row, email: String(row.email ?? "").trim().toLowerCase(), big_order: Number(String(row.amount).replace(/[^0-9.]/g, "")) > 1000 };
      },
    };
    const r = await run(p, cfg);
    expect(r.extract.staged).toBe(true);
    expect(seen[0]).toEqual({ order_id: "1001", email: " Alice@Example.COM ", amount: "$1,234.50", ordered_on: "03/25/2026" });
    expect(await types(p)).toMatchObject({ order_id: "BIGINT", email: "VARCHAR", amount: "DECIMAL(18,2)", ordered_on: "DATE", coupon: "VARCHAR", big_order: "BOOLEAN" });
    expect(await q(p, `SELECT order_id, email, amount::VARCHAR AS amount, big_order, _file FROM sales ORDER BY order_id`)).toEqual([
      { order_id: 1001, email: "alice@example.com", amount: "1234.50", big_order: true, _file: "files/sales/2026-01.csv" },
      { order_id: 1002, email: "bob@example.com", amount: "20.00", big_order: false, _file: "files/sales/2026-01.csv" },
      { order_id: 1004, email: "dan@example.com", amount: "15.25", big_order: false, _file: "files/sales/2026-02.csv" },
      { order_id: 1005, email: "eve@example.com", amount: "2000.00", big_order: true, _file: "files/sales/2026-02.csv" },
    ]);
    expect(r.batch!.formats).toEqual({ amount: "money", ordered_on: "%m/%d/%Y" });
  });

  test("map errors: a throw is ASSET_CODE_ERROR with the row; undefined is ROW_NOT_OBJECT with a return hint", async () => {
    const p = project();
    p.put("files/a.csv", "id,v\n1,x\n2,y\n");
    const thrown = await failure(extract(p, { file: "files/a.csv", map: (row) => { if (row.id === "2") throw new Error("boom"); return row; } }));
    expect(thrown.code).toBe("ASSET_CODE_ERROR");
    expect(thrown.message).toBe("map() threw on row 2 of files/a.csv: boom");
    expect(thrown.problem.details).toMatchObject({ file: "files/a.csv", row: 2, input: '{"id":"2","v":"y"}' });
    const undef = await failure(extract(p, { file: "files/a.csv", map: (() => undefined) as unknown as (r: Record<string, unknown>) => null }));
    expect(undef.code).toBe("ROW_NOT_OBJECT");
    expect(undef.problem.hint).toContain("return");
  });

  test("map on Parquet: columns map() leaves alone keep their Parquet types", async () => {
    const p = project({ asset: "t" });
    p.put("files/types.parquet", { fixture: "types.parquet" });
    await run(p, { file: "files/types.parquet", map: (row) => ({ ...row, name: row.name === null ? null : String(row.name).toUpperCase(), doubled: Number(row.small) * 2 }) });
    expect(await types(p)).toMatchObject({
      small: "BIGINT", int32: "BIGINT", float32: "DOUBLE", uid: "VARCHAR", st: "JSON", list: "JSON", m: "JSON", amount: "DECIMAL(18,2)",
      ts_ns: "TIMESTAMP", tstz: "TIMESTAMP WITH TIME ZONE", day: "DATE", flag: "BOOLEAN", name: "VARCHAR", tiny: "BIGINT", big: "BIGINT", doubled: "BIGINT",
    });
    expect(await q(p, `SELECT name, float32, amount::VARCHAR AS amount, big::VARCHAR AS big, doubled FROM t ORDER BY small`)).toEqual([
      { name: "X", float32: 0.1, amount: "12.34", big: "9007199254740993", doubled: 2 },
      { name: null, float32: 2.5, amount: "0.50", big: "2", doubled: 4 },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("Parquet", () => {
  test("types are normalized; union_by_name widens INTEGER to BIGINT across files and keeps a later column", async () => {
    const p = project({ asset: "t" });
    p.put("files/p/1.parquet", { fixture: "types.parquet" });
    p.put("files/p/2.parquet", { fixture: "types-2.parquet" });
    const r = await run(p, { file: "files/p/*.parquet" });
    expect(await types(p)).toEqual({
      small: "BIGINT", int32: "BIGINT", float32: "DOUBLE", uid: "VARCHAR", st: "JSON", list: "JSON", m: "JSON", amount: "DECIMAL(18,2)",
      ts_ns: "TIMESTAMP", tstz: "TIMESTAMP WITH TIME ZONE", day: "DATE", flag: "BOOLEAN", name: "VARCHAR", tiny: "BIGINT", big: "BIGINT",
      extra: "VARCHAR", _file: "VARCHAR", _loaded_at: "TIMESTAMP WITH TIME ZONE",
    });
    expect(r.batch!.formats).toEqual({});
    expect(await q(p, `SELECT small, int32, float32, uid, st::VARCHAR AS st, list::VARCHAR AS list, m::VARCHAR AS m, ts_ns::VARCHAR AS ts, big::VARCHAR AS big, extra, _file FROM t ORDER BY small`)).toEqual([
      { small: 1, int32: 100000, float32: 0.1, uid: "6f1c2a3b-0000-4000-8000-000000000001", st: '{"a":1,"b":[1,2]}', list: "[1,2,3]", m: '{"k":1}', ts: "2024-01-01 10:00:00.123456", big: "9007199254740993", extra: null, _file: "files/p/1.parquet" },
      { small: 2, int32: null, float32: 2.5, uid: null, st: null, list: "[]", m: '{"k":2,"j":3}', ts: "2024-01-02 00:00:00", big: "2", extra: null, _file: "files/p/1.parquet" },
      { small: 3, int32: 5000000000, float32: null, uid: null, st: null, list: null, m: null, ts: null, big: null, extra: "later", _file: "files/p/2.parquet" },
    ]);
  });

  test("a Parquet column that turns into text in a later file is TYPE_CONFLICT; a corrupt file is FILE_UNREADABLE", async () => {
    const p = project({ asset: "t" });
    p.put("files/p/1.parquet", { fixture: "types-2.parquet" });
    await run(p, { file: "files/p/*.parquet", incremental: true });
    // A second file where int32 is text.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "croft-pq-")));
    const db = await openMemory({ timezone: "UTC", stateDir: dir });
    cleanups.push(() => db.close());
    const sql = new LeaseSql(await db.connect(), { mode: "ts", timezone: "UTC" }, null);
    await sql.exec(`COPY (SELECT 4::BIGINT AS small, 'lots' AS int32) TO '${dir}/x.parquet' (FORMAT parquet)`);
    p.put("files/p/2.parquet", new Uint8Array(readFileSync(join(dir, "x.parquet"))));
    const e = await failure(run(p, { file: "files/p/*.parquet", incremental: true }));
    expect(e.code).toBe("TYPE_CONFLICT");
    expect(e.message).toContain("column int32 is BIGINT");
    expect(e.problem.details!.samples).toEqual([{ row: 1, value: "lots" }]);

    p.put("files/p/2.parquet", "not parquet at all");
    const bad = await failure(extract(p, { file: "files/p/*.parquet", incremental: true }));
    expect(bad.code).toBe("FILE_UNREADABLE");
    expect(bad.message).toContain("files/p/2.parquet");
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("JSON and NDJSON", () => {
  test("a JSON array goes through the API pipeline: exact big integers, JSON columns, zoned timestamps", async () => {
    const p = project({ asset: "orders" });
    p.put("files/orders.json", { fixture: "orders.json" });
    const r = await run(p, { file: "files/orders.json", key: "id" });
    expect(r.extract.staged).toBe(true);
    expect(await types(p)).toMatchObject({ id: "HUGEINT", customer: "JSON", total: "DOUBLE", placed_at: "TIMESTAMP WITH TIME ZONE", tags: "JSON", _file: "VARCHAR" });
    expect(await q(p, `SELECT id::VARCHAR AS id, customer::VARCHAR AS c, total, strftime(placed_at AT TIME ZONE 'UTC', '%H:%M') AS at, _file FROM orders ORDER BY orders.id`)).toEqual([
      { id: "1", c: '{"name":"Alice","tier":"gold"}', total: 12.5, at: "10:00", _file: "files/orders.json" },
      { id: "2", c: '{"name":"Bob","tier":"silver"}', total: 20, at: "09:30", _file: "files/orders.json" },
      { id: "12345678901234567890", c: null, total: 3.25, at: "09:15", _file: "files/orders.json" },
    ]);
  });

  test("NDJSON: blank lines skipped, a column seen later is added; a bad line is FILE_UNREADABLE with its number", async () => {
    const p = project({ asset: "events" });
    p.put("files/events.ndjson", { fixture: "events.ndjson" });
    await run(p, { file: "files/*.ndjson", incremental: true });
    expect(await q(p, `SELECT event_id, kind, props::VARCHAR AS props, count FROM events ORDER BY event_id`)).toEqual([
      { event_id: "e1", kind: "click", props: '{"x":1}', count: null },
      { event_id: "e2", kind: "view", props: '{"x":2,"y":[1,2]}', count: null },
      { event_id: "e3", kind: "click", props: null, count: 3 },
    ]);
    p.put("files/more.ndjson", '{"event_id":"e4"}\n{"event_id": oops}\n');
    const e = await failure(extract(p, { file: "files/*.ndjson", incremental: true }));
    expect(e.code).toBe("FILE_UNREADABLE");
    expect(e.message).toContain("line 2 of files/more.ndjson");
  });

  test("map() on JSON rows follows the API rules, and a pinned column is honored", async () => {
    const p = project({ asset: "orders" });
    p.put("files/orders.json", { fixture: "orders.json" });
    await run(p, {
      file: "files/orders.json", key: "id", columns: { total: "DECIMAL(10,2)" },
      map: (row) => (row.customer === null ? null : { ...row, customer: (row.customer as { name: string }).name }),
    });
    expect(await types(p)).toMatchObject({ id: "BIGINT", customer: "VARCHAR", total: "DECIMAL(10,2)" });
    expect(await q(p, `SELECT id, customer, total::VARCHAR AS total FROM orders ORDER BY id`)).toEqual([
      { id: 1, customer: "Alice", total: "12.50" }, { id: 2, customer: "Bob", total: "20.00" },
    ]);
  });

  test("a .json file of one object per line is read as NDJSON; a non-object element is ROW_NOT_OBJECT; one object is one row", async () => {
    const p = project({ asset: "j" });
    p.put("files/lines.json", '{"a":1}\n{"a":2}\n');
    await run(p, { file: "files/lines.json" });
    expect(await q(p, `SELECT a FROM j ORDER BY a`)).toEqual([{ a: 1 }, { a: 2 }]);
    p.put("files/lines.json", "[1, 2]");
    expect((await failure(extract(p, { file: "files/lines.json" }))).code).toBe("ROW_NOT_OBJECT");
    p.put("files/lines.json", '{"a": 3}');
    await run(p, { file: "files/lines.json" });
    expect(await q(p, `SELECT a FROM j`)).toEqual([{ a: 3 }]);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("_croft.files", () => {
  test("readKnownFiles on a new warehouse is empty; recordFiles upserts loaded files and refreshes unchanged ones", async () => {
    const p = project({ asset: "k" });
    expect(await p.w.read((db) => readKnownFiles(db, "k"), { purpose: "test" })).toEqual([]);
    p.put("files/a.csv", "id\n1\n");
    p.put("files/b.csv", "id\n2\n");
    await run(p, { file: "files/*.csv", incremental: true });
    const first = await q<{ path: string; loaded_at: string }>(p, `SELECT path, loaded_at::VARCHAR AS loaded_at FROM _croft.files ORDER BY path`);
    p.put("files/b.csv", "id\n3\n");
    const r = await run(p, { file: "files/*.csv", incremental: true });
    const second = await q<{ path: string; loaded_at: string }>(p, `SELECT path, loaded_at::VARCHAR AS loaded_at FROM _croft.files ORDER BY path`);
    expect(second[0]!.loaded_at).toBe(first[0]!.loaded_at);
    expect(second[1]!.loaded_at).not.toBe(first[1]!.loaded_at);
    const known = await p.w.read((db) => readKnownFiles(db, "k"), { purpose: "test" });
    expect(known.map((k) => k.path)).toEqual(["files/a.csv", "files/b.csv"]);
    expect(known[1]).toMatchObject({ size: 5, etag: null, sha256: r.extract.files[1]!.sha256 });
    expect(new Date(known[1]!.mtime!).getTime()).toBeGreaterThan(0);
  });

  test("end to end in a real write lease: a failed load records nothing, and the next run loads the same files", async () => {
    const p = project();
    p.put("files/sales/2026-01.csv", { fixture: "sales/2026-01.csv" });
    const cfg = { file: "files/sales/*.csv", incremental: true, checks: [] };
    // A check that fails inside the lease rolls back rows, columns and _croft.files together.
    const ex = await extract(p, cfg);
    const err = await p.w.write(p.asset, async (tx) => {
      const batch = await buildFileBatch(tx, { extract: ex, knownColumns: [], timezone: "UTC" });
      const result = await writeBatch(tx, {
        batch, target: { asset: p.asset, write: "append", key: [], runId: "r_fail", replaceFiles: batch.replaceFiles }, formats: batch.formats,
        checks: async () => {
          throw new CroftError("CHECK_FAILED", { message: "amount >= 0 failed for 1 row", hint: "fix the data" });
        },
      });
      await recordFiles(tx, p.asset, ex, result.loadedAt);
    }, { runId: "r_fail" }).catch((e: CroftError) => e);
    expect((err as CroftError).code).toBe("CHECK_FAILED");
    expect(await p.w.read((db) => readKnownFiles(db, p.asset), { purpose: "test" })).toEqual([]);
    expect(await q(p, `SELECT count(*)::INTEGER AS n FROM duckdb_tables() WHERE table_name = 'sales'`)).toEqual([{ n: 0 }]);
    const ok = await run(p, cfg);
    expect(ok.extract.load).toEqual(["files/sales/2026-01.csv"]);
    expect(ok.result!.rows.total).toBe(3);
    expect(existsSync(ok.extract.stageDir)).toBe(true);
  });
});
