// Lake mode, in the warehouse (DESIGN.md D138 to D144; option 07, slice 2): what a project's `lake` setting becomes when a command
// opens the warehouse, how a lake's errors are told apart, who may write it, and which machine did.
//
// - lakeConnection(): the project's settings and its secrets as the ModeSpec an instance attaches (db/modes.ts), by access. The
//   writer's login and key are resolved only for a process that writes; everything that only reads resolves the read-only pair and
//   never holds the writer's.
// - The errors of a lake that came and went (a dropped Postgres connection, a restart) and a commit whose outcome nobody knows are
//   told apart by what DuckDB and DuckLake say (isConnectionError, isCommitFailure, isConflict), tested against a real Postgres
//   that is terminated and restarted. db/warehouse.ts retries reads, and writes as a whole.
// - One writing machine, one write at a time on it: a lock of croft's own in the state folder, in place of the file's lock (LakeWriteLock).
// - Which machines wrote is a row of _croft.meta for each (writerKey), so croft doctor can warn when another machine has written since.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CroftError } from "../core/errors.ts";
import { currentIdentity, recordAlive } from "../core/proc.ts";
import type { LockHolder, Sql } from "../core/types.ts";
import type { ProjectEnv } from "../project/env.ts";
import { bucketPath, type LakeConfig, lakeSecretNames, localLakePaths } from "../project/lake-config.ts";
import type { Project } from "../project/root.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { catalogTls } from "./catalog-tls.ts";
import { LAKE_ALIAS, type ModeSpec, REFUSED, TLS_REFUSED } from "./modes.ts";
import { CROFT_VERSION } from "./state.ts";
import { storeCaFile } from "./store-tls.ts";

/** What a warehouse needs to attach the project's lake: its label, and the mode (extensions, credentials, attach) for an access. */
export interface LakeConnection {
  /** Where the lake is, for messages: no credential in it. */
  readonly label: string;
  readonly kind: "postgres" | "local";
  /** The folder of DuckDB's secret files for the instance, inside the state folder. */
  readonly secretDir: string;
  /** The names of the project's secrets the lake uses: declared, so their values are redacted wherever they could appear. */
  readonly secretNames: readonly string[];
  /** The mode for an instance that writes (the writer's login and key) or only reads (the read-only ones). Throws SECRET_MISSING. */
  mode(access: "write" | "read"): ModeSpec;
}

/**
 * The project's lake as a warehouse opens it, or undefined for a project with a file. `extensionDir` is for croft's tests: the folder of
 * pinned extension files; a project's are in $CROFT_EXTENSION_DIR or croft's cache, fetched from DuckDB when absent (D195).
 */
export function lakeConnection(project: Project, env: ProjectEnv, o: { extensionDir?: string; listsBucket?: true } = {}): LakeConnection | undefined {
  const lake = project.config.lake;
  if (!lake) return undefined;
  const names = lakeSecretNames(lake);
  const secretDir = join(project.paths.stateDir, "lake-secrets");
  const base = { secretDir, ...(o.extensionDir ? { extensionDir: o.extensionDir } : {}) };
  // secret() declares every name of the lake first, so a value is redacted from every message and log whether it came from .env, the
  // shell or secretsFrom, and throws SECRET_MISSING for a name nothing sets.
  const secret = (name: string): string => env.secret(name, names);
  return {
    label: project.databaseLabel,
    kind: lake.kind,
    secretDir,
    secretNames: names,
    mode: (access) => lakeMode(lake, project, access, base, secret, { tlsEnv: { SSL_CERT_FILE: env.lookup("SSL_CERT_FILE")?.value }, listsBucket: o.listsBucket }),
  };
}

/** `{ lake }` for a warehouse's options when the project has a lake, else nothing: spread into openWarehouse(). */
export function lakeOption(project: Project, env: ProjectEnv, o: { listsBucket?: true } = {}): { lake?: LakeConnection } {
  const lake = lakeConnection(project, env, o);
  return lake ? { lake } : {};
}

