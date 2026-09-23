// `croft run` and `croft wait` as real processes: detaching off a TTY, following, exit 6 and wait, SIGTERM,
// kill -9 mid-write and reconcile, the --allow-shrink token flow through hidden flags, and human output.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { closeAllWarehouses } from "../../db/warehouse.ts";
import { RunsDb } from "../../history/runs-db.ts";
import { initProject } from "../../project/init.ts";
import { eventsPath, runExample } from "../../run/runner.ts";
import { listTrash } from "../../safety/trash.ts";
import { cleanupProjects, cli, cliEnv, keysetIssues, makeProject, mockApi, PKG, simpleGet, slowPages, startCli, until } from "../../run/testkit.ts";
import { main } from "../main.ts";
import { formatRun, progressLine, userArgs } from "./run.ts";

const api = mockApi();
afterAll(async () => {
  api.stop();
  await closeAllWarehouses();
  cleanupProjects();
});
beforeEach(() => {
  api.state.log.length = 0;
});

async function count(root: string, table: string): Promise<number> {
  await closeAllWarehouses();
  const db = await DuckDBInstance.create(join(root, "warehouse.duckdb"), { access_mode: "READ_ONLY" });
  const c = await db.connect();
  try {
    return Number((await c.runAndReadAll(`select count(*) from ${table}`)).getRowsJS()[0]![0]);
  } finally {
    c.disconnectSync();
    db.closeSync();
  }
}

function withRuns<T>(root: string, fn: (db: RunsDb) => T): T {
  const db = RunsDb.open(join(root, ".croft"));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function inProcess(root: string, argv: string[], o: { stdinTTY?: boolean; stdoutTTY?: boolean } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const exit = await main(argv, {
    cwd: root, env: {}, stdinTTY: o.stdinTTY ?? false, stdoutTTY: o.stdoutTTY ?? false, stderrTTY: false,
    stdout: (t) => out.push(t), stderr: (t) => err.push(t),
  });
  const stdout = out.join("");
  return { exit, stdout, stderr: err.join(""), json: argv.includes("--json") ? JSON.parse(stdout) : undefined };
}

describe("detached runs", () => {
  test("off a TTY the run detaches; after --follow the parent exits 6 with croft wait; wait returns the result", async () => {
    api.state.slowPages = 10;
    api.state.slowDelayMs = 250;
    const root = makeProject({ "assets/slow.ts": slowPages(api.url) });
    const parent = startCli(root, ["run", "slow", "--json", "--follow", "1s"]);
    const first = await parent.done;
    expect(first.code).toBe(6);
    const env = first.json!;
    expect(env).toMatchObject({ ok: true, command: "run", data: { status: "running" }, problems: [] });
    const runId = env.data.runId as string;
    expect(env.next).toEqual([{ command: `croft wait ${runId} --timeout 100s`, reason: "still running" }]);

    // The run outlives the process that started it.
    const still = await cli(root, ["wait", runId, "--timeout", "0.1s", "--json"]);
    expect(still.code).toBe(6);
    expect(still.json!.data).toMatchObject({ runId, status: "running" });
    expect(still.json!.data.progress).toMatchObject({ asset: "slow", phase: "extract" });

    const done = await cli(root, ["wait", runId, "--timeout", "30s", "--json"]);
    expect(done.code).toBe(0);
    expect(done.json).toMatchObject({ ok: true, command: "wait", data: { runId, status: "succeeded" } });
    expect(done.json!.data.steps[0]).toMatchObject({ asset: "slow", status: "ok", rows: { total: 20 } });
    expect(await count(root, "slow")).toBe(20);
    withRuns(root, (db) => {
      const run = db.getRun(runId)!;
      expect(run.status).toBe("succeeded");
      expect(run.argv).toEqual(["run", "slow", "--json", "--follow", "1s"]);
      expect(run.pid).not.toBe(parent.proc.pid); // the work was done by the detached child
    });
    // The child's own output went to its process log, not to the parent's stdout.
    expect(existsSync(join(root, ".croft", "logs", runId, "_process.log"))).toBe(true);
  }, 30_000);

  test("a run that finishes within --follow prints its result and exit code; --events streams NDJSON", async () => {
    api.state.zones = [{ zone: 1 }, { zone: 2 }];
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones") });
    const r = await cli(root, ["run", "zones", "--json", "--events"]);
    expect(r.code).toBe(0);
    expect(r.json!.data).toMatchObject({ status: "succeeded", steps: [{ asset: "zones", status: "ok" }] });
    const events = r.stderr.trim().split("\n").map((l) => JSON.parse(l));
    expect(events[0]).toMatchObject({ type: "run", status: "running" });
    expect(events.some((e) => e.type === "step" && e.status === "ok")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "run", status: "succeeded", exit: 0 });
  }, 30_000);

  test("usage problems are reported by the parent, without a child", async () => {
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones") });
    const r = await cli(root, ["run", "zonez", "--json"]);
    expect(r.code).toBe(2);
    expect(r.json!.problems[0]).toMatchObject({ code: "USAGE_ERROR", hint: "did you mean zones?" });
    expect(existsSync(join(root, ".croft", "logs"))).toBe(false);
  }, 30_000);

  test("wait with an unknown run id is a usage error", async () => {
    const root = makeProject({});
    expect((await cli(root, ["wait", "r_0101_0000_zzzz", "--json"])).code).toBe(2);
    expect((await cli(root, ["wait", "nope", "--json"])).code).toBe(2);
  }, 30_000);
});

