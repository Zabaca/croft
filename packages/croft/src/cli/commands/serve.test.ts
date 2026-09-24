// croft serve, the command: the banner (DESIGN.md §4.2), serve.json while it runs, the scheduler loop, a clean
// stop, --json, and the refusals. The engine is a fake (serve/instance.ts is another builder's), and so are the
// tick spawner and the stop signal; the HTTP server is the real one on port 0.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CroftError } from "../../core/errors.ts";
import { bootId } from "../../core/proc.ts";
import { RunsDb } from "../../history/runs-db.ts";
import { query } from "../../read.ts";
import { cleanup, spawnIdle } from "../../read/testkit.ts";
import type { TickSpawner } from "../../serve/loop.ts";
import type { RunningServer } from "../../serve/server.ts";
import type { ServeEngine, ServeEngineOptions, ServeQuery } from "../../serve/types.ts";
import type { Command } from "../command.ts";
import { CliContext } from "../context.ts";
import { Render } from "../render.ts";
import { COMMANDS } from "./index.ts";
import { cli, makeProject } from "./inspect-testkit.ts";
import { formatBanner, runServe, serve, type ServeData, type ServeDeps } from "./serve.ts";

afterAll(() => cleanup());

interface Fake extends ServeEngine {
  calls: ServeQuery[];
  closed: boolean;
  opened: ServeEngineOptions[];
}

function fakeEngine(): Fake {
  const e: Fake = {
    calls: [], closed: false, opened: [],
    async query(q) {
      e.calls.push(q);
      return { columns: [{ name: "a", type: "INTEGER" }], rows: [{ a: 1 }], rowCount: 1, tookMs: 0 };
    },
    status: () => ({ state: "open", writeIntent: null, inFlight: 0, queued: 0, openConnections: 1, queriesToday: e.calls.length }),
    async close() {
      e.closed = true;
    },
  };
  return e;
}

function stopper() {
  let fire!: (s: string) => void;
  const stop = new Promise<string>((r) => (fire = r));
  return { stop, fire };
}

function spawner() {
  const calls: { root: string; stateDir: string; env: Record<string, string> }[] = [];
  const spawn: TickSpawner = (o) => {
    calls.push(o);
    return { pid: 4242, alive: () => false };
  };
  return { spawn, calls };
}

/** The registered serve command, running runServe with test deps. */
function command(deps: ServeDeps): Command {
  const spec = COMMANDS.find((c) => c.name === "serve")!;
  const { load: _load, ...rest } = spec;
  return { ...rest, run: (ctx) => runServe(ctx, deps), human: serve.human!.bind(serve) };
}

/** Start `croft serve` in this process; resolves once it listens. */
async function start(argv: string[], o: { root: string; env?: Record<string, string>; deps?: Partial<ServeDeps> } ) {
  const engine = fakeEngine();
  const ticks = spawner();
  const { stop, fire } = stopper();
  let onStarted!: (d: ServeData) => void;
  const started = new Promise<ServeData>((r) => (onStarted = r));
  const deps: ServeDeps = {
    openEngine: async (opts) => {
      engine.opened.push(opts);
      return engine;
    },
    spawnTick: ticks.spawn, tickIntervalMs: 60_000, stop, onStarted, ...o.deps,
  };
  const done = cli(["serve", ...argv], { cwd: o.root, env: o.env ?? {}, commands: [command(deps)] });
  const first = await Promise.race([started, done.then((r) => r)]);
  return { engine, ticks, fire, done, started: "url" in first ? first : null, early: "url" in first ? null : first };
}

