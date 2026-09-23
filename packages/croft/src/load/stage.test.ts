import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import {
  canonicalJson, cleanColumnName, ColumnNamer, MANIFEST_FILE, parseJsonLossless, readStageManifest, STAGE_FILE,
  UnserializableError, writeStage, type StageOptions,
} from "./stage.ts";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "croft-stage-")));
const stage = (source: StageOptions["source"], o: Partial<StageOptions> = {}) =>
  writeStage({ dir: join(tmp(), "staging", "r_1", "a"), asset: "a", runId: "r_1", source, ...o });
const lines = (path: string) => readFileSync(path, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));

async function failure(p: Promise<unknown>): Promise<CroftError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
  throw new Error("expected a CroftError");
}

describe("lossless JSON (ctx.http)", () => {
  test("integers beyond ±2^53 become exact bigint; everything else is plain JSON.parse", () => {
    const v = parseJsonLossless(`{"safe":9007199254740991,"edge":9007199254740992,"plus1":9007199254740993,
      "int64":9223372036854775807,"uint64":18446744073709551615,"neg":-12345678901234567890,
      "nested":[{"id":123456789012345678901234567890}],"f":1.5,"e":1e20,"small":42}`) as Record<string, unknown>;
    expect(v.safe).toBe(9007199254740991);
    expect(v.edge).toBe(9007199254740992n);
    expect(v.plus1).toBe(9007199254740993n);
    expect(v.int64).toBe(9223372036854775807n);
    expect(v.uint64).toBe(18446744073709551615n);
    expect(v.neg).toBe(-12345678901234567890n);
    expect((v.nested as { id: unknown }[])[0]!.id).toBe(123456789012345678901234567890n);
    expect(v.f).toBe(1.5);
    expect(v.e).toBe(1e20); // written with an exponent: a double on purpose, not an integer literal
    expect(v.small).toBe(42);
  });

  test("plain JSON.parse would lose the digits; parse + canonicalJson keeps them", () => {
    const text = `{"id":12345678901234567890}`;
    expect(String((JSON.parse(text) as { id: number }).id)).toBe("12345678901234567000");
    expect(canonicalJson(parseJsonLossless(text))).toBe(text);
  });
});

describe("canonicalJson", () => {
  test("object keys sorted at every depth, arrays in order, minified", () => {
    const a = canonicalJson({ b: 1, a: { z: [3, { y: 1, x: 2 }], m: null } });
    const b = canonicalJson({ a: { m: null, z: [3, { x: 2, y: 1 }] }, b: 1 });
    expect(a).toBe(`{"a":{"m":null,"z":[3,{"x":2,"y":1}]},"b":1}`);
    expect(b).toBe(a);
    expect(canonicalJson({ 10: "a", 9: "b", x: "c" })).toBe(`{"10":"a","9":"b","x":"c"}`); // code-unit order
  });

  test("bigint as exact digits, Date as an ISO instant, toJSON honored, boxed values unwrapped", () => {
    expect(canonicalJson({ n: 2n ** 64n - 1n, m: -(2n ** 70n) })).toBe(`{"m":-1180591620717411303424,"n":18446744073709551615}`);
    expect(canonicalJson(new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 6)))).toBe(`"2024-01-02T03:04:05.006Z"`);
    expect(canonicalJson({ toJSON: () => ({ b: 1, a: 2 }) })).toBe(`{"a":2,"b":1}`);
    expect(canonicalJson([new Number(1), new String("s"), new Boolean(false)])).toBe(`[1,"s",false]`);
  });

  test("undefined properties are omitted and undefined array items are null, as in JSON", () => {
    expect(canonicalJson({ a: undefined, b: [undefined, 1] })).toBe(`{"b":[null,1]}`);
  });

  test("-0 is 0 and non-ASCII text is kept", () => {
    expect(canonicalJson({ x: -0, y: "名前 café" })).toBe(`{"x":0,"y":"名前 café"}`);
  });

  const bad: [string, unknown, string][] = [
    ["Map", new Map([["a", 1]]), "Map"],
    ["Set", new Set([1]), "Set"],
    ["Uint8Array", new Uint8Array([1]), "Uint8Array"],
    ["Float64Array", new Float64Array([1]), "Float64Array"],
    ["ArrayBuffer", new ArrayBuffer(2), "ArrayBuffer"],
    ["DataView", new DataView(new ArrayBuffer(2)), "DataView"],
    ["function", () => 1, "function"],
    ["symbol", Symbol("s"), "symbol"],
    ["NaN", NaN, "NaN"],
    ["Infinity", Infinity, "Infinity"],
    ["-Infinity", -Infinity, "-Infinity"],
    ["invalid Date", new Date("nope"), "Invalid Date"],
    ["RegExp", /x/, "RegExp"],
    ["Error", new TypeError("x"), "TypeError"],
    ["Promise", Promise.resolve(1), "Promise (missing await?)"],
    ["lone surrogate", "a\ud800b", "string with an unpaired surrogate"],
  ];
  test.each(bad)("rejects %s", (_l, value, type) => {
    let err: unknown;
    try {
      canonicalJson({ outer: [{ inner: value }] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnserializableError);
    expect((err as UnserializableError).type).toBe(type);
    expect((err as UnserializableError).path).toBe("outer[0].inner");
  });

  test("rejects circular references", () => {
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    expect(() => canonicalJson(o)).toThrow(UnserializableError);
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe(`{"a":{"x":1},"b":{"x":1}}`); // repeats are fine
  });

  test("reports integers beyond ±2^53 that arrive as numbers", () => {
    const seen: [string, number][] = [];
    canonicalJson({ a: 2 ** 53 + 2, b: [2 ** 60], c: 9007199254740991, d: 1e21 }, { onUnsafeInteger: (p, v) => seen.push([p, v]) });
    expect(seen).toEqual([["a", 2 ** 53 + 2], ["b[0]", 2 ** 60], ["d", 1e21]]);
  });
});

