// Test fixtures for the scheduler's due work and ticks (schedule/due.ts, schedule/tick.ts): temp projects with a
// scheduled ingest, state written straight into runs.sqlite (catalog entries, steps, approvals), and a marker an
// asset's top-level code appends to, which proves when asset code was imported. Not imported by croft.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Problem } from "../core/types.ts";
import type { CatalogAsset, InputSeen } from "../history/catalog.ts";
import { RunsDb } from "../history/runs-db.ts";
import { loadProject, type Project } from "../project/root.ts";
import { makeProject } from "../run/testkit.ts";
import { type AssetFacts, FACTS_SETTING } from "./due.ts";

/** A process that is not running (history tests use the same). */
export const DEAD = { pid: 999_999, procStart: "0", bootId: "no-such-boot" };

/** An ingest with a schedule; `marker`: its top-level code appends a line to that file whenever it is imported. */
export function scheduledIngest(o: { schedule?: string; marker?: string; body?: string } = {}): string {
  const mark = o.marker ? `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(o.marker)}, "imported\\n");\n` : "";
  return `${mark}import { ingest } from "@zabaca/croft";
export default ingest({
  key: "id",
  schedule: ${JSON.stringify(o.schedule ?? "every hour")},
  async *rows() {
    ${o.body ?? "yield [{ id: 1 }];"}
  },
});
`;
}

/** Lines the marker file holds: how many times the asset was imported. */
export function imports(marker: string): number {
  return existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean).length : 0;
}

export interface SchedProject { root: string; project: Project; stateDir: string; db(now?: Date): RunsDb }

export function schedProject(files: Record<string, string>, o: { timezone?: string } = {}): SchedProject {
  const root = makeProject(files, { timezone: o.timezone ?? "UTC" });
  const project = loadProject({ root });
  return {
    root, project, stateDir: project.paths.stateDir,
    db: (now) => RunsDb.open(project.paths.stateDir, now ? { now: () => now } : {}),
  };
}

/** The cached facts (after a dueWork that stored them). */
export function factsOf(p: SchedProject): Record<string, AssetFacts> {
  const db = p.db();
  try {
    return db.getSetting<Record<string, AssetFacts>>(FACTS_SETTING) ?? {};
  } finally {
    db.close();
  }
}

/** Approve every asset's current code, as a run by hand would (after a dueWork that stored the facts). */
export function approveAll(p: SchedProject, only?: string[]): void {
  const facts = factsOf(p);
  const db = p.db();
  try {
    for (const [asset, f] of Object.entries(facts)) if (f.codeHash && (!only || only.includes(asset))) db.approveCode(asset, f.codeHash);
  } finally {
    db.close();
  }
}

/** A catalog mirror entry, as a committed step writes it. */
export function built(p: SchedProject, asset: string, e: {
  kind?: CatalogAsset["kind"]; lastLoadedAt: string; codeHash?: string | null; inputsSeen?: Record<string, Partial<InputSeen>>; lastReplacedAt?: string | null;
}): void {
  const db = p.db();
  try {
    const inputsSeen = e.inputsSeen
      ? Object.fromEntries(Object.entries(e.inputsSeen).map(([k, v]) => [k, { seenLoadedAt: null, seenKey: null, inputLastLoadedAt: null, ...v }]))
      : undefined;
    const entry: CatalogAsset = {
      asset, kind: e.kind ?? "ingest", behavior: "", write: "replace", key: [], rows: 1, columns: [{ name: "id", type: "BIGINT", sourceName: null, pinned: false, pending: false, format: null }],
      cursor: null, lastLoadedAt: e.lastLoadedAt, lastReplacedAt: e.lastReplacedAt ?? null, lastRunId: null,
      codeHash: e.codeHash === undefined ? factsOf(p)[asset]?.codeHash ?? null : e.codeHash, ...(inputsSeen ? { inputsSeen } : {}),
    };
    db.catalogPut(asset, entry, "run");
  } finally {
    db.close();
  }
}

/** A finished step of `asset`, in a run of its own that started at `at`. */
export function recordStep(p: SchedProject, s: {
  asset: string; at: string; status: "ok" | "unchanged" | "failed" | "crashed" | "interrupted" | "skipped"; human?: boolean;
  error?: Problem; codeHash?: string; finishedAt?: string;
}): string {
  const db = p.db(new Date(s.at));
  try {
    const human = s.human ?? true;
    const run = db.createRun({ trigger: human ? "manual" : "schedule", human, argv: ["run", s.asset], identity: DEAD });
    db.startStep({ runId: run.id, asset: s.asset, attempt: 1, reason: "requested", ...(s.codeHash ? { codeHash: s.codeHash } : {}) });
    db.finishStep(run.id, s.asset, 1, { status: s.status, ...(s.error ? { error: s.error } : {}) });
    db.finishRun(run.id, s.status === "ok" || s.status === "unchanged" || s.status === "skipped" ? "succeeded" : "failed");
    if (s.finishedAt) db.sqlite.query("UPDATE steps SET finished_at = ? WHERE run_id = ?").run(s.finishedAt, run.id);
    return run.id;
  } finally {
    db.close();
  }
}

/** A step of `asset` skipped for an input (attempt 0, as run/runner.ts records it), in a scheduled run of its own
 *  that started at `at` and whose stored summary gives `because` as skippedBecause. */
export function recordSkip(p: SchedProject, s: { asset: string; at: string; because: string; human?: boolean }): string {
  const db = p.db(new Date(s.at));
  try {
    const human = s.human ?? false;
    const run = db.createRun({ trigger: human ? "manual" : "schedule", human, argv: ["run", "--due", s.asset], identity: DEAD });
    db.startStep({ runId: run.id, asset: s.asset, attempt: 0, reason: "stale" });
    db.finishStep(run.id, s.asset, 0, { status: "skipped", reason: "stale" });
    db.finishRun(run.id, "succeeded", { data: { runId: run.id, steps: [{ asset: s.asset, status: "skipped", skippedBecause: s.because }] } });
    return run.id;
  } finally {
    db.close();
  }
}

/** The same project with croft.json's timezone changed (nothing else). */
export function rezone(p: SchedProject, timezone: string): SchedProject {
  const file = join(p.root, "croft.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), timezone }));
  return { ...p, project: loadProject({ root: p.root }) };
}

/** Scheduling for the project (the settings row `croft schedule` writes). */
export function scheduling(p: SchedProject, state: "on" | "off" | "paused", pausedUntil?: string): void {
  const db = p.db();
  try {
    db.setScheduling({ state, via: "serve", ...(pausedUntil !== undefined ? { pausedUntil } : {}) });
  } finally {
    db.close();
  }
}

export function scheduleStateOf(p: SchedProject, asset: string) {
  const db = p.db();
  try {
    return db.scheduleState(asset);
  } finally {
    db.close();
  }
}
