// Finding the project and reading croft.json (DESIGN.md §2). croft.json is data, not code (D3), so
// the launcher and `croft tick` read it without running user code. The validator is hand-written so
// every message names the key, what was expected and what was found.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, statSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CroftError, problem } from "../core/errors.ts";
import { checkTimeZone, systemTimeZone } from "../core/time.ts";
import type { Fix, Problem } from "../core/types.ts";
import { joinPath, scanJson, type JsonPosition } from "./json-locate.ts";
import { didYouMean } from "./suggest.ts";

export const CONFIG_FILE = "croft.json";

export interface NotifyConfig { desktop: boolean; webhook: string | null }
export interface ServeConfig {
  port: number; host: string; queryTimeoutMs: number; maxConcurrent: number; maxBytes: number; maxRows: number; allowOrigins: string[];
}
export interface CroftConfig {
  database: string;                  // as written: relative to the root, or absolute after relocation
  timezone: string;
  readCopy: boolean;
  notify: NotifyConfig;
  concurrency: number;               // parallel extractions in one run
  serve: ServeConfig;
  stateDir: string | null;           // set when .croft/ was relocated off a synced folder
}

export const DEFAULTS = {
  database: "warehouse.duckdb",
  readCopy: false,
  notify: { desktop: true, webhook: null },
  concurrency: 4,
  serve: { port: 7447, host: "127.0.0.1", queryTimeoutMs: 30_000, maxConcurrent: 4, maxBytes: 64 * 1024 * 1024, maxRows: 100_000, allowOrigins: [] },
} as const;

/** One line per key, for `croft docs config`. */
export const CONFIG_KEYS: { key: string; type: string; default: string; description: string }[] = [
  { key: "database", type: "string", default: `"${DEFAULTS.database}"`, description: "the DuckDB file, relative to the project folder (absolute after relocation)" },
  { key: "timezone", type: "string", default: "(required)", description: "IANA zone for schedules, ::DATE and JSON timestamps, e.g. \"America/Los_Angeles\"; changing it rebuilds every transform" },
  { key: "readCopy", type: "boolean", default: "false", description: "keep warehouse.read.duckdb, a copy for GUIs and notebooks, refreshed after runs" },
  { key: "notify.desktop", type: "boolean", default: "true", description: "desktop notification when a scheduled run fails" },
  { key: "notify.webhook", type: "string | null", default: "null", description: "http(s) URL that receives the failure envelope of a scheduled run" },
  { key: "concurrency", type: "integer", default: String(DEFAULTS.concurrency), description: "extractions that run at the same time in one run (1-64)" },
  { key: "serve.port", type: "integer", default: String(DEFAULTS.serve.port), description: "read server port" },
  { key: "serve.host", type: "string", default: `"${DEFAULTS.serve.host}"`, description: "read server address; anything but loopback must sit behind HTTPS" },
  { key: "serve.queryTimeoutMs", type: "integer", default: String(DEFAULTS.serve.queryTimeoutMs), description: "deadline for one query over HTTP" },
  { key: "serve.maxConcurrent", type: "integer", default: String(DEFAULTS.serve.maxConcurrent), description: "queries running in DuckDB at once; the rest queue" },
  { key: "serve.maxBytes", type: "integer", default: String(DEFAULTS.serve.maxBytes), description: "largest result in bytes; bigger results fail with QUERY_TOO_MANY_ROWS" },
  { key: "serve.maxRows", type: "integer", default: String(DEFAULTS.serve.maxRows), description: "most rows one answer carries, whatever limit asks; more fail with QUERY_TOO_MANY_ROWS" },
  { key: "serve.allowOrigins", type: "string[]", default: "[]", description: "browser origins allowed to call the read server, e.g. \"http://localhost:3000\"" },
  { key: "stateDir", type: "string", default: "\".croft\"", description: "state folder; croft sets it when it moves state off a synced folder" },
];