function lakeMode(lake: LakeConfig, project: Project, access: "write" | "read", base: Pick<ModeSpec, "secretDir" | "extensionDir">, secret: (name: string) => string,
  o: { tlsEnv: NodeJS.ProcessEnv; listsBucket?: true }): ModeSpec {
  if (lake.kind === "local") {
    const { catalog, data } = localLakePaths(lake, project.root);
    // A reader never makes the lake; the machine that writes does, with the folders it needs.
    if (access === "write") {
      mkdirSync(data, { recursive: true });
      mkdirSync(join(catalog, ".."), { recursive: true });
    }
    return { ...base, kind: "lake-local", lake: { catalog: { kind: "sqlite", path: catalog }, dataPath: `${data.replace(/\/+$/, "")}/`, access } };
  }
  const login = access === "write" ? lake.catalog.writer : lake.catalog.reader;
  const key = access === "write" ? lake.bucket.writer : lake.bucket.reader;
  const b = lake.bucket;
  const tls = catalogTls(lake.catalog, project.root, { env: o.tlsEnv });
  const caFile = storeCaFile(b, project.root, { env: o.tlsEnv });
  return {
    ...base,
    kind: "lake",
    lake: {
      catalog: { kind: "postgres", host: lake.catalog.host, port: lake.catalog.port, database: lake.catalog.database, user: login.user, password: secret(login.passwordSecret), ...tls },
      data: {
        path: bucketPath(b), keyId: secret(key.keyIdSecret), secretKey: secret(key.secretKeySecret),
        ...(key.sessionTokenSecret ? { sessionToken: secret(key.sessionTokenSecret) } : {}),
        ...(b.endpoint ? { endpoint: b.endpoint } : {}), ...(b.region ? { region: b.region } : {}), urlStyle: b.urlStyle, useSsl: b.useSsl,
        ...(caFile ? { caFile } : {}), ...(o.listsBucket ? { listsBucket: o.listsBucket } : {}),
      },
      access,
    },
  };
}

// ---- Telling a lake's errors apart ------------------------------------------------------------------------------

/** DuckDB's and Postgres's words for a connection that dropped, could not be made, or was ended: what a Postgres restart,
 *  pg_terminate_backend or a network drop leaves [V: 2.0.0, a real Postgres, option 07's spike and this slice's tests]. */
const CONNECTION = /server closed the connection|no connection to the server|connection to server .*failed|connection .*(?:was )?(?:reset|lost|timed out|closed)|Connection refused|Unable to connect to Postgres|terminating connection|SSL SYSCALL|broken pipe|could not (?:connect|receive|send)|EOF detected|the database system is (?:shutting down|starting up|in recovery|not yet accepting)|Failed to prepare COPY/i;

/** A catalog or store that went away for a moment: the next statement reconnects by itself. */
export function isConnectionError(e: unknown): boolean {
  const text = messageOf(e);
  // A server that answered and refused the login or the key is not a connection that dropped: waiting does not change its answer.
  return CONNECTION.test(text) && !REFUSED.test(text) && !TLS_REFUSED.test(text);
}

/** A commit DuckLake could not finish. Its cause may be a dropped connection or a conflict, and whether it landed is not known. */
export function isCommitFailure(e: unknown): boolean {
  return /Failed to commit DuckLake transaction|Failed to commit:/i.test(messageOf(e));
}

/** Another transaction changed what this one wrote or read, or SQLite's lock refused the commit: nothing landed, and trying again is safe. */
export function isConflict(e: unknown): boolean {
  return /Transaction conflict|conflict.*(?:another|concurrent)|(?:another|concurrent).*conflict|database is locked|SQLITE_BUSY/i.test(messageOf(e));
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** How many times a read, or a whole write, is tried when the catalog's connection dropped, and for a conflict. */
export const LAKE_RETRY = { connection: 2, conflict: 4 } as const;

/** Wait a little longer each time, with jitter; a catalog that is restarting needs seconds, not milliseconds. */
export function lakeBackoffMs(attempt: number): number {
  const base = Math.min(2000, 150 * 2 ** attempt);
  return Math.round(base / 2 + Math.random() * (base / 2));
}

/**
 * Which of the tags of a step's earlier attempts is on a snapshot of the lake, or null: DuckLake records the commit message on the
 * snapshot. A commit that was in flight when the connection dropped is ended by Postgres either way within moments, so the check waits
 * a beat first. The tag is how croft tells apart a commit that landed from one that did not, for every kind of write, rather than
 * reading the bookkeeping of one: a delete, a restore and a rename write no run of their own. Every attempt whose commit may still
 * land is asked about at once, before each retry, since an earlier attempt's commit can land after a later one has begun.
 */
export async function landedTag(sql: Sql, tags: readonly string[], o: { settleMs?: number } = {}): Promise<string | null> {
  await sleep(o.settleMs ?? 250);
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      // The tags are croft's own (croft:<pid>:<uuid>, or a test's), never text from a user; still quoted as literals.
      const list = tags.map((t) => `'${t.replaceAll("'", "''")}'`).join(", ");
      const rows = await sql.all<{ m: string }>(`SELECT commit_message AS m FROM ducklake_snapshots('${LAKE_ALIAS}') WHERE commit_message IN (${list})`);
      return tags.find((t) => rows.some((r) => r.m === t)) ?? null;
    } catch (e) {
      last = e;
      if (!isConnectionError(e)) throw e;
      await sleep(lakeBackoffMs(attempt));
    }
  }
  throw last;
}

