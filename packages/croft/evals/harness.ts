// Agent evals (DESIGN.md §10 "Test strategy" item 9): a headless Claude Code session works on a fixture croft
// project, then a verifier per task decides whether it succeeded and the transcript is scored (score.ts).
//
// A fixture is what a user's project looks like after `croft init` and `bun install`, set up the way the e2e
// journeys set up theirs (tests/e2e/harness.ts), but on its own so that evals/ depends on nothing under tests/:
// - `croft init <dir> --no-install` in a temp folder, then node_modules/@zabaca/croft → this package (and
//   node_modules/.bin/croft, as `bun install` links it);
// - a `croft` shim on PATH that runs this package's bin/croft.mjs, and `bun` next to it;
// - a Bun.serve mock API on 127.0.0.1 (port 0) that the task's ingests read, with its secret in .env;
// - .claude/settings.json: allow croft, bun and the file tools; ask before `croft confirm`; deny reading .env;
// - the task's assets, one `croft run` so the warehouse holds what a user's would, and a git commit of the
//   result, so the agent's changes are a `git diff` afterwards.
//
// The session is `claude -p <prompt> --output-format stream-json ...` (claudeArgs) in the fixture, with an
// explicit environment (agentEnv): the real HOME, so Claude Code finds the user's login, and nothing else of
// the calling environment beyond a short list of auth variables. Nested-session markers such as CLAUDECODE,
// which the harness has when Claude Code runs it, never reach the session.
//
// The harness never runs claude in `bun test`; evals/run.ts does, on request.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseStream, type Score, scoreTranscript, type StreamEvent } from "./score.ts";

/** packages/croft */
export const PKG = resolve(import.meta.dir, "..");
/** The bin a project's `croft` runs. */
export const CROFT_BIN = join(PKG, "bin", "croft.mjs");
/** The zone the fixture's croft init records (croft.json) and every command runs in. */
export const FIXTURE_TZ = "America/Los_Angeles";

export const MAX_TURNS = 60;
export const AGENT_TIMEOUT_MS = 20 * 60_000;

/** The permission rules of every fixture (§9: one `ask` rule gates every destructive action). */
export const FIXTURE_SETTINGS = {
  permissions: {
    allow: ["Bash(croft:*)", "Bash(bun:*)", "Read", "Edit", "Write", "Glob", "Grep"],
    ask: ["Bash(croft confirm:*)"],
    deny: ["Read(./.env*)"],
  },
} as const;

/** Appended to every task prompt: nobody is there to approve anything during the session. */
export const AWAY_NOTE = [
  "I'm away from my computer and can't answer questions until later. Do everything you can without my approval.",
  "Don't run anything that needs my approval: list it at the end of your reply instead, with the exact command and why it needs me.",
].join(" ");

// ---------------------------------------------------------------------------------------------------------
// Tasks and verdicts

export interface VerifyCheck {
  name: string;
  /** warehouse: what the tables hold. code: what the project's SQL computes now (over the raw ingest tables),
   *  built or not. data: ingested data left intact. files: files left as they were. */
  kind: "warehouse" | "code" | "data" | "files";
  ok: boolean;
  detail: string;
}

export interface Verdict {
  pass: boolean;
  checks: VerifyCheck[];
}

export interface EvalTask {
  name: string;
  /** One line for listings. */
  summary: string;
  /** The project folder's name. */
  project: string;
  /** What the user asks (AWAY_NOTE is appended). */
  prompt: string;
  /** Add the task's assets, secrets and mock routes to a fresh project. The harness runs croft afterwards. */
  setup(f: Fixture): void | Promise<void>;
  /** Decide from the project and its warehouse whether the task was done. */
  verify(f: Fixture): Promise<Verdict>;
  /** A scripted solution: what a good agent would do, ending with the croft run it would make (returned). The
   *  self-test checks the verifier against it; evals never call it. */
  solve(f: Fixture): Promise<CliResult>;
  /** The SQL assets the task's transforms build (the self-test tells built from skipped by these). */
  transforms: string[];
}

