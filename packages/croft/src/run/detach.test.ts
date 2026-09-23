import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError, problem } from "../core/errors.ts";
import { bootId } from "../core/proc.ts";
import { logDir } from "../history/logs.ts";
import { RunsDb } from "../history/runs-db.ts";
import { finishedSteps, followRun, lastProgress, parseWait, runningSummary, spawnDetachedRun, summaryFromRecords } from "./detach.ts";
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
      expect(sum.data.steps[0]).toMatchObject({ asset: "a", attempt: 2, status: "failed" });
      expect(sum.problems.map((p) => p.code)).toContain("RUN_CRASHED");
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

  test("an unknown run with no process log is not_started; with one it is still starting", async () => {
    const s = stateDir();
    const none = await followRun({ stateDir: s, runId: "r_0101_0000_abcd", timeoutMs: 50, pollMs: 10 });
    expect(none).toMatchObject({ kind: "not_started", problem: { code: "USAGE_ERROR" } });
    mkdirSync(logDir(s, "r_0101_0000_efgh"), { recursive: true });
    writeFileSync(join(logDir(s, "r_0101_0000_efgh"), "process.log"), "");
    const starting = await followRun({ stateDir: s, runId: "r_0101_0000_efgh", timeoutMs: 50, pollMs: 10 });
    expect(starting).toMatchObject({ kind: "running", summary: { exit: 6 } });
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
    await Bun.sleep(60);
    p.addRows(1);
    p.setPhase("write");
    expect(seen).toEqual(["extract:2", "extract:6", "write:6"]);
    expect(p.paused).toBe(true);
    expect(p.extractInfo()).toEqual({ requests: 1, lastStatus: 200, bodyPreview: "[]" });
  });

  test("jsonSafe turns bigint into numbers or exact text", () => {
    expect(jsonSafe({ a: 5n, b: 12345678901234567890n })).toEqual({ a: 5, b: "12345678901234567890" } as never);
  });
});
