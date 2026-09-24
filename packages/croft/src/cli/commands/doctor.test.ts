import { afterAll, describe, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { CODES } from "../../core/errors.ts";
import { offsetSeconds } from "../../core/time.ts";
import { CROFT_VERSION, SKILL_PATH, skillMd } from "../../agent/templates.ts";
import type { FsKind } from "../../db/fs-kind.ts";
import { RunsDb } from "../../history/runs-db.ts";
import { initProject } from "../../project/init.ts";
import { croftHome } from "../../schedule/home.ts";
import type { OsRunner } from "../../schedule/os.ts";
import { addProject } from "../../schedule/registry.ts";
import { scan } from "../../agent/contract-testkit.ts";
import { SELF_ROOT } from "../launcher.ts";
import { main } from "../main.ts";
import { BUN_TESTED } from "../version.ts";
import {
  type DoctorCheck, type DoctorDeps, type DuckdbProbe, duckdbOffsets, formatBytes, formatDoctor, probeDuckdb, runDoctor,
} from "./doctor.ts";
import { SINCE_KEY } from "./schedule.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "doctor-")));
const children: ChildProcess[] = [];
afterAll(() => {
  children.forEach((c) => c.kill("SIGKILL"));
  rmSync(base, { recursive: true, force: true });
});
let n = 0;

/** A fresh project made by croft init (so its Claude files are current). */
async function project(o: { app?: boolean; timezone?: string } = {}): Promise<string> {
  const dir = join(base, `p${n++}`);
  mkdirSync(dir, { recursive: true });
  if (o.app) writeFileSync(join(dir, "package.json"), "{}");
  const r = await initProject({ target: dir, install: false, timezone: o.timezone ?? "Asia/Tokyo", synced: () => null });
  return r.root;
}

const OK_PROBE: DuckdbProbe = { ok: true, version: "v1.5.5", extensions: ["autocomplete", "core_functions", "icu", "json", "parquet"], platformArch: `${process.platform}-${process.arch}` };
const LOCAL: FsKind = { type: "apfs", mountPoint: "/", source: "mounts", unsafe: null };

function deps(o: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    bunVersion: "1.3.14", platform: process.platform, arch: process.arch, croftRoot: SELF_ROOT, env: {}, home: join(base, "home"),
    wsl: false, probeDuckdb: () => OK_PROBE, rosetta: () => false, synced: () => null, filesystem: () => LOCAL, lockWaitMs: 150, healthTimeoutMs: 300, ...o,
  };
}

const check = (checks: DoctorCheck[], id: string) => checks.find((c) => c.id === id)!;

