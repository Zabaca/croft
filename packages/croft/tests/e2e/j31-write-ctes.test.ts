// Journey 31: SQL that writes or exports from inside a SELECT (DESIGN.md §5 "Sandboxing every DuckDB instance", D112).
// DuckDB 2.0 parses `WITH x AS (DELETE … RETURNING *) SELECT …` and `WITH x AS (COPY … TO …) SELECT …` as one
// SELECT, and runs them; COPY writes files even on a READ_ONLY connection. Each statement of the battery goes
// through every way croft runs user SQL: croft query, an SQL asset (validate and run), a `-- check:` rule, a TS
// transform's check, `croft delete --where`, croft serve over HTTP and ctx.query. Each is refused, no file appears,
// the warehouse's WAL is as it was and the table keeps its rows.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanupAll, codes, type Envelope, initProject, type Project, show, tempDir, until } from "./harness.ts";

afterAll(cleanupAll);

const ORDERS = `import { ingest } from "@zabaca/croft";

export default ingest({
  key: "id",
  rows() {
    return [{ id: 1, amount: 10 }, { id: 2, amount: 20 }, { id: 3, amount: 30 }];
  },
}, 180_000);
`;

let p: Project;
let outside: string;
beforeAll(async () => {
  ({ project: p } = await initProject());
  outside = tempDir("croft-e2e-outside-");
  p.write("assets/orders.ts", ORDERS);
  const r = await p.json(["run", "orders"]);
  if (r.code !== 0) throw new Error(show(r));
}, 180_000);

/** Every statement of the battery; `{out}` is a file the statement would write. */
function battery(out: (name: string) => string): string[] {
  const copy = (name: string) => `COPY (SELECT 1 AS x) TO '${out(name)}'`;
  return [
    "WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x",
    "WITH x AS (INSERT INTO orders VALUES (9, 9) RETURNING *) SELECT * FROM x",
    "WITH x AS (UPDATE orders SET amount = 0 RETURNING *) SELECT * FROM x",
    "WITH x AS (INSERT INTO orders VALUES (9, 9) RETURNING *) SELECT 1 AS n",
    `WITH x AS (${copy("files")}) SELECT 1 AS n`,
    `WITH x AS (${copy("croft")}) SELECT 1 AS n`,
    `WITH x AS (${copy("wal")}) SELECT 1 AS n`,
    `WITH x AS (${copy("outside")}) SELECT 1 AS n`,
    "SELECT * FROM (WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x) s",
    "SELECT (WITH x AS (DELETE FROM orders RETURNING id) SELECT max(id) FROM x) AS n",
    "SELECT * FROM orders WHERE id IN (WITH x AS (DELETE FROM orders RETURNING id) SELECT id FROM x)",
    "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 2), x AS (DELETE FROM orders RETURNING *) SELECT * FROM r, x",
  ];
}

function targets(): Record<string, string> {
  return {
    files: join(p.root, "files", "pwned.csv"),
    croft: join(p.stateDir, "pwned.csv"),
    wal: join(p.root, "warehouse.duckdb.wal"),
    outside: join(outside, "pwned.csv"),
  };
}

function fingerprint(): { wal: string; files: string[] } {
  const wal = join(p.root, "warehouse.duckdb.wal");
  return {
    wal: existsSync(wal) ? `${statSync(wal).size}:${readFileSync(wal).toString("base64")}` : "none",
    files: [join(p.root, "files"), p.stateDir, outside].flatMap((d) => (existsSync(d) ? readdirSync(d).filter((f) => f.startsWith("pwned")) : [])),
  };
}

async function unchanged(before: ReturnType<typeof fingerprint>, what: string): Promise<void> {
  expect(fingerprint(), what).toEqual(before);
  for (const t of Object.values(targets())) if (!t.endsWith(".wal")) expect(existsSync(t), `${what}: ${t}`).toBe(false);
  expect(await p.rows("select id, amount from orders order by id"), what).toEqual([{ id: 1, amount: 10 }, { id: 2, amount: 20 }, { id: 3, amount: 30 }]);
}

// SQL_SYNTAX: DuckDB itself refuses DML inside a recursive CTE. USAGE_ERROR: croft delete reports a bad --where so.
const REFUSED = ["QUERY_NOT_SELECT", "SQL_NOT_SELECT", "CHECK_INVALID", "QUERY_PATH_DENIED", "SQL_SYNTAX", "USAGE_ERROR"];
const refused = (env: Envelope) => codes(env).some((c) => REFUSED.includes(c));

