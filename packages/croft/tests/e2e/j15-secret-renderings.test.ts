// Journey 15: a secret is never printed raw, yet it still leaks in other renderings. A multi-line private key
// printed inside an object (ctx.log and console.log escape "\n" and split it into '…' + lines) or serialized with
// JSON.stringify; an API that echoes a key back in an error body with PHP-style "\/" escaping, or a Basic auth
// header in base64; a subprocess (Bun Shell `$` prints by default) or Bun.write(Bun.stdout) that bypasses
// console. §9.6 / D54: every .env value is redacted wherever croft writes or prints text: step logs,
// _process.log, the envelope, runs.sqlite and events.ndjson. §4: --json prints exactly one envelope.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanupAll, findProblem, initProject, type MockApi, mockApi, type Project, show } from "./harness.ts";

const PEM_BODY = ["MIIEowIBAAKCAQEAsecretline1abcdefghij", "ZZsecretline2abcdef0123456789klmnopqr"];
const PEM = `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY.join("\n")}\n-----END RSA PRIVATE KEY-----\n`;
const AWS = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const API_KEY = "sk_live_Zyx987654321";
/** Pieces no output may contain: each key line, the AWS key's parts, the API key and base64 of the AWS key. */
const FRAGMENTS = [...PEM_BODY, "secretline", "K7MDENG", "bPxRfiCYEXAMPLEKEY", API_KEY, "Zyx987654321",
  Buffer.from(`user:${AWS}`).toString("base64").slice(8, 40)];

let api: MockApi;
beforeAll(() => {
  api = mockApi();
  // Answers 403 echoing the key header and the Authorization header, JSON-encoded the way PHP does ("/" as "\/").
  api.route("/x", (req) => new Response(
    JSON.stringify({ error: `invalid key ${req.headers.get("x-key")}`, auth: req.headers.get("authorization") }).replaceAll("/", "\\/"),
    { status: 403, headers: { "content-type": "application/json" } },
  ));
});
afterAll(async () => {
  api.stop();
  await cleanupAll();
});

/** Every file croft wrote under .croft (logs, events.ndjson, runs.sqlite and its WAL), as text. */
function stateFiles(p: Project): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(path, readFileSync(path).toString("latin1"));
    }
  };
  walk(p.stateDir);
  return out;
}

