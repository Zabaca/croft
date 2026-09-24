// Journey 22: a scheduled ingest that fails the same way every time (DESIGN.md §8 "What the user experiences":
// retries, failures, notifications). The API tightens its page size after the ingest was approved, so the 10:00
// scheduled run fails with HTTP 400, whose body echoes the API key from .env. Nobody watches a scheduled run, so:
// a desktop notification is recorded (CROFT_NOTIFY_DRY: <state>/logs/notifications.ndjson), and the webhook in
// croft.json receives the failure envelope, with the key redacted. The failure is not retried, not within the run
// and not by the ticks that follow; a code fix and a run by hand clear it, and the next fire runs the fixed code.
import { afterAll, beforeAll, describe, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bugTest, cleanupAll, type Envelope, initProject, json, laTime, type MockApi, mockApi, ndjson, schedulerEnv, show, until,
} from "./harness.ts";

// `croft schedule on` refuses under CROFT_FORBID_OS_JOBS=1 with a temp HOME (see j20): a bugTest() until the fix
// in T3's needed_shared_changes lands; CROFT_E2E_BUGS=1 runs it as a plain test.
const scheduleTest = bugTest;

const KEY = "sk_live_j22SecretKey0123456789abcdef";
let api: MockApi;
let hook: ReturnType<typeof Bun.serve>;
const hooks: { path: string; headers: Record<string, string>; body: string }[] = [];

beforeAll(() => {
  api = mockApi();
  hook = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      hooks.push({ path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers), body: await req.text() });
      return new Response("ok");
    },
  });
});
afterAll(async () => {
  api.stop();
  hook.stop(true);
  await cleanupAll();
});

const itemsAsset = (base: string, perPage: number) => `import { ingest } from "@zabaca/croft";

export default ingest({
  description: "Items, a page of ${perPage}",
  schedule: "every hour",
  secrets: ["SHOP_KEY"],
  key: "id",
  async *rows({ http, secret }) {
    const res = await http.get("${base}/v1/items", {
      headers: { Authorization: \`Bearer \${secret("SHOP_KEY")}\` },
      query: { per_page: ${perPage} },
    });
    yield res.json<Record<string, unknown>[]>();
  },
});
`;