describe("column names (§7)", () => {
  test.each([
    ["Amount ($)", "Amount"],
    ["first name", "first_name"],
    ["user-id", "user_id"],
    ["__a__b__", "a_b"],
    ["a..b", "a_b"],
    ["名前", "名前"],
    ["café", "café"],
    ["café", "café"], // decomposed → NFC
    ["Größe (cm)", "Größe_cm"],
    ["2fa_enabled", "col_2fa_enabled"],
    ["🎉party", "party"],
    ["ID", "ID"],
  ])("%p → %p", (raw, clean) => {
    expect(cleanColumnName(raw, 1)).toBe(clean);
  });

  test("an empty result becomes col_<position>", () => {
    expect(cleanColumnName("", 3)).toBe("col_3");
    expect(cleanColumnName("$$$", 1)).toBe("col_1");
    expect(cleanColumnName("___", 7)).toBe("col_7");
  });

  test("ID and Id land in one column with the first spelling", () => {
    const n = new ColumnNamer();
    expect(n.resolveRow(["ID", "name"])).toEqual(["ID", "name"]);
    expect(n.resolveRow(["Id", "Name"])).toEqual(["ID", "name"]);
    expect(n.columns).toEqual([{ name: "ID", sourceName: "ID" }, { name: "name", sourceName: "name" }]);
    expect(n.warnings).toEqual([]);
  });

  test("keys resolve case-insensitively to the stored spelling, and by stored source name", () => {
    const n = new ColumnNamer([{ name: "Id", sourceName: "Id" }, { name: "Amount", sourceName: "Amount ($)" }]);
    expect(n.resolveRow(["ID", "Amount ($)", "AMOUNT_USD"])).toEqual(["Id", "Amount", "AMOUNT_USD"]);
    expect(n.columns.map((c) => c.name)).toEqual(["Id", "Amount", "AMOUNT_USD"]);
  });

  test("two keys of one row that collide: the later one gets _2, with a warning", () => {
    const n = new ColumnNamer([], "a");
    expect(n.resolveRow(["Id", "id", "ID"])).toEqual(["Id", "id_2", "ID_3"]);
    expect(n.resolveRow(["id"])).toEqual(["id_2"]); // stable for the rest of the batch
    expect(n.warnings.map((w) => [w.code, w.severity])).toEqual([["DUPLICATE_OUTPUT_COLUMN", "warning"], ["DUPLICATE_OUTPUT_COLUMN", "warning"]]);
    expect(n.warnings[0]!.message).toContain(`"id" is stored as id_2`);
  });

  test("Amount ($) and Amount in one row: the owner of the stored column keeps it", () => {
    const n = new ColumnNamer([{ name: "Amount", sourceName: "Amount" }]);
    expect(n.resolveRow(["Amount ($)", "Amount"])).toEqual(["Amount_2", "Amount"]);
  });

  test("a stored _2 column is not reused for a new collision", () => {
    const n = new ColumnNamer([{ name: "x", sourceName: "x" }, { name: "x_2", sourceName: "other" }]);
    expect(n.resolveRow(["x", "X"])).toEqual(["x", "X_3"]);
  });

  test("source fields _loaded_at and _file are renamed", () => {
    const n = new ColumnNamer();
    expect(n.resolveRow(["_loaded_at", "_file", "_FILE_", "_croft_seq"])).toEqual(["_source_loaded_at", "_source_file", "FILE", "croft_seq"]);
    expect(n.columns[0]).toEqual({ name: "_source_loaded_at", sourceName: "_loaded_at" });
  });
});

