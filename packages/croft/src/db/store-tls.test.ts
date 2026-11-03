// A lake whose store is reached over HTTPS (DESIGN.md D160): the first real-lake trial (R2) could neither read nor write a byte of it, because
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
    // The CA file is the only file of the machine DuckDB may read, and it is the instance's, not SQL's: the gate refuses a query that names it,
    // to read or to overwrite, as it refuses one that names any other file (D160).
    for (const sql of [`copy (select 1) to '${certs!.cert}'`, `select * from read_text('${certs!.cert}')`, `select * from read_text('/etc/hosts')`]) {
      const r = await cli(["query", sql, "--json"], { cwd: p.root, env: p.env });
      expect(r.exit, sql).not.toBe(0);
      expect(problemsOf(r.json).map((x) => x.code), sql).toContain(sql.includes("COPY") || sql.startsWith("copy") ? "QUERY_NOT_SELECT" : "QUERY_PATH_DENIED");
      expect(JSON.stringify(r.json), sql).not.toContain("BEGIN CERTIFICATE");
      await closeAllWarehouses();
    }
    expect(readFileSync(certs!.cert, "utf8")).toContain("BEGIN CERTIFICATE");
  }, 180_000);

  // No sslRootCert: the CA is found the way the catalog's is, $SSL_CERT_FILE of the project's environment first (db/ca-bundle.ts, D160).
  maybe("a CA bundle found by the finder ($SSL_CERT_FILE) is allowed and used: every command works with no sslRootCert in croft.json", async () => {
    const lake = await rig!.lake();
    const p = project(lake, undefined);
    const env = { ...p.env, SSL_CERT_FILE: certs!.cert };
    expect((await cli(["run", "--foreground", "--json"], { cwd: p.root, env })).exit).toBe(0);
    await closeAllWarehouses();
    expect(filesIn(lake.files).some((f) => f.endsWith(".parquet"))).toBe(true);
    for (const argv of [["query", "select max(note) from orders"], ["maintain"], ["backup"], ["doctor"]]) {
      const r = await cli([...argv, "--json"], { cwd: p.root, env });
      expect(r.exit, `${argv[0]}: ${r.stdout.slice(0, 500)}`).toBe(0);
      if (argv[0] === "doctor") expect(checksOf(r.json).find((c) => c.id === "lake.store")!.details).toMatchObject({ caFile: certs!.cert });
      await closeAllWarehouses();
    }
  }, 180_000);

  maybe("without the CA, every command that meets the store says LAKE_STORE_TLS and the fix, and none says INTERNAL_ERROR, QUERY_FAILED or LAKE_MAINTENANCE_FAILED", async () => {
    const lake = await rig!.lake();
    const p = project(lake, certs!.cert);
    expect((await cli(["run", "--foreground", "--json"], { cwd: p.root, env: p.env })).exit).toBe(0);
    await closeAllWarehouses();
    // The CA the check uses does not vouch for the store: a bundle $SSL_CERT_FILE names, a file the project names, or (nothing named) this machine's own
    // bundle, which does not know the store's authority; on a machine with no bundle at all the refusal is the same code, kind no-ca-file.
    const cases: { label: string; cert?: string; env: Record<string, string> }[] = [
      { label: "$SSL_CERT_FILE names a bundle that does not vouch for the store", env: { SSL_CERT_FILE: certs!.otherCa } },
      { label: "the project names another CA", cert: certs!.otherCa, env: {} },
      { label: "this machine's own bundle", env: { SSL_CERT_FILE: "/no/such/bundle.pem" } },
    ];
    for (const c of cases) {
      p.use(c.cert);
      const env = { ...p.env, ...c.env };
      for (const argv of [["run", "orders", "--foreground"], ["query", "select max(note) from orders"], ["describe", "orders"], ["maintain"], ["backup"]]) {
        const r = await cli([...argv, "--json"], { cwd: p.root, env });
        const codes = problemsOf(r.json).map((x) => x.code);
        expect(codes, `${c.label}: croft ${argv[0]}: ${r.stdout.slice(0, 600)}`).toContain("LAKE_STORE_TLS");
        for (const bad of ["INTERNAL_ERROR", "QUERY_FAILED", "LAKE_MAINTENANCE_FAILED"]) expect(codes, `croft ${argv[0]}`).not.toContain(bad);
        const tls = problemsOf(r.json).find((x) => x.code === "LAKE_STORE_TLS")!;
        expect(tls.hint, argv[0]).toContain("lake.bucket.sslRootCert");
        expect(["untrusted", "no-ca-file"], c.label).toContain(String(tls.details?.kind));
        await closeAllWarehouses();
      }
      const doctor = await cli(["doctor", "--json"], { cwd: p.root, env });
      expect(problemsOf(doctor.json).map((x) => x.code), `croft doctor, ${c.label}`).toContain("LAKE_STORE_TLS");
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

  // DuckDB 2.0's enable_server_cert_verification defaults to false, and its httplib client then reads a store with a certificate nobody vouches for
  // (measured: no CA and the wrong CA both read and wrote). croft pins the check on and the curl client; a prepare hook that runs before the lock
  // forces httplib back, as a default or a setting of the machine's could, and the read must still be refused (D160).
  maybe("with the httplib client forced, the wrong CA is still refused, and the right one works", async () => {
    const { mkdtempSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { openWarehouse } = await import("./warehouse.ts");
    const { rigConnection } = await import("./lake-testkit.ts");
    const lake = await rig!.lake();
    const open = (caFile: string) => {
      const root = mkdtempSync(join(tmpdir(), "croft-httplib-"));
      const stateDir = join(root, ".croft");
      mkdirSync(stateDir, { recursive: true });
      const base = rigConnection(rig!, lake, { stateDir, extensionDir: ready.dir });
      const conn = {
        ...base,
        mode: (access: "write" | "read") => {
          const m = base.mode(access);
          if (m.kind !== "lake") throw new Error("expected a lake mode");
          return {
            ...m,
            // httplib also sends to a proxy named in the environment, even for 127.0.0.1 (HTTPS_PROXY made it fail with "Proxy connection failed"
            // before it reached the certificate); the test is about the certificate.
            prepare: async (c: { run(sql: string): Promise<unknown> }) => { await c.run("SET GLOBAL httpfs_client_implementation = 'httplib'"); await c.run("SET GLOBAL http_proxy = ''"); },
            lake: { ...m.lake, data: { ...m.lake.data, useSsl: true, caFile } },
          };
        },
      };
      return openWarehouse({ path: join(root, "w.duckdb"), mode: "read_write", timezone: "UTC", root, stateDir, lake: conn, isTTY: false, register: false });
    };
    const write = (w: ReturnType<typeof open>) => w.write("x", (tx) => tx.exec("CREATE TABLE t AS SELECT range AS id FROM range(50)"), { runId: "r_test" });
    const wrong = open(certs!.otherCa);
    const refused = await write(wrong).then(() => null, (e: unknown) => e);
    await wrong.close();
    await closeAllWarehouses();
    expect(refused, "the wrong CA must not be able to write").toBeInstanceOf(CroftError);
    expect((refused as CroftError).code).toBe("LAKE_STORE_TLS");
    expect(filesIn(lake.files), "nothing reached the store").toEqual([]);
    const right = open(certs!.cert);
    await write(right);
    await right.close();
    await closeAllWarehouses();
    expect(filesIn(lake.files).some((f) => f.endsWith(".parquet"))).toBe(true);
  }, 120_000);

  // Bun's fetch honours NODE_TLS_REJECT_UNAUTHORIZED=0 (measured: it read a self-signed store with the wrong CA), and croft backup's mirror uses
  // fetch. The mirror names rejectUnauthorized, which beats the variable, so a machine that turned checking off for its other tools still has
  // the bucket's certificate checked by croft (D160). The variable is read when the process starts, so the mirror runs in a child that has it set.
  maybe("with NODE_TLS_REJECT_UNAUTHORIZED=0 set, the backup mirror still refuses a store whose certificate the CA does not vouch for", async () => {
    const script = `import { listObjects } from ${JSON.stringify(join(import.meta.dir, "s3-mirror.ts"))};
const a = { endpoint: "127.0.0.1:" + process.env.STORE_PORT, region: "auto", useSsl: true, urlStyle: "path", bucket: "lakeb", keyId: "RKEYID0123456789", secretKey: "x", caFile: process.env.STORE_CA };
try { for await (const o of listObjects(a, "")) void o; console.log("READ"); } catch (e) { console.log("REFUSED " + (e as { code?: string }).code); }`;
    const run = async (ca: string) => {
      const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_TLS_REJECT_UNAUTHORIZED: "0", STORE_PORT: String(rig!.s3.port), STORE_CA: ca };
      const proc = Bun.spawn([process.execPath, "-e", script], { env, stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return out.trim();
    };
    expect(await run(certs!.otherCa)).toBe("REFUSED LAKE_STORE_TLS");
    expect(await run(certs!.cert)).toBe("READ");
  }, 60_000);

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

describe("croft doctor asks the bucket before the first run (D165)", () => {
  maybe("a lake nobody has made yet: with the CA the bucket answers and the folder is empty; without it doctor says LAKE_STORE_TLS, not 'no problems found'", async () => {
    const lake = await rig!.lake();
    const p = project(lake, certs!.cert);
    const ok = await cli(["doctor", "--json"], { cwd: p.root, env: p.env });
    await closeAllWarehouses();
    const store = checksOf(ok.json).find((c) => c.id === "lake.store")!;
    expect(store, ok.stdout.slice(0, 800)).toMatchObject({ status: "ok" });
    expect(store.text).toContain("is empty");
    expect(store.details).toMatchObject({ empty: true, caFile: certs!.cert });
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
    expect(store.text).toMatch(/s3:\/\/lakeb\/proj\d+\/ listed in \d+ ms, the footer of \S+\.parquet read in \d+ ms/);
    expect(filesIn(lake.files)).toEqual(before);
    // The rig's Postgres offers no TLS and is on this machine: said, as a note.
    expect(checks.find((c) => c.id === "lake.catalog.encrypted")).toMatchObject({ status: "info" });
    expect(checks.find((c) => c.id === "lake.catalog.encrypted")!.text).toContain("not encrypted: the server offers no TLS; the catalog is on this machine");
  }, 120_000);

  maybe("a folder of more than a page of objects (6,000) still answers: the first page proves the key, the endpoint and the certificate, and it is said so", async () => {
    const { mkdirSync } = await import("node:fs");
    const lake = await rig!.lake();
    const p = project(lake, certs!.cert);
    expect((await cli(["run", "--foreground", "--json"], { cwd: p.root, env: p.env })).exit).toBe(0);
    await closeAllWarehouses();
    mkdirSync(join(lake.files, "main", "many"), { recursive: true });
    for (let i = 0; i < 6000; i++) writeFileSync(join(lake.files, "main", "many", `f${i}.txt`), "x");
    const r = await cli(["doctor", "--json"], { cwd: p.root, env: p.env });
    await closeAllWarehouses();
    const store = checksOf(r.json).find((c) => c.id === "lake.store")!;
    expect(store, r.stdout.slice(0, 600)).toMatchObject({ status: "ok" });
    // DuckDB's locked instance cannot list past 1,000 objects (db/lake-probe.ts): the probe says what it knows instead of failing the lake.
    expect(store.text).toContain("it holds more than 1,000 objects");
    expect(store.details).toMatchObject({ many: true, empty: false });
  }, 120_000);

  test("the catalog line is the client's side: the setting for verify-full, require and disable, the server's offer for prefer, and nothing false when it cannot be known", () => {
    // The second real-lake trial's hosted catalog: verify-full to a pooler. libpq would have ended the connection had it not been encrypted, whatever
    // the database behind the pooler sees; the line used to ask the database and said "NOT encrypted".
    for (const mode of ["verify-full", "require"] as const) {
      const line = catalogEncryptionLine("ep-x.c-4.us-west-2.aws.example.tech", mode);
      expect(line.status).toBe("ok");
      expect(line.text).toContain("is encrypted");
      expect(line.text).not.toMatch(/NOT|not encrypted/);
    }
    // disable is the setting's doing, not a fallback; to another machine it is a warning, to this one a note.
    const off = catalogEncryptionLine("db.internal", "disable");
    expect(off.status).toBe("warn");
    expect(off.text).toContain('because sslMode is "disable"');
    expect(off.text).not.toMatch(/fell back|without saying/);
    expect(catalogEncryptionLine("127.0.0.1", "disable").status).toBe("info");
    // prefer takes TLS when the server offers it.
    expect(catalogEncryptionLine("db.internal", "prefer", "offered")).toMatchObject({ status: "ok", text: expect.stringContaining("the server offers TLS and sslMode prefer takes it") });
    expect(catalogEncryptionLine("db.internal", "prefer", "refused")).toMatchObject({ status: "warn", text: expect.stringContaining("NOT encrypted") });
    expect(catalogEncryptionLine("localhost", "prefer", "refused").status).toBe("info");
    expect(catalogEncryptionLine("::1", "prefer", "refused").status).toBe("info");
    // A server that could not be asked is a note, never a warning.
    const unknown = catalogEncryptionLine("db.internal", "prefer", "unknown");
    expect(unknown.status).toBe("info");
    expect(unknown.text).toContain("could not be checked");
    expect(catalogEncryptionLine("db.internal", "prefer").status).toBe("info");
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

  test("storeCaFile finds the machine's bundle with the catalog's finder: $SSL_CERT_FILE first, then the usual places; none is LAKE_STORE_TLS, no-ca-file, before anything is attached", () => {
    const has = (...files: string[]) => (p: string) => files.includes(p);
    const bucket = { useSsl: true };
    expect(storeCaFile(bucket, "/proj", { env: { SSL_CERT_FILE: "/corp/ca.pem" }, file: has("/corp/ca.pem", "/etc/ssl/cert.pem") })).toBe("/corp/ca.pem");
    expect(storeCaFile(bucket, "/proj", { env: {}, file: has("/etc/ssl/certs/ca-certificates.crt") })).toBe("/etc/ssl/certs/ca-certificates.crt");
    // A named setting beats the environment; a store without TLS needs none.
    expect(storeCaFile({ useSsl: true, sslRootCert: "mine.pem" }, "/proj", { env: { SSL_CERT_FILE: "/corp/ca.pem" }, file: has("/corp/ca.pem", "/proj/mine.pem") })).toBe("/proj/mine.pem");
    expect(storeCaFile({ useSsl: false }, "/proj", { env: {}, file: has() })).toBeUndefined();
    let err: unknown;
    try { storeCaFile(bucket, "/proj", { env: { SSL_CERT_FILE: "/gone.pem" }, file: has() }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CroftError);
    expect((err as CroftError).code).toBe("LAKE_STORE_TLS");
    expect((err as CroftError).problem).toMatchObject({ retryable: false, details: { kind: "no-ca-file", key: "lake.bucket.sslRootCert" } });
    expect((err as CroftError).problem.details!.looked).toContain("/etc/ssl/cert.pem");
    expect((err as CroftError).problem.hint).toContain("lake.bucket.sslRootCert");
  });

  test("DuckDB's words for a certificate that does not check out, and only those, are LAKE_STORE_TLS", () => {
    const refused = "Permission Error: Cannot read a CA certificate bundle: file system access is restricted by configuration. Add one of /etc/ssl/cert.pem to allowed_paths";
    const bad = 'IO Error: S3 upload request for "s3://b/f/x.parquet" could not be completed: SSL peer certificate or SSH remote key was not OK';
    expect(isStoreTls(new Error(refused))).toBe(true);
    expect(isStoreTls(new Error(bad))).toBe(true);
    expect(storeTlsProblem(new Error(refused))).toMatchObject({ code: "LAKE_STORE_TLS", retryable: false, details: { kind: "no-ca-file" } });
    expect(storeTlsProblem(new Error(bad), { caFile: "/etc/ssl/cert.pem" })).toMatchObject({ code: "LAKE_STORE_TLS", details: { kind: "untrusted" } });
    expect(storeTlsProblem(new Error(bad))!.hint).toContain("lake.bucket.sslRootCert");
    for (const other of ["HTTP Error: HTTP GET error reading 's3://b/f/x.parquet' (HTTP 403 Forbidden)", "IO Error: Connection refused", "Invalid Input Error: nothing"]) {
      expect(isStoreTls(new Error(other)), other).toBe(false);
      expect(storeTlsProblem(new Error(other)), other).toBeNull();
    }
  });
});
