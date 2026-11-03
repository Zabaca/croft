// The TLS of a lake's Postgres catalog connection (DESIGN.md D159), against a real Postgres child that offers TLS with a self-signed
// certificate (issued for "localhost" only), and one that does not. What is under test: that verify-full connects with the right CA and
// is refused with the wrong CA, the wrong host name, or a server with no TLS; that require, prefer and disable do what libpq does; that
// a refusal is a stable error that names the setting and is never retried; that the CA file stays out of SQL's reach; and the project
// path (croft.json, $SSL_CERT_FILE, croft doctor). Nothing here reaches a network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lakeProject } from "../cli/commands/lake-project-testkit.ts";
import { cleanup as cleanupProjects, cli } from "../cli/commands/inspect-testkit.ts";
import { CroftError } from "../core/errors.ts";
import type { CatalogSslMode } from "../project/lake-config.ts";
import { isConnectionError } from "./lake.ts";
import { lakeRigReady, type LakeRig, rigConnection, startLakeRig } from "./lake-testkit.ts";
import { readListening, startPostgres, type TestPostgres } from "./mode-testkit.ts";
import { certsReady, makeCerts, type TestCerts } from "./tls-testkit.ts";
import { closeAllWarehouses, openWarehouse } from "./warehouse.ts";

const ready = lakeRigReady();
const certs = ready.ready ? certsReady() : { ready: false, skipReason: ready.skipReason };
if (!certs.ready) console.warn(`[lake-tls.test] SKIPPING the TLS catalog tests: ${certs.skipReason}`);
const maybe = certs.ready ? test : test.skip;