describe("croft serve", () => {
  test("prints the banner, records serve.json (0600) while it runs, answers queries, and cleans up on a signal", async () => {
    const p = makeProject();
    const s = await start(["--port", "0"], { root: p.root });
    const d = s.started!;
    expect(d.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(d.pid).toBe(process.pid);

    const file = join(p.stateDir, "serve.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const rec = JSON.parse(readFileSync(file, "utf8"));
    expect(rec).toMatchObject({ url: d.url, host: "127.0.0.1", port: d.port, pid: process.pid, version: expect.any(String) });
    expect(rec.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(typeof rec.procStart).toBe("string");
    expect(typeof rec.bootId).toBe("string");
    expect(typeof rec.startedAt).toBe("string");

    // An app in this project finds the server through serve.json, with its token.
    expect(await query("SELECT 1 AS a", [], { project: p.root })).toEqual([{ a: 1 }]);
    expect(s.engine.calls).toHaveLength(1);
    expect(s.engine.opened[0]).toMatchObject({ root: p.root, maxConcurrent: 4, queryTimeoutMs: 30_000 });

    s.fire("SIGINT");
    const r = await s.done;
    expect(r.exit).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(s.engine.closed).toBe(true);
    const lines = r.stdout.split("\n");
    expect(lines.slice(0, 5)).toEqual([
      `croft serve · ${d.url} · database warehouse.duckdb (read-only, steps aside for writes)`,
      "token: .croft/serve.json (hosted apps: set CROFT_SERVE_TOKEN)",
      "scheduler: off (croft schedule on turns it on; on a server without an OS job: croft schedule on --no-os-job)",
      'apps: import from "@zabaca/croft/read" in this project, or set CROFT_URL + CROFT_SERVE_TOKEN',
      "^C to stop",
    ]);
    expect(r.stdout).toContain("croft serve stopped (SIGINT)");
    expect(r.stdout).not.toContain(rec.token);
  });

  test("with scheduling on, the loop ticks from the project folder with an explicit environment", async () => {
    const p = makeProject();
    const db = RunsDb.open(p.stateDir);
    db.setScheduling({ state: "on", via: "serve" });
    db.close();
    const s = await start(["--port", "0"], { root: p.root, env: { PATH: "/usr/bin:/bin", CROFT_SERVE_TOKEN: "tok-from-the-shell-1234" } });
    expect(s.ticks.calls).toHaveLength(1);
    expect(s.ticks.calls[0]).toEqual({ root: p.root, stateDir: p.stateDir, env: { PATH: "/usr/bin:/bin" } });
    s.fire("SIGTERM");
    const r = await s.done;
    expect(r.stdout).toContain("scheduler: on, ticking every minute");
    expect(r.stdout).toContain("token: CROFT_SERVE_TOKEN from the environment");
  });

  test("CROFT_SERVE_TOKEN from the project's .env is the token", async () => {
    const p = makeProject();
    writeFileSync(join(p.root, ".env"), "CROFT_SERVE_TOKEN=from-dotenv-token-5678\n");
    const s = await start(["--port", "0"], { root: p.root });
    expect(JSON.parse(readFileSync(join(p.stateDir, "serve.json"), "utf8")).token).toBe("from-dotenv-token-5678");
    expect(await query("SELECT 1 AS a", [], { url: s.started!.url, token: "from-dotenv-token-5678" })).toEqual([{ a: 1 }]);
    s.fire("SIGINT");
    const r = await s.done;
    expect(r.stdout).toContain("token: CROFT_SERVE_TOKEN from .env");
  });

  test("refuses to start while a live croft serve is recorded, naming it; nothing is opened", async () => {
    const p = makeProject();
    const other = spawnIdle();
    await other.waitFor("up");
    writeFileSync(join(p.stateDir, "serve.json"), JSON.stringify({ url: "http://127.0.0.1:7999", pid: other.pid, bootId: bootId(), token: "x" }));
    const s = await start(["--port", "0"], { root: p.root });
    const r = s.early!;
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("USAGE_ERROR");
    expect(r.stderr).toContain(String(other.pid));
    expect(r.stderr).toContain("http://127.0.0.1:7999");
    expect(s.engine.opened).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(p.stateDir, "serve.json"), "utf8")).pid).toBe(other.pid);
  });

  test("a stale serve.json of a dead process does not block the start", async () => {
    const p = makeProject();
    writeFileSync(join(p.stateDir, "serve.json"), JSON.stringify({ url: "http://127.0.0.1:7999", pid: 999_999, bootId: "old-boot", procStart: "1", token: "x" }));
    const s = await start(["--port", "0"], { root: p.root });
    expect(s.started).not.toBeNull();
    s.fire("SIGINT");
    expect((await s.done).exit).toBe(0);
  });

  test("an engine that cannot open is the command's error, and nothing is left behind", async () => {
    const p = makeProject();
    const s = await start(["--port", "0"], {
      root: p.root,
      deps: { openEngine: async () => { throw new CroftError("SERVE_UNSAFE_FILESYSTEM", { message: "the warehouse is on a 9p mount", hint: "move it" }); } },
    });
    expect(s.early!.exit).toBe(4);
    expect(s.early!.stderr).toContain("SERVE_UNSAFE_FILESYSTEM");
    expect(existsSync(join(p.stateDir, "serve.json"))).toBe(false);
  });

  test("a bad --port is USAGE_ERROR", async () => {
    const p = makeProject();
    for (const port of ["abc", "70000", "-1", "1.5"]) {
      const s = await start(["--port", port], { root: p.root });
      expect(s.early!.exit).toBe(2);
      expect(s.early!.stderr).toContain("--port");
    }
  });

  test("any host but loopback says an HTTPS proxy is required and the token must be set", async () => {
    const p = makeProject();
    let closed = false;
    const fakeListen = (): RunningServer => ({
      url: "http://0.0.0.0:7447", host: "0.0.0.0", port: 7447, loopback: false,
      stop: async () => {
        closed = true;
      },
    });
    const s = await start(["--host", "0.0.0.0", "--port", "7447"], { root: p.root, deps: { listen: fakeListen } });
    s.fire("SIGINT");
    const r = await s.done;
    expect(closed).toBe(true);
    expect(r.stdout.split("\n")[0]).toBe("croft serve · http://0.0.0.0:7447 · database warehouse.duckdb (read-only, steps aside for writes)");
    expect(r.stdout).toContain("not loopback: put an HTTPS reverse proxy or tunnel in front of 0.0.0.0:7447");
    expect(r.stdout).toContain("set CROFT_SERVE_TOKEN in .env");
  });
});

