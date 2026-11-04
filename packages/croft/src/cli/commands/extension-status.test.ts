// croft validate, croft doctor and croft status on a project with a mode on and its DuckDB extension files on the machine, missing or
// wrong (DESIGN.md D195; option 06, slice 5). Each says the same thing in its text and in its --json: the stable code, and the fetch
// command as the fix. None of them fetches. The files are DuckDB's real ones where a test needs them (a folder named by
// $CROFT_EXTENSION_DIR), and a stand-in file where it only needs a wrong one.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extensionsReady } from "../../db/extension-dir-testkit.ts";
import { extensionPath, hostPlatform } from "../../db/extension-files.ts";
import { localLakeBlock, useLake } from "../../db/lake-testkit.ts";
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

const ready = extensionsReady(["quack", "httpfs", "postgres", "ducklake"]);
const withFiles = ready.ready ? test : test.skip;
if (!ready.ready) console.warn(`[extension-status.test] SKIPPING the checks on real files: ${ready.skipReason}`);

const AT = "2026-09-24T17:05:00.000Z";

/** An environment whose cache holds nothing and that names no extension folder, so no file is on the machine. */
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

function lakeProject(): TestProject {
  const p = makeProject({ files: { "assets/orders.sql": "-- key: id\nSELECT range AS id FROM range(5)\n" } });
  useLake(p.root, { block: localLakeBlock() });
  return { ...p, project: loadProject({ root: p.root }) };
}

/** A folder with a stand-in (wrong) file for each extension named, in DuckDB's layout. */
function standIns(names: readonly ("quack" | "httpfs" | "postgres" | "ducklake")[]): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "croft-standins-")));
  scratch.push(dir);
  for (const n of names) {
    const file = extensionPath(dir, n, hostPlatform()!);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "x".repeat(600));
  }
  return dir;
}

function doctorDeps(env: Record<string, string>): DoctorDeps {
  return {
    ...defaultDeps({ CROFT_NOW: AT, CROFT_BUN_VERSION: "1.3.14", ...env }),
    croftRoot: SELF_ROOT, home: join(tmpdir(), "no-home"),
    filesystem: () => ({ type: "apfs", mountPoint: "/", source: "mounts", unsafe: null }),
    extensions: { env },
  };
}

const FETCH_SERVER = "croft fetch-extensions httpfs quack";

