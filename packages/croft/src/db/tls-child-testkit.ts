// A process that attaches a lake's catalog and holds the connection open, for the test that must start libpq with an environment of its
// own (db/lake-tls.test.ts): Bun's writes to process.env do not reach the getenv() of the DuckDB library already loaded, so an
// environment variable can only be tested in a child that was started with it. Takes one JSON argument; prints LISTENING 1 (the word mode-testkit.ts readListening waits for) once the lake is
// written, then waits to be killed. Test support, left out of the published package (package.json "files").
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type LakeRig, type RigLake, rigConnection } from "./lake-testkit.ts";
import { openWarehouse } from "./warehouse.ts";

interface Args {
  root: string;
  extensionDir: string;
  pg: { host: string; port: number };
  s3Endpoint: string;
  lake: RigLake;
  catalog: Parameters<typeof rigConnection>[2]["catalog"];
}

const a = JSON.parse(process.argv[2]!) as Args;
const stateDir = join(a.root, ".croft");
mkdirSync(stateDir, { recursive: true });
const rig = { pg: a.pg, s3: { endpoint: a.s3Endpoint } } as unknown as LakeRig;
const conn = rigConnection(rig, a.lake, { stateDir, extensionDir: a.extensionDir, catalog: a.catalog });
const w = openWarehouse({ path: join(a.root, "w.duckdb"), mode: "read_write", timezone: "UTC", root: a.root, stateDir, lake: conn, register: false, isTTY: false });
await w.write("make t", (tx) => tx.exec("CREATE TABLE t AS SELECT 1 AS a"), { runId: "r1" });
console.log("LISTENING 1"); // readListening()'s word for "up"; there is no port
await new Promise(() => {});