const TOP_KEYS = ["$schema", "database", "timezone", "readCopy", "notify", "concurrency", "serve", "stateDir"];
const NOTIFY_KEYS = ["desktop", "webhook"];
const SERVE_KEYS = ["port", "host", "queryTimeoutMs", "maxConcurrent", "maxBytes", "maxRows", "allowOrigins"];

export interface ConfigIssue {
  path: string;                      // "" for the whole file, "serve.port", "serve.allowOrigins[0]"
  message: string;
  hint: string;
  line?: number;
  column?: number;
  fix?: Fix;
}
export type ConfigResult = { ok: true; config: CroftConfig } | { ok: false; issues: ConfigIssue[] };

type Locate = (path: string) => JsonPosition | undefined;

/** Where a croft.json lives, so its paths can be checked against the project folder (and ~). */
export interface ConfigPlace { root: string; home?: string }

/** Parse and validate the text of croft.json. With `place`, stateDir and database are checked on disk too. */
export function parseConfig(text: string, place?: ConfigPlace): ConfigResult {
  const scan = scanJson(text);
  if (!scan.ok) {
    return { ok: false, issues: [{
      path: "", message: `croft.json is not valid JSON: ${scan.message}`, line: scan.at.line, column: scan.at.column,
      hint: `fix the JSON at line ${scan.at.line}, column ${scan.at.column}`,
    }] };
  }
  const raw: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  return validateConfig(raw, (path) => scan.paths.get(path), place);
}