/**
 * The connection variable that names the write transaction in progress (its commit tag): set as a lake write begins, so a change that must
 * happen once per transaction (a table's rewrite, load/evolve.ts retypeColumns) can be counted by croft and not found out from DuckLake's
 * error, which comes or not by timing. A variable of the connection is seen by every wrapper around the transaction's Sql.
 */
export const TX_VARIABLE = "croft_tx";

/** A fresh tag for one commit. */
export function newCommitTag(): string {
  return `croft:${process.pid}:${randomUUID()}`;
}

// ---- Types a lake cannot hold -----------------------------------------------------------------------------------

/** The column types DuckLake refuses: ENUM, UNION, VARINT (DuckDB 2.0 spells it BIGNUM when it names the type of a column), BIT and a fixed-size
 *  ARRAY (`INTEGER[3]`; a LIST, `INTEGER[]`, is fine), also inside a STRUCT, LIST or MAP [V: 2.0.0, DuckLake 1.0, every other type round-trips:
 *  the probe of option 07 slice 4 copied BOOLEAN, every integer width, FLOAT, DOUBLE, DECIMAL, VARCHAR, BLOB, DATE, TIME, every TIMESTAMP, UUID,
 *  JSON, STRUCT, LIST, MAP and TIME_NS out of a file and back with no difference; HUGEINT, UHUGEINT, INTERVAL and TIMETZ it changes, below]. The first three are
 *  matched whatever the case; DuckDB writes BIT in capitals, so a STRUCT field named "bit" is not taken for one. */
const LAKE_TYPE = /\b(ENUM|UNION|VARINT|BIGNUM)\b/i;
const LAKE_BIT = /\bBIT\b/;
const LAKE_ARRAY = /\[\d+\]/;

export type LakeRefusedKind = "ENUM" | "UNION" | "VARINT" | "BIT" | "ARRAY";

/** The columns among `columns` whose type a lake cannot hold, with the word that says so. */
export function lakeRefusedColumns(columns: readonly { name: string; type: string }[]): { name: string; type: string; kind: LakeRefusedKind }[] {
  return columns.flatMap((c) => {
    const word = LAKE_TYPE.exec(c.type)?.[1]?.toUpperCase();
    const kind: LakeRefusedKind | undefined = word === "BIGNUM" ? "VARINT" : word ? (word as "ENUM" | "UNION" | "VARINT")
      : LAKE_BIT.test(c.type) ? "BIT" : LAKE_ARRAY.test(c.type) ? "ARRAY" : undefined;
    return kind ? [{ name: c.name, type: c.type, kind }] : [];
  });
}

/** The SELECT expression that stores a refused column in a type a lake takes. */
export function lakeCastFix(c: { name: string; type: string; kind: LakeRefusedKind }): string {
  switch (c.kind) {
    case "ENUM":
    case "BIT":
      return `CAST(${c.name} AS VARCHAR) AS ${c.name}`;
    case "VARINT":
      return `CAST(${c.name} AS ${LAKE_HUGE}) AS ${c.name}, or AS VARCHAR when it can have more than 38 digits`;
    case "ARRAY":
      // A fixed-size array becomes a list of the same element type: INTEGER[3] → INTEGER[].
      return `CAST(${c.name} AS ${c.type.replace(/\[\d+\]/g, "[]")}) AS ${c.name}`;
    default:
      return `CAST(${c.name} AS VARCHAR) AS ${c.name}, or to_json(${c.name}) AS ${c.name}`;
  }
}

// ---- Types a lake stores inexactly ------------------------------------------------------------------------------

