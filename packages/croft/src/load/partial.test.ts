// Monotone partial commits, the load half (DESIGN.md §8 "Large first loads"): the order check a cursor ingest's
// rows must pass before its parts may commit, and the staging that cuts the rows into parts and commits them.
// The run half (commits through the write lease, crashes, resume) is in run/ingest-partial.test.ts.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { cursorValues, monotoneTracker, PARTIAL_COMMIT, PARTIAL_COMMIT_MS, PARTIAL_COMMIT_ROWS, PartialCommitFailed, stageInParts,
  type StageInPartsOptions } from "./partial.ts";
import type { StageManifestFile } from "./stage.ts";

const rawJSON = (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
afterEach(() => {
  PARTIAL_COMMIT.rows = PARTIAL_COMMIT_ROWS;
  PARTIAL_COMMIT.ms = PARTIAL_COMMIT_MS;
});

describe("monotoneTracker: every cursor value is at least every value before it", () => {
  test("the defaults are 50,000 rows or 5 minutes", () => {
    expect(PARTIAL_COMMIT).toEqual({ rows: 50_000, ms: 300_000 });
  });

  test("integers: numbers, bigints and exact digits beyond 2^53 compare exactly; ties hold", () => {
    const t = monotoneTracker("integer", "s");
    expect(t.add([1, 2, 2, 3n])).toBe(true);
    expect(t.add([9007199254740992, 9007199254740993n, rawJSON("9007199254740994")])).toBe(true);
    expect(t.max).toBe("9007199254740994");
    expect(t.monotone).toBe(true);
    expect(t.broken).toBeNull();
    expect(t.add([9007199254740993n])).toBe(false);
    // Its position among every value added, NULLs included (one value per row: its row, from 0).
    expect(t.broken).toEqual({ value: "9007199254740993", after: "9007199254740994", index: 7 });
  });

  test("newest first breaks the order at the second value, and it stays broken", () => {
    const t = monotoneTracker("integer", null);
    expect(t.add([1782290000, 1782280000])).toBe(false);
    expect(t.add([1782300000, 1782400000])).toBe(false);
    expect(t.monotone).toBe(false);
    expect(t.broken).toEqual({ value: "1782280000", after: "1782290000", index: 1 });
    // The maximum is still the typed maximum of everything seen.
    expect(t.max).toBe("1782400000");
  });

  test("timestamps with offsets compare as instants, not as text", () => {
    const t = monotoneTracker("timestamp", null);
    // 08:00Z, then 09:30Z: later, although "…T09" sorts before "…T10" as text.
    expect(t.add(["2026-09-22T10:00:00+02:00", "2026-09-22T09:30:00Z", "2026-09-22T09:30:00.5Z", "2026-09-22 09:30:01+0000"])).toBe(true);
    expect(t.max).toBe("2026-09-22 09:30:01+0000");
    // 11:00+03 is 08:00Z: earlier.
    expect(t.add(["2026-09-22T11:00:00+03"])).toBe(false);
  });

  test("equal instants are ties: the maximum's text is the last one sent, as the cursor keeps it", () => {
    const t = monotoneTracker("timestamp", null);
    expect(t.add(["2026-09-22T10:00:00+02:00", "2026-09-22T08:00:00Z"])).toBe(true);
    expect(t.max).toBe("2026-09-22T08:00:00Z");
  });

  test("fractions compare exactly, beyond microseconds too", () => {
    const t = monotoneTracker("timestamp", null);
    expect(t.add(["2026-09-22T10:00:00.0000004Z", "2026-09-22T10:00:00.00000041Z", "2026-09-22T10:00:00.000001Z"])).toBe(true);
    expect(t.add(["2026-09-22T10:00:00.0000005Z"])).toBe(false);
  });

  test("Date objects are the instants they stand for", () => {
    const t = monotoneTracker(null, null);
    expect(t.add([new Date("2026-09-22T10:00:00Z"), "2026-09-22T10:00:01Z"])).toBe(true);
    expect(t.add([new Date("2026-09-22T09:00:00Z")])).toBe(false);
  });

  test("naive timestamps compare as wall clocks, and dates as their midnight among them (DATE widens to TIMESTAMP)", () => {
    const t = monotoneTracker(null, null);
    expect(t.add(["2026-09-22", "2026-09-22T00:00:00", "2026-09-22 10:00", "2026-09-23"])).toBe(true);
    expect(t.add(["2026-09-22T23:59:59"])).toBe(false);
  });

  test("kinds whose order depends on how the column is typed break it: date with instant, naive with instant", () => {
    const a = monotoneTracker(null, null);
    expect(a.add(["2026-09-22", "2026-09-23T00:00:00Z"])).toBe(false);
    const b = monotoneTracker("timestamp", null);
    expect(b.add(["2026-09-22T10:00:00", "2026-09-23T00:00:00Z"])).toBe(false);
  });

  test("a text cursor compares text in code point order, as DuckDB compares VARCHAR (bytes of UTF-8)", () => {
    const t = monotoneTracker("string", null);
    expect(t.add(["v0005", "v0006", "v0010"])).toBe(true);
    // Under UTF-16 code units "😀" (\uD83D…) sorts before "�"; as code points it comes after.
    expect(t.add(["v0010�", "v0010😀"])).toBe(true);
    expect(t.add(["v0009"])).toBe(false);
  });

  test("a text cursor does not read ISO text as instants: its order is the text's", () => {
    const t = monotoneTracker("string", null);
    expect(t.add(["2026-09-22T10:00:00+02:00", "2026-09-22T09:30:00Z"])).toBe(false);
  });

  test("before the first load fixes the type, the first value decides; another kind breaks the order", () => {
    const n = monotoneTracker(null, null);
    expect(n.add([1, 2])).toBe(true);
    expect(n.add(["3"])).toBe(false);
    const s = monotoneTracker(null, null);
    expect(s.add(["abc", "abd"])).toBe(true);
    expect(s.add(["2026-09-22T10:00:00Z"])).toBe(false);
    const i = monotoneTracker(null, null);
    expect(i.add(["2026-09-22T10:00:00Z"])).toBe(true);
    expect(i.add(["later"])).toBe(false);
  });

  test("NULL and missing values are skipped; values no cursor can hold break the order", () => {
    const t = monotoneTracker("integer", null);
    expect(t.add([null, undefined, 1, null, 2])).toBe(true);
    expect(t.max).toBe("2");
    for (const bad of [1.5, true, { a: 1 }, [1], "2", "2026-09-22"]) {
      const x = monotoneTracker("integer", null);
      expect(x.add([1, bad])).toBe(false);
    }
    const d = monotoneTracker("date", null);
    expect(d.add(["2026-02-28", "2026-02-30"])).toBe(false);
  });

  test("nothing seen: monotone, with no maximum", () => {
    const t = monotoneTracker("timestamp", null);
    expect(t.add([])).toBe(true);
    expect(t.max).toBeNull();
  });
});

describe("cursorValues", () => {
  test("the incremental field of each row: its own key, else the key that cleans to it", () => {
    expect(cursorValues([{ id: 1, updated_at: "a" }, { id: 2 }, { id: 3, updated_at: null }], "updated_at")).toEqual(["a", undefined, null]);
    expect(cursorValues([{ "Updated At": 5 }, { "updated-at": 6 }], "updated_at")).toEqual([5, 6]);
    // A row that is no object has no cursor (staging reports it).
    expect(cursorValues([7 as unknown as Record<string, unknown>, null as unknown as Record<string, unknown>], "x")).toEqual([undefined, undefined]);
  });
});

// ---------------------------------------------------------------------------------------------------------

function tempDir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "croft-partial-")));
  dirs.push(d);
  return d;
}

