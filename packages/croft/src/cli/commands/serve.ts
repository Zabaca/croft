// croft serve [--host h] [--port 7447] (DESIGN.md §4.1, §4.2, §5 "Server mode", §8 "Turning it on"): the
// optional long-running read server for apps, with the scheduler loop built in.
//
// 1. Refuse while a live croft serve is recorded for the project (<state>/serve.json).
// 2. The token: CROFT_SERVE_TOKEN (the shell, then the project's .env), else 32 random bytes.
// 3. Open the engine (serve/instance.ts: the read-only instance and the write-intent handoff), listen
//    (serve/server.ts), record serve.json (0600), and start the loop that spawns `croft tick` every minute
//    while scheduling is on (serve/loop.ts).
// 4. Print the banner (--json: one envelope with the address), then run until SIGINT, SIGTERM or SIGHUP.
// 5. Stop: no more ticks, remove serve.json (apps fall back to reading the file), stop listening, close the
//    engine (which interrupts what still runs), exit 0.
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
import { openServeEngine } from "../../serve/instance.ts";
import { type LoopEvent, type SchedulerLoop, startLoop, TICK_INTERVAL_MS, tickEnv, type TickSpawner } from "../../serve/loop.ts";
import {
  alreadyServing, removeServeJson, type RunningServer, type ServerOptions, serveJsonPath, startServer, writeServeJson,
} from "../../serve/server.ts";
import type { ServeEngine, ServeEngineOptions } from "../../serve/types.ts";
import type { CommandImpl, CommandResult, Ctx } from "../command.ts";
import { buildEnvelope, redactEnvelope } from "../render.ts";
import { CROFT_VERSION } from "../version.ts";

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
  /** Set once it stopped. */
  stopped: { signal: string; at: string } | null;
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

export const serve: CommandImpl<ServeData> = {
  run: (ctx) => runServe(ctx),
  human(result, ctx) {
    const d = result.data;
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
  const token = resolveToken((name) => ctx.env.lookup(name));
  const scheduling = readScheduling(stateDir, ctx);

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
  };

  const started = ctx.now();
  try {
    engine = await (deps.openEngine ?? openServeEngine)({ root: project.root, maxConcurrent: cfg.maxConcurrent, queryTimeoutMs: cfg.queryTimeoutMs });
    server = (deps.listen ?? startServer)({
      engine, host, port, token: token.token, allowOrigins: cfg.allowOrigins, root: project.root,
      database: project.databaseLabel, timezone: project.timezone, startedAt: formatInstant(started, project.timezone),
      redact: (text) => ctx.env.redact(text),
      onError: (e) => ctx.render.err(`croft serve: failed while answering a request: ${e instanceof Error ? e.stack ?? e.message : String(e)}`),
    });
    const id = currentIdentity();
    writeServeJson(stateDir, {
      url: server.url, host: server.host, port: server.port, token: token.token, pid: id.pid, procStart: id.procStart,
      bootId: id.bootId, startedAt: started.toISOString(), version: CROFT_VERSION,
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
      stopped: null,
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
  const lines = [`croft serve · ${d.url} · database ${d.database} (read-only, steps aside for writes)`];
  if (!d.loopback) {
    const bound = `${urlHost(d.host)}:${d.port}`;
    const proxyHost = isLoopbackHost(d.host) || isUnspecifiedHost(d.host) ? `127.0.0.1:${d.port}` : bound;
    lines.push(`not loopback: put an HTTPS reverse proxy or tunnel in front of ${bound} (it must send Host: ${proxyHost})`
      + (d.token.source === "generated"
        ? ", and set CROFT_SERVE_TOKEN in .env: hosted apps need a token that does not change on every start"
        : "; every request needs the token"));
  }
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
