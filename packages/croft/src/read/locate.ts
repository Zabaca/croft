// Where @zabaca/croft/read sends a query (DESIGN.md §5 "Server mode, apps and GUIs"):
// - the project: { project }, then CROFT_PROJECT, then a walk up from the working directory (which also
//   checks ./data/croft.json, for a project inside an app repo); croft.json gives the time zone, the
//   database and a relocated state folder;
// - the server: { url }, then CROFT_URL (both explicit: never a fallback to the file), then a live
//   croft serve recorded in <state>/serve.json;
// - the token: { token }, then CROFT_SERVE_TOKEN, then serve.json.
// It uses no Bun-only APIs: this file ships in the Node build.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CroftError } from "../core/errors.ts";
import { isHolderAlive } from "../db/intent.ts";
import { CONFIG_FILE, loadProject, type Project } from "../project/root.ts";

export type Env = Record<string, string | undefined>;

const nonEmpty = (s: string | undefined): string | undefined => (s !== undefined && s.trim() !== "" ? s.trim() : undefined);

/** Find and load the project. Throws PROJECT_NOT_FOUND (with app-oriented advice) or CONFIG_INVALID. */
export function findProject(o: { project?: string }, env: Env, cwd: string): Project {
  const explicit = nonEmpty(o.project) ?? nonEmpty(env.CROFT_PROJECT);
  if (explicit !== undefined) {
    const root = resolve(cwd, explicit);
    // An app may point at its repo root; the project then lives in its data/ folder (§2).
    const dir = !existsSync(join(root, CONFIG_FILE)) && existsSync(join(root, "data", CONFIG_FILE)) ? join(root, "data") : root;
    if (!existsSync(join(dir, CONFIG_FILE))) {
      throw new CroftError("PROJECT_NOT_FOUND", {
        message: `${root} is not a croft project (it has no croft.json)${o.project ? "" : " (from CROFT_PROJECT)"}`,
        hint: "point { project } or CROFT_PROJECT at the folder that holds croft.json",
        fix: { kind: "manual", description: "pass the folder that holds croft.json" },
        details: { project: root },
      });
    }
    return loadProject({ root: dir });
  }
  try {
    return loadProject({ cwd });
  } catch (e) {
    if (e instanceof CroftError && e.code === "PROJECT_NOT_FOUND") {
      throw new CroftError("PROJECT_NOT_FOUND", {
        message: `no croft project found from ${cwd}: no croft.json there, in its parent folders or in ${join(cwd, "data")}`,
        hint: "pass query(sql, params, { project: \"/path/to/data\" }) or set CROFT_PROJECT; to use a croft serve instead, set CROFT_URL",
        fix: { kind: "manual", description: "tell query() where the croft project is, or where croft serve listens" },
        details: { cwd },
      });
    }
    throw e;
  }
}

/** What croft serve records in <state>/serve.json. Only the fields the read helper uses. */
export interface ServeRecord {
  url: string;
  token: string | null;
  pid: number;
  procStart: string | null;
  bootId: string | null;
}

/** Parse <state>/serve.json; null when missing, unreadable or without a pid and an address. */
export function readServeRecord(stateDir: string): ServeRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(stateDir, "serve.json"), "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.pid !== "number" || !Number.isInteger(v.pid) || v.pid <= 0) return null;
  let url = typeof v.url === "string" ? v.url : null;
  if (!url && typeof v.port === "number") {
    const host = typeof v.host === "string" && v.host !== "" ? v.host : "127.0.0.1";
    url = `http://${host.includes(":") ? `[${host}]` : host}:${v.port}`;
  }
  if (!url || !httpUrl(url)) return null;
  return {
    url,
    token: typeof v.token === "string" && v.token !== "" ? v.token : null,
    pid: v.pid,
    procStart: typeof v.procStart === "string" ? v.procStart : null,
    bootId: typeof v.bootId === "string" ? v.bootId : null,
  };
}

/**
 * Whether the recorded server process still runs. Same rule as write intents and asset leases: the boot
 * id and the process start time must match, not only the PID, because PIDs are reused after a reboot
 * (intent.ts's isHolderAlive: /proc/<pid>/stat on Linux, `ps -o lstart=` on macOS). A record without
 * them falls back to "the PID exists"; a reused PID then costs one refused connection, after which the
 * server counts as absent anyway.
 */
export function isServeAlive(r: ServeRecord): boolean {
  if (r.procStart !== null && r.bootId !== null) return isHolderAlive({ pid: r.pid, procStart: r.procStart, bootId: r.bootId });
  try {
    process.kill(r.pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The live croft serve recorded for a state folder, if any. */
export function liveServer(stateDir: string): ServeRecord | null {
  const r = readServeRecord(stateDir);
  return r && isServeAlive(r) ? r : null;
}

export function httpUrl(text: string): URL | null {
  try {
    const u = new URL(text);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "" ? u : null;
  } catch {
    return null;
  }
}

/** Parse an explicit server URL ({ url } or CROFT_URL). Throws USAGE_ERROR for anything but http(s). */
export function explicitUrl(o: { url?: string }, env: Env): { url: URL; source: "option" | "CROFT_URL" } | null {
  const fromOption = nonEmpty(o.url);
  const text = fromOption ?? nonEmpty(env.CROFT_URL);
  if (text === undefined) return null;
  const source = fromOption !== undefined ? "option" : "CROFT_URL";
  const url = httpUrl(text);
  if (!url) {
    throw new CroftError("USAGE_ERROR", {
      message: `${source === "option" ? "{ url }" : "CROFT_URL"} must be the http(s) address of croft serve, like http://127.0.0.1:7447; found ${JSON.stringify(text)}`,
      hint: "use the URL croft serve printed when it started",
    });
  }
  return { url, source };
}

export type TokenSource = "option" | "CROFT_SERVE_TOKEN" | "serve.json";

/**
 * The bearer token: { token }, then CROFT_SERVE_TOKEN, then serve.json. The serve.json token is used only
 * for the origin serve.json records: sending it to an explicit URL elsewhere would hand the local server's
 * token to a remote host.
 */
export function tokenFor(url: URL, o: { token?: string }, env: Env, record: ServeRecord | null | (() => ServeRecord | null)): { token: string; source: TokenSource } | null {
  const option = nonEmpty(o.token);
  if (option !== undefined) return { token: option, source: "option" };
  const fromEnv = nonEmpty(env.CROFT_SERVE_TOKEN);
  if (fromEnv !== undefined) return { token: fromEnv, source: "CROFT_SERVE_TOKEN" };
  const r = typeof record === "function" ? record() : record; // looked up only when needed
  if (!r?.token || httpUrl(r.url)?.origin !== url.origin) return null;
  return { token: r.token, source: "serve.json" };
}
