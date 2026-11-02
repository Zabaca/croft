// Journey 33: a key per person (DESIGN.md D122, D123; option 06, slice 3). With the project sharing `orders` (and not `payments`),
// `croft serve key add` makes keys in its own processes; a real croft serve answers a key with the shared table only, the
// app token with both; a key removed or added while the server runs is honoured on the very next request; a run's new rows
// reach a key; stopping the server writes each key's last use; and no key appears in anything croft prints or keeps. It runs on
// the file engine, and, when the extension files are there, in server mode too (the readers' process, a view per shared
// table). The real CLI throughout, a mock API for the data. Locally a missing extension file skips the server-mode run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { extensionsReady } from "../../src/db/extension-dir-testkit.ts";
import { cleanupAll, type Envelope, initProject, json, type MockApi, mockApi, type Project, schedulerEnv, show, until } from "./harness.ts";

let api: MockApi;
beforeAll(() => {
  api = mockApi();
});
afterAll(async () => {
  api.stop();
  await cleanupAll();
});

const ext = extensionsReady(["quack", "httpfs"]);
if (!ext.ready) console.warn(`[j33-keys] SKIPPING the server-mode run: ${ext.skipReason}`);

const asset = (base: string, path: string) => `import { ingest } from "@zabaca/croft";

export default ingest({
  key: "id",
  async *rows({ http }) {
    yield (await http.get("${base}${path}")).json<Record<string, unknown>[]>();
  },
});
`;

interface ServeRecord { url: string; token: string; pid: number }

async function ask(rec: ServeRecord, bearer: string, sql: string): Promise<{ status: number; body: Envelope }> {
  const res = await fetch(`${rec.url}/query`, {
    method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: JSON.stringify({ sql }),
  });
  return { status: res.status, body: (await res.json()) as Envelope };
}

/** Every file under a folder, as text, for "no key anywhere". */
function everything(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(full);
      } else if (statSync(full).size < 5_000_000) out.push(readFileSync(full, "latin1"));
    }
  };
  walk(dir);
  return out.join("\n");
}

