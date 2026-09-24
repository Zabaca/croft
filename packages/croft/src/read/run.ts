// The query() pipeline of @zabaca/croft/read, with its environment passed in (tests inject env, cwd and
// shorter waits; read.ts passes process.env and process.cwd()). DESIGN.md §5 "Server mode, apps and GUIs":
// 1. { url } or CROFT_URL: always HTTP; no project needed (a hosted app has none).
// 2. Otherwise find the project; a live croft serve in <state>/serve.json answers when it can.
// 3. Otherwise open the file directly, read-only, for this one query.
// Direct mode is imported on first use: it is the only part that needs @duckdb/node-api, so a hosted app
// that only talks to croft serve never loads the native binding (the build splits it into its own chunk).
// It uses no Bun-only APIs: this file ships in the Node build.
import { CroftError } from "../core/errors.ts";
import type { ReadOptions } from "../read-types.ts";
import type { Row } from "../types.ts";
import type { DirectTimings } from "./direct.ts";
import { type Env, explicitUrl, findProject, httpUrl, liveServer, readServeRecord, tokenFor } from "./locate.ts";
import { ABSENT, DEFAULT_SERVER_TIMINGS, DEFAULT_TIMEOUT_MS, serverQuery, type ServerTimings } from "./server.ts";
import { DEFAULT_LIMIT, type SelectRequest } from "./wire.ts";

export interface ReadContext {
  env: Env;
  cwd: string;
  direct?: DirectTimings;
  server?: Omit<ServerTimings, "timeoutMs">;
}

/** Which way a query went; for tests and diagnostics. */
export type Route = "url" | "serve.json" | "direct";

export async function runQuery(sql: unknown, params: unknown, options: unknown, ctx: ReadContext, onRoute?: (r: Route) => void): Promise<Row[]> {
  const o = checkOptions(options);
  const req = checkRequest(sql, params, o.limit ?? DEFAULT_LIMIT);
  const timings: ServerTimings = { timeoutMs: o.timeoutMs ?? DEFAULT_TIMEOUT_MS, ...DEFAULT_SERVER_TIMINGS, ...ctx.server };

  const explicit = explicitUrl(o, ctx.env);
  if (explicit) {
    onRoute?.("url");
    const token = tokenFor(explicit.url, o, ctx.env, () => localRecord(o, ctx));
    const rows = await serverQuery({ url: explicit.url, token: token?.token ?? null, tokenSource: token?.source ?? null, local: false }, req, timings);
    if (rows === ABSENT) throw new CroftError("INTERNAL_ERROR", { message: "an explicit read server URL was treated as absent", hint: "report this croft bug" });
    return rows;
  }

  const project = findProject(o, ctx.env, ctx.cwd);
  const local = liveServer(project.paths.stateDir);
  const url = local ? httpUrl(local.url) : null;
  if (local && url) {
    const token = tokenFor(url, o, ctx.env, local);
    const rows = await serverQuery({ url, token: token?.token ?? null, tokenSource: token?.source ?? null, local: true }, req, timings);
    if (rows !== ABSENT) {
      onRoute?.("serve.json");
      return rows;
    }
  }
  onRoute?.("direct");
  const direct = await import("./direct.ts");
  return direct.directQuery(project, req, ctx.direct ?? direct.DEFAULT_TIMINGS);
}

/** The local serve.json, for the token of an explicit URL; null when there is no (valid) project here. */
function localRecord(o: ReadOptions, ctx: ReadContext) {
  try {
    return readServeRecord(findProject(o, ctx.env, ctx.cwd).paths.stateDir);
  } catch {
    return null; // a hosted app has no project; an explicit URL does not need one
  }
}

function usage(message: string, hint: string): CroftError {
  return new CroftError("USAGE_ERROR", { message, hint });
}

function checkOptions(options: unknown): ReadOptions {
  if (options === undefined || options === null) return {};
  if (typeof options !== "object" || Array.isArray(options)) {
    throw usage("query()'s third argument must be an options object like { limit: 100 }", "call query(sql, params, { ... })");
  }
  const o = options as ReadOptions;
  for (const key of ["project", "url", "token"] as const) {
    if (o[key] !== undefined && typeof o[key] !== "string") throw usage(`{ ${key} } must be a string`, `pass ${key} as a string`);
  }
  if (o.limit !== undefined && !(Number.isSafeInteger(o.limit) && o.limit >= 1)) {
    throw usage(`{ limit } must be a whole number of rows, 1 or more; found ${String(o.limit)}`, `omit it for the default of ${DEFAULT_LIMIT.toLocaleString("en-US")}`);
  }
  if (o.timeoutMs !== undefined && !(typeof o.timeoutMs === "number" && Number.isFinite(o.timeoutMs) && o.timeoutMs >= 0)) {
    throw usage(`{ timeoutMs } must be a number of milliseconds, 0 or more; found ${String(o.timeoutMs)}`, `omit it for the default of ${DEFAULT_TIMEOUT_MS} ms`);
  }
  return o;
}

function checkRequest(sql: unknown, params: unknown, limit: number): SelectRequest {
  if (typeof sql !== "string") throw usage("query()'s first argument must be one SELECT as a string", 'call query("SELECT ...")');
  if (params !== undefined && params !== null && !Array.isArray(params)) {
    throw usage("query()'s params must be an array bound to $1, $2, ...", 'call query("SELECT * FROM t WHERE id = $1", [id])');
  }
  return { sql, params: (params as unknown[] | undefined | null) ?? [], limit };
}
