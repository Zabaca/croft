// Journey 34: a person's own DuckDB over Quack (DESIGN.md D125 to D127; option 06, slice 4). With "serverMode" on and the project
// sharing `orders` (not `payments`), a real croft serve listens for DuckDB 2.0 clients; `croft serve key add` says how to attach
// (the same in --json); a DuckDB 2.0 client in a process of its own attaches with the key, reads the shared table and the copy's
// as-of time, sees a run's new rows after the refresh and swap, is refused the hidden table and every write, and is refused on its
// very next query once its key is removed from another process; stopping the server is clean, its log has one line per Quack query
// and no SQL or key, and `key list` shows the use. The real CLI throughout, a mock API for the data. It runs on a lake too (the lake jobs of
// ci.yml): no copy, the lake's newest snapshot in the as-of view. Locally a missing extension file skips it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extensionsReady } from "../../src/db/extension-dir-testkit.ts";
import { QuackClients } from "../../src/serve/quack-client-testkit.ts";
import { cleanupAll, initProject, json, type MockApi, mockApi, schedulerEnv, show, until } from "./harness.ts";

let api: MockApi;
const clients = new QuackClients();
beforeAll(() => {
  api = mockApi();
});
afterAll(async () => {
  await clients.close();
  api.stop();
  await cleanupAll();
});

const ext = extensionsReady(["quack", "httpfs"]);
if (!ext.ready) console.warn(`[j34-quack] SKIPPING: ${ext.skipReason}`);

const asset = (base: string, path: string) => `import { ingest } from "@zabaca/croft";

export default ingest({
  key: "id",
  async *rows({ http }) {
    yield (await http.get("${base}${path}")).json<Record<string, unknown>[]>();
  },
});
`;

interface ServeRecord { url: string; token: string; pid: number; quack?: { uri: string } }

