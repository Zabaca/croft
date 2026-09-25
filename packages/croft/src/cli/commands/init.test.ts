import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookSettings, SETTINGS_FILE } from "../../agent/hook.ts";
import { CROFT_VERSION, SKILL_PATH, skillMd } from "../../agent/templates.ts";
import type { InitResult } from "../../project/init.ts";
import { main, type MainIO } from "../main.ts";
import { describe as describeInit, HOOK_LINE, nextSteps } from "./init.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "croft-initcmd-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const d = join(base, `c${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};

async function croft(argv: string[], io: MainIO = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const exit = await main(argv, {
    env: {}, stdinTTY: false, stdoutTTY: false, stderrTTY: false,
    stdout: (t) => out.push(t), stderr: (t) => err.push(t), ...io,
  });
  const stdout = out.join("");
  return { exit, stdout, stderr: err.join(""), env: argv.includes("--json") ? JSON.parse(stdout) : undefined };
}

describe("croft init (command)", () => {
  test("--json: one envelope with the result; next says how to load the example", async () => {
    const cwd = fresh();
    const r = await croft(["init", "my-data", "--no-install", "--json"], { cwd });
    expect(r.exit).toBe(0);
    expect(r.env).toMatchObject({ ok: true, command: "init", problems: [] });
    expect(r.env.data).toMatchObject({ mode: "new", root: join(cwd, "my-data"), version: CROFT_VERSION });
    expect(r.env.data.files).toHaveLength(10);
    expect(r.env.next).toEqual([
      { command: "cd my-data && bun install", reason: "install croft and its DuckDB binding into the project" },
      { command: "cd my-data && croft run example_sales", reason: "load the example table from files/example_sales.csv (no network needed)" },
    ]);
    expect(existsSync(join(cwd, "my-data", "croft.json"))).toBe(true);
  });

  test("human output", async () => {
    const cwd = fresh();
    const r = await croft(["init", "shop data", "--no-install"], { cwd });
    expect(r.exit).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toMatch(new RegExp(`^Created shop data/ \\(croft ${CROFT_VERSION.replace(/\./g, "\\.")}, timezone [\\w/+-]+\\)$`));
    expect(r.stdout).toContain("Claude Code: CLAUDE.md and .claude/skills/croft/SKILL.md are ready.");
    expect(r.stdout).toContain("next: cd 'shop data' && croft run example_sales");
  });

  test("without a folder inside a project: that project (plain init refuses, --claude refreshes)", async () => {
    const cwd = fresh();
    await croft(["init", "p", "--no-install"], { cwd });
    const sub = join(cwd, "p", "assets");
    const again = await croft(["init", "--json"], { cwd: sub });
    expect(again.exit).toBe(2);
    expect(again.env.problems[0]).toMatchObject({ code: "USAGE_ERROR", fix: { command: "croft init --claude" } });

    writeFileSync(join(cwd, "p", SKILL_PATH), skillMd("0.0.1"));
    const refresh = await croft(["init", "--claude"], { cwd: sub });
    expect(refresh.exit).toBe(0);
    expect(refresh.stdout).toContain(`Refreshed the Claude files for croft ${CROFT_VERSION}:`);
    expect(refresh.stdout).toContain(`${SKILL_PATH}  updated`);
    const same = await croft(["init", "--claude"], { cwd: sub });
    expect(same.stdout).toContain(`The Claude files already match croft ${CROFT_VERSION}:`);
  });

  test("a relative folder resolves from CROFT_CALLER_CWD (set by the launcher, which runs from the project root)", async () => {
    const caller = fresh();
    const projectRoot = fresh();
    const r = await croft(["init", "x", "--no-install", "--json"], { cwd: projectRoot, env: { CROFT_CALLER_CWD: caller } });
    expect(r.env.data.root).toBe(join(caller, "x"));
    expect(existsSync(join(projectRoot, "x"))).toBe(false);
  });

  test("in an app repo off a TTY the tsconfig edit is printed, not applied, and nothing prompts", async () => {
    const app = fresh();
    writeFileSync(join(app, "package.json"), "{}");
    const tsconfig = `{\n  "exclude": ["node_modules"]\n}\n`;
    writeFileSync(join(app, "tsconfig.json"), tsconfig);
    const r = await croft(["init", "--no-install"], { cwd: app, stdinTTY: false });
    expect(r.exit).toBe(0);
    expect(readFileSync(join(app, "tsconfig.json"), "utf8")).toBe(tsconfig);
    expect(r.stdout).toContain("Created data/ next to your app");
    expect(r.stdout).toContain(`tsconfig.json was not changed. So that your app's type-check (next build, tsc) skips data/, make this edit:`);
    expect(r.stdout).toContain(`  +  "exclude": ["node_modules", "data"]`);
    expect(r.stdout).toContain("In your app:\n  npm install @zabaca/croft@");
    expect(r.stdout).toContain("  CLAUDE.md: created (points Claude Code at data/)");
    expect(r.stdout).toContain(`  ${SKILL_PATH}: created`);
    expect(r.stdout).not.toContain("data/croft.json");

    const withClaude = fresh();
    writeFileSync(join(withClaude, "package.json"), "{}");
    writeFileSync(join(withClaude, "CLAUDE.md"), "# App\n");
    const r2 = await croft(["init", "--no-install"], { cwd: withClaude });
    expect(r2.stdout).toContain("  CLAUDE.md: added the croft block (points Claude Code at data/)");
  });

  test("a failed bun install is INSTALL_FAILED (exit 2); the project is still created", async () => {
    const cwd = fresh();
    // An unreachable registry makes bun install fail at once, provided init hands bun install this env.
    const env = { ...process.env, BUN_CONFIG_REGISTRY: "http://127.0.0.1:9/" };
    const r = await croft(["init", "p", "--json"], { cwd, env });
    expect(r.exit).toBe(2);
    expect(r.env.ok).toBe(false);
    expect(r.env.data.install).toMatchObject({ ran: true, ok: false, command: "bun install" });
    expect(r.env.problems).toHaveLength(1);
    expect(r.env.problems[0]).toMatchObject({
      severity: "error", code: "INSTALL_FAILED",
      fix: { kind: "command", command: "cd p && bun install" }, details: { root: join(cwd, "p") },
    });
    expect(r.env.problems[0].details.output).toContain("ConnectionRefused");
    expect(existsSync(join(cwd, "p", "croft.json"))).toBe(true);

    const human = await croft(["init", "q"], { cwd, env });
    expect(human.exit).toBe(2);
    expect(human.stdout).toContain("error INSTALL_FAILED  bun install failed in q");
  }, 30_000);

  test("an unknown flag is a usage error with a suggestion", async () => {
    const r = await croft(["init", "--no-instal", "--json"], { cwd: fresh() });
    expect(r.exit).toBe(2);
    expect(r.env.problems[0].hint).toBe("did you mean --no-install?");
  });
});

