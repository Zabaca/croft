// What `croft doctor` asks of a lake before anything is run (DESIGN.md D165): does the bucket answer, and is the catalog's connection encrypted.
//
// The first real-lake trial had doctor say "no problems found" before a first run that could write nothing: the lake did not exist yet, so
// doctor attached nothing and touched no byte of the bucket, and the bucket was exactly what was wrong. So the probe goes through croft's own
// locked instance (the same sandbox, the same CA file, the read-only key) with only the bucket's secret and no catalog, and it lists the lake's
// folder and reads the footer of one data file when there is one. It writes nothing: the read-only key could not, and the folder must hold
// nothing but the lake.
import { type LakeMode, modeSecrets, REFUSED, scrubThrown } from "./modes.ts";
import { CroftError } from "../core/errors.ts";
import type { ProjectEnv } from "../project/env.ts";
import { bucketPath } from "../project/lake-config.ts";
import type { Project } from "../project/root.ts";
import { openMemory } from "./connect.ts";
import { lakeConnection } from "./lake.ts";
import { storeTlsError } from "./store-tls.ts";

/** How long the probe may take before doctor gives up on the bucket. */
export const PROBE_MS = 15_000;

export interface StoreProbe {
  /** The lake's folder, `s3://bucket/folder/`. */
  folder: string;
  /** Whether the folder holds anything. The listing stops at the first object: a lake of 100,000 files is not listed to say that it answers. */
  empty: boolean;
  /** The folder holds more than one page of the store's listing (1,000 objects): the first page answered, and no sample file is named. */
  many: boolean;
  listMs: number;
  /** One data file whose footer was read, and how long that took; null when the folder holds none. */
  sample: { file: string; readMs: number } | null;
  /** The CA file the store's certificate was checked against, when the project names one. */
  caFile: string | null;
}

/**
 * List the lake's folder and read the footer of one data file, as the read-only key. Throws a CroftError: LAKE_STORE_TLS when the store's
 * certificate cannot be checked, LAKE_ATTACH_FAILED for anything else the store (or a missing secret, SECRET_MISSING) says. Does not need the
 * lake to exist, or the catalog to be up.
 */
export async function probeStore(project: Project, env: ProjectEnv, o: { timeoutMs?: number; extensionDir?: string } = {}): Promise<StoreProbe> {
  const lake = project.config.lake;
  if (!lake || lake.kind !== "postgres") throw new CroftError("INTERNAL_ERROR", { message: "probeStore is for a lake with a bucket", hint: "report this croft bug" });
  const connection = lakeConnection(project, env, o.extensionDir ? { extensionDir: o.extensionDir } : {})!;
  const read = connection.mode("read");
  if (read.kind !== "lake") throw new CroftError("INTERNAL_ERROR", { message: "a shared lake's read mode is not a lake mode", hint: "report this croft bug" });
  const mode: LakeMode = { ...read, lake: { ...read.lake, storeOnly: true } };
  const secrets = modeSecrets(mode);
  const folder = bucketPath(lake.bucket);
  const memory = await openMemory({ timezone: project.timezone, root: project.root, mode });
  let conn;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    conn = await memory.connect();
    const c = conn;
    timer = setTimeout(() => c.interrupt(), o.timeoutMs ?? PROBE_MS);
    const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
    const t0 = performance.now();
    // The first object of the listing, or none. DuckDB 2.0 under croft's lock lists one page (1,000 objects) and fails on the next, with
    // `Cannot access "s3://<bucket>/"` [V: 2.0.0, a folder of 1,100 objects, LIMIT 1 or not]: that error is proof that the first page came back
    // (the key, the endpoint and the certificate are right), and it says the folder holds more than a page.
    const listed = async (pattern: string): Promise<{ file: string | null; many: boolean }> => {
      try {
        const rows = (await c.runAndReadAll(`SELECT file FROM glob(${q(pattern)}) LIMIT 1`)).getRowsJS();
        return { file: typeof rows[0]?.[0] === "string" ? rows[0][0] : null, many: false };
      } catch (e) {
        if (/Cannot access "s3:\/\/[^/"]+\/" - file system operations are disabled/.test(e instanceof Error ? e.message : String(e))) return { file: null, many: true };
        throw e;
      }
    };
    const first = await listed(`${folder}**`);
    const listMs = Math.round(performance.now() - t0);
    let sample: StoreProbe["sample"] = null;
    if (first.file) {
      // One data file is enough to read a footer from.
      const data = await listed(`${folder}**/*.parquet`);
      if (data.file) {
        const t1 = performance.now();
        await c.runAndReadAll(`SELECT count(*) FROM parquet_metadata(${q(data.file)})`);
        sample = { file: data.file.slice(folder.length), readMs: Math.round(performance.now() - t1) };
      }
    }
    return { folder, empty: !first.file && !first.many, many: first.many, listMs, sample, caFile: mode.lake.data.caFile ?? null };
  } catch (e) {
    throw probeFailure(e, secrets, folder, mode.lake.data.caFile);
  } finally {
    if (timer) clearTimeout(timer);
    memory.close();
  }
}