/**
 * The types DuckLake 1.0 (DuckDB 2.0.0) changes on the way into a Parquet file [V: 2.0.0, option 07 slice 4's probe, 400 rows of each type so that
 * a file is written; a few rows stay in the catalog and read back exactly, which hides it]: HUGEINT and UHUGEINT are stored as DOUBLE (a value past
 * 2^53 comes back changed, and one near the top of the range cannot be read at all), an INTERVAL keeps its milliseconds and loses the microseconds
 * under them, a TIMETZ comes back at offset 0; also inside a STRUCT, a LIST or a MAP. Every other type round-trips. A lake write therefore refuses
 * these by the column's TYPE, not by its values (D174): whether a value survives depends on where its rows are kept, which changes under a table
 * (the maintenance flush moves rows from the catalog into files). DuckDB writes the type names in capitals, so a STRUCT field named "interval" is
 * not taken for one.
 */
/** The type a lake keeps a whole number of up to 38 digits in exactly, where DuckDB would use a HUGEINT (D174). */
export const LAKE_HUGE = "DECIMAL(38,0)";

export type LakeInexactKind = "HUGEINT" | "UHUGEINT" | "INTERVAL" | "TIMETZ";

const INEXACT: readonly [LakeInexactKind, RegExp][] = [
  ["UHUGEINT", /\bUHUGEINT\b/], ["HUGEINT", /\bHUGEINT\b/], ["INTERVAL", /\bINTERVAL\b/], ["TIMETZ", /\bTIME WITH TIME ZONE\b|\bTIMETZ\b/],
];

export interface LakeInexactColumn { name: string; type: string; kind: LakeInexactKind; nested: boolean }

/** The columns among `columns` whose type a lake would store inexactly (the first kind found in a type), and whether it is inside a STRUCT, LIST or MAP. */
export function lakeInexactColumns(columns: readonly { name: string; type: string }[]): LakeInexactColumn[] {
  const plain: Record<LakeInexactKind, RegExp> = { HUGEINT: /^HUGEINT$/, UHUGEINT: /^UHUGEINT$/, INTERVAL: /^INTERVAL$/, TIMETZ: /^(TIME WITH TIME ZONE|TIMETZ)$/ };
  return columns.flatMap((c) => {
    for (const [kind, re] of INEXACT) if (re.test(c.type)) return [{ name: c.name, type: c.type, kind, nested: !plain[kind].test(c.type.trim()) }];
    return [];
  });
}

/** The SELECT expression that stores a column of an inexact type in a type a lake keeps exactly. */
export function lakeInexactFix(c: LakeInexactColumn): string {
  if (c.nested) return `cast the inner value, or turn the whole column into JSON with to_json(${c.name}) AS ${c.name}`;
  switch (c.kind) {
    case "HUGEINT": return `CAST(${c.name} AS ${LAKE_HUGE}) AS ${c.name} (exact up to 38 digits), or AS VARCHAR`;
    case "UHUGEINT": return `CAST(${c.name} AS VARCHAR) AS ${c.name}`;
    case "INTERVAL": return `CAST(${c.name} AS VARCHAR) AS ${c.name}, or the length as a whole number of milliseconds`;
    case "TIMETZ": return `CAST(${c.name} AS VARCHAR) AS ${c.name}, or CAST(${c.name} AS TIME) AS ${c.name} when the offset does not matter`;
  }
}

export const LAKE_INEXACT_WHY: Record<LakeInexactKind, string> = {
  HUGEINT: "a lake stores a HUGEINT as a DOUBLE, which changes a value past 2^53 (9007199254740993 comes back 9007199254740992) and cannot read one near the top of the range at all",
  UHUGEINT: "a lake stores a UHUGEINT as a DOUBLE, which changes a value past 2^53 and cannot read one near the top of the range at all",
  INTERVAL: "a lake keeps an INTERVAL to the millisecond, so 1.000003 seconds comes back 1 second",
  TIMETZ: "a lake stores a TIMETZ as the same time at offset 0, so 10:11:12+02 comes back 08:11:12+00",
};

/**
 * LAKE_VALUES_INEXACT for a result that has a column of a type a lake would store inexactly, before anything is written. Nothing, for a column list a
 * lake keeps exactly.
 */