async function journey(serverMode: boolean): Promise<void> {
  const state = { orders: [{ id: 1, amount: 10 }, { id: 2, amount: 20 }] };
  api.route("/orders", () => json(state.orders));
  api.route("/payments", () => json([{ id: 1, card: "4111-secret" }]));
  const { project: p } = await initProject();
  p.remove("assets/example_sales.ts");
  p.write("assets/orders.ts", asset(api.url, "/orders"));
  p.write("assets/payments.ts", asset(api.url, "/payments"));
  const env = { ...schedulerEnv(), CROFT_EXTENSION_DIR: ext.dir };
  const home = { env };
  p.edit("croft.json", '"timezone"', `${serverMode ? '"serverMode": { "enabled": true, "quackPort": 0 }, ' : ""}"serve": { "sharedTables": ["orders"] }, "timezone"`);
  const built = await p.json(["run"], home);
  expect(built.code, show(built)).toBe(0);

  // The keys are made by the command, in processes of their own, before the server runs.
  const keyOf = async (name: string) => {
    const r = await p.json(["serve", "key", "add", name], home);
    expect(r.code, show(r)).toBe(0);
    expect(r.json.data).toMatchObject({ action: "add", name, sharedTables: ["orders"], file: ".croft/serve-keys.json" });
    return r.json.data.key as string;
  };
  const alice = await keyOf("alice");
  const bob = await keyOf("bob");
  expect(alice).toMatch(/^croftkey_[A-Za-z0-9_-]{43}$/);
  const listed = await p.json(["serve", "key", "list"], home);
  expect(listed.json.data.keys.map((k: { name: string }) => k.name)).toEqual(["alice", "bob"]);
  expect(JSON.stringify(listed.json)).not.toContain(alice);
  // Only the hash is kept, in a private file.
  expect(statSync(join(p.stateDir, "serve-keys.json")).mode & 0o777).toBe(0o600);

  const serve = p.start(["serve", "--port", "0"], home);
  const file = join(p.stateDir, "serve.json");
  try {
    await until(() => existsSync(file) || serve.proc.exitCode !== null, 30_000);
    if (!existsSync(file)) throw new Error(`croft serve did not start\n${show(await serve.done)}`);
    const rec = JSON.parse(readFileSync(file, "utf8")) as ServeRecord;

    // A key reads the shared table; the app token reads both.
    const own = await ask(rec, alice, "select id, amount from orders order by id");
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.data.rows).toEqual([{ id: 1, amount: 10 }, { id: 2, amount: 20 }]);
    if (serverMode) expect(own.body.data.asOf).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect((await ask(rec, rec.token, "select card from payments")).body.data.rows).toEqual([{ card: "4111-secret" }]);

    // Any other table is refused in the words for one that is not there.
    const hidden = await ask(rec, alice, "select card from payments");
    const absent = await ask(rec, alice, "select card from nothing_here");
    expect(hidden.status).toBe(400);
    expect(hidden.body.problems[0]).toMatchObject({ code: "QUERY_PATH_DENIED" });
    expect(hidden.body.problems[0].message.replace("payments", "<t>")).toBe(absent.body.problems[0].message.replace("nothing_here", "<t>"));
    expect(JSON.stringify(hidden.body)).not.toContain("4111");
    for (const sql of ["show tables from _croft", "select * from _croft.assets", "select * from read_text('.croft/serve-keys.json')", "delete from orders"]) {
      expect((await ask(rec, alice, sql)).status, sql).toBe(400);
    }
    expect((await ask(rec, alice, "show tables")).body.data.rows).toEqual([{ name: "orders" }]);
    // A key is for /query only.
    expect((await fetch(`${rec.url}/status`, { headers: { Authorization: `Bearer ${alice}` } })).status).toBe(403);

    // Removing a key, in another process, refuses it on the very next request; the others carry on; a new key works at once.
    expect((await ask(rec, bob, "select 1 as one")).status).toBe(200);
    const removed = await p.json(["serve", "key", "remove", "alice"], home);
    expect(removed.code, show(removed)).toBe(0);
    const gone = await ask(rec, alice, "select 1 as one");
    expect(gone.status).toBe(401);
    expect(gone.body.problems[0].code).toBe("SERVE_UNAUTHORIZED");
    expect((await ask(rec, bob, "select 1 as one")).status).toBe(200);
    const carol = await keyOf("carol");
    expect((await ask(rec, carol, "select count(*) as n from orders")).body.data.rows).toEqual([{ n: 2 }]);

    // A run that changes the data reaches a key: the file engine steps aside and comes back, server mode swaps the copy in.
    state.orders.push({ id: 3, amount: 30 });
    const again = await p.json(["run", "orders"], home);
    expect(again.code, show(again)).toBe(0);
    await until(async () => {
      const r = await ask(rec, bob, "select count(*) as n from orders");
      return r.status === 200 && (r.body.data.rows as { n: number }[])[0]!.n === 3;
    }, 30_000);

    // Stopping is clean; the log has one line per key query, with names and no SQL or key; the last use is written.
    serve.proc.kill("SIGINT");
    const stopped = await serve.done;
    expect(stopped.code, show(stopped)).toBe(0);
    const lines = stopped.stderr.split("\n").filter((l) => l.startsWith("croft serve: key "));
    expect(lines.length).toBeGreaterThan(10);
    expect(lines.some((l) => /^croft serve: key alice {2}\S+ {2}read orders {2}2 rows {2}\d+ ms$/.test(l))).toBe(true);
    expect(lines.some((l) => /key alice .* refused QUERY_PATH_DENIED/.test(l))).toBe(true);
    expect(lines.some((l) => l.startsWith("croft serve: key bob "))).toBe(true);
    for (const secret of [alice, bob, carol, "4111", "payments", "select"]) expect(stopped.stdout + stopped.stderr).not.toContain(secret);
    const after = await p.json(["serve", "key", "list"], home);
    const used = Object.fromEntries(after.json.data.keys.map((k: { name: string; lastUsedAt: string | null }) => [k.name, k.lastUsedAt]));
    expect(Object.keys(used)).toEqual(["bob", "carol"]);
    expect(used.bob).toMatch(/^\d{4}-/);
    expect(used.carol).toMatch(/^\d{4}-/);
    expect(existsSync(file)).toBe(false);
  } finally {
    if (serve.proc.exitCode === null) {
      serve.proc.kill("SIGKILL");
      await serve.done;
    }
  }

  // No key is in any file of the project, its state or its backups.
  const backup = await p.json(["backup", join(p.root, "..", `backup-${serverMode ? "sm" : "file"}`)], home);
  expect(backup.code, show(backup)).toBe(0);
  const bytes = everything(p.root) + everything(join(p.root, "..", `backup-${serverMode ? "sm" : "file"}`));
  for (const k of [alice, bob]) expect(bytes.includes(k), "a key is in a file").toBe(false);
}

describe("journey 33: keys", () => {
  test("on the file engine", () => journey(false), 180_000);
  (ext.ready ? test : test.skip)("in server mode", () => journey(true), 180_000);
});
