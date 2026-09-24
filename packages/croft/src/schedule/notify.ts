// Failure notifications of scheduled runs (DESIGN.md §8 "What the user experiences", "Failures"; §2 croft.json
// `notify`). A person started a manual run and sees its result; nobody watches a scheduled one, so when it fails:
//
//   desktop   on by default ("notify": {"desktop": false} turns it off). macOS: `osascript -e 'display
//             notification "…" with title "…"'`; Linux: `notify-send` when it is installed. Plain words: the
//             project folder, the failed asset(s), the first error's code and message, and the command that shows
//             it (`croft logs <asset> --failed`). Both go through an OsRunner (os.ts), so tests inject a fake one.
//   webhook   "notify": {"webhook": "https://…"} receives the failure envelope as JSON: the run's summary
//             ({data: {runId, status, steps}, problems, next, exit, ok}, what `croft run --json` prints) plus
//             `project`, and `text` (the notification in one line, which Slack-style incoming webhooks need to
//             accept the post). 10 s per attempt, 3 attempts with backoff on network errors, timeouts, 429 and 5xx
//             (a Retry-After up to 30 s is honored), never on another 4xx. A loopback URL is posted over a plain
//             socket (read/http.ts), so HTTP_PROXY never sees it; any other host goes through fetch and keeps the
//             machine's egress proxy.
//
// Secrets: everything sent or written is redacted the way the runner redacts a run summary (runner.ts
// redactValue: problems as free text, every .env value; the rest under the data policy), with the run's own
// ProjectEnv when the runner passes it (its declared secrets and the shell values secret() handed out), else
// <root>/.env plus every secret the asset files name. Messages are redacted before they are cut, so a cut can
// never leave a secret's prefix. A webhook URL is secret-like too (Slack's path is its credential): logs and
// records name its host only, and error texts are scrubbed of the rest.
//
// CROFT_NOTIFY_DRY=1 (tests/preload.ts, the e2e harness): each notification is recorded as a JSON line in
// <state>/logs/notifications.ndjson instead of being shown. A loopback webhook is still posted (tests run a
// mock server); any other is recorded as "dry" and not sent.
//
// Never throws: the run it reports on has already ended. A notification that could not go out is one line in
// <state>/logs/notify.log (time, run id, what failed), which is where to look when a notification never came.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as sleepMs } from "node:timers/promises";
import { CroftError } from "../core/errors.ts";
import { now as clockNow } from "../core/time.ts";
import type { Problem } from "../core/types.ts";
import { staticSecrets } from "../cli/commands/describe.ts";
import { CROFT_VERSION } from "../cli/version.ts";
import { RUNS_DB_FILE, RunsDb } from "../history/runs-db.ts";
import { ProjectEnv } from "../project/env.ts";
import { DEFAULTS, type NotifyConfig, readConfig, resolvePaths } from "../project/root.ts";
import { isLoopback, post as httpPost, TransportError } from "../read/http.ts";
import { redactValue, type RunSummary } from "../run/runner.ts";
import type { Env } from "./home.ts";
import { type OsRunner, realRunner } from "./os.ts";

export interface ScheduledFailure {
  /** The project's name: its folder's (a path is cut to its last segment). */
  project: string;
  runId: string;
  /** Assets whose step failed, crashed or was interrupted. */
  failed: { asset: string; error: Problem | null }[];
  /** The run's summary as the runner stored it. When absent it is read from runs.sqlite, else built from `failed`. */
  summary?: RunSummary;
}

export interface NotifyOptions {
  /** The run's ProjectEnv, which knows the run's declared secrets and the shell values it handed out. Default:
   *  <root>/.env and the process environment, with every secret the asset files name declared. */
  env?: ProjectEnv;
  /** CROFT_NOTIFY_DRY, PATH, HOME, LANG and the desktop session's variables are read from it; process.env. */
  processEnv?: Env;
  /** Runs osascript / notify-send; realRunner (which refuses under CROFT_FORBID_OS_JOBS=1). */
  runner?: OsRunner;
  platform?: NodeJS.Platform;
  /** The HTTP transport (read/http.ts post); tests inject one that must not be called. */
  post?: typeof httpPost;
  /** Between webhook attempts. */
  sleep?: (ms: number) => Promise<void>;
  /** Waits before attempts 2 and 3 (default 1 s, 4 s). */
  retryDelaysMs?: readonly number[];
  /** Per webhook attempt (default 10 s). */
  timeoutMs?: number;
}

