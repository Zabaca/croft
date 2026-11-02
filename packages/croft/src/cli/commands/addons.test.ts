// croft validate, croft doctor and croft status on a project with a mode on and its add-on installed, missing or wrong
// (DESIGN.md D134; option 06, slice 5). Each says the same thing in its text and in its --json: the stable code, and the
// install command as the fix. The files are the add-on's, linked from DuckDB's real ones where a test needs them.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADDON_VERSION } from "../../db/addons.ts";
import { installFakeAddon } from "../../db/addon-testkit.ts";
import { extensionsReady } from "../../db/extension-dir-testkit.ts";
import { loadProject } from "../../project/root.ts";
import { SELF_ROOT } from "../launcher.ts";
import { defaultDeps, type DoctorDeps, formatDoctor, runDoctor } from "./doctor.ts";
import { cleanup, cli, makeProject, type TestProject } from "./inspect-testkit.ts";
import { collectStatus, formatStatus } from "./status.ts";

const scratch: string[] = [];
afterAll(async () => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  await cleanup();
});

const ready = extensionsReady(["quack", "httpfs"]);
const withFiles = ready.ready ? test : test.skip;
if (!ready.ready) console.warn(`[addons.test] SKIPPING the checks on real files: ${ready.skipReason}`);

const AT = "2026-09-24T17:05:00.000Z";

/** An environment that names no extension folder and has an empty cache, so only an add-on in the project can supply the files. */
function emptyEnv(): Record<string, string> {
  const cache = realpathSync(mkdtempSync(join(tmpdir(), "croft-nocache-")));
  scratch.push(cache);
  return { XDG_CACHE_HOME: cache, HOME: cache };
}

/** A project, in server mode unless `serverMode` is false. */
function projectWith(o: { serverMode?: boolean } = {}): TestProject {
  const p = makeProject();
  writeFileSync(join(p.root, "croft.json"), JSON.stringify({
    database: "warehouse.duckdb", timezone: "America/Los_Angeles", ...(o.serverMode === false ? {} : { serverMode: { enabled: true } }),
  }));
  return { ...p, project: loadProject({ root: p.root }) };
}

function doctorDeps(env: Record<string, string>): DoctorDeps {
  return {
    ...defaultDeps({ CROFT_NOW: AT, CROFT_BUN_VERSION: "1.3.14", ...env }),
    croftRoot: SELF_ROOT, home: join(tmpdir(), "no-home"),
    filesystem: () => ({ type: "apfs", mountPoint: "/", source: "mounts", unsafe: null }),
    extensions: { env },
  };
}

describe("croft validate", () => {
  test("server mode on and no add-on: EXTENSION_MISSING, exit 2, the install command as the fix, in the text and in --json", async () => {
    const p = projectWith();
    const env = emptyEnv();
    const r = await cli(["validate", "--json"], { cwd: p.root, env });
    expect(r.exit).toBe(2);
    const problem = r.json.problems.find((x: { code: string }) => x.code === "EXTENSION_MISSING");
    expect(problem).toMatchObject({
      severity: "error",
      fix: { kind: "command", command: `cd ${p.root} && bun add @zabaca/croft-addon-server@${ADDON_VERSION}` },
      details: { kind: "addon", addon: "server", installed: false },
    });
    expect(r.json.data.addons).toEqual([expect.objectContaining({
      addon: "server", mode: "server mode", package: "@zabaca/croft-addon-server", version: ADDON_VERSION, ok: false, installed: false,
      install: `cd ${p.root} && bun add @zabaca/croft-addon-server@${ADDON_VERSION}`,
    })]);
    expect(r.json.data.addons[0].extensions.map((x: { name: string; ok: boolean; code: string }) => [x.name, x.ok, x.code])).toEqual([
      ["httpfs", false, "EXTENSION_MISSING"], ["quack", false, "EXTENSION_MISSING"],
    ]);
    const text = await cli(["validate"], { cwd: p.root, env });
    expect(text.exit).toBe(2);
    expect(text.stdout).toContain("EXTENSION_MISSING");
    expect(text.stdout).toContain(`bun add @zabaca/croft-addon-server@${ADDON_VERSION}`);
  });

  withFiles("with the add-on installed it passes, and says where each file came from", async () => {
    const p = projectWith();
    installFakeAddon(p.root, "server", { from: ready.dir });
    const r = await cli(["validate", "--json"], { cwd: p.root, env: emptyEnv() });
    expect(r.exit).toBe(0);
    expect(r.json.problems.filter((x: { code: string }) => x.code.startsWith("EXTENSION_"))).toEqual([]);
    expect(r.json.data.addons[0]).toMatchObject({ ok: true, installed: true });
    expect(r.json.data.addons[0].extensions.map((x: { name: string; source: string }) => [x.name, x.source])).toEqual([["httpfs", "addon"], ["quack", "addon"]]);
  });

  test("an add-on whose file is not the pinned one is refused by its checksum (exit 2), and the fix is to install it again", async () => {
    const p = projectWith();
    installFakeAddon(p.root, "server", { from: null });
    const r = await cli(["validate", "--json"], { cwd: p.root, env: emptyEnv() });
    expect(r.exit).toBe(2);
    expect(r.json.problems.find((x: { code: string }) => x.code === "EXTENSION_CHECKSUM_MISMATCH")).toMatchObject({
      severity: "error", fix: { kind: "command", command: expect.stringContaining("bun add @zabaca/croft-addon-server@") },
    });
    expect(r.json.data.addons[0]).toMatchObject({ ok: false, installed: true });
  });

  test("a project with no mode on is unchanged: no add-on looked for, no addons in the data", async () => {
    const p = projectWith({ serverMode: false });
    const r = await cli(["validate", "--json"], { cwd: p.root, env: emptyEnv() });
    expect(r.exit).toBe(0);
    expect(r.json.data.addons).toBeUndefined();
    expect(r.json.problems.filter((x: { code: string }) => x.code.startsWith("EXTENSION_"))).toEqual([]);
  });
});

