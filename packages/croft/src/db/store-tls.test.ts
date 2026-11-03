// A lake whose store is reached over HTTPS (DESIGN.md D-R1): the first real-lake trial (R2) could neither read nor write a byte of it, because
// croft's lockdown never let DuckDB read a CA file, and the one failure surfaced as INTERNAL_ERROR, QUERY_FAILED or LAKE_MAINTENANCE_FAILED by
// where it was met. The test rig's store is served over HTTPS with a self-signed certificate (store-tls-testkit.ts), which is what the suite
// never had: with the CA the project names every command works; without it, or with another's, or for another name, every command says
// LAKE_STORE_TLS and the fix.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { catalogEncryptionLine } from "../cli/commands/doctor.ts";
import { cleanup, cli, makeProject } from "../cli/commands/inspect-testkit.ts";
import { ORDERS_SQL } from "../cli/commands/lake-project-testkit.ts";
import { CroftError } from "../core/errors.ts";
import { modePaths } from "./modes.ts";
import { lakeRigReady, type LakeRig, type RigLake, useLake } from "./lake-testkit.ts";
import { isStoreTls, storeCaFile, storeTlsProblem } from "./store-tls.ts";
import { makeStoreCerts, startTlsLakeRig, storeCertsReady, type StoreCerts } from "./store-tls-testkit.ts";
import { closeAllWarehouses } from "./warehouse.ts";

const ready = lakeRigReady();
const certsOk = storeCertsReady();
const runnable = ready.ready && certsOk.ready;
if (!ready.ready) console.warn(`[store-tls.test] SKIPPING the store TLS tests: ${ready.skipReason}`);
if (!certsOk.ready) console.warn(`[store-tls.test] SKIPPING the store TLS tests: ${certsOk.skipReason}`);
const maybe = runnable ? test : test.skip;

let rig: LakeRig | undefined;
let certs: StoreCerts | undefined;
let wrongNameRig: LakeRig | undefined;
beforeAll(async () => {
  if (!runnable) return;
  certs = makeStoreCerts();
  rig = await startTlsLakeRig(certs);
  wrongNameRig = await startTlsLakeRig(certs.wrongName);
}, 120_000);
afterAll(async () => {
  await closeAllWarehouses();
  await cleanup();
  await rig?.stop();
  await wrongNameRig?.stop();
  certs?.remove();
});

type Problem = { code: string; hint?: string; details?: Record<string, unknown>; message: string };

/** Every problem an envelope holds, in problems[] and in the steps of a run. */
function problemsOf(json: unknown): Problem[] {
  const env = json as { problems?: Problem[]; data?: { steps?: { error?: Problem }[]; checks?: { code?: string; status?: string; text?: string }[] } };
  const fromSteps = (env.data?.steps ?? []).flatMap((s) => (s.error ? [s.error] : []));
  return [...(env.problems ?? []), ...fromSteps];
}

/** A project over `lake` with the bucket's `sslRootCert` as given, and its secrets. */
function project(lake: RigLake, sslRootCert?: string): { root: string; env: Record<string, string>; use(cert?: string): void } {
  const p = makeProject({ files: { "files/x.csv": "a,b\n1,2\n", "assets/orders.sql": ORDERS_SQL,
    // Three rows: kept inside the catalog until a pass flushes them into a file, which is a write to the store.
    "assets/few.sql": "-- key: id\nSELECT range AS id FROM range(3)\n" } });
  const env: Record<string, string> = { CROFT_EXTENSION_DIR: ready.dir, ...lake.env };
  const use = (cert?: string) => {
    const bucket = { ...(lake.block.bucket as Record<string, unknown>), ...(cert ? { sslRootCert: cert } : {}) };
    writeFileSync(join(p.root, "croft.json"), JSON.stringify({ database: "warehouse.duckdb", timezone: "UTC", lake: { ...lake.block, bucket } }));
  };
  use(sslRootCert);
  useLake(p.root, { block: { ...lake.block, bucket: { ...(lake.block.bucket as Record<string, unknown>), ...(sslRootCert ? { sslRootCert } : {}) } }, env: lake.env });
  return { root: p.root, env, use };
}