describe("croft init --with-hook (DESIGN.md §9 item 7)", () => {
  const settings = (dir: string) => JSON.parse(readFileSync(join(dir, SETTINGS_FILE), "utf8"));

  test("plain init never writes .claude/settings.json (D27)", async () => {
    const cwd = fresh();
    await croft(["init", "p", "--no-install"], { cwd });
    expect(existsSync(join(cwd, "p", SETTINGS_FILE))).toBe(false);
    await croft(["init", "--claude"], { cwd: join(cwd, "p") });
    expect(existsSync(join(cwd, "p", SETTINGS_FILE))).toBe(false);
  });

  test("a new project: .claude/settings.json holds the PostToolUse hook, and the output says so", async () => {
    const cwd = fresh();
    const r = await croft(["init", "p", "--no-install", "--with-hook", "--json"], { cwd });
    expect(r.exit).toBe(0);
    expect(r.env.problems).toEqual([]);
    expect(r.env.data.files).toContainEqual({ path: SETTINGS_FILE, action: "created", note: expect.stringContaining("croft validate --hook") });
    expect(settings(join(cwd, "p"))).toEqual(hookSettings());

    const human = await croft(["init", "q", "--no-install", "--with-hook"], { cwd });
    expect(human.exit).toBe(0);
    expect(human.stdout).toContain(HOOK_LINE);
  });

  test("--claude --with-hook merges into the user's settings, and a second run changes nothing", async () => {
    const cwd = fresh();
    await croft(["init", "p", "--no-install"], { cwd });
    const root = join(cwd, "p");
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, SETTINGS_FILE), `{\n  "permissions": {\n    "ask": ["Bash(croft confirm:*)"]\n  }\n}\n`);
    const first = await croft(["init", "--claude", "--with-hook"], { cwd: root });
    expect(first.exit).toBe(0);
    expect(first.stdout).toContain(`  ${SETTINGS_FILE}  merged (`);
    expect(first.stdout).toContain(HOOK_LINE);
    expect(settings(root)).toEqual({ permissions: { ask: ["Bash(croft confirm:*)"] }, ...hookSettings() });

    const before = readFileSync(join(root, SETTINGS_FILE), "utf8");
    const second = await croft(["init", "--claude", "--with-hook", "--json"], { cwd: root });
    expect(second.exit).toBe(0);
    expect(second.env.data.files).toContainEqual({ path: SETTINGS_FILE, action: "unchanged", note: expect.any(String) });
    expect(readFileSync(join(root, SETTINGS_FILE), "utf8")).toBe(before);
  });

  test("a project inside an app: the app's settings run data/'s croft; data/ gets its own for sessions started there", async () => {
    const app = fresh();
    writeFileSync(join(app, "package.json"), "{}");
    mkdirSync(join(app, ".claude"));
    writeFileSync(join(app, SETTINGS_FILE), `{"model": "opus"}`);
    const r = await croft(["init", "--no-install", "--with-hook"], { cwd: app });
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain(`  ${SETTINGS_FILE}: merged (`);
    expect(r.stdout).toContain(HOOK_LINE);
    expect(settings(app)).toEqual({ model: "opus", ...hookSettings("data") });
    expect(settings(join(app, "data"))).toEqual(hookSettings());

    const again = await croft(["init", "--claude", "--with-hook", "--json"], { cwd: app });
    expect(again.env.data.files.filter((f: { path: string }) => f.path.endsWith(SETTINGS_FILE)))
      .toEqual([
        { path: `data/${SETTINGS_FILE}`, action: "unchanged", note: expect.any(String) },
        { path: SETTINGS_FILE, action: "unchanged", note: expect.any(String) },
      ]);
    expect(settings(app).hooks.PostToolUse).toHaveLength(1);
  });

  test("settings.json that is not valid JSON: the project is created, the file untouched, USAGE_ERROR says what to do", async () => {
    const cwd = fresh();
    const target = join(cwd, "p");
    mkdirSync(join(target, ".claude"), { recursive: true });
    writeFileSync(join(target, SETTINGS_FILE), `{"model": "opus",}`);
    const r = await croft(["init", "p", "--no-install", "--with-hook", "--json"], { cwd });
    expect(r.exit).toBe(2);
    expect(existsSync(join(target, "croft.json"))).toBe(true);
    expect(readFileSync(join(target, SETTINGS_FILE), "utf8")).toBe(`{"model": "opus",}`);
    expect(r.env.problems).toEqual([expect.objectContaining({
      code: "USAGE_ERROR", file: SETTINGS_FILE, fix: expect.objectContaining({ kind: "manual" }),
    })]);
    expect(r.env.problems[0].hint).toContain("croft init --claude --with-hook");
    expect(r.env.data.files).toContainEqual({ path: SETTINGS_FILE, action: "skipped", note: expect.stringContaining("not valid JSON") });
  });

  test("--with-hook on an existing project: the fix is croft init --claude --with-hook", async () => {
    const cwd = fresh();
    await croft(["init", "p", "--no-install"], { cwd });
    const r = await croft(["init", "p", "--with-hook", "--json"], { cwd });
    expect(r.exit).toBe(2);
    expect(r.env.problems[0]).toMatchObject({ code: "USAGE_ERROR", fix: { kind: "command", command: "croft init p --claude --with-hook" } });
    expect(r.env.problems[0].hint).toContain("croft init p --claude --with-hook");
    expect(existsSync(join(cwd, "p", SETTINGS_FILE))).toBe(false);
  });
});