/** Validate a parsed croft.json, collecting every issue rather than stopping at the first. */
export function validateConfig(raw: unknown, locate: Locate = () => undefined, place?: ConfigPlace): ConfigResult {
  const issues: ConfigIssue[] = [];
  const add = (path: string, message: string, hint: string, fix?: Fix) => {
    const at = locate(path);
    issues.push({ path, message, hint, ...(at ? { line: at.line, column: at.column } : {}), ...(fix ? { fix } : {}) });
  };
  const editFix = (path: string, description: string, from: string, to: string): Fix => {
    const at = locate(path);
    return { kind: "edit", description, file: CONFIG_FILE, ...(at ? { line: at.line } : {}), replace: { from, to } };
  };

  if (!isPlainObject(raw)) {
    add("", `croft.json must hold a JSON object like {"database": "warehouse.duckdb", "timezone": "${systemTimeZone()}"}; found ${kindOf(raw)}`,
      "replace the contents of croft.json with an object");
    return { ok: false, issues };
  }

  const unknownKeys = (obj: Record<string, unknown>, known: string[], parent: string) => {
    for (const key of Object.keys(obj)) {
      if (known.includes(key)) continue;
      const path = joinPath(parent, key);
      const guess = didYouMean(key, known.filter((k) => k !== "$schema"));
      if (guess) add(path, `unknown key "${path}"; did you mean "${joinPath(parent, guess)}"?`, `rename "${key}" to "${guess}"`,
        editFix(path, `rename "${key}" to "${guess}"`, `"${key}"`, `"${guess}"`));
      else add(path, `unknown key "${path}"; ${parent ? `"${parent}"` : "croft.json"} takes ${known.filter((k) => k !== "$schema").map((k) => `"${k}"`).join(", ")}`,
        `remove "${key}" from croft.json (croft docs config lists every key)`);
    }
  };
  unknownKeys(raw, TOP_KEYS, "");

  const str = (obj: Record<string, unknown>, path: string, key: string, fallback: string): string => {
    const v = obj[key];
    if (v === undefined) return fallback;
    if (typeof v === "string" && v.trim() !== "") return v;
    add(path, `"${path}" must be a non-empty string; found ${show(v)}`, `set "${path}" to a string in double quotes`);
    return fallback;
  };
  const bool = (obj: Record<string, unknown>, path: string, key: string, fallback: boolean): boolean => {
    const v = obj[key];
    if (v === undefined) return fallback;
    if (typeof v === "boolean") return v;
    const fix = v === "true" || v === "false" ? editFix(path, `use ${v} without quotes`, `"${v}"`, v) : undefined;
    add(path, `"${path}" must be true or false; found ${show(v)}`, `set "${path}" to true or false (no quotes)`, fix);
    return fallback;
  };
  const int = (obj: Record<string, unknown>, path: string, key: string, fallback: number, min: number, max: number): number => {
    const v = obj[key];
    if (v === undefined) return fallback;
    if (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max) return v;
    const fix = typeof v === "string" && /^\d+$/.test(v) && Number(v) >= min && Number(v) <= max
      ? editFix(path, `use ${v} without quotes`, `"${v}"`, v) : undefined;
    add(path, `"${path}" must be a whole number from ${min} to ${max}; found ${show(v)}`, `set "${path}" to a number like ${fallback}`, fix);
    return fallback;
  };
  const obj = (path: string, key: string): Record<string, unknown> => {
    const v = raw[key];
    if (v === undefined) return {};
    if (isPlainObject(v)) return v;
    add(path, `"${path}" must be an object; found ${show(v)}`, `write "${path}" as {…} (croft docs config lists its keys)`);
    return {};
  };

  // database
  const database = str(raw, "database", "database", DEFAULTS.database);
  if (raw.database !== undefined && typeof raw.database === "string" && raw.database.trim() !== "") {
    if (raw.database === ":memory:") add("database", `"database" must be a file; ":memory:" would lose every table when croft exits`, `set "database" to "${DEFAULTS.database}"`);
    else if (!database.endsWith(".duckdb")) {
      add("database", `"database" must end in .duckdb; found ${show(database)}`, `rename it to "${database.replace(/\.[^./]*$/, "")}.duckdb"`,
        editFix("database", "use the .duckdb extension", `"${database}"`, `"${database.replace(/\.[^./]*$/, "")}.duckdb"`));
    }
  }

  // timezone (required: "daily at 06:00" must not change meaning on a UTC server)
  let timezone = "UTC";
  if (raw.timezone === undefined) {
    const zone = systemTimeZone();
    add("", `croft.json has no "timezone"; croft needs it for schedules, ::DATE and JSON timestamps`, `add "timezone": "${zone}" to croft.json`,
      { kind: "edit", description: `add the time zone ${zone}`, file: CONFIG_FILE, insert: `"timezone": "${zone}"` });
  } else if (typeof raw.timezone !== "string") {
    add("timezone", `"timezone" must be a string like "America/Los_Angeles"; found ${show(raw.timezone)}`, `set "timezone" to an IANA zone name`);
  } else {
    const check = checkTimeZone(raw.timezone);
    if (check.ok) timezone = check.name;
    else {
      const tz = raw.timezone;
      add("timezone", `"timezone" is ${show(tz)}, which croft cannot use: ${check.reason}`,
        check.suggestion ? `use "${check.suggestion}"` : `use an IANA zone name like "America/Los_Angeles" or "Asia/Tokyo"`,
        check.suggestion ? editFix("timezone", `use "${check.suggestion}"`, `"${tz}"`, `"${check.suggestion}"`) : undefined);
    }
  }

  const readCopy = bool(raw, "readCopy", "readCopy", DEFAULTS.readCopy);
  const concurrency = int(raw, "concurrency", "concurrency", DEFAULTS.concurrency, 1, 64);

  // notify
  const n = obj("notify", "notify");
  unknownKeys(n, NOTIFY_KEYS, "notify");
  const desktop = bool(n, "notify.desktop", "desktop", DEFAULTS.notify.desktop);
  let webhook: string | null = null;
  if (n.webhook !== undefined && n.webhook !== null) {
    if (typeof n.webhook === "string" && isHttpUrl(n.webhook)) webhook = n.webhook;
    else add("notify.webhook", `"notify.webhook" must be an http(s) URL or null; found ${show(n.webhook)}`, `set it to a URL like "https://hooks.slack.com/services/…", or remove it`);
  }

  // serve
  const s = obj("serve", "serve");
  unknownKeys(s, SERVE_KEYS, "serve");
  const serve: ServeConfig = {
    port: int(s, "serve.port", "port", DEFAULTS.serve.port, 1, 65535),
    host: str(s, "serve.host", "host", DEFAULTS.serve.host),
    queryTimeoutMs: int(s, "serve.queryTimeoutMs", "queryTimeoutMs", DEFAULTS.serve.queryTimeoutMs, 100, 3_600_000),
    maxConcurrent: int(s, "serve.maxConcurrent", "maxConcurrent", DEFAULTS.serve.maxConcurrent, 1, 64),
    maxBytes: int(s, "serve.maxBytes", "maxBytes", DEFAULTS.serve.maxBytes, 1024, Number.MAX_SAFE_INTEGER),
    maxRows: int(s, "serve.maxRows", "maxRows", DEFAULTS.serve.maxRows, 1, 10_000_000),
    allowOrigins: [],
  };
  if (s.allowOrigins !== undefined) {
    if (!Array.isArray(s.allowOrigins)) {
      add("serve.allowOrigins", `"serve.allowOrigins" must be a list of origins like ["http://localhost:3000"]; found ${show(s.allowOrigins)}`, "write it as a JSON array of strings");
    } else {
      s.allowOrigins.forEach((o: unknown, i: number) => {
        const path = joinPath("serve.allowOrigins", i);
        const origin = typeof o === "string" ? originOf(o) : null;
        if (origin && origin === o) serve.allowOrigins.push(origin);
        else if (origin) add(path, `"${path}" must be an origin without a path; found ${show(o)}`, `use "${origin}"`, editFix(path, `use "${origin}"`, `"${o as string}"`, `"${origin}"`));
        else add(path, `"${path}" must be an origin like "http://localhost:3000"; found ${show(o)}`,
          o === "*" ? "list each origin that may call the read server; \"*\" is not allowed" : "use scheme://host[:port]");
      });
    }
  }

  // stateDir
  let stateDir: string | null = null;
  if (raw.stateDir !== undefined && raw.stateDir !== null) stateDir = str(raw, "stateDir", "stateDir", "") || null;

  if (place && !issues.length) {
    for (const i of locationIssues(database, stateDir, place)) add(i.path, i.message, i.hint);
  }

  if (issues.length) return { ok: false, issues };
  return { ok: true, config: { database, timezone, readCopy, notify: { desktop, webhook }, concurrency, serve, stateDir } };
}

