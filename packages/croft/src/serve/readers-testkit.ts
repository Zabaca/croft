// Shared fixtures for the server-mode tests (readers*.test.ts, DESIGN.md D119): a server-mode project whose read copy
// is made the way a refresh leaves it, and an engine over it. Test support, left out of the published package
// (package.json "files").
import { test } from "bun:test";
import { chmodSync, copyFileSync, renameSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { extensionsReady } from "../db/extension-dir-testkit.ts";
import { makeProject, seed, type TempProject } from "../read/testkit.ts";
import { openReadersEngine, type ReadersEngineInternals } from "./readers.ts";
import type { ServeEngine, ServeEngineOptions } from "./types.ts";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The quack and httpfs files, where the tests read them. Locally a missing file skips the tests that use `withExt`. */
export function extensionFiles(label: string) {
  const ext = extensionsReady(["quack", "httpfs"]);
  if (!ext.ready) console.warn(`[${label}] SKIPPING the tests that start a readers' process: ${ext.skipReason}`);
  return { ext, withExt: ext.ready ? test : test.skip };
}

export async function until(what: string, cond: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

export async function rejection(p: Promise<unknown>): Promise<CroftError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
  throw new Error("expected a CroftError");
}

export const q = (sql: string, o: { limit?: number; signal?: AbortSignal } = {}) => ({ sql, params: [], limit: o.limit ?? 10_000, signal: o.signal });
export const ask = (e: ServeEngine, sql: string) => e.query(q(sql));
export const count = async (e: ServeEngine, table = "orders") => Number((await ask(e, `SELECT count(*) AS n FROM ${table}`)).rows[0]!.n);

const ORDERS = (n: number) => `CREATE TABLE orders AS SELECT range AS id, range % 7 AS k FROM range(${n})`;

/** A server-mode project (a warehouse of `n` orders) whose read copy is that warehouse as of `asOf`: a whole file renamed
 *  into place, read-only (db/readcopy.ts does the same). */
export async function project(o: { n?: number; asOf?: string; copy?: boolean; config?: Record<string, unknown>; also?: string[] } = {}): Promise<TempProject> {
  const p = await makeProject({ config: { serverMode: { enabled: true }, ...o.config }, seed: [ORDERS(o.n ?? 10), ...(o.also ?? [])] });
  if (o.copy !== false) putCopy(p, aside(p, "template"), o.asOf ?? "2026-10-30T10:00:00Z");
  return p;
}

/** The warehouse as it was when the project was made, kept aside: copies are made from it, never from a file an engine
 *  may have open (closing a descriptor on a file drops this process's DuckDB lock on it, DESIGN.md §5). */
export function aside(p: TempProject, name: string): string {
  const path = join(p.root, `${name}.duckdb`);
  copyFileSync(p.database, path);
  return path;
}

/** Put `from` in place as the read copy with mtime `asOf`, the way a refresh does: a clone renamed over it, read-only. */
export function putCopy(p: TempProject, from: string, asOf: string): void {
  const tmp = `${p.project.paths.readCopy}.test-tmp`;
  copyFileSync(from, tmp);
  const at = new Date(asOf);
  utimesSync(tmp, at, at);
  chmodSync(tmp, 0o444);
  renameSync(tmp, p.project.paths.readCopy);
}

/** A new copy holding `n` orders: built aside, then renamed over the copy. */
export async function replaceCopy(p: TempProject, n: number, asOf: string): Promise<void> {
  const path = join(p.root, `aside-${n}-${Math.random().toString(36).slice(2, 6)}.duckdb`);
  await seed(path, [ORDERS(n), "CHECKPOINT"]);
  putCopy(p, path, asOf);
}

/** An engine over the project, tracked in `into` so the file's teardown closes it. */
export async function openEngine(into: ServeEngine[], extensionDir: string, p: TempProject, o: Partial<ServeEngineOptions & ReadersEngineInternals> = {}): Promise<ServeEngine> {
  const e = await openReadersEngine({ root: p.root, resources: { threads: 2 }, extensionDir, copyPollMs: 25, ...o });
  into.push(e);
  return e;
}
