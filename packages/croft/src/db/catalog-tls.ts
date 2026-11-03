// The TLS of a lake's Postgres catalog connection (DESIGN.md D159): what croft hands DuckDB's postgres extension as `sslmode` and
// `sslrootcert` when it makes the catalog's secret. The setting is validated in project/lake-config.ts without touching the disk; this
// is the part that does, at attach: it finds the CA file a `verify-full` connection checks the server's certificate against.
//
// croft always names a real file. DuckDB's bundled libpq has refused `sslrootcert=system` ("root certificate file "system" does not
// exist", measured on 1.4.3 against Neon); on 2.0.0 it is accepted but croft does not lean on it, so the same project works on both and
// the message for a missing CA names a path a person can look at.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CroftError } from "../core/errors.ts";
import type { CatalogSslMode } from "../project/lake-config.ts";
import { findCaBundle, isFile } from "./ca-bundle.ts";

/** What the catalog's secret carries: `sslMode`, and for `verify-full` the absolute path of the CA file. */
export interface CatalogTls { sslMode: CatalogSslMode; sslRootCert?: string }

/**
 * The catalog's TLS as DuckDB is given it. `verify-full` resolves its CA file: the one `sslRootCert` names (relative to the project folder,
 * `~/` for the home folder), else this machine's CA bundle. A file that is not there, or no bundle at all, is CONFIG_INVALID naming the
 * setting: nothing has been attached, and a check that cannot be made must not be skipped.
 */
export function catalogTls(
  catalog: { sslMode: CatalogSslMode; sslRootCert?: string },
  root: string,
  o: { home?: string; env?: NodeJS.ProcessEnv; file?: (p: string) => boolean } = {},
): CatalogTls {
  if (catalog.sslMode !== "verify-full") return { sslMode: catalog.sslMode };
  const file = o.file ?? isFile;
  const home = o.home ?? homedir();
  if (catalog.sslRootCert !== undefined) {
    const w = catalog.sslRootCert;
    const path = resolve(root, w === "~" ? home : w.startsWith("~/") ? join(home, w.slice(2)) : w);
    if (!file(path)) {
      throw new CroftError("CONFIG_INVALID", {
        message: `"lake.catalog.sslRootCert" is ${JSON.stringify(w)}, which is not a file (looked at ${path})`,
        hint: `set "lake.catalog.sslRootCert" to the PEM file of the certificate authorities the catalog's certificate is signed by, or remove the setting to use this machine's CA bundle`,
        details: { key: "lake.catalog.sslRootCert", found: path },
      });
    }
    return { sslMode: "verify-full", sslRootCert: path };
  }
  const bundle = findCaBundle({ needs: `"lake.catalog.sslMode" is "verify-full"`, setting: "lake.catalog.sslRootCert", ...(o.env ? { env: o.env } : {}), file });
  return { sslMode: "verify-full", sslRootCert: bundle };
}

