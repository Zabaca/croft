// croft validate --hook (DESIGN.md §9 item 7): the PostToolUse hook's side. Claude Code runs it after each Edit,
// Write or MultiEdit with the tool call's JSON on stdin; exit 2 shows its stderr to Claude, exit 0 is silent
// (code.claude.com/docs/en/hooks, "Exit code 2 behavior per event": PostToolUse "Shows stderr to Claude; the
// tool already ran").
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOOK_IO, hookCommand } from "../../agent/hook.ts";
import { putCatalog } from "../../history/catalog.ts";
import { cleanup, cli, ISSUES_CATALOG, ISSUES_TS, makeProject, PKG, runsDb, type TestProject, writeFiles } from "./inspect-testkit.ts";

const realStdin = HOOK_IO.readStdin;
afterEach(() => { HOOK_IO.readStdin = realStdin; });
afterAll(async () => { await cleanup(); });

const OPEN_SQL = `SELECT id, title, "user"->>'login' AS author FROM github_issues\n`;
const BY_AUTHOR_SQL = "SELECT author, count(*) AS n FROM open_issues GROUP BY author\n";

/** github_issues (built: id, title, "user"), open_issues reading it, by_author reading that, and an unrelated
 *  asset with a syntax error. */
function project(files: Record<string, string> = {}): TestProject {
  const p = makeProject({
    files: {
      "assets/github_issues.ts": ISSUES_TS,
      "assets/open_issues.sql": OPEN_SQL,
      "assets/by_author.sql": BY_AUTHOR_SQL,
      "assets/broken.sql": "SELECT FROM WHERE\n",
      ...files,
    },
  });
  const db = runsDb(p.stateDir);
  try {
    putCatalog(db, ISSUES_CATALOG);
  } finally {
    db.close();
  }
  return p;
}

/** PostToolUse input for an edit of `file` (relative to the project, made absolute as Claude Code sends it). */
function input(p: TestProject, file: string, tool = "Edit"): string {
  return JSON.stringify({
    session_id: "abc123", transcript_path: "/tmp/t.jsonl", cwd: p.root, permission_mode: "default",
    hook_event_name: "PostToolUse", tool_name: tool, tool_input: { file_path: join(p.root, file), old_string: "a", new_string: "b" },
    tool_response: { filePath: join(p.root, file) }, tool_use_id: "toolu_01",
  });
}

async function hook(p: TestProject, file: string, o: { json?: boolean; stdin?: string; cwd?: string; stdinTTY?: boolean; args?: string[] } = {}) {
  let reads = 0;
  HOOK_IO.readStdin = async () => {
    reads++;
    return o.stdin ?? input(p, file);
  };
  const r = await cli(["validate", "--hook", ...(o.args ?? []), ...(o.json ? ["--json"] : [])], {
    cwd: o.cwd ?? p.root, ...(o.stdinTTY !== undefined ? { stdinTTY: o.stdinTTY } : {}),
  });
  return { ...r, reads };
}

describe("croft validate --hook: nothing to check", () => {
  test("an edit outside assets/ and lib/ exits 0 and prints nothing", async () => {
    const p = project({ "files/sales.csv": "a\n1\n", "assets/notes.md": "# notes\n" });
    for (const f of ["croft.json", "files/sales.csv", "CLAUDE.md", "assets/notes.md", "../elsewhere/assets/x.sql"]) {
      const r = await hook(p, f);
      expect({ f, exit: r.exit, stdout: r.stdout, stderr: r.stderr }).toEqual({ f, exit: 0, stdout: "", stderr: "" });
    }
  });

  test("hook input without a file (another event or tool) exits 0 and prints nothing", async () => {
    const p = project();
    const r = await hook(p, "", { stdin: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } }) });
    expect([r.exit, r.stdout, r.stderr]).toEqual([0, "", ""]);
  });

  test("a clean asset exits 0 and prints nothing, although another asset is broken", async () => {
    const p = project();
    const r = await hook(p, "assets/open_issues.sql");
    expect([r.exit, r.stdout, r.stderr]).toEqual([0, "", ""]);
    const whole = await cli(["validate", "--json"], { cwd: p.root });
    expect(whole.exit).toBe(2);                        // broken.sql: the full validate still reports it
  });

  test("warnings alone do not stop Claude: exit 0, silent (--json still carries them)", async () => {
    const p = project();
    const r = await hook(p, "assets/github_issues.ts");
    expect([r.exit, r.stdout, r.stderr]).toEqual([0, "", ""]);
    const j = await hook(p, "assets/github_issues.ts", { json: true });
    expect(j.exit).toBe(0);
    expect(j.json).toMatchObject({ ok: true, command: "validate", next: [] });
    expect(j.json.problems.map((x: { code: string }) => x.code)).toEqual(["SECRET_MISSING"]);
    expect(j.json.data.assets.map((a: { name: string }) => a.name)).toEqual(["github_issues"]);
  });
});