// ---------------------------------------------------------------------------------------------------------
// Processes

export interface CliResult {
  args: string[];
  code: number | null;
  stdout: string;
  stderr: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json?: Record<string, any>;
}

/** Run a command to completion with an explicit environment (stdin closed: off a TTY, as agents run). */
export async function exec(cmd: string[], o: { cwd: string; env: Record<string, string>; timeoutMs?: number }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { cwd: o.cwd, env: o.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = o.timeoutMs ? setTimeout(() => proc.kill("SIGKILL"), o.timeoutMs) : null;
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (timer) clearTimeout(timer);
  return { code: proc.signalCode ? null : code, stdout, stderr };
}

/** A readable account of a croft result, for errors. */
export function show(r: CliResult): string {
  return `croft ${r.args.join(" ")} → exit ${r.code}\nstdout: ${r.stdout.slice(0, 3000)}\nstderr: ${r.stderr.slice(0, 1500)}`;
}

// ---------------------------------------------------------------------------------------------------------
// The mock API

export interface ApiRequest { method: string; path: string; at: number }
export type Handler = (req: Request, url: URL) => Response | Promise<Response>;

export interface MockApi {
  url: string;
  log: ApiRequest[];
  route(path: string, h: Handler): void;
  stop(): void;
}

export function mockApi(): MockApi {
  const routes = new Map<string, Handler>();
  const log: ApiRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      log.push({ method: req.method, path: url.pathname, at: Date.now() });
      const h = routes.get(url.pathname);
      return h ? h(req, url) : new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    log,
    route: (path, h) => void routes.set(path, h),
    stop: () => void server.stop(true),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Environments

/** Auth and network settings a session may need, passed through when set; nothing else of the caller's. */
export const PASS_THROUGH_ENV = [
  "USER", "LOGNAME", "LANG",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "AWS_PROFILE", "AWS_REGION", "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION",
  "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy",
  // A TLS-inspecting proxy's CA: without it the session cannot reach the API through the proxy.
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
] as const;

type ParentEnv = Record<string, string | undefined>;

/** The environment of the croft commands the harness runs itself (setup, verify, the scripted solutions). */
export function croftEnv(binDir: string, parent: ParentEnv = process.env): Record<string, string> {
  return {
    HOME: parent.HOME ?? "/tmp",
    TMPDIR: parent.TMPDIR ?? "/tmp",
    SHELL: parent.SHELL ?? "/bin/sh",
    PATH: [binDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    TZ: FIXTURE_TZ,
    NO_COLOR: "1",
    // The test tripwires (tests/preload.ts): nothing an eval runs installs OS jobs or shows notifications.
    CROFT_FORBID_OS_JOBS: "1",
    CROFT_NOTIFY_DRY: "1",
  };
}

/** Nested-session markers and croft's own settings: never inherited by a session. */
const NEVER_INHERIT = /^(CLAUDECODE|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|EXECPATH|MESSAGING_.*)|CLAUDE_PID|CMUX_.*|CROFT_.*)$/;

/**
 * The session's environment: croftEnv plus the pass-through list. Real HOME: Claude Code's login lives there.
 * CROFT_EVAL_INHERIT_ENV=1 starts from the whole calling environment instead (minus nested-session markers and
 * CROFT_* settings), for machines whose Claude Code authenticates through something the list does not name,
 * such as a sandbox proxy.
 */
export function agentEnv(binDir: string, parent: ParentEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  if (parent.CROFT_EVAL_INHERIT_ENV === "1") {
    for (const [k, v] of Object.entries(parent)) if (v !== undefined && !NEVER_INHERIT.test(k)) env[k] = v;
  }
  Object.assign(env, croftEnv(binDir, parent));
  for (const k of PASS_THROUGH_ENV) {
    const v = parent[k];
    if (v !== undefined && v !== "") env[k] = v;
  }
  return env;
}

/**
 * The claude executable a session runs: CROFT_EVAL_CLAUDE when set, else the first `claude` on PATH that is not
 * a shell-script wrapper. Terminal apps (cmux, for one) put a bash shim named claude first on PATH that looks
 * `claude` up again, and the session's PATH (agentEnv) is too short for it to find the real one.
 */
export function findClaude(env: ParentEnv = process.env): string | null {
  if (env.CROFT_EVAL_CLAUDE) return env.CROFT_EVAL_CLAUDE;
  let first: string | null = null;
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const p = join(dir, "claude");
    if (!existsSync(p)) continue;
    first ??= p;
    let head = "";
    try { head = readFileSync(p).subarray(0, 64).toString("latin1"); } catch { continue; }
    if (!/^#!.*\b(ba|z)?sh\b/.test(head.split("\n")[0] ?? "")) return p;
  }
  return first;
}

/**
 * CROFT_EVAL_USER_SETTINGS=1: load the user's settings too (--setting-sources user,project), for machines whose
 * Claude Code login lives in settings `env` (a sandbox proxy's token, say). The fixture then turns off every
 * plugin the user enabled, so the session sees croft's files and nothing of the user's setup.
 */
export function userSettingsMode(env: ParentEnv = process.env): boolean {
  return env.CROFT_EVAL_USER_SETTINGS === "1";
}

/** The fixture's .claude/settings.json: FIXTURE_SETTINGS, plus the user's plugins turned off in user-settings mode. */
export function fixtureSettings(env: ParentEnv = process.env): Record<string, unknown> {
  if (!userSettingsMode(env)) return FIXTURE_SETTINGS;
  let plugins: string[] = [];
  try {
    const user = JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? "", ".claude"), "settings.json"), "utf8")) as { enabledPlugins?: Record<string, unknown> };
    plugins = Object.keys(user.enabledPlugins ?? {});
  } catch { /* no user settings: nothing to turn off */ }
  return { ...FIXTURE_SETTINGS, enabledPlugins: Object.fromEntries(plugins.map((p) => [p, false])) };
}