function expectNoFragments(text: string, where: string): void {
  // Also with escaped slashes undone, so "K7MDENG\/bPx…" counts as the key it is.
  const plain = text.replace(/\\+\//g, "/");
  for (const f of FRAGMENTS) expect(plain.includes(f), `${where} contains ${f}:\n${text.slice(0, 3000)}`).toBe(false);
}

function expectCleanState(p: Project): void {
  const files = stateFiles(p);
  expect(files.size).toBeGreaterThan(0);
  for (const [path, text] of files) expectNoFragments(text, path);
}

async function secretProject(): Promise<Project> {
  const { project: p } = await initProject();
  // A quoted multi-line value, as a GitHub App or GCP key is stored.
  p.write(".env", `GH_APP_KEY="${PEM.replaceAll("\n", "\\n")}"\nAWS_SECRET=${AWS}\nAPI_KEY=${API_KEY}\n`);
  return p;
}

test("journey 15a: a multi-line key printed inside an object or as JSON is redacted in the step log", async () => {
  const p = await secretProject();
  p.write("assets/app_key.ts", `import { ingest } from "@zabaca/croft";
export default ingest({
  key: "id",
  secrets: ["GH_APP_KEY"],
  rows({ secret, log }) {
    const creds = { appId: 123, privateKey: secret("GH_APP_KEY") };
    log("auth config", creds);
    console.log(creds);
    console.log(JSON.stringify(creds));
    log(secret("GH_APP_KEY").split("\\n")[1]);
    return [{ id: 1 }];
  },
});
`);
  const r = await p.croft(["run", "app_key", "--foreground", "--json"]);
  expect(r.code, show(r)).toBe(0);
  expect(r.json, show(r)).toMatchObject({ ok: true, data: { steps: [{ asset: "app_key", status: "ok" }] } });
  expectNoFragments(r.stdout + r.stderr, "run output");

  const logs = await p.json(["logs", "app_key"]);
  expect(logs.code, show(logs)).toBe(0);
  const lines = (logs.json.data.steps[0].lines as string[]).join("\n");
  expectNoFragments(logs.stdout, "croft logs");
  expect(lines).toContain("auth config");
  expect(lines).toContain("appId: 123");
  expect(lines).toContain('{"appId":123,"privateKey":"[redacted:GH_APP_KEY]"}');
  expect(lines).toContain("[redacted:GH_APP_KEY]");
  expectCleanState(p);
}, 120_000);

test("journey 15b: an API error echoing the key with \\/ escaping, or in a Basic auth header, is redacted everywhere", async () => {
  const p = await secretProject();
  p.write("assets/aws.ts", `import { ingest } from "@zabaca/croft";
export default ingest({
  key: "id",
  secrets: ["AWS_SECRET"],
  async *rows({ http, secret }) {
    const key = secret("AWS_SECRET");
    const res = await http.get("${api.url}/x", { headers: { "x-key": key, authorization: "Basic " + btoa("user:" + key) } });
    yield res.json();
  },
});
`);
  const r = await p.croft(["run", "aws", "--foreground", "--json"]);
  expect(r.code, show(r)).toBe(1);
  expect(r.json, show(r)).toBeDefined();
  const err = findProblem(r.json!, "HTTP_ERROR");
  expect(err, show(r)).toBeDefined();
  expect(err!.message).toContain("[redacted:AWS_SECRET]");
  expectNoFragments(r.stdout + r.stderr, "run output");

  // The same run read back: `croft wait`-style from runs.sqlite, and every file under .croft.
  const logs = await p.json(["logs", "aws", "--failed"]);
  expectNoFragments(logs.stdout + logs.stderr, "croft logs");
  const runs = await p.json(["logs", "--runs"]);
  expectNoFragments(runs.stdout + runs.stderr, "croft logs --runs");
  expectCleanState(p);
}, 120_000);

const SHELL_ASSET = `import { ingest } from "@zabaca/croft";
import { $ } from "bun";
export default ingest({
  key: "id",
  secrets: ["API_KEY"],
  async rows({ secret }) {
    const key = secret("API_KEY");
    await $\`echo fetching with \${key}\`;
    await $\`sh -c \${"echo shell stderr " + key + " >&2"}\`;
    await Bun.spawn(["echo", "spawned", key], { stdio: ["ignore", "inherit", "inherit"] }).exited;
    await Bun.write(Bun.stdout, "bun write " + key + "\\n");
    // Started and not awaited: they print after the step has ended.
    Bun.spawn(["sh", "-c", "sleep 0.3; echo late " + key], { stdio: ["ignore", "inherit", "inherit"] });
    setTimeout(() => void Bun.write(Bun.stdout, "timer " + key + "\\n"), 50);
    return [{ id: 1 }];
  },
});
`;

test("journey 15c: subprocess and Bun.write output never reach stdout in --foreground --json, and are redacted", async () => {
  const p = await secretProject();
  p.write("assets/dl.ts", SHELL_ASSET);
  const r = await p.croft(["run", "dl", "--foreground", "--json"]);
  expect(r.code, show(r)).toBe(0);
  expect(r.json, `stdout is not one envelope\n${show(r)}`).toMatchObject({ ok: true, data: { steps: [{ asset: "dl", status: "ok" }] } });
  expect(r.stdout.trim().split("\n")).toHaveLength(1);
  expectNoFragments(r.stdout + r.stderr, "run output");
  // Printed after its step, outside any: on stderr, redacted.
  expect(r.stderr, show(r)).toContain("timer [redacted:API_KEY]");

  const logs = await p.json(["logs", "dl"]);
  const lines: string[] = logs.json.data.steps[0].lines;
  for (const want of ["fetching with [redacted:API_KEY]", "shell stderr [redacted:API_KEY]", "spawned [redacted:API_KEY]", "bun write [redacted:API_KEY]"]) {
    expect(lines, lines.join("\n")).toContain(want);
  }
  await Bun.sleep(500);   // the subprocess that outlived its step has printed by now
  expectCleanState(p);
}, 120_000);

test("journey 15d: a detached run's _process.log never gets subprocess output unredacted", async () => {
  const p = await secretProject();
  p.write("assets/dl.ts", SHELL_ASSET);
  const r = await p.croft(["run", "dl", "--json"]);
  expect(r.code, show(r)).toBe(0);
  expect(r.json, show(r)).toMatchObject({ ok: true, data: { status: "succeeded" } });
  expectNoFragments(r.stdout + r.stderr, "run output");
  const runId = r.json!.data.runId as string;
  const processLog = join(p.stateDir, "logs", runId, "_process.log");
  expect(statSync(processLog).mode & 0o777).toBe(0o600);
  await Bun.sleep(500);
  expectNoFragments(readFileSync(processLog, "utf8"), "_process.log");
  const logs = await p.json(["logs", runId]);
  const lines: string[] = logs.json.data.steps.flatMap((s: { lines: string[] }) => s.lines);
  expect(lines, lines.join("\n")).toContain("fetching with [redacted:API_KEY]");
  expectCleanState(p);
}, 120_000);
