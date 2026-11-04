// A TCP proxy for a lake's catalog (or its store) that holds every chunk back for a while and counts what passes, for tests and benchmarks that
// need distance without a network: a Postgres on this machine that answers as if it were a city away. It keeps the order of the bytes and nothing
// else (no loss, no jitter, no bandwidth limit), and a new connection costs one round trip, not the several of a TLS handshake.
//
// `trips()` counts the round trips the client paid: each time it sent something after the server had answered. A test that asks how many round
// trips a read costs the catalog asks this, with no delay at all (`oneWayMs` 0): the count is made by the order of the bytes, not by a clock, so
// it is the same on a slow machine and a fast one. `requests()` counts HTTP request lines (for a proxy in front of the store).
// Test support, left out of the published package (package.json "files").

export interface DelayProxy {
  /** The port to give the client in place of the server's. */
  port: number;
  /** Round trips the client has paid since the last reset. */
  trips(): number;
  /** HTTP requests seen from the client since the last reset. */
  requests(): number;
  reset(): void;
  stop(): void;
}

interface Side { write(d: Uint8Array): number; end(): void; data: Link }
interface Link { peer?: Side; pending: Uint8Array | null; ending: boolean; early: Uint8Array[] }

/** Proxy 127.0.0.1:<port> to 127.0.0.1:`targetPort`, holding each chunk back `oneWayMs` in each direction. A socket that takes only part of a write
 *  keeps the rest and sends it when it drains (a Parquet file is more than a socket buffer). */
export function delayProxy(targetPort: number, oneWayMs = 0): DelayProxy {
  let trips = 0;
  let requests = 0;
  let serverSpoke = false;
  const later = (fn: () => void) => (oneWayMs > 0 ? void setTimeout(fn, oneWayMs) : fn());
  const send = (to: Side | undefined, d: Uint8Array) => {
    if (!to) return;
    if (to.data.pending) {
      const joined = new Uint8Array(to.data.pending.length + d.length);
      joined.set(to.data.pending);
      joined.set(d, to.data.pending.length);
      to.data.pending = joined;
      return;
    }
    const n = to.write(d);
    if (n < d.length) to.data.pending = d.slice(n);
  };
  const drain = (s: Side) => {
    const p = s.data.pending;
    if (!p) return;
    s.data.pending = null;
    send(s, p);
    if (!s.data.pending && s.data.ending) s.end();
  };
  const close = (to: Side | undefined) => later(() => {
    if (!to) return;
    if (to.data.pending) to.data.ending = true;
    else to.end();
  });
  const server = Bun.listen<Link>({
    hostname: "127.0.0.1", port: 0,
    socket: {
      async open(client) {
        client.data = { pending: null, ending: false, early: [] };
        const upstream = await Bun.connect<Link>({
          hostname: "127.0.0.1", port: targetPort,
          socket: {
            open(s) { s.data = { peer: client as unknown as Side, pending: null, ending: false, early: [] }; },
            data(s, d) { serverSpoke = true; later(() => send(s.data.peer, d)); },
            drain(s) { drain(s as unknown as Side); },
            close(s) { close(s.data.peer); },
          },
        });
        client.data.peer = upstream as unknown as Side;
        // What the client sent while the connection to the server was being made.
        for (const d of client.data.early.splice(0)) later(() => send(client.data.peer, d));
      },
      data(client, d) {
        if (serverSpoke) { trips++; serverSpoke = false; }
        if (/^(?:GET|HEAD|PUT|POST|DELETE) /.test(Buffer.from(d.subarray(0, 8)).toString("latin1"))) requests++;
        if (!client.data.peer) client.data.early.push(d.slice());
        else later(() => send(client.data.peer, d));
      },
      drain(client) { drain(client as unknown as Side); },
      close(client) { close(client.data.peer); },
    },
  });
  return { port: server.port, trips: () => trips, requests: () => requests, reset: () => { trips = 0; requests = 0; serverSpoke = false; }, stop: () => server.stop(true) };
}