describe("croft doctor", () => {
  test("a line for the add-on: an error with the install command when it is missing, in the checks and in the problems", async () => {
    const p = projectWith();
    const { data, problems } = await runDoctor(p.root, doctorDeps(emptyEnv()));
    const line = data.checks.find((c) => c.id === "addon.server")!;
    expect(line).toMatchObject({ section: "environment", status: "error", code: "EXTENSION_MISSING" });
    expect(line.text).toContain(`bun add @zabaca/croft-addon-server@${ADDON_VERSION}`);
    expect(line.details).toMatchObject({ addon: "server", ok: false, installed: false, package: "@zabaca/croft-addon-server" });
    expect(problems.find((x) => x.code === "EXTENSION_MISSING")?.fix).toMatchObject({ kind: "command" });
    expect(formatDoctor(data, problems)).toContain("bun add @zabaca/croft-addon-server");
  });

  test("the assets line is about assets: a project with no add-on and no assets has no asset errors", async () => {
    const p = projectWith();
    const { data } = await runDoctor(p.root, doctorDeps(emptyEnv()));
    const assets = data.checks.find((c) => c.id === "assets");
    expect(assets, "the assets line is there").toBeDefined();
    expect(assets).toMatchObject({ status: "ok", details: { assets: 0, errors: 0 } });
    expect(assets!.text).toContain("0 assets · 0 errors");
    expect(data.summary.errors).toBe(1);
  });

  withFiles("with the add-on installed the line is ok and says which package supplied the files", async () => {
    const p = projectWith();
    installFakeAddon(p.root, "server", { from: ready.dir });
    const { data, problems } = await runDoctor(p.root, doctorDeps(emptyEnv()));
    const line = data.checks.find((c) => c.id === "addon.server")!;
    expect(line).toMatchObject({ status: "ok" });
    expect(line.text).toBe("server mode add-on: httpfs and quack found (@zabaca/croft-addon-server) and match the pins");
    expect(problems.filter((x) => x.code.startsWith("EXTENSION_"))).toEqual([]);
  });

  test("a project with no mode on has no add-on line", async () => {
    const p = projectWith({ serverMode: false });
    const { data } = await runDoctor(p.root, doctorDeps(emptyEnv()));
    expect(data.checks.some((c) => c.id.startsWith("addon."))).toBe(false);
  });
});

describe("croft status", () => {
  test("server mode with no add-on: the problem with the install command, the add-on in the data, and a line in the text", async () => {
    const p = projectWith();
    const now = new Date(AT);
    const state = await collectStatus(p.project, now, { extensions: { env: emptyEnv() } });
    expect(state.data.serverMode?.serving).toBe(false);
    expect(state.data.serverMode?.addons).toHaveLength(1);
    expect(state.data.serverMode?.addons[0]).toMatchObject({ addon: "server", ok: false });
    expect(state.problems.find((x) => x.code === "EXTENSION_MISSING")?.fix).toMatchObject({ kind: "command", command: expect.stringContaining("bun add @zabaca/croft-addon-server@") });
    const text = formatStatus(state.data, now, { tz: p.project.timezone, problems: state.problems, root: p.root, database: p.project.paths.database });
    expect(text).toContain("server mode add-on: not installed");
  });

  test("through the command, --json carries the same", async () => {
    const p = projectWith();
    const r = await cli(["status", "--json"], { cwd: p.root, env: emptyEnv() });
    expect(r.exit).toBe(0);
    expect(r.json.data.serverMode.addons[0]).toMatchObject({ addon: "server", ok: false });
    expect(r.json.problems.find((x: { code: string }) => x.code === "EXTENSION_MISSING")).toMatchObject({ fix: { kind: "command" } });
  });

  withFiles("with the add-on installed there is no problem and no line", async () => {
    const p = projectWith();
    installFakeAddon(p.root, "server", { from: ready.dir });
    const now = new Date(AT);
    const state = await collectStatus(p.project, now, { extensions: { env: emptyEnv() } });
    expect(state.data.serverMode?.addons[0]).toMatchObject({ ok: true });
    expect(state.problems.filter((x) => x.code.startsWith("EXTENSION_"))).toEqual([]);
    const text = formatStatus(state.data, now, { tz: p.project.timezone, problems: state.problems, root: p.root, database: p.project.paths.database });
    expect(text).not.toContain("add-on");
  });
});
