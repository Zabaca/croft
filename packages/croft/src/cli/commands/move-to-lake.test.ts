// croft move-to-lake (DESIGN.md D155 to D161; option 07, slice 4), run in this process against a local lake (a SQLite catalog and a folder): what it
// refuses and says before it changes anything, the question on a terminal, the confirmation that goes stale or waits for a run, and the happy path in
// miniature. The move of a real-sized project, on both kinds of lake, with a kill at each point, is the journey (tests/e2e/j39-lake-move.test.ts, run
// by the two lake jobs of ci.yml); the pieces are db/lake-move.test.ts.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extensionsReady } from "../../db/extension-dir-testkit.ts";
import { localLakeBlock } from "../../db/lake-testkit.ts";
import { closeAllWarehouses } from "../../db/warehouse.ts";
import { tryAcquire } from "../../history/leases.ts";
import { prompter, MAINTAIN_WAITS } from "./delete.ts";
import { cleanup, cli, makeProject, PKG, runsDb, type TestProject } from "./inspect-testkit.ts";

afterAll(async () => {
  await closeAllWarehouses();
  await cleanup();
});
afterEach(closeAllWarehouses);

const ready = extensionsReady(["httpfs", "postgres", "ducklake", "sqlite"]);
const maybe = ready.ready ? test : test.skip;
if (!ready.ready) console.warn(`[move-to-lake.test] SKIPPING: ${ready.skipReason}`);

const ORDERS = "-- description: orders\n-- key: id\nSELECT range AS id, range % 7 AS k, 'o' || range AS note FROM range(40)\n";
const SUMMARY = "-- description: orders by k\n-- key: k\nSELECT k, count(*) AS n FROM orders GROUP BY k\n";
const env = { CROFT_EXTENSION_DIR: ready.dir };
const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** A file project with its lake named and switched off (a local lake), built (orders and a summary of it). */
async function fileProject(o: { lake?: boolean | Record<string, unknown>; build?: boolean; config?: (c: Record<string, any>) => void } = {}): Promise<TestProject> {
  const p = makeProject({ files: { "assets/orders.sql": ORDERS, "assets/summary.sql": SUMMARY } });
  const cfg = JSON.parse(readFileSync(join(p.root, "croft.json"), "utf8")) as Record<string, any>;
  if (o.lake !== false) cfg.lake = { enabled: false, ...localLakeBlock(), ...(typeof o.lake === "object" ? o.lake : {}) };
  if (o.build !== false) {
    writeFileSync(join(p.root, "croft.json"), JSON.stringify({ ...cfg, lake: undefined }));
    const built = await cli(["run", "--foreground", "--json"], { cwd: p.root, env });
    expect(built.exit, built.stdout).toBe(0);
    await closeAllWarehouses();
  }
  o.config?.(cfg);
  writeFileSync(join(p.root, "croft.json"), JSON.stringify(cfg, null, 2));
  return p;
}

/** croft in a process of its own (one command per process, as a user runs it): a process uses one access mode for a file for its whole life, so what
 *  reads after the move, or reads the file the move wrote, cannot share this one. */
async function child(p: TestProject, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string; json: any }> {
  const proc = Bun.spawn([process.execPath, join(PKG, "bin", "croft.mjs"), ...args], {
    cwd: p.root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", TZ: "America/Los_Angeles", NO_COLOR: "1", CROFT_TEST_HARNESS: "1", CROFT_FORBID_OS_JOBS: "1", CROFT_NOTIFY_DRY: "1", ...env },
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()]);
  const code = await proc.exited;
  return { code, stdout, stderr, json: args.includes("--json") ? JSON.parse(stdout) : null };
}

const move = async (p: TestProject, extra: string[] = []) => {
  const r = await cli(["move-to-lake", ...extra, "--json"], { cwd: p.root, env });
  await closeAllWarehouses();
  return r;
};

