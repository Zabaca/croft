// Who may do what over Quack (serve/quack-access.ts, D125, D126), with literal inputs and no listener: the decisions are
// synchronous and need only the parsed query DuckDB hands the hook, so they are tested the way the hook calls them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection } from "@duckdb/node-api";
import { openMemory } from "../db/connect.ts";
import { cleanup } from "../read/testkit.ts";
import { type CatalogRow, catalogOf } from "../sql/gate-core.ts";
import { hashKey } from "./keys.ts";
import { QuackAccess, type QuackEvent, QuackRefusal } from "./quack-access.ts";
import { AS_OF_VIEW } from "./quack-address.ts";
import { catalogReplacements, SCHEMA_QUERY, TABLES_QUERY, TRANSACTION_TEXTS } from "./quack-catalog.ts";

let db: Awaited<ReturnType<typeof openMemory>>;
let conn: DuckDBConnection;
beforeAll(async () => {
  db = await openMemory({ timezone: "UTC" });
  conn = await db.connect();
});
afterAll(() => {
  db.close();
  cleanup();
});

/** json_serialize_sql's text, as the hook's macro hands it over. */
async function parsed(sql: string): Promise<string> {
  const reader = await conn.runAndReadAll("SELECT json_serialize_sql($1::VARCHAR)", [sql]);
  return String(reader.getRowsJS()[0]![0]);
}

const VIEWS = ["orders", "customers", AS_OF_VIEW];
/** What the readers' in-memory database holds: one view per shared table and the as-of view. */
const catalog = catalogOf(VIEWS.map((name): CatalogRow => ({ current: "memory", name, kind: "view", database: "memory", schema: "main", temporary: false, internal: false })), "memory");

const ALICE = "croftkey_alice-alice-alice-alice-alice-alice-alice-0";
const BOB = "croftkey_bob-bob-bob-bob-bob-bob-bob-bob-bob-bob-bob-0";
const keyOf = (name: string, key: string) => ({ name, hash: hashKey(key) });

function access(o: { shared?: string[]; now?: () => number; maxConcurrent?: number } = {}) {
  const events: QuackEvent[] = [];
  const a = new QuackAccess({
    shared: o.shared ?? ["orders", "customers"], emit: (e) => events.push(e), ...(o.now ? { now: o.now } : {}), ...(o.maxConcurrent ? { maxConcurrent: o.maxConcurrent } : {}),
  });
  a.setKeys([keyOf("alice", ALICE), keyOf("bob", BOB)]);
  a.setCatalog(catalog, VIEWS);
  return { a, events };
}

/** The refusal's text for `sql`, or null when it was allowed. */
async function refusal(a: QuackAccess, session: string, sql: string): Promise<string | null> {
  try {
    a.authorize(session, sql, await parsed(sql));
    return null;
  } catch (e) {
    if (!(e instanceof QuackRefusal)) throw e;
    return e.message;
  }
}

describe("signing in", () => {
  test("a listed key signs in; the app token, a made-up key, no token and a key that is not listed do not", () => {
    const { a, events } = access();
    expect(a.authenticate("s1", ALICE)).toBe(true);
    expect(a.authenticate("s2", "app-token-for-tests")).toBe(false);
    expect(a.authenticate("s3", `croftkey_${"A".repeat(43)}`)).toBe(false);
    expect(a.authenticate("s4", "")).toBe(false);
    expect(a.authenticate("s5", null)).toBe(false);
    expect(a.authenticate("s6", `${ALICE} `)).toBe(false);
    expect(a.signedIn).toBe(1);
    expect(events).toEqual([{ kind: "signin", key: "alice", at: expect.any(Number) }]);
  });

  test("nobody signs in before the catalog is set: a client that attached then would list nothing", () => {
    const a = new QuackAccess({ shared: ["orders"], emit: () => {} });
    a.setKeys([keyOf("alice", ALICE)]);
    expect(a.authenticate("s1", ALICE)).toBe(false);
    a.setCatalog(catalog, ["orders"]);
    expect(a.authenticate("s1", ALICE)).toBe(true);
  });
});