describe("journey 34: a person's DuckDB over Quack", () => {
  (ext.ready ? test : test.skip)("attach with a key, read, see a refresh, lose the key", async () => {
    const state = { orders: [{ id: 1, amount: 10 }, { id: 2, amount: 20 }] };
    api.route("/orders", () => json(state.orders));
    api.route("/payments", () => json([{ id: 1, card: "4111-secret" }]));
    const { project: p } = await initProject();
    p.remove("assets/example_sales.ts");
    p.write("assets/orders.ts", asset(api.url, "/orders"));
    p.write("assets/payments.ts", asset(api.url, "/payments"));
    const home = { env: { ...schedulerEnv(), CROFT_EXTENSION_DIR: ext.dir } };
    p.edit("croft.json", '"timezone"', '"serverMode": { "enabled": true, "quackPort": 0 }, "serve": { "sharedTables": ["orders"] }, "timezone"');
    const built = await p.json(["run"], home);
    expect(built.code, show(built)).toBe(0);

    const serve = p.start(["serve", "--port", "0"], home);
    const file = join(p.stateDir, "serve.json");
    try {
      await until(() => existsSync(file) || serve.proc.exitCode !== null, 30_000);
      if (!existsSync(file)) throw new Error(`croft serve did not start\n${show(await serve.done)}`);
      const rec = JSON.parse(readFileSync(file, "utf8")) as ServeRecord;
      expect(rec.quack?.uri).toMatch(/^quack:127\.0\.0\.1:\d+$/);

      // The key command says how to attach, in the data too, and the address is the one croft serve bound.
      const added = await p.json(["serve", "key", "add", "alice"], home);
      expect(added.code, show(added)).toBe(0);
      const alice = added.json.data.key as string;
      expect(added.json.data.quack).toEqual({ uri: rec.quack!.uri, loopback: true, asOfView: "_croft_as_of", attach: `ATTACH '${rec.quack!.uri}' AS croft (TOKEN '${alice}')` });
      const bob = (await p.json(["serve", "key", "add", "bob"], home)).json.data.key as string;
      const asOfOverHttp = async () => {
        const r = await fetch(`${rec.url}/query`, { method: "POST", headers: { Authorization: `Bearer ${rec.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ sql: "select 1 as one" }) });
        return ((await r.json()) as { data: { asOf: string } }).data.asOf;
      };
      const c = await clients.start(ext.dir);
      // croft serve hands the readers the keys file on its poll, so a new key is refused until then: attach once it is accepted.
      const attach = added.json.data.quack.attach as string;
      let at = await c.run(attach);
      for (const end = Date.now() + 30_000; !at.ok && Date.now() < end; ) {
        await Bun.sleep(100);
        at = await c.run(attach);
      }
      expect(at.ok, JSON.stringify(at)).toBe(true);
      expect(await c.rows("SELECT id, amount FROM croft.orders ORDER BY id")).toEqual([{ id: "1", amount: "10" }, { id: "2", amount: "20" }]);
      expect(Number((await c.rows("SELECT epoch_ms(as_of) AS t FROM croft._croft_as_of"))[0]!.t)).toBe(Date.parse(await asOfOverHttp()));
      expect(await c.rows("SELECT view_name FROM duckdb_views() WHERE database_name = 'croft' ORDER BY 1")).toEqual([{ view_name: "_croft_as_of" }, { view_name: "orders" }]);

      // The hidden table, croft's own tables and every write are refused, and nothing leaks.
      for (const sql of ["SELECT card FROM croft.payments", "SELECT * FROM croft._croft.assets", "INSERT INTO croft.orders VALUES (9, 9)", "DELETE FROM croft.orders", "DROP VIEW croft.orders"]) {
        const a = await c.run(sql);
        expect(a.ok, sql).toBe(false);
        expect(JSON.stringify(a), sql).not.toContain("4111-secret");
      }
      expect(await c.rows("SELECT count(*) AS n FROM croft.orders")).toEqual([{ n: "2" }]);

      // A run that changes the data: the refresh and the swap reach the open session, and the as-of time moves.
      const before = await asOfOverHttp();
      state.orders.push({ id: 3, amount: 30 });
      const again = await p.json(["run", "orders"], home);
      expect(again.code, show(again)).toBe(0);
      await until(async () => (await asOfOverHttp()) !== before, 30_000);
      expect(await c.rows("SELECT count(*) AS n FROM croft.orders")).toEqual([{ n: "3" }]);
      // Over a lake the view follows the lake's newest snapshot within a quarter of a second, so it is waited for.
      await until(async () => Number((await c.rows("SELECT epoch_ms(as_of) AS t FROM croft._croft_as_of"))[0]!.t) === Date.parse(await asOfOverHttp()), 10_000);

      // Another person, and then alice's key is removed from another process: her open session is refused on its next query.
      const other = await clients.start(ext.dir);
      expect((await other.attach(rec.quack!.uri, bob, "croft")).ok).toBe(true);
      // The app token is not a key: Quack is for people.
      const refused = await other.attach(rec.quack!.uri, rec.token, "app");
      expect(refused.ok).toBe(false);
      expect(refused.ok ? "" : refused.error).toContain("Authentication failed");
      const removed = await p.json(["serve", "key", "remove", "alice"], home);
      expect(removed.code, show(removed)).toBe(0);
      await until(async () => !(await c.run("SELECT count(*) AS n FROM croft.orders")).ok, 5000);
      expect(await c.error("SELECT count(*) AS n FROM croft.orders")).toContain("alice was removed");
      expect(await other.rows("SELECT count(*) AS n FROM croft.orders")).toEqual([{ n: "3" }]);
      const retry = await clients.start(ext.dir).then((x) => x.attach(rec.quack!.uri, alice));
      expect(retry.ok ? "" : retry.error).toContain("Authentication failed");

      // Stopping is clean. The log has a line for each Quack query, with names and no SQL or key.
      serve.proc.kill("SIGINT");
      const stopped = await serve.done;
      expect(stopped.code, show(stopped)).toBe(0);
      const lines = stopped.stderr.split("\n").filter((l) => l.startsWith("croft serve: key "));
      expect(lines.some((l) => /^croft serve: key alice {2}\S+ {2}read orders {2}over Quack$/.test(l))).toBe(true);
      expect(lines.some((l) => /^croft serve: key alice {2}\S+ {2}refused QUERY_NOT_SELECT {2}over Quack$/.test(l))).toBe(true);
      expect(lines.some((l) => /^croft serve: key bob {2}\S+ {2}read orders {2}over Quack$/.test(l))).toBe(true);
      for (const secret of [alice, bob, "4111-secret", "payments", "INSERT"]) expect(stopped.stdout + stopped.stderr).not.toContain(secret);
      const listed = await p.json(["serve", "key", "list"], home);
      expect(listed.json.data.keys.map((k: { name: string; lastUsedAt: string | null }) => k.name)).toEqual(["bob"]);
      expect(listed.json.data.keys[0].lastUsedAt).toMatch(/^\d{4}-/);
      expect(existsSync(file)).toBe(false);
    } finally {
      if (serve.proc.exitCode === null) {
        serve.proc.kill("SIGKILL");
        await serve.done;
      }
    }
  }, 240_000);
});
