import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { problem } from "../../core/errors.ts";
import { logPath, openLog } from "../../history/logs.ts";
import { cleanup, cli, DEAD, makeProject, NOW, runsDb, shape } from "./inspect-testkit.ts";

afterAll(() => cleanup());

const ENV = { CROFT_NOW: NOW };

/** Two runs: r_0922_1000_aaaa (github_issues ok, stripe_charges failed) and r_0922_1100_bbbb (github_issues ok),
 *  plus a crashed one; logs written through history/logs.ts with a .env value in them. */
function project() {
  const p = makeProject({ files: { ".env": "GITHUB_TOKEN=ghp_supersecret123\n" } });
  let clock = Date.parse("2026-09-22T17:00:00Z");
  const db = runsDb(p.stateDir, () => new Date(clock));
  const redact = (s: string) => s.replaceAll("ghp_supersecret123", "[redacted:GITHUB_TOKEN]");
  try {
    const a = db.createRun({ id: "r_0922_1000_aaaa", trigger: "manual", human: true, argv: ["run"], identity: DEAD });
    db.startStep({ runId: a.id, asset: "github_issues", attempt: 1, reason: "requested" });
    const l1 = openLog(p.stateDir, a.id, "github_issues");
    l1.log("fetching page", 1);
    l1.write("token ghp_supersecret123 in a line the asset printed");   // written raw: croft logs redacts on read too
    l1.close();
    clock += 3000;
    db.finishStep(a.id, "github_issues", 1, { status: "ok", rows: { in: 200, added: 200, updated: 0 } });
    db.startStep({ runId: a.id, asset: "stripe_charges", attempt: 1, reason: "requested" });
    const l2 = openLog(p.stateDir, a.id, "stripe_charges", { redact });
    for (let i = 1; i <= 250; i++) l2.log(`line ${i}`);
    l2.close();
    clock += 2000;
    db.finishStep(a.id, "stripe_charges", 1, {
      status: "failed",
      error: problem("HTTP_ERROR", { message: "GET https://api.stripe.com/v1/charges?key=ghp_supersecret123 → 401", hint: "check STRIPE_KEY", asset: "stripe_charges" }),
    });
    db.finishRun(a.id, "failed");

    clock += 60 * 60_000;
    const b = db.createRun({ id: "r_0922_1100_bbbb", trigger: "schedule", human: false, argv: ["run", "--due"], identity: DEAD });
    db.startStep({ runId: b.id, asset: "github_issues", attempt: 1, reason: "schedule_due" });
    const l3 = openLog(p.stateDir, b.id, "github_issues");
    l3.log("nothing new");
    l3.close();
    clock += 1000;
    db.finishStep(b.id, "github_issues", 1, { status: "unchanged", rows: { in: 0, added: 0, updated: 0 } });
    db.finishRun(b.id, "succeeded");
  } finally {
    db.close();
  }
  return p;
}

