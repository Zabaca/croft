// Lake mode and its add-on (DESIGN.md D134, D138; option 07, slice 2, and the lake half of option 06's slice 5 acceptance 1): a project with a
// `lake` block needs the lake add-on, and says so the way server mode does. A fresh lake project with no add-on gets the code and the install
// command from `croft validate`, `croft doctor` and `croft status`; once the add-on is installed it starts and runs with nothing from the
// network and nothing written outside the project (a local lake: a SQLite catalog and a folder, so there is no remote to reach).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ADDON_VERSION } from "../../db/addons.ts";
import { installFakeAddon } from "../../db/addon-testkit.ts";
import { extensionsReady } from "../../db/extension-dir-testkit.ts";
import { extensionPath, hostPlatform } from "../../db/extension-files.ts";
import { localLakeBlock, useLake } from "../../db/lake-testkit.ts";
import { closeAllWarehouses } from "../../db/warehouse.ts";
import { loadProject } from "../../project/root.ts";
import { SELF_ROOT } from "../launcher.ts";
import { defaultDeps, type DoctorDeps, formatDoctor, runDoctor } from "./doctor.ts";
import { cleanup, cli, makeProject, type TestProject } from "./inspect-testkit.ts";
import { collectStatus, formatStatus } from "./status.ts";

const scratch: string[] = [];
afterAll(async () => {
  await closeAllWarehouses();
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  await cleanup();
});

const ready = extensionsReady(["httpfs", "postgres", "ducklake", "sqlite"]);
const withFiles = ready.ready ? test : test.skip;
if (!ready.ready) console.warn(`[addons-lake.test] SKIPPING the checks on real files: ${ready.skipReason}`);

const AT = "2026-09-24T17:05:00.000Z";

const folder = (prefix: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(d);
  return d;
};

/** An environment that names no extension folder and has an empty home and cache, so only the project's add-on (and the cache, if given) supplies files. */
function emptyEnv(): Record<string, string> {
  const home = folder("croft-nohome-");
  return { XDG_CACHE_HOME: join(home, ".cache"), HOME: home };
}

/** The builders' cache folder with the SQLite extension only (a local lake's catalog; sqlite ships in no add-on): the one file the add-on does not carry. */
function cacheWithSqlite(env: Record<string, string>): void {
  const platform = hostPlatform()!;
  const file = extensionPath(join(env.XDG_CACHE_HOME!, "croft", "test-extensions"), "sqlite", platform);
  mkdirSync(dirname(file), { recursive: true });
  symlinkSync(extensionPath(ready.dir, "sqlite", platform), file);
}

function lakeProject(): TestProject {
  const p = makeProject({ files: { "assets/orders.sql": "-- key: id\nSELECT range AS id FROM range(5)\n" } });
  useLake(p.root, { block: localLakeBlock() });
  return { ...p, project: loadProject({ root: p.root }) };
}

