import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError, problem } from "../core/errors.ts";
import { systemTimeZone } from "../core/time.ts";
import type { Envelope } from "../core/types.ts";
import { type Command, lazyCommand } from "./command.ts";
import { COMMANDS } from "./commands/index.ts";
import { type Dispatch, dispatchOf, main, scanArgv, shellQuote, trimStack, type MainIO } from "./main.ts";
import { CROFT_VERSION, versionAtLeast } from "./version.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "croft-main-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;

function dir(files: Record<string, string> = {}): string {
  const d = join(base, `d${n++}`);
  mkdirSync(d, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(d, name), text);
  return d;
}

const outside = dir();
const PROJECT = JSON.stringify({ database: "warehouse.duckdb", timezone: "Asia/Tokyo" });

async function run(argv: string[], io: MainIO = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const exit = await main(argv, {
    cwd: outside, env: {}, stdinTTY: false, stdoutTTY: false, stderrTTY: false,
    stdout: (t) => out.push(t), stderr: (t) => err.push(t), ...io,
  });
  return { exit, stdout: out.join(""), stderr: err.join(""), writes: out.length };
}

// Parsed loosely: tests index into problems[] and data freely.
function envelope(stdout: string): Envelope<any> & { problems: any[]; confirmation?: any } {
  return JSON.parse(stdout);
}

/** Test commands that exercise every path through main. */
function testCommand(name: string, run: Command["run"], extra: Partial<Command> = {}): Command {
  return { name, summary: `test ${name}`, usage: `croft ${name}`, options: {}, run, ...extra };
}
const THROWS_BUSY = testCommand("busy", async () => {
  throw new CroftError("DB_BUSY", { message: "held by run r_1", hint: "wait", retryable: true });
});
const NEEDS_CONFIRM = testCommand("shrink", async () => ({
  data: null, problems: [], next: [],
  confirmation: { token: "c_1", expiresAt: "2026-09-22T11:55:00-07:00", command: "croft confirm c_1",
    impact: { asset: "t", action: "replace", rows: 265, downstream: [] } },
}));
const CHECKS_FAIL = testCommand("checks", async () => ({
  data: null, next: [], problems: [problem("CHECK_FAILED", { message: "unique(id): 2 rows", hint: "fix the data" })],
}));
const CRASHES = testCommand("crash", async () => { throw new TypeError("cannot read properties of undefined"); });
const OVERRIDE = testCommand("health", async () => ({ data: { healthy: false }, problems: [], next: [], exit: 1 }));
const USES_PROJECT = testCommand("proj", async (ctx) => ({
  data: { root: ctx.project.root, tz: ctx.project.timezone, now: ctx.now().toISOString() }, problems: [], next: [],
}));
const LEAKY = testCommand("leak", async (ctx) => {
  ctx.render.out("progress with supersecret123");
  return {
    data: { token: "supersecret123", level: "info" }, next: [{ command: "croft run x", reason: "because" }],
    problems: [problem("INPUT_NOT_BUILT", { message: "saw supersecret123 at info level", hint: "h", fix: { kind: "manual", description: "d" } })],
  };
});
const WITH_OPTS = testCommand("opts", async (ctx) => ({ data: { values: ctx.values, positionals: ctx.positionals }, problems: [], next: [] }), {
  options: { rows: { type: "string", description: "rows", value: "N" }, list: { type: "boolean", description: "list" } },
});
const ALL = [...COMMANDS, THROWS_BUSY, NEEDS_CONFIRM, CHECKS_FAIL, CRASHES, OVERRIDE, USES_PROJECT, LEAKY, WITH_OPTS,
  testCommand("status", async () => ({ data: null, problems: [], next: [] }))];