describe("signals and crashes", () => {
  test("SIGTERM mid-extract: the step is interrupted, the run is marked interrupted, exit 130", async () => {
    api.state.slowPages = 100;
    api.state.slowDelayMs = 100;
    const root = makeProject({ "assets/slow.ts": slowPages(api.url) });
    const child = startCli(root, ["run", "slow", "--foreground", "--json"]);
    await until(() => api.state.log.filter((l) => l.path === "/slow").length >= 2);
    child.proc.kill("SIGTERM");
    const r = await child.done;
    expect(r.code).toBe(130);
    expect(r.json).toMatchObject({ ok: false, data: { status: "interrupted" } });
    expect(r.json!.problems.map((p: { code: string }) => p.code)).toContain("INTERRUPTED");
    withRuns(root, (db) => {
      const [run] = db.listRuns();
      expect(run!.status).toBe("interrupted");
      expect(db.stepsFor(run!.id)[0]!.status).toBe("interrupted");
      expect(db.sqlite.query("select count(*) n from leases").get()).toEqual({ n: 0 });
    });
  }, 30_000);

  test("two runs on one asset: the second exits 4 with ASSET_BUSY naming the first (--no-wait)", async () => {
    api.state.slowPages = 100;
    api.state.slowDelayMs = 100;
    const root = makeProject({ "assets/slow.ts": slowPages(api.url) });
    const a = startCli(root, ["run", "slow", "--foreground", "--json"]);
    await until(() => api.state.log.filter((l) => l.path === "/slow").length >= 1);
    const aRun = await until(() => withRuns(root, (db) => db.runningRuns()[0]));
    const b = await cli(root, ["run", "slow", "--foreground", "--no-wait", "--json"]);
    expect(b.code).toBe(4);
    expect(b.json!.problems[0]).toMatchObject({ code: "ASSET_BUSY", asset: "slow", runId: aRun.id });
    expect(b.json!.next[0].command).toBe(`croft wait ${aRun.id} --timeout 100s`);
    a.proc.kill("SIGTERM");
    expect((await a.done).code).toBe(130);
  }, 30_000);

  test("kill -9 inside the write transaction: nothing lands; the next run reconciles the crash and succeeds", async () => {
    api.state.zones = Array.from({ length: 6 }, (_, i) => ({ zone: i + 1 }));
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones") });
    expect((await cli(root, ["run", "zones", "--foreground", "--json"])).code).toBe(0);
    api.state.zones = Array.from({ length: 7 }, (_, i) => ({ zone: i + 1 }));
    const killed = await cli(root, ["run", "zones", "--foreground", "--json"], cliEnv({ CROFT_FAULT: "before_commit" }));
    expect(killed.signal).toBe("SIGKILL");
    const crashedId = withRuns(root, (db) => db.listRuns()[0]!.id);
    expect(await count(root, "zones")).toBe(6);

    const next = await cli(root, ["run", "zones", "--foreground", "--json"]);
    expect(next.code).toBe(0);
    expect(await count(root, "zones")).toBe(7);
    withRuns(root, (db) => {
      expect(db.getRun(crashedId)!.status).toBe("crashed");
      const [step] = db.stepsFor(crashedId);
      expect(step).toMatchObject({ status: "crashed" });
      expect(step!.error?.code).toBe("RUN_CRASHED");
      expect(db.sqlite.query("select count(*) n from leases").get()).toEqual({ n: 0 });
    });
  }, 30_000);

  test("kill -9 after the commit, before runs.sqlite: reconcile recovers the step as ok", async () => {
    api.state.zones = [{ zone: 1 }, { zone: 2 }];
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones") });
    const killed = await cli(root, ["run", "zones", "--foreground", "--json"], cliEnv({ CROFT_FAULT: "after_commit_before_sqlite" }));
    expect(killed.signal).toBe("SIGKILL");
    const crashedId = withRuns(root, (db) => db.listRuns()[0]!.id);
    expect((await cli(root, ["run", "zones", "--foreground", "--json"])).code).toBe(0);
    withRuns(root, (db) => {
      expect(db.getRun(crashedId)!.status).toBe("crashed");
      expect(db.stepsFor(crashedId)[0]).toMatchObject({ status: "ok", reason: "requested (recovered)", added: 2 });
    });
    expect(await count(root, "zones")).toBe(2);
  }, 30_000);
});

