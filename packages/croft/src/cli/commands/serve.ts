// croft serve [--host h] [--port 7447] (DESIGN.md §4.1, §4.2, §5 "Server mode", §8 "Turning it on"): the
// optional long-running read server for apps, with the scheduler loop built in. `croft serve key add|list|remove <name>`
// manages the keys people read with (cli/commands/serve-key.ts, D122).
//
// 1. Refuse while a live croft serve is recorded for the project (<state>/serve.json).
// 2. The token: CROFT_SERVE_TOKEN (the shell, then the project's .env), else 32 random bytes.
// 3. Open the engine (serve/instance.ts: the read-only instance, held in a query worker process it can kill, and
//    the write-intent handoff), listen (serve/server.ts) with the keys file (serve/keys.ts, read on every request) and
//    one log line on stderr for every key query, record serve.json (0600), and start the loop that spawns
//    `croft tick` every minute while scheduling is on (serve/loop.ts).
//    In server mode the readers' process also listens for DuckDB 2.0 clients over Quack (D125): its address is in the banner and in
//    serve.json, and each Quack query a key makes gets a log line like an HTTP one.
// 4. Print the banner (--json: one envelope with the address), then run until SIGINT, SIGTERM or SIGHUP.
// 5. Stop: no more ticks, remove serve.json (apps fall back to reading the file), stop listening, close the
//    engine (which interrupts what still runs and kills its workers), exit 0. A worker whose croft serve dies
//    without stopping (kill -9) exits by itself, so the file is never left locked.
//
// Off a TTY it runs all the same (servers, containers). Agents are told to ask the user to start it in their own
// terminal (SKILL.md), since it never returns by itself.
import { mkdirSync } from "node:fs";
import { relative, sep } from "node:path";
import { CroftError } from "../../core/errors.ts";
import { currentIdentity } from "../../core/proc.ts";
import { formatInstant, zonedParts } from "../../core/time.ts";
import { RunsDb } from "../../history/runs-db.ts";
import type { Project } from "../../project/root.ts";
import { liveServer } from "../../read/locate.ts";
import type { SchedulingSetting } from "../../schedule/os.ts";
import { isLoopbackHost, isUnspecifiedHost, resolveToken, type ServeToken, urlHost } from "../../serve/auth.ts";
import { KeyStore } from "../../serve/keys.ts";
import { openEngine } from "../../serve/open.ts";
import { connectSnippet, listenAddress, type QuackConnect } from "../../serve/quack-address.ts";
import type { QuackEvent } from "../../serve/quack-access.ts";
import { type LoopEvent, type SchedulerLoop, startLoop, TICK_INTERVAL_MS, tickEnv, type TickSpawner } from "../../serve/loop.ts";
import {
  alreadyServing, type KeyQueryLog, removeServeJson, type RunningServer, type ServerOptions, serveJsonPath, startServer, writeServeJson,
} from "../../serve/server.ts";
import type { ServeEngine, ServeEngineOptions } from "../../serve/types.ts";
import type { CommandImpl, CommandResult, Ctx } from "../command.ts";
import { buildEnvelope, redactEnvelope } from "../render.ts";
import { CROFT_VERSION } from "../version.ts";
import { formatKey, runKey, type ServeKeyData, unknownLine, unknownSharedTables } from "./serve-key.ts";

export interface ServeData {
  url: string;
  host: string;
  port: number;
  pid: number;
  /** Whether it listens on loopback only. Anything else must sit behind HTTPS. */
  loopback: boolean;
  database: string;
  /** ISO-8601 with the project offset. */
  startedAt: string;
  version: string;
  token: {
    source: ServeToken["source"];
    /** Where CROFT_SERVE_TOKEN came from; null for a generated token. */
    from: ".env" | "env" | null;
    /** serve.json, which holds the token (relative to the project when inside it). */
    file: string;
  };
  scheduling: { state: SchedulingSetting["state"]; via: SchedulingSetting["via"]; pausedUntil: string | null; tickEveryMs: number };
  /** The keys people read with (croft serve key add) and the tables they may read (serve.sharedTables), as the server
   *  started: a key made later is honoured at once, a table shared later needs a restart. */
  keys: { count: number; sharedTables: string[]; unknownTables: string[]; needsServerMode: boolean };
  /** Set once it stopped. */
  stopped: { signal: string; at: string } | null;
  /** Only with serverMode on (D119): croft serve answers from this read copy (relative to the project when inside it),
   *  as of this time (null until the first copy exists), and never opens the warehouse file. */
  serverMode?: { readCopy: string; asOf: string | null };
  /** Only in server mode, once the readers' process listens (D125): how a person's DuckDB 2.0 attaches over Quack, with `<key>`
   *  where the key goes (croft serve key add prints the statement with the key in it). */
  quack?: QuackConnect & { uri: string; attach: string };
}

