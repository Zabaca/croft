// Generated input types against a real TypeScript compiler (DESIGN.md §3e, §11 phase 5). A real `croft run`
// (a child process, off a TTY) builds an ingest, an SQL asset with most DuckDB types, and a TS transform that
// writes down, as a TS literal, every row rows() handed it. The run writes .croft/types, and tsc then checks that
// literal against the generated row types: the types are what a transform is really handed, column for column.
// The same project shows that a column an input does not have is a type error, that untyped code and explicit row
// types still compile, and that a project without the folder compiles as before. croft preview writes the types of
// an asset it built that was never run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupProjects, cli, cliEnv, makeProject, PKG, writeFiles } from "../run/testkit.ts";

let root: string;
let home: string;

/** The CLI in a child process, with the tripwires and a HOME of its own. */
const croft = (argv: string[]) => cli(root, argv, cliEnv({ HOME: home, CROFT_HOME: join(home, ".croft"), CROFT_FORBID_OS_JOBS: "1", CROFT_NOTIFY_DRY: "1" }));

/** The project's own tsc --noEmit (typescript linked in, as bun install leaves it). */
function tsc(): { exit: number; out: string } {
  const r = Bun.spawnSync([process.execPath, join(root, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "--pretty", "false"], {
    cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe",
  });
  return { exit: r.exitCode ?? -1, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}

/** The tsconfig croft init writes, with .croft/types included (agent/templates.ts tsconfigJson). */
const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "esnext", module: "esnext", moduleResolution: "bundler", strict: true, skipLibCheck: true, noEmit: true,
    allowImportingTsExtensions: true, resolveJsonModule: true, types: ["bun"],
  },
  include: ["assets", "lib", ".croft/types"],
}, null, 2);

const EVENTS_TS = `import { ingest } from "@zabaca/croft";
export default ingest({
  key: "id",
  async *rows() {
    yield [
      { id: 1, name: "a", amount: 1.5, big: 2n ** 60n, at: "2026-03-01T07:30:00Z", day: "2026-03-01", meta: { a: 1, b: [1, 2] }, tags: ["x"], flag: true, nothing: null },
      { id: 2, name: null, amount: null, big: 5, at: null, day: null, meta: null, tags: [], flag: false, nothing: null },
    ];
  },
});
`;

const ALL_TYPES_SQL = `-- key: id
SELECT 1 AS id, true AS b, 7::TINYINT AS ti, 70000::INTEGER AS i, 9007199254740993::BIGINT AS big, 3::BIGINT AS small_big,
  18446744073709551615::UBIGINT AS ub, 170141183460469231731687303715884105727::HUGEINT AS huge, 1.5::FLOAT AS f,
  2.25::DOUBLE AS d, 12.34::DECIMAL(10,2) AS dec_small, 123456789012345678.91::DECIMAL(20,2) AS dec_wide,
  12345::DECIMAL(38,0) AS dec38, 'x' AS s, '{"a": 1, "n": 12345678901234567890}'::JSON AS j, DATE '2026-01-02' AS day,
  TIME '10:11:12' AS tod, TIMESTAMP '2026-01-02 03:04:05.123456' AS ts, TIMESTAMPTZ '2026-01-02 03:04:05+00' AS tstz,
  '2b1e8b7c-0000-4000-8000-000000000001'::UUID AS u, '\\xAA'::BLOB AS bl, INTERVAL 3 DAY AS iv,
  [1, NULL]::INTEGER[] AS ints, ['a', 'b']::VARCHAR[] AS strs, {'a': 1, 'b': 'x'} AS st, MAP {'k': 1} AS m
UNION ALL
SELECT 2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL
`;

/** A transform that writes every row of its inputs down as a TS literal typed with the generated row type. */
const CAPTURE_TS = (file: string) => `import { writeFileSync } from "node:fs";
import { transform } from "@zabaca/croft";

const lit = (v: unknown): string => {
  if (v === null) return "null";
  if (typeof v === "bigint") return \`\${v}n\`;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return \`[\${v.map(lit).join(", ")}]\`;
  if (typeof v === "object") return \`{ \${Object.entries(v).map(([k, x]) => \`\${JSON.stringify(k)}: \${lit(x)}\`).join(", ")} }\`;
  return "undefined";
};

export default transform({
  inputs: ["events", "all_types"],
  async *rows({ rows }) {
    const out = ['import type { InputRow } from "@zabaca/croft";'];
    for (const input of ["events", "all_types"]) {
      const items: string[] = [];
      for await (const r of rows(input)) {
        // Every column the row has: its enumerable ones, and croft's _loaded_at, which it keeps out of { ...r }.
        const cols = [...Object.keys(r), "_loaded_at"];
        items.push(\`  { \${cols.map((c) => \`\${JSON.stringify(c)}: \${lit(r[c])}\`).join(", ")} }\`);
      }
      out.push(\`export const \${input}: InputRow<"\${input}">[] = [\\n\${items.join(",\\n")},\\n];\`);
    }
    writeFileSync(${JSON.stringify(file)}, \`\${out.join("\\n")}\\n\`);
    yield { id: 1 };
  },
});
`;

