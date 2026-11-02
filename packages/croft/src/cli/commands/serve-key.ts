// croft serve key add|list|remove <name> (DESIGN.md §4.1, D122): a key per person for croft serve's HTTP API.
//
// - add <name>: make a key, print it once, keep its SHA-256 in <state>/serve-keys.json (serve/keys.ts). The key reads the
//   tables named in croft.json's serve.sharedTables, read-only, over POST /query; the app token keeps reading every table.
//   Giving a person access to data is the user's call, so the skill puts `add` on its ask-first list.
// - list: the names, when each was made and last used; never a key.
// - remove <name>: the key is refused on its next request. Taking access away needs no asking.
// All three work with croft serve running or not, and with --json: croft serve reads the keys file on every HTTP request
// (serve/keys.ts), so a key added or removed here is honoured by a running server at once, with no restart; its readers' process
// has the list within a poll (250 ms, D126) for the Quack sessions that outlive a request.
//
// In server mode (D125) a key also signs in to Quack, from a person's DuckDB 2.0. What a person needs to attach is in the data
// as `quack` (the address, the ATTACH statement, the name of the as-of view), so an agent gets it as `--json` too, and the
// human text prints the same.
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { CroftError } from "../../core/errors.ts";
import { formatInstant } from "../../core/time.ts";
import type { Project } from "../../project/root.ts";
import { didYouMean } from "../../project/suggest.ts";
import { liveServer } from "../../read/locate.ts";
import { type KeyInfo, KeyStore } from "../../serve/keys.ts";
import { connectSnippet, type QuackConnect } from "../../serve/quack-address.ts";
import type { CommandResult, Ctx } from "../command.ts";
import { table } from "../render.ts";

/** A key as `list` shows it: times in the project offset. */
export interface ServeKeyInfo {
  name: string;
  createdAt: string;
  /** null: never used, as far as croft serve has written down. */
  lastUsedAt: string | null;
}

/** What `croft serve key …` prints with --json. `key` appears once, in `add`, and nowhere else. */
export type ServeKeyData =
  | {
    action: "add";
    name: string;
    /** The key itself: shown now and never again. Keep it out of logs, chats and git. */
    key: string;
    createdAt: string;
    /** The tables it reads (serve.sharedTables); empty means every query of it is refused until the project names some. */
    sharedTables: string[];
    /** Entries of sharedTables that no asset of the project makes (a typo, or an asset not written yet): a key cannot read them. */
    unknownTables: string[];
    /** The keys file, relative to the project when inside it: only the key's hash is kept there. */
    file: string;
    /** Whether server mode is on in croft.json. A key works only there (D128): with it off the key is made all the same, so a
     *  person can be set up first, and croft serve refuses it until server mode is on. */
    serverMode: boolean;
    /** Server mode only: how to attach from a DuckDB 2.0 client, with the key in the statement. */
    quack?: QuackConnect;
  }
  | { action: "list"; keys: ServeKeyInfo[]; sharedTables: string[]; unknownTables: string[]; file: string; serverMode: boolean; quack?: QuackConnect }
  | { action: "remove"; name: string; createdAt: string; lastUsedAt: string | null; remaining: number };

const ACTIONS = ["add", "list", "remove"] as const;

/**
 * The entries of serve.sharedTables that no asset file makes: asset names are the files' names under assets/, so a typo in the
 * list shares nothing, and without this nobody would be told (a name that is an asset not yet run is a table that does not
 * exist yet, and is not named here).
 */
export function unknownSharedTables(project: Project): string[] {
  const dir = project.paths.assetsDir;
  const names = new Set<string>();
  if (existsSync(dir)) {
    for (const f of new Bun.Glob("**/*.{ts,sql}").scanSync({ cwd: dir, onlyFiles: true })) {
      if (!f.endsWith(".d.ts")) names.add(basename(f, extname(f)));
    }
  }
  return project.config.serve.sharedTables.filter((t) => !names.has(t));
}

/** Where a DuckDB 2.0 client attaches, in server mode: the address croft serve recorded if it runs (a port of 0 is only known
 *  then), else the configured one. Undefined outside server mode, where there is no Quack. */
function quackFor(project: Project, key: string | null): QuackConnect | undefined {
  const sm = project.config.serverMode;
  if (!sm.enabled) return undefined;
  let running: string | null = null;
  if (liveServer(project.paths.stateDir)) {
    try {
      const rec = JSON.parse(readFileSync(join(project.paths.stateDir, "serve.json"), "utf8")) as { quack?: { uri?: unknown } };
      if (typeof rec.quack?.uri === "string") running = rec.quack.uri;
    } catch {
      // The record is read for the address only; a damaged one means the configured address is shown.
    }
  }
  return connectSnippet({ host: sm.quackHost, port: sm.quackPort }, running, key);
}

