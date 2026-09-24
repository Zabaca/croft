import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError, problem } from "../core/errors.ts";
import { bootId, currentIdentity, procStart } from "../core/proc.ts";
import { logDir, processLogPath } from "../history/logs.ts";
import { RunsDb } from "../history/runs-db.ts";
import {
  finishedSteps, followRun, lastProgress, parseWait, readChildRecord, runningSummary, spawnDetachedRun, summaryFromRecords,
  writeChildRecord,
} from "./detach.ts";
import { croftError, isRetryable, StepProgress } from "./ingest.ts";
import { eventsPath, EventLog, jsonSafe } from "./runner.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function stateDir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "croft-detach-")));
  dirs.push(d);
  return d;
}

describe("parseWait", () => {
  test("durations with units; a bare number is seconds", () => {
    expect(parseWait("100s", "--timeout")).toBe(100_000);
    expect(parseWait("2m", "--timeout")).toBe(120_000);
    expect(parseWait("1.5h", "--timeout")).toBe(5_400_000);
    expect(parseWait("90", "--follow")).toBe(90_000);
    expect(parseWait("250ms", "--follow")).toBe(250);
    expect(parseWait("0", "--timeout")).toBe(0);
    expect(() => parseWait("soon", "--timeout")).toThrow(CroftError);
    expect(() => parseWait("-5s", "--timeout")).toThrow(/--timeout "-5s" is not a duration/);
  });
});

describe("reading a run back", () => {
  test("progress and finished steps come from events.ndjson", () => {
    const s = stateDir();
    const ev = new EventLog(s, "r_0101_0000_abcd");
    ev.emit({ type: "run", runId: "r_0101_0000_abcd", status: "running" });
    ev.emit({ type: "progress", runId: "r_0101_0000_abcd", asset: "a", phase: "extract", rowsFetched: 10, requests: 2, elapsedMs: 5 });
    ev.emit({ type: "step", asset: "b", status: "ok", result: { asset: "b", status: "ok" } });
    ev.emit({ type: "progress", runId: "r_0101_0000_abcd", asset: "a", phase: "write", rowsFetched: 20, requests: 3, elapsedMs: 9 });
    appendFileSync(eventsPath(s, "r_0101_0000_abcd"), "not json\n");
    expect(lastProgress(s, "r_0101_0000_abcd")).toEqual({ asset: "a", phase: "write", rowsFetched: 20, requests: 3, elapsedMs: 9 });
    expect(finishedSteps(s, "r_0101_0000_abcd")).toEqual([{ asset: "b", status: "ok" } as never]);
    const r = runningSummary(s, "r_0101_0000_abcd");
    expect(r).toMatchObject({ exit: 6, ok: true, data: { status: "running", progress: { phase: "write" } }, next: [{ command: "croft wait r_0101_0000_abcd --timeout 100s" }] });
    expect(lastProgress(s, "r_0101_0000_zzzz")).toBeUndefined();
  });

  test("a crashed run without a summary is rebuilt from its steps (last attempt per asset)", () => {
    const s = stateDir();
    const db = RunsDb.open(s);
    try {
      const run = db.createRun({ trigger: "manual", human: true, argv: ["run"] });
      db.startStep({ runId: run.id, asset: "a", attempt: 1, reason: "requested" });
      db.finishStep(run.id, "a", 1, { status: "failed", error: problem("HTTP_ERROR", { message: "x", hint: "y" }) });
      db.startStep({ runId: run.id, asset: "a", attempt: 2, reason: "requested" });
      db.markCrashed(run.id);
      const sum = summaryFromRecords(db.getRun(run.id)!, db.stepsFor(run.id));
      expect(sum.exit).toBe(1);
      expect(sum.data.status).toBe("crashed");
      expect(sum.data.steps).toHaveLength(1);
      expect(sum.data.steps[0]).toMatchObject({ asset: "a", attempt: 2, status: "failed", error: { code: "RUN_CRASHED" } });
      expect(sum.problems.map((p) => p.code)).toEqual(["RUN_CRASHED"]);
      expect(sum.problems[0]).toMatchObject({ asset: "a", runId: run.id });
    } finally {
      db.close();
    }
  });
});

