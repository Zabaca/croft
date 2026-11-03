// Finding this machine's CA bundle (db/ca-bundle.ts, DESIGN.md D159). The disk is a parameter, so no test depends on what this machine
// happens to have installed.
import { describe, expect, test } from "bun:test";
import { CroftError } from "../core/errors.ts";
import { CA_BUNDLES, findCaBundle, systemCaBundle } from "./ca-bundle.ts";

const has = (...paths: string[]) => (p: string) => paths.includes(p);

describe("the system CA bundle", () => {
  test("is $SSL_CERT_FILE when it is a file, else the first usual place that is one, else nothing", () => {
    expect(systemCaBundle({ SSL_CERT_FILE: "/x/ca.pem" }, has("/x/ca.pem", "/etc/ssl/cert.pem"))).toBe("/x/ca.pem");
    expect(systemCaBundle({ SSL_CERT_FILE: "/x/gone.pem" }, has("/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"))).toBe("/etc/ssl/certs/ca-certificates.crt");
    expect(systemCaBundle({}, has("/etc/ssl/cert.pem"))).toBe("/etc/ssl/cert.pem");
    expect(systemCaBundle({}, has("/etc/pki/tls/certs/ca-bundle.crt"))).toBe("/etc/pki/tls/certs/ca-bundle.crt");
    expect(systemCaBundle({}, has())).toBeNull();
  });

  test("findCaBundle gives the bundle, or refuses in the caller's words: what needs it, and the setting to change", () => {
    const o = { needs: '"x.tls" is "verify"', setting: "x.caFile" };
    expect(findCaBundle({ ...o, env: {}, file: has("/etc/ssl/cert.pem") })).toBe("/etc/ssl/cert.pem");
    const e = (() => { try { findCaBundle({ ...o, env: {}, file: has() }); } catch (x) { return x; } })();
    expect(e).toBeInstanceOf(CroftError);
    expect((e as CroftError).code).toBe("CONFIG_INVALID");
    expect((e as CroftError).problem.message).toBe(`"x.tls" is "verify", and croft found no CA bundle on this machine (looked at $SSL_CERT_FILE and ${CA_BUNDLES.join(", ")})`);
    expect((e as CroftError).problem.hint).toContain('"x.caFile"');
    expect((e as CroftError).problem.hint).not.toContain("catalog");
    expect((e as CroftError).problem.details).toMatchObject({ key: "x.caFile" });
  });
});