describe("journey 22: a scheduled run that fails", () => {
  scheduleTest("fails once per fire, notifies (desktop and webhook, the key redacted), and a fix plus a run by hand clear it", async () => {
    const shop = { maxPerPage: 1000, items: [{ id: 1, name: "a" }, { id: 2, name: "b" }] };
    api.route("/v1/items", (req, url) => {
      if (req.headers.get("authorization") !== `Bearer ${KEY}`) return json({ error: "unknown key" }, { status: 401 });
      if (Number(url.searchParams.get("per_page")) > shop.maxPerPage) {
        // Deterministic, and it echoes the key: a real API's error bodies often do.
        return json({ error: `per_page must be at most ${shop.maxPerPage} (key ${KEY})` }, { status: 400 });
      }
      return json(shop.items);
    });
    const fetches = () => api.requests("/v1/items").length;
    const { project: p } = await initProject();
    p.remove("assets/example_sales.ts");
    p.secret("SHOP_KEY", KEY);
    const hookPath = "/services/T0001/B0001/j22HookSecretPath";
    const config = JSON.parse(p.read("croft.json"));
    p.write("croft.json", JSON.stringify({ ...config, notify: { webhook: `http://127.0.0.1:${hook.port}${hookPath}` } }, null, 2));
    p.write("assets/items.ts", itemsAsset(api.url, 500));
    const sched = schedulerEnv();
    const at = (h: number, m = 0) => ({ env: { ...sched, CROFT_NOW: laTime(h, m) } });
    const ok = async (args: string[], h: number, m = 0) => {
      const r = await p.json(args, at(h, m));
      expect(r.code, show(r)).toBe(0);
      return r.json;
    };
    const notifications = () => ndjson(join(p.stateDir, "logs", "notifications.ndjson"));

    await ok(["schedule", "on", "--no-os-job"], 9, 30);
    const first = await ok(["run", "items"], 9, 35);                  // approves the code for the scheduler
    expect(first.data.steps[0]).toMatchObject({ asset: "items", status: "ok", rows: { total: 2 } });
    expect(fetches()).toBe(1);

    // The API now allows at most 100 per page. The 10:00 run fails: one request, no retry (a 400 is deterministic).
    shop.maxPerPage = 100;
    const tick = await ok(["tick"], 10);
    expect(tick.data.spawned).toEqual([{ runId: expect.any(String), assets: ["items"] }]);
    const runId = tick.data.spawned[0].runId as string;
    const failed = await p.json(["wait", runId, "--timeout", "60s"], at(10));
    expect(failed.code, show(failed)).toBe(1);
    const step = failed.json.data.steps[0];
    expect(step).toMatchObject({ asset: "items", status: "failed", attempt: 1, error: { code: "HTTP_ERROR", retryable: false } });
    expect(step.error.message).toContain("[redacted:SHOP_KEY]");
    expect(fetches()).toBe(2);

    // The notification: recorded, not shown (CROFT_NOTIFY_DRY), in plain words, the key redacted. The run notifies
    // after it has recorded its end, which is when croft wait returns, so the records may come a moment later.
    await until(() => notifications().some((n) => n.kind === "webhook"));
    const desktop = notifications().filter((n) => n.kind === "desktop");
    expect(desktop).toHaveLength(1);
    expect(desktop[0]).toMatchObject({ runId, status: "dry", title: "croft: proj" });
    expect(desktop[0]!.body).toContain("items failed in a scheduled run: HTTP_ERROR: ");
    expect(desktop[0]!.body).toContain("See it with: croft logs items --failed");
    // The webhook: posted once (loopback, so even under CROFT_NOTIFY_DRY), the run's failure envelope as JSON.
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.path).toBe(hookPath);
    expect(hooks[0]!.headers["content-type"]).toBe("application/json");
    const envelope = JSON.parse(hooks[0]!.body) as Envelope;
    expect(envelope).toMatchObject({ project: "proj", ok: false, exit: 1, data: { runId, status: "failed" } });
    expect(envelope.text).toContain("items failed in a scheduled run");
    expect(envelope.data.steps[0]).toMatchObject({ asset: "items", status: "failed", error: { code: "HTTP_ERROR" } });
    expect(envelope.problems[0]).toMatchObject({ code: "HTTP_ERROR", asset: "items" });
    expect(envelope.next).toContainEqual(expect.objectContaining({ command: "croft logs items --failed" }));
    expect(envelope.confirmation).toBeUndefined();
    expect(hooks[0]!.body).toContain("[redacted:SHOP_KEY]");
    // No trace of the key anywhere a notification went, nor of the webhook's secret path in what croft wrote.
    const written = [hooks[0]!.body, readFileSync(join(p.stateDir, "logs", "notifications.ndjson"), "utf8")];
    for (const text of written) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(Buffer.from(KEY).toString("base64"));
      expect(text).not.toContain(encodeURIComponent(KEY).replace(/_/g, "%5F"));
    }
    expect(notifications().find((n) => n.kind === "webhook")).toEqual({
      at: "2036-06-10T17:00:00.000Z", runId, kind: "webhook", host: `127.0.0.1:${hook.port}`, status: "sent", httpStatus: 200, attempts: 1,
    });
    expect(JSON.stringify(notifications())).not.toContain("j22HookSecretPath");

    // Not retried every minute: the fire is handled, and the next ticks start nothing until the next fire.
    for (const m of [1, 2, 30]) {
      const t = await ok(["tick"], 10, m);
      expect(t.data, `10:${m}`).toMatchObject({ exited: null, spawned: [] });
    }
    expect(fetches()).toBe(2);
    expect(hooks).toHaveLength(1);
    const view = await ok(["schedule", "status"], 10, 31);
    expect(view.data.assets.find((a: Envelope) => a.asset === "items")).toMatchObject({
      due: false, lastFireAt: laTime(10), lastAttemptAt: laTime(10), nextFireAt: laTime(11), held: null,
    });
    const status = await ok(["status"], 10, 31);
    expect(status.data.assets.find((a: Envelope) => a.asset === "items")).toMatchObject({ status: "failed", lastRun: { runId, code: "HTTP_ERROR" } });
    expect(status.next).toContainEqual(expect.objectContaining({ command: "croft logs items --failed" }));

    // The fix: a page size the API accepts. The edit holds the ingest until it is run by hand, which clears it.
    p.write("assets/items.ts", itemsAsset(api.url, 100));
    const heldNow = await ok(["status"], 10, 40);
    expect(heldNow.data.assets.find((a: Envelope) => a.asset === "items")).toMatchObject({ status: "failed", held: true, hold: { code: "SCHEDULE_HELD" } });
    shop.items.push({ id: 3, name: "c" });
    const fixed = await ok(["run", "items"], 10, 45);
    expect(fixed.data.steps[0]).toMatchObject({ asset: "items", status: "ok", rows: { added: 1, total: 3 } });
    const cleared = await ok(["status"], 10, 46);
    expect(cleared.data.assets.find((a: Envelope) => a.asset === "items")).toMatchObject({ status: "ok", held: false, edited: false });
    expect(cleared.problems.filter((x: Envelope) => x.severity === "error" || x.code === "SCHEDULE_HELD")).toEqual([]);

    // 11:00: the scheduler runs the fixed code, and a run that succeeds notifies nobody.
    shop.items.push({ id: 4, name: "d" });
    const eleven = await ok(["tick"], 11);
    expect(eleven.data.spawned).toHaveLength(1);
    const next = await p.json(["wait", eleven.data.spawned[0].runId, "--timeout", "60s"], at(11));
    expect(next.code, show(next)).toBe(0);
    expect(next.json.data.steps[0]).toMatchObject({ asset: "items", status: "ok", rows: { added: 1, total: 4 } });
    expect(notifications().filter((n) => n.kind === "desktop")).toHaveLength(1);
    expect(hooks).toHaveLength(1);
  }, 180_000);
});