const lines = (m: StageManifestFile) => m.parts.flatMap((p) => readFileSync(p.path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));

interface Recorded { events: string[]; commits: { n: number; rows: number; ids: unknown[]; dir: string }[] }

function options(source: unknown, o: Partial<StageInPartsOptions> & { failCommit?: number } = {}): StageInPartsOptions & Recorded {
  const rec: Recorded = { events: [], commits: [] };
  const opts: StageInPartsOptions = {
    dir: join(tempDir(), "stage"), asset: "events", runId: "r_test", source, knownColumns: [], field: "ts",
    tracker: monotoneTracker("integer", null),
    commit: async (m, n) => {
      if (o.failCommit === n) throw new CroftError("CHECK_FAILED", { message: "part refused", hint: "fix the rows" });
      rec.events.push(`commit ${n}`);
      rec.commits.push({ n, rows: m.rows, ids: lines(m).map((r) => r.id), dir: m.parts[0]?.path ?? "" });
      return [...m.columns.map((c) => ({ name: c.name.toUpperCase() === "TS" ? "TS" : c.name, sourceName: c.sourceName }))];
    },
    rewind: async () => {
      rec.events.push("rewind");
    },
    ...o,
  };
  return Object.assign(opts, rec);
}

async function* pages(list: Record<string, unknown>[][], events?: string[]): AsyncGenerator<Record<string, unknown>[]> {
  for (const [n, page] of list.entries()) {
    events?.push(`page ${n + 1}`);
    yield page;
  }
}

