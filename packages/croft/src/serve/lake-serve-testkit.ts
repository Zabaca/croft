// Server mode over a lake in a test (DESIGN.md D183; option 07, slice 5): a lake project with the attack list's warehouse (orders and
// customers shared; payments and secrets not; croft's own `_croft` records come from the runs that built it), the lake engine over it with
// "serverMode" on, and the HTTP layer and key store of key-rig-testkit.ts. Test support, left out of the published package.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { lakeProject, type LakeProject } from "../cli/commands/lake-project-testkit.ts";
import { connect, openMemoryInstance } from "../db/connect.ts";
import { lakeConnection } from "../db/lake.ts";
import { lakeRigReady, type LakeRig, startLakeRig } from "../db/lake-testkit.ts";
import { lakeReadersMode } from "../db/modes.ts";
import { ProjectEnv } from "../project/env.ts";
import { SHARED } from "../sql/attack-testkit.ts";
import { openLakeEngine, type LakeEngineInternals } from "./lake-engine.ts";
import { type Rig, Rigs } from "./key-rig-testkit.ts";
import { until } from "./readers-testkit.ts";
import type { QuackEvent } from "./quack-access.ts";
import type { ServeEngine, ServeEngineOptions } from "./types.ts";

/** The attack list's other tables, built by croft's own runs (sql/attack-testkit.ts WAREHOUSE_SQL, as assets). */
export const LAKE_ASSETS: Record<string, string> = {
  "assets/customers.sql": "-- description: customers\n-- key: id\nSELECT range AS id, 'c' || range AS name FROM range(5)\n",
  "assets/payments.sql": "-- description: payments\n-- key: id\nSELECT range AS id, range * 10 AS amount, 'p' || range AS note FROM range(8)\n",
  "assets/secrets.sql": "-- description: secrets\n-- key: name\nSELECT 'token' AS name, 'hunter2' AS value\n",
};
export const LAKE_BUILD = ["orders", "customers", "payments", "secrets"];

export const lakeReady = lakeRigReady;

export type LakeKind = "local" | "postgres";

/** A running server-mode engine over a lake, with the HTTP rig on it. */
export interface LakeServe {
  l: LakeProject;
  engine: ServeEngine;
  rig: Rig;
  events: QuackEvent[];
  /** The address the listener is bound to now. */
  uri(): string;
  /** The project's secrets, as a command would read them. */
  env(): ProjectEnv;
  /** A key made now, once the engine has told the process of it. */
  key(name: string): Promise<string>;
}

/** A project in a lake of `kind` with the four tables built, and server mode on over it. Engines and servers are tracked in `rigs`. */
export async function startLakeServe(kind: LakeKind, o: { extensionDir: string; lakeRig?: LakeRig; rigs: Rigs; shared?: readonly string[]; engine?: Partial<ServeEngineOptions & LakeEngineInternals>; serverMode?: Record<string, unknown> }): Promise<LakeServe> {
  const shared = o.shared ?? SHARED;
  const l = await lakeProject(kind, {
    extensionDir: o.extensionDir, ...(o.lakeRig ? { rig: o.lakeRig } : {}), files: LAKE_ASSETS, build: LAKE_BUILD,
    // Quack listens on a free port, and its cap on running queries is out of the way (quack_query opens a session per call, D136).
    config: { serverMode: { enabled: true, quackPort: 0, quackMaxConcurrent: 64, ...o.serverMode }, serve: { sharedTables: [...shared] } },
  });
  const events: QuackEvent[] = [];
  const env = () => ProjectEnv.load(l.p.root, l.env);
  // The names of the keys the engine has told the process of, so that a test waits for that and not for a fixed time.
  const told = new Set<string>();
  const engine = await openLakeEngine({
    root: l.p.root, env: env(), extensionDir: o.extensionDir, resources: { threads: 2 }, onQuack: (e) => events.push(e), pollMs: 50, ...o.engine,
    hooks: { ...o.engine?.hooks, keysSent: (e) => { for (const n of e.names) told.add(n); o.engine?.hooks?.keysSent?.(e); } },
  });
  o.rigs.engines.push(engine);
  const rig = await o.rigs.rig({ ...l.p, database: l.project.paths.database } as never, engine, { sharedTables: shared });
  return {
    l, engine, rig, events, uri: () => engine.status().serverMode!.quack!.uri, env,
    async key(name) {
      const made = rig.key(name);
      await until(`the key ${name} to be told to the process`, () => told.has(name), 15_000);
      return made;
    },
  };
}

/** The folder the lake's files are in on disk: the local lake's data folder, or the store's folder of a shared one. */
export const lakeFolder = (l: LakeProject): string => (l.shared ? l.shared.files : join(l.p.root, "lake", "data"));

/** Every file under `dir` with its size, sorted: a file written there would show. */
export function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const here = rel ? `${rel}/${name}` : name;
      const st = statSync(full);
      if (st.isDirectory()) walk(full, here);
      else out.push(`${here} ${st.size}`);
    }
  };
  walk(dir, "");
  return out;
}

/** Everything in the project folder and the lake's folder that an attack could write: the project's files (not its records, state or
 *  links) and the lake's files. The SQLite catalog of a local lake is in the project's folder, so its size is here too. */
export function written(l: LakeProject): { project: string[]; lake: string[] } {
  const project: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const here = rel ? `${rel}/${name}` : name;
      const st = statSync(full);
      if (st.isDirectory()) {
        if (name === "node_modules" || name === ".git" || name === "lake-secrets") continue;
        walk(full, here);
      } else if (!/^(serve-keys|runs\.sqlite)/.test(name)) project.push(`${here} ${st.size}`);
    }
  };
  walk(l.p.root, "");
  return { project, lake: filesUnder(lakeFolder(l)) };
}

/** A person holding the read-only catalog login and bucket key, attached to the lake in a DuckDB of their own (acceptance 3), and, with `readers`,
 *  the same lake attached the way the readers' process attaches it (the mode, loaded and locked down, with the gate left out of it): the
 *  statements the gate would refuse go to this one. Closed by `close()`. */
export async function lakeSession(s: LakeServe, o: { readers?: boolean; extensionDir: string }): Promise<{ run(sql: string): Promise<unknown[][]>; error(sql: string): Promise<string>; close(): void }> {
  const lake = lakeConnection(s.l.project, s.env(), { extensionDir: o.extensionDir })!;
  const mode = lake.mode("read");
  const instance = await openMemoryInstance();
  const conn: DuckDBConnection = await connect(instance, {
    profile: "serve", timezone: "UTC", root: s.l.p.root, stateDir: s.l.project.paths.stateDir,
    mode: o.readers ? lakeReadersMode(mode as never) : mode,
  }, `:memory:lake-session-${Math.random().toString(36).slice(2)}`);
  await conn.run("USE lake");
  return {
    async run(sql) {
      return (await conn.runAndReadAll(sql)).getRowsJS();
    },
    async error(sql) {
      try {
        await conn.run(sql);
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error(`expected a failure: ${sql}`);
    },
    close() {
      conn.disconnectSync();
      instance.closeSync();
    },
  };
}

export { startLakeRig };