/** Code written before generated types, against Row: untyped rows("x") with casts, explicit row types, a helper
 *  taking Row, spread, query with and without a row type. It compiles with the generated types and without them. */
const LEGACY_TS = `import { type Row, transform } from "@zabaca/croft";

type Event = { id: number; name: string | null };
const keep = (r: Row) => r;

export default transform({
  inputs: ["events", "all_types"],
  async *rows({ rows, newRows, query }) {
    for await (const e of rows("events")) {
      const id = Number(e.id);
      const when = e.at === null ? null : new Date(e.at as string);
      const meta = e.meta as { a?: number } | null;
      yield { ...e, id, name: String(e.name ?? "none"), when: when?.toISOString() ?? null, a: meta?.a ?? null, whole: keep(e), json: JSON.stringify(e) };
    }
    for await (const e of newRows("events")) yield { id: e.id as number, amount: ((e.amount as number | null) ?? 0) * 2, keys: Object.keys(e).join(",") };
    for await (const e of rows<Event>("events")) yield { id: e.id, upper: e.name?.toUpperCase() ?? "" };
    for await (const e of rows<Row>("events")) yield { id: e.id, anything: e.whatever };
    for await (const e of rows("not_an_asset")) yield { any: e.column };
    const col: string = "name";
    for await (const e of rows<Row>("events")) yield { v: e[col] };
    const counted = await query<{ n: number }>("SELECT count(*) AS n FROM events");
    const loose = await query("SELECT * FROM all_types");
    yield { n: counted[0]?.n, x: loose[0]?.x };
  },
});
`;

/** Code that uses the generated types: no casts for a column's own type, query<"x">, InputRow. */
const TYPED_TS = `import { type InputRow, transform } from "@zabaca/croft";

export default transform({
  inputs: ["events", "all_types"],
  async *rows({ rows, newRows, query }) {
    for await (const e of rows("events")) {
      const when = e.at === null ? null : new Date(e.at);
      yield { id: e.id, name: e.name?.toUpperCase() ?? null, when: when?.toISOString() ?? null, flag: e.flag === true };
    }
    for await (const e of newRows("events")) yield { id: e.id, amount: (e.amount ?? 0) * 2 };
    const typed = await query<"all_types">("SELECT * FROM all_types");
    const t: InputRow<"all_types"> | undefined = typed[0];
    if (t) yield { big: typeof t.big === "bigint" ? t.big.toString() : t.big, tags: t.strs?.join(",") ?? "", huge: t.huge?.toString() ?? null };
  },
});
`;

/** Reads columns the inputs do not have. */
const WRONG_TS = `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["events"],
  async *rows({ rows, query }) {
    for await (const e of rows("events")) {
      yield { n: e.nam };
      const { author } = e;
      const col: string = "name";
      yield { author, dyn: e[col] };
    }
    const typed = await query<"all_types">("SELECT * FROM all_types");
    yield { x: typed[0]?.gone };
  },
});
`;

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "croft-types-home-")));
  root = makeProject({
    "assets/events.ts": EVENTS_TS,
    "assets/all_types.sql": ALL_TYPES_SQL,
    "tsconfig.json": TSCONFIG,
  });
  writeFiles(root, { "assets/capture.ts": CAPTURE_TS(join(root, "lib", "captured.ts")) });
  mkdirSync(join(root, "lib"), { recursive: true });
  const nm = join(root, "node_modules");
  symlinkSync(join(PKG, "node_modules", "typescript"), join(nm, "typescript"));
  mkdirSync(join(nm, "@types"), { recursive: true });
  symlinkSync(join(PKG, "node_modules", "@types", "bun"), join(nm, "@types", "bun"));
  const r = await croft(["run", "--json"]);
  if (r.code !== 0) throw new Error(`croft run failed (${r.code}):\n${r.stdout}\n${r.stderr}`);
}, 120_000);

