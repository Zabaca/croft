// The readers' profile with a Quack listener, as a child process of a test (DESIGN.md D118): it opens an in-memory
// instance through the connection factory, attaches the read copy, creates a view per table in the in-memory
// database (a Quack session starts there), starts the listener BEFORE the lock, and locks. It prints
// `LISTENING <port>` and serves until it is killed.
//
//   bun quack-listener-testkit.ts --ext <dir> --state <dir> --copy <file> --port <n> --token <t> --tables a,b
import { DuckDBInstance } from "@duckdb/node-api";
import { join } from "node:path";
import { connect, instanceConfig } from "./connect.ts";
import { READ_COPY_ALIAS, startQuackListener } from "./modes.ts";

const arg = (n: string) => process.argv[process.argv.indexOf(`--${n}`) + 1]!;
const port = Number(arg("port"));
const tables = arg("tables").split(",").filter(Boolean);

const instance = await DuckDBInstance.create(":memory:", instanceConfig("read_write"));
const conn = await connect(instance, {
  profile: "serve",
  timezone: "UTC",
  mode: {
    kind: "readers",
    extensionDir: arg("ext"),
    secretDir: join(arg("state"), "secrets"),
    copy: arg("copy"),
    prepare: async (c) => {
      for (const t of tables) await c.run(`CREATE VIEW memory.main.${t} AS SELECT * FROM ${READ_COPY_ALIAS}.main.${t}`);
      await startQuackListener(c, `quack:localhost:${port}`, arg("token"));
    },
  },
}, ":memory:readers");
// The listener lives as long as the connection that started it: keep it referenced for the process's life.
(globalThis as Record<string, unknown>).__readersConnection = conn;
console.log(`LISTENING ${port}`);
setInterval(() => {}, 1 << 30);
