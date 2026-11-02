// Where Quack listens and how a person is told to attach (serve/quack-address.ts, D125).
import { describe, expect, test } from "bun:test";
import { connectSnippet, listenAddress } from "./quack-address.ts";

describe("the address Quack listens on", () => {
  test("localhost is bound as 127.0.0.1: Quack binds the name as ::1 on macOS, which a client dialing 127.0.0.1 cannot reach", () => {
    expect(listenAddress("localhost", 9494)).toEqual({ uri: "quack:127.0.0.1:9494", loopback: true });
    expect(listenAddress("LocalHost", 9494).uri).toBe("quack:127.0.0.1:9494");
    expect(listenAddress("127.0.0.1", 9494)).toEqual({ uri: "quack:127.0.0.1:9494", loopback: true });
    expect(listenAddress("127.0.0.2", 1).loopback).toBe(true);
  });

  test("every other address is not loopback: it needs Quack's override and an HTTPS reverse proxy", () => {
    expect(listenAddress("0.0.0.0", 9494)).toEqual({ uri: "quack:0.0.0.0:9494", loopback: false });
    expect(listenAddress("10.1.2.3", 9494).loopback).toBe(false);
    expect(listenAddress("my-host.example.com", 9494)).toEqual({ uri: "quack:my-host.example.com:9494", loopback: false });
  });

  test("IPv6 is written in brackets, and a bracketed host is read as the host", () => {
    expect(listenAddress("::1", 9494)).toEqual({ uri: "quack:[::1]:9494", loopback: true });
    expect(listenAddress("[::1]", 9494).uri).toBe("quack:[::1]:9494");
    expect(listenAddress("::", 9494)).toEqual({ uri: "quack:[::]:9494", loopback: false });
  });
});

describe("the statement a person is given", () => {
  test("the configured address, with the key in it, or <key> where it is not given", () => {
    expect(connectSnippet({ host: "127.0.0.1", port: 9494 }, null, "croftkey_x")).toEqual({
      uri: "quack:127.0.0.1:9494", loopback: true, asOfView: "_croft_as_of", attach: "ATTACH 'quack:127.0.0.1:9494' AS croft (TOKEN 'croftkey_x')",
    });
    expect(connectSnippet({ host: "127.0.0.1", port: 9494 }, null, null).attach).toBe("ATTACH 'quack:127.0.0.1:9494' AS croft (TOKEN '<key>')");
  });

  test("the address croft serve recorded wins: a port of 0 is only known then", () => {
    expect(connectSnippet({ host: "127.0.0.1", port: 0 }, "quack:127.0.0.1:55001", "k").attach).toBe("ATTACH 'quack:127.0.0.1:55001' AS croft (TOKEN 'k')");
    const none = connectSnippet({ host: "127.0.0.1", port: 0 }, null, "k");
    expect(none).toMatchObject({ uri: null, attach: null });
  });

  test("an address that listens on every interface gets the client's name for this machine in its place", () => {
    const s = connectSnippet({ host: "0.0.0.0", port: 9494 }, null, null);
    expect(s).toMatchObject({ uri: "quack:0.0.0.0:9494", loopback: false });
    expect(s.attach).toBe("ATTACH 'quack:<this machine>:9494' AS croft (TOKEN '<key>')");
    expect(connectSnippet({ host: "::", port: 9494 }, "quack:[::]:9494", null).attach).toBe("ATTACH 'quack:<this machine>:9494' AS croft (TOKEN '<key>')");
  });
});