describe("croft move-to-lake: what it refuses before anything is touched", () => {
  test("a project with no lake block, and a project already in a lake, are told so", async () => {
    const none = await fileProject({ lake: false, build: false });
    const a = await cli(["move-to-lake", "--json"], { cwd: none.root, env });
    expect(a.exit).toBe(2);
    expect(a.json.problems[0]).toMatchObject({ code: "MOVE_NEEDS_LAKE", details: { reason: "no_lake" }, effect: "nothing was changed" });
    const on = await fileProject({ lake: { enabled: true }, build: false });
    const b = await cli(["move-to-lake", "--json"], { cwd: on.root, env });
    expect(b.exit).toBe(2);
    expect(b.json.problems[0]).toMatchObject({ code: "MOVE_NEEDS_LAKE", details: { reason: "already_in_lake" } });
  });

  test("everything that stands in the way is named at once, with its fix, and croft.json and the file are untouched", async () => {
    const p = await fileProject({ config: (c) => { c.serverMode = { enabled: true }; } });
    writeFileSync(join(p.stateDir, "serve.json"), JSON.stringify({ pid: process.pid, host: "127.0.0.1", port: 7447, token: "t" }));
    writeFileSync(join(p.stateDir, "rename.json"), JSON.stringify({ from: "orders", to: "sales", fileFrom: "assets/orders.sql", fileTo: "assets/sales.sql", mode: "file", startedAt: "2026-11-02T00:00:00Z", runId: "r_x" }));
    const cfg0 = readFileSync(join(p.root, "croft.json"), "utf8");
    const sha0 = sha(p.database);
    const r = await move(p);
    expect(r.exit, r.stdout).toBe(2);
    const problem = r.json.problems[0];
    expect(problem).toMatchObject({ code: "MOVE_BLOCKED", effect: "nothing was changed" });
    expect(problem.details.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining("server mode is on"), expect.stringContaining("croft serve is running"), expect.stringContaining("a croft rename did not finish"),
    ]));
    expect(problem.hint).toContain("its keys and settings stay as they are");
    expect(readFileSync(join(p.root, "croft.json"), "utf8")).toBe(cfg0);
    expect(sha(p.database)).toBe(sha0);
    expect(existsSync(join(p.root, "lake"))).toBe(false);
  });

  test("a project that has built nothing has nothing to move", async () => {
    const p = await fileProject({ build: false });
    const r = await move(p);
    expect(r.exit).toBe(2);
    expect(r.json.problems[0]).toMatchObject({ code: "MOVE_BLOCKED" });
    expect(r.json.problems[0].message).toContain("there is no warehouse to move");
  });

  test("a read copy is refused too (a lake has no file to copy)", async () => {
    const p = await fileProject({ config: (c) => { c.readCopy = true; } });
    const r = await move(p);
    expect(r.json.problems[0].details.reasons).toEqual([expect.stringContaining("read copy")]);
  });
});

describe("croft move-to-lake: the question and the confirmation", () => {
  maybe("off a terminal it changes nothing and issues a token; the question says what moves, what stays, what does not come along and the way back", async () => {
    const p = await fileProject();
    const sha0 = sha(p.database);
    const cfg0 = readFileSync(join(p.root, "croft.json"), "utf8");
    const r = await move(p);
    expect(r.exit, r.stdout).toBe(5);
    expect(r.json.data).toMatchObject({ status: "needs_confirmation", mode: "copy", switched: false, backup: null, file: null, verified: null, rows: 47 });
    expect(r.json.data.tables).toEqual([{ name: "orders", rows: 40, columns: 4 }, { name: "summary", rows: 7, columns: 3 }]);
    expect(r.json.confirmation).toMatchObject({ command: "croft move-to-lake" });
    const text = r.json.problems[0].message + r.json.problems[0].hint;
    for (const phrase of ["backs the file up", "not one byte changed", '"lake.enabled" to false', "not carried back", "time travel", "the trash", "run history"]) expect(text).toContain(phrase);
    expect(readFileSync(join(p.root, "croft.json"), "utf8")).toBe(cfg0);
    expect(sha(p.database)).toBe(sha0);
    expect(existsSync(join(p.root, "lake"))).toBe(false);
    expect(existsSync(join(p.stateDir, "backups"))).toBe(false);
  }, 120_000);

  maybe("on a terminal it asks y/N; a no changes nothing, a yes moves", async () => {
    const p = await fileProject();
    const sha0 = sha(p.database);
    const asked: string[] = [];
    const real = prompter.ask;
    try {
      prompter.ask = async (q: string) => { asked.push(q); return false; };
      const no = await cli(["move-to-lake"], { cwd: p.root, env, stdinTTY: true, stdoutTTY: true });
      await closeAllWarehouses();
      expect(no.exit, no.stdout + no.stderr).toBe(1);
      expect(no.stdout).toContain("not moved");
      expect(asked[0]).toContain("Proceed? [y/N]");
      expect(asked[0]).toContain("move the warehouse into the lake");
      expect(existsSync(join(p.root, "lake"))).toBe(false);
      prompter.ask = async () => true;
      const yes = await cli(["move-to-lake"], { cwd: p.root, env, stdinTTY: true, stdoutTTY: true });
      await closeAllWarehouses();
      expect(yes.exit, yes.stdout + yes.stderr).toBe(0);
      expect(yes.stdout).toContain("moved into the lake");
      expect(yes.stdout).toContain("proved equal to the file");
      expect(JSON.parse(readFileSync(join(p.root, "croft.json"), "utf8")).lake.enabled).toBe(true);
      expect(sha(p.database)).toBe(sha0);
    } finally {
      prompter.ask = real;
    }
  }, 180_000);

  maybe("a token minted before something wrote the warehouse is stale: nothing is moved", async () => {
    const p = await fileProject();
    const asked = await move(p);
    expect(asked.exit).toBe(5);
    // A table is rewritten between the question and the yes.
    writeFileSync(join(p.root, "assets/orders.sql"), ORDERS.replace("range(40)", "range(41)"));
    const ran = await cli(["run", "orders", "--foreground", "--json"], { cwd: p.root, env });
    expect(ran.exit, ran.stdout).toBe(0);
    await closeAllWarehouses();
    const cfg0 = readFileSync(join(p.root, "croft.json"), "utf8");
    const done = await cli(["confirm", asked.json.confirmation.token, "--json"], { cwd: p.root, env });
    await closeAllWarehouses();
    expect(done.exit, done.stdout).toBe(5);
    expect(done.json.problems[0]).toMatchObject({ code: "CONFIRMATION_STALE", effect: "nothing was changed" });
    expect(readFileSync(join(p.root, "croft.json"), "utf8")).toBe(cfg0);
    expect(existsSync(join(p.root, "lake"))).toBe(false);
    // The new question has a token that works.
    const again = await move(p);
    expect(again.json.data.rows).toBe(48);
  }, 180_000);

  maybe("a run that holds an asset keeps the move from starting: ASSET_BUSY, nothing changed", async () => {
    const p = await fileProject();
    const asked = await move(p);
    expect(asked.exit).toBe(5);
    const runs = runsDb(p.stateDir);
    try {
      expect(tryAcquire(runs, ["orders"], "r_someone_else").ok).toBe(true); // this process is alive, so the lease is live
      const waits = { ...MAINTAIN_WAITS };
      MAINTAIN_WAITS.offTtyMs = 150;
      let done;
      try {
        done = await cli(["confirm", asked.json.confirmation.token, "--json"], { cwd: p.root, env });
      } finally {
        Object.assign(MAINTAIN_WAITS, waits);
      }
      await closeAllWarehouses();
      expect(done.exit, done.stdout).toBe(4);
      expect(done.json.problems[0]).toMatchObject({ code: "ASSET_BUSY" });
      expect(JSON.parse(readFileSync(join(p.root, "croft.json"), "utf8")).lake.enabled).toBe(false);
      expect(existsSync(join(p.root, "lake"))).toBe(false);
    } finally {
      runs.close();
    }
  }, 120_000);
});

