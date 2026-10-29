// Engine changes (DESIGN.md §8 "What a code change does", D114): an SQL asset's code hash is a hash of DuckDB's
// parse tree (project/sql-asset.ts sqlFingerprint), so a new DuckDB changes every SQL code hash although no file
// changed. Such an asset rebuilds once (code_changed: the new engine may compute differently), but it was not edited,
// so there is no EDITED_SINCE_LAST_RUN, and the approval a person gave its code carries over to the new hash: no
// SCHEDULE_HELD. The run that rebuilds it approves the new hash, a scheduled run included.
//
// The proof that the source did not change:
// - runs.sqlite's code_sources (croft ≥ 0.4) records, per code hash, the source hash it was made from and the engine
//   that made it. An old hash whose source is the source now, made by another engine, is an engine change.
// - A hash recorded by croft 0.3 has no row. It counts when it is the hash the asset was last built with, that build
//   predates the engine switch (the engine runs.sqlite records, ENGINE_SETTING, is still the old one, or was recorded
//   after the build), and the file's mtime is not newer than that build. A git checkout bumps mtimes, so such a
//   project falls to the safe side: an edit.
// TS assets are not affected: their code hash is their bundle's (project/ts-asset.ts), which no engine enters.
import { readFileSync, statSync } from "node:fs";
import { version as duckdbVersion } from "@duckdb/node-api";
import type { CatalogAsset } from "../history/catalog.ts";
import type { RunsDb } from "../history/runs-db.ts";
import { compareEngineVersions, ENGINE_SETTING, type EngineRecord, listBackups } from "../db/backup.ts";
import { parseSqlHeader, sqlSourceHash } from "../project/sql-asset.ts";

/** The engines an asset's code hash moved between, as version() prints them (v1.5.5, v2.0.0). */
export interface EngineChange { from: string; to: string }

/** What is known of the asset now. */
export interface EngineChangeInput {
  /** LoadedSqlAsset.sourceHash, or sourceHashOf its file; null when it cannot be read. */
  sourceHash: string | null;
  /** The asset's file, absolute: a build recorded by croft 0.3 counts only when the file is not newer. */
  path: string;
  /** Its catalog entry: the code hash it was built with, and when. */
  entry: CatalogAsset | null;
  /** The state folder: the names of its pre-upgrade backups say which engine came before. */
  stateDir?: string;
}

/** The source hash of the SQL asset file at `path`, as loadSqlAsset computes it; null when it cannot be read. */
export function sourceHashOf(path: string, file: string, timezone: string): string | null {
  try {
    const parsed = parseSqlHeader(readFileSync(path, "utf8"), file);
    return sqlSourceHash(parsed.header, parsed.body, timezone);
  } catch {
    return null;
  }
}

/**
 * The engine change that explains why the code hash `was` (a build's, or an approval's) is not the code hash now, or
 * null when nothing proves the source the same (an edit, or unknown). `engine` is the running DuckDB.
 */
export function engineChange(runs: Pick<RunsDb, "codeSource" | "getSetting">, was: string, now: EngineChangeInput,
  engine: string = duckdbVersion()): EngineChange | null {
  const row = runs.codeSource(was);
  if (row) {
    return row.engine !== engine && now.sourceHash !== null && row.sourceHash === now.sourceHash ? { from: row.engine, to: engine } : null;
  }
  // Recorded by croft 0.3: the build's own hash, built before the switch, from a file not touched since.
  const e = now.entry;
  if (!e || e.codeHash !== was) return null;
  const builtAt = latest(e.lastLoadedAt, e.lastReplacedAt);
  if (builtAt === null) return null;
  const record = runs.getSetting<Partial<EngineRecord>>(ENGINE_SETTING);
  const recorded = typeof record?.version === "string" ? record.version : null;
  if (recorded === engine) {
    const switchedAt = Date.parse(String(record?.recordedAt ?? ""));
    if (!Number.isFinite(switchedAt) || builtAt >= switchedAt) return null;
  }
  let mtime: number;
  try {
    mtime = statSync(now.path).mtimeMs;
  } catch {
    return null;
  }
  if (mtime > builtAt) return null;
  return { from: previousEngine(engine, recorded, now.stateDir), to: engine };
}

/** The engine before `engine`: the newest pre-upgrade backup made to it names it, else the recorded engine, else
 *  1.5.5 (the engine of every croft before 0.4). */
function previousEngine(engine: string, recorded: string | null, stateDir?: string): string {
  if (stateDir) {
    try {
      const to = engine.replace(/^v(?=\d)/, "");
      const made = listBackups(stateDir).filter((b) => b.to === to).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
      if (made) return `v${made.from}`;
    } catch {
      // No backups folder: the record says.
    }
  }
  if (recorded !== null && compareEngineVersions(recorded, engine) < 0) return recorded;
  return "v1.5.5";
}

/** The later of two ISO instants, in ms; null when neither is one. */
function latest(a: string | null, b: string | null): number | null {
  const xs = [a, b].map((t) => (t === null ? NaN : Date.parse(t))).filter(Number.isFinite);
  return xs.length ? Math.max(...xs) : null;
}

/** An engine change as the plan and the hold say it: "DuckDB upgraded (1.5.5 → 2.0.0)". */
export function engineWords(c: EngineChange): string {
  const bare = (v: string) => v.replace(/^v(?=\d)/, "");
  return `DuckDB ${compareEngineVersions(c.from, c.to) < 0 ? "upgraded" : "changed"} (${bare(c.from)} → ${bare(c.to)})`;
}