describe("croft logs --json", () => {
  test("an asset's last step: its log lines, redacted, and where the log is", async () => {
    const p = project();
    const r = await cli(["logs", "github_issues", "--json"], { cwd: p.root, env: ENV });
    expect(r.exit).toBe(0);
    expect(r.json.data).toEqual({
      mode: "logs", target: { kind: "asset", value: "github_issues" }, followed: false,
      steps: [{
        runId: "r_0922_1100_bbbb", asset: "github_issues", attempt: 1, status: "unchanged", reason: "schedule_due",
        startedAt: "2026-09-22T11:00:05-07:00", finishedAt: "2026-09-22T11:00:06-07:00",
        log: ".croft/logs/r_0922_1100_bbbb/github_issues.log", lines: ["nothing new"], truncated: false, error: null,
      }],
    });
  });

  test("every .env value is redacted from log lines and errors", async () => {
    const p = project();
    const r = await cli(["logs", "r_0922_1000_aaaa", "--json"], { cwd: p.root, env: ENV });
    expect(r.stdout).not.toContain("ghp_supersecret123");
    const [issues, charges] = r.json.data.steps;
    expect(issues.lines).toEqual(["fetching page 1", "token [redacted:GITHUB_TOKEN] in a line the asset printed"]);
    expect(charges.error).toMatchObject({ code: "HTTP_ERROR", message: "GET https://api.stripe.com/v1/charges?key=[redacted:GITHUB_TOKEN] → 401" });
  });

  test("the default tail is 200 lines; --lines N shows more", async () => {
    const p = project();
    const r = await cli(["logs", "stripe_charges", "--json"], { cwd: p.root, env: ENV });
    const step = r.json.data.steps[0];
    expect(step.lines).toHaveLength(200);
    expect(step.lines[0]).toBe("line 51");
    expect(step.truncated).toBe(true);
    expect(r.json.next).toEqual([{ command: "croft logs stripe_charges --lines 1000", reason: "earlier log lines were cut" }]);
    const more = await cli(["logs", "stripe_charges", "--lines", "1000", "--json"], { cwd: p.root, env: ENV });
    expect(more.json.data.steps[0]).toMatchObject({ truncated: false });
    expect(more.json.data.steps[0].lines).toHaveLength(250);
    expect((await cli(["logs", "--lines", "0", "--json"], { cwd: p.root })).json.problems[0].code).toBe("USAGE_ERROR");
  });

  test("--failed: the asset's last failed step, with its error", async () => {
    const p = project();
    const r = await cli(["logs", "stripe_charges", "--failed", "--json"], { cwd: p.root, env: ENV });
    expect(r.json.data.steps).toHaveLength(1);
    expect(r.json.data.steps[0]).toMatchObject({ runId: "r_0922_1000_aaaa", status: "failed", error: { code: "HTTP_ERROR", hint: "check STRIPE_KEY" } });
    const none = await cli(["logs", "github_issues", "--failed", "--json"], { cwd: p.root, env: ENV });
    expect(none.json.data.steps).toEqual([]);
    expect(none.json.next[0].command).toBe("croft logs github_issues");
  });

  test("a run id shows each of its steps; bare logs shows the latest run; --failed the latest failed one", async () => {
    const p = project();
    const run = await cli(["logs", "r_0922_1000_aaaa", "--json"], { cwd: p.root, env: ENV });
    expect(run.json.data.target).toEqual({ kind: "run", value: "r_0922_1000_aaaa" });
    expect(run.json.data.steps.map((s: { asset: string }) => s.asset)).toEqual(["github_issues", "stripe_charges"]);
    const latest = await cli(["logs", "--json"], { cwd: p.root, env: ENV });
    expect(latest.json.data.steps.map((s: { runId: string }) => s.runId)).toEqual(["r_0922_1100_bbbb"]);
    const failed = await cli(["logs", "--failed", "--json"], { cwd: p.root, env: ENV });
    expect(failed.json.data.steps.map((s: { asset: string }) => s.asset)).toEqual(["stripe_charges"]);
  });

  test("a step still marked running in a run whose process is gone is shown as crashed, and counts as failed", async () => {
    const p = project();
    const db = runsDb(p.stateDir);
    db.createRun({ id: "r_0922_1200_dead", trigger: "manual", human: true, argv: ["run", "taxi_zones"], identity: DEAD });
    db.startStep({ runId: "r_0922_1200_dead", asset: "taxi_zones", attempt: 1, reason: "requested" });
    db.close();
    const r = await cli(["logs", "taxi_zones", "--failed", "--json"], { cwd: p.root, env: ENV });
    expect(r.json.data.steps[0]).toMatchObject({ runId: "r_0922_1200_dead", status: "crashed", log: null, lines: [] });
  });

  test("unknown runs and malformed targets are usage errors", async () => {
    const p = project();
    const r = await cli(["logs", "r_0101_0000_zzzz", "--json"], { cwd: p.root });
    expect(r.exit).toBe(2);
    expect(r.json.problems[0]).toMatchObject({ code: "USAGE_ERROR", fix: { command: "croft logs --runs" } });
    expect((await cli(["logs", "../etc", "--json"], { cwd: p.root })).json.problems[0].code).toBe("USAGE_ERROR");
  });

  test("before any run there is nothing to show, and it says what to do", async () => {
    const p = makeProject();
    const r = await cli(["logs", "github_issues", "--json"], { cwd: p.root });
    expect(r.exit).toBe(0);
    expect(r.json.data.steps).toEqual([]);
    expect(r.json.next).toEqual([{ command: "croft run github_issues", reason: "nothing has run yet" }]);
    expect((await cli(["logs", "--runs", "--json"], { cwd: p.root })).json.data.runs).toEqual([]);
  });
});

