// Server mode in the commands that show it (DESIGN.md D119, D121; option 06, slice 2): croft doctor and croft status say
// the project is in server mode, the copy's as-of time and whether croft serve is live, and warn what a refresh costs
// where the filesystem cannot clone; the serve banner says what it answers from. The filesystem is simulated by the `cp`
// the policy tries (a script), and the warehouse's size by a sparse file, because the policy reads only its size.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SELF_ROOT } from "../launcher.ts";
import { cleanup as cleanupChildren, spawnIdle, writeServeJson } from "../../read/testkit.ts";
import { loadProject } from "../../project/root.ts";
import { defaultDeps, type DoctorDeps, formatDoctor, runDoctor } from "./doctor.ts";
import { cleanup, cli, makeProject, type TestProject } from "./inspect-testkit.ts";
import { formatBanner, type ServeData } from "./serve.ts";
import { collectStatus, formatStatus } from "./status.ts";

const scratch: string[] = [];
afterAll(async () => {
  cleanupChildren();
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  await cleanup();
});

const GB = 1_000_000_000;
const AT = "2026-09-24T17:05:00.000Z"; // 10:05 in Los Angeles

/** A `cp` that cannot clone, as on ext4: it refuses the clone flags and otherwise copies. */
function cpWithoutClone(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "croft-cp-")));
  scratch.push(dir);
  const f = join(dir, "cp");
  writeFileSync(f, '#!/bin/sh\nfor a in "$@"; do case "$a" in -c|--reflink=always) echo "clone not supported" >&2; exit 1;; esac; done\nexec /bin/cp "$@"\n');
  chmodSync(f, 0o755);
  return f;
}

/** A project in server mode (or with a plain read copy) with a warehouse file of `bytes` and, if given, a copy made at `copyAt`. */
function serverProject(o: { serverMode?: Record<string, unknown> | null; readCopy?: boolean; bytes?: number; copyAt?: string } = {}): TestProject {
  const p = makeProject();
  const config = {
    database: "warehouse.duckdb", timezone: "America/Los_Angeles",
    ...(o.serverMode === null ? {} : { serverMode: o.serverMode ?? { enabled: true } }),
    ...(o.readCopy ? { readCopy: true } : {}),
  };
  writeFileSync(join(p.root, "croft.json"), JSON.stringify(config));
  writeFileSync(p.database, "");
  truncateSync(p.database, o.bytes ?? 1_000_000);
  if (o.copyAt) {
    const copy = loadProject({ root: p.root }).paths.readCopy;
    writeFileSync(copy, "a copy");
    utimesSync(copy, new Date(o.copyAt), new Date(o.copyAt));
  }
  return { ...p, project: loadProject({ root: p.root }) };
}

function deps(o: Partial<DoctorDeps> = {}): DoctorDeps {
  return { ...defaultDeps({ CROFT_NOW: AT, CROFT_BUN_VERSION: "1.3.14" }), croftRoot: SELF_ROOT, home: join(tmpdir(), "no-home"), filesystem: () => ({ type: "apfs", mountPoint: "/", source: "mounts", unsafe: null }), ...o };
}

