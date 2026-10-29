import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE_SETTING } from "../db/backup.ts";
import type { CatalogAsset } from "../history/catalog.ts";
import { RunsDb } from "../history/runs-db.ts";
import { engineChange, engineWords, sourceHashOf } from "./engine-change.ts";

let dir: string;
let db: RunsDb;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "croft-engine-"));
  db = RunsDb.open(dir);
  path = join(dir, "orders.sql");
  writeFileSync(path, "-- key: id\nSELECT id FROM raw\n");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const BUILT = "2026-10-01T12:00:00.000000Z";
const entry = (o: Partial<CatalogAsset> = {}): CatalogAsset => ({
  asset: "orders", kind: "sql", behavior: "", write: "replace", key: ["id"], rows: 1, columns: [], cursor: null,
  lastLoadedAt: BUILT, lastReplacedAt: null, lastRunId: "r", codeHash: "old", ...o,
});
const setMtime = (iso: string) => utimesSync(path, new Date(iso), new Date(iso));

describe("with a code_sources row (croft ≥ 0.4)", () => {
  test("the same source under another engine is an engine change; another source or the same engine is not", () => {
    const source = sourceHashOf(path, "assets/orders.sql", "UTC")!;
    db.noteCodeSource("old", source, "v1.5.5");
    const now = { sourceHash: source, path, entry: entry() };
    expect(engineChange(db, "old", now, "v2.0.0")).toEqual({ from: "v1.5.5", to: "v2.0.0" });
    expect(engineChange(db, "old", { ...now, sourceHash: "edited" }, "v2.0.0")).toBeNull();
    expect(engineChange(db, "old", now, "v1.5.5")).toBeNull();
    // The time zone is part of the source.
    expect(sourceHashOf(path, "assets/orders.sql", "Asia/Tokyo")).not.toBe(source);
    expect(engineChange(db, "old", { ...now, sourceHash: null }, "v2.0.0")).toBeNull();
  });
});

describe("without one (a build croft 0.3 recorded)", () => {
  test("the build's hash, built before the switch, from a file not touched since", () => {
    setMtime("2026-09-30T00:00:00Z");
    const now = { sourceHash: "s", path, entry: entry() };
    // No engine recorded by a 2.0 writer yet: every build is the old engine's.
    db.setSetting(ENGINE_SETTING, { version: "v1.5.5", recordedAt: "2026-09-01T00:00:00.000Z" });
    expect(engineChange(db, "old", now, "v2.0.0")).toEqual({ from: "v1.5.5", to: "v2.0.0" });
    // A 2.0 writer recorded the switch after the build: still the old engine's build.
    db.setSetting(ENGINE_SETTING, { version: "v2.0.0", recordedAt: "2026-10-02T00:00:00.000Z" });
    expect(engineChange(db, "old", now, "v2.0.0")).toEqual({ from: "v1.5.5", to: "v2.0.0" });
    // A build after the switch was 2.0's own: its hash differing is an edit.
    db.setSetting(ENGINE_SETTING, { version: "v2.0.0", recordedAt: "2026-09-15T00:00:00.000Z" });
    expect(engineChange(db, "old", now, "v2.0.0")).toBeNull();
  });

  test("a file newer than the build (an edit, or a git checkout) falls to the safe side", () => {
    db.setSetting(ENGINE_SETTING, { version: "v1.5.5", recordedAt: "2026-09-01T00:00:00.000Z" });
    setMtime("2026-10-05T00:00:00Z");
    expect(engineChange(db, "old", { sourceHash: "s", path, entry: entry() }, "v2.0.0")).toBeNull();
  });

  test("a hash that is not the build's, or no build, proves nothing", () => {
    setMtime("2026-09-30T00:00:00Z");
    expect(engineChange(db, "approved-elsewhere", { sourceHash: "s", path, entry: entry() }, "v2.0.0")).toBeNull();
    expect(engineChange(db, "old", { sourceHash: "s", path, entry: null }, "v2.0.0")).toBeNull();
    expect(engineChange(db, "old", { sourceHash: "s", path, entry: entry({ lastLoadedAt: null }) }, "v2.0.0")).toBeNull();
  });

  test("the engine before: the newest backup made to this one names it, else the record, else 1.5.5", () => {
    setMtime("2026-09-30T00:00:00Z");
    const now = { sourceHash: "s", path, entry: entry(), stateDir: dir };
    expect(engineChange(db, "old", now, "v2.0.0")?.from).toBe("v1.5.5");
    db.setSetting(ENGINE_SETTING, { version: "v1.4.3", recordedAt: "2026-09-01T00:00:00.000Z" });
    expect(engineChange(db, "old", now, "v2.0.0")?.from).toBe("v1.4.3");
    mkdirSync(join(dir, "backups"));
    writeFileSync(join(dir, "backups", "20261002T000000Z-1.5.4-to-2.0.0.duckdb"), "");
    writeFileSync(join(dir, "backups", "20261003T000000Z-1.5.5-to-2.0.0.duckdb"), "");
    writeFileSync(join(dir, "backups", "20261004T000000Z-2.0.0-to-2.1.0.duckdb"), "");
    expect(engineChange(db, "old", now, "v2.0.0")?.from).toBe("v1.5.5");
  });
});

test("engineWords", () => {
  expect(engineWords({ from: "v1.5.5", to: "v2.0.0" })).toBe("DuckDB upgraded (1.5.5 → 2.0.0)");
  expect(engineWords({ from: "v2.1.0", to: "v2.0.0" })).toBe("DuckDB changed (2.1.0 → 2.0.0)");
});