describe("a lake whose store is served over HTTPS", () => {
  maybe("with the CA the project names, every command works: run, query, status, doctor, maintain, backup", async () => {
    const lake = await rig!.lake();
    const p = project(lake, certs!.cert);
    const run = await cli(["run", "--foreground", "--json"], { cwd: p.root, env: p.env });
    expect(run.exit, run.stdout).toBe(0);
    await closeAllWarehouses();
    // The Parquet files are in the HTTPS store: the CA file was readable by DuckDB, and nothing else of the machine's files was asked for.
    expect(existsSync(lake.files)).toBe(true);
    expect(readdirSync(join(lake.files, "main", "orders")).some((f) => f.endsWith(".parquet"))).toBe(true);
    for (const argv of [["query", "select count(*) as n from orders"], ["status"], ["doctor"], ["maintain"], ["backup"]]) {
      const r = await cli([...argv, "--json"], { cwd: p.root, env: p.env });
      expect(r.exit, `${argv[0]}: ${r.stdout}`).toBe(0);
      await closeAllWarehouses();
    }
    const q = await cli(["query", "select count(*) as n from orders", "--json"], { cwd: p.root, env: p.env });
    expect((q.json as { data: { rows: { n: number }[] } }).data.rows[0]!.n).toBe(20);
    await closeAllWarehouses();
    // The CA file is the only file of the machine DuckDB may read, and SQL cannot change it or reach another: a write to it, and a read of any
    // other file, are refused. (SQL can read the CA file itself, a file of public certificates.)
    for (const sql of [`copy (select 1) to '${certs!.cert}'`, `select * from read_text('/etc/hosts')`]) {
      const r = await cli(["query", sql, "--json"], { cwd: p.root, env: p.env });
      expect(r.exit, sql).not.toBe(0);
      await closeAllWarehouses();
    }
    expect(readFileSync(certs!.cert, "utf8")).toContain("BEGIN CERTIFICATE");
  }, 180_000);

  maybe("without the CA, every command that meets the store says LAKE_STORE_TLS and the fix, and none says INTERNAL_ERROR, QUERY_FAILED or LAKE_MAINTENANCE_FAILED", async () => {
    const lake = await rig!.lake();
    const p = project(lake, certs!.cert);
    expect((await cli(["run", "--foreground", "--json"], { cwd: p.root, env: p.env })).exit).toBe(0);
    await closeAllWarehouses();
    // The project drops the setting (or names a CA that does not vouch for the store): the machine's own bundle does not know the store's authority.
    for (const cert of [undefined, certs!.otherCa]) {
      p.use(cert);
      for (const argv of [["run", "orders", "--foreground"], ["query", "select max(note) from orders"], ["describe", "orders"], ["maintain"], ["backup"]]) {
        const r = await cli([...argv, "--json"], { cwd: p.root, env: p.env });
        const codes = problemsOf(r.json).map((x) => x.code);
        expect(codes, `${cert ? "another CA" : "no CA"}: croft ${argv[0]}: ${r.stdout.slice(0, 600)}`).toContain("LAKE_STORE_TLS");
        for (const bad of ["INTERNAL_ERROR", "QUERY_FAILED", "LAKE_MAINTENANCE_FAILED"]) expect(codes, `croft ${argv[0]}`).not.toContain(bad);
        const tls = problemsOf(r.json).find((x) => x.code === "LAKE_STORE_TLS")!;
        expect(tls.hint, argv[0]).toContain("lake.bucket.sslRootCert");
        await closeAllWarehouses();
      }
      const doctor = await cli(["doctor", "--json"], { cwd: p.root, env: p.env });
      expect(problemsOf(doctor.json).map((x) => x.code), "croft doctor").toContain("LAKE_STORE_TLS");
      await closeAllWarehouses();
    }
  }, 240_000);

  maybe("a store whose certificate is for another name is LAKE_STORE_TLS too, even with the CA that signed it", async () => {
    const lake = await wrongNameRig!.lake();
    const p = project(lake, certs!.wrongName.cert);
    const r = await cli(["run", "orders", "--foreground", "--json"], { cwd: p.root, env: p.env });
    expect(r.exit).not.toBe(0);
    const tls = problemsOf(r.json).find((x) => x.code === "LAKE_STORE_TLS");
    expect(tls, r.stdout.slice(0, 600)).toBeDefined();
    expect(tls!.details).toMatchObject({ kind: "untrusted" });
  }, 120_000);

  maybe("a CA file the project names that is not a file is CONFIG_INVALID before anything is attached", async () => {
    const lake = await rig!.lake();
    const p = project(lake, "certs/no-such-ca.pem");
    const r = await cli(["query", "select 1", "--json"], { cwd: p.root, env: p.env });
    expect(r.exit).not.toBe(0);
    const codes = problemsOf(r.json).map((x) => x.code);
    expect(codes).toContain("CONFIG_INVALID");
    expect(JSON.stringify(r.json)).toContain("lake.bucket.sslRootCert");
  }, 60_000);
});

