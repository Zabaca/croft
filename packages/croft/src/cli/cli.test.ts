// End-to-end: spawn the real CLI the way the launcher does (`bun --no-env-file src/cli/main.ts`).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODES } from "../core/errors.ts";
import { CROFT_VERSION } from "./version.ts";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const outside = mkdtempSync(join(tmpdir(), "croft-cli-"));
afterAll(() => rmSync(outside, { recursive: true, force: true }));

function croft(args: string[], cwd = outside) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "NO_COLOR" && k !== "FORCE_COLOR") env[k] = v;
  const r = Bun.spawnSync([process.execPath, "--no-env-file", MAIN, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  return { exit: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

describe("the real CLI", () => {
  test("croft --version", () => {
    const r = croft(["--version"]);
    expect(r).toEqual({ exit: 0, stdout: `croft ${CROFT_VERSION}\n`, stderr: "" });
  });

  test("croft docs --list --json prints one envelope line with every code", () => {
    const r = croft(["docs", "--list", "--json"]);
    expect(r.exit).toBe(0);
    expect(r.stderr).toBe("");
    const lines = r.stdout.split("\n");
    expect(lines).toHaveLength(2);                                  // one line plus the trailing newline
    expect(lines[1]).toBe("");
    const env = JSON.parse(lines[0]!);
    expect(env).toMatchObject({ schemaVersion: 1, ok: true, command: "docs", croftVersion: CROFT_VERSION, database: "", problems: [], next: [] });
    expect(env.data.codes).toHaveLength(Object.keys(CODES).length);
    for (const c of env.data.codes) {
      expect(["project", "run", "coordination", "safety", "environment", "warning"]).toContain(c.category);
      expect(["error", "warning", "info"]).toContain(c.severity);
    }
  });

  test("an unknown command exits 2 with USAGE_ERROR and a suggestion", () => {
    const r = croft(["dosc", "--list", "--json"]);
    expect(r.exit).toBe(2);
    const env = JSON.parse(r.stdout);
    expect(env.ok).toBe(false);
    expect(env.problems[0]).toMatchObject({
      severity: "error", code: "USAGE_ERROR", message: 'unknown command "dosc"', hint: 'did you mean "croft docs"?',
      fix: { kind: "command", command: "croft docs --list --json" },
    });
  });

  test("human mode: the problem goes to stderr, uncolored off a TTY", () => {
    const r = croft(["frobnicate"]);
    expect(r.exit).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe('error USAGE_ERROR  unknown command "frobnicate"\n      fix: croft help\n');
  });

  test("inside a project, output is redacted and the envelope names the project", () => {
    const root = mkdtempSync(join(outside, "p-"));
    writeFileSync(join(root, "croft.json"), JSON.stringify({ database: "warehouse.duckdb", timezone: "Asia/Tokyo" }));
    writeFileSync(join(root, ".env"), "TOKEN=dosc-secret\n");
    const r = croft(["dosc-secret", "--json"], root);
    expect(r.exit).toBe(2);
    expect(r.stdout).not.toContain("dosc-secret");
    const env = JSON.parse(r.stdout);
    expect(env).toMatchObject({ database: "warehouse.duckdb", timezone: "Asia/Tokyo" });
    expect(env.problems[0].message).toBe('unknown command "[redacted:TOKEN]"');
  });
});
