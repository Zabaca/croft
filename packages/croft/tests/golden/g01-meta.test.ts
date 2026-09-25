// Golden: the commands that need no data (DESIGN.md §4.3, §10): version, help, docs, init, doctor, secrets and new,
// each --json envelope validated against its schema, plus the error envelope of a failed command and of a command
// croft does not have. Every run gets a temporary HOME, so nothing reads or writes the real ~/.croft.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupAll, croftIn, initProject, type Project, schedulerEnv, tempDir } from "../e2e/harness.ts";
import { golden, goldenEnvelope } from "./kit.ts";

let p: Project;
let env: Record<string, string>;
beforeAll(async () => {
  env = schedulerEnv();
  p = (await initProject("golden-meta")).project;
}, 120_000);
afterAll(cleanupAll);

test("version, and --version anywhere", async () => {
  const outside = tempDir();
  const d = golden("version", await croftIn(outside, ["version", "--json"], { env })).data;
  expect(d.version).toBeString();
  golden("version", await croftIn(outside, ["--version", "--json"], { env }));
}, 120_000);

test("help: the command list, one command, and <command> --help", async () => {
  expect(golden("help", await p.croft(["help", "--json"], { env })).data.commands.length).toBeGreaterThan(10);
  expect(golden("help", await p.croft(["help", "run", "--json"], { env })).data.command.name).toBe("run");
  expect(golden("help", await p.croft(["status", "--help", "--json"], { env })).data.command.name).toBe("status");
  golden("help", await p.croft(["help", "no-such-command", "--json"], { env }), { failed: true, exit: 2 });
}, 120_000);

test("docs: the list, a code's page, a topic page, a built-in page, and an unknown page", async () => {
  const list = golden("docs", await p.croft(["docs", "--json"], { env })).data;
  expect(list.topics.length).toBeGreaterThan(5);
  expect(list.codes.length).toBeGreaterThan(50);
  expect(golden("docs", await p.croft(["docs", "CHECK_INVALID", "--json"], { env })).data).toMatchObject({ code: "CHECK_INVALID", source: "file" });
  expect(golden("docs", await p.croft(["docs", "ingest", "--json"], { env })).data).toMatchObject({ topic: "ingest", source: "file" });
  expect(golden("docs", await p.croft(["docs", "json", "--json"], { env })).data).toMatchObject({ topic: "json", source: "built-in" });
  golden("docs", await p.croft(["docs", "no-such-page", "--json"], { env }), { failed: true, exit: 2 });
}, 120_000);

test("init: a new project, an app's data/ folder, and --claude", async () => {
  const base = tempDir();
  const fresh = golden("init", await croftIn(base, ["init", join(base, "fresh"), "--no-install", "--json"], { env })).data;
  expect(fresh.mode).toBe("new");
  const app = join(base, "app");
  await Bun.write(join(app, "package.json"), JSON.stringify({ name: "app", private: true }));
  expect(golden("init", await croftIn(base, ["init", app, "--no-install", "--json"], { env })).data.mode).toBe("app");
  expect(golden("init", await p.croft(["init", "--claude", "--json"], { env })).data.mode).toBe("claude");
  golden("init", await croftIn(base, ["init", join(base, "fresh"), "--no-install", "--json"], { env }), { failed: true, exit: 2 });
}, 120_000);

test("doctor, in a project and outside one", async () => {
  expect(golden("doctor", await p.croft(["doctor", "--json"], { env })).data.checks.length).toBeGreaterThan(5);
  golden("doctor", await croftIn(tempDir(), ["doctor", "--json"], { env }));
}, 120_000);

test("secrets: the list, and set from stdin", async () => {
  p.write("assets/needs_key.ts", `import { ingest } from "@zabaca/croft";

export default ingest({
  secrets: ["GOLDEN_KEY"],
  async *rows({ secret }) {
    yield { id: 1, key_length: secret("GOLDEN_KEY").length };
  },
});
`);
  const list = golden("secrets", await p.croft(["secrets", "--json"], { env })).data;
  expect(list).toContainEqual(expect.objectContaining({ name: "GOLDEN_KEY" }));
  const set = golden("secrets", await p.croft(["secrets", "set", "GOLDEN_KEY", "--stdin", "--json"], { env, stdin: "golden-secret-value-1234\n" })).data;
  expect(set).toMatchObject({ name: "GOLDEN_KEY" });
  const after = golden("secrets", await p.croft(["secrets", "--json"], { env })).data;
  expect(after.find((s: { name: string }) => s.name === "GOLDEN_KEY")).toMatchObject({ status: "set" });
  p.remove("assets/needs_key.ts");
}, 120_000);

test("new: the kinds, and a template", async () => {
  const list = await p.croft(["new", "--list", "--json"], { env });
  const made = await p.croft(["new", "sql", "golden_report", "--json"], { env });
  // Until croft new is built (phase 5, NW), the stub fails with INTERNAL_ERROR: its envelope still matches.
  const stub = (r: typeof list) => r.stdout.includes("PHASE_STUB");
  if (stub(list)) golden("new", list, { failed: true, exit: 1 });
  else golden("new", list);
  if (stub(made)) golden("new", made, { failed: true, exit: 1 });
  else golden("new", made);
  golden("new", await p.croft(["new", "sql", "golden_report", "--json"], { env }), { failed: true, exit: stub(made) ? 1 : 2 });
}, 120_000);

test("a command croft does not have: the envelope schema alone", async () => {
  const r = await p.croft(["stauts", "--json"], { env });
  expect(r.code).toBe(2);
  expect(goldenEnvelope(r)).toMatchObject({ ok: false, command: "stauts", data: null });
}, 120_000);