describe("a session's key is checked on every query", () => {
  test("a removed key is refused on its session's next query; other sessions and other keys are unaffected", async () => {
    const { a } = access();
    a.authenticate("sa", ALICE);
    a.authenticate("sb", BOB);
    expect(await refusal(a, "sa", "SELECT count(*) FROM orders")).toBeNull();
    a.setKeys([keyOf("bob", BOB)]);
    expect(await refusal(a, "sa", "SELECT count(*) FROM orders")).toMatch(/key alice was removed/);
    expect(await refusal(a, "sa", "SELECT 1")).toMatch(/removed/);
    expect(await refusal(a, "sa", "COMMIT")).toMatch(/removed/); // even the transaction control
    expect(await refusal(a, "sb", "SELECT count(*) FROM orders")).toBeNull();
    // ...and it cannot sign in again.
    expect(a.authenticate("sa2", ALICE)).toBe(false);
  });

  test("a name made again with another key does not revive the old key's session", async () => {
    const { a } = access();
    a.authenticate("sa", ALICE);
    a.setKeys([keyOf("alice", "croftkey_a-different-key-a-different-key-a-different-0")]);
    expect(await refusal(a, "sa", "SELECT 1")).toMatch(/removed/);
  });

  test("a session that never signed in is refused", async () => {
    const { a } = access();
    expect(await refusal(a, "nobody", "SELECT 1")).toMatch(/not signed in/);
    expect(await refusal(a, "nobody", "BEGIN TRANSACTION")).toMatch(/not signed in/);
  });

  test("the keys file being unreadable is no keys: every session is refused", async () => {
    const { a } = access();
    a.authenticate("sa", ALICE);
    a.setKeys([]);
    expect(await refusal(a, "sa", "SELECT 1")).toMatch(/removed/);
  });
});

describe("what a client sends to attach", () => {
  test("the transaction control is let through by its exact text, and nothing near it is", async () => {
    const { a } = access();
    a.authenticate("s", ALICE);
    for (const t of TRANSACTION_TEXTS) expect(a.authorize("s", t, await parsed(t))).toBe(t);
    for (const t of ["BEGIN", "begin transaction", "COMMIT ", " COMMIT", "COMMIT;", "ROLLBACK -- x", "COMMIT; DROP VIEW orders", "START TRANSACTION", "BEGIN TRANSACTION READ WRITE", "COMMIT\n"]) {
      expect(await refusal(a, "s", t), t).not.toBeNull();
    }
  });

  test("each of the two catalog queries is swapped for a query that lists the main schema and the views, by its exact text", async () => {
    const { a } = access();
    a.authenticate("s", ALICE);
    const replacements = catalogReplacements(["orders", "customers", AS_OF_VIEW]);
    for (const q of [SCHEMA_QUERY, TABLES_QUERY]) {
      const run = a.authorize("s", q, await parsed(q));
      expect(run).toBe(replacements.get(q)!);
      expect(run).not.toBe(q);
      expect(run).toContain("database_name = 'memory'");
    }
    expect(a.authorize("s", TABLES_QUERY, "{}")).toContain("view_name IN ('orders', 'customers', '_croft_as_of')");
  });

  test("a catalog query with a trailing space, a comment, a second statement or any other change goes through the gate, which refuses it", async () => {
    const { a } = access();
    a.authenticate("s", ALICE);
    for (const q of [SCHEMA_QUERY, TABLES_QUERY]) {
      for (const text of [`${q} `, `${q}/* x */`, `${q} -- duckdb_tables(`, `${q}; DROP VIEW orders`, `${q};`, q.trim(), q.replace("system", "memory"), q.toLowerCase(),
        q.replace("\n", " "), q.replaceAll("\t", " "), `/* duckdb_schemas( */${q}`, `${q}\n`].filter((t) => t !== q)) {
        const why = await refusal(a, "s", text);
        expect(why, text.slice(0, 60)).not.toBeNull();
        expect(why, text.slice(0, 60)).toMatch(/QUERY_PATH_DENIED|QUERY_NOT_SELECT|SQL_SYNTAX|SQL_NOT_ONE_STATEMENT/);
      }
    }
  });

  test("a catalog function's name in a comment, a string or after a line comment buys nothing", async () => {
    const { a } = access();
    a.authenticate("s", ALICE);
    for (const sql of [
      "SELECT * FROM wh._croft.assets /* duckdb_tables( */", "SELECT *, 'duckdb_tables()' AS x FROM wh._croft.assets", "SELECT * FROM wh.main._croft_runs -- duckdb_schemas(",
      "DELETE FROM orders RETURNING id /* duckdb_tables( */", "COPY (SELECT 1) TO 'pwn.csv' /* duckdb_tables( */", "ATTACH ':memory:' AS m /* duckdb_tables( */",
      "SELECT * FROM quack_stop('quack:localhost:1') /* duckdb_tables( */", "SELECT * FROM duckdb_settings(), payments LIMIT 1",
    ]) {
      expect(await refusal(a, "s", sql), sql).not.toBeNull();
    }
  });
});

