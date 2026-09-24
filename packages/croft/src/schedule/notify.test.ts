// Failure notifications of scheduled runs. Nothing here shows a real notification: desktop notifications go
// through a fake OsRunner (or CROFT_NOTIFY_DRY records them), and webhooks go to mock servers on port 0.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { problem } from "../core/errors.ts";
import type { Problem, StepResult } from "../core/types.ts";
import { RunsDb } from "../history/runs-db.ts";
import { ProjectEnv } from "../project/env.ts";
import type { RunSummary } from "../run/runner.ts";
import {
  appleScriptString, desktopCommand, desktopMessage, type NotifyOptions, notifyScheduledFailure, notificationsPath, notifyLogPath,
  type ScheduledFailure, sendWebhook, WEBHOOK_ATTEMPTS,
} from "./notify.ts";
import type { ExecOptions, ExecResult, OsRunner } from "./os.ts";

let root: string;
let stateDir: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "croft-notify-")));
  stateDir = join(root, ".croft");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const SECRET = "sk_live_9f8e7d6c5b4a3210";

function project(notify: Record<string, unknown> = {}, dotenv = `API_TOKEN=${SECRET}\n`): void {
  writeFileSync(join(root, "croft.json"), JSON.stringify({ timezone: "UTC", notify }));
  writeFileSync(join(root, ".env"), dotenv);
}

function httpError(message: string, asset = "github_issues"): Problem {
  return problem("HTTP_ERROR", { message, hint: "check the API", asset });
}

function failure(o: Partial<ScheduledFailure> = {}): ScheduledFailure {
  return {
    project: "weather", runId: "r_0924_0900_ab12",
    failed: [{ asset: "github_issues", error: httpError(`GET https://api.github.com/issues?token=${SECRET} answered 500`) }],
    ...o,
  };
}

interface Call { argv: string[]; o: ExecOptions }
function fakeRunner(respond: (argv: string[]) => Partial<ExecResult> | undefined = () => undefined) {
  const calls: Call[] = [];
  const runner: OsRunner = {
    exec(argv, o = {}) {
      calls.push({ argv: [...argv], o });
      return { status: 0, stdout: "", stderr: "", ...respond([...argv]) };
    },
  };
  return { runner, calls };
}

const DRY = { CROFT_NOTIFY_DRY: "1", PATH: "/usr/bin:/bin", HOME: "/Users/ada" };
const LIVE = { PATH: "/usr/bin:/bin", HOME: "/Users/ada" };

function records(): Record<string, unknown>[] {
  const file = notificationsPath(stateDir);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}
function notifyLog(): string {
  const file = notifyLogPath(stateDir);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/** Everything notify left on disk under the state folder, for "never leaks" assertions. */
function everythingWritten(): string {
  return (existsSync(notificationsPath(stateDir)) ? readFileSync(notificationsPath(stateDir), "utf8") : "") + notifyLog();
}

// ---------------------------------------------------------------------------------------------------------
// A test-only reader for the AppleScript that osascript receives: a string literal knows only \" and \\ (and
// \n \r \t, which croft never writes); anything else after a backslash is a syntax error.

function readLiteral(src: string, at: number): { value: string; end: number } {
  if (src[at] !== '"') throw new Error(`expected a string literal at ${at}: ${src.slice(at, at + 20)}`);
  let value = "";
  for (let i = at + 1; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") {
      const n = src[i + 1];
      if (n !== '"' && n !== "\\") throw new Error(`AppleScript syntax error: \\${n}`);
      value += n;
      i++;
      continue;
    }
    if (c === '"') return { value, end: i + 1 };
    if (c === "\n" || c === "\r") throw new Error("a raw line break inside a literal");
    value += c;
  }
  throw new Error("unterminated literal");
}