export interface AgentOptions {
  /** The claude executable (default: `claude` found on the caller's PATH). */
  claudeBin?: string;
  model?: string;
  maxTurns?: number;
  timeoutMs?: number;
  /** Where the raw stream-json goes as it arrives (kept even when the session is killed). */
  transcriptPath?: string;
  /** Called with every parsed event, for progress output. */
  onEvent?: (e: StreamEvent) => void;
  /** The caller's environment (tests pass their own). */
  parentEnv?: ParentEnv;
}

/**
 * The claude arguments. Checked against `claude --help` (2.1.x): `--max-turns` is accepted but not listed there.
 * The prompt comes right after -p, because --mcp-config takes several values and would swallow a prompt after it.
 * `--permission-prompts none` denies whatever would ask (a headless session has nobody to ask), which is what the
 * fixture's `ask` rule on `croft confirm` relies on; `--no-session-persistence` keeps temp projects out of the
 * user's session list.
 */
export function claudeArgs(prompt: string, o: { model?: string; maxTurns?: number; userSettings?: boolean } = {}): string[] {
  return [
    "-p", prompt,
    "--output-format", "stream-json", "--verbose",
    "--max-turns", String(o.maxTurns ?? MAX_TURNS),
    "--setting-sources", o.userSettings ? "user,project" : "project",
    // Claude Code ignores a project's allow rules until someone accepts the folder's trust dialog, which never
    // happens in a fresh temp folder: the rules go on the command line too. Nothing else is allowed, so with
    // --permission-prompts none `croft confirm` (the fixture's one `ask` rule) is denied, as the file intends.
    "--allowedTools", FIXTURE_SETTINGS.permissions.allow.join(","),
    "--disallowedTools", FIXTURE_SETTINGS.permissions.deny.join(","),
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--permission-prompts", "none",
    "--no-session-persistence",
    ...(o.model ? ["--model", o.model] : []),
  ];
}

