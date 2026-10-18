// croft backup [<dir>] (DESIGN.md §4.1, §6 "Backups of the project's data", D109): the command around db/backup.ts
// backupProject, whose copies db/backup.test.ts checks. Here: where the folder goes (the default, a folder named
// relative to the working directory), what --json and the human output say, and the refusals.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeAllWarehouses } from "../../db/warehouse.ts";
import { formatBackup } from "./backup.ts";
import { cleanup, cli, makeProject, seed, STATE } from "./inspect-testkit.ts";

const env = { CROFT_NOW: "2026-09-22T18:40:00.000Z" };
afterEach(closeAllWarehouses);
afterAll(cleanup);

async function rowsIn(file: string): Promise<number> {
  const db = await DuckDBInstance.create(file, { access_mode: "READ_ONLY" });
  const c = await db.connect();
  try {
    return Number((await c.runAndReadAll("SELECT count(*) AS n FROM orders")).getRowObjectsJS()[0]!.n);
  } finally {
    c.disconnectSync();
    db.closeSync();
  }
}

describe("croft backup", () => {
  test("by default a new folder in .croft/backups, with where it went and how big", async () => {
    const p = makeProject();
    await seed(p.database, [...STATE, "CREATE TABLE orders AS SELECT range AS id FROM range(12)"]);
    const r = await cli(["backup", "--json"], { cwd: p.root, env });
    expect(r.exit).toBe(0);
    const name = `${p.root.slice(p.root.lastIndexOf("/") + 1)}-20260922T184000Z`;
    expect(r.json).toMatchObject({
      ok: true, command: "backup", problems: [],
      next: [{ command: "croft docs backup", reason: "how to put a backup back, and what it holds" }],
      data: {
        path: join(p.stateDir, "backups", name), createdAt: "2026-09-22T11:40:00-07:00", sameDisk: true,
        warehouse: { file: "warehouse.duckdb" }, runs: { file: "runs.sqlite" }, trash: null, formatVersion: expect.any(String),
      },
    });
    expect(r.json.data.bytes).toBeGreaterThan(0);
    expect(await rowsIn(join(r.json.data.path, "warehouse.duckdb"))).toBe(12);

    const human = await cli(["backup"], { cwd: p.root, env });
    const lines = human.stdout.split("\n");
    expect(lines[0]).toMatch(new RegExp(`^Backed up to \\.croft/backups/${name}-2 \\([\\d.]+ [KM]?B\\)$`));
    expect(lines[1]).toMatch(/^ {2}warehouse\.duckdb +[\d.]+ [KM]?B +as of 2026-09-22 11:40:00 \((cloned|copied)/);
    expect(lines[2]).toMatch(/^ {2}runs\.sqlite +[\d.]+ [KM]?B +run history, schedules, the catalog$/);
    expect(lines[3]).toMatch(/^ {2}trash\/ +- +empty$/);
    expect(human.stdout).toContain("it undoes a mistake, not a lost disk");
    expect(human.stdout).toContain("next: croft docs backup");
    expect(readdirSync(join(p.stateDir, "backups")).sort()).toEqual([name, `${name}-2`]);
  });

  test("a folder is named relative to the working directory and created when missing", async () => {
    const p = makeProject();
    await seed(p.database, [...STATE, "CREATE TABLE orders AS SELECT 1 AS id"]);
    mkdirSync(join(p.root, "assets", "sub"), { recursive: true });
    const r = await cli(["backup", "../../kept/croft", "--json"], { cwd: join(p.root, "assets", "sub"), env });
    expect(r.exit).toBe(0);
    expect(r.json.data.path.startsWith(join(p.root, "kept", "croft") + "/")).toBe(true);
    expect(existsSync(join(r.json.data.path, "backup.json"))).toBe(true);
  });

  test("refusals: no warehouse yet, a folder inside the state folder, a second folder", async () => {
    const p = makeProject();
    const none = await cli(["backup", "--json"], { cwd: p.root, env });
    expect(none.exit).toBe(2);
    expect(none.json.data).toBeNull();
    expect(none.json.problems[0]).toMatchObject({ code: "DB_NOT_FOUND", effect: "nothing was written" });
    await seed(p.database, [...STATE, "CREATE TABLE orders AS SELECT 1 AS id"]);
    const inside = await cli(["backup", ".croft/trash", "--json"], { cwd: p.root, env });
    expect(inside.exit).toBe(2);
    expect(inside.json.problems[0]).toMatchObject({ code: "USAGE_ERROR", fix: { command: "croft backup" } });
    writeFileSync(join(p.root, "notes.txt"), "");
    expect((await cli(["backup", "notes.txt", "--json"], { cwd: p.root, env })).json.problems[0].code).toBe("USAGE_ERROR");
    expect((await cli(["backup", "a", "b", "--json"], { cwd: p.root, env })).json.problems[0].code).toBe("USAGE_ERROR");
    expect(existsSync(join(p.stateDir, "backups"))).toBe(false);
  });
});

describe("formatBackup", () => {
  test("a copy on another disk says nothing of disks; a plain copy says copied; the trash counts its versions", () => {
    const text = formatBackup({
      path: "/Volumes/Ext/croft/p-20260922T184000Z", createdAt: "2026-09-22T11:40:00.000-07:00", bytes: 3 * 1024 * 1024,
      warehouse: { file: "warehouse.duckdb", bytes: 2 * 1024 * 1024, method: "copy" }, runs: { file: "runs.sqlite", bytes: 512 * 1024 },
      trash: { dir: "trash", versions: 1, bytes: 512 * 1024 }, sameDisk: false, heldMs: 41, duckdb: "v1.5.5", formatVersion: "3",
    }, "/Users/ana/p", "/Users/ana/p");
    expect(text.split("\n")).toEqual([
      "Backed up to /Volumes/Ext/croft/p-20260922T184000Z (3 MB)",
      "  warehouse.duckdb    2 MB  as of 2026-09-22 11:40:00 (copied)",
      "  runs.sqlite       512 KB  run history, schedules, the catalog",
      "  trash/            512 KB  1 version",
      "The warehouse was held 41 ms; croft serve and runs carried on after that.",
    ]);
  });
});