/** `croft serve key <action> [name]`: the positionals after `key`. */
export function runKey(ctx: Ctx, rest: readonly string[]): CommandResult<ServeKeyData> {
  const project = ctx.project;
  const action = rest[0];
  if (!action || !(ACTIONS as readonly string[]).includes(action)) {
    const guess = action ? didYouMean(action, ACTIONS) : undefined;
    throw new CroftError("USAGE_ERROR", {
      message: action ? `croft serve key has no ${JSON.stringify(action.slice(0, 40))}; it takes add, list or remove` : "croft serve key needs add, list or remove",
      hint: guess ? `did you mean "${guess}"? croft serve key add|list|remove <name>` : "croft serve key add <name>, croft serve key list, croft serve key remove <name>",
    });
  }
  const names = rest.slice(1);
  if (action === "list" ? names.length > 0 : names.length !== 1) {
    throw new CroftError("USAGE_ERROR", {
      message: action === "list" ? "croft serve key list takes no name" : `croft serve key ${action} takes exactly one name`,
      hint: action === "list" ? "croft serve key list" : `croft serve key ${action} <name>`,
    });
  }
  const store = new KeyStore(project.paths.stateDir, { now: () => ctx.now() });
  const file = shown(project, store.path);
  const sharedTables = [...project.config.serve.sharedTables];
  const unknownTables = unknownSharedTables(project);
  if (action === "list") {
    const quack = quackFor(project, null);
    return { data: { action: "list", keys: store.list().map((k) => view(k, project)), sharedTables, unknownTables, file, serverMode: project.config.serverMode.enabled, ...(quack ? { quack } : {}) }, problems: [], next: [] };
  }
  const name = names[0]!;
  if (action === "add") {
    const made = store.add(name);
    const quack = quackFor(project, made.key);
    return {
      data: { action: "add", name, key: made.key, createdAt: formatInstant(new Date(made.info.createdAt), project.timezone), sharedTables, unknownTables, file, serverMode: project.config.serverMode.enabled, ...(quack ? { quack } : {}) },
      problems: [], next: [],
    };
  }
  const gone = store.remove(name);
  return {
    data: { action: "remove", name, createdAt: formatInstant(new Date(gone.createdAt), project.timezone), lastUsedAt: gone.lastUsedAt ? formatInstant(new Date(gone.lastUsedAt), project.timezone) : null, remaining: store.list().length },
    problems: [], next: [],
  };
}

function view(k: KeyInfo, project: Project): ServeKeyInfo {
  return {
    name: k.name,
    createdAt: formatInstant(new Date(k.createdAt), project.timezone),
    lastUsedAt: k.lastUsedAt ? formatInstant(new Date(k.lastUsedAt), project.timezone) : null,
  };
}

function shown(project: Project, path: string): string {
  return path.startsWith(`${project.root}/`) ? path.slice(project.root.length + 1) : path;
}

/** The warning for entries of serve.sharedTables that no asset makes, as lines (none when there are none). */
export function unknownLine(unknown: readonly string[]): string[] {
  return unknown.length ? [`serve.sharedTables names no asset called ${unknown.join(", ")} (a typo?): a key cannot read ${unknown.length === 1 ? "it" : "them"}`] : [];
}

/** The warning for keys with server mode off (D128): a key is made all the same, so a person can be set up before the mode is turned on. */
export function serverModeLine(on: boolean, what: string): string[] {
  return on ? [] : [`server mode is off in croft.json, so ${what} is refused until server mode is on ("serverMode": {"enabled": true}, which the user decides: croft docs keys)`];
}

/** The lines that tell a person how to attach from DuckDB 2.0 (croft docs quack). */
function quackLines(q: QuackConnect | undefined, shared: readonly string[]): string[] {
  if (!q) return [];
  if (!q.attach) return ["From a DuckDB 2.0 client, over Quack: croft serve picks the port (serverMode.quackPort is 0); its banner shows the address to attach to."];
  return [
    "From a DuckDB 2.0 client, over Quack (croft docs quack):",
    `  ${q.attach};`,
    `  SELECT * FROM croft.${shared[0] ?? "<shared table>"};   -- the shared tables are views of the read copy`,
    `  SELECT as_of FROM croft.${q.asOfView};   -- when the copy was taken`,
    ...(q.loopback ? [] : ["Quack is not on loopback: it must sit behind an HTTPS reverse proxy, and the client attaches to the proxy's name with the port written out."]),
  ];
}

function quackAddressLine(q: QuackConnect): string {
  return q.uri ? `DuckDB 2.0 clients attach over Quack at ${q.uri} (croft docs quack)` : "Quack: croft serve picks the port (serverMode.quackPort is 0); its banner shows it";
}

/** The human text of a key command. */
export function formatKey(d: ServeKeyData): string {
  if (d.action === "add") {
    const reads = d.sharedTables.length
      ? `This key reads ${d.sharedTables.join(", ")}, read-only (serve.sharedTables in croft.json).`
      : "serve.sharedTables in croft.json names no table yet, so every query of this key is refused until it does.";
    return [
      `key for ${d.name}, shown once (croft keeps only its hash, in ${d.file}):`,
      "",
      `  ${d.key}`,
      "",
      reads,
      ...unknownLine(d.unknownTables),
      ...serverModeLine(d.serverMode, "this key"),
      "Send it as Authorization: Bearer <key> to croft serve's POST /query, or give it to query() as { token }.",
      ...quackLines(d.quack, d.sharedTables),
      `Removing it is one command: croft serve key remove ${d.name}`,
    ].join("\n");
  }
  if (d.action === "list") {
    if (!d.keys.length) return `no keys yet; croft serve key add <name> makes one${d.sharedTables.length ? "" : " (and serve.sharedTables in croft.json names the tables it reads)"}`;
    const t = table(["name", "made", "last used"], d.keys.map((k) => [k.name, k.createdAt, k.lastUsedAt ?? "never"]));
    const reads = d.sharedTables.length ? `keys read: ${d.sharedTables.join(", ")}` : "serve.sharedTables names no table, so every key query is refused";
    return [t.text, reads, ...unknownLine(d.unknownTables), ...serverModeLine(d.serverMode, "every key"), ...(d.quack ? [quackAddressLine(d.quack)] : [])].join("\n");
  }
  return `removed the key for ${d.name} (made ${d.createdAt}); it is refused on its next request, croft serve running or not. ${d.remaining} key${d.remaining === 1 ? "" : "s"} left`;
}