describe("croft doctor", () => {
  test("server mode on: a line with the copy's as-of time, and that croft serve is not running", async () => {
    const p = serverProject({ copyAt: "2026-09-24T17:00:00.000Z" });
    const { data } = await runDoctor(p.root, deps());
    const line = data.checks.find((c) => c.id === "servermode")!;
    expect(line).toMatchObject({ section: "environment", status: "ok", details: { serving: false, asOf: "2026-09-24T10:00:00-07:00" } });
    expect(line.text).toBe("server mode on · croft serve is not running: apps read the warehouse file directly · copy as of 10:00");
    expect(data.checks.find((c) => c.id === "readcopy")!.text).toContain("as of 10:00");
  });

  test("before the first run it says there is no copy yet", async () => {
    const p = serverProject();
    const { data } = await runDoctor(p.root, deps());
    expect(data.checks.find((c) => c.id === "servermode")!.text).toContain("no copy yet");
  });

  test("with croft serve running it says so, and the as-of time the server reports", async () => {
    const p = serverProject({ copyAt: "2026-09-24T17:00:00.000Z" });
    const idle = spawnIdle();
    const server = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch: () => Response.json({ ok: true, pid: idle.pid, version: "x", database: "warehouse.duckdb", writeIntent: null, queriesToday: 3, serverMode: { state: "open", asOf: "2026-09-24T10:00:00-07:00" } }),
    });
    try {
      writeServeJson(p.stateDir, { url: `http://127.0.0.1:${server.port}`, token: "t", pid: idle.pid });
      const { data } = await runDoctor(p.root, deps());
      expect(data.checks.find((c) => c.id === "serve")!.text).toContain("server mode, reads the copy as of 10:00");
      expect(data.checks.find((c) => c.id === "servermode")!.text).toContain(`croft serve is running (pid ${idle.pid}) and answers from the read copy`);
      expect(data.checks.find((c) => c.id === "servermode")!.details).toMatchObject({ serving: true });
    } finally {
      await server.stop(true);
    }
  });

  test("where the copy cannot be cloned and the warehouse is over 1 GB, server mode is an error naming the setting; accepted, a warning", async () => {
    const p = serverProject({ bytes: 1.5 * GB, copyAt: "2026-09-24T17:00:00.000Z" });
    const refused = await runDoctor(p.root, deps({ copyProbe: { platform: "linux", cp: [cpWithoutClone()] } }));
    const err = refused.data.checks.find((c) => c.id === "readcopy.cost")!;
    expect(err).toMatchObject({ status: "error", code: "SERVER_MODE_COPY_COSTLY" });
    expect(err.text).toContain("1.5 GB");
    expect(refused.problems.find((x) => x.code === "SERVER_MODE_COPY_COSTLY")!.hint).toContain("serverMode.acceptFullCopyCost");
    expect(refused.data.summary.errors).toBeGreaterThan(0);

    const ok = serverProject({ serverMode: { enabled: true, acceptFullCopyCost: true }, bytes: 1.5 * GB, copyAt: "2026-09-24T17:00:00.000Z" });
    const accepted = await runDoctor(ok.root, deps({ copyProbe: { platform: "linux", cp: [cpWithoutClone()] } }));
    const warn = accepted.data.checks.find((c) => c.id === "readcopy.cost")!;
    expect(warn).toMatchObject({ status: "warn", code: "READ_COPY_NOT_CLONED" });
    expect(warn.text).toContain("1.5 GB more disk");
    expect(warn.text).toContain("accepted");
  });

  test("a plain read copy warns too, with the disk and the time a refresh costs; a small warehouse does not", async () => {
    const big = serverProject({ serverMode: null, readCopy: true, bytes: 300_000_000, copyAt: "2026-09-24T17:00:00.000Z" });
    const w = (await runDoctor(big.root, deps({ copyProbe: { platform: "linux", cp: [cpWithoutClone()] } }))).data.checks.find((c) => c.id === "readcopy.cost")!;
    expect(w).toMatchObject({ status: "warn", code: "READ_COPY_NOT_CLONED" });
    expect(w.text).toMatch(/300 MB more disk .* about 1 to 2 s/);
    const small = serverProject({ serverMode: null, readCopy: true, bytes: 5_000_000, copyAt: "2026-09-24T17:00:00.000Z" });
    expect((await runDoctor(small.root, deps({ copyProbe: { platform: "linux", cp: [cpWithoutClone()] } }))).data.checks.find((c) => c.id === "readcopy.cost")).toBeUndefined();
  });

  test("where the copy clones, nothing is said about cost", async () => {
    const p = serverProject({ bytes: 5 * GB, copyAt: "2026-09-24T17:00:00.000Z" });
    const cp = join(realpathSync(mkdtempSync(join(tmpdir(), "croft-cp-"))), "cp");
    scratch.push(join(cp, ".."));
    writeFileSync(cp, '#!/bin/sh\nfor a in "$@"; do src="$dst"; dst="$a"; done\nexec /bin/cp "$src" "$dst"\n');
    chmodSync(cp, 0o755);
    const { data } = await runDoctor(p.root, deps({ copyProbe: { platform: "darwin", cp: [cp] } }));
    expect(data.checks.find((c) => c.id === "readcopy.cost")).toBeUndefined();
    expect(formatDoctor(data, [])).toContain("server mode on");
  });

  test("a project without server mode has no server mode line", async () => {
    const p = serverProject({ serverMode: null, readCopy: true, copyAt: "2026-09-24T17:00:00.000Z" });
    const { data } = await runDoctor(p.root, deps());
    expect(data.checks.find((c) => c.id === "servermode")).toBeUndefined();
  });
});