describe("writeStage", () => {
  test("NDJSON parts of partRows rows, _croft_seq in yield order, manifest written last", async () => {
    async function* rows() {
      yield [{ id: 1 }, { id: 2 }, { id: 3 }];
      yield { id: 4, extra: "x" };
      yield [];
      yield [{ id: 5 }, { id: 6 }, { id: 7 }];
    }
    const m = await stage(rows(), { partRows: 3, sinceUsed: "2024-01-01T00:00:00Z" });
    expect(m.rows).toBe(7);
    expect(m.parts.map((p) => p.rows)).toEqual([3, 3, 1]);
    expect(m.parts.map((p) => p.path.split("/").at(-1))).toEqual(["part-0001.ndjson", "part-0002.ndjson", "part-0003.ndjson"]);
    expect(m.topLevelKeys).toEqual(["id", "extra"]);
    expect(m).toMatchObject({ runId: "r_1", asset: "a", complete: true, sinceUsed: "2024-01-01T00:00:00Z", capped: false, hasFile: false });
    const all = m.parts.flatMap((p) => lines(p.path));
    expect(all.map((l) => l._croft_seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(all[3]).toEqual({ _croft_seq: 4, id: 4, extra: "x" });
    const dir = join(m.parts[0]!.path, "..");
    expect(readdirSync(dir).sort()).toEqual([MANIFEST_FILE, "part-0001.ndjson", "part-0002.ndjson", "part-0003.ndjson"]);
    expect(readStageManifest(dir)).toEqual(m);
  });

  test("accepts sync iterables, arrays and promises of rows", async () => {
    function* gen() {
      yield { a: 1 };
      yield [{ a: 2 }];
    }
    expect((await stage(gen())).rows).toBe(2);
    expect((await stage([{ a: 1 }, { a: 2 }, { a: 3 }])).rows).toBe(3);
    expect((await stage(Promise.resolve([{ a: 1 }]))).rows).toBe(1);
  });

  test("an empty extraction still writes a manifest", async () => {
    const m = await stage((async function* () {})());
    expect(m).toMatchObject({ rows: 0, parts: [], topLevelKeys: [] });
    expect(existsSync(join(tmp(), "x"))).toBe(false);
  });

  test("canonical lines: nested key order never matters; top-level undefined is absent", async () => {
    const m = await stage([{ user: { login: "a", id: 1 }, u: undefined }, { user: { id: 1, login: "a" } }]);
    const [l1, l2] = readFileSync(m.parts[0]!.path, "utf8").trimEnd().split("\n");
    expect(l1).toBe(`{"_croft_seq":1,"user":{"id":1,"login":"a"}}`);
    expect(l2).toBe(`{"_croft_seq":2,"user":{"id":1,"login":"a"}}`);
    expect(m.topLevelKeys).toEqual(["user"]);
  });

  test("bigint reaches the file as exact digits", async () => {
    const m = await stage([{ id: 12345678901234567890n, neg: -9223372036854775809n }]);
    expect(readFileSync(m.parts[0]!.path, "utf8")).toBe(`{"_croft_seq":1,"id":12345678901234567890,"neg":-9223372036854775809}\n`);
  });

  test("cleaned and case-resolved names reach the file; source names are kept in the manifest", async () => {
    const m = await stage([{ "Amount ($)": 1, ID: 1, "": 2 }, { Id: 2, _loaded_at: "x", _file: "f.csv" }], {
      knownColumns: [{ name: "id", sourceName: "id" }],
    });
    expect(m.topLevelKeys).toEqual(["Amount", "id", "col_3", "_source_loaded_at", "_source_file"]);
    expect(m.columns).toContainEqual({ name: "Amount", sourceName: "Amount ($)" });
    expect(m.columns).toContainEqual({ name: "id", sourceName: "ID" });
    expect(lines(m.parts[0]!.path)[1]).toEqual({ _croft_seq: 2, id: 2, _source_loaded_at: "x", _source_file: "f.csv" });
  });

  test("rows tagged with STAGE_FILE carry the reserved _file column", async () => {
    const m = await stage([{ a: 1, [STAGE_FILE]: "files/sales/jan.json" }]);
    expect(m.hasFile).toBe(true);
    expect(lines(m.parts[0]!.path)[0]).toEqual({ _croft_seq: 1, a: 1, _file: "files/sales/jan.json" });
  });

  test("ROW_NOT_OBJECT names the row and the type", async () => {
    const cases: [unknown, string, string][] = [
      [[{ a: 1 }, 5], "number", "row 2"],
      [[{ a: 1 }, null], "null", "row 2"],
      [[[{ a: 1 }, [1, 2]]], "array", "row 2"],
      [[new Map()], "Map", "row 1"],
      [["text"], "string", "row 1"],
      [[undefined], "undefined", "row 1"],
    ];
    for (const [source, type, where] of cases) {
      const e = await failure(stage(source as Iterable<unknown>));
      expect(e.code).toBe("ROW_NOT_OBJECT");
      expect(e.problem.details).toMatchObject({ type });
      expect(e.message).toContain(where);
    }
    const e = await failure(stage(42 as unknown as Iterable<unknown>));
    expect(e.code).toBe("ROW_NOT_OBJECT");
  });

  test("UNSERIALIZABLE_VALUE names the row, the field and the type", async () => {
    const cases: [unknown, string, string][] = [
      [new Map(), "Map", "tags"],
      [new Set(["a"]), "Set", "tags"],
      [new Uint8Array(2), "Uint8Array", "tags"],
      [() => 1, "function", "tags"],
      [Symbol("x"), "symbol", "tags"],
      [NaN, "NaN", "tags"],
      [Infinity, "Infinity", "tags"],
      [-Infinity, "-Infinity", "tags"],
      [{ deep: [new Set()] }, "Set", "tags.deep[0]"],
    ];
    for (const [value, type, path] of cases) {
      const e = await failure(stage([{ id: 1 }, { id: 2, tags: value }]));
      expect(e.code).toBe("UNSERIALIZABLE_VALUE");
      expect(e.problem.details).toMatchObject({ row: 2, field: "tags", type, path });
      expect(e.problem.asset).toBe("a");
    }
  });

  test("UNSAFE_INTEGER warns once per column for numbers beyond ±2^53, never for bigint", async () => {
    const m = await stage([{ id: 2 ** 53 + 2, ok: 12345678901234567890n }, { id: 2 ** 60, n: { x: 2 ** 54 } }]);
    expect(m.warnings.map((w) => [w.code, w.details?.column, w.details?.count])).toEqual([
      ["UNSAFE_INTEGER", "id", 2],
      ["UNSAFE_INTEGER", "n", 1],
    ]);
    expect(m.warnings[1]!.details).toMatchObject({ row: 2, path: "n.x" });
  });

  test("the row cap stops extraction, closes the generator and reports capped", async () => {
    let closed = false;
    let capped = 0;
    async function* rows() {
      try {
        for (let page = 0; page < 100; page++) yield Array.from({ length: 10 }, (_, i) => ({ n: page * 10 + i }));
      } finally {
        closed = true;
      }
    }
    const m = await stage(rows(), { maxRows: 25, onCap: () => capped++ });
    expect(m.rows).toBe(25);
    expect(m.capped).toBe(true);
    expect(closed).toBe(true);
    expect(capped).toBe(1);
    expect(lines(m.parts[0]!.path).at(-1)).toEqual({ _croft_seq: 25, n: 24 });
    const exact = await stage([{ a: 1 }, { a: 2 }], { maxRows: 2 });
    expect(exact).toMatchObject({ rows: 2, capped: true });
  });

  test("an abort interrupts a generator that is waiting, with no manifest", async () => {
    const ac = new AbortController();
    async function* rows() {
      yield { a: 1 };
      await new Promise(() => {}); // a request that never answers
    }
    const dir = join(tmp(), "s");
    setTimeout(() => ac.abort(), 20);
    const e = await failure(writeStage({ dir, asset: "a", runId: "r", source: rows(), signal: ac.signal }));
    expect(e.code).toBe("INTERRUPTED");
    expect(existsSync(join(dir, MANIFEST_FILE))).toBe(false);
  });

  test("an abort whose reason is a CroftError rethrows it; an aborted signal stops at once", async () => {
    const ac = new AbortController();
    ac.abort(new CroftError("TIMEOUT", { message: "no progress for 10m", hint: "h" }));
    const e = await failure(stage([{ a: 1 }], { signal: ac.signal }));
    expect(e.code).toBe("TIMEOUT");
  });

  test("errors from the generator propagate unchanged", async () => {
    async function* rows() {
      yield { a: 1 };
      throw new Error("boom");
    }
    await expect(stage(rows())).rejects.toThrow("boom");
  });

  test("readStageManifest refuses an incomplete stage", () => {
    expect(() => readStageManifest(tmp())).toThrow(CroftError);
  });
});