/** Every file and folder under dir, to prove doctor wrote nothing. */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      out.push(`${relative(dir, p).split(sep).join("/")}${e.isDirectory() ? "/" : ` ${statSync(p).size}`}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

/** A warehouse file written with DuckDB directly (not through connect.ts, whose instance cache would pin
 *  this process to read-write for the path). */
async function warehouse(root: string, meta: Record<string, string> | null): Promise<string> {
  const path = join(root, "warehouse.duckdb");
  const db = await DuckDBInstance.create(path);
  const c = await db.connect();
  await c.run("CREATE TABLE example_sales AS SELECT range AS id FROM range(1000)");
  if (meta) {
    await c.run("CREATE SCHEMA _croft");
    await c.run("CREATE TABLE _croft.meta (key VARCHAR PRIMARY KEY, value VARCHAR)");
    for (const [k, v] of Object.entries(meta)) await c.run(`INSERT INTO _croft.meta VALUES ('${k}', '${v}')`);
  }
  c.disconnectSync();
  db.closeSync();
  return path;
}

function waitForLine(child: ChildProcess, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    child.stdout!.on("data", (d) => { out += String(d); if (out.includes(text)) resolve(); });
    child.stderr!.on("data", (d) => (err += String(d)));
    child.on("exit", () => reject(new Error(`child exited before "${text}": ${err}`)));
  });
}

describe("croft doctor --json", () => {
  test("envelope shape, every check, no writes, well under a second", async () => {
    const root = await project();
    await warehouse(root, { format_version: "1", duckdb_version: "v1.5.5", croft_version: CROFT_VERSION });
    // Installed, as after bun install: the project's pinned copy is this one.
    mkdirSync(join(root, "node_modules", "@zabaca"), { recursive: true });
    symlinkSync(SELF_ROOT, join(root, "node_modules", "@zabaca", "croft"));
    const before = tree(root);
    let stdout = "";
    const exit = await main(["doctor", "--json"], { cwd: join(root, "assets"), env: {}, stdout: (t) => { stdout += t; }, stderr: () => {} });
    const env = JSON.parse(stdout);
    expect(exit).toBe(0);
    expect(env).toMatchObject({ schemaVersion: 1, ok: true, command: "doctor", database: "warehouse.duckdb", timezone: "Asia/Tokyo", problems: [], next: [] });
    expect(env.durationMs).toBeLessThan(1000);
    const checks: DoctorCheck[] = env.data.checks;
    expect(checks.map((c) => c.id)).toEqual(["bun", "croft", "duckdb", "warehouse", "serve", "config", "assets", "storage", "writable", "env", "claude", "scheduling"]);
    // The example asset, validated as croft validate does (and within the second).
    expect(check(checks, "assets")).toMatchObject({
      status: "ok", text: "1 asset · 0 errors, 0 warnings (details: croft validate)", details: { assets: 1, errors: 0, warnings: 0, info: 0 },
    });
    for (const c of checks) {
      expect(Object.keys(c).every((k) => ["id", "section", "status", "text", "code", "details"].includes(k))).toBe(true);
      expect(["ok", "warn", "error", "info"]).toContain(c.status);
      expect(["environment", "project", "scheduling"]).toContain(c.section);
    }
    expect(check(checks, "duckdb").text).toMatch(/^duckdb 1\.5\.5 binding \w+-\w+ · json, parquet, icu built in$/);
    expect(check(checks, "warehouse")).toMatchObject({ status: "ok", details: { exists: true, writable: true, heldBy: null } });
    expect(check(checks, "warehouse").text).toMatch(/^warehouse\.duckdb [\d.]+ (KB|MB) · writable · not held · duckdb 1\.5\.5 · croft format 1$/);
    expect(env.data.summary).toEqual({ ok: checks.filter((c) => c.status === "ok").length, info: checks.filter((c) => c.status === "info").length, warnings: 0, errors: 0 });
    expect(env.data.project).toEqual({ root, database: join(root, "warehouse.duckdb"), stateDir: join(root, ".croft"), relocated: false });
    expect(tree(root)).toEqual(before);
  });

  test("outside a project: the environment and a pointer to croft init", async () => {
    const dir = join(base, `out${n++}`);
    mkdirSync(dir);
    const { data, problems } = await runDoctor(dir, deps());
    expect(data.checks.map((c) => `${c.section}:${c.id}:${c.status}`)).toEqual([
      "environment:bun:ok", "environment:croft:ok", "environment:duckdb:ok", "project:project:info",
    ]);
    expect(data.project).toBeNull();
    expect(problems).toEqual([]);
  });
});

describe("environment checks", () => {
  test("Bun floor, and a Bun newer than the tested one", async () => {
    const dir = await project();
    const old = await runDoctor(dir, deps({ bunVersion: "1.3.13" }));
    expect(check(old.data.checks, "bun")).toMatchObject({ status: "error", code: "BUN_TOO_OLD" });
    expect(old.problems[0]!.fix).toMatchObject({ kind: "command", command: "bun upgrade" });
    const newer = await runDoctor(dir, deps({ bunVersion: "9.0.0" }));
    expect(check(newer.data.checks, "bun")).toMatchObject({ status: "warn", code: "BUN_UNTESTED", details: { tested: BUN_TESTED } });
    expect(check(newer.data.checks, "bun").text).toContain(`newer than the newest Bun croft ${CROFT_VERSION} was tested on`);
    expect(newer.problems).toHaveLength(1);
    expect(newer.problems[0]).toMatchObject({ severity: "warning", code: "BUN_UNTESTED", details: { bun: "9.0.0", tested: BUN_TESTED } });
    const tested = await runDoctor(dir, deps({ bunVersion: BUN_TESTED }));
    expect(check(tested.data.checks, "bun").status).toBe("ok");
  });

  test("DuckDB binding missing, from another machine, or under Rosetta: DUCKDB_BINDING_MISSING", async () => {
    const dir = await project();
    const missing = await runDoctor(dir, deps({ probeDuckdb: () => ({ ok: false, name: "ResolveMessage", code: "MODULE_NOT_FOUND",
      message: "Cannot find module '@duckdb/node-bindings-darwin-arm64/duckdb.node' from '/x/node_modules/@duckdb/node-bindings/duckdb.js'" }) }));
    const p = missing.problems.find((x) => x.code === "DUCKDB_BINDING_MISSING")!;
    expect(p.message).toContain("is not installed");
    expect(p.fix).toEqual({ kind: "command", description: "reinstall the dependencies for this machine", command: `cd ${dir} && rm -rf node_modules && bun install` });
    expect(check(missing.data.checks, "duckdb").status).toBe("error");

    const arch = await runDoctor(dir, deps({ probeDuckdb: () => ({ ok: false, code: "ERR_DLOPEN_FAILED",
      message: "dlopen(/x/duckdb.node, 0x0001): tried: '/x/duckdb.node' (mach-o file, but is an incompatible architecture (have 'x86_64', need 'arm64'))" }) }));
    expect(arch.problems[0]).toMatchObject({ code: "DUCKDB_BINDING_MISSING" });
    expect(arch.problems[0]!.message).toContain("cannot be loaded by this");

    // node_modules installed on another machine: the binding that is there is named.
    const here = `${process.platform}-${process.arch}`;
    const foreign = await runDoctor(dir, deps({ platform: "linux", arch: "s390x", probeDuckdb: () => ({ ok: false, code: "MODULE_NOT_FOUND", message: "Cannot find module '@duckdb/node-bindings-linux-s390x/duckdb.node'" }) }));
    const fp = foreign.problems.find((x) => x.code === "DUCKDB_BINDING_MISSING")!;
    expect(fp.details!.bindingsPresent).toContain(here);
    // Linux installs both the glibc and the musl binding; the message lists what is really there.
    const present = (fp.details!.bindingsPresent as string[]).join(", ");
    expect(fp.message).toBe(`the DuckDB binding for linux-s390x is not installed (node_modules has ${present}: installed on another machine or by another Bun?)`);
    // Outside a project the fix reinstalls croft itself.
    const out = join(base, `bare${n++}`);
    mkdirSync(out);
    const bare = await runDoctor(out, deps({ probeDuckdb: () => ({ ok: false, code: "MODULE_NOT_FOUND", message: "Cannot find package '@duckdb/node-api'" }) }));
    expect(bare.problems[0]!.fix).toMatchObject({ kind: "command", command: "bun add -g @zabaca/croft" });

    const rosetta = await runDoctor(dir, deps({ rosetta: () => true, probeDuckdb: () => ({ ok: false, message: "dlopen failed" }) }));
    expect(rosetta.problems[0]!.fix).toMatchObject({ kind: "manual", requiresHuman: true });
    expect(rosetta.problems[0]!.hint).toContain("arm64 build of Bun");
  });

  test("DuckDB binding that fails to load: DUCKDB_BINDING_LOAD, with the glibc it needs", async () => {
    const dir = await project();
    const glibc = await runDoctor(dir, deps({ probeDuckdb: () => ({ ok: false, code: "ERR_DLOPEN_FAILED",
      message: "/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.28' not found (required by /x/libduckdb.so)" }) }));
    expect(glibc.problems[0]).toMatchObject({ code: "DUCKDB_BINDING_LOAD", message: "the DuckDB binding needs glibc 2.28 or newer, which this system does not have" });
    const crash = await runDoctor(dir, deps({ probeDuckdb: () => ({ ok: false, message: "the DuckDB check crashed (SIGSEGV)", signal: "SIGSEGV" }) }));
    expect(crash.problems[0]).toMatchObject({ code: "DUCKDB_BINDING_LOAD" });
    expect(crash.problems[0]!.message).toContain("SIGSEGV");
  });

  test("the real probe loads this machine's binding in a child process", () => {
    const probe = probeDuckdb(SELF_ROOT);
    expect(probe).toMatchObject({ ok: true, platformArch: `${process.platform}-${process.arch}` });
    if (probe.ok) {
      expect(probe.version).toMatch(/^v1\.5\.\d+$/);
      for (const e of ["json", "parquet", "icu"]) expect(probe.extensions).toContain(e);
    }
    const nowhere = probeDuckdb(join(base, "no-such-install"));
    expect(nowhere).toMatchObject({ ok: false });
  });

  test("the probe child gets the environment doctor was given, not the one Bun started with", () => {
    // BUN_OPTIONS reaches the child only through the env passed to it; this one makes @duckdb/* unloadable.
    const preload = join(base, "block-duckdb.js");
    writeFileSync(preload, `Bun.plugin({ name: "block", setup(b) { b.onResolve({ filter: /^@duckdb\\// }, () => { throw new Error("blocked through env"); }); } });\n`);
    const env = { ...process.env, BUN_OPTIONS: `--preload ${preload}` };
    const blocked = probeDuckdb(SELF_ROOT, env);
    expect(blocked).toMatchObject({ ok: false });
    expect(JSON.stringify(blocked)).toContain("blocked through env");
    expect(probeDuckdb(SELF_ROOT, { ...process.env, BUN_OPTIONS: undefined })).toMatchObject({ ok: true });
  });

  test("croft pinning", async () => {
    const dir = await project();
    const declared = await runDoctor(dir, deps());
    expect(check(declared.data.checks, "croft")).toMatchObject({ status: "warn" });
    expect(check(declared.data.checks, "croft").text).toContain("pinned croft is not installed; run bun install");

    mkdirSync(join(dir, "node_modules", "@zabaca"), { recursive: true });
    symlinkSync(SELF_ROOT, join(dir, "node_modules", "@zabaca", "croft"));
    const pinned = await runDoctor(dir, deps({ env: { CROFT_LAUNCHER_VERSION: "9.9.9" } }));
    expect(check(pinned.data.checks, "croft")).toMatchObject({ status: "ok", text: `croft ${CROFT_VERSION} (project-pinned; launcher 9.9.9)` });

    const other = await project();
    mkdirSync(join(other, "node_modules", "@zabaca", "croft"), { recursive: true });
    writeFileSync(join(other, "node_modules", "@zabaca", "croft", "package.json"), JSON.stringify({ name: "@zabaca/croft", version: "0.0.7" }));
    const mismatch = await runDoctor(other, deps());
    expect(check(mismatch.data.checks, "croft").status).toBe("warn");
    expect(check(mismatch.data.checks, "croft").text).toContain("this project pins croft 0.0.7");
  });

  test("WSL gets a note about the VM stopping", async () => {
    const { data } = await runDoctor(await project(), deps({ wsl: true }));
    expect(check(data.checks, "wsl")).toMatchObject({ section: "environment", status: "info" });
  });
});

describe("doctor names only commands this version has", () => {
  test("the assets line points at croft validate for details, and no line or fix names a later command", async () => {
    const root = await project();
    installed(root);
    const { data, problems } = await runDoctor(root, deps());
    expect(check(data.checks, "config").text).toBe("croft.json · timezone Asia/Tokyo");
    expect(check(data.checks, "assets").text).toBe("1 asset · 0 errors, 0 warnings (details: croft validate)");
    const texts = [...data.checks.map((c) => c.text), ...problems.flatMap((p) => [p.hint, p.fix?.description ?? "", p.fix?.kind === "command" ? p.fix.command : ""])];
    expect(texts.flatMap((t) => scan("croft doctor", t))).toEqual([]);
  });
});

/** node_modules/@zabaca/croft as bun install leaves it: this package. */
function installed(root: string): void {
  mkdirSync(join(root, "node_modules", "@zabaca"), { recursive: true });
  symlinkSync(SELF_ROOT, join(root, "node_modules", "@zabaca", "croft"));
}

describe("the assets line (croft validate's counts)", () => {
  test("an asset with an error makes the line an error; the problems stay validate's", async () => {
    const root = await project();
    installed(root);
    writeFileSync(join(root, "assets", "open_issues.sql"), "SELECT id FROM example_sales; SELECT 2\n");
    writeFileSync(join(root, "assets", "stamped.sql"), "SELECT now() AS at\n");
    const { data, problems } = await runDoctor(root, deps());
    expect(check(data.checks, "assets")).toMatchObject({
      status: "error", text: "3 assets · 1 error, 1 warning (details: croft validate)", details: { assets: 3, errors: 1, warnings: 1 },
    });
    expect(problems).toEqual([]);
    let out = "";
    const exit = await main(["doctor"], { cwd: root, env: {}, stdout: (t) => { out += t; }, stderr: () => {}, stdoutTTY: false });
    expect(exit).toBe(1);
    expect(out).toContain("  error 3 assets · 1 error, 1 warning (details: croft validate)");
  });

  test("before bun install, and without a DuckDB binding, the files are counted, not validated", async () => {
    const root = await project();
    const before = await runDoctor(root, deps());
    expect(check(before.data.checks, "assets")).toMatchObject({
      status: "info", text: "1 asset file, not validated until the project's packages are installed (bun install)",
    });
    installed(root);
    const broken = await runDoctor(root, deps({ probeDuckdb: () => ({ ok: false, message: "simulated" }) }));
    expect(check(broken.data.checks, "assets")).toMatchObject({
      status: "info", text: "1 asset file, not validated (validating needs the DuckDB binding)",
    });
  });
});

describe("warehouse checks", () => {
  test("not created yet", async () => {
    const { data } = await runDoctor(await project(), deps());
    expect(check(data.checks, "warehouse")).toMatchObject({ status: "ok", text: "warehouse.duckdb not created yet (the first croft run creates it)" });
  });

  test("written by a newer croft: DB_NEWER_FORMAT", async () => {
    const root = await project();
    await warehouse(root, { format_version: "99", croft_version: "9.0.0" });
    const { data, problems } = await runDoctor(root, deps());
    expect(check(data.checks, "warehouse")).toMatchObject({ status: "error", code: "DB_NEWER_FORMAT" });
    expect(problems[0]!.message).toContain("croft format 99");
  });

  test("a database croft has not written to yet, and a file that is not a database", async () => {
    const root = await project();
    await warehouse(root, null);
    expect(check((await runDoctor(root, deps())).data.checks, "warehouse").text).toContain("no croft state yet");

    const broken = await project();
    writeFileSync(join(broken, "warehouse.duckdb"), "this is not a duckdb file at all, just text".repeat(200));
    const { data, problems } = await runDoctor(broken, deps());
    expect(check(data.checks, "warehouse")).toMatchObject({ status: "error", code: "DB_UNREADABLE" });
    expect(check(data.checks, "warehouse").text).toContain("cannot be opened");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ severity: "error", code: "DB_UNREADABLE", details: { path: join(broken, "warehouse.duckdb") } });
    expect(problems[0]!.message).toContain("warehouse.duckdb cannot be opened as a DuckDB database");
  });

  test("the binding does not load: the file is described but not opened", async () => {
    const root = await project();
    await warehouse(root, { format_version: "1" });
    const { data } = await runDoctor(root, deps({ probeDuckdb: () => ({ ok: false, code: "MODULE_NOT_FOUND", message: "Cannot find module 'x'" }) }));
    expect(check(data.checks, "warehouse")).toMatchObject({ status: "info" });
    expect(check(data.checks, "warehouse").text).toContain("not opened");
  });

  test("held by another program: DB_HELD_BY_OTHER_PROGRAM naming its PID", async () => {
    const root = await project();
    const path = await warehouse(root, { format_version: "1" });
    // Like the DuckDB UI: holds the file read-write. Its command line must not mention croft.
    const holder = spawn(process.execPath, ["-e", `const { DuckDBInstance } = require(process.env.DUCKDB_API);
      (async () => { const db = await DuckDBInstance.create(process.env.DB_PATH); const c = await db.connect();
      await c.run("SELECT 1"); console.log("holding"); setInterval(() => {}, 1000); })();`], {
      env: { ...process.env, DUCKDB_API: require.resolve("@duckdb/node-api"), DB_PATH: path }, stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(holder);
    await waitForLine(holder, "holding");
    const started = performance.now();
    const { data, problems } = await runDoctor(root, deps());
    expect(performance.now() - started).toBeLessThan(1000);
    holder.kill("SIGKILL");
    const w = check(data.checks, "warehouse");
    expect(w).toMatchObject({ status: "error", code: "DB_HELD_BY_OTHER_PROGRAM", details: { heldBy: { pid: holder.pid } } });
    expect(w.text).toContain(`(PID ${holder.pid})`);
    expect(problems.find((p) => p.code === "DB_HELD_BY_OTHER_PROGRAM")!.hint).toContain("then retry");
  }, 20_000);

  test("a croft process holding the file without an intent (a race) is busy, not a foreign program", async () => {
    const root = await project();
    const path = await warehouse(root, { format_version: "1" });
    // isCroftCommand() recognizes croft by its command line.
    const holder = spawn(process.execPath, ["-e", `/* croft */ const { DuckDBInstance } = require(process.env.DUCKDB_API);
      (async () => { const db = await DuckDBInstance.create(process.env.DB_PATH); await db.connect(); console.log("holding"); setInterval(() => {}, 1000); })();`], {
      env: { ...process.env, DUCKDB_API: require.resolve("@duckdb/node-api"), DB_PATH: path }, stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(holder);
    await waitForLine(holder, "holding");
    const { data, problems } = await runDoctor(root, deps());
    holder.kill("SIGKILL");
    expect(check(data.checks, "warehouse")).toMatchObject({ status: "info", details: { heldBy: { pid: holder.pid, program: "croft" } } });
    expect(check(data.checks, "warehouse").text).toContain(`busy: croft (pid ${holder.pid}) is writing`);
    expect(problems).toEqual([]);
  }, 20_000);

  test("a croft run writing: busy, named from its write intent, not a problem", async () => {
    const root = await project();
    await warehouse(root, { format_version: "1" });
    const release = join(root, "release");
    const writer = spawn(process.execPath, ["-e", `const { openWarehouse } = await import(process.env.WH_TS);
      const { existsSync } = await import("node:fs");
      const w = openWarehouse({ path: process.env.DB_PATH, mode: "read_write", timezone: "UTC", root: process.env.ROOT, stateDir: process.env.STATE, isTTY: false, runId: "r_test" });
      await w.write("hold", async () => { console.log("holding"); while (!existsSync(process.env.RELEASE)) await new Promise((r) => setTimeout(r, 10)); }, { runId: "r_test" });
      await w.close();`], {
      env: { ...process.env, WH_TS: join(import.meta.dir, "../../db/warehouse.ts"), DB_PATH: join(root, "warehouse.duckdb"), ROOT: root, STATE: join(root, ".croft"), RELEASE: release },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(writer);
    await waitForLine(writer, "holding");
    const { data, problems } = await runDoctor(root, deps());
    writeFileSync(release, "");
    const w = check(data.checks, "warehouse");
    expect(w.status).toBe("info");
    expect(w.text).toContain("busy: croft run r_test is writing (not opened meanwhile)");
    expect(problems).toEqual([]);
  }, 20_000);
});

describe("croft serve detection", () => {
  test("not running, and a serve.json left by a dead process", async () => {
    const root = await project();
    expect(check((await runDoctor(root, deps())).data.checks, "serve")).toMatchObject({ status: "info", details: { running: false } });
    const dead = Bun.spawnSync(["true"]).pid;
    writeFileSync(join(root, ".croft", "serve.json"), JSON.stringify({ pid: dead, url: "http://127.0.0.1:1" }));
    const stale = check((await runDoctor(root, deps())).data.checks, "serve");
    expect(stale).toMatchObject({ status: "info", details: { running: false, stalePid: dead } });
  });

  test("a live server: address, pid, token file and today's queries; the warehouse shows it holds the file", async () => {
    const root = await project();
    await warehouse(root, { format_version: "1" });
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch(req) {
        seen.push(`${new URL(req.url).pathname} ${req.headers.get("authorization")}`);
        return Response.json({ ok: true, pid: process.pid, queriesToday: 1204 });
      },
    });
    try {
      writeFileSync(join(root, ".croft", "serve.json"), JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${server.port}`, token: "t0k3n" }));
      const { data, problems } = await runDoctor(root, deps());
      expect(check(data.checks, "serve")).toMatchObject({
        status: "ok", text: `read server on 127.0.0.1:${server.port} (pid ${process.pid}) · token in .croft/serve.json · 1,204 queries today`,
      });
      expect(seen).toEqual(["/health Bearer t0k3n"]);
      expect(check(data.checks, "warehouse").text).toContain(`held read-only by croft's read server (pid ${process.pid}; steps aside for writes)`);
      expect(problems).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("a live process that does not answer: SERVE_UNAVAILABLE", async () => {
    const root = await project();
    const closed = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = closed.port;
    closed.stop(true);
    writeFileSync(join(root, ".croft", "serve.json"), JSON.stringify({ pid: process.pid, host: "127.0.0.1", port }));
    const { data, problems } = await runDoctor(root, deps());
    expect(check(data.checks, "serve")).toMatchObject({ status: "error", code: "SERVE_UNAVAILABLE" });
    expect(problems[0]!.retryable).toBe(true);
  });
});

describe("project checks", () => {
  test("a database in a synced folder: DB_ON_SYNCED_FOLDER with the relocation fix", async () => {
    const root = await project();
    const { data, problems } = await runDoctor(root, deps({ synced: (p) => (p.startsWith(root) ? "iCloud Drive" : null) }));
    expect(check(data.checks, "storage")).toMatchObject({ status: "warn", code: "DB_ON_SYNCED_FOLDER" });
    expect(problems.map((x) => x.code)).toEqual(["DB_ON_SYNCED_FOLDER"]);
    const p = problems[0]!;
    expect(p.severity).toBe("warning");
    expect(p.fix).toMatchObject({ kind: "manual", requiresHuman: true });
    expect(p.hint).toContain(`"database": "~/.local/share/croft/`);
  });

  test("a database on a network filesystem or a WSL drive: SERVE_UNSAFE_FILESYSTEM", async () => {
    const root = await project();
    for (const why of ["a network filesystem (nfs)", "a network filesystem (9p)", "a Windows drive under WSL (/mnt/<drive>)"]) {
      const { data, problems } = await runDoctor(root, deps({ synced: (p) => (p.startsWith(root) ? why : null) }));
      expect(check(data.checks, "storage")).toMatchObject({ status: "error", code: "SERVE_UNSAFE_FILESYSTEM" });
      expect(problems.map((x) => x.code)).toEqual(["SERVE_UNSAFE_FILESYSTEM"]);
      expect(problems[0]!.message).toContain(why);
    }
  });

  test("a relocated project in a synced folder is fine", async () => {
    const home = join(base, `home${n++}`);
    const target = join(home, "Documents", "sales");
    await initProject({ target, install: false, timezone: "UTC", home, synced: (p) => (p.includes("/Documents/") ? "iCloud Drive" : null) });
    const { data, problems } = await runDoctor(target, deps({ home, synced: (p) => (p.includes("/Documents/") ? "iCloud Drive" : null) }));
    expect(check(data.checks, "storage").status).toBe("ok");
    expect(check(data.checks, "storage").text).toContain("the project folder is in iCloud Drive; the database and .croft/ live in");
    expect(data.project?.relocated).toBe(true);
    expect(problems).toEqual([]);
  });

  test("an unwritable state folder", async () => {
    if (process.getuid?.() === 0) return;                         // root can write anywhere
    const root = await project();
    chmodSync(join(root, ".croft"), 0o500);
    try {
      const { data, problems } = await runDoctor(root, deps());
      expect(check(data.checks, "writable")).toMatchObject({ status: "error", code: "PROJECT_NOT_WRITABLE" });
      expect(problems.map((p) => p.code)).toEqual(["PROJECT_NOT_WRITABLE"]);
      expect(problems[0]!.details).toMatchObject({ dir: join(root, ".croft"), error: "EACCES" });
    } finally {
      chmodSync(join(root, ".croft"), 0o700);
    }
  });

  test("before the first run the write test uses the project folder", async () => {
    const root = await project();
    rmSync(join(root, ".croft"), { recursive: true });
    const { data } = await runDoctor(root, deps());
    expect(check(data.checks, "writable")).toMatchObject({ status: "ok", text: "the project folder is writable" });
  });

  test("ENV_FILE_IGNORED and ENV_FILE_INVALID", async () => {
    const root = await project();
    writeFileSync(join(root, ".env.local"), "X=1\n");
    writeFileSync(join(root, ".env"), "GOOD=1\nnot a pair\n");
    const { data, problems } = await runDoctor(root, deps());
    expect(problems.map((p) => p.code).sort()).toEqual(["ENV_FILE_IGNORED", "ENV_FILE_INVALID"]);
    expect(data.checks.filter((c) => c.id === "env").map((c) => c.status)).toEqual(["warn", "warn"]);
    expect(problems.find((p) => p.code === "ENV_FILE_IGNORED")!.file).toBe(".env.local");
  });

  describe("declared secrets (§2: SECRET_MISSING)", () => {
    // charges names its secret in a literal; gh builds its list at import time, so only importing finds GH_TOKEN.
    // Neither asset's rows() may run: it would write a file into the project.
    const CHARGES = `import { ingest } from "@zabaca/croft";
export default ingest({ secrets: ["STRIPE_KEY"], key: "id", async *rows() { await Bun.write("ran-charges", "x"); yield []; } });
`;
    const GH = `import { ingest } from "@zabaca/croft";
const names = ["GH" + "_TOKEN", "STRIPE_KEY"];
export default ingest({ secrets: names, key: "id", async *rows() { await Bun.write("ran-gh", "x"); yield []; } });
`;
    async function withSecrets(): Promise<string> {
      const root = await project();
      mkdirSync(join(root, "node_modules", "@zabaca"), { recursive: true });
      symlinkSync(SELF_ROOT, join(root, "node_modules", "@zabaca", "croft"));
      writeFileSync(join(root, "assets", "charges.ts"), CHARGES);
      writeFileSync(join(root, "assets", "gh.ts"), GH);
      return root;
    }

    test("each missing one is a warning naming the assets that use it, with the .env fix; nothing runs or is written", async () => {
      const root = await withSecrets();
      const before = tree(root);
      const { data, problems } = await runDoctor(root, deps());
      const missing = problems.filter((p) => p.code === "SECRET_MISSING");
      expect(missing.map((p) => p.details?.name)).toEqual(["GH_TOKEN", "STRIPE_KEY"]);
      for (const p of missing) {
        expect(p.severity).toBe("warning");
        expect(p.hint).toBe(`add ${p.details!.name}=... to .env (or run \`croft secrets set ${p.details!.name}\` in your terminal)`);
        expect(p.fix).toMatchObject({ kind: "manual", requiresHuman: true });
        expect(p.fix!.description).toContain(".env");
      }
      expect(missing[1]!.details).toEqual({ name: "STRIPE_KEY", usedBy: ["charges", "gh"] });
      const lines = data.checks.filter((c) => c.id === "secrets");
      expect(lines.map((c) => [c.status, c.code, c.text])).toEqual([
        ["warn", "SECRET_MISSING", "GH_TOKEN (used by gh)"],
        ["warn", "SECRET_MISSING", "STRIPE_KEY (used by charges, gh)"],
      ]);
      expect(lines.every((c) => c.section === "project")).toBe(true);
      expect(data.summary.warnings).toBe(2);
      expect(data.summary.errors).toBe(0);
      expect(tree(root)).toEqual(before);
      // The §2 layout: the code and the names on the check line, the fix under it.
      const human = formatDoctor(data, problems);
      expect(human).toContain("  warn  SECRET_MISSING STRIPE_KEY (used by charges, gh)\n        fix: add STRIPE_KEY=... to .env (or run `croft secrets set STRIPE_KEY` in your terminal)");
    });

    test("set in .env or in the environment: one ok line, no problem", async () => {
      const root = await withSecrets();
      writeFileSync(join(root, ".env"), "STRIPE_KEY=sk_test_123\n");
      const { data, problems } = await runDoctor(root, deps({ env: { GH_TOKEN: "ghp_abc" } }));
      expect(problems.filter((p) => p.code === "SECRET_MISSING")).toEqual([]);
      expect(data.checks.filter((c) => c.id === "secrets").map((c) => [c.status, c.text])).toEqual([["ok", "secrets: GH_TOKEN, STRIPE_KEY set"]]);
      // An empty value is not set.
      const empty = await runDoctor(root, deps({ env: { GH_TOKEN: "" } }));
      expect(empty.problems.filter((p) => p.code === "SECRET_MISSING").map((p) => p.details?.name)).toEqual(["GH_TOKEN"]);
    });

    test("an asset that does not import still has its literal secrets checked; no declared secrets means no line", async () => {
      const root = await project();
      writeFileSync(join(root, "assets", "charges.ts"), CHARGES.replace("async *rows", "broken syntax ( async *rows"));
      const { data, problems } = await runDoctor(root, deps());
      expect(problems.filter((p) => p.code === "SECRET_MISSING").map((p) => p.details?.name)).toEqual(["STRIPE_KEY"]);
      const plain = await project();
      expect((await runDoctor(plain, deps())).data.checks.some((c) => c.id === "secrets")).toBe(false);
      expect(data.checks.filter((c) => c.id === "secrets")).toHaveLength(1);
    });

    test("not checked when the DuckDB binding does not load (finding the assets needs it)", async () => {
      const root = await withSecrets();
      const { data, problems } = await runDoctor(root, deps({ probeDuckdb: () => ({ ok: false, code: "ERR_DLOPEN_FAILED", message: "dlopen failed" }) }));
      expect(problems.some((p) => p.code === "SECRET_MISSING")).toBe(false);
      expect(data.checks.filter((c) => c.id === "secrets").map((c) => c.status)).toEqual(["info"]);
    });
  });

  test("CLAUDE_FILES_OUTDATED: old stamp, missing skill, edited block; fixed by croft init --claude", async () => {
    const root = await project();
    writeFileSync(join(root, SKILL_PATH), skillMd("0.0.1"));
    const old = await runDoctor(root, deps());
    const p = old.problems.find((x) => x.code === "CLAUDE_FILES_OUTDATED")!;
    expect(p.message).toContain(`${SKILL_PATH} is for croft 0.0.1; this is croft ${CROFT_VERSION}`);
    expect(p.fix).toEqual({ kind: "command", description: "refresh CLAUDE.md's croft block and the croft skill", command: "croft init --claude" });
    expect(CODES.CLAUDE_FILES_OUTDATED.severity).toBe("warning");

    rmSync(join(root, SKILL_PATH));
    writeFileSync(join(root, "CLAUDE.md"), "<!-- croft:start -->\nold words\n<!-- croft:end -->\n");
    const worse = await runDoctor(root, deps());
    expect(worse.problems.find((x) => x.code === "CLAUDE_FILES_OUTDATED")!.details!.reasons).toEqual([
      `${SKILL_PATH} is missing`, `CLAUDE.md's croft block differs from croft ${CROFT_VERSION}'s`,
    ]);

    await initProject({ target: root, claudeOnly: true });
    expect(check((await runDoctor(root, deps())).data.checks, "claude").status).toBe("ok");
  });

  test("an app repo's root block is checked too", async () => {
    const root = await project({ app: true });
    expect(check((await runDoctor(root, deps())).data.checks, "claude").status).toBe("ok");
    writeFileSync(join(root, "..", "CLAUDE.md"), "# App only\n");
    const r = await runDoctor(root, deps());
    expect(r.problems[0]!.details!.reasons).toEqual(["../CLAUDE.md has no croft block"]);
  });

  test("a broken croft.json: every issue as CONFIG_INVALID; the other project checks still run", async () => {
    const root = await project();
    writeFileSync(join(root, "croft.json"), `{"timezone": "Pacific", "databse": "x.duckdb"}`);
    const { data, problems } = await runDoctor(root, deps());
    expect(problems.filter((p) => p.code === "CONFIG_INVALID")).toHaveLength(2);
    expect(data.checks.some((c) => c.id === "warehouse")).toBe(false);
    expect(check(data.checks, "claude").status).toBe("ok");
    expect(data.project).toBeNull();
  });
});

describe("human output", () => {
  test("sections, status labels and the summary line (§2 layout)", () => {
    const text = formatDoctor({
      checks: [
        { id: "bun", section: "environment", status: "ok", text: "bun 1.3.14 (darwin-arm64), needs >= 1.3.14" },
        { id: "serve", section: "environment", status: "info", text: "croft serve is not running" },
        { id: "env", section: "project", status: "warn", text: "ENV_FILE_IGNORED .env.local: ignored", code: "ENV_FILE_IGNORED" },
        { id: "claude", section: "project", status: "error", text: "first line\nsecond line" },
      ],
      summary: { ok: 1, info: 1, warnings: 1, errors: 1 },
      project: null,
    });
    expect(text).toBe([
      "Environment",
      "  ok    bun 1.3.14 (darwin-arm64), needs >= 1.3.14",
      "  info  croft serve is not running",
      "Project",
      "  warn  ENV_FILE_IGNORED .env.local: ignored",
      "  error first line",
      "        second line",
      "1 error, 1 warning",
    ].join("\n"));
    expect(formatDoctor({ checks: [], summary: { ok: 0, info: 0, warnings: 0, errors: 0 }, project: null })).toBe("no problems found");
  });

  test("formatBytes", () => {
    expect([0, 1023, 1024, 1536, 412 * 1024 * 1024, 5 * 1024 ** 3].map(formatBytes)).toEqual(["0 B", "1023 B", "1 KB", "1.5 KB", "412 MB", "5 GB"]);
  });

  test("each problem is shown under its check, with its fix, and nowhere else (§2)", () => {
    const text = formatDoctor({
      checks: [
        { id: "bun", section: "environment", status: "ok", text: "bun 1.3.14 (darwin-arm64), needs >= 1.3.14" },
        { id: "claude", section: "project", status: "warn", text: "CLAUDE_FILES_OUTDATED SKILL.md is old", code: "CLAUDE_FILES_OUTDATED" },
        { id: "writable", section: "project", status: "error", text: ".croft/ is not writable (EACCES)", code: "PROJECT_NOT_WRITABLE" },
      ],
      summary: { ok: 1, info: 0, warnings: 1, errors: 1 },
      project: null,
    }, [
      { severity: "warning", code: "CLAUDE_FILES_OUTDATED", message: "m", hint: "run croft init --claude", docs: "croft docs CLAUDE_FILES_OUTDATED",
        fix: { kind: "command", description: "refresh", command: "croft init --claude" } },
      { severity: "error", code: "PROJECT_NOT_WRITABLE", message: "m", hint: "make /p/.croft writable for your user", docs: "croft docs PROJECT_NOT_WRITABLE",
        fix: { kind: "manual", description: "make /p/.croft writable for your user", requiresHuman: true } },
    ]);
    expect(text).toBe([
      "Environment",
      "  ok    bun 1.3.14 (darwin-arm64), needs >= 1.3.14",
      "Project",
      "  warn  CLAUDE_FILES_OUTDATED SKILL.md is old",
      "        fix: croft init --claude",
      "  error PROJECT_NOT_WRITABLE .croft/ is not writable (EACCES)",
      "        fix: make /p/.croft writable for your user",
      "1 error, 1 warning",
    ].join("\n"));
  });

  test("croft doctor prints problems inline, not again after the summary", async () => {
    const root = await project();
    writeFileSync(join(root, ".env"), "GOOD=1\nnot a pair\n");
    let out = "";
    const exit = await main(["doctor"], { cwd: root, env: {}, stdout: (t) => { out += t; }, stderr: () => {}, stdoutTTY: false });
    expect(exit).toBe(0);
    expect(out).toContain("  warn  ENV_FILE_INVALID .env: line 2");
    expect(out).toContain("        fix: fix that line of .env (KEY=value)\n");
    expect(out.match(/ENV_FILE_INVALID/g)).toHaveLength(1);
    // The summary is the last line: no problem block is appended after it (the pinned croft is not installed
    // in this fixture, which is the other warning).
    expect(out.trimEnd().split("\n").at(-1)).toBe("2 warnings");
  });

  test("the real command prints sections and exits 0 on a healthy project", async () => {
    const root = await project();
    let out = "";
    const exit = await main(["doctor"], { cwd: root, env: {}, stdout: (t) => { out += t; }, stderr: () => {}, stdoutTTY: false });
    expect(exit).toBe(0);
    expect(out.split("\n")[0]).toBe("Environment");
    expect(out).toContain("\nProject\n");
    expect(out).toContain("  ok    storage: local disk (not a synced or network folder)");
  });
});

describe("TZDATA_MISMATCH: Bun's Intl and DuckDB's ICU agree on the project zone for the next 2 years", () => {
  const LA = "America/Los_Angeles";
  const NOW = "2026-09-23T00:00:00Z";
  const intl = (tz: string, instants: readonly number[]) => instants.map((t) => offsetSeconds(t, tz));

  test("agreement is silent", async () => {
    const root = await project({ timezone: LA });
    const asked: number[][] = [];
    const { data, problems } = await runDoctor(root, deps({
      env: { CROFT_NOW: NOW }, duckdbOffsets: async (tz, instants) => { asked.push([...instants]); return intl(tz, instants); },
    }));
    expect(data.checks.find((c) => c.id === "tzdata")).toBeUndefined();
    expect(problems.filter((p) => p.code === "TZDATA_MISMATCH")).toEqual([]);
    // Sampled at least monthly across two years, and densely around LA's four DST transitions in that span.
    const coarse = asked[0]!;
    expect(coarse[0]).toBe(Date.parse(NOW));
    expect(coarse.at(-1)! - coarse[0]!).toBeGreaterThanOrEqual(730 * 86_400_000);
    expect(Math.max(...coarse.slice(1).map((t, i) => t - coarse[i]!))).toBeLessThanOrEqual(31 * 86_400_000);
    const fine = asked[1]!;
    expect(fine).toContain(Date.parse("2026-11-01T09:00:00Z"));                  // fall back at 02:00 PDT
    expect(fine).toContain(Date.parse("2027-03-14T10:00:00Z"));                  // spring forward at 02:00 PST
  });

  test("a different offset, or a different switch time, is a warning with where it happens", async () => {
    const root = await project({ timezone: LA });
    // DuckDB's data (simulated) springs forward an hour later in 2027 and ignores DST from 2028.
    const skewed = async (tz: string, instants: readonly number[]) => instants.map((t) => {
      if (t >= Date.parse("2028-01-01T00:00:00Z")) return -8 * 3600;
      if (t >= Date.parse("2027-03-14T10:00:00Z") && t < Date.parse("2027-03-14T11:00:00Z")) return -8 * 3600;
      return offsetSeconds(t, tz);
    });
    const { data, problems } = await runDoctor(root, deps({ env: { CROFT_NOW: NOW }, duckdbOffsets: skewed }));
    const p = problems.find((x) => x.code === "TZDATA_MISMATCH")!;
    expect(p.severity).toBe("warning");
    expect(p.message).toContain("America/Los_Angeles");
    expect(p.message).toContain("2027-03-14T10:00:00Z (Bun -07:00, DuckDB -08:00)");
    expect(p.hint).toContain("::DATE");
    expect(p.details).toMatchObject({ timezone: LA, first: { at: "2027-03-14T10:00:00Z", bun: "-07:00", duckdb: "-08:00" } });
    expect(p.details!.mismatches).toBeGreaterThan(4);
    expect(check(data.checks, "tzdata")).toMatchObject({ section: "environment", status: "warn", code: "TZDATA_MISMATCH" });
    expect(data.summary.warnings).toBeGreaterThanOrEqual(1);
  });

  test("a zone DuckDB does not know is reported; a failing comparison is only info", async () => {
    const root = await project({ timezone: LA });
    const unknown = await runDoctor(root, deps({ env: { CROFT_NOW: NOW }, duckdbOffsets: async () => null }));
    expect(unknown.problems.find((x) => x.code === "TZDATA_MISMATCH")!.message).toContain("DuckDB's time zone data does not know America/Los_Angeles");
    const broken = await runDoctor(root, deps({ env: { CROFT_NOW: NOW }, duckdbOffsets: async () => { throw new Error("boom"); } }));
    expect(check(broken.data.checks, "tzdata")).toMatchObject({ status: "info" });
    expect(broken.problems.filter((x) => x.code === "TZDATA_MISMATCH")).toEqual([]);
  });

  test("not compared when the DuckDB binding does not load", async () => {
    const root = await project({ timezone: LA });
    let called = false;
    const { data } = await runDoctor(root, deps({
      probeDuckdb: () => ({ ok: false, code: "MODULE_NOT_FOUND", message: "Cannot find module 'x'" }),
      duckdbOffsets: async () => { called = true; return []; },
    }));
    expect(called).toBe(false);
    expect(data.checks.find((c) => c.id === "tzdata")).toBeUndefined();
  });

  test("the real DuckDB: offsets through SET TimeZone, null for an unknown zone", async () => {
    const winter = Date.parse("2027-01-15T12:00:00Z");
    const summer = Date.parse("2027-07-15T12:00:00Z");
    expect(await duckdbOffsets(LA, [winter, summer])).toEqual([-8 * 3600, -7 * 3600]);
    expect(await duckdbOffsets("Asia/Kolkata", [winter])).toEqual([19800]);
    expect(await duckdbOffsets("Nowhere/Nope", [winter])).toBeNull();
  });

  test("the real DuckDB for Africa/Casablanca: the verdict matches a direct comparison", async () => {
    // Casablanca's rules are where Bun's and DuckDB's bundled data have drifted apart before.
    const tz = "Africa/Casablanca";
    const root = await project({ timezone: tz });
    const monthly = Array.from({ length: 25 }, (_, i) => Date.UTC(2026, 8 + i, 23));
    const duck = (await duckdbOffsets(tz, monthly))!;
    const differs = monthly.some((t, i) => duck[i] !== offsetSeconds(t, tz));
    const { problems } = await runDoctor(root, deps({ env: { CROFT_NOW: NOW } }));
    if (differs) expect(problems.map((p) => p.code)).toContain("TZDATA_MISMATCH");
  });
});

// The Scheduling section (§2 example, §8): who ticks and when it last did; SCHEDULER_STALE with the diagnosis. A fake
// ~/.croft (CROFT_HOME under a temp HOME) and a fake OsRunner: nothing here reads or runs the real scheduler.
describe("the Scheduling section", () => {
  const TICKED = "2026-09-24T17:04:48.000Z";
  const AT = "2026-09-24T17:05:00.000Z";

  function fakeHome() {
    const userHome = join(base, `home${n++}`);
    mkdirSync(userHome, { recursive: true });
    return croftHome({ HOME: userHome, CROFT_HOME: join(userHome, ".croft"), CROFT_JOB_LABEL: `dev.croft.test-${process.pid}-${n}` });
  }

  function recorder(respond: (argv: readonly string[]) => { status: number; stderr?: string } = () => ({ status: 0 })) {
    const calls: string[][] = [];
    const runner: OsRunner = { exec: (argv) => (calls.push([...argv]), { stdout: "", stderr: "", ...respond(argv) }) };
    return { runner, calls };
  }

  function turnOn(root: string, s: { state: "on" | "paused"; via: "os-job" | "serve"; pausedUntil?: string | null }, o: { since?: string; heartbeat?: string } = {}) {
    const db = RunsDb.open(join(root, ".croft"));
    db.setScheduling(s);
    db.setSetting(SINCE_KEY, o.since ?? "2026-09-24T16:00:00.000Z");
    if (o.heartbeat) db.heartbeat(o.heartbeat);
    db.close();
  }

  test("off: an info line, and runs.sqlite is not created", async () => {
    const root = await project();
    const { data, problems } = await runDoctor(root, deps({ env: { CROFT_NOW: AT } }));
    expect(check(data.checks, "scheduling")).toEqual({
      id: "scheduling", section: "scheduling", status: "info", text: "off (croft schedule on runs the scheduled ingests on their schedules)",
      details: { state: "off", via: null, lastTickAt: null },
    });
    expect(problems).toEqual([]);
    expect(existsSync(join(root, ".croft", "runs.sqlite"))).toBe(false);
  });

  test("on, ticked by croft serve: the §2 line", async () => {
    const root = await project({ timezone: "America/Los_Angeles" });
    turnOn(root, { state: "on", via: "serve" }, { heartbeat: TICKED });
    writeFileSync(join(root, ".croft", "serve.json"), JSON.stringify({ pid: process.pid, url: "http://127.0.0.1:1" }));
    const { data } = await runDoctor(root, deps({ env: { CROFT_NOW: AT }, croftHome: fakeHome() }));
    expect(check(data.checks, "scheduling")).toMatchObject({
      status: "ok", text: `on · ticks from croft serve (pid ${process.pid}) · last tick 12 s ago`,
      details: { state: "on", via: "serve", lastTickAt: "2026-09-24T10:04:48-07:00", stale: false },
    });
  });

  test("on, ticked by the OS job, and paused", async () => {
    const root = await project();
    turnOn(root, { state: "on", via: "os-job" }, { heartbeat: TICKED });
    const { runner, calls } = recorder();
    const on = await runDoctor(root, deps({ env: { CROFT_NOW: AT }, croftHome: fakeHome(), osRunner: runner }));
    expect(check(on.data.checks, "scheduling")).toMatchObject({ status: "ok", text: "on · ticks from the per-user OS job · last tick 12 s ago" });
    expect(calls).toEqual([]);   // a healthy scheduler is not inspected
    turnOn(root, { state: "paused", via: "os-job", pausedUntil: "2026-09-24T19:00:00.000Z" });
    const paused = await runDoctor(root, deps({ env: { CROFT_NOW: AT }, croftHome: fakeHome() }));
    expect(check(paused.data.checks, "scheduling")).toMatchObject({ status: "ok", text: "paused until 04:00 (croft schedule on resumes it now) · last tick 12 s ago" });
  });

  test("paused, ticked by croft serve only: resumed with croft schedule on --no-os-job (R32-10)", async () => {
    const root = await project();
    turnOn(root, { state: "paused", via: "serve", pausedUntil: "2026-09-24T19:00:00.000Z" }, { heartbeat: TICKED });
    const until = await runDoctor(root, deps({ env: { CROFT_NOW: AT }, croftHome: fakeHome() }));
    expect(check(until.data.checks, "scheduling")).toMatchObject({
      status: "ok", text: "paused until 04:00 (croft schedule on --no-os-job resumes it now) · last tick 12 s ago",
    });
    turnOn(root, { state: "paused", via: "serve", pausedUntil: null });
    const open = await runDoctor(root, deps({ env: { CROFT_NOW: AT }, croftHome: fakeHome() }));
    expect(check(open.data.checks, "scheduling")).toMatchObject({ status: "ok", text: "paused until croft schedule on --no-os-job · last tick 12 s ago" });
  });

  test("stale: SCHEDULER_STALE with the cause, the tick log under it, and the fix", async () => {
    const root = await project();
    const home = fakeHome();
    addProject(home, { root, via: "os-job" });
    mkdirSync(home.logDir, { recursive: true });
    writeFileSync(home.tickLog, "2026-09-24T16:55:00.000Z tick: 1 project\n");
    turnOn(root, { state: "on", via: "os-job" }, { heartbeat: "2026-09-24T16:55:00.000Z" });
    // launchd does not know the job, and its plist is gone.
    const { runner, calls } = recorder((argv) => (argv[1] === "print" ? { status: 113, stderr: "Could not find service" } : { status: 0 }));
    const { data, problems } = await runDoctor(root, deps({ env: { CROFT_NOW: AT }, croftHome: home, osRunner: runner, platform: "darwin" }));
    const c = check(data.checks, "scheduling");
    expect(c).toMatchObject({ status: "warn", code: "SCHEDULER_STALE", details: { state: "on", stale: true } });
    expect(c.text.split("\n")).toEqual([
      "on · ticks from the per-user OS job · last tick 10 min ago (stale)",
      `${home.tickLog}, last lines:`,
      "  2026-09-24T16:55:00.000Z tick: 1 project",
    ]);
    expect(calls.map((x) => x[1])).toContain("print");
    expect(problems).toEqual([expect.objectContaining({
      code: "SCHEDULER_STALE", severity: "warning", fix: expect.objectContaining({ kind: "command", command: "croft schedule on" }),
      details: expect.objectContaining({ cause: "job_missing" }),
    })]);
    const out = formatDoctor(data, problems);
    expect(out).toContain([
      "Scheduling",
      "  warn  SCHEDULER_STALE on · ticks from the per-user OS job · last tick 10 min ago (stale)",
      `        ${home.tickLog}, last lines:`,
      "          2026-09-24T16:55:00.000Z tick: 1 project",
      "        fix: croft schedule on",
    ].join("\n"));
  });
});

describe("storage: filesystems whose locks do not hold across machines (db/fs-kind.ts)", () => {
  test("the database or .croft/ on a VM or container share, or a network mount: SERVE_UNSAFE_FILESYSTEM", async () => {
    const root = await project();
    const share: FsKind = { type: "virtiofs", mountPoint: "/mnt/share", source: "mounts", unsafe: "virtiofs, a VM or container file share" };
    const seen: string[] = [];
    const { data, problems } = await runDoctor(root, deps({ filesystem: (p) => (seen.push(p), p.endsWith("warehouse.duckdb") ? share : LOCAL) }));
    expect(seen).toEqual([join(root, "warehouse.duckdb"), join(root, ".croft")]);
    expect(check(data.checks, "storage")).toMatchObject({ status: "error", code: "SERVE_UNSAFE_FILESYSTEM" });
    expect(problems.map((x) => x.code)).toEqual(["SERVE_UNSAFE_FILESYSTEM"]);
    expect(problems[0]!.message).toBe("the database is on virtiofs, a VM or container file share, where DuckDB's file lock does not hold across machines and writes can be lost");
    expect(problems[0]!.fix).toMatchObject({ kind: "manual", requiresHuman: true });
    expect(problems[0]!.hint).toContain(`"database": "~/.local/share/croft/`);
    expect(problems[0]!.details).toMatchObject({ reason: "virtiofs, a VM or container file share", filesystem: "virtiofs", mountPoint: "/mnt/share" });
  });

  test("a local disk is ok, and a probe that cannot tell says nothing", async () => {
    const root = await project();
    expect(check((await runDoctor(root, deps())).data.checks, "storage").status).toBe("ok");
    const unknown: FsKind = { type: null, mountPoint: null, source: "none", unsafe: null };
    expect(check((await runDoctor(root, deps({ filesystem: () => unknown }))).data.checks, "storage").status).toBe("ok");
  });
});
