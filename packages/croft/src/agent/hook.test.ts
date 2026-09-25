import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CroftError } from "../core/errors.ts";
import type { Problem } from "../core/types.ts";
import { docs } from "../cli/commands/docs.ts";
import type { Ctx } from "../cli/command.ts";
import {
  HOOK_CONTEXT_MAX, HOOK_IO, HOOK_MATCHER, hookCommand, hookContext, hookOutput, hookPlaces, hookProblems, hookReport, hookSelection,
  hookPaths, hookSettings, hookTarget, installHook, mergeHookSettings, parseHookInput, readAll, SETTINGS_FILE, showPaths,
} from "./hook.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "croft-hook-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const d = join(base, `h${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};

/** PostToolUse input as Claude Code sends it for an edit (code.claude.com/docs/en/hooks, "PostToolUse input"). */
const edit = (file_path: string, o: { cwd?: string; tool?: string } = {}) => JSON.stringify({
  session_id: "abc123", transcript_path: "/tmp/t.jsonl", cwd: o.cwd ?? "/somewhere", permission_mode: "default",
  hook_event_name: "PostToolUse", tool_name: o.tool ?? "Edit",
  tool_input: { file_path, old_string: "a", new_string: "b" },
  tool_response: { filePath: file_path, success: true }, tool_use_id: "toolu_01",
});

// ---------------------------------------------------------------------------------------------------------

describe("the hook entry", () => {
  test("the project's pinned croft, started from the project folder (a data/ project from the app folder)", () => {
    const guard = "test -x ./node_modules/.bin/croft || exit 0; ./node_modules/.bin/croft validate --hook";
    expect(hookCommand()).toBe(`cd "$CLAUDE_PROJECT_DIR" && ${guard}`);
    expect(hookCommand("data")).toBe(`cd "$CLAUDE_PROJECT_DIR"/data && ${guard}`);
    expect(hookCommand("my data")).toBe(`cd "$CLAUDE_PROJECT_DIR"/'my data' && ${guard}`);
  });

  test("before bun install (no pinned croft), or with the project folder gone, the hook does nothing: exit 0, silent", async () => {
    const app = fresh();
    const project = join(app, "data");
    mkdirSync(project);
    for (const [dir, sub] of [[project, ""], [app, "data"], [app, "gone"]] as const) {
      const proc = Bun.spawn(["sh", "-c", hookCommand(sub)], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", CLAUDE_PROJECT_DIR: dir }, cwd: fresh(),
        stdin: new TextEncoder().encode(edit(join(project, "assets/x.sql"))), stdout: "pipe", stderr: "pipe",
      });
      const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect({ sub, exit, stdout }).toEqual({ sub, exit: 0, stdout: "" });
    }
  });

  test("no bun on the PATH Claude Code gives the hook (an app started from the Dock): exit 1, a one-line notice for the user, never 2", async () => {
    const PATH = "/usr/bin:/bin";
    if (Bun.which("bun", { PATH }) || Bun.which("node", { PATH })) return;       // a system-wide runtime
    const project = fresh();
    const bin = join(project, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(join(import.meta.dir, "..", "..", "bin", "croft.mjs"), join(bin, "croft"));
    const proc = Bun.spawn(["sh", "-c", hookCommand()], {
      env: { PATH, CLAUDE_PROJECT_DIR: project }, cwd: project,
      stdin: new TextEncoder().encode(edit(join(project, "README.md"))), stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(exit).toBe(1);
    expect(stdout).toBe("");
    // Claude Code shows the user the first line of stderr, prefixed with "Failed with non-blocking status code:".
    const first = stderr.split("\n")[0]!;
    expect(first).toStartWith("error NEEDS_BUN  croft validate --hook did not run: bun is not on the PATH");
    expect(stderr).toContain("~/.bun/bin");
  });

  test("a PostToolUse group for Edit|Write|MultiEdit with one command handler", () => {
    expect(HOOK_MATCHER).toBe("Edit|Write|MultiEdit");
    expect(hookSettings()).toEqual({
      hooks: { PostToolUse: [{ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: hookCommand(), timeout: 120 }] }] },
    });
    expect(hookSettings("data").hooks.PostToolUse[0]!.hooks[0]!.command).toBe(hookCommand("data"));
  });

  test("sh runs it: CLAUDE_PROJECT_DIR is honored with spaces in it, the pinned bin gets validate --hook and the hook's stdin", async () => {
    const app = join(fresh(), "An App");
    const project = join(app, "my data");
    const bin = join(project, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    // A stand-in for the pinned croft: it reports where it ran, what it was given and what stdin held, and exits 2.
    writeFileSync(join(bin, "croft"), `#!/bin/sh\necho "cwd=$(pwd -P)" >&2\necho "args=$*" >&2\necho "stdin=$(cat)" >&2\nexit 2\n`);
    chmodSync(join(bin, "croft"), 0o755);
    const proc = Bun.spawn(["sh", "-c", hookCommand("my data")], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", CLAUDE_PROJECT_DIR: app }, cwd: fresh(),
      stdin: new TextEncoder().encode('{"tool_name":"Edit"}'), stdout: "pipe", stderr: "pipe",
    });
    const [stderr, exit] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(exit).toBe(2);
    expect(stderr.split("\n")).toEqual([`cwd=${realpathSync(project)}`, "args=validate --hook", `stdin={"tool_name":"Edit"}`, ""]);
  });
});