describe("a query goes through the same gate as over HTTP", () => {
  test("the shared tables and the as-of view can be read; the query to run is the query as sent", async () => {
    const { a } = access();
    a.authenticate("s", ALICE);
    for (const sql of ["SELECT count_star() FROM orders", "SELECT * FROM customers WHERE id > 1", `SELECT as_of FROM ${AS_OF_VIEW}`, "SELECT 1 + 1",
      "WITH big AS (SELECT * FROM orders) SELECT count(*) FROM big", "SELECT * FROM memory.main.orders", "SELECT * FROM ORDERS"]) {
      expect(a.authorize("s", sql, await parsed(sql)), sql).toBe(sql);
    }
  });

  test("a table that is not shared is refused in the words for one that does not exist, and the as-of view is listed with the shared tables", async () => {
    const { a } = access();
    a.authenticate("s", ALICE);
    const real = await refusal(a, "s", "SELECT * FROM payments");
    const absent = await refusal(a, "s", "SELECT * FROM nothing_here");
    expect(real).toMatch(/QUERY_PATH_DENIED/);
    expect(real!.replaceAll("payments", "<n>")).toBe(absent!.replaceAll("nothing_here", "<n>"));
    expect(a.authorize("s", "SHOW TABLES", await parsed("SHOW TABLES"))).toBe(`SELECT name FROM (VALUES ('${AS_OF_VIEW}'), ('customers'), ('orders')) AS t(name) ORDER BY name`);
  });

  test("what is not one SELECT is QUERY_NOT_SELECT, as over HTTP, and a syntax error is SQL_SYNTAX", async () => {
    const { a } = access();
    a.authenticate("s", ALICE);
    for (const sql of ["INSERT INTO orders VALUES (1, 1, 'x')", "DELETE FROM orders", "DROP VIEW orders", "CREATE TABLE x AS SELECT 1", "COPY orders TO 'x.csv'", "ATTACH ':memory:' AS m",
      "INSTALL httpfs", "SET threads = 1", "PRAGMA database_list", "CALL checkpoint()", "SELECT 1; DROP VIEW orders", "WITH x AS (DELETE FROM orders RETURNING *) SELECT 1"]) {
      expect(await refusal(a, "s", sql), sql).toMatch(/QUERY_NOT_SELECT/);
    }
    expect(await refusal(a, "s", "SELEC 1")).toMatch(/SQL_SYNTAX/);
    expect(await refusal(a, "s", "SELECT 1; SELECT 2")).toMatch(/SQL_NOT_ONE_STATEMENT/);
  });

  test("croft's own hook functions and Quack's are not callable from a query", async () => {
    const { a } = access();
    a.authenticate("s", ALICE);
    for (const sql of ["SELECT croft_authz('x', 'SELECT 1')", "SELECT croft_authn('x', 'y', 'z')", "SELECT croft_authz_js('x', 'SELECT 1', '{}')", "SELECT memory.main.croft_authz('x', 'y')",
      "SELECT quack_check_token('x', 'y', 'z')", "SELECT quack_connection_id('x')", "SELECT * FROM quack_active_connections()"]) {
      expect(await refusal(a, "s", sql), sql).toMatch(/QUERY_PATH_DENIED/);
    }
  });

  test("a project that shares no table shares nothing: every query but the transaction control is refused with the setting named, the attach included", async () => {
    const { a } = access({ shared: [] });
    a.authenticate("s", ALICE);
    for (const sql of ["SELECT 1", "SELECT * FROM orders", "SHOW TABLES", SCHEMA_QUERY, TABLES_QUERY]) {
      const why = await refusal(a, "s", sql);
      expect(why, sql.slice(0, 40)).toMatch(/SERVE_NO_SHARED_TABLES/);
      expect(why).toContain("sharedTables");
    }
    expect(await refusal(a, "s", "COMMIT")).toBeNull();
  });
});

