import { describe, expect, test } from "bun:test";
import {
  bearerToken, checkContentType, checkHost, checkOrigin, generateToken, isLoopbackHost, isUnspecifiedHost, resolveToken,
  tokenMatches, urlHost,
} from "./auth.ts";

describe("the token", () => {
  test("generated: 32 random bytes as base64url, different every time", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a, "base64url")).toHaveLength(32);
    expect(a).not.toBe(b);
  });

  test("CROFT_SERVE_TOKEN (the shell, then .env) wins over a generated one", () => {
    expect(resolveToken((n) => (n === "CROFT_SERVE_TOKEN" ? { value: "from-dotenv-123", source: ".env" } : null)))
      .toEqual({ token: "from-dotenv-123", source: "CROFT_SERVE_TOKEN", from: ".env" });
    expect(resolveToken(() => ({ value: "from-shell-4567", source: "env" })))
      .toEqual({ token: "from-shell-4567", source: "CROFT_SERVE_TOKEN", from: "env" });
    const generated = resolveToken(() => null);
    expect(generated.source).toBe("generated");
    expect(generated.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("a CROFT_SERVE_TOKEN that cannot travel in a header is USAGE_ERROR, and is never echoed", () => {
    for (const bad of ["has space inside", "line\nbreak", "tab\there", "ünïcode-token"]) {
      let err: unknown;
      try {
        resolveToken(() => ({ value: bad, source: ".env" }));
      } catch (e) {
        err = e;
      }
      expect((err as { code?: string }).code).toBe("USAGE_ERROR");
      expect(JSON.stringify((err as { problem: unknown }).problem)).not.toContain(bad);
      expect((err as { problem: { hint: string } }).problem.hint).toContain("CROFT_SERVE_TOKEN");
    }
  });

  test("the bearer token from an Authorization header", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer   abc  ")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });

  test("tokens are compared in constant time, whatever their lengths", () => {
    expect(tokenMatches("s3cret", "s3cret")).toBe(true);
    expect(tokenMatches("s3cret", "s3cre")).toBe(false);
    expect(tokenMatches("s3cret", "s3cret-longer")).toBe(false);
    expect(tokenMatches("s3cret", "")).toBe(false);
    expect(tokenMatches("s3cret", null)).toBe(false);
    expect(tokenMatches("", "")).toBe(false); // an empty expected token never matches anything
  });
});

describe("addresses", () => {
  test("loopback and unspecified hosts", () => {
    for (const h of ["127.0.0.1", "127.0.0.2", "::1", "localhost", "LOCALHOST", "[::1]"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["0.0.0.0", "::", "192.168.1.5", "example.com", "10.0.0.1"]) expect(isLoopbackHost(h)).toBe(false);
    expect(isUnspecifiedHost("0.0.0.0")).toBe(true);
    expect(isUnspecifiedHost("::")).toBe(true);
    expect(isUnspecifiedHost("[::]")).toBe(true);
    expect(isUnspecifiedHost("127.0.0.1")).toBe(false);
  });

  test("a host in a URL gets brackets when it is IPv6", () => {
    expect(urlHost("127.0.0.1")).toBe("127.0.0.1");
    expect(urlHost("::1")).toBe("[::1]");
    expect(urlHost("::")).toBe("[::]");
    expect(urlHost("[::1]")).toBe("[::1]");
  });
});

describe("the Host header (DNS rebinding)", () => {
  const loop = { host: "127.0.0.1", port: 7447 };

  test("bound to loopback: the bound address, localhost and 127.0.0.1 with the bound port", () => {
    for (const h of ["127.0.0.1:7447", "localhost:7447", "LocalHost:7447", "[::1]:7447", "127.0.0.1", "localhost"]) {
      expect(checkHost(h, loop)).toBeNull();
    }
  });

  test("any other name is refused with 403 SERVE_UNAUTHORIZED, naming what to send instead", () => {
    for (const h of ["evil.example:7447", "attacker.test", "192.168.1.5:7447", "127.0.0.1.evil.example:7447", "localhost.:7447"]) {
      const r = checkHost(h, loop)!;
      expect(r.status).toBe(403);
      expect(r.problem.code).toBe("SERVE_UNAUTHORIZED");
      expect(r.problem.hint).toContain("127.0.0.1:7447");
    }
  });

  test("a wrong port, a missing Host and malformed values are refused", () => {
    expect(checkHost("127.0.0.1:9999", loop)?.status).toBe(403);
    expect(checkHost(null, loop)?.status).toBe(403);
    expect(checkHost("", loop)?.status).toBe(403);
    for (const h of ["user@127.0.0.1:7447", "127.0.0.1:7447/x", "127.0.0.1:abc", "127.0.0.1 :7447"]) expect(checkHost(h, loop)?.status).toBe(403);
  });

  test("bound to every interface: loopback names and the bound address itself; other names need the proxy to send one", () => {
    const all = { host: "0.0.0.0", port: 7447 };
    for (const h of ["127.0.0.1:7447", "localhost:7447", "0.0.0.0:7447"]) expect(checkHost(h, all)).toBeNull();
    const r = checkHost("data.example.com", all)!;
    expect(r.status).toBe(403);
    expect(r.problem.hint).toContain("Host: 127.0.0.1:7447");
    expect(checkHost("[::1]:7447", { host: "::", port: 7447 })).toBeNull();
  });

  test("bound to a specific address: only that address", () => {
    const lan = { host: "192.168.1.5", port: 8080 };
    expect(checkHost("192.168.1.5:8080", lan)).toBeNull();
    expect(checkHost("localhost:8080", lan)?.status).toBe(403);
    expect(checkHost("[::1]:8080", { host: "::1", port: 8080 })).toBeNull();
  });
});

describe("the Origin header (browser pages)", () => {
  test("no Origin (apps, curl, the read client) is fine", () => {
    expect(checkOrigin(null, [])).toBeNull();
  });

  test("an Origin outside serve.allowOrigins is refused with 403, naming the setting", () => {
    const r = checkOrigin("https://evil.example", ["http://localhost:3000"])!;
    expect(r.status).toBe(403);
    expect(r.problem.code).toBe("SERVE_UNAUTHORIZED");
    expect(r.problem.message).toContain("https://evil.example");
    expect(r.problem.hint).toContain("serve.allowOrigins");
    expect(checkOrigin("null", ["http://localhost:3000"])?.status).toBe(403);
    expect(checkOrigin("http://localhost:3001", ["http://localhost:3000"])?.status).toBe(403);
  });

  test("a listed origin passes, compared as an origin (case and default port normalized)", () => {
    expect(checkOrigin("http://localhost:3000", ["http://localhost:3000"])).toBeNull();
    expect(checkOrigin("HTTP://LOCALHOST:3000", ["http://localhost:3000"])).toBeNull();
    expect(checkOrigin("https://app.example.com:443", ["https://app.example.com"])).toBeNull();
  });
});

describe("Content-Type", () => {
  test("application/json, with or without parameters, in any case", () => {
    expect(checkContentType("application/json")).toBeNull();
    expect(checkContentType("application/json; charset=utf-8")).toBeNull();
    expect(checkContentType("Application/JSON")).toBeNull();
  });

  test("anything else is 415 USAGE_ERROR (a form post from a page cannot pass)", () => {
    for (const t of [null, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonx"]) {
      const r = checkContentType(t)!;
      expect(r.status).toBe(415);
      expect(r.problem.code).toBe("USAGE_ERROR");
      expect(r.problem.hint).toContain("application/json");
    }
  });
});