type Check = { id: string; status: string; text: string; code?: string; details?: Record<string, unknown> };
const checksOf = (json: unknown): Check[] => (json as { data: { checks: Check[] } }).data.checks;
const filesIn = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : []);

describe("croft doctor asks the bucket before the first run (D-R6)", () => {
  maybe("a lake nobody has made yet: with the CA the bucket answers and the folder is empty; without it doctor says LAKE_STORE_TLS, not 'no problems found'", async () => {
    const lake = await rig!.lake();
    const p = project(lake, certs!.cert);
    const ok = await cli(["doctor", "--json"], { cwd: p.root, env: p.env });
    await closeAllWarehouses();
    const store = checksOf(ok.json).find((c) => c.id === "lake.store")!;
    expect(store, ok.stdout.slice(0, 800)).toMatchObject({ status: "ok" });
    expect(store.text).toContain("is empty");
    expect(store.details).toMatchObject({ listed: 0, caFile: certs!.cert });
    // Doctor wrote nothing into the lake's folder (not even the folder).
    expect(filesIn(lake.files)).toEqual([]);
    expect(checksOf(ok.json).find((c) => c.id === "warehouse")!.text).toContain("not created yet");

    // The trial's case: the first run could write nothing, and doctor said all was well.
    p.use(undefined);
    const bad = await cli(["doctor", "--json"], { cwd: p.root, env: p.env });
    await closeAllWarehouses();
    const broken = checksOf(bad.json).find((c) => c.id === "lake.store")!;
    expect(broken, bad.stdout.slice(0, 800)).toMatchObject({ status: "error", code: "LAKE_STORE_TLS" });
    expect(bad.exit).not.toBe(0);
  }, 120_000);

  maybe("after a run it lists the folder and reads the footer of a data file, writes nothing, and says whether the catalog connection is encrypted", async () => {
    const lake = await rig!.lake();
    const p = project(lake, certs!.cert);
    expect((await cli(["run", "--foreground", "--json"], { cwd: p.root, env: p.env })).exit).toBe(0);
    await closeAllWarehouses();
    const before = filesIn(lake.files);
    const r = await cli(["doctor", "--json"], { cwd: p.root, env: p.env });
    await closeAllWarehouses();
    const checks = checksOf(r.json);
    const store = checks.find((c) => c.id === "lake.store")!;
    expect(store, r.stdout.slice(0, 800)).toMatchObject({ status: "ok" });
    expect(store.text).toMatch(/objects? under s3:\/\/lakeb\/proj\d+\/ listed in \d+ ms, the footer of \S+\.parquet read in \d+ ms/);
    expect(filesIn(lake.files)).toEqual(before);
    // The rig's Postgres offers no TLS and is on this machine: said, as a note.
    expect(checks.find((c) => c.id === "lake.catalog.encrypted")).toMatchObject({ status: "info" });
    expect(checks.find((c) => c.id === "lake.catalog.encrypted")!.text).toContain("not encrypted; the catalog is on this machine");
  }, 120_000);

  test("the catalog line: encrypted is ok; plain text to this machine is a note; plain text to another machine is a warning", () => {
    expect(catalogEncryptionLine("db.example.com", { encrypted: true, version: "TLSv1.3" })).toMatchObject({ status: "ok", text: expect.stringContaining("(TLSv1.3)") });
    expect(catalogEncryptionLine("127.0.0.1", { encrypted: false, version: null }).status).toBe("info");
    expect(catalogEncryptionLine("localhost", { encrypted: false, version: null }).status).toBe("info");
    const warn = catalogEncryptionLine("db.internal", { encrypted: false, version: null });
    expect(warn.status).toBe("warn");
    expect(warn.text).toContain("NOT encrypted");
  });
});

