// Golden: scheduling and serving (DESIGN.md §4.3, §8, §5), each --json envelope validated against its schema:
// `croft schedule status|on --no-os-job|pause|off` with scheduling shown in status, context, describe and validate
// while it is on, and `croft serve --json`'s one envelope when the server starts. Scheduling runs under a temporary
// HOME and CROFT_HOME with --no-os-job, and CROFT_FORBID_OS_JOBS stays set: no OS job is installed. The server listens
// on a free port and is stopped with SIGTERM.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cleanupAll, initProject, laTime, type Project, schedulerEnv, until } from "../e2e/harness.ts";
import { golden } from "./kit.ts";

let p: Project;
let env: Record<string, string>;

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
