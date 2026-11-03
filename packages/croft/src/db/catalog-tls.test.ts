// Which CA file a verify-full catalog connection checks against, and the refusals when there is none (DESIGN.md D159). The disk is a
// parameter, so no test depends on what this machine happens to have installed. The bundle search itself is db/ca-bundle.test.ts.
import { describe, expect, test } from "bun:test";
import { CroftError } from "../core/errors.ts";
import { CA_BUNDLES } from "./ca-bundle.ts";
import { catalogTls } from "./catalog-tls.ts";

const has = (...paths: string[]) => (p: string) => paths.includes(p);

describe("the TLS handed to the catalog's secret", () => {
  test("anything but verify-full names no file", () => {
    for (const sslMode of ["require", "prefer", "disable"] as const) expect(catalogTls({ sslMode }, "/p", { file: has() })).toEqual({ sslMode });
  });

  test("verify-full with no file named uses the system bundle", () => {
    expect(catalogTls({ sslMode: "verify-full" }, "/p", { env: {}, file: has("/etc/ssl/cert.pem") })).toEqual({ sslMode: "verify-full", sslRootCert: "/etc/ssl/cert.pem" });
  });

  test("verify-full with a file named uses it: relative to the project folder, ~ for the home folder, absolute as it is", () => {
    const o = (...p: string[]) => ({ home: "/h", file: has(...p) });
    expect(catalogTls({ sslMode: "verify-full", sslRootCert: "certs/ca.pem" }, "/p", o("/p/certs/ca.pem"))).toEqual({ sslMode: "verify-full", sslRootCert: "/p/certs/ca.pem" });
    expect(catalogTls({ sslMode: "verify-full", sslRootCert: "~/ca.pem" }, "/p", o("/h/ca.pem")).sslRootCert).toBe("/h/ca.pem");
    expect(catalogTls({ sslMode: "verify-full", sslRootCert: "/etc/x/ca.pem" }, "/p", o("/etc/x/ca.pem")).sslRootCert).toBe("/etc/x/ca.pem");
  });

  test("a CA file that is not there is CONFIG_INVALID naming the setting and the path, and so is a machine with no bundle", () => {
    const missing = (() => { try { catalogTls({ sslMode: "verify-full", sslRootCert: "certs/ca.pem" }, "/p", { file: has() }); } catch (e) { return e; } })();
    expect(missing).toBeInstanceOf(CroftError);
    expect((missing as CroftError).code).toBe("CONFIG_INVALID");
    expect((missing as CroftError).problem.message).toContain('"lake.catalog.sslRootCert" is "certs/ca.pem", which is not a file (looked at /p/certs/ca.pem)');
    const none = (() => { try { catalogTls({ sslMode: "verify-full" }, "/p", { env: {}, file: has() }); } catch (e) { return e; } })();
    expect((none as CroftError).code).toBe("CONFIG_INVALID");
    expect((none as CroftError).problem.message).toContain("no CA bundle on this machine");
    for (const place of CA_BUNDLES) expect((none as CroftError).problem.message).toContain(place);
    expect((none as CroftError).problem.hint).toContain('"lake.catalog.sslRootCert"');
  });
});