/** Parse exactly `display notification "<body>" with title "<title>"`; throws on anything else. */
function parseDisplay(script: string): { body: string; title: string } {
  const head = "display notification ";
  if (!script.startsWith(head)) throw new Error(`unexpected script: ${script}`);
  const body = readLiteral(script, head.length);
  const mid = " with title ";
  if (script.slice(body.end, body.end + mid.length) !== mid) throw new Error(`unexpected script after body: ${script.slice(body.end)}`);
  const title = readLiteral(script, body.end + mid.length);
  if (title.end !== script.length) throw new Error(`trailing text: ${script.slice(title.end)}`);
  return { body: body.value, title: title.value };
}

describe("appleScriptString", () => {
  test("quotes and backslashes are escaped, and the literal reads back as the text", () => {
    expect(appleScriptString(`a"b\\c`)).toBe(`"a\\"b\\\\c"`);
    for (const s of [`plain`, `"`, `\\`, `\\"`, `ends with \\`, `"; do shell script "touch /tmp/pwned"; "`, `\\" & (do shell script "id") & "`]) {
      const lit = appleScriptString(s);
      const r = readLiteral(lit, 0);
      expect(r.end).toBe(lit.length);
      expect(r.value).toBe(s);
    }
  });

  test("line breaks, tabs and other control characters become spaces", () => {
    const lit = appleScriptString("one\ntwo\r\nthree\tfour\u0000five\u2028six\u007f");
    expect(lit).not.toMatch(/[\u0000-\u001f\u007f\u2028\u2029]/);
    expect(readLiteral(lit, 0).value).toBe("one two three four five six ");
  });

  test("non-ASCII text is kept", () => {
    expect(readLiteral(appleScriptString("café … 東京"), 0).value).toBe("café … 東京");
  });
});

describe("desktopCommand", () => {
  test("macOS: osascript with one display notification statement; injection stays inside the literals", () => {
    const title = `croft: we"ird\\`;
    const body = `x" with title "pwn" & (do shell script "id") & "\nsecond line`;
    const argv = desktopCommand("darwin", title, body)!;
    expect(argv.slice(0, 2)).toEqual(["/usr/bin/osascript", "-e"]);
    expect(argv).toHaveLength(3);
    const parsed = parseDisplay(argv[2]!);
    expect(parsed.title).toBe(title);
    expect(parsed.body).toBe(body.replace("\n", " "));
  });

  test("Linux: notify-send with the app name (-a), options ended, and the body's markup escaped", () => {
    const argv = desktopCommand("linux", "-croft: x", "a <b> & c")!;
    expect(argv).toEqual(["notify-send", "-a", "croft", "--", "-croft: x", "a &lt;b&gt; &amp; c"]);
  });

  test("other platforms have none", () => {
    expect(desktopCommand("win32", "t", "b")).toBeNull();
  });
});

