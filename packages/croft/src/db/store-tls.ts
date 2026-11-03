// The TLS of a lake's bucket (DESIGN.md D-R1): the certificate authorities the store's certificate is checked against, and the one clear
// error for every way that check fails.
//
// Once croft locks a DuckDB instance it may read no file but those it names, and httpfs checks an https store's certificate against a CA
// file it reads itself. Without one allowed, every read and write of the bucket failed with "Cannot read a CA certificate bundle" (the first
// real-lake trial, R2), which commands reported as INTERNAL_ERROR, QUERY_FAILED or LAKE_MAINTENANCE_FAILED by where they met it. So the file
// is found when the lake's mode is made (lake.ts), allowed by name and given to httpfs as `ca_cert_file` (modes.ts), and every failure of the
// check, whichever command meets it, is LAKE_STORE_TLS.
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CroftError, problem } from "../core/errors.ts";
import type { Problem } from "../core/types.ts";

const isFile = (p: string): boolean => {
  try { return statSync(p).isFile(); } catch { return false; }
};

/**
 * The CA file a store over TLS is checked against, as an absolute path, or undefined when the store is not reached over TLS (or, until the
 * machine's own bundle is found, when the project names none: DuckDB's refusal is then LAKE_STORE_TLS, below). `sslRootCert` is the file the
 * project names (relative to the project folder, `~/` for the home folder), for a store with a certificate of a private authority; a name
 * that is not a file is CONFIG_INVALID, naming the setting, before anything is attached.
 */
export function storeCaFile(
  bucket: { useSsl: boolean; sslRootCert?: string },
  root: string,
  o: { home?: string; file?: (p: string) => boolean } = {},
): string | undefined {
  if (!bucket.useSsl) return undefined;
  const file = o.file ?? isFile;
  const home = o.home ?? homedir();
  const named = bucket.sslRootCert;
  if (named === undefined) return undefined;
  const path = resolve(root, named === "~" ? home : named.startsWith("~/") ? join(home, named.slice(2)) : named);
  if (!file(path)) {
    throw new CroftError("CONFIG_INVALID", {
      message: `"lake.bucket.sslRootCert" is ${JSON.stringify(named)}, which is not a file (looked at ${path})`,
      hint: `set "lake.bucket.sslRootCert" to the PEM file of the certificate authorities the store's certificate is signed by, or remove the setting`,
      details: { key: "lake.bucket.sslRootCert", found: path },
    });
  }
  return path;
}

/** DuckDB's words (httpfs, libcurl and OpenSSL) for a check of the store's certificate that could not be made or failed: the CA file may not be
 *  read (the lockdown), the certificate is not signed by a CA in the file, or it is for another name [V: 2.0.0, a store over HTTPS with a
 *  self-signed certificate: "SSL peer certificate or SSH remote key was not OK"]. */
const STORE_TLS = /Cannot read a CA certificate bundle|SSL peer certificate|SSL certificate problem|SSL connect error|SSL CA cert|certificate verify failed|self[- ]signed certificate|unable to get (?:local )?issuer certificate|server certificate verification failed|no alternative certificate subject name|unable to verify the (?:first|leaf) certificate|certificate has expired|does not match certificate's altnames|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_CERT_ALTNAME_INVALID/i;

/** Whether an error is the check of a store's certificate failing. Waiting does not change its answer, so it is not retried. */
export function isStoreTls(e: unknown): boolean {
  return STORE_TLS.test(e instanceof Error ? e.message : String(e));
}

const CONFIGURE = `ask the user to set "lake.bucket.sslRootCert" in croft.json to the PEM file of the certificate authorities the store's certificate is signed by (the file the store's provider publishes, or a private authority's; for a public certificate, this machine's own bundle, such as /etc/ssl/cert.pem); croft docs LAKE_STORE_TLS. Do not turn "lake.bucket.useSsl" off or skip the check`;

/**
 * LAKE_STORE_TLS for the failure of the check of the store's certificate, with DuckDB's first line (credentials already taken out by the
 * caller); null for any other error. `named`: the project names its own CA file (then the file is the thing to look at, not the machine's).
 */
export function storeTlsProblem(e: unknown, o: { named?: boolean } = {}): Problem | null {
  const text = e instanceof Error ? e.message : String(e);
  if (!STORE_TLS.test(text)) return null;
  const first = text.split("\n").find((l) => STORE_TLS.test(l)) ?? text.split("\n")[0]!;
  const unreadable = /Cannot read a CA certificate bundle/i.test(text);
  const detail = first.replace(/^(?:IO|Permission|HTTP) Error:\s*/i, "").replace(/\s+Add one of .*$/i, "").slice(0, 300);
  return problem("LAKE_STORE_TLS", {
    message: unreadable
      ? `croft has no CA file to check the store's certificate against, so it cannot read or write the lake's bucket (${detail})`
      : `the store's certificate did not check out, so croft cannot read or write the lake's bucket (${detail})`,
    hint: unreadable
      ? `${CONFIGURE}; trying again will not help`
      : o.named
        ? `the store's certificate is not signed by an authority in the file "lake.bucket.sslRootCert" names, or is for another name than "lake.bucket.endpoint": ${CONFIGURE}; trying again will not help`
        : `the store's certificate is not signed by an authority in this machine's CA bundle, or is for another name than "lake.bucket.endpoint": ${CONFIGURE}; trying again will not help`,
    fix: { kind: "manual", description: `ask the user for the store's CA file and set "lake.bucket.sslRootCert" to it`, requiresHuman: true },
    retryable: false,
    effect: "nothing was read from or written to the bucket",
    details: { tls: true, kind: unreadable ? "no-ca-file" : "untrusted", duckdb: detail },
  });
}

/** The error to throw for it, or null. */
export function storeTlsError(e: unknown, o: { named?: boolean } = {}): CroftError | null {
  const p = storeTlsProblem(e, o);
  if (!p) return null;
  const { severity: _s, code: _c, docs: _d, ...init } = p;
  return new CroftError("LAKE_STORE_TLS", init);
}
