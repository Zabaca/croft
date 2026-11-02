// Where croft serve listens for DuckDB clients over Quack, and how a client is told to attach (DESIGN.md D125). No DuckDB in it:
// croft serve, `croft serve key add` and the tests all need the address, and only the readers' process needs the library.
import { isLoopbackHost, isUnspecifiedHost, urlHost } from "./auth.ts";

/** The view of one row, the copy's as-of time, in the readers' in-memory database, for a DuckDB client to read. Its name starts
 *  with an underscore, which no asset's name can (project/discover.ts NAME_PATTERN), so no table can collide with it. */
export const AS_OF_VIEW = "_croft_as_of";

/** The URI Quack is asked to listen on, and whether the host is loopback: Quack accepts only localhost unless told otherwise
 *  [V: 2.0.0]. `localhost` itself is bound as 127.0.0.1: Quack binds it as ::1 on macOS, which a client dialing 127.0.0.1
 *  cannot reach [V: 2.0.0], the quirk croft serve's HTTP listener has too. */
export function listenAddress(host: string, port: number): { uri: string; loopback: boolean } {
  const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const bound = h.toLowerCase() === "localhost" ? "127.0.0.1" : h;
  return { uri: `quack:${urlHost(bound)}:${port}`, loopback: isLoopbackHost(bound) };
}

/** What a person is told to run in DuckDB 2.0 to attach. `uri` is the address Quack listens on; for an address that listens on every
 *  interface the client's own name for this machine goes in its place, and past an HTTPS reverse proxy the proxy's name and its
 *  port, written out, do. */
export interface QuackConnect {
  /** The address Quack listens on (`quack:127.0.0.1:9494`); null when the port is 0 and croft serve is not running to say which. */
  uri: string | null;
  /** Whether it listens on loopback only. Anything else must sit behind an HTTPS reverse proxy. */
  loopback: boolean;
  /** The statement for the client, with `<key>` for the key, or the key itself when it is given. Null with `uri`. */
  attach: string | null;
  /** The view of one row, the copy's as-of time, beside the shared tables. */
  asOfView: string;
}

export function connectSnippet(listen: { host: string; port: number }, running: string | null, key: string | null): QuackConnect {
  const { uri: configured, loopback } = listenAddress(listen.host, listen.port);
  const uri = running ?? (listen.port === 0 ? null : configured);
  const shown = uri === null ? null : isUnspecifiedHost(listen.host) ? `quack:<this machine>:${uri.slice(uri.lastIndexOf(":") + 1)}` : uri;
  return {
    uri, loopback, asOfView: AS_OF_VIEW,
    attach: shown === null ? null : `ATTACH '${shown}' AS croft (TOKEN '${key ?? "<key>"}')`,
  };
}
