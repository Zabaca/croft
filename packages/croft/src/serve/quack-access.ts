// Who may do what over Quack (DESIGN.md D125, D126; option 06, slice 4): the two decisions Quack asks croft for, with no
// DuckDB in them, so each can be tested with literal inputs and neither can wait.
//
// - authenticate(session, token): is the token a person's key that is listed now? The app token is not a key, so it is refused
//   here, as it is for a key on /status: Quack is for people, each with a key of their own. A session is remembered as that
//   person's, by the key's digest.
// - authorize(session, query, parsed): called for every query a session sends (Quack runs it only if this returns a query).
//   In order: the session's key must still be listed, which is why a key removed while a session is open is refused on
//   that session's next query (the list is the one croft serve pushes to the process when the keys file changes, D126);
//   the client's transaction control, and the two catalog queries it sends on ATTACH, are let through by their exact bytes
//   (the catalog ones swapped for a filtered query, quack-catalog.ts); everything else goes through sql/gate-core.ts
//   decide(), the same synchronous check HTTP uses (D123), narrowed to the shared tables and the as-of view.
//
// A refusal is a thrown QuackRefusal: Quack shows the client "Authorization callback failed: <message>", and a null return would say
// only "Authorization failed". Its text is a CroftError's message and hint, which never name a hidden table (the words are
// those of a table that does not exist) and never echo the query.
import { timingSafeEqual } from "node:crypto";
import { CroftError } from "../core/errors.ts";
import { type CatalogSnapshot, decide, parseSerialized } from "../sql/gate-core.ts";
import { catalogReplacements, TRANSACTION_TEXTS } from "./quack-catalog.ts";
import { noSharedTables } from "./errors.ts";
import { AS_OF_VIEW } from "./quack-address.ts";
import { hashKey } from "./keys.ts";

/** A refusal the hook throws on purpose: Quack shows the client its text. Anything else thrown in a hook is croft's bug. */
export class QuackRefusal extends Error {}

/** A key as the process holds it: its name and the digest croft stores (serve/keys.ts hashKey). Never the key. */
export interface QuackKey {
  name: string;
  hash: string;
}

/** What a Quack session did, for croft serve's log and a key's last-used time (the process cannot write either). */
export type QuackEvent =
  | { kind: "signin"; key: string; at: number }
  | { kind: "query"; key: string; at: number; tables: string[]; outcome: string };

export interface QuackAccessOptions {
  /** serve.sharedTables: the tables a key may name. The as-of view is added to them here. */
  shared: readonly string[];
  /** Told of every sign-in and every data query, answered or refused. Never throws into the hook. */
  emit(e: QuackEvent): void;
  /** Milliseconds since the epoch; the clock by default. */
  now?(): number;
}

interface Session {
  key: string;
  hash: string;
  since: number;
}

/** The hash of `given` as a buffer. */
const digest = (hash: string) => Buffer.from(hash.slice("sha256:".length), "hex");

export class QuackAccess {
  private keys: QuackKey[] = [];
  private readonly sessions = new Map<string, Session>();
  private catalog: CatalogSnapshot | null = null;
  private replacements: ReadonlyMap<string, string> = new Map();
  private ready = false;
  private readonly shared: readonly string[];
  private readonly now: () => number;

  constructor(private readonly o: QuackAccessOptions) {
    this.shared = [...o.shared, AS_OF_VIEW];
    this.now = o.now ?? (() => Date.now());
  }

  /** The keys listed now. A session whose key is not among them is refused on its next query. */
  setKeys(keys: readonly QuackKey[]): void {
    this.keys = keys.map((k) => ({ name: k.name, hash: k.hash }));
  }

  /**
   * What a client may see: the catalog snapshot of the in-memory database (its views are the shared tables and the as-of view)
   * and, for the two catalog queries, the names of those views. Called after every swap. Until it has been called, no one
   * signs in: a client that attached before the views existed would list nothing.
   */
  setCatalog(catalog: CatalogSnapshot, views: readonly string[]): void {
    this.catalog = catalog;
    this.replacements = catalogReplacements(views);
    this.ready = true;
  }

  get signedIn(): number {
    return this.sessions.size;
  }

  authenticate(session: string, token: string | null): boolean {
    if (!this.ready || token === null) return false;
    const want = digest(hashKey(token));
    let found: QuackKey | null = null;
    // Every digest is compared, so the time taken does not say where a match was (serve/keys.ts verify()).
    for (const k of this.keys) {
      if (timingSafeEqual(want, digest(k.hash))) found = k;
    }
    if (!found) return false;
    this.sessions.set(session, { key: found.name, hash: found.hash, since: this.now() });
    this.tell({ kind: "signin", key: found.name, at: this.now() });
    return true;
  }

  /**
   * The query to run in place of `query`, or a thrown Error (the refusal). `parsed` is json_serialize_sql(query) as text,
   * which the hook's macro computes before the call.
   */
  authorize(session: string, query: string, parsed: string): string {
    const s = this.sessions.get(session);
    if (!s) throw new QuackRefusal("this session is not signed in; attach again with a key");
    if (!this.keys.some((k) => k.hash === s.hash && k.name === s.key)) {
      throw new QuackRefusal(`the key ${s.key} was removed, so this session is closed; ask for a new key and attach again [SERVE_UNAUTHORIZED]`);
    }
    if (TRANSACTION_TEXTS.has(query)) return query;
    try {
      // A project that shares no table shares nothing with a key: every query is refused, the client's attach included, so the
      // refusal that reaches the person names the setting (D122).
      if (this.o.shared.length === 0) throw noSharedTables();
      const replacement = this.replacements.get(query);
      if (replacement !== undefined) return replacement;
      const verdict = this.decide(query, parsed);
      this.tell({ kind: "query", key: s.key, at: this.now(), tables: verdict.tables, outcome: "ok" });
      return verdict.sql;
    } catch (e) {
      if (!(e instanceof CroftError)) throw e;
      this.tell({ kind: "query", key: s.key, at: this.now(), tables: [], outcome: e.code });
      throw new QuackRefusal(`${e.problem.message}${e.problem.hint ? `; ${e.problem.hint}` : ""} [${e.code}]`);
    }
  }

  /** Forget sessions the server no longer lists (their client detached or went away). A session younger than `minAgeMs` is kept:
   *  it signed in a moment ago and may not be listed yet. */
  prune(live: ReadonlySet<string>, minAgeMs = 30_000): void {
    const at = this.now();
    for (const [id, s] of this.sessions) if (!live.has(id) && at - s.since >= minAgeMs) this.sessions.delete(id);
  }

  private decide(query: string, parsed: string) {
    if (!this.catalog) throw new QuackRefusal("croft serve has no catalog for this session yet; try again");
    // A statement json_serialize_sql could not serialize is one DuckDB can parse but that is not a SELECT: it is counted as one
    // statement, so the refusal is QUERY_NOT_SELECT (what HTTP says), not "no statement". A parse error is a syntax error.
    const count = parseSerialized(parsed).error ? 1 : undefined;
    return decide({
      sql: query, parsed, ...(count !== undefined ? { count } : {}), catalog: this.catalog,
      options: { profile: "serve", shared: this.shared },
    });
  }

  private tell(e: QuackEvent): void {
    try {
      this.o.emit(e);
    } catch {
      // A log that cannot be written never costs a client its answer.
    }
  }
}