describe("mergeHookSettings", () => {
  const ours = () => hookSettings().hooks.PostToolUse[0]!;

  test("no file: the hook alone, two-space JSON ending in a newline", () => {
    const r = mergeHookSettings(null);
    expect(r).toMatchObject({ ok: true, action: "created" });
    if (!r.ok) throw new Error("refused");
    expect(JSON.parse(r.text)).toEqual(hookSettings());
    expect(r.text).toBe(`${JSON.stringify(hookSettings(), null, 2)}\n`);
  });

  test("an existing file keeps every setting and hook it has; ours is appended as its own group", () => {
    const user = {
      permissions: { ask: ["Bash(croft confirm:*)"], deny: ["Read(./.env)"] },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] }],
        PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "prettier --write" }] }],
      },
      model: "opus",
    };
    const r = mergeHookSettings(JSON.stringify(user, null, 2));
    expect(r).toMatchObject({ ok: true, action: "merged" });
    if (!r.ok) throw new Error("refused");
    const merged = JSON.parse(r.text);
    expect(merged).toEqual({ ...user, hooks: { ...user.hooks, PostToolUse: [...user.hooks.PostToolUse, ours()] } });
    expect(Object.keys(merged)).toEqual(["permissions", "hooks", "model"]);
  });

  test("settings without hooks, or hooks without PostToolUse, gain them", () => {
    const a = mergeHookSettings(`{"permissions":{"allow":[]}}`);
    if (!a.ok) throw new Error("refused");
    expect(JSON.parse(a.text)).toEqual({ permissions: { allow: [] }, ...hookSettings() });
    const b = mergeHookSettings(`{"hooks":{"Stop":[]}}`);
    if (!b.ok) throw new Error("refused");
    expect(JSON.parse(b.text)).toEqual({ hooks: { Stop: [], PostToolUse: [ours()] } });
  });

  test("idempotent: a second merge changes nothing, byte for byte", () => {
    const once = mergeHookSettings(`{\n  "model": "opus"\n}\n`);
    if (!once.ok) throw new Error("refused");
    const twice = mergeHookSettings(once.text);
    expect(twice).toEqual({ ok: true, action: "unchanged", text: once.text, note: expect.any(String) });
  });

  test("a croft validate --hook handler written another way is kept, not doubled or rewritten", () => {
    const text = JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "croft validate --hook" }] }] } });
    const r = mergeHookSettings(text);
    expect(r).toMatchObject({ ok: true, action: "unchanged", text });
    if (!r.ok) throw new Error("refused");
    expect(r.note).toContain("croft validate --hook");
  });

  test("the file's indentation is kept (four spaces, tabs)", () => {
    const four = mergeHookSettings(`{\n    "model": "opus"\n}\n`);
    if (!four.ok) throw new Error("refused");
    expect(four.text).toStartWith(`{\n    "model": "opus",\n    "hooks": {\n        "PostToolUse": [`);
    const tabs = mergeHookSettings(`{\n\t"model": "opus"\n}`);
    if (!tabs.ok) throw new Error("refused");
    expect(tabs.text).toStartWith(`{\n\t"model": "opus",\n\t"hooks": {\n\t\t"PostToolUse": [`);
  });

  test("an empty file, and one starting with a byte-order mark, are read as settings", () => {
    const empty = mergeHookSettings("  \n");
    expect(empty).toMatchObject({ ok: true, action: "merged" });
    if (!empty.ok) throw new Error("refused");
    expect(JSON.parse(empty.text)).toEqual(hookSettings());
    const bom = mergeHookSettings(`﻿{"model":"opus"}`);
    if (!bom.ok) throw new Error("refused");
    expect(JSON.parse(bom.text)).toEqual({ model: "opus", ...hookSettings() });
  });

  test("refused, with the reason, when the file is not settings croft can merge into", () => {
    expect(mergeHookSettings(`{"model": "opus",}`)).toMatchObject({ ok: false, reason: expect.stringContaining("not valid JSON") });
    expect(mergeHookSettings(`// comment\n{}`)).toMatchObject({ ok: false, reason: expect.stringContaining("not valid JSON") });
    expect(mergeHookSettings(`[]`)).toMatchObject({ ok: false, reason: expect.stringContaining("not a JSON object") });
    expect(mergeHookSettings(`{"hooks": []}`)).toMatchObject({ ok: false, reason: expect.stringContaining(`"hooks" is not an object`) });
    expect(mergeHookSettings(`{"hooks": {"PostToolUse": {}}}`)).toMatchObject({ ok: false, reason: expect.stringContaining(`"hooks.PostToolUse" is not a list`) });
  });
});

