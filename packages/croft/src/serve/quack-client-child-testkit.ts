// A person's DuckDB 2.0, as a child process of a test (DESIGN.md D125; option 06, slice 4): `@duckdb/node-api` 2.0.0-r.1, the
// same library croft runs on, with quack and httpfs loaded from the pinned files. The DuckDB command line installed on a
// development machine is older than Quack, so a real client is a second process of this library. It reads JSON lines on
// stdin and answers each on stdout:
//
//   in:  {"id": 1, "sql": "ATTACH 'quack:127.0.0.1:9494' AS r (TOKEN 'croftkey_…')"}             (the default connection)
//        {"id": 2, "sql": "SELECT count(*) FROM r.orders", "conn": "second"}                       (a connection of its own)
//   out: {"id": 2, "ok": true, "rows": [{"count_star()": "20"}], "ms": 3.2}
//        {"id": 3, "ok": false, "error": "Invalid Input Error: Authentication failed", "ms": 1.1}
//
// It prints `READY` once the extensions are loaded. Test support, left out of the published package (package.json "files").
//
//   bun quack-client-child-testkit.ts --ext <dir>
import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { createInterface } from "node:readline";
import { instanceConfig } from "../db/connect.ts";
import { extensionPath, hostPlatform } from "../db/extension-files.ts";

const arg = (n: string) => process.argv[process.argv.indexOf(`--${n}`) + 1]!;
const platform = hostPlatform()!;
const instance = await DuckDBInstance.create(":memory:", instanceConfig("read_write"));
const connections = new Map<string, DuckDBConnection>([["", await instance.connect()]]);
for (const name of ["httpfs", "quack"] as const) await connections.get("")!.run(`LOAD '${extensionPath(arg("ext"), name, platform)}'`);

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
console.log("READY");
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const { id, sql, conn: name = "" } = JSON.parse(line) as { id: number; sql: string; conn?: string };
  const started = performance.now();
  try {
    let conn = connections.get(name);
    if (!conn) connections.set(name, (conn = await instance.connect()));
    const reader = await conn.runAndReadAll(sql);
    console.log(json({ id, ok: true, rows: reader.getRowObjectsJson(), ms: performance.now() - started }));
  } catch (e) {
    console.log(json({ id, ok: false, error: String((e as Error).message), ms: performance.now() - started }));
  }
}
