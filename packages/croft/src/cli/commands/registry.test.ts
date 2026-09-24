// The registry loads commands lazily, so a DuckDB binding that cannot load (missing optional package,
// node_modules from another machine) breaks only the commands that need DuckDB (§2 "Install-time failures").
import { afterAll, describe, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lazyCommand } from "../command.ts";
import { COMMANDS } from "./index.ts";

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const BIN = fileURLToPath(new URL("../../../bin/croft.mjs", import.meta.url));
const base = realpathSync(mkdtempSync(join(tmpdir(), "croft-registry-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

// Bun resolves every @duckdb/* import to an error, as when the platform binding was never installed.
const NO_DUCKDB = join(base, "no-duckdb.js");
writeFileSync(NO_DUCKDB, `Bun.plugin({ name: "no-duckdb", setup(build) {
  build.onResolve({ filter: /^@duckdb\\// }, (args) => {
    throw new Error("Cannot find package '" + args.path + "' (simulated: the DuckDB binding for " + process.platform + "-" + process.arch + " is not installed)");
  });
} });\n`);

// A command whose module imports DuckDB at the top, like run or query will.
const HEAVY = join(base, "heavy.ts");
writeFileSync(HEAVY, `import { openWarehouse } from ${JSON.stringify(join(SRC, "db", "warehouse.ts"))};
export const heavy = { async run() { return { data: { loaded: typeof openWarehouse === "function" }, problems: [], next: [] }; } };\n`);
const HARNESS = join(base, "harness.ts");
writeFileSync(HARNESS, `import { main } from ${JSON.stringify(join(SRC, "cli", "main.ts"))};
import { COMMANDS } from ${JSON.stringify(join(SRC, "cli", "commands", "index.ts"))};
import { lazyCommand } from ${JSON.stringify(join(SRC, "cli", "command.ts"))};
const heavy = lazyCommand({ name: "heavy", summary: "needs DuckDB", usage: "croft heavy", options: {} }, async () => (await import(${JSON.stringify(HEAVY)})).heavy);
process.exitCode = await main(process.argv.slice(2), { commands: [...COMMANDS, heavy] });\n`);

let n = 0;
function dir(files: Record<string, string> = {}): string {
  const d = join(base, `d${n++}`);
  mkdirSync(d, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(d, name), text);
  return d;
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("CROFT_") && k !== "BUN_OPTIONS") env[k] = v;
  return env;
}

/** Run `script` (the bin, or the harness) with @duckdb/* unloadable in this process only. */
function broken(script: string, args: string[], cwd: string, preload = true) {
  const r = Bun.spawnSync([process.execPath, "--no-env-file", ...(preload ? ["--preload", NO_DUCKDB] : []), script, ...args], {
    cwd, env: cleanEnv(), stdout: "pipe", stderr: "pipe",
  });
  const stdout = r.stdout.toString();
  return { exit: r.exitCode, stdout, stderr: r.stderr.toString(), env: args.includes("--json") && stdout ? JSON.parse(stdout) : null };
}

describe("a DuckDB binding that cannot load", () => {
  test("the simulation really breaks DuckDB", () => {
    const r = Bun.spawnSync([process.execPath, "--no-env-file", "--preload", NO_DUCKDB, "-e", `await import("@duckdb/node-api")`], {
      cwd: SRC, env: cleanEnv(), stdout: "pipe", stderr: "pipe",
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("simulated");
  });

  test("--version, help, help <command> and docs still answer", () => {
    const out = dir();
    expect(broken(BIN, ["--version"], out)).toMatchObject({ exit: 0, stderr: "" });
    const help = broken(BIN, ["help", "--json"], out);
    expect(help.exit).toBe(0);
    expect(help.env.data.commands.map((c: { name: string }) => c.name)).toEqual(COMMANDS.filter((c) => !c.hidden).map((c) => c.name).sort());
    expect(broken(BIN, ["doctor", "--help", "--json"], out).env.data.command).toMatchObject({ name: "doctor", usage: "croft doctor" });
    expect(broken(BIN, ["docs", "DUCKDB_BINDING_MISSING", "--json"], out).exit).toBe(0);
  });

  test("init creates a project", () => {
    const out = dir();
    const r = broken(BIN, ["init", "p", "--no-install", "--json"], out);
    expect(r.stderr).toBe("");
    expect(r.exit).toBe(0);
    expect(r.env).toMatchObject({ ok: true, command: "init", data: { mode: "new" } });
  });

  test("doctor reports the binding instead of crashing, even with a database to open", async () => {
    const root = dir({ "croft.json": JSON.stringify({ database: "warehouse.duckdb", timezone: "UTC" }) });
    const db = await DuckDBInstance.create(join(root, "warehouse.duckdb"));
    db.closeSync();
    // doctor's child-process probe does not get the preload, so it loads DuckDB fine; the import in
    // doctor's own process is what fails.
    const r = broken(BIN, ["doctor", "--json"], root);
    expect(r.env.problems.map((p: { code: string }) => p.code)).not.toContain("INTERNAL_ERROR");
    expect(r.env.command).toBe("doctor");
    const w = r.env.data.checks.find((c: { id: string }) => c.id === "warehouse");
    expect(w).toMatchObject({ status: "error", code: "DUCKDB_BINDING_LOAD" });
    expect(w.text).toContain("simulated");
  });

  test("a command that imports DuckDB fails alone, with DUCKDB_BINDING_MISSING and croft doctor as the fix", () => {
    const out = dir();
    const r = broken(HARNESS, ["heavy", "--json"], out);
    expect(r.exit).toBe(2);
    expect(r.env.problems).toHaveLength(1);
    expect(r.env.problems[0]).toMatchObject({
      code: "DUCKDB_BINDING_MISSING", fix: { kind: "command", command: "croft doctor" }, details: { command: "heavy" },
    });
    expect(r.env.problems[0].message).toContain("simulated");
    // The other commands in the same registry are unaffected, and a bad flag never loads the module.
    expect(broken(HARNESS, ["help", "--json"], out).exit).toBe(0);
    expect(broken(HARNESS, ["heavy", "--nope", "--json"], out).env.problems[0].code).toBe("USAGE_ERROR");
    // Without the simulation the same command loads and runs.
    expect(broken(HARNESS, ["heavy", "--json"], out, false)).toMatchObject({ exit: 0, env: { ok: true, data: { loaded: true } } });
  });
});

describe("lazyCommand", () => {
  test("every registered loader resolves to a runnable command", async () => {
    for (const c of COMMANDS) {
      const loaded = c.load ? await c.load() : c;
      expect(typeof loaded.run).toBe("function");
      expect(loaded.name).toBe(c.name);
    }
  });

  test("the module is imported once, only when needed, and the spec is the registry's", async () => {
    let loads = 0;
    const cmd = lazyCommand({ name: "x", summary: "s", usage: "croft x", options: {}, humanShowsProblems: true }, async () => {
      loads++;
      return { run: async () => ({ data: 1, problems: [], next: [] }), human: () => "one" };
    });
    expect(loads).toBe(0);
    const loaded = await cmd.load!();
    await cmd.load!();
    expect(loads).toBe(1);
    expect(loaded).toMatchObject({ name: "x", usage: "croft x", humanShowsProblems: true });
    expect(loaded.human!({ data: 1, problems: [], next: [] }, undefined as never)).toBe("one");
  });

  test("a failed load is retried on the next call", async () => {
    let calls = 0;
    const cmd = lazyCommand({ name: "x", summary: "s", usage: "croft x", options: {} }, async () => {
      if (calls++ === 0) throw new Error("first");
      return { run: async () => ({ data: null, problems: [], next: [] }) };
    });
    await expect(cmd.load!()).rejects.toThrow("first");
    expect(typeof (await cmd.load!()).run).toBe("function");
  });
});