describe("followRun", () => {
  test("a running run whose process is gone is marked crashed", async () => {
    const s = stateDir();
    const db = RunsDb.open(s);
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
    const run = db.createRun({ trigger: "manual", human: true, argv: ["run"], identity: { pid: dead, procStart: "1", bootId: bootId() } });
    db.close();
    const res = await followRun({ stateDir: s, runId: run.id, timeoutMs: 5000, pollMs: 20 });
    expect(res.kind).toBe("finished");
    if (res.kind === "finished") {
      expect(res.summary.data.status).toBe("crashed");
      expect(res.summary.exit).toBe(1);
    }
  });

  // status reads the step, not the run: a step left running in a run croft reported crashed showed as running.
  test("croft wait: the dead run's running step is crashed too, with RUN_CRASHED", async () => {
    const s = stateDir();
    const db = RunsDb.open(s);
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
    const run = db.createRun({ trigger: "manual", human: true, argv: ["run"], identity: { pid: dead, procStart: "1", bootId: bootId() } });
    db.startStep({ runId: run.id, asset: "labels", attempt: 1, reason: "requested" });
    db.close();
    const res = await followRun({ stateDir: s, runId: run.id, timeoutMs: 5000, pollMs: 20 });
    expect(res.kind).toBe("finished");
    const after = RunsDb.open(s);
    try {
      expect(after.getStep(run.id, "labels", 1)).toMatchObject({ status: "crashed", error: { code: "RUN_CRASHED", asset: "labels" } });
      expect(after.danglingSteps().map((x) => x.asset)).toEqual(["labels"]);   // the next reconcile still checks it
    } finally {
      after.close();
    }
    if (res.kind === "finished") {
      expect(res.summary.data.steps).toMatchObject([{ asset: "labels", status: "failed", error: { code: "RUN_CRASHED" } }]);
      expect(res.summary.problems).toMatchObject([{ code: "RUN_CRASHED", asset: "labels", runId: run.id, fix: { command: "croft run labels" } }]);
    }
  });

  test("croft run's parent: a child killed mid-step leaves its run and its step crashed", async () => {
    const s = stateDir();
    const script = join(s, "kill.ts");
    writeFileSync(script, `
      import { RunsDb } from ${JSON.stringify(join(import.meta.dir, "../history/runs-db.ts"))};
      const db = RunsDb.open(${JSON.stringify(s)});
      db.createRun({ id: "r_0101_0000_kill", trigger: "manual", human: false, argv: ["run"] });
      db.startStep({ runId: "r_0101_0000_kill", asset: "labels", attempt: 1, reason: "requested" });
      db.close();
      process.kill(process.pid, "SIGKILL");
    `);
    const spawned = spawnDetachedRun({ root: s, stateDir: s, args: [], runId: "r_0101_0000_kill", env: { PATH: process.env.PATH }, entry: script });
    const res = await followRun({ stateDir: s, runId: "r_0101_0000_kill", timeoutMs: 10_000, pollMs: 20, spawned });
    expect(res).toMatchObject({ kind: "finished", summary: { exit: 1, data: { status: "crashed" } } });
    const db = RunsDb.open(s);
    try {
      expect(db.getRun("r_0101_0000_kill")?.status).toBe("crashed");
      expect(db.getStep("r_0101_0000_kill", "labels", 1)).toMatchObject({ status: "crashed", error: { code: "RUN_CRASHED" } });
    } finally {
      db.close();
    }
  });

  test("croft run's parent returns once the child that finished its run has exited (it closes the warehouse last)", async () => {
    const s = stateDir();
    const script = join(s, "linger.ts");
    const marker = join(s, "exited");
    writeFileSync(script, `
      import { writeFileSync } from "node:fs";
      import { RunsDb } from ${JSON.stringify(join(import.meta.dir, "../history/runs-db.ts"))};
      const db = RunsDb.open(${JSON.stringify(s)});
      db.createRun({ id: "r_0101_0000_lngr", trigger: "manual", human: false, argv: ["run"] });
      db.finishRun("r_0101_0000_lngr", "succeeded", { data: { runId: "r_0101_0000_lngr", status: "succeeded", steps: [] }, problems: [], next: [], exit: 0, ok: true });
      db.close();
      await Bun.sleep(400);
      process.on("exit", () => writeFileSync(${JSON.stringify(marker)}, "1"));
    `);
    const spawned = spawnDetachedRun({ root: s, stateDir: s, args: [], runId: "r_0101_0000_lngr", env: { PATH: process.env.PATH }, entry: script });
    const res = await followRun({ stateDir: s, runId: "r_0101_0000_lngr", timeoutMs: 10_000, pollMs: 20, spawned });
    expect(res).toMatchObject({ kind: "finished", summary: { exit: 0 } });
    expect(existsSync(marker)).toBe(true);
    // A child that does not exit in time does not hold the parent for long.
    const s2 = stateDir();
    const stuck = join(s2, "stuck.ts");
    writeFileSync(stuck, `
      import { RunsDb } from ${JSON.stringify(join(import.meta.dir, "../history/runs-db.ts"))};
      const db = RunsDb.open(${JSON.stringify(s2)});
      db.createRun({ id: "r_0101_0000_stck", trigger: "manual", human: false, argv: ["run"] });
      db.finishRun("r_0101_0000_stck", "succeeded", { data: { runId: "r_0101_0000_stck", status: "succeeded", steps: [] }, problems: [], next: [], exit: 0, ok: true });
      db.close();
      await Bun.sleep(20_000);
    `);
    const sp2 = spawnDetachedRun({ root: s2, stateDir: s2, args: [], runId: "r_0101_0000_stck", env: { PATH: process.env.PATH }, entry: stuck });
    const t0 = Date.now();
    expect(await followRun({ stateDir: s2, runId: "r_0101_0000_stck", timeoutMs: 10_000, pollMs: 20, spawned: sp2, exitGraceMs: 300 })).toMatchObject({ kind: "finished" });
    expect(Date.now() - t0).toBeLessThan(5000);
    sp2.child.kill("SIGKILL");
  });

  test("croft run's parent process exits as soon as it has followed the child: nothing it waited with keeps it alive", () => {
    // The grace for the child's exit was a 3 s sleep raced against the exit; the exit won, and the sleep then held the
    // parent's event loop (and `croft run`) for the rest of the 3 s.
    const s = stateDir();
    const child = join(s, "child.ts");
    writeFileSync(child, `
      import { RunsDb } from ${JSON.stringify(join(import.meta.dir, "../history/runs-db.ts"))};
      const db = RunsDb.open(${JSON.stringify(s)});
      db.createRun({ id: "r_0101_0000_prnt", trigger: "manual", human: false, argv: ["run"] });
      db.finishRun("r_0101_0000_prnt", "succeeded", { data: { runId: "r_0101_0000_prnt", status: "succeeded", steps: [] }, problems: [], next: [], exit: 0, ok: true });
      db.close();
      await Bun.sleep(300);
    `);
    const parent = join(s, "parent.ts");
    writeFileSync(parent, `
      import { followRun, spawnDetachedRun } from ${JSON.stringify(join(import.meta.dir, "detach.ts"))};
      const spawned = spawnDetachedRun({ root: ${JSON.stringify(s)}, stateDir: ${JSON.stringify(s)}, args: [], runId: "r_0101_0000_prnt", env: { PATH: process.env.PATH }, entry: ${JSON.stringify(child)} });
      const res = await followRun({ stateDir: ${JSON.stringify(s)}, runId: "r_0101_0000_prnt", timeoutMs: 10_000, pollMs: 20, spawned });
      console.log(res.kind, Date.now());
    `);
    const r = spawnSync(process.execPath, [parent], { encoding: "utf8", env: { PATH: process.env.PATH } });
    const exitedAt = Date.now();
    const [kind, followedAt] = r.stdout.trim().split(" ");
    expect(kind, r.stderr).toBe("finished");
    expect(exitedAt - Number(followedAt)).toBeLessThan(1000);
  });

  test("an unknown run with no process log is not_started; with one it is still starting", async () => {
    const s = stateDir();
    const none = await followRun({ stateDir: s, runId: "r_0101_0000_abcd", timeoutMs: 50, pollMs: 10 });
    expect(none).toMatchObject({ kind: "not_started", problem: { code: "USAGE_ERROR" } });
    mkdirSync(logDir(s, "r_0101_0000_efgh"), { recursive: true });
    writeFileSync(processLogPath(s, "r_0101_0000_efgh"), "");
    const starting = await followRun({ stateDir: s, runId: "r_0101_0000_efgh", timeoutMs: 50, pollMs: 10 });
    expect(starting).toMatchObject({ kind: "running", summary: { exit: 6 } });
  });

  test("the child's own output goes to _process.log, which no asset's log can be (names cannot start with _)", () => {
    const s = stateDir();
    expect(processLogPath(s, "r_0101_0000_abcd")).toBe(join(logDir(s, "r_0101_0000_abcd"), "_process.log"));
  });

  test("the parent records the child's pid, start time and boot id at spawn (the handshake)", async () => {
    const s = stateDir();
    const script = join(s, "wait.ts");
    writeFileSync(script, `await Bun.sleep(200);\n`);
    const spawned = spawnDetachedRun({ root: s, stateDir: s, args: ["x"], runId: "r_0101_0000_hand", env: { PATH: process.env.PATH }, entry: script });
    expect(spawned.output).toBe(processLogPath(s, "r_0101_0000_hand"));
    // The child's output may quote asset output: only the user can read it.
    expect(statSync(spawned.output).mode & 0o777).toBe(0o600);
    const rec = readChildRecord(s, "r_0101_0000_hand");
    expect(rec).toMatchObject({ pid: spawned.pid, procStart: procStart(spawned.pid)!, bootId: bootId() });
    await spawned.exited;
  });

  // `croft wait` for a run whose detached child died before it created the run record (kill -9, OOM, reboot
  // during a slow import) used to report "running" forever while status showed nothing running.
  test("wait: a child that died before recording its run is crashed, not running forever", async () => {
    const s = stateDir();
    const child = spawnSync(process.execPath, ["-e", "0"]);
    writeChildRecord(s, "r_0101_0000_gone", { pid: child.pid!, procStart: "1", bootId: bootId() });
    writeFileSync(processLogPath(s, "r_0101_0000_gone"), "loading assets…\n");
    const res = await followRun({ stateDir: s, runId: "r_0101_0000_gone", timeoutMs: 3000, pollMs: 10 });
    expect(res.kind).toBe("finished");
    if (res.kind === "finished") {
      expect(res.summary).toMatchObject({ exit: 1, ok: false, data: { runId: "r_0101_0000_gone", status: "crashed", steps: [] } });
      expect(res.summary.problems[0]).toMatchObject({ code: "RUN_CRASHED", runId: "r_0101_0000_gone" });
      expect(res.summary.problems[0]!.message).toContain(`pid ${child.pid}`);
    }
  });

  test("wait: a child that is still alive without a run record is still starting", async () => {
    const s = stateDir();
    writeChildRecord(s, "r_0101_0000_live", currentIdentity());
    const res = await followRun({ stateDir: s, runId: "r_0101_0000_live", timeoutMs: 100, pollMs: 10 });
    expect(res).toMatchObject({ kind: "running", summary: { exit: 6, data: { status: "running" } } });
  });

  test("a child that refused to start reports its own problem (parent and wait alike)", async () => {
    const s = stateDir();
    const p = problem("BACKFILL_WOULD_DUPLICATE", { message: "events appends rows", hint: "add a key", asset: "events" });
    const script = join(s, "refuse.ts");
    writeFileSync(script, `
      import { writeNotStarted } from ${JSON.stringify(join(import.meta.dir, "detach.ts"))};
      writeNotStarted(${JSON.stringify(s)}, "r_0101_0000_refu", ${JSON.stringify(p)});
      process.exit(2);
    `);
    const spawned = spawnDetachedRun({ root: s, stateDir: s, args: [], runId: "r_0101_0000_refu", env: { PATH: process.env.PATH }, entry: script });
    const res = await followRun({ stateDir: s, runId: "r_0101_0000_refu", timeoutMs: 10_000, pollMs: 20, spawned });
    expect(res).toMatchObject({ kind: "not_started", problem: { code: "BACKFILL_WOULD_DUPLICATE", message: "events appends rows", runId: "r_0101_0000_refu" } });
    const later = await followRun({ stateDir: s, runId: "r_0101_0000_refu", timeoutMs: 3000, pollMs: 10 });
    expect(later).toMatchObject({ kind: "not_started", problem: { code: "BACKFILL_WOULD_DUPLICATE" } });
  });

  test("a live run recorded with an empty boot id is followed, not marked crashed", async () => {
    const s = stateDir();
    const db = RunsDb.open(s);
    const run = db.createRun({ trigger: "manual", human: true, argv: ["run"], identity: { ...currentIdentity(), bootId: "" } });
    db.close();
    const res = await followRun({ stateDir: s, runId: run.id, timeoutMs: 1500, pollMs: 20 });
    expect(res.kind).toBe("running");
    const again = RunsDb.open(s);
    try {
      expect(again.getRun(run.id)?.status).toBe("running");
    } finally {
      again.close();
    }
  });

  test("a detached child that dies before recording its run is reported with its output", async () => {
    const s = stateDir();
    const script = join(s, "die.ts");
    writeFileSync(script, `console.error("could not load the asset: boom"); process.exit(3);\n`);
    const spawned = spawnDetachedRun({ root: s, stateDir: s, args: [], runId: "r_0101_0000_dead", env: { PATH: process.env.PATH }, entry: script });
    const res = await followRun({ stateDir: s, runId: "r_0101_0000_dead", timeoutMs: 10_000, pollMs: 20, spawned });
    expect(res.kind).toBe("not_started");
    if (res.kind === "not_started") {
      expect(res.problem.message).toContain("exited with 3");
      expect(res.problem.message).toContain("could not load the asset: boom");
    }
  });

  test("the detached child gets only the environment it was given, plus the hidden flags", async () => {
    const s = stateDir();
    const script = join(s, "env.ts");
    writeFileSync(script, `console.log(JSON.stringify({ secret: process.env.SHOULD_NOT_LEAK ?? null, mine: process.env.MINE ?? null, args: process.argv.slice(2) }));\n`);
    process.env.SHOULD_NOT_LEAK = "leak";
    try {
      const spawned = spawnDetachedRun({ root: s, stateDir: s, args: ["x", "--json"], runId: "r_0101_0000_envv", env: { PATH: process.env.PATH, MINE: "yes" }, entry: script });
      expect((await spawned.exited).code).toBe(0);
      const out = JSON.parse(readFileSync(spawned.output, "utf8").trim());
      expect(out).toMatchObject({ secret: null, mine: "yes", args: ["run", "x", "--json", "--run-id", "r_0101_0000_envv", "--detached"] });
    } finally {
      delete process.env.SHOULD_NOT_LEAK;
    }
  });
});

