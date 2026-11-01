// What SQL that got past the gate can do inside the readers' process (DESIGN.md D119, D118; option 06, slice 2). The gate is
// bypassed here on purpose: serve/readers-session-testkit.ts opens the same locked instance the worker does and takes raw
// SQL. The copy is attached read-only and is read-only on disk (a refresh marks it so), the live file is out of reach, and
// the only thing SQL can still make beside the copy is a `<copy>.wal`, which the readers' process removes before it attaches.
import { afterAll, describe, expect } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { closeAllWarehouses } from "../db/warehouse.ts";
import { refreshReadCopy } from "../db/readcopy.ts";
import { cleanup, seed, type TempProject } from "../read/testkit.ts";
import { extensionFiles, project } from "./readers-testkit.ts";

const { ext, withExt } = extensionFiles("readers-lockdown.test");
const children: ChildProcess[] = [];
afterAll(async () => {
  for (const c of children) c.kill("SIGKILL");
  await closeAllWarehouses();
  cleanup();
});

interface Session { run(sql: string): Promise<{ ok: true; rows: unknown[][] } | { ok: false; error: string }>; stop(): void }

/** The readers' instance in a child, taking raw SQL. */
async function session(p: TempProject): Promise<Session> {
  const proc = spawn(process.execPath, [join(import.meta.dir, "readers-session-testkit.ts"), "--ext", ext.dir, "--state", p.stateDir, "--copy", p.project.paths.readCopy], { stdio: ["pipe", "pipe", "pipe"] });
  children.push(proc);
  const lines: string[] = [];
  const waiters: (() => void)[] = [];
  let buf = "";
  let err = "";
  proc.stdout!.on("data", (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
      for (const w of waiters.splice(0)) w();
    }
  });
  proc.stderr!.on("data", (d) => (err += String(d)));
  const next = async (): Promise<string> => {
    const end = Date.now() + 20_000;
    while (lines.length === 0) {
      if (Date.now() > end || proc.exitCode !== null) throw new Error(`the readers' session said nothing: ${err}`);
      await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 50); });
    }
    return lines.shift()!;
  };
  expect(await next()).toBe("READY");
  let id = 0;
  return {
    async run(sql) {
      proc.stdin!.write(`${JSON.stringify({ id: ++id, sql })}\n`);
      return JSON.parse(await next());
    },
    stop: () => proc.kill("SIGKILL"),
  };
}

/** A server-mode project whose read copy was made by a real refresh, so it is as croft leaves it. */
async function refreshedProject(): Promise<TempProject> {
  const p = await project({ n: 10, copy: false });
  const out = await refreshReadCopy(p.root, { project: p.project });
  expect(out.status).toBe("refreshed");
  await closeAllWarehouses();
  return p;
}

const isRoot = process.getuid?.() === 0;