describe("more crash points (CROFT_FAULT)", () => {
  test("after_stage: extraction done, nothing written; the next run deletes the dead run's staging", async () => {
    api.state.zones = [{ zone: 1 }, { zone: 2 }];
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones") });
    const killed = await cli(root, ["run", "zones", "--foreground", "--json"], cliEnv({ CROFT_FAULT: "after_stage" }));
    expect(killed.signal).toBe("SIGKILL");
    const deadId = withRuns(root, (db) => db.listRuns()[0]!.id);
    expect(existsSync(join(root, ".croft", "staging", deadId, "zones", "manifest.json"))).toBe(true);
    expect(existsSync(join(root, "warehouse.duckdb")) ? await count(root, "duckdb_tables() where table_name = 'zones'") : 0).toBe(0);
    expect((await cli(root, ["run", "zones", "--foreground", "--json"])).code).toBe(0);
    expect(existsSync(join(root, ".croft", "staging", deadId))).toBe(false);
    withRuns(root, (db) => expect(db.getRun(deadId)!.status).toBe("crashed"));
    expect(await count(root, "zones")).toBe(2);
  }, 30_000);

  test("between_trash_and_drop: the trash committed, the table did not change; a new confirmation finishes the job", async () => {
    api.state.zones = Array.from({ length: 4 }, (_, i) => ({ zone: i + 1 }));
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones") });
    await cli(root, ["run", "zones", "--foreground", "--json"]);
    api.state.zones = [];
    const asked = await cli(root, ["run", "zones", "--allow-shrink", "--foreground", "--json"]);
    const token = asked.json!.confirmation.token as string;
    const killed = await cli(root, ["run", "zones", "--allow-shrink", "--confirm-token", token, "--foreground", "--json"], cliEnv({ CROFT_FAULT: "between_trash_and_drop" }));
    expect(killed.signal).toBe("SIGKILL");
    expect(listTrash(join(root, ".croft"), "zones")).toHaveLength(1);
    expect(await count(root, "zones")).toBe(4);
    // The spent token is stale; a new one (same impact) goes through.
    const stale = await cli(root, ["run", "zones", "--allow-shrink", "--confirm-token", token, "--foreground", "--json"]);
    expect(stale.code).toBe(5);
    expect(stale.json!.data.steps[0].error.code).toBe("CONFIRMATION_STALE");
    const again = await cli(root, ["run", "zones", "--allow-shrink", "--foreground", "--json"]);
    const done = await cli(root, ["run", "zones", "--allow-shrink", "--confirm-token", again.json!.confirmation.token, "--foreground", "--json"]);
    expect(done.code).toBe(0);
    expect(await count(root, "zones")).toBe(0);
    expect(listTrash(join(root, ".croft"), "zones")).toHaveLength(2);
    withRuns(root, (db) => expect(db.listRuns()[0]!.trigger).toBe("confirm"));
  }, 60_000);
});

