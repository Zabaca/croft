// The lake readers' lockdown (DESIGN.md D183, D118; option 06 slice 1's "lake readers" profile; option 07, slice 5, acceptance 2, 4 and 5): the
// process behind croft serve in server mode over a lake attaches the lake read-only with the read-only login and bucket key, loads quack
// and starts its listener before the lock, and is then locked down to the lake's one folder. These tests open that same instance (the
// connection factory, the real mode) and send it SQL the gate would refuse, so what is proved is the lockdown, the read-only attach, the
// read-only login and the read-only key, not the gate. On a bucket the store enforces the key; a local lake has no key, and its folder is
// the user's own (croft docs lake).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { lakeProject } from "../cli/commands/lake-project-testkit.ts";
import { type LakeRig, RIG_SECRETS, startLakeRig } from "../db/lake-testkit.ts";
import { ProjectEnv } from "../project/env.ts";
import { Rigs } from "./key-rig-testkit.ts";
import { hashKey, newKey } from "./keys.ts";
import { openLakeEngine } from "./lake-engine.ts";
import { type LakeKind, type LakeServe, filesUnder, lakeFolder, lakeReady, lakeSession, startLakeServe } from "./lake-serve-testkit.ts";
import type { QuackEvent } from "./quack-access.ts";
import { QuackClients } from "./quack-client-testkit.ts";
import { QuackListener } from "./quack-listener.ts";

const ready = lakeReady();
if (!ready.ready) console.warn(`[lake-serve-lockdown.test] SKIPPING the lake readers' lockdown tests: ${ready.skipReason}`);
const maybe = ready.ready ? describe : describe.skip;

let lakeRig: LakeRig;
const rigs = new Rigs();
beforeAll(async () => {
  if (ready.ready) lakeRig = await startLakeRig();
}, 120_000);
afterAll(async () => {
  await rigs.close();
  await lakeRig?.stop();
});