export function refuseInexactTypes(asset: string, columns: readonly { name: string; type: string }[], file?: string): void {
  const bad = lakeInexactColumns(columns);
  if (!bad.length) return;
  const kinds = [...new Set(bad.map((c) => c.kind))];
  throw new CroftError("LAKE_VALUES_INEXACT", {
    asset, ...(file ? { file } : {}),
    message: `${asset}: ${bad.map((c) => `${c.name} is ${c.type.length > 60 ? `${c.type.slice(0, 57)}...` : c.type}`).join("; ")}; a lake would store ${bad.length === 1 ? "its values" : "their values"} differently from the ones written`,
    hint: `${kinds.map((k) => LAKE_INEXACT_WHY[k]).join("; ")}; store ${bad.length === 1 ? "it" : "them"} in a type a lake keeps exactly, in the SELECT or the pin that sets the type: ${bad.map(lakeInexactFix).join("; ")}`,
    fix: { kind: "manual", description: `cast ${bad.map((c) => c.name).join(", ")} to a type a lake keeps exactly (${LAKE_HUGE} or VARCHAR for a HUGEINT, VARCHAR for an INTERVAL or a TIMETZ) in ${file ?? `${asset}'s code`}` },
    effect: "nothing was written",
    details: { columns: bad.map((c) => ({ name: c.name, type: c.type, kind: c.kind, fix: lakeInexactFix(c) })), kind: bad[0]!.kind },
  });
}

/**
 * LAKE_TYPE_UNSUPPORTED for a result that has a column a lake cannot hold, before anything is written: croft's code and the cast that
 * fixes it, not DuckDB's error from the middle of a write. Nothing, for a column list the lake takes.
 */
export function refuseUnfitLakeColumns(asset: string, columns: readonly { name: string; type: string }[], file?: string): void {
  const bad = lakeRefusedColumns(columns);
  if (!bad.length) return refuseInexactTypes(asset, columns, file);
  const first = bad[0]!;
  const fixes = bad.map(lakeCastFix);
  throw new CroftError("LAKE_TYPE_UNSUPPORTED", {
    asset, ...(file ? { file } : {}),
    message: `${asset}: ${bad.map((c) => `${c.name} is ${c.type.length > 60 ? `${c.type.slice(0, 57)}...` : c.type}`).join("; ")}; a lake cannot store ${[...new Set(bad.map((c) => c.kind))].join(", ")} columns`,
    hint: `cast ${bad.length === 1 ? "it" : "them"} in the SELECT: ${fixes.join("; ")}`,
    fix: { kind: "manual", description: `cast ${bad.map((c) => c.name).join(", ")} to a type a lake stores (VARCHAR, or ${LAKE_HUGE} for a VARINT, a list for a fixed-size array) in ${file ?? `${asset}'s code`}` },
    effect: "nothing was written",
    details: { columns: bad.map((c) => ({ name: c.name, type: c.type })), kind: first.kind },
  });
}

// ---- Which machine wrote ----------------------------------------------------------------------------------------

/** The prefix of the rows of _croft.meta that say which machines wrote the lake: one row per machine, the last write of each. */
export const WRITER_PREFIX = "writer.";
export const writerKey = (machineId: string): string => `${WRITER_PREFIX}${machineId}`;

let machine: string | undefined;

/** A stable name for this machine that survives its restarts and the project folder being copied to another one: the platform's machine
 *  id (or $CROFT_MACHINE_ID), hashed, with the host name for people to read. */
export function machineId(): string {
  // $CROFT_MACHINE_ID names the machine when the platform's id is not a stable one (a container that gets a new one each start), and lets a
  // test be two machines. It is hashed like the platform's.
  const named = process.env.CROFT_MACHINE_ID;
  if (named) return createHash("sha256").update(named).digest("hex").slice(0, 16);
  if (machine) return machine;
  let raw = "";
  try {
    if (process.platform === "linux") raw = readFileSync("/etc/machine-id", "utf8").trim() || readFileSync("/var/lib/dbus/machine-id", "utf8").trim();
    else if (process.platform === "darwin") {
      const out = spawnSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", env: { PATH: "/usr/sbin:/usr/bin:/bin", LC_ALL: "C" } });
      raw = /"IOPlatformUUID" = "([^"]+)"/.exec(out.stdout ?? "")?.[1] ?? "";
    }
  } catch {
    // Fall back to the host name below.
  }
  machine = createHash("sha256").update(raw || hostname()).digest("hex").slice(0, 16);
  return machine;
}

/** How long a LAKE_OTHER_WRITER warning stays after the other machine's write (or the write that found it), whatever this machine writes meanwhile. */
export const OTHER_WRITER_WARNING_DAYS = 7;
const WARNING_MS = OTHER_WRITER_WARNING_DAYS * 86_400_000;

