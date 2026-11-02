// The gate's synchronous core (sql/gate-core.ts, D123) and a key's scope (D122). decide() is given everything DuckDB has to
// say before it decides, so these tests build the inputs once and then call it without a connection; the async shell
// (gate.ts) must reach the same decisions with the same inputs. The attack list is sql/attack-testkit.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection } from "@duckdb/node-api";
import { CroftError } from "../core/errors.ts";
import { openMemory } from "../db/connect.ts";
import { cleanup } from "../read/testkit.ts";
import { ALL_ATTACKS, ALLOWED, SHARED, WAREHOUSE_SQL } from "./attack-testkit.ts";
import {
  type CatalogSnapshot, catalogOf, decide, type GateInputs, type GateOptions, type GateVerdict, restrictCatalog,
} from "./gate-core.ts";
import { gateSelect, loadCatalog } from "./gate.ts";

let db: Awaited<ReturnType<typeof openMemory>>;
let conn: DuckDBConnection;
let catalog: CatalogSnapshot;
beforeAll(async () => {
  db = await openMemory({ timezone: "UTC" });
  conn = await db.connect();
  for (const sql of WAREHOUSE_SQL) await conn.run(sql);
  catalog = await loadCatalog(conn);
});
afterAll(() => {
  db.close();
  cleanup();
});

/** What DuckDB says about `sql` before the gate decides: the count and the parsed query. */
async function parse(sql: string): Promise<Pick<GateInputs, "count" | "parsed">> {
  let count: number | "unparsable";
  try {
    count = (await conn.extractStatements(sql)).count;
  } catch {
    count = "unparsable";
  }
  const reader = await conn.runAndReadAll("SELECT json_serialize_sql($1::VARCHAR)", [sql]);
  return { count, parsed: String(reader.getRowsJS()[0]![0]) };
}

const KEY: GateOptions = { profile: "serve", shared: SHARED };
const TOKEN: GateOptions = { profile: "serve" };

