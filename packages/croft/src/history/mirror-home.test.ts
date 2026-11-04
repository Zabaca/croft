// Which warehouse the catalog mirror describes (history/mirror-home.ts; DESIGN.md D170; option 07, slice 4): runs.sqlite only, no warehouse.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunsDb } from "./runs-db.ts";
import { readMoveRecord, settleMirror, settleMirrorFor, stashMirror } from "./mirror-home.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const state = (): { dir: string; db: RunsDb } => {
  const dir = mkdtempSync(join(tmpdir(), "croft-mirror-"));
  dirs.push(dir);
  return { dir, db: RunsDb.open(dir) };
};
const assets = (db: RunsDb): Record<string, unknown> => Object.fromEntries(db.catalogAll<{ rows: number }>().map((e) => [e.asset, e.value.rows]));
const FILE = "warehouse.duckdb";
const LAKE = "lake s3://b/f/ (catalog db:5432/c)";

describe("the catalog mirror and the warehouse it describes", () => {
  test("a mirror never recorded takes the project as its home, and the same home changes nothing", () => {
    const { db } = state();
    db.catalogPut("orders", { rows: 5 }, "run");
    expect(settleMirror(db, FILE)).toBe("recorded");
    expect(settleMirror(db, FILE)).toBe("same");
    expect(assets(db)).toEqual({ orders: 5 });
    db.close();
  });

  test("the file's mirror is put back when the project returns to the file, whatever the lake's days wrote", () => {
    const { db } = state();
    db.catalogPut("orders", { rows: 5 }, "run");
    db.catalogPut("gone_later", { rows: 1 }, "run");
    settleMirror(db, FILE);
    // The move saves the file's mirror as it is, just before the switch.
    stashMirror(db, FILE);
    // The first command in the lake: the mirror is the file's (equal data), kept, and now at home in the lake.
    expect(settleMirror(db, LAKE)).toBe("kept");
    expect(assets(db)).toEqual({ gone_later: 1, orders: 5 });
    // Runs in the lake change it.
    db.catalogPut("orders", { rows: 305 }, "run");
    db.catalogDelete("gone_later");
    db.catalogPut("lake_only", { rows: 2 }, "run");
    // Back on the file: its own mirror, exactly.
    expect(settleMirror(db, FILE)).toBe("restored");
    expect(assets(db)).toEqual({ gone_later: 1, orders: 5 });
    // And on the lake again: the lake's days are where they were left.
    expect(settleMirror(db, LAKE)).toBe("restored");
    expect(assets(db)).toEqual({ lake_only: 2, orders: 305 });
    db.close();
  });

  test("a place the project was never at keeps the mirror as it is (the next write of each asset refreshes its entry)", () => {
    const { db } = state();
    db.catalogPut("orders", { rows: 5 }, "run");
    settleMirror(db, FILE);
    expect(settleMirror(db, "warehouse2.duckdb")).toBe("kept");
    expect(assets(db)).toEqual({ orders: 5 });
    db.close();
  });

  test("a project that has nothing to do with a lake is not touched at all", () => {
    const { dir, db } = state();
    db.catalogPut("orders", { rows: 5 }, "run");
    db.close();
    expect(settleMirrorFor(dir, FILE, false)).toBeNull();
    const again = RunsDb.open(dir);
    expect(again.getSetting("catalog.home")).toBeNull();
    again.close();
    // With a lake block (on or off) it is recorded.
    expect(settleMirrorFor(dir, FILE, true)).toBe("recorded");
    // No runs.sqlite, nothing to settle, and none is made.
    const none = mkdtempSync(join(tmpdir(), "croft-mirror-"));
    dirs.push(none);
    expect(settleMirrorFor(join(none, ".croft"), FILE, true)).toBeNull();
  });

  test("the record of a move is read back, and a setting that is not one reads as none", () => {
    const { db } = state();
    expect(readMoveRecord(db)).toBeNull();
    db.setSetting("lake.move", { nonsense: true });
    expect(readMoveRecord(db)).toBeNull();
    const record = { at: "2026-11-02T00:00:00.000Z", runId: "r_1", tag: "croft:1:move:x", lake: "lake x", tables: 2, rows: 47, fileSha256: "a".repeat(64), fileBytes: 10, backup: ".croft/backups/x" };
    db.setSetting("lake.move", record);
    expect(readMoveRecord(db)).toEqual(record);
    db.close();
  });
});