/**
 * What a machine's row of _croft.meta holds (`writer.<machine>`): the machine, the host's name, when, which run and which croft, and a
 * counter `n`. The counter is what orders the machines' writes: one more than the largest any record holds, read and written in the
 * write's own transaction, so it follows the lake's commit order and not any machine's clock (a clock that runs behind would order its
 * machine before the one it wrote after). `at` is for people to read, and for how long a warning stays.
 *
 * `crossed` is set when the write found another machine's record with a larger counter than this machine's one before it (or this machine
 * had none), and carried over by this machine's later writes until the warning's days are over, counted from the other machine's `at` or
 * from the write that found it (`seen`), whichever is later: a clean write of this machine's own does not clear it.
 */
export interface WriterRecord { machine: string; host: string; at: string; run: string | null; croft: string; n: number; crossed: Crossing | null }
export interface Crossing { machine: string; host: string; at: string; run: string | null; seen: string }

const staysAt = (c: Crossing, nowMs: number): boolean => {
  const since = Math.max(Date.parse(c.at) || 0, Date.parse(c.seen) || 0);
  return nowMs - since < WARNING_MS;
};

const machinesIn = (rows: readonly { key: string; value: string | undefined }[]): WriterRecord[] =>
  rows.flatMap((r) => (r.key.startsWith(WRITER_PREFIX) ? [parseWriter(r.value)] : [])).filter((r): r is WriterRecord => r !== null);

/** This machine's record for a write at `at`, given the rows of meta that are machines' records (`key`, `value`). */
export function writerRecord(runId: string | null, at: Date = new Date(), rows: readonly { key: string; value: string }[] = []): WriterRecord {
  const me = machineId();
  const records = machinesIn(rows);
  const mine = records.find((r) => r.machine === me);
  const newest = records.filter((r) => r.machine !== me).sort((a, b) => b.n - a.n)[0];
  const n = Math.max(0, ...records.map((r) => r.n)) + 1;
  const found = newest && (!mine || newest.n > mine.n) ? { machine: newest.machine, host: newest.host, at: newest.at, run: newest.run, seen: at.toISOString() } : null;
  const crossed = found ?? (mine?.crossed && staysAt(mine.crossed, at.getTime()) ? mine.crossed : null);
  return { machine: me, host: hostname(), at: at.toISOString(), run: runId, croft: CROFT_VERSION, n, crossed };
}

/** The record in meta text, or null when it is not one. */
export function parseWriter(value: string | undefined | null): WriterRecord | null {
  if (!value) return null;
  try {
    const v = JSON.parse(value) as Partial<WriterRecord>;
    if (typeof v.machine !== "string" || typeof v.at !== "string") return null;
    const c = v.crossed;
    const crossed = c && typeof c.machine === "string" && typeof c.at === "string"
      ? { machine: c.machine, host: c.host ?? "", at: c.at, run: c.run ?? null, seen: typeof c.seen === "string" ? c.seen : c.at } : null;
    return { machine: v.machine, host: v.host ?? "", at: v.at, run: v.run ?? null, croft: v.croft ?? "", n: typeof v.n === "number" ? v.n : 0, crossed };
  } catch {
    return null;
  }
}

/**
 * What `croft doctor` makes of the machines' records in meta, for the machine it runs on, at `nowMs`. Another machine has written since this
 * one's last write when its counter is larger than this one's (until this machine writes again), and a crossing this machine's last write
 * found stays for OTHER_WRITER_WARNING_DAYS from the other machine's write or from the write that found it. A machine that has never
 * written is not a competing writer, so it is told who wrote and nothing else.
 */
export function writerReport(meta: Readonly<Record<string, string | undefined>>, nowMs: number = Date.now()): { mine: WriterRecord | null; others: WriterRecord[]; crossing: Crossing | null } {
  const records = machinesIn(Object.entries(meta).map(([key, value]) => ({ key, value })));
  const me = machineId();
  const mine = records.find((r) => r.machine === me) ?? null;
  const others = records.filter((r) => r.machine !== me).sort((a, b) => b.n - a.n);
  const newer = mine ? others.find((o) => o.n > mine.n) : undefined;
  const crossing: Crossing | null = !mine ? null
    : newer ? { machine: newer.machine, host: newer.host, at: newer.at, run: newer.run, seen: newer.at }
    : mine.crossed && staysAt(mine.crossed, nowMs) ? mine.crossed : null;
  return { mine, others, crossing };
}

// ---- One writer at a time on this machine -----------------------------------------------------------------------

interface LockRecord { pid: number; procStart: string; bootId: string; runId: string | null; asset?: string; label: string; since: string }

