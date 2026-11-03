// Certificates for the tests of a store served over HTTPS (DESIGN.md D-R1): made with the openssl program, in a temporary folder, for the
// S3-compatible test store (mode-testkit.ts startS3 with `tls`), which a real store's certificate stands in for. Test support, left out of the
// published package (package.json "files"). The openssl helper is the catalog's (tls-testkit.ts), which makes the same kind of certificate.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LakeRig, READER_KEY, startLakeRig, WRITER_KEY } from "./lake-testkit.ts";
import { startS3, type TestS3 } from "./mode-testkit.ts";
import { certsReady, req } from "./tls-testkit.ts";

export interface StoreCerts {
  /** The store's certificate, self-signed, so it is also the CA file a client trusts it by. Issued for localhost and 127.0.0.1. */
  cert: string;
  key: string;
  /** A certificate of some other authority: a CA file that does not vouch for the store's. */
  otherCa: string;
  /** A certificate for a name that is not the store's address (`not-the-store.example`), with its key: a store that serves it fails the name check. */
  wrongName: { cert: string; key: string };
  remove(): void;
}

/**
 * The lake rig (Postgres and a store) with the store served over HTTPS with `tls`: the rig's own `lake()` with each lake's bucket pointed at
 * the HTTPS store and `useSsl` true. The lake's folder is in the HTTPS store's folder, so `files` is where its Parquet files are.
 */
export async function startTlsLakeRig(tls: { cert: string; key: string }): Promise<LakeRig> {
  const rig = await startLakeRig();
  let store: TestS3;
  try {
    store = await startS3({ buckets: ["lakeb", "other"], keys: { [WRITER_KEY.id]: "rw", [READER_KEY.id]: "ro" }, tls });
  } catch (e) {
    await rig.stop();
    throw e;
  }
  return {
    ...rig,
    s3: store,
    async lake(over) {
      const l = await rig.lake(over);
      const bucket = { ...(l.block.bucket as Record<string, unknown>), endpoint: store.endpoint, useSsl: true };
      return { ...l, block: { ...l.block, bucket }, files: join(store.root, l.bucket, l.folder) };
    },
    async stop() {
      await store.stop();
      await rig.stop();
    },
  };
}

/** Whether openssl is here (the catalog tests' check: locally a missing one skips with a reason, in CI it throws). */
export const storeCertsReady = certsReady;

export function makeStoreCerts(): StoreCerts {
  const dir = mkdtempSync(join(tmpdir(), "croft-store-tls-"));
  const store = req(dir, "store", "localhost", "DNS:localhost,IP:127.0.0.1");
  const other = req(dir, "other", "some other authority", null);
  const wrongName = req(dir, "wrong", "not-the-store.example", "DNS:not-the-store.example");
  return { ...store, otherCa: other.cert, wrongName, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
