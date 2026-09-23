// Journey 7: a long run off a TTY (how Claude Code runs croft). `croft run` detaches, follows for --follow,
// and returns exit 6 with `croft wait <id>`; the child keeps fetching after the parent exited; `croft wait`
// returns 0 with the result; `croft logs <run-id>` shows the asset's console output.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { slowAsset } from "./fixtures.ts";
import { alive, cleanupAll, initProject, json, type MockApi, mockApi, RUN_ID, show, until } from "./harness.ts";

let api: MockApi;
beforeAll(() => {
  api = mockApi();
});
afterAll(async () => {
  api.stop();
  await cleanupAll();
});

test("journey 7: detached run → exit 6 within --follow → croft wait 0 → croft logs <run-id>", async () => {
  const PAGES = 16;
  api.route("/slow", async (_req, url) => {
    const page = Number(url.searchParams.get("page") ?? 1);
    await Bun.sleep(250);
    return json({ rows: [{ id: page * 2 - 1, page }, { id: page * 2, page }], more: page < PAGES });
  });
  const { project: p } = await initProject();
  p.write("assets/slow_api.ts", slowAsset(api.url));

  const t0 = Date.now();
  const parent = p.start(["run", "slow_api", "--json", "--follow", "1s"]);
  const r = await parent.done;
  const took = Date.now() - t0;
  expect(r.code, show(r)).toBe(6);
  expect(took).toBeLessThan(8_000);
  expect(r.json).toMatchObject({ ok: true, command: "run", data: { status: "running" } });
  const runId = r.json!.data.runId as string;
  expect(runId).toMatch(RUN_ID);
  expect(r.json!.next).toEqual([{ command: `croft wait ${runId} --timeout 100s`, reason: "still running" }]);
  const pagesAtExit = api.requests("/slow").length;
  expect(pagesAtExit).toBeLessThan(PAGES);

  // The run outlives its parent: status shows it running in another process, and requests keep coming.
  const st = await p.json(["status"]);
  const running = st.json.data.running.find((x: { runId: string }) => x.runId === runId);
  expect(running, show(st)).toBeDefined();
  expect(running.pid).not.toBe(parent.proc.pid);
  expect(alive(running.pid)).toBe(true);
  expect(alive(parent.proc.pid)).toBe(false);

  // A short wait is still exit 6, with progress.
  const short = await p.json(["wait", runId, "--timeout", "0.2s"]);
  expect(short.code, show(short)).toBe(6);
  expect(short.json.data).toMatchObject({ runId, status: "running" });

  const done = await p.json(["wait", runId, "--timeout", "60s"]);
  expect(done.code, show(done)).toBe(0);
  expect(done.json).toMatchObject({ ok: true, command: "wait", data: { runId, status: "succeeded" } });
  expect(done.json.data.steps[0]).toMatchObject({ asset: "slow_api", status: "ok", rows: { added: PAGES * 2, total: PAGES * 2 }, requests: PAGES });
  expect(api.requests("/slow").length).toBe(PAGES);
  expect((await p.rows("select count(*) n from slow_api"))[0]!.n).toBe(PAGES * 2);

  const logs = await p.json(["logs", runId]);
  expect(logs.code, show(logs)).toBe(0);
  expect(logs.json.data).toMatchObject({ mode: "logs", target: { kind: "run", value: runId } });
  const lines: string[] = logs.json.data.steps.flatMap((s: { lines: string[] }) => s.lines);
  for (let page = 1; page <= PAGES; page++) expect(lines.some((l) => l.includes(`fetched page ${page} with 2 rows`)), lines.join("\n")).toBe(true);
  // The human form shows the same text.
  const human = await p.croft(["logs", runId]);
  expect(human.code).toBe(0);
  expect(human.stdout).toContain(`fetched page ${PAGES} with 2 rows`);

  // logs --runs lists the run with its argv (the user's own arguments only).
  const runs = await p.json(["logs", "--runs"]);
  const entry = runs.json.data.runs.find((x: { runId: string }) => x.runId === runId);
  expect(entry).toMatchObject({ status: "succeeded", argv: ["run", "slow_api", "--json", "--follow", "1s"] });
}, 120_000);

// Fixed: §4.3 status.running[] carries {phase, rowsFetched}, which status reads from runs.summary.progress. The
// run engine now writes it while a step works (at most every 500 ms, and what changed inside a window at its
// end), so rows fetched in the first second no longer read as 0. Same for context.running.
test("journey 7b: status shows a running run's phase and rows fetched", async () => {
  api.route("/slow2", async (_req, url) => {
    const page = Number(url.searchParams.get("page") ?? 1);
    await Bun.sleep(300);
    return json({ rows: [{ id: page * 2 - 1, page }, { id: page * 2, page }], more: page < 12 });
  });
  const { project: p } = await initProject();
  p.write("assets/slow_two.ts", slowAsset(api.url).replace(`${api.url}/slow"`, `${api.url}/slow2"`));
  const r = await p.json(["run", "slow_two", "--follow", "0.2s"]);
  expect(r.code, show(r)).toBe(6);
  const runId = r.json.data.runId as string;
  try {
    await until(() => api.requests("/slow2").length >= 4);
    const st = await p.json(["status"]);
    const running = st.json.data.running.find((x: { runId: string }) => x.runId === runId);
    expect(running, show(st)).toBeDefined();
    expect(running.phase, show(st)).toBe("extract");
    expect(running.rowsFetched, show(st)).toBeGreaterThan(0);
  } finally {
    await p.croft(["wait", runId, "--timeout", "60s"]);
  }
}, 120_000);