const LOCK_FOLDER = "lake-write.lock";
/** The label a lake maintenance pass takes the lock with (db/lake-pass.ts): the holder is then told as `maintenance`, not as a write. */
export const MAINTENANCE_LOCK_LABEL = "lake maintenance";
/** A lock folder whose holder file never appeared (its taker died between the mkdir and the write) is stale after this long. */
const HOLDERLESS_STALE_MS = 10_000;
/** The lock a reclaimer holds while it removes a dead holder's lock is stale after this long. */
const RECLAIM_STALE_MS = 10_000;

/**
 * croft's own lock on the lake's writes, in place of the file's lock (DuckDB's), which a lake does not have. It is a folder made with
 * mkdir (atomic) in the state folder holding one file that names its holder. A holder whose process is gone (a kill -9, a reboot) is
 * reclaimed by the next taker, as asset leases are: the PID, the process's start time and the boot id decide. It orders the writes of
 * this machine, which is the only machine that writes (option 07: one writing machine per lake). Two lakes' states are different
 * folders, so two projects never wait for each other.
 */
export class LakeWriteLock {
  private readonly dir: string;
  constructor(stateDir: string) {
    this.dir = join(stateDir, LOCK_FOLDER);
  }

  /** The live holder, or null. A dead one is reclaimed on the way. */
  holder(): LockHolder | null {
    const rec = this.read();
    if (rec === "none") return null;
    if (rec === "empty") return statSafe(this.dir) > HOLDERLESS_STALE_MS ? (this.reclaim("empty"), null) : { pid: null, program: "croft" };
    if (!recordAlive({ pid: rec.pid, procStart: rec.procStart, bootId: rec.bootId })) {
      this.reclaim(rec);
      return null;
    }
    return {
      pid: rec.pid, program: "croft", ...(rec.runId ? { runId: rec.runId } : {}), ...(rec.asset ? { asset: rec.asset } : {}),
      action: rec.label === MAINTENANCE_LOCK_LABEL ? "maintenance" : "write", since: rec.since,
    };
  }

  /**
   * Take the lock, waiting up to `waitMs`; returns what releases it. `onWait` is called once, with the holder and how long the wait has
   * been, when it has gone on for `noticeAfterMs`. `busy` makes the error for a wait that ran out, `aborted` the one for a signal.
   */
  async acquire(o: {
    waitMs: number; runId?: string | null; asset?: string; label: string; signal?: AbortSignal; noticeAfterMs?: number;
    onWait?: (h: LockHolder, waitedMs: number) => void; busy: (h: LockHolder | null, waitedMs: number) => CroftError; aborted: () => CroftError;
  }): Promise<() => void> {
    const started = Date.now();
    let told = false;
    for (let attempt = 0; ; attempt++) {
      if (o.signal?.aborted) throw o.aborted();
      if (this.tryTake(o.runId ?? null, o.asset, o.label)) return () => this.release();
      const holder = this.holder();
      if (!holder) {
        // It went while we looked, or was stale and was reclaimed: try at once. But a lock that is still there with no live holder was
        // not removed (another reclaimer holds the reclaim lock, or the holder and the reclaimer both died): wait a moment, not a spin
        // that starts `ps` for every turn, until the reclaim lock goes stale.
        if (existsSync(this.dir)) await sleepAbortable(50 + Math.round(Math.random() * 50), o.signal);
        continue;
      }
      const waited = Date.now() - started;
      if (!told && waited >= (o.noticeAfterMs ?? 2000)) {
        told = true;
        o.onWait?.(holder, waited);
      }
      if (waited >= o.waitMs) throw o.busy(holder, waited);
      await sleepAbortable(Math.min(Math.round(25 * 2 ** Math.min(attempt, 5) * (0.5 + Math.random() / 2)), 1000, o.waitMs - waited), o.signal);
    }
  }

  private tryTake(runId: string | null, asset: string | undefined, label: string): boolean {
    try {
      mkdirSync(this.dir, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        mkdirSync(join(this.dir, ".."), { recursive: true });
        return this.tryTake(runId, asset, label);
      }
      throw e;
    }
    const id = currentIdentity();
    const rec: LockRecord = { pid: id.pid, procStart: id.procStart, bootId: id.bootId, runId, ...(asset ? { asset } : {}), label, since: new Date().toISOString() };
    writeFileSync(join(this.dir, "holder.json.tmp"), JSON.stringify(rec));
    renameSync(join(this.dir, "holder.json.tmp"), join(this.dir, "holder.json"));
    return true;
  }