describe("a lake project with no add-on", () => {
  test("croft validate: EXTENSION_MISSING, exit 2, the lake add-on's install command as the fix, in --json and in text", async () => {
    const p = lakeProject();
    const env = emptyEnv();
    const r = await cli(["validate", "--json"], { cwd: p.root, env });
    expect(r.exit).toBe(2);
    const problem = r.json.problems.find((x: { code: string }) => x.code === "EXTENSION_MISSING");
    expect(problem).toMatchObject({
      severity: "error",
      fix: { kind: "command", command: `cd ${p.root} && bun add @zabaca/croft-addon-lake@${ADDON_VERSION}` },
      details: { kind: "addon", addon: "lake", installed: false },
    });
    expect(r.json.data.addons).toEqual([expect.objectContaining({
      addon: "lake", mode: "lake mode", package: "@zabaca/croft-addon-lake", version: ADDON_VERSION, ok: false, installed: false,
      install: `cd ${p.root} && bun add @zabaca/croft-addon-lake@${ADDON_VERSION}`,
    })]);
    expect(r.json.data.addons[0].extensions.map((x: { name: string; ok: boolean }) => [x.name, x.ok])).toEqual([["httpfs", false], ["postgres", false], ["ducklake", false]]);
    const text = await cli(["validate"], { cwd: p.root, env });
    expect(text.exit).toBe(2);
    expect(text.stdout).toContain(`bun add @zabaca/croft-addon-lake@${ADDON_VERSION}`);
  });

  test("a shared lake (a Postgres catalog and a bucket) needs the same add-on", async () => {
    const p = makeProject();
    useLake(p.root, {
      block: {
        catalog: { kind: "postgres", host: "db.example.com", database: "croft", writer: { user: "w", passwordSecret: "A_PW" }, reader: { user: "r", passwordSecret: "B_PW" } },
        bucket: { name: "my-bucket", folder: "croft/x/", writer: { keyIdSecret: "A_ID", secretKeySecret: "A_KEY" }, reader: { keyIdSecret: "B_ID", secretKeySecret: "B_KEY" } },
      },
    });
    const r = await cli(["validate", "--json"], { cwd: p.root, env: emptyEnv() });
    expect(r.exit).toBe(2);
    expect(r.json.data.addons[0]).toMatchObject({ addon: "lake", ok: false });
  });

  test("croft doctor has a line for the add-on, an error with the install command", async () => {
    const p = lakeProject();
    const env = emptyEnv();
    const deps: DoctorDeps = {
      ...defaultDeps({ CROFT_NOW: AT, CROFT_BUN_VERSION: "1.3.14", ...env }), croftRoot: SELF_ROOT, home: join(tmpdir(), "no-home"),
      filesystem: () => ({ type: "apfs", mountPoint: "/", source: "mounts", unsafe: null }), extensions: { env },
    };
    const { data, problems } = await runDoctor(p.root, deps);
    const line = data.checks.find((c) => c.id === "addon.lake")!;
    expect(line).toMatchObject({ section: "environment", status: "error", code: "EXTENSION_MISSING" });
    expect(line.text).toContain(`bun add @zabaca/croft-addon-lake@${ADDON_VERSION}`);
    expect(formatDoctor(data, problems)).toContain("bun add @zabaca/croft-addon-lake");
    // And it says what the lake's folder must hold.
    expect(data.checks.find((c) => c.id === "lake.folder")?.text).toContain("must hold nothing but this lake");
  });

  test("croft status has the add-on in data.lake and a problem with the install command", async () => {
    const p = lakeProject();
    const env = emptyEnv();
    const state = await collectStatus(p.project, new Date(AT), { extensions: { env } });
    expect(state.data.lake).toMatchObject({ kind: "local", folder: "lake/data" });
    expect(state.data.lake?.addons[0]).toMatchObject({ addon: "lake", ok: false });
    expect(state.problems.find((x) => x.code === "EXTENSION_MISSING")?.fix).toMatchObject({ kind: "command", command: expect.stringContaining("bun add @zabaca/croft-addon-lake@") });
    expect(formatStatus(state.data, new Date(AT), { tz: p.project.timezone, problems: state.problems, root: p.root, database: p.project.paths.database })).toContain("Lake mode");
  });
});

describe("a lake project with the add-on installed", () => {
  withFiles("passes croft validate, and runs from the add-on's files with nothing from the network and nothing written outside the project", async () => {
    const p = lakeProject();
    installFakeAddon(p.root, "lake", { from: ready.dir });
    const env = emptyEnv();
    cacheWithSqlite(env);
    const v = await cli(["validate", "--json"], { cwd: p.root, env });
    expect(v.exit, v.stdout).toBe(0);
    expect(v.json.data.addons[0]).toMatchObject({ addon: "lake", ok: true, installed: true });
    expect(v.json.data.addons[0].extensions.map((x: { name: string; source: string }) => [x.name, x.source])).toEqual([["httpfs", "addon"], ["postgres", "addon"], ["ducklake", "addon"]]);
    // A run: the example asset lands in the lake. Its files came from the add-on and the cache; nothing was fetched.
    const run = await cli(["run", "--foreground", "--json"], { cwd: p.root, env: { ...env, HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "" } });
    expect(run.exit, run.stdout).toBe(0);
    expect(existsSync(join(p.root, "lake", "catalog.sqlite"))).toBe(true);
    // The home folder DuckDB would install extensions into, if it had been asked to, was never made.
    expect(readdirSync(env.HOME!)).not.toContain(".duckdb");
  });

  test("the add-on's own files are checked against the pins like any other: a tampered one is refused", async () => {
    const p = lakeProject();
    installFakeAddon(p.root, "lake", { from: null, content: "not the pinned file" });
    const r = await cli(["validate", "--json"], { cwd: p.root, env: emptyEnv() });
    expect(r.exit).toBe(2);
    expect(r.json.problems.map((x: { code: string }) => x.code)).toContain("EXTENSION_CHECKSUM_MISMATCH");
  });
});

