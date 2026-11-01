// The readers' process opened the way serve/worker.ts opens it, but taking raw SQL: a child process of a test, for the
// statements the gate would refuse (DESIGN.md D119). It opens an in-memory instance through the connection factory with
// the `readers` mode (quack and httpfs loaded, the read copy attached read-only as `wh`, locked down to the copy's path),
// then reads JSON lines on stdin and answers each on stdout:
//
//   in:  {"id": 1, "sql": "SELECT count(*) FROM wh.orders"}
//   out: {"id": 1, "ok": true, "rows": [[10]]}   or   {"id": 1, "ok": false, "error": "…first line of DuckDB's message…"}
//
// It prints `READY` once it is locked. Test support, left out of the published package (package.json "files").
//
//   bun readers-session-testkit.ts --ext <dir> --state <dir> --copy <file>
import { createInterface } from "node:readline";
import { join } from "node:path";
import { connect, openMemoryInstance } from "../db/connect.ts";
import { lockCopy, READERS_KEY, readersSpec } from "./worker.ts";

const arg = (n: string) => process.argv[process.argv.indexOf(`--${n}`) + 1]!;
const copy = arg("copy");

lockCopy(copy); // as the worker does before it attaches
const instance = await openMemoryInstance();
const conn = await connect(
  instance,
  readersSpec({ profile: "serve", timezone: "UTC", stateDir: arg("state") }, copy, { extensionDir: arg("ext"), secretDir: join(arg("state"), "readers-secrets") }),
  READERS_KEY,
);
// The instance is referenced for the process's whole life, as the worker's is.
(globalThis as Record<string, unknown>).__readersSession = [instance, conn];

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x));
console.log("READY");
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const { id, sql } = JSON.parse(line) as { id: number; sql: string };
  try {
    const reader = await conn.runAndReadAll(sql);
    console.log(json({ id, ok: true, rows: reader.getRowsJS() }));
  } catch (e) {
    console.log(json({ id, ok: false, error: String((e as Error).message).split("\n")[0] }));
  }
}