describe("croft validate --hook: problems go to Claude", () => {
  test("an error in the edited asset: exit 2, the problem with its fix on stderr, nothing on stdout", async () => {
    const p = project();
    writeFiles(p.root, { "assets/open_issues.sql": `SELECT id, titel, "user"->>'login' AS author FROM github_issues\n` });
    const r = await hook(p, "assets/open_issues.sql");
    expect(r.exit).toBe(2);
    expect(r.stdout).toBe("");
    const lines = r.stderr.trimEnd().split("\n");
    expect(lines[0]).toBe("croft validate --hook: 1 error after the edit to assets/open_issues.sql (also checked the assets that read it: by_author)");
    expect(r.stderr).toContain("error UNKNOWN_COLUMN  assets/open_issues.sql:1:12");
    expect(r.stderr).toContain("fix: replace titel with title on line 1");
    expect(r.stderr).not.toContain("broken.sql");
    expect(r.stderr).not.toContain("INPUT_NOT_BUILT");     // info (by_author waits on open_issues) is left out
    expect(r.stderr).not.toContain("\x1b[");
    expect(lines.at(-1)).toBe("Fix it, then carry on: croft checks each edit under assets/ and lib/ again.");
  });

  test("an SQL edit that breaks a reader: the reader's error, in the reader's file", async () => {
    const p = project();
    writeFiles(p.root, { "assets/open_issues.sql": `SELECT id, title, "user"->>'login' AS login FROM github_issues\n` });
    const r = await hook(p, "assets/open_issues.sql");
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("1 error after the edit to assets/open_issues.sql (also checked the assets that read it: by_author)");
    expect(r.stderr).toContain("error UNKNOWN_COLUMN  assets/by_author.sql:1:");
    expect(r.stderr).toContain(`Referenced column "author" not found`);
    const j = await hook(p, "assets/open_issues.sql", { json: true });
    expect(j.exit).toBe(2);
    expect(j.json.problems).toEqual([expect.objectContaining({ code: "UNKNOWN_COLUMN", asset: "by_author", file: "assets/by_author.sql" })]);
    expect(j.json.data.assets.map((a: { name: string }) => a.name)).toEqual(["open_issues", "by_author"]);
  });

  test("a syntax error in the edited asset", async () => {
    const p = project();
    const r = await hook(p, "assets/broken.sql");
    expect(r.exit).toBe(2);
    expect(r.stderr).toStartWith("croft validate --hook: 1 error after the edit to assets/broken.sql\n");
    expect(r.stderr).toContain("error SQL_SYNTAX  assets/broken.sql");
  });

  test("a file name that cannot be an asset name", async () => {
    const p = project({ "assets/Open-Bugs.sql": "SELECT 1 AS x\n" });
    const r = await hook(p, "assets/Open-Bugs.sql", { args: [] });
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("error NAME_INVALID  assets/Open-Bugs.sql");
    expect(r.stderr).toContain("open_bugs.sql");
  });

  test("a TS transform naming an input that is no asset", async () => {
    const p = project({
      "assets/enriched.ts": `import { transform } from "@zabaca/croft";\nexport default transform({ inputs: ["github_issue"], async *rows() { yield []; } });\n`,
    });
    const r = await hook(p, "assets/enriched.ts", { stdin: input(p, "assets/enriched.ts", "Write") });
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("error UNKNOWN_TABLE  assets/enriched.ts:2");
    expect(r.stderr).toContain("fix: replace github_issue with github_issues");
  });

  test("a lib/ file: the TS assets that import it are checked; a lib file nothing imports is silent", async () => {
    const p = project({
      "lib/fmt.ts": "export const label = (s: string) => s.toUpperCase();\n",
      "lib/unused.ts": "export const x = 1;\n",
      "assets/labelled.ts": `import { transform } from "@zabaca/croft";\nimport { label } from "../lib/fmt.ts";\nexport default transform({ inputs: ["github_issue"], async *rows() { yield { l: label("x") }; } });\n`,
    });
    const r = await hook(p, "lib/fmt.ts");
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("1 error after the edit to lib/fmt.ts (checked the assets that import it: labelled)");
    expect(r.stderr).toContain("error UNKNOWN_TABLE  assets/labelled.ts");
    const quiet = await hook(p, "lib/unused.ts");
    expect([quiet.exit, quiet.stdout, quiet.stderr]).toEqual([0, "", ""]);
  });

  test("a lib/ file that no longer compiles: the assets that fail to load on it are reported", async () => {
    const p = project({
      "lib/fmt.ts": "export const label = (s: string) => s.toUpperCase(;\n",
      "assets/labelled.ts": `import { transform } from "@zabaca/croft";\nimport { label } from "../lib/fmt.ts";\nexport default transform({ inputs: ["github_issues"], async *rows() { yield { l: label("x") }; } });\n`,
    });
    const r = await hook(p, "lib/fmt.ts");
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("(checked the assets that import it: labelled)");
    expect(r.stderr).toContain("error ASSET_INVALID  lib/fmt.ts:1:51");
    expect(r.stderr).toContain("assets/labelled.ts does not compile");
  });

  test("run from a folder inside the project, the edited file is still found", async () => {
    const p = project();
    writeFiles(p.root, { "assets/open_issues.sql": `SELECT id, titel FROM github_issues\n` });
    const r = await hook(p, "assets/open_issues.sql", { cwd: join(p.root, "assets") });
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("error UNKNOWN_COLUMN  assets/open_issues.sql:1:12");
  });

  test("a broken croft.json is reported for an asset edit (Claude can fix it)", async () => {
    const p = project();
    writeFileSync(join(p.root, "croft.json"), `{"database": 3}`);
    const r = await hook(p, "assets/open_issues.sql");
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("croft.json");
    const other = await hook(p, "files/a.csv");
    expect([other.exit, other.stderr]).toEqual([0, ""]);
  });
});