describe("init output helpers", () => {
  const result = (o: Partial<InitResult>): InitResult => ({
    mode: "new", base: "/w/p", root: "/w/p", version: "0.1.0", timezone: "UTC", files: [], relocation: null, tsconfig: null,
    appSteps: [], install: { ran: true, ok: true, command: "bun install", ms: 2100 }, example: { ran: false, reason: "x" }, ...o,
  });

  test("next steps: example run → query; otherwise run it; failed install → bun install first", () => {
    expect(nextSteps(result({ example: { ran: true, ok: true, asset: "example_sales", rows: 120, checks: "ok" } }), "/w"))
      .toEqual([{ command: `cd p && croft query "from example_sales limit 5"`, reason: "look at the example table" }]);
    expect(nextSteps(result({}), "/w/p").map((x) => x.command)).toEqual(["croft run example_sales"]);
    expect(nextSteps(result({ install: { ran: true, ok: false, command: "bun install", ms: 1 } }), "/elsewhere").map((x) => x.command))
      .toEqual(["cd /w/p && bun install", "cd /w/p && croft run example_sales"]);
    expect(nextSteps(result({ mode: "claude" }), "/w")).toEqual([]);
  });

  test("the §2 lines: install time, example rows, relocation in plain words", () => {
    const text = describeInit(result({
      example: { ran: true, ok: true, asset: "example_sales", rows: 120, checks: "ok" },
      relocation: { reason: "iCloud Drive", dir: "/Users/a/.local/share/croft/p-12345678", database: "~/x", stateDir: "~/y" },
    }), "/w");
    expect(text.split("\n")).toEqual([
      "Created p/ (croft 0.1.0, timezone UTC)",
      "This folder is in iCloud Drive; file sync can corrupt a database mid-write, so the database and",
      ".croft/ live in /Users/a/.local/share/croft/p-12345678 instead (recorded in croft.json). Your asset files stay here.",
      "Installed dependencies (bun install, 2.1 s)",
      "Ran example_sales: 120 rows · checks ok",
      "Claude Code: CLAUDE.md and .claude/skills/croft/SKILL.md are ready. croft docs claude-permissions suggests permission rules.",
    ]);
    const failed = describeInit(result({ install: { ran: true, ok: false, command: "bun install", ms: 900, output: "error: offline" } }), "/w");
    expect(failed).toContain("bun install failed after 900 ms; the project is created but cannot run yet:\n    error: offline");
  });
});