/** Webhook attempts in all: the first and two retries. */
export const WEBHOOK_ATTEMPTS = 3;
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000];
/** The longest Retry-After a webhook retry waits for. */
const MAX_RETRY_AFTER_MS = 30_000;
const DESKTOP_TIMEOUT_MS = 10_000;
/** The error message's share of a desktop notification (Notification Center shows about four lines). */
const MESSAGE_CHARS = 180;
const LISTED_ASSETS = 2;

export const NOTIFICATIONS_FILE = "notifications.ndjson";
export const NOTIFY_LOG_FILE = "notify.log";

export function notificationsPath(stateDir: string): string {
  return join(stateDir, "logs", NOTIFICATIONS_FILE);
}
export function notifyLogPath(stateDir: string): string {
  return join(stateDir, "logs", NOTIFY_LOG_FILE);
}

/** Called by the runner when a run with trigger "schedule" ends with failed steps. Never throws. */
export async function notifyScheduledFailure(root: string, failure: ScheduledFailure, o: NotifyOptions = {}): Promise<void> {
  let out: Outbox | undefined;
  try {
    const processEnv = o.processEnv ?? process.env;
    const { notify, stateDir, assetsDir } = projectSettings(root);
    const redact = redactorFor(root, assetsDir, processEnv, o.env);
    out = new Outbox(stateDir, safeLine(failure.runId), redact.text, processEnv);
    const dry = processEnv.CROFT_NOTIFY_DRY === "1";
    const project = basename(failure.project || root) || basename(root);
    const message = desktopMessage(project, failure.failed, redact, failure.runId);

    if (notify.desktop) {
      try {
        showDesktop(message, dry, o, processEnv, out);
      } catch (e) {
        out.log(`desktop: ${errorText(e)}`);
      }
    }
    if (notify.webhook) {
      const payload = webhookPayload(project, failure, stateDir, `${message.title} — ${message.body}`, redact.env);
      await postWebhook(notify.webhook, JSON.stringify(payload), dry, o, out);
    }
  } catch (e) {
    try {
      out?.log(`notify: ${errorText(e)}`);
    } catch {
      // Nowhere left to report it; the run's own result is already recorded.
    }
  }
}

// ---- The message ----

export interface Redaction {
  /** Free text (messages): every .env value. */
  text: (t: string) => string;
  /** Names and values (assets, commands): the data policy. */
  data: (t: string) => string;
}

/** The desktop notification's title and body, in plain words. */
export function desktopMessage(project: string, failed: ScheduledFailure["failed"], redact: Redaction, runId: string): { title: string; body: string } {
  const title = `croft: ${oneLine(redact.data(project))}`;
  if (failed.length === 0) return { title, body: `A scheduled run failed. See it with: croft logs ${redact.data(runId)}` };
  const names = failed.map((f) => oneLine(redact.data(f.asset)));
  // "a", "a and b", "a, b and c", then "a, b and 3 more".
  const shown = names.length <= LISTED_ASSETS + 1 ? names : [...names.slice(0, LISTED_ASSETS), `${names.length - LISTED_ASSETS} more`];
  const listed = shown.length === 1 ? shown[0]! : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
  const first = failed.find((f) => f.error) ?? failed[0]!;
  const asset = oneLine(redact.data(first.asset));
  // Redact, then collapse and cut: cutting first could leave a secret's prefix that no pattern matches.
  const text = first.error ? cut(oneLine(redact.text(first.error.message)), MESSAGE_CHARS) : "";
  const what = first.error ? `: ${first.error.code}: ${/[.!?…]$/.test(text) ? text : `${text}.`}` : ".";
  return { title, body: `${listed} failed in a scheduled run${what} See it with: croft logs ${asset} --failed` };
}

