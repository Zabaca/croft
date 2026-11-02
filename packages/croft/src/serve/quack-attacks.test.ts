// The attack list over Quack (DESIGN.md D125; option 06, slice 4 acceptance 3 to 5): everything a person with a key might type to
// read a table that is not shared, change data, read a file, learn a setting or stop the server, sent to the real listener as
// the server would see it from a DuckDB 2.0 client, written plainly and with a catalog function's name in a comment, in a
// string literal and after a line comment. Every one is refused, nothing is written anywhere, and the server stands. The
// first Quack spike let a catalog function's name in a comment through (the option's review); those bypasses are here too.
import { afterAll, describe, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { closeAllWarehouses } from "../db/warehouse.ts";
import { cleanup } from "../read/testkit.ts";
import { absentFor, ALL_ATTACKS, type Attack, CTE_SHAPES, HIDDEN_NAMES, HIDDEN_TABLES, NOT_A_READ, REACHING_OUT, SHARED, variants, WAREHOUSE_SQL } from "../sql/attack-testkit.ts";
import { KeyStore } from "./keys.ts";
import { QuackClients, raw } from "./quack-client-testkit.ts";
import { SCHEMA_QUERY, TABLES_QUERY, TRANSACTION_TEXTS } from "./quack-catalog.ts";
import { count, extensionFiles, openEngine, project } from "./readers-testkit.ts";
import type { ServeEngine } from "./types.ts";

const { ext, withExt } = extensionFiles("quack-attacks.test");
const engines: ServeEngine[] = [];
const clients = new QuackClients();
afterAll(async () => {
  clients.close();
  for (const e of engines) await e.close().catch(() => {});
  await closeAllWarehouses();
  cleanup();
});

/** Every file and folder under `dir` (not following links), with its size: a file an attack wrote would show here. */
function listing(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const here = rel ? `${rel}/${name}` : name;
      const st = statSync(full);
      if (st.isDirectory()) {
        if (name === "node_modules" || name === ".git" || name === "readers-secrets") continue;
        walk(full, here);
      } else if (!/^serve-keys|^runs\.sqlite/.test(name)) out.push(`${here} ${st.size}`);
    }
  };
  walk(dir, "");
  return out;
}

/** Attacks with absolute paths into the project, which a relative path in the list cannot reach from another folder. */
function pathAttacks(root: string, stateDir: string, copy: string): Attack[] {
  const a = (label: string, sql: string): Attack => ({ label, sql });
  return [
    a("COPY a shared table into the project", `COPY orders TO '${root}/pwn-abs.csv'`),
    a("COPY a query into the project", `COPY (SELECT 1) TO '${root}/pwn-abs2.csv' (FORMAT CSV)`),
    a("COPY inside a WITH, into the project", `WITH x AS (COPY (SELECT 1) TO '${root}/pwn-abs3.csv') SELECT 1`),
    a("COPY over the read copy", `COPY orders TO '${copy}' (FORMAT PARQUET)`),
    a("COPY beside the read copy, as its WAL", `COPY (SELECT 'x' AS a) TO '${copy}.wal' (FORMAT CSV)`),
    a("EXPORT DATABASE into the project", `EXPORT DATABASE '${root}/exp-abs'`),
    a("ATTACH the read copy", `ATTACH '${copy}' AS second`),
    a("ATTACH the read copy read-write", `ATTACH '${copy}' AS second (READ_WRITE)`),
    a("DETACH the read copy", "DETACH wh"),
    a("the read copy as a table", `SELECT * FROM '${copy}'`),
    a("read_blob of the read copy", `SELECT * FROM read_blob('${copy}')`),
    a("read_text of the record file", `SELECT content FROM read_text('${stateDir}/serve.json')`),
    a("read_text of the keys file", `SELECT content FROM read_text('${stateDir}/serve-keys.json')`),
    a("read_text of the project's .env", `SELECT content FROM read_text('${root}/.env')`),
    a("glob of the project", `SELECT * FROM glob('${root}/*')`),
    a("glob of the state folder", `SELECT * FROM glob('${stateDir}/*')`),
    a("read_csv of a file in the project", `SELECT * FROM read_csv('${root}/files/x.csv')`),
    a("a hidden table by its catalog and schema", "SELECT * FROM wh.main.payments"),
    a("croft's schema through the copy", "SELECT * FROM wh._croft.assets"),
    a("a hidden table through the in-memory catalog", "SELECT * FROM memory.main.payments"),
    a("the copy's catalog function in a comment, reading a hidden table", "SELECT * FROM wh.main.payments /* duckdb_tables( */"),
    a("quack_stop of this server", "SELECT * FROM quack_stop('quack:127.0.0.1:1')"),
    a("quack_serve for another listener", "SELECT * FROM quack_serve('quack:127.0.0.1:0', token = 'abcdef')"),
  ];
}

