// Certificates for the tests of a TLS catalog (DESIGN.md D159): made with the openssl program, in a temporary folder, for a Postgres child
// that offers TLS (mode-testkit.ts startPostgres). Test support, left out of the published package (package.json "files").
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IN_CI } from "./extension-dir-testkit.ts";

export interface TestCerts {
  /** The server's certificate, self-signed (so it is also the CA a client trusts it by), issued for "localhost" and not for 127.0.0.1. */
  cert: string;
  key: string;
  /** A certificate of some other authority: a CA file that does not vouch for the server's. */
  otherCa: string;
  remove(): void;
}

/** Whether openssl is here. Locally a missing one skips with a reason; in CI it throws. */
export function certsReady(): { ready: boolean; skipReason: string } {
  if (Bun.which("openssl")) return { ready: true, skipReason: "" };
  const msg = "the openssl program is not installed";
  if (IN_CI) throw new Error(`CI must have openssl for the TLS catalog tests: ${msg}`);
  return { ready: false, skipReason: msg };
}

function req(dir: string, name: string, cn: string, san: string | null): { cert: string; key: string } {
  const cnf = join(dir, `${name}.cnf`);
  writeFileSync(cnf, `[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=${cn}\n[v3]\n${san ? `subjectAltName=${san}\n` : ""}basicConstraints=critical,CA:TRUE\n`);
  const cert = join(dir, `${name}.crt`);
  const key = join(dir, `${name}.key`);
  const r = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-config", cnf], { stdout: "ignore", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`openssl req failed: ${r.stderr.toString()}`);
  return { cert, key };
}

/** Make the certificates. The server's is issued for the name "localhost" only, so a client that connects to 127.0.0.1 with the right CA
 *  still finds the name wrong, and one that connects to "localhost" finds it right. */
export function makeCerts(): TestCerts {
  const dir = mkdtempSync(join(tmpdir(), "croft-tls-"));
  const server = req(dir, "server", "localhost", "DNS:localhost");
  const other = req(dir, "other", "some other authority", null);
  return { ...server, otherCa: other.cert, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