test("croft query refuses every statement", async () => {
  const t = targets();
  for (const sql of battery((n) => t[n]!)) {
    const before = fingerprint();
    const r = await p.json(["query", sql]);
    expect([sql, r.code, refused(r.json)], show(r)).toEqual([sql, 2, true]);
    await unchanged(before, sql);
  }
}, 180_000);

test("an SQL asset: validate refuses it, and run builds nothing", async () => {
  const t = targets();
  for (const sql of battery((n) => t[n]!)) {
    const before = fingerprint();
    p.write("assets/attack.sql", `${sql}\n`);
    const v = await p.json(["validate", "attack"]);
    expect([sql, v.code, refused(v.json)], show(v)).toEqual([sql, 2, true]);
    const r = await p.json(["run", "attack"]);
    expect([sql, r.code], show(r)).toEqual([sql, 2]);
    await unchanged(before, sql);
    p.remove("assets/attack.sql");
  }
}, 180_000);

test("a -- check: rule and a TS check refuse it", async () => {
  const t = targets();
  for (const sql of battery((n) => t[n]!)) {
    const before = fingerprint();
    const rule = `(SELECT count(*) FROM (${sql}) q) >= 0`;
    p.write("assets/checked.sql", `-- check: ${rule}\nSELECT id FROM orders\n`);
    const v = await p.json(["validate", "checked"]);
    expect([sql, refused(v.json)], show(v)).toEqual([sql, true]);
    p.remove("assets/checked.sql");
    p.write("assets/checked_ts.ts", `import { transform } from "@zabaca/croft";
export default transform({ inputs: ["orders"], checks: [${JSON.stringify(rule)}], async rows(ctx) { return []; } });
`);
    const w = await p.json(["validate", "checked_ts"]);
    expect([sql, refused(w.json)], show(w)).toEqual([sql, true]);
    p.remove("assets/checked_ts.ts");
    await unchanged(before, sql);
  }
}, 180_000);

test("croft delete --where refuses it", async () => {
  const t = targets();
  for (const sql of battery((n) => t[n]!)) {
    const before = fingerprint();
    const r = await p.json(["delete", "orders", "--where", `id IN (SELECT 1 FROM (${sql}) q)`]);
    expect([sql, r.code, refused(r.json)], show(r)).toEqual([sql, 2, true]);
    await unchanged(before, sql);
  }
}, 180_000);

test("ctx.query in a TS transform refuses it", async () => {
  const t = targets();
  for (const sql of battery((n) => t[n]!)) {
    const before = fingerprint();
    p.write("assets/sneaky.ts", `import { transform } from "@zabaca/croft";
export default transform({ inputs: ["orders"], async *rows(ctx) { yield* await ctx.query(${JSON.stringify(sql)}); } });
`);
    const r = await p.json(["run", "sneaky"]);
    expect([sql, r.code], show(r)).not.toEqual([sql, 0]);
    expect(JSON.stringify(r.json), sql).toMatch(/QUERY_NOT_SELECT|QUERY_PATH_DENIED|SQL_SYNTAX/);
    p.remove("assets/sneaky.ts");
    await unchanged(before, sql);
  }
}, 180_000);

test("croft serve refuses it over HTTP", async () => {
  const t = targets();
  const server = p.start(["serve", "--port", "0"]);
  const file = join(p.stateDir, "serve.json");
  try {
    await until(() => existsSync(file) || server.proc.exitCode !== null, 30_000);
    if (!existsSync(file)) throw new Error(`croft serve did not start\n${show(await server.done)}`);
    const rec = JSON.parse(readFileSync(file, "utf8")) as { url: string; token: string };
    for (const sql of battery((n) => t[n]!)) {
      const before = fingerprint();
      const res = await fetch(`${rec.url}/query`, {
        method: "POST", headers: { Authorization: `Bearer ${rec.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ sql }),
      });
      const body = (await res.json()) as Envelope;
      expect([sql, res.status >= 400, refused(body)], JSON.stringify(body)).toEqual([sql, true, true]);
      await unchanged(before, sql);
    }
  } finally {
    server.proc.kill();
    await server.done;
  }
}, 180_000);