let tls: TestCerts;
let rig: LakeRig;
let plain: TestPostgres;
const made: string[] = [];
beforeAll(async () => {
  if (!certs.ready) return;
  tls = makeCerts();
  rig = await startLakeRig({ tls: { cert: tls.cert, key: tls.key } });
  plain = await startPostgres();
}, 120_000);
afterAll(async () => {
  await closeAllWarehouses();
  await cleanupProjects();
  await rig?.stop();
  await plain?.stop();
  tls?.remove();
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

type Catalog = { host?: string; sslMode?: CatalogSslMode; sslRootCert?: string };

/** A warehouse on a new lake of the TLS Postgres, attached with `catalog`'s TLS; `port` points it at the other Postgres instead. */
async function attach(catalog: Catalog, o: { port?: number; access?: "write" | "read" } = {}) {
  const lake = await rig.lake();
  const root = mkdtempSync(join(tmpdir(), "croft-laketls-"));
  made.push(root);
  const stateDir = join(root, ".croft");
  mkdirSync(stateDir, { recursive: true });
  const conn = rigConnection(rig, lake, { stateDir, extensionDir: ready.dir, catalog, ...(o.port ? { override: { port: o.port } } : {}) });
  const w = openWarehouse({ path: join(root, "w.duckdb"), mode: "read_write", timezone: "UTC", root, stateDir, lake: conn, register: false, isTTY: false });
  const r = openWarehouse({ path: join(root, "r.duckdb"), mode: "read_only", profile: "query", timezone: "UTC", root, stateDir, lake: conn, register: false, isTTY: false });
  return { lake, w, r };
}

/** Whether the lake's catalog connections of `user` are encrypted, as the server sees them: "true", "false", or "" for none. */
const encrypted = (db: string, user: string): Promise<string> =>
  rig.pg.sql(`SELECT coalesce(string_agg(DISTINCT s.ssl::text, ','), '') FROM pg_stat_ssl s JOIN pg_stat_activity a USING (pid) WHERE a.datname = '${db}' AND a.usename = '${user}'`);

const make = (w: Awaited<ReturnType<typeof attach>>["w"]) => w.write("make t", (tx) => tx.exec("CREATE TABLE t AS SELECT 1 AS a"), { runId: "r1" });
const refusal = async (p: Promise<unknown>): Promise<CroftError> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(CroftError);
  expect((e as CroftError).code).toBe("LAKE_ATTACH_FAILED");
  return e as CroftError;
};

describe("the catalog connection's TLS, in the warehouse", () => {
  maybe("verify-full with the right CA connects, writer and reader, and the server sees both encrypted", async () => {
    const { lake, w, r } = await attach({ host: "localhost", sslMode: "verify-full", sslRootCert: tls.cert });
    await make(w);
    expect(await r.read(async (db) => Number((await db.all<{ n: number | bigint }>("SELECT count(*) AS n FROM t"))[0]!.n), { purpose: "test" })).toBe(1);
    expect(await encrypted(lake.db, "lakew")).toBe("true");
    expect(await encrypted(lake.db, "laker")).toBe("true");
  }, 60_000);

  maybe("verify-full with another authority's CA is refused: a stable code, not retryable, a hint that names the setting, and never treated as a dropped connection", async () => {
    const { w } = await attach({ host: "localhost", sslMode: "verify-full", sslRootCert: tls.otherCa });
    const e = await refusal(make(w));
    expect(e.problem.message).toContain("certificate verify failed");
    expect(e.problem.retryable).toBe(false);
    expect(e.problem.details).toMatchObject({ tls: true });
    expect(e.problem.details?.refused).toBeUndefined();
    expect(e.problem.hint).toContain("lake.catalog.sslMode");
    expect(e.problem.hint).toContain("lake.catalog.sslRootCert");
    expect(isConnectionError(e.problem.details!.duckdb)).toBe(false);
  }, 60_000);

  maybe("verify-full with the right CA and a host name the certificate was not issued for (127.0.0.1) is refused, and says which name", async () => {
    const { w } = await attach({ host: "127.0.0.1", sslMode: "verify-full", sslRootCert: tls.cert });
    const e = await refusal(make(w));
    expect(e.problem.message).toMatch(/does not match host name "127\.0\.0\.1"/);
    expect(e.problem.hint).toContain("issued for the name in lake.catalog.host");
    expect(e.problem.hint).toContain("lake.catalog.sslMode");
    expect(e.problem.retryable).toBe(false);
    expect(e.problem.details).toMatchObject({ tls: true });
  }, 60_000);

  maybe("verify-full against a Postgres with no TLS is refused (it never falls back to plaintext)", async () => {
    const { w } = await attach({ host: "127.0.0.1", sslMode: "verify-full", sslRootCert: tls.cert }, { port: plain.port });
    const e = await refusal(make(w));
    expect(e.problem.message).toContain("server does not support SSL");
    expect(e.problem.details).toMatchObject({ tls: true });
    expect(e.problem.retryable).toBe(false);
  }, 60_000);

  maybe("require encrypts with no CA named; against a server with no TLS it is refused", async () => {
    const a = await attach({ host: "127.0.0.1", sslMode: "require" });
    await make(a.w);
    expect(await encrypted(a.lake.db, "lakew")).toBe("true");
    const b = await attach({ host: "127.0.0.1", sslMode: "require" }, { port: plain.port });
    const e = await refusal(make(b.w));
    expect(e.problem.hint).toContain('lake.catalog.sslMode "require"');
  }, 60_000);

  maybe("prefer encrypts when the server offers TLS and goes on without it when it does not (what croft did before the setting)", async () => {
    const a = await attach({ host: "127.0.0.1", sslMode: "prefer" });
    await make(a.w);
    expect(await encrypted(a.lake.db, "lakew")).toBe("true");
    // The other Postgres has no such login: it answers the login, in plaintext, which proves the connection was made without TLS.
    const b = await attach({ host: "127.0.0.1", sslMode: "prefer" }, { port: plain.port });
    const e = await refusal(make(b.w));
    expect(e.problem.message).toContain("password authentication failed");
    expect(e.problem.details).toMatchObject({ refused: true });
    expect(e.problem.details?.tls).toBeUndefined();
  }, 60_000);

  maybe("disable never encrypts, even where the server offers TLS", async () => {
    const { lake, w } = await attach({ host: "127.0.0.1", sslMode: "disable" });
    await make(w);
    expect(await encrypted(lake.db, "lakew")).toBe("false");
  }, 60_000);

  /** `attach`, in a child process that was started with `env`; the server's view of the writer's connection while the child holds it. */
  async function inChild(catalog: Catalog, env: Record<string, string>): Promise<string> {
    const lake = await rig.lake();
    const root = mkdtempSync(join(tmpdir(), "croft-laketls-"));
    made.push(root);
    const args = { root, extensionDir: ready.dir, pg: { host: rig.pg.host, port: rig.pg.port }, s3Endpoint: rig.s3.endpoint, lake, catalog };
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "tls-child-testkit.ts"), JSON.stringify(args)], {
      stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CROFT_TEST_HARNESS: "1", ...env },
    });
    try {
      await readListening(child, 45_000); // the child says so once the lake is written
      return await encrypted(lake.db, "lakew");
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  }

  maybe("the setting wins over the environment: with PGSSLMODE=disable in the process, a secret with no SSLMODE is plaintext, and croft's is still encrypted", async () => {
    const env = { PGSSLMODE: "disable" };
    // The control: libpq does read PGSSLMODE in that child, or the next line would prove nothing.
    expect(await inChild({ host: "127.0.0.1" }, env)).toBe("false");
    expect(await inChild({ host: "localhost", sslMode: "verify-full", sslRootCert: tls.cert }, env)).toBe("true");
  }, 120_000);

  maybe("the CA file is not newly readable from SQL: libpq reads it, DuckDB's file system never does", async () => {
    const { w } = await attach({ host: "localhost", sslMode: "verify-full", sslRootCert: tls.cert });
    await make(w);
    const sql = (q: string) => w.read((db) => db.all(q), { purpose: "test" }).then(() => "allowed", (e: Error) => e.message);
    expect(await sql(`SELECT * FROM read_text('${tls.cert}')`)).toMatch(/Permission|not allowed|allowed_directories|access/i);
    expect(await sql(`SELECT * FROM read_text('/etc/ssl/cert.pem')`)).toMatch(/Permission|not allowed|allowed_directories|access|No files/i);
  }, 60_000);
});