/**
 * stateDir and database locations that would break the sandbox (DESIGN.md §5). stateDir goes into the warehouse
 * connection's allowed_directories and files/ into croft query's, so SQL assets, checks and ctx.query can read
 * everything under stateDir, and `croft query` everything under files/. §2 relocation writes both keys, so
 * this is the last check before a bad value reaches DuckDB. Paths are resolved without opening anything.
 */
function locationIssues(database: string, stateDir: string | null, place: ConfigPlace): { path: string; message: string; hint: string }[] {
  const home = place.home ?? homedir();
  const paths = resolvePaths(place.root, { database, stateDir } as CroftConfig, home);
  const real = (p: string) => physicalPath(p).path;
  const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);
  const root = real(place.root);
  const db = real(paths.database);
  const state = real(paths.stateDir);
  const folders = [["files/", paths.filesDir], ["assets/", paths.assetsDir], ["lib/", paths.libDir]].map(([name, p]) => [name!, real(p!)] as const);
  const out: { path: string; message: string; hint: string }[] = [];
  const fixState = 'remove "stateDir" to use .croft/ in the project folder, or name a folder of its own such as "~/.local/share/croft/<project>/.croft"';
  if (stateDir !== null) {
    const found = `"stateDir" is ${show(stateDir)}`;
    const folder = folders.find(([, f]) => inside(state, f) || inside(f, state));
    if (inside(root, state)) {
      out.push({ path: "stateDir", message: `${found}, which is or holds the project folder; SQL could then read .env and the warehouse file`, hint: fixState });
    } else if (inside(real(home), state)) {
      out.push({ path: "stateDir", message: `${found}, which is or holds your home folder; SQL could then read every file in it`, hint: fixState });
    } else if (folder) {
      out.push({ path: "stateDir", message: `${found}, which overlaps the project's ${folder[0]} folder; croft query could then read serve.json (the serve token) and runs.sqlite`, hint: fixState });
    } else if (inside(db, state)) {
      out.push({ path: "stateDir", message: `${found}, a state folder that is or holds the database ${show(database)}; SQL assets may read the state folder but must never reach the warehouse file`, hint: "keep the database outside the state folder" });
    }
  }
  const name = basename(db);
  if (inside(db, folders[0]![1])) {
    out.push({ path: "database", message: `"database" is ${show(database)}, inside files/, which croft query may read; the warehouse must stay out of SQL's reach`, hint: `set "database" to "${DEFAULTS.database}"` });
  } else if (stateDir === null && inside(db, state)) {
    out.push({ path: "database", message: `"database" is ${show(database)}, inside the state folder .croft/, which SQL assets may read`, hint: `set "database" to "${DEFAULTS.database}"` });
  } else if (name === "preview.duckdb" || name.endsWith(".read.duckdb")) {
    out.push({ path: "database", message: `"database" is ${show(database)}, a reserved name: croft uses preview.duckdb for previews and <name>.read.duckdb for the read copy`, hint: `set "database" to "${DEFAULTS.database}"` });
  }
  return out;
}

