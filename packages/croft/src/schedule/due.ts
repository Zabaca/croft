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
// - SCHEDULE_HELD: the code is not the code a human last ran (approved_code_hash), new assets included;
// - LARGE_REPROCESS: a scheduled run met the cost guard, and no person has run the transform since;
// - leased: another run holds it, or a run a tick started has not taken its leases yet (overlaps skip);
// - backoff: a transform whose last attempt failed. A deterministic failure (TYPE_CONFLICT, CHECK_FAILED, an SQL
//   error, ASSET_INVALID: not retryable) waits for a change to its code or inputs; a retryable one (after its own
//   retries), a crash or an interruption waits RETRY_BACKOFF_MS, or the server's longer Retry-After. Never every
//   minute. An ingest needs none of this: it is due again only at its next fire.
//
// What the scheduler knows of an asset without importing it (AssetFacts: kind, schedule, inputs, code hash) is
// cached in runs.sqlite by file hash: schedule_state keeps phrase, cron and file_hash, and the settings row
// `schedule.facts` the rest. The file hash covers the asset file and the project time zone, and for TS assets the
// size and modification time of everything in lib/ and of package.json and the lockfile, which the TS code hash
// depends on. Only an asset whose hash changed is imported again (project/resolve.ts), so a tick with nothing
// changed imports no asset code.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { CODES, isCode, problem } from "../core/errors.ts";
import { recordAlive } from "../core/proc.ts";
import { zonedParts } from "../core/time.ts";
import type { Hold, Problem, Reason } from "../core/types.ts";
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
 *  cache), and it imports only assets whose file changed since the last tick, unless `resolved` is given. */
export async function scheduleView(i: ScheduleViewInput): Promise<AssetScheduleView[]> {
  const project = loadProject({ root: i.root });
  const runs = existsSync(join(project.paths.stateDir, RUNS_DB_FILE)) ? RunsDb.open(project.paths.stateDir, { now: () => i.now }) : null;
  try {
    const work = await dueWork({ project, runs, now: i.now, store: false, ...(i.resolved ? { resolved: i.resolved } : {}) });
    return work.views;
  } finally {
    runs?.close();
  }
}

// ---------------------------------------------------------------------------------------------------------
// Facts: what the scheduler knows of an asset without importing it

/** The settings row that caches AssetFacts by asset. */
export const FACTS_SETTING = "schedule.facts";
/** The settings row listing the runs ticks started that may not hold their leases yet: [{runId, assets}]. */
export const SPAWNED_SETTING = "schedule.spawned";
/** How long a transform waits after a retryable failure, a crash or an interruption before the scheduler tries
 *  it again (a server's longer Retry-After wins). */
export const RETRY_BACKOFF_MS = 15 * 60_000;

export interface AssetFacts {
  asset: string;
  /** Root-relative. */
  file: string;
  kind: "ingest" | "sql" | "ts" | null;
  /** fileHash(): what the cache is keyed by. */
  fileHash: string;
  schedule: Schedule | null;
  /** The assets it reads (transforms). */
  inputs: string[];
  /** The code hash (includes the project time zone); null when the code does not parse. */
  codeHash: string | null;
  /** An incremental TS transform (newRows()): forward-only, so an edit is no reason to run it. */
  incremental: boolean;
  /** Loaded with no error. */
  ok: boolean;
}

/** Refreshes the facts of `names` (whose files changed) by importing them. It may return more assets than it was
 *  asked for (resolveProject loads every transform); an asset it cannot resolve is left out. */
export type FactsResolver = (i: { root: string; timezone: string; names: readonly string[] }) => Promise<ResolvedAsset[]>;

/** The default resolver: project/resolve.ts, imported only when something changed. */
export const resolveAssets: FactsResolver = async (i) => {
  const [{ resolveProject }, { discoverAssets }] = await Promise.all([import("../project/resolve.ts"), import("../project/discover.ts")]);
  // A name the naming rules refuse is not an asset (the tick lists files without DuckDB's keyword list).
  const valid = new Set((await discoverAssets(i.root)).assets.map((a) => a.name));
  const selectors = i.names.filter((n) => valid.has(n));
  if (selectors.length === 0) return [];
  const project = await resolveProject({ root: i.root, timezone: i.timezone, selectors });
  return project.assets.filter((a) => a.loaded);
};