describe("installHook", () => {
  test("where Claude Code may start: the project, and the app around a data/ project", () => {
    expect(hookPlaces("/w/p", "/w/p")).toEqual([{ dir: "/w/p", sub: "" }]);
    expect(hookPlaces("/w/app/data", "/w/app")).toEqual([{ dir: "/w/app/data", sub: "" }, { dir: "/w/app", sub: "data" }]);
  });

  test("writes each settings file, reports it as a file change, and a second install changes nothing", () => {
    const app = fresh();
    const root = join(app, "data");
    mkdirSync(join(app, ".claude"), { recursive: true });
    writeFileSync(join(app, SETTINGS_FILE), `{\n  "permissions": {\n    "ask": ["Bash(croft confirm:*)"]\n  }\n}\n`);
    const first = installHook(root, app);
    expect(first.problems).toEqual([]);
    expect(first.files).toEqual([
      { path: `data/${SETTINGS_FILE}`, action: "created", note: expect.stringContaining("croft validate --hook") },
      { path: SETTINGS_FILE, action: "merged", note: expect.stringContaining("croft validate --hook") },
    ]);
    expect(JSON.parse(readFileSync(join(root, SETTINGS_FILE), "utf8"))).toEqual(hookSettings());
    const appSettings = JSON.parse(readFileSync(join(app, SETTINGS_FILE), "utf8"));
    expect(appSettings.permissions).toEqual({ ask: ["Bash(croft confirm:*)"] });
    expect(appSettings.hooks).toEqual(hookSettings("data").hooks);

    const before = readFileSync(join(app, SETTINGS_FILE), "utf8");
    const second = installHook(root, app);
    expect(second.files.map((f) => f.action)).toEqual(["unchanged", "unchanged"]);
    expect(readFileSync(join(app, SETTINGS_FILE), "utf8")).toBe(before);
  });

  test("a settings file croft cannot read is left as it is: a skipped file and a problem with the snippet", () => {
    const root = fresh();
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, SETTINGS_FILE), `{"model": "opus",}`);
    const r = installHook(root, root);
    expect(r.files).toEqual([{ path: SETTINGS_FILE, action: "skipped", note: expect.stringContaining("not valid JSON") }]);
    expect(readFileSync(join(root, SETTINGS_FILE), "utf8")).toBe(`{"model": "opus",}`);
    expect(r.problems).toHaveLength(1);
    const p = r.problems[0]!;
    expect(p).toMatchObject({ severity: "error", code: "USAGE_ERROR", file: SETTINGS_FILE, fix: { kind: "manual" } });
    expect(p.message).toContain("the hook was not added");
    expect(p.hint).toContain("croft init --claude --with-hook");
    expect(p.fix!.description).toContain(JSON.stringify(hookSettings()));
  });
});