/** One CONFIG_INVALID problem per issue (for `doctor` and `validate`, which report all of them). */
export function configProblems(issues: ConfigIssue[], file = CONFIG_FILE): Problem[] {
  return issues.map((i) => problem("CONFIG_INVALID", {
    message: i.message, hint: i.hint, file,
    ...(i.line !== undefined ? { line: i.line, column: i.column } : {}),
    fix: i.fix ?? { kind: "manual", description: i.hint },
    details: { key: i.path || null },
  }));
}

/** Read and validate <root>/croft.json. Throws CONFIG_INVALID listing every issue. */
export function readConfig(root: string, home?: string): CroftConfig {
  const file = join(root, CONFIG_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new CroftError("PROJECT_NOT_FOUND", {
      message: `cannot read ${file}: ${(e as Error).message}`,
      hint: "check that croft.json exists and is readable",
      file: CONFIG_FILE,
    });
  }
  const result = parseConfig(text, { root, home });
  if (result.ok) return result.config;
  throw configError(result.issues);
}

function configError(issues: ConfigIssue[]): CroftError {
  const first = issues[0]!;
  const message = issues.length === 1 ? first.message
    : `croft.json has ${issues.length} problems:\n${issues.map((i) => `${i.line ? `line ${i.line}: ` : ""}${i.message}`).join("\n")}`;
  return new CroftError("CONFIG_INVALID", {
    message,
    hint: issues.length === 1 ? first.hint : `${first.hint} (and fix the other ${issues.length - 1}; croft docs config lists every key)`,
    file: CONFIG_FILE,
    ...(first.line !== undefined ? { line: first.line, column: first.column } : {}),
    fix: first.fix ?? { kind: "manual", description: first.hint },
    details: { issues },
  });
}

/** The project root for a starting folder: the nearest folder with croft.json, walking up.
 *  The start folder's data/croft.json is also checked, for projects inside an app repo (§2). */
