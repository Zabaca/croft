// Journey 14: an asset that prints. Its console output (at top level and inside rows()) goes to the step log,
// redacted, which `croft logs` shows (§4.1); never to stdout, so every --json command still prints exactly one
// envelope (§4 "Conventions"), and a printed .env value never leaves croft unredacted (§9.6, D54).
import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAll, initProject, show } from "./harness.ts";

afterAll(cleanupAll);

const KEY = "sk_live_Abc123456789";

const NOISY = `import { ingest } from "@zabaca/croft";

console.log("top-level hello ${KEY}");
process.stdout.write("top-level stdout write\\n");

export default ingest({
  key: "id",
  secrets: ["API_KEY"],
  async *rows({ secret }) {
    console.log("in rows: key is", secret("API_KEY"));
    console.info("in rows: info");
    console.warn("in rows: warn");
    console.error("in rows: error");
    console.debug("in rows: debug");
    process.stdout.write("in rows: direct stdout\\n");
    process.stderr.write("in rows: direct stderr\\n");
    await new Promise((r) => setTimeout(r, 10));
    console.log("in rows: after await");
    yield [{ id: 1 }, { id: 2 }];
  },
});
`;

const IN_LOG = [
  "top-level hello [redacted:API_KEY]", "top-level stdout write", "in rows: key is [redacted:API_KEY]", "in rows: info",
  "in rows: warn", "in rows: error", "in rows: debug", "in rows: direct stdout", "in rows: direct stderr", "in rows: after await",
];

async function noisyProject() {
  const { project: p } = await initProject();
  p.secret("API_KEY", KEY);
  p.write("assets/noisy.ts", NOISY);
  return p;
}

test("journey 14: run --foreground --json prints one envelope; the prints are in the step log, redacted", async () => {
  const p = await noisyProject();
  const r = await p.croft(["run", "noisy", "--foreground", "--json"]);
  expect(r.code, show(r)).toBe(0);
  expect(r.json, show(r)).toMatchObject({ ok: true, command: "run", data: { status: "succeeded", steps: [{ asset: "noisy", status: "ok" }] } });
  expect(r.stdout).not.toContain("in rows");
  expect(r.stdout).not.toContain("top-level");
  expect(r.stdout + r.stderr).not.toContain(KEY);

  const logs = await p.json(["logs", "noisy"]);
  expect(logs.code, show(logs)).toBe(0);
  const lines: string[] = logs.json.data.steps[0].lines;
  for (const want of IN_LOG) expect(lines, lines.join("\n")).toContain(want);
  expect(lines.join("\n")).not.toContain(KEY);

  // Commands that import the asset (for its declared secrets and kind) still print one envelope; the top-level
  // print goes to stderr, redacted and labelled with its file.
  const q = await p.croft(["query", "select count(*)::INT n from noisy", "--json"]);
  expect(q.code, show(q)).toBe(0);
  expect(q.json, show(q)).toMatchObject({ ok: true, command: "query", data: { rows: [{ n: 2 }] } });
  expect(q.stderr).toContain("assets/noisy.ts: top-level hello [redacted:API_KEY]");
  expect(q.stdout + q.stderr).not.toContain(KEY);
  for (const args of [["describe", "noisy"], ["context"], ["secrets"], ["status"]]) {
    const c = await p.croft([...args, "--json"]);
    expect(c.json, show(c)).toBeDefined();
    expect(c.stdout + c.stderr).not.toContain(KEY);
  }
}, 120_000);

test("journey 14b: a detached run keeps the prints out of the parent's stdout and its process log", async () => {
  const p = await noisyProject();
  const r = await p.croft(["run", "noisy", "--json"]);
  expect(r.code, show(r)).toBe(0);
  expect(r.json, show(r)).toMatchObject({ ok: true, data: { status: "succeeded" } });
  expect(r.stdout + r.stderr).not.toContain(KEY);
  const runId = r.json!.data.runId as string;
  const processLog = readFileSync(join(p.stateDir, "logs", runId, "_process.log"), "utf8");
  expect(processLog).not.toContain(KEY);
  expect(processLog).not.toContain("in rows");
  const logs = await p.json(["logs", runId]);
  const lines: string[] = logs.json.data.steps.flatMap((s: { lines: string[] }) => s.lines);
  for (const want of IN_LOG) expect(lines, lines.join("\n")).toContain(want);
  expect(readFileSync(join(p.stateDir, "logs", runId, "noisy.log"), "utf8")).not.toContain(KEY);
}, 120_000);
