// Quack inside the readers' process (DESIGN.md D125, D127; option 06, slice 4): the two hooks DuckDB calls, the listener, and
// the watch on how long a query has run. serve/worker.ts creates one when croft serve asks for it; serve/quack-access.ts
// holds the decisions, so this file is the part that talks to DuckDB.
//
// The order is db/modes.ts's (D118): everything here that must happen before the lock happens in `prepare`, which the
// connection factory runs after the extensions are loaded, the secret folder is pointed into the state folder and the copy
// is attached, and before the lock. DuckDB refuses to register the settings, or to start the listener, once outside access
// is off. Registered there, in the in-memory database (a macro cannot be made in a read-only copy, and a temporary one breaks
// the hook, option 06's spikes):
//
//   croft_authn(session, token, server_token)  JS: is this token a listed key? remembers the session as that key's
//   croft_authz_js(session, query, parsed)     JS: the query to run, or an error (quack-access.ts)
//   croft_authz(session, query)                macro: croft_authz_js(session, query, json_serialize_sql(query)::VARCHAR), the
//                                              name Quack's authorization setting holds. The macro is what hands the JS the
//                                              parsed query, so the check never waits on DuckDB.
//
// The three names are reserved: the serve gate refuses a scalar named croft_* or quack_* in anyone's SQL.
//
// The time limit. Quack has no server-side cancel [V: 2.0.0: a 13 s query ran to its end after its client gave up], and a
// query's end is not seen by a hook. quack_active_connections() lists what runs and since when; a query still `active` past
// serve.queryTimeoutMs is reported to croft serve, which kills this process (SIGKILL, as D76 and D119), so every session on
// it drops and the clients attach again. The same poll tells quack-access.ts which sessions still exist.
import { BOOLEAN, type DuckDBConnection, DuckDBScalarFunction, type DuckDBVector, VARCHAR } from "@duckdb/node-api";
import { CroftError } from "../core/errors.ts";
import { startQuackListener } from "../db/modes.ts";
import { loadCatalog } from "../sql/gate.ts";
import { AS_OF_VIEW, listenAddress } from "./quack-address.ts";
import { QuackAccess, type QuackEvent, type QuackKey, QuackRefusal } from "./quack-access.ts";

export const HOOK_AUTHN = "croft_authn";
export const HOOK_AUTHZ_JS = "croft_authz_js";
export const HOOK_AUTHZ = "croft_authz";

/** How often the running queries are looked at. */
export const WATCH_MS = 250;

export interface QuackOptions {
  /** serverMode.quackHost and quackPort. */
  host: string;
  port: number;
  /** serve.queryTimeoutMs: a query active longer than this ends the process. */
  queryTimeoutMs: number;
  /** serve.sharedTables. */
  shared: readonly string[];
  /** serverMode.quackMaxConcurrent: Quack queries running at once (D130). */
  maxConcurrent: number;
  keys: readonly QuackKey[];
  emit(e: QuackEvent): void;
  /** A query ran past the limit: croft serve kills this process. Called once. */
  overdue(o: { connection: string; ms: number }): void;
}

const text = (v: DuckDBVector, row: number): string | null => {
  const x = v.getItem(row);
  return x === null || x === undefined ? null : String(x);
};

export class QuackListener {
  readonly access: QuackAccess;
  /** The address actually bound (a port of 0 becomes the one picked); null before `prepare` has run. */
  uri: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private fired = false;

  constructor(private readonly o: QuackOptions) {
    this.access = new QuackAccess({ shared: o.shared, emit: o.emit, maxConcurrent: o.maxConcurrent });
    this.access.setKeys(o.keys);
  }

