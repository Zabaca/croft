import { afterAll, describe, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { CODES } from "../../core/errors.ts";
import { CROFT_VERSION, SKILL_PATH, skillMd } from "../../agent/templates.ts";
import { initProject } from "../../project/init.ts";
import { SELF_ROOT } from "../launcher.ts";
import { main } from "../main.ts";
import { BUN_TESTED, type DoctorCheck, type DoctorDeps, type DuckdbProbe, formatBytes, formatDoctor, probeDuckdb, runDoctor } from "./doctor.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "doctor-")));
const children: ChildProcess[] = [];
afterAll(() => {
  children.forEach((c) => c.kill("SIGKILL"));
  rmSync(base, { recursive: true, force: true });
});
let n = 0;

/** A fresh project made by croft init (so its Claude files are current). */
async function project(o: { app?: boolean } = {}): Promise<string> {
  const dir = join(base, `p${n++}`);
  mkdirSync(dir, { recursive: true });
  if (o.app) writeFileSync(join(dir, "package.json"), "{}");
  const r = await initProject({ target: dir, install: false, timezone: "Asia/Tokyo", synced: () => null });
  return r.root;
}

const OK_PROBE: DuckdbProbe = { ok: true, version: "v1.5.5", extensions: ["autocomplete", "core_functions", "icu", "json", "parquet"], platformArch: `${process.platform}-${process.arch}` };

function deps(o: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    bunVersion: "1.3.14", platform: process.platform, arch: process.arch, croftRoot: SELF_ROOT, env: {}, home: join(base, "home"),
    wsl: false, probeDuckdb: () => OK_PROBE, rosetta: () => false, synced: () => null, lockWaitMs: 150, healthTimeoutMs: 300, ...o,
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
    expect(checks.map((c) => c.id)).toEqual(["bun", "croft", "duckdb", "warehouse", "serve", "config", "storage", "writable", "env", "claude"]);
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
    expect(check(newer.data.checks, "bun")).toMatchObject({ status: "warn", details: { tested: BUN_TESTED } });
    expect(check(newer.data.checks, "bun").text).toContain(`newer than the newest Bun croft ${CROFT_VERSION} was tested on`);
    expect(newer.problems).toEqual([]);
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
    expect(fp.message).toBe(`the DuckDB binding for linux-s390x is not installed (node_modules has ${here}: installed on another machine or by another Bun?)`);
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
    expect(check(data.checks, "warehouse").status).toBe("error");
    expect(check(data.checks, "warehouse").text).toContain("cannot be opened");
    expect(problems).toEqual([]);
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
    expect(problems.find((p) => p.code === "DB_HELD_BY_OTHER_PROGRAM")!.hint).toContain("croft serve");
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
        status: "ok", text: `croft serve on 127.0.0.1:${server.port} (pid ${process.pid}) · token in .croft/serve.json · 1,204 queries today`,
      });
      expect(seen).toEqual(["/health Bearer t0k3n"]);
      expect(check(data.checks, "warehouse").text).toContain(`held read-only by croft serve (pid ${process.pid}; steps aside for writes)`);
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
  test("a database in a synced folder: SERVE_UNSAFE_FILESYSTEM with the relocation fix", async () => {
    const root = await project();
    const { data, problems } = await runDoctor(root, deps({ synced: (p) => (p.startsWith(root) ? "iCloud Drive" : null) }));
    expect(check(data.checks, "storage")).toMatchObject({ status: "error", code: "SERVE_UNSAFE_FILESYSTEM" });
    const p = problems.find((x) => x.code === "SERVE_UNSAFE_FILESYSTEM")!;
    expect(p.fix).toMatchObject({ kind: "manual", requiresHuman: true });
    expect(p.hint).toContain(`"database": "~/.local/share/croft/`);
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
      expect(check(data.checks, "writable")).toMatchObject({ status: "error", code: "REQUIRES_HUMAN" });
      expect(problems.find((p) => p.code === "REQUIRES_HUMAN")!.details).toMatchObject({ check: "project_writable" });
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