describe("croft validate --hook: usage, and croft's own failures", () => {
  // Exit 2 is kept for findings about the edited assets: Claude Code feeds it to Claude after the edit. croft's
  // own failures exit 1, which Claude Code shows the user as a non-blocking hook error.
  test("typed at a terminal: USAGE_ERROR pointing at croft validate, exit 1, and stdin is never read", async () => {
    const p = project();
    const r = await hook(p, "assets/open_issues.sql", { stdinTTY: true });
    expect(r.exit).toBe(1);
    expect(r.reads).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toStartWith("error USAGE_ERROR  croft validate --hook is what Claude Code's PostToolUse hook runs");
    expect(r.stderr).toContain("croft validate");
  });

  test("stdin that is not hook JSON, asset names, or --types alongside: USAGE_ERROR, exit 1", async () => {
    const p = project();
    const bad = await hook(p, "", { stdin: "hello", json: true });
    expect(bad.exit).toBe(1);
    expect(bad.json).toMatchObject({ ok: false, command: "validate" });
    expect(bad.json.problems[0]).toMatchObject({ code: "USAGE_ERROR", fix: { kind: "command", command: "croft validate" } });
    const human = await hook(p, "", { stdin: "hello" });
    expect([human.exit, human.stdout]).toEqual([1, ""]);
    expect(human.stderr).toStartWith("error USAGE_ERROR  croft validate --hook reads the JSON Claude Code sends");
    const named = await hook(p, "assets/open_issues.sql", { args: ["open_issues"], json: true });
    expect(named.exit).toBe(1);
    expect(named.json.problems[0]).toMatchObject({ code: "USAGE_ERROR", fix: { kind: "command", command: "croft validate open_issues" } });
    const types = await hook(p, "assets/open_issues.sql", { args: ["--types"], json: true });
    expect(types.exit).toBe(1);
    expect(types.json.problems[0]).toMatchObject({ code: "USAGE_ERROR", fix: { kind: "command", command: "croft validate --types" } });
  });

  test("stdin still open after the time limit (a pipe nobody closes): USAGE_ERROR, exit 1, instead of waiting", async () => {
    const p = project();
    let limit = 0;
    HOOK_IO.readStdin = async (ms: number) => { limit = ms; return null; };
    const r = await cli(["validate", "--hook"], { cwd: p.root });
    expect(limit).toBe(HOOK_IO.stdinTimeoutMs);
    expect([r.exit, r.stdout]).toEqual([1, ""]);
    expect(r.stderr).toStartWith("error USAGE_ERROR  croft validate --hook reads the JSON Claude Code sends a PostToolUse hook on stdin, and stdin was still open after 5 s");
    expect(r.stderr).toContain("fix: croft validate");
  });

  test("outside a croft project, stdin that is not hook JSON is still a usage error, exit 1", async () => {
    const p = project();
    const r = await hook(p, "", { stdin: "hello", cwd: dirname(p.root) });
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain("USAGE_ERROR");
  });
});

