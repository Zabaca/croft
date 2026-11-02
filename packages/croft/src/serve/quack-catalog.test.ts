// The pinned quack build's catalog texts (serve/quack-catalog.ts, D125). A DuckDB 2.0 client sends two fixed queries when it attaches,
// and croft recognises each by its exact bytes. They belong to one build of the quack extension: this test attaches a real client to a
// listener that records every text the server is sent, and fails when the build, or a text, is not the one croft holds. After a quack
// upgrade it fails with the texts to capture again (the test prints what it saw), and until they are captured again an ATTACH fails
// closed: the client's catalog query is not recognised, the gate refuses it, and no one can attach.
import { afterAll, describe, expect } from "bun:test";
import { DuckDBInstance, DuckDBScalarFunction, BOOLEAN, VARCHAR } from "@duckdb/node-api";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceConfig } from "../db/connect.ts";
import { extensionPath, hostPlatform, readFooter } from "../db/extension-files.ts";
import { startQuackListener } from "../db/modes.ts";
import { cleanup } from "../read/testkit.ts";
import { QUACK_BUILD, SCHEMA_QUERY, TABLES_QUERY, TRANSACTION_TEXTS } from "./quack-catalog.ts";
import { QuackClients } from "./quack-client-testkit.ts";
import { extensionFiles } from "./readers-testkit.ts";

const { ext, withExt } = extensionFiles("quack-catalog.test");
const clients = new QuackClients();
const keep: unknown[] = [];
const dirs: string[] = [];
afterAll(() => {
  clients.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  cleanup();
});

describe("the pinned quack build", () => {
  withExt("is the build whose catalog texts croft holds, and a client sends exactly those two texts, and exactly the transaction control croft lets through", async () => {
    const quack = extensionPath(ext.dir, "quack", hostPlatform()!);
    const footer = readFooter(quack);
    expect(footer, `the pinned quack file is build ${footer?.version}; capture the catalog texts again (see this test) and set QUACK_BUILD`).toMatchObject({ version: QUACK_BUILD });

    // A listener that lets everything through and writes down what it was asked.
    const db = await DuckDBInstance.create(":memory:", instanceConfig("read_write"));
    keep.push(db);
    const conn = await db.connect();
    for (const name of ["httpfs", "quack"] as const) await conn.run(`LOAD '${extensionPath(ext.dir, name, hostPlatform()!)}'`);
    const seen = new Set<string>();
    const text = (v: { getItem(i: number): unknown }, r: number) => (v.getItem(r) == null ? "" : String(v.getItem(r)));
    conn.registerScalarFunction(DuckDBScalarFunction.create({
      name: "capture_authn", returnType: BOOLEAN, parameterTypes: [VARCHAR, VARCHAR, VARCHAR], volatile: true,
      mainFunction: (_i, input, out) => { for (let r = 0; r < input.rowCount; r++) out.setItem(r, text(input.getColumnVector(1), r) === "capture-token"); out.flush(); },
    }));
    conn.registerScalarFunction(DuckDBScalarFunction.create({
      name: "capture_authz_js", returnType: VARCHAR, parameterTypes: [VARCHAR, VARCHAR], volatile: true,
      mainFunction: (_i, input, out) => { for (let r = 0; r < input.rowCount; r++) { const q = text(input.getColumnVector(1), r); seen.add(q); out.setItem(r, q); } out.flush(); },
    }));
    await conn.run("CREATE MACRO memory.main.capture_authz(session, query) AS capture_authz_js(session, query)");
    await conn.run("SET GLOBAL quack_authentication_function = 'capture_authn'");
    await conn.run("SET GLOBAL quack_authorization_function = 'capture_authz'");
    await conn.run("CREATE TABLE memory.main.orders AS SELECT range AS id FROM range(10)");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "croft-quack-catalog-")));
    dirs.push(dir);
    const secrets = join(dir, "secrets");
    mkdirSync(secrets, { recursive: true });
    await conn.run(`SET secret_directory = '${secrets}'`);
    const uri = await startQuackListener(conn, "quack:127.0.0.1:0");

    // What a person does: attach, read, read in an explicit transaction, roll one back, fail a query, detach.
    const c = await clients.start(ext.dir);
    expect((await c.attach(uri, "capture-token")).ok).toBe(true);
    await c.rows("SELECT count(*) AS n FROM r.orders");
    await c.rows("SELECT name FROM (SHOW TABLES FROM r)");
    await c.run("BEGIN");
    await c.rows("SELECT count(*) AS n FROM r.orders WHERE id > 3");
    await c.run("ROLLBACK");
    await c.run("BEGIN");
    await c.rows("SELECT count(*) AS n FROM r.orders");
    await c.run("COMMIT");
    await c.run("SELECT id / 0 FROM r.orders");
    await c.run("SELECT * FROM r.nothing");
    await c.run("DETACH r");

    const texts = [...seen];
    const known = new Set([SCHEMA_QUERY, TABLES_QUERY, ...TRANSACTION_TEXTS]);
    const unknown = texts.filter((t) => !known.has(t) && !/^SELECT .*FROM orders/.test(t));
    expect(unknown.map((t) => JSON.stringify(t)), "texts the quack build sends that croft does not know: capture them again").toEqual([]);
    expect(seen.has(SCHEMA_QUERY), `the schema query changed; this build sent: ${JSON.stringify(texts.filter((t) => t.includes("duckdb_schemas")))}`).toBe(true);
    expect(seen.has(TABLES_QUERY), `the tables query changed; this build sent: ${JSON.stringify(texts.filter((t) => t.includes("duckdb_tables")))}`).toBe(true);
    for (const t of TRANSACTION_TEXTS) expect(seen.has(t), `the build no longer sends ${t}`).toBe(true);
    // The user's query arrives as DuckDB writes it, not as typed.
    expect(texts.some((t) => /^SELECT .*count_star\(\).* FROM orders/.test(t.replace(/\s+/g, " ")))).toBe(true);
  }, 90_000);
});