/** The probe's failure, as a coded error with every credential taken out of DuckDB's words. */
function probeFailure(e: unknown, secrets: readonly string[], folder: string, caFile: string | undefined): CroftError {
  const clean = scrubThrown(e, secrets);
  if (clean instanceof CroftError) return clean;
  const tls = storeTlsError(clean, { ...(caFile ? { caFile } : {}) });
  if (tls) return tls;
  const raw = clean.message.split("\n")[0]!.slice(0, 300);
  if (/interrupt/i.test(raw)) {
    return new CroftError("LAKE_ATTACH_FAILED", {
      message: `the lake's bucket (${folder}) did not answer within ${PROBE_MS / 1000} s`,
      hint: "check that the bucket's endpoint is reachable from this machine (lake.bucket.endpoint), then run croft doctor again",
      retryable: true, details: { duckdb: raw, store: true },
    });
  }
  const refused = REFUSED.test(raw);
  return new CroftError("LAKE_ATTACH_FAILED", {
    message: `croft could not read the lake's bucket (${folder}): ${raw}`,
    hint: refused
      ? "the store refused the read-only bucket key: ask the user to check the key and its secrets (the lake block names them), and that it may list and read the lake's folder; trying again will not help"
      : "check the bucket's name, folder and endpoint (lake.bucket) and that the store is reachable from this machine",
    retryable: !refused, details: { duckdb: raw, store: true, ...(refused ? { refused: true } : {}) },
  });
}

/** What a Postgres server answers to the first thing libpq asks of it, "may we use TLS": it offers it, it does not, or nothing could be learned. */
export type TlsOffer = "offered" | "refused" | "unknown";

/**
 * Ask a Postgres server the question libpq asks before anything else (an SSLRequest: eight bytes, to which the server answers `S` or `N`), and
 * nothing more: no login, no certificate check, no data. It is the client's side of the matter, which is what `croft doctor` needs to say whether a
 * connection is encrypted: the server's own view (`pg_stat_ssl`, which the first version read) is of the last hop of a proxy or a pooler, which
 * a hosted catalog is, and said "NOT encrypted" about a connection that checked the certificate (the second real-lake trial, DESIGN.md D175). "unknown" for a server that
 * does not answer in `timeoutMs`, answers anything else, or cannot be reached.
 */
export function serverOffersTls(host: string, port: number, o: { timeoutMs?: number } = {}): Promise<TlsOffer> {
  const request = new Uint8Array([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]); // length 8, request code 80877103
  return new Promise<TlsOffer>((resolve) => {
    let done = false;
    let socket: { end(): void } | undefined;
    const finish = (v: TlsOffer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket?.end(); } catch { /* gone */ }
      resolve(v);
    };
    const timer = setTimeout(() => finish("unknown"), o.timeoutMs ?? 5000);
    Bun.connect({
      hostname: host, port,
      socket: {
        // A socket that opens after the probe has ended (its time ran out first) is closed here, not left open.
        open(s) {
          if (done) {
            s.end();
            return;
          }
          socket = s;
          s.write(request);
        },
        data(_s, d) { finish(d[0] === 0x53 ? "offered" : d[0] === 0x4e ? "refused" : "unknown"); },
        error() { finish("unknown"); },
        close() { finish("unknown"); },
        connectError() { finish("unknown"); },
      },
    }).catch(() => finish("unknown"));
  });
}