describe("the cap on running queries (D130, D136)", () => {
  const read = async (a: QuackAccess, sql = "SELECT count(*) FROM orders") => refusal(a, "s", sql);

  test("past the cap a data query is refused with a retryable answer that names the setting; the client's own control and catalog queries still run", async () => {
    const { a, events } = access({ maxConcurrent: 2 });
    a.authenticate("s", ALICE);
    a.setActive(2);
    const why = await read(a);
    expect(why).toMatch(/SERVE_UNAVAILABLE/);
    expect(why).toContain("serverMode.quackMaxConcurrent");
    expect(why).toContain("2 Quack queries");
    expect(events.at(-1)).toMatchObject({ kind: "query", outcome: "SERVE_UNAVAILABLE", tables: [] });
    for (const t of ["BEGIN TRANSACTION", "COMMIT", "ROLLBACK", SCHEMA_QUERY, TABLES_QUERY]) expect(await read(a, t), t.slice(0, 20)).toBeNull();
    a.setActive(1);
    expect(await read(a)).toBeNull();
  });

  test("a burst inside one look is capped: each session admitted a query counts at once, so the query past the cap is refused before the next look (D136)", async () => {
    const { a, events } = access({ maxConcurrent: 2 });
    for (let i = 0; i < 5; i++) a.authenticate(`s${i}`, ALICE);
    // The last look saw nothing running; five sessions then send a query within the same 250 ms.
    a.setActive(0);
    expect(await refusal(a, "s0", "SELECT count(*) FROM orders")).toBeNull();
    expect(await refusal(a, "s1", "SELECT count(*) FROM orders")).toBeNull();
    for (const s of ["s2", "s3", "s4"]) expect(await refusal(a, s, "SELECT count(*) FROM orders"), s).toMatch(/SERVE_UNAVAILABLE/);
    expect(events.filter((e) => e.kind === "query" && e.outcome === "ok")).toHaveLength(2);
  });

  test("the next look replaces the count with the real number, so sessions whose query finished stop being counted", async () => {
    const { a } = access({ maxConcurrent: 2 });
    for (const s of ["a", "b", "c", "d", "e", "f", "g"]) a.authenticate(s, ALICE);
    const q = (s: string) => refusal(a, s, "SELECT count(*) FROM orders");
    a.setActive(0);
    expect(await q("a")).toBeNull();
    expect(await q("b")).toBeNull();
    expect(await q("c")).toMatch(/SERVE_UNAVAILABLE/);
    // Both finished; the look sees one running (somebody else's), not the two admitted.
    a.setActive(1);
    expect(await q("d")).toBeNull();
    expect(await q("e")).toMatch(/SERVE_UNAVAILABLE/);
    // And a look that sees the server idle clears it whatever was admitted before.
    a.setActive(0);
    expect(await q("f")).toBeNull();
    expect(await q("g")).toBeNull();
    expect(await q("a")).toMatch(/SERVE_UNAVAILABLE/);
  });

  test("a session that sends one query after another counts once: it is never refused for the ones it finished, whatever the look says", async () => {
    const { a } = access({ maxConcurrent: 2 });
    a.authenticate("s", ALICE);
    a.setActive(0);
    for (let i = 0; i < 100; i++) expect(await read(a), String(i)).toBeNull();
    // A second session joins it, and a third is past the cap: two sessions are two running queries, not a hundred.
    a.authenticate("t", ALICE);
    a.authenticate("u", ALICE);
    expect(await refusal(a, "t", "SELECT count(*) FROM orders")).toBeNull();
    expect(await refusal(a, "u", "SELECT count(*) FROM orders")).toMatch(/SERVE_UNAVAILABLE/);
    for (let i = 0; i < 100; i++) expect(await read(a), String(i)).toBeNull();
  });

  test("a hundred sessions that send one query each per look are never refused", async () => {
    const { a } = access({ maxConcurrent: 2 });
    for (let i = 0; i < 100; i++) {
      a.authenticate(`s${i}`, ALICE);
      a.setActive(0);
      expect(await refusal(a, `s${i}`, "SELECT count(*) FROM orders"), String(i)).toBeNull();
    }
  });

  test("a look that began before a session was admitted does not forget it: only admissions the look could have seen stop being counted", async () => {
    let t = 1000;
    const { a } = access({ maxConcurrent: 2, now: () => t });
    for (const s of ["a", "b", "c", "d"]) a.authenticate(s, ALICE);
    const q = (s: string) => refusal(a, s, "SELECT count(*) FROM orders");
    // A look begins at 1000 and its query takes 40 ms; two sessions are admitted while it is in flight.
    a.setActive(0, 1000);
    t = 1010;
    expect(await q("a")).toBeNull();
    t = 1030;
    expect(await q("b")).toBeNull();
    // The look ends with 0 running (it began before either query) and must not clear them: a third session is refused.
    a.setActive(0, 1000);
    expect(await q("c")).toMatch(/SERVE_UNAVAILABLE/);
    // The next look began after both admissions, so it has seen them (running, or finished): the count is the look's.
    t = 1250;
    a.setActive(1, 1250);
    expect(await q("c")).toBeNull();
    expect(await q("d")).toMatch(/SERVE_UNAVAILABLE/);
    // A session admitted again after a look began is counted again from then, once.
    t = 1500;
    a.setActive(0, 1490);
    expect(await q("a")).toBeNull();
    expect(await q("a")).toBeNull();
    expect(await q("b")).toBeNull();
    expect(await q("d")).toMatch(/SERVE_UNAVAILABLE/);
  });

  test("a look that fails changes nothing: the count only grows until one succeeds", async () => {
    const { a } = access({ maxConcurrent: 2 });
    for (const s of ["a", "b", "c"]) a.authenticate(s, ALICE);
    const q = (s: string) => refusal(a, s, "SELECT count(*) FROM orders");
    a.setActive(0);
    expect(await q("a")).toBeNull();
    expect(await q("b")).toBeNull();
    // No look follows (every one failed): the sessions stay counted and a new one is turned away, however long it takes.
    expect(await q("c")).toMatch(/SERVE_UNAVAILABLE/);
    a.setActive(0);
    expect(await q("c")).toBeNull();
  });

  test("a refused attack does not use a slot, and without a cap nothing is counted", async () => {
    const { a } = access({ maxConcurrent: 1 });
    a.authenticate("s", ALICE);
    for (let i = 0; i < 5; i++) expect(await read(a, "DROP VIEW orders")).toMatch(/QUERY_NOT_SELECT/);
    expect(await read(a)).toBeNull();
    const { a: free } = access();
    free.authenticate("s", ALICE);
    free.setActive(1000);
    expect(await read(free)).toBeNull();
  });
});