/** The decision, taken without a connection. */
async function decision(sql: string, options: GateOptions, cat: CatalogSnapshot | null = catalog): Promise<GateVerdict | CroftError> {
  const given = await parse(sql);
  try {
    return decide({ sql, ...given, options, ...(cat ? { catalog: cat } : {}) });
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
}
const refused = (d: GateVerdict | CroftError): d is CroftError => d instanceof CroftError;

describe("decide() is synchronous: everything it needs is given", () => {
  test("it returns a verdict, not a promise, and needs no connection once the inputs are built", async () => {
    const sql = "SELECT count(*) AS n FROM orders";
    const given = await parse(sql);
    const closed = await db.connect();
    closed.disconnectSync(); // nothing below may touch DuckDB
    const verdict = decide({ sql, ...given, options: KEY, catalog });
    expect(verdict).not.toBeInstanceOf(Promise);
    expect(verdict.sql).toBe(sql);
    expect(verdict.tables).toEqual(["orders"]);
    expect(verdict.ast.node.type).toBe("SELECT_NODE");
  });

  test("the serve profile without a catalog snapshot is a croft bug, never an open door", async () => {
    for (const options of [TOKEN, KEY]) {
      const e = await decision("SELECT * FROM orders", options, null);
      expect(refused(e) && e.code).toBe("INTERNAL_ERROR");
    }
  });

  test("a hook that has only the parsed query passes no count; the parsed query's own is used", async () => {
    const one = await parse("SELECT 1");
    expect(decide({ sql: "SELECT 1", parsed: one.parsed, options: TOKEN, catalog }).tables).toEqual([]);
    const two = await parse("SELECT 1; SELECT 2");
    expect(() => decide({ sql: "SELECT 1; SELECT 2", parsed: two.parsed, options: TOKEN, catalog })).toThrow(/found 2 statements/);
    // The count extractStatements gives is what refuses a COPY, which json_serialize_sql does not serialize at all.
    const copy = await parse("COPY orders TO 'x.csv'");
    expect(() => decide({ sql: "COPY orders TO 'x.csv'", parsed: copy.parsed, options: TOKEN, catalog })).toThrow(CroftError);
  });

  test("the shell reaches the same decision as the core, for the whole attack list and the allowed queries, key and token", async () => {
    const cached = { catalog };
    for (const q of [...ALL_ATTACKS, ...ALLOWED]) {
      for (const options of [KEY, TOKEN]) {
        const core = await decision(q.sql, options);
        let shell: GateVerdict | CroftError;
        try {
          shell = await gateSelect(conn, q.sql, { ...options, ...cached });
        } catch (e) {
          if (!(e instanceof CroftError)) throw e;
          shell = e;
        }
        expect(refused(shell), `${q.label}: ${q.sql}`).toBe(refused(core));
        if (refused(shell) && refused(core)) expect(shell.code, q.label).toBe(core.code);
        // And without the cached snapshot the shell fetches its own.
        const fetched = await gateSelect(conn, q.sql, options).then((v) => v.sql, (e: CroftError) => e.code);
        expect(fetched, q.label).toBe(refused(core) ? core.code : (core as GateVerdict).sql);
      }
    }
  }, 60_000);
});

describe("a key's scope: the attack list", () => {
  test("every attack is refused, however it is written", async () => {
    const failures: string[] = [];
    for (const q of ALL_ATTACKS) {
      const d = await decision(q.sql, KEY);
      if (!refused(d)) failures.push(`${q.label}: ${q.sql}`);
    }
    expect(failures).toEqual([]);
    expect(ALL_ATTACKS.length).toBeGreaterThan(250);
  }, 60_000);

  test("the queries a person needs are allowed, with the tables they read", async () => {
    for (const q of ALLOWED) {
      const d = await decision(q.sql, KEY);
      expect(refused(d) ? `${q.label}: ${d.message}` : "ok", q.label).toBe("ok");
    }
    const read = async (sql: string) => (await decision(sql, KEY) as GateVerdict).tables;
    expect(await read("SELECT count(*) FROM orders o JOIN customers c ON o.id = c.id")).toEqual(["orders", "customers"]);
    expect(await read("SELECT count(*) FROM ORDERS")).toEqual(["orders"]);
    expect(await read("SELECT 1")).toEqual([]);
    expect(await read("WITH orders AS (SELECT 1 AS a) SELECT a FROM orders")).toEqual(["orders"]); // a shared name stays allowed
  });

  test("a table that is not shared is refused as if it did not exist: the same words whether or not it does", async () => {
    const words = async (name: string) => {
      const e = await decision(`SELECT * FROM ${name}`, KEY);
      expect(refused(e)).toBe(true);
      const c = e as CroftError;
      return { code: c.code, message: c.message.replaceAll(name, "<name>"), hint: c.problem.hint, details: c.problem.details };
    };
    const real = await words("payments");
    expect(await words("no_such_table")).toEqual(real);
    expect(await words("secrets")).toEqual(real);
    expect(real.code).toBe("QUERY_PATH_DENIED");
    expect(real.message).toContain("is not one of the tables shared with this key");
    // The words never say that the table exists, or what else does.
    expect(JSON.stringify(real)).not.toMatch(/payments|secrets|_croft|Did you mean/);
    expect(real.hint).toContain("this key may read: customers, orders");
  });

  test("SHOW TABLES lists the shared tables the warehouse has, and only those", async () => {
    const d = (await decision("SHOW TABLES", KEY)) as GateVerdict;
    expect(d.sql).not.toBe("SHOW TABLES");
    expect(d.tables).toEqual([]);
    const rows = (await conn.runAndReadAll(d.sql)).getRowObjectsJS();
    expect(rows).toEqual([{ name: "customers" }, { name: "orders" }]);
    // The token's SHOW TABLES is DuckDB's own and lists every table of the main schema.
    const all = (await decision("SHOW TABLES", TOKEN)) as GateVerdict;
    expect(all.sql).toBe("SHOW TABLES");
    // A shared table the warehouse lacks is not listed, and one it has is.
    const ghost = (await decision("SHOW TABLES", { profile: "serve", shared: ["orders", "ghost"] })) as GateVerdict;
    expect((await conn.runAndReadAll(ghost.sql)).getRowObjectsJS()).toEqual([{ name: "orders" }]);
    expect(refused(await decision("SELECT * FROM ghost", { profile: "serve", shared: ["orders", "ghost"] }))).toBe(true);
  });

  test("with no table shared, every table is refused and the hint names the setting", async () => {
    for (const sql of ["SELECT * FROM orders", "SELECT * FROM customers", "SELECT * FROM payments", "DESCRIBE orders"]) {
      const e = await decision(sql, { profile: "serve", shared: [] });
      expect(refused(e), sql).toBe(true);
      expect((e as CroftError).problem.hint, sql).toContain("serve.sharedTables");
    }
    const none = (await decision("SHOW TABLES", { profile: "serve", shared: [] })) as GateVerdict;
    expect((await conn.runAndReadAll(none.sql)).getRowObjectsJS()).toEqual([]);
  });

  test("a key's connection in the readers' process names the shared tables' views in its own database", async () => {
    const memoryAt = await db.connect();
    await memoryAt.run("ATTACH ':memory:' AS wh");
    await memoryAt.run("CREATE TABLE wh.main.orders AS SELECT 1 AS id");
    await memoryAt.run("CREATE TABLE wh.main.payments AS SELECT 1 AS id");
    // The readers' process: a view per shared table in the connection's own database; the tables stay in wh.
    const views = await db.connect();
    await views.run("CREATE SCHEMA IF NOT EXISTS other");
    const rows = [
      { current: "memory", name: "orders", kind: "view" as const, database: "memory", schema: "main", temporary: false, internal: false },
      { current: "memory", name: "payments", kind: "table" as const, database: "wh", schema: "main", temporary: false, internal: false },
      { current: "memory", name: "orders", kind: "table" as const, database: "wh", schema: "main", temporary: false, internal: false },
    ];
    const snapshot = catalogOf(rows, "memory");
    expect([...snapshot.views]).toEqual(["orders"]);
    expect([...snapshot.userTables]).toEqual([]);
    const key = restrictCatalog(snapshot, ["orders", "customers"]);
    expect([...key.userTables]).toEqual(["orders"]);
    const open = async (sql: string) => {
      const given = await parse(sql);
      try {
        return decide({ sql, ...given, options: KEY, catalog: snapshot });
      } catch (e) {
        return e as CroftError;
      }
    };
    expect(refused(await open("SELECT * FROM orders"))).toBe(false);
    expect(refused(await open("SELECT * FROM memory.main.orders"))).toBe(false);
    expect(refused(await open("SELECT * FROM wh.main.orders"))).toBe(true); // the copy itself is another catalog
    expect(refused(await open("SELECT * FROM payments"))).toBe(true);
    expect(refused(await open("SELECT * FROM wh.main.payments"))).toBe(true);
  });
});

describe("the app token keeps its reach", () => {
  test("every table of the main schema, as before; croft's own schema and files are still refused", async () => {
    for (const sql of ["SELECT * FROM payments", "SELECT * FROM secrets", "SELECT * FROM orders JOIN payments USING (id)", "SHOW TABLES"]) {
      expect(refused(await decision(sql, TOKEN)), sql).toBe(false);
    }
    for (const sql of ["SELECT * FROM _croft.assets", "SELECT * FROM 'files/x.csv'", "SELECT * FROM duckdb_tables()", "SELECT getenv('HOME')"]) {
      expect(refused(await decision(sql, TOKEN)), sql).toBe(true);
    }
  });

  test("SHOW TABLES FROM <schema> is refused for the token too: it listed croft's own tables", async () => {
    for (const sql of ["SHOW TABLES FROM _croft", "SHOW TABLES FROM memory", "SHOW TABLES FROM memory._croft", "SELECT * FROM (SHOW TABLES FROM _croft)"]) {
      const e = await decision(sql, TOKEN);
      expect(refused(e), sql).toBe(true);
      expect((e as CroftError).code).toBe("QUERY_PATH_DENIED");
      expect((e as CroftError).message).toContain("SHOW TABLES FROM");
    }
  });
});

describe("the catalog snapshot", () => {
  test("holds the main schema's tables and views of the connection's database, and the names a CTE may not take", async () => {
    expect(catalog.current).toBe("memory");
    expect([...catalog.userTables].sort()).toEqual(["customers", "orders", "payments", "secrets"]);
    expect(catalog.userTables.has("assets")).toBe(false); // _croft's table
    expect(catalog.others.has("duckdb_tables")).toBe(true);
  });

  test("temporary tables and tables of other databases are not user tables", () => {
    const row = (o: object) => ({ current: "wh", name: "t", kind: "table" as const, database: "wh", schema: "main", temporary: false, internal: false, ...o });
    const c = catalogOf([row({}), row({ name: "tmp", temporary: true }), row({ name: "o", database: "other" }), row({ name: "s", schema: "x" })], "wh");
    expect([...c.userTables]).toEqual(["t"]);
  });
});