describe("JSON mode", () => {
  test("prints exactly one envelope line on stdout and nothing on stderr", async () => {
    const r = await run(["version", "--json"]);
    expect(r.exit).toBe(0);
    expect(r.writes).toBe(1);
    expect(r.stdout.endsWith("\n")).toBe(true);
    expect(r.stdout.trimEnd()).not.toContain("\n");
    expect(r.stderr).toBe("");
  });

  test("golden envelope shape outside a project", async () => {
    const env = envelope((await run(["--json", "--version"])).stdout);
    expect(Object.keys(env)).toEqual([
      "schemaVersion", "ok", "command", "croftVersion", "database", "timezone", "durationMs", "data", "problems", "next",
    ]);
    expect({ ...env, durationMs: 0 }).toEqual({
      schemaVersion: 1, ok: true, command: "version", croftVersion: CROFT_VERSION, database: "", timezone: systemTimeZone(),
      durationMs: 0, data: { version: CROFT_VERSION, bun: Bun.version, platform: `${process.platform}-${process.arch}` },
      problems: [], next: [],
    });
    expect(env.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(env.durationMs)).toBe(true);
  });

  test("inside a project the envelope carries its database and time zone", async () => {
    const root = dir({ "croft.json": PROJECT });
    mkdirSync(join(root, "assets"));
    const env = envelope((await run(["version", "--json"], { cwd: join(root, "assets") })).stdout);
    expect(env.database).toBe("warehouse.duckdb");
    expect(env.timezone).toBe("Asia/Tokyo");
  });

  test("human text a command writes in JSON mode goes to stderr", async () => {
    const root = dir({ "croft.json": PROJECT });
    const r = await run(["leak", "--json"], { cwd: root, commands: ALL });
    expect(r.writes).toBe(1);
    expect(r.stderr).toContain("progress with");
  });
});

describe("exit codes", () => {
  const cases: [string[], number][] = [
    [["version"], 0],
    [["docs", "--list", "--json"], 0],
    [["nope"], 2],
    [["docs", "no-such-topic"], 2],
    [["busy"], 4],
    [["shrink"], 5],
    [["checks"], 3],
    [["crash"], 1],
    [["health"], 1],
  ];
  for (const [argv, code] of cases) {
    test(`croft ${argv.join(" ")} exits ${code}`, async () => {
      expect((await run(argv, { commands: ALL })).exit).toBe(code);
    });
  }

  test("a CroftError becomes its problem, with ok false and data null", async () => {
    const env = envelope((await run(["busy", "--json"], { commands: ALL })).stdout);
    expect(env.ok).toBe(false);
    expect(env.data).toBeNull();
    expect(env.problems).toEqual([{
      severity: "error", code: "DB_BUSY", message: "held by run r_1", hint: "wait", docs: "croft docs DB_BUSY", retryable: true,
    }]);
  });

  test("a pending confirmation is ok with exit 5 and the confirmation in the envelope", async () => {
    const r = await run(["shrink", "--json"], { commands: ALL });
    const env = envelope(r.stdout);
    expect(r.exit).toBe(5);
    expect(env.ok).toBe(true);
    expect(env.confirmation.token).toBe("c_1");
    expect(env.next).toEqual([]);
  });

  test("any other error is INTERNAL_ERROR with a trimmed stack", async () => {
    const r = await run(["crash", "--json"], { commands: ALL });
    const p = envelope(r.stdout).problems[0];
    expect(p.code).toBe("INTERNAL_ERROR");
    expect(p.message).toBe("TypeError: cannot read properties of undefined");
    expect(p.details.stack.length).toBeGreaterThan(0);
    expect(p.details.stack.length).toBeLessThanOrEqual(8);
    for (const frame of p.details.stack) {
      expect(frame.startsWith("at ")).toBe(true);
      expect(frame).not.toMatch(/node:|bun:|native/);
    }
    expect(p.details.stack.some((f: string) => f.includes("croft/src/cli/main.test.ts"))).toBe(true);
  });

  test("data that cannot be serialized becomes INTERNAL_ERROR, still one envelope", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const r = await run(["cycle", "--json"], { commands: [testCommand("cycle", async () => ({ data: [cyclic], problems: [], next: [] }))] });
    expect(r.exit).toBe(1);
    expect(r.writes).toBe(1);
    expect(envelope(r.stdout).problems[0].code).toBe("INTERNAL_ERROR");
  });

  test("BUN_TOO_OLD on an old Bun", async () => {
    const r = await run(["version", "--json"], { bunVersion: "1.2.20" });
    expect(r.exit).toBe(2);
    expect(envelope(r.stdout).problems[0]).toMatchObject({ code: "BUN_TOO_OLD", hint: "run bun upgrade" });
  });
});