describe("--allow-shrink through the CLI", () => {
  test("exit 5 with a confirmation; the hidden --confirm-token run (as croft confirm does it) trashes, then writes", async () => {
    api.state.zones = Array.from({ length: 4 }, (_, i) => ({ zone: i + 1 }));
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones") });
    expect((await cli(root, ["run", "zones", "--json"])).code).toBe(0);
    api.state.zones = [];
    const guarded = await cli(root, ["run", "zones", "--json"]);
    expect(guarded.code).toBe(1);
    expect(guarded.json!.data.steps[0].error.code).toBe("SHRINK_GUARD");

    const asked = await cli(root, ["run", "zones", "--allow-shrink", "--json"]);
    expect(asked.code).toBe(5);
    expect(asked.json).toMatchObject({ ok: false, confirmation: { command: "croft run zones --allow-shrink", impact: { asset: "zones", rows: 4 } } });
    expect(asked.json!.confirmation.token).toMatch(/^c_[0-9a-f]{6}$/);
    expect(asked.json!.next.some((n: { command: string }) => n.command.includes("confirm"))).toBe(false);
    expect(await count(root, "zones")).toBe(4);

    const token = asked.json!.confirmation.token as string;
    const done = await cli(root, ["run", "zones", "--allow-shrink", "--confirm-token", token, "--json"]);
    expect(done.code).toBe(0);
    expect(done.json!.data.steps[0]).toMatchObject({ status: "ok", trashed: { rows: 4 } });
    expect(await count(root, "zones")).toBe(0);
    expect(listTrash(join(root, ".croft"), "zones")[0]).toMatchObject({ rows: 4 });
    withRuns(root, (db) => {
      // The run record keeps the user's own arguments, never the hidden ones.
      expect(db.listRuns()[0]!.argv).toEqual(["run", "zones", "--allow-shrink", "--json"]);
    });
    const unknown = await cli(root, ["run", "zones", "--allow-shrink", "--confirm-token", "c_000000", "--json"]);
    expect(unknown.code).toBe(2);
  }, 60_000);
});

describe("in-process command", () => {
  test("human output on a TTY-less foreground run", async () => {
    api.state.zones = [{ zone: 1, name: "a" }, { zone: 2, name: "b" }];
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones") });
    const r = await inProcess(root, ["run", "zones", "--foreground"]);
    expect(r.exit).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toMatch(/^run r_\d{4}_\d{4}_[0-9a-z]{4} · 1 asset$/);
    // §4.2: the first run says it created the table.
    expect(lines[1]).toMatch(/^ok\s+zones\s+1 request, 2 rows \(\d+ ms\) · new table, 2 columns$/);
    expect(lines[2]).toContain("added 2 · updated 0 · unchanged 0 · 2 rows now");
    expect(r.stdout).toMatch(/done \d+ ms · 1 updated · 0 failed\nchecks: not enforced until phase 2\n/);
    expect(r.stdout).toContain('next: croft query "from zones limit 5"');
    const again = await inProcess(root, ["run", "zones", "--foreground"]);
    expect(again.stdout.split("\n")[1]).toMatch(/^ok\s+zones\s+1 request, 2 rows \(\d+ ms\)$/);
  });

  test("on a TTY the run stays in this process and shows progress on stderr", async () => {
    api.state.zones = [{ zone: 1 }];
    const root = makeProject({ "assets/zones.ts": simpleGet(api.url, "/zones") });
    const r = await inProcess(root, ["run", "zones"], { stdinTTY: true, stdoutTTY: true });
    expect(r.exit).toBe(0);
    expect(r.stderr).toContain("zones: fetching…");
    expect(r.stdout).toContain("done ");
    expect(existsSync(join(root, ".croft", "logs"))).toBe(true);
    const runId = withRuns(root, (db) => db.listRuns()[0]!);
    expect(runId.pid).toBe(process.pid);
  });

  test("--from -90d and --from=-90d reach the engine and the since conversion is echoed in the step", async () => {
    api.state.issues = [{ id: 1, title: "a", updated_at: "2026-09-01T10:00:00Z" }];
    const root = makeProject({ "assets/issues.ts": keysetIssues(api.url) });
    for (const from of [["--from=-90d"], ["--from", "-90d"]]) {
      api.state.log.length = 0;
      const r = await inProcess(root, ["run", "issues", ...from, "--foreground", "--json"]);
      expect(r.exit).toBe(0);
      expect(r.json.data.checksEnforced).toBe(false);
      expect(r.json.data.steps[0].reason).toMatch(/^requested; since: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-0[78]:00\)$/);
      expect(api.state.log[0]!.query.since).toBeDefined();
    }
  });

  test("progressLine", () => {
    expect(progressLine({ type: "step", asset: "a", status: "running", attempt: 2 })).toBe("a: fetching (attempt 2)…");
    expect(progressLine({ type: "retry", asset: "a", code: "HTTP_ERROR", nextRetryAt: "T" })).toBe("a: HTTP_ERROR; trying again at T");
    expect(progressLine({ type: "waiting", assets: ["a", "b"], heldBy: ["r_1"] })).toBe("waiting for a, b: held by run r_1");
    expect(progressLine({ type: "progress" })).toBeNull();
  });

  test("formatRun: still running, failed and skipped steps", () => {
    const text = formatRun({
      runId: "r_0922_1130_x1c8", status: "running", progress: { asset: "a", phase: "extract", rowsFetched: 61200, requests: 612, elapsedMs: 100_000 },
      steps: [{ asset: "b", status: "failed", reason: "requested", behavior: "replace", attempt: 3, maxAttempts: 3, rows: { in: 0, added: 0, updated: 0, unchanged: 0, deleted: 0, total: 0 }, schemaChanges: [], checks: [], logsCommand: "croft logs b --failed", durationMs: 5, error: { severity: "error", code: "HTTP_ERROR", message: "GET x failed", hint: "", docs: "" } }],
    });
    expect(text).toContain("run r_0922_1130_x1c8 is still running (a: extract, 61,200 rows, 612 requests, 1 min 40 s)");
    expect(text).toContain("failed   b                  HTTP_ERROR: GET x failed (attempt 3 of 3)");
  });

  test("formatRun: a step that created its table says so (§4.2)", () => {
    const text = formatRun({
      runId: "r_0922_1015_k3f9", status: "succeeded",
      steps: [{ asset: "github_issues", status: "ok", reason: "requested", behavior: "merge by id", attempt: 1, maxAttempts: 3, requests: 184,
        rows: { in: 18342, added: 18342, updated: 0, unchanged: 0, deleted: 0, total: 18342 }, schemaChanges: [], checks: [],
        logsCommand: "croft logs github_issues", durationMs: 41_200, created: { columns: 31, jsonColumns: 7 } }],
    });
    expect(text.split("\n")[1]).toBe("ok       github_issues      184 requests, 18,342 rows (41.2 s) · new table, 31 columns (7 JSON)");
  });

  test("userArgs drops the hidden flags", () => {
    expect(userArgs(["x", "--run-id", "r_0101_0000_abcd", "--detached", "--confirm-token=c_123456", "--json"])).toEqual(["x", "--json"]);
  });

  test("wait needs a run id", async () => {
    const root = makeProject({});
    const r = await inProcess(root, ["wait", "--json"]);
    expect(r.exit).toBe(2);
    expect(r.json.problems[0].code).toBe("USAGE_ERROR");
  });
});