/** What tests replace. Everything defaults to the real thing. */
export interface ServeDeps {
  openEngine?: (o: ServeEngineOptions) => Promise<ServeEngine>;
  listen?: (o: ServerOptions) => RunningServer;
  spawnTick?: TickSpawner;
  tickIntervalMs?: number;
  /** Resolves with the reason to stop. Default: the first SIGINT, SIGTERM or SIGHUP (a second one exits at once). */
  stop?: Promise<string>;
  /** Called once it listens and serve.json is written. */
  onStarted?: (d: ServeData) => void;
  /** Ends the process after a --json run, whose one envelope was printed at start. Default process.exit. */
  exit?: (code: number) => void;
}

export const serve: CommandImpl<ServeData | ServeKeyData> = {
  async run(ctx) {
    const [first, ...rest] = ctx.positionals;
    if (first === "key") return runKey(ctx, rest);
    if (first !== undefined) {
      throw new CroftError("USAGE_ERROR", {
        message: `croft serve takes no ${JSON.stringify(first.slice(0, 40))}; start it with croft serve, or manage keys with croft serve key add|list|remove <name>`,
        hint: "croft serve [--host h] [--port p] | croft serve key add|list|remove <name>",
      });
    }
    return runServe(ctx);
  },
  human(result, ctx) {
    const d = result.data;
    if ("action" in d) return formatKey(d);
    // The banner went out when the server started; what is left to say is that it stopped.
    return d.stopped ? `croft serve stopped (${d.stopped.signal})` : formatBanner(d, ctx.project.timezone);
  },
};

