// Journey 20: an hourly ingest and the SQL transform that reads it, kept fresh by the scheduler (DESIGN.md §8, §6 "The
// scheduler only runs code a human has run"). Scheduling is turned on with `croft schedule on --no-os-job`, so no OS
// job is installed, and the journey plays the per-minute job itself: `croft tick` at CROFT_NOW hour boundaries,
// waiting for each run it starts. Along the way: a new asset is held until it is run by hand, the transform
// updates in the same scheduled run, an edit holds the ingest again, a pause stops the ticks for two hours, missed
// hours run once, and status, doctor, context and describe show all of it.
import { afterAll, beforeAll, describe, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bugTest, cleanupAll, type Envelope, initProject, json, laTime, type MockApi, mockApi, schedulerEnv, show,
} from "./harness.ts";

// `croft schedule on|off` refuses in every croft process started with a temp HOME while CROFT_FORBID_OS_JOBS=1
// (INTERNAL_ERROR "refusing to change the scheduler of the real user"): under Bun, os.userInfo().homedir answers
// $HOME, so guardRealHome (cli/commands/schedule.ts) takes the temp HOME for the real user's. The fix is in T3's
// needed_shared_changes. Until it lands this journey is a bugTest(); CROFT_E2E_BUGS=1 runs it as a plain test.
const scheduleTest = bugTest;

let api: MockApi;
beforeAll(() => {
  api = mockApi();
});
afterAll(async () => {
  api.stop();
  await cleanupAll();
});

const itemsAsset = (base: string, extra = "") => `import { ingest } from "@zabaca/croft";

export default ingest({${extra}
  schedule: "every hour",
  key: "id",
  async *rows({ http }) {
    yield (await http.get("${base}/items")).json<Record<string, unknown>[]>();
  },
});
`;