describe("usage errors", () => {
  test("an unknown command suggests the closest one and keeps the other arguments", async () => {
    const r = await run(["stauts", "--json", "it's"], { commands: ALL });
    expect(r.exit).toBe(2);
    const p = envelope(r.stdout).problems[0];
    expect(p).toMatchObject({
      code: "USAGE_ERROR", message: 'unknown command "stauts"', hint: 'did you mean "croft status"?',
      fix: { kind: "command", command: "croft status --json 'it'\\''s'" },
      details: { command: "stauts", suggestion: "status" },
    });
  });

  test("with nothing close, the fix is croft help", async () => {
    const p = envelope((await run(["frobnicate", "--json"])).stdout).problems[0];
    expect(p.hint).toBe("croft help lists every command");
    expect(p.fix).toEqual({ kind: "command", description: "list the commands", command: "croft help" });
  });

  test("human mode prints the problem block on stderr and nothing on stdout", async () => {
    const r = await run(["dcos"]);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe('error USAGE_ERROR  unknown command "dcos"\n      fix: croft docs\n');
  });

  test("unknown options get a did-you-mean and a corrected command", async () => {
    const r = await run(["opts", "--lsit", "--rows=5"], { commands: ALL });
    expect(r.exit).toBe(2);
    expect(r.stderr).toBe([
      "error USAGE_ERROR  croft opts has no option --lsit",
      "      hint: did you mean --list?",
      "      fix: croft opts --list --rows=5",
      "",
    ].join("\n"));
  });

  test("missing option values, flags given values, and extra arguments", async () => {
    expect((await run(["opts", "--rows"], { commands: ALL })).stderr).toContain("--rows needs a value");
    expect((await run(["opts", "--list=yes"], { commands: ALL })).stderr).toContain("--list does not take a value");
    const extra = await run(["version", "extra", "--json"]);
    expect(extra.exit).toBe(2);
    expect(envelope(extra.stdout).problems[0].message).toBe('croft version takes no arguments; got "extra"');
    const docs = envelope((await run(["docs", "a", "b", "--json"])).stdout).problems[0];
    expect(docs.message).toBe('croft docs takes at most 1 argument; "b" is extra');
  });

  test("a string option takes a value that starts with a dash (-90d, -5) unless it is one of the command's flags", async () => {
    const values = async (argv: string[]) => envelope((await run(["--json", ...argv], { commands: ALL })).stdout);
    expect((await values(["opts", "--rows", "-5", "a"])).data).toEqual({ values: { rows: "-5", json: true }, positionals: ["a"] });
    expect((await values(["opts", "--rows=-5"])).data.values).toEqual({ rows: "-5", json: true });
    expect((await values(["opts", "--rows", "-"])).data.values).toEqual({ rows: "-", json: true });
    // A known flag is not swallowed as the value, and -- still ends the options.
    expect((await values(["opts", "--rows", "--list"])).problems[0].message).toBe("--rows needs a value");
    expect((await values(["opts", "--rows", "-h"])).command).toBe("help");
    expect((await values(["opts", "--", "--rows", "-5"])).data).toEqual({ values: { json: true }, positionals: ["--rows", "-5"] });
    // An unknown dashed word after a boolean stays an unknown option.
    expect((await values(["opts", "--list", "-5"])).problems[0].message).toBe("croft opts has no option -5");
  });

  test("croft run x --from -90d and --from=-90d both parse (DESIGN §8)", async () => {
    const spec = COMMANDS.find((c) => c.name === "run")!;
    const echo: Command = { ...spec, load: undefined, run: async (ctx) => ({ data: { values: ctx.values, positionals: ctx.positionals }, problems: [], next: [] }) };
    for (const argv of [["run", "x", "--from", "-90d"], ["run", "x", "--from=-90d"], ["run", "--from", "-12h", "x"]]) {
      const env = envelope((await run([...argv, "--json"], { commands: [echo] })).stdout);
      expect(env.ok).toBe(true);
      expect(env.data.values.from).toBe(argv.includes("-12h") ? "-12h" : "-90d");
      expect(env.data.positionals).toEqual(["x"]);
    }
    const missing = envelope((await run(["run", "x", "--from", "--foreground", "--json"], { commands: [echo] })).stdout);
    expect(missing.problems[0]).toMatchObject({ code: "USAGE_ERROR", message: "--from needs a value" });
  });

  test("hidden options parse but stay out of help and did-you-mean", async () => {
    const hidden = testCommand("hid", async (ctx) => ({ data: ctx.values, problems: [], next: [] }), {
      options: {
        rows: { type: "string", description: "rows", value: "N" },
        "child-id": { type: "string", hidden: true, description: "set by croft" },
      },
    });
    const cmds = [...COMMANDS, hidden];
    expect(envelope((await run(["hid", "--child-id", "c_123456", "--json"], { commands: cmds })).stdout).data)
      .toEqual({ "child-id": "c_123456", json: true });
    const help = envelope((await run(["help", "hid", "--json"], { commands: cmds })).stdout);
    expect(help.data.command.options.map((o: { flag: string }) => o.flag)).toEqual(["--rows"]);
    const typo = envelope((await run(["hid", "--child-i", "x", "--json"], { commands: cmds })).stdout).problems[0];
    expect(typo.hint).toBe("croft hid --help lists its options");
    expect(typo.details).toEqual({ option: "--child-i" });
    // The real commands: run's --run-id and --detached are hidden.
    const runHelp = envelope((await run(["help", "run", "--json"])).stdout).data.command.options.map((o: { flag: string }) => o.flag);
    expect(runHelp).toContain("--from");
    for (const f of ["--run-id", "--detached", "--confirm-token"]) expect(runHelp).not.toContain(f);
    expect((await run(["help", "run"])).stdout).not.toContain("confirm-token");
  });

  test("no command line carries a confirmation token: run has no --confirm-token (§6)", async () => {
    for (const argv of [["run", "x", "--allow-shrink", "--confirm-token", "c_123456"], ["run", "x", "--allow-shrink", "--confirm-token=c_123456"]]) {
      const r = await run([...argv, "--json"]);
      expect(r.exit).toBe(2);
      const p = envelope(r.stdout).problems[0];
      expect(p).toMatchObject({ code: "USAGE_ERROR", message: "croft run has no option --confirm-token", details: { option: "--confirm-token" } });
      expect(p.hint).toBe("croft run --help lists its options");
    }
  });

  test("the Dispatch reaches a command only when croft runs it itself, never from argv; it gets the result back", async () => {
    const seen: (Dispatch | undefined)[] = [];
    const d = testCommand("disp", async (ctx) => {
      seen.push(dispatchOf(ctx));
      return { data: { done: true }, problems: [], next: [] };
    });
    const dispatch: Dispatch = { confirmToken: "c_123456" };
    expect((await run(["disp", "--json"], { commands: [d], dispatch })).exit).toBe(0);
    expect((await run(["disp", "--json"], { commands: [d] })).exit).toBe(0);
    expect(seen).toEqual([dispatch, undefined]);
    expect(dispatch.result).toMatchObject({ data: { done: true } });
    const failing: Dispatch = { confirmToken: "c_123456" };
    expect((await run(["busy", "--json"], { commands: [THROWS_BUSY], dispatch: failing })).exit).toBe(4);
    expect(failing.result).toBeUndefined();
  });

  test("options and positionals reach the command; global flags work anywhere", async () => {
    const env = envelope((await run(["--json", "opts", "--rows", "5", "a", "--list", "--", "--json"], { commands: ALL })).stdout);
    expect(env.data).toEqual({ values: { rows: "5", list: true, json: true }, positionals: ["a", "--json"] });
  });
});

