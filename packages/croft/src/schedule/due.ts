// What is due (DESIGN.md §8 "What counts as due", "What the user experiences"; §6 "The scheduler only runs code a
// human has run"), computed from runs.sqlite, for `croft tick` (schedule/tick.ts), `croft run --due` (the holds its
// plan applies) and what status, `schedule status` and doctor show (scheduleView).
//
// The due set:
// - an ingest whose schedule fired since it was last handled: its latest fire (latestFireAtOrBefore) is after
//   last_fire_at and after the start of its last successful step (a run by hand covers the fires before it). A
//   laptop that slept through 8 hourly fires runs the ingest once: only the latest fire counts;
// - any stale transform (run/staleness.ts over the catalog mirror), even when no ingest is due: `run --only`, an
//   edit run by hand since, or an earlier failure can leave one stale. One whose input was never built waits for
//   that input instead;
// - the stale downstream of a due ingest follows it: the run of the ingest takes it (run/plan.ts), so the tick
//   passes only the ingest, and the view calls the downstream due "after <ingest>".
//
// Held (not started, still due), in this order:
// - paused: scheduling is paused (`croft schedule pause`);
// - SCHEDULE_HELD: the code is not the code a human last ran (approved_code_hash), new assets included. A hash
//   that differs only because croft.json's timezone changed says so, rather than "code edited";
// - LARGE_REPROCESS: a scheduled run met the cost guard, and no person has run the transform since;
// - leased: another run holds it, or a run a tick started has not taken its leases yet (overlaps skip);
// - backoff, one of:
//   - a run a tick started that ended before it started the asset, abnormally: its child died or refused before it
//     recorded the run, it could not be spawned, or the run crashed or was interrupted first. It waits
//     RETRY_BACKOFF_MS, then runs once more; the fire it was for stays due;
//   - a transform whose last attempt failed. A deterministic failure (TYPE_CONFLICT, CHECK_FAILED, an SQL error,
//     ASSET_INVALID: not retryable) waits for a change to its code or inputs; a retryable one (after its own
//     retries), a crash or an interruption waits RETRY_BACKOFF_MS, or the server's longer Retry-After. Never every
//     minute. An ingest needs none of this: it is due again only at its next fire;
//   - a transform whose last step was skipped for an input that is still held (any of the above, SCHEDULE_HELD
//     included, or failed and backed off) and has not changed since: a run would only skip it again. It waits for
//     that input, and is due again once the input changes or is released.
//
// Fires: a tick records the fire a due ingest handles as last_fire_at before it starts the run, and the run (with
// the value it replaced) in the settings row `schedule.spawned`. Once that run has ended, a fire it did not attempt
// (its step never started: another run's lease met after planning, a hold that appeared since, a child that died
// or refused before it recorded the run) is not handled: last_fire_at goes back (the view does so in memory, the
// tick for good), so the fire stays due.
//
// What the scheduler knows of an asset (AssetFacts: kind, schedule, inputs, code hash) is cached in runs.sqlite:
// schedule_state keeps phrase, cron and file_hash, and the settings row `schedule.facts` the rest. The cache key
// (fileHash) covers the asset file and the project time zone, and for a TS asset the size and modification time of
// every file its bundle read (Bun.build's inputs: lib/, helpers anywhere, JSON, code outside the project) and the
// versions of the packages it imports: everything its code hash covers. A tick with nothing changed reads no asset
// code. When a key changes, an SQL asset is parsed again; a TS asset is bundled again, which gives its code hash
// without running it. Only code a human has run (approved_code_hash) is imported, in the tick and in the runs it
// starts (§6): an unapproved TS asset keeps the facts of the last approved code (or, never approved, what its
// text shows: ingest( or transform( and a literal schedule), and is held anyway. An approval (a run by hand)
// imports it on the next tick, with no file change; an approval of other code bundles it again. An import of
// approved code that fails (network code at module scope, a package half installed, a busy machine) keeps the facts
// it had and is tried again after LOAD_RETRY_MS. An asset a run the tick started ended without starting is bundled
// again too, so a key that missed a change cannot keep the tick and the runs it starts disagreeing every minute.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CODES, isCode, problem } from "../core/errors.ts";
import { recordAlive } from "../core/proc.ts";
import { zonedParts } from "../core/time.ts";
import type { AssetKind, Hold, Incremental, Problem, Reason } from "../core/types.ts";
import type { CatalogAsset } from "../history/catalog.ts";
import { RUNS_DB_FILE, RunsDb, type ScheduleStateRow, type StepRecord } from "../history/runs-db.ts";
import type { ResolvedAsset } from "../project/resolve.ts";
import { loadProject, type Project } from "../project/root.ts";
import type { DuePlanning, StepKind } from "../run/plan.ts";
import { staleReasons } from "../run/staleness.ts";
import type { SchedulingSetting } from "./os.ts";
import { latestFireAtOrBefore, nextFires, parseSchedule, type Schedule } from "./types.ts";

export type HoldCode = "SCHEDULE_HELD" | "LARGE_REPROCESS" | "paused" | "leased" | "backoff";

/** One asset as the scheduler sees it. Instants are ISO-8601 UTC. */
export interface AssetScheduleView {
  asset: string;
  kind: "ingest" | "sql" | "ts";
  /** Ingests with a schedule. */
  schedule: Schedule | null;
  /** The next fire after now (ingests with a schedule). */
  nextFireAt: string | null;
  lastFireAt: string | null;
  lastAttemptAt: string | null;
  /** Due now: a fire not yet handled, or a stale transform. */
  due: boolean;
  /** Why it is due, in words ("fired at 11:00", "stale: input issues changed"). */
  dueReason: string | null;
  /** Why the scheduler will not run it now, or null. */
  held: { code: HoldCode; reason: string } | null;
}

export interface ScheduleViewInput {
  root: string;
  now: Date;
  /** The project as the caller already resolved it (status does): its facts are taken from here, so nothing is
   *  imported again. */
  resolved?: readonly ResolvedAsset[];
}

/** Every asset as the scheduler sees it now. Read-only: it never writes runs.sqlite (the tick refreshes the
 *  cache), and it imports only assets whose facts changed since the last tick, unless `resolved` is given. It runs
 *  for a person (status, `schedule status`), so it may import code nobody has run yet, as status does. */
export async function scheduleView(i: ScheduleViewInput): Promise<AssetScheduleView[]> {
  const project = loadProject({ root: i.root });
  const runs = existsSync(join(project.paths.stateDir, RUNS_DB_FILE)) ? RunsDb.open(project.paths.stateDir, { now: () => i.now }) : null;
  try {
    const work = await dueWork({ project, runs, now: i.now, store: false, importUnapproved: true, ...(i.resolved ? { resolved: i.resolved } : {}) });
    return work.views;
  } finally {
    runs?.close();
  }
}

// ---------------------------------------------------------------------------------------------------------
// Facts: what the scheduler knows of an asset

/** The settings row that caches AssetFacts by asset. */
export const FACTS_SETTING = "schedule.facts";
/** The settings row listing the runs ticks started whose end was not looked at yet: SpawnedRun[]. */
export const SPAWNED_SETTING = "schedule.spawned";
/** The settings row listing runs a tick started that ended before they started some of their assets: FailedStart[]. */
export const FAILED_STARTS_SETTING = "schedule.failedStarts";
/** How long a transform waits after a retryable failure, a crash or an interruption before the scheduler tries
 *  it again (a server's longer Retry-After wins), and how long assets wait after a run a tick started failed to
 *  start them. */
export const RETRY_BACKOFF_MS = 15 * 60_000;
/** How long the scheduler waits before it imports approved code again whose import failed. */
export const LOAD_RETRY_MS = 5 * 60_000;
/** A run a tick has just started may not have written its handshake yet. */
const SPAWN_GRACE_MS = 10_000;

