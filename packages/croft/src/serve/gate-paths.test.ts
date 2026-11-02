// One gate, every path (option 06, slice 3, acceptance 4; DESIGN.md D123): croft's existing gate cases (hidden writes, COPY, file
// reads, settings, globs) are sent through every way croft runs user SQL, and each must be refused on every one of them:
// `croft query`, an SQL asset, a `-- check:` rule, croft serve over HTTP with the app token and over HTTP with a key. They
// all reach the same synchronous decision (sql/gate-core.ts decide()), so a case one path refuses another cannot let through.
// A positive control says each path still runs a plain read. A key works only in server mode (D128), so its path is server mode's
// readers' process; without the extension files it is left out locally, and the tests fail in CI.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli } from "../cli/commands/inspect-testkit.ts";
import { type Rig, Rigs, TOKEN } from "./key-rig-testkit.ts";
import { extensionFiles } from "./readers-testkit.ts";

const { ext } = extensionFiles("gate-paths.test");
const rigs = new Rigs();
let r: Rig;
/** server mode's rig, where a key can run; absent locally without the extension files */
let kr: Rig | undefined;
let root: string;
let key: string;
beforeAll(async () => {
  r = await rigs.file();
  root = r.p.root;
  if (ext.ready) {
    kr = await rigs.readers(ext.dir);
    key = kr.key("paths-key");
  }
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "files", "x.csv"), "a,b\n1,2\n");
}, 60_000);
afterAll(() => rigs.close());

/** The existing gate's cases, by what they try. Each is refused on every path. */
const CASES: Record<string, string> = {
  "a hidden write": "WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x",
  "a hidden insert": "WITH x AS (INSERT INTO orders VALUES (1, 1, 'x') RETURNING *) SELECT count(*) FROM x",
  "a COPY inside a WITH": "WITH x AS (COPY (SELECT 1 AS a) TO 'pwned.csv') SELECT 1",
  "a statement that is not a SELECT": "DELETE FROM orders",
  "two statements": "SELECT 1; SELECT 2",
  "reading the state folder": "SELECT * FROM read_text('.croft/runs.sqlite')",
  "reading the open database": "SELECT * FROM read_blob('warehouse.duckdb')",
  "reading a file outside the project": "SELECT * FROM read_text('/etc/hosts')",
  "reading a URL": "SELECT * FROM read_csv('https://example.com/x.csv')",
  "a path as a table": "SELECT * FROM '/etc/hosts'",
  "a glob over the state folder": "SELECT * FROM glob('.croft/*')",
  "a glob outside the project": "SELECT * FROM glob('/etc/*')",
  "a path that is not a literal": "SELECT * FROM read_csv('files/' || 'x.csv')",
  "a hidden table by name": "SELECT * FROM query_table('orders')",
  "SQL in a string": "SELECT * FROM query('SELECT 1')",
  "the log": "SELECT write_log('x')",
  "a sequence": "SELECT setval('s', 1)",
  "an arbitrary table function": "SELECT * FROM checkpoint()",
};

const path = {
  query: async (sql: string) => {
    const x = await cli(["query", sql, "--json"], { cwd: root });
    return { refused: x.exit === 2, how: x.stdout.slice(0, 300) };
  },
  asset: async (sql: string) => {
    writeFileSync(join(root, "assets", "attack.sql"), `${sql}\n`);
    try {
      const x = await cli(["validate", "attack", "--json"], { cwd: root });
      return { refused: x.exit === 2, how: x.stdout.slice(0, 300) };
    } finally {
      rmSync(join(root, "assets", "attack.sql"), { force: true });
    }
  },
  check: async (sql: string) => {
    writeFileSync(join(root, "assets", "checked.sql"), `-- check: (SELECT count(*) FROM (${sql}) q) >= 0\nSELECT id FROM orders\n`);
    try {
      const x = await cli(["validate", "checked", "--json"], { cwd: root });
      return { refused: x.exit === 2 || /CHECK_INVALID/.test(x.stdout), how: x.stdout.slice(0, 300) };
    } finally {
      rmSync(join(root, "assets", "checked.sql"), { force: true });
    }
  },
  token: async (sql: string) => {
    const x = await r.call(TOKEN, sql);
    return { refused: x.status >= 400, how: JSON.stringify(x.json).slice(0, 300) };
  },
  key: async (sql: string) => {
    const x = await kr!.call(key, sql);
    return { refused: x.status >= 400, how: JSON.stringify(x.json).slice(0, 300) };
  },
};

describe("the same cases, refused on every path", () => {
  for (const [what, sql] of Object.entries(CASES)) {
    test(what, async () => {
      for (const [name, run] of Object.entries(path).filter(([n]) => n !== "key" || kr)) {
        const x = await run(sql);
        expect([name, x.refused, x.how], `${name}: ${sql}`).toEqual([name, true, x.how]);
      }
      expect(existsSync(join(root, "pwned.csv")), what).toBe(false);
    }, 60_000);
  }

  test("a plain read still runs on the paths that run queries (an asset and a check are vetted, not run)", async () => {
    expect((await path.query("SELECT count(*) AS n FROM orders")).refused).toBe(false);
    expect((await path.token("SELECT count(*) AS n FROM orders")).refused).toBe(false);
    if (kr) expect((await path.key("SELECT count(*) AS n FROM orders")).refused).toBe(false);
  }, 60_000);
});
