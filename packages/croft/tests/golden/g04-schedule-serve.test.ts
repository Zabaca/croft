// Golden: scheduling and serving (DESIGN.md §4.3, §8, §5), each --json envelope validated against its schema:
// `croft schedule status|on --no-os-job|pause|off` with scheduling shown in status, context, describe and validate
// while it is on, and `croft serve --json`'s one envelope when the server starts. Scheduling runs under a temporary
// HOME and CROFT_HOME with --no-os-job, and CROFT_FORBID_OS_JOBS stays set: no OS job is installed. The server listens
// on a free port and is stopped with SIGTERM.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { extensionsReady } from "../../src/db/extension-dir-testkit.ts";
import { cleanupAll, initProject, laTime, type Project, schedulerEnv, until } from "../e2e/harness.ts";
import { freePort } from "../../src/serve/quack-client-testkit.ts";
import { golden } from "./kit.ts";

let p: Project;
let env: Record<string, string>;
const ext = extensionsReady(["quack", "httpfs"]);
if (!ext.ready) console.warn(`[g04] SKIPPING the server-mode serve envelope: ${ext.skipReason}`);

const HOURLY = `import { ingest } from "@zabaca/croft";

export default ingest({
  description: "An hourly counter",
  schedule: "every hour",
  key: "id",
  async *rows() {
    yield [{ id: 1, n: 1 }, { id: 2, n: 2 }];
  },
});
`;

beforeAll(async () => {
  env = { ...schedulerEnv(), CROFT_NOW: laTime(9, 30) };
  p = (await initProject("golden-schedule")).project;
  p.write("assets/hourly.ts", HOURLY);
}, 120_000);
afterAll(cleanupAll);

test("schedule: status, on --no-os-job, pause --for, off; scheduling in status, context, describe, validate", async () => {
  const before = golden("schedule", await p.croft(["schedule", "status", "--json"], { env })).data;
  expect(before.scheduling.state).toBe("off");
  golden("schedule", await p.croft(["schedule", "--json"], { env }));
  const on = golden("schedule", await p.croft(["schedule", "on", "--no-os-job", "--json"], { env })).data;
  expect(on.scheduling).toMatchObject({ state: "on", via: "serve" });
  expect(golden("status", await p.croft(["status", "--json"], { env })).data.scheduling.state).toBe("on");
  golden("context", await p.croft(["context", "--json"], { env }));
  expect(golden("describe", await p.croft(["describe", "hourly", "--json"], { env })).data.schedule).not.toBeNull();
  golden("validate", await p.croft(["validate", "--json"], { env }));
  golden("schedule", await p.croft(["schedule", "status", "--json"], { env }));
  const paused = golden("schedule", await p.croft(["schedule", "pause", "--for", "2h", "--json"], { env })).data;
  expect(paused.scheduling.state).toBe("paused");
  golden("status", await p.croft(["status", "--json"], { env }));
  const off = golden("schedule", await p.croft(["schedule", "off", "--json"], { env })).data;
  expect(off.scheduling.state).toBe("off");
  golden("schedule", await p.croft(["schedule", "sometimes", "--json"], { env }), { failed: true, exit: 2 });
}, 120_000);

test("serve --json: one envelope when the server starts, nothing more when it stops", async () => {
  const serveEnv = { ...env };
  delete (serveEnv as Record<string, string | undefined>).CROFT_NOW;
  const serve = p.start(["serve", "--port", "0", "--json"], { env: serveEnv });
  const file = join(p.stateDir, "serve.json");
  await until(() => existsSync(file) || serve.proc.exitCode !== null, 30_000);
  serve.proc.kill("SIGTERM");
  const r = await serve.done;
  const started = golden("serve", r).data;
  expect(started).toMatchObject({ host: "127.0.0.1", loopback: true, stopped: null });
  expect(started.port).toBeGreaterThan(0);
  const twice = p.start(["serve", "--port", "0", "--json"], { env: serveEnv });
  await until(() => existsSync(file) || twice.proc.exitCode !== null, 30_000);
  const second = await p.croft(["serve", "--port", "0", "--json"], { env: serveEnv });
  twice.proc.kill("SIGTERM");
  await twice.done;
  golden("serve", second, { failed: true, exit: 2 });
}, 120_000);