describe("croft status", () => {
  test("server mode on: data.serverMode says whether croft serve is live, and the human output says so above the copy's line", async () => {
    const p = serverProject({ copyAt: "2026-09-24T17:00:00.000Z" });
    const json = await cli(["status", "--json"], { cwd: p.root, env: { CROFT_NOW: AT } });
    const body = JSON.parse(json.stdout);
    expect(body.data.serverMode).toEqual({ serving: false });
    expect(body.data.readCopy).toMatchObject({ asOf: "2026-09-24T10:00:00-07:00", health: "ok" });
    const human = await cli(["status"], { cwd: p.root, env: { CROFT_NOW: AT } });
    const lines = human.stdout.split("\n");
    const at = lines.findIndex((l) => l.startsWith("Server mode on"));
    expect(lines[at]).toBe("Server mode on · croft serve is not running: apps read the warehouse file directly");
    expect(lines[at + 1]).toContain("Read copy warehouse.read.duckdb · as of 10:00");
  });

  test("with croft serve live it says it answers from the copy", async () => {
    const p = serverProject({ copyAt: "2026-09-24T17:00:00.000Z" });
    const idle = spawnIdle();
    writeServeJson(p.stateDir, { url: "http://127.0.0.1:7447", token: "t", pid: idle.pid });
    const json = JSON.parse((await cli(["status", "--json"], { cwd: p.root, env: { CROFT_NOW: AT } })).stdout);
    expect(json.data.serverMode).toEqual({ serving: true });
    expect((await cli(["status"], { cwd: p.root, env: { CROFT_NOW: AT } })).stdout).toContain("Server mode on · croft serve answers from the read copy");
  });

  test("without server mode the output has no server mode field or line", async () => {
    const p = serverProject({ serverMode: null, readCopy: true, copyAt: "2026-09-24T17:00:00.000Z" });
    const json = JSON.parse((await cli(["status", "--json"], { cwd: p.root, env: { CROFT_NOW: AT } })).stdout);
    expect("serverMode" in json.data).toBe(false);
    expect((await cli(["status"], { cwd: p.root, env: { CROFT_NOW: AT } })).stdout).not.toContain("Server mode");
  });

  test("the cost of a refresh where the filesystem cannot clone is a problem in status", async () => {
    const p = serverProject({ bytes: 1.5 * GB, copyAt: "2026-09-24T17:00:00.000Z" });
    const refused = await collectStatus(p.project, new Date(AT), { resolved: null, copyProbe: { platform: "linux", cp: [cpWithoutClone()] } });
    expect(refused.problems.map((x) => x.code)).toContain("SERVER_MODE_COPY_COSTLY");
    const plain = serverProject({ serverMode: null, readCopy: true, bytes: 400_000_000, copyAt: "2026-09-24T17:00:00.000Z" });
    const warned = await collectStatus(plain.project, new Date(AT), { resolved: null, copyProbe: { platform: "linux", cp: [cpWithoutClone()] } });
    expect(warned.problems.map((x) => x.code)).toContain("READ_COPY_NOT_CLONED");
    expect(formatStatus(warned.data, new Date(AT), { tz: "America/Los_Angeles", problems: warned.problems })).toContain("Read copy");
  });
});

describe("the croft serve banner", () => {
  const base: ServeData = {
    url: "http://127.0.0.1:7447", host: "127.0.0.1", port: 7447, pid: 4121, loopback: true, database: "warehouse.duckdb",
    startedAt: "2026-09-24T10:00:00-07:00", version: "0.1.0",
    token: { source: "generated", from: null, file: ".croft/serve.json" },
    scheduling: { state: "on", via: "serve", pausedUntil: null, tickEveryMs: 60_000 }, stopped: null,
  };

  test("in server mode it says what it answers from and that it never opens the warehouse", () => {
    const text = formatBanner({ ...base, serverMode: { readCopy: "warehouse.read.duckdb", asOf: "2026-09-24T10:00:00-07:00" } }, "America/Los_Angeles", new Date(AT));
    const lines = text.split("\n");
    expect(lines[0]).toBe("croft serve · http://127.0.0.1:7447 · server mode: answers from warehouse.read.duckdb, never opens warehouse.duckdb");
    expect(lines[1]).toBe("the read copy is as of 10:00; every answer says as of when, and runs never wait for croft serve");
    expect(text).not.toContain("steps aside for writes");
  });

  test("before the first copy it says the next run makes it", () => {
    const text = formatBanner({ ...base, serverMode: { readCopy: "warehouse.read.duckdb", asOf: null } }, "UTC");
    expect(text).toContain("the read copy is not made yet: the next run that changes data makes it");
  });

  test("without server mode the banner is as it was", () => {
    expect(formatBanner(base, "UTC").split("\n")[0]).toBe("croft serve · http://127.0.0.1:7447 · database warehouse.duckdb (read-only, steps aside for writes)");
  });
});

