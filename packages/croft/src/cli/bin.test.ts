// bin/croft.mjs, the file package.json "bin" names: plain JavaScript, so that Node can parse it and say
// NEEDS_BUN (§2 "Install-time failures") instead of failing on TypeScript syntax deep in src/.
import { afterAll, describe, expect, test } from "bun:test";
import { realNode } from "../node-testkit.ts";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { planLaunch, SELF_ROOT } from "./launcher.ts";
import { formatProblem } from "./render.ts";
import { CROFT_VERSION } from "./version.ts";

const BIN = fileURLToPath(new URL("../../bin/croft.mjs", import.meta.url));
const PKG = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"));
const NODE = realNode();
const base = realpathSync(mkdtempSync(join(tmpdir(), "croft-bin-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("CROFT_") && k !== "NO_COLOR") env[k] = v;
  return { ...env, ...extra };
}

function run(cmd: string[], env = cleanEnv()) {
  const r = Bun.spawnSync(cmd, { cwd: base, env, stdout: "pipe", stderr: "pipe" });
  return { exit: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

/** The launcher's NEEDS_BUN problem, the one the bin must print under Node. */
const needsBun = (() => {
  const plan = planLaunch({ argv: [], cwd: base, env: {}, isBun: false, selfRoot: SELF_ROOT, commandNames: [] });
  if (plan.kind !== "refuse") throw new Error("expected a refusal");
  return plan.problem;
})();

describe("package.json", () => {
  test("bin is the plain-JS entry, and it ships with the JSON Schema", () => {
    expect(PKG.bin).toEqual({ croft: "bin/croft.mjs" });
    expect(PKG.files).toContain("bin");
    expect(PKG.files).toContain("croft.schema.json");
    expect(statSync(BIN).mode & 0o111).not.toBe(0);                  // executable
  });
});

describe("under Bun", () => {
  test("runs the CLI", () => {
    expect(run([process.execPath, "--no-env-file", BIN, "--version"])).toEqual({ exit: 0, stdout: `croft ${CROFT_VERSION}\n`, stderr: "" });
    const env = JSON.parse(run([process.execPath, "--no-env-file", BIN, "docs", "--list", "--json"]).stdout);
    expect(env).toMatchObject({ ok: true, command: "docs" });
  });
});

describe.skipIf(!NODE)("under Node", () => {
  test("--json: one NEEDS_BUN envelope on stdout, exit 2", () => {
    const r = run([NODE!, BIN, "status", "--json"]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toBe("");
    const lines = r.stdout.split("\n");
    expect(lines).toHaveLength(2);
    const env = JSON.parse(lines[0]!);
    expect(Object.keys(env)).toEqual(["schemaVersion", "ok", "command", "croftVersion", "database", "timezone", "durationMs", "data", "problems", "next"]);
    expect(env).toMatchObject({ schemaVersion: 1, ok: false, command: "status", croftVersion: CROFT_VERSION, database: "", durationMs: 0, data: null, next: [] });
    expect(typeof env.timezone).toBe("string");
    expect(env.problems).toEqual([needsBun]);
    expect(Object.keys(env.problems[0])).toEqual(["severity", "code", "message", "hint", "docs", "fix"]);
  });

  test("human mode: the launcher's problem block on stderr", () => {
    const r = run([NODE!, BIN, "run", "x"]);
    expect(r).toEqual({ exit: 2, stdout: "", stderr: `${formatProblem(needsBun)}\n` });
    // --version is a command name like any other; the refusal names it.
    expect(JSON.parse(run([NODE!, BIN, "--version", "--json"]).stdout).command).toBe("version");
  });

  test("started as an executable with node but no bun on PATH (npx croft without Bun)", () => {
    const onlyNode = join(base, "only-node");
    mkdirSync(onlyNode);
    symlinkSync(NODE!, join(onlyNode, "node"));
    const r = run([BIN, "status"], cleanEnv({ PATH: `${onlyNode}:/usr/bin:/bin` }));
    expect(r.exit).toBe(2);
    expect(r.stderr).toStartWith("error NEEDS_BUN  croft runs on Bun");
  });
});

test("started as an executable with bun on PATH, it runs under Bun", () => {
  const onlyBun = join(base, "only-bun");
  mkdirSync(onlyBun, { recursive: true });
  symlinkSync(process.execPath, join(onlyBun, "bun"));
  const env = cleanEnv({ PATH: `${onlyBun}:/usr/bin:/bin` });
  expect(run([BIN, "--version"], env)).toEqual({ exit: 0, stdout: `croft ${CROFT_VERSION}\n`, stderr: "" });
  // Through a symlink, as node_modules/.bin/croft and ~/.bun/bin/croft are.
  const link = join(base, "dot-bin", "croft");
  mkdirSync(join(base, "dot-bin"));
  symlinkSync(BIN, link);
  expect(run([link, "--version"], env)).toEqual({ exit: 0, stdout: `croft ${CROFT_VERSION}\n`, stderr: "" });
});

test("with neither runtime on PATH it says how to install Bun", () => {
  const r = run([BIN, "status"], cleanEnv({ PATH: "/usr/bin:/bin" }));
  if (Bun.which("bun", { PATH: "/usr/bin:/bin" }) || Bun.which("node", { PATH: "/usr/bin:/bin" })) return;   // a system-wide runtime
  expect(r.exit).toBe(2);
  expect(r.stderr).toContain("NEEDS_BUN");
  expect(r.stderr).toContain("curl -fsSL https://bun.sh/install | bash");
});