describe("help and version", () => {
  test("bare croft lists commands", async () => {
    const r = await run([]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("Usage: croft <command> [options]");
    // The column width follows the longest registered command name.
    expect(r.stdout).toMatch(/^  docs +offline docs/m);
  });

  test("help --json lists every registered command", async () => {
    const env = envelope((await run(["help", "--json"])).stdout);
    expect(env.data.commands.map((c: { name: string }) => c.name)).toEqual(COMMANDS.filter((c) => !c.hidden).map((c) => c.name).sort());
    expect(env.data.globalOptions.map((o: { flag: string }) => o.flag)).toEqual(["--json", "--help", "--version"]);
  });

  test("<command> --help is help for that command", async () => {
    const env = envelope((await run(["docs", "--help", "--json", "extra", "args"])).stdout);
    expect(env.command).toBe("help");
    expect(env.data.command).toMatchObject({ name: "docs", usage: "croft docs [topic|ERROR_CODE] | croft docs --list" });
    expect(env.data.command.options).toEqual([{ flag: "--list", type: "boolean", description: expect.any(String) }]);
  });

  test("help for an unknown command suggests one", async () => {
    const p = envelope((await run(["help", "dosc", "--json"])).stdout).problems[0];
    expect(p).toMatchObject({ code: "USAGE_ERROR", hint: 'did you mean "croft help docs"?' });
  });

  test("--version wins wherever it appears", async () => {
    expect((await run(["docs", "--version"])).stdout).toBe(`croft ${CROFT_VERSION}\n`);
    expect((await run(["-V"])).stdout).toBe(`croft ${CROFT_VERSION}\n`);
  });
});

describe("context", () => {
  test("ctx.project loads lazily and honors CROFT_NOW", async () => {
    const root = dir({ "croft.json": PROJECT });
    const env = envelope((await run(["proj", "--json"], { cwd: root, commands: ALL, env: { CROFT_NOW: "2026-09-21T22:00:00-07:00" } })).stdout);
    expect(env.data).toEqual({ root, tz: "Asia/Tokyo", now: "2026-09-22T05:00:00.000Z" });
  });

  test("ctx.project outside a project is PROJECT_NOT_FOUND (exit 2)", async () => {
    const r = await run(["proj", "--json"], { commands: ALL });
    expect(r.exit).toBe(2);
    expect(envelope(r.stdout).problems[0].code).toBe("PROJECT_NOT_FOUND");
  });

  test("a broken croft.json fails commands that need it but not docs", async () => {
    const root = dir({ "croft.json": '{"timezone": "Pacific"}' });
    const r = await run(["proj", "--json"], { cwd: root, commands: ALL });
    expect(r.exit).toBe(2);
    expect(envelope(r.stdout).problems[0]).toMatchObject({ code: "CONFIG_INVALID", file: "croft.json", line: 1, column: 2 });
    const docs = await run(["docs", "config", "--json"], { cwd: root });
    expect(docs.exit).toBe(0);
    expect(envelope(docs.stdout).database).toBe("");
  });

  test("isTTY reflects stdin and stdout", async () => {
    const seen: unknown[] = [];
    const probe = testCommand("tty", async (ctx) => { seen.push(ctx.isTTY); return { data: null, problems: [], next: [] }; });
    await run(["tty"], { commands: [probe], stdinTTY: true, stdoutTTY: false });
    expect(seen).toEqual([{ stdin: true, stdout: false }]);
  });
});

describe("redaction", () => {
  test("every .env value is redacted from JSON messages; data keeps ordinary values and says what it hid", async () => {
    const root = dir({ "croft.json": PROJECT, ".env": "TOKEN=supersecret123\nLEVEL=info\n" });
    const r = await run(["leak", "--json"], { cwd: root, commands: ALL });
    expect(r.stdout).not.toContain("supersecret123");
    expect(r.stderr).not.toContain("supersecret123");
    const env = envelope(r.stdout);
    // In data (what an agent reasons from) only credential-looking values are replaced: LEVEL=info stays readable.
    expect(env.data).toEqual({ token: "[redacted:TOKEN]", level: "info", redactedValues: true });
    expect(env.problems[0]).toMatchObject({
      severity: "info", code: "INPUT_NOT_BUILT", message: "saw [redacted:TOKEN] at [redacted:LEVEL] level",
    });
  });

  test("human output is redacted but keeps croft's own labels", async () => {
    const root = dir({ "croft.json": PROJECT, ".env": "TOKEN=supersecret123\nLEVEL=info\n" });
    const r = await run(["leak"], { cwd: root, commands: ALL });
    expect(r.stdout + r.stderr).not.toContain("supersecret123");
    expect(r.stdout).toContain("info  INPUT_NOT_BUILT");
    expect(r.stdout).toContain('"token": "[redacted:TOKEN]"');
    expect(r.stdout).toContain("next: croft run x  # because");
  });
});

describe("lazy commands", () => {
  function lazy(load: () => Promise<Pick<Command, "run" | "human">>, extra: Partial<Command> = {}) {
    let loads = 0;
    const cmd = lazyCommand({ name: "lazy", summary: "test lazy", usage: "croft lazy", options: { rows: { type: "string", description: "rows" } }, maxPositionals: 0, ...extra },
      async () => { loads++; return load(); });
    return { cmd, loads: () => loads };
  }
  const ok = async () => ({ run: async () => ({ data: { ran: true }, problems: [], next: [] }), human: () => "ran it" });

  test("the module loads only when the command runs, after its flags parse", async () => {
    const l = lazy(ok);
    const commands = [...COMMANDS, l.cmd];
    expect((await run(["help", "--json"], { commands })).exit).toBe(0);
    expect((await run(["lazy", "--help"], { commands })).stdout).toContain("--rows");
    expect(envelope((await run(["lazy", "--rwos", "--json"], { commands })).stdout).problems[0].code).toBe("USAGE_ERROR");
    expect((await run(["lazy", "extra"], { commands })).exit).toBe(2);
    expect(l.loads()).toBe(0);
    const r = await run(["lazy"], { commands });
    expect(r).toMatchObject({ exit: 0, stdout: "ran it\n" });
    expect(l.loads()).toBe(1);
  });

  const bindingErrors: [string, Error, string][] = [
    ["a missing platform package", Object.assign(new Error("Cannot find package '@duckdb/node-bindings-linux-arm64' from '/p/node_modules/@duckdb/node-bindings/duckdb.js'"), { code: "ERR_MODULE_NOT_FOUND" }), "DUCKDB_BINDING_MISSING"],
    ["a foreign-arch binding", Object.assign(new Error("dlopen(/p/node_modules/@duckdb/node-bindings-darwin-x64/duckdb.node, 0x0001): tried: '...' (mach-o file, but is an incompatible architecture (have 'x86_64', need 'arm64'))"), { code: "ERR_DLOPEN_FAILED" }), "DUCKDB_BINDING_MISSING"],
    ["an old glibc", Object.assign(new Error("/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.28' not found (required by /p/node_modules/@duckdb/node-bindings-linux-x64/libduckdb.so)"), { code: "ERR_DLOPEN_FAILED" }), "DUCKDB_BINDING_LOAD"],
  ];
  for (const [what, error, code] of bindingErrors) {
    test(`a module that cannot load DuckDB (${what}) is ${code}, pointing at croft doctor`, async () => {
      const l = lazy(async () => { throw error; });
      const r = await run(["lazy", "--json"], { commands: [...COMMANDS, l.cmd] });
      expect(r.exit).toBe(2);
      const p = envelope(r.stdout).problems[0];
      expect(p).toMatchObject({ code, fix: { kind: "command", command: "croft doctor" }, details: { command: "lazy" } });
      expect(p.message).toStartWith("croft lazy needs DuckDB, whose binding does not load here");
    });
  }

  test("a real failed import (Bun throws a ResolveMessage, which is not an Error) is DUCKDB_BINDING_MISSING", async () => {
    const platform = "@duckdb/node-bindings-plan9-mips";
    const l = lazy(async () => (await import(`${platform}/duckdb.node`)) as never);
    const p = envelope((await run(["lazy", "--json"], { commands: [l.cmd] })).stdout).problems[0];
    expect(p).toMatchObject({ code: "DUCKDB_BINDING_MISSING", fix: { command: "croft doctor" } });
    expect(p.message).toContain(platform);
  });

  test("croft validate --hook: Bun too old, or a binding that does not load, exits 1 (Claude Code does not block on it); a finding keeps its 2", async () => {
    const hook = { hook: { type: "boolean" as const, description: "hook" } };
    const finding = testCommand("validate", async () => ({ data: null, next: [], problems: [problem("UNKNOWN_COLUMN", { message: "no column x", hint: "h" })] }), { options: hook });
    const old = await run(["validate", "--hook"], { bunVersion: "1.2.20", commands: [finding] });
    expect(old.exit).toBe(1);
    expect(old.stderr).toStartWith("error BUN_TOO_OLD");
    expect((await run(["validate"], { bunVersion: "1.2.20", commands: [finding] })).exit).toBe(2);
    const [, error] = bindingErrors[0]!;
    const binding = lazy(async () => { throw error; }, { name: "validate", options: hook });
    const r = await run(["validate", "--hook", "--json"], { commands: [binding.cmd] });
    expect(r.exit).toBe(1);
    expect(envelope(r.stdout).problems[0].code).toBe("DUCKDB_BINDING_MISSING");
    expect((await run(["validate", "--json"], { commands: [binding.cmd] })).exit).toBe(2);
    expect((await run(["validate", "--hook"], { commands: [finding] })).exit).toBe(2);
    expect((await run(["validate", "--", "--hook"], { bunVersion: "1.2.20", commands: [finding] })).exit).toBe(2);
  });

  test("the same failure inside run() (a dynamic import there) is mapped too; other errors stay INTERNAL_ERROR", async () => {
    const [, error] = bindingErrors[0]!;
    const inRun = testCommand("inrun", async () => { throw error; });
    expect(envelope((await run(["inrun", "--json"], { commands: [inRun] })).stdout).problems[0].code).toBe("DUCKDB_BINDING_MISSING");
    const other = lazy(async () => { throw new Error("Cannot find module './typo.ts' from '/p/src/cli/commands/index.ts'"); });
    expect(envelope((await run(["lazy", "--json"], { commands: [other.cmd] })).stdout).problems[0].code).toBe("INTERNAL_ERROR");
    const sqlError = testCommand("sql", async () => { throw new Error("Binder Error: Referenced column \"x\" not found"); });
    expect(envelope((await run(["sql", "--json"], { commands: [sqlError] })).stdout).problems[0].code).toBe("INTERNAL_ERROR");
  });
});

describe("humanShowsProblems", () => {
  const result = async () => ({
    data: "the command's own text", next: [{ command: "croft init --claude", reason: "refresh" }],
    problems: [problem("CLAUDE_FILES_OUTDATED", { message: "old skill", hint: "run croft init --claude", fix: { kind: "command", description: "d", command: "croft init --claude" } })],
  });

  test("off: main appends the problem blocks after the command's text", async () => {
    const r = await run(["p"], { commands: [testCommand("p", result, { human: (res) => String(res.data) })] });
    expect(r.stdout).toContain("the command's own text\nwarn  CLAUDE_FILES_OUTDATED  old skill\n");
  });

  test("on: the command prints its problems itself; next lines are still appended", async () => {
    const r = await run(["p"], { commands: [testCommand("p", result, { human: (res) => String(res.data), humanShowsProblems: true })] });
    expect(r.stdout).toBe("the command's own text\nnext: croft init --claude  # refresh\n");
  });

  test("on, but human() throws: the problems are printed the standard way after the JSON fallback", async () => {
    const r = await run(["p"], { commands: [testCommand("p", result, { human: () => { throw new Error("formatter bug"); }, humanShowsProblems: true })] });
    expect(r.stderr).toContain("INTERNAL_ERROR");
    expect(r.stdout).toContain("warn  CLAUDE_FILES_OUTDATED  old skill");
  });
});

describe("colors", () => {
  test("none off a TTY, some on a TTY, none with NO_COLOR", async () => {
    expect((await run(["help"])).stdout).not.toContain("\x1b[");
    expect((await run(["help"], { stdoutTTY: true })).stdout).toContain("\x1b[1m");
    expect((await run(["help"], { stdoutTTY: true, env: { NO_COLOR: "1" } })).stdout).not.toContain("\x1b[");
  });
});

describe("helpers", () => {
  test("scanArgv finds the command and global flags, stopping at --", () => {
    expect(scanArgv(["--json", "docs", "SHRINK_GUARD", "--", "--help"])).toEqual({ name: "docs", index: 1, json: true, help: false, version: false });
    expect(scanArgv(["-h"])).toEqual({ index: -1, json: false, help: true, version: false });
  });

  test("versionAtLeast compares numerically and ignores prerelease tags", () => {
    expect(versionAtLeast("1.3.14", "1.3.14")).toBe(true);
    expect(versionAtLeast("1.3.9", "1.3.14")).toBe(false);
    expect(versionAtLeast("1.4.0-canary.2", "1.3.14")).toBe(true);
    expect(versionAtLeast("1.10.0", "1.9.9")).toBe(true);
    expect(versionAtLeast("0.9", "1.3.14")).toBe(false);
  });

  test("shellQuote", () => {
    expect(shellQuote("croft")).toBe("croft");
    expect(shellQuote("from x limit 5")).toBe("'from x limit 5'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  test("trimStack drops runtime frames and caps the length", () => {
    const stack = ["Error: x", ...Array.from({ length: 12 }, (_, i) => `    at f${i} (/tmp/a.ts:${i}:1)`), "    at processTicksAndRejections (native:7:39)", "    at node:internal/x"].join("\n");
    const frames = trimStack(stack);
    expect(frames).toHaveLength(8);
    expect(frames[0]).toBe("at f0 (/tmp/a.ts:0:1)");
    expect(trimStack(undefined)).toEqual([]);
  });
});