describe("the copy", () => {
  withExt("is read-only on disk after a refresh, and a write aimed at it from inside the readers' process fails", async () => {
    const p = await refreshedProject();
    const copy = p.project.paths.readCopy;
    expect(statSync(copy).mode & 0o222).toBe(0);
    const before = readFileSync(copy);
    const s = await session(p);
    expect(await s.run("SELECT count(*) FROM wh.orders")).toMatchObject({ ok: true, rows: [[10]] });
    for (const sql of [
      "INSERT INTO wh.orders VALUES (1, 1)",
      "DELETE FROM wh.orders",
      "DROP TABLE wh.orders",
      "CREATE TABLE wh.extra (x INT)",
      `COPY (SELECT 1 AS a) TO '${copy}'`,
      `COPY wh.orders TO '${copy}' (FORMAT PARQUET)`,
      `ATTACH '${copy}' AS second`,
      `ATTACH '${copy}' AS second (READ_WRITE)`,
    ]) {
      const r = await s.run(sql);
      expect(r.ok, sql).toBe(false);
    }
    if (!isRoot) {
      // Detach it and attach it again for writing: the mode is read-only on disk, so even this fails.
      expect((await s.run("DETACH wh")).ok).toBe(true);
      const rw = await s.run(`ATTACH '${copy}' AS wh (READ_WRITE)`);
      expect(rw.ok).toBe(false);
      expect(rw.ok ? "" : rw.error).toMatch(/read-only|Permission|permission|cannot be opened/i);
      expect((await s.run(`ATTACH '${copy}' AS wh (READ_ONLY)`)).ok).toBe(true);
    }
    s.stop();
    expect(readFileSync(copy).equals(before)).toBe(true);
  });

  withExt("a copy that is writable on disk (made while only readCopy was on) is made read-only before it is attached", async () => {
    const p = await refreshedProject();
    const copy = p.project.paths.readCopy;
    chmodSync(copy, 0o644); // what a refresh with server mode off leaves
    const s = await session(p);
    expect(statSync(copy).mode & 0o222).toBe(0);
    if (!isRoot) {
      // Without that, a detach and a read-write attach worked, and wrote a WAL.
      expect((await s.run("DETACH wh")).ok).toBe(true);
      const rw = await s.run(`ATTACH '${copy}' AS wh (READ_WRITE)`);
      expect(rw.ok).toBe(false);
      expect((await s.run(`ATTACH '${copy}' AS wh (READ_ONLY)`)).ok).toBe(true);
    }
    expect(existsSync(`${copy}.wal`)).toBe(false);
    s.stop();
  });

  withExt("the live file, files/, the state folder and the project's .env are out of reach", async () => {
    const p = await refreshedProject();
    const s = await session(p);
    for (const path of [p.database, join(p.root, "files", "x.csv"), join(p.stateDir, "runs.sqlite"), join(p.root, ".env"), join(p.stateDir, "readers-secrets"), "/etc/hosts"]) {
      for (const sql of [`SELECT * FROM read_text('${path}')`, `ATTACH '${path}' AS other`, `COPY (SELECT 1) TO '${path}.out'`]) {
        const r = await s.run(sql);
        expect(r.ok, sql).toBe(false);
      }
    }
    s.stop();
  });

  withExt("a <copy>.wal that SQL makes beside it changes nothing any reader sees, and the next refresh removes it", async () => {
    const p = await refreshedProject();
    const copy = p.project.paths.readCopy;
    const s = await session(p);
    const made = await s.run(`COPY (SELECT 'not a wal' AS a) TO '${copy}.wal' (FORMAT CSV)`);
    // The sandbox lets a database's own WAL path through, so this is allowed: it is why the refresh and the readers'
    // process both remove it.
    expect(made.ok).toBe(true);
    expect(existsSync(`${copy}.wal`)).toBe(true);
    expect(await s.run("SELECT count(*) FROM wh.orders")).toMatchObject({ ok: true, rows: [[10]] });
    s.stop();
    // A new refresh (the warehouse gained rows) takes the stray file away and leaves a read-only copy.
    await seed(p.database, ["INSERT INTO orders VALUES (100, 0)"]);
    expect((await refreshReadCopy(p.root, { project: p.project })).status).toBe("refreshed");
    await closeAllWarehouses();
    expect(existsSync(`${copy}.wal`)).toBe(false);
    expect(statSync(copy).mode & 0o222).toBe(0);
    const again = await session(p);
    expect(await again.run("SELECT count(*) FROM wh.orders")).toMatchObject({ ok: true, rows: [[11]] });
    again.stop();
  });
});

describe("the mode's lockdown", () => {
  withExt("SET, INSTALL, LOAD and a remote attach are refused; only the copy's path is reachable", async () => {
    const p = await refreshedProject();
    const s = await session(p);
    for (const sql of ["SET enable_external_access = true", "SET allowed_paths = []", "INSTALL httpfs", "LOAD '/tmp/x.duckdb_extension'", "ATTACH 'postgres:dbname=x' AS pg (TYPE postgres)", "ATTACH 'quack:localhost:1' AS q (TYPE quack)", "SELECT * FROM read_csv('https://example.com/x.csv')", "SELECT getenv('HOME')"]) {
      const r = await s.run(sql);
      expect(r.ok, sql).toBe(false);
    }
    s.stop();
  });
});