describe("desktopMessage", () => {
  const plain = (t: string) => t;

  test("one asset: project, asset, the error's code and message, and the command to see it", () => {
    const m = desktopMessage("weather", failure().failed, { text: plain, data: plain }, "r_1");
    expect(m.title).toBe("croft: weather");
    expect(m.body).toBe(
      `github_issues failed in a scheduled run: HTTP_ERROR: GET https://api.github.com/issues?token=${SECRET} answered 500. `
      + "See it with: croft logs github_issues --failed");
  });

  test("several assets are listed, then counted; the command names the one whose error is shown", () => {
    const failed = [
      { asset: "a_crash", error: null },
      { asset: "b_http", error: httpError("503 from the API.", "b_http") },
      { asset: "c", error: null },
      { asset: "d", error: null },
    ];
    const m = desktopMessage("proj", failed, { text: plain, data: plain }, "r_1");
    expect(m.body).toBe("a_crash, b_http and 2 more failed in a scheduled run: HTTP_ERROR: 503 from the API. See it with: croft logs b_http --failed");
    const two = desktopMessage("proj", failed.slice(0, 2), { text: plain, data: plain }, "r_1");
    expect(two.body).toStartWith("a_crash and b_http failed in a scheduled run");
  });

  test("no error (a crash): the asset and the command only", () => {
    const m = desktopMessage("proj", [{ asset: "x", error: null }], { text: plain, data: plain }, "r_1");
    expect(m.body).toBe("x failed in a scheduled run. See it with: croft logs x --failed");
  });

  test("nothing listed: the run and its logs", () => {
    const m = desktopMessage("proj", [], { text: plain, data: plain }, "r_0924_0900_ab12");
    expect(m.body).toBe("A scheduled run failed. See it with: croft logs r_0924_0900_ab12");
  });

  test("a long, multi-line message is collapsed and cut, after redaction (no secret prefix survives the cut)", () => {
    const env = new ProjectEnv({ root, fileValues: new Map([["API_TOKEN", SECRET]]) });
    // The secret straddles the cut: cutting first would leave a prefix that no longer matches the pattern.
    const message = `${"x".repeat(150)}\n\n  ${SECRET} and more text ${"y".repeat(300)}`;
    const m = desktopMessage("proj", [{ asset: "a", error: httpError(message, "a") }],
      { text: (t) => env.redact(t), data: (t) => env.redactData(t) }, "r_1");
    expect(m.body).not.toContain(SECRET.slice(0, 8));
    expect(m.body).not.toContain("\n");
    expect(m.body).toContain("…");
    expect(m.body.length).toBeLessThan(320);
    expect(m.body).toEndWith("See it with: croft logs a --failed");
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("desktop notifications", () => {
  test("CROFT_NOTIFY_DRY records the notification instead of showing it", async () => {
    project();
    const { runner, calls } = fakeRunner();
    await notifyScheduledFailure(root, failure(), { runner, processEnv: DRY, platform: "darwin" });
    expect(calls).toEqual([]);
    const r = records();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: "desktop", runId: "r_0924_0900_ab12", title: "croft: weather", status: "dry", via: "osascript" });
    expect(String(r[0]!.body)).toContain("github_issues failed in a scheduled run: HTTP_ERROR");
    expect(String(r[0]!.body)).toContain("croft logs github_issues --failed");
  });

  test("the secret in the error message is not in the notification", async () => {
    project();
    await notifyScheduledFailure(root, failure(), { processEnv: DRY, platform: "darwin" });
    const body = String(records()[0]!.body);
    expect(body).not.toContain(SECRET);
    expect(body).toContain("[redacted:API_TOKEN]");
    expect(everythingWritten()).not.toContain(SECRET);
  });

  test("the preload's CROFT_NOTIFY_DRY is honored with no options at all", async () => {
    project();
    expect(process.env.CROFT_NOTIFY_DRY).toBe("1");
    await notifyScheduledFailure(root, failure());
    expect(records().map((r) => r.kind)).toEqual(["desktop"]);
  });

  test('"desktop": false disables it', async () => {
    project({ desktop: false });
    const { runner, calls } = fakeRunner();
    await notifyScheduledFailure(root, failure(), { runner, processEnv: LIVE, platform: "darwin" });
    await notifyScheduledFailure(root, failure(), { runner, processEnv: DRY, platform: "darwin" });
    expect(calls).toEqual([]);
    expect(records()).toEqual([]);
    expect(notifyLog()).toBe("");
  });

  test("macOS: runs osascript through the runner with an explicit environment", async () => {
    project();
    const { runner, calls } = fakeRunner();
    await notifyScheduledFailure(root, failure(), { runner, processEnv: LIVE, platform: "darwin" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv[0]).toBe("/usr/bin/osascript");
    const shown = parseDisplay(calls[0]!.argv[2]!);
    expect(shown.title).toBe("croft: weather");
    expect(shown.body).not.toContain(SECRET);
    expect(shown.body).toContain("croft logs github_issues --failed");
    expect(calls[0]!.o.env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/Users/ada", LANG: "en_US.UTF-8" });
    expect(calls[0]!.o.timeoutMs).toBeGreaterThan(0);
    expect(records()).toEqual([]);
    expect(notifyLog()).toBe("");
  });

  test("Linux: notify-send gets the desktop session's variables", async () => {
    project();
    const { runner, calls } = fakeRunner();
    const env = { ...LIVE, DISPLAY: ":0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", XDG_RUNTIME_DIR: "/run/user/1000", SECRET_THING: "x" };
    await notifyScheduledFailure(root, failure(), { runner, processEnv: env, platform: "linux" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv.slice(0, 5)).toEqual(["notify-send", "-a", "croft", "--", "croft: weather"]);
    expect(calls[0]!.o.env).toEqual({
      PATH: "/usr/bin:/bin", HOME: "/Users/ada", LANG: "C.UTF-8", DISPLAY: ":0",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", XDG_RUNTIME_DIR: "/run/user/1000",
    });
  });

  test("Linux without notify-send: the failure is logged, nothing throws", async () => {
    project();
    const { runner } = fakeRunner(() => ({ status: null, stderr: "Error: spawnSync notify-send ENOENT" }));
    await notifyScheduledFailure(root, failure(), { runner, processEnv: LIVE, platform: "linux" });
    expect(notifyLog()).toContain("r_0924_0900_ab12 desktop: notify-send is not installed");
  });

  test("osascript failing is logged with its exit status and first stderr line", async () => {
    project();
    const { runner } = fakeRunner(() => ({ status: 1, stderr: "execution error: boom (-1)\nmore\n" }));
    await notifyScheduledFailure(root, failure(), { runner, processEnv: LIVE, platform: "darwin" });
    expect(notifyLog()).toContain("desktop: osascript exited 1: execution error: boom (-1)");
  });

  test("a runner that throws (the FORBID tripwire) is logged, never thrown", async () => {
    project();
    // No runner: the real one, which refuses under the preload's CROFT_FORBID_OS_JOBS even though processEnv
    // says nothing about it.
    await notifyScheduledFailure(root, failure(), { processEnv: LIVE, platform: "darwin" });
    expect(notifyLog()).toContain("CROFT_FORBID_OS_JOBS=1");
  });

  test("an unsupported platform is logged", async () => {
    project();
    const { runner, calls } = fakeRunner();
    await notifyScheduledFailure(root, failure(), { runner, processEnv: LIVE, platform: "win32" });
    expect(calls).toEqual([]);
    expect(notifyLog()).toContain("desktop notifications are not supported on win32");
  });

  test("a secret declared by an asset and set only in the shell is redacted too", async () => {
    project({}, "");
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "assets", "github_issues.ts"), `export default ingest({ secrets: ["GH_TOKEN"], rows() {} });\n`);
    const shellSecret = "ghp_shellOnlyValue123456";
    const f = failure({ failed: [{ asset: "github_issues", error: httpError(`bad token ${shellSecret}`) }] });
    await notifyScheduledFailure(root, f, { processEnv: { ...DRY, GH_TOKEN: shellSecret }, platform: "darwin" });
    expect(String(records()[0]!.body)).toContain("[redacted:GH_TOKEN]");
    expect(everythingWritten()).not.toContain(shellSecret);
  });

  test("the run's own ProjectEnv is used when given", async () => {
    project({}, "");
    const env = new ProjectEnv({ root, fileValues: new Map([["OTHER", "zzz_run_env_secret"]]) });
    const f = failure({ failed: [{ asset: "a", error: httpError("value zzz_run_env_secret leaked", "a") }] });
    await notifyScheduledFailure(root, f, { env, processEnv: DRY, platform: "darwin" });
    expect(String(records()[0]!.body)).toContain("[redacted:OTHER]");
  });
});

// ---------------------------------------------------------------------------------------------------------

interface Hit { method: string; path: string; headers: Record<string, string>; body: string }

/** A mock webhook on port 0 that answers each request with the next of `replies` (the last one repeats). */
function mockHook(replies: (Response | "hang")[]) {
  const hits: Hit[] = [];
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k] = v));
      hits.push({ method: req.method, path: u.pathname + u.search, headers, body: await req.text() });
      const r = replies[Math.min(hits.length - 1, replies.length - 1)]!;
      if (r === "hang") return new Promise<Response>(() => {});
      return r.clone();
    },
  });
  servers.push(server);
  return { hits, url: (path = "/hook") => `http://127.0.0.1:${server.port}${path}`, port: server.port };
}
const servers: ReturnType<typeof Bun.serve>[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

const ok = () => new Response("ok", { status: 200 });
const status = (n: number, headers: Record<string, string> = {}) => new Response(`status ${n}`, { status: n, headers });

function recordingSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

describe("webhook", () => {
  test("POSTs the redacted failure envelope as JSON; the secret never leaves", async () => {
    const hook = mockHook([ok()]);
    project({ desktop: false, webhook: hook.url("/services/T0/B0/xyzSECRETPATH") });
    await notifyScheduledFailure(root, failure(), { processEnv: DRY });
    expect(hook.hits).toHaveLength(1);
    const hit = hook.hits[0]!;
    expect(hit.method).toBe("POST");
    expect(hit.path).toBe("/services/T0/B0/xyzSECRETPATH");
    expect(hit.headers["content-type"]).toBe("application/json");
    expect(hit.body).not.toContain(SECRET);
    const payload = JSON.parse(hit.body) as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(["project", "text", "data", "problems", "next", "exit", "ok"]);
    expect(payload.project).toBe("weather");
    expect(payload.ok).toBe(false);
    expect(payload.exit).toBe(1);
    expect(payload.data).toEqual({ runId: "r_0924_0900_ab12", status: "failed", steps: [] });
    const problems = payload.problems as Problem[];
    expect(problems[0]!.code).toBe("HTTP_ERROR");
    expect(problems[0]!.message).toContain("[redacted:API_TOKEN]");
    expect(String(payload.text)).toContain("github_issues failed in a scheduled run");
    expect(payload.next).toEqual([{ command: "croft logs github_issues --failed", reason: "see what failed" }]);
    // DRY: recorded, with the host only.
    const r = records();
    expect(r).toEqual([expect.objectContaining({ kind: "webhook", host: `127.0.0.1:${hook.port}`, status: "sent", httpStatus: 200, attempts: 1 })]);
    expect(everythingWritten()).not.toContain("SECRETPATH");
  });

  test("sends the run's stored summary, with project, and re-redacts it", async () => {
    const hook = mockHook([ok()]);
    project({ desktop: false, webhook: hook.url() });
    const step = {
      asset: "github_issues", status: "failed", reason: "scheduled", behavior: "merge", attempt: 3, maxAttempts: 3,
      rows: { in: 0, added: 0, updated: 0, unchanged: 0, deleted: 0, total: 10 }, schemaChanges: [], checks: [],
      logsCommand: "croft logs github_issues", durationMs: 5, error: httpError(`token ${SECRET}`),
    } satisfies StepResult;
    const summary: RunSummary = {
      data: { runId: "r_0924_0900_ab12", status: "failed", steps: [step], progress: { rows: 0 } as never },
      problems: [httpError(`token ${SECRET}`)], next: [{ command: "croft logs github_issues", reason: "r" }],
      confirmation: { token: "c_secret_token", expiresAt: "x", command: "croft confirm c_secret_token", impact: { asset: "a", action: "b", rows: 1, downstream: [] } },
      exit: 1, ok: false,
    };
    await notifyScheduledFailure(root, failure({ summary }), { processEnv: DRY });
    const payload = JSON.parse(hook.hits[0]!.body) as { data: { steps: StepResult[] }; project: string; problems: Problem[] };
    expect(Object.keys(payload.data)).toEqual(["runId", "status", "steps"]);
    expect(payload.data.steps[0]!.asset).toBe("github_issues");
    expect(payload.data.steps[0]!.error!.message).toBe("token [redacted:API_TOKEN]");
    expect(payload.problems[0]!.message).toBe("token [redacted:API_TOKEN]");
    expect(hook.hits[0]!.body).not.toContain(SECRET);
    expect(hook.hits[0]!.body).not.toContain("c_secret_token");
  });

  test("without a summary it reads the one runs.sqlite stored for the run", async () => {
    const hook = mockHook([ok()]);
    project({ desktop: false, webhook: hook.url() });
    mkdirSync(stateDir, { recursive: true });
    const db = RunsDb.open(stateDir);
    const run = db.createRun({ trigger: "schedule", human: false, argv: ["run", "--due"], timeZone: "UTC" });
    const stored = { data: { runId: run.id, status: "failed", steps: [] }, problems: [httpError("stored problem")], next: [], exit: 1, ok: false };
    db.finishRun(run.id, "failed", stored);
    db.close();
    await notifyScheduledFailure(root, failure({ runId: run.id }), { processEnv: DRY });
    const payload = JSON.parse(hook.hits[0]!.body) as { data: { runId: string }; problems: Problem[] };
    expect(payload.data.runId).toBe(run.id);
    expect(payload.problems.map((p) => p.message)).toEqual(["stored problem"]);
  });

  test("5xx is retried with backoff; 3 attempts in all", async () => {
    const hook = mockHook([status(503), status(500), ok()]);
    project({ desktop: false, webhook: hook.url() });
    const { waits, sleep } = recordingSleep();
    await notifyScheduledFailure(root, failure(), { processEnv: DRY, sleep, retryDelaysMs: [10, 40] });
    expect(hook.hits).toHaveLength(3);
    expect(waits).toEqual([10, 40]);
    expect(records()[0]).toMatchObject({ kind: "webhook", status: "sent", attempts: 3, httpStatus: 200 });
    expect(notifyLog()).toBe("");
  });

  test("gives up after 3 attempts and logs the host only", async () => {
    const hook = mockHook([status(502)]);
    project({ desktop: false, webhook: hook.url("/services/T0/B0/xyzSECRETPATH?token=abcSECRETQUERY") });
    const { sleep } = recordingSleep();
    await notifyScheduledFailure(root, failure(), { processEnv: DRY, sleep, retryDelaysMs: [1, 1] });
    expect(hook.hits).toHaveLength(WEBHOOK_ATTEMPTS);
    expect(WEBHOOK_ATTEMPTS).toBe(3);
    const log = notifyLog();
    expect(log).toContain(`webhook 127.0.0.1:${hook.port}: gave up after 3 attempts: HTTP 502`);
    expect(everythingWritten()).not.toContain("SECRETPATH");
    expect(everythingWritten()).not.toContain("SECRETQUERY");
    expect(records()[0]).toMatchObject({ kind: "webhook", status: "failed", attempts: 3, httpStatus: 502 });
  });

  test("429 is retried, honoring Retry-After", async () => {
    const hook = mockHook([status(429, { "Retry-After": "2" }), ok()]);
    project({ desktop: false, webhook: hook.url() });
    const { waits, sleep } = recordingSleep();
    await notifyScheduledFailure(root, failure(), { processEnv: DRY, sleep, retryDelaysMs: [10, 40] });
    expect(hook.hits).toHaveLength(2);
    expect(waits).toEqual([2000]);
  });

  test("4xx is never retried", async () => {
    const hook = mockHook([status(404)]);
    project({ desktop: false, webhook: hook.url("/nope/SECRETPATH") });
    const { waits, sleep } = recordingSleep();
    await notifyScheduledFailure(root, failure(), { processEnv: DRY, sleep, retryDelaysMs: [1, 1] });
    expect(hook.hits).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(notifyLog()).toContain(`webhook 127.0.0.1:${hook.port}: HTTP 404 (not retried)`);
    expect(notifyLog()).not.toContain("SECRETPATH");
  });

  test("network errors are retried, then logged; nothing throws", async () => {
    // A port nothing listens on: start a server, note its port, stop it.
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => ok() });
    const port = s.port;
    s.stop(true);
    project({ desktop: false, webhook: `http://127.0.0.1:${port}/hooks/SECRETPATH` });
    const { waits, sleep } = recordingSleep();
    await notifyScheduledFailure(root, failure(), { processEnv: DRY, sleep, retryDelaysMs: [5, 7] });
    expect(waits).toEqual([5, 7]);
    expect(notifyLog()).toContain(`webhook 127.0.0.1:${port}: gave up after 3 attempts`);
    expect(notifyLog()).not.toContain("SECRETPATH");
  });

  test("a server that never answers times out, and is retried", async () => {
    const hook = mockHook(["hang"]);
    project({ desktop: false, webhook: hook.url() });
    const { sleep } = recordingSleep();
    const started = Date.now();
    await notifyScheduledFailure(root, failure(), { processEnv: DRY, sleep, retryDelaysMs: [1, 1], timeoutMs: 150 });
    expect(hook.hits).toHaveLength(3);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(notifyLog()).toContain("gave up after 3 attempts");
  });

  test("under DRY a webhook that is not loopback is recorded, not sent", async () => {
    project({ desktop: false, webhook: "https://hooks.slack.com/services/T0/B0/xyzSECRETPATH" });
    const post = () => { throw new Error("must not POST"); };
    await notifyScheduledFailure(root, failure(), { processEnv: DRY, post });
    expect(records()).toEqual([expect.objectContaining({ kind: "webhook", host: "hooks.slack.com", status: "dry" })]);
    expect(everythingWritten()).not.toContain("SECRETPATH");
    expect(notifyLog()).toBe("");
  });

  test("loopback webhooks bypass HTTP_PROXY", async () => {
    const hook = mockHook([ok()]);
    project({ desktop: false, webhook: hook.url() });
    // In a child process: Bun reads the proxy variables once per process, so setting them here would send every
    // later test's fetch in this process through the dead proxy.
    const script = `const { notifyScheduledFailure } = await import(${JSON.stringify(new URL("./notify.ts", import.meta.url).href)});
await notifyScheduledFailure(${JSON.stringify(root)}, ${JSON.stringify(failure())}, { processEnv: ${JSON.stringify(DRY)}, retryDelaysMs: [1, 1] });`;
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", HTTP_PROXY: "http://127.0.0.1:9", http_proxy: "http://127.0.0.1:9" },
      stdout: "pipe", stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    expect(hook.hits).toHaveLength(1);
  });

  test("desktop and webhook both go out when both are configured", async () => {
    const hook = mockHook([ok()]);
    project({ webhook: hook.url() });
    await notifyScheduledFailure(root, failure(), { processEnv: DRY, platform: "linux" });
    expect(records().map((r) => [r.kind, r.status])).toEqual([["desktop", "dry"], ["webhook", "sent"]]);
    expect(records()[0]!.via).toBe("notify-send");
  });
});