describe("hookTarget", () => {
  const project = () => {
    const root = fresh();
    for (const d of ["assets/sub", "lib", "files"]) mkdirSync(join(root, d), { recursive: true });
    return root;
  };

  test("an asset file or a lib/ file, relative to the project root", () => {
    const root = project();
    expect(hookTarget(edit(join(root, "assets/orders.sql")), root)).toBe("assets/orders.sql");
    expect(hookTarget(edit(join(root, "assets/sub/charges.ts"), { tool: "Write" }), root)).toBe("assets/sub/charges.ts");
    expect(hookTarget(edit(join(root, "lib/money.ts"), { tool: "MultiEdit" }), root)).toBe("lib/money.ts");
    expect(hookTarget(edit(join(root, "lib/rates.json")), root)).toBe("lib/rates.json");
  });

  test("null for anything else: other folders, other files in assets/, other projects", () => {
    const root = project();
    for (const f of ["croft.json", "files/sales.csv", "CLAUDE.md", "assets/README.md", "assets/types.d.ts", "assetsx/a.sql"]) {
      expect(hookTarget(edit(join(root, f)), root), f).toBeNull();
    }
    expect(hookTarget(edit(join(fresh(), "assets/orders.sql")), root)).toBeNull();
    expect(hookTarget(edit(join(dirname(root), "assets/orders.sql")), root)).toBeNull();
  });

  test("a relative path is read from the hook's cwd; a symlinked project folder still matches", () => {
    const root = project();
    expect(hookTarget(edit("assets/orders.sql", { cwd: root }), root)).toBe("assets/orders.sql");
    expect(hookTarget(edit("../assets/orders.sql", { cwd: join(root, "lib") }), root)).toBe("assets/orders.sql");
    const link = join(fresh(), "link");
    symlinkSync(root, link);
    writeFileSync(join(root, "assets/orders.sql"), "SELECT 1 AS x\n");
    expect(hookTarget(edit(join(link, "assets/orders.sql")), root)).toBe("assets/orders.sql");
    expect(hookTarget(edit(join(root, "assets/orders.sql")), link)).toBe("assets/orders.sql");
    expect(hookTarget(edit(join(link, "assets/new_one.sql")), root)).toBe("assets/new_one.sql");
  });

  test("hookPaths: files named from where Claude works (the input's cwd); showPaths renames a problem's files", () => {
    const app = fresh();
    const root = join(app, "data");
    mkdirSync(join(root, "assets"), { recursive: true });
    expect(hookPaths(root, root)("assets/x.sql")).toBe("assets/x.sql");
    expect(hookPaths(root, app)("assets/x.sql")).toBe("data/assets/x.sql");
    expect(hookPaths(root, join(root, "assets"))("assets/x.sql")).toBe("x.sql");
    expect(hookPaths(root, join(root, "assets"))("lib/fmt.ts")).toBe("../lib/fmt.ts");
    expect(hookPaths(root, fresh())("assets/x.sql")).toBe(join(root, "assets", "x.sql"));
    expect(hookPaths(root, undefined)("assets/x.sql")).toBe("assets/x.sql");
    expect(hookPaths(root, "relative/cwd")("assets/x.sql")).toBe("assets/x.sql");
    // A symlinked spelling of the same folders (macOS: /var is /private/var).
    const link = join(fresh(), "link");
    symlinkSync(app, link);
    expect(hookPaths(root, link)("assets/x.sql")).toBe("data/assets/x.sql");

    const p = { severity: "error" as const, code: "UNKNOWN_COLUMN", message: "m", hint: "h", docs: "d", file: "assets/x.sql", line: 2,
      fix: { kind: "edit" as const, description: "d", file: "assets/y.sql" } };
    expect(showPaths([p, { ...p, file: undefined, fix: undefined }], hookPaths(root, app))).toEqual([
      { ...p, file: "data/assets/x.sql", fix: { ...p.fix, file: "data/assets/y.sql" } },
      { ...p, file: undefined, fix: undefined },
    ]);
  });

  test("input without a file path (another tool or event) is nothing to check", () => {
    const root = project();
    expect(hookTarget(JSON.stringify({ hook_event_name: "Stop" }), root)).toBeNull();
    expect(hookTarget(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }), root)).toBeNull();
    expect(parseHookInput(JSON.stringify({ tool_response: { filePath: "/x/assets/a.sql" } })).file).toBe("/x/assets/a.sql");
  });

  test("readAll: all of a stream that closes; null, promptly, for one still open at the deadline", async () => {
    const bytes = new TextEncoder().encode(edit("/p/assets/é.sql"));
    const split = bytes.indexOf(0xc3) + 1;                                   // inside the two bytes of "é"
    const closed = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.slice(0, split)); c.enqueue(bytes.slice(split)); c.close(); } });
    expect(await readAll(closed, 1000)).toBe(edit("/p/assets/é.sql"));
    let canceled = false;
    const open = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.slice(0, 5)); }, cancel() { canceled = true; } });
    const t0 = performance.now();
    expect(await readAll(open, 50)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(canceled).toBe(true);                                             // the read is given up, so the process can exit
    expect(HOOK_IO.stdinTimeoutMs).toBe(5000);
  });

  test("stdin that is not a hook's JSON is USAGE_ERROR, with a hint and a fix", () => {
    for (const text of ["", "not json", "[1,2]", "null"]) {
      let err: unknown;
      try {
        parseHookInput(text);
      } catch (e) {
        err = e;
      }
      expect(err, text).toBeInstanceOf(CroftError);
      const p = (err as CroftError).problem;
      expect(p.code).toBe("USAGE_ERROR");
      expect(p.message).toContain("stdin");
      expect(p.hint).toBeTruthy();
      expect(p.fix).toMatchObject({ kind: "command", command: "croft validate" });
    }
  });
});