describe("the catalog connection's TLS, from croft.json", () => {
  const writeBlock = (root: string, catalog: Record<string, unknown>) => {
    const file = join(root, "croft.json");
    const config = JSON.parse(readFileSync(file, "utf8")) as { lake: { catalog: Record<string, unknown> } };
    config.lake.catalog = { ...config.lake.catalog, ...catalog };
    for (const [k, v] of Object.entries(catalog)) if (v === undefined) delete config.lake.catalog[k];
    writeFileSync(file, JSON.stringify(config, null, 2));
  };

  maybe("a project with verify-full builds its lake and reads it; the wrong CA, a missing CA file and a missing bundle are each named; $SSL_CERT_FILE stands in for the bundle; doctor says what it checks", async () => {
    const lake = await rig.lake({ host: "localhost" });
    (lake.block.catalog as Record<string, unknown>).sslMode = "verify-full";
    (lake.block.catalog as Record<string, unknown>).sslRootCert = tls.cert;
    const l = await lakeProject("postgres", { extensionDir: ready.dir, rig, lake }); // croft run, as the writer, over verified TLS
    const query = async (env: Record<string, string> = {}) => {
      const r = await cli(["query", "SELECT count(*) AS n FROM orders", "--json"], { cwd: l.p.root, env: { ...l.env, ...env } });
      await closeAllWarehouses();
      return r;
    };
    const ok = await query();
    expect(ok.exit, ok.stdout).toBe(0);

    const doctor = await cli(["doctor", "--json"], { cwd: l.p.root, env: l.env });
    await closeAllWarehouses();
    const line = (doctor.json as { data: { checks: { id: string; status: string; text: string }[] } }).data.checks.find((c) => c.id === "lake.catalog.tls")!;
    expect(line.status).toBe("ok");
    expect(line.text).toContain("checks the server's certificate and host name");
    expect(line.text).toContain(`against ${tls.cert} (named by lake.catalog.sslRootCert)`);

    // Another authority's CA: refused at the attach, naming the setting.
    writeBlock(l.p.root, { sslRootCert: tls.otherCa });
    const wrong = await query();
    expect(wrong.exit).toBe(2);
    expect(JSON.stringify(wrong.json)).toContain("LAKE_ATTACH_FAILED");
    expect(JSON.stringify(wrong.json)).toContain("lake.catalog.sslRootCert");

    // A CA file that is not there: CONFIG_INVALID, before anything connects.
    writeBlock(l.p.root, { sslRootCert: "certs/nowhere.pem" });
    const gone = await query();
    expect(gone.exit).toBe(2);
    expect(JSON.stringify(gone.json)).toContain("CONFIG_INVALID");
    expect(JSON.stringify(gone.json)).toContain("certs/nowhere.pem");

    // Doctor says the same refusal, instead of claiming the check is made.
    const doctorLine = async (env: Record<string, string> = {}) => {
      const d = await cli(["doctor", "--json"], { cwd: l.p.root, env: { ...l.env, ...env } });
      await closeAllWarehouses();
      return (d.json as { data: { checks: { id: string; status: string; text: string }[] } }).data.checks.find((c) => c.id === "lake.catalog.tls")!;
    };
    expect(await doctorLine()).toMatchObject({ status: "error", text: expect.stringContaining("certs/nowhere.pem") });

    // No file named: this machine's bundle, which $SSL_CERT_FILE points at here (the one place the test can say it).
    writeBlock(l.p.root, { sslRootCert: undefined });
    const viaEnv = await query({ SSL_CERT_FILE: tls.cert });
    expect(viaEnv.exit, viaEnv.stdout).toBe(0);
    expect(await doctorLine({ SSL_CERT_FILE: tls.cert })).toMatchObject({ status: "ok", text: expect.stringContaining(`against ${tls.cert} (chosen by $SSL_CERT_FILE)`) });
    const viaOther = await query({ SSL_CERT_FILE: tls.otherCa });
    expect(viaOther.exit).toBe(2);
    expect(JSON.stringify(viaOther.json)).toContain("LAKE_ATTACH_FAILED");

    // On this machine with no setting at all the connection is prefer: it works, and doctor says it is not checked.
    writeBlock(l.p.root, { sslMode: undefined });
    const dflt = await query();
    expect(dflt.exit, dflt.stdout).toBe(0);
    const doctor2 = await cli(["doctor", "--json"], { cwd: l.p.root, env: l.env });
    await closeAllWarehouses();
    const line2 = (doctor2.json as { data: { checks: { id: string; status: string; text: string }[] } }).data.checks.find((c) => c.id === "lake.catalog.tls")!;
    expect(line2.status).toBe("info");
    expect(line2.text).toContain("sslMode prefer");
  }, 180_000);
});