afterAll(() => {
  cleanupProjects();
  rmSync(home, { recursive: true, force: true });
});

const types = (f: string) => readFileSync(join(root, ".croft", "types", f), "utf8");

describe("a real run writes .croft/types", () => {
  test("one file per built asset, and the index", () => {
    expect(readdirSync(join(root, ".croft", "types")).sort()).toEqual(["all_types.d.ts", "capture.d.ts", "events.d.ts", "index.d.ts"]);
    const events = types("events.d.ts");
    expect(events).toContain("export type EventsRow = {");
    expect(events).toContain("  id: number | bigint;\n");
    expect(events).toContain("  big: number | bigint | null;\n");
    expect(events).toContain("  at: string | null;\n");
    expect(events).toContain("  meta: unknown;\n");
    // NULL in every row so far: its type is not settled.
    expect(events).toContain("NULL in every row so far");
    expect(events).toContain("  nothing: unknown;\n");
    expect(events).toContain("  _loaded_at: string;\n");
    expect(types("index.d.ts")).toContain(`    events: import("./events.js").EventsRow;\n`);
  });
});

describe("tsc with the generated types", () => {
  test("what rows() really handed a transform type-checks as its generated row type; code written for Row still compiles", () => {
    expect(readFileSync(join(root, "lib", "captured.ts"), "utf8")).toContain("170141183460469231731687303715884105727n");
    writeFiles(root, { "lib/legacy.ts": LEGACY_TS, "lib/typed.ts": TYPED_TS });
    try {
      const r = tsc();
      expect(r.out).toBe("");
      expect(r.exit).toBe(0);
    } finally {
      rmSync(join(root, "lib", "legacy.ts"));
      rmSync(join(root, "lib", "typed.ts"));
    }
  }, 60_000);

  test("a column the input does not have is a type error, named by the input's row type", () => {
    writeFiles(root, { "lib/wrong.ts": WRONG_TS });
    try {
      const r = tsc();
      expect(r.exit).toBe(2);
      const lines = r.out.trim().split("\n").filter((l) => l.startsWith("lib/"));
      expect(lines).toEqual([
        "lib/wrong.ts(6,20): error TS2551: Property 'nam' does not exist on type 'EventsRow'. Did you mean 'name'?",
        "lib/wrong.ts(7,15): error TS2339: Property 'author' does not exist on type 'EventsRow'.",
        "lib/wrong.ts(9,28): error TS7053: Element implicitly has an 'any' type because expression of type 'string' can't be used to index type 'EventsRow'.",
        "lib/wrong.ts(12,26): error TS2339: Property 'gone' does not exist on type 'AllTypesRow'.",
      ]);
    } finally {
      rmSync(join(root, "lib", "wrong.ts"));
    }
  }, 60_000);

  test("without .croft/types (before the first run) every input row is a Row, and the same code compiles", () => {
    const dir = join(root, ".croft", "types");
    const aside = join(root, ".croft", "types-aside");
    renameSync(dir, aside);
    writeFiles(root, { "lib/legacy.ts": LEGACY_TS });
    try {
      const r = tsc();
      expect(r.out).toBe("");
      expect(r.exit).toBe(0);
    } finally {
      rmSync(join(root, "lib", "legacy.ts"));
      renameSync(aside, dir);
    }
  }, 60_000);
});

describe("regeneration", () => {
  test("croft preview writes the type of an asset it built that was never run", async () => {
    writeFiles(root, { "assets/fresh.sql": "SELECT 1 AS n, 'x' AS label\n" });
    const r = await croft(["preview", "fresh", "--json"]);
    expect(r.code).toBe(0);
    const fresh = types("fresh.d.ts");
    expect(fresh).toContain("From the columns the last croft preview gave it; it has never been built.");
    expect(fresh).toContain("  n: number | null;\n  /** VARCHAR */\n  label: string | null;\n");
    expect(types("index.d.ts")).toContain("fresh: import(");
  }, 60_000);

  test("a run that adds a column rewrites its input's type", async () => {
    writeFiles(root, { "assets/events.ts": EVENTS_TS.replace('flag: true, nothing: null }', 'flag: true, nothing: null, added: "new" }') });
    const r = await croft(["run", "events", "--only", "--json"]);
    expect(r.code).toBe(0);
    expect(types("events.d.ts")).toContain("  added: string | null;\n");
  }, 60_000);
});