/** An asset file found in assets/ (the naming rules' pattern; NAME_RESERVED is the resolver's to apply). */
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
    list.push({ name, file: relative(root, path).split(sep).join("/"), path, sql });
    byName.set(name, list);
  }
  // Two files for one name (NAME_CONFLICT) define no asset.
  return [...byName.values()].filter((l) => l.length === 1).map((l) => l[0]!).sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Size and modification time of what every TS code hash depends on besides the file: lib/ and the packages. */
function sharedStamp(root: string, libDir: string): string {
  const parts: string[] = [];
  const stamp = (path: string) => {
    try {
      const st = statSync(path);
      if (st.isFile()) parts.push(`${relative(root, path)}:${st.size}:${st.mtimeMs}`);
    } catch {
      // Gone: its absence is the stamp.
    }
  };
  for (const f of ["package.json", "bun.lock", "bun.lockb"]) stamp(join(root, f));
  if (existsSync(libDir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(libDir, { recursive: true }) as string[];
    } catch {}
    for (const rel of entries.sort()) if (!rel.split(sep).some((p) => p === "node_modules" || p.startsWith("."))) stamp(join(libDir, rel));
  }
  return parts.join("\n");
}

/** The cache key of an asset's facts (see the top of this file). "" when the file cannot be read. */
export function fileHash(path: string, timezone: string, shared: string | null): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return "";
  }
  const h = createHash("sha256").update(bytes).update("\0").update(timezone);
  if (shared !== null) h.update("\0").update(shared);
  return h.digest("hex");
}

function factsOf(a: ResolvedAsset, hash: string): AssetFacts {
  return {
    asset: a.name, file: a.file, kind: a.kind, fileHash: hash, schedule: a.schedule ?? null, inputs: [...a.inputs],
    codeHash: a.codeHash ?? null, incremental: a.incremental.kind === "new-rows", ok: a.ok,
  };
}

interface FactsOutcome { facts: AssetFacts[]; imported: boolean; problems: Problem[] }

/**
 * The facts of every asset, from the cache where its file hash is unchanged; the others are imported once
 * (`resolve`) and, with `store`, cached again. `resolved` (a caller that already resolved the project) replaces the
 * import.
 */
