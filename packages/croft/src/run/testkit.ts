// Test fixtures for the run engine: temp croft projects whose assets import "@zabaca/croft" (linked to this
// package, as in a user's project), and a Bun.serve mock API with the pagination styles and failure modes of
// DESIGN.md §10 "End-to-end fixture projects". Not imported by the engine.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Server } from "bun";
import { ProjectEnv } from "../project/env.ts";
import { loadProject, type Project } from "../project/root.ts";
import { executeRun, type RunnerOptions, type RunOutcome } from "./runner.ts";

export const PKG = resolve(import.meta.dir, "../..");
export const MAIN = join(PKG, "src", "cli", "main.ts");

const made: string[] = [];

/** A project in a temp folder: croft.json, node_modules/@zabaca/croft → this package, and the given files. */
export function makeProject(files: Record<string, string>, o: { timezone?: string; config?: Record<string, unknown> } = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-run-")));
  made.push(root);
  mkdirSync(join(root, "node_modules", "@zabaca"), { recursive: true });
  symlinkSync(PKG, join(root, "node_modules", "@zabaca", "croft"));
  mkdirSync(join(root, "files"), { recursive: true });
  writeFileSync(join(root, "croft.json"), JSON.stringify({ database: "warehouse.duckdb", timezone: o.timezone ?? "America/Los_Angeles", ...o.config }));
  writeFiles(root, files);
  return root;
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

export function cleanupProjects(): void {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** Run in this process, the way `croft run --foreground` does, with fast retries and HTTP backoff. */
export async function runIn(root: string, selectors: string[], o: Partial<RunnerOptions> & { shell?: Record<string, string> } = {}): Promise<RunOutcome & { project: Project }> {
  const project = loadProject({ root });
  const env = ProjectEnv.load(root, o.shell ?? {});
  const out = await executeRun({
    project, env, selectors, argv: ["run", ...selectors], interactive: false, retryDelaysMs: [10, 20],
    http: { retryBaseMs: 5 }, ...o,
  });
  return { ...out, project };
}

// ---------------------------------------------------------------------------------------------------------
// The mock API

export interface Issue { id: number; title: string; updated_at: string; [k: string]: unknown }

export interface MockState {
  issues: Issue[];
  items: Record<string, unknown>[];
  zones: Record<string, unknown>[];
  /** Raw JSON text served by /raw (big integers, type drift). */
  raw: string;
  /** /flaky answers 500 this many more times. */
  failures: number;
  /** /limited answers 429 (Retry-After: `retryAfter` seconds, default 1) this many more times. */
  limited: number;
  retryAfter: string;
  /** /slow: pages and the delay before each. */
  slowPages: number;
  slowDelayMs: number;
  /** Every request's path and query. */
  log: { path: string; query: Record<string, string> }[];
}

export interface MockApi {
  url: string;
  state: MockState;
  stop(): void;
}

export function mockApi(): MockApi {
  const state: MockState = {
    issues: [], items: [], zones: [], raw: "[]", failures: 0, limited: 0, retryAfter: "1", slowPages: 5, slowDelayMs: 300, log: [],
  };
  const json = (v: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(v), { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const server: Server<undefined> = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const query = Object.fromEntries(u.searchParams);
      state.log.push({ path: u.pathname, query });
      switch (u.pathname) {
        case "/issues": {
          // Ascending keyset by updated_at; `since` is inclusive, like GitHub's.
          const per = Number(query.per_page ?? 100);
          const since = query.since;
          const rows = [...state.issues].sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : a.id - b.id))
            .filter((r) => since === undefined || Date.parse(r.updated_at) >= Date.parse(since));
          return json(rows.slice(0, per));
        }
        case "/items": {
          // Link pagination: 2 items per page.
          const page = Number(query.page ?? 1);
          const rows = state.items.slice((page - 1) * 2, page * 2);
          const more = page * 2 < state.items.length;
          const headers: Record<string, string> = more ? { link: `<${u.origin}/items?page=${page + 1}>; rel="next"` } : {};
          return json(rows, { headers });
        }
        case "/zones":
          return json(state.zones);
        case "/raw":
          return new Response(state.raw, { headers: { "content-type": "application/json" } });
        case "/flaky":
          if (state.failures > 0) {
            state.failures--;
            return new Response("upstream exploded", { status: 500 });
          }
          return json([{ id: 1, ok: true }, { id: 2, ok: true }]);
        case "/limited":
          if (state.limited > 0) {
            state.limited--;
            return new Response("slow down", { status: 429, headers: { "retry-after": state.retryAfter } });
          }
          return json([{ id: 1 }]);
        case "/slow": {
          const page = Number(query.page ?? 1);
          await Bun.sleep(state.slowDelayMs);
          const rows = [{ id: page * 2 - 1, page }, { id: page * 2, page }];
          return json({ rows, more: page < state.slowPages });
        }
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, state, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------------------------------------------------
// Asset sources

export const keysetIssues = (api: string, extra = "") => `import { ingest } from "@zabaca/croft";
type Issue = { id: number; updated_at: string };
export default ingest({
  key: "id",
  incremental: "updated_at",${extra}
  async *rows({ since, http }) {
    let from = since;
    for (;;) {
      const res = await http.get("${api}/issues", { query: { per_page: 2, since: from } });
      const page = res.json<Issue[]>();
      yield page;
      if (page.length < 2) return;
      const last = page.at(-1)!.updated_at;
      if (last === from) return;
      from = last;
    }
  },
});
`;

export const linkItems = (api: string) => `import { ingest } from "@zabaca/croft";
export default ingest({
  async *rows({ http }) {
    let url: string | undefined = "${api}/items";
    while (url) {
      const res = await http.get(url);
      yield res.json<Record<string, unknown>[]>();
      url = res.next;
    }
  },
});
`;

export const simpleGet = (api: string, path: string, extra = "") => `import { ingest } from "@zabaca/croft";
export default ingest({${extra}
  async *rows({ http }) {
    yield (await http.get("${api}${path}")).json<Record<string, unknown>[]>();
  },
});
`;

export const slowPages = (api: string) => `import { ingest } from "@zabaca/croft";
export default ingest({
  key: "id",
  async *rows({ http, log }) {
    for (let page = 1; ; page++) {
      const res = await http.get("${api}/slow", { query: { page } });
      const body = res.json<{ rows: Record<string, unknown>[]; more: boolean }>();
      log("page", page);
      yield body.rows;
      if (!body.more) return;
    }
  },
});
`;

// ---------------------------------------------------------------------------------------------------------
// The real CLI in a child process

export interface CliResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; json?: Record<string, any> }

export function cliEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", NO_COLOR: "1", ...extra };
}

/** Start the CLI (src/cli/main.ts) with stdin ignored, so it is off a TTY. */
export function startCli(root: string, argv: string[], env: Record<string, string> = cliEnv()): { proc: ChildProcess; done: Promise<CliResult> } {
  const proc = spawn(process.execPath, ["--no-env-file", MAIN, ...argv], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  proc.stdout!.on("data", (d) => (stdout += d));
  proc.stderr!.on("data", (d) => (stderr += d));
  const done = new Promise<CliResult>((r) => proc.on("exit", (code, signal) => {
    let parsed: Record<string, any> | undefined;
    try {
      parsed = argv.includes("--json") && stdout.trim() ? JSON.parse(stdout) : undefined;
    } catch {}
    r({ code, signal, stdout, stderr, ...(parsed ? { json: parsed } : {}) });
  }));
  return { proc, done };
}

export function cli(root: string, argv: string[], env?: Record<string, string>): Promise<CliResult> {
  return startCli(root, argv, env).done;
}

export async function until<T>(fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, timeoutMs = 15_000, pollMs = 25): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for a condition");
    await Bun.sleep(pollMs);
  }
}

export type { ChildProcess };