export async function runServe(ctx: Ctx, deps: ServeDeps = {}): Promise<CommandResult<ServeData>> {
  const project = ctx.project;
  const cfg = project.config.serve;
  const host = hostOption(ctx.values.host) ?? cfg.host;
  const port = portOption(ctx.values.port) ?? cfg.port;
  const stateDir = project.paths.stateDir;
  mkdirSync(stateDir, { recursive: true });

  const running = liveServer(stateDir);
  if (running && running.pid !== process.pid) throw alreadyServing(running);
  // The token comes from the shell or .env only: serve never runs the secretsFrom command (D108).
  const token = resolveToken((name) => {
    const found = ctx.env.lookup(name);
    return found && found.source !== "command" ? { value: found.value, source: found.source } : null;
  });
  const scheduling = readScheduling(stateDir, ctx);
  const keys = new KeyStore(stateDir);

  // Signals are caught from here on, so a Ctrl-C while starting still cleans up.
  const signals = deps.stop ? null : catchSignals();
  const stop = deps.stop ?? signals!.stop;
  let engine: ServeEngine | undefined;
  let server: RunningServer | undefined;
  let loop: SchedulerLoop | undefined;
  // Every step runs even when one fails (reported on stderr): serve.json must go, and the file must be released.
  const step = async (what: string, fn: () => unknown) => {
    try {
      await fn();
    } catch (e) {
      ctx.render.err(`croft serve: could not ${what} while stopping: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const shutdown = async () => {
    loop?.stop();
    await step("remove serve.json", () => removeServeJson(stateDir));
    // Stop listening, let the engine interrupt what still runs (those requests get their answer), then close
    // whatever connections are left.
    const closing = server?.stop(false).catch(() => {});
    await step("close the database", () => engine?.close());
    await within(closing, 3000);
    await step("close the connections", () => server?.stop(true));
    keys.flush(); // last, so the uses of the requests that finished above are in: what croft serve key list shows
  };

  const started = ctx.now();
  try {
    engine = await (deps.openEngine ?? openEngine)({
      root: project.root, maxConcurrent: cfg.maxConcurrent, queryTimeoutMs: cfg.queryTimeoutMs,
      // Quack's hooks run in the readers' process, which cannot write the log or the last-used time: it reports, and this writes.
      onQuack: (e) => onQuack(ctx, keys, e, project.timezone),
    });
    server = (deps.listen ?? startServer)({
      engine, host, port, token: token.token, allowOrigins: cfg.allowOrigins, root: project.root,
      database: project.databaseLabel, timezone: project.timezone, startedAt: formatInstant(started, project.timezone),
      redact: (text) => ctx.env.redact(text),
      keys, sharedTables: cfg.sharedTables, onKeyQuery: (e) => ctx.render.err(keyLogLine(e, project.timezone)),
      onError: (e) => ctx.render.err(`croft serve: failed while answering a request: ${e instanceof Error ? e.stack ?? e.message : String(e)}`),
    });
    const id = currentIdentity();
    // The listener starts with the readers' process, which waits for the first read copy; until it exists a fixed address is the
    // configured one, and a port of 0 is not known yet.
    const mode = engine.status().serverMode;
    const sm = project.config.serverMode;
    const quackUri = mode?.quack?.uri ?? (mode && sm.quackPort !== 0 ? listenAddress(sm.quackHost, sm.quackPort).uri : null);
    writeServeJson(stateDir, {
      url: server.url, host: server.host, port: server.port, token: token.token, pid: id.pid, procStart: id.procStart,
      bootId: id.bootId, startedAt: started.toISOString(), version: CROFT_VERSION,
      ...(engine.status().serverMode ? { serverMode: true as const } : {}),
      ...(quackUri ? { quack: { uri: quackUri } } : {}),
    });
    loop = startLoop({
      root: project.root, stateDir, env: tickEnv(ctx.processEnv), intervalMs: deps.tickIntervalMs ?? TICK_INTERVAL_MS,
      ...(deps.spawnTick ? { spawn: deps.spawnTick } : {}), onEvent: loopLogger(ctx),
    });

    const data: ServeData = {
      url: server.url, host: server.host, port: server.port, pid: process.pid, loopback: server.loopback,
      database: project.databaseLabel, startedAt: formatInstant(started, project.timezone), version: CROFT_VERSION,
      token: { source: token.source, from: token.from ?? null, file: shownPath(project, serveJsonPath(stateDir)) },
      scheduling: { state: scheduling.state, via: scheduling.via, pausedUntil: scheduling.pausedUntil ?? null, tickEveryMs: deps.tickIntervalMs ?? TICK_INTERVAL_MS },
      keys: {
        count: keyCount(keys), sharedTables: [...cfg.sharedTables], unknownTables: unknownSharedTables(project),
        // A key works only in server mode (D128): with keys made and server mode off, every key is refused until it is on.
        needsServerMode: !project.config.serverMode.enabled && keyCount(keys) > 0,
      },
      stopped: null,
      ...(project.config.serverMode.enabled ? { serverMode: { readCopy: shownPath(project, project.paths.readCopy), asOf: engine.status().serverMode?.asOf ?? null } } : {}),
      ...(quackUri ? { quack: connectSnippet({ host: project.config.serverMode.quackHost, port: project.config.serverMode.quackPort }, quackUri, null) as QuackConnect & { uri: string; attach: string } } : {}),
    };
    announce(ctx, data);
    deps.onStarted?.(data);

    const signal = await stop;
    await shutdown();
    const result: CommandResult<ServeData> = {
      data: { ...data, stopped: { signal, at: formatInstant(ctx.now(), project.timezone) } }, problems: [], next: [], exit: 0,
    };
    if (ctx.json) (deps.exit ?? ((code: number) => process.exit(code)))(0); // its one envelope went out at start
    return result;
  } catch (e) {
    await shutdown();
    throw e;
  } finally {
    signals?.dispose();
  }
}

/** The banner on stdout, or with --json the one envelope; both from data redacted the way main.ts does it. */
function announce(ctx: Ctx, data: ServeData): void {
  const meta = { database: ctx.project.databaseLabel, timezone: ctx.project.timezone };
  const envelope = redactEnvelope(
    buildEnvelope({ command: "serve", data, problems: [], next: [], ...meta, durationMs: performance.now() - ctx.startedAt }),
    redactorOf(ctx),
  );
  if (ctx.json) ctx.render.envelope(envelope);
  else ctx.render.outRaw(formatBanner(envelope.data, ctx.project.timezone, ctx.now()));
}

/** How many keys the file holds; 0 when it cannot be read (the server then accepts none, and `croft serve key list` says why). */
function keyCount(keys: KeyStore): number {
  try {
    return keys.list().length;
  } catch {
    return 0;
  }
}

/** The one log line of a key query (D122): who, when, what it read, how many rows, how long; never the SQL or the key. */
export function keyLogLine(e: KeyQueryLog, timezone: string): string {
  const what = e.outcome === "ok" ? `read ${e.tables.length ? e.tables.join(", ") : "no table"}` : `refused ${e.outcome}`;
  return `croft serve: key ${e.key}  ${formatInstant(e.at, timezone)}  ${what}  ${e.rows} row${e.rows === 1 ? "" : "s"}  ${e.ms} ms`;
}

/** What a Quack session did: a key's query gets its log line, and a sign-in or a query counts as the key's last use (D125). */
function onQuack(ctx: Ctx, keys: KeyStore, e: QuackEvent, timezone: string): void {
  keys.noteUsed(e.key);
  if (e.kind === "query") ctx.render.err(quackLogLine(e, timezone));
}

/** The log line of a key's Quack query (D125): like an HTTP one (keyLogLine), but Quack's hook runs before the query does, so the
 *  rows and the time are the client's to know, and the line says it went over Quack instead. Never the SQL or the key. */
export function quackLogLine(e: Extract<QuackEvent, { kind: "query" }>, timezone: string): string {
  const what = e.outcome === "ok" ? `read ${e.tables.length ? e.tables.join(", ") : "no table"}` : `refused ${e.outcome}`;
  return `croft serve: key ${e.key}  ${formatInstant(new Date(e.at), timezone)}  ${what}  over Quack`;
}

function redactorOf(ctx: Ctx) {
  const env = ctx.env;
  return Object.assign((text: string) => env.redact(text), { data: (text: string) => env.redactData(text) });
}

/** Errors of the loop on stderr, each distinct one once in a row (it retries every minute). */
function loopLogger(ctx: Ctx): (e: LoopEvent) => void {
  let last = "";
  return (e) => {
    if (e.kind !== "error") {
      if (e.kind === "spawned") last = "";
      return;
    }
    const text = `croft serve: could not start croft tick: ${e.error instanceof Error ? e.error.message : String(e.error)}`;
    if (text !== last) ctx.render.err(text);
    last = text;
  };
}

/** DESIGN.md §4.2. */
export function formatBanner(d: ServeData, timezone: string, now: Date = new Date()): string {
  const lines = [d.serverMode
    ? `croft serve · ${d.url} · server mode: answers from ${d.serverMode.readCopy}, never opens ${d.database}`
    : `croft serve · ${d.url} · database ${d.database} (read-only, steps aside for writes)`];
  if (d.serverMode) {
    lines.push(`the read copy is ${d.serverMode.asOf ? `as of ${localTime(d.serverMode.asOf, timezone, now)}` : "not made yet: croft serve is making it, and a run makes it too"}; every answer says as of when, and runs never wait for croft serve`);
  }
  if (!d.loopback) {
    const bound = `${urlHost(d.host)}:${d.port}`;
    const proxyHost = isLoopbackHost(d.host) || isUnspecifiedHost(d.host) ? `127.0.0.1:${d.port}` : bound;
    lines.push(`not loopback: put an HTTPS reverse proxy or tunnel in front of ${bound} (it must send Host: ${proxyHost})`
      + (d.token.source === "generated"
        ? ", and set CROFT_SERVE_TOKEN in .env: hosted apps need a token that does not change on every start"
        : "; every request needs the token"));
  }
  if (d.keys.needsServerMode) {
    const n = d.keys.count;
    lines.push(`${n} key${n === 1 ? " is" : "s are"} refused until server mode is on: a key works only there ("serverMode": {"enabled": true} in croft.json, croft docs keys)`);
  } else if (d.keys.count > 0 || (d.serverMode && d.keys.sharedTables.length > 0)) {
    const n = `${d.keys.count} key${d.keys.count === 1 ? "" : "s"} (croft serve key list)`;
    lines.push(d.keys.sharedTables.length
      ? `${n} read ${d.keys.sharedTables.join(", ")}, read-only`
      : `${n}, but serve.sharedTables in croft.json names no table, so every key query is refused`);
  }
  if (d.quack) {
    lines.push(`DuckDB 2.0 clients attach over Quack at ${d.quack.uri} with a key: ${d.quack.attach}; the copy's as-of time is in ${d.quack.asOfView} (croft docs quack)`);
    if (!d.quack.loopback) {
      lines.push(`Quack is not loopback: put an HTTPS reverse proxy in front of ${d.quack.uri.replace(/^quack:/, "")}; clients attach to the proxy's name with the port written out`);
    }
  }
  lines.push(...unknownLine(d.keys.unknownTables));
  if (d.token.source === "generated") lines.push(`token: ${d.token.file} (hosted apps: set CROFT_SERVE_TOKEN)`);
  else lines.push(`token: CROFT_SERVE_TOKEN from ${d.token.from === "env" ? "the environment" : ".env"} (apps in this project also find it in ${d.token.file})`);
  lines.push(schedulerLine(d.scheduling, timezone, now));
  lines.push('apps: import from "@zabaca/croft/read" in this project, or set CROFT_URL + CROFT_SERVE_TOKEN');
  lines.push("^C to stop");
  return lines.join("\n");
}

function schedulerLine(s: ServeData["scheduling"], timezone: string, now: Date): string {
  const every = s.tickEveryMs === 60_000 ? "every minute" : `every ${Math.round(s.tickEveryMs / 1000)} s`;
  if (s.state === "on") return `scheduler: on, ticking ${every}`;
  if (s.state === "paused") {
    return s.pausedUntil
      ? `scheduler: paused until ${localTime(s.pausedUntil, timezone, now)} (croft schedule on resumes it now)`
      : "scheduler: paused (croft schedule on resumes it)";
  }
  return "scheduler: off (croft schedule on turns it on; on a server without an OS job: croft schedule on --no-os-job)";
}

/** "14:00" today, "2026-09-26 14:00" another day, in the project zone. */
function localTime(iso: string, timezone: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const p = zonedParts(at, timezone);
  const n = zonedParts(now, timezone);
  const pad = (x: number) => String(x).padStart(2, "0");
  const time = `${pad(p.hour)}:${pad(p.minute)}`;
  return p.year === n.year && p.month === n.month && p.day === n.day ? time : `${p.year}-${pad(p.month)}-${pad(p.day)} ${time}`;
}

function shownPath(project: Project, p: string): string {
  return p.startsWith(project.root + sep) ? relative(project.root, p) : p;
}

/** Scheduling as `croft tick` reads it; CROFT_NOW honored. */
function readScheduling(stateDir: string, ctx: Ctx): SchedulingSetting {
  const db = RunsDb.open(stateDir, { now: () => ctx.now() });
  try {
    return db.getScheduling();
  } finally {
    db.close();
  }
}

function hostOption(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const host = v.trim();
  if (host === "" || /[\s/?#@]/.test(host)) {
    throw new CroftError("USAGE_ERROR", {
      message: `--host ${JSON.stringify(v)} is not an address to listen on`,
      hint: "leave --host out to listen on 127.0.0.1 (this machine only); otherwise give an address like 0.0.0.0 and put an HTTPS proxy in front",
      fix: { kind: "command", description: "listen on this machine only", command: "croft serve", requiresHuman: true },
      details: { host: v },
    });
  }
  return host;
}

function portOption(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  const n = /^\d{1,5}$/.test(t) ? Number(t) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new CroftError("USAGE_ERROR", {
      message: `--port ${JSON.stringify(v)} is not a port number`,
      hint: "give a whole number from 1 to 65535 (0 picks a free port), or leave --port out for serve.port in croft.json (7447 by default)",
      fix: { kind: "command", description: "listen on the default port", command: "croft serve", requiresHuman: true },
      details: { port: v },
    });
  }
  return n;
}

/** Wait for `p`, at most `ms`, without a timer that outlives the wait. */
async function within(p: Promise<unknown> | undefined, ms: number): Promise<void> {
  if (!p) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([p, new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** The stop signal: the first SIGINT, SIGTERM or SIGHUP. A second one while stopping exits at once (130). */
function catchSignals(): { stop: Promise<string>; dispose(): void } {
  const names = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  let fired = false;
  let resolve!: (s: string) => void;
  const stop = new Promise<string>((r) => (resolve = r));
  const handler = (sig: NodeJS.Signals) => {
    if (fired) process.exit(130);
    fired = true;
    resolve(sig);
  };
  for (const n of names) process.on(n, handler);
  return { stop, dispose: () => { for (const n of names) process.off(n, handler); } };
}