export interface AgentRun {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  wallMs: number;
  events: StreamEvent[];
  stderr: string;
}

// ---------------------------------------------------------------------------------------------------------
// Fixtures

export class Fixture {
  /** Files under assets/ as they were when the agent started (for "left untouched" checks). */
  readonly originals = new Map<string, string>();
  /** The `croft run --json` that built the starting warehouse. */
  setupRun: CliResult | null = null;
  /** The git baseline, when git is installed. */
  git = false;

  constructor(
    readonly task: string,
    /** The temp folder: the project, the shims. */
    readonly base: string,
    /** The project root. */
    readonly root: string,
    /** Holds the croft and bun shims. */
    readonly binDir: string,
    readonly api: MockApi,
  ) {}

  /** The environment of croft commands the harness runs. */
  get env(): Record<string, string> {
    return croftEnv(this.binDir);
  }

  async croft(args: string[], o: { timeoutMs?: number } = {}): Promise<CliResult> {
    const r = await exec([process.execPath, CROFT_BIN, ...args], { cwd: this.root, env: this.env, timeoutMs: o.timeoutMs ?? 300_000 });
    let json: CliResult["json"];
    if (args.includes("--json") && r.stdout.trim()) {
      try {
        json = JSON.parse(r.stdout) as CliResult["json"];
      } catch { /* show() reports stdout */ }
    }
    return { args, ...r, ...(json ? { json } : {}) };
  }

  /**
   * `croft query <sql>` over the warehouse: the columns and every row. Throws the problem (`CODE: message`) when
   * croft refuses or fails, and when rows were cut off.
   */
  async query(sql: string): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
    const r = await this.croft(["query", sql, "--limit", "100000", "--json"]);
    const env = r.json;
    if (!env || r.code !== 0 || env.ok !== true) {
      const p = env?.problems?.[0];
      throw new Error(p ? `${p.code}: ${p.message}` : `croft query failed (exit ${r.code}): ${r.stderr.slice(0, 500) || r.stdout.slice(0, 500)}`);
    }
    const data = env.data as { columns: { name: string }[]; rows: Record<string, unknown>[]; truncatedRows?: number };
    if (data.truncatedRows) throw new Error(`croft query cut off ${data.truncatedRows} rows`);
    return { columns: data.columns.map((c) => c.name), rows: data.rows };
  }

  path(rel: string): string {
    return join(this.root, rel);
  }

  write(rel: string, text: string): void {
    const p = this.path(rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }

  read(rel: string): string {
    return readFileSync(this.path(rel), "utf8");
  }

  exists(rel: string): boolean {
    return existsSync(this.path(rel));
  }

  /** Append NAME=value to .env, as a user would. */
  secret(name: string, value: string): void {
    const p = this.path(".env");
    const before = existsSync(p) ? readFileSync(p, "utf8") : "";
    writeFileSync(p, `${before}${before === "" || before.endsWith("\n") ? "" : "\n"}${name}=${value}\n`, { mode: 0o600 });
  }

  /** Files under assets/ and lib/, root-relative. */
  projectFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) out.push(relative(this.root, p));
      }
    };
    walk(this.path("assets"));
    walk(this.path("lib"));
    return out.sort();
  }

  /** The agent's changes against the baseline commit (tracked and new files), or null without git. */
  async diff(): Promise<string | null> {
    if (!this.git) return null;
    await git(this, ["add", "-A"]);
    const r = await git(this, ["diff", "--cached", "--no-color", "--no-ext-diff"]);
    return r.code === 0 ? r.stdout : null;
  }

  /** Wait until no croft run is in progress (a run detached from the session may still be writing). */
  async settle(timeoutMs = 300_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.croft(["status", "--json"]);
      const running = r.json?.data?.running;
      if (!Array.isArray(running) || running.length === 0 || Date.now() > end) return;
      await Bun.sleep(2000);
    }
  }

  /** Stop the mock API and delete the temp folder (unless kept). */
  close(o: { keep?: boolean } = {}): void {
    this.api.stop();
    if (!o.keep) rmSync(this.base, { recursive: true, force: true });
  }
}