describe("--json", () => {
  test("one envelope with the address at start, then it blocks; a stop exits 0 without a second envelope", async () => {
    const p = makeProject();
    const out: string[] = [];
    const err: string[] = [];
    const render = new Render({ json: true, stdout: (t) => out.push(t), stderr: (t) => err.push(t), stdoutTTY: false, stderrTTY: false, env: {} });
    const ctx = new CliContext({ cwd: p.root, processEnv: {}, render, isTTY: { stdin: false, stdout: false }, commands: COMMANDS, startedAt: performance.now() });
    ctx.command = "serve";
    ctx.values = { port: "0" };
    const engine = fakeEngine();
    const { stop, fire } = stopper();
    let started!: () => void;
    const up = new Promise<void>((r) => (started = r));
    const exits: number[] = [];
    const running = runServe(ctx, {
      openEngine: async () => engine, spawnTick: spawner().spawn, stop, onStarted: () => started(), exit: (c) => void exits.push(c),
    });
    await up;
    expect(out).toHaveLength(1);
    const env = JSON.parse(out[0]!);
    expect(env).toMatchObject({
      schemaVersion: 1, ok: true, command: "serve",
      data: { url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), pid: process.pid, loopback: true, token: { source: "generated", file: ".croft/serve.json" }, scheduling: { state: "off" } },
    });
    expect(JSON.stringify(env)).not.toContain(JSON.parse(readFileSync(join(p.stateDir, "serve.json"), "utf8")).token);
    fire("SIGTERM");
    await running;
    expect(exits).toEqual([0]);
    expect(out).toHaveLength(1);
    expect(existsSync(join(p.stateDir, "serve.json"))).toBe(false);
  });
});

