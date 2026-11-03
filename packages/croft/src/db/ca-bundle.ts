// Finding the certificate authorities this machine trusts, for a client that must verify a server's TLS certificate with a file of CAs
// (libpq's `sslrootcert` for a lake's catalog, D159; httpfs for an object store). It knows no setting: the caller names the setting a
// person would change, and says what needs the bundle, so the refusal reads right wherever it comes from.
import { statSync } from "node:fs";
import { CroftError } from "../core/errors.ts";

/** Where operating systems keep the bundle of CA certificates they trust, in the order tried: macOS and Alpine, Debian and Ubuntu,
 *  Fedora and RHEL, openSUSE, RHEL's extracted store, Homebrew's OpenSSL (Intel, then Apple silicon), FreeBSD. */
export const CA_BUNDLES: readonly string[] = [
  "/etc/ssl/cert.pem",
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/ca-bundle.pem",
  "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
  "/usr/local/etc/openssl/cert.pem",
  "/opt/homebrew/etc/openssl@3/cert.pem",
  "/usr/local/share/certs/ca-root-nss.crt",
];

/** Whether `p` is a file. */
export const isFile = (p: string): boolean => {
  try { return statSync(p).isFile(); } catch { return false; }
};

/** This machine's CA bundle: `$SSL_CERT_FILE` when it names a file (the variable OpenSSL's tools and most clients honour), else the first
 *  of CA_BUNDLES that is a file; null when there is none. `env` and `file` are parameters so a test does not depend on the machine. */
export function systemCaBundle(env: NodeJS.ProcessEnv = process.env, file: (p: string) => boolean = isFile): string | null {
  const named = env.SSL_CERT_FILE;
  if (named && file(named)) return named;
  return CA_BUNDLES.find(file) ?? null;
}

/**
 * This machine's CA bundle, or CONFIG_INVALID when there is none: a check that cannot be made must not be skipped. `needs` completes
 * the sentence "<needs>, and croft found no CA bundle on this machine" (say what wants the bundle, e.g. `"x.sslMode" is "verify-full"`);
 * `setting` is the key a person sets to name a file instead.
 */
export function findCaBundle(o: { needs: string; setting: string; env?: NodeJS.ProcessEnv; file?: (p: string) => boolean }): string {
  const found = systemCaBundle(o.env, o.file);
  if (found) return found;
  throw new CroftError("CONFIG_INVALID", {
    message: `${o.needs}, and croft found no CA bundle on this machine (looked at $SSL_CERT_FILE and ${CA_BUNDLES.join(", ")})`,
    hint: `set "${o.setting}" to a PEM file of trusted certificate authorities (the root certificate the server's provider publishes, or your operating system's bundle)`,
    details: { key: o.setting, looked: [...CA_BUNDLES] },
  });
}