describe("the attack list over Quack", () => {
  withExt("every attack is refused, written plainly and with a catalog function in a comment, a string and after a line comment; nothing is written and the server stands", async () => {
    const p = await project({ n: 20, also: WAREHOUSE_SQL.filter((s) => !s.startsWith("CREATE TABLE orders")), config: { serve: { sharedTables: [...SHARED] } } });
    const e = await openEngine(engines, ext.dir, p);
    const keys = new KeyStore(p.stateDir);
    const alice = keys.add("alice").key;
    await Bun.sleep(150);
    const uri = e.status().serverMode!.quack!.uri;
    const c = await clients.start(ext.dir);
    const copy = p.project.paths.readCopy;
    const before = { root: listing(p.root), cwd: listing(process.cwd()), db: readFileSync(p.database).length, copy: readFileSync(copy).length };
    const pid = e.status().serverMode!.workerPid;

    const attacks = [...ALL_ATTACKS, ...pathAttacks(p.root, p.stateDir, copy).flatMap(variants)];
    const wrong: string[] = [];
    for (const q of attacks) {
      // The client's own transaction control is let through by its exact text, on purpose (the server's reply is the same as for BEGIN
      // from any client); everything near it is an attack.
      const control = TRANSACTION_TEXTS.has(q.sql);
      const a = await raw(c, uri, alice, q.sql);
      // Refused by croft's hook, not by something else on the way: the server saw every one of them.
      if (!a.ok && !a.error.includes("Authorization callback failed")) wrong.push(`${q.label}: ${q.sql.slice(0, 120)} -> NOT THE HOOK: ${a.error.split("\n")[0]}`);
      if (a.ok !== control) wrong.push(`${q.label}: ${q.sql.slice(0, 120)} -> ${a.ok ? "ALLOWED" : a.error.split("\n")[0]}`);
    }
    expect(wrong).toEqual([]);
    expect(attacks.length).toBeGreaterThan(400);
    expect([HIDDEN_TABLES.length, NOT_A_READ.length, REACHING_OUT.length].every((n) => n > 20)).toBe(true);

    // Nothing was written, anywhere a write could land: the project, the folder the server runs in, the warehouse and its copy.
    expect(listing(p.root)).toEqual(before.root);
    expect(listing(process.cwd())).toEqual(before.cwd);
    expect(readFileSync(p.database).length).toBe(before.db);
    expect(readFileSync(copy).length).toBe(before.copy);
    expect(existsSync(`${copy}.wal`)).toBe(false);
    // The server stands: the same process, the same rows, the same key, and the app token over HTTP is untouched.
    expect(e.status().serverMode).toMatchObject({ state: "open", workerPid: pid, restarts: 0 });
    expect((await raw(c, uri, alice, "SELECT count(*) AS n FROM orders")).ok).toBe(true);
    const attached = await c.attach(uri, alice);
    expect(attached.ok).toBe(true);
    expect(await c.rows("SELECT count(*) AS n FROM r.orders")).toEqual([{ n: "20" }]);
    expect(await count(e, "payments")).toBe(8);
  }, 300_000);

  withExt("the catalog queries are allowed as their exact bytes only: with a trailing space, a comment or a second statement added they are refused", async () => {
    const p = await project({ n: 20, also: WAREHOUSE_SQL.filter((s) => !s.startsWith("CREATE TABLE orders")), config: { serve: { sharedTables: [...SHARED] } } });
    const e = await openEngine(engines, ext.dir, p);
    const alice = new KeyStore(p.stateDir).add("alice").key;
    await Bun.sleep(150);
    const uri = e.status().serverMode!.quack!.uri;
    const c = await clients.start(ext.dir);
    // As sent: the listing is the in-memory database's main schema and the views, nothing of croft's.
    const schemas = await raw(c, uri, alice, SCHEMA_QUERY);
    expect(schemas.ok && schemas.rows.map((r) => [r.database_name, JSON.stringify(r.schema_path)])).toEqual([["memory", '["main"]']]);
    const tables = await raw(c, uri, alice, TABLES_QUERY);
    expect(tables.ok && tables.rows.map((r) => r.view_name ?? Object.values(r)[1]).sort()).toEqual(["_croft_as_of", "customers", "orders"]);
    expect(JSON.stringify(tables)).not.toMatch(/_croft\b(?!_)|payments|secrets/);
    for (const q of [SCHEMA_QUERY, TABLES_QUERY]) {
      for (const text of [`${q} `, `${q}/* x */`, `${q} -- duckdb_tables(`, `${q}; DROP VIEW orders`, `${q}; SELECT * FROM wh._croft.assets`, `${q};`, q.trim(), `/* duckdb_schemas( */${q}`]) {
        const a = await raw(c, uri, alice, text);
        expect(a.ok, JSON.stringify(text.slice(-40))).toBe(false);
      }
    }
    // The views are still there: the variants dropped nothing.
    expect((await raw(c, uri, alice, "SELECT count(*) AS n FROM orders")).ok).toBe(true);
  }, 120_000);

  withExt("bytes that are not plain SQL text buy nothing: a NUL, a no-break space, a zero-width space and full-width letters in a name", async () => {
    const p = await project({ n: 20, also: WAREHOUSE_SQL.filter((s) => !s.startsWith("CREATE TABLE orders")), config: { serve: { sharedTables: [...SHARED] } } });
    const e = await openEngine(engines, ext.dir, p);
    const alice = new KeyStore(p.stateDir).add("alice").key;
    await Bun.sleep(150);
    const uri = e.status().serverMode!.quack!.uri;
    const c = await clients.start(ext.dir);
    // The text is built in SQL on the client, since a literal cannot hold a NUL. The parser sees the whole string, NUL included
    // (a name with a NUL is not the shared table's), and the same string is what runs.
    for (const text of [
      "'SELECT 1' || chr(0) || '; DROP VIEW orders'", "'SELECT count(*) FROM orders' || chr(0) || ' UNION ALL SELECT count(*) FROM payments'",
      "chr(0) || 'SELECT * FROM payments'", "'SELECT 1 FROM orders;' || chr(0) || 'SELECT * FROM payments'", "'SELECT 1' || chr(12) || '; SELECT * FROM payments'",
      "'SELECT * FROM payments' || chr(160)", "'SELECT * FROM pay' || chr(8203) || 'ments'", "'SELECT * FROM ｐａｙｍｅｎｔｓ'",
    ]) {
      const a = await c.run(`SELECT * FROM quack_query('${uri}', ${text}, token = '${alice}')`);
      expect(a.ok, text).toBe(false);
      expect(a.ok ? "" : a.error, text).toContain("Authorization callback failed");
    }
    expect((await raw(c, uri, alice, "SELECT count(*) AS n FROM orders")).ok).toBe(true);
  }, 120_000);

  withExt("a CTE named after a hidden table gets the same answer as one named after nothing, over Quack too", async () => {
    const p = await project({ n: 20, also: WAREHOUSE_SQL.filter((s) => !s.startsWith("CREATE TABLE orders")), config: { serve: { sharedTables: [...SHARED] } } });
    const e = await openEngine(engines, ext.dir, p);
    const alice = new KeyStore(p.stateDir).add("alice").key;
    await Bun.sleep(150);
    const uri = e.status().serverMode!.quack!.uri;
    const c = await clients.start(ext.dir);
    let ok = 0;
    let refused = 0;
    for (const hidden of HIDDEN_NAMES) {
      const absent = absentFor(hidden);
      for (const shape of CTE_SHAPES) {
        const a = await raw(c, uri, alice, shape.sql(hidden));
        const b = await raw(c, uri, alice, shape.sql(absent));
        const norm = (x: typeof a, name: string) => JSON.stringify(x.ok ? { rows: x.rows } : { error: x.error }).replace(new RegExp(name, "gi"), "<name>").replace(/\d+\.\d+/g, "<ms>");
        expect(a.ok, `${shape.label}: ${shape.sql(hidden)}`).toBe(b.ok);
        expect(norm(a, hidden), shape.label).toBe(norm(b, absent));
        if (a.ok) ok++;
        else refused++;
      }
    }
    expect(ok).toBeGreaterThan(10);
    expect(refused).toBeGreaterThan(5);
  }, 120_000);
});