describe("signals, in a real process", () => {
  // A child runs main() with the registered serve command and a fake engine; this process sends the signal.
  const MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));
  const SERVE = fileURLToPath(new URL("./serve.ts", import.meta.url));
  const INDEX = fileURLToPath(new URL("./index.ts", import.meta.url));
  const script = `
    const { main } = await import(${JSON.stringify(MAIN)});
    const { runServe, serve } = await import(${JSON.stringify(SERVE)});
    const { COMMANDS } = await import(${JSON.stringify(INDEX)});
    const { load, ...spec } = COMMANDS.find((c) => c.name === "serve");
    const engine = {
      async query() { return { columns: [], rows: [], rowCount: 0, tookMs: 0 }; },
      status: () => ({ state: "open", writeIntent: null, inFlight: 0, queued: 0, openConnections: 1, queriesToday: 0 }),
      async close() { console.error("engine closed"); },
    };
    const deps = { openEngine: async () => engine, spawnTick: () => ({ pid: 1, alive: () => false }) };
    const cmd = { ...spec, run: (ctx) => runServe(ctx, deps), human: serve.human.bind(serve) };
    process.exitCode = await main(process.argv.slice(1), { commands: [cmd] });`;

  async function runChild(root: string, argv: string[], signal: NodeJS.Signals, ready: (out: string) => boolean) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("CROFT_SERVE")) env[k] = v;
    const child = spawn(process.execPath, ["--no-env-file", "-e", script, ...argv], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const exited = new Promise<number | null>((r) => child.on("close", (code) => r(code))); // after stdout drained
    const end = Date.now() + 15_000;
    while (!ready(out) && Date.now() < end) await Bun.sleep(20);
    if (!ready(out)) {
      child.kill("SIGKILL");
      throw new Error(`the server never came up: ${out}\n${err}`);
    }
    const record = JSON.parse(readFileSync(join(root, ".croft", "serve.json"), "utf8"));
    child.kill(signal);
    return { code: await exited, out, err, record };
  }

  test("SIGTERM: serve.json removed, engine closed, the stop line, exit 0", async () => {
    const p = makeProject();
    const r = await runChild(p.root, ["serve", "--port", "0"], "SIGTERM", (out) => out.includes("^C to stop"));
    expect(r.record.pid).toBeGreaterThan(0);
    expect(r.code).toBe(0);
    expect(existsSync(join(p.stateDir, "serve.json"))).toBe(false);
    expect(r.err).toContain("engine closed");
    expect(r.out).toContain("croft serve stopped (SIGTERM)");
  }, 30_000);

  test("--json: exactly one envelope on stdout, then SIGINT exits 0", async () => {
    const p = makeProject();
    const r = await runChild(p.root, ["serve", "--port", "0", "--json"], "SIGINT", (out) => out.endsWith("\n"));
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: true, command: "serve", data: { url: r.record.url, pid: r.record.pid } });
    expect(existsSync(join(p.stateDir, "serve.json"))).toBe(false);
  }, 30_000);
});

describe("the banner", () => {
  const base: ServeData = {
    url: "http://127.0.0.1:7447", host: "127.0.0.1", port: 7447, pid: 4121, loopback: true, database: "warehouse.duckdb",
    startedAt: "2026-09-24T10:00:00-07:00", version: "0.1.0",
    token: { source: "generated", from: null, file: ".croft/serve.json" },
    scheduling: { state: "on", via: "serve", pausedUntil: null, tickEveryMs: 60_000 }, stopped: null,
  };

  test("DESIGN.md §4.2", () => {
    expect(formatBanner(base, "America/Los_Angeles")).toBe([
      "croft serve · http://127.0.0.1:7447 · database warehouse.duckdb (read-only, steps aside for writes)",
      "token: .croft/serve.json (hosted apps: set CROFT_SERVE_TOKEN)",
      "scheduler: on, ticking every minute",
      'apps: import from "@zabaca/croft/read" in this project, or set CROFT_URL + CROFT_SERVE_TOKEN',
      "^C to stop",
    ].join("\n"));
  });

  test("paused, with and without an end", () => {
    const paused = (at: string) => ({ ...base, scheduling: { ...base.scheduling, state: "paused" as const, pausedUntil: at } });
    const now = new Date("2026-09-24T17:00:00Z");
    expect(formatBanner(paused("2026-09-24T21:00:00.000Z"), "America/Los_Angeles", now)).toContain("scheduler: paused until 14:00 (croft schedule on resumes it now)");
    expect(formatBanner(paused("2026-09-26T21:00:00.000Z"), "America/Los_Angeles", now)).toContain("scheduler: paused until 2026-09-26 14:00 (croft schedule on resumes it now)");
    const open = formatBanner({ ...base, scheduling: { ...base.scheduling, state: "paused", pausedUntil: null } }, "America/Los_Angeles");
    expect(open).toContain("scheduler: paused (croft schedule on resumes it)");
  });

  test("not loopback, with the token already set", () => {
    const text = formatBanner({ ...base, url: "http://[::]:7447", host: "::", loopback: false, token: { source: "CROFT_SERVE_TOKEN", from: ".env", file: ".croft/serve.json" } }, "UTC");
    expect(text).toContain("not loopback: put an HTTPS reverse proxy or tunnel in front of [::]:7447");
    expect(text).toContain("Host: 127.0.0.1:7447");
    expect(text).not.toContain("set CROFT_SERVE_TOKEN in .env");
    expect(text).toContain("token: CROFT_SERVE_TOKEN from .env");
  });
});