export function findRoot(start: string): string | null {
  const dir = resolve(start);
  if (isFile(join(dir, CONFIG_FILE))) return dir;
  if (isFile(join(dir, "data", CONFIG_FILE))) return join(dir, "data");
  for (let cur = dirname(dir); ; cur = dirname(cur)) {
    if (isFile(join(cur, CONFIG_FILE))) return cur;
    if (dirname(cur) === cur) return null;
  }
}

export interface ProjectPaths {
  root: string;
  config: string;
  database: string;
  readCopy: string;                  // warehouse.read.duckdb next to the database
  stateDir: string;                  // .croft/ or its relocated folder
  filesDir: string;                  // files/ (input files stay in the project folder)
  assetsDir: string;
  libDir: string;
  envFile: string;
}

export interface Project {
  root: string;
  config: CroftConfig;
  paths: ProjectPaths;
  timezone: string;
  databaseLabel: string;             // for the envelope: relative to the root when inside it
  relocated: boolean;                // database or state lives outside the project folder
}

export function resolvePaths(root: string, config: CroftConfig, home = homedir()): ProjectPaths {
  const database = resolve(root, expandHome(config.database, home));
  return {
    root,
    config: join(root, CONFIG_FILE),
    database,
    readCopy: database.replace(/\.duckdb$/, "") + ".read.duckdb",
    stateDir: config.stateDir ? resolve(root, expandHome(config.stateDir, home)) : join(root, ".croft"),
    filesDir: join(root, "files"),
    assetsDir: join(root, "assets"),
    libDir: join(root, "lib"),
    envFile: join(root, ".env"),
  };
}

/** Find, read and validate the project. Throws PROJECT_NOT_FOUND or CONFIG_INVALID. */
export function loadProject(opts: { cwd?: string; root?: string; home?: string } = {}): Project {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const root = opts.root ? resolve(opts.root) : findRoot(cwd);
  if (!root || !isFile(join(root, CONFIG_FILE))) throw notFound(opts.root ? resolve(opts.root) : cwd, !!opts.root);
  const config = readConfig(root, opts.home);
  const paths = resolvePaths(root, config, opts.home);
  const inside = (p: string) => p === root || p.startsWith(root + sep);
  return {
    root, config, paths, timezone: config.timezone,
    databaseLabel: inside(paths.database) ? relative(root, paths.database) : paths.database,
    relocated: !inside(paths.database) || !inside(paths.stateDir),
  };
}

export function notFound(start: string, explicit = false): CroftError {
  return new CroftError("PROJECT_NOT_FOUND", {
    message: explicit
      ? `${start} is not a croft project (it has no croft.json)`
      : `no croft project here: no croft.json in ${start}, its parent folders or ${join(start, "data")}`,
    hint: "cd into the folder that has croft.json, or create a project with croft init",
    fix: { kind: "manual", description: "run croft from inside a project folder, or create one with croft init" },
  });
}

/** Why a path should not hold a DuckDB file (file sync or a network filesystem), or null (§2). */
export function syncedLocation(path: string, opts: { home?: string; platform?: NodeJS.Platform; wsl?: boolean } = {}): string | null {
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const p = resolve(path);
  const under = (base: string) => p === base || p.startsWith(base + sep);
  if (platform === "darwin") {
    if (under(join(home, "Library", "Mobile Documents"))) return "iCloud Drive";
    if (under(join(home, "Library", "CloudStorage"))) return "a cloud storage folder (Dropbox, OneDrive or Google Drive)";
    if (under(join(home, "Documents")) || under(join(home, "Desktop"))) return "~/Documents or ~/Desktop, which iCloud often syncs";
  }
  const rel = under(home) ? relative(home, p).split(sep)[0] ?? "" : "";
  if (rel === "Dropbox" || rel.startsWith("Dropbox (")) return "Dropbox";
  if (rel === "OneDrive" || rel.startsWith("OneDrive - ")) return "OneDrive";
  if (rel === "Google Drive") return "Google Drive";
  if (platform === "linux") {
    if ((opts.wsl ?? isWsl()) && /^\/mnt\/[a-z](\/|$)/.test(p)) return "a Windows drive under WSL (/mnt/<drive>)";
    const fs = networkFilesystem(p);
    if (fs) return `a network filesystem (${fs})`;
  }
  return null;
}