function git(f: Fixture, args: string[]) {
  return exec(["git", "-c", "user.name=croft evals", "-c", "user.email=evals@croft.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd: f.root, env: { ...f.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
}

/** The `croft` and `bun` a session finds on PATH: this package's bin, run by the bun running the harness. */
export function writeShims(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  const croft = join(binDir, "croft");
  const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  writeFileSync(croft, `#!/bin/sh\n# croft evals: this checkout's croft\nexec ${q(process.execPath)} ${q(CROFT_BIN)} "$@"\n`);
  chmodSync(croft, 0o755);
  const bun = join(binDir, "bun");
  if (!existsSync(bun)) symlinkSync(process.execPath, bun);
}

/** The files croft init writes that no task uses: the example asset and its CSV. */
const INIT_EXAMPLE = ["assets/example_sales.ts", "files/example_sales.csv"];

/**
 * A fresh fixture for a task: init, link, shims, settings, mock API, the task's setup, one `croft run`, and a git
 * baseline. Throws when any of it fails; the temp folder is removed then (unless kept).
 */
export async function setupFixture(task: EvalTask, o: { keep?: boolean; tmpRoot?: string } = {}): Promise<Fixture> {
  const base = realpathSync(mkdtempSync(join(o.tmpRoot ?? tmpdir(), `croft-eval-${task.name}-`)));
  const binDir = join(base, "bin");
  const root = join(base, task.project);
  const f = new Fixture(task.name, base, root, binDir, mockApi());
  try {
    writeShims(binDir);
    const init = await exec([process.execPath, CROFT_BIN, "init", root, "--no-install", "--json"], { cwd: base, env: f.env, timeoutMs: 120_000 });
    if (init.code !== 0) throw new Error(`croft init failed (exit ${init.code})\n${init.stdout}\n${init.stderr}`);
    mkdirSync(join(root, "node_modules", "@zabaca"), { recursive: true });
    symlinkSync(PKG, join(root, "node_modules", "@zabaca", "croft"));
    // As `bun install` links it: `bunx croft` and ./node_modules/.bin/croft find this copy instead of fetching
    // whatever npm has under the name.
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    symlinkSync(join("..", "@zabaca", "croft", "bin", "croft.mjs"), join(root, "node_modules", ".bin", "croft"));
    for (const rel of INIT_EXAMPLE) rmSync(f.path(rel), { force: true });
    f.write(".claude/settings.json", `${JSON.stringify(fixtureSettings(), null, 2)}\n`);
    await task.setup(f);
    const run = await f.croft(["run", "--json"]);
    f.setupRun = run;
    const failed = (run.json?.data?.steps ?? []).filter((s: { status: string }) => s.status === "failed");
    if (run.code !== 0 || failed.length > 0) throw new Error(`the fixture's first croft run failed\n${show(run)}`);
    for (const rel of f.projectFiles()) f.originals.set(rel, f.read(rel));
    if (Bun.which("git", { PATH: f.env.PATH })) {
      const steps = [["init", "-q"], ["add", "-A"], ["commit", "-q", "-m", `fixture: ${task.name}`]];
      f.git = true;
      for (const args of steps) {
        const r = await git(f, args);
        if (r.code !== 0) {
          f.git = false;
          break;
        }
      }
    }
    return f;
  } catch (e) {
    f.close({ keep: o.keep });
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Sessions

/** The prompt a session gets. */
export function taskPrompt(task: EvalTask): string {
  return `${task.prompt}\n\n${AWAY_NOTE}`;
}

/** Run one headless session in the fixture. Never throws for what the session does; throws if claude is missing. */
export async function runAgent(f: Fixture, prompt: string, o: AgentOptions = {}): Promise<AgentRun> {
  const bin = o.claudeBin ?? findClaude();
  if (!bin) throw new Error("claude is not on PATH: install Claude Code, or pass the executable's path");
  const started = performance.now();
  const proc = Bun.spawn([bin, ...claudeArgs(prompt, { ...o, userSettings: userSettingsMode(o.parentEnv) })], {
    cwd: f.root, env: agentEnv(f.binDir, o.parentEnv), stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
    killTimer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
  }, o.timeoutMs ?? AGENT_TIMEOUT_MS);
  const transcript = o.transcriptPath ? openTranscript(o.transcriptPath) : null;
  const stderrText = new Response(proc.stderr).text();
  let text = "";
  let pending = "";
  const decoder = new TextDecoder();
  for await (const chunk of proc.stdout) {
    const s = decoder.decode(chunk, { stream: true });
    text += s;
    transcript?.write(s);
    pending += s;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    if (o.onEvent) for (const e of parseStream(lines.join("\n"))) o.onEvent(e);
  }
  const code = await proc.exited;
  clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  await new Promise<void>((done) => (transcript ? transcript.end(done) : done()));
  return {
    exitCode: proc.signalCode ? null : code,
    signal: proc.signalCode ?? null,
    timedOut,
    wallMs: Math.round(performance.now() - started),
    events: parseStream(text),
    stderr: await stderrText,
  };
}

function openTranscript(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  return createWriteStream(path);
}

export interface TaskResult {
  task: string;
  pass: boolean;
  verdict: Verdict | null;
  score: Score | null;
  agent: { exitCode: number | null; signal: string | null; timedOut: boolean; wallMs: number; stderrTail: string } | null;
  /** Requests the session's runs made to the mock API (the setup run's excluded). */
  apiRequests: number;
  diff: string | null;
  transcript: string | null;
  /** Kept fixture folder (--keep). */
  fixture: string | null;
  /** The harness failed (setup, a missing claude); the task was not attempted. */
  error: string | null;
}

/** Set up, run the session, settle, verify, score. The fixture is removed afterwards unless kept. */
export async function runTask(task: EvalTask, o: AgentOptions & { keep?: boolean; tmpRoot?: string } = {}): Promise<TaskResult> {
  const empty: TaskResult = { task: task.name, pass: false, verdict: null, score: null, agent: null, apiRequests: 0, diff: null, transcript: null, fixture: null, error: null };
  // Before the fixture: a missing claude is a harness error, found without setting anything up.
  const bin = o.claudeBin ?? findClaude();
  if (!bin || !existsSync(bin)) return { ...empty, error: `claude not found: ${bin ?? "no claude on PATH"}` };
  o = { ...o, claudeBin: bin };
  let f: Fixture;
  try {
    f = await setupFixture(task, o);
  } catch (e) {
    return { ...empty, error: `fixture setup failed: ${(e as Error).message}` };
  }
  try {
    const before = f.api.log.length;
    const run = await runAgent(f, taskPrompt(task), o);
    await f.settle();
    const verdict = await task.verify(f);
    return {
      ...empty,
      pass: verdict.pass,
      verdict,
      score: scoreTranscript(run.events),
      agent: { exitCode: run.exitCode, signal: run.signal, timedOut: run.timedOut, wallMs: run.wallMs, stderrTail: run.stderr.slice(-2000) },
      apiRequests: f.api.log.length - before,
      diff: await f.diff(),
      transcript: o.transcriptPath ?? null,
      fixture: o.keep ? f.root : null,
    };
  } catch (e) {
    return { ...empty, error: (e as Error).message, fixture: o.keep ? f.root : null };
  } finally {
    f.close({ keep: o.keep });
  }
}
