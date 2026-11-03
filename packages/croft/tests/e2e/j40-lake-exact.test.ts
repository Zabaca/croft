// Journey 40: a lake never silently changes a value (DESIGN.md D162; option 07, slice 4's follow-up). DuckLake 1.0 stores a HUGEINT or a UHUGEINT as a
// DOUBLE, an INTERVAL to the millisecond and a TIMETZ at offset 0 once a table's rows are in a Parquet file, so croft's lake writes refuse a column of
// those types by its TYPE (LAKE_VALUES_INEXACT, with the cast), and croft's own type inference makes an integer past 64 bits DECIMAL(38,0) instead of
// HUGEINT in a lake. The real croft CLI against a local lake (a SQLite catalog and a folder) and a Postgres catalog with an S3-compatible store:
//   a. a JSON ingest of integers past 64 bits (450 rows, so a Parquet file is written; and 5 rows, which stay in the catalog) lands as DECIMAL(38,0)
//      with every digit, and the maintenance pass, which moves the catalog's rows into files, changes none of them;
//   b. a CSV file ingest of the same, and a later batch with a fraction in such a column does not round it;
//   c. a SQL transform whose output has a HUGEINT, an INTERVAL, a TIMETZ or one inside a STRUCT is refused before anything is written, with the cast
//      that fixes it, and the fix runs; a pin to HUGEINT is refused the same way.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { lakeRigReady, type LakeRig, localLakeBlock, startLakeRig, useLake } from "../../src/db/lake-testkit.ts";
import { cleanupAll, initProject, type MockApi, mockApi, type Project, rawJson, show } from "./harness.ts";

const ready = lakeRigReady();
if (!ready.ready) console.warn(`[j40] SKIPPING the lake journeys: ${ready.skipReason}`);
const maybe = ready.ready ? describe : describe.skip;

let rig: LakeRig | undefined;
let api: MockApi;
beforeAll(async () => {
  api = mockApi();
  if (ready.ready) rig = await startLakeRig();
}, 120_000);
afterAll(async () => {
  api.stop();
  await rig?.stop();
  await cleanupAll();
});

const run = (p: Project, args: string[]): Promise<Awaited<ReturnType<Project["json"]>>> => p.json(args, { env: { CROFT_EXTENSION_DIR: ready.dir } });

const UNIT = 123456789012345678901n; // past 2^63: croft would make a HUGEINT of it
const big = (id: number): string => String(BigInt(id) * UNIT);
const bigAsset = (path: string) => `import { ingest } from "@zabaca/croft";
export default ingest({
  description: "integers past 64 bits",
  key: "id",
  async *rows({ http }) {
    const res = await http.get("${api.url}${path}");
    yield res.json<{ rows: Record<string, unknown>[] }>().rows;
  },
});
`;
const rows = (n: number, extra = ""): string => `{"rows":[${Array.from({ length: n }, (_, i) => `{"id":${i + 1},"amount":${big(i + 1)}${extra}}`).join(",")}]}`;