describe("sendWebhook", () => {
  test("reports attempts and status without throwing", async () => {
    const hook = mockHook([status(500), status(400)]);
    const r = await sendWebhook(new URL(hook.url()), "{}", { sleep: async () => {}, retryDelaysMs: [1, 1] });
    expect(r).toMatchObject({ ok: false, attempts: 2, httpStatus: 400, retryable: false });
  });
});

describe("never throws", () => {
  const cases: [string, () => void, NotifyOptions?][] = [
    ["no croft.json", () => {}],
    ["an invalid croft.json", () => writeFileSync(join(root, "croft.json"), "{ nope")],
    ["an unreadable state folder", () => { project(); writeFileSync(stateDir, "a file, not a folder"); }],
  ];
  for (const [name, setup, extra] of cases) {
    test(name, async () => {
      setup();
      await expect(notifyScheduledFailure(root, failure(), { processEnv: DRY, platform: "darwin", ...extra })).resolves.toBeUndefined();
    });
  }

  test("a missing project still records under <root>/.croft with the defaults", async () => {
    await notifyScheduledFailure(root, failure(), { processEnv: DRY, platform: "darwin" });
    expect(records().map((r) => r.kind)).toEqual(["desktop"]);
  });

  test("an asset name that is not a path segment cannot escape the logs folder", async () => {
    project();
    const f = failure({ runId: "../../escape", failed: [{ asset: "../x", error: null }] });
    await notifyScheduledFailure(root, f, { processEnv: DRY, platform: "darwin" });
    expect(existsSync(join(root, "..", "escape"))).toBe(false);
    expect(records()).toHaveLength(1);
  });
});