describe("what is written down", () => {
  test("a query is told with the key's name, the tables it read and how it ended; a refusal with the code; never the SQL or the key", async () => {
    const { a, events } = access();
    a.authenticate("s", ALICE);
    events.length = 0;
    const sql = "SELECT o.id, 'secret-literal' FROM orders o JOIN customers c ON o.id = c.id";
    a.authorize("s", sql, await parsed(sql));
    await refusal(a, "s", "SELECT * FROM payments");
    await refusal(a, "s", "DROP VIEW orders");
    a.authorize("s", "COMMIT", "{}"); // transaction control and the catalog are not queries of the key's
    expect(events.map((e) => (e.kind === "query" ? { key: e.key, tables: e.tables, outcome: e.outcome } : e))).toEqual([
      { key: "alice", tables: ["orders", "customers"], outcome: "ok" },
      { key: "alice", tables: [], outcome: "QUERY_PATH_DENIED" },
      { key: "alice", tables: [], outcome: "QUERY_NOT_SELECT" },
    ]);
    expect(JSON.stringify(events)).not.toContain(ALICE);
    expect(JSON.stringify(events)).not.toContain("secret-literal");
  });

  test("a log that throws never costs the client its answer", async () => {
    const a = new QuackAccess({ shared: ["orders"], emit: () => { throw new Error("disk full"); } });
    a.setKeys([keyOf("alice", ALICE)]);
    a.setCatalog(catalog, ["orders"]);
    expect(a.authenticate("s", ALICE)).toBe(true);
    expect(a.authorize("s", "SELECT 1", await parsed("SELECT 1"))).toBe("SELECT 1");
  });
});

describe("sessions the server no longer lists", () => {
  test("a session that is not listed any more is forgotten once it is old enough; a young one and a listed one stay", () => {
    let clock = 1_000_000;
    const { a } = access({ now: () => clock });
    a.authenticate("old-gone", ALICE);
    a.authenticate("old-listed", ALICE);
    clock += 60_000;
    a.authenticate("young", ALICE);
    expect(a.signedIn).toBe(3);
    a.prune(new Set(["old-listed"]));
    expect(a.signedIn).toBe(2);
    clock += 60_000;
    a.prune(new Set(["old-listed"]));
    expect(a.signedIn).toBe(1);
  });
});