for (const kind of ["local", "postgres"] as LakeKind[]) {
  maybe(`the lake readers' lockdown on a ${kind} lake`, () => {
    let s: LakeServe;
    beforeAll(async () => {
      s = await startLakeServe(kind, { extensionDir: ready.dir, lakeRig, rigs });
    }, 180_000);

    test("it loads quack besides the lake's extensions, reads the lake, and refuses SET, INSTALL, LOAD and a remote attach once locked", async () => {
      const g = await lakeSession(s, { readers: true, extensionDir: ready.dir });
      try {
        // duckdb_extensions() reads a folder the lockdown closes, so what is loaded is told by what each extension adds.
        const probes: [string, string][] = [
          ["quack", "quack_serve"], ["httpfs", "enable_server_cert_verification"], ["postgres", "postgres_query"], ["sqlite", "sqlite_scan"], ["ducklake", "ducklake_set_option"],
        ];
        const loaded: string[] = [];
        for (const [name, what] of probes) {
          const sql = name === "httpfs" ? `SELECT count(*) FROM duckdb_settings() WHERE name = '${what}'` : `SELECT count(*) FROM duckdb_functions() WHERE function_name = '${what}'`;
          if (Number((await g.run(sql))[0]![0]) > 0) loaded.push(name);
        }
        expect(loaded.sort()).toEqual(kind === "postgres" ? ["ducklake", "httpfs", "postgres", "quack"] : ["ducklake", "httpfs", "quack", "sqlite"]);
        expect(Number((await g.run("SELECT count(*) FROM main.payments"))[0]![0])).toBe(8);
        for (const sql of [
          "SET enable_external_access = true", "SET allowed_directories = ['/']", "SET autoinstall_known_extensions = true", "INSTALL tpch", "LOAD tpch",
          "ATTACH 'quack:127.0.0.1:1' AS remote (TOKEN 'abcdef')", "ATTACH 'dbname=x host=127.0.0.1' AS pg (TYPE postgres)",
        ]) expect(await g.error(sql), sql).toMatch(/Permission Error|disabled|locked|not allowed|Cannot|cannot/i);
        // Not in this list, and not the lock's to refuse: the lake's secrets were made before the lock, so the secret manager is up, and past the
        // gate quack_serve starts a second listener [V: 2.0.0, here]. The gate refuses quack_serve in every key's SQL (the attack list, over HTTP
        // and over Quack), which is the wall for it (DESIGN.md D183); what a listener started past it is worth is the next test (D204).
      } finally {
        g.close();
      }
    });

    test("a second Quack listener started past the gate, on an address of its own choosing, still asks for a listed key and runs the same hooks (D204)", async () => {
      const key = newKey();
      const events: QuackEvent[] = [];
      const listener = new QuackListener({
        host: "127.0.0.1", port: 0, queryTimeoutMs: 60_000, shared: ["orders"], maxConcurrent: 4, keys: [{ name: "reader", hash: hashKey(key) }],
        emit: (e) => events.push(e), overdue: () => {},
      });
      const g = await lakeSession(s, { readers: true, extensionDir: ready.dir, listener });
      await g.ready();
      const clients = new QuackClients();
      try {
        // Past the gate and the loopback rule (D131): every interface, no TLS, and a token of the caller's choosing.
        const rows = await g.run("SELECT listen_uri FROM quack_serve('quack:0.0.0.0:0', token = 'chosen-by-the-caller', create_secret_if_not_exists = false, allow_other_hostname = true, disable_ssl = true)");
        const second = `quack:127.0.0.1:${String(rows[0]![0]).split(":").pop()}`;
        expect(second).not.toBe(listener.uri);
        const c = await clients.start(ready.dir);
        // The token the second listener was started with is no way in: the one authentication hook is DuckDB's global setting, and it asks for a listed key.
        expect((await c.attach(second, "chosen-by-the-caller")).ok).toBe(false);
        expect((await c.attach(second, "some-other-key")).ok).toBe(false);
        expect(events).toEqual([]);
        // A listed key signs in, and the one authorization hook refuses what the first listener refuses: a table that is not shared.
        const answer = await c.run(`SELECT * FROM quack_query('${second}', 'SELECT count(*) FROM payments', token = '${key}')`);
        expect(answer.ok).toBe(false);
        expect(answer.ok ? "" : answer.error).toContain("payments is not one of the tables shared with this key");
        // The listener is the one the caller asked for, on every interface: nothing but the gate kept it off the network.
        expect((await g.run("SELECT host FROM quack_server_list()")).map((r) => r[0]).sort()).toEqual(["0.0.0.0", "127.0.0.1"]);
        expect(events.map((e) => [e.kind, e.key])).toContainEqual(["signin", "reader"]);
      } finally {
        await clients.close();
        g.close();
      }
    });

    test("a write is refused by the read-only attach: a table, a column, a drop; the lake is as it was", async () => {
      const files = filesUnder(lakeFolder(s.l));
      const g = await lakeSession(s, { readers: true, extensionDir: ready.dir });
      try {
        const snapshots = await g.run("SELECT count(*) FROM lake.snapshots()");
        for (const sql of [
          "INSERT INTO main.orders (id, k, note) VALUES (1, 1, 'x')", "UPDATE main.orders SET k = 0", "DELETE FROM main.orders", "CREATE TABLE main.evil AS SELECT 1 AS a",
          "DROP TABLE main.orders", "ALTER TABLE main.orders ADD COLUMN z INT", "CREATE SCHEMA evil",
        ]) expect(await g.error(sql), sql).toMatch(/read-only|read only|readonly|not allowed|Permission/i);
        // A flush of inlined rows is a write the read-only attach does not refuse by name: it tries to put a file in the folder, which a local lake's
        // read-only attach (readonly database) and a bucket's read-only key (403) refuse.
        expect(await g.error("CALL ducklake_flush_inlined_data('lake')")).toMatch(/readonly|read-only|403|Forbidden|Access Denied/i);
        expect(await g.run("SELECT count(*) FROM lake.snapshots()")).toEqual(snapshots);
      } finally {
        g.close();
      }
      expect(filesUnder(lakeFolder(s.l))).toEqual(files);
    });

    test("only the lake's folder and no local folder are reachable: the state folder, files/, the project's .env and the machine's files are refused", async () => {
      const g = await lakeSession(s, { readers: true, extensionDir: ready.dir });
      try {
        const root = s.l.p.root;
        for (const sql of [
          `SELECT * FROM read_text('${root}/.env')`, `SELECT * FROM read_text('${s.l.project.paths.stateDir}/serve-keys.json')`, `SELECT * FROM read_csv('${root}/files/x.csv')`,
          "SELECT * FROM read_text('/etc/hosts')", `SELECT * FROM glob('${root}/*')`, `COPY (SELECT 1 AS a) TO '${root}/evil.csv'`, `COPY (SELECT 1 AS a) TO '${root}/files/evil.csv'`,
          `ATTACH '${root}/evil.duckdb' AS evil`, `EXPORT DATABASE '${root}/evil'`,
        ]) expect(await g.error(sql), sql).toMatch(/Permission Error/);
        expect(existsSync(join(root, "evil.csv"))).toBe(false);
        expect(existsSync(join(root, "files", "evil.csv"))).toBe(false);
        expect(existsSync(join(root, "evil.duckdb"))).toBe(false);
        expect(readdirSync(root).includes("evil")).toBe(false);
      } finally {
        g.close();
      }
    });

    if (kind === "postgres") {
      test("with the gate bypassed, a COPY from the readers' process into the lake's bucket folder is refused by the store, because its key cannot write (acceptance 5)", async () => {
        const g = await lakeSession(s, { readers: true, extensionDir: ready.dir });
        const before = filesUnder(lakeFolder(s.l));
        try {
          // The folder is the one place the lockdown lets a remote path through, so DuckDB sends the request, and the store answers for the key.
          for (const target of ["evil.parquet", "main/orders/evil.parquet", "main/evil/ducklake-evil.parquet"]) {
            const copy = await g.error(`COPY (SELECT 1 AS a) TO '${s.l.bucket}${target}' (FORMAT PARQUET)`);
            expect(copy, target).toMatch(/403|Forbidden|Access Denied/i);
          }
          expect(await g.error(`COPY main.orders TO '${s.l.bucket}evil2.csv'`)).toMatch(/403|Forbidden|Access Denied/i);
          // Another folder of the same bucket, and another bucket: refused by the lockdown before any request is sent.
          for (const other of ["s3://lakeb/elsewhere/x.parquet", "s3://other/x.parquet"]) expect(await g.error(`COPY (SELECT 1 AS a) TO '${other}'`), other).toMatch(/Permission Error/);
          expect(await g.error("SELECT * FROM read_parquet('https://example.com/x.parquet')")).toMatch(/Permission Error/);
        } finally {
          g.close();
        }
        expect(filesUnder(lakeFolder(s.l))).toEqual(before);
        expect(existsSync(join(lakeFolder(s.l), "evil.parquet"))).toBe(false);
      });

      test("the catalog is protected by its login: past the gate, a DROP of the metadata is refused, and the lake still reads", async () => {
        const g = await lakeSession(s, { readers: true, extensionDir: ready.dir });
        try {
          const meta = "__ducklake_metadata_lake";
          for (const sql of [`CALL postgres_execute('${meta}', 'DROP TABLE ducklake_snapshot')`, `CALL postgres_execute('${meta}', 'DELETE FROM ducklake_snapshot')`, `CALL postgres_execute('${meta}', 'CREATE TABLE evil (a INT)')`]) {
            expect(await g.error(sql), sql).toMatch(/permission denied|must be owner|read-only|not allowed/i);
          }
          expect(Number((await g.run("SELECT count(*) FROM main.orders"))[0]![0])).toBeGreaterThan(0);
        } finally {
          g.close();
        }
      });

      test("a wrong password stops the start with the attach's own error, and names no credential anywhere", async () => {
        const l = await lakeProject("postgres", { extensionDir: ready.dir, rig: lakeRig, config: { serverMode: { enabled: true, quackPort: 0 }, serve: { sharedTables: ["orders"] } } });
        const wrongPassword = await openLakeEngine({ root: l.p.root, env: ProjectEnv.load(l.p.root, { ...l.env, LAKE_READER_PASSWORD: "not-the-password" }), extensionDir: ready.dir, resources: { threads: 2 } })
          .catch((x: Error) => x);
        expect(wrongPassword).toBeInstanceOf(Error);
        const text = JSON.stringify([(wrongPassword as Error).message, (wrongPassword as { problem?: unknown }).problem]);
        expect((wrongPassword as { code?: string }).code, text).toBe("LAKE_ATTACH_FAILED");
        for (const secret of [...RIG_SECRETS, "not-the-password"]) expect(text, secret).not.toContain(secret);
      }, 120_000);
        }
  });
}