function oneLine(s: string): string {
  return s.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
}

function cut(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

// ---- Desktop ----

/** An AppleScript string literal: backslashes and quotes escaped (any other backslash sequence is a syntax
 *  error, and nothing else is special inside a literal), line breaks and control characters as spaces. */
export function appleScriptString(s: string): string {
  const flat = s.replace(/\r\n/g, " ").replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ");
  return `"${flat.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** notify-send bodies are markup on most notification servers (GNOME, KDE, dunst). */
function escapeMarkup(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The command that shows a notification, or null when the platform has none. */
export function desktopCommand(platform: NodeJS.Platform, title: string, body: string): string[] | null {
  if (platform === "darwin") {
    return ["/usr/bin/osascript", "-e", `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`];
  }
  // -a is --app-name. `--` ends the options, so a title or body starting with "-" is never read as one.
  if (platform === "linux") return ["notify-send", "-a", "croft", "--", title, escapeMarkup(oneLine(body))];
  return null;
}

/** The environment a notifier gets: enough to find it and reach the user's session, nothing else. */
function desktopEnv(platform: NodeJS.Platform, env: Env): Record<string, string> {
  const out: Record<string, string> = {
    PATH: env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: env.HOME ?? "",
    LANG: env.LANG || (platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8"),
  };
  if (platform === "linux") {
    for (const k of ["DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"]) if (env[k]) out[k] = env[k]!;
    // cron starts the tick without the session's bus address; the user's bus lives in their runtime folder.
    if (!out.DBUS_SESSION_BUS_ADDRESS) {
      const runtime = out.XDG_RUNTIME_DIR ?? (process.getuid ? `/run/user/${process.getuid()}` : null);
      if (runtime && existsSync(join(runtime, "bus"))) out.DBUS_SESSION_BUS_ADDRESS = `unix:path=${join(runtime, "bus")}`;
    }
  }
  return out;
}

function showDesktop(m: { title: string; body: string }, dry: boolean, o: NotifyOptions, processEnv: Env, out: Outbox): void {
  const platform = o.platform ?? process.platform;
  const argv = desktopCommand(platform, m.title, m.body);
  const via = argv ? basename(argv[0]!) : null;
  if (dry) {
    out.record({ kind: "desktop", title: m.title, body: m.body, via, status: argv ? "dry" : "unsupported" });
    return;
  }
  if (!argv) {
    out.log(`desktop: desktop notifications are not supported on ${platform}`);
    return;
  }
  // The FORBID tripwire holds whatever processEnv a caller passes: the real runner refuses if either says so.
  const runner = o.runner ?? realRunner({ ...processEnv, CROFT_FORBID_OS_JOBS: process.env.CROFT_FORBID_OS_JOBS === "1" ? "1" : processEnv.CROFT_FORBID_OS_JOBS });
  const r = runner.exec(argv, { env: desktopEnv(platform, processEnv), timeoutMs: DESKTOP_TIMEOUT_MS });
  if (r.status === 0) return;
  if (r.status === null && /ENOENT/.test(r.stderr)) {
    out.log(`desktop: ${via} is not installed${platform === "linux" ? " (install libnotify-bin or libnotify)" : ""}`);
    return;
  }
  const first = r.stderr.split("\n").map((l) => l.trim()).find(Boolean);
  out.log(`desktop: ${via} ${r.status === null ? "did not finish" : `exited ${r.status}`}${first ? `: ${first}` : ""}`);
}

// ---- Webhook ----

/** The failure envelope: the run's summary, re-redacted, with the project and a one-line text. */
function webhookPayload(project: string, f: ScheduledFailure, stateDir: string, text: string, env: ProjectEnv): Record<string, unknown> {
  const s = f.summary ?? storedSummary(stateDir, f.runId) ?? builtSummary(f);
  // Only the fields `croft run --json` documents: no progress, and no confirmation token.
  const payload = {
    project, text,
    data: { runId: s.data.runId, status: s.data.status, steps: s.data.steps ?? [] },
    problems: s.problems ?? [], next: s.next ?? [], exit: s.exit, ok: s.ok,
  };
  return redactValue(payload, env);
}

/** The summary runs.sqlite holds for the run, or null (no database, no such run, still running, unreadable). */
function storedSummary(stateDir: string, runId: string): RunSummary | null {
  if (!existsSync(join(stateDir, RUNS_DB_FILE))) return null;
  try {
    const db = RunsDb.open(stateDir);
    try {
      const s = db.getRun(runId)?.summary as Partial<RunSummary> | null | undefined;
      return s && s.data && typeof s.data === "object" && typeof s.exit === "number" ? s as RunSummary : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function builtSummary(f: ScheduledFailure): RunSummary {
  const problems = f.failed.map((x) => x.error).filter((p): p is Problem => p !== null);
  const asset = (f.failed.find((x) => x.error) ?? f.failed[0])?.asset;
  return {
    data: { runId: f.runId, status: "failed", steps: [] },
    problems,
    next: [{ command: asset ? `croft logs ${asset} --failed` : `croft logs ${f.runId}`, reason: "see what failed" }],
    exit: 1, ok: false,
  };
}

export interface WebhookResult {
  ok: boolean;
  attempts: number;
  /** The last HTTP status, or null when no answer came. */
  httpStatus: number | null;
  /** Whether the last failure was one that is retried (network, timeout, 429, 5xx). */
  retryable: boolean;
  /** Why it failed, with the URL's path and query scrubbed. */
  error?: string;
}

/** POST `body` to the webhook: up to 3 attempts. Never throws. */
export async function sendWebhook(url: URL, body: string, o: Pick<NotifyOptions, "post" | "sleep" | "retryDelaysMs" | "timeoutMs"> = {}): Promise<WebhookResult> {
  const send = o.post ?? httpPost;
  const sleep = o.sleep ?? ((ms: number) => sleepMs(ms));
  const delays = o.retryDelaysMs ?? WEBHOOK_RETRY_DELAYS_MS;
  const timeout = o.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const headers = { "Content-Type": "application/json", "User-Agent": `croft/${CROFT_VERSION}` };
  let last: WebhookResult = { ok: false, attempts: 0, httpStatus: null, retryable: false };
  for (let attempt = 1; attempt <= WEBHOOK_ATTEMPTS; attempt++) {
    let wait = delays[attempt - 1] ?? delays[delays.length - 1] ?? 0;
    try {
      const reply = await send(url, body, headers, { connectMs: timeout, responseMs: timeout });
      if (reply.status >= 200 && reply.status < 300) return { ok: true, attempts: attempt, httpStatus: reply.status, retryable: false };
      const retryable = reply.status === 429 || reply.status >= 500;
      last = { ok: false, attempts: attempt, httpStatus: reply.status, retryable, error: `HTTP ${reply.status}` };
      if (!retryable) return last;
      const after = retryAfterMs(reply.headers["retry-after"]);
      if (after !== null) wait = Math.max(wait, Math.min(after, MAX_RETRY_AFTER_MS));
    } catch (e) {
      last = { ok: false, attempts: attempt, httpStatus: null, retryable: true, error: scrubUrl(errorText(e), url) };
    }
    if (attempt < WEBHOOK_ATTEMPTS) await sleep(wait);
  }
  return last;
}

/** Retry-After in seconds or as an HTTP date, in ms; null when absent or unreadable. */
function retryAfterMs(v: string | undefined): number | null {
  if (!v) return null;
  if (/^\d+$/.test(v.trim())) return Number(v.trim()) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

async function postWebhook(webhook: string, body: string, dry: boolean, o: NotifyOptions, out: Outbox): Promise<void> {
  let url: URL;
  try {
    url = new URL(webhook);
  } catch {
    out.log("webhook: notify.webhook is not a URL");
    return;
  }
  const host = url.host;
  if (dry && !isLoopback(url)) {
    out.record({ kind: "webhook", host, status: "dry" });
    return;
  }
  const r = await sendWebhook(url, body, o);
  if (dry) out.record({ kind: "webhook", host, status: r.ok ? "sent" : "failed", httpStatus: r.httpStatus, attempts: r.attempts });
  if (r.ok) return;
  out.log(r.retryable
    ? `webhook ${host}: gave up after ${r.attempts} attempts: ${r.error}`
    : `webhook ${host}: ${r.error} (not retried)`);
}

/** An error text without the webhook's path, query or credentials: only its origin may appear. */
function scrubUrl(text: string, url: URL): string {
  let out = text.split(url.href).join(url.origin);
  const secretParts = [url.pathname + url.search, url.search, url.pathname, url.username, url.password]
    .filter((p) => p.length > 1 && p !== "/");
  for (const p of secretParts) out = out.split(p).join("…");
  return out;
}

// ---- Project, redaction and where things are written ----

/** croft.json's notify settings and the folders notify reads and writes, or the defaults when croft.json cannot
 *  be read (the notification still goes out, recorded under <root>/.croft). */
function projectSettings(root: string): { notify: NotifyConfig; stateDir: string; assetsDir: string } {
  try {
    const config = readConfig(root);
    const paths = resolvePaths(root, config);
    return { notify: config.notify, stateDir: paths.stateDir, assetsDir: paths.assetsDir };
  } catch {
    return { notify: { ...DEFAULTS.notify }, stateDir: join(root, ".croft"), assetsDir: join(root, "assets") };
  }
}

function redactorFor(root: string, assetsDir: string, processEnv: Env, given: ProjectEnv | undefined): Redaction & { env: ProjectEnv } {
  let env = given;
  if (!env) {
    try {
      env = ProjectEnv.load(root, processEnv);
    } catch {
      env = new ProjectEnv({ root, shell: processEnv });
    }
    // As a run declares them (runner.ts withProjectChecks): a secret set only in the shell is redacted once
    // an asset names it.
    env.declare(assetSecrets(assetsDir));
  }
  const e = env;
  return { env: e, text: (t) => e.redact(t), data: (t) => e.redactData(t) };
}

/** The secret names the project's TS asset files name (describe.ts staticSecrets), without importing them. */
function assetSecrets(assetsDir: string): string[] {
  const names = new Set<string>();
  try {
    if (!existsSync(assetsDir)) return [];
    for (const file of new Bun.Glob("**/*.ts").scanSync({ cwd: assetsDir, onlyFiles: true })) {
      try {
        for (const n of staticSecrets(readFileSync(join(assetsDir, file), "utf8"))) names.add(n);
      } catch { /* unreadable: nothing to declare */ }
    }
  } catch { /* no assets folder */ }
  return [...names];
}

/** A run id as it may appear in a log line: one token, no line breaks. */
function safeLine(s: string): string {
  return oneLine(s).replace(/\s/g, "_") || "-";
}

function errorText(e: unknown): string {
  if (e instanceof CroftError) return e.message;
  if (e instanceof TransportError) return e.message;
  return oneLine(e instanceof Error ? e.message : String(e));
}

/** Where a notification's traces go: the DRY records and the log of what could not be sent. */
class Outbox {
  constructor(private readonly stateDir: string, private readonly runId: string, private readonly redact: (t: string) => string,
    private readonly env: Env) {}

  #append(file: string, line: string): void {
    try {
      mkdirSync(join(this.stateDir, "logs"), { recursive: true });
      appendFileSync(file, `${line}\n`);
    } catch {
      // A notification's own log must never fail anything.
    }
  }

  #at(): string {
    try {
      return clockNow(this.env).toISOString();
    } catch {
      return new Date().toISOString();
    }
  }

  /** CROFT_NOTIFY_DRY: what would have been shown or sent. */
  record(r: Record<string, unknown>): void {
    this.#append(notificationsPath(this.stateDir), JSON.stringify({ at: this.#at(), runId: this.runId, ...r }));
  }

  /** A notification that did not go out. */
  log(message: string): void {
    this.#append(notifyLogPath(this.stateDir), this.redact(`${this.#at()} ${this.runId} ${oneLine(message)}`));
  }
}
