// The read copy in server mode (DESIGN.md D119, D121; option 06, slice 2): the refresh marks its temporary file read-only
// before the rename, and removes a `<copy>.wal` before and after it. It never stops for the copy policy.
// With server mode off the copy is written with the usual permissions. The readers' process itself is tested in
// serve/readers*.test.ts; nothing here needs DuckDB's extension files.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { cleanup, makeProject, seed, type TempProject } from "../read/testkit.ts";
import { readCopyStatus, refreshReadCopy } from "./readcopy.ts";
import { closeAllWarehouses } from "./warehouse.ts";

const scratch: string[] = [];
afterEach(async () => {
  await closeAllWarehouses();
});
afterAll(async () => {
  await closeAllWarehouses();
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  cleanup();
});

const SEED = ["CREATE TABLE t AS SELECT range AS n FROM range(10)"];
const serverMode = (config: Record<string, unknown> = {}) => makeProject({ config: { serverMode: { enabled: true }, ...config }, seed: SEED });
const copyOf = (p: TempProject) => p.project.paths.readCopy;
const writable = (file: string) => (statSync(file).mode & 0o200) !== 0;
const temps = (p: TempProject) => readdirSync(dirname(copyOf(p))).filter((n) => n.startsWith(`.${basename(copyOf(p))}.`));
const refresh = (p: TempProject, o: Parameters<typeof refreshReadCopy>[1] = {}) => refreshReadCopy(p.root, { project: p.project, ...o });

/** A `cp` that cannot clone, as on ext4: it refuses the clone flags and otherwise copies. */
function cpWithoutClone(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "croft-cp-")));
  scratch.push(dir);
  const f = join(dir, "cp");
  writeFileSync(f, '#!/bin/sh\nfor a in "$@"; do case "$a" in -c|--reflink=always) exit 1;; esac; done\nexec /bin/cp "$@"\n');
  chmodSync(f, 0o755);
  return f;
}

describe("in server mode", () => {
  test("turning it on turns the read copy on: the refresh makes warehouse.read.duckdb", async () => {
    const p = await serverMode();
    expect(p.project.config.readCopy).toBe(true);
    expect((await refresh(p)).status).toBe("refreshed");
    expect(existsSync(copyOf(p))).toBe(true);
    expect(readCopyStatus(p.project)).toMatchObject({ enabled: true, exists: true });
  });

  test("the refresh leaves the copy read-only on disk, and the next refresh still replaces it", async () => {
    const p = await serverMode();
    expect((await refresh(p)).status).toBe("refreshed");
    expect(statSync(copyOf(p)).mode & 0o777).toBe(0o444);
    const first = statSync(copyOf(p)).ino;
    await seed(p.database, ["INSERT INTO t VALUES (100)"]);
    expect((await refresh(p)).status).toBe("refreshed");
    expect(statSync(copyOf(p)).ino).not.toBe(first); // renamed over: the folder changes, not the file
    expect(statSync(copyOf(p)).mode & 0o777).toBe(0o444);
    expect(temps(p)).toEqual([]);
  });

  test("a <copy>.wal beside the old copy is gone after the refresh", async () => {
    const p = await serverMode();
    expect((await refresh(p)).status).toBe("refreshed");
    writeFileSync(`${copyOf(p)}.wal`, "left by SQL in the readers' process");
    await seed(p.database, ["INSERT INTO t VALUES (101)"]);
    expect((await refresh(p)).status).toBe("refreshed");
    expect(existsSync(`${copyOf(p)}.wal`)).toBe(false);
  });

  test("past the copy limit the refresh carries on: the cost is reported elsewhere, and a running server keeps getting fresh copies", async () => {
    const p = await serverMode();
    truncateSync(p.database, 1_500_000_000); // a sparse file: DuckDB reads its header, the policy only the size
    const out = await refresh(p, { platform: "linux", cp: [cpWithoutClone()] });
    expect(out.status).toBe("refreshed");
    expect(existsSync(copyOf(p))).toBe(true);
    expect(readCopyStatus(p.project).health).toBe("ok");
  });
});

describe("with server mode off", () => {
  test("the copy is written with the usual permissions, also over a read-only copy that server mode left", async () => {
    const p = await makeProject({ config: { readCopy: true }, seed: SEED });
    expect(p.project.config.serverMode.enabled).toBe(false);
    expect((await refresh(p)).status).toBe("refreshed");
    expect(writable(copyOf(p))).toBe(true);
    chmodSync(copyOf(p), 0o444); // what server mode left
    await seed(p.database, ["INSERT INTO t VALUES (103)"]);
    expect((await refresh(p)).status).toBe("refreshed");
    expect(writable(copyOf(p))).toBe(true);
  });

  test("a warehouse of any size is copied: the policy applies to server mode only", async () => {
    const p = await makeProject({ config: { readCopy: true }, seed: SEED });
    expect((await refresh(p, { platform: "linux", cp: [cpWithoutClone()] })).status).toBe("refreshed");
  });
});