  private release(): void {
    const rec = this.read();
    if (rec !== "none" && rec !== "empty" && rec.pid !== process.pid) return; // not ours any more: someone reclaimed it
    rmSync(this.dir, { recursive: true, force: true });
  }

  private read(): LockRecord | "none" | "empty" {
    if (!existsSync(this.dir)) return "none";
    try {
      return JSON.parse(readFileSync(join(this.dir, "holder.json"), "utf8")) as LockRecord;
    } catch {
      return existsSync(this.dir) ? "empty" : "none";
    }
  }

  /**
   * Remove the lock whose holder was judged dead (`judged`: the record that was read, or "empty" for a folder with no holder file).
   * Two waiters can judge the same holder dead; the first to remove it lets a new taker in, and the second must not then remove that
   * live lock. So reclaimers take a small lock of their own for the moment, and look again at what is there before they remove it:
   * only the holder that was judged, and still dead, is removed. (Only reclaimers remove a dead holder's lock, and a taker cannot make
   * the lock while it stands, so nothing changes between the second look and the rename.) A reclaim lock left by a reclaimer that died
   * is itself stale after a few seconds.
   */
  private reclaim(judged: LockRecord | "empty"): void {
    const guard = `${this.dir}.reclaim`;
    try {
      mkdirSync(guard, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST" && statSafe(guard) > RECLAIM_STALE_MS) rmSync(guard, { recursive: true, force: true });
      return; // another reclaimer is at it (or the state folder is not there): the caller looks again
    }
    try {
      const now = this.read();
      if (now === "none") return;
      if (judged === "empty") {
        if (now !== "empty" || statSafe(this.dir) <= HOLDERLESS_STALE_MS) return;
      } else if (now === "empty" || now.pid !== judged.pid || now.since !== judged.since || recordAlive({ pid: now.pid, procStart: now.procStart, bootId: now.bootId })) {
        return; // it is not the holder that was judged any more, or it is alive: someone took the lock after the one that was judged
      }
      const away = `${this.dir}.stale-${process.pid}-${Date.now()}`;
      try {
        renameSync(this.dir, away);
      } catch {
        return;
      }
      rmSync(away, { recursive: true, force: true });
    } finally {
      rmSync(guard, { recursive: true, force: true });
    }
  }
}

function statSafe(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(1, ms));
    signal?.addEventListener("abort", done, { once: true });
  });
}

// ---- A backup copying the bucket ---------------------------------------------------------------------------------

/** The folder in the state folder that holds a marker for each backup that is copying. */
const BACKUP_MARKERS = "lake-backups";

interface BackupMarker { pid: number; procStart: string; bootId: string; since: string }

/**
 * `croft backup` of a lake takes the catalog's dump under croft's lock on the lake's writes, then lets writes go on while it copies the
 * bucket (a slow copy must not hold up runs). A write only adds files, but a maintenance pass deletes them, and the dump names files the
 * pass may free; so while a backup copies, its marker in the state folder keeps this machine's passes, and the deletion of files that are not
 * the lake's own, from running (db/lake-pass.ts, which looks again with the lock held). Each backup has a marker of its own, so one that
 * finishes removes its own and no other; a marker whose process is gone is no marker. Returns what removes it.
 */
export function markBackupRunning(stateDir: string): () => void {
  const id = currentIdentity();
  const dir = join(stateDir, BACKUP_MARKERS);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id.pid}-${randomUUID()}.json`);
  const rec: BackupMarker = { pid: id.pid, procStart: id.procStart, bootId: id.bootId, since: new Date().toISOString() };
  writeFileSync(`${file}.tmp`, JSON.stringify(rec));
  renameSync(`${file}.tmp`, file);
  return () => rmSync(file, { force: true });
}

/** A backup that is copying this lake's bucket now, or null. The markers of processes that are gone are removed on the way. */
export function backupRunning(stateDir: string): { pid: number; since: string } | null {
  const dir = join(stateDir, BACKUP_MARKERS);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    try {
      const rec = JSON.parse(readFileSync(file, "utf8")) as Partial<BackupMarker>;
      if (typeof rec.pid === "number" && typeof rec.procStart === "string" && typeof rec.bootId === "string") {
        if (recordAlive({ pid: rec.pid, procStart: rec.procStart, bootId: rec.bootId })) return { pid: rec.pid, since: String(rec.since ?? "") };
      }
      rmSync(file, { force: true });
    } catch {
      // Being written or removed meanwhile.
    }
  }
  return null;
}
