// A croft serve in a test: an engine behind the real HTTP layer with a key store, so a test can send a request with the app token or a
// person's key and see the status, the envelope and the log line (D122). Test support, left out of the published package.
import { closeAllWarehouses } from "../db/warehouse.ts";
import { cleanup, makeProject, type TempProject } from "../read/testkit.ts";
import { SHARED, WAREHOUSE_SQL } from "../sql/attack-testkit.ts";
import { openServeEngine } from "./instance.ts";
import { KeyStore } from "./keys.ts";
import { aside, openEngine, project as readersProject } from "./readers-testkit.ts";
import { type KeyQueryLog, type RunningServer, startServer } from "./server.ts";
import type { ServeEngine } from "./types.ts";

export const TOKEN = "app-token-for-key-tests";

export interface Rig {
  p: TempProject;
  engine: ServeEngine;
  keys: KeyStore;
  url: string;
  log: KeyQueryLog[];
  /** Make a key; the server honours it at once. */
  key(name: string): string;
  call(bearer: string | null, sql: string, extra?: Record<string, unknown>, path?: string): Promise<{ status: number; json: any }>;
}

/** Engines and servers started by rigs, for the file's teardown. */
export class Rigs {
  readonly engines: ServeEngine[] = [];
  readonly servers: RunningServer[] = [];

  async rig(p: TempProject, engine: ServeEngine, o: { sharedTables?: readonly string[] } = {}): Promise<Rig> {
    const keys = new KeyStore(p.stateDir);
    const log: KeyQueryLog[] = [];
    const server = startServer({
      engine, host: "127.0.0.1", port: 0, token: TOKEN, allowOrigins: [], root: p.root, database: "warehouse.duckdb", timezone: "America/Los_Angeles",
      keys, sharedTables: o.sharedTables ?? SHARED, onKeyQuery: (e) => log.push(e),
    });
    this.servers.push(server);
    return {
      p, engine, keys, url: server.url, log,
      key: (name) => keys.add(name).key,
      async call(bearer, sql, extra = {}, path = "/query") {
        const res = await fetch(`${server.url}${path}`, {
          method: path === "/query" ? "POST" : "GET",
          headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(path === "/query" ? { "content-type": "application/json" } : {}) },
          ...(path === "/query" ? { body: JSON.stringify({ sql, ...extra }) } : {}),
        });
        return { status: res.status, json: await res.json() };
      },
    };
  }

  /** The file engine over a project with the attack list's warehouse. */
  async file(): Promise<Rig> {
    const p = await makeProject({ config: { serve: { sharedTables: [...SHARED] } }, seed: WAREHOUSE_SQL });
    const engine = await openServeEngine({ root: p.root, resources: { threads: 2 } });
    this.engines.push(engine);
    return this.rig(p, engine);
  }

  /** Server mode: the readers' process over a read copy of the same warehouse (the kit makes `orders` itself). */
  async readers(extensionDir: string): Promise<Rig> {
    const p = await readersProject({
      n: 20, also: WAREHOUSE_SQL.filter((s) => !s.startsWith("CREATE TABLE orders")), config: { serve: { sharedTables: [...SHARED] } },
    });
    const engine = await openEngine(this.engines, extensionDir, p);
    return this.rig(p, engine);
  }

  async close(): Promise<void> {
    for (const s of this.servers) await s.stop(true).catch(() => {});
    for (const e of this.engines) await e.close().catch(() => {});
    await closeAllWarehouses();
    cleanup();
  }
}

export { aside };