/** Where a relocated project keeps its database and state: ~/.local/share/croft/<name>-<hash>/. */
export function relocationDir(root: string, home = homedir()): string {
  const abs = resolve(root);
  const name = basename(abs).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  const hash = createHash("sha256").update(abs).digest("hex").slice(0, 8);
  return join(home, ".local", "share", "croft", `${name}-${hash}`);
}

// Linux statfs magic numbers of filesystems that break DuckDB's fcntl lock or corrupt mid-write.
const NETWORK_FS: Record<number, string> = {
  0x6969: "nfs", 0x517b: "smb", 0xff534d42: "cifs", 0xfe534d42: "smb2", 0x01021997: "9p",
};

function networkFilesystem(path: string): string | null {
  for (let cur = path; ; cur = dirname(cur)) {
    try {
      return NETWORK_FS[statfsSync(cur).type] ?? null;
    } catch {
      if (dirname(cur) === cur) return null;                            // path does not exist yet: check its parent
    }
  }
}

function isWsl(): boolean {
  if (process.env.WSL_DISTRO_NAME) return true;
  try { return /microsoft/i.test(readFileSync("/proc/version", "utf8")); } catch { return false; }
}

/**
 * The path the OS resolves `path` to, found without opening anything. Bun's realpath opens the file (open +
 * F_GETPATH on macOS), and closing that descriptor releases this process's DuckDB lock on it (§5, hazard 3);
 * it also normalizes `..` lexically first. So symlinks are followed here one component at a time with lstat
 * and readlink, and `..` after a symlink goes up from its target, as open(2) does. A missing tail is appended
 * to the resolved part as written (`exists: false`). Relative paths resolve against `cwd`.
 */
export function physicalPath(path: string, cwd = process.cwd()): { path: string; exists: boolean } {
  const queue = (isAbsolute(path) ? path : `${cwd}/${path}`).split("/").filter((s) => s !== "" && s !== ".");
  let cur = ""; // resolved so far, without symlinks; "" is the file system root
  let hops = 0;
  while (queue.length) {
    const part = queue.shift()!;
    if (part === "..") {
      cur = cur.slice(0, cur.lastIndexOf("/"));
      continue;
    }
    const next = `${cur}/${part}`;
    let st;
    try {
      st = lstatSync(next);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return { path: resolve(next, ...queue), exists: false };
      throw e;
    }
    if (st.isSymbolicLink()) {
      if (++hops > 40) throw Object.assign(new Error(`too many symbolic links in ${path}`), { code: "ELOOP" });
      const target = readlinkSync(next);
      queue.unshift(...target.split("/").filter((s) => s !== "" && s !== "."));
      if (target.startsWith("/")) cur = "";
      continue;
    }
    if (queue.length && !st.isDirectory()) return { path: resolve(next, ...queue), exists: false };
    cur = next;
  }
  return { path: cur || "/", exists: true };
}

function expandHome(p: string, home: string): string {
  return p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isHttpUrl(s: string): boolean {
  try { const u = new URL(s); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; }
}

function originOf(s: string): string | null {
  try {
    const u = new URL(s);
    return (u.protocol === "http:" || u.protocol === "https:") && u.origin !== "null" ? u.origin : null;
  } catch { return null; }
}

function kindOf(v: unknown): string {
  return v === null ? "null" : Array.isArray(v) ? "a list" : `a ${typeof v}`;
}

function show(v: unknown): string {
  if (v === undefined) return "nothing";
  const text = JSON.stringify(v) ?? String(v);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