export interface AssetFacts {
  asset: string;
  /** Root-relative. */
  file: string;
  kind: "ingest" | "sql" | "ts" | null;
  /** keyOf(): what the cache is keyed by. */
  fileHash: string;
  schedule: Schedule | null;
  /** The assets it reads (transforms). */
  inputs: string[];
  /** The code hash (includes the project time zone); null when the code does not parse or bundle. */
  codeHash: string | null;
  /** An incremental TS transform (newRows()): forward-only, so an edit is no reason to run it. */
  incremental: boolean;
  /** Loaded with no error (or, not imported, it bundles). */
  ok: boolean;
  /** The project time zone the facts were read in. */
  timezone?: string;
  /** TS assets: every file its bundle read, root-relative, the asset first. */
  files?: string[];
  /** TS assets: the packages its bundle imports, with their installed versions. */
  packages?: Record<string, string | null>;
  /** The code hash whose import gave kind, schedule, inputs and incremental. It differs from codeHash while the
   *  current code is not approved (the scheduler does not import it: those are the facts of the last code it
   *  imported, or what the file's text shows); null when no code of this asset was imported. */
  readFrom?: string | null;
  /** The import of the (approved) code failed at this instant: it is imported again after LOAD_RETRY_MS. */
  failedAt?: string;
  /** Why that import failed. */
  failure?: Problem;
  /** approved_code_hash when the facts were read: an approval since makes the scheduler look again. */
  approved?: string | null;
  /** The code hash differs from approved_code_hash only because croft.json's timezone changed. */
  timeZoneChanged?: { from: string; to: string };
  /** The file defines no asset (a name the naming rules refuse): not looked at again until it changes. */
  notAsset?: boolean;
}

/** What importing an asset tells the scheduler: ResolvedAsset has all of it. */
export interface ImportedAsset {
  name: string;
  file: string;
  kind: AssetKind | null;
  /** false: resolveProject did not import it (ResolvedAsset.loaded). */
  loaded?: boolean;
  ok: boolean;
  inputs: string[];
  incremental: Incremental;
  schedule?: Schedule;
  codeHash?: string;
  timeZoneChanged?: { from: string; to: string };
  problems: Problem[];
  ts?: { localFiles: string[]; packages: Record<string, string | null> };
}

/** Imports `names` (SQL assets whose file changed, TS assets whose code is approved) and returns what each
 *  declares. An asset it cannot find (a name the naming rules refuse) is left out. */
export type FactsResolver = (i: { root: string; timezone: string; names: readonly string[] }) => Promise<ImportedAsset[]>;

const NONE: Incremental = { kind: "none" };

/** The default resolver: each named asset loaded on its own (project/sql-asset.ts, project/ts-asset.ts), never the
 *  whole project, which would import every TS transform. Loaded only when something changed. */
export const resolveAssets: FactsResolver = async (i) => {
  const { discoverAssets } = await import("../project/discover.ts");
  const discovery = await discoverAssets(i.root);
  const wanted = new Set(i.names);
  const assets = discovery.assets.filter((a) => wanted.has(a.name));
  const names = discovery.assets.map((a) => a.name);
  const out: ImportedAsset[] = [];
  const sql = assets.filter((a) => a.kind === "sql");
  if (sql.length > 0) {
    const [{ openMemory }, { loadSqlAsset }] = await Promise.all([import("../db/connect.ts"), import("../project/sql-asset.ts")]);
    const memory = await openMemory({ timezone: i.timezone });
    try {
      const conn = await memory.connect();
      for (const a of sql) {
        const s = await loadSqlAsset(a, { root: i.root, timezone: i.timezone, conn, assetNames: names });
        out.push({
          name: a.name, file: a.file, kind: "sql", ok: s.ok, inputs: [...s.astInputs], incremental: NONE,
          ...(s.codeHash ? { codeHash: s.codeHash } : {}), problems: s.problems,
        });
      }
    } finally {
      memory.close();
    }
  }
  const ts = assets.filter((a) => a.kind === "ts");
  if (ts.length > 0) {
    const { loadTsAsset } = await import("../project/ts-asset.ts");
    for (const a of ts) {
      const t = await loadTsAsset(a, { root: i.root, timezone: i.timezone });
      const spec = t.ok ? t.spec : undefined;
      const parsed = spec?.schedule !== undefined ? parseSchedule(spec.schedule) : null;
      out.push({
        name: a.name, file: a.file, kind: spec ? (spec.role === "transform" ? "ts" : "ingest") : sniff(a.path).kind, ok: t.ok,
        inputs: spec?.role === "transform" ? [...spec.inputs] : [], incremental: spec?.incremental ?? NONE,
        ...(parsed?.ok ? { schedule: parsed.schedule } : {}), ...(t.codeHash ? { codeHash: t.codeHash } : {}),
        problems: t.problems, ts: { localFiles: t.localFiles, packages: t.packages },
      });
    }
  }
  return out;
};

/** An asset file found in assets/ (the naming rules' pattern; NAME_RESERVED is discovery's to apply). */
interface AssetFile { name: string; file: string; path: string; sql: boolean }

const NAME = /^[a-z][a-z0-9_]*$/;

function listAssetFiles(root: string, assetsDir: string): AssetFile[] {
  if (!existsSync(assetsDir)) return [];
  const byName = new Map<string, AssetFile[]>();
  for (const rel of new Bun.Glob("**/*.{ts,sql}").scanSync({ cwd: assetsDir, onlyFiles: true })) {
    if (rel.endsWith(".d.ts")) continue;
    const base = rel.split("/").pop()!;
    const sql = base.endsWith(".sql");
    const name = base.slice(0, base.length - (sql ? 4 : 3));
    if (!NAME.test(name)) continue;
    const path = join(assetsDir, rel);
    const list = byName.get(name) ?? [];
    list.push({ name, file: relPath(root, path), path, sql });
    byName.set(name, list);
  }
  // Two files for one name (NAME_CONFLICT) define no asset.
  return [...byName.values()].filter((l) => l.length === 1).map((l) => l[0]!).sort((a, b) => (a.name < b.name ? -1 : 1));
}

const relPath = (root: string, path: string) => relative(root, path).split(sep).join("/");

/** The installed version of a package, as ts-asset.ts packageVersions finds it (walking up node_modules). */
function installedVersion(name: string, from: string): string | null {
  for (let cur = dirname(from); ; cur = dirname(cur)) {
    const pkg = join(cur, "node_modules", name, "package.json");
    if (existsSync(pkg)) {
      try {
        const v = (JSON.parse(readFileSync(pkg, "utf8")) as { version?: unknown }).version;
        return typeof v === "string" ? v : null;
      } catch {
        return null;
      }
    }
    if (dirname(cur) === cur) return null;
  }
}

/**
 * The cache key of an asset's facts (see the top of this file): the asset file's bytes and the time zone, and for a
 * TS asset the size and modification time of every other file its bundle read and the installed versions of the
 * packages it imports. "" when the file cannot be read.
 */
export function keyOf(root: string, path: string, timezone: string, deps: { files?: readonly string[]; packages?: Record<string, string | null> } | null): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return "";
  }
  const h = createHash("sha256").update(bytes).update("\0").update(timezone);
  if (deps) {
    for (const rel of [...new Set(deps.files ?? [])].sort()) {
      const abs = resolve(root, rel);
      if (abs === path) continue;
      let stamp = "gone";
      try {
        const st = statSync(abs);
        stamp = `${st.size}:${st.mtimeMs}`;
      } catch {
        // Gone: its absence is the stamp.
      }
      h.update("\0").update(`${rel}:${stamp}`);
    }
    for (const name of Object.keys(deps.packages ?? {}).sort()) h.update("\0").update(`${name}@${installedVersion(name, path) ?? "-"}`);
  }
  return h.digest("hex");
}

/** What an asset's text shows without running it: ingest( or transform( (as resolve.ts sniffKind reads it), and an
 *  ingest's schedule when it is a plain string. */