async function loadFacts(o: {
  project: Project; runs: RunsDb | null; store: boolean; resolve: FactsResolver; resolved?: readonly ResolvedAsset[];
}): Promise<FactsOutcome> {
  const { project } = o;
  const files = listAssetFiles(project.root, project.paths.assetsDir);
  const shared = files.some((f) => !f.sql) ? sharedStamp(project.root, project.paths.libDir) : "";
  const hashes = new Map(files.map((f) => [f.name, fileHash(f.path, project.timezone, f.sql ? null : shared)]));
  const cached = o.runs?.getSetting<Record<string, AssetFacts>>(FACTS_SETTING) ?? {};
  const state = new Map((o.runs?.allScheduleState() ?? []).map((s) => [s.asset, s]));
  const current = (name: string): AssetFacts | null => {
    const f = Object.hasOwn(cached, name) ? cached[name] : undefined;
    const hash = hashes.get(name);
    return f && hash && f.fileHash === hash && state.get(name)?.fileHash === hash ? f : null;
  };
  const out = new Map<string, AssetFacts>();
  const changed: string[] = [];
  for (const f of files) {
    const c = current(f.name);
    if (c) out.set(f.name, c);
    else if (hashes.get(f.name)) changed.push(f.name);
  }
  const problems: Problem[] = [];
  let imported = false;
  const fresh: AssetFacts[] = [];
  if (o.resolved) {
    for (const a of o.resolved) if (a.loaded && hashes.get(a.name)) fresh.push(factsOf(a, hashes.get(a.name)!));
  } else if (changed.length > 0) {
    try {
      const got = await o.resolve({ root: project.root, timezone: project.timezone, names: changed });
      imported = got.length > 0;
      for (const a of got) {
        const hash = hashes.get(a.name);
        if (hash) fresh.push(factsOf(a, hash));
      }
      // A file that is no asset after all (a name the naming rules refuse) is remembered as such, so it is not
      // looked at again until it changes.
      for (const name of changed) {
        if (fresh.some((f) => f.asset === name)) continue;
        const file = files.find((f) => f.name === name)!;
        fresh.push({ asset: name, file: file.file, kind: null, fileHash: hashes.get(name)!, schedule: null, inputs: [], codeHash: null, incremental: false, ok: false });
      }
    } catch (e) {
      const p = (e as { problem?: Problem }).problem;
      problems.push({
        ...(p ?? problem("INTERNAL_ERROR", { message: String((e as Error)?.message ?? e), hint: "report this croft bug" })),
        severity: "warning",
        message: `the scheduler could not read ${changed.join(", ")}: ${p?.message ?? String((e as Error)?.message ?? e)}`,
        effect: "those assets are not scheduled until they load again",
      });
    }
  }
  for (const f of fresh) {
    // A file that no longer loads keeps the schedule it had, so it stays scheduled, and held (its code changed).
    const prev = state.get(f.asset);
    if (!f.ok && !f.schedule && prev?.cron) f.schedule = { text: prev.phrase ?? prev.cron, cron: prev.cron };
    out.set(f.asset, f);
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
  resolve?: FactsResolver;
  resolved?: readonly ResolvedAsset[];
  fires?: FireTimes;
  /** Whether a recorded process still runs (core/proc.ts recordAlive). */
  alive?: Alive;
}

export type Alive = (r: { pid: number | null; procStart: string | null; bootId: string | null }) => boolean;

export interface HeldAsset { asset: string; code: HoldCode; reason: string }

export interface DueWork {
  views: AssetScheduleView[];
  /** The due assets nothing holds, one group per run to start: the ingests that fired and the stale transforms, in
   *  groups the graph connects (through what reads them), so two runs never want the same downstream asset. */
  groups: string[][];
  /** The fire each due ingest handles (ISO-8601 UTC): its last_fire_at once its run starts. */
  fires: Map<string, string>;
  /** Due assets the scheduler skips, and why. */
  held: HeldAsset[];
  /** Whether asset code was imported to refresh the facts. */
  imported: boolean;
  /** Runs earlier ticks started that are still starting or running: [{runId, assets}]. */
  inFlight: SpawnedRun[];
  problems: Problem[];
}

/** A run a tick started (the settings row SPAWNED_SETTING). */
export interface SpawnedRun { runId: string; assets: string[] }

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

/** SCHEDULE_HELD (§6): the asset's code is not the code a human last ran. The reason is what status shows. */
export function scheduleHeld(o: { asset: string; file: string; approved: string | null; editedAt: number | null; loads: boolean; now: Date }): { reason: string; problem: Problem } {
  const run = `croft run ${o.asset}`;
  const edited = `${o.approved === null ? "new: " : ""}code edited${o.editedAt !== null ? ` ${ago(o.editedAt, o.now)} ago` : ""}`;
  const reason = o.loads
    ? `${edited}, not run by hand yet; ${run} releases it`
    : `${edited} and it does not load; fix it, then ${run} releases it`;
  const p = problem("SCHEDULE_HELD", {
    asset: o.asset, file: o.file,
    message: `${o.asset} is held from the scheduler: ${o.approved === null ? "it has never been run by hand" : "its code changed since it was last run by hand"}`,
    hint: `the scheduler only runs code a person has run; check the change, then ${run} (a run from a terminal or Claude Code) releases it`,
    effect: "scheduled runs skip it, and it stays due",
    fix: { kind: "command", description: `run ${o.asset} by hand once`, command: run },
    details: { approvedCodeHash: o.approved, ...(o.editedAt !== null ? { editedAt: new Date(o.editedAt).toISOString() } : {}) },
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
  const loaded = await loadFacts({ project, runs, store: i.store, resolve: i.resolve ?? resolveAssets, ...(i.resolved ? { resolved: i.resolved } : {}) });
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

  // Leases held by live runs, and runs earlier ticks started that may not hold theirs yet.
  const leased = new Map<string, string>();
  if (runs) {
    for (const l of runs.sqlite.query("SELECT asset, run_id, pid, proc_start, boot_id FROM leases").all() as
      { asset: string; run_id: string; pid: number; proc_start: string | null; boot_id: string | null }[]) {
      if (alive({ pid: l.pid, procStart: l.proc_start, bootId: l.boot_id })) leased.set(l.asset, l.run_id);
    }
  }
  const inFlight = runs ? startingRuns(runs, project.paths.stateDir, alive) : [];
  const starting = new Map<string, string>();
  for (const s of inFlight) for (const a of [...s.assets, ...downstream(s.assets)]) if (!starting.has(a)) starting.set(a, s.runId);

  const views: AssetScheduleView[] = [];
  const due = new Map<string, string>();          // primary due assets → why
  const fired = new Map<string, string>();
  const holds = new Map<string, { code: HoldCode; reason: string }>();
  for (const f of facts) {
    const h = historyOf(runs, f.asset);
    const view: AssetScheduleView = {
      asset: f.asset, kind: f.kind!, schedule: f.kind === "ingest" ? f.schedule : null, nextFireAt: null,
      lastFireAt: h.state?.lastFireAt ?? null, lastAttemptAt: h.state?.lastAttemptAt ?? null, due: false, dueReason: null, held: null,
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
        const handled = later(h.state?.lastFireAt ?? null, h.lastOk);
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
      startingRun: starting.get(f.asset) ?? null, primaryDue: due.has(f.asset), inputs: transform ? inputsOf(f) : [], entry,
    });
    if (hold) holds.set(f.asset, hold);
    view.held = hold;
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
    views, groups: groupsOf(ready, facts, inputsOf, downstream),
    fires: new Map(ready.filter((a) => fired.has(a)).map((a) => [a, fired.get(a)!])),
    held, imported: loaded.imported, inFlight, problems: loaded.problems,
  };
}

interface HoldContext {
  project: Project;
  now: Date;
  scheduling: SchedulingSetting;
  approved: string | null;
  leasedBy: string | null;
  startingRun: string | null;
  /** Due on its own (a fire, or stale): only then can a failure hold it back. */
  primaryDue: boolean;
  inputs: string[];
  entry: (name: string) => CatalogAsset | null;
}

/** The first hold that applies (see the top of this file), or null. */
function holdOf(f: AssetFacts, h: History, c: HoldContext): { code: HoldCode; reason: string } | null {
  if (c.scheduling.state === "paused") {
    const until = c.scheduling.pausedUntil ? ` until ${clockWords(new Date(c.scheduling.pausedUntil), c.project.timezone, c.now)}` : "";
    return { code: "paused", reason: `scheduling is paused${until}; croft schedule on resumes it` };
  }
  if (f.codeHash === null || f.codeHash !== c.approved) {
    return { code: "SCHEDULE_HELD", reason: scheduleHeld({
      asset: f.asset, file: f.file, approved: c.approved, editedAt: editedAt(c.project.root, f.file), loads: f.ok && f.codeHash !== null, now: c.now,
    }).reason };
  }
  if (h.reprocess) {
    return { code: "LARGE_REPROCESS", reason: `the cost guard needs a person: croft run ${f.asset} shows how many rows it would process and asks first` };
  }
  if (c.leasedBy) return { code: "leased", reason: `run ${c.leasedBy} holds it; it stays due` };
  if (c.startingRun) return { code: "leased", reason: `the scheduled run ${c.startingRun} is starting; it stays due` };
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

/** Group the ready assets: two share a group when the graph connects them through assets a run of either takes
 *  (they and their downstream). */
function groupsOf(ready: readonly string[], facts: readonly AssetFacts[], inputsOf: (f: AssetFacts) => string[],
  downstream: (names: Iterable<string>) => Set<string>): string[][] {
  const closure = new Set([...ready, ...downstream(ready)]);
  const parent = new Map([...closure].map((n) => [n, n]));
  const find = (n: string): string => {
    let r = n;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(n, r);
    return r;
  };
  for (const f of facts) {
    if (!closure.has(f.asset)) continue;
    for (const x of inputsOf(f)) if (closure.has(x)) parent.set(find(f.asset), find(x));
  }
  const groups = new Map<string, string[]>();
  for (const a of ready) groups.set(find(a), [...(groups.get(find(a)) ?? []), a]);
  return [...groups.values()].map((g) => g.sort()).sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
}

/** The runs earlier ticks started that are still starting or running (their process alive, their run not ended). */
export function startingRuns(runs: RunsDb, stateDir: string, alive: Alive = recordAlive): SpawnedRun[] {
  const list = runs.getSetting<SpawnedRun[]>(SPAWNED_SETTING);
  if (!Array.isArray(list)) return [];
  return list.filter((s) => {
    if (!s || typeof s.runId !== "string" || !Array.isArray(s.assets)) return false;
    const run = runs.getRun(s.runId);
    if (run) return run.status === "running" && alive(run);
    const child = readSpawnRecord(stateDir, s.runId);
    return child !== null && alive(child);
  });
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
  return {
    hold(step: { asset: string; file: string; kind: StepKind; codeHash?: string; ok: boolean }) {
      if (scheduling.state === "paused") {
        return { hold: "paused" as Hold, reason: "held: scheduling is paused" };
      }
      if (scheduling.state === "off") return { hold: "paused" as Hold, reason: "held: scheduling is off" };
      const approved = runs.approvedCode(step.asset);
      if (step.codeHash === undefined || step.codeHash !== approved) {
        const h = scheduleHeld({
          asset: step.asset, file: step.file, approved, editedAt: editedAt(project.root, step.file), loads: step.ok && step.codeHash !== undefined, now,
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
