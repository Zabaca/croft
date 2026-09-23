import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODES, type Code } from "../../core/errors.ts";
import { main } from "../main.ts";
import { CATEGORIES, docsCommand, EXIT_MEANINGS, generatedCodePage } from "./docs.ts";
import { help } from "./help.ts";
import { version } from "./version.ts";

const pages = mkdtempSync(join(tmpdir(), "croft-docs-"));
const cwd = mkdtempSync(join(tmpdir(), "croft-docs-cwd-"));
afterAll(() => {
  rmSync(pages, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});
writeFileSync(join(pages, "SHRINK_GUARD.md"), "# SHRINK_GUARD\n\nA replace would remove most rows.\n");
writeFileSync(join(pages, "recipes.md"), "# Recipes for common jobs\n\nbody\n");
writeFileSync(join(pages, "Config.md"), "# croft.json from a file\n");
writeFileSync(join(pages, "notes.txt"), "ignored");

const commands = [docsCommand(pages), help, version];

async function docs(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const exit = await main(["docs", ...args], {
    cwd, env: {}, commands, stdout: (t) => out.push(t), stderr: (t) => err.push(t), stdoutTTY: false, stderrTTY: false, stdinTTY: false,
  });
  const stdout = out.join("");
  return { exit, stdout, stderr: err.join(""), env: args.includes("--json") ? JSON.parse(stdout) : undefined };
}

describe("croft docs --list", () => {
  test("lists topics and every error code with category, severity and exit", async () => {
    const r = await docs("--list", "--json");
    expect(r.exit).toBe(0);
    const { topics, codes } = r.env.data;
    expect(codes).toHaveLength(Object.keys(CODES).length);
    expect(codes[0]).toEqual({ code: "DUPLICATE_OUTPUT_COLUMN", category: "project", severity: "error", exit: 2 });
    for (const c of codes) expect(CODES[c.code as Code]).toEqual({ category: c.category, severity: c.severity, exit: c.exit });
    expect(topics.map((t: { name: string }) => t.name)).toEqual([
      "claude-permissions", "config", "errors", "exit-codes", "internals", "json", "recipes", "secrets",
    ]);
    expect(topics.find((t: { name: string }) => t.name === "recipes")).toEqual({ name: "recipes", summary: "Recipes for common jobs", source: "file" });
    expect(topics.find((t: { name: string }) => t.name === "config").source).toBe("file");
  });

  test("bare croft docs is the list; human output has both tables", async () => {
    const r = await docs();
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("Topics  (croft docs <topic>)");
    expect(r.stdout).toContain("  CODE                            CATEGORY       SEVERITY   EXIT");
    expect(r.stdout).toContain("  ENV_FILE_IGNORED                warning        warning    0");
    expect(r.stdout).not.toContain("rows shown");                    // the list is never truncated
  });
});

describe("croft docs CODE", () => {
  test("a page from src/agent/docs wins", async () => {
    const r = await docs("SHRINK_GUARD", "--json");
    expect(r.env.data).toEqual({
      code: "SHRINK_GUARD", category: "run", severity: "error", exit: 1,
      exitMeaning: "an asset failed, or status --check found something unhealthy",
      source: "file", page: "# SHRINK_GUARD\n\nA replace would remove most rows.",
    });
  });

  test("codes are case-insensitive and fall back to a generated summary", async () => {
    const r = await docs("db_busy", "--json");
    expect(r.env.data).toMatchObject({ code: "DB_BUSY", category: "coordination", severity: "error", exit: 4, source: "generated" });
    expect(r.env.data.page).toContain("DB_BUSY is an error in the coordination category");
    expect(r.env.data.page).toContain(CATEGORIES.coordination.todo);
  });

  test("human output leads with category, severity and exit", async () => {
    const r = await docs("CONFIRMATION_REQUIRED");
    expect(r.stdout.split("\n").slice(0, 4)).toEqual([
      "CONFIRMATION_REQUIRED",
      "  category  safety (a human has to decide)",
      "  severity  error",
      "  exit      5 (needs a human (confirmation or a human-only step))",
    ]);
  });

  test("every code has a category description, an exit meaning and a generated page", () => {
    for (const code of Object.keys(CODES) as Code[]) {
      expect(CATEGORIES[CODES[code].category]).toBeDefined();
      expect(EXIT_MEANINGS[CODES[code].exit]).toBeDefined();
      expect(generatedCodePage(code)).toContain(code);
    }
  });
});

describe("croft docs <topic>", () => {
  test("built-in topics", async () => {
    const perms = await docs("claude-permissions", "--json");
    expect(perms.env.data.source).toBe("built-in");
    expect(perms.env.data.page).toContain('"ask": ["Bash(croft confirm:*)"]');
    const exits = await docs("exit-codes");
    expect(exits.stdout).toContain("130    interrupted");
    const secrets = await docs("SECRETS");
    expect(secrets.stdout).toContain("ENV_FILE_IGNORED");
  });

  test("file topics, including one that overrides a built-in", async () => {
    expect((await docs("recipes", "--json")).env.data).toEqual({ topic: "recipes", source: "file", page: "# Recipes for common jobs\n\nbody" });
    expect((await docs("config", "--json")).env.data.page).toBe("# croft.json from a file");
  });

  test("the built-in config page lists every croft.json key", async () => {
    let text = "";
    const r = await main(["docs", "config"], {
      cwd, env: {}, commands: [docsCommand(join(pages, "missing")), help, version],
      stdout: (t) => { text += t; }, stderr: () => {}, stdoutTTY: false, stderrTTY: false,
    });
    expect(r).toBe(0);
    for (const key of ["database", "timezone", "readCopy", "notify.webhook", "serve.allowOrigins", "stateDir"]) expect(text).toContain(key);
  });

  test("an unknown topic is USAGE_ERROR with a suggestion", async () => {
    const r = await docs("confg", "--json");
    expect(r.exit).toBe(2);
    expect(r.env.problems[0]).toMatchObject({
      code: "USAGE_ERROR", message: 'no docs page "confg"', hint: 'did you mean "croft docs config"?',
      fix: { kind: "command", command: "croft docs config" },
    });
    const far = await docs("zzzzzz", "--json");
    expect(far.env.problems[0].fix.command).toBe("croft docs --list");
  });
});