  /** Register the hooks and start the listener. The connection factory calls it before the lock (db/modes.ts, step 5). */
  async prepare(conn: DuckDBConnection): Promise<void> {
    const { access } = this;
    conn.registerScalarFunction(DuckDBScalarFunction.create({
      name: HOOK_AUTHN, returnType: BOOLEAN, parameterTypes: [VARCHAR, VARCHAR, VARCHAR], volatile: true,
      mainFunction: (_info, input, out) => {
        for (let r = 0; r < input.rowCount; r++) {
          let ok = false;
          try {
            ok = access.authenticate(text(input.getColumnVector(0), r) ?? "", text(input.getColumnVector(1), r));
          } catch {
            ok = false; // no sign-in on an error
          }
          out.setItem(r, ok);
        }
        out.flush();
      },
    }));
    conn.registerScalarFunction(DuckDBScalarFunction.create({
      name: HOOK_AUTHZ_JS, returnType: VARCHAR, parameterTypes: [VARCHAR, VARCHAR, VARCHAR], volatile: true,
      mainFunction: (_info, input, out) => {
        for (let r = 0; r < input.rowCount; r++) {
          try {
            out.setItem(r, access.authorize(text(input.getColumnVector(0), r) ?? "", text(input.getColumnVector(1), r) ?? "", text(input.getColumnVector(2), r) ?? ""));
          } catch (e) {
            // A refusal's text is the client's to read; anything else is croft's bug and says so without its details.
            throw e instanceof QuackRefusal ? e : new Error("croft could not check this query, so it was not run");
          }
        }
        out.flush();
      },
    }));
    await conn.run(`CREATE MACRO memory.main.${HOOK_AUTHZ}(session, query) AS ${HOOK_AUTHZ_JS}(session, query, json_serialize_sql(query)::VARCHAR)`);
    await conn.run(`SET GLOBAL quack_authentication_function = '${HOOK_AUTHN}'`);
    await conn.run(`SET GLOBAL quack_authorization_function = '${HOOK_AUTHZ}'`);
    const { uri, loopback } = listenAddress(this.o.host, this.o.port);
    try {
      this.uri = await startQuackListener(conn, uri, { allowOtherHostname: !loopback, disableSsl: !loopback });
    } catch (e) {
      throw listenFailed(uri, e);
    }
  }

  /** The views of the shared tables and the as-of view exist (they were made after the lock, for the copy now attached):
   *  read what a client may name from them, and let people sign in. Called after every swap. */
  async refresh(conn: DuckDBConnection, views: readonly string[]): Promise<void> {
    this.access.setCatalog(await loadCatalog(conn), [...views, AS_OF_VIEW]);
  }

  /** Start watching how long queries have run, and which sessions still exist, on a connection of its own. */
  watch(conn: DuckDBConnection): void {
    this.timer = setInterval(() => void this.poll(conn), WATCH_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(conn: DuckDBConnection): Promise<void> {
    if (this.polling || this.fired) return;
    this.polling = true;
    try {
      const began = Date.now();
      const reader = await conn.runAndReadAll("SELECT connection_id, state, epoch_ms(query_started_at) AS started FROM quack_active_connections()");
      const live = new Set<string>();
      let worst: { connection: string; ms: number } | null = null;
      let running = 0;
      const at = Date.now();
      for (const [id, state, started] of reader.getRowsJS()) {
        live.add(String(id));
        if (state !== "active" || started === null || started === undefined) continue;
        running++;
        const ms = at - Number(started);
        if (ms > this.o.queryTimeoutMs && (!worst || ms > worst.ms)) worst = { connection: String(id), ms };
      }
      this.access.prune(live);
      this.access.setActive(running, began);
      if (worst) {
        this.fired = true;
        this.o.overdue(worst);
      }
    } catch {
      // The next look tries again; a failed look never ends a query by itself.
    } finally {
      this.polling = false;
    }
  }
}

function listenFailed(uri: string, e: unknown): CroftError {
  const detail = (e instanceof Error ? e.message : String(e)).split("\n")[0]!;
  return new CroftError("QUACK_LISTEN_FAILED", {
    message: `croft serve could not listen for DuckDB clients on ${uri}: ${detail}`,
    hint: 'the port may be in use, or the address not this machine\'s: set "serverMode": {"quackPort": …} (or quackHost) in croft.json, or 0 for a free port, and restart croft serve',
    fix: { kind: "manual", description: 'choose another "serverMode.quackPort" (or "quackHost") in croft.json, then restart croft serve', requiresHuman: true },
    retryable: true,
    details: { uri, quack: detail },
  });
}