describe("croft validate", () => {
  test("server mode on and no files on the machine: EXTENSION_MISSING, exit 2, the fetch command as the fix, in the text and in --json", async () => {
    const p = projectWith();
    const env = emptyEnv();
    const r = await cli(["validate", "--json"], { cwd: p.root, env });
    expect(r.exit).toBe(2);
    const problem = r.json.problems.find((x: { code: string }) => x.code === "EXTENSION_MISSING");
    expect(problem).toMatchObject({
      severity: "error",
      fix: { kind: "command", command: FETCH_SERVER },
      details: { kind: "file", mode: "server", missing: ["httpfs", "quack"], fetch: FETCH_SERVER },
    });
    expect(r.json.data.extensionFiles).toEqual([expect.objectContaining({ mode: "server", label: "server mode", ok: false, fetch: FETCH_SERVER })]);
    expect(r.json.data.extensionFiles[0].extensions.map((x: { name: string; ok: boolean; code: string }) => [x.name, x.ok, x.code])).toEqual([
      ["httpfs", false, "EXTENSION_MISSING"], ["quack", false, "EXTENSION_MISSING"],
    ]);
    const text = await cli(["validate"], { cwd: p.root, env });
    expect(text.exit).toBe(2);
    expect(text.stdout).toContain("EXTENSION_MISSING");
    expect(text.stdout).toContain(FETCH_SERVER);
  });

  test("validate fetches nothing: it reports a missing file even where the repository would answer", async () => {
    const p = projectWith();
    const r = await cli(["validate", "--json"], { cwd: p.root, env: { ...emptyEnv(), CROFT_NO_FETCH: "", CROFT_EXTENSION_REPO: "http://127.0.0.1:9" } });
    expect(r.exit).toBe(2);
    expect(r.json.problems.map((x: { code: string }) => x.code)).toContain("EXTENSION_MISSING");
    expect(r.json.problems.map((x: { code: string }) => x.code)).not.toContain("EXTENSION_FETCH_FAILED");
  });

  withFiles("with the files on the machine it passes", async () => {
    const p = projectWith();
    const r = await cli(["validate", "--json"], { cwd: p.root, env: { ...emptyEnv(), CROFT_EXTENSION_DIR: ready.dir } });
    expect(r.exit).toBe(0);
    expect(r.json.problems.filter((x: { code: string }) => x.code.startsWith("EXTENSION_"))).toEqual([]);
    expect(r.json.data.extensionFiles[0]).toMatchObject({ ok: true, fetch: null });
    expect(r.json.data.extensionFiles[0].extensions.map((x: { name: string; ok: boolean }) => [x.name, x.ok])).toEqual([["httpfs", true], ["quack", true]]);
  });

  test("a file that is not the pinned one is refused by its checksum (exit 2), and the fix fetches DuckDB's file over it", async () => {
    const p = projectWith();
    const r = await cli(["validate", "--json"], { cwd: p.root, env: { ...emptyEnv(), CROFT_EXTENSION_DIR: standIns(["quack", "httpfs"]) } });
    expect(r.exit).toBe(2);
    expect(r.json.problems.find((x: { code: string }) => x.code === "EXTENSION_CHECKSUM_MISMATCH")).toMatchObject({
      severity: "error", fix: { kind: "command", command: FETCH_SERVER },
    });
    expect(r.json.data.extensionFiles[0]).toMatchObject({ ok: false, fetch: FETCH_SERVER });
  });

  test("a project with no mode on is unchanged: no files looked for, none in the data", async () => {
    const p = projectWith({ serverMode: false });
    const r = await cli(["validate", "--json"], { cwd: p.root, env: emptyEnv() });
    expect(r.exit).toBe(0);
    expect(r.json.data.extensionFiles).toBeUndefined();
    expect(r.json.problems.filter((x: { code: string }) => x.code.startsWith("EXTENSION_"))).toEqual([]);
  });

  test("a lake project needs the lake's files: httpfs, postgres and ducklake, one command for the three", async () => {
    const p = lakeProject();
    const r = await cli(["validate", "--json"], { cwd: p.root, env: emptyEnv() });
    expect(r.exit).toBe(2);
    expect(r.json.data.extensionFiles).toEqual([expect.objectContaining({ mode: "lake", label: "lake mode", ok: false, fetch: "croft fetch-extensions httpfs postgres ducklake" })]);
    expect(r.json.problems.find((x: { code: string }) => x.code === "EXTENSION_MISSING")).toMatchObject({ fix: { kind: "command", command: "croft fetch-extensions httpfs postgres ducklake" } });
  });
});