describe("croft logs --runs", () => {
  test("golden: runs newest first with their steps", async () => {
    const p = project();
    const r = await cli(["logs", "--runs", "--json"], { cwd: p.root, env: ENV });
    expect(r.exit).toBe(0);
    const runs = r.json.data.runs;
    expect(runs.map((x: { runId: string }) => x.runId)).toEqual(["r_0922_1100_bbbb", "r_0922_1000_aaaa"]);
    expect(runs[1]).toEqual({
      runId: "r_0922_1000_aaaa", trigger: "manual", human: true, status: "failed", startedAt: "2026-09-22T10:00:00-07:00",
      finishedAt: "2026-09-22T10:00:05-07:00", durationMs: 5000, argv: ["run"],
      steps: [
        { asset: "github_issues", attempt: 1, status: "ok", reason: "requested", startedAt: "2026-09-22T10:00:00-07:00",
          finishedAt: "2026-09-22T10:00:03-07:00", durationMs: 3000, rows: { in: 200, added: 200, updated: 0 }, error: null,
          logsCommand: "croft logs r_0922_1000_aaaa" },
        { asset: "stripe_charges", attempt: 1, status: "failed", reason: "requested", startedAt: "2026-09-22T10:00:03-07:00",
          finishedAt: "2026-09-22T10:00:05-07:00", durationMs: 2000, rows: { in: null, added: null, updated: null },
          error: { code: "HTTP_ERROR", message: "GET https://api.stripe.com/v1/charges?key=[redacted:GITHUB_TOKEN] → 401" },
          logsCommand: "croft logs r_0922_1000_aaaa" },
      ],
    });
    expect(shape(r.json.data)).toMatchObject({ mode: "string", target: { kind: "string", value: "null" }, limit: "number" });
  });

  test("filtered by asset, by failure and by run", async () => {
    const p = project();
    const byAsset = await cli(["logs", "stripe_charges", "--runs", "--json"], { cwd: p.root, env: ENV });
    expect(byAsset.json.data.runs.map((x: { runId: string }) => x.runId)).toEqual(["r_0922_1000_aaaa"]);
    expect(byAsset.json.data.runs[0].steps.map((s: { asset: string }) => s.asset)).toEqual(["stripe_charges"]);
    const failed = await cli(["logs", "--runs", "--failed", "--json"], { cwd: p.root, env: ENV });
    expect(failed.json.data.runs.map((x: { runId: string }) => x.runId)).toEqual(["r_0922_1000_aaaa"]);
    const one = await cli(["logs", "r_0922_1100_bbbb", "--runs", "--json"], { cwd: p.root, env: ENV });
    expect(one.json.data.runs).toHaveLength(1);
  });

  test("human output lists each run and its steps", async () => {
    const p = project();
    const r = await cli(["logs", "--runs"], { cwd: p.root, env: ENV });
    expect(r.stdout).toContain("r_0922_1000_aaaa  failed  manual  2026-09-22T10:00:00-07:00  5.0 s");
    expect(r.stdout).toContain("  failed      stripe_charges  2.0 s  HTTP_ERROR: GET https://api.stripe.com/v1/charges?key=[redacted:GITHUB_TOKEN] → 401");
    expect(r.stdout).toContain("r_0922_1100_bbbb  succeeded  schedule (scheduled)");
  });
});

describe("croft logs: human output", () => {
  test("a header per step, the lines, and the error block", async () => {
    const p = project();
    const r = await cli(["logs", "stripe_charges", "--failed"], { cwd: p.root, env: ENV });
    const lines = r.stdout.split("\n");
    expect(lines[0]).toBe("── stripe_charges · r_0922_1000_aaaa · attempt 1 · failed (HTTP_ERROR) · 2026-09-22T10:00:03-07:00");
    expect(lines[1]).toBe("(earlier lines not shown; --lines N shows more)");
    expect(lines[2]).toBe("line 51");
    expect(r.stdout).toContain("error HTTP_ERROR");
    expect(r.stdout).not.toContain("ghp_supersecret123");
  });
});

describe("croft logs --follow", () => {
  test("prints a running step's new lines until the step ends", async () => {
    const p = makeProject();
    const db = runsDb(p.stateDir);
    db.createRun({ id: "r_0922_1300_live", trigger: "manual", human: true, argv: ["run", "sales"] });   // this process: alive
    db.startStep({ runId: "r_0922_1300_live", asset: "sales", attempt: 1, reason: "requested" });
    const path = logPath(p.stateDir, "r_0922_1300_live", "sales");
    const w = openLog(p.stateDir, "r_0922_1300_live", "sales");
    w.log("first");
    const out: string[] = [];
    const done = cli(["logs", "sales", "--follow"], { cwd: p.root, stdout: (t) => out.push(t) });
    await Bun.sleep(300);
    expect(out.join("")).toContain("first");
    appendFileSync(path, "second\nthird\n");
    await Bun.sleep(300);
    expect(out.join("")).toContain("third");
    db.finishStep("r_0922_1300_live", "sales", 1, { status: "ok" });
    db.finishRun("r_0922_1300_live", "succeeded");
    const r = await done;
    w.close();
    db.close();
    expect(r.exit).toBe(0);
    const text = out.join("");
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
    expect(text).toContain("── sales ok");
  });

  test("--json collects the followed lines into data and prints them on stderr", async () => {
    const p = makeProject();
    const db = runsDb(p.stateDir);
    db.createRun({ id: "r_0922_1300_json", trigger: "manual", human: true, argv: ["run", "sales"] });
    db.startStep({ runId: "r_0922_1300_json", asset: "sales", attempt: 1, reason: "requested" });
    const w = openLog(p.stateDir, "r_0922_1300_json", "sales");
    w.log("one");
    const err: string[] = [];
    const done = cli(["logs", "r_0922_1300_json", "--follow", "--json"], { cwd: p.root, stderr: (t) => err.push(t) });
    await Bun.sleep(250);
    w.log("two");
    await Bun.sleep(250);
    db.finishStep("r_0922_1300_json", "sales", 1, { status: "ok" });
    db.finishRun("r_0922_1300_json", "succeeded");
    const r = await done;
    w.close();
    db.close();
    expect(r.json.data).toMatchObject({ followed: true, steps: [{ asset: "sales", status: "ok", lines: ["one", "two"] }] });
    expect(err.join("")).toContain("two");
  });

  test("a finished step is shown once, without waiting", async () => {
    const p = project();
    const started = performance.now();
    const r = await cli(["logs", "github_issues", "--follow", "--json"], { cwd: p.root, env: ENV });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(r.json.data.steps[0].lines).toEqual(["nothing new"]);
  });
});