for (const kind of ["local", "postgres"] as const) {
  maybe(`journey 40 (${kind} lake): a lake never silently changes a value`, () => {
    let p: Project;
    let state = { many: rows(450), few: rows(5), fraction: "" };
    beforeAll(async () => {
      api.route("/many", () => rawJson(state.many));
      api.route("/few", () => rawJson(state.few));
      api.route("/fraction", () => rawJson(state.fraction));
      p = (await initProject(`exact-${kind}`)).project;
      if (kind === "local") useLake(p.root, { block: localLakeBlock() });
      else useLake(p.root, await rig!.lake());
      p.write("assets/many.ts", bigAsset("/many"));
      p.write("assets/few.ts", bigAsset("/few"));
    }, 120_000);

    const amounts = async (table: string): Promise<string[]> =>
      (await run(p, ["query", `select amount::VARCHAR as a from ${table} order by id`, "--limit", "1000"])).json.data.rows.map((r: { a: string }) => r.a);

    test("a. integers past 64 bits are DECIMAL(38,0) in a lake, with every digit, before and after the maintenance pass", async () => {
      for (const asset of ["many", "few"]) {
        const r = await run(p, ["run", asset]);
        expect(r.code, show(r)).toBe(0);
      }
      const described = await run(p, ["describe", "many"]);
      expect(described.json.data.columns.find((c: { name: string }) => c.name === "amount")).toMatchObject({ type: "DECIMAL(38,0)" });
      const want = (n: number) => Array.from({ length: n }, (_, i) => big(i + 1));
      expect(await amounts("many")).toEqual(want(450));
      expect(await amounts("few")).toEqual(want(5));
      // The pass flushes the rows the catalog holds into files, which is where a HUGEINT used to change.
      const pass = await run(p, ["maintain"]);
      expect(pass.code, show(pass)).toBe(0);
      expect(pass.json.data.status).toBe("ran");
      expect(pass.json.data.report.steps.find((s: { step: string }) => s.step === "flush")).toMatchObject({ status: "ok" });
      expect(await amounts("many")).toEqual(want(450));
      expect(await amounts("few")).toEqual(want(5));
      // And a second run (the merge rewrites nothing, and finds nothing changed).
      const again = await run(p, ["run", "many", "few"]);
      expect(again.code, show(again)).toBe(0);
      expect(again.json.data.steps.map((s: { rows: { added: number; updated: number } }) => [s.rows.added, s.rows.updated])).toEqual([[0, 0], [0, 0]]);
    }, 240_000);

    test("b. a CSV file of the same is DECIMAL(38,0) too, and a fraction arriving in such a column is not rounded into it", async () => {
      p.write("files/big.csv", `id,amount\n${Array.from({ length: 450 }, (_, i) => `${i + 1},${big(i + 1)}`).join("\n")}\n`);
      p.write("assets/big_csv.ts", `import { ingest } from "@zabaca/croft";\nexport default ingest({ description: "a csv of integers past 64 bits", file: "files/big.csv", key: "id" });\n`);
      const r = await run(p, ["run", "big_csv"]);
      expect(r.code, show(r)).toBe(0);
      expect((await run(p, ["describe", "big_csv"])).json.data.columns.find((c: { name: string }) => c.name === "amount")).toMatchObject({ type: "DECIMAL(38,0)" });
      expect(await amounts("big_csv")).toEqual(Array.from({ length: 450 }, (_, i) => big(i + 1)));
      // The API now sends a fraction in the column: the values stored are not changed to fit.
      state.fraction = `{"rows":[{"id":1,"amount":1.5}]}`;
      p.write("assets/few.ts", bigAsset("/fraction"));
      const clash = await run(p, ["run", "few"]);
      expect(clash.json.problems.concat(clash.json.data?.steps?.flatMap((s: { error?: unknown }) => (s.error ? [s.error] : [])) ?? []).map((x: { code: string }) => x.code).join(",")).toMatch(/TYPE_CONFLICT|TYPE_WIDENED/);
      expect((await amounts("few")).slice(1)).toEqual(Array.from({ length: 4 }, (_, i) => big(i + 2)));
    }, 240_000);

    test("c. a SQL transform with a column a lake would store inexactly is refused before anything is written, with the cast, and the fix runs", async () => {
      const writes = async () => (await run(p, ["query", "select count(*)::INT as n from _croft.writes"])).json.data.rows;
      const before = await writes();
      const cases: [string, string, string][] = [
        ["a HUGEINT", "range::HUGEINT AS v", "CAST(v AS DECIMAL(38,0)) AS v"],
        ["a UHUGEINT", "range::UHUGEINT AS v", "CAST(v AS VARCHAR) AS v"],
        ["an INTERVAL", "INTERVAL (range) MICROSECOND AS v", "CAST(v AS VARCHAR) AS v"],
        ["a TIMETZ", "TIMETZ '10:11:12+02' AS v", "CAST(v AS TIME) AS v"],
        ["a HUGEINT in a STRUCT", "{'h': range::HUGEINT} AS v", "to_json(v) AS v"],
        ["a HUGEINT[]", "[range::HUGEINT] AS v", "to_json(v) AS v"],
      ];
      for (const [what, expr, cast] of cases) {
        p.write("assets/odd.sql", `-- description: ${what}\n-- key: id\nSELECT range AS id, ${expr} FROM range(3)\n`);
        const r = await run(p, ["run", "odd"]);
        expect(r.code, `${what}\n${show(r)}`).not.toBe(0);
        const problem = r.json.problems?.[0] ?? r.json.data?.steps?.find((s: { error?: unknown }) => s.error)?.error;
        expect(problem, `${what}\n${show(r)}`).toMatchObject({ code: "LAKE_VALUES_INEXACT", effect: "nothing was written" });
        expect(problem.hint, what).toContain(cast);
        expect(await writes(), what).toEqual(before);
        expect((await run(p, ["query", "select count(*) from odd"])).code, what).not.toBe(0);
      }
      p.write("assets/odd.sql", "-- description: fixed\n-- key: id\nSELECT range AS id, CAST(range::HUGEINT * 123456789012345678901 AS DECIMAL(38, 0)) AS v FROM range(3)\n");
      const fixed = await run(p, ["run", "odd"]);
      expect(fixed.code, show(fixed)).toBe(0);
      expect((await run(p, ["query", "select v::VARCHAR as v from odd order by id"])).json.data.rows.map((r: { v: string }) => r.v)).toEqual(["0", big(1), big(2)]);
    }, 300_000);

    test("d. a pin to HUGEINT is refused the same way, and a pin to DECIMAL(38,0) is the fix", async () => {
      p.write("assets/pinned.ts", `import { ingest } from "@zabaca/croft";
export default ingest({
  description: "pinned HUGEINT",
  key: "id",
  columns: { amount: "HUGEINT" },
  async *rows({ http }) {
    const res = await http.get("${api.url}/few");
    yield res.json<{ rows: Record<string, unknown>[] }>().rows;
  },
});
`);
      state = { ...state, few: rows(5) };
      const r = await run(p, ["run", "pinned"]);
      expect(r.code, show(r)).not.toBe(0);
      const problem = r.json.problems?.[0] ?? r.json.data?.steps?.find((s: { error?: unknown }) => s.error)?.error;
      expect(problem).toMatchObject({ code: "LAKE_VALUES_INEXACT", effect: "nothing was written" });
      expect(problem.hint).toContain("DECIMAL(38,0)");
      p.edit("assets/pinned.ts", 'amount: "HUGEINT"', 'amount: "DECIMAL(38,0)"');
      const fixed = await run(p, ["run", "pinned"]);
      expect(fixed.code, show(fixed)).toBe(0);
      expect(await amounts("pinned")).toEqual(Array.from({ length: 5 }, (_, i) => big(i + 1)));
    }, 240_000);

    test("e. a Parquet file's UBIGINT (croft reads it as HUGEINT) is DECIMAL(38,0) too", async () => {
      const { DuckDBInstance } = await import("@duckdb/node-api");
      const db = await DuckDBInstance.create(":memory:");
      const c = await db.connect();
      await c.run(`COPY (SELECT range::INTEGER AS id, (18446744073709551615 - range)::UBIGINT AS u FROM range(450)) TO '${join(p.root, "files", "u.parquet")}' (FORMAT parquet)`);
      c.disconnectSync();
      db.closeSync();
      p.write("assets/u_parquet.ts", `import { ingest } from "@zabaca/croft";\nexport default ingest({ description: "a parquet file with a UBIGINT", file: "files/u.parquet", key: "id" });\n`);
      const r = await run(p, ["run", "u_parquet"]);
      expect(r.code, show(r)).toBe(0);
      expect((await run(p, ["describe", "u_parquet"])).json.data.columns.find((x: { name: string }) => x.name === "u")).toMatchObject({ type: "DECIMAL(38,0)" });
      const read = async () => (await run(p, ["query", "select u::VARCHAR as u from u_parquet order by id", "--limit", "1000"])).json.data.rows.map((x: { u: string }) => x.u);
      const got = await read();
      expect(got).toEqual(Array.from({ length: 450 }, (_, i) => String(18446744073709551615n - BigInt(i))));
      expect((await run(p, ["maintain"])).code).toBe(0);
      expect(await read()).toEqual(got);
    }, 240_000);

    test("f. a BIGINT column that later receives integers past 64 bits is rewritten as DECIMAL(38,0), every stored value kept", async () => {
      state = { ...state, few: `{"rows":[{"id":1,"amount":7},{"id":2,"amount":9007199254740993}]}` };
      p.write("assets/grow.ts", bigAsset("/few"));
      expect((await run(p, ["run", "grow"])).code).toBe(0);
      expect((await run(p, ["describe", "grow"])).json.data.columns.find((x: { name: string }) => x.name === "amount")).toMatchObject({ type: "BIGINT" });
      state = { ...state, few: `{"rows":[{"id":1,"amount":7},{"id":2,"amount":9007199254740993},{"id":3,"amount":${big(3)}}]}` };
      const r = await run(p, ["run", "grow"]);
      expect(r.code, show(r)).toBe(0);
      expect((await run(p, ["describe", "grow"])).json.data.columns.find((x: { name: string }) => x.name === "amount")).toMatchObject({ type: "DECIMAL(38,0)" });
      expect(await amounts("grow")).toEqual(["7", "9007199254740993", big(3)]);
      expect((await run(p, ["maintain"])).code).toBe(0);
      expect(await amounts("grow")).toEqual(["7", "9007199254740993", big(3)]);
    }, 240_000);
  });
}