describe("croft doctor", () => {
  test("a line per mode: an error with the fetch command when the files are missing, in the checks and in the problems", async () => {
    const p = projectWith();
    const { data, problems } = await runDoctor(p.root, doctorDeps(emptyEnv()));
    const line = data.checks.find((c) => c.id === "extensions.server")!;
    expect(line).toMatchObject({ section: "environment", status: "error", code: "EXTENSION_MISSING" });
    expect(line.text).toContain(FETCH_SERVER);
    expect(line.details).toMatchObject({ mode: "server", ok: false, fetch: FETCH_SERVER });
    expect(problems.find((x) => x.code === "EXTENSION_MISSING")?.fix).toMatchObject({ kind: "command", command: FETCH_SERVER });
    expect(formatDoctor(data, problems)).toContain(FETCH_SERVER);
  });

  test("the assets line is about assets: a project with no files and no assets has no asset errors", async () => {
    const p = projectWith();
    const { data } = await runDoctor(p.root, doctorDeps(emptyEnv()));
    const assets = data.checks.find((c) => c.id === "assets");
    expect(assets, "the assets line is there").toBeDefined();
    expect(assets).toMatchObject({ status: "ok", details: { assets: 0, errors: 0 } });
    expect(assets!.text).toContain("0 assets · 0 errors");
    expect(data.summary.errors).toBe(1);
  });

  withFiles("with the files on the machine the line is ok", async () => {
    const p = projectWith();
    const { data, problems } = await runDoctor(p.root, doctorDeps({ ...emptyEnv(), CROFT_EXTENSION_DIR: ready.dir }));
    const line = data.checks.find((c) => c.id === "extensions.server")!;
    expect(line).toMatchObject({ status: "ok" });
    expect(line.text).toBe("server mode extension files: httpfs and quack found and match the pins");
    expect(problems.filter((x) => x.code.startsWith("EXTENSION_"))).toEqual([]);
  });

  test("a project with no mode on has no extension line", async () => {
    const p = projectWith({ serverMode: false });
    const { data } = await runDoctor(p.root, doctorDeps(emptyEnv()));
    expect(data.checks.some((c) => c.id.startsWith("extensions."))).toBe(false);
  });

  test("a lake project has a lake line, an error with the fetch command", async () => {
    const p = lakeProject();
    const { data, problems } = await runDoctor(p.root, doctorDeps(emptyEnv()));
    const line = data.checks.find((c) => c.id === "extensions.lake")!;
    expect(line).toMatchObject({ section: "environment", status: "error", code: "EXTENSION_MISSING" });
    expect(line.text).toContain("croft fetch-extensions httpfs postgres ducklake");
    expect(formatDoctor(data, problems)).toContain("croft fetch-extensions httpfs postgres ducklake");
  });
});

describe("croft status", () => {
  test("server mode with no files: the problem with the fetch command, the files in the data, and a line in the text", async () => {
    const p = projectWith();
    const now = new Date(AT);
    const state = await collectStatus(p.project, now, { extensions: { env: emptyEnv() } });
    expect(state.data.serverMode?.serving).toBe(false);
    expect(state.data.serverMode?.extensionFiles).toHaveLength(1);
    expect(state.data.serverMode?.extensionFiles[0]).toMatchObject({ mode: "server", ok: false });
    expect(state.problems.find((x) => x.code === "EXTENSION_MISSING")?.fix).toMatchObject({ kind: "command", command: FETCH_SERVER });
    const text = formatStatus(state.data, now, { tz: p.project.timezone, problems: state.problems, root: p.root, database: p.project.paths.database });
    expect(text).toContain(`server mode extension files: not on this machine yet; ${FETCH_SERVER}`);
  });

  test("through the command, --json carries the same", async () => {
    const p = projectWith();
    const r = await cli(["status", "--json"], { cwd: p.root, env: emptyEnv() });
    expect(r.exit).toBe(0);
    expect(r.json.data.serverMode.extensionFiles[0]).toMatchObject({ mode: "server", ok: false });
    expect(r.json.problems.find((x: { code: string }) => x.code === "EXTENSION_MISSING")).toMatchObject({ fix: { kind: "command" } });
  });

  withFiles("with the files on the machine there is no problem and no line", async () => {
    const p = projectWith();
    const now = new Date(AT);
    const state = await collectStatus(p.project, now, { extensions: { env: { ...emptyEnv(), CROFT_EXTENSION_DIR: ready.dir } } });
    expect(state.data.serverMode?.extensionFiles[0]).toMatchObject({ ok: true });
    expect(state.problems.filter((x) => x.code.startsWith("EXTENSION_"))).toEqual([]);
    const text = formatStatus(state.data, now, { tz: p.project.timezone, problems: state.problems, root: p.root, database: p.project.paths.database });
    expect(text).not.toContain("extension files");
  });

  test("a lake project has the files in data.lake and a problem with the fetch command", async () => {
    const p = lakeProject();
    const state = await collectStatus(p.project, new Date(AT), { extensions: { env: emptyEnv() } });
    expect(state.data.lake?.extensionFiles[0]).toMatchObject({ mode: "lake", ok: false });
    expect(state.problems.find((x) => x.code === "EXTENSION_MISSING")?.fix).toMatchObject({ kind: "command", command: "croft fetch-extensions httpfs postgres ducklake" });
  });
});
