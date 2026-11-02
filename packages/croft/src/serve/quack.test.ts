// A person's DuckDB over Quack (DESIGN.md D125 to D127; option 06, slice 4), against the real thing: croft serve's readers' engine
// with its Quack listener, and a DuckDB 2.0 client in a process of its own (serve/quack-client-testkit.ts). Everything that starts is
// a child of the test, killed in teardown. The attack list (sql/attack-testkit.ts) is sent over Quack in quack-attacks.test.ts.
import { afterAll, beforeAll, describe, expect } from "bun:test";
import { closeAllWarehouses } from "../db/warehouse.ts";
import { cleanup, spawnWriter } from "../read/testkit.ts";
import { SHARED, WAREHOUSE_SQL } from "../sql/attack-testkit.ts";
import { KeyStore } from "./keys.ts";
import type { QuackEvent } from "./quack-access.ts";
import { QuackClients } from "./quack-client-testkit.ts";
import { extensionFiles, openEngine, project, until } from "./readers-testkit.ts";
import type { ServeEngine } from "./types.ts";

const { ext, withExt } = extensionFiles("quack.test");
const engines: ServeEngine[] = [];
const clients = new QuackClients();
afterAll(async () => {
  clients.close();
  for (const e of engines) await e.close().catch(() => {});
  await closeAllWarehouses();
  cleanup();
});

/** A server-mode project with the attack list's warehouse (orders and customers shared; payments and secrets not), its engine, and a key store. */
async function rig(o: { onEvent?: (e: QuackEvent) => void } = {}) {
  const p = await project({ n: 20, also: WAREHOUSE_SQL.filter((s) => !s.startsWith("CREATE TABLE orders")), asOf: "2026-10-30T10:00:00Z", config: { serve: { sharedTables: [...SHARED] } } });
  const events: QuackEvent[] = [];
  const e = await openEngine(engines, ext.dir, p, { onQuack: (x) => { events.push(x); o.onEvent?.(x); } });
  const keys = new KeyStore(p.stateDir);
  const uri = e.status().serverMode!.quack!.uri;
  /** A key made now, and the engine told of it (its poll reads the keys file). */
  const key = async (name: string) => {
    const made = keys.add(name).key;
    await Bun.sleep(150);
    return made;
  };
  return { p, e, keys, uri, events, key };
}

describe("signing in and reading", () => {
  withExt("a DuckDB 2.0 attaches with a key and reads a shared table by its plain name, with filters and aggregates pushed down", async () => {
    const { uri, key } = await rig();
    const alice = await key("alice");
    const c = await clients.start(ext.dir);
    expect((await c.attach(uri, alice)).ok).toBe(true);
    expect(await c.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: "20" }]);
    expect(await c.rows("SELECT k, count(*) AS n FROM r.orders WHERE id > 12 GROUP BY k ORDER BY k")).toEqual([
      { k: "0", n: "1" }, { k: "1", n: "1" }, { k: "2", n: "1" }, { k: "3", n: "1" }, { k: "4", n: "1" }, { k: "5", n: "1" }, { k: "6", n: "1" },
    ]);
    expect(await c.rows("SELECT count(*) AS n FROM r.orders o JOIN r.customers c ON o.id = c.id")).toEqual([{ n: "5" }]);
  });
});