const rows = (...ts: number[]) => ts.map((t) => ({ id: t, ts: t }));

describe("stageInParts: parts commit as they come while the order holds", () => {
  test("every `rows` rows, at the end of the page that reaches it; the rest is the last part, left to the caller", async () => {
    PARTIAL_COMMIT.rows = 3;
    const o = options(null);
    o.source = pages([rows(1, 2), rows(3, 4), rows(5), rows(6, 7), rows(8)], o.events);
    const out = await stageInParts(o);
    expect(o.events).toEqual(["page 1", "page 2", "commit 1", "page 3", "page 4", "commit 2", "page 5"]);
    expect(o.commits.map((c) => c.ids)).toEqual([[1, 2, 3, 4], [5, 6, 7]]);
    expect(lines(out.manifest).map((r) => r.id)).toEqual([8]);
    expect(out).toMatchObject({ commits: 2, committedRows: 7, monotone: true, broken: null, large: true });
    // Each part numbers its rows from 1 (dedupe inside a part keeps the last), in its own folder.
    expect(lines(out.manifest).map((r) => r._croft_seq)).toEqual([1]);
    expect(o.commits[0]!.dir.startsWith(o.dir)).toBe(true);
    // The staged files of a committed part are gone once it committed.
    expect(existsSync(o.commits[0]!.dir)).toBe(false);
    expect(existsSync(o.commits[1]!.dir)).toBe(false);
  });

  test("a later part names its columns after what the earlier commits stored", async () => {
    PARTIAL_COMMIT.rows = 1;
    const o = options(pages([[{ id: 1, ts: 1 }], [{ id: 2, ts: 2 }]]));
    const seen: string[][] = [];
    const commit = o.commit;
    o.commit = async (m, n) => {
      seen.push(m.columns.map((c) => c.name));
      return commit(m, n);
    };
    await stageInParts(o);
    expect(seen).toEqual([["id", "ts"], ["id", "TS"]]);
  });

  test("every `ms` milliseconds too; a part with no rows never commits", async () => {
    PARTIAL_COMMIT.ms = 0;
    const o = options(pages([rows(1), [], rows(2), [], [], rows(3)]));
    const out = await stageInParts(o);
    expect(o.commits.map((c) => c.ids)).toEqual([[1], [2], [3]]);
    expect(out.manifest.rows).toBe(0);
    expect(out.commits).toBe(3);
  });

  test("NULL cursor values and rows without the field neither break the order nor move it; breaks name their row", async () => {
    PARTIAL_COMMIT.rows = 100;
    const o = options(pages([[{ id: 1, ts: 1 }, { id: 2 }, { id: 3, ts: null }], [{ id: 4, ts: 5 }, { id: 5, ts: 4 }]]));
    const out = await stageInParts(o);
    expect(out.broken).toEqual({ value: "4", after: "5", row: 5 });
  });

  test("a small load commits nothing on its way: one part, as before", async () => {
    const o = options(pages([rows(1, 2), rows(3)]));
    const out = await stageInParts(o);
    expect(o.commits).toEqual([]);
    expect(out).toMatchObject({ commits: 0, committedRows: 0, monotone: true, large: false });
    expect(lines(out.manifest).map((r) => r.id)).toEqual([1, 2, 3]);
    // The first part is staged where a single-transaction load stages it.
    expect(existsSync(join(o.dir, "manifest.json"))).toBe(true);
  });

  test("newest first: nothing commits on the way, and the result says the order broke and the load was large", async () => {
    PARTIAL_COMMIT.rows = 2;
    const o = options(pages([rows(9, 8), rows(7, 6), rows(5)]));
    const out = await stageInParts(o);
    expect(o.events).toEqual([]);
    expect(out).toMatchObject({ commits: 0, monotone: false, large: true, broken: { value: "8", after: "9", row: 2 } });
    expect(lines(out.manifest).map((r) => r.id)).toEqual([9, 8, 7, 6, 5]);
  });

  test("the order breaks after a commit: the saved position goes back at once, before the rows that broke it are staged", async () => {
    PARTIAL_COMMIT.rows = 2;
    const o = options(null);
    o.source = pages([rows(1, 2), rows(3, 4), rows(0), rows(5)], o.events);
    const out = await stageInParts(o);
    expect(o.events).toEqual(["page 1", "commit 1", "page 2", "commit 2", "page 3", "rewind", "page 4"]);
    expect(out).toMatchObject({ commits: 2, committedRows: 4, monotone: false, broken: { value: "0", after: "4", row: 5 } });
    expect(lines(out.manifest).map((r) => r.id)).toEqual([0, 5]);
  });

  test("a failed commit is PartialCommitFailed around the commit's own error; its part stays staged", async () => {
    PARTIAL_COMMIT.rows = 1;
    const o = options(pages([rows(1), rows(2), rows(3)]), { failCommit: 2 });
    const err = await stageInParts(o).catch((e) => e);
    expect(err).toBeInstanceOf(PartialCommitFailed);
    expect((err as PartialCommitFailed).cause).toBeInstanceOf(CroftError);
    expect((err as PartialCommitFailed).commits).toBe(1);
    expect(o.commits.map((c) => c.ids)).toEqual([[1]]);
    expect(existsSync(join(o.dir, "commit-2", "manifest.json"))).toBe(true);
  });

  test("staging errors of a later part name the row of the whole load", async () => {
    PARTIAL_COMMIT.rows = 2;
    const o = options(pages([rows(1, 2), [{ id: 3, ts: 3 }, 5 as unknown as Record<string, unknown>]]));
    const err = (await stageInParts(o).catch((e) => e)) as CroftError;
    expect(err.code).toBe("ROW_NOT_OBJECT");
    expect(err.problem.details?.row).toBe(4);
    expect(err.problem.message).toContain("row 4 of events");
  });

  test("an error thrown by the source ends the load; the generator is not asked again", async () => {
    PARTIAL_COMMIT.rows = 1;
    let asked = 0;
    const source = (async function* () {
      asked++;
      yield rows(1);
      asked++;
      throw new Error("boom");
    })();
    const o = options(source);
    await expect(stageInParts(o)).rejects.toThrow("boom");
    expect(asked).toBe(2);
    expect(o.commits.map((c) => c.ids)).toEqual([[1]]);
  });

  test("a source that is one promise, or no rows at all, is staged in one part", async () => {
    PARTIAL_COMMIT.rows = 1;
    const p = options(Promise.resolve(rows(1, 2, 3)));
    const out = await stageInParts(p);
    expect(p.commits).toEqual([]);
    expect(out.manifest.rows).toBe(3);
    const bad = options(42);
    await expect(stageInParts(bad)).rejects.toMatchObject({ problem: { code: "ROW_NOT_OBJECT" } });
  });

  test("a sync iterable of rows commits too", async () => {
    PARTIAL_COMMIT.rows = 2;
    const o = options(rows(1, 2, 3, 4, 5));
    const out = await stageInParts(o);
    expect(o.commits.map((c) => c.ids)).toEqual([[1, 2], [3, 4]]);
    expect(lines(out.manifest).map((r) => r.id)).toEqual([5]);
  });

  test("an aborted signal stops between parts", async () => {
    PARTIAL_COMMIT.rows = 1;
    const ac = new AbortController();
    const o = options(pages([rows(1), rows(2), rows(3)]));
    o.commit = async () => {
      ac.abort(new CroftError("INTERRUPTED", { message: "stop", hint: "run it again" }));
      return [];
    };
    o.signal = ac.signal;
    await expect(stageInParts(o)).rejects.toMatchObject({ problem: { code: "INTERRUPTED" } });
  });
});
