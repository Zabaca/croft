// Journey 6: a declared secret that is not in .env. The run stops with SECRET_MISSING (a project problem,
// exit 2) whose fix tells the human to add it to .env, before any request is made; `croft secrets` lists it
// as missing; `croft secrets set NAME --stdin` writes .env (mode 0600) and the next run works.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { stripeAsset } from "./fixtures.ts";
import { cleanupAll, findProblem, initProject, json, type MockApi, mockApi, show } from "./harness.ts";

let api: MockApi;
beforeAll(() => {
  api = mockApi();
});
afterAll(async () => {
  api.stop();
  await cleanupAll();
});

test("journey 6: a missing secret is SECRET_MISSING with a fix that mentions .env; secrets set fixes it", async () => {
  const KEY = "sk_test_setThroughStdin42";
  api.route("/v1/charges", (req) => {
    if (req.headers.get("authorization") !== `Bearer ${KEY}`) return json({ error: { message: "Invalid API Key" } }, { status: 401 });
    return json({ object: "list", data: [{ id: "ch_1", created: 1758600000, amount: 500, currency: "usd" }], has_more: false });
  });
  const { project: p } = await initProject();
  p.write("assets/stripe_charges.ts", stripeAsset(api.url));

  const r = await p.json(["run", "stripe_charges"]);
  expect(r.code, show(r)).toBe(2);
  expect(r.json.ok).toBe(false);
  const m = findProblem(r.json, "SECRET_MISSING");
  expect(m, show(r)).toBeDefined();
  expect(m!.asset).toBe("stripe_charges");
  expect(m!.message).toContain("STRIPE_KEY");
  expect(`${m!.hint} ${m!.fix?.description ?? ""}`).toContain(".env");
  expect(m!.fix?.requiresHuman).toBe(true);
  // Not retried, and no request went out without the key.
  expect(r.json.data.steps[0].attempt).toBe(1);
  expect(api.requests("/v1/charges")).toHaveLength(0);

  const list = await p.json(["secrets"]);
  expect(list.code, show(list)).toBe(0);
  expect(JSON.stringify(list.json.data)).toContain("STRIPE_KEY");
  expect(JSON.stringify(list.json.data)).toContain("missing");
  expect(JSON.stringify(list.json.data)).toContain("stripe_charges");

  // The user sets it from their terminal (here through --stdin); the value is never echoed back.
  const set = await p.croft(["secrets", "set", "STRIPE_KEY", "--stdin", "--json"], { stdin: `${KEY}\n` });
  expect(set.code, show(set)).toBe(0);
  expect(set.stdout).not.toContain(KEY);
  expect(p.read(".env")).toContain(`STRIPE_KEY=${KEY}`);
  expect(statSync(join(p.root, ".env")).mode & 0o777).toBe(0o600);
  const listed = await p.json(["secrets"]);
  expect(JSON.stringify(listed.json.data)).not.toContain(KEY);
  expect(JSON.stringify(listed.json.data)).toContain("set");

  const ok = await p.json(["run", "stripe_charges"]);
  expect(ok.code, show(ok)).toBe(0);
  expect(ok.json.data.steps[0].rows).toMatchObject({ added: 1, total: 1 });
}, 120_000);

test("journey 6b: a secret the asset did not declare is refused (SECRET_MISSING), even when it is in .env", async () => {
  api.route("/undeclared", () => json([{ id: 1 }]));
  const { project: p } = await initProject();
  p.secret("OTHER_TOKEN", "other-token-value-1234");
  p.write("assets/sneaky.ts", `import { ingest } from "@zabaca/croft";
export default ingest({
  key: "id",
  async *rows({ http, secret }) {
    const t = secret("OTHER_TOKEN");
    yield (await http.get("${api.url}/undeclared", { headers: { authorization: t } })).json<Record<string, unknown>[]>();
  },
});
`);
  const r = await p.json(["run", "sneaky"]);
  expect(r.code, show(r)).toBe(2);
  const m = findProblem(r.json, "SECRET_MISSING");
  expect(m, show(r)).toBeDefined();
  expect(m!.message).toContain("not declared");
  expect(api.requests("/undeclared")).toHaveLength(0);
}, 60_000);