test("serve key add, list, remove --json: the key once, then only names and times; each validated against serve's schema (D122)", async () => {
  const addedEnvelope = golden("serve", await p.croft(["serve", "key", "add", "alice", "--json"], { env }));
  const added = addedEnvelope.data;
  expect(added).toMatchObject({ action: "add", name: "alice", sharedTables: [], file: ".croft/serve-keys.json", serverMode: false });
  expect(added).not.toHaveProperty("quack"); // no Quack outside server mode
  // Server mode is off here, so the key is made and the envelope warns (D128): ok, exit 0, naming the setting.
  expect(addedEnvelope.problems).toMatchObject([{ severity: "warning", code: "SERVER_MODE_OFF_FOR_KEYS" }]);
  expect(added.key).toMatch(/^croftkey_[A-Za-z0-9_-]{43}$/);
  const listed = await p.croft(["serve", "key", "list", "--json"], { env });
  const list = golden("serve", listed).data;
  expect(list).toMatchObject({ action: "list", keys: [{ name: "alice", lastUsedAt: null }], sharedTables: [], serverMode: false });
  expect(listed.stdout).not.toContain(added.key);
  golden("serve", await p.croft(["serve", "key", "add", "alice", "--json"], { env }), { failed: true, exit: 2 });
  const removed = golden("serve", await p.croft(["serve", "key", "remove", "alice", "--json"], { env })).data;
  expect(removed).toMatchObject({ action: "remove", name: "alice", remaining: 0 });
  golden("serve", await p.croft(["serve", "key", "remove", "alice", "--json"], { env }), { failed: true, exit: 2 });
  golden("serve", await p.croft(["serve", "key", "list", "--json"], { env })); // empty, not an error
}, 120_000);

test("serve key add and list --json in server mode: data.serverMode and data.quack (the address, the ATTACH statement, the as-of view), each validated against serve's schema (D125, D128)", async () => {
  const q = (await initProject("golden-quack")).project;
  q.edit("croft.json", '"timezone"', '"serverMode": { "enabled": true }, "serve": { "sharedTables": ["orders"] }, "timezone"');
  const addedEnvelope = golden("serve", await q.croft(["serve", "key", "add", "alice", "--json"], { env }));
  const added = addedEnvelope.data;
  expect(addedEnvelope.problems).toEqual([]);
  expect(added).toMatchObject({ action: "add", name: "alice", serverMode: true, sharedTables: ["orders"] });
  expect(Object.keys(added.quack)).toEqual(["uri", "loopback", "asOfView", "attach"]);
  expect(added.quack).toEqual({
    uri: "quack:127.0.0.1:9494", loopback: true, asOfView: "_croft_as_of", attach: `ATTACH 'quack:127.0.0.1:9494' AS croft (TOKEN '${added.key}')`,
  });
  const listed = await q.croft(["serve", "key", "list", "--json"], { env });
  const list = golden("serve", listed).data;
  expect(list).toMatchObject({ action: "list", serverMode: true, quack: { uri: "quack:127.0.0.1:9494", loopback: true, asOfView: "_croft_as_of", attach: "ATTACH 'quack:127.0.0.1:9494' AS croft (TOKEN '<key>')" } });
  expect(listed.stdout).not.toContain(added.key);
  // A port of 0 is only known to a running croft serve: without one the address is null (and so is the statement).
  q.edit("croft.json", '"serverMode": { "enabled": true }', '"serverMode": { "enabled": true, "quackPort": 0 }');
  expect(golden("serve", await q.croft(["serve", "key", "add", "bob", "--json"], { env })).data.quack).toMatchObject({ uri: null, attach: null, loopback: true });
}, 120_000);

(ext.ready ? test : test.skip)("serve --json in server mode: the one envelope carries data.quack with the address it bound (D125)", async () => {
  const q = (await initProject("golden-quack-serve")).project;
  const port = freePort();
  q.edit("croft.json", '"timezone"', `"serverMode": { "enabled": true, "quackPort": ${port} }, "timezone"`);
  const serveEnv = { ...env, CROFT_EXTENSION_DIR: ext.dir };
  delete (serveEnv as Record<string, string | undefined>).CROFT_NOW;
  const serve = q.start(["serve", "--port", "0", "--json"], { env: serveEnv });
  const file = join(q.stateDir, "serve.json");
  await until(() => existsSync(file) || serve.proc.exitCode !== null, 30_000);
  serve.proc.kill("SIGTERM");
  const r = await serve.done;
  const started = golden("serve", r).data;
  expect(started.serverMode).toMatchObject({ readCopy: "warehouse.read.duckdb" });
  expect(started.keys).toMatchObject({ count: 0, needsServerMode: false });
  expect(Object.keys(started.quack)).toEqual(["uri", "loopback", "asOfView", "attach"]);
  expect(started.quack.uri).toBe(`quack:127.0.0.1:${port}`);
  expect(started.quack).toMatchObject({ loopback: true, asOfView: "_croft_as_of", attach: `ATTACH '${started.quack.uri}' AS croft (TOKEN '<key>')` });
}, 120_000);