describe("journey 20: croft schedule", () => {
  scheduleTest("held until run by hand, hourly ticks with the transform in the same run, edits, pause, catch-up, off", async () => {
    const state = { items: [{ id: 1, name: "a" }, { id: 2, name: "b" }] };
    api.route("/items", () => json(state.items));
    const fetches = () => api.requests("/items").length;
    const { project: p } = await initProject();
    p.remove("assets/example_sales.ts");
    p.write("assets/items.ts", itemsAsset(api.url));
    p.write("assets/item_count.sql", "-- description: how many items there are\nSELECT count(*) AS n, max(id) AS last_id FROM items\n");
    const sched = schedulerEnv();
    const at = (h: number, m = 0) => ({ env: { ...sched, CROFT_NOW: laTime(h, m) } });
    const croft = async (args: string[], h: number, m = 0) => p.json(args, at(h, m));
    const ok = async (args: string[], h: number, m = 0) => {
      const r = await croft(args, h, m);
      expect(r.code, show(r)).toBe(0);
      return r.json;
    };
    const heldOf = (env: Envelope, asset: string) => (env.problems as Envelope[]).find((x) => x.code === "SCHEDULE_HELD" && x.asset === asset);
    const itemCount = async () => Number((await p.rows("select n from item_count"))[0]!.n);

    // The scheduler runs a tick; the tick starts one detached `croft run --due` per group, which the journey waits for.
    const tickAndWait = async (h: number, m = 0): Promise<Envelope> => {
      const tick = await ok(["tick"], h, m);
      expect(tick.data.spawned, JSON.stringify(tick)).toHaveLength(1);
      const runId = tick.data.spawned[0].runId as string;
      const done = await croft(["wait", runId, "--timeout", "60s"], h, m);
      expect(done.code, show(done)).toBe(0);
      return { tick, run: done.json };
    };

    expect((await ok(["validate"], 9, 25)).problems.filter((x: Envelope) => x.severity === "error")).toEqual([]);

    // On, without an OS job: the setting, the registry in CROFT_HOME, no LaunchAgent, and both new assets held.
    const on = await ok(["schedule", "on", "--no-os-job"], 9, 30);
    expect(on.data).toMatchObject({
      action: "on", root: p.root, scheduling: { state: "on", via: "serve", lastTickAt: null, stale: false }, job: null, firstTick: null,
      registry: { file: join(sched.CROFT_HOME, "projects.json"), projects: 1, osJob: 0 },
    });
    expect(JSON.parse(readFileSync(join(sched.CROFT_HOME, "projects.json"), "utf8"))).toEqual([expect.objectContaining({ root: p.root, via: "serve" })]);
    expect(existsSync(join(sched.HOME, "Library", "LaunchAgents"))).toBe(false);
    const items = on.data.assets.find((a: Envelope) => a.asset === "items");
    expect(items).toMatchObject({ schedule: "every hour", cron: "0 * * * *", nextFireAt: laTime(10), held: { code: "SCHEDULE_HELD" } });
    expect(items.held.reason).toContain("croft run items releases it");
    expect(heldOf(on, "items")?.fix).toEqual(expect.objectContaining({ command: "croft run items" }));
    expect(on.next).toContainEqual(expect.objectContaining({ command: "croft run items" }));

    // 10:00: the ingest is due, but held: nothing starts and the API is not called.
    const held = await ok(["tick"], 10);
    expect(held.data).toMatchObject({ exited: null, heartbeatAt: "2036-06-10T17:00:00.000Z", spawned: [] });
    expect(held.data.held).toEqual([expect.objectContaining({ asset: "items", code: "SCHEDULE_HELD" })]);
    expect(fetches()).toBe(0);

    // A run by hand releases both.
    const byHand = await ok(["run", "items"], 10, 5);
    expect(byHand.data.steps.map((s: Envelope) => [s.asset, s.status])).toEqual([["items", "ok"], ["item_count", "ok"]]);
    expect(fetches()).toBe(1);
    // (Not due: false. The run by hand is stamped in runs.sqlite with the real clock, years before CROFT_NOW, so the
    // scheduler still counts the 10:00 fire as unhandled; see laTime. No tick comes before 11:00.)
    const released = await ok(["schedule", "status"], 10, 6);
    for (const a of released.data.assets) expect(a, a.asset).toMatchObject({ held: null });
    expect(released.problems.filter((x: Envelope) => x.code === "SCHEDULE_HELD")).toEqual([]);

    // 11:00: the tick starts the ingest's run; the transform that reads it updates in the same run.
    state.items.push({ id: 3, name: "c" });
    const eleven = await tickAndWait(11);
    const runId = eleven.tick.data.spawned[0].runId;
    expect(eleven.tick.data.spawned[0].assets).toEqual(["items"]);
    expect(eleven.run.data).toMatchObject({ runId, status: "succeeded" });
    expect(eleven.run.data.steps.map((s: Envelope) => [s.asset, s.status])).toEqual([["items", "ok"], ["item_count", "ok"]]);
    expect(eleven.run.data.steps[0]).toMatchObject({ reason: "scheduled", rows: { added: 1, total: 3 } });
    expect(fetches()).toBe(2);
    expect(await itemCount()).toBe(3);
    const runs = await ok(["logs", "--runs"], 11, 1);
    expect(runs.data.runs.find((r: Envelope) => r.runId === runId)).toMatchObject({ trigger: "schedule", human: false, argv: ["run", "--due", "items"] });
    // 11:01: that fire is handled; nothing is due.
    const quiet = await ok(["tick"], 11, 1);
    expect(quiet.data).toMatchObject({ exited: null, spawned: [], held: [] });
    expect(fetches()).toBe(2);

    // An edit holds the ingest again: status, context and the tick say so, and nothing runs.
    p.write("assets/items.ts", itemsAsset(api.url, '\n  description: "Items of the shop",'));
    const edited = await ok(["status"], 11, 10);
    expect(edited.data.assets.find((a: Envelope) => a.asset === "items")).toMatchObject({ held: true, edited: true, hold: { code: "SCHEDULE_HELD" } });
    expect(heldOf(edited, "items")?.fix).toEqual(expect.objectContaining({ command: "croft run items" }));
    expect(edited.next).toContainEqual(expect.objectContaining({ command: "croft run items" }));
    const human = await p.croft(["status"], at(11, 10));
    expect(human.stdout).toMatch(/items .*held: code edited .*croft run items releases it/);
    const context = await ok(["context"], 11, 10);
    expect(context.data.held).toEqual(["items"]);
    expect(context.data.assets.find((a: Envelope) => a.asset === "items")).toMatchObject({ schedule: "every hour", hold: { code: "SCHEDULE_HELD" } });
    const heldAgain = await ok(["tick"], 12);
    expect(heldAgain.data.spawned).toEqual([]);
    expect(heldAgain.data.held).toEqual([expect.objectContaining({ asset: "items", code: "SCHEDULE_HELD" })]);
    expect(fetches()).toBe(2);
    await ok(["run", "items"], 12, 10);
    expect(fetches()).toBe(3);
    // (No tick between that run and the next fire: runs.sqlite stamps runs with the real clock, see laTime.)

    // 13:00: scheduled again.
    state.items.push({ id: 4, name: "d" });
    const one = await tickAndWait(13);
    expect(one.run.data.steps.map((s: Envelope) => [s.asset, s.status])).toEqual([["items", "ok"], ["item_count", "ok"]]);
    expect(fetches()).toBe(4);
    expect(await itemCount()).toBe(4);

    // Paused for 2 h at 13:30: the 14:00 and 15:00 ticks exit at once; from 15:30 it is on again, and the fires it
    // missed run once, at 16:00.
    const paused = await ok(["schedule", "pause", "--for", "2h"], 13, 30);
    expect(paused.data.scheduling).toMatchObject({ state: "paused", pausedUntil: laTime(15, 30) });
    expect(paused.next).toEqual([expect.objectContaining({ command: "croft schedule on" })]);
    expect((await ok(["status"], 13, 31)).data.scheduling).toMatchObject({ state: "paused", pausedUntil: laTime(15, 30) });
    for (const h of [14, 15]) {
      const t = await ok(["tick"], h);
      expect(t.data, `${h}:00`).toMatchObject({ exited: "paused", heartbeatAt: null, spawned: [] });
    }
    expect(fetches()).toBe(4);
    const resumed = await ok(["schedule", "status"], 16);
    expect(resumed.data.scheduling.state).toBe("on");
    expect(resumed.data.assets.find((a: Envelope) => a.asset === "items")).toMatchObject({ due: true, dueReason: "fired at 16:00; 3 missed fires run once" });
    state.items.push({ id: 5, name: "e" });
    const sixteen = await tickAndWait(16);
    expect(sixteen.run.data.status).toBe("succeeded");
    expect(fetches()).toBe(5);

    // Missed hours (a laptop asleep from 16:00 to 20:00) run once, and the scheduler reads as stale meanwhile.
    const asleep = await croft(["schedule", "status"], 20);
    expect(asleep.code, show(asleep)).toBe(0);
    expect(asleep.json.data.assets.find((a: Envelope) => a.asset === "items")).toMatchObject({ due: true, dueReason: "fired at 20:00; 4 missed fires run once" });
    expect((asleep.json.problems as Envelope[]).find((x) => x.code === "SCHEDULER_STALE")).toMatchObject({ details: { cause: "serve_not_running" } });
    state.items.push({ id: 6, name: "f" });
    const twenty = await tickAndWait(20);
    expect(twenty.run.data.steps[0]).toMatchObject({ asset: "items", status: "ok", rows: { added: 1, total: 6 } });
    expect(fetches()).toBe(6);
    expect((await ok(["tick"], 20, 1)).data.spawned).toEqual([]);
    expect(fetches()).toBe(6);
    expect(await itemCount()).toBe(6);

    // status, doctor, context and describe show the schedule.
    const status = await ok(["status"], 20, 2);
    expect(status.data.scheduling).toEqual({ state: "on", via: "serve", lastTickAt: laTime(20, 1), stale: false });
    expect(status.data.assets.find((a: Envelope) => a.asset === "items")).toMatchObject({ status: "ok", held: false, next: { at: laTime(21), reason: "schedule", schedule: "every hour" } });
    expect(status.data.assets.find((a: Envelope) => a.asset === "item_count")).toMatchObject({ next: { reason: "after inputs" } });
    expect((await p.croft(["status"], at(20, 2))).stdout).toMatch(/^Scheduling on · last tick 1 min ago · 0 running$/m);
    const doctor = await ok(["doctor"], 20, 2);
    expect(doctor.data.checks.find((c: Envelope) => c.id === "scheduling")).toMatchObject({
      section: "scheduling", status: "ok", details: { state: "on", via: "serve", lastTickAt: laTime(20, 1), stale: false },
    });
    const ctx = await ok(["context"], 20, 2);
    expect(ctx.data.project.scheduling).toMatchObject({ state: "on", via: "serve" });
    expect(ctx.data.assets.find((a: Envelope) => a.asset === "items")).toMatchObject({ schedule: "every hour", nextFireAt: laTime(21) });
    expect(ctx.data.held).toEqual([]);
    const describe = await ok(["describe", "items"], 20, 2);
    expect(describe.data.schedule).toEqual({
      text: "every hour", cron: "0 * * * *", nextFires: [laTime(21), laTime(22), laTime(23)], lastFireAt: laTime(20), lastAttemptAt: laTime(20), scheduling: "on",
    });
    expect((await p.croft(["describe", "items"], at(20, 2))).stdout).toContain("Schedule   every hour (cron 0 * * * *) · next 21:00, 22:00, 23:00");

    // Off: out of the registry, and a tick exits at once.
    const off = await ok(["schedule", "off"], 20, 5);
    expect(off.data).toMatchObject({ action: "off", scheduling: { state: "off", via: null }, job: null, registry: { projects: 0, osJob: 0 } });
    expect(JSON.parse(readFileSync(join(sched.CROFT_HOME, "projects.json"), "utf8"))).toEqual([]);
    expect((await ok(["tick"], 21)).data).toMatchObject({ exited: "scheduling_off", spawned: [] });
    const after = await ok(["status"], 21, 1);
    expect(after.data.scheduling.state).toBe("off");
    expect(after.data.assets.find((a: Envelope) => a.asset === "items").next).toMatchObject({ reason: "scheduling off" });
    expect(fetches()).toBe(6);
    expect(existsSync(join(sched.HOME, "Library", "LaunchAgents"))).toBe(false);
  }, 240_000);
});