describe("step helpers", () => {
  test("croftError recognizes a CroftError from another copy of croft by its shape", () => {
    const foreign = Object.assign(new Error("m"), { name: "CroftError", problem: problem("KEYSET_STUCK", { message: "stuck", hint: "h" }) });
    expect(croftError(foreign)).toBeInstanceOf(CroftError);
    expect(croftError(foreign)!.code).toBe("KEYSET_STUCK");
    const unknown = Object.assign(new Error("m"), { name: "CroftError", problem: { severity: "error", code: "NOT_A_CODE", message: "x", hint: "", docs: "" } });
    expect(croftError(unknown)!.code).toBe("ASSET_CODE_ERROR");
    expect(croftError(new Error("plain"))).toBeNull();
  });

  test("retryable: what the error says, never project, safety or control-flow codes", () => {
    const p = (code: Parameters<typeof problem>[0], retryable?: boolean) => problem(code, { message: "", hint: "", ...(retryable !== undefined ? { retryable } : {}) });
    expect(isRetryable(p("HTTP_ERROR", true))).toBe(true);
    expect(isRetryable(p("HTTP_ERROR", false))).toBe(false);
    expect(isRetryable(p("DB_BUSY", true))).toBe(true);
    expect(isRetryable(p("TYPE_CONFLICT"))).toBe(false);
    expect(isRetryable(p("ASSET_BUSY", true))).toBe(false);
    expect(isRetryable(p("SECRET_MISSING", true))).toBe(false);
    expect(isRetryable(p("INTERRUPTED", true))).toBe(false);
    expect(isRetryable({ ...p("HTTP_ERROR", true), code: "SOMETHING_ELSE" })).toBe(false);
  });

  test("StepProgress throttles progress events, but a phase change is always reported", async () => {
    const seen: string[] = [];
    const p = new StepProgress("a", (s) => seen.push(`${s.phase}:${s.rowsFetched}`), 50);
    p.addRows(2);
    p.addRows(3);
    p.request({ status: 200, body: "[]", label: "GET x" });
    expect(seen).toEqual(["extract:2"]);
    // What changed inside the window is reported when it ends.
    await Bun.sleep(80);
    expect(seen).toEqual(["extract:2", "extract:5"]);
    p.addRows(1);
    p.setPhase("write");
    expect(seen).toEqual(["extract:2", "extract:5", "write:6"]);
    await Bun.sleep(80);
    expect(seen).toEqual(["extract:2", "extract:5", "write:6"]);   // the forced report replaced the pending one
    expect(p.paused).toBe(true);
    expect(p.extractInfo()).toEqual({ requests: 1, lastStatus: 200, bodyPreview: "[]" });
  });

  test("StepProgress reports at most every 500 ms by default, and nothing after close()", async () => {
    const seen: number[] = [];
    const p = new StepProgress("a", (s) => seen.push(s.rowsFetched));
    p.addRows(1);
    p.addRows(1);
    expect(seen).toEqual([1]);
    p.close();
    await Bun.sleep(600);
    p.addRows(1);
    expect(seen).toEqual([1]);
  });

  test("jsonSafe turns bigint into numbers or exact text", () => {
    expect(jsonSafe({ a: 5n, b: 12345678901234567890n })).toEqual({ a: 5, b: "12345678901234567890" } as never);
  });
});
