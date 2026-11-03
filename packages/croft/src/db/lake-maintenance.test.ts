// A lake's maintenance (db/lake-maintenance.ts; DESIGN.md D149 to D152; option 07, slice 3). First the promise as a pure function over literal
// snapshots; then the steps against a real lake.
import { describe, expect, test } from "bun:test";
import { assetsChanged, isTransientStorage, type LakeTable, parseChanges, planExpiry, type SnapshotInfo, tablesByLatestName, WINDOW_SKEW_MS } from "./lake-maintenance.ts";

const DAY = 86_400_000;
const NOW = new Date("2026-11-02T12:00:00Z");
const ago = (days: number): number => NOW.getTime() - days * DAY;

const TABLES: LakeTable[] = [
  { id: 1, schema: "main", name: "orders" },
  { id: 2, schema: "main", name: "users" },
  { id: 3, schema: "_croft", name: "assets_log" },
  { id: 4, schema: "main", name: "orders" }, // orders rebuilt: a new table id with the same name
];

/** A snapshot with its changes written the way `to_json(changes)` prints them. */
const snap = (id: number, days: number, changes: Record<string, string[]>): SnapshotInfo => ({ id, ms: ago(days), changes: JSON.stringify(changes) });

describe("what a snapshot changed", () => {
  test("changes come as an object or as a list of pairs, and a bad value is nothing", () => {
    expect(parseChanges('{"tables_inserted_into":["1"],"inlined_insert":["2"]}')).toEqual({ tables_inserted_into: ["1"], inlined_insert: ["2"] });
    expect(parseChanges('[{"key":"tables_created","value":["main.t"]}]')).toEqual({ tables_created: ["main.t"] });
    expect(parseChanges("not json")).toEqual({});
    expect(parseChanges(null)).toEqual({});
  });

  test("a table of main that was created, written to, deleted from or altered has a new version; a drop, a flush and a merge do not", () => {
    const t = new Map(TABLES.map((x) => [x.id, x]));
    expect(assetsChanged({ tables_created: ["main.orders"], tables_inserted_into: ["4"] }, t)).toEqual(["orders"]);
    expect(assetsChanged({ inlined_insert: ["2"], inlined_delete: ["1"] }, t).sort()).toEqual(["orders", "users"]);
    expect(assetsChanged({ tables_altered: ["2"], tables_deleted_from: ["1"] }, t).sort()).toEqual(["orders", "users"]);
    expect(assetsChanged({ tables_dropped: ["1"] }, t)).toEqual([]);
    expect(assetsChanged({ flushed_inlined: ["2"], merge_adjacent: ["1"] }, t)).toEqual([]);
    // croft's own bookkeeping is no asset, and an id the catalog no longer names is nobody's.
    expect(assetsChanged({ inlined_insert: ["3"], tables_inserted_into: ["99"], tables_created: ["_croft.meta"] }, t)).toEqual([]);
  });
});