describe("init HOOK(example)", () => {
  test("runExample runs the example ingest through the engine", async () => {
    api.state.zones = [{ order_id: 1, amount: 5 }, { order_id: 2, amount: 7 }];
    const root = makeProject({ "assets/example_sales.ts": simpleGet(api.url, "/zones", '\n  key: "order_id",') });
    const r = await runExample(root, { env: {} });
    expect(r).toEqual({ ran: true, ok: true, asset: "example_sales", rows: 2, checks: "ok" });
    expect(existsSync(eventsPath(join(root, ".croft"), withRuns(root, (db) => db.listRuns()[0]!.id)))).toBe(true);
  });

  test("croft init's scaffold: the file ingest runs through the engine", async () => {
    const base = makeProject({});
    const target = join(base, "fresh");
    const r = await initProject({
      target, env: {}, runInstall: (root) => {
        mkdirSync(join(root, "node_modules", "@zabaca"), { recursive: true });
        symlinkSync(PKG, join(root, "node_modules", "@zabaca", "croft"));
        return { ran: true, ok: true, command: "bun install", ms: 1 };
      },
      runExample: (root) => runExample(root, { env: {} }),
    });
    // load/files.ts is in: the scaffold's example_sales.csv loads in full.
    expect(r.example).toMatchObject({ ran: true, ok: true, asset: "example_sales", rows: 120 });
  });

  test("the init command wires runExample at HOOK(example)", () => {
    const text = readFileSync(join(import.meta.dir, "init.ts"), "utf8");
    expect(text).toMatch(/runExample: async \(root: string\) => \(await import\("..\/..\/run\/runner.ts"\)\)\.runExample\(root/);
  });
});