function sniff(path: string): { kind: "ingest" | "ts" | null; schedule: Schedule | null } {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { kind: null, schedule: null };
  }
  const t = /\btransform\s*\(/.test(text);
  const i = /\bingest\s*\(/.test(text);
  const kind = t && !i ? "ts" : i && !t ? "ingest" : null;
  let schedule: Schedule | null = null;
  const m = kind === "ingest" ? /\bschedule\s*:\s*(["'`])((?:\\.|(?!\1)[^\\\r\n])*)\1/.exec(text) : null;
  if (m && !m[2]!.includes("${")) {
    const parsed = parseSchedule(m[2]!);
    if (parsed.ok) schedule = parsed.schedule;
  }
  return { kind, schedule };
}

/** A TS asset bundled, not run: its code hash, in any zone, and what the cache key covers. */
interface Bundled {
  /** The code hash in a zone; null when it does not bundle. */
  hashIn: ((timezone: string) => string) | null;
  files: string[];
  packages: Record<string, string | null>;
}

/** Bundle a TS asset as its fingerprint does (project/ts-asset.ts), and list every file the bundle read. The code
 *  hash in the project zone is tsFingerprint's, the one a run computes, so the tick and the runs it starts agree. */
async function bundle(root: string, path: string, timezone: string): Promise<Bundled> {
  const ts = await import("../project/ts-asset.ts");
  const b = await ts.bundleTs(path);
  const files = new Set<string>([relPath(root, path)]);
  // Bun.build's own inputs (anything the bundle includes, wherever it is), and the import scan's (JSON and the
  // other files it follows, also when the bundle fails).
  for (const f of (b as { inputs?: string[] }).inputs ?? await bundleInputs(path)) files.add(relPath(root, f));
  try {
    for (const f of ts.scanImportGraph(path, root).files) files.add(relPath(root, f));
  } catch {
    // The bundle's inputs stand.
  }
  if (!b.ok) return { hashIn: null, files: [...files], packages: {} };
  let current: string;
  try {
    current = await ts.tsFingerprint(path, { root, timezone });
  } catch {
    return { hashIn: null, files: [...files], packages: {} };
  }
  const packages = ts.packageVersions(b.imports, path);
  const code = ts.normalizeBundle(b.code, path);
  // In another zone (a time zone change): the same fingerprint of the same bundle.
  return { hashIn: (z) => (z === timezone ? current : ts.fingerprintOf(code, packages, z)), files: [...files], packages };
}

/** The files a bundle of `path` reads (Bun.build's metafile inputs), absolute. */
async function bundleInputs(path: string): Promise<string[]> {
  try {
    const config = { entrypoints: [path], packages: "external", target: "bun", format: "esm", throw: false, metafile: true };
    const r = await Bun.build(config as unknown as Parameters<typeof Bun.build>[0]);
    const inputs = (r as { metafile?: { inputs?: Record<string, unknown> } }).metafile?.inputs ?? {};
    return Object.keys(inputs).map((k) => resolve(process.cwd(), k)).filter((f) => {
      try {
        return statSync(f).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/** An SQL asset's code hash in another zone (it parses the file again), or null. */
async function sqlHashIn(root: string, a: AssetFile, zones: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (zones.length === 0) return out;
  try {
    const [{ openMemory }, { loadSqlAsset }] = await Promise.all([import("../db/connect.ts"), import("../project/sql-asset.ts")]);
    const memory = await openMemory({ timezone: zones[0]! });
    try {
      const conn = await memory.connect();
      for (const z of zones) {
        const s = await loadSqlAsset({ name: a.name, file: a.file, path: a.path }, { root, timezone: z, conn, assetNames: [] });
        if (s.codeHash) out.set(z, s.codeHash);
      }
    } finally {
      memory.close();
    }
  } catch {
    // Nothing is claimed.
  }
  return out;
}

/** The zones the approved code may have been hashed in: the ones earlier facts were read in. */
function zonesBefore(prev: AssetFacts | undefined, timezone: string): string[] {
  return [...new Set([prev?.timeZoneChanged?.from, prev?.timezone].filter((z): z is string => typeof z === "string" && z !== timezone))];
}

interface FactsOutcome { facts: AssetFacts[]; imported: boolean; problems: Problem[] }

/**
 * The facts of every asset, from the cache where its key is unchanged (see the top of this file); the others are
 * read again and, with `store`, cached again. `resolved` (a caller that already resolved the project) replaces the
 * import.
 */
async function loadFacts(o: {
  project: Project; runs: RunsDb | null; now: Date; store: boolean; resolve: FactsResolver; resolved?: readonly ImportedAsset[];
  importUnapproved: boolean;
  /** TS assets to bundle again whatever their key says: a run the tick started ended without starting them, which
   *  a code hash the key failed to refresh would explain (the run found them held); never twice for one run. */
  recheck: ReadonlySet<string>;
}): Promise<FactsOutcome> {
  const { project, now } = o;
  const { root, timezone } = project;
  const files = listAssetFiles(root, project.paths.assetsDir);
  const cached = o.runs?.getSetting<Record<string, AssetFacts>>(FACTS_SETTING) ?? {};
  const state = new Map((o.runs?.allScheduleState() ?? []).map((s) => [s.asset, s]));
  const approvedOf = (name: string) => state.get(name)?.approvedCodeHash ?? null;
  const previous = (name: string): AssetFacts | undefined => (Object.hasOwn(cached, name) ? cached[name] : undefined);
  const resolvedBy = new Map((o.resolved ?? []).filter((a) => a.loaded !== false).map((a) => [a.name, a]));

  const out = new Map<string, AssetFacts>();
  const fresh: AssetFacts[] = [];
  const set = (f: AssetFacts) => {
    out.set(f.asset, f);
    fresh.push(f);
  };
  const problems: Problem[] = [];
  let imported = false;

  // 1. What is current, and what must be read again: TS assets to bundle, assets to import.
  const toBundle: AssetFile[] = [];
  const toImport = new Map<string, { file: AssetFile; key: string; bundled?: Bundled; deps?: Pick<AssetFacts, "files" | "packages"> }>();
  for (const f of files) {
    const prev = previous(f.name);
    const approved = approvedOf(f.name);
    const r = resolvedBy.get(f.name);
    if (r) {
      const deps = f.sql ? null : { files: r.ts?.localFiles ?? [f.file], packages: r.ts?.packages ?? {} };
      out.set(f.name, factsOf(r, f, keyOf(root, f.path, timezone, deps), timezone, approved, deps));
      continue;
    }
    const key = keyOf(root, f.path, timezone, f.sql ? null : { files: prev?.files ?? [f.file], packages: prev?.packages ?? {} });
    if (!key) continue;
    const current = prev && prev.fileHash === key && state.get(f.name)?.fileHash === key ? prev : undefined;
    if (!current) {
      if (f.sql) toImport.set(f.name, { file: f, key });
      else toBundle.push(f);
      continue;
    }
    if (f.sql || current.notAsset) {
      out.set(f.name, current);
      continue;
    }
    if (o.recheck.has(f.name)) {
      toBundle.push(f);
      continue;
    }
    const code = current.codeHash;
    const approvedNow = code !== null && code === approved;
    const job = { file: f, key, deps: { files: current.files ?? [f.file], packages: current.packages ?? {} } };
    // An import that failed is tried again after LOAD_RETRY_MS, not before.
    const failed = !current.ok && typeof current.failedAt === "string";
    const retry = failed && now.getTime() >= Date.parse(current.failedAt!) + LOAD_RETRY_MS;
    if (approvedNow && (failed ? retry : current.readFrom !== code)) {
      // Run by hand since the facts were read (with no file change): its code may be imported now.
      toImport.set(f.name, job);
    } else if (o.importUnapproved && code !== null && current.readFrom !== code) {
      toImport.set(f.name, job);
    } else if (!approvedNow && (current.approved ?? null) !== approved) {
      // Approved since, and still not this code: bundle it again, in case something the key does not cover moved.
      toBundle.push(f);
    } else {
      out.set(f.name, current);
    }
  }

  // Which files are assets at all (a name the naming rules refuse is not), asked only when something changed.
  let valid: Set<string> | null = null;
  const isAsset = async (name: string): Promise<boolean> => {
    if (!valid) {
      try {
        const { discoverAssets } = await import("../project/discover.ts");
        valid = new Set((await discoverAssets(root, { assetsDir: project.paths.assetsDir })).assets.map((a) => a.name));
      } catch {
        valid = new Set(files.map((f) => f.name));
      }
    }
    return valid.has(name);
  };
  const notAsset = (f: AssetFile, key: string): AssetFacts => ({
    asset: f.name, file: f.file, kind: null, fileHash: key, schedule: null, inputs: [], codeHash: null, incremental: false, ok: false, timezone, readFrom: null,
    notAsset: true,
  });

  // 2. TS assets whose key changed: bundled, never run. Approved code is imported; other code keeps the facts it had.
  for (const f of toBundle) {
    const prev = previous(f.name);
    const approved = approvedOf(f.name);
    if (!(await isAsset(f.name))) {
      set(notAsset(f, keyOf(root, f.path, timezone, null)));
      continue;
    }
    const b = await bundle(root, f.path, timezone);
    const key = keyOf(root, f.path, timezone, { files: b.files, packages: b.packages });
    const code = b.hashIn ? b.hashIn(timezone) : null;
    const base = { files: b.files, packages: b.packages, fileHash: key, codeHash: code, approved, timezone };
    if (code !== null && prev?.readFrom === code && prev.kind !== null && (prev.ok || !prev.failedAt || now.getTime() < Date.parse(prev.failedAt) + LOAD_RETRY_MS)) {
      // The same code as the facts were read from (a comment edited, say): nothing to import.
      const { timeZoneChanged: _was, ...same } = prev;
      set({ ...same, ...base, ...tzShift(b, prev, timezone, approved, code) });
    } else if (code !== null && (code === approved || o.importUnapproved)) {
      toImport.set(f.name, { file: f, key, bundled: b, deps: { files: b.files, packages: b.packages } });
    } else {
      set({ ...carried(prev, f), ...base, ok: code !== null, ...tzShift(b, prev, timezone, approved, code) });
    }
  }

  // 3. The imports.
  if (toImport.size > 0) {
    const names = [...toImport.keys()];
    const wanted: string[] = [];
    for (const n of names) {
      if (await isAsset(n)) wanted.push(n);
      else set(notAsset(toImport.get(n)!.file, toImport.get(n)!.key));
    }
    let got: ImportedAsset[] = [];
    try {
      got = wanted.length ? await o.resolve({ root, timezone, names: wanted }) : [];
      imported = got.length > 0;
    } catch (e) {
      const p = (e as { problem?: Problem }).problem;
      problems.push({
        ...(p ?? problem("INTERNAL_ERROR", { message: String((e as Error)?.message ?? e), hint: "report this croft bug" })),
        severity: "warning",
        message: `the scheduler could not read ${wanted.join(", ")}: ${p?.message ?? String((e as Error)?.message ?? e)}`,
        effect: "those assets are not scheduled until they load again",
      });
      got = [];
      for (const n of wanted) toImport.delete(n);
    }
    const byName = new Map(got.map((a) => [a.name, a]));
    for (const n of wanted) {
      const job = toImport.get(n);
      if (!job) continue;
      const f = job.file;
      const a = byName.get(n);
      const prev = previous(n);
      const approved = approvedOf(n);
      if (!a) {
        // A file that is no asset after all is remembered as such, so it is not looked at again until it changes.
        set(notAsset(f, job.key));
        continue;
      }
      // What the key covers: the bundle's inputs (the import scan's files too), and the packages it imports.
      const deps = f.sql ? null : {
        files: [...new Set([...(job.deps?.files ?? [f.file]), ...(a.ts?.localFiles ?? [])])], packages: job.deps?.packages ?? a.ts?.packages ?? {},
      };
      const key = f.sql ? job.key : keyOf(root, f.path, timezone, deps);
      let facts = factsOf(a, f, key, timezone, approved, deps);
      const code = a.codeHash ?? job.bundled?.hashIn?.(timezone) ?? null;
      if (!f.sql && !a.ok && approved !== null && code === approved) {
        // Approved code that did not import this time (network code at module scope, a package half installed, a
        // timeout): the facts it had stand, and it is imported again after LOAD_RETRY_MS.
        const failure = a.problems.find((p) => p.severity === "error") ?? a.problems[0];
        facts = {
          ...carried(prev, f), ...(deps ?? {}), fileHash: key, codeHash: code, ok: false, timezone, approved,
          failedAt: now.toISOString(), ...(failure ? { failure } : {}),
        };
        const retry = clockWords(new Date(now.getTime() + LOAD_RETRY_MS), timezone, now);
        problems.push({
          ...(failure ?? problem("ASSET_INVALID", { message: `${f.file} did not load`, hint: `croft validate ${n} shows why` })),
          severity: "warning", asset: n,
          message: `the scheduler could not load ${n}: ${failure?.message ?? "it did not load"}`,
          effect: `the scheduler keeps what it knew of ${n} and tries again after ${retry}`,
        });
      } else if (facts.codeHash !== approved && !facts.timeZoneChanged) {
        if (prev?.timeZoneChanged && prev.codeHash === facts.codeHash && (prev.approved ?? null) === approved) {
          // The same code and the same approval as when it was found.
          facts = { ...facts, timeZoneChanged: prev.timeZoneChanged };
        } else {
          const zones = zonesBefore(prev, timezone);
          const hashIn = zones.length === 0 ? null : f.sql
            ? await (async () => {
                const m = await sqlHashIn(root, f, zones);
                return (z: string) => m.get(z) ?? "";
              })()
            : (job.bundled ?? await bundle(root, f.path, timezone)).hashIn;
          facts = { ...facts, ...tzShift({ hashIn }, prev, timezone, approved, facts.codeHash) };
        }
      }
      set(facts);
    }
  }

  // A file that no longer loads keeps the schedule it had, so it stays scheduled, and held (its code changed).
  for (const f of fresh) {
    const prev = state.get(f.asset);
    if (!f.ok && !f.schedule && prev?.cron) f.schedule = { text: prev.phrase ?? prev.cron, cron: prev.cron };
  }

  if (o.store && o.runs && fresh.length > 0) {
    const runs = o.runs;
    const keep: Record<string, AssetFacts> = {};
    for (const [name, f] of out) keep[name] = f;
    runs.transaction(() => {
      runs.setSetting(FACTS_SETTING, keep);
      for (const f of fresh) {
        runs.putScheduleState(f.asset, {
          fileHash: f.fileHash, ...(f.schedule ? { phrase: f.schedule.text, cron: f.schedule.cron } : f.ok ? { phrase: null, cron: null } : {}),
        });
      }
    });
  }
  return { facts: [...out.values()].sort((a, b) => (a.asset < b.asset ? -1 : 1)), imported, problems };
}

/** The facts an import gave. */
function factsOf(a: ImportedAsset, f: AssetFile, key: string, timezone: string, approved: string | null,
  deps: { files: string[]; packages: Record<string, string | null> } | null): AssetFacts {
  const code = a.codeHash ?? null;
  return {
    asset: a.name, file: f.file, kind: a.kind, fileHash: key, schedule: a.schedule ?? null, inputs: [...a.inputs], codeHash: code,
    incremental: a.incremental.kind === "new-rows", ok: a.ok, timezone, ...(deps ?? {}), readFrom: code, approved,
    ...(a.timeZoneChanged && code !== approved ? { timeZoneChanged: a.timeZoneChanged } : {}),
  };
}

/** What the scheduler keeps of an asset whose current code it does not import: the facts of the code it last
 *  imported, or, with none, what the file's text shows. */
function carried(prev: AssetFacts | undefined, f: AssetFile): Pick<AssetFacts, "asset" | "file" | "kind" | "schedule" | "inputs" | "incremental" | "readFrom"> {
  if (prev && prev.kind !== null && prev.readFrom) {
    return { asset: f.name, file: f.file, kind: prev.kind, schedule: prev.schedule, inputs: [...prev.inputs], incremental: prev.incremental, readFrom: prev.readFrom };
  }
  const s = sniff(f.path);
  return { asset: f.name, file: f.file, kind: s.kind, schedule: s.schedule, inputs: prev?.inputs ?? [], incremental: false, readFrom: null };
}

/** timeZoneChanged when the code, hashed in a zone the approved code may have been hashed in, is the approved
 *  code (resolve.ts does the same against the built hash). */
function tzShift(b: { hashIn: ((timezone: string) => string) | null }, prev: AssetFacts | undefined, timezone: string, approved: string | null,
  code: string | null): { timeZoneChanged?: { from: string; to: string } } {
  if (!b.hashIn || code === null || approved === null || code === approved) return {};
  const from = zonesBefore(prev, timezone).find((z) => b.hashIn!(z) === approved);
  return from ? { timeZoneChanged: { from, to: timezone } } : {};
}

// ---------------------------------------------------------------------------------------------------------
// The due set

/** Fire times (schedule/types.ts by default; tests inject their own). */
export interface FireTimes {
  /** The latest fire at or before `now`, or null. */
  latest(cron: string, timeZone: string, now: Date): Date | null;
  /** The first fire strictly after `after`, or null. */
  next(cron: string, timeZone: string, after: Date): Date | null;
}

export const defaultFires: FireTimes = {
  latest: (cron, tz, now) => latestFireAtOrBefore(cron, tz, now),
  next: (cron, tz, after) => nextFires(cron, tz, after, 1)[0] ?? null,
};

/** The fires after `handled` up to `now` (at most MAX_MISSED): what a catch-up run covers at once. */
const MAX_MISSED = 50;
function missedFires(fires: FireTimes, cron: string, tz: string, handled: Date, now: Date): number {
  let n = 0;
  for (let at = handled; n < MAX_MISSED; n++) {
    const next = fires.next(cron, tz, at);
    if (!next || next > now) break;
    at = next;
  }
  return n;
}

export interface DueInput {
  project: Project;
  /** null: the project has no runs.sqlite yet (nothing ran, nothing approved). */
  runs: RunsDb | null;
  now: Date;
  /** Write refreshed facts to runs.sqlite (the tick). */
  store: boolean;
  /** Import code nobody has run by hand (a person asked: status, `schedule status`). Never in the tick. */
  importUnapproved?: boolean;
  resolve?: FactsResolver;
  resolved?: readonly ImportedAsset[];
  fires?: FireTimes;
  /** Whether a recorded process still runs (core/proc.ts recordAlive). */
  alive?: Alive;
}

export type Alive = (r: { pid: number | null; procStart: string | null; bootId: string | null }) => boolean;

export interface HeldAsset { asset: string; code: HoldCode; reason: string }

export interface DueWork {
  views: AssetScheduleView[];
  /** The due assets nothing holds, one group per run to start: the ingests that fired and the stale transforms, in
   *  groups the graph connects (through anything that reads or is read, shared inputs included), so N stale
   *  readers of one input are one run, and two runs never want the same asset. */
  groups: string[][];
  /** The fire each due ingest handles (ISO-8601 UTC): its last_fire_at once its run starts. */
  fires: Map<string, string>;
  /** Due assets the scheduler skips, and why. */
  held: HeldAsset[];
  /** Whether asset files were read (imported or parsed) to refresh the facts. */
  imported: boolean;
  /** Runs earlier ticks started that are still starting or running. */
  inFlight: SpawnedRun[];
  /** Runs earlier ticks started that ended before they started some of their assets, abnormally, and are waited
   *  out (RETRY_BACKOFF_MS): the ones found just now (`fresh`) and the ones still waited out. */
  failedStarts: FailedStart[];
  /** Fires the runs that ended did not attempt: last_fire_at goes back to `to`, so the fire stays due. */
  rollbacks: { asset: string; from: string; to: string | null }[];
  problems: Problem[];
}

/** A run a tick started (the settings row SPAWNED_SETTING). */
export interface SpawnedRun {
  runId: string;
  assets: string[];
  /** When the tick started it (ISO-8601 UTC). */
  at?: string;
  /** The fire each due ingest of it handles, and the last_fire_at it replaced. */
  fires?: Record<string, { fire: string; before: string | null }>;
}

/** A run a tick started that ended before it started `assets` (the settings row FAILED_STARTS_SETTING). */
export interface FailedStart {
  runId: string;
  assets: string[];
  /** When it was started (the backoff runs from here). */
  at: string;
  /** Why, in words: "its process ended before it recorded the run". */
  reason: string;
  /** Its child never recorded the run (nothing else reports it: the tick notifies). */
  unrecorded: boolean;
  /** The child's own refusal, when it left one. */
  problem?: Problem;
  /** Found by this look (not yet reported). */
  fresh?: boolean;
}

/** What runs.sqlite says about one asset's history, read once per asset. */
interface History {
  state: ScheduleStateRow | null;
  latest: (StepRecord & { human: boolean }) | null;
  /** Start of the latest ok or unchanged step, by any run. */
  lastOk: string | null;
  /** A scheduled run met the cost guard after the latest successful run by hand. */
  reprocess: Problem | null;
}

function historyOf(runs: RunsDb | null, asset: string): History {
  if (!runs) return { state: null, latest: null, lastOk: null, reprocess: null };
  const latest = runs.latestStep(asset);
  const lastOk = (runs.sqlite.query(`SELECT max(started_at) AS t FROM steps WHERE asset = ? AND status IN ('ok', 'unchanged')`)
    .get(asset) as { t: string | null } | null)?.t ?? null;
  const guard = runs.sqlite.query(`SELECT s.started_at AS t, s.error AS error FROM steps s JOIN runs r ON r.id = s.run_id
      WHERE s.asset = ? AND r.human = 0 AND json_extract(s.error, '$.code') = ? ORDER BY s.started_at DESC LIMIT 1`)
    .get(asset, "LARGE_REPROCESS") as { t: string; error: string } | null;
  let reprocess: Problem | null = null;
  if (guard) {
    const humanOk = (runs.sqlite.query(`SELECT max(s.started_at) AS t FROM steps s JOIN runs r ON r.id = s.run_id
        WHERE s.asset = ? AND r.human = 1 AND s.status IN ('ok', 'unchanged')`).get(asset) as { t: string | null } | null)?.t ?? null;
    if (humanOk === null || humanOk < guard.t) {
      try {
        reprocess = JSON.parse(guard.error) as Problem;
      } catch {
        reprocess = null;
      }
    }
  }
  return {
    state: runs.scheduleState(asset),
    latest: latest ? { ...latest, human: runs.getRun(latest.runId)?.human ?? true } : null,
    lastOk, reprocess,
  };
}

/** isRetryable (run/ingest.ts) without importing the ingest pipeline: a retryable problem that is no coordination
 *  refusal and no project error. */
function retryable(p: Problem | null): boolean {
  if (!p || !isCode(p.code)) return false;
  if (["INTERRUPTED", "ASSET_BUSY", "SHRINK_GUARD", "CONFIRMATION_STALE", "CONFIRMATION_REQUIRED"].includes(p.code)) return false;
  if (CODES[p.code].category === "project") return false;
  return p.retryable === true;
}

const FAILED = new Set(["failed", "crashed", "interrupted"]);

/** "12 min", "3 h", "2 days". */
export function ago(fromMs: number, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - fromMs) / 1000));
  if (s < 90) return `${s} s`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} days`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number) => String(n).padStart(2, "0");

/** A time in the project zone: "11:00" today, "Sep 21 11:00" otherwise. */
export function clockWords(at: Date, timezone: string, now: Date): string {
  const p = zonedParts(at, timezone);
  const n = zonedParts(now, timezone);
  const clock = `${pad2(p.hour)}:${pad2(p.minute)}`;
  return p.year === n.year && p.month === n.month && p.day === n.day ? clock : `${MONTHS[p.month - 1]} ${p.day} ${clock}`;
}

/** SCHEDULE_HELD (§6): the asset's code is not the code a human last ran. The reason is what status shows. A hash
 *  that moved only with croft.json's timezone is said as such (§8), not as an edit. */
export function scheduleHeld(o: {
  asset: string; file: string; approved: string | null; editedAt: number | null; loads: boolean; now: Date;
  timeZoneChanged?: { from: string; to: string } | null;
}): { reason: string; problem: Problem } {
  const run = `croft run ${o.asset}`;
  const zone = o.approved !== null && o.loads && o.timeZoneChanged ? o.timeZoneChanged : null;
  const edited = `${o.approved === null ? "new: " : ""}code edited${o.editedAt !== null ? ` ${ago(o.editedAt, o.now)} ago` : ""}`;
  const reason = zone
    ? `the project time zone changed (${zone.from} → ${zone.to}) since it was last run by hand; ${run} releases it`
    : o.loads
      ? `${edited}, not run by hand yet; ${run} releases it`
      : `${edited} and it does not load; fix it, then ${run} releases it`;
  const p = problem("SCHEDULE_HELD", {
    asset: o.asset, file: o.file,
    message: `${o.asset} is held from the scheduler: ${o.approved === null ? "it has never been run by hand"
      : zone ? `the project time zone changed (${zone.from} → ${zone.to}) since it was last run by hand` : "its code changed since it was last run by hand"}`,
    hint: `the scheduler only runs code a person has run; check the change, then ${run} (a run from a terminal or Claude Code) releases it`,
    effect: "scheduled runs skip it, and it stays due",
    fix: { kind: "command", description: `run ${o.asset} by hand once`, command: run },
    details: {
      approvedCodeHash: o.approved,
      ...(zone ? { timeZoneChanged: zone } : o.editedAt !== null ? { editedAt: new Date(o.editedAt).toISOString() } : {}),
    },
  });
  // A hold is the scheduler's news, not a failure of the run that skips the asset.
  return { reason, problem: { ...p, severity: "warning" } };
}

function editedAt(root: string, file: string): number | null {
  try {
    return statSync(join(root, file)).mtimeMs;
  } catch {
    return null;
  }
}

/** Why a stale transform is stale, in words. */
function staleWords(reasons: readonly Reason[], changed: readonly string[]): string {
  if (reasons.includes("never_built")) return "stale: never built";
  const parts: string[] = [];
  if (reasons.includes("code_changed")) parts.push("code changed");
  if (changed.length) parts.push(`input ${changed.join(", ")} changed`);
  if (reasons.includes("input_replaced")) parts.push("an input was replaced");
  return `stale: ${parts.join("; ") || "an input changed"}`;
}

const isoOf = (d: Date) => d.toISOString();
const later = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : a > b ? a : b);

/** Compute the views, the due groups and what is held (see the top of this file). */
export async function dueWork(i: DueInput): Promise<DueWork> {
  const { project, runs, now } = i;
  const tz = project.timezone;
  const fires = i.fires ?? defaultFires;
  const alive = i.alive ?? recordAlive;
  // Runs earlier ticks started: those still starting or running, and how the others ended (the fires they did not
  // attempt go back; the ones that failed to start their assets are waited out; what they did not start is looked at
  // again).
  const spawned = runs ? endedRuns(runs, project.paths.stateDir, alive, now) : { inFlight: [], rollbacks: [], failed: [], unstarted: [] };
  const loaded = await loadFacts({
    project, runs, now, store: i.store, resolve: i.resolve ?? resolveAssets, importUnapproved: i.importUnapproved ?? false,
    recheck: new Set(spawned.unstarted), ...(i.resolved ? { resolved: i.resolved } : {}),
  });
  const problems = [...loaded.problems];
  const facts = loaded.facts.filter((f) => f.kind !== null);
  const byName = new Map(facts.map((f) => [f.asset, f]));
  const byLower = new Map(facts.map((f) => [f.asset.toLowerCase(), f.asset]));
  const assetOf = (n: string) => byLower.get(n.toLowerCase());
  const catalog = new Map((runs?.catalogAll<CatalogAsset>() ?? []).map((e) => [e.value.asset.toLowerCase(), e.value]));
  const entry = (n: string) => catalog.get(n.toLowerCase()) ?? null;
  const scheduling: SchedulingSetting = runs?.getScheduling() ?? { state: "off", via: null };

  // The graph among assets: inputs (transforms) and readers.
  const inputsOf = (f: AssetFacts) => [...new Set(f.inputs.map(assetOf).filter((n): n is string => n !== undefined && n !== f.asset))];
  const readers = new Map<string, string[]>();
  for (const f of facts) for (const x of inputsOf(f)) readers.set(x, [...(readers.get(x) ?? []), f.asset]);
  const downstream = (names: Iterable<string>): Set<string> => {
    const seen = new Set<string>();
    const queue = [...names];
    while (queue.length) for (const r of readers.get(queue.pop()!) ?? []) if (!seen.has(r)) seen.add(r), queue.push(r);
    return seen;
  };

  // Leases held by live runs.
  const leased = new Map<string, string>();
  if (runs) {
    for (const l of runs.sqlite.query("SELECT asset, run_id, pid, proc_start, boot_id FROM leases").all() as
      { asset: string; run_id: string; pid: number; proc_start: string | null; boot_id: string | null }[]) {
      if (alive({ pid: l.pid, procStart: l.proc_start, bootId: l.boot_id })) leased.set(l.asset, l.run_id);
    }
  }
  const inFlight = spawned.inFlight;
  const starting = new Map<string, string>();
  for (const s of inFlight) for (const a of [...s.assets, ...downstream(s.assets)]) if (!starting.has(a)) starting.set(a, s.runId);
  const rolledBack = new Map(spawned.rollbacks.map((r) => [r.asset, r.to]));
  const expired = (s: FailedStart) => now.getTime() >= Date.parse(s.at) + RETRY_BACKOFF_MS;
  const failedStarts = [
    ...(runs?.getSetting<FailedStart[]>(FAILED_STARTS_SETTING) ?? []).filter((s) => s && typeof s.at === "string" && Array.isArray(s.assets) && !expired(s))
      .map((s) => ({ ...s, fresh: false })),
    ...spawned.failed.map((s) => ({ ...s, fresh: true })),
  ];
  for (const s of spawned.failed) {
    const retry = expired(s) ? "it runs again when it is next due" : `it runs again after ${clockWords(new Date(Date.parse(s.at) + RETRY_BACKOFF_MS), tz, now)}`;
    problems.push({
      ...problem("RUN_CRASHED", {
        message: `the scheduled run ${s.runId} did not start ${s.assets.join(", ")}: ${s.reason}`,
        hint: s.problem?.hint ?? `croft logs --runs shows the scheduled runs; ${s.unrecorded ? `.croft/logs/${s.runId}/process.log has what it printed` : `croft logs ${s.assets[0]} shows its last run`}`,
        effect: `${s.assets.length === 1 ? "it stays" : "they stay"} due; ${retry}`,
        details: { runId: s.runId, assets: s.assets },
      }),
      severity: "warning",
    });
  }
  const failedStartOf = (asset: string, lastOk: string | null): FailedStart | null => {
    let found: FailedStart | null = null;
    for (const s of failedStarts) {
      if (!s.assets.includes(asset) || expired(s)) continue;
      // A successful run since (by hand, say) ends the wait.
      if (lastOk !== null && Date.parse(lastOk) > Date.parse(s.at)) continue;
      if (!found || s.at > found.at) found = s;
    }
    return found;
  };

  const views: AssetScheduleView[] = [];
  const histories = new Map<string, History>();
  const due = new Map<string, string>();          // primary due assets → why
  const fired = new Map<string, string>();
  const holds = new Map<string, { code: HoldCode; reason: string }>();
  for (const f of facts) {
    const h = historyOf(runs, f.asset);
    histories.set(f.asset, h);
    const lastFireAt = rolledBack.has(f.asset) ? rolledBack.get(f.asset)! : h.state?.lastFireAt ?? null;
    const view: AssetScheduleView = {
      asset: f.asset, kind: f.kind!, schedule: f.kind === "ingest" ? f.schedule : null, nextFireAt: null,
      lastFireAt, lastAttemptAt: h.state?.lastAttemptAt ?? null, due: false, dueReason: null, held: null,
    };
    views.push(view);
    const transform = f.kind === "sql" || f.kind === "ts";
    if (!transform && !view.schedule) continue;       // an ingest without a schedule: the scheduler never runs it

    if (view.schedule) {
      const cron = view.schedule.cron;
      try {
        const next = fires.next(cron, tz, now);
        view.nextFireAt = next ? isoOf(next) : null;
        const latest = fires.latest(cron, tz, now);
        const handled = later(lastFireAt, h.lastOk);
        if (latest && (handled === null || isoOf(latest) > handled)) {
          const missed = handled === null ? 1 : missedFires(fires, cron, tz, new Date(handled), now);
          const when = `fired at ${clockWords(latest, tz, now)}`;
          due.set(f.asset, missed > 1 ? `${when}; ${missed >= MAX_MISSED ? `${MAX_MISSED} or more` : missed} missed fires run once` : when);
          fired.set(f.asset, isoOf(latest));
        }
      } catch {
        // A cron the matcher refuses: validate reports SCHEDULE_INVALID; the scheduler leaves the ingest alone.
      }
    } else {
      const inputs = inputsOf(f);
      // A transform whose input was never built waits for that input (a run would only skip it).
      const waiting = inputs.some((x) => entry(x) === null);
      const inputEntries = Object.fromEntries(inputs.map((x) => [x, entry(x)]));
      const reasons = waiting ? [] : staleReasons({
        asset: f.asset, file: f.file, kind: f.kind!, incremental: f.incremental, inputs,
        ...(f.codeHash ? { codeHash: f.codeHash } : {}), entry: entry(f.asset), inputEntries,
      });
      if (reasons.length) {
        const changed = inputs.filter((x) => staleReasons({
          asset: f.asset, file: f.file, kind: f.kind!, incremental: f.incremental, inputs: [x], entry: entry(f.asset), inputEntries,
        }).includes("input_changed"));
        due.set(f.asset, staleWords(reasons, changed));
      }
    }

    const hold = holdOf(f, h, {
      project, now, scheduling, approved: h.state?.approvedCodeHash ?? null, leasedBy: leased.get(f.asset) ?? null,
      startingRun: starting.get(f.asset) ?? null, failedStart: failedStartOf(f.asset, h.lastOk), primaryDue: due.has(f.asset),
      inputs: transform ? inputsOf(f) : [], entry,
    });
    if (hold) holds.set(f.asset, hold);
    view.held = hold;
  }

  // A stale transform whose last step was skipped for an input that is still held, and unchanged since, waits for
  // that input (holds are looked at inputs first: an input may itself wait for its own).
  const waits = new Map<string, { code: HoldCode; reason: string } | null>();
  const effective = (name: string, seen: Set<string>): { code: HoldCode; reason: string } | null => holds.get(name) ?? waitFor(name, seen);
  const waitFor = (name: string, seen: Set<string>): { code: HoldCode; reason: string } | null => {
    if (waits.has(name)) return waits.get(name)!;
    if (seen.has(name)) return null;
    seen.add(name);
    const f = byName.get(name);
    const h = histories.get(name);
    let result: { code: HoldCode; reason: string } | null = null;
    const s = h?.latest;
    if (f && (f.kind === "sql" || f.kind === "ts") && due.has(name) && s && s.status === "skipped" && s.attempt === 0) {
      const named = blockerOf(runs, s.runId, name);
      const candidates = named !== null && byName.has(named) ? [named] : inputsOf(f);
      const since = Date.parse(s.startedAt);
      const newer = (t: string | null | undefined) => typeof t === "string" && Date.parse(t) > since;
      for (const x of candidates) {
        const hx = effective(x, seen);
        if (!hx || hx.code === "paused") continue;
        const e = entry(x);
        if (newer(e?.lastLoadedAt) || newer(e?.lastReplacedAt)) continue;   // it changed since: try again
        result = { code: "backoff", reason: `waits for its input ${x}: ${hx.code === "backoff" ? "" : `${hx.code}, `}${hx.reason}` };
        break;
      }
    }
    waits.set(name, result);
    return result;
  };
  for (const v of views) {
    if (holds.has(v.asset)) continue;
    const w = waitFor(v.asset, new Set());
    if (w) {
      holds.set(v.asset, w);
      v.held = w;
    }
  }

  // What follows a due ingest the scheduler starts: its downstream runs in the same run.
  const starts = [...due.keys()].filter((a) => byName.get(a)?.kind === "ingest" && !holds.has(a));
  const followers = downstream(starts);
  for (const v of views) {
    const why = due.get(v.asset);
    if (why !== undefined) {
      v.due = true;
      v.dueReason = why;
    } else if (followers.has(v.asset) && v.kind !== "ingest") {
      const from = starts.filter((a) => downstream([a]).has(v.asset));
      v.due = true;
      v.dueReason = `after ${from.join(", ")}, which ${from.length === 1 ? "is" : "are"} due`;
    }
  }

  const held: HeldAsset[] = views.filter((v) => v.due && v.held).map((v) => ({ asset: v.asset, code: v.held!.code, reason: v.held!.reason }));
  const ready = [...due.keys()].filter((a) => !holds.has(a)).sort();
  return {
    views, groups: groupsOf(ready, facts, inputsOf),
    fires: new Map(ready.filter((a) => fired.has(a)).map((a) => [a, fired.get(a)!])),
    held, imported: loaded.imported, inFlight, failedStarts, rollbacks: spawned.rollbacks, problems,
  };
}

/** The input a skipped step named as the reason (the run's stored summary: "input x is held …"), or null. */
function blockerOf(runs: RunsDb | null, runId: string, asset: string): string | null {
  try {
    const summary = runs?.getRun(runId)?.summary as { data?: { steps?: { asset?: unknown; skippedBecause?: unknown }[] } } | null | undefined;
    const step = summary?.data?.steps?.find((s) => s.asset === asset);
    const m = typeof step?.skippedBecause === "string" ? /^input ([A-Za-z0-9_]+) /.exec(step.skippedBecause) : null;
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

interface HoldContext {
  project: Project;
  now: Date;
  scheduling: SchedulingSetting;
  approved: string | null;
  leasedBy: string | null;
  startingRun: string | null;
  failedStart: FailedStart | null;
  /** Due on its own (a fire, or stale): only then can a failure hold it back. */
  primaryDue: boolean;
  inputs: string[];
  entry: (name: string) => CatalogAsset | null;
}

/** The first hold that applies (see the top of this file), or null. Waiting for an input comes after (dueWork). */
function holdOf(f: AssetFacts, h: History, c: HoldContext): { code: HoldCode; reason: string } | null {
  if (c.scheduling.state === "paused") {
    const until = c.scheduling.pausedUntil ? ` until ${clockWords(new Date(c.scheduling.pausedUntil), c.project.timezone, c.now)}` : "";
    // A project ticked by croft serve only resumes with --no-os-job, so following the hint never installs the OS job (R32-10).
    const resume = c.scheduling.via === "serve" ? "croft schedule on --no-os-job" : "croft schedule on";
    return { code: "paused", reason: `scheduling is paused${until}; ${resume} resumes it` };
  }
  if (f.codeHash === null || f.codeHash !== c.approved) {
    return { code: "SCHEDULE_HELD", reason: scheduleHeld({
      asset: f.asset, file: f.file, approved: c.approved, editedAt: editedAt(c.project.root, f.file), loads: f.ok && f.codeHash !== null, now: c.now,
      timeZoneChanged: f.timeZoneChanged ?? null,
    }).reason };
  }
  if (h.reprocess) {
    return { code: "LARGE_REPROCESS", reason: `the cost guard needs a person: croft run ${f.asset} shows how many rows it would process and asks first` };
  }
  if (c.leasedBy) return { code: "leased", reason: `run ${c.leasedBy} holds it; it stays due` };
  if (c.startingRun) return { code: "leased", reason: `the scheduled run ${c.startingRun} is starting; it stays due` };
  if (c.failedStart && (c.primaryDue || f.kind !== "ingest")) {
    const until = clockWords(new Date(Date.parse(c.failedStart.at) + RETRY_BACKOFF_MS), c.project.timezone, c.now);
    return { code: "backoff", reason: `the scheduled run ${c.failedStart.runId} did not start it (${c.failedStart.reason}); tries again after ${until}` };
  }
  if (!c.primaryDue || f.kind === "ingest") return null;
  return backoff(f, h, c);
}

/** A transform whose last attempt failed waits (see the top of this file). */
function backoff(f: AssetFacts, h: History, c: HoldContext): { code: HoldCode; reason: string } | null {
  const s = h.latest;
  if (!s || !FAILED.has(s.status)) return null;
  const started = Date.parse(s.startedAt);
  // A change since the attempt ends the wait: other code (approved since, or the hash differs), or new input data.
  if (s.codeHash && f.codeHash && s.codeHash !== f.codeHash) return null;
  const newer = (t: string | null) => t !== null && Date.parse(t) > started;
  if (c.inputs.some((x) => newer(c.entry(x)?.lastLoadedAt ?? null) || newer(c.entry(x)?.lastReplacedAt ?? null))) return null;
  const at = clockWords(new Date(started), c.project.timezone, c.now);
  const code = s.error?.code ?? s.status.toUpperCase();
  if (s.status === "failed" && !retryable(s.error)) {
    return { code: "backoff", reason: `failed at ${at} (${code}); waits for a change to its code or inputs, or croft run ${f.asset}` };
  }
  const ended = Date.parse(s.finishedAt ?? s.startedAt);
  const asked = Number(s.error?.details?.retryAfterMs);
  const until = ended + Math.max(RETRY_BACKOFF_MS, Number.isFinite(asked) ? asked : 0);
  if (c.now.getTime() >= until) return null;
  return { code: "backoff", reason: `${s.status === "failed" ? "failed" : s.status} at ${at} (${code}); tries again after ${clockWords(new Date(until), c.project.timezone, c.now)}` };
}

/** Group the ready assets: two share a group when the graph connects them at all, through what reads them or what
 *  they read (a shared input included). Every run waits for the one database writer anyway, so N stale readers of
 *  one input become one process, not N. */
function groupsOf(ready: readonly string[], facts: readonly AssetFacts[], inputsOf: (f: AssetFacts) => string[]): string[][] {
  const parent = new Map<string, string>();
  const find = (n: string): string => {
    let r = n;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(n, r);
    return r;
  };
  for (const f of facts) for (const x of inputsOf(f)) parent.set(find(f.asset), find(x));
  const groups = new Map<string, string[]>();
  for (const a of ready) groups.set(find(a), [...(groups.get(find(a)) ?? []), a]);
  return [...groups.values()].map((g) => g.sort()).sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------------------
// Runs ticks started

/** The runs earlier ticks started that are still starting or running (their process alive, their run not ended). */
export function startingRuns(runs: RunsDb, stateDir: string, alive: Alive = recordAlive, now: Date = new Date()): SpawnedRun[] {
  return endedRuns(runs, stateDir, alive, now).inFlight;
}

/**
 * The runs earlier ticks started (SPAWNED_SETTING): the ones still starting or running, and for the others, the
 * fires they did not attempt (last_fire_at goes back, when nothing moved it since) and whether they failed to start
 * assets: the child died or refused before it recorded the run, or the run crashed or was interrupted before it
 * started them. A run that ended normally without starting an asset skipped it for a reason the scheduler sees
 * too (another run's lease, a hold): its fire stays due, with no wait.
 */
function endedRuns(runs: RunsDb, stateDir: string, alive: Alive, now: Date): {
  inFlight: SpawnedRun[]; rollbacks: { asset: string; from: string; to: string | null }[]; failed: FailedStart[];
  /** The assets the ended runs did not start. */
  unstarted: string[];
} {
  const list = runs.getSetting<SpawnedRun[]>(SPAWNED_SETTING);
  const inFlight: SpawnedRun[] = [];
  const rollbacks: { asset: string; from: string; to: string | null }[] = [];
  const failed: FailedStart[] = [];
  const all: string[] = [];
  if (!Array.isArray(list)) return { inFlight, rollbacks, failed, unstarted: all };
  const attempted = (runId: string, asset: string) =>
    runs.sqlite.query("SELECT 1 FROM steps WHERE run_id = ? AND asset = ? AND attempt >= 1 LIMIT 1").get(runId, asset) !== null;
  for (const s of list) {
    if (!s || typeof s.runId !== "string" || !Array.isArray(s.assets)) continue;
    const run = runs.getRun(s.runId);
    let unstarted: string[];
    let why: { reason: string; unrecorded: boolean; problem?: Problem } | null = null;
    if (run) {
      if (run.status === "running" && alive(run)) {
        inFlight.push(s);
        continue;
      }
      unstarted = s.assets.filter((a) => !attempted(s.runId, a));
      if (run.status === "crashed" || run.status === "interrupted" || run.status === "running") {
        why = { reason: `the run ${run.status === "interrupted" ? "was interrupted" : "crashed"} before it started ${unstarted.length === 1 ? "it" : "them"}`, unrecorded: false };
      }
    } else {
      const refused = readNotStarted(stateDir, s.runId);
      const child = readSpawnRecord(stateDir, s.runId);
      if (!refused && child !== null && alive(child)) {
        inFlight.push(s);
        continue;
      }
      if (!refused && child === null && typeof s.at === "string" && Math.abs(now.getTime() - Date.parse(s.at)) < SPAWN_GRACE_MS) {
        inFlight.push(s);
        continue;
      }
      unstarted = [...s.assets];
      why = refused
        ? { reason: `it refused to start: ${refused.code}: ${refused.message}`, unrecorded: true, problem: refused }
        : { reason: "its process ended before it recorded the run", unrecorded: true };
    }
    all.push(...unstarted);
    for (const a of unstarted) {
      const f = s.fires?.[a];
      if (!f) continue;
      // Not handled: the fire stays due (unless a later fire moved last_fire_at since).
      if (runs.scheduleState(a)?.lastFireAt === f.fire) rollbacks.push({ asset: a, from: f.fire, to: f.before ?? null });
    }
    if (why && unstarted.length > 0) {
      failed.push({ runId: s.runId, assets: unstarted, at: typeof s.at === "string" ? s.at : run?.startedAt ?? now.toISOString(), ...why });
    }
  }
  return { inFlight, rollbacks, failed, unstarted: all };
}

/** The spawn handshake of a detached run (run/detach.ts _process.json), read without importing the run engine. */
function readSpawnRecord(stateDir: string, runId: string): { pid: number; procStart: string; bootId: string } | null {
  try {
    const r = JSON.parse(readFileSync(join(stateDir, "logs", runId, "_process.json"), "utf8")) as { pid?: unknown; procStart?: unknown; bootId?: unknown };
    if (typeof r.pid !== "number" || typeof r.procStart !== "string") return null;
    return { pid: r.pid, procStart: r.procStart, bootId: typeof r.bootId === "string" ? r.bootId : "" };
  } catch {
    return null;
  }
}

/** The refusal a detached child left before it recorded its run (run/detach.ts _not_started.json), or null. */
function readNotStarted(stateDir: string, runId: string): Problem | null {
  try {
    const p = JSON.parse(readFileSync(join(stateDir, "logs", runId, "_not_started.json"), "utf8")) as Problem;
    return p && typeof p.code === "string" && typeof p.message === "string" ? p : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// croft run --due: what its plan holds (run/plan.ts DuePlanning)

/** The holds a `croft run --due` plan applies, read from runs.sqlite now: the run re-checks what the tick found,
 *  with the code hashes it just computed. The fire a due ingest handles is `fires`' (the due work's), else the
 *  latest fire of its schedule as its code says it now. */
export function duePlanning(o: { project: Project; runs: RunsDb; now: Date; fires?: Map<string, string>; times?: FireTimes; alive?: Alive }): DuePlanning {
  const { project, runs, now } = o;
  const alive = o.alive ?? recordAlive;
  const times = o.times ?? defaultFires;
  const scheduling = runs.getScheduling();
  const facts = runs.getSetting<Record<string, AssetFacts>>(FACTS_SETTING) ?? {};
  return {
    hold(step: { asset: string; file: string; kind: StepKind; codeHash?: string; ok: boolean }) {
      if (scheduling.state === "paused") {
        return { hold: "paused" as Hold, reason: "held: scheduling is paused" };
      }
      if (scheduling.state === "off") return { hold: "paused" as Hold, reason: "held: scheduling is off" };
      const approved = runs.approvedCode(step.asset);
      if (step.codeHash === undefined || step.codeHash !== approved) {
        // The tick found (and noted) whether only the time zone moved this code's hash.
        const known = Object.hasOwn(facts, step.asset) ? facts[step.asset] : undefined;
        const zone = known && known.codeHash === (step.codeHash ?? null) && known.approved === approved ? known.timeZoneChanged ?? null : null;
        const h = scheduleHeld({
          asset: step.asset, file: step.file, approved, editedAt: editedAt(project.root, step.file), loads: step.ok && step.codeHash !== undefined, now,
          timeZoneChanged: zone,
        });
        return { hold: "code_not_run_by_hand" as Hold, reason: `held: ${h.reason}`, problem: h.problem };
      }
      if (step.kind === "transform") {
        const r = historyOf(runs, step.asset).reprocess;
        if (r) {
          return {
            hold: "large_reprocess" as Hold, reason: "held: the cost guard needs a person (LARGE_REPROCESS)",
            problem: { ...r, severity: "warning" as const, asset: step.asset },
          };
        }
      }
      const lease = runs.sqlite.query("SELECT run_id, pid, proc_start, boot_id FROM leases WHERE asset = ?").get(step.asset) as
        { run_id: string; pid: number; proc_start: string | null; boot_id: string | null } | null;
      if (lease && alive({ pid: lease.pid, procStart: lease.proc_start, bootId: lease.boot_id })) {
        return { hold: "leased" as Hold, reason: `held: run ${lease.run_id} holds it; it stays due` };
      }
      return null;
    },
    fire(step: { asset: string; schedule?: string }) {
      const known = o.fires?.get(step.asset);
      if (known) return known;
      const parsed = step.schedule !== undefined ? parseSchedule(step.schedule) : null;
      if (!parsed?.ok) return null;
      try {
        const latest = times.latest(parsed.schedule.cron, project.timezone, now);
        return latest ? isoOf(latest) : null;
      } catch {
        return null;
      }
    },
  };
}