describe("croft move-to-lake: the move, in miniature", () => {
  maybe("backs up, copies, proves, switches; the file is untouched; the project reads from the lake", async () => {
    const p = await fileProject();
    const sha0 = sha(p.database);
    const before = await child(p, ["query", "select * from orders order by id", "--limit", "1000", "--json"]);
    expect(before.code, before.stdout + before.stderr).toBe(0);
    const asked = await move(p);
    const done = await cli(["confirm", asked.json.confirmation.token, "--json"], { cwd: p.root, env });
    await closeAllWarehouses();
    expect(done.exit, done.stdout + done.stderr).toBe(0);
    expect(done.json.data.outcome).toBe("used");
    expect(done.json.data.result).toMatchObject({ status: "moved", mode: "copy", switched: true, file: { unchanged: true, sha256: sha0 }, verified: { tables: 2, rows: 47 } });
    const result = done.json.data.result;
    expect(sha(join(result.backup.path, "warehouse.duckdb"))).toBe(sha0);
    expect(sha(p.database)).toBe(sha0);
    expect(readFileSync(join(p.root, "croft.json"), "utf8")).toContain('"enabled": true');
    // A second move: the project is in the lake.
    const again = await move(p);
    expect(again.json.problems[0]).toMatchObject({ code: "MOVE_NEEDS_LAKE", details: { reason: "already_in_lake" } });
    // The tables, in the lake, are the file's.
    const after = await child(p, ["query", "select * from orders order by id", "--limit", "1000", "--json"]);
    expect(after.code, after.stdout + after.stderr).toBe(0);
    expect(after.json.data.rows).toEqual(before.json.data.rows);
    expect(after.json.database).toMatch(/^lake /);
    // status and doctor say what happened.
    const status = await child(p, ["status", "--json"]);
    expect(status.json.data.lakeMove).toMatchObject({ state: "moved", tables: 2, rows: 47, fileSha256: sha0 });
    const human = await child(p, ["status"]);
    expect(human.stdout).toContain("moved in from the file");
    const doctor = await child(p, ["doctor", "--json"]);
    expect(doctor.json.data.checks.find((c: { id: string }) => c.id === "lake.move")).toMatchObject({ status: "info", text: expect.stringContaining("the file is untouched") });
    // Going back: the setting. The mirror the file had is put back; status says so.
    writeFileSync(join(p.root, "croft.json"), readFileSync(join(p.root, "croft.json"), "utf8").replace('"enabled": true', '"enabled": false'));
    const back = await child(p, ["status", "--json"]);
    expect(back.json.data.lakeMove).toMatchObject({ state: "back" });
    expect(back.json.database).toBe("warehouse.duckdb");
    // Moved again without a write in between: the lake already holds an equal copy, which is proved again and switched to.
    const second = await move(p);
    expect(second.exit, second.stdout).toBe(5);
    expect(second.json.data.mode).toBe("finish");
    const finished = await cli(["confirm", second.json.confirmation.token, "--json"], { cwd: p.root, env });
    await closeAllWarehouses();
    expect(finished.json.data.result).toMatchObject({ status: "moved", mode: "finish" });
  }, 300_000);
});