describe("the promise: 30 days or 5 versions per asset", () => {
  test("nothing within 30 days is expired", () => {
    const snaps = Array.from({ length: 40 }, (_, i) => snap(i + 1, 29 - i * 0.7, { tables_inserted_into: ["1"] }));
    const plan = planExpiry(snaps, TABLES, { now: NOW });
    expect(plan.expire).toEqual([]);
    expect(plan.kept).toBe(40);
  });

  test("older snapshots go except each asset's 5 newest versions, the state at the start of the window, and the newest", () => {
    // orders: 8 versions 60..53 days ago, then nothing; users: 2 versions 45 and 44 days ago; a flush and a merge in between.
    const snaps: SnapshotInfo[] = [
      ...Array.from({ length: 8 }, (_, i) => snap(i + 1, 60 - i, { tables_inserted_into: ["1"] })), // 1..8
      snap(9, 46, { flushed_inlined: ["1"] }),
      snap(10, 45, { tables_inserted_into: ["2"] }),
      snap(11, 44, { inlined_insert: ["2"] }),
      snap(12, 43, { merge_adjacent: ["1"] }),
      snap(13, 31, { inlined_insert: ["3"] }), // croft's bookkeeping, the newest snapshot before the window
      snap(14, 5, { inlined_insert: ["3"] }),
    ];
    const plan = planExpiry(snaps, TABLES, { now: NOW });
    // Kept: orders' newest 5 (4..8), users' 2 (10, 11), the state at the window's start (13), the window (14), the latest (14).
    expect(plan.expire).toEqual([1, 2, 3, 9, 12]);
    expect(plan.assets).toEqual({ orders: 5, users: 2 });
    expect(plan.because.versions).toBe(7);
    expect(plan.because.windowStart).toBe(1);
    expect(plan.because.latest).toBe(1);
  });

  test("an asset rebuilt under a new table id is one asset: the 5 newest versions are counted by name", () => {
    const snaps: SnapshotInfo[] = [
      snap(1, 70, { tables_created: ["main.orders"], tables_inserted_into: ["1"] }),
      snap(2, 69, { tables_inserted_into: ["1"] }),
      snap(3, 68, { tables_inserted_into: ["1"] }),
      snap(4, 67, { tables_created: ["main.orders"], tables_dropped: ["1"], tables_inserted_into: ["4"] }), // CREATE OR REPLACE
      snap(5, 66, { tables_inserted_into: ["4"] }),
      snap(6, 65, { tables_inserted_into: ["4"] }),
      snap(7, 64, { tables_inserted_into: ["4"] }),
      snap(8, 1, { inlined_insert: ["3"] }),
    ];
    const plan = planExpiry(snaps, TABLES, { now: NOW });
    expect(plan.assets).toEqual({ orders: 5 });
    expect(plan.expire).toEqual([1, 2]); // 3..7 are orders' five newest, 8 is the window and the latest
  });

  test("a drop is not a version, so a dropped table keeps its last five states", () => {
    const snaps: SnapshotInfo[] = [
      ...Array.from({ length: 6 }, (_, i) => snap(i + 1, 50 - i, { tables_inserted_into: ["2"] })), // 1..6
      snap(7, 40, { tables_dropped: ["2"] }),
      snap(8, 2, { inlined_insert: ["3"] }),
    ];
    const plan = planExpiry(snaps, TABLES, { now: NOW });
    expect(plan.expire).toEqual([1]); // 1 goes; 2..6 stay; the drop at 7 is the state at the window's start
    expect(plan.kept).toBe(7);
  });

  test("a snapshot the trash pins stays however old, and a pin to a snapshot that is gone is ignored", () => {
    const snaps: SnapshotInfo[] = [
      ...Array.from({ length: 9 }, (_, i) => snap(i + 1, 80 - i, { tables_inserted_into: ["1"] })),
      snap(10, 2, { inlined_insert: ["3"] }),
    ];
    const plain = planExpiry(snaps, TABLES, { now: NOW });
    expect(plain.expire).toEqual([1, 2, 3, 4]);
    const pinned = planExpiry(snaps, TABLES, { now: NOW, pins: [2, 99] });
    expect(pinned.expire).toEqual([1, 3, 4]);
    expect(pinned.because.pinned).toBe(1);
  });

  test("the edge of the window: a snapshot just inside it stays, one just outside it goes unless it is the state at the start", () => {
    const snaps: SnapshotInfo[] = [
      ...Array.from({ length: 7 }, (_, i) => snap(i + 1, 90 - i, { tables_inserted_into: ["1"] })), // 1..7, orders
      snap(8, 31, { inlined_insert: ["3"] }),
      snap(9, 30.5, { inlined_insert: ["3"] }),
      snap(10, 29.9, { inlined_insert: ["3"] }),
    ];
    const plan = planExpiry(snaps, TABLES, { now: NOW });
    // 9 (30.5 days) is the newest before the window: it stays as the window's start; 8 (31 days) goes; 1 and 2 go (orders keeps 3..7).
    expect(plan.expire).toEqual([1, 2, 8]);
  });

  test("a lake of one snapshot, or none, expires nothing", () => {
    expect(planExpiry([], TABLES, { now: NOW }).expire).toEqual([]);
    expect(planExpiry([snap(1, 100, { schemas_created: ["main"] })], TABLES, { now: NOW }).expire).toEqual([]);
  });
});