describe("what an edit affects, and what Claude reads", () => {
  const p = (o: Partial<Problem> & Pick<Problem, "severity" | "code">): Problem => ({ message: "m", hint: "h", docs: `croft docs ${o.code}`, ...o });
  const graph = { downstream: (names: readonly string[]) => (names.includes("orders") ? ["daily", "weekly"] : []) };

  test("hookSelection: SQL with everything downstream, TS alone, lib/ by the TS assets that import it or fail on it", () => {
    const assets = [
      { name: "orders", file: "assets/orders.sql", kind: "sql" },
      { name: "daily", file: "assets/daily.sql", kind: "sql" },
      { name: "weekly", file: "assets/weekly.ts", kind: "transform", ts: { localFiles: ["assets/weekly.ts", "lib/money.ts"] } },
      { name: "charges", file: "assets/charges.ts", kind: "ingest", ts: { localFiles: ["assets/charges.ts"] } },
      { name: "broken", file: "assets/broken.ts", kind: "transform", ok: false, ts: { localFiles: ["assets/broken.ts"] },
        problems: [p({ severity: "error", code: "ASSET_INVALID", file: "lib/money.ts", message: "assets/broken.ts does not compile" })] },
    ];
    expect(hookSelection({ assets, graph }, "assets/orders.sql")).toEqual(["orders", "daily", "weekly"]);
    expect(hookSelection({ assets, graph }, "assets/charges.ts")).toEqual(["charges"]);
    expect(hookSelection({ assets, graph }, "lib/money.ts")).toEqual(["weekly", "broken"]);
    expect(hookSelection({ assets, graph }, "lib/unused.ts")).toEqual([]);
  });

  test("hookProblems: errors and warnings of what was checked, and of the edited file; never info", () => {
    const list = [
      p({ severity: "error", code: "UNKNOWN_COLUMN", asset: "daily" }),
      p({ severity: "warning", code: "SECRET_MISSING", asset: "orders" }),
      p({ severity: "info", code: "INPUT_NOT_BUILT", asset: "orders" }),
      p({ severity: "error", code: "SQL_SYNTAX", asset: "elsewhere" }),
      p({ severity: "error", code: "NAME_INVALID", file: "assets/Bad.sql" }),
      p({ severity: "error", code: "NAME_INVALID", file: "assets/Other.sql" }),
      p({ severity: "error", code: "CYCLE" }),
    ];
    expect(hookProblems(list, new Set(["orders", "daily"]), "assets/Bad.sql").map((x) => x.code))
      .toEqual(["UNKNOWN_COLUMN", "SECRET_MISSING", "NAME_INVALID", "CYCLE"]);
  });

  test("hookReport: what was found, what was checked besides the edit, each problem, what to do", () => {
    const two = [p({ severity: "error", code: "A" }), p({ severity: "error", code: "B" }), p({ severity: "warning", code: "C" })];
    expect(hookReport({ target: "assets/orders.sql", asset: "orders", selected: ["orders", "daily"], problems: two, formatted: "<problems>" }).split("\n")).toEqual([
      "croft validate --hook: 2 errors, 1 warning after the edit to assets/orders.sql (also checked the assets that read it: daily)",
      "<problems>",
      "Fix them, then carry on: croft checks each edit under assets/ and lib/ again.",
    ]);
    expect(hookReport({ target: "lib/money.ts", asset: null, selected: ["weekly"], problems: two.slice(0, 1), formatted: "x" }))
      .toStartWith("croft validate --hook: 1 error after the edit to lib/money.ts (checked the assets that import it: weekly)\n");
    expect(hookReport({ target: "assets/Bad.sql", asset: null, selected: [], problems: two.slice(0, 1), formatted: "x" }))
      .toStartWith("croft validate --hook: 1 error after the edit to assets/Bad.sql\n");
  });

  test("hookContext and hookOutput: warnings for Claude as PostToolUse additionalContext, under Claude Code's cap", () => {
    const warn = (code: string) => p({ severity: "warning", code });
    const one = hookContext({ target: "assets/paid.ts", asset: "paid", selected: ["paid"], problems: [warn("TRANSFORM_MAKES_REQUESTS")], formatted: ["<w1>"] });
    expect(one.split("\n")).toEqual([
      "croft validate --hook: 1 warning after the edit to assets/paid.ts",
      "<w1>",
      "A warning does not stop the edit or croft run; it says what the asset will cost or risk as written.",
    ]);
    expect(JSON.parse(hookOutput(one))).toEqual({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: one } });
    expect(hookOutput(one)).not.toContain("\n");

    const many = Array.from({ length: 50 }, (_, i) => warn(`W${i}`));
    const formatted = many.map((_, i) => `warn  W${i}  ${"x".repeat(400)}`);
    const text = hookContext({ target: "assets/orders.sql", asset: "orders", selected: ["orders", "daily"], problems: many, formatted });
    expect(text.length).toBeLessThanOrEqual(HOOK_CONTEXT_MAX);
    const lines = text.split("\n");
    expect(lines[0]).toBe("croft validate --hook: 50 warnings after the edit to assets/orders.sql (also checked the assets that read it: daily)");
    const shown = lines.filter((l) => l.startsWith("warn  ")).length;
    expect(shown).toBeGreaterThan(10);
    expect(lines.at(-2)).toBe(`... and ${50 - shown} more warnings; croft validate lists them all`);
    expect(lines.at(-1)).toBe("Warnings do not stop the edit or croft run; each says what its asset will cost or risk as written.");
  });
});

describe("croft docs claude-permissions", () => {
  test("says what the opt-in hook does, how to add it and how to remove it", async () => {
    const r = await docs.run({ positionals: ["claude-permissions"], values: {} } as unknown as Ctx);
    const page = (r.data as { page: string }).page;
    for (const t of ["croft init --claude --with-hook", "croft validate --hook", "PostToolUse", HOOK_MATCHER, hookCommand(), "exit code 2"]) {
      expect(page, t).toContain(t);
    }
    expect(page).not.toContain("It never\nwrites .claude/settings.json");
    expect(existsSync(join(import.meta.dir, "docs", "claude-permissions.md"))).toBe(true);
  });
});