describe("the pieces", () => {
  test("a store over TLS allows its CA file by name, and nothing else; a store without TLS allows nothing", () => {
    const lake = (data: Record<string, unknown>) => ({
      kind: "lake" as const, secretDir: "/s", lake: { access: "read" as const, catalog: { kind: "postgres" as const, host: "h", port: 1, database: "d", user: "u", password: "p" },
        data: { path: "s3://b/f/", keyId: "k", secretKey: "s", ...data } },
    });
    expect(modePaths(lake({ caFile: "/etc/ssl/cert.pem", useSsl: true }))).toEqual(["/etc/ssl/cert.pem"]);
    expect(modePaths(lake({ useSsl: false }))).toEqual([]);
    expect(modePaths(undefined)).toEqual([]);
  });

  test("storeCaFile: the named file, relative to the project, ~/ for home; nothing without TLS; a missing file names the setting", () => {
    const file = (p: string) => p === "/proj/certs/ca.pem" || p === "/home/me/ca.pem" || p === "/abs/ca.pem";
    expect(storeCaFile({ useSsl: true, sslRootCert: "certs/ca.pem" }, "/proj", { file })).toBe("/proj/certs/ca.pem");
    expect(storeCaFile({ useSsl: true, sslRootCert: "~/ca.pem" }, "/proj", { file, home: "/home/me" })).toBe("/home/me/ca.pem");
    expect(storeCaFile({ useSsl: true, sslRootCert: "/abs/ca.pem" }, "/proj", { file })).toBe("/abs/ca.pem");
    expect(storeCaFile({ useSsl: false, sslRootCert: "certs/ca.pem" }, "/proj", { file })).toBeUndefined();
    let err: unknown;
    try { storeCaFile({ useSsl: true, sslRootCert: "nope.pem" }, "/proj", { file }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CroftError);
    expect((err as CroftError).code).toBe("CONFIG_INVALID");
    expect((err as CroftError).message).toContain("lake.bucket.sslRootCert");
  });

  test("DuckDB's words for a certificate that does not check out, and only those, are LAKE_STORE_TLS", () => {
    const refused = "Permission Error: Cannot read a CA certificate bundle: file system access is restricted by configuration. Add one of /etc/ssl/cert.pem to allowed_paths";
    const bad = 'IO Error: S3 upload request for "s3://b/f/x.parquet" could not be completed: SSL peer certificate or SSH remote key was not OK';
    expect(isStoreTls(new Error(refused))).toBe(true);
    expect(isStoreTls(new Error(bad))).toBe(true);
    expect(storeTlsProblem(new Error(refused))).toMatchObject({ code: "LAKE_STORE_TLS", retryable: false, details: { kind: "no-ca-file" } });
    expect(storeTlsProblem(new Error(bad), { named: true })).toMatchObject({ code: "LAKE_STORE_TLS", details: { kind: "untrusted" } });
    expect(storeTlsProblem(new Error(bad))!.hint).toContain("lake.bucket.sslRootCert");
    for (const other of ["HTTP Error: HTTP GET error reading 's3://b/f/x.parquet' (HTTP 403 Forbidden)", "IO Error: Connection refused", "Invalid Input Error: nothing"]) {
      expect(isStoreTls(new Error(other)), other).toBe(false);
      expect(storeTlsProblem(new Error(other)), other).toBeNull();
    }
  });
});