describe("a table that was renamed", () => {
  test("goes by the name it has now: of the rows one table id has, the one that begins last wins, whatever the order they come in", () => {
    const rows = [
      { id: 1, schema: "main", name: "b", begin: 40 }, { id: 1, schema: "main", name: "a", begin: 1 }, { id: 4, schema: "main", name: "a", begin: 41 },
    ];
    const byId = (t: LakeTable[]) => [...t].sort((x, y) => x.id - y.id);
    expect(byId(tablesByLatestName(rows))).toEqual([{ id: 1, schema: "main", name: "b" }, { id: 4, schema: "main", name: "a" }]);
    expect(byId(tablesByLatestName([...rows].reverse()))).toEqual(byId(tablesByLatestName(rows)));
  });

  test("its versions are counted under the new name, and a new table of the old name has versions of its own", () => {
    const tables = tablesByLatestName([{ id: 1, schema: "main", name: "a", begin: 1 }, { id: 1, schema: "main", name: "b", begin: 20 }, { id: 5, schema: "main", name: "a", begin: 21 }]);
    const snaps: SnapshotInfo[] = [
      ...Array.from({ length: 8 }, (_, i) => snap(i + 1, 90 - i, { tables_inserted_into: ["1"] })), // 1..8, the table that is b now
      snap(9, 80, { tables_altered: ["1"] }), // the rename
      snap(10, 79, { tables_created: ["main.a"], tables_inserted_into: ["5"] }),
      snap(11, 78, { tables_inserted_into: ["5"] }),
      snap(12, 1, { inlined_insert: ["3"] }),
    ];
    const plan = planExpiry(snaps, tables, { now: NOW });
    expect(plan.assets).toEqual({ b: 5, a: 2 });
    expect(plan.expire).toEqual([1, 2, 3, 4]); // b keeps 5 to 8 and the rename; the new a keeps both of its versions
  });
});

describe("the edge of the window", () => {
  test("is an hour wider than 30 days, so a clock a little off does not move it", () => {
    expect(WINDOW_SKEW_MS).toBe(3_600_000);
    const inside = snap(2, 30 + 0.5 / 24, { inlined_insert: ["3"] }); // 30 days and half an hour old
    const outside = snap(1, 30 + 2 / 24, { inlined_insert: ["3"] }); // 30 days and two hours old
    const plan = planExpiry([outside, inside, snap(3, 1, { inlined_insert: ["3"] })], TABLES, { now: NOW });
    expect(plan.because.window).toBe(2); // the half hour past 30 days is still the window
    expect(plan.expire).toEqual([]); // and the older one is the state when the window began
  });
});

describe("a failure worth trying again", () => {
  test("a server error, a slowdown and a dropped connection are; a refusal is not", () => {
    expect(isTransientStorage(new Error("HTTP Error: Request returned HTTP 500 for HTTP POST to 'http://127.0.0.1:1/lakeb/?delete='"))).toBe(true);
    expect(isTransientStorage(new Error("HTTP Error: Request returned HTTP 503 for HTTP DELETE to 'https://x/y'"))).toBe(true);
    expect(isTransientStorage(new Error("<Error><Code>SlowDown</Code>"))).toBe(true);
    expect(isTransientStorage(new Error("server closed the connection unexpectedly"))).toBe(true);
    expect(isTransientStorage(new Error("HTTP Error: Request returned HTTP 403 for HTTP POST to 'https://x/y'"))).toBe(false);
    expect(isTransientStorage(new Error("Catalog Error: Table with name x does not exist"))).toBe(false);
  });
});
