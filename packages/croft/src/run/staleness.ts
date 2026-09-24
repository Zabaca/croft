// Staleness (DESIGN.md §5 "Versions, staleness and atomicity", §8 "What a code change does"): why an asset
// would run in a bare `croft run`, from the catalog mirror alone (no DuckDB lock), and the warning for an
// asset edited since it last ran.
//
// A transform is stale when it was never built (never_built), when an input changed since it last read all
// of it (input_changed: the input's lastLoadedAt is newer than InputSeen.inputLastLoadedAt, that is null, or
// the input has no InputSeen entry at all; an input that never had rows changes nothing), when an input was
// replaced (input_replaced: the input's lastReplacedAt is newer than what the transform saw), or when its code
// changed (code_changed). Incremental TS transforms are forward-only: new code applies to new rows, so their
// code change is EDITED_SINCE_LAST_RUN, never a reason to run. Ingests are only ever never_built here.
//
// "What the transform saw" of an input is InputSeen.inputLastLoadedAt: the input's version when the transform
// last read all of it. input_replaced compares the input's lastReplacedAt with it, so it clears once the
// transform has read the input again, provided the step records that version as the later of the input's
// last_loaded_at and last_replaced_at: an out-of-band change that no write followed (doctor, a write that
// changed no row) moves last_replaced_at alone, past last_loaded_at.
//
// Unknowns never make an asset stale on their own: an input that is not built, an entry without a code hash
// (none was recorded), an asset whose code does not load. They are for validate and the planner to report;
// here they would only make every run rebuild.
import { problem } from "../core/errors.ts";
import { parseInstant } from "../core/time.ts";
import type { AssetKind, Problem, Reason } from "../core/types.ts";
import type { CatalogAsset } from "../history/catalog.ts";

/** One asset as staleness sees it: the definition's side and the catalog mirror's. */
export interface StaleView {
  asset: string;
  /** Root-relative, for EDITED_SINCE_LAST_RUN. */
  file: string;
  kind: AssetKind;
  /** An incremental TS transform (newRows()): forward-only. */
  incremental: boolean;
  /** The assets it reads (PlannedStep.inputs). */
  inputs: readonly string[];
  /** The code hash now (PlannedStep.codeHash); undefined when the asset does not load. */
  codeHash?: string;
  /** Its catalog entry (entry.codeHash is the code it was built with, entry.inputsSeen what it has read); null
   *  when it was never built. */
  entry: CatalogAsset | null;
  /** The catalog entry of each input, by name; null for an input never built. */
  inputEntries: Readonly<Record<string, CatalogAsset | null>>;
}

/** Why the asset is stale, in the order of core/types.ts Reason; empty when it is fresh. */
export function staleReasons(v: StaleView): Reason[] {
  if (!v.entry) return ["never_built"];
  if (v.kind === "ingest") return [];
  const reasons: Reason[] = [];
  if (!(v.kind === "ts" && v.incremental) && codeChanged(v)) reasons.push("code_changed");
  let changed = false;
  let replaced = false;
  for (const input of v.inputs) {
    const e = lookup(v.inputEntries, input);
    if (!e) continue;                                      // not built: nothing to read yet
    const seen = lookup(v.entry.inputsSeen ?? {}, input);
    const version = seen?.inputLastLoadedAt ?? null;
    if (e.lastLoadedAt !== null && (version === null || newer(e.lastLoadedAt, version))) changed = true;
    if (e.lastReplacedAt !== null && seen && version !== null && newer(e.lastReplacedAt, version)) replaced = true;
  }
  if (changed) reasons.push("input_changed");
  if (replaced) reasons.push("input_replaced");
  return reasons;
}

/** EDITED_SINCE_LAST_RUN when the asset's code changed since it was built; for an incremental TS transform it
 *  says how many rows older code built. null when unedited, or never built. */
export function editedProblem(v: StaleView): Problem | null {
  if (!v.entry || !codeChanged(v)) return null;
  const details = { codeHash: v.codeHash, builtWith: v.entry.codeHash, rows: v.entry.rows };
  const base = { asset: v.asset, file: v.file, details };
  if (v.kind === "ts" && v.incremental) {
    const rows = v.entry.rows;
    return problem("EDITED_SINCE_LAST_RUN", {
      ...base,
      message: `${v.asset} edited since its last run; ${count(rows)} row${rows === 1 ? " was" : "s were"} built by older code`,
      hint: "an incremental transform applies new code to new input rows only, so paid calls are never repeated implicitly; the rows built earlier keep their values",
      effect: "the next run processes new input rows with the new code",
    });
  }
  if (v.kind === "ingest") {
    return problem("EDITED_SINCE_LAST_RUN", {
      ...base,
      message: `${v.asset} edited since its last run`,
      hint: `the next run fetches with the new code; rows already loaded are not refetched: croft run ${v.asset}`,
      fix: { kind: "command", description: `run ${v.asset} with the new code`, command: `croft run ${v.asset}` },
    });
  }
  return problem("EDITED_SINCE_LAST_RUN", {
    ...base,
    message: `${v.asset} edited since its last run; its table still holds what the previous code built`,
    hint: `the next run rebuilds it with the new code: croft run ${v.asset}`,
    fix: { kind: "command", description: `rebuild ${v.asset} with the new code`, command: `croft run ${v.asset}` },
  });
}

/** The code now differs from the code it was built with. Unknown on either side is not a change. */
function codeChanged(v: StaleView): boolean {
  return v.codeHash !== undefined && v.entry !== null && v.entry.codeHash !== null && v.entry.codeHash !== v.codeHash;
}

/** An entry by asset name: exact, else the one name that matches without regard to case. */
function lookup<T>(map: Readonly<Record<string, T>>, name: string): T | null {
  if (Object.hasOwn(map, name)) return map[name] ?? null;
  const lower = name.toLowerCase();
  const hits = Object.keys(map).filter((k) => k.toLowerCase() === lower);
  return hits.length === 1 ? map[hits[0]!] ?? null : null;
}

/** Whether instant `a` is later than `b` (ISO-8601 with microseconds; text order when either does not parse). */
function newer(a: string, b: string): boolean {
  try {
    return parseInstant(a) > parseInstant(b);
  } catch {
    return a > b;
  }
}

const count = (n: number) => n.toLocaleString("en-US");