describe("croft validate --hook: the real hook command", () => {
  /** node_modules/.bin/croft as bun install links it. */
  function linkBin(root: string): void {
    const bin = join(root, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(join("..", "@zabaca", "croft", "bin", "croft.mjs"), join(bin, "croft"));
  }

  async function sh(command: string, o: { projectDir: string; cwd: string; stdin: string }) {
    const proc = Bun.spawn(["sh", "-c", command], {
      cwd: o.cwd, stdin: new TextEncoder().encode(o.stdin), stdout: "pipe", stderr: "pipe",
      env: {
        PATH: `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: process.env.HOME ?? "/tmp",
        TMPDIR: process.env.TMPDIR ?? "/tmp", CLAUDE_PROJECT_DIR: o.projectDir, CROFT_FORBID_OS_JOBS: "1", CROFT_NOTIFY_DRY: "1",
      },
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { exit, stdout, stderr };
  }

  test("sh -c with CLAUDE_PROJECT_DIR, from wherever Claude is: exit 2 with the problem on stderr, then 0 and silent", async () => {
    const p = project();
    linkBin(p.root);
    writeFiles(p.root, { "assets/open_issues.sql": `SELECT id, titel FROM github_issues\n` });
    const bad = await sh(hookCommand(), { projectDir: p.root, cwd: PKG, stdin: input(p, "assets/open_issues.sql") });
    expect(bad.stdout).toBe("");
    expect(bad.stderr).toContain("error UNKNOWN_COLUMN  assets/open_issues.sql:1:12");
    expect(bad.exit).toBe(2);

    writeFiles(p.root, { "assets/open_issues.sql": OPEN_SQL });
    const good = await sh(hookCommand(), { projectDir: p.root, cwd: PKG, stdin: input(p, "assets/open_issues.sql") });
    expect(good).toEqual({ exit: 0, stdout: "", stderr: "" });
    const other = await sh(hookCommand(), { projectDir: p.root, cwd: PKG, stdin: input(p, "CLAUDE.md") });
    expect(other).toEqual({ exit: 0, stdout: "", stderr: "" });
  }, 60_000);

  test("stdin a pipe that never closes: the process gives up after 5 s and exits 1 (it does not wait for the pipe)", async () => {
    const p = project();
    linkBin(p.root);
    const started = performance.now();
    const proc = Bun.spawn([process.execPath, "--no-env-file", join(p.root, "node_modules", ".bin", "croft"), "validate", "--hook"], {
      cwd: p.root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", CROFT_FORBID_OS_JOBS: "1", CROFT_NOTIFY_DRY: "1" },
    });
    const killer = setTimeout(() => proc.kill(), 30_000);
    const [stderr, exit] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(killer);
    const seconds = (performance.now() - started) / 1000;
    proc.stdin.end();
    expect(exit).toBe(1);
    expect(stderr).toContain("stdin was still open after 5 s");
    expect(seconds).toBeGreaterThanOrEqual(4.9);
    expect(seconds).toBeLessThan(20);
  }, 60_000);
});
